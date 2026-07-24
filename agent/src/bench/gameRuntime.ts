/**
 * Sub-task B of the Milestone 1, bullet 5 simulator-speed spike
 * (agent/docs/Milestone1_Bullet5_Prompts.md): full-game headless runtime.
 *
 * Produces the first of the spike's three required measurements (wall-clock per game) plus the
 * per-decision component breakdown that sub-tasks D and E both consume as `rollout_step`. This
 * module takes no measurement of clone/restore cost (sub-task C) or fork realism (sub-task D) -
 * it only drives complete games with the random-legal agent and times what that costs.
 *
 * Instrumentation happens by wrapping the `EmbeddedResponder` the driver is handed - never by
 * editing `embeddedDriver.ts` or `decisionPoint.ts` (the shared preamble's hard rule). See
 * `instrumentedResponder` below for the injection point and why a *second*, throwaway rng is
 * required to keep the instrumented run reproducible.
 */
import {Phase} from '@/common/Phase';
import {createGame} from '../engine/gameFactory';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom, AgentRandom} from '../core/rng';
import {enumerate} from '../core/enumerator';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedResponder} from '../driver/responder';
import {runGame} from '../driver/embeddedDriver';
import {BenchReport, BenchStats, BenchSuite, BenchSuiteOptions, ConsoleCounts} from './types';
import {benchEnvironment, silenceConsole, summarize, timed} from './harness';

/**
 * Per-decision timing accumulator filled in by {@link instrumentedResponder} while driving one
 * instrumented game. `toModelMs`/`enumerateMs` have one entry per decision **that didn't throw**
 * - see the function's doc comment for why a throw is swallowed rather than counted as 0ms.
 * `enumerateThrows` counts the decisions where the retimed `enumerate` call raised (independent
 * of `throwawayRng`'s draw - e.g. "no affordable standard project" is a fact about game state,
 * not about which rng stream asks), so `enumerateMs.length + enumerateThrows === decisions`.
 */
type InstrumentedAccumulator = {
  toModelMs: Array<number>;
  enumerateMs: Array<number>;
  enumerateThrows: number;
};

/**
 * Wraps a real (seeded) responder so every decision also re-times `toModel` (the HTTP-transport
 * model construction `toDecisionPoint` already builds unconditionally on the embedded hot path -
 * see `agent/src/driver/decisionPoint.ts:33`) and `enumerate` (the agent's own move selection),
 * without perturbing the real agent's move, rng stream, or the response actually submitted.
 *
 * Three things matter here:
 * - `decision.raw.toModel(decision.player)` is a pure model constructor over already-live state,
 *   so calling it a second time purely for timing is safe - it does not mutate anything.
 * - `throwawayRng` must **never** be the real agent's own `AgentRandom`. Calling `enumerate` a
 *   second time against the real stream would advance it, silently diverging the instrumented
 *   run from the clean one it's supposed to be timing a copy of. A second, independently-seeded
 *   `AgentRandom` keeps the real agent's stream (and therefore the game) untouched.
 * - **The retimed `enumerate` call can legitimately throw** (e.g. "no actable, affordable
 *   standard project among N offered" - a fact about live game state, not about which rng stream
 *   is asking, so a different `throwawayRng` draw hits it too). If that throw were allowed to
 *   propagate out of this responder, `applyDecision` would treat it exactly like a genuine
 *   responder failure and resubmit the FR-9 conservative fallback **instead of the real agent's
 *   move** - silently replacing the actual decision this suite is trying to time, for a reason
 *   that has nothing to do with the real agent. It's caught and counted instead, and `inner`
 *   (the real agent) always still gets to decide.
 */
function instrumentedResponder(inner: EmbeddedResponder, acc: InstrumentedAccumulator, throwawayRng: AgentRandom): EmbeddedResponder {
  return (decision: EmbeddedDecisionPoint) => {
    acc.toModelMs.push(timed(() => decision.raw.toModel(decision.player)).ms);
    try {
      acc.enumerateMs.push(timed(() => enumerate(decision, throwawayRng)).ms);
    } catch {
      acc.enumerateThrows++;
    }
    return inner(decision);
  };
}

/** Deterministic per-game engine seed, distinct per player count so corpora never overlap. */
function engineSeedFor(base: number, players: number, gameIndex: number): number {
  return base + players * 1_000_000 + gameIndex;
}

/**
 * Deterministic per-game agent seed, derived from `agentSeedBase` by a transform that never
 * touches the engine seed (SRS CON-5: the two seeds must be chosen independently of one another).
 */
function agentSeedFor(agentSeedBase: number, players: number, gameIndex: number): number {
  return agentSeedBase + players * 2_000_003 + gameIndex * 7 + 1;
}

/** A throwaway agent seed, offset far enough from the real per-game agent seeds to never collide. */
function throwawaySeedFor(agentSeedBase: number, players: number, gameIndex: number): number {
  return agentSeedFor(agentSeedBase, players, gameIndex) + 500_000_000;
}

type CleanGameOutcome = {
  ms: number;
  decisions: number;
  generation: number;
  fallbacks: number;
};

type InstrumentedGameOutcome = {
  ms: number;
  decisions: number;
  fallbacks: number;
  toModelMs: ReadonlyArray<number>;
  enumerateMs: ReadonlyArray<number>;
  enumerateThrows: number;
};

/** Drives one clean (uninstrumented) game and times the whole run. */
function runCleanGame(players: number, engineSeed: number, agentSeed: number): CleanGameOutcome {
  const game = createGame({players, seed: engineSeed});
  let decisions = 0;
  let fallbacks = 0;
  const agent = randomLegalAgent(createAgentRandom(agentSeed));
  const countingAgent: EmbeddedResponder = (decision) => {
    decisions++;
    return agent(decision);
  };

  const {ms, result} = timed(() => runGame(game, countingAgent, {onFallback: () => { fallbacks++; }}));

  if (game.phase !== Phase.END) {
    throw new Error(`gameRuntime: game (players=${players}, seed=${engineSeed}) returned from runGame without reaching Phase.END`);
  }

  return {ms, decisions, generation: result.generation, fallbacks};
}

/** Drives one instrumented game (component breakdown), separately from the clean timing run. */
function runInstrumentedGame(players: number, engineSeed: number, agentSeed: number, throwawaySeed: number): InstrumentedGameOutcome {
  const game = createGame({players, seed: engineSeed});
  const acc: InstrumentedAccumulator = {toModelMs: [], enumerateMs: [], enumerateThrows: 0};
  let fallbacks = 0;
  const agent = randomLegalAgent(createAgentRandom(agentSeed));
  const throwawayRng = createAgentRandom(throwawaySeed);
  const responder = instrumentedResponder(agent, acc, throwawayRng);

  const {ms} = timed(() => runGame(game, responder, {onFallback: () => { fallbacks++; }}));

  if (game.phase !== Phase.END) {
    throw new Error(`gameRuntime: instrumented game (players=${players}, seed=${engineSeed}) returned from runGame without reaching Phase.END`);
  }

  return {
    ms,
    decisions: acc.toModelMs.length,
    fallbacks,
    toModelMs: acc.toModelMs,
    enumerateMs: acc.enumerateMs,
    enumerateThrows: acc.enumerateThrows,
  };
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((a, b) => a + b, 0);
}

/** The median of a numeric sample, using the same even-length convention as `summarize`. */
function medianOf(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return 0;
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Merges per-suppressed-region console counts into a running total (see the shared preamble). */
function mergeConsoleCounts(into: ConsoleCounts, from: ConsoleCounts): void {
  into.log += from.log;
  into.warn += from.warn;
  into.error += from.error;
  for (const [name, count] of Object.entries(from.matched)) {
    into.matched[name] = (into.matched[name] ?? 0) + count;
  }
}

/**
 * The `game-runtime` suite (sub-task B). `options.scale` is the number of games driven **per
 * player count** (default 20 for a routine run; the committed sub-task E run uses >=100). Each
 * player count in `options.players` is measured twice: once with a clean (uninstrumented) agent
 * for the wall-clock/decisions/generation headline numbers, once with the instrumented responder
 * for the toModel/enumerate/residual component breakdown - see `instrumentedResponder`'s doc
 * comment for why these must be two separate runs rather than one.
 */
export const gameRuntime: BenchSuite = {
  name: 'game-runtime',
  description: 'Full-game headless runtime: wall-clock/game, decisions/game, and the toModel/enumerate/Engine component breakdown.',
  run: (options: BenchSuiteOptions): BenchReport => {
    const stats: Array<BenchStats> = [];
    const metrics: Record<string, number | string | ReadonlyArray<number>> = {
      scale: options.scale,
      seed: options.seed,
      agentSeed: options.agentSeed,
      players: options.players,
    };
    const notes: Array<string> = [
      'Two runs per player count: "clean" (plain agent, wall-clock source of truth) and ' +
      '"instrumented" (re-times toModel + enumerate per decision via a throwaway rng). The ' +
      'instrumented run carries measurable overhead of its own - see the .overheadFactor metric ' +
      'per player count - so its components are shares of the instrumented total, not absolute ' +
      'numbers to subtract from the clean total.',
      'residualPerGameMs (Engine work: player.process/deferred drain/driver loop) is computed as ' +
      'instrumented game wall-clock minus that game\'s own summed toModel + enumerate time.',
      'residualPerDecisionMedianMs approximates per-decision Engine cost as ' +
      'median(residualPerGameMs) / median(decisionsPerGame) - a corpus-level ratio, not a ' +
      'per-decision sample, since residual is only measurable at game granularity.',
    ];
    const totalConsoleCounts: ConsoleCounts = {log: 0, warn: 0, error: 0, matched: {}};

    const rssBefore = process.memoryUsage().rss;
    let peakHeapUsed = process.memoryUsage().heapUsed;

    for (const players of options.players) {
      const cleanOutcomes: Array<CleanGameOutcome> = [];
      const instrumentedOutcomes: Array<InstrumentedGameOutcome> = [];

      const {counts} = silenceConsole(() => {
        for (let i = 0; i < options.scale; i++) {
          const engineSeed = engineSeedFor(options.seed, players, i);
          const agentSeed = agentSeedFor(options.agentSeed, players, i);

          const clean = runCleanGame(players, engineSeed, agentSeed);
          cleanOutcomes.push(clean);
          peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);

          const throwawaySeed = throwawaySeedFor(options.agentSeed, players, i);
          const instrumented = runInstrumentedGame(players, engineSeed, agentSeed, throwawaySeed);
          instrumentedOutcomes.push(instrumented);
          peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
        }
      });
      mergeConsoleCounts(totalConsoleCounts, counts);

      const suffix = `${players}p`;

      // --- Headline numbers (clean run) ---
      const gameTimes = cleanOutcomes.map((o) => o.ms);
      const decisionsPerGame = cleanOutcomes.map((o) => o.decisions);
      const generationsPerGame = cleanOutcomes.map((o) => o.generation);
      const cleanTotalMs = sum(gameTimes);
      const cleanTotalDecisions = sum(decisionsPerGame);
      const cleanTotalFallbacks = sum(cleanOutcomes.map((o) => o.fallbacks));

      stats.push(summarize(`gameTime.${suffix}`, gameTimes));
      stats.push(summarize(`decisionsPerGame.${suffix}`, decisionsPerGame));
      stats.push(summarize(`generationsPerGame.${suffix}`, generationsPerGame));

      metrics[`decisionsPerGame.${suffix}.distribution`] = decisionsPerGame;
      metrics[`gamesPerSecond.${suffix}`] = cleanTotalMs > 0 ? (cleanOutcomes.length / (cleanTotalMs / 1000)) : 0;
      metrics[`decisionsPerSecond.${suffix}`] = cleanTotalMs > 0 ? (cleanTotalDecisions / (cleanTotalMs / 1000)) : 0;
      metrics[`fallbacksPer1000Decisions.${suffix}`] = cleanTotalDecisions > 0 ? (cleanTotalFallbacks * 1000 / cleanTotalDecisions) : 0;

      // --- Component breakdown (instrumented run) ---
      const allToModelMs = instrumentedOutcomes.flatMap((o) => o.toModelMs);
      const allEnumerateMs = instrumentedOutcomes.flatMap((o) => o.enumerateMs);
      const residualPerGameMs = instrumentedOutcomes.map((o) => o.ms - sum(o.toModelMs) - sum(o.enumerateMs));
      const instrumentedTotalMs = sum(instrumentedOutcomes.map((o) => o.ms));

      stats.push(summarize(`toModel.${suffix}`, allToModelMs));
      stats.push(summarize(`enumerate.${suffix}`, allEnumerateMs));
      stats.push(summarize(`residualPerGame.${suffix}`, residualPerGameMs));

      const toModelTotal = sum(allToModelMs);
      const enumerateTotal = sum(allEnumerateMs);
      const residualTotal = sum(residualPerGameMs);
      const componentTotal = toModelTotal + enumerateTotal + residualTotal;
      metrics[`toModelShare.${suffix}`] = componentTotal > 0 ? toModelTotal / componentTotal : 0;
      metrics[`enumerateShare.${suffix}`] = componentTotal > 0 ? enumerateTotal / componentTotal : 0;
      metrics[`residualShare.${suffix}`] = componentTotal > 0 ? residualTotal / componentTotal : 0;
      metrics[`overheadFactor.${suffix}`] = cleanTotalMs > 0 ? instrumentedTotalMs / cleanTotalMs : 0;

      const medianDecisionsPerGame = medianOf(decisionsPerGame);
      const medianResidualPerGame = medianOf(residualPerGameMs);
      metrics[`residualPerDecisionMedianMs.${suffix}`] = medianDecisionsPerGame > 0 ? medianResidualPerGame / medianDecisionsPerGame : 0;

      const enumerateThrows = sum(instrumentedOutcomes.map((o) => o.enumerateThrows));
      metrics[`enumerateRetimeThrows.${suffix}`] = enumerateThrows;
      if (enumerateThrows > 0) {
        notes.push(
          `${suffix}: the retimed enumerate() call threw ${enumerateThrows} time(s) out of ` +
          `${sum(instrumentedOutcomes.map((o) => o.decisions))} decisions (e.g. "no affordable ` +
          'standard project" - a state fact, not a bug); those decisions have no enumerate sample ' +
          'and their cost is folded into residualPerGame instead, per instrumentedResponder\'s doc comment.',
        );
      }

      const medianGenerations = medianOf(generationsPerGame);
      if (medianGenerations < 6 || medianGenerations > 16) {
        notes.push(
          `${suffix}: median generations/game is ${medianGenerations}, outside the ~8-12 range a ` +
          'base+CorpEra+Prelude game is expected to land in - check the corpus before trusting these numbers.',
        );
      }
    }

    const rssAfter = process.memoryUsage().rss;
    metrics.rssBeforeBytes = rssBefore;
    metrics.rssAfterBytes = rssAfter;
    metrics.peakHeapUsedBytes = peakHeapUsed;

    return {
      suite: gameRuntime.name,
      environment: benchEnvironment(),
      stats,
      metrics,
      consoleCounts: totalConsoleCounts,
      notes,
    };
  },
};
