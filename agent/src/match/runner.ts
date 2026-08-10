import {Phase} from '@/common/Phase';
import {PlayerId} from '@/common/Types';
import {IGame} from '@/server/IGame';
import {SeatedAgent, createAgent, lookupAgent} from '../agents/registry';
import {createGame} from '../engine/gameFactory';
import {PLAYER_ORDER_COLORS} from '../engine/gameConfig';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedResponder} from '../driver/responder';
import {EmbeddedDriverOptions, runGame} from '../driver/embeddedDriver';
import {errorClassName} from '../legality/causes';
import {percentiles} from '../legality/run';
import {buildHeader} from '../determinism/corpus';
import {buildMatchConfigs, defaultRunId, describePairing, resolveMatchSpec} from './pairing';
import {rankGame} from './ranking';
import {
  HistoryTier,
  MATCH_HARNESS_VERSION,
  MatchGameConfig,
  MatchGameRecord,
  MatchInstrumentationReport,
  MatchLegalityCounters,
  MatchRunHeader,
  MatchRunReport,
  MatchSeatRecord,
  MatchSeatStanding,
  MatchSlotStanding,
  MatchSpec,
  MatchStanding,
  MatchSummary,
  MatchVpBreakdown,
  ResolvedMatchSpec,
} from './types';

/**
 * The match runner: play N games between named agent versions under controlled seeds and record
 * them (SRS FR-13; Milestone 2 bullet 1, Unit A).
 *
 * **Every number this project will ever quote about playing strength comes out of here** - M3's
 * tuned weights, M4's significance test, the AC-7 promotion gate, the AC-3/AC-5 evidence. (AC-8's
 * distributional calibration was on that list until it was withdrawn on 10 Aug 2026 - SRS v1.7 -
 * which removes a consumer and changes nothing here.) `agent/CLAUDE.md` §9 says it outright:
 * measure everything through this harness. So
 * the two places a defensible-looking local choice would produce a systematically wrong number are
 * settled elsewhere and imported here rather than decided in this loop - the seat balancing in
 * `pairing.ts` (§4.1) and the ranking in `ranking.ts` (§4.2).
 *
 * **The loop reuses `legality/run.ts`'s shape, and its reasons, not just its code:**
 *
 * - **Async, yielding between games** (hazard H3). `Game.gotoEndGame()` is unawaited async, so a
 *   synchronous batch loop holds every finished game alive through its pending continuation - about
 *   0.27 MB each, measured. Yielding lets those continuations run.
 * - **A failing game does not abort the run** (hazard H8). The failure is recorded with its error
 *   class and message and the run continues; stopping at the first one would throw away the
 *   diagnostic value of the other N−1 games, including whether the failure is systematic or one
 *   seed. What a failure *does* cost is the balance: a group with a failed game is no longer a
 *   balanced group, and is **excluded from `bySlot`/`bySeat`** (see {@link summarizeMatch}). That
 *   decision is recorded in the artifact header as `incompleteGroupPolicy`, not just here.
 * - **Routine per-decision logs are silenced above a threshold, and only because the counts are
 *   strict** (hazard H7). The driver `console.warn`s on every FR-9 fallback (~5.7 per game,
 *   measured over 1,500 games) and the Engine logs an eviction line per finished game. Both are
 *   already counted - by `onFallback` here, and by Unit B's submission monitor in legality mode -
 *   so the log line carries no information the record doesn't. Reuse the silencing only together
 *   with the accounting.
 *
 * **What this module deliberately does not do:** no heap sampling. `legality/run.ts` samples
 * because criterion L7 is stated on it; no match criterion is, and every non-deterministic field
 * added here is one more thing R2 (reproducibility) and R6 (the pooled artifact is byte-identical)
 * have to strip before comparing. The H3 yield stays; the measurement doesn't.
 *
 * **Per-seat routing** needs no driver change. `runGame` takes one responder; a match passes it a
 * *router* closing over the seat map and dispatching on `decision.player.id` - the technique
 * `demo/match.ts` already proved. `embeddedDriver.ts` is untouched by this bullet.
 *
 * **Agent contributions** (Milestone 2 bullet 2, hazard H4). A searching agent needs the game, not
 * just its own seat: `EmbeddedDriverOptions.onFallback` to learn which response the Engine
 * *accepted*, and a wrapper around the router to see every seat's decisions. `agents/registry.ts`
 * lets an entry contribute both ({@link SeatedAgent}); this file merges them
 * ({@link mergeDriverOptions}) and does **nothing** when none are supplied, so `random-legal@1`'s
 * artifacts are byte-identical before and after the seam existed. `agent/src/driver/` is not
 * modified.
 */

// ---------------------------------------------------------------------------------------------
// The instrumentation seam (Unit B)
// ---------------------------------------------------------------------------------------------

/** What to capture beyond the game record. Serializable, so Unit C's pool can pass it to a child. */
export type MatchCaptureOptions = {
  /** §4.4. `summary` (the default) captures nothing extra and loads no instrument at all. */
  historyTier: HistoryTier;
  /** §4.6: install the strict AC-1 submission accounting around the batch. */
  legality: boolean;
  /** Where `moves`-tier sidecars are written. Defaults to `agent/runs/` (§4.7) - see `artifact.ts`. */
  movesDir?: string;
};

export const DEFAULT_CAPTURE: MatchCaptureOptions = {historyTier: 'summary', legality: false};

/**
 * The hook Unit B's history recorder and legality mode attach through (§4.4, §4.6). Both live at
 * the submission boundary and both are per-process global state, which is why there is one seam
 * and not two: having two independent things wrap `Player.prototype.process` in one process is a
 * bug waiting to happen.
 */
export interface MatchInstrument {
  /** Installed once around the whole batch (before the first game), and uninstalled in a `finally`. */
  install?(): void;
  uninstall?(): void;
  /** Called before each game; returns the responder the driver will actually see (usually a wrapper). */
  beginGame(config: MatchGameConfig, responder: EmbeddedResponder): EmbeddedResponder;
  /** Called after each game with the base record; returns the record to store. `game` is undefined only if the game could not be created. */
  endGame(config: MatchGameConfig, record: MatchGameRecord, game: IGame | undefined): MatchGameRecord;
  /** Run-level output folded into the report. */
  finish?(): MatchInstrumentationReport | undefined;
}

/**
 * Module id of Unit B's instrument factory. Resolved **by name at runtime**, not by a static
 * `import`, for one reason: it lets this file compile and run before `match/history.ts` exists,
 * so Unit A ships a working `summary`-tier runner and Unit B never has to edit a file §9 assigns
 * to A. The contract Unit B implements:
 *
 * ```ts
 * export function createMatchInstrument(capture: MatchCaptureOptions): MatchInstrument;
 * ```
 *
 * `history.ts` is the single entry point even for legality mode, because §4.6 puts both
 * instruments behind one `Player.prototype.process` wrapper; how it composes with
 * `match/legality.ts` internally is Unit B's business.
 */
const INSTRUMENT_MODULE = './history';

/**
 * Builds the instrument for `capture`, or `undefined` when nothing beyond the game record is
 * wanted - which is the default path and touches {@link INSTRUMENT_MODULE} not at all.
 */
export function resolveInstrument(capture: MatchCaptureOptions): MatchInstrument | undefined {
  if (capture.historyTier === 'summary' && capture.legality === false) {
    return undefined;
  }
  let factory: ((capture: MatchCaptureOptions) => MatchInstrument) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    factory = require(INSTRUMENT_MODULE).createMatchInstrument;
  } catch (error) {
    throw new Error(
      `history tier '${capture.historyTier}'${capture.legality ? ' and legality mode' : ''} need ` +
      `agent/src/match/history.ts to export createMatchInstrument(capture) (Milestone 2 bullet 1, Unit B; ` +
      `see §4.4/§4.6 of agent/docs/Milestone2_Bullet1_Prompts.md). Loading it failed: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof factory !== 'function') {
    throw new Error(`agent/src/match/history.ts does not export createMatchInstrument(capture) (Unit B's contract).`);
  }
  return factory(capture);
}

// ---------------------------------------------------------------------------------------------
// Playing one game
// ---------------------------------------------------------------------------------------------

/**
 * The player ids `engine/gameFactory.ts` assigns, per seat. Derived rather than read off the game
 * so a game that failed to *build* still records who was seated - a failure with no attribution is
 * a failure nobody can act on. `runner.spec.ts` asserts this stays in step with a real game's ids.
 */
export function seatPlayerId(seat: number): PlayerId {
  return `p-${PLAYER_ORDER_COLORS[seat]}` as PlayerId;
}

/** Seat identities, known before the game is created and unchanged by how it ends. */
function seatIdentities(config: MatchGameConfig): ReadonlyArray<MatchSeatRecord> {
  return config.seating.map((slot, seat) => {
    const name = config.lineup[slot];
    return {
      seat,
      slot,
      playerId: seatPlayerId(seat),
      agent: name,
      // Resolved through the registry rather than carried on the config, so the version recorded
      // is always the version that actually played (AC-7, and the per-version AC-1 re-run).
      agentVersion: lookupAgent(name).version,
      agentSeed: config.agentSeeds[slot],
    };
  });
}

/**
 * Plays exactly one fully-specified game and returns its record. Synchronous: the event-loop yield
 * that hazard H3 requires belongs to the batch loop, which is the thing that runs many of these.
 *
 * Exported so Unit C's pool child can play a shard game-by-game without reimplementing any of it -
 * the single-process path stays the reference implementation and the correctness oracle (§4.5).
 */
export function playMatchGame(config: MatchGameConfig, instrument?: MatchInstrument): MatchGameRecord {
  const started = Date.now();
  const seats = seatIdentities(config);

  let decisions = 0;
  let fallbacksAfterRejection = 0;
  let fallbacksAfterThrow = 0;
  let game: IGame | undefined;

  const base = (): Omit<MatchGameRecord, 'completed' | 'generation' | 'seats' | 'claimedMilestones' | 'fundedAwards'> => ({
    groupIndex: config.groupIndex,
    permutationIndex: config.permutationIndex,
    engineSeed: config.engineSeed,
    seating: config.seating,
    decisions,
    fallbacksAfterRejection,
    fallbacksAfterThrow,
    durationMs: Date.now() - started,
  });

  try {
    // Bound to a non-optional local as well as to `game`: `game` exists so the catch below can
    // report the generation of a game that failed mid-play, but everything on the success path
    // reads `created`, which TypeScript knows is defined.
    const created = createGame({players: config.players, seed: config.engineSeed});
    game = created;

    // One agent per seat, built here and therefore **once per game**, which is what lets a
    // searching agent keep per-game state (a fork service, a recorded move list) in its closure.
    const agents = new Map<PlayerId, SeatedAgent>(
      seats.map((seat) => [seat.playerId, createAgent(seat.agent, seat.agentSeed)]),
    );
    // The router: one responder for the driver, dispatching on which player is being asked
    // (`demo/match.ts:53`'s precedent). This is the whole of "per-seat agents" - `runGame` and
    // `applyDecision` need no change.
    const router: EmbeddedResponder = (decision: EmbeddedDecisionPoint) => {
      const agent = agents.get(decision.player.id);
      if (agent === undefined) {
        throw new Error(`no agent is seated as player ${decision.player.id} in group ${config.groupIndex}.`);
      }
      decisions++;
      return agent.respond(decision);
    };

    // Hazard H4 (Milestone 2 bullet 2): an agent whose search replays opponents' moves has to see
    // *every* decision, not only its own, and the driver takes one responder. Each contributing
    // agent wraps the router in seat order, innermost first, so the wrappers are applied in an
    // order fixed by the seating rather than by map iteration luck. An agent that contributes
    // nothing leaves `observed === router`, so the instrument below and the driver see exactly the
    // object they saw before this seam existed - criteria R2/R6 compare artifacts byte for byte.
    let observed = router;
    for (const seat of seats) {
      const wrap = agents.get(seat.playerId)?.observeDecisions;
      if (wrap !== undefined) {
        observed = wrap(observed);
      }
    }

    const result = runGame(created, instrument?.beginGame(config, observed) ?? observed, mergeDriverOptions([
      {
        onFallback: (event) => {
          // `rejectedInput === undefined` means the responder threw without producing a move (class
          // B - nothing was submitted); otherwise its move was submitted and rejected (class A - an
          // illegal move under AC-1's definition). These two counters are the driver's view, and are
          // *not* the strict accounting: `onFallback` cannot see the fallback's own rejected
          // `'or'`-branch probes. That population needs legality mode (§4.6).
          if (event.rejectedInput === undefined) {
            fallbacksAfterThrow++;
          } else {
            fallbacksAfterRejection++;
          }
        },
      },
      ...seats.flatMap((seat) => {
        const options = agents.get(seat.playerId)?.driverOptions;
        return options === undefined ? [] : [options];
      }),
    ]));

    const ranking = rankGame(created);
    const seatOf = new Map(seats.map((seat) => [seat.playerId, seat.seat]));
    const record: MatchGameRecord = {
      ...base(),
      completed: created.phase === Phase.END,
      generation: result.generation,
      seats: seats.map((seat) => {
        const player = created.players[seat.seat];
        const rank = ranking[seat.seat];
        return {
          ...seat,
          outcome: {
            placement: rank.placement,
            isWinner: rank.isWinner,
            marginToNext: rank.marginToNext,
            victoryPoints: rank.victoryPoints,
            megaCredits: rank.megaCredits,
            terraformRating: player.terraformRating,
            vpBreakdown: readVpBreakdown(player.getVictoryPoints()),
            victoryPointsByGeneration: [...player.victoryPointsByGeneration],
            corporations: player.playedCards.corporations().map((card) => card.name),
            preludes: player.playedCards.preludes().map((card) => card.name),
            projectCards: player.playedCards.projects().map((card) => card.name),
          },
        };
      }),
      claimedMilestones: created.claimedMilestones.map((claimed) => ({
        milestone: claimed.milestone.name,
        seat: seatOf.get(claimed.player.id) ?? -1,
      })),
      fundedAwards: created.fundedAwards.map((funded) => ({
        award: funded.award.name,
        seat: seatOf.get(funded.player.id) ?? -1,
      })),
    };
    return instrument?.endGame(config, record, created) ?? record;
  } catch (error) {
    const record: MatchGameRecord = {
      ...base(),
      completed: false,
      failure: {
        errorClass: errorClassName(error),
        message: error instanceof Error ? error.message : String(error),
      },
      generation: game?.generation ?? 0,
      // Identities without outcomes: who was playing is still the first thing a failure
      // investigation needs, and it is exactly what a bare "game 412 failed" row cannot give.
      seats,
      claimedMilestones: [],
      fundedAwards: [],
    };
    return instrument?.endGame(config, record, game) ?? record;
  }
}

/**
 * Combines the runner's own driver options with those any seated agent contributes (hazard H4).
 *
 * **Returns the single element unchanged when there is nothing to merge**, which is the whole of
 * every run before this bullet and every run of `random-legal@1` after it. That is not an
 * optimization: criteria R2 and R6 compare artifacts byte for byte, so the no-contribution path has
 * to be *the same path*, not an equivalent one.
 *
 * `onFallback` **composes** rather than overriding - the runner's own counters run first, then each
 * agent's in seat order - because both callers are observers and there is no sensible sense in
 * which one of them wins. `maxDecisions` is the strictest value any party asked for, so an agent
 * can tighten the driver's stall cap but never loosen the runner's.
 */
export function mergeDriverOptions(parts: ReadonlyArray<EmbeddedDriverOptions>): EmbeddedDriverOptions {
  if (parts.length === 1) {
    return parts[0];
  }
  const caps = parts.map((part) => part.maxDecisions).filter((cap): cap is number => cap !== undefined);
  const hooks = parts.map((part) => part.onFallback).filter((hook): hook is NonNullable<EmbeddedDriverOptions['onFallback']> => hook !== undefined);
  return {
    ...(caps.length === 0 ? {} : {maxDecisions: Math.min(...caps)}),
    ...(hooks.length === 0 ? {} : {
      onFallback: (event) => {
        for (const hook of hooks) {
          hook(event);
        }
      },
    }),
  };
}

/** The in-scope subset of the Engine's `VictoryPointsBreakdown` (see `MatchVpBreakdown`). */
function readVpBreakdown(breakdown: {
  terraformRating: number; milestones: number; awards: number; greenery: number; city: number;
  victoryPoints: number; total: number;
}): MatchVpBreakdown {
  return {
    terraformRating: breakdown.terraformRating,
    milestones: breakdown.milestones,
    awards: breakdown.awards,
    greenery: breakdown.greenery,
    city: breakdown.city,
    cards: breakdown.victoryPoints,
    total: breakdown.total,
  };
}

// ---------------------------------------------------------------------------------------------
// The batch loop
// ---------------------------------------------------------------------------------------------

export type MatchRunOptions = {
  /** Defaults to {@link defaultRunId} - deterministic, so re-running a spec produces the same id (R2). */
  runId?: string;
  /** What to capture beyond the game record (§4.4/§4.6). Defaults to {@link DEFAULT_CAPTURE}. */
  capture?: MatchCaptureOptions;
  /**
   * A pre-built instrument, bypassing {@link resolveInstrument}. For tests and for Unit C's pool
   * child, which may want to build one itself; `capture` still describes it in the header.
   */
  instrument?: MatchInstrument;
  /** Yield to the event loop every N games. Default 1 - see the module doc (hazard H3). */
  yieldEvery?: number;
  /** Silence the driver's per-fallback warn and the Engine's eviction log (hazard H7). */
  silenceRoutineLogs?: boolean;
  onProgress?: (completed: number, total: number, record: MatchGameRecord) => void;
};

export function buildMatchHeader(spec: ResolvedMatchSpec, options: MatchRunOptions = {}): MatchRunHeader {
  const capture = options.capture ?? DEFAULT_CAPTURE;
  return {
    runId: options.runId ?? defaultRunId(spec),
    harnessVersion: MATCH_HARNESS_VERSION,
    spec,
    pairing: describePairing(spec),
    historyTier: capture.historyTier,
    legalityMode: capture.legality,
    incompleteGroupPolicy: 'excluded-from-balanced-statistics',
    provenance: buildHeader(),
  };
}

/** Resolves a specification and plays it. The entry point for the CLI and for tests. */
export async function runMatch(spec: MatchSpec, options: MatchRunOptions = {}): Promise<MatchRunReport> {
  const resolved = resolveMatchSpec(spec);
  return runMatchConfigs(buildMatchConfigs(resolved), resolved, options);
}

/**
 * Plays an explicit list of configs. Separate from {@link runMatch} because Unit C's pool needs to
 * hand a *shard* of the run's configs to a child process; the shard is always a whole number of
 * pairing groups (§4.5), which is what keeps the resulting rows summarizable.
 */
export async function runMatchConfigs(
  configs: ReadonlyArray<MatchGameConfig>,
  spec: ResolvedMatchSpec,
  options: MatchRunOptions = {},
): Promise<MatchRunReport> {
  ensureHeadlessEngine();

  const yieldEvery = options.yieldEvery ?? 1;
  const instrument = options.instrument ?? resolveInstrument(options.capture ?? DEFAULT_CAPTURE);

  const originalWarn = console.warn;
  const originalLog = console.log;
  if (options.silenceRoutineLogs === true) {
    console.warn = () => {};
    console.log = () => {};
  }

  const games: Array<MatchGameRecord> = [];
  const runStart = Date.now();
  let instrumentation: MatchInstrumentationReport | undefined;

  instrument?.install?.();
  try {
    for (const [index, config] of configs.entries()) {
      games.push(playMatchGame(config, instrument));
      options.onProgress?.(games.length, configs.length, games[games.length - 1]);
      if ((index + 1) % yieldEvery === 0) {
        await yieldToEventLoop();
      }
    }
    instrumentation = instrument?.finish?.();
  } finally {
    instrument?.uninstall?.();
    console.warn = originalWarn;
    console.log = originalLog;
  }

  // Let the last games' `gotoEndGame` continuations settle before the caller reads anything global.
  await yieldToEventLoop();

  return {
    header: buildMatchHeader(spec, options),
    summary: summarizeMatch(games, spec, {wallClockMs: Date.now() - runStart}),
    games,
    ...(instrumentation === undefined ? {} : {instrumentation}),
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------
// Summarizing
// ---------------------------------------------------------------------------------------------

/**
 * The run's own counts. **Nothing beyond what this bullet's pre-committed criteria need** (§6):
 * win rates and placement distributions by lineup slot (R1a) and by seat (R1b), and the
 * completion/decision counts. Elo, TrueSkill, significance tests and any comparison to the expert
 * dataset are bullets 3 and 4 - this artifact records their *inputs*.
 *
 * `bySlot` and `bySeat` are computed over **balanced groups only**: groups in which every
 * permutation was played and every game completed (hazard H8's question, answered here and
 * recorded in the header as `incompleteGroupPolicy`). The reason is that a group missing a
 * permutation is precisely a group in which some slot did not sit in every seat, so including it
 * would reintroduce the seat bias the pairing exists to remove - in a way that would be invisible
 * in the output. `completed`/`failed` still count every game, so nothing is hidden.
 */
export function summarizeMatch(
  games: ReadonlyArray<MatchGameRecord>,
  spec: ResolvedMatchSpec,
  timing: {wallClockMs: number},
): MatchSummary {
  const completed = games.filter((game) => game.completed);
  const byGroup = new Map<number, Array<MatchGameRecord>>();
  for (const game of games) {
    const group = byGroup.get(game.groupIndex) ?? [];
    group.push(game);
    byGroup.set(game.groupIndex, group);
  }
  const balanced = [...byGroup.values()]
    .filter((group) => group.length === spec.permutationsPerGroup && group.every((game) => game.completed))
    .flat();

  const legality = summarizeLegality(games);

  return {
    players: spec.players,
    groups: byGroup.size,
    permutationsPerGroup: spec.permutationsPerGroup,
    games: games.length,
    completed: completed.length,
    failed: games.length - completed.length,
    balancedGroups: balanced.length / spec.permutationsPerGroup,
    totalDecisions: sum(games.map((game) => game.decisions)),
    fallbacksAfterRejection: sum(games.map((game) => game.fallbacksAfterRejection)),
    fallbacksAfterThrow: sum(games.map((game) => game.fallbacksAfterThrow)),
    decisionsPerGame: percentiles(completed.map((game) => game.decisions)),
    generationsPerGame: percentiles(completed.map((game) => game.generation)),
    bySlot: spec.lineup.map((identity, slot): MatchSlotStanding => ({
      slot,
      agent: identity.name,
      agentVersion: identity.version,
      ...standing(balanced, spec.players, (seat) => seat.slot === slot),
    })),
    bySeat: range(spec.players).map((seat): MatchSeatStanding => ({
      seat,
      ...standing(balanced, spec.players, (record) => record.seat === seat),
    })),
    ...(legality === undefined ? {} : {legality}),
    timing: {...timing, durationMsPerGame: percentiles(completed.map((game) => game.durationMs))},
  };
}

function standing(
  games: ReadonlyArray<MatchGameRecord>,
  players: number,
  select: (seat: MatchSeatRecord) => boolean,
): MatchStanding {
  const placementCounts = range(players).map(() => 0);
  let wins = 0;
  let sharedWins = 0;
  let counted = 0;

  for (const game of games) {
    const seat = game.seats.find(select);
    const outcome = seat?.outcome;
    if (outcome === undefined) {
      continue;
    }
    counted++;
    placementCounts[outcome.placement - 1]++;
    if (outcome.isWinner) {
      wins++;
      if (game.seats.filter((other) => other.outcome?.isWinner === true).length > 1) {
        sharedWins++;
      }
    }
  }

  const winRate = counted === 0 ? NaN : wins / counted;
  return {games: counted, wins, sharedWins, placementCounts, winRate, winRateCi95: wilson95(wins, counted)};
}

function summarizeLegality(games: ReadonlyArray<MatchGameRecord>): MatchLegalityCounters | undefined {
  const counted = games.map((game) => game.legality).filter((counters): counters is MatchLegalityCounters => counters !== undefined);
  if (counted.length === 0) {
    return undefined;
  }
  return {
    submissions: sum(counted.map((c) => c.submissions)),
    rejectedResponder: sum(counted.map((c) => c.rejectedResponder)),
    rejectedFallbackProbe: sum(counted.map((c) => c.rejectedFallbackProbe)),
    responderThrows: sum(counted.map((c) => c.responderThrows)),
  };
}

/**
 * The Wilson score interval at 95%, on a proportion. Criterion R1a is stated directly on this
 * ("the lineup-slot-A win rate has a 95% confidence interval containing 50%"), which is the only
 * reason any interval is computed in this bullet at all - ratings and significance testing are
 * bullet 3.
 *
 * Wilson rather than the normal (Wald) approximation because Wald misbehaves exactly where a
 * self-test might land: near 0 or 1, and at small n, where it can produce an interval containing
 * impossible proportions. Wilson stays inside [0, 1] and is well-behaved at the sample sizes R1
 * pre-commits to.
 */
export function wilson95(successes: number, trials: number): {low: number; high: number} {
  if (trials === 0) {
    return {low: NaN, high: NaN};
  }
  const z = 1.959964;
  const p = successes / trials;
  const denominator = 1 + z * z / trials;
  const centre = (p + z * z / (2 * trials)) / denominator;
  const half = z / denominator * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials));
  return {low: Math.max(0, centre - half), high: Math.min(1, centre + half)};
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}

function range(length: number): Array<number> {
  return [...Array(length).keys()];
}
