import {Phase} from '@/common/Phase';
import {createGame} from '../engine/gameFactory';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
import {runGame, UnrecoverableIllegalMoveError} from '../driver/embeddedDriver';
import {errorClassName} from './causes';
import {SubmissionMonitor} from './submissionMonitor';
import {
  LegalityGameConfig,
  LegalityGameRecord,
  LegalityRunReport,
  Percentiles,
  StabilitySample,
} from './types';

/**
 * The AC-1 legality run itself (Milestone 1 exit criterion, legality half). Criteria L1-L7 are
 * pre-committed in agent/docs/AC1_Legality_Run.md; this module produces the evidence for them and
 * decides nothing.
 *
 * Two design points worth not rediscovering:
 *
 * **The loop is async and yields between games, deliberately.** `Game.gotoEndGame()` is unawaited
 * async (Determinism_Verification.md / Running Notes 2026-07-24), so a synchronous batch loop
 * defers every finished game's completion work and holds each finished `Game` alive through its
 * pending continuation - measured at ~0.27 MB per queued game, and at 1,500 games that is both a
 * false leak signal for criterion L7 and a real memory problem. Yielding between games lets those
 * continuations run. That entry flagged this run by name; this is the loop it was flagging.
 *
 * **A failing game does not abort the run.** A crash is a blocking-criterion breach (L3) whatever
 * else happens, and stopping at the first one would throw away the diagnostic value of the other
 * 1,499 games - including whether the failure is systematic or a single seed. Failures are
 * recorded with their error class and message and the run continues; the summary reports them and
 * the write-up adjudicates.
 */

export type LegalityRunOptions = {
  /** Sample heap/RSS every N games (criterion L7). Default 25. */
  heapSampleEvery?: number;
  /** Called after each game, for progress reporting. */
  onProgress?: (completed: number, total: number, record: LegalityGameRecord) => void;
  /** Yield to the event loop every N games. Default 1 - see the module doc for why this matters. */
  yieldEvery?: number;
  /**
   * Silences the two per-decision log lines a long run would otherwise drown in: the driver's
   * unconditional `console.warn` on every FR-9 fallback (embeddedDriver.ts) and the Engine's
   * `Marking <game> to be evicted` on every finished game (`Cache.mark`, src/server/database/Cache.ts).
   *
   * This is safe **because** of the strict accounting, not in spite of it: every fallback is
   * already counted through `onFallback` and every submission through {@link SubmissionMonitor},
   * so the log line carries no information the report doesn't. At 1,500 games it is ~9,000 lines
   * of stderr that would bury the summary and any genuine failure message. Off by default, so a
   * small ad-hoc shard still logs normally.
   */
  silenceRoutineLogs?: boolean;
};

export async function runLegalityBatch(
  configs: ReadonlyArray<LegalityGameConfig>,
  options: LegalityRunOptions = {},
): Promise<LegalityRunReport> {
  ensureHeadlessEngine();

  const heapSampleEvery = options.heapSampleEvery ?? 25;
  const yieldEvery = options.yieldEvery ?? 1;

  const monitor = new SubmissionMonitor();
  monitor.install();

  const originalWarn = console.warn;
  const originalLog = console.log;
  if (options.silenceRoutineLogs === true) {
    console.warn = () => {};
    console.log = () => {};
  }

  const games: Array<LegalityGameRecord> = [];
  const stability: Array<StabilitySample> = [];
  let unrecoverableIllegalMoves = 0;
  const runStart = Date.now();

  try {
    for (const [index, config] of configs.entries()) {
      monitor.startGame();
      const record = playOneGame(config, monitor);
      if (record.failure?.errorClass === UnrecoverableIllegalMoveError.name) {
        unrecoverableIllegalMoves++;
      }
      games.push(record);
      options.onProgress?.(games.length, configs.length, record);

      if ((index + 1) % yieldEvery === 0) {
        await yieldToEventLoop();
      }
      if ((index + 1) % heapSampleEvery === 0) {
        // Sampled *after* the yield above so the pending `gotoEndGame` continuations of the games
        // in this window have actually run - otherwise the sample measures the backlog, not the run.
        await yieldToEventLoop();
        forceGcIfAvailable();
        const usage = process.memoryUsage();
        stability.push({
          gamesCompleted: index + 1,
          heapUsedMb: round(usage.heapUsed / 1024 / 1024, 2),
          rssMb: round(usage.rss / 1024 / 1024, 2),
          elapsedMs: Date.now() - runStart,
        });
      }
    }
  } finally {
    monitor.uninstall();
    console.warn = originalWarn;
    console.log = originalLog;
  }

  // Let the last window's game-over continuations settle before the caller reads anything global.
  await yieldToEventLoop();
  const wallClockMs = Date.now() - runStart;

  return {
    summary: summarize(games, unrecoverableIllegalMoves, wallClockMs),
    causes: monitor.causeTallies,
    games,
    stability,
  };
}

function playOneGame(config: LegalityGameConfig, monitor: SubmissionMonitor): LegalityGameRecord {
  const {players, engineSeed, agentSeed} = config;
  const started = Date.now();

  let fallbacksAfterRejection = 0;
  let fallbacksAfterThrow = 0;
  let decisions = 0;

  const game = createGame({players, seed: engineSeed});
  const agent = randomLegalAgent(createAgentRandom(agentSeed));
  const responder = monitor.observeResponder((decision) => {
    decisions++;
    return agent(decision);
  });

  try {
    const result = runGame(game, responder, {
      onFallback: (event) => {
        // `rejectedInput === undefined` means the responder threw without producing a move (class
        // B - nothing was submitted); otherwise its move was submitted and rejected (class A - an
        // illegal move under this run's stated definition). See AC1_Legality_Run.md.
        if (event.rejectedInput === undefined) {
          fallbacksAfterThrow++;
        } else {
          fallbacksAfterRejection++;
        }
      },
    });

    const counters = monitor.gameCounters;
    return {
      players, engineSeed, agentSeed,
      completed: game.phase === Phase.END,
      decisions,
      generation: result.generation,
      fallbacksAfterRejection,
      fallbacksAfterThrow,
      responderThrows: counters.responderThrows,
      submissions: counters.submissions,
      rejectedResponder: counters.rejectedResponder,
      rejectedFallbackProbe: counters.rejectedFallbackProbe,
      victoryPoints: result.players.map((p) => p.victoryPoints),
      winners: result.winners.length,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const counters = monitor.gameCounters;
    return {
      players, engineSeed, agentSeed,
      completed: false,
      failure: {
        errorClass: errorClassName(error),
        message: error instanceof Error ? error.message : String(error),
      },
      decisions,
      generation: game.generation,
      fallbacksAfterRejection,
      fallbacksAfterThrow,
      responderThrows: counters.responderThrows,
      submissions: counters.submissions,
      rejectedResponder: counters.rejectedResponder,
      rejectedFallbackProbe: counters.rejectedFallbackProbe,
      victoryPoints: [],
      winners: 0,
      durationMs: Date.now() - started,
    };
  }
}

function summarize(
  games: ReadonlyArray<LegalityGameRecord>,
  unrecoverableIllegalMoves: number,
  wallClockMs: number,
): LegalityRunReport['summary'] {
  const completed = games.filter((g) => g.completed);
  const playerCounts: ReadonlyArray<2 | 3 | 4> = [2, 3, 4];

  return {
    gamesRun: games.length,
    gamesCompleted: completed.length,
    gamesFailed: games.length - completed.length,
    byPlayerCount: playerCounts
      .map((players) => {
        const shard = games.filter((g) => g.players === players);
        return {players, gamesRun: shard.length, gamesCompleted: shard.filter((g) => g.completed).length};
      })
      .filter((shard) => shard.gamesRun > 0),
    totalDecisions: sum(games.map((g) => g.decisions)),
    totalSubmissions: sum(games.map((g) => g.submissions)),
    unrecoverableIllegalMoves,
    rejectedResponder: sum(games.map((g) => g.rejectedResponder)),
    rejectedFallbackProbe: sum(games.map((g) => g.rejectedFallbackProbe)),
    responderThrows: sum(games.map((g) => g.responderThrows)),
    decisionsPerGame: percentiles(completed.map((g) => g.decisions)),
    generationsPerGame: percentiles(completed.map((g) => g.generation)),
    durationMsPerGame: percentiles(completed.map((g) => g.durationMs)),
    wallClockMs,
  };
}

export function percentiles(values: ReadonlyArray<number>): Percentiles {
  if (values.length === 0) {
    return {min: NaN, p50: NaN, p95: NaN, max: NaN, mean: NaN};
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: round(sum(sorted) / sorted.length, 2),
  };
}

/** Nearest-rank quantile - no interpolation, so every reported value is one actually observed. */
function quantile(sorted: ReadonlyArray<number>, q: number): number {
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)];
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Collects before sampling the heap, when the process was started with `--expose-gc`. Without it,
 * criterion L7 cannot separate the two things a rising `heapUsed` curve might mean: memory the run
 * is still holding (a leak), or memory V8 simply hasn't bothered to collect yet (not a leak, and
 * the far more likely reading on a run that allocates hundreds of megabytes of short-lived game
 * state). A post-collection curve that is flat says the first is not happening; a pre-collection
 * curve that rises says nothing at all. The run works either way - the sample is just weaker
 * without it - so this degrades silently rather than requiring the flag.
 */
function forceGcIfAvailable(): void {
  const gc = (globalThis as {gc?: () => void}).gc;
  gc?.();
}
