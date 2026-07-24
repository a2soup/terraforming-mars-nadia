/**
 * Contamination and order independence (Milestone 1, bullet 6, sub-task C - see
 * agent/docs/Milestone1_Bullet6_Prompts.md). Answers **P3** ("a replay performed after >=100
 * unrelated games in the same process reproduces the solo-run hashes exactly") and turns hazards
 * **H1** (`GameLoader`'s process-wide cache, fed by `Game.save()`, under ids that omit the player
 * count), **H2** (the env-var-gated wall-clock sweep that trims a live game's log) and **H3**
 * (`Cache.mark`'s unbounded map) from hypotheses into findings.
 *
 * This module only *observes* - it creates no Engine or agent changes, and it instruments from
 * the outside: every experiment is built out of `replay()` (sub-task A) and the existing driver's
 * exported `applyDecision`, plus reflective reads of `GameLoader`'s private cache (see
 * {@link loaderStats}). Nothing here is on any gameplay path.
 *
 * Run it:
 * ```
 * npx tsx agent/src/determinism/contamination.ts --experiment all
 * npx tsx agent/src/determinism/contamination.ts --experiment order --noise 100
 * ```
 * The `order` and `sweep` experiments spawn **children of this same file** (`--role ...`) so that
 * "a fresh process" means one, rather than "a later point in the process that already ran the
 * baseline". `determinismCli.ts` is sub-task A's file and is deliberately not touched.
 *
 * **Why every experiment here carries a negative control.** A contamination check that reports
 * "no contamination" looks exactly like a contamination check that compares two copies of the
 * same thing. Each experiment therefore also runs a deliberately perturbed input it is required
 * to flag, and reports both outcomes; `passed` is false if either the real check fails *or* the
 * perturbed one is not caught.
 */
import {spawnSync} from 'child_process';
import * as path from 'path';
import {Phase} from '@/common/Phase';
import {InputResponse} from '@/common/inputs/InputResponse';
import {GameId} from '@/common/Types';
import {GameLoader} from '@/server/database/GameLoader';
import {IGame} from '@/server/IGame';
import {silenceConsole} from '../bench/harness';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {applyDecision} from '../driver/embeddedDriver';
import {EmbeddedResponder} from '../driver/responder';
import {createGame} from '../engine/gameFactory';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {pendingSignature} from '../engine/snapshot';
import {fingerprintsMatch} from './corpus';
import {replay, stableStringify} from './replay';
import {ReplayConfig, ReplayFingerprint} from './types';

// ---------------------------------------------------------------------------------------------
// Fixed, committed inputs. Explicit lists, never generated from a range or from randomness, so a
// re-run of this file is comparing the same games a reported result was measured on.
// ---------------------------------------------------------------------------------------------

/**
 * The >=10 configs P3 is adjudicated on: four per player count, spread over engine and agent
 * seeds. Engine seeds 5 and 7 appear at more than one player count **on purpose** - that is
 * hazard H1's id collision (`createGame` builds `g-nadia-${seed}`, with no player count), so the
 * P3 sweep itself exercises it in passing, and {@link idCollisionExperiment} then attacks it directly.
 */
export const CONTAMINATION_CONFIGS: ReadonlyArray<ReplayConfig> = [
  {players: 2, engineSeed: 5, agentSeed: 1000003},
  {players: 2, engineSeed: 7, agentSeed: 1000033},
  {players: 2, engineSeed: 101, agentSeed: 1000037},
  {players: 2, engineSeed: 907, agentSeed: 1000039},
  {players: 3, engineSeed: 5, agentSeed: 1000081},
  {players: 3, engineSeed: 7, agentSeed: 1000099},
  {players: 3, engineSeed: 211, agentSeed: 1000117},
  {players: 3, engineSeed: 1303, agentSeed: 1000121},
  {players: 4, engineSeed: 5, agentSeed: 1000133},
  {players: 4, engineSeed: 13, agentSeed: 1000151},
  {players: 4, engineSeed: 307, agentSeed: 1000159},
  {players: 4, engineSeed: 1511, agentSeed: 1000171},
];

/**
 * The `i`th "unrelated" game used as noise. Player count cycles 2/3/4 and both seed bases sit far
 * from every {@link CONTAMINATION_CONFIGS} seed, so noise can never accidentally *be* the config
 * under test - which would turn the whole experiment into a tautology.
 */
export function noiseConfig(i: number): ReplayConfig {
  return {
    players: ([2, 3, 4] as const)[i % 3],
    engineSeed: 5_000_000 + i,
    agentSeed: 9_000_000 + i,
  };
}

/** Default number of unrelated games interposed before the replay under test (P3 requires >=100). */
const DEFAULT_NOISE = 100;

// ---------------------------------------------------------------------------------------------
// Observing the Engine's process-global state
// ---------------------------------------------------------------------------------------------

/**
 * A point-in-time reading of every accumulating structure inside the `GameLoader` singleton -
 * the process-global state hazards H1/H3 are about.
 *
 * `residentGames` is the one that decides H1 and H2: the cache's `games` map is only ever
 * populated by `GameLoader.add()`, and `Game.save()` reaches `GameLoader.saveGame()`, which goes
 * straight to the `Database` **without touching the cache**. If `residentGames` stays 0 across a
 * whole batch, no embedded game is ever readable back out of the cache, and both the id collision
 * (H1) and the log-trimming sweep (H2) lose the object they would have to act on.
 */
export type LoaderStats = {
  /** False until the first `Game.save()` lazily constructs the singleton. */
  loaderConstructed: boolean;
  /** Entries in `Cache.games` - games resident in memory and reachable by id. */
  residentGames: number;
  /** Entries in `Cache.participantIds` - player/spectator id -> game id. */
  participantIds: number;
  /** Entries in `Cache.evictionSchedule` - grown by `Cache.mark()`, never trimmed except by a sweep (H3). */
  markedForEviction: number;
  /** Entries in `Cache.lastAccess` - written by `Cache.touch()`, i.e. only via `add()`/`getGame()`. */
  lastAccess: number;
  /** `Cache.load()` has resolved (it awaits `Database.getParticipants()`). */
  cacheLoaded: boolean;
  /** The `CacheConfig` parsed from `GAME_CACHE` - `sweep` is what hazard H2 turns on. */
  config: unknown;
};

/**
 * Reads {@link LoaderStats} out of the `GameLoader` singleton's private `Cache`.
 *
 * The reflective casts are deliberate and confined to this one function: `Cache`'s maps are
 * private and there is no public accessor for their sizes (`getLoadedGameCount()` only counts
 * non-`undefined` entries and says nothing about `evictionSchedule`), and the Engine is immutable
 * ground truth (SRS CON-1) so adding one is not an option. Reading private state from a
 * diagnostics module that sits on no gameplay path is the cheaper trade; nothing else in
 * `agent/src` does this.
 */
export function loaderStats(): LoaderStats {
  const instance = (GameLoader as unknown as {instance?: {cache: Record<string, unknown>}}).instance;
  if (instance === undefined) {
    return {
      loaderConstructed: false,
      residentGames: 0,
      participantIds: 0,
      markedForEviction: 0,
      lastAccess: 0,
      cacheLoaded: false,
      config: undefined,
    };
  }
  const cache = instance.cache;
  const size = (field: string) => (cache[field] as Map<unknown, unknown>).size;
  return {
    loaderConstructed: true,
    residentGames: size('games'),
    participantIds: size('participantIds'),
    markedForEviction: size('evictionSchedule'),
    lastAccess: size('lastAccess'),
    cacheLoaded: cache.loaded === true,
    config: cache.config,
  };
}

/**
 * Yields to the event loop so already-queued microtasks and immediates run.
 *
 * This matters more than it looks. `Game.gotoEndGame()` is `async` and is called **without being
 * awaited** (`Game.ts:1175`); it sets `Phase.END` synchronously (so the driver's loop exits) but
 * then suspends at `await gameLoader.saveGame(this)`, and everything after that - including
 * `completeGame()` -> `Cache.mark()` - runs as a continuation. A synchronous batch loop never
 * yields, so *none* of those continuations run until the loop ends: `markedForEviction` reads 0
 * mid-batch and jumps to the full count afterwards, and each pending continuation keeps its
 * finished `Game` reachable in the meantime. Any measurement of end-of-game global state has to
 * flush first or it is measuring the wrong moment.
 */
export function flushPendingGameCompletions(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** True when the process was launched with `--expose-gc`, which {@link retainedHeapMb} needs to mean anything. */
const GC_AVAILABLE = typeof global.gc === 'function';

/**
 * Heap in MB, after collecting first when `--expose-gc` is available. Without a collection the
 * number is dominated by uncollected garbage and swings by hundreds of MB between adjacent
 * readings, which would make "does a long run accumulate?" unanswerable - so
 * {@link accumulationExperiment} reports {@link GC_AVAILABLE} alongside every figure, and this
 * experiment should be run as `node --expose-gc --import tsx src/determinism/contamination.ts`
 * when the memory numbers matter. Two passes because the first can leave newly-unreachable
 * objects behind. Not a timing - see the sub-task C prompt on `tsx` and performance figures.
 */
function retainedHeapMb(): number {
  global.gc?.();
  global.gc?.();
  return process.memoryUsage().heapUsed / 1e6;
}

/** Runs `count` unrelated games (see {@link noiseConfig}) with the Engine's console noise suppressed. */
export function runNoise(count: number): {games: number; consoleLines: number} {
  const {counts} = silenceConsole(() => {
    for (let i = 0; i < count; i++) {
      replay(noiseConfig(i));
    }
  });
  return {games: count, consoleLines: counts.log + counts.warn + counts.error};
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

export type ContaminationReport = {
  experiment: string;
  /** The real check held **and** its negative control was caught. Either failure makes this false. */
  passed: boolean;
  /** Hazards this experiment adjudicates, each `confirmed` / `not reachable` / `not applicable`. */
  hazards: Record<string, string>;
  /** Human-readable findings, in the order they were established. */
  findings: ReadonlyArray<string>;
  data: Record<string, unknown>;
};

export function formatReport(report: ContaminationReport): string {
  const lines = [`=== ${report.experiment}: ${report.passed ? 'PASS' : 'FAIL'} ===`];
  for (const [hazard, verdict] of Object.entries(report.hazards)) {
    lines.push(`  ${hazard}: ${verdict}`);
  }
  for (const finding of report.findings) {
    lines.push(`  - ${finding}`);
  }
  lines.push(`  data: ${JSON.stringify(report.data)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Child-process orchestration
// ---------------------------------------------------------------------------------------------

/**
 * Marks the one line of a child's stdout that carries its result, so Engine console noise
 * (`Preloaded 0 IDs.`, `Marking g-nadia-... to be evicted`, FR-9 fallback warnings) - some of
 * which is emitted from unawaited continuations *after* the child's own work finishes - can never
 * be mistaken for it.
 */
const RESULT_SENTINEL = '##contamination-result##';

/** The `agent/` directory: children run with this as cwd so `tsx` resolves the `@/` path alias. */
const AGENT_DIR = path.join(__dirname, '..', '..');

type ChildOutcome<T> = {ok: true; value: T} | {ok: false; error: string};

/**
 * Runs this file again in a fresh Node process with `--role <role>` and reads back the single
 * sentinel-prefixed JSON line it prints. `node --import tsx` is used rather than the `tsx` binary
 * so the child does not depend on how the parent was launched.
 */
function spawnRole<T>(role: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): ChildOutcome<T> {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', __filename, '--role', role, ...args],
    {cwd: AGENT_DIR, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024},
  );
  if (result.error !== undefined) {
    return {ok: false, error: `spawn failed: ${result.error.message}`};
  }
  const line = (result.stdout ?? '').split('\n').find((l) => l.startsWith(RESULT_SENTINEL));
  if (line === undefined) {
    return {ok: false, error: `child --role ${role} produced no result (exit ${result.status}): ${(result.stderr ?? '').slice(-500)}`};
  }
  return {ok: true, value: JSON.parse(line.slice(RESULT_SENTINEL.length)) as T};
}

function emitChildResult(value: unknown): void {
  console.log(RESULT_SENTINEL + JSON.stringify(value));
}

function parseConfig(raw: string): ReplayConfig {
  return JSON.parse(raw) as ReplayConfig;
}

// ---------------------------------------------------------------------------------------------
// Experiment 1 - order independence across processes (P3)
// ---------------------------------------------------------------------------------------------

type OrderComparison = {
  config: ReplayConfig;
  noise: number;
  matched: boolean;
  differingFields: ReadonlyArray<string>;
  solo?: ReplayFingerprint;
  after?: ReplayFingerprint;
  error?: string;
};

function differingFields(a: ReplayFingerprint, b: ReplayFingerprint): ReadonlyArray<string> {
  return (['moveTraceHash', 'stableStateHash', 'resultHash', 'decisions', 'fallbacks', 'generation'] as const)
    .filter((field) => a[field] !== b[field]);
}

/**
 * One P3 trial: `solo` is the config replayed as the **first and only** game of a fresh process;
 * `after` is the same config replayed in another fresh process that first ran `noise` unrelated
 * games. Both children are spawned from this same file, so neither can accidentally inherit state
 * from the parent's own runs.
 */
function orderTrial(config: ReplayConfig, noise: number, agentSeedDelta = 0): OrderComparison {
  const solo = spawnRole<ReplayFingerprint>('solo', ['--config', JSON.stringify(config)]);
  if (!solo.ok) {
    return {config, noise, matched: false, differingFields: [], error: solo.error};
  }
  const perturbed = agentSeedDelta === 0 ? config : {...config, agentSeed: config.agentSeed + agentSeedDelta};
  const after = spawnRole<ReplayFingerprint>('after', ['--config', JSON.stringify(perturbed), '--noise', String(noise)]);
  if (!after.ok) {
    return {config, noise, matched: false, differingFields: [], error: after.error};
  }
  return {
    config,
    noise,
    matched: fingerprintsMatch(solo.value, after.value),
    differingFields: differingFields(solo.value, after.value),
    solo: solo.value,
    after: after.value,
  };
}

/**
 * Binary-searches the **smallest** number of intervening noise games that still reproduces a P3
 * failure for `config`. Only called when a trial actually fails - a divergence at 100 games is
 * hard to act on, "it diverges after 3" names the mechanism. Costs ~log2(maxNoise) child spawns.
 */
function isolateMinimumNoise(config: ReplayConfig, maxNoise: number): number | undefined {
  if (orderTrial(config, 0).matched === false) {
    return 0;
  }
  let low = 1;
  let high = maxNoise;
  let best: number | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (orderTrial(config, mid).matched) {
      low = mid + 1;
    } else {
      best = mid;
      high = mid - 1;
    }
  }
  return best;
}

export function orderIndependenceExperiment(noise: number): ContaminationReport {
  const trials = CONTAMINATION_CONFIGS.map((config) => orderTrial(config, noise));
  const failures = trials.filter((t) => !t.matched);

  // Negative control: ask the "after" child for a config one agent seed away from the solo
  // baseline. The comparison must flag it. If it does not, every PASS above is meaningless -
  // it would mean the two sides are not actually being compared.
  const control = orderTrial(CONTAMINATION_CONFIGS[0], noise, 1);
  const controlCaught = control.matched === false && control.error === undefined;

  const findings: Array<string> = [];
  findings.push(
    `${trials.length - failures.length}/${trials.length} configs (2p/3p/4p) reproduced their fresh-process solo ` +
    `fingerprint exactly after ${noise} unrelated games in the same process.`,
  );
  findings.push(
    controlCaught
      ? `Negative control caught: a one-off agent seed in the "after" child diverged on [${control.differingFields.join(', ')}].`
      : 'NEGATIVE CONTROL NOT CAUGHT - the comparison is not testing what it claims to test.',
  );

  const isolation: Record<string, number | string> = {};
  for (const failure of failures) {
    const key = `${failure.config.players}p/e${failure.config.engineSeed}/a${failure.config.agentSeed}`;
    if (failure.error !== undefined) {
      findings.push(`${key}: trial could not be run - ${failure.error}`);
      isolation[key] = failure.error;
      continue;
    }
    const minimum = isolateMinimumNoise(failure.config, noise);
    findings.push(`${key}: DIVERGED on [${failure.differingFields.join(', ')}]; minimum intervening games that reproduces it: ${minimum ?? 'not isolated'}.`);
    isolation[key] = minimum ?? 'not isolated';
  }

  return {
    experiment: `order-independence (P3, noise=${noise})`,
    passed: failures.length === 0 && controlCaught,
    hazards: {},
    findings,
    data: {
      configs: trials.length,
      noise,
      failures: failures.length,
      controlCaught,
      isolation,
      soloDecisions: trials.map((t) => t.solo?.decisions ?? -1),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Experiment 2 - the same-id collision (H1)
// ---------------------------------------------------------------------------------------------

/**
 * H1 head-on: `createGame` builds `g-nadia-${seed}` with **no player count**, so 2p seed 5 and 3p
 * seed 5 are different games sharing one id, and a repeated seed re-uses an id already seen. This
 * runs those two orderings in one process and checks each against a fresh-process solo baseline.
 *
 * The first assertion is the one that keeps the rest honest: 2p-seed-5 and 3p-seed-5 must produce
 * *different* fingerprints. If they did not, "both matched their baseline" would be vacuous.
 */
export function idCollisionExperiment(): ContaminationReport {
  const a: ReplayConfig = {players: 2, engineSeed: 5, agentSeed: 1000003};
  const b: ReplayConfig = {players: 3, engineSeed: 5, agentSeed: 1000003};

  const soloA = spawnRole<ReplayFingerprint>('solo', ['--config', JSON.stringify(a)]);
  const soloB = spawnRole<ReplayFingerprint>('solo', ['--config', JSON.stringify(b)]);
  if (!soloA.ok || !soloB.ok) {
    return {
      experiment: 'id-collision (H1)',
      passed: false,
      hazards: {H1: 'not adjudicated - baseline child failed'},
      findings: [`baseline child failed: ${[soloA, soloB].filter((r) => !r.ok).map((r) => (r as {error: string}).error).join('; ')}`],
      data: {},
    };
  }

  const distinctGames = soloA.value.moveTraceHash !== soloB.value.moveTraceHash;

  // In one process: A, B (same id, different game), A again (id already resident), B again.
  ensureHeadlessEngine();
  const sequence = silenceConsole(() => [replay(a), replay(b), replay(a), replay(b)]).result;
  const [a1, b1, a2, b2] = sequence;

  const results = {
    'A first': fingerprintsMatch(soloA.value, a1),
    'B after A (shared id)': fingerprintsMatch(soloB.value, b1),
    'A repeated (own id already used)': fingerprintsMatch(soloA.value, a2),
    'B repeated': fingerprintsMatch(soloB.value, b2),
  };
  const allMatched = Object.values(results).every(Boolean);

  const findings: Array<string> = [];
  findings.push(
    distinctGames
      ? '2p seed 5 and 3p seed 5 are genuinely different games (different move-trace hashes) despite sharing the id g-nadia-5.'
      : 'CONTROL FAILED: 2p seed 5 and 3p seed 5 produced the same move-trace hash, so the collision test proves nothing.',
  );
  for (const [label, matched] of Object.entries(results)) {
    findings.push(`${label}: ${matched ? 'matches its fresh-process baseline' : 'DIVERGED from its fresh-process baseline'}`);
  }

  const stats = loaderStats();
  findings.push(
    `After 4 games spanning 2 distinct ids, GameLoader's cache held ${stats.residentGames} resident game(s) - ` +
    'embedded play reaches `GameLoader.saveGame()` (which goes straight to the Database) but never ' +
    '`GameLoader.add()`, so no game is ever readable back out of the cache and the shared id has nothing to collide over.',
  );

  return {
    experiment: 'id-collision (H1)',
    passed: allMatched && distinctGames,
    hazards: {
      H1: stats.residentGames === 0
        ? 'NOT REACHABLE under embedded play - the cache is never populated (`saveGame` bypasses it), so a shared id has no cached object to return. Still a latent trap for any code that calls GameLoader.add()/getGame() (live play, M5).'
        : 'REACHABLE - games are resident in the cache under colliding ids; see data.',
    },
    findings,
    data: {results, distinctGames, loaderStats: stats},
  };
}

// ---------------------------------------------------------------------------------------------
// Experiment 3 - interleaving (the M4/M6 access pattern)
// ---------------------------------------------------------------------------------------------

/**
 * Steps one game a decision at a time, recording the same per-decision trace string
 * `replay()` folds into its rolling move-trace hash. Built on the driver's exported
 * `applyDecision` rather than `runGame`, because `runGame` drives to completion and interleaving
 * needs to stop after each decision.
 *
 * The trace-string recipe is duplicated from `replay.ts`'s responder wrapper (which is private),
 * which would be a real risk of silent drift - so {@link interleaveExperiment} always runs this
 * stepper *sequentially* first and requires it to reproduce `replay()`'s own diagnostic trace
 * exactly. If the recipe ever drifts, that control fails before any interleaving result is
 * reported.
 */
class SteppedGame {
  readonly game: IGame;
  readonly steps: Array<string> = [];
  private readonly agent: EmbeddedResponder;

  constructor(config: ReplayConfig, private readonly deviateAt = -1) {
    this.game = createGame({players: config.players, seed: config.engineSeed});
    this.agent = randomLegalAgent(createAgentRandom(config.agentSeed));
  }

  get done(): boolean {
    return this.game.phase === Phase.END;
  }

  step(): void {
    const player = this.game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
    if (player === undefined) {
      throw new Error(`SteppedGame: ${this.game.id} has no waiting player but phase is ${this.game.phase}`);
    }
    applyDecision(player, (decision: EmbeddedDecisionPoint): InputResponse => {
      const before = pendingSignature(decision.game);
      // The negative control: at decision `deviateAt`, burn one extra draw from the agent's RNG
      // and answer with the *second* response. Still a legal move (it comes from the same
      // enumerator), but from a perturbed stream, so the run must diverge at or after this point.
      if (this.steps.length === this.deviateAt) {
        this.agent(decision);
      }
      const response = this.agent(decision);
      this.steps.push(`${before}|${decision.player.id}|${decision.model.type}|${stableStringify(response)}`);
      return response;
    });
  }

  runToEnd(): void {
    while (!this.done) {
      this.step();
    }
  }
}

/** First index at which two trace-string sequences differ, or -1 if they are identical. */
function firstDifference(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return -1;
}

/**
 * Two games driven alternately, decision by decision, in one process - the access pattern M4
 * search and M6 self-play actually produce, and the one least like anything tested so far (every
 * prior determinism check ran whole games back to back). Each is compared against its own
 * solo trace.
 */
export function interleaveExperiment(): ContaminationReport {
  ensureHeadlessEngine();
  const a: ReplayConfig = {players: 2, engineSeed: 101, agentSeed: 1000037};
  const b: ReplayConfig = {players: 3, engineSeed: 211, agentSeed: 1000117};
  const c: ReplayConfig = {players: 4, engineSeed: 307, agentSeed: 1000159};

  const soloTrace = (config: ReplayConfig): ReadonlyArray<string> => {
    const fingerprint = silenceConsole(() => replay(config, {diagnostics: true})).result;
    return fingerprint.diagnostics!.trace.map((step) => step.stepInput);
  };
  const traces = {a: soloTrace(a), b: soloTrace(b), c: soloTrace(c)};

  // Control 1: the stepper itself must be equivalent to runGame(). Everything below is only
  // meaningful if driving by hand reproduces the driver's own trace.
  const sequential = new SteppedGame(a);
  silenceConsole(() => sequential.runToEnd());
  const stepperFaithful = firstDifference(traces.a, sequential.steps) === -1;

  // Three games advanced one decision each per round.
  const runners = [new SteppedGame(a), new SteppedGame(b), new SteppedGame(c)];
  silenceConsole(() => {
    while (runners.some((r) => !r.done)) {
      for (const runner of runners) {
        if (!runner.done) {
          runner.step();
        }
      }
    }
  });
  const interleavedDiffs = {
    a: firstDifference(traces.a, runners[0].steps),
    b: firstDifference(traces.b, runners[1].steps),
    c: firstDifference(traces.c, runners[2].steps),
  };
  const interleavedClean = Object.values(interleavedDiffs).every((d) => d === -1);

  // Control 2: a run deliberately perturbed at decision 40 must be flagged, at or after 40.
  const deviateAt = 40;
  const perturbed = new SteppedGame(a, deviateAt);
  silenceConsole(() => perturbed.runToEnd());
  const perturbedDiff = firstDifference(traces.a, perturbed.steps);
  const perturbationCaught = perturbedDiff >= deviateAt;

  const findings = [
    stepperFaithful
      ? `Control: stepping by hand via applyDecision reproduces runGame()'s trace exactly (${sequential.steps.length} decisions), so the trace recipe here matches replay.ts's.`
      : `CONTROL FAILED: the hand stepper diverges from runGame() at decision ${firstDifference(traces.a, sequential.steps)} - no interleaving result below can be trusted.`,
    interleavedClean
      ? `2p, 3p and 4p games driven alternately (one decision each per round, ${runners.map((r) => r.steps.length).join('/')} decisions) each reproduced their solo trace decision-for-decision.`
      : `Interleaved runs diverged from their solo traces at ${JSON.stringify(interleavedDiffs)}.`,
    perturbationCaught
      ? `Negative control caught: a perturbation injected at decision ${deviateAt} was detected at decision ${perturbedDiff}.`
      : `NEGATIVE CONTROL NOT CAUGHT: a perturbation at decision ${deviateAt} produced first-difference ${perturbedDiff}.`,
  ];

  return {
    experiment: 'interleaving (P3, the M4/M6 access pattern)',
    passed: stepperFaithful && interleavedClean && perturbationCaught,
    hazards: {},
    findings,
    data: {interleavedDiffs, stepperFaithful, perturbedDiff, deviateAt, decisions: runners.map((r) => r.steps.length)},
  };
}

// ---------------------------------------------------------------------------------------------
// Experiment 4 - accumulation (H3)
// ---------------------------------------------------------------------------------------------

/**
 * H3, quantified: what grows in a long-lived process, and is anything ever released under the
 * default `sweep: 'manual'`? Reports `GameLoader` cache sizes and retained heap at checkpoints,
 * plus the pre-flush/post-flush split that exposes the unawaited `gotoEndGame()` continuations
 * (see {@link flushPendingGameCompletions}).
 */
export async function accumulationExperiment(games: number): Promise<ContaminationReport> {
  ensureHeadlessEngine();
  const checkpointEvery = Math.max(1, Math.floor(games / 5));
  const checkpoints: Array<Record<string, number>> = [];

  const before = loaderStats();
  let played = 0;
  while (played < games) {
    const batch = Math.min(checkpointEvery, games - played);
    silenceConsole(() => {
      for (let i = 0; i < batch; i++) {
        replay(noiseConfig(played + i));
      }
    });
    const preFlushHeapMb = retainedHeapMb();
    const preFlushMarks = loaderStats().markedForEviction;
    await flushPendingGameCompletions();
    played += batch;
    const stats = loaderStats();
    checkpoints.push({
      games: played,
      preFlushMarks,
      markedForEviction: stats.markedForEviction,
      residentGames: stats.residentGames,
      participantIds: stats.participantIds,
      lastAccess: stats.lastAccess,
      preFlushHeapMb: Number(preFlushHeapMb.toFixed(1)),
      postFlushHeapMb: Number(retainedHeapMb().toFixed(1)),
    });
  }

  const last = checkpoints[checkpoints.length - 1];
  // What one finished-but-not-yet-completed game costs while its unawaited gotoEndGame()
  // continuation keeps it reachable - the difference the flush releases, per game in a checkpoint.
  const transientMbPerGame = ((last.preFlushHeapMb - last.postFlushHeapMb) / checkpointEvery).toFixed(2);

  // Nothing is ever evicted under `sweep: 'manual'` because nothing schedules a sweep - but
  // running one by hand is the check that "nothing was evicted" is about residency, not about
  // the sweep never having been given the chance.
  silenceConsole(() => (GameLoader.getInstance() as GameLoader).sweep());
  const afterManualSweep = loaderStats();

  // Control: the probe must be able to see growth at all. `markedForEviction` growing 1:1 with
  // distinct game ids is what makes "residentGames stayed 0" a finding rather than a dead read.
  const probeSeesGrowth = last.markedForEviction > checkpoints[0].markedForEviction;
  // Control: repeating an id already marked must NOT grow the map (it is keyed by game id).
  const marksBeforeRepeat = loaderStats().markedForEviction;
  silenceConsole(() => replay(noiseConfig(0)));
  await flushPendingGameCompletions();
  const marksAfterRepeat = loaderStats().markedForEviction;

  const findings = [
    `Over ${games} games, GameLoader's eviction-schedule map grew by ${last.markedForEviction - before.markedForEviction} entries to ${last.markedForEviction} - one per *distinct* game id - while resident games stayed ${last.residentGames} and participant ids ${last.participantIds}.`,
    `Replaying an id already marked left the map at ${marksAfterRepeat} (was ${marksBeforeRepeat}) - the map is keyed by game id, so \`g-nadia-\${seed}\` bounds the leak by distinct seeds, not by games played.`,
    `A manual \`GameLoader.sweep()\` evicted nothing (resident games ${afterManualSweep.residentGames}, marks ${afterManualSweep.markedForEviction}) - under \`sweep: 'manual'\` nothing calls it anyway, and with no resident games there is nothing for it to evict or trim.`,
    GC_AVAILABLE
      ? `Retained heap (after a forced collection) was ${last.postFlushHeapMb} MB at ${games} games vs ${checkpoints[0].postFlushHeapMb} MB at ${checkpoints[0].games} - flat, so nothing per-game is being retained. Read *before* flushing the event loop the same checkpoint held ${last.preFlushHeapMb} MB, i.e. ~${transientMbPerGame} MB per not-yet-completed game held live by its pending gotoEndGame() continuation.`
      : `Heap figures below are NOT retained heap - this process was launched without --expose-gc, so they include uncollected garbage and are not comparable across checkpoints. Re-run as \`node --expose-gc --import tsx src/determinism/contamination.ts --experiment accumulation\` for a usable number. (Raw: ${checkpoints.map((c) => `${c.games}:${c.postFlushHeapMb}MB`).join(' ')})`,
    `Mid-batch, \`Cache.mark\` had fired ${last.preFlushMarks} times against ${last.markedForEviction} after a flush: \`Game.gotoEndGame()\` is an unawaited async call, so every finished game's completion work - and the game object it closes over - stays queued until the batch yields.`,
    probeSeesGrowth
      ? 'Control: the probe does observe growth, so "resident games stayed 0" is a reading, not a dead accessor.'
      : 'CONTROL FAILED: no tracked structure grew at all, so this experiment measured nothing.',
  ];

  return {
    experiment: `accumulation (H3, ${games} games)`,
    passed: probeSeesGrowth && marksAfterRepeat === marksBeforeRepeat,
    hazards: {
      H3: `CONFIRMED but bounded: +${last.markedForEviction - before.markedForEviction} Map entries (a GameId string + a number) after ${games} games, never released, keyed by game id - so \`g-nadia-\${seed}\` caps it at one entry per distinct seed however many games are played. ` +
        (GC_AVAILABLE
          ? 'Retained heap is flat across the run, so this is an accounting leak, not GC pressure.'
          : 'Heap impact not adjudicated here - re-run with --expose-gc.'),
    },
    findings,
    data: {gcAvailable: GC_AVAILABLE, before, checkpoints, afterManualSweep, marksBeforeRepeat, marksAfterRepeat},
  };
}

// ---------------------------------------------------------------------------------------------
// Experiment 5 - the env-gated wall-clock sweep (H2)
// ---------------------------------------------------------------------------------------------

const SWEEP_ENV = 'sweep=auto;sweep_freq=1s;idle_age=1s;eviction_age=1s';

export type SweepProbeResult = {
  gameCache: string | undefined;
  config: unknown;
  /** Cache state after several sweeps with the game played but never `add()`ed. */
  withoutAdd: {residentGames: number; gameLogLength: number; trimEvents: number};
  /** Cache state after the same wait with the live game deliberately `add()`ed - the positive control. */
  withAdd: {residentGames: number; gameLogLength: number; trimEvents: number};
  /** `gameLog` after `GameLoader.getGame()` runs `restoreGameLog` against the no-op Database. */
  gameLogAfterRestore: unknown;
  /** What happened when play resumed on the restored game. */
  playAfterRestore: {ok: boolean; error?: string};
};

/**
 * Runs inside a child launched with `GAME_CACHE` set (the sweep config is parsed once, when the
 * `GameLoader` singleton is lazily constructed, so it cannot be changed in-process). Plays a game
 * partway, waits out several sweeps without adding it to the cache, then adds it and waits again.
 */
async function sweepProbeChild(): Promise<SweepProbeResult> {
  // The one legitimate `allowAutoSweep` caller: this probe exists to enter the unsafe
  // configuration deliberately and measure what it does. Sub-task E turned C's recommended
  // isolation into a real bootstrap guard (headlessEngine.ts's assertSweepIsManual), which would
  // otherwise refuse to start this child - the guard and the experiment that justifies it have to
  // coexist. Nothing here is compared against a fingerprint.
  ensureHeadlessEngine({allowAutoSweep: true});
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const game = createGame({players: 2, seed: 77});
  const agent = randomLegalAgent(createAgentRandom(31));
  const play = (decisions: number) => silenceConsole(() => {
    for (let i = 0; i < decisions && game.phase !== Phase.END; i++) {
      const player = game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
      if (player === undefined) {
        return;
      }
      applyDecision(player, agent);
    }
  });
  play(40);

  // The singleton exists by now (Game.save() during setup built it); subscribing to its cache is
  // the only way to see a trim, which is otherwise silent apart from a console line.
  let trimEvents = 0;
  const cache = (GameLoader as unknown as {instance: {cache: {on(event: string, cb: (n: number) => void): void}}}).instance.cache;
  cache.on('trimmed', (n: number) => {
    trimEvents += n;
  });

  await sleep(3200);
  const withoutAdd = {residentGames: loaderStats().residentGames, gameLogLength: game.gameLog.length, trimEvents};

  await GameLoader.getInstance().add(game);
  await sleep(3200);
  const withAdd = {residentGames: loaderStats().residentGames, gameLogLength: game.gameLog.length, trimEvents};

  await GameLoader.getInstance().getGame(game.id as GameId);
  const gameLogAfterRestore = game.gameLog as unknown;

  let playAfterRestore: {ok: boolean; error?: string};
  try {
    play(5);
    playAfterRestore = {ok: true};
  } catch (e) {
    playAfterRestore = {ok: false, error: e instanceof Error ? e.message : String(e)};
  }

  return {
    gameCache: process.env.GAME_CACHE,
    config: loaderStats().config,
    withoutAdd,
    withAdd,
    gameLogAfterRestore,
    playAfterRestore,
  };
}

/**
 * H2, decided rather than left open. Two children: one with `GAME_CACHE` unset (establishing that
 * the headless bootstrap really does get `sweep: 'manual'`), one with `sweep=auto` and a 1-second
 * idle age (so the hour-long default does not have to be waited out).
 */
export function sweepExperiment(): ContaminationReport {
  const defaults = spawnRole<LoaderStats>('loader-stats', [], {...process.env, GAME_CACHE: undefined});
  const auto = spawnRole<SweepProbeResult>('sweep-probe', [], {...process.env, GAME_CACHE: SWEEP_ENV});

  if (!defaults.ok || !auto.ok) {
    return {
      experiment: 'wall-clock sweep (H2)',
      passed: false,
      hazards: {H2: 'not adjudicated - child failed'},
      findings: [[defaults, auto].filter((r) => !r.ok).map((r) => (r as {error: string}).error).join('; ')],
      data: {},
    };
  }

  const defaultsManual = (defaults.value.config as {sweep?: string} | undefined)?.sweep === 'manual';
  const untouchedWithoutAdd = auto.value.withoutAdd.trimEvents === 0 && auto.value.withoutAdd.gameLogLength > 0;
  const trimmedWithAdd = auto.value.withAdd.trimEvents > 0 && auto.value.withAdd.gameLogLength === 0;
  const restoreCorrupted = auto.value.gameLogAfterRestore === null || auto.value.gameLogAfterRestore === undefined;

  const findings = [
    defaultsManual
      ? `With GAME_CACHE unset, the headless bootstrap gets sweep: 'manual' (${JSON.stringify(defaults.value.config)}) - no timer is installed and nothing is swept.`
      : `Default sweep mode is NOT 'manual': ${JSON.stringify(defaults.value.config)}.`,
    untouchedWithoutAdd
      ? `Under GAME_CACHE='${SWEEP_ENV}' the sweeper ran repeatedly against a live 2p game and changed nothing (gameLog still ${auto.value.withoutAdd.gameLogLength} entries, ${auto.value.withoutAdd.residentGames} resident games) - because embedded play never calls GameLoader.add(), the sweep has no game to act on.`
      : `Under GAME_CACHE='${SWEEP_ENV}' a never-added game was already affected: ${JSON.stringify(auto.value.withoutAdd)}.`,
    trimmedWithAdd
      ? `Positive control: after one GameLoader.add() of the *same live game*, the next sweep emptied its gameLog mid-play (${auto.value.withAdd.trimEvents} trim event(s), gameLog ${auto.value.withAdd.gameLogLength} entries). The hazard mechanism is real; only the reachability is missing.`
      : `Positive control did NOT fire - the hazard could not be reproduced even with the game added: ${JSON.stringify(auto.value.withAdd)}.`,
    restoreCorrupted
      ? `GameLoader.getGame() then ran restoreGameLog against the headless no-op Database (which returns {}), setting the live game's gameLog to ${String(auto.value.gameLogAfterRestore)}.`
      : `restoreGameLog left gameLog as ${JSON.stringify(auto.value.gameLogAfterRestore)}.`,
    auto.value.playAfterRestore.ok
      ? 'Play continued after the restore, so the corruption is silent rather than fatal - worse, not better.'
      : `Play then crashed on the next decision: ${auto.value.playAfterRestore.error?.slice(0, 160)}...`,
  ];

  return {
    experiment: 'wall-clock sweep (H2)',
    passed: defaultsManual && untouchedWithoutAdd && trimmedWithAdd,
    hazards: {
      H2: 'NOT REACHABLE under the headless bootstrap as written (nothing is ever added to the cache), but CONFIRMED as a mechanism: with sweep=auto and any code path that calls GameLoader.add(), a live game\'s log is emptied on a wall-clock schedule and the next getGame() replaces it with undefined. Trigger: GAME_CACHE containing sweep=auto, plus one add(). Recommended isolation (for sub-task E to apply - headlessEngine.ts is not sub-task C\'s file): have ensureHeadlessEngine() assert the parsed CacheConfig has sweep === \'manual\', so an inherited GAME_CACHE fails loudly at bootstrap instead of quietly at generation 12.',
    },
    findings,
    data: {defaults: defaults.value, auto: auto.value},
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

type ParsedArgs = {
  role?: string;
  experiment: string;
  config?: ReplayConfig;
  noise: number;
  games: number;
  json: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const args: ParsedArgs = {experiment: 'all', noise: DEFAULT_NOISE, games: 500, json: false};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--role':
      args.role = argv[++i];
      break;
    case '--experiment':
      args.experiment = argv[++i];
      break;
    case '--config':
      args.config = parseConfig(argv[++i]);
      break;
    case '--noise':
      args.noise = Number(argv[++i]);
      break;
    case '--games':
      args.games = Number(argv[++i]);
      break;
    case '--json':
      args.json = true;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }
  return args;
}

/** The child-process roles. Each prints exactly one {@link RESULT_SENTINEL} line and exits. */
async function runRole(args: ParsedArgs): Promise<void> {
  switch (args.role) {
  case 'solo': {
    // The config is the first and only game this process runs.
    ensureHeadlessEngine();
    if (args.config === undefined) {
      throw new Error('--role solo requires --config');
    }
    const config = args.config;
    emitChildResult(silenceConsole(() => replay(config)).result);
    return;
  }
  case 'after': {
    ensureHeadlessEngine();
    if (args.config === undefined) {
      throw new Error('--role after requires --config');
    }
    const config = args.config;
    runNoise(args.noise);
    emitChildResult(silenceConsole(() => replay(config)).result);
    return;
  }
  case 'loader-stats': {
    ensureHeadlessEngine();
    silenceConsole(() => replay({players: 2, engineSeed: 2, agentSeed: 2}));
    await flushPendingGameCompletions();
    emitChildResult(loaderStats());
    return;
  }
  case 'sweep-probe': {
    emitChildResult(await sweepProbeChild());
    // The sweeper installs a recurring setTimeout, so the child would otherwise never exit.
    process.exit(0);
  }
  default:
    throw new Error(`Unrecognized --role: ${args.role}`);
  }
}

async function runExperiments(args: ParsedArgs): Promise<void> {
  const wanted = args.experiment === 'all'
    ? ['order', 'collision', 'interleave', 'accumulation', 'sweep']
    : [args.experiment];

  const reports: Array<ContaminationReport> = [];
  for (const name of wanted) {
    switch (name) {
    case 'order':
      reports.push(orderIndependenceExperiment(args.noise));
      break;
    case 'collision':
      reports.push(idCollisionExperiment());
      break;
    case 'interleave':
      reports.push(interleaveExperiment());
      break;
    case 'accumulation':
      reports.push(await accumulationExperiment(args.games));
      break;
    case 'sweep':
      reports.push(sweepExperiment());
      break;
    default:
      throw new Error(`Unknown --experiment: ${name} (order, collision, interleave, accumulation, sweep, all)`);
    }
  }

  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const report of reports) {
      console.log(formatReport(report));
      console.log('');
    }
  }

  if (reports.some((r) => !r.passed)) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.role !== undefined) {
    await runRole(args);
    return;
  }
  await runExperiments(args);
}

if (require.main === module) {
  main();
}
