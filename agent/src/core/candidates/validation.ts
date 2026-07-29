import {Phase} from '@/common/Phase';
import {InputResponse} from '@/common/inputs/InputResponse';
import {PlayerInputModel} from '@/common/models/PlayerInputModel';
import {GameLoader} from '@/server/database/GameLoader';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {toDecisionPoint} from '../../driver/decisionPoint';
import {EmbeddedDriverOptions, applyDecision} from '../../driver/embeddedDriver';
import {EmbeddedResponder} from '../../driver/responder';
import {createGame} from '../../engine/gameFactory';
import {
  GameSnapshot,
  SnapshotFidelityError,
  UnsafeSnapshotError,
  assertSnapshotSafe,
  pendingSignature,
  restore,
  snapshot,
} from '../../engine/snapshot';
import {stableStateOf} from '../../engine/stableState';
import {randomLegalAgent} from '../randomLegalAgent';
import {createAgentRandom} from '../rng';
import {IN_SCOPE_TYPES, InScopeModelType, candidates} from './index';

/**
 * **The G1a/G1c corpus run** - the measurement half of Unit B
 * (agent/docs/Milestone2_Bullet2_Prompts.md §5, criterion G1).
 *
 * G1a is not a property of the type system and is not asserted from one: *"over >= 200 real
 * games, with every candidate set generated at every in-scope decision, every candidate is
 * accepted by the Engine's own `process()` on first submission."* So this drives real games with
 * the random-legal agent and, at every decision point, generates the candidate set and submits
 * **each** candidate into a throwaway fork, recording what the Engine did with it. The live game
 * proceeds on the random-legal move, untouched by any of the probing.
 *
 * Three things this harness is deliberately *not*:
 *
 * - **Not the production fork service.** Unit A owns `agent/src/search/fork.ts`, which
 *   productionizes exactly this mechanism (and adds the speculation registry that keeps
 *   speculative submissions out of the legality and history instruments). This is a
 *   validation-local copy of the same validated strategy from `bench/forkCost.ts`, written
 *   because Units A and B run in parallel and B cannot wait for A. When A lands, a future session
 *   should delete this and call the real service - the only reason not to today is the ordering.
 * - **Not measuring anything about performance.** No timing here is a performance figure
 *   (hazard H10); throughput is printed only so a later run can be sized.
 * - **Not the greedy agent.** It generates candidates and throws them away. Choosing among them
 *   is Unit C.
 *
 * **The one addition to `forkCost.ts`'s strategy, and it is load-bearing for G1c.** That suite
 * counted decision points before the first forkable ancestor as "no experiment possible". Here
 * those points are the entire game-setup prefix - which is where `initialCards` lives, one of the
 * thirteen types G1c requires be exercised - so skipping them would leave a whole decision type
 * unvalidated and report it as unreached. The fix is to treat the **freshly created game as the
 * index-0 ancestor**: `createGame` is deterministic in the Engine seed (Milestone 1 bullet 6), so
 * a fresh game plus the recorded responses reproduces the position, and every fork is checked
 * against the live original both ways regardless (hazard H7) so the assumption is verified rather
 * than trusted.
 */

/** One game to validate. Engine and Agent seeds stay independent (SRS CON-5). */
export type CandidateValidationConfig = {
  readonly players: number;
  readonly engineSeed: number;
  readonly agentSeed: number;
};

export type CandidateValidationOptions = {
  /**
   * Uniformly subsamples the candidates actually submitted at a decision, for a cheap smoke run.
   * Unset (the default) submits every candidate, which is what G1a requires.
   */
  readonly maxCandidatesPerDecision?: number;
  /** How many rejections to record in full. The counts are always complete. Default 50. */
  readonly maxRejectionsRecorded?: number;
  /** Silences the driver's FR-9 warn and the Engine's own log lines. Default true. */
  readonly silenceLogs?: boolean;
  readonly onProgress?: (completed: number, total: number) => void;
};

/** A candidate the Engine refused - the finding G1a is looking for, recorded in full. */
export type CandidateRejection = {
  readonly players: number;
  readonly engineSeed: number;
  readonly decisionIndex: number;
  readonly decisionType: string;
  readonly candidateIndex: number;
  readonly candidate: string;
  readonly errorClass: string;
  readonly message: string;
};

/** Per-decision-type accounting: the coverage half of G1c and the candidate-count half of G7. */
export type CandidateTypeStats = {
  /** Decision points of this type reached at all. */
  decisions: number;
  /**
   * Times a response of this type appeared **anywhere** inside a generated candidate, including
   * nested inside an `or` branch or an `and`/`initialCards` child. This is the honest denominator
   * for G1c: a type like `option` is almost never a top-level decision in this scope - it is a
   * branch of the action-phase `or` - but its generator runs, and its response is validated
   * transitively when the Engine accepts the enclosing candidate (`OrOptions.process` delegates
   * to `options[index].process`). Counting only top-level decisions would report a generator that
   * ran tens of thousands of times as "never reached".
   */
  candidateAppearances: number;
  /** Decision points of this type where a faithful fork was available, so candidates were submitted. */
  decisionsValidated: number;
  /** Decision points of this type whose candidate set was empty. */
  emptySets: number;
  /** Decision points of this type whose set hit the global cap (this node or below). */
  cappedDecisions: number;
  candidatesGenerated: number;
  candidatesSubmitted: number;
  candidatesAccepted: number;
  candidatesRejected: number;
  /**
   * Candidate-set size distribution for this type - the per-type half of the G7 diagnostic.
   * Summarized rather than dumped: the raw per-decision sizes are 60,000 numbers on the
   * pre-committed corpus, and the committed artifact should carry the finding, not the log.
   */
  setSize: SetSizeSummary;
};

export type SetSizeSummary = {
  readonly median: number;
  readonly p95: number;
  readonly max: number;
};

/** Why a decision point could not be probed. Counted, named, and never confused with a rejection. */
export type ForkGap =
  /** Restoring the ancestor threw, or a replayed step was rejected. */
  | 'forkUnavailable'
  /** The fork was built but did not reproduce the live position (pendingSignature and/or stableStateOf). */
  | 'forkUnfaithful'
  /**
   * The fork passed **both** of the Milestone-1 checks and still presented a *different pending
   * decision* - see {@link pendingModelSignature}. Counted separately because it is a finding
   * about the fork machinery, not about this unit, and because the count is the evidence for it.
   */
  | 'forkPendingModelMismatch'
  /**
   * A restore was rejected as an ancestor for the same reason - the coarse checks passed, the
   * decision's contents did not. Not a probe gap in itself (the point falls back to replay from
   * an older ancestor), but the count is what makes the finding measurable.
   */
  | 'ancestorPendingModelMismatch';

export type CandidateValidationReport = {
  readonly gamesRun: number;
  readonly gamesCompleted: number;
  readonly decisionPoints: number;
  readonly decisionsValidated: number;
  readonly forkGaps: Record<ForkGap, number>;
  readonly candidatesGenerated: number;
  readonly candidatesSubmitted: number;
  readonly candidatesAccepted: number;
  readonly candidatesRejected: number;
  readonly cappedDecisions: number;
  readonly emptySets: number;
  readonly setSize: SetSizeSummary;
  readonly byType: Record<string, CandidateTypeStats>;
  /** In-scope types the corpus never reached - named, per G1c, rather than silently absent. */
  readonly unreachedTypes: ReadonlyArray<InScopeModelType>;
  /** In-scope types reached but never validated (no faithful fork at any of their points). */
  readonly unvalidatedTypes: ReadonlyArray<InScopeModelType>;
  readonly rejections: ReadonlyArray<CandidateRejection>;
  readonly fr9Fallbacks: number;
  readonly failedGames: ReadonlyArray<{config: CandidateValidationConfig; message: string}>;
  readonly wallClockMs: number;
};

/** A decision as the live game actually resolved it - the replay unit (hazard H3: the *accepted* response). */
type RecordedDecision = {
  readonly playerId: string;
  readonly response: InputResponse;
};

/** The rolling fork source: a snapshot, or `undefined` meaning "the freshly created game". */
type Ancestor = {
  /** How many decisions had been recorded when this ancestor was captured. */
  readonly index: number;
  readonly snap: GameSnapshot | undefined;
};

/** The mutable form the corpus loop accumulates: the raw set sizes, summarized at report time. */
type TypeAccumulator = Omit<CandidateTypeStats, 'setSize'> & {readonly setSizes: Array<number>};

function emptyTypeStats(): TypeAccumulator {
  return {
    decisions: 0,
    candidateAppearances: 0,
    decisionsValidated: 0,
    emptySets: 0,
    cappedDecisions: 0,
    candidatesGenerated: 0,
    candidatesSubmitted: 0,
    candidatesAccepted: 0,
    candidatesRejected: 0,
    setSizes: [],
  };
}

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

/** The response objects are replayed into many independently restored games; never share one. */
function copyResponse(response: InputResponse): InputResponse {
  return JSON.parse(JSON.stringify(response)) as InputResponse;
}

/** `assertSnapshotSafe`'s verdict as a boolean. Any other throw is a real bug and propagates. */
function isGuardSafe(game: IGame): boolean {
  try {
    assertSnapshotSafe(game);
    return true;
  } catch (error) {
    if (error instanceof UnsafeSnapshotError) {
      return false;
    }
    throw error;
  }
}

/**
 * The replay counterpart of `applyDecision`, copied from `bench/forkCost.ts` (hazard H6): plain
 * `player.process` plus the driver's own **guarded** deferred drain, and deliberately *not*
 * `applyDecision` - the FR-9 fallback must not fire during a replay, because a rejected replay
 * step is a divergence to surface, not a move to silently substitute. The guard on the drain is
 * the fix for a real driver bug (an unconditional `runAll()` overwriting a freshly-set
 * `waitingFor`) and must stay identical to `applyDecision`'s.
 */
function submitRecorded(player: IPlayer, response: InputResponse): void {
  player.process(response);
  if (player.getWaitingFor() === undefined) {
    player.game.deferredActions.runAll(() => {});
  }
}

/**
 * Builds one throwaway fork positioned at the current decision point: restore the rolling
 * ancestor (or recreate the game, for the setup prefix) and replay the recorded responses since
 * it. Returns `undefined` rather than throwing, so a missing fork is a counted gap and never
 * looks like an illegal candidate.
 */
function buildFork(config: CandidateValidationConfig, ancestor: Ancestor, recorded: ReadonlyArray<RecordedDecision>): IGame | undefined {
  let forked: IGame;
  try {
    forked = ancestor.snap === undefined ?
      createGame({players: config.players, seed: config.engineSeed}) :
      restore(ancestor.snap, {verify: 'pending'});
  } catch (error) {
    if (!(error instanceof SnapshotFidelityError)) {
      throw error;
    }
    return undefined;
  }

  for (let i = ancestor.index; i < recorded.length; i++) {
    if (forked.phase === Phase.END) {
      return undefined;
    }
    const player = nextWaitingPlayer(forked);
    if (player === undefined || player.id !== recorded[i].playerId) {
      return undefined;
    }
    try {
      submitRecorded(player, copyResponse(recorded[i].response));
    } catch {
      return undefined;
    }
  }
  return forked;
}

/**
 * The **contents** of every waiting player's pending decision, as the serialized model the Agent
 * actually reasons about (`waitingFor.toModel(player)`, the same construction `toDecisionPoint`
 * uses in both transports).
 *
 * **Why this exists, and it is the main finding of this unit's corpus run.** Hazard H7's two-way
 * check - `pendingSignature` **and** `stableStateOf` - is not sufficient to certify a fork for
 * candidate probing, and the first 2-game smoke run demonstrated it: 29 candidates were "rejected
 * by the Engine", every one of them an `or` whose branch response did not match the branch, some
 * with `Invalid index` - an index this module cannot generate for the decision it was looking at.
 * The forks had passed both checks and were nevertheless positioned at a *different* `or`.
 *
 * That follows from what each check can see. `pendingSignature` is deliberately coarse -
 * `` `${player.id}:${type}` `` - so a mid-action `OrOptions` sub-decision and the top-of-turn
 * "take your next action" `OrOptions` that `Game.deserialize` regenerates in its place are the
 * same string. And the pending decision is *not serialized at all* (`Game.serialize()` hardcodes
 * `deferredActions: []`), so `stableStateOf` is byte-identical across the substitution. This is
 * precisely bullet 4's "action-phase failures are 100% silent" population, seen from a new angle:
 * it is silent to the *validation* too.
 *
 * It matters here in a way it did not for `bench/forkCost.ts` (whose 26,026 forks reproduced
 * "exactly" under the same two checks) because that suite only ever asked whether the state came
 * back, while an agent forking to try a move must land on **the same decision** or its move is
 * answering a different question. So this module uses a third, strictly finer check for both
 * things it does with a restore: adopting an ancestor, and probing a candidate.
 *
 * Recorded for Unit A: `search/fork.ts`'s validation should carry this check too, and for Unit D:
 * the forkability rate under this definition is lower than §2.4's ~72%, and the gap is the number
 * to report.
 */
function pendingModelSignature(game: IGame): string {
  const parts: Array<string> = [];
  for (const player of game.playersInGenerationOrder) {
    const waitingFor = player.getWaitingFor();
    if (waitingFor !== undefined) {
      parts.push(JSON.stringify({id: player.id, model: toDecisionPoint(player, waitingFor).model}));
    }
  }
  return parts.join('|');
}

/** The live position a fork has to reproduce, captured once per decision point. */
type LiveSignature = {
  readonly pending: string;
  readonly stable: string;
  readonly pendingModel: string;
};

/**
 * Fork validation, three ways: hazard H7's `pendingSignature` **and** `stableStateOf`, plus
 * {@link pendingModelSignature}. Returns the gap that fired, or `undefined` when the fork is the
 * live position. The log is ignored on both sides because forks here are log-stripped, which
 * bullet 4 proved rules-neutral.
 */
function forkGapOf(forked: IGame, live: LiveSignature): ForkGap | undefined {
  if (pendingSignature(forked) !== live.pending || stableStateOf(forked.serialize(), {ignoreLog: true}) !== live.stable) {
    return 'forkUnfaithful';
  }
  if (pendingModelSignature(forked) !== live.pendingModel) {
    return 'forkPendingModelMismatch';
  }
  return undefined;
}

type Accumulator = {
  byType: Map<string, TypeAccumulator>;
  forkGaps: Record<ForkGap, number>;
  rejections: Array<CandidateRejection>;
  fr9Fallbacks: number;
  decisionPoints: number;
  decisionsValidated: number;
};

function statsFor(acc: Accumulator, type: PlayerInputModel['type']): TypeAccumulator {
  let stats = acc.byType.get(type);
  if (stats === undefined) {
    stats = emptyTypeStats();
    acc.byType.set(type, stats);
  }
  return stats;
}

/**
 * Drives one game to `Phase.END`, validating every candidate at every decision point along the
 * way. The live game is advanced by the random-legal agent through the ordinary driver, so the
 * corpus of positions visited is exactly the Milestone-1 one - candidate generation must not
 * change which games get played, or G1a would be measured on a different distribution than the
 * one AC-1 was.
 */
function validateGame(config: CandidateValidationConfig, options: CandidateValidationOptions, acc: Accumulator): void {
  const game = createGame({players: config.players, seed: config.engineSeed});
  const agent: EmbeddedResponder = randomLegalAgent(createAgentRandom(config.agentSeed));
  // A second, independent agent-side stream for candidate generation, so probing consumes no
  // draws from the stream that decides the live game's moves and the corpus stays byte-identical
  // to an unprobed run. Derived from the agent seed, never from the Engine seed (SRS CON-5, H8).
  const candidateRng = createAgentRandom(config.agentSeed + 1_000_003);

  let acceptedResponse: InputResponse | undefined;
  const recorder: EmbeddedResponder = (decision) => {
    const response = agent(decision);
    acceptedResponse = response;
    return response;
  };
  const driverOptions: EmbeddedDriverOptions = {
    // Hazard H3: record what the Engine *accepted*, not what the responder returned. When the
    // FR-9 fallback fires the driver submits something else entirely, and a replay of the
    // responder's move would reproduce a different game.
    onFallback: (event) => {
      acceptedResponse = event.fallbackInput;
      acc.fr9Fallbacks++;
    },
  };

  const recorded: Array<RecordedDecision> = [];
  let ancestor: Ancestor = {index: 0, snap: undefined};

  while (game.phase !== Phase.END) {
    const waitingPlayer = nextWaitingPlayer(game);
    if (waitingPlayer === undefined) {
      throw new Error(`${config.players}p/seed=${config.engineSeed}: no player has a pending input, but phase is '${game.phase}'`);
    }
    const waitingFor = waitingPlayer.getWaitingFor();
    if (waitingFor === undefined) {
      throw new Error(`${config.players}p/seed=${config.engineSeed}: the waiting player has no pending input`);
    }
    const decision = toDecisionPoint(waitingPlayer, waitingFor);
    const type = decision.model.type;
    const stats = statsFor(acc, type);
    acc.decisionPoints++;
    stats.decisions++;

    const live: LiveSignature = {
      pending: pendingSignature(game),
      stable: stableStateOf(game.serialize(), {ignoreLog: true}),
      pendingModel: pendingModelSignature(game),
    };

    // Roll the ancestor forward to this point when the point is itself forkable. The definition
    // used here is stricter than `bench/forkCost.ts`'s - `assertSnapshotSafe` accepts the point,
    // a verifying restore returns, *and* the restored game presents the same pending decision
    // *contents* ({@link pendingModelSignature}). A point that fails only the last of those is
    // the silent substitution bullet 4 catalogued; adopting it as an ancestor would poison every
    // replay descended from it, so it is refused and counted. The probe restore is kept and spent
    // as the first candidate's fork rather than thrown away.
    let pooledFork: IGame | undefined;
    if (isGuardSafe(game)) {
      const snap = snapshot(game, {stripLog: true});
      try {
        const restored = restore(snap, {verify: 'pending'});
        if (pendingModelSignature(restored) === live.pendingModel) {
          pooledFork = restored;
          ancestor = {index: recorded.length, snap};
        } else {
          acc.forkGaps.ancestorPendingModelMismatch++;
        }
      } catch (error) {
        if (!(error instanceof SnapshotFidelityError)) {
          throw error;
        }
      }
    }

    const set = candidates(decision, candidateRng);
    stats.candidatesGenerated += set.generated;
    stats.setSizes.push(set.candidates.length);
    if (set.cappedNodes > 0) {
      stats.cappedDecisions++;
    }
    if (set.candidates.length === 0) {
      stats.emptySets++;
    }
    for (const candidate of set.candidates) {
      countResponseTypes(candidate, acc);
    }

    const probes = subsampleProbes(set.candidates, options.maxCandidatesPerDecision);
    if (probes.length > 0) {
      const first = pooledFork ?? buildFork(config, ancestor, recorded);
      const gap = first === undefined ? 'forkUnavailable' : forkGapOf(first, live);
      if (first === undefined || gap !== undefined) {
        acc.forkGaps[gap ?? 'forkUnavailable']++;
      } else {
        acc.decisionsValidated++;
        stats.decisionsValidated++;
        let fork: IGame | undefined = first;
        for (let i = 0; i < probes.length; i++) {
          if (fork === undefined) {
            acc.forkGaps.forkUnavailable++;
            break;
          }
          submitProbe(fork, waitingPlayer.id, probes[i], i, type, config, recorded.length + 1, options, acc, stats);
          fork = i + 1 < probes.length ? buildFork(config, ancestor, recorded) : undefined;
        }
      }
    }

    acceptedResponse = undefined;
    applyDecision(waitingPlayer, recorder, driverOptions);
    if (acceptedResponse === undefined) {
      throw new Error(`${config.players}p/seed=${config.engineSeed} #${recorded.length + 1}: the decision was applied but no accepted response was captured`);
    }
    recorded.push({playerId: waitingPlayer.id, response: copyResponse(acceptedResponse)});
  }
}

/**
 * Records every decision type a candidate exercises, walking into composite responses. The
 * `InputResponse` and `PlayerInputModel` unions use the same `type` strings, so the response tree
 * is a faithful record of which generators ran.
 */
function countResponseTypes(response: InputResponse, acc: Accumulator): void {
  statsFor(acc, response.type as PlayerInputModel['type']).candidateAppearances++;
  switch (response.type) {
  case 'or':
    countResponseTypes(response.response, acc);
    break;
  case 'and':
  case 'initialCards':
    for (const child of response.responses) {
      countResponseTypes(child, acc);
    }
    break;
  default:
    break;
  }
}

/** Submits one candidate into `fork` and records the Engine's verdict. The fork is discarded after. */
function submitProbe(
  fork: IGame,
  playerId: string,
  candidate: InputResponse,
  candidateIndex: number,
  type: string,
  config: CandidateValidationConfig,
  decisionIndex: number,
  options: CandidateValidationOptions,
  acc: Accumulator,
  stats: TypeAccumulator,
): void {
  const player = fork.playersInGenerationOrder.find((p) => p.id === playerId);
  if (player === undefined) {
    acc.forkGaps.forkUnavailable++;
    return;
  }
  stats.candidatesSubmitted++;
  try {
    // The definition of legal (SRS CON-2, and the Milestone-1 enumerator specs' one hard rule):
    // the Engine's own `process()` accepts it on **first** submission. No drain, no retry, no
    // fallback - anything beyond `process()` would be measuring something else.
    player.process(copyResponse(candidate));
    stats.candidatesAccepted++;
  } catch (error) {
    stats.candidatesRejected++;
    const limit = options.maxRejectionsRecorded ?? 50;
    if (acc.rejections.length < limit) {
      acc.rejections.push({
        players: config.players,
        engineSeed: config.engineSeed,
        decisionIndex,
        decisionType: type,
        candidateIndex,
        candidate: JSON.stringify(candidate),
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Uniform subsample of the candidates to actually submit, when a smoke run asks for one. */
function subsampleProbes(all: ReadonlyArray<InputResponse>, max: number | undefined): ReadonlyArray<InputResponse> {
  if (max === undefined || all.length <= max) {
    return all;
  }
  const step = all.length / max;
  return Array.from({length: max}, (_, i) => all[Math.floor(i * step)]);
}

function percentile(sorted: ReadonlyArray<number>, fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

/** The three-number summary the artifact carries in place of the raw per-decision sizes. */
function summarize(sizes: ReadonlyArray<number>): SetSizeSummary {
  const sorted = [...sizes].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
  };
}

/**
 * Runs the corpus. Yields to the event loop between games (hazard H9: `Game.gotoEndGame()` is
 * unawaited async, so a synchronous batch loop holds every finished game alive), which is why
 * this is async even though nothing in it awaits I/O.
 */
export async function runCandidateValidation(
  configs: ReadonlyArray<CandidateValidationConfig>,
  options: CandidateValidationOptions = {},
): Promise<CandidateValidationReport> {
  const started = Date.now();
  const acc: Accumulator = {
    byType: new Map(),
    forkGaps: {forkUnavailable: 0, forkUnfaithful: 0, forkPendingModelMismatch: 0, ancestorPendingModelMismatch: 0},
    rejections: [],
    fr9Fallbacks: 0,
    decisionPoints: 0,
    decisionsValidated: 0,
  };
  const failedGames: Array<{config: CandidateValidationConfig; message: string}> = [];

  // Terminal states restore into Phase.END, where Game.deserialize touches this lazy singleton -
  // construct it up front so its one-off cost and its log line land outside the corpus loop.
  GameLoader.getInstance();

  const restoreConsole = (options.silenceLogs ?? true) ? silenceConsole() : undefined;
  try {
    let completed = 0;
    for (const config of configs) {
      try {
        validateGame(config, options, acc);
      } catch (error) {
        failedGames.push({config, message: error instanceof Error ? error.message : String(error)});
      }
      completed++;
      options.onProgress?.(completed, configs.length);
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    restoreConsole?.();
  }

  const byType: Record<string, CandidateTypeStats> = {};
  const allSetSizes: Array<number> = [];
  let candidatesGenerated = 0;
  let candidatesSubmitted = 0;
  let candidatesAccepted = 0;
  let candidatesRejected = 0;
  let cappedDecisions = 0;
  let emptySets = 0;
  for (const [type, stats] of [...acc.byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const {setSizes, ...rest} = stats;
    byType[type] = {...rest, setSize: summarize(setSizes)};
    allSetSizes.push(...setSizes);
    candidatesGenerated += stats.candidatesGenerated;
    candidatesSubmitted += stats.candidatesSubmitted;
    candidatesAccepted += stats.candidatesAccepted;
    candidatesRejected += stats.candidatesRejected;
    cappedDecisions += stats.cappedDecisions;
    emptySets += stats.emptySets;
  }
  allSetSizes.sort((a, b) => a - b);

  return {
    gamesRun: configs.length,
    gamesCompleted: configs.length - failedGames.length,
    decisionPoints: acc.decisionPoints,
    decisionsValidated: acc.decisionsValidated,
    forkGaps: acc.forkGaps,
    candidatesGenerated,
    candidatesSubmitted,
    candidatesAccepted,
    candidatesRejected,
    cappedDecisions,
    emptySets,
    setSize: summarize(allSetSizes),
    byType,
    unreachedTypes: IN_SCOPE_TYPES.filter((type) => (byType[type]?.decisions ?? 0) === 0 && (byType[type]?.candidateAppearances ?? 0) === 0),
    unvalidatedTypes: IN_SCOPE_TYPES.filter((type) => (byType[type]?.decisions ?? 0) > 0 && (byType[type]?.decisionsValidated ?? 0) === 0),
    rejections: acc.rejections,
    fr9Fallbacks: acc.fr9Fallbacks,
    failedGames,
    wallClockMs: Date.now() - started,
  };
}

/**
 * Silences the routine per-decision noise a long corpus buries everything else under - the
 * driver's FR-9 `console.warn` (counted through `onFallback` anyway) and the Engine's own cache
 * log lines. Returns the restore function; the caller must call it in a `finally`.
 */
function silenceConsole(): () => void {
  const {log, warn, error} = console;
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  return () => {
    console.log = log;
    console.warn = warn;
    console.error = error;
  };
}

/**
 * The corpus seeds: `games` per player count, Engine and Agent seeds derived from independent
 * transforms of the base (SRS CON-5) so the whole run is reproducible from the CLI invocation.
 * The bases are deliberately away from the Milestone-1 legality and determinism seed spaces, so
 * a candidate-path defect cannot hide behind games those runs already established as clean.
 */
export function buildCandidateValidationConfigs(
  composition: ReadonlyArray<{players: number; games: number}>,
  engineSeedBase = 900_000,
  agentSeedBase = 700_001,
): ReadonlyArray<CandidateValidationConfig> {
  const configs: Array<CandidateValidationConfig> = [];
  for (const {players, games} of composition) {
    for (let i = 0; i < games; i++) {
      configs.push({
        players,
        engineSeed: engineSeedBase + players * 100_000 + i * 13,
        agentSeed: agentSeedBase + players * 7_919 + i * 104_729,
      });
    }
  }
  return configs;
}
