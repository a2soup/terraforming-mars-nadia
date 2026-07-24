/**
 * Sub-task C of the Milestone 1, bullet 5 simulator-speed spike
 * (agent/docs/Milestone1_Bullet5_Prompts.md): clone round-trip cost.
 *
 * Produces the second and third required measurements for the spike - clone round-trip time and
 * clones/second - by timing every layer of `agent/src/engine/snapshot.ts`'s clone primitive
 * (serialize, deep copy, `Game.deserialize`, the pending-signature/state verification levels, and
 * the composite `snapshot`/`restore`/`cloneGame` operations) at a stratified set of decision
 * points across full games.
 *
 * **The trap this file is built around** (restated from the sub-task prompt, itself restating
 * bullet 4 sub-task B's identical trap): 28.0%/26.8% of decision points (Running Notes,
 * 2026-07-22/23) are ones `assertSnapshotSafe` refuses. Every snapshot taken here uses
 * `{unsafe: true}` and every restore uses `{verify: 'none'}` for the *component and composite
 * timings* - safety is deliberately bypassed so the curve covers exactly the points the guard
 * exists to refuse, not just the cheap, guard-accepted ones. The `assertSnapshotSafe` verdict is
 * still recorded per point (never acted on), so the report can present the cost curve twice: once
 * over every sampled point, and once restricted to the safe subset search would actually see.
 */
import {Phase} from '@/common/Phase';
import {Game} from '@/server/Game';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {SerializedGame} from '@/server/SerializedGame';
import {GameLoader} from '@/server/database/GameLoader';
import {createGame} from '../engine/gameFactory';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
import {applyDecision} from '../driver/embeddedDriver';
import {
  GameSnapshot,
  SnapshotFidelityError,
  UnsafeSnapshotError,
  assertSnapshotSafe,
  cloneGame,
  pendingSignature,
  restore,
  snapshot,
} from '../engine/snapshot';
import {stableStateOf} from '../engine/stableState';
import {benchEnvironment, silenceConsole, summarize, timed} from './harness';
import {BenchReport, BenchStats, BenchSuite, BenchSuiteOptions} from './types';

/** Where in a game a sample was captured. `terminal` is the game's state at `Phase.END`, after the last decision. */
type Stratum = 'early' | 'mid' | 'late' | 'terminal';
const STRATA: ReadonlyArray<Stratum> = ['early', 'mid', 'late', 'terminal'];

/**
 * The component and composite operations timed at every sample point. `restoreNone` is timed at
 * {@link RESTORE_MANY_ITERATIONS} (100) rather than {@link COMPONENT_ITERATIONS} - it is the
 * "snapshot-once, restore-many" access pattern the prompt asks for explicitly ("N = 100"), and the
 * honest clones/second figure search actually lives on.
 */
const METRIC_NAMES = [
  'serialize', 'jsonDeepCopy', 'structuredClone', 'deserialize', 'pendingSignature',
  'stableStateWithLog', 'stableStateNoLog',
  'snapshotUnstripped', 'snapshotStripped',
  'restoreNone', 'restorePending', 'restoreState', 'restoreNoneStripped',
  'cloneGameNaive',
] as const;
type MetricName = typeof METRIC_NAMES[number];

const COMPONENT_ITERATIONS = 30;
const COMPONENT_WARMUP = 3;
/** The prompt's explicit "N = 100" for the snapshot-once/restore-many access pattern. */
const RESTORE_MANY_ITERATIONS = 100;
const RESTORE_MANY_WARMUP = 5;

function iterationsFor(metric: MetricName): {iterations: number; warmup: number} {
  return metric === 'restoreNone'
    ? {iterations: RESTORE_MANY_ITERATIONS, warmup: RESTORE_MANY_WARMUP}
    : {iterations: COMPONENT_ITERATIONS, warmup: COMPONENT_WARMUP};
}

/**
 * Must stay identical to the private `deepCopy` in `../engine/snapshot.ts` (deliberately not
 * exported from there - see Milestone1_Bullet5_Prompts.md, sub-task C). Needed here to hand
 * `Game.deserialize` its own fresh, disposable input on every timed call (see {@link timeDeserialize}).
 */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Times `restore(snap, {verify})` at a verification level that can legitimately throw
 * {@link SnapshotFidelityError} - `'pending'`/`'state'` reject roughly 28% of decision points
 * (Running Notes, 2026-07-22/23), and this suite deliberately samples those points too (see this
 * file's doc comment). The check itself still runs and still costs time whether or not it ends up
 * throwing, so the fidelity error is swallowed here rather than left to crash the benchmark - the
 * same reason bullet 4's own fidelity audit (`snapshotFidelity.spec.ts`) never runs verification
 * levels other than `'none'` over an unsafe-inclusive corpus. Any *other* thrown error is a real
 * bug and is left to propagate.
 */
function restoreIgnoringFidelityError(snap: GameSnapshot, verify: 'pending' | 'state'): void {
  try {
    restore(snap, {verify});
  } catch (error) {
    if (!(error instanceof SnapshotFidelityError)) {
      throw error;
    }
  }
}

/** Runs `warmup` untimed calls, then `iterations` timed calls, returning the raw millisecond samples. */
function timeMany(iterations: number, warmup: number, fn: () => void): ReadonlyArray<number> {
  for (let i = 0; i < warmup; i++) {
    fn();
  }
  const samples: Array<number> = [];
  for (let i = 0; i < iterations; i++) {
    samples.push(timed(fn).ms);
  }
  return samples;
}

/**
 * `Game.deserialize` both mutates its argument (`gameOptions.boardName` normalization) and
 * consumes it (re-aliases `gameLog`, drains deck arrays into a fresh `SeededRandom`) - see
 * `snapshot.ts`'s doc comment. Timing it in isolation therefore needs a *fresh* deep copy of
 * `base` on every call, generated up front so the copy itself isn't attributed to the timing.
 */
function timeDeserialize(base: SerializedGame, iterations: number, warmup: number): ReadonlyArray<number> {
  const inputs = Array.from({length: warmup + iterations}, () => deepCopy(base));
  for (let i = 0; i < warmup; i++) {
    Game.deserialize(inputs[i]);
  }
  const samples: Array<number> = [];
  for (let i = 0; i < iterations; i++) {
    samples.push(timed(() => Game.deserialize(inputs[warmup + i])).ms);
  }
  return samples;
}

/** `assertSnapshotSafe`'s verdict as a boolean, recorded per sample point but never acted on. */
function isSnapshotSafe(game: IGame): boolean {
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

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

type SamplePoint = {
  readonly players: number;
  readonly stratum: Stratum;
  readonly decisionIndex: number;
  readonly totalDecisions: number;
  readonly phase: Phase;
  readonly safe: boolean;
  readonly totalBytes: number;
  readonly gameLogBytes: number;
  readonly logShare: number;
  readonly timings: Readonly<Record<MetricName, ReadonlyArray<number>>>;
  /**
   * The (unstripped) snapshot captured at this point, kept around so the suite can pick one
   * point as the "single snapshot" for the dedicated snapshot-once/restore-many demonstration
   * (see `cloneCostSuite.run`) without re-driving a game just to get one.
   */
  readonly snap: GameSnapshot;
};

/**
 * Times every component and composite operation at the game's *current* decision point (before
 * the pending decision is applied - the state a search fork would actually see) and returns the
 * raw per-iteration millisecond samples for each, plus the size breakdown and the safety verdict.
 * Deliberately called *during* the drive, not from a stored copy afterward: only the live `game`
 * lets `serialize()`, `pendingSignature()` and the composite operations be timed directly, as the
 * prompt's component table asks for.
 */
function measureSamplePoint(game: IGame, players: number, stratum: Stratum, decisionIndex: number, totalDecisions: number): SamplePoint {
  const safe = isSnapshotSafe(game);
  const phase = game.phase;

  // One untimed capture of each snapshot flavor - reused as fixed input to every downstream
  // component measurement below, and as the single snapshot the restore-many timings restore
  // from repeatedly (restore() deep-copies its input internally, so reusing one snapshot object
  // across many restores is exactly the real "snapshot-once, restore-many" access pattern, not a
  // shortcut around it).
  const snap = snapshot(game, {unsafe: true});
  const strippedSnap = snapshot(game, {unsafe: true, stripLog: true});
  const base = snap.state;

  const totalBytes = JSON.stringify(base).length;
  const gameLogBytes = JSON.stringify(base.gameLog).length;

  const timings: Record<MetricName, ReadonlyArray<number>> = {
    serialize: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      game.serialize();
    }),
    jsonDeepCopy: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      JSON.parse(JSON.stringify(base));
    }),
    structuredClone: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      structuredClone(base);
    }),
    deserialize: timeDeserialize(base, COMPONENT_ITERATIONS, COMPONENT_WARMUP),
    pendingSignature: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      pendingSignature(game);
    }),
    stableStateWithLog: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      stableStateOf(base, {ignoreLog: false});
    }),
    stableStateNoLog: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      stableStateOf(base, {ignoreLog: true});
    }),
    snapshotUnstripped: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      snapshot(game, {unsafe: true});
    }),
    snapshotStripped: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      snapshot(game, {unsafe: true, stripLog: true});
    }),
    restoreNone: timeMany(RESTORE_MANY_ITERATIONS, RESTORE_MANY_WARMUP, () => {
      restore(snap, {verify: 'none'});
    }),
    restorePending: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      restoreIgnoringFidelityError(snap, 'pending');
    }),
    restoreState: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      restoreIgnoringFidelityError(snap, 'state');
    }),
    restoreNoneStripped: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      restore(strippedSnap, {verify: 'none'});
    }),
    cloneGameNaive: timeMany(COMPONENT_ITERATIONS, COMPONENT_WARMUP, () => {
      cloneGame(game, {unsafe: true, verify: 'none'});
    }),
  };

  return {
    players,
    stratum,
    decisionIndex,
    totalDecisions,
    phase,
    safe,
    totalBytes,
    gameLogBytes,
    logShare: gameLogBytes / totalBytes,
    timings,
    snap,
  };
}

/** Drives one full game with `randomLegalAgent`, counting decisions only - no snapshotting. */
function countDecisions(players: number, engineSeed: number, agentSeed: number): number {
  const game = createGame({players, seed: engineSeed});
  const agent = randomLegalAgent(createAgentRandom(agentSeed));
  let count = 0;
  while (game.phase !== Phase.END) {
    const player = nextWaitingPlayer(game);
    if (player === undefined) {
      throw new Error(`countDecisions: ${players}p/seed=${engineSeed} has no pending input, phase='${game.phase}'`);
    }
    count++;
    applyDecision(player, agent);
  }
  return count;
}

/**
 * Drives one game *twice* under the identical engine + agent seed - once (above) to learn its
 * total decision count, once here to actually capture stratified samples at ~10%/50%/90% of that
 * total plus the terminal (`Phase.END`) state. Two drives per game rather than one: the target
 * indices are percentages of a total that isn't known until the game has been driven to
 * completion once. `createGame`/`randomLegalAgent` are exactly reproducible under a fixed
 * engine+agent seed pair (Running Notes, 2026-07-21/22), so the second drive reaches the identical
 * sequence of decisions as the first.
 */
function sampleGame(players: number, engineSeed: number, agentSeed: number): ReadonlyArray<SamplePoint> {
  const totalDecisions = countDecisions(players, engineSeed, agentSeed);

  const targets = new Map<number, Stratum>([
    [Math.max(1, Math.round(totalDecisions * 0.1)), 'early'],
    [Math.max(1, Math.round(totalDecisions * 0.5)), 'mid'],
    [Math.max(1, Math.round(totalDecisions * 0.9)), 'late'],
  ]);

  const game = createGame({players, seed: engineSeed});
  const agent = randomLegalAgent(createAgentRandom(agentSeed));

  const samples: Array<SamplePoint> = [];
  let decisionIndex = 0;
  while (game.phase !== Phase.END) {
    const player = nextWaitingPlayer(game);
    if (player === undefined) {
      throw new Error(`sampleGame: ${players}p/seed=${engineSeed} has no pending input, phase='${game.phase}'`);
    }
    decisionIndex++;
    const stratum = targets.get(decisionIndex);
    if (stratum !== undefined) {
      samples.push(measureSamplePoint(game, players, stratum, decisionIndex, totalDecisions));
    }
    applyDecision(player, agent);
  }
  samples.push(measureSamplePoint(game, players, 'terminal', decisionIndex, totalDecisions));

  return samples;
}

/** Pools every sample point's raw timings for `metric` (optionally filtered) and summarizes them. */
function aggregate(points: ReadonlyArray<SamplePoint>, metric: MetricName, filter: (p: SamplePoint) => boolean, label: string): BenchStats | undefined {
  const pooled = points.filter(filter).flatMap((p) => p.timings[metric]);
  return pooled.length > 0 ? summarize(label, pooled) : undefined;
}

/** Median of `metric`'s pooled timings (across every player count) for each stratum, in `STRATA` order - the cost curve's shape. */
function medianByStratum(points: ReadonlyArray<SamplePoint>, metric: MetricName): ReadonlyArray<number> {
  return STRATA.map((stratum) => {
    const pooled = points.filter((p) => p.stratum === stratum).flatMap((p) => p.timings[metric]);
    return pooled.length > 0 ? summarize('tmp', pooled).median : NaN;
  });
}

function medianScalarByStratum(points: ReadonlyArray<SamplePoint>, select: (p: SamplePoint) => number): ReadonlyArray<number> {
  return STRATA.map((stratum) => {
    const values = points.filter((p) => p.stratum === stratum).map(select).sort((a, b) => a - b);
    if (values.length === 0) {
      return NaN;
    }
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  });
}

/**
 * Distributes `totalGames` round-robin across `players` (e.g. `[2, 3, 4]`), and derives per-game
 * engine and agent seeds as two *independent* counters off the suite's two seed bases - never one
 * derived from the other (SRS CON-5; see `types.ts`'s doc comment on `BenchSuiteOptions.agentSeed`).
 */
function corpusPlan(totalGames: number, players: ReadonlyArray<number>, seedBase: number, agentSeedBase: number): ReadonlyArray<{players: number; engineSeed: number; agentSeed: number}> {
  return Array.from({length: totalGames}, (_, i) => ({
    players: players[i % players.length],
    engineSeed: seedBase + i,
    agentSeed: agentSeedBase + i,
  }));
}

/**
 * Milestone 1, bullet 5, sub-task C: clone round-trip cost and clones/second.
 *
 * `options.scale` is this suite's own convention: the *total* number of games sampled, spread
 * round-robin across `options.players` (default: 10 games, at least 50 for the committed run -
 * matching sub-task D's convention of "N games, across 2/3/4 players" rather than sub-task B's
 * "N games per player count"). Pass `--players 2,3,4` to actually cover all three player counts;
 * left at the CLI's own default (`[2]`), every game is 2-player.
 */
export const cloneCostSuite: BenchSuite = {
  name: 'clone-cost',
  description: 'Clone round-trip cost (serialize/copy/deserialize/verify) at stratified decision points, plus clones/second.',
  run: (options: BenchSuiteOptions): BenchReport => {
    // Lazily-constructed singleton (Running Notes, 2026-07-22 "Cache.mark leak"): touch it once,
    // outside the measured/silenced region, so its construction cost isn't attributed to the
    // first restore that happens to trigger it.
    GameLoader.getInstance();

    const plan = corpusPlan(options.scale, options.players, options.seed, options.agentSeed);

    // Silenced as one region: driving (agent trace lines, the FR-9 fallback's console.warn) and
    // sampling (Cache.mark's console.log on every restore into Phase.END, hit constantly here
    // since 'terminal' and late-stratum restores land right on or near it) are both in-scope for
    // this suite's timings, so there is no meaningful "outside the measured region" to leave loud.
    const {result, counts: consoleCounts} = silenceConsole(() => {
      const points: Array<SamplePoint> = [];
      for (const {players, engineSeed, agentSeed} of plan) {
        points.push(...sampleGame(players, engineSeed, agentSeed));
      }

      // The headline "snapshot-once, restore-many" demonstration (prompt: "N = 100"), and its
      // naive-independent-clone counterpart, as one dedicated pair rather than folded into the
      // per-sample-point loop above - a single representative *point's* snapshot, not pooled
      // across the corpus, is what "a single snapshot" means literally. `liveAgain` restores
      // once (untimed) from that same snapshot so the naive-clone timing has a live game to fork
      // from, without disturbing the original sample point's own recorded timings.
      const representative = points.find((p) => p.stratum === 'mid') ?? points[0];
      const restoreManyRaw = timeMany(RESTORE_MANY_ITERATIONS, RESTORE_MANY_WARMUP, () => {
        restore(representative.snap, {verify: 'none'});
      });
      const liveAgain = restore(representative.snap, {verify: 'none'});
      const naiveManyRaw = timeMany(RESTORE_MANY_ITERATIONS, RESTORE_MANY_WARMUP, () => {
        cloneGame(liveAgain, {unsafe: true, verify: 'none'});
      });

      return {points, representative, restoreManyRaw, naiveManyRaw};
    });
    const {points, representative, restoreManyRaw, naiveManyRaw} = result;

    const restoreManyStats = summarize(
      `restore-many (N=${RESTORE_MANY_ITERATIONS}, single snapshot: ${representative.players}p/${representative.stratum})`,
      restoreManyRaw,
    );
    const naiveManyStats = summarize(
      `naive-independent-clone (N=${RESTORE_MANY_ITERATIONS}, single snapshot: ${representative.players}p/${representative.stratum})`,
      naiveManyRaw,
    );

    const stats: Array<BenchStats> = [restoreManyStats, naiveManyStats];
    for (const metric of METRIC_NAMES) {
      const {iterations} = iterationsFor(metric);
      const allStats = aggregate(points, metric, () => true, `${metric} (all points, n=${iterations}/point)`);
      const safeStats = aggregate(points, metric, (p) => p.safe, `${metric} (safe points only, n=${iterations}/point)`);
      if (allStats !== undefined) stats.push(allStats);
      if (safeStats !== undefined) stats.push(safeStats);
    }

    const metrics: Record<string, number | string | ReadonlyArray<number>> = {
      gamesSampled: plan.length,
      decisionPointsSampled: points.length,
      // The honest "clones/second" figure for search (snapshot-once, restore-many) vs. the naive
      // figure the bullet literally asks for (an independent snapshot+restore every time) -
      // labeled separately per the prompt ("label clearly which is which").
      restoresPerSecondSingleSnapshot: 1000 / restoreManyStats.median,
      naiveClonesPerSecondIndependent: 1000 / naiveManyStats.median,
      safePointFraction: points.filter((p) => p.safe).length / points.length,
      safeFractionByStratum: medianScalarByStratum(points, (p) => (p.safe ? 1 : 0)),
      totalBytesMedianByStratum: medianScalarByStratum(points, (p) => p.totalBytes),
      gameLogBytesMedianByStratum: medianScalarByStratum(points, (p) => p.gameLogBytes),
      logShareMedianByStratum: medianScalarByStratum(points, (p) => p.logShare),
    };
    for (const metric of METRIC_NAMES) {
      metrics[`${metric}MedianMsByStratum`] = medianByStratum(points, metric);
    }

    return {
      suite: cloneCostSuite.name,
      environment: benchEnvironment(),
      stats,
      metrics,
      consoleCounts,
      notes: [
        `Strata: ${STRATA.join(', ')} (~10%/50%/90% of each game's own decision count, plus its Phase.END state).`,
        `Component/composite timings: ${COMPONENT_ITERATIONS} iterations/point (${COMPONENT_WARMUP} warmup), except 'restoreNone' at ${RESTORE_MANY_ITERATIONS} (${RESTORE_MANY_WARMUP} warmup) - the prompt's explicit snapshot-once/restore-many N.`,
        'Every snapshot/restore/cloneGame call in this suite uses {unsafe: true} / {verify: \'none\'} at the component level so the curve covers guard-refused points, not just the cheap ones - assertSnapshotSafe\'s verdict is recorded per point (the "safe" split above) but never acted on.',
        '"(all points)" pools every sampled decision point; "(safe points only)" restricts to points assertSnapshotSafe would accept - the figure a real search fork would actually see.',
        'gameLog is expected to dominate serialized bytes and grow with decisionIndex (Running Notes: ~74% mid-game on one probe) - see logShareMedianByStratum.',
        'consoleCounts.matched.cacheMark counts Cache.mark\'s console.log, fired on every restore into Phase.END (terminal-stratum and some late-stratum restores) - a real cost at self-play scale, not cosmetic.',
        'FINDING: consoleCounts.matched.cacheMark slightly undercounts the true incidence, and a handful of unsilenced "Marking <id> to be evicted" lines print after this suite (and any --json output) returns. Cause: Game.gotoEndGame() (src/server/Game.ts:1106, private async) sets phase = Phase.END synchronously near its start, then calls gameLoader.completeGame(this) (line ~1127) without awaiting it; its caller (line 1175) does not await gotoEndGame() either. completeGame() is itself async and calls mark() (another console.log) partway through - so that second mark() fires on a later microtask, after this suite\'s synchronous drive/measure region - and therefore silenceConsole\'s dynamic extent - has already returned and restored the real console.log. Two real Phase.END transitions happen per sampled game (the count-only pass and the sampling pass), hence two escaped lines per game. This is Engine behavior (src/server/Game.ts), not an agent bug, and out of scope to change (CON-1); harmless to every timing above (nothing async touches a measured value), but worth knowing before treating cacheMark or a CLI --json capture as exact - and worth knowing for self-play at scale (Milestone 4/6), where each completed game leaves one unawaited async tail running against the no-op Database.',
      ],
    };
  },
};
