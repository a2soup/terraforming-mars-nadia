/**
 * The match runner's validation battery (Milestone 2, bullet 1, Unit D): the runs that produce
 * evidence for criteria R1-R8, pre-committed in agent/docs/Milestone2_Bullet1_Prompts.md §6.
 *
 *   Everything, writing the committed artifact (~25 minutes):
 *     node build/agent/agent/src/runner/matchValidationCli.js --phase all
 *
 *   One phase at a time, into a scratch directory, then assembled:
 *     node build/agent/agent/src/runner/matchValidationCli.js --phase main --out-dir /tmp/v
 *     node build/agent/agent/src/runner/matchValidationCli.js --phase assemble --out-dir /tmp/v
 *
 * **Why this file exists.** Units A-C built every check R1-R8 is stated on, but three of them
 * (R2, R6, R8) are library functions with no entry point: `reportsMatch`, `runMatchPool` against
 * `runMatchConfigs`, and `compareLegalityAccounting`/`checkMatchNeutrality`. Unit D has to produce
 * their numbers, and a scratch script that produces a milestone's evidence and then vanishes is
 * against this project's grain - `legality/`, `determinism/` and `coverage/` are all permanent and
 * re-runnable. The plan's §9 assigns Unit D only documents; adding this file is a deliberate
 * deviation, recorded in agent/docs/Match_Runner.md §7.
 *
 * **Every number here is a measurement of this machine at this moment** (hazard H5: compiled build
 * only). R7 in particular is reported as a *speedup ratio* with all its points measured
 * back-to-back in one session, because the absolute baseline turned out not to be stable across
 * sessions - see the Match_Runner.md throughput section.
 */
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {defaultOutputDir, loadMatchArtifact, reportsMatch, saveMatchArtifact, stripTimingFields} from '../match/artifact';
import {verifyMatchArtifact} from '../match/history';
import {checkMatchNeutrality, checkNeutralityAgainstReplay, compareLegalityAccounting} from '../match/legality';
import {buildMatchConfigs, resolveMatchSpec} from '../match/pairing';
import {runMatchPool} from '../match/pool';
import {runMatch, runMatchConfigs} from '../match/runner';
import {MatchGameRecord, MatchRunReport, MatchSpec} from '../match/types';

// ---------------------------------------------------------------------------------------------
// The pre-committed run design (§6). These sizes are floors from the criteria, not arbitrary.
// ---------------------------------------------------------------------------------------------

/** R1/R4/R5: the headline runs. 2p is primary; 3p carries R5; 4p is smoke scale per §4.7. */
const MAIN_RUNS: ReadonlyArray<MatchSpec> = [
  {players: 2, lineup: ['random-legal', 'random-legal'], groups: 500},
  {players: 3, lineup: ['random-legal', 'random-legal', 'random-legal'], groups: 100},
  {players: 4, lineup: ['random-legal', 'random-legal', 'random-legal', 'random-legal'], groups: 25},
];

/**
 * R2: "≥ 20 groups at 2p and ≥ 10 at 3p", in-process and in a fresh process. Offset clear of the
 * main runs' groups.
 *
 * The 4p leg is not R2's own requirement - it discharges **R5**'s reproducibility clause, which
 * asks for completion, placement recording and R2-style reproducibility at 4p smoke scale. It runs
 * here rather than in `phaseMain` because this is where the reproducibility machinery already is.
 */
const R2_RUNS: ReadonlyArray<MatchSpec> = [
  {players: 2, lineup: ['random-legal', 'random-legal'], groups: 20, startGroup: 5_000},
  {players: 3, lineup: ['random-legal', 'random-legal', 'random-legal'], groups: 10, startGroup: 5_000},
  {players: 4, lineup: ['random-legal', 'random-legal', 'random-legal', 'random-legal'], groups: 5, startGroup: 5_000},
];

/** R3: ≥ 50 games sampled, ≥ 10 of them with a fallback. 30 groups x 2 = 60 games. */
const R3_RUN: MatchSpec = {players: 2, lineup: ['random-legal', 'random-legal'], groups: 30, startGroup: 6_000};
const R3_REQUIRED_FALLBACK_GAMES = 10;

/** R6: pooled vs single-process, in both capture modes. 40 groups = 80 games, enough to shard across 4 workers. */
const R6_RUN: MatchSpec = {players: 2, lineup: ['random-legal', 'random-legal'], groups: 40, startGroup: 7_000};
const R6_WORKERS = 4;

/**
 * R7: the scaling measurement. One spec, replayed at each worker count back-to-back.
 *
 * Sized at 2,000 games deliberately. A child process costs ~0.5-1 s to start, so at 8 workers a
 * 500-game run gives each child ~1.6 s of work against ~1 s of startup - a measurement mostly of
 * process creation, which is not what R7 is about. At 2,000 games each child does ~6.5 s of work
 * and startup is under 15% of its share.
 */
const R7_RUN: MatchSpec = {players: 2, lineup: ['random-legal', 'random-legal'], groups: 1_000, startGroup: 8_000};
const R7_WORKER_COUNTS: ReadonlyArray<number> = [1, 2, 4, 8];
/** Pre-committed in §6: below this, the spike's ×8 column is annotated and the M6 budget recomputed. */
const R7_THRESHOLD = 5;

/** R8: "a shared set of ≥ 50 configs". */
const R8_CONFIG_COUNT = 50;
const R8_NEUTRALITY_GROUPS = 10;

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

type PhaseName = 'main' | 'r2' | 'r3' | 'r6' | 'r7' | 'r8';

const PHASES: ReadonlyArray<PhaseName> = ['main', 'r2', 'r3', 'r6', 'r7', 'r8'];

/**
 * R4's *observed* half. The constructed cases live in `test/match/ranking.spec.ts`; what a spec
 * cannot supply is whether a real tie ever happened, and §6 requires that to be reported - if it
 * is zero, the tie path is covered by construction only and the write-up must say so.
 */
function tieObservations(games: ReadonlyArray<MatchGameRecord>): {
  completed: number;
  sharedWinGames: number;
  vpTieGames: number;
  vpTieBrokenByMegaCredits: number;
} {
  let sharedWinGames = 0;
  let vpTieGames = 0;
  let vpTieBrokenByMegaCredits = 0;
  const completedGames = games.filter((game) => game.completed);

  for (const game of completedGames) {
    const outcomes = game.seats.flatMap((seat) => (seat.outcome === undefined ? [] : [seat.outcome]));
    if (outcomes.filter((outcome) => outcome.isWinner).length > 1) {
      sharedWinGames++;
    }
    const topVp = Math.max(...outcomes.map((outcome) => outcome.victoryPoints));
    const atTop = outcomes.filter((outcome) => outcome.victoryPoints === topVp);
    if (atTop.length > 1) {
      vpTieGames++;
      // The tiebreak actually did work: tied on VP, separated by megacredits.
      if (new Set(atTop.map((outcome) => outcome.megaCredits)).size > 1) {
        vpTieBrokenByMegaCredits++;
      }
    }
  }

  return {completed: completedGames.length, sharedWinGames, vpTieGames, vpTieBrokenByMegaCredits};
}

async function phaseMain(): Promise<unknown> {
  const runs: Array<MatchRunReport> = [];
  for (const spec of MAIN_RUNS) {
    const resolved = resolveMatchSpec(spec);
    console.log(`[validate] main: ${resolved.players}p, ${resolved.groups} groups = ${resolved.games} games`);
    runs.push(await runMatch(spec, {silenceRoutineLogs: true, onProgress: progress(resolved.games)}));
  }
  return {
    runs,
    ties: Object.fromEntries(runs.map((run) => [`${run.summary.players}p`, tieObservations(run.games)])),
  };
}

/**
 * R2. Two legs, because "reproducible" means two different things and only one of them is
 * cheap: a second run in the *same* process (does the runner carry state between runs?) and a
 * run in a *fresh* process (does it depend on anything accumulated in this one?). Milestone 1
 * bullet 6 found nothing at either level, but it verified `replay()`, not this runner.
 */
async function phaseR2(): Promise<unknown> {
  const legs: Array<unknown> = [];
  for (const spec of R2_RUNS) {
    const resolved = resolveMatchSpec(spec);
    console.log(`[validate] R2: ${resolved.players}p x ${resolved.groups} groups, in-process and fresh-process`);
    const first = await runMatch(spec, {silenceRoutineLogs: true});
    const second = await runMatch(spec, {silenceRoutineLogs: true});
    const fresh = runInFreshProcess(spec);

    legs.push({
      players: resolved.players,
      groups: resolved.groups,
      games: resolved.games,
      inProcessMatches: reportsMatch(first, second),
      freshProcessMatches: reportsMatch(first, fresh),
      firstDifferingGame: firstRecordDifference(first, fresh),
    });
  }
  return {legs};
}

async function phaseR3(outDir: string): Promise<unknown> {
  const resolved = resolveMatchSpec(R3_RUN);
  const movesDir = path.join(outDir, 'moves');
  console.log(`[validate] R3: ${resolved.games} games at 'moves' tier -> ${movesDir}`);
  const report = await runMatch(R3_RUN, {
    capture: {historyTier: 'moves', legality: false, movesDir},
    silenceRoutineLogs: true,
  });
  const artifactPath = path.join(movesDir, 'r3.json');
  saveMatchArtifact(artifactPath, report);

  const verification = verifyMatchArtifact(artifactPath, {
    sample: resolved.games,
    requireFallbackGames: R3_REQUIRED_FALLBACK_GAMES,
    movesDir,
  });

  // §4.4 asked for the real bytes/game rather than the plan's 30-60 KB guess.
  const movesBytes = fs.readdirSync(movesDir)
    .filter((name) => name !== 'r3.json')
    .reduce((total, name) => total + fs.statSync(path.join(movesDir, name)).size, 0);

  return {
    verification,
    movesTierBytesPerGame: Math.round(movesBytes / resolved.games),
    summaryTierBytesPerGame: Math.round(fs.statSync(artifactPath).size / resolved.games),
  };
}

async function phaseR6(): Promise<unknown> {
  const legs: Array<unknown> = [];
  for (const capture of [
    {historyTier: 'summary', legality: false} as const,
    {historyTier: 'trace', legality: true} as const,
  ]) {
    const resolved = resolveMatchSpec(R6_RUN);
    console.log(`[validate] R6: ${resolved.games} games, single-process vs ${R6_WORKERS} workers, ` +
      `tier '${capture.historyTier}'${capture.legality ? ' + legality' : ''}`);
    const single = await runMatchConfigs(buildMatchConfigs(resolved), resolved, {capture, silenceRoutineLogs: true});
    const pooled = await runMatchPool(R6_RUN, {workers: R6_WORKERS, capture, silenceRoutineLogs: true});

    legs.push({
      capture,
      games: resolved.games,
      workers: R6_WORKERS,
      identical: reportsMatch(single, pooled),
      firstDifferingGame: firstRecordDifference(single, pooled),
    });
  }
  return {legs};
}

/**
 * R7. Absolute games/s on this machine is not stable across sessions (see the module doc), so the
 * criterion is adjudicated on the **speedup ratio**, whose points are all measured back-to-back
 * here. The absolute numbers are reported too, with the machine described, because a ratio with
 * no scale is not a throughput measurement.
 */
async function phaseR7(options: {workerCounts?: ReadonlyArray<number>; groups?: number} = {}): Promise<unknown> {
  const spec = {...R7_RUN, groups: options.groups ?? R7_RUN.groups};
  const workerCounts = options.workerCounts ?? R7_WORKER_COUNTS;
  const resolved = resolveMatchSpec(spec);
  const points: Array<{
    workers: number;
    wallClockMs: number;
    gamesPerSecond: number;
    completed: number;
    machineBefore: unknown;
    machineAfter: unknown;
  }> = [];

  for (const workers of workerCounts) {
    console.log(`[validate] R7: ${resolved.games} games across ${workers} worker(s)`);
    const before = machineState();
    const started = Date.now();
    const report = await runMatchPool(spec, {workers, capture: {historyTier: 'summary', legality: false}, silenceRoutineLogs: true});
    const wallClockMs = Date.now() - started;
    points.push({
      workers,
      wallClockMs,
      gamesPerSecond: report.summary.games / (wallClockMs / 1000),
      completed: report.summary.completed,
      // R7 is only interpretable alongside what else the machine was doing: a host that is
      // swapping cannot host 8 Node children at ~300 MB peak heap each, and the resulting number
      // measures the host, not the pool. Recorded per point rather than once per run.
      machineBefore: before,
      machineAfter: machineState(),
    });
  }

  const baseline = points[0].gamesPerSecond;
  const speedups = points.map((point) => ({workers: point.workers, speedup: point.gamesPerSecond / baseline}));
  const atEight = speedups.find((entry) => entry.workers === 8)?.speedup ?? NaN;

  return {
    games: resolved.games,
    workerCounts,
    machine: describeMachine(),
    points,
    speedups,
    threshold: R7_THRESHOLD,
    // `met` is only meaningful when 8 workers were actually measured; a partial sweep leaves it
    // undefined rather than false, so a reduced run cannot be misread as a failed one.
    met: Number.isNaN(atEight) ? undefined : atEight >= R7_THRESHOLD,
    speedupAt8: Number.isNaN(atEight) ? undefined : atEight,
  };
}

async function phaseR8(): Promise<unknown> {
  console.log(`[validate] R8: legality-accounting equivalence over ${R8_CONFIG_COUNT} configs (both variants)`);
  // The oracle (`runLegalityBatch`) takes `LegalityGameConfig`s; use a seed schedule of its own
  // shape rather than the match pairing's, since this comparison is about accounting, not pairing.
  const configs = Array.from({length: R8_CONFIG_COUNT}, (_unused, index) => ({
    players: 2 as const,
    engineSeed: 31_000_019 + index * 1_301,
    agentSeed: 37_000_003 + index * 2_711,
  }));
  const equivalence = await compareLegalityAccounting(configs);

  console.log('[validate] R8: instrumentation neutrality (against replay, and on real match games)');
  const neutralityAgainstReplay = await checkNeutralityAgainstReplay(configs.slice(0, 12));

  const neutralitySpec = resolveMatchSpec({
    players: 2,
    lineup: ['random-legal', 'random-legal'],
    groups: R8_NEUTRALITY_GROUPS,
    startGroup: 9_000,
  });
  const matchNeutrality = await checkMatchNeutrality(buildMatchConfigs(neutralitySpec), neutralitySpec);

  return {equivalence, neutralityAgainstReplay, matchNeutrality};
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function progress(total: number): (completed: number) => void {
  return (completed: number) => {
    if (completed % 200 === 0) {
      process.stdout.write(`[validate]   ${completed}/${total} games\n`);
    }
  };
}

/**
 * Locates the first game record two reports disagree on, after the declared timing fields are
 * stripped. `reportsMatch` answers yes/no; when the answer is no, this is what makes the failure
 * diagnosable instead of a 3 MB diff.
 */
function firstRecordDifference(a: MatchRunReport, b: MatchRunReport): unknown {
  const strippedA = stripTimingFields(a) as {games: ReadonlyArray<unknown>};
  const strippedB = stripTimingFields(b) as {games: ReadonlyArray<unknown>};
  const length = Math.max(strippedA.games.length, strippedB.games.length);
  for (let i = 0; i < length; i++) {
    const left = JSON.stringify(strippedA.games[i]);
    const right = JSON.stringify(strippedB.games[i]);
    if (left !== right) {
      return {index: i, a: truncate(left), b: truncate(right)};
    }
  }
  return undefined;
}

function truncate(value: string | undefined): string {
  const text = value ?? '<missing>';
  return text.length <= 400 ? text : `${text.slice(0, 400)}...`;
}

/** `matchCli.js`/`.ts` beside this file, whichever runtime we are under. */
function matchCliPath(): string {
  return path.join(__dirname, __filename.endsWith('.ts') ? 'matchCli.ts' : 'matchCli.js');
}

/**
 * Plays `spec` in a genuinely fresh process via the ordinary CLI, and loads the artifact it wrote.
 * Uses the CLI rather than a bespoke worker so the fresh-process leg exercises the same entry
 * point an operator would - if the CLI defaulted something differently, R2 should catch it.
 */
function runInFreshProcess(spec: MatchSpec): MatchRunReport {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-match-r2-'));
  const outPath = path.join(dir, 'fresh.json');
  try {
    const args = [
      '--players', String(spec.players),
      '--lineup', spec.lineup.join(','),
      '--groups', String(spec.groups),
      '--start-group', String(spec.startGroup ?? 0),
      '--out', outPath,
    ];
    const cli = matchCliPath();
    const command = cli.endsWith('.ts') ?
      {bin: process.execPath, argv: [path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs'), cli, ...args]} :
      {bin: process.execPath, argv: [cli, ...args]};
    execFileSync(command.bin, command.argv, {stdio: ['ignore', 'ignore', 'inherit']});
    return loadMatchArtifact(outPath);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

/**
 * A throughput point is only interpretable next to what the host was doing. `freeMemoryBytes` and
 * the swap figure are the ones that matter here: this measurement was first taken on a host with
 * 5.7 GB of 6.1 GB swap in use, where the pool was thrashing rather than scaling.
 */
function machineState(): Record<string, unknown> {
  return {
    loadAverage: os.loadavg(),
    freeMemoryBytes: os.freemem(),
    swap: readSwapUsage(),
  };
}

/** macOS-only, and best-effort: a missing swap figure must never fail a validation run. */
function readSwapUsage(): string | undefined {
  try {
    return execFileSync('sysctl', ['-n', 'vm.swapusage'], {encoding: 'utf8'}).trim();
  } catch {
    return undefined;
  }
}

function describeMachine(): Record<string, unknown> {
  return {
    cpuModel: os.cpus()[0]?.model,
    cores: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    loadAverage: os.loadavg(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runtime: __filename.endsWith('.ts') ? 'tsx' : 'compiled',
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

type PhaseOptions = {r7Workers?: ReadonlyArray<number>; r7Groups?: number};

async function runPhase(phase: PhaseName, outDir: string, options: PhaseOptions = {}): Promise<void> {
  const started = Date.now();
  const block = phase === 'main' ? await phaseMain() :
    phase === 'r2' ? await phaseR2() :
      phase === 'r3' ? await phaseR3(outDir) :
        phase === 'r6' ? await phaseR6() :
          phase === 'r7' ? await phaseR7({workerCounts: options.r7Workers, groups: options.r7Groups}) :
            await phaseR8();

  fs.mkdirSync(outDir, {recursive: true});
  fs.writeFileSync(path.join(outDir, `${phase}.json`), JSON.stringify(block, null, 1));
  console.log(`[validate] ${phase} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * Serializes the battery with the analysis pretty-printed and the ~1,700 per-game rows one per
 * line - the same call `match/artifact.ts` and `legality/artifact.ts` both make, for the same
 * reason: a game row is read as a record and grepped for a seed, not navigated as a tree, and
 * indenting them tripled the file (6.98 MB pretty-printed against 3.5 MB this way) for no gain.
 */
function serializeArtifact(artifact: Record<string, unknown>): string {
  const ROWS = '@@ROWS@@';
  const rowSets: Array<string> = [];

  const text = JSON.stringify(artifact, (_key, value: unknown) => {
    if (Array.isArray(value) && value.length > 0 && isGameRow(value[0])) {
      rowSets.push(value.map((row) => `      ${JSON.stringify(row)}`).join(',\n'));
      return `${ROWS}${rowSets.length - 1}`;
    }
    return value;
  }, 1);

  return `${text.replace(new RegExp(`"${ROWS}(\\d+)"`, 'g'), (_match, index: string) =>
    `[\n${rowSets[Number(index)]}\n    ]`)}\n`;
}

function isGameRow(value: unknown): boolean {
  const row = value as Partial<MatchGameRecord> | null;
  return row !== null && typeof row === 'object' &&
    typeof row.groupIndex === 'number' && typeof row.permutationIndex === 'number' && Array.isArray(row.seats);
}

/** Merges the phase blocks into the one committed artifact the plan names. */
function assemble(outDir: string, finalPath: string): void {
  const blocks: Record<string, unknown> = {};
  for (const phase of PHASES) {
    const file = path.join(outDir, `${phase}.json`);
    if (fs.existsSync(file)) {
      blocks[phase] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      console.warn(`[validate] assemble: ${phase}.json is missing - the artifact will not carry it.`);
    }
  }

  const main = blocks.main as {runs: ReadonlyArray<MatchRunReport>} | undefined;
  const artifact = {
    what: 'Milestone 2 bullet 1 (the match runner) validation battery: evidence for criteria R1-R8, ' +
      'pre-committed in agent/docs/Milestone2_Bullet1_Prompts.md §6. Adjudicated in agent/docs/Match_Runner.md.',
    generatedAt: new Date().toISOString(),
    machine: describeMachine(),
    // Provenance is identical across the phases; lift one copy rather than repeating it per run.
    provenance: main?.runs[0]?.header.provenance,
    ...blocks,
  };

  fs.mkdirSync(path.dirname(finalPath), {recursive: true});
  fs.writeFileSync(finalPath, serializeArtifact(artifact));
  const sizeMb = fs.statSync(finalPath).size / 1024 / 1024;
  console.log(`[validate] wrote ${finalPath} (${sizeMb.toFixed(2)} MB)`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let phase = 'all';
  let outDir = path.join(os.tmpdir(), 'nadia-match-validation');
  let finalPath: string | undefined;
  // R7's shape is adjustable so the check can be re-run on a host that can actually afford the
  // worker counts it names - see the Match_Runner.md throughput section for why this run could not.
  let r7Workers: ReadonlyArray<number> | undefined;
  let r7Groups: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--phase':
      phase = argv[++i];
      break;
    case '--out-dir':
      outDir = argv[++i];
      break;
    case '--final':
      finalPath = argv[++i];
      break;
    case '--r7-workers':
      r7Workers = argv[++i].split(',').map(Number);
      break;
    case '--r7-groups':
      r7Groups = Number(argv[++i]);
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  ensureHeadlessEngine();
  // `defaultOutputDir` walks up to the real repo root rather than counting `..` from __dirname -
  // which under the compiled build (the only build a throughput number may come from, hazard H5)
  // would resolve to `build/agent/agent/docs/data`, a path that exists nowhere and is not
  // gitignored. `artifact.ts` documents that trap; this is it, and the first assemble run fell
  // straight into it by hand-rolling the join.
  const resolvedFinal = finalPath ?? path.join(defaultOutputDir('summary'), 'match_runner_validation.json');

  if (phase === 'assemble') {
    assemble(outDir, resolvedFinal);
    return;
  }
  if (phase === 'all') {
    for (const name of PHASES) {
      await runPhase(name, outDir, {r7Workers, r7Groups});
    }
    assemble(outDir, resolvedFinal);
    return;
  }
  if (!PHASES.includes(phase as PhaseName)) {
    throw new Error(`--phase must be one of ${[...PHASES, 'all', 'assemble'].join(', ')}; got '${phase}'`);
  }
  await runPhase(phase as PhaseName, outDir, {r7Workers, r7Groups});
}

if (require.main === module) {
  void main();
}
