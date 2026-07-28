/**
 * CLI for the match runner (SRS FR-13; Milestone 2 bullet 1). The criteria it produces evidence
 * for - R1-R8 - are pre-committed in agent/docs/Milestone2_Bullet1_Prompts.md §6.
 *
 *   A 1,000-game 2p validation match (500 pairing groups x 2 permutations), writing the artifact:
 *     node build/agent/agent/src/runner/matchCli.js --players 2 --groups 500 --out match_runner_validation.json
 *
 *   A small ad-hoc match, reported to stdout and not written anywhere:
 *     npx tsx agent/src/runner/matchCli.ts --players 3 --groups 5
 *
 *   Two named agents against each other (once bullet 2 adds the greedy baseline):
 *     npx tsx agent/src/runner/matchCli.ts --lineup random-legal,greedy-1ply --groups 100
 *
 *   Preview the resolved specification without playing anything:
 *     npx tsx agent/src/runner/matchCli.ts --players 2 --groups 3 --list
 *
 *   The AC-1 legality battery as a mode of a match (§4.6), for a promoted agent version:
 *     npx tsx agent/src/runner/matchCli.ts --lineup <agent>,<agent> --groups 500 --legality
 *
 * **Any performance number must come from the compiled build** (hazard H5): `tsx` understates the
 * simulator ~3.5x, so a games/s figure measured under `npx tsx` is not a performance figure. Build
 * with `npx tsc -p agent/tsconfig.json && npx tsc-alias -p agent/tsconfig.json` (the alias pass is
 * required - plain tsc emits unrewritten `require("@/...")` calls) and run the `node` form above.
 *
 * Follows the arg-parsing style of `legalityCli.ts`/`determinismCli.ts`: a switch over
 * `process.argv`, explicit errors on unknown flags, no parsing dependency. Routine per-decision
 * logging is silenced automatically for runs of 100+ games, since every fallback is counted anyway
 * (hazard H7); `--verbose-logs` keeps it.
 *
 * Exit code is 1 if any game failed to complete - a match with holes in it is not a measurement,
 * so the runner is usable as a gate and not only as a report.
 *
 * **`npm run match:pool` is Unit C's entry point** (`agent/src/match/pool.ts`, §4.5), registered in
 * `package.json` up front so Unit C never edits that file (§9). It takes the same flags:
 * {@link parseMatchArgs} and {@link runFromArgs} are exported so the pooled path parses one
 * specification language rather than a second, near-identical one.
 */
import * as path from 'path';
import {AGENTS, agentNames, DEFAULT_AGENT, formatIdentity} from '../agents/registry';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {defaultOutputDir, resolveOutputPath, saveMatchArtifact} from '../match/artifact';
import {buildMatchConfigs, defaultRunId, groupsForGames, permutationsFor, resolveMatchSpec} from '../match/pairing';
import {MatchCaptureOptions, runMatchConfigs} from '../match/runner';
import {HistoryTier, MatchRunReport, MatchSpec, ResolvedMatchSpec} from '../match/types';

export type ParsedMatchArgs = {
  spec: MatchSpec;
  capture: MatchCaptureOptions;
  runId?: string;
  out?: string;
  list: boolean;
  listAgents: boolean;
  progressEvery: number;
  yieldEvery: number;
  verboseLogs: boolean;
  /**
   * Rounded up from `--games` to a whole number of pairing groups, when that flag was used and it
   * changed the count. Reported rather than applied silently: a partly-played group is an
   * unbalanced sample (§4.1), so the operator has to be told what was actually played.
   */
  roundedFrom?: number;
};

function parseTier(raw: string): HistoryTier {
  if (raw !== 'summary' && raw !== 'trace' && raw !== 'moves') {
    throw new Error(`--history must be one of summary, trace, moves; got '${raw}'`);
  }
  return raw;
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got '${raw}'`);
  }
  return value;
}

/** Exported so Unit C's pool entry point takes exactly the same flags rather than inventing its own. */
export function parseMatchArgs(argv: ReadonlyArray<string>): ParsedMatchArgs {
  let players: 2 | 3 | 4 = 2;
  let lineup: ReadonlyArray<string> | undefined;
  let groups: number | undefined;
  let games: number | undefined;
  let startGroup = 0;
  let historyTier: HistoryTier = 'summary';
  let legality = false;
  let movesDir: string | undefined;
  let runId: string | undefined;
  let out: string | undefined;
  let list = false;
  let listAgents = false;
  let progressEvery = 100;
  let yieldEvery = 1;
  let verboseLogs = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--players': {
      const value = Number(argv[++i]);
      if (value !== 2 && value !== 3 && value !== 4) {
        throw new Error(`--players must be 2, 3, or 4, got '${argv[i]}'`);
      }
      players = value;
      break;
    }
    case '--lineup':
      lineup = argv[++i].split(',').map((name) => name.trim());
      break;
    case '--groups':
      groups = positiveInteger(argv[++i], '--groups');
      break;
    case '--games':
      games = positiveInteger(argv[++i], '--games');
      break;
    case '--start-group':
      startGroup = Number(argv[++i]);
      break;
    case '--history':
      historyTier = parseTier(argv[++i]);
      break;
    case '--legality':
      legality = true;
      break;
    case '--moves-dir':
      movesDir = argv[++i];
      break;
    case '--run-id':
      runId = argv[++i];
      break;
    case '--out':
      out = argv[++i];
      break;
    case '--list':
      list = true;
      break;
    case '--list-agents':
      listAgents = true;
      break;
    case '--progress-every':
      progressEvery = positiveInteger(argv[++i], '--progress-every');
      break;
    case '--yield-every':
      yieldEvery = positiveInteger(argv[++i], '--yield-every');
      break;
    case '--verbose-logs':
      verboseLogs = true;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  if (groups !== undefined && games !== undefined) {
    throw new Error('--groups and --games specify the same thing two ways; pass one of them.');
  }
  // `--lineup` implies the player count when `--players` was not given, so the common two-agent
  // case reads as one flag rather than two that have to agree.
  if (lineup !== undefined && argvHas(argv, '--players') === false) {
    if (lineup.length !== 2 && lineup.length !== 3 && lineup.length !== 4) {
      throw new Error(`--lineup must name 2, 3, or 4 agents, got ${lineup.length}`);
    }
    players = lineup.length;
  }

  const resolvedGroups = games === undefined ? groups ?? 1 : groupsForGames(games, players);
  return {
    spec: {players, lineup: lineup ?? new Array(players).fill(DEFAULT_AGENT), groups: resolvedGroups, startGroup},
    capture: {historyTier, legality, ...(movesDir === undefined ? {} : {movesDir})},
    runId,
    out,
    list,
    listAgents,
    progressEvery,
    yieldEvery,
    verboseLogs,
    ...(games !== undefined && games !== resolvedGroups * permutationsFor(players).length ? {roundedFrom: games} : {}),
  };
}

function argvHas(argv: ReadonlyArray<string>, flag: string): boolean {
  return argv.includes(flag);
}

function describeAgents(): string {
  return agentNames()
    .map((name) => `  ${formatIdentity(AGENTS[name]).padEnd(20)}${AGENTS[name].description}`)
    .join('\n');
}

function reportSummary(report: MatchRunReport): void {
  const {summary, header} = report;
  const seconds = summary.timing.wallClockMs / 1000;
  console.log('');
  console.log(`[match] ${header.runId}`);
  console.log(`[match] ${summary.completed}/${summary.games} games completed in ${seconds.toFixed(1)}s ` +
    `(${(summary.games / seconds).toFixed(1)} games/s), ${summary.balancedGroups}/${summary.groups} balanced groups`);
  console.log(`[match] decisions: ${summary.totalDecisions.toLocaleString()} total, median ` +
    `${summary.decisionsPerGame.p50}/game; generations: median ${summary.generationsPerGame.p50}`);
  console.log(`[match] FR-9 fallbacks: ${summary.fallbacksAfterRejection} after a rejection, ` +
    `${summary.fallbacksAfterThrow} after a responder throw`);

  console.log('[match] R1a - by lineup slot, over balanced groups:');
  for (const slot of summary.bySlot) {
    console.log(`  slot ${slot.slot} ${formatIdentity({name: slot.agent, version: slot.agentVersion}).padEnd(20)} ` +
      `${formatRate(slot.winRate)} wins (${slot.wins}/${slot.games}, ${slot.sharedWins} shared) ` +
      `95% CI [${formatRate(slot.winRateCi95.low)}, ${formatRate(slot.winRateCi95.high)}] ` +
      `placements ${slot.placementCounts.join('/')}`);
  }
  console.log('[match] R1b - by seat, over the same games (seat 0 leads):');
  for (const seat of summary.bySeat) {
    console.log(`  seat ${seat.seat}                      ` +
      `${formatRate(seat.winRate)} wins (${seat.wins}/${seat.games}) ` +
      `95% CI [${formatRate(seat.winRateCi95.low)}, ${formatRate(seat.winRateCi95.high)}] ` +
      `placements ${seat.placementCounts.join('/')}`);
  }

  if (summary.legality !== undefined) {
    const l = summary.legality;
    console.log(`[match] legality mode: ${l.submissions.toLocaleString()} submissions; rejected - responder ` +
      `${l.rejectedResponder}, fallback probe ${l.rejectedFallbackProbe}; responder throws ${l.responderThrows}`);
    for (const cause of report.instrumentation?.causes ?? []) {
      console.log(`  ${String(cause.count).padStart(7)}  ${cause.source} :: ${cause.decisionType} :: ${cause.errorClass}: ${cause.signature}`);
    }
  }

  for (const game of report.games.filter((g) => !g.completed)) {
    console.error(`[match] FAILED group=${game.groupIndex} permutation=${game.permutationIndex} ` +
      `engineSeed=${game.engineSeed}: ${game.failure?.errorClass}: ${game.failure?.message}`);
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function formatRate(rate: number): string {
  return Number.isNaN(rate) ? '  n/a' : `${(rate * 100).toFixed(1)}%`;
}

/**
 * Where the artifact goes when `--out` was not given. `summary`/`trace` runs write nothing - most
 * of them are ad-hoc and an artifact nobody asked for is one more file in `git status`. A `moves`
 * run always writes, into `agent/runs/` (§4.7), because it is producing a large sidecar anyway and
 * the artifact that indexes it should sit beside it rather than nowhere.
 */
function resolveOut(args: ParsedMatchArgs, spec: ResolvedMatchSpec): string | undefined {
  const runId = args.runId ?? defaultRunId(spec);
  if (args.out !== undefined) {
    return resolveOutputPath(args.out, args.capture.historyTier);
  }
  return args.capture.historyTier === 'moves' ?
    path.join(defaultOutputDir('moves'), `${runId}.json`) :
    undefined;
}

export async function runFromArgs(args: ParsedMatchArgs): Promise<void> {
  if (args.listAgents) {
    console.log(describeAgents());
    return;
  }

  const spec = resolveMatchSpec(args.spec);
  const configs = buildMatchConfigs(spec);

  if (args.roundedFrom !== undefined) {
    console.log(`[match] --games ${args.roundedFrom} rounded up to ${plural(spec.groups, 'pairing group')} = ` +
      `${spec.games} games: a partly-played group is not a balanced sample (§4.1).`);
  }

  if (args.list) {
    for (const config of configs) {
      console.log(JSON.stringify(config));
    }
    return;
  }

  ensureHeadlessEngine();
  const lineup = spec.lineup.map(formatIdentity).join(' vs ');
  console.log(`[match] ${lineup} at ${spec.players}p: ${plural(spec.groups, 'pairing group')} x ` +
    `${spec.permutationsPerGroup} permutations = ${spec.games} games, single process` +
    `${args.capture.legality ? ', legality mode' : ''}` +
    `${args.capture.historyTier === 'summary' ? '' : `, history tier '${args.capture.historyTier}'`}.`);

  const started = Date.now();
  const report = await runMatchConfigs(configs, spec, {
    runId: args.runId,
    capture: args.capture,
    yieldEvery: args.yieldEvery,
    // Silenced for any run big enough to be buried by it (H7); that also silences `console.log`,
    // so progress goes straight to stdout.
    silenceRoutineLogs: !args.verboseLogs && configs.length >= 100,
    onProgress: (completed, total) => {
      if (completed % args.progressEvery === 0) {
        const rate = completed / ((Date.now() - started) / 1000);
        process.stdout.write(`[match] ${completed}/${total} games (${rate.toFixed(1)} games/s)\n`);
      }
    },
  });

  reportSummary(report);

  const out = resolveOut(args, spec);
  if (out !== undefined) {
    saveMatchArtifact(out, report);
    console.log(`[match] wrote the run artifact to ${out}`);
  }

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  await runFromArgs(parseMatchArgs(process.argv.slice(2)));
}

if (require.main === module) {
  void main();
}
