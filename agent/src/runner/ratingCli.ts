/**
 * CLI for the rating pipeline (SRS FR-14; Milestone 2 bullet 3). The criteria it produces evidence
 * for - P1-P9 - are pre-committed in agent/docs/Milestone2_Bullet3_Prompts.md §5.
 *
 *   The pooled report over this bullet's corpus, written to agent/docs/data/:
 *     npm run rate -- report docs/data/rating_corpus_2p.json docs/data/rating_corpus_3p.json --out rating_report.json
 *
 *   The design effect and ICC on a corpus - criterion P4a's table:
 *     npm run rate -- design-effect docs/data/match_runner_validation.json
 *
 *   How many games a claim needs, and what a fixed budget can resolve (§2.5):
 *     npm run rate -- power --detect 0.55 --null 0.5 --deff 1.03
 *     npm run rate -- power --games 1000 --null 0.5 --deff 1.03
 *
 *   The promotion gate (criterion P8), one command, pre-registered and reproducible:
 *     npm run rate -- gate --challenger greedy-1ply@1 --incumbent random-legal@1 \
 *       --preregistered-games 1000 --block gate --start-group 2000 docs/data/rating_corpus_2p.json
 *
 * **The gate is a win rate, never a rating** (§3.4). Every acceptance criterion in the SRS is a
 * rate with a threshold - AC-2, AC-3, AC-5, AC-7 - and not one of them is stated as an Elo. A pool
 * rating borrows strength across the whole comparison graph, so a new agent's rating can move
 * because some *other* pair was played: useful for ranking a ladder, disqualifying for a gate.
 *
 * Follows the arg-parsing style of `matchCli.ts`/`legalityCli.ts`: a switch over `process.argv`,
 * explicit errors on unknown flags, no parsing dependency. {@link RATING_SUBCOMMANDS} is a dispatch
 * table Unit B extends with `elo` and `ladder` (§8) - a new region of this table, following bullet
 * 2's `registry.ts` precedent, rather than a second CLI.
 *
 * Nothing here is a performance measurement (hazard H10). The analysis is arithmetic over committed
 * artifacts; the one number that matters for planning is `power`, which is arithmetic too.
 */
import * as path from 'path';
import {analysisRandom} from '../rating/bootstrap';
import {buildObservationSet, clustersOf, stratify} from '../rating/observations';
import {
  buildRatingReport,
  headToHead,
  intervalGap,
  resolveRatingOutputPath,
  saveRatingReport,
} from '../rating/report';
import {assertBlockAvailable, loadLedger, rangeOf} from '../rating/seedBlocks';
import {
  meanEstimate,
  minimumDetectableRate,
  proportionEstimate,
  requiredGames,
  requiredGroups,
} from '../rating/stats';
import {
  DEFAULT_ANALYSIS_SEED,
  DEFAULT_BOOTSTRAP_REPLICATES,
  Interval,
  ProportionEstimate,
  SEED_BLOCKS,
  SeedBlockName,
  Unestimable,
  isUnestimable,
} from '../rating/types';

// ---------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------

export type FlagKind = 'string' | 'number' | 'boolean';

export type ParsedFlags = {
  values: ReadonlyMap<string, string | number | boolean>;
  /** Everything that was not a flag: artifact paths, in the order given. */
  positional: ReadonlyArray<string>;
};

/**
 * A small shared parser, because every subcommand below takes `<paths...> --flag value` and Unit B's
 * two will too. Unknown flags are an error rather than a silent no-op - a typo'd `--analysis-seed`
 * that fell back to the default would make a report irreproducible in the one way this pipeline
 * exists to prevent.
 */
export function parseFlags(argv: ReadonlyArray<string>, known: Readonly<Record<string, FlagKind>>): ParsedFlags {
  const values = new Map<string, string | number | boolean>();
  const positional: Array<string> = [];

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) {
      positional.push(flag);
      continue;
    }
    const kind = known[flag];
    if (kind === undefined) {
      throw new Error(`Unrecognized argument: ${flag}. Known flags here: ${Object.keys(known).sort().join(', ')}`);
    }
    if (kind === 'boolean') {
      values.set(flag, true);
      continue;
    }
    const raw = argv[++i];
    if (raw === undefined) {
      throw new Error(`${flag} needs a value`);
    }
    if (kind === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new Error(`${flag} must be a number, got '${raw}'`);
      }
      values.set(flag, value);
    } else {
      values.set(flag, raw);
    }
  }

  return {values, positional};
}

function requirePaths(parsed: ParsedFlags, subcommand: string): ReadonlyArray<string> {
  if (parsed.positional.length === 0) {
    throw new Error(`${subcommand} needs at least one match artifact path`);
  }
  return parsed.positional;
}

const COMMON_FLAGS: Readonly<Record<string, FlagKind>> = {
  '--analysis-seed': 'number',
  '--bootstrap-replicates': 'number',
  '--no-bootstrap': 'boolean',
};

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function formatInterval(interval: Interval): string {
  return `[${formatRate(interval.low)}, ${formatRate(interval.high)}]`;
}

/**
 * Prints an estimate, or the reason there is not one. **An unestimable quantity is printed as its
 * reason, never as `NaN`** (hazard H9) - the whole point of the type is that the distinction
 * survives to the reader.
 */
export function formatEstimate(estimate: ProportionEstimate | Unestimable): string {
  if (isUnestimable(estimate)) {
    return `unestimable (${estimate.reason})`;
  }
  const bootstrap = estimate.bootstrapCi95 === undefined ?
    '' :
    ` bootstrap ${formatInterval(estimate.bootstrapCi95)} (gap ${(intervalGap(estimate.ci95, estimate.bootstrapCi95) * 100).toFixed(2)} pp)`;
  return `${formatRate(estimate.rate)} (${estimate.successes}/${estimate.trials}) 95% CI ` +
    `${formatInterval(estimate.ci95)}${bootstrap}`;
}

export function formatDesignEffect(design: {designEffect: number; icc: number; groups: number; meanClusterSize: number; note?: string}): string {
  return `deff ${design.designEffect.toFixed(4)}, ICC ${design.icc.toFixed(4)} ` +
    `(${design.groups} groups x ${design.meanClusterSize.toFixed(2)})${design.note === undefined ? '' : ` [${design.note}]`}`;
}

// ---------------------------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------------------------

function commandReport(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, {...COMMON_FLAGS, '--out': 'string'});
  const paths = requirePaths(parsed, 'report');
  const report = buildRatingReport(paths, {
    analysisSeed: numberFlag(parsed, '--analysis-seed', DEFAULT_ANALYSIS_SEED),
    bootstrapReplicates: numberFlag(parsed, '--bootstrap-replicates', DEFAULT_BOOTSTRAP_REPLICATES),
    skipBootstrap: parsed.values.get('--no-bootstrap') === true,
  });

  console.log(`[rate] analysis seed ${report.header.analysisSeed}, ` +
    `${report.header.bootstrapReplicates} bootstrap replicates, ` +
    `Engine pin ${report.header.pooledProvenance.engineCommit.slice(0, 9)}`);
  for (const input of report.header.inputs) {
    console.log(`[rate]   ${input.path}${input.location === '' ? '' : ` (${input.location})`} ` +
      `${input.players}p ${input.runId} groups ${input.startGroup}-${input.startGroup + input.groups - 1} ` +
      `sha256 ${input.sha256.slice(0, 12)}`);
  }
  if (report.exclusions.unbalancedGroups > 0) {
    console.log(`[rate] excluded ${report.exclusions.unbalancedGroups} unbalanced group(s), ` +
      `${report.exclusions.excludedGames} game(s) (§3.1)`);
  }
  if (report.sharedEngineSeeds.length > 0) {
    console.log(`[rate] NOTE: ${report.sharedEngineSeeds.length} engine seed(s) are played by more than one ` +
      'pooled run. Those games share an initial position across artifacts, which the clustering ' +
      'cannot see (different runIds are different clusters).');
  }

  for (const stratum of report.strata) {
    console.log('');
    console.log(`[rate] ${stratum.players}p: ${stratum.games} games in ${stratum.groups} pairing groups`);
    for (const identity of stratum.identities) {
      console.log(`  ${identity.identity.padEnd(20)} win ${formatEstimate(identity.winRate)}`);
      console.log(`  ${' '.repeat(20)} ${identity.seatsPerGame.toFixed(2)} seats/game, null first place ` +
        `${formatRate(identity.nullFirstPlaceRate)}, placements ${identity.placementCounts.join('/')}`);
      if (!isUnestimable(identity.winRate)) {
        console.log(`  ${' '.repeat(20)} ${formatDesignEffect(identity.winRate.design)}`);
      }
      const {overall} = identity.margin;
      console.log(`  ${' '.repeat(20)} margin ${!isUnestimable(overall) ?
        `${overall.mean.toFixed(2)} VP (sd ${overall.sd.toFixed(1)}) 95% CI [${overall.ci95.low.toFixed(2)}, ${overall.ci95.high.toFixed(2)}]` :
        `unestimable (${overall.reason})`}` +
        `${stratum.players > 2 ? ' - NOT comparable across player counts: measured against the max of N-1 opponents (§2.3)' : ''}`);
    }
    // By slot and by seat, cluster-correctly - R1a and R1b restated. Printed after the identity
    // block because for a *self-play* corpus it is the only informative view: one identity holds
    // every seat, so its game-level win rate is 100% by construction (§3.6).
    for (const slot of stratum.bySlot) {
      console.log(`  slot ${slot.slot} ${slot.identity.padEnd(20)} ${formatEstimate(slot.winRate)}`);
    }
    for (const seat of stratum.bySeat) {
      console.log(`  seat ${seat.seat} ${' '.repeat(20)} ${formatEstimate(seat.winRate)}`);
    }
    for (const test of stratum.acFirstPlaceTests) {
      console.log(`  AC-5 ${test.identity.padEnd(18)} ${isUnestimable(test.test) ?
        `unestimable (${test.test.reason})` :
        `observed ${formatRate(test.test.observed)} vs null ${formatRate(test.test.threshold)}, ` +
        `p = ${test.test.pValue.toExponential(2)}, ${test.test.rejected ? 'REJECTS the null' : 'does not reject'}`}`);
    }
  }

  const out = parsed.values.get('--out');
  if (typeof out === 'string') {
    const resolved = resolveRatingOutputPath(out);
    saveRatingReport(resolved, report);
    console.log(`[rate] wrote the rating report to ${resolved}`);
  }
}

/**
 * Criterion P4a's table: the design effect and ICC for the win rate and the VP margin, by player
 * count, on whatever artifacts are named.
 *
 * Reproduces §2.3's pre-registered figures on the committed self-play runs (1.033 / 1.252 / 1.293
 * for the win rate; 1.043 / 1.516 / 1.184 for the margin). **Disagreeing with them is a finding,
 * not a tolerance to widen.**
 */
function commandDesignEffect(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, {'--slot': 'number'});
  const paths = requirePaths(parsed, 'design-effect');
  const slot = numberFlag(parsed, '--slot', 0);
  const set = buildObservationSet(paths);

  console.log(`[rate] design effect by player count, on lineup slot ${slot} (§2.3 / criterion P4a)`);
  for (const players of set.playerCounts) {
    const rows = stratify(set, players).filter((row) => row.slot === slot);
    if (rows.length === 0) {
      console.log(`  ${players}p: no rows for slot ${slot}`);
      continue;
    }
    const clusters = clustersOf(rows);
    const win = proportionEstimate(clusters.map((cluster) => cluster.map((row) => row.win)));
    const margin = meanEstimate(clusters.map((cluster) => cluster.map((row) => row.margin)));
    console.log(`  ${players}p  win rate ${!isUnestimable(win) ? formatRate(win.rate) : 'n/a'}  ` +
      `${!isUnestimable(win) ? formatDesignEffect(win.design) : win.reason}`);
    console.log(`      margin ${!isUnestimable(margin) ?
      `${margin.mean.toFixed(4)} VP (sd ${margin.sd.toFixed(3)})  ${formatDesignEffect(margin.design)}` :
      margin.reason}`);
  }
}

/**
 * The power / sample-size calculator (§2.5).
 *
 * **This is the number that matters for later milestones**, and it is arithmetic rather than
 * compute. From Milestone 4 onward the gate's sample size is a multi-day commitment - at the M4
 * exit-criterion search budget a game is ~230 s, so certifying a 53% improvement is ~4.7 days
 * single-core - so N has to be derived, not inherited from what the last run happened to use.
 * **1,000 games resolves a 4 pp edge and nothing finer.**
 */
function commandPower(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, {
    '--detect': 'number',
    '--games': 'number',
    '--null': 'number',
    '--deff': 'number',
    '--alpha': 'number',
    '--power': 'number',
    '--permutations': 'number',
  });
  const nullRate = numberFlag(parsed, '--null', 0.5);
  const designEffect = numberFlag(parsed, '--deff', 1.03);
  const alpha = numberFlag(parsed, '--alpha', 0.05);
  const power = numberFlag(parsed, '--power', 0.8);
  const permutations = numberFlag(parsed, '--permutations', 2);
  const inputs = {nullRate, designEffect, alpha, power};

  console.log(`[rate] one-sided alpha ${alpha}, power ${power}, null ${formatRate(nullRate)}, ` +
    `design effect ${designEffect} (measured: 1.03 at 2p, 1.25 at 3p, 1.29 at 4p - §2.3)`);

  const detect = parsed.values.get('--detect');
  const games = parsed.values.get('--games');

  if (typeof detect === 'number') {
    const needed = requiredGames({...inputs, rate: detect});
    console.log(typeof needed === 'number' ?
      `[rate] detecting ${formatRate(detect)} needs ${needed} games ` +
      `= ${requiredGroups(needed, permutations)} pairing groups at ${permutations} permutations/group` :
      `[rate] ${needed.reason}`);
  }
  if (typeof games === 'number') {
    const detectable = minimumDetectableRate(games, inputs);
    console.log(typeof detectable === 'number' ?
      `[rate] ${games} games can detect ${formatRate(detectable)} and nothing finer` :
      `[rate] ${detectable.reason}`);
  }
  if (detect === undefined && games === undefined) {
    console.log('[rate] the pre-registered tables of §2.5:');
    for (const rate of [0.65, 0.6, 0.55, 0.53, 0.52]) {
      const needed = requiredGames({...inputs, rate});
      console.log(typeof needed === 'number' ?
        `  detect ${formatRate(rate)}: ${String(needed).padStart(5)} games, ` +
        `${requiredGroups(needed, permutations)} groups` :
        `  detect ${formatRate(rate)}: ${needed.reason}`);
    }
    for (const n of [200, 500, 1_000, 2_000, 6_000]) {
      const detectable = minimumDetectableRate(n, inputs);
      console.log(typeof detectable === 'number' ?
        `  ${String(n).padStart(5)} games: detects ${formatRate(detectable)}` :
        `  ${String(n).padStart(5)} games: ${detectable.reason}`);
    }
  }
}

/**
 * The promotion gate (criterion P8): one command, pre-registered, reproducible, and refusing what
 * it should refuse.
 *
 * Three refusals, each of which exists because the alternative is a verdict that looks identical
 * and means nothing:
 *
 * - **A seed block the ladder records as spent** (§3.8, hazard H7). A gate re-run on its own
 *   sub-range after a change is not a gate.
 * - **A sample smaller than the pre-registered N.** Stopping when the answer looks good is optional
 *   stopping, which criterion P9 measures at a predicted 15-30% false-positive rate against a
 *   nominal 5%.
 * - **A comparison the corpus cannot make** - the two identities never sat at the same table.
 */
function commandGate(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, {
    ...COMMON_FLAGS,
    '--challenger': 'string',
    '--incumbent': 'string',
    '--players': 'number',
    '--threshold': 'number',
    '--preregistered-games': 'number',
    '--block': 'string',
    '--start-group': 'number',
    '--ladder': 'string',
  });
  const paths = requirePaths(parsed, 'gate');
  const challenger = stringFlag(parsed, '--challenger');
  const incumbent = stringFlag(parsed, '--incumbent');
  const players = numberFlag(parsed, '--players', 2) as 2 | 3 | 4;
  const threshold = numberFlag(parsed, '--threshold', 0.5);
  const preregistered = numberFlag(parsed, '--preregistered-games', 0);
  const analysisSeed = numberFlag(parsed, '--analysis-seed', DEFAULT_ANALYSIS_SEED);

  const block = (parsed.values.get('--block') ?? 'gate') as SeedBlockName;
  if (SEED_BLOCKS[block] === undefined) {
    throw new Error(`--block must be one of ${Object.keys(SEED_BLOCKS).join(', ')}, got '${String(block)}'`);
  }

  const set = buildObservationSet(paths);
  const random = analysisRandom(analysisSeed);
  const bootstrap = parsed.values.get('--no-bootstrap') === true ?
    undefined :
    {replicates: numberFlag(parsed, '--bootstrap-replicates', DEFAULT_BOOTSTRAP_REPLICATES), random};

  // The seed block the corpus actually occupies, checked against the ladder before anything is
  // reported - a verdict printed and then retracted is a verdict someone has already screenshotted.
  const groupIndices = stratify(set, players).map((row) => row.groupIndex);
  const ledgerPath = stringFlag(parsed, '--ladder', path.join(defaultLadderDir(), 'ladder.json'));
  const ledger = loadLedger(ledgerPath);
  const observed = groupIndices.length === 0 ?
    rangeOf(numberFlag(parsed, '--start-group', SEED_BLOCKS[block].from), 1) :
    {from: Math.min(...groupIndices), to: Math.max(...groupIndices)};
  assertBlockAvailable(block, observed.from, observed.to, ledger);

  const result = headToHead(set, challenger, incumbent, players, {threshold, bootstrap});
  if (isUnestimable(result)) {
    console.error(`[rate] gate CANNOT RUN: ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[rate] GATE ${challenger} vs ${incumbent} at ${players}p`);
  console.log(`[rate]   test:            one-sided cluster-corrected z test on the head-to-head win rate`);
  console.log(`[rate]   null:            win rate = ${formatRate(threshold)}`);
  console.log(`[rate]   seed block:      ${block} (${SEED_BLOCKS[block].from}-${SEED_BLOCKS[block].to}), ` +
    `run occupies groups ${observed.from}-${observed.to}`);
  console.log(`[rate]   pre-registered:  ${preregistered} games`);
  console.log(`[rate]   observed:        ${result.games} games in ${result.groups} pairing groups`);
  console.log(`[rate]   win rate:        ${formatEstimate(result.winRate)}`);
  console.log(`[rate]   analysis seed:   ${analysisSeed}`);

  if (preregistered > 0 && result.games < preregistered) {
    console.error(`[rate]   VERDICT: NO VERDICT - ${result.games} games is short of the pre-registered ` +
      `${preregistered}. Reporting a result here is optional stopping, which inflates the one-sided ` +
      '5% false-positive rate (criterion P9). Run the remaining games or re-register N.');
    process.exitCode = 1;
    return;
  }
  if (preregistered === 0) {
    console.warn('[rate]   WARNING: no --preregistered-games given, so this run has no pre-registered N ' +
      'and its p-value is not protected against optional stopping (§3.8, hazard H7).');
  }

  if (isUnestimable(result.test)) {
    console.error(`[rate]   VERDICT: NO VERDICT - ${result.test.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[rate]   z:               ${result.test.z.toFixed(4)}`);
  console.log(`[rate]   p-value:         ${result.test.pValue.toExponential(4)} (alpha ${result.test.alpha})`);
  console.log(`[rate]   VERDICT: ${result.test.rejected ? 'PASS' : 'FAIL'} - ` +
    `${result.test.rejected ? 'beats' : 'does not beat'} ${incumbent} with significance`);
  if (!result.test.rejected) {
    process.exitCode = 1;
  }
}

/** Where `ladder.json` lives by default. Unit B owns the file; this only reads it. */
function defaultLadderDir(): string {
  return path.dirname(resolveRatingOutputPath('ladder.json'));
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

export type RatingSubcommand = {
  describe: string;
  run: (argv: ReadonlyArray<string>) => void | Promise<void>;
};

/**
 * The dispatch table. **Unit B adds `elo` and `ladder` here** (§8) rather than writing a second
 * CLI: every subcommand is a thin shell over the module that owns the computation, and a separate
 * entry point would spend its budget re-deriving these argument conventions.
 */
export const RATING_SUBCOMMANDS: Record<string, RatingSubcommand> = {
  report: {
    describe: 'pooled win rates, margins and AC-5 tests over one or more match artifacts',
    run: commandReport,
  },
  'design-effect': {
    describe: "the clustering penalty by player count - criterion P4a's table",
    run: commandDesignEffect,
  },
  power: {
    describe: 'games needed for a claim, and what a fixed budget can resolve (§2.5)',
    run: commandPower,
  },
  gate: {
    describe: 'the promotion gate: a pre-registered one-sided head-to-head test (criterion P8)',
    run: commandGate,
  },
};

function usage(): string {
  const commands = Object.entries(RATING_SUBCOMMANDS)
    .map(([name, command]) => `  ${name.padEnd(16)}${command.describe}`)
    .join('\n');
  return `usage: npm run rate -- <subcommand> [args]\n\n${commands}\n`;
}

export async function runRatingCli(argv: ReadonlyArray<string>): Promise<void> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h') {
    console.log(usage());
    return;
  }
  const subcommand = RATING_SUBCOMMANDS[name];
  if (subcommand === undefined) {
    throw new Error(`Unknown subcommand '${name}'.\n\n${usage()}`);
  }
  await subcommand.run(rest);
}

function numberFlag(parsed: ParsedFlags, flag: string, fallback: number): number {
  const value = parsed.values.get(flag);
  return typeof value === 'number' ? value : fallback;
}

function stringFlag(parsed: ParsedFlags, flag: string, fallback?: string): string {
  const value = parsed.values.get(flag);
  if (typeof value === 'string') {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${flag} is required`);
}

async function main(): Promise<void> {
  await runRatingCli(process.argv.slice(2));
}

if (require.main === module) {
  void main();
}

export {analysisRandom};
