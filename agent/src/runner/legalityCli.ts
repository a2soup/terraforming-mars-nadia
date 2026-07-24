/**
 * CLI for the AC-1 legality run (Milestone 1 exit criterion, legality half). The criteria it
 * produces evidence for - L1-L7 - are pre-committed in agent/docs/AC1_Legality_Run.md.
 *
 *   The full pre-committed run (1,000 x 2p + 250 x 3p + 250 x 4p), writing the artifact:
 *     node build/agent/agent/src/runner/legalityCli.js --out agent/docs/data/ac1_legality_run.json
 *
 *   A smaller shard, e.g. to re-check one player count or reproduce a failing seed:
 *     npx tsx agent/src/runner/legalityCli.ts --composition 2:20
 *
 *   The instrumentation-neutrality check (does the measurement change the run?):
 *     npx tsx agent/src/runner/legalityCli.ts --check-instrumentation 8
 *
 *   Routine per-decision logging (the driver's FR-9 warn, the Engine's cache-eviction log) is
 *   silenced automatically for runs of 100+ games, since every fallback is counted anyway;
 *   `--verbose-logs` keeps it.
 *
 *   Preview the resolved configs without playing anything:
 *     npx tsx agent/src/runner/legalityCli.ts --composition 2:5,3:5 --list
 *
 * Follows the arg-parsing style of determinismCli.ts/speedSpikeCli.ts: a switch over process.argv,
 * explicit errors on unknown flags, no parsing dependency.
 *
 * Exit code is 1 if any blocking criterion is breached (a game that did not complete, or an
 * unrecovered illegal move), so the run is usable as a gate and not only as a report.
 */
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {ReplayConfig} from '../determinism/types';
import {buildArtifact, saveArtifact} from '../legality/artifact';
import {checkInstrumentationNeutrality} from '../legality/instrumentationCheck';
import {runLegalityBatch} from '../legality/run';
import {buildLegalityConfigs, DEFAULT_COMPOSITION} from '../legality/seeds';
import {LegalityRunReport} from '../legality/types';

type ParsedArgs = {
  composition: ReadonlyArray<{players: 2 | 3 | 4; games: number}>;
  out?: string;
  list: boolean;
  checkInstrumentation?: number;
  progressEvery: number;
  heapSampleEvery: number;
  verboseLogs: boolean;
};

/** `2:1000,3:250` -> the default-shaped composition list. */
function parseComposition(raw: string): ReadonlyArray<{players: 2 | 3 | 4; games: number}> {
  return raw.split(',').map((entry) => {
    const [playersRaw, gamesRaw] = entry.split(':');
    const players = Number(playersRaw);
    const games = Number(gamesRaw);
    if (players !== 2 && players !== 3 && players !== 4) {
      throw new Error(`--composition player counts must each be 2, 3, or 4, got ${playersRaw}`);
    }
    if (!Number.isInteger(games) || games < 1) {
      throw new Error(`--composition game counts must be positive integers, got ${gamesRaw}`);
    }
    return {players: players as 2 | 3 | 4, games};
  });
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let composition = DEFAULT_COMPOSITION;
  let out: string | undefined;
  let list = false;
  let checkInstrumentation: number | undefined;
  let progressEvery = 100;
  let heapSampleEvery = 25;
  let verboseLogs = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--composition':
      composition = parseComposition(argv[++i]);
      break;
    case '--out':
      out = argv[++i];
      break;
    case '--list':
      list = true;
      break;
    case '--check-instrumentation':
      checkInstrumentation = Number(argv[++i]);
      break;
    case '--progress-every':
      progressEvery = Number(argv[++i]);
      break;
    case '--heap-sample-every':
      heapSampleEvery = Number(argv[++i]);
      break;
    case '--verbose-logs':
      verboseLogs = true;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  return {composition, out, list, checkInstrumentation, progressEvery, heapSampleEvery, verboseLogs};
}

/**
 * The neutrality check's configs: taken from the determinism corpus's own seed space (base
 * 500,000, stride 977 - determinism/sweep.ts), deliberately, since those are the games bullet 6
 * already established replay exactly. A wrapper-induced difference there is unambiguous.
 */
function neutralityConfigs(count: number): ReadonlyArray<ReplayConfig> {
  const players: ReadonlyArray<2 | 3 | 4> = [2, 3, 4];
  const configs: Array<ReplayConfig> = [];
  for (let i = 0; i < count; i++) {
    configs.push({
      players: players[i % players.length],
      engineSeed: 500_000 + i * 977,
      agentSeed: 1_000_003,
    });
  }
  return configs;
}

async function runNeutrality(count: number): Promise<void> {
  ensureHeadlessEngine();
  const configs = neutralityConfigs(count);
  console.log(`[legality] instrumentation neutrality: comparing ${configs.length} config(s) clean vs instrumented...`);
  const report = await checkInstrumentationNeutrality(configs);

  if (report.mismatches.length === 0) {
    console.log(`[legality] OK - the instrumentation is behaviour-neutral across ${report.configsChecked} config(s).`);
    return;
  }
  for (const mismatch of report.mismatches) {
    console.error(
      `[legality] NEUTRALITY MISMATCH players=${mismatch.config.players} engineSeed=${mismatch.config.engineSeed} ` +
      `agentSeed=${mismatch.config.agentSeed}: ${mismatch.field} clean=${mismatch.clean} instrumented=${mismatch.instrumented}`,
    );
  }
  console.error(
    `[legality] ${report.mismatches.length} mismatch(es): the instrumented run is NOT measuring the same games as ` +
    'the uninstrumented one, so every strict-accounting number from it is void.',
  );
  process.exitCode = 1;
}

function reportSummary(report: LegalityRunReport): void {
  const s = report.summary;
  console.log('');
  console.log(`[legality] ${s.gamesCompleted}/${s.gamesRun} games completed in ${(s.wallClockMs / 1000).toFixed(1)}s ` +
    `(${s.byPlayerCount.map((b) => `${b.players}p ${b.gamesCompleted}/${b.gamesRun}`).join(', ')})`);
  console.log(`[legality] decisions: ${s.totalDecisions.toLocaleString()} total, ` +
    `median ${s.decisionsPerGame.p50}/game (p95 ${s.decisionsPerGame.p95}, max ${s.decisionsPerGame.max})`);
  console.log(`[legality] submissions to the Engine: ${s.totalSubmissions.toLocaleString()}`);
  console.log(`[legality] L4 unrecovered illegal moves: ${s.unrecoverableIllegalMoves}`);
  console.log(`[legality] L5 rejected submissions - responder (class A, an illegal move): ${s.rejectedResponder}; ` +
    `fallback probe: ${s.rejectedFallbackProbe}`);
  console.log(`[legality] class B (responder threw, nothing submitted): ${s.responderThrows}`);
  console.log('[legality] L6 causes:');
  for (const cause of report.causes) {
    console.log(`  ${String(cause.count).padStart(7)}  ${cause.source} :: ${cause.decisionType} :: ${cause.errorClass}: ${cause.signature}`);
  }
  if (report.stability.length > 0) {
    const first = report.stability[0];
    const last = report.stability[report.stability.length - 1];
    console.log(`[legality] L7 heap: ${first.heapUsedMb} MB after ${first.gamesCompleted} games -> ` +
      `${last.heapUsedMb} MB after ${last.gamesCompleted} (rss ${first.rssMb} -> ${last.rssMb} MB)`);
  }
  for (const game of report.games.filter((g) => !g.completed)) {
    console.error(`[legality] FAILED players=${game.players} engineSeed=${game.engineSeed} agentSeed=${game.agentSeed}: ` +
      `${game.failure?.errorClass}: ${game.failure?.message}`);
  }
}

async function runFull(args: ParsedArgs): Promise<void> {
  const configs = buildLegalityConfigs(args.composition);

  if (args.list) {
    for (const config of configs) {
      console.log(JSON.stringify(config));
    }
    return;
  }

  ensureHeadlessEngine();
  console.log(`[legality] AC-1 legality run: ${configs.length} games ` +
    `(${args.composition.map((c) => `${c.games}x${c.players}p`).join(' + ')}), single process.`);

  const started = Date.now();
  const report = await runLegalityBatch(configs, {
    heapSampleEvery: args.heapSampleEvery,
    // Routine per-decision logging is silenced for any run big enough to be buried by it - see
    // `silenceRoutineLogs`. That also silences `console.log`, so progress goes straight to stdout.
    silenceRoutineLogs: !args.verboseLogs && configs.length >= 100,
    onProgress: (completed, total) => {
      if (completed % args.progressEvery === 0) {
        const rate = completed / ((Date.now() - started) / 1000);
        process.stdout.write(`[legality] ${completed}/${total} games (${rate.toFixed(1)} games/s)\n`);
      }
    },
  });

  reportSummary(report);

  if (args.out !== undefined) {
    saveArtifact(args.out, buildArtifact(report));
    console.log(`[legality] wrote the run artifact to ${args.out}`);
  }

  if (report.summary.gamesFailed > 0 || report.summary.unrecoverableIllegalMoves > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkInstrumentation !== undefined) {
    await runNeutrality(args.checkInstrumentation);
    return;
  }
  await runFull(args);
}

void main();
