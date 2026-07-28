import {spawn} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {formatIdentity, lookupAgent} from '../agents/registry';
import {CauseTally} from '../legality/types';
import {parseMatchArgs, ParsedMatchArgs} from '../runner/matchCli';
import {defaultOutputDir, resolveOutputPath, saveMatchArtifact} from './artifact';
import {mergeHistoryDetail} from './history';
import {buildMatchConfigs, defaultRunId, resolveMatchSpec} from './pairing';
import {buildMatchHeader, DEFAULT_CAPTURE, MatchCaptureOptions, MatchRunOptions, seatPlayerId, summarizeMatch} from './runner';
import {
  MatchGameConfig,
  MatchGameRecord,
  MatchInstrumentationReport,
  MatchRunReport,
  MatchSeatRecord,
  MatchSpec,
  ResolvedMatchSpec,
} from './types';

/**
 * The process pool: discharges R6 (the pooled artifact is byte-identical to the single-process
 * one) and R7 (the ×8-workers throughput figure `docs/Simulator_Speed_Spike.md` §5 explicitly
 * deferred to this harness) - Milestone 2 bullet 1, Unit C (§4.5).
 *
 * **Child processes, not worker threads** (§4.5's reasons, restated because they are why this
 * file exists in the shape it does): games are fully independent, the per-game payload
 * (`MatchGameConfig`) is small and serializable by design (`pairing.ts`'s own doc comment), and a
 * child process sidesteps every question about the Engine's process-global state (`GameLoader`,
 * `Cache`, the `Database` singleton, and - in legality mode - `SubmissionMonitor`'s
 * `Player.prototype.process` wrap) that a shared-heap worker would raise. `determinism/childReplay.ts`
 * is the working precedent for spawning a fresh process and getting a typed result back; this module
 * follows the same "write the result to a temp file, never parse stdout" discipline, because the
 * Engine itself logs to stdout during play (module-load-time logging, `Cache.mark`, the eviction
 * line hazard H7 silences) and that output is unavoidably interleaved across concurrent children.
 *
 * **Sharding is by whole pairing group, never by game.** A group split across two workers would
 * still be correct - nothing about a game depends on its sibling permutations - but it would lose
 * the "one group, one seed, adjacent in the output" property that makes the artifact readable next
 * to the seed that produced it (§4.5). {@link shardConfigs} enforces this: it partitions the
 * spec's `groups` into `workers` contiguous ranges and slices the (group-major-ordered) config
 * list along those boundaries, so concatenating the shards' results in worker order reproduces
 * exactly {@link buildMatchConfigs}'s own order.
 *
 * **R6 first, R7 second** (§4.5's own instruction): a pool that is fast and subtly different from
 * the single-process path is worse than no pool, because every downstream number would then depend
 * on which path produced it. {@link runMatchPool} is built to make that comparison mechanical: it
 * produces the exact same {@link MatchRunReport} shape as `runner.ts`'s `runMatch`/`runMatchConfigs`
 * - same header (via the same {@link buildMatchHeader}), same summary (via the same
 * `summarizeMatch`, run once over the *concatenated* game rows rather than merged as an already-
 * summarized statistic, because win rates and percentiles are non-linear and cannot be merged any
 * other way), same games array, same optional `instrumentation`. `artifact.ts`'s `reportsMatch`
 * (already written to compare two runs modulo the declared timing fields) is therefore the R6
 * check as-is; nothing pool-specific needed adding to it.
 *
 * **Legality mode across the pool (§4.6).** `SubmissionMonitor` installs global state on
 * `Player.prototype`, so each child installs and uninstalls its own - `runMatchConfigs` already
 * does this per call via `resolveInstrument`, so a child needs no special-casing to run in legality
 * mode. What the pool must do is merge the *run-level* instrumentation report the driver's
 * `onFallback` counters can't provide: {@link mergeInstrumentation} sums each child's per-signature
 * cause tallies and keeps one representative message, exactly the semantics §4.6 states for Unit B
 * and directs this unit to implement rather than invent. (Per-game `MatchLegalityCounters` need no
 * separate merge: they live on each game row, and `summarizeMatch`'s `summarizeLegality` already
 * sums them correctly once the rows are concatenated.)
 *
 * **A child that dies mid-shard does not abort the run** - the same H8 discipline the single-process
 * loop applies to one game, applied here to one shard. A shard whose child exits without writing a
 * result (a crash, not a caught game failure - `playMatchGame` already catches per-game errors
 * inside the child) becomes a run of synthetic {@link MatchGameRecord}s, one per config in the
 * shard, each `completed: false` with `failure.errorClass === 'ChildProcessFailure'` and full seat
 * identity - a failure with no attribution is a failure nobody can act on, same reasoning as
 * `runner.ts`'s own per-game catch path, which this mirrors rather than reuses (that path is
 * private to `runner.ts`; duplicating ~10 lines here is cheaper than exporting a function whose
 * only other caller would be this one).
 */

// ---------------------------------------------------------------------------------------------
// Sharding
// ---------------------------------------------------------------------------------------------

/** `total` split into `buckets` parts differing by at most 1, largest first. Always sums to `total`. */
function distribute(total: number, buckets: number): ReadonlyArray<number> {
  const base = Math.floor(total / buckets);
  let remainder = total % buckets;
  return Array.from({length: buckets}, () => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) {
      remainder--;
    }
    return base + extra;
  });
}

/**
 * Splits `configs` (in {@link buildMatchConfigs}'s group-major order) into at most `workers`
 * contiguous, non-empty shards, each a whole number of groups. Fewer than `workers` shards come
 * back when there are fewer groups than requested workers - one worker per group is the most
 * parallelism a group-sharded pool can offer, and an empty shard would just be a child process that
 * plays nothing.
 */
export function shardConfigs(
  configs: ReadonlyArray<MatchGameConfig>,
  groups: number,
  permutationsPerGroup: number,
  workers: number,
): ReadonlyArray<ReadonlyArray<MatchGameConfig>> {
  const groupCounts = distribute(groups, Math.max(1, Math.min(workers, groups)));
  const shards: Array<ReadonlyArray<MatchGameConfig>> = [];
  let offset = 0;
  for (const count of groupCounts) {
    if (count === 0) {
      continue;
    }
    const gamesInShard = count * permutationsPerGroup;
    shards.push(configs.slice(offset, offset + gamesInShard));
    offset += gamesInShard;
  }
  return shards;
}

// ---------------------------------------------------------------------------------------------
// Merging instrumentation (§4.6's merge semantics, implemented rather than invented)
// ---------------------------------------------------------------------------------------------

/**
 * Merges each child's {@link MatchInstrumentationReport}: cause tallies sum by signature and keep
 * one representative message; `detail` is delegated to {@link mergeHistoryDetail}, which owns that
 * field's shape (`match/history.ts`).
 *
 * This unit deliberately does not merge `detail` itself - it is Unit B's escape hatch and a merge
 * rule guessed at here would be a wrong number rather than a missing one. It originally preserved
 * each child's block under `perWorker` for that reason, which was right in the absence of a rule and
 * wrong once R6 was actually measured: it made the pooled artifact structurally different from the
 * single-process artifact for **every** instrumented run (Unit D's validation battery, criterion
 * R6). `mergeHistoryDetail` is the missing half of the seam and falls back to the same `perWorker`
 * shape whenever it has no rule for what it is given.
 */
export function mergeInstrumentation(
  reports: ReadonlyArray<MatchInstrumentationReport | undefined>,
): MatchInstrumentationReport | undefined {
  const present = reports.filter((report): report is MatchInstrumentationReport => report !== undefined);
  if (present.length === 0) {
    return undefined;
  }

  const causesByKey = new Map<string, CauseTally>();
  for (const report of present) {
    for (const cause of report.causes ?? []) {
      const key = `${cause.source}|${cause.decisionType}|${cause.errorClass}|${cause.signature}`;
      const existing = causesByKey.get(key);
      if (existing !== undefined) {
        existing.count += cause.count;
      } else {
        causesByKey.set(key, {...cause});
      }
    }
  }
  const causes = [...causesByKey.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  const details = present.map((report) => report.detail).filter((detail): detail is Record<string, unknown> => detail !== undefined);

  return {
    ...(causes.length > 0 ? {causes} : {}),
    ...(details.length > 0 ? {detail: mergeHistoryDetail(details)} : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Spawning a child
// ---------------------------------------------------------------------------------------------

const WORKER_IN_FLAG = '--worker-in';
const WORKER_OUT_FLAG = '--worker-out';

/** `tsx`'s package.json doesn't export `./dist/cli.mjs` directly - resolved the same way `determinism/childReplay.ts` does. */
function tsxCliPath(): string {
  return path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
}

/**
 * How to invoke `poolChild`. Under `tsx` (dev, and every non-throughput test run) this file's own
 * `__filename` ends in `.ts`, so the child needs `tsx`'s CLI in front of it, same as
 * `childReplay.ts`. Under the compiled build (hazard H5 - the only build a throughput number may
 * come from) both this file and its sibling are plain `.js`, and `poolChild.js` runs directly under
 * `node`.
 */
function childCommand(): {command: string; args: ReadonlyArray<string>} {
  const compiled = !__filename.endsWith('.ts');
  const childPath = path.join(__dirname, compiled ? 'poolChild.js' : 'poolChild.ts');
  return compiled ?
    {command: process.execPath, args: [childPath]} :
    {command: process.execPath, args: [tsxCliPath(), childPath]};
}

/** What a worker's input file carries - everything a shard needs to reproduce `runMatchConfigs`'s own behaviour. */
export type WorkerInput = {
  configs: ReadonlyArray<MatchGameConfig>;
  spec: ResolvedMatchSpec;
  capture: MatchCaptureOptions;
  yieldEvery: number;
  silenceRoutineLogs: boolean;
};

/** What a worker's output file carries back. */
export type WorkerOutput = {
  games: ReadonlyArray<MatchGameRecord>;
  instrumentation?: MatchInstrumentationReport;
};

type ShardResult = WorkerOutput;

/** Seat identities for a config whose child process died before producing any record at all. Mirrors `runner.ts`'s own failure-path seat construction. */
function seatsForShardFailure(config: MatchGameConfig): ReadonlyArray<MatchSeatRecord> {
  return config.seating.map((slot, seat) => ({
    seat,
    slot,
    playerId: seatPlayerId(seat),
    agent: config.lineup[slot],
    agentVersion: lookupAgent(config.lineup[slot]).version,
    agentSeed: config.agentSeeds[slot],
  }));
}

/** Exported for `pool.spec.ts`'s direct check of the H8-at-shard-level failure shape, without needing to kill a real child. */
export function syntheticFailureRecord(config: MatchGameConfig, message: string): MatchGameRecord {
  return {
    groupIndex: config.groupIndex,
    permutationIndex: config.permutationIndex,
    engineSeed: config.engineSeed,
    seating: config.seating,
    completed: false,
    failure: {errorClass: 'ChildProcessFailure', message},
    generation: 0,
    decisions: 0,
    fallbacksAfterRejection: 0,
    fallbacksAfterThrow: 0,
    seats: seatsForShardFailure(config),
    claimedMilestones: [],
    fundedAwards: [],
    durationMs: 0,
  };
}

/**
 * Runs one shard in a fresh child process and resolves with its result - never rejects, because a
 * dead child must not abort the pool (H8, applied at the shard level). A shard whose child exits
 * without writing a result becomes a run of {@link syntheticFailureRecord}s, one per config.
 */
function runShard(
  shard: ReadonlyArray<MatchGameConfig>,
  spec: ResolvedMatchSpec,
  capture: MatchCaptureOptions,
  options: {yieldEvery: number; silenceRoutineLogs: boolean; env: NodeJS.ProcessEnv},
): Promise<ShardResult> {
  return new Promise((resolve) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-match-pool-'));
    const inPath = path.join(tmpDir, 'in.json');
    const outPath = path.join(tmpDir, 'out.json');
    const errPath = path.join(tmpDir, 'out.error');
    const input: WorkerInput = {configs: shard, spec, capture, yieldEvery: options.yieldEvery, silenceRoutineLogs: options.silenceRoutineLogs};
    fs.writeFileSync(inPath, JSON.stringify(input));

    const {command, args} = childCommand();
    const child = spawn(command, [...args, WORKER_IN_FLAG, inPath, WORKER_OUT_FLAG, outPath], {
      env: options.env,
      // Never parse stdout (see the module doc): the Engine logs to it during play, and concurrent
      // children's output would interleave. `inherit` lets a genuine crash trace still reach the
      // operator's terminal for diagnosis.
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const finish = (): void => {
      try {
        if (fs.existsSync(outPath)) {
          resolve(JSON.parse(fs.readFileSync(outPath, 'utf8')) as WorkerOutput);
          return;
        }
        const message = fs.existsSync(errPath) ?
          fs.readFileSync(errPath, 'utf8') :
          `child process exited without producing a result (shard of ${shard.length} game(s), groups ` +
          `${shard[0]?.groupIndex}-${shard[shard.length - 1]?.groupIndex})`;
        resolve({games: shard.map((config) => syntheticFailureRecord(config, message))});
      } finally {
        fs.rmSync(tmpDir, {recursive: true, force: true});
      }
    };

    child.on('exit', finish);
    child.on('error', (error) => {
      fs.writeFileSync(errPath, String(error.stack ?? error));
      finish();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------------------------

export type PoolOptions = MatchRunOptions & {
  /** Number of child processes. Clamped down to the number of groups (one group is the smallest unit of parallelism). */
  workers: number;
  env?: NodeJS.ProcessEnv;
};

/**
 * Plays a full match specification across a pool of child processes and returns the exact same
 * {@link MatchRunReport} shape `runMatch`/`runMatchConfigs` would for the identical specification
 * played single-process - see the module doc's R6 paragraph for why that is true by construction
 * rather than by a separate merge of already-summarized numbers.
 */
export async function runMatchPool(spec: MatchSpec, options: PoolOptions): Promise<MatchRunReport> {
  const resolved = resolveMatchSpec(spec);
  const configs = buildMatchConfigs(resolved);
  const capture = options.capture ?? DEFAULT_CAPTURE;
  const shards = shardConfigs(configs, resolved.groups, resolved.permutationsPerGroup, options.workers);

  const runStart = Date.now();
  const shardOptions = {
    yieldEvery: options.yieldEvery ?? 1,
    silenceRoutineLogs: options.silenceRoutineLogs ?? configs.length >= 100,
    env: options.env ?? process.env,
  };
  const results = await Promise.all(shards.map((shard) => runShard(shard, resolved, capture, shardOptions)));

  const games = results.flatMap((result) => result.games);
  const instrumentation = mergeInstrumentation(results.map((result) => result.instrumentation));

  return {
    header: buildMatchHeader(resolved, {runId: options.runId, capture}),
    summary: summarizeMatch(games, resolved, {wallClockMs: Date.now() - runStart}),
    games,
    ...(instrumentation === undefined ? {} : {instrumentation}),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI (`npm run match:pool`, registered by Unit A - see `agent/package.json`)
// ---------------------------------------------------------------------------------------------

const DEFAULT_WORKERS = os.cpus().length;

/** Pulls `--workers <n>` out of argv before handing the rest to `matchCli`'s `parseMatchArgs`, so this file parses one flag rather than a second, near-identical arg language. */
function extractWorkers(argv: ReadonlyArray<string>): {workers: number; rest: ReadonlyArray<string>} {
  const index = argv.indexOf('--workers');
  if (index === -1) {
    return {workers: DEFAULT_WORKERS, rest: argv};
  }
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--workers must be a positive integer, got '${argv[index + 1]}'`);
  }
  return {workers: value, rest: [...argv.slice(0, index), ...argv.slice(index + 2)]};
}

function reportPoolSummary(report: MatchRunReport, workers: number): void {
  const {summary, header} = report;
  const seconds = summary.timing.wallClockMs / 1000;
  console.log('');
  console.log(`[match:pool] ${header.runId} (${workers} worker(s))`);
  console.log(`[match:pool] ${summary.completed}/${summary.games} games completed in ${seconds.toFixed(1)}s ` +
    `(${(summary.games / seconds).toFixed(1)} games/s), ${summary.balancedGroups}/${summary.groups} balanced groups`);
  for (const slot of summary.bySlot) {
    const rate = Number.isNaN(slot.winRate) ? 'n/a' : `${(slot.winRate * 100).toFixed(1)}%`;
    console.log(`  slot ${slot.slot} ${formatIdentity({name: slot.agent, version: slot.agentVersion}).padEnd(20)} ${rate} wins (${slot.wins}/${slot.games})`);
  }
  if (summary.legality !== undefined) {
    const l = summary.legality;
    console.log(`[match:pool] legality mode: ${l.submissions.toLocaleString()} submissions; rejected - responder ` +
      `${l.rejectedResponder}, fallback probe ${l.rejectedFallbackProbe}; responder throws ${l.responderThrows}`);
  }
  for (const game of report.games.filter((g) => !g.completed)) {
    console.error(`[match:pool] FAILED group=${game.groupIndex} permutation=${game.permutationIndex} ` +
      `engineSeed=${game.engineSeed}: ${game.failure?.errorClass}: ${game.failure?.message}`);
  }
}

function resolveOut(args: ParsedMatchArgs, spec: ResolvedMatchSpec): string | undefined {
  const runId = args.runId ?? defaultRunId(spec);
  if (args.out !== undefined) {
    return resolveOutputPath(args.out, args.capture.historyTier);
  }
  return args.capture.historyTier === 'moves' ?
    path.join(defaultOutputDir('moves'), `${runId}.json`) :
    undefined;
}

async function main(): Promise<void> {
  const {workers, rest} = extractWorkers(process.argv.slice(2));
  const args = parseMatchArgs(rest);

  if (args.listAgents) {
    // Same listing `matchCli.ts` prints for `--list-agents`; not worth importing its private
    // formatter for one line, and this keeps the pool CLI independently readable.
    const {agentNames, AGENTS} = await import('../agents/registry');
    console.log(agentNames().map((name) => `  ${formatIdentity(AGENTS[name]).padEnd(20)}${AGENTS[name].description}`).join('\n'));
    return;
  }

  const spec = resolveMatchSpec(args.spec);
  if (args.roundedFrom !== undefined) {
    console.log(`[match:pool] --games ${args.roundedFrom} rounded up to ${spec.groups} pairing group(s) = ${spec.games} games.`);
  }
  if (args.list) {
    for (const config of buildMatchConfigs(spec)) {
      console.log(JSON.stringify(config));
    }
    return;
  }

  const effectiveWorkers = Math.max(1, Math.min(workers, spec.groups));
  const lineup = spec.lineup.map(formatIdentity).join(' vs ');
  console.log(`[match:pool] ${lineup} at ${spec.players}p: ${spec.groups} pairing group(s) x ` +
    `${spec.permutationsPerGroup} permutations = ${spec.games} games across ${effectiveWorkers} worker(s)` +
    `${args.capture.legality ? ', legality mode' : ''}` +
    `${args.capture.historyTier === 'summary' ? '' : `, history tier '${args.capture.historyTier}'`}.`);

  const report = await runMatchPool(args.spec, {
    workers,
    runId: args.runId,
    capture: args.capture,
    yieldEvery: args.yieldEvery,
    // Same H7 threshold `matchCli.ts` uses, `--verbose-logs` overriding it the same way.
    silenceRoutineLogs: !args.verboseLogs && spec.games >= 100,
  });

  reportPoolSummary(report, effectiveWorkers);

  const out = resolveOut(args, spec);
  if (out !== undefined) {
    saveMatchArtifact(out, report);
    console.log(`[match:pool] wrote the run artifact to ${out}`);
  }

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
