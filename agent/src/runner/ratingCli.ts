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
 *   The ratings (Unit B), on the Elo scale with random-legal@1 anchored at 0:
 *     npm run rate -- elo docs/data/rating_corpus_2p.json
 *
 *   The ladder: build it, read it, allocate a gate's seeds, or re-derive it from its own inputs:
 *     npm run ladder -- build docs/data/rating_corpus_2p.json docs/data/rating_corpus_3p.json --out ladder.json
 *     npm run ladder -- show --ladder docs/data/ladder.json
 *     npm run ladder -- allocate --block gate --groups 500 --spent-by m3-promotion --out ladder.json
 *     npm run ladder -- verify --ladder docs/data/ladder.json
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
import {
  DEFAULT_PRIOR_SIGMA,
  EloBounds,
  PoolRating,
  describePool,
  eloFromWinRate,
} from '../rating/bradleyTerry';
import {
  AllocationRequest,
  DEFAULT_LINEAGE,
  Ladder,
  LadderEntry,
  RelativeRating,
  allocate,
  buildLadder,
  emptyLadder,
  loadLadder,
  rateStratum,
  rederiveLadder,
  saveLadder,
} from '../rating/ladder';
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
  SMALL_SAMPLE_FLOOR,
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

export /**
 * The small-sample caveat, printed rather than left in a doc comment.
 *
 * Criterion P3 measured the calculator against the shipped test at the sample sizes the calculator
 * itself prescribes: agreement to under 1.7 pp from n = 158 up, and a 2.4 pp overstatement at
 * n = 70. The cause is the normal approximation meeting a discrete binomial, and it costs power
 * rather than size. A reader planning a 35-group run is exactly the reader who will not go looking
 * for that, so the number carries its own caveat (`stats.ts`'s {@link SMALL_SAMPLE_FLOOR}).
 */
function warnSmallSample(games: number): void {
  if (games <= SMALL_SAMPLE_FLOOR) {
    console.log(`[rate] caution: at ${games} games this is a normal approximation at a scale where ` +
      'the binomial is too discrete for it. Measured (P3): it overstates power by 2.4 pp at n = 70 ' +
      'and by under 1.7 pp from n = 158 up. Treat the figure as a floor.');
  }
}

function formatRate(rate: number): string {
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

export function formatDesignEffect(design: {designEffect: number; appliedDesignEffect: number; icc: number; groups: number; meanClusterSize: number; note?: string}): string {
  // The estimate is what gets printed; the floor is called out only when it bit, because a reader
  // who sees `deff 0.9898 (applied 1.0000)` learns something and a reader who sees
  // `deff 1.2518 (applied 1.2518)` on every other line learns to skip the parenthesis.
  const floored = design.appliedDesignEffect > design.designEffect ?
    ` (applied ${design.appliedDesignEffect.toFixed(4)} - floored at 1, §3.1)` : '';
  return `deff ${design.designEffect.toFixed(4)}${floored}, ICC ${design.icc.toFixed(4)} ` +
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
    if (typeof needed === 'number') {
      warnSmallSample(needed);
    }
  }
  if (typeof games === 'number') {
    const detectable = minimumDetectableRate(games, inputs);
    console.log(typeof detectable === 'number' ?
      `[rate] ${games} games can detect ${formatRate(detectable)} and nothing finer` :
      `[rate] ${detectable.reason}`);
    warnSmallSample(games);
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
    '--claim': 'string',
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
  // The claim must match the `--spent-by` this range was allocated under, or the ledger refuses it
  // as somebody else's range (§3.8, and the end-to-end defect recorded in `seedBlocks.ts`).
  const claimFlag = parsed.values.get('--claim');
  assertBlockAvailable(block, observed.from, observed.to, ledger, console.warn,
    typeof claimFlag === 'string' ? claimFlag : undefined);

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

/** Where `ladder.json` lives by default. */
function defaultLadderDir(): string {
  return path.dirname(resolveRatingOutputPath('ladder.json'));
}

function defaultLadderPath(): string {
  return path.join(defaultLadderDir(), 'ladder.json');
}

// ---------------------------------------------------------------------------------------------
// Unit B: the ratings and the ladder (§8 - a new region of this dispatch table, not a second CLI)
// ---------------------------------------------------------------------------------------------

const RATING_FLAGS: Readonly<Record<string, FlagKind>> = {
  ...COMMON_FLAGS,
  '--prior-sigma': 'number',
  '--players': 'number',
};

function formatBounds(bounds: EloBounds): string {
  // An unbounded end prints as the word, never as a number and never as `Infinity` (H3, P5). The
  // whole failure this guards against is a reader seeing a plausible figure where the data has
  // nothing to say.
  const low = bounds.low === null ? 'unbounded' : bounds.low.toFixed(0);
  const high = bounds.high === null ? 'unbounded' : bounds.high.toFixed(0);
  return `[${low}, ${high}]`;
}

function printPool(pool: PoolRating): void {
  console.log(`[rate] ${pool.players}p ${pool.model}: ${pool.games} games in ${pool.groups} pairing groups, ` +
    `prior sigma ${pool.priorSigma} logits (${(pool.priorSigma * 400 / Math.LN10).toFixed(0)} Elo)`);
  if (pool.selfMatchGamesExcluded > 0) {
    console.log(`[rate]   excluded ${pool.selfMatchGamesExcluded} self-match game(s): a lineup of one identity is ` +
      '50/50 by symmetry and carries no information about relative strength (§3.6)');
  }
  if (!pool.converged) {
    console.warn('[rate]   WARNING: the fit did not converge; treat every number below as provisional');
  }
  if (!pool.connected) {
    console.warn(`[rate]   WARNING: the comparison graph has ${pool.components.length} components. There is no ` +
      'single scale across them - each table below is anchored separately and the numbers in one ' +
      'may not be compared with the numbers in another (§3.4).');
  }
  for (const component of pool.components) {
    if (pool.components.length > 1) {
      console.log(`[rate]   component ${component.index}: ${component.identities.join(', ')}`);
    }
    if (!component.usesPreferredAnchor) {
      console.log(`[rate]   anchored at ${component.anchor} (random-legal@1 is not in this component)`);
    }
    for (const rating of component.ratings) {
      console.log(`  ${rating.identity.padEnd(20)} ${rating.elo.toFixed(0).padStart(6)} Elo  95% ` +
        `${formatBounds(rating.ci95)}  shrinkage ${(rating.shrinkage * 100).toFixed(1)}%  ` +
        `${rating.games} games`);
      if (rating.ci95.unbounded !== undefined) {
        console.log(`  ${' '.repeat(20)} ${rating.ci95.unbounded.reason}`);
      }
    }
  }
  console.log(`[rate]   ${pool.effectiveParameters.toFixed(2)} of ${
    pool.components.reduce((total, component) => total + component.identities.length, 0)
  } parameters are pinned by data rather than by the prior`);
  if (pool.bootstrap === undefined) {
    console.log('[rate]   no bootstrap was run, so no interval exists. §3.3 takes rating intervals from the ' +
      'cluster bootstrap and deliberately not from the Hessian: the near-separated regime this pool ' +
      'occupies is where the asymptotic normal approximation is worst.');
  } else {
    console.log(`[rate]   ${pool.bootstrap.usable}/${pool.bootstrap.replicates} bootstrap resamples usable`);
  }
}

/**
 * The ratings for a pool (§3.3), on the Elo scale with `random-legal@1` at 0.
 *
 * **With two agents this is the win rate in different units** (§2.4, §3.4) and carries no additional
 * information - the command says so in its own output, next to the number, because the temptation to
 * read a rating as independent evidence is exactly what §3.4 is written against. The rating earns
 * its keep only as the pool grows.
 */
function commandElo(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, RATING_FLAGS);
  const paths = requirePaths(parsed, 'elo');
  const analysisSeed = numberFlag(parsed, '--analysis-seed', DEFAULT_ANALYSIS_SEED);
  const replicates = numberFlag(parsed, '--bootstrap-replicates', DEFAULT_BOOTSTRAP_REPLICATES);
  const priorSigma = numberFlag(parsed, '--prior-sigma', DEFAULT_PRIOR_SIGMA);
  const random = parsed.values.get('--no-bootstrap') === true ? undefined : analysisRandom(analysisSeed);

  const set = buildObservationSet([...paths].sort());
  const wanted = parsed.values.get('--players');
  const playerCounts = typeof wanted === 'number' ?
    set.playerCounts.filter((players) => players === wanted) :
    set.playerCounts;

  console.log(`[rate] analysis seed ${analysisSeed}, ${random === undefined ? 0 : replicates} bootstrap replicates, ` +
    `Engine pin ${set.sources[0].engineCommit.slice(0, 9)}`);

  for (const players of playerCounts) {
    console.log('');
    const fit = rateStratum(stratify(set, players), players, {priorSigma, replicates, random});
    const pool = describePool(fit);
    printPool(pool);

    // **The note §3.4 requires, printed next to the number rather than left to the write-up.** With
    // two identities *at 2p* a pool rating adds nothing: it is the head-to-head win rate through
    // `-400 log10(1/p - 1)` and back. Printing the win-rate-derived figure beside the fitted one
    // makes that checkable rather than assertable - they agree to within the cluster correction and
    // the prior, and if they ever did not, one of the two would be wrong.
    //
    // **The `players === 2` guard is load-bearing and was added after the note fired at 3p.** There
    // the identity-level win rate is not a two-agent quantity at all: `greedy-1ply@1` holds two of
    // three seats in this bullet's 3p corpus, so its 99.5% "win rate against random-legal@1" is
    // mostly seat arithmetic (hazard H2) and maps to 920 Elo against a fitted 603. The two numbers
    // are not estimates of the same thing, and printing them side by side under the word
    // "monotonically transformed" would invite exactly the reading §3.4 exists to prevent.
    if (players === 2 && fit.identities.length === 2 && pool.components.length === 1) {
      const {anchor} = pool.components[0];
      const subject = fit.identities.find((identity) => identity !== anchor) as string;
      const observed = headToHead(set, subject, anchor, players);
      const implied = isUnestimable(observed) || isUnestimable(observed.winRate) ?
        null :
        eloFromWinRate(observed.winRate.rate);
      console.log(`[rate]   NOTE: with two identities the Elo *is* the head-to-head win rate, monotonically ` +
        `transformed, and carries no additional information (§2.4, §3.4).${implied === null ? '' :
          ` ${subject}'s raw win rate against ${anchor} maps to ${implied.toFixed(0)} Elo.`} The fitted ` +
        'figure differs from it only by the cluster correction and the prior. A rating earns its ' +
        'keep as the pool grows, and a promotion is never argued from one.');
    }
  }
}

function formatRelative(rating: RelativeRating | Unestimable): string {
  return isUnestimable(rating) ?
    `unestimable (${rating.reason})` :
    `${rating.elo.toFixed(0)} Elo vs ${rating.reference}, 95% ${formatBounds(rating.ci95)}`;
}

function printLadder(ladder: Ladder): void {
  console.log(`[ladder] version ${ladder.header.ladderVersion}, anchor ${ladder.header.anchor}, ` +
    `prior sigma ${ladder.header.priorSigma}, analysis seed ${ladder.header.analysisSeed}`);
  console.log(`[ladder] promotion chain: ${ladder.header.lineage.join(' -> ')}`);
  for (const input of ladder.header.inputs) {
    console.log(`[ladder]   ${input.path} ${input.players}p ${input.runId} ` +
      `groups ${input.startGroup}-${input.startGroup + input.groups - 1} sha256 ${input.sha256.slice(0, 12)}`);
  }
  for (const stratum of ladder.strata) {
    console.log('');
    printPool(stratum.pool);
    for (const entry of stratum.entries) {
      printEntry(entry);
    }
  }
  console.log('');
  console.log(`[ladder] seed-block ledger: ${ladder.ledger.allocations.length} allocation(s) (§3.8)`);
  for (const allocation of ladder.ledger.allocations) {
    console.log(`[ladder]   ${allocation.block.padEnd(12)} ${String(allocation.from).padStart(5)}-` +
      `${String(allocation.to).padEnd(5)} spent by '${allocation.spentBy}' on ${allocation.recordedAt}` +
      `${allocation.preregisteredGames === undefined ? '' : `, N = ${allocation.preregisteredGames} pre-registered`}`);
  }
}

function printEntry(entry: LadderEntry): void {
  console.log(`  ${entry.identity.padEnd(20)} anchor ${formatRelative(entry.anchor)}`);
  console.log(`  ${' '.repeat(20)} predecessor ${formatRelative(entry.predecessor)}`);
  // Printed last and deliberately: this is the number a promotion is decided on. Every acceptance
  // criterion in the SRS is a rate with a threshold, and none is stated as an Elo (§3.4).
  const gate = entry.predecessorHeadToHead;
  console.log(`  ${' '.repeat(20)} GATE STATISTIC (a win rate, never the Elo - §3.4): ${
    isUnestimable(gate) ? `unestimable (${gate.reason})` : formatEstimate(gate.winRate)}`);
  // The threshold is printed with the rate because at 3p+ it is *not* 0.5: an identity holding two
  // of three seats takes first place two thirds of the time at equal strength (hazard H2), and a
  // rate quoted without its null invites exactly that misreading.
  if (!isUnestimable(gate) && !isUnestimable(gate.test)) {
    console.log(`  ${' '.repeat(20)} vs a null of ${formatRate(gate.test.threshold)} ` +
      `(seats held / players), p = ${gate.test.pValue.toExponential(2)}, ` +
      `${gate.test.rejected ? 'REJECTS the null' : 'does not reject'}`);
  }
}

function commandLadder(argv: ReadonlyArray<string>): void {
  const [action, ...rest] = argv;
  const known = action === undefined ? '' : action;
  switch (known) {
  case 'build':
    return ladderBuild(rest);
  case 'show':
    return ladderShow(rest);
  case 'allocate':
    return ladderAllocate(rest);
  case 'verify':
    return ladderVerify(rest);
  default:
    throw new Error(
      `ladder needs an action: build | show | allocate | verify (got '${known}').\n` +
      '  build     fit every player count in the named artifacts and write the ladder\n' +
      '  show      print a committed ladder\n' +
      "  allocate  record a seed-block sub-range as spent, *before* the run spends it (§3.8)\n" +
      '  verify    reload the recorded inputs, refit, and check the committed numbers come back');
  }
}

const LADDER_FLAGS: Readonly<Record<string, FlagKind>> = {
  ...RATING_FLAGS,
  '--out': 'string',
  '--ladder': 'string',
  '--lineage': 'string',
};

function ladderBuild(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, LADDER_FLAGS);
  const paths = requirePaths(parsed, 'ladder build');
  const ladderPath = stringFlag(parsed, '--ladder', defaultLadderPath());
  const existing = loadLadder(ladderPath);
  const lineageFlag = parsed.values.get('--lineage');

  // The ledger is carried forward, never regenerated. A rebuild that dropped it would silently
  // un-spend every range a previous gate had claimed, which is the one way an append-only record
  // stops being one (§3.8).
  const ladder = buildLadder(paths, {
    analysisSeed: numberFlag(parsed, '--analysis-seed', DEFAULT_ANALYSIS_SEED),
    bootstrapReplicates: parsed.values.get('--no-bootstrap') === true ?
      0 :
      numberFlag(parsed, '--bootstrap-replicates', DEFAULT_BOOTSTRAP_REPLICATES),
    priorSigma: numberFlag(parsed, '--prior-sigma', DEFAULT_PRIOR_SIGMA),
    lineage: typeof lineageFlag === 'string' ?
      lineageFlag.split(',').map((identity) => identity.trim()).filter((identity) => identity.length > 0) :
      existing?.header.lineage ?? DEFAULT_LINEAGE,
    ledger: existing?.ledger,
  });

  printLadder(ladder);
  const out = parsed.values.get('--out');
  if (typeof out === 'string') {
    const resolved = resolveRatingOutputPath(out);
    saveLadder(resolved, ladder);
    console.log(`[ladder] wrote ${resolved}`);
  } else {
    console.log('[ladder] not written: pass --out ladder.json to persist it');
  }
}

function ladderShow(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, {'--ladder': 'string'});
  const ladderPath = stringFlag(parsed, '--ladder', defaultLadderPath());
  const ladder = loadLadder(ladderPath);
  if (ladder === undefined) {
    throw new Error(`no ladder at ${ladderPath}. Build one with: npm run ladder -- build <artifacts...> --out ladder.json`);
  }
  printLadder(ladder);
}

/**
 * Records a seed-block sub-range as spent (§3.8, hazard H7).
 *
 * **Run this before the games, not after.** The ledger's whole value is that it is written first: a
 * range recorded afterwards records what happened, which is a log, and what §3.8 needs is a
 * commitment. `seedBlocks.ts`'s `assertBlockAvailable` - which the gate calls - is what turns that
 * commitment into a refusal.
 */
function ladderAllocate(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, {
    '--block': 'string',
    '--groups': 'number',
    '--spent-by': 'string',
    '--from': 'number',
    '--preregistered-games': 'number',
    '--recorded-at': 'string',
    '--ladder': 'string',
    '--out': 'string',
  });
  const ladderPath = stringFlag(parsed, '--ladder', defaultLadderPath());
  const ladder = loadLadder(ladderPath) ?? emptyLadder();
  const block = stringFlag(parsed, '--block') as SeedBlockName;
  if (SEED_BLOCKS[block] === undefined) {
    throw new Error(`--block must be one of ${Object.keys(SEED_BLOCKS).join(', ')}, got '${String(block)}'`);
  }
  const from = parsed.values.get('--from');
  const preregistered = parsed.values.get('--preregistered-games');
  const recordedAt = parsed.values.get('--recorded-at');

  const request: AllocationRequest = {
    block,
    groups: numberFlag(parsed, '--groups', 0),
    spentBy: stringFlag(parsed, '--spent-by'),
    ...(typeof from === 'number' ? {from} : {}),
    ...(typeof preregistered === 'number' ? {preregisteredGames: preregistered} : {}),
    ...(typeof recordedAt === 'string' ? {recordedAt} : {}),
  };
  const updated = allocate(ladder, request);
  const allocation = updated.ledger.allocations[updated.ledger.allocations.length - 1];

  console.log(`[ladder] allocated groups ${allocation.from}-${allocation.to} in the '${allocation.block}' block ` +
    `to '${allocation.spentBy}' on ${allocation.recordedAt}` +
    `${allocation.preregisteredGames === undefined ? '' : `, N = ${allocation.preregisteredGames} pre-registered`}`);
  if (allocation.preregisteredGames === undefined && block === 'gate') {
    console.warn('[ladder] WARNING: a gate allocation with no --preregistered-games has no committed N, so its ' +
      'p-value is not protected against optional stopping (criterion P9 measures that at a predicted ' +
      '15-30% false-positive rate against a nominal 5%).');
  }

  const out = stringFlag(parsed, '--out', ladderPath);
  saveLadder(resolveRatingOutputPath(out), updated);
  console.log(`[ladder] wrote ${resolveRatingOutputPath(out)}`);
}

/**
 * Re-derives a committed ladder from its own recorded inputs (§8, Unit B).
 *
 * **This is the property that makes the ladder an audit trail rather than a cache.** A ladder that
 * cannot reproduce its own ratings from its own recorded artifacts is a set of numbers whose
 * provenance has drifted - the failure a months-long accumulating record is most prone to, and the
 * one nobody notices, because a stale number looks exactly like a fresh one.
 */
function ladderVerify(argv: ReadonlyArray<string>): void {
  const parsed = parseFlags(argv, {'--ladder': 'string'});
  const ladderPath = stringFlag(parsed, '--ladder', defaultLadderPath());
  const ladder = loadLadder(ladderPath);
  if (ladder === undefined) {
    throw new Error(`no ladder at ${ladderPath}`);
  }

  const result = rederiveLadder(ladder);
  for (const problem of result.inputProblems) {
    console.error(`[ladder]   INPUT: ${problem}`);
  }
  for (const difference of result.differences) {
    console.error(`[ladder]   DIFFERS: ${difference}`);
  }
  if (result.matches) {
    console.log(`[ladder] VERIFIED: ${ladderPath} re-derives to identical ratings from its ` +
      `${ladder.header.inputs.length} recorded input(s), all hashes matching.`);
    return;
  }
  console.error('[ladder] NOT VERIFIED: this ladder does not re-derive from its own recorded inputs.');
  process.exitCode = 1;
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
  // Unit B's region of the table (§8). Both are thin shells over `rating/bradleyTerry.ts`,
  // `rating/plackettLuce.ts` and `rating/ladder.ts`, which own the computation.
  elo: {
    describe: 'ratings on the Elo scale, anchored at random-legal@1, with separation handled (§3.3)',
    run: commandElo,
  },
  ladder: {
    describe: 'build | show | allocate | verify - the append-only record and its seed-block ledger',
    run: commandLadder,
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
