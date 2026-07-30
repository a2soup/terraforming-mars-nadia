/**
 * CLI for the candidate-enumeration corpus run - Milestone 2, bullet 2, Unit B, criterion G1a/G1c
 * (agent/docs/Milestone2_Bullet2_Prompts.md §5).
 *
 *   The pre-committed G1a run (>= 200 real games), writing the artifact:
 *     node build/agent/agent/src/runner/candidatesCli.js --composition 2:150,3:35,4:15 \
 *       --out agent/docs/data/candidate_validation.json
 *
 *   A quick smoke run:
 *     npx tsx agent/src/runner/candidatesCli.ts --composition 2:3
 *
 *   Preview the resolved configs without playing anything:
 *     npx tsx agent/src/runner/candidatesCli.ts --composition 2:5 --list
 *
 * Follows the arg-parsing style of legalityCli.ts / determinismCli.ts: a switch over process.argv,
 * explicit errors on unknown flags, no parsing dependency.
 *
 * Exit code is 1 if any candidate was rejected by the Engine (G1a's blocking condition) or any
 * game failed to complete, so the run is usable as a gate and not only as a report.
 *
 * **No timing printed here is a performance figure** (hazard H10): `tsx` understates the
 * simulator ~3.5x, and any number that matters comes from the compiled build with the host's swap
 * state checked first.
 */
import {writeFileSync} from 'fs';
import {
  CandidateValidationReport,
  buildCandidateValidationConfigs,
  runCandidateValidation,
} from '../core/candidates/validation';
import {ensureHeadlessEngine} from '../engine/headlessEngine';

/** The pre-committed G1a corpus: 200 games, weighted to the 2p primary setting (CLAUDE.md §1). */
const DEFAULT_COMPOSITION: ReadonlyArray<{players: number; games: number}> = [
  {players: 2, games: 150},
  {players: 3, games: 35},
  {players: 4, games: 15},
];

type ParsedArgs = {
  composition: ReadonlyArray<{players: number; games: number}>;
  out?: string;
  list: boolean;
  maxCandidatesPerDecision?: number;
  progressEvery: number;
  verboseLogs: boolean;
};

/** `2:150,3:35` -> the composition list. */
function parseComposition(raw: string): ReadonlyArray<{players: number; games: number}> {
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
    return {players, games};
  });
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let composition = DEFAULT_COMPOSITION;
  let out: string | undefined;
  let list = false;
  let maxCandidatesPerDecision: number | undefined;
  let progressEvery = 10;
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
    case '--max-candidates':
      maxCandidatesPerDecision = Number(argv[++i]);
      break;
    case '--progress-every':
      progressEvery = Number(argv[++i]);
      break;
    case '--verbose-logs':
      verboseLogs = true;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  return {composition, out, list, maxCandidatesPerDecision, progressEvery, verboseLogs};
}

function reportSummary(report: CandidateValidationReport): void {
  console.log('');
  console.log(`[candidates] ${report.gamesCompleted}/${report.gamesRun} games completed in ${(report.wallClockMs / 1000).toFixed(1)}s`);
  console.log(`[candidates] decision points: ${report.decisionPoints.toLocaleString()}, ` +
    `probed at ${report.decisionsValidated.toLocaleString()} (${percent(report.decisionsValidated, report.decisionPoints)}%)`);
  console.log(`[candidates] fork gaps: unavailable ${report.forkGaps.forkUnavailable}, unfaithful ${report.forkGaps.forkUnfaithful}, ` +
    `pending-model mismatch ${report.forkGaps.forkPendingModelMismatch} (+${report.forkGaps.ancestorPendingModelMismatch} refused as ancestors)`);
  console.log(`[candidates] G1a candidates submitted: ${report.candidatesSubmitted.toLocaleString()}, ` +
    `accepted ${report.candidatesAccepted.toLocaleString()}, REJECTED ${report.candidatesRejected.toLocaleString()}`);
  console.log(`[candidates] set size: median ${report.setSize.median}, p95 ${report.setSize.p95}, max ${report.setSize.max}; ` +
    `capped decisions ${report.cappedDecisions}, empty sets ${report.emptySets}`);
  console.log(`[candidates] FR-9 fallbacks during the driving runs: ${report.fr9Fallbacks}`);

  console.log('[candidates] G1c coverage by decision type:');
  console.log(`  ${'type'.padEnd(18)}${'decisions'.padStart(10)}${'probed'.padStart(9)}${'inCands'.padStart(11)}${'submitted'.padStart(11)}${'accepted'.padStart(10)}${'rejected'.padStart(10)}${'empty'.padStart(7)}${'capped'.padStart(8)}${'set p50/p95/max'.padStart(18)}`);
  for (const [type, stats] of Object.entries(report.byType)) {
    console.log(`  ${type.padEnd(18)}${String(stats.decisions).padStart(10)}${String(stats.decisionsValidated).padStart(9)}` +
      `${String(stats.candidateAppearances).padStart(11)}${String(stats.candidatesSubmitted).padStart(11)}${String(stats.candidatesAccepted).padStart(10)}` +
      `${String(stats.candidatesRejected).padStart(10)}${String(stats.emptySets).padStart(7)}${String(stats.cappedDecisions).padStart(8)}` +
      `${`${stats.setSize.median}/${stats.setSize.p95}/${stats.setSize.max}`.padStart(18)}`);
  }
  if (report.unreachedTypes.length > 0) {
    console.log(`[candidates] G1c: in-scope types the corpus never reached: ${report.unreachedTypes.join(', ')}`);
  }
  if (report.unvalidatedTypes.length > 0) {
    console.log(`[candidates] G1c: in-scope types reached but never probed (no faithful fork): ${report.unvalidatedTypes.join(', ')}`);
  }

  for (const rejection of report.rejections) {
    console.error(`[candidates] REJECTED players=${rejection.players} engineSeed=${rejection.engineSeed} ` +
      `#${rejection.decisionIndex} ${rejection.decisionType} candidate[${rejection.candidateIndex}] ` +
      `${rejection.candidate} -> ${rejection.errorClass}: ${rejection.message}`);
  }
  for (const failure of report.failedGames) {
    console.error(`[candidates] FAILED players=${failure.config.players} engineSeed=${failure.config.engineSeed} ` +
      `agentSeed=${failure.config.agentSeed}: ${failure.message}`);
  }

  console.log('');
  if (report.candidatesRejected === 0 && report.failedGames.length === 0) {
    console.log(`[candidates] G1a PASSED: all ${report.candidatesSubmitted.toLocaleString()} candidates across ` +
      `${report.gamesCompleted} games were accepted by the Engine's own process() on first submission.`);
  } else {
    console.error('[candidates] G1a FAILED: see the rejections above. This is a defect in candidate enumeration, ' +
      'not something to work around - a candidate the Engine refuses is an illegal move (SRS CON-2, NFR-4).');
  }
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '0.0' : (100 * part / whole).toFixed(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configs = buildCandidateValidationConfigs(args.composition);

  if (args.list) {
    for (const config of configs) {
      console.log(JSON.stringify(config));
    }
    return;
  }

  ensureHeadlessEngine();
  console.log(`[candidates] G1a/G1c corpus: ${configs.length} games ` +
    `(${args.composition.map((c) => `${c.games}x${c.players}p`).join(' + ')}), single process.`);

  const started = Date.now();
  const report = await runCandidateValidation(configs, {
    maxCandidatesPerDecision: args.maxCandidatesPerDecision,
    silenceLogs: !args.verboseLogs,
    onProgress: (completed, total) => {
      if (completed % args.progressEvery === 0 || completed === total) {
        const rate = completed / ((Date.now() - started) / 1000);
        process.stdout.write(`[candidates] ${completed}/${total} games (${rate.toFixed(2)} games/s)\n`);
      }
    },
  });

  reportSummary(report);

  if (args.out !== undefined) {
    writeFileSync(args.out, JSON.stringify(report, undefined, 2) + '\n');
    console.log(`[candidates] wrote the run artifact to ${args.out}`);
  }

  if (report.candidatesRejected > 0 || report.failedGames.length > 0) {
    process.exitCode = 1;
  }
}

void main();
