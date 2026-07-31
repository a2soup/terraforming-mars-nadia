import {AgentRandom, createAgentRandom} from '../core/rng';
import {bootstrapProportion} from './bootstrap';
import {
  CLUSTER_MECHANISMS,
  ClusterMechanism,
  simulateClusteredBinary,
  simulateClusteredContinuous,
} from './simulate';
import {
  groupSignFlipTest,
  lnGamma,
  meanEstimate,
  normalUpperTail,
  powerAt,
  proportionEstimate,
  regularizedIncompleteBeta,
  requiredGames,
  requiredGroups,
  studentTQuantile,
  thresholdTest,
  wilsonInterval,
} from './stats';
import {DEFAULT_ANALYSIS_SEED, Interval, isUnestimable} from './types';

/**
 * The calibration study (Milestone 2, bullet 3, Unit C; agent/docs/Milestone2_Bullet3_Prompts.md
 * §3.9, §5's P2/P3/P9, hazards H7 and H12).
 *
 * **What this module is for.** Nothing else in this bullet can be checked by running games. A win
 * rate is adjudicated by counting; a *confidence interval* is not, because there is no game you can
 * play to find out whether a 95% interval is a 95% interval. The method is the only one there is:
 * generate data from **known** parameters, run the shipped estimator over it, and count how often
 * the interval contains the truth. Everything Unit D publishes about an interval or a p-value in
 * this bullet traces back to a number in this file.
 *
 * ## The three things that would make this study green and worthless
 *
 * This unit's central correctness problem is not that the study might fail. It is that it might
 * *pass without meaning anything* (hazard H12). Three shortcuts do that, and each is refused here
 * in a way a later reader can check:
 *
 * 1. **Widening the band until coverage passes.** {@link coverageBand} computes the tolerance from
 *    the replication count - `0.95 ± 1.96·√(0.95·0.05/R)` - so the band is arithmetic, not taste. It
 *    is *not* a parameter. The pre-committed [94.0%, 96.0%] of criterion P2 is exactly this band at
 *    R = 2,000, rounded outward to one decimal place, and {@link PRECOMMITTED_BAND} records it so
 *    that a cell falling between the two can be reported as **marginal** rather than silently passed
 *    or silently failed.
 * 2. **Testing the estimator against a generator that shares its assumptions.** The generator is
 *    Unit A's (`simulate.ts`) and it carries §3.9's first two mitigations - two genuinely different
 *    cluster mechanisms, and degeneracy to independent Bernoulli draws at ICC = 0. This module adds
 *    the part that is *not* a simulation at all: {@link analyticAnchorGrid} computes the exact
 *    coverage of the textbook Wilson interval by **enumerating the binomial pmf**, with no RNG
 *    anywhere, so at least one row of the study is checked against mathematics rather than against
 *    Unit A's code.
 * 3. **Reporting a correction without showing that its absence matters.** Every coverage cell and
 *    every size cell carries the *unclustered* figure beside the clustered one
 *    ({@link ProportionCoverageCell.unclustered}, {@link SizeCell.unclustered}). A correction whose
 *    absence cannot be shown to matter has not been justified, only asserted.
 *
 * ## What the grid can and cannot detect - read this before trusting a green cell
 *
 * Unit A measured how far apart the two cluster mechanisms actually are (`simulate.ts`, and the
 * table in its module doc): total variation between their group-sum distributions is **0.20% -
 * 2.23%**, largest at p = 0.90 with ICC = 0.20 and smallest in the symmetric p = 0.50 row. Fixing
 * both the marginal rate and the ICC pins a unimodal mixing density on [0, 1] tightly, so the pair
 * is a real comparison but a narrow one. Two consequences this module is built around:
 *
 * - The mechanism comparison's evidence lives in the **off-centre, high-ICC cells**, so the grid
 *   runs the full rate x ICC cross rather than a diagonal, and the per-cell numbers are reported
 *   rather than a single pass/fail.
 * - The pair **cannot** detect an estimator that is wrong in a way common to every two-moment-matched
 *   mixture. For that class of error the analytic anchor and the real-data agreement check (P4b,
 *   Unit A's) are doing the work. §3.9's three mitigations are **not** equally strong and the write-up
 *   should not present them as three independent votes.
 *
 * ## Multiplicity, stated in advance
 *
 * The P2 grid has 4 rates x 3 ICCs x 2 group counts x 2 cluster sizes x 2 mechanisms = 96 cells.
 * Each is a 95% Monte-Carlo band, so **about 4.8 cells are expected outside it under a perfectly
 * calibrated estimator**. {@link expectedExcursions} computes that, and the adjudication is stated
 * on the *pattern* - a systematic direction, a cluster of failures in one corner of the grid - not
 * on the existence of an excursion. Reading a single marginal cell as a defect and a single passing
 * cell as proof are the same mistake.
 *
 * ## What it found, at 2,000 replications per cell
 *
 * Recorded here because the next reader of this file will want the answer before they want the
 * method. The full per-cell numbers are in `docs/data/rating_validation.json`; the adjudication is
 * Unit D's.
 *
 * **The proportion interval is calibrated at 500 pairing groups and mildly anti-conservative at 50.**
 * Mean coverage over the 72 cells with `p <= 0.9`: **0.9505 / 0.9509** at G = 500 (m = 2 / m = 6)
 * against **0.9466 / 0.9448** at G = 50. The direction is the same everywhere and the cause is
 * structural rather than a defect in the formula: the interval plugs an *estimated* design effect
 * into a multiplier that assumes the variance is known, and at 50 groups that estimate is noisy. The
 * committed corpora sit at 500 (2p), 100 (3p) and **25 (4p) groups**, so this is a real caveat on
 * the 3p and 4p intervals and effectively none on 2p.
 *
 * **§3.1's flooring question has an answer: floor it.** The design effect comes out below 1 on
 * **17-34% of replications** (block means; individual cells reach 63%), and flooring at 1 raises mean coverage from 0.9482 to 0.9503 over the
 * `p <= 0.9` cells, cuts under-covering cells from 5 to 3, and costs 0.1% of interval width. Adding a
 * `t` multiplier on `groups - 1` degrees of freedom on top (`flooredWithT`) removes under-coverage
 * entirely (0 cells) but overshoots to 0.963 at G = 50, m = 2 - it trades under-coverage for
 * over-coverage rather than eliminating error. Flooring is the change the data supports; the
 * multiplier is a further option with a stated cost.
 *
 * **The cluster correction is justified by measurement, not by argument.** Without it, mean coverage
 * over the same cells is **0.9205** with 44 of 72 cells under-covering, and the one-sided 5% test's
 * empirical size reaches **11.8%** at ICC = 0.20 with m = 6 and **7.1%** at ICC = 0.05 with m = 6 -
 * the 3p regime, where AC-5 lives. With the correction, all 48 size cells and all 12 permutation-test
 * cells sit at or below nominal.
 *
 * **The percentile cluster bootstrap is the weakest thing in the pipeline**, and it fails in exactly
 * the regime this project's baselines occupy. At 50 groups it under-covers by 1-2 pp across the
 * board, and at `p = 0.99` with m = 2 it collapses to **0.60-0.64** - because a sample that is all
 * successes makes every resample all successes, so the percentile interval is the degenerate `[1, 1]`
 * and excludes the truth by construction. `greedy-1ply@1` wins 99.2%. Unit A found the same edge from
 * the other side (P4b's 4p gap); this is its coverage cost, measured.
 *
 * **The analytic anchor reframes the `p = 0.99` failures, and this is the finding a reader is most
 * likely to draw the wrong conclusion from without it.** The *exact* coverage of a textbook Wilson
 * interval - enumerated, no estimator and no generator involved - at `p = 0.99` with 100 rows is
 * **92.06%**, and at `p = 0.5` with 100 rows it is 94.31%. A plug-in interval on a discrete
 * distribution simply does not sit at 95% at every `(n, p)`; that is a property of the interval and
 * of binomial discreteness, not of anything this bullet built. So the near-boundary cells in the grid
 * are measuring two things at once, and the anchor is what separates them: across all 16 anchor cells
 * the pipeline's simulated coverage sits within **-1.5 pp to +1.7 pp** of the exact figure, which is
 * the cost of estimating the design effect and is the part that *is* attributable to this pipeline.
 *
 * **The power calculator is accurate except at the smallest sample it is asked for.** Empirical power
 * matches `powerAt` to under 1.7 pp at every §2.5 row from n = 158 up, and overstates by **2.3 pp** at
 * n = 70 (the 65%-detection row), where a normal approximation has the least to work with. Treat
 * `requiredGames` as a floor at that scale.
 *
 * ## Seeding
 *
 * Every cell derives its own stream from `(analysisSeed, cell label)` via {@link cellSeed}, rather
 * than consuming one long stream in grid order. That costs nothing and buys the property §4 of this
 * unit's prompt asks for: **a later reader can re-run one cell** and get the identical number,
 * without running the 95 cells before it, and adding a cell to the grid does not perturb the cells
 * already published. `createAgentRandom` only - never a directly constructed `SeededRandom`, whose
 * integer-seed constructor is degenerate (Running Notes, 2026-07-22; hazard H11).
 *
 * (That sentence is deliberately not written with the constructor call spelled out: the structural
 * guard in `test/determinism/rngSeparation.spec.ts` greps raw file text, so a *prose mention* of the
 * forbidden construction fails the spec exactly as the construction itself would. Which is the guard
 * behaving correctly - a regex over source cannot tell a warning from a violation, and the version
 * that could be fooled by a comment would be the broken one.)
 */

// ---------------------------------------------------------------------------------------------
// Tolerance: arithmetic, never taste
// ---------------------------------------------------------------------------------------------

/** The nominal level of every interval and the complement of every test's size in this pipeline. */
export const NOMINAL_COVERAGE = 0.95;

/**
 * Criterion P2's pre-committed band, written down before any estimator existed: **[94.0%, 96.0%]**
 * over >= 2,000 replications. It is {@link coverageBand} at R = 2,000 rounded outward to one decimal
 * place, and it is recorded as a constant so the two can be compared rather than conflated.
 */
export const PRECOMMITTED_BAND: Interval = {low: 0.94, high: 0.96};

/** Criterion P2's floor on replications per scenario. */
export const REQUIRED_REPLICATIONS = 2_000;

export type CoverageBand = {
  replications: number;
  nominal: number;
  /** The Monte-Carlo standard error of an empirical coverage of `replications` draws. */
  standardError: number;
  low: number;
  high: number;
};

/**
 * The +/-1.96 Monte-Carlo band around the nominal level, **computed from the replication count**.
 *
 * This is the function that makes P2 unwidenable. An empirical coverage over `R` replications is a
 * binomial proportion with standard error `√(0.95·0.05/R)`; at R = 2,000 that is 0.487 pp and the
 * band is [94.05%, 95.96%], which is the [94.0%, 96.0%] the plan pre-committed. **If a cell lands
 * outside, the estimator is what changes** - the band cannot, because it is not a parameter of
 * anything, and raising `replications` narrows it rather than widening it.
 */
export function coverageBand(replications: number, nominal: number = NOMINAL_COVERAGE): CoverageBand {
  const standardError = Math.sqrt(nominal * (1 - nominal) / replications);
  const half = 1.959964 * standardError;
  return {replications, nominal, standardError, low: nominal - half, high: nominal + half};
}

/**
 * `pass` inside the computed band; `fail` outside the pre-committed [94.0%, 96.0%]; `marginal` in
 * between - i.e. outside the Monte-Carlo band but inside the criterion as it was written down.
 *
 * The three-way split exists so that neither of the two available dishonesties is convenient. A
 * two-way split against the computed band would make the ~4.8 expected excursions look like five
 * defects; a two-way split against the pre-committed band would hide a cell sitting exactly on the
 * boundary. Reporting both is the only version that survives a reader checking the arithmetic.
 */
export type CoverageVerdict = 'pass' | 'marginal' | 'fail';

export function coverageVerdict(coverage: number, band: CoverageBand): CoverageVerdict {
  if (coverage >= band.low && coverage <= band.high) {
    return 'pass';
  }
  return coverage >= PRECOMMITTED_BAND.low && coverage <= PRECOMMITTED_BAND.high ? 'marginal' : 'fail';
}

/**
 * How many of `cells` are *expected* outside a 95% Monte-Carlo band under a perfectly calibrated
 * estimator: `cells · 0.05`. Reported next to the observed count, because "5 of 96 cells were
 * outside the band" is a pass and reads like a failure.
 */
export function expectedExcursions(cells: number, bandLevel = 0.95): number {
  return cells * (1 - bandLevel);
}

/**
 * A per-cell stream derived from the cell's **parameters**, not from its position in the grid.
 *
 * FNV-1a over the label, mixed with the analysis seed. Two properties follow, both of which the
 * "one long stream in grid order" alternative lacks: a cell can be re-run in isolation and
 * reproduce exactly, and adding a cell to the grid does not change any number already published.
 */
export function cellSeed(analysisSeed: number, label: string): number {
  let hash = 2_166_136_261 ^ (analysisSeed >>> 0);
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  // `>>> 0` then halve: `createAgentRandom` wants a non-negative safe integer, and the top bit
  // carries no information the mixing has not already spread.
  return (hash >>> 1) + 1;
}

function cellRandom(analysisSeed: number, label: string): AgentRandom {
  return createAgentRandom(cellSeed(analysisSeed, label));
}

// ---------------------------------------------------------------------------------------------
// P2: the coverage grid
// ---------------------------------------------------------------------------------------------

/** Criterion P2's scenario grid, exactly as pre-committed. */
export const P2_RATES: ReadonlyArray<number> = [0.5, 0.65, 0.9, 0.99];
export const P2_ICCS: ReadonlyArray<number> = [0, 0.05, 0.2];
export const P2_GROUP_COUNTS: ReadonlyArray<number> = [50, 500];
/** 2 is the 2p pairing design's permutation count; 6 is 3p's. Both are real cluster sizes. */
export const P2_CLUSTER_SIZES: ReadonlyArray<number> = [2, 6];

export type CoverageResult = {
  covered: number;
  coverage: number;
  verdict: CoverageVerdict;
  /**
   * The *direction* of a miss, which the coverage figure alone hides. An interval that misses low
   * as often as it misses high is too narrow; one that misses only on one side is biased, and the
   * two call for different fixes.
   */
  missedLow: number;
  missedHigh: number;
  meanWidth: number;
};

export type ProportionCoverageCell = {
  label: string;
  rate: number;
  icc: number;
  groups: number;
  clusterSize: number;
  mechanism: ClusterMechanism;
  analysisSeed: number;
  replications: number;
  /** Replications on which the estimator produced an interval at all. Anything less is a finding. */
  estimable: number;
  /** Reasons the estimator declined, counted. Empty is the expected case. */
  unestimableReasons: Record<string, number>;
  designEffect: {
    truth: number;
    meanEstimated: number;
    /**
     * Replications on which the *estimated* design effect came out below 1. §3.1 deliberately does
     * not floor it - a blocked design legitimately produces `deff < 1`, and Unit A found two such
     * cases in real data - so this column is how often the anti-conservative side of that decision
     * was actually taken, next to the coverage it produced.
     */
    belowOne: number;
    /**
     * Replications on which `clusterDesign` could not estimate the design effect at all and used
     * its stated fallback (every row a success, or every row a failure - the ICC is unidentified
     * and it assumes the conservative end). Expected to be common at p = 0.99 and rare elsewhere;
     * a coverage figure in a cell where this is large is a figure about the fallback.
     */
    degenerate: number;
  };
  /** **The shipped estimator**: effective-n Wilson with the design effect left unfloored (§3.1). */
  primary: CoverageResult;
  /**
   * The same interval with the design effect floored at 1. §3.1 leaves flooring open and names P2's
   * coverage at ICC = 0 as the measurement that decides it, so both are computed on the *same*
   * replications and the difference is the evidence.
   */
  floored: CoverageResult;
  /**
   * **A candidate fix, not the shipped estimator**: the design effect floored at 1 *and* the normal
   * multiplier replaced by `t` on `groups - 1` degrees of freedom.
   *
   * The reasoning it tests: the shipped interval plugs an *estimated* design effect into a formula
   * whose 1.96 assumes the variance is known. With 50 pairing groups that estimate is itself noisy,
   * and ignoring its noise makes the interval too narrow - which is the direction and roughly the
   * magnitude of the residual under-coverage this grid measures at G = 50. `t_49 = 2.010` against
   * `z = 1.960` widens the interval by 2.5%, and `stats.ts`'s continuous {@link meanEstimate} already
   * uses exactly this multiplier for exactly this reason, so the pipeline is internally inconsistent
   * about it rather than being deliberately different.
   *
   * Computed here so that "the interval under-covers at 50 groups" arrives at Unit D with a measured
   * remedy attached rather than as a problem statement. **`rating/stats.ts` is Unit A's file and is
   * not modified by this unit** (§8).
   */
  flooredWithT: CoverageResult;
  /** No cluster correction at all - the negative control. Its under-coverage is the justification. */
  unclustered: CoverageResult;
};

export type ProportionCoverageGrid = {
  what: string;
  band: CoverageBand;
  precommittedBand: Interval;
  cells: ReadonlyArray<ProportionCoverageCell>;
  summary: GridSummary;
  /**
   * The four interval variants side by side, over the whole grid and over the sub-grid that excludes
   * `p = 0.99`. **This is the table the flooring decision of §3.1 is made from**, and the reason the
   * p = 0.99 split is reported separately is that the near-boundary regime has its own failure mode
   * (the degenerate-design fallback) which would otherwise be averaged into the flooring question and
   * hide it.
   */
  variants: ReadonlyArray<VariantComparison>;
};

export type VariantComparison = {
  variant: 'primary' | 'floored' | 'flooredWithT' | 'unclustered';
  what: string;
  /** Over all 96 cells. */
  meanCoverage: number;
  failUnder: number;
  failOver: number;
  /** Over the 72 cells with `p <= 0.9`, where the degenerate-design fallback is rare. */
  meanCoverageBelow99: number;
  failUnderBelow99: number;
  /** Mean interval width, in probability points. A narrower interval that covers less is not a win. */
  meanWidth: number;
};

export type GridSummary = {
  cells: number;
  pass: number;
  marginal: number;
  fail: number;
  /**
   * Failing cells whose coverage is **below** the pre-committed band. §5's P2 names this and only
   * this a blocking failure - an interval that misses the truth more than 1 time in 20 is not a 95%
   * interval, and no amount of the other kind compensates.
   */
  failUnder: number;
  /**
   * Failing cells whose coverage is **above** it. Conservative rather than wrong: the interval is
   * wider than it needs to be, so a claim made from it is understated. Reported separately because
   * treating the two directions alike is how a conservative estimator gets "fixed" into an
   * anti-conservative one.
   */
  failOver: number;
  /** `cells · 0.05` - what a perfectly calibrated estimator would produce outside the band. */
  expectedOutsideBand: number;
  observedOutsideBand: number;
  worst: {label: string; coverage: number; verdict: CoverageVerdict} | undefined;
  /** Under-coverage is the blocking direction; over-coverage is conservative and merely wasteful. */
  worstUnderCoverage: {label: string; coverage: number} | undefined;
};

type CoverageTally = {covered: number; missedLow: number; missedHigh: number; width: number};

function tally(): CoverageTally {
  return {covered: 0, missedLow: 0, missedHigh: 0, width: 0};
}

function record(into: CoverageTally, interval: Interval, truth: number): void {
  into.width += interval.high - interval.low;
  if (interval.low <= truth && truth <= interval.high) {
    into.covered++;
  } else if (interval.high < truth) {
    into.missedLow++;
  } else {
    into.missedHigh++;
  }
}

function resultOf(counts: CoverageTally, estimable: number, band: CoverageBand): CoverageResult {
  const coverage = estimable === 0 ? 0 : counts.covered / estimable;
  return {
    covered: counts.covered,
    coverage,
    verdict: coverageVerdict(coverage, band),
    missedLow: counts.missedLow,
    missedHigh: counts.missedHigh,
    meanWidth: estimable === 0 ? 0 : counts.width / estimable,
  };
}

function summarize(cells: ReadonlyArray<{label: string; primary: CoverageResult}>): GridSummary {
  const verdicts = cells.map((cell) => cell.primary.verdict);
  const sorted = [...cells].sort((a, b) =>
    Math.abs(b.primary.coverage - NOMINAL_COVERAGE) - Math.abs(a.primary.coverage - NOMINAL_COVERAGE));
  const under = [...cells].sort((a, b) => a.primary.coverage - b.primary.coverage)[0];
  const failing = cells.filter((cell) => cell.primary.verdict === 'fail');
  return {
    cells: cells.length,
    pass: verdicts.filter((verdict) => verdict === 'pass').length,
    marginal: verdicts.filter((verdict) => verdict === 'marginal').length,
    fail: failing.length,
    failUnder: failing.filter((cell) => cell.primary.coverage < PRECOMMITTED_BAND.low).length,
    failOver: failing.filter((cell) => cell.primary.coverage > PRECOMMITTED_BAND.high).length,
    expectedOutsideBand: expectedExcursions(cells.length),
    observedOutsideBand: verdicts.filter((verdict) => verdict !== 'pass').length,
    worst: sorted[0] === undefined ?
      undefined :
      {label: sorted[0].label, coverage: sorted[0].primary.coverage, verdict: sorted[0].primary.verdict},
    worstUnderCoverage: under === undefined ? undefined : {label: under.label, coverage: under.primary.coverage},
  };
}

export type GridOptions = {
  replications?: number;
  analysisSeed?: number;
  onCell?: (label: string, index: number, total: number) => void;
};

/**
 * Criterion P2's main event: the effective-n Wilson interval's empirical coverage over the full
 * scenario grid, under **both** cluster mechanisms.
 *
 * Every cell runs the shipped {@link proportionEstimate} - not a reimplementation of it - because a
 * calibration study of a copy of the estimator is a calibration study of the copy.
 */
export function proportionCoverageGrid(options: GridOptions = {}): ProportionCoverageGrid {
  const replications = options.replications ?? REQUIRED_REPLICATIONS;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const band = coverageBand(replications);

  const scenarios: Array<{rate: number; icc: number; groups: number; clusterSize: number; mechanism: ClusterMechanism}> = [];
  for (const rate of P2_RATES) {
    for (const icc of P2_ICCS) {
      for (const groups of P2_GROUP_COUNTS) {
        for (const clusterSize of P2_CLUSTER_SIZES) {
          for (const mechanism of CLUSTER_MECHANISMS) {
            scenarios.push({rate, icc, groups, clusterSize, mechanism});
          }
        }
      }
    }
  }

  const cells = scenarios.map((scenario, index) => {
    const label = proportionCellLabel(scenario);
    options.onCell?.(label, index, scenarios.length);
    return proportionCoverageCell({...scenario, replications, analysisSeed, band});
  });

  return {
    what: 'P2: empirical coverage of the effective-n Wilson interval over the pre-committed scenario grid, ' +
      'under both cluster mechanisms of §3.9. The floored and unclustered columns are computed on the same ' +
      'replications: the first settles §3.1\'s open question about flooring the design effect, the second is ' +
      'the negative control that justifies the correction.',
    band,
    precommittedBand: PRECOMMITTED_BAND,
    cells,
    summary: summarize(cells),
    variants: compareVariants(cells),
  };
}

const VARIANT_DESCRIPTIONS: Readonly<Record<VariantComparison['variant'], string>> = {
  primary: 'the shipped estimator: effective-n Wilson, design effect unfloored, z = 1.96',
  floored: 'design effect floored at 1 (§3.1\'s open question), z = 1.96',
  flooredWithT: 'design effect floored at 1 and z replaced by t on groups - 1 df - a candidate fix, not shipped',
  unclustered: 'no cluster correction at all - the negative control',
};

function compareVariants(cells: ReadonlyArray<ProportionCoverageCell>): ReadonlyArray<VariantComparison> {
  const below99 = cells.filter((cell) => cell.rate < 0.99);
  const mean = (values: ReadonlyArray<number>): number =>
    (values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length);

  return (Object.keys(VARIANT_DESCRIPTIONS) as ReadonlyArray<VariantComparison['variant']>).map((variant) => {
    const results = cells.map((cell) => cell[variant]);
    return {
      variant,
      what: VARIANT_DESCRIPTIONS[variant],
      meanCoverage: mean(results.map((result) => result.coverage)),
      failUnder: results.filter((result) => result.coverage < PRECOMMITTED_BAND.low).length,
      failOver: results.filter((result) => result.coverage > PRECOMMITTED_BAND.high).length,
      meanCoverageBelow99: mean(below99.map((cell) => cell[variant].coverage)),
      failUnderBelow99: below99.filter((cell) => cell[variant].coverage < PRECOMMITTED_BAND.low).length,
      meanWidth: mean(results.map((result) => result.meanWidth)),
    };
  });
}

function proportionCellLabel(scenario: {rate: number; icc: number; groups: number; clusterSize: number; mechanism: ClusterMechanism}): string {
  return `p=${scenario.rate} icc=${scenario.icc} G=${scenario.groups} m=${scenario.clusterSize} ${scenario.mechanism}`;
}

export function proportionCoverageCell(scenario: {
  rate: number;
  icc: number;
  groups: number;
  clusterSize: number;
  mechanism: ClusterMechanism;
  replications: number;
  analysisSeed: number;
  band?: CoverageBand;
}): ProportionCoverageCell {
  const label = proportionCellLabel(scenario);
  const band = scenario.band ?? coverageBand(scenario.replications);
  const seed = cellSeed(scenario.analysisSeed, label);
  const random = createAgentRandom(seed);

  const primary = tally();
  const floored = tally();
  const flooredWithT = tally();
  const unclustered = tally();
  // One `t` quantile per cell, not per replication: the group count is fixed by the scenario, and
  // `studentTQuantile` bisects on an incomplete beta, which is not something to do 2,000 times for
  // the same answer.
  const tMultiplier = studentTQuantile(0.975, scenario.groups - 1);
  const unestimableReasons: Record<string, number> = {};
  let estimable = 0;
  let designEffectTotal = 0;
  let belowOne = 0;
  let degenerate = 0;

  for (let replication = 0; replication < scenario.replications; replication++) {
    const sample = simulateClusteredBinary({
      groups: scenario.groups,
      clusterSize: scenario.clusterSize,
      rate: scenario.rate,
      icc: scenario.icc,
      mechanism: scenario.mechanism,
      random,
    });
    const estimate = proportionEstimate(sample.clusters);
    if (isUnestimable(estimate)) {
      // Never silently dropped: an estimator that declines on 3% of replications has a coverage
      // figure conditional on the 97% it liked, and that conditioning is itself the finding (H9).
      const key = shortReason(estimate.reason);
      unestimableReasons[key] = (unestimableReasons[key] ?? 0) + 1;
      continue;
    }
    estimable++;
    designEffectTotal += estimate.design.designEffect;
    if (estimate.design.designEffect < 1) {
      belowOne++;
    }
    if (estimate.design.note !== undefined) {
      degenerate++;
    }
    const flooredN = estimate.design.rows / Math.max(1, estimate.design.designEffect);
    record(primary, estimate.ci95, scenario.rate);
    record(floored, wilsonInterval(estimate.rate, flooredN), scenario.rate);
    record(flooredWithT, wilsonScoreInterval(estimate.rate, flooredN, tMultiplier), scenario.rate);
    record(unclustered, wilsonInterval(estimate.rate, estimate.design.rows), scenario.rate);
  }

  return {
    label,
    rate: scenario.rate,
    icc: scenario.icc,
    groups: scenario.groups,
    clusterSize: scenario.clusterSize,
    mechanism: scenario.mechanism,
    analysisSeed: seed,
    replications: scenario.replications,
    estimable,
    unestimableReasons,
    designEffect: {
      truth: 1 + (scenario.clusterSize - 1) * scenario.icc,
      meanEstimated: estimable === 0 ? 0 : designEffectTotal / estimable,
      belowOne,
      degenerate,
    },
    primary: resultOf(primary, estimable, band),
    floored: resultOf(floored, estimable, band),
    flooredWithT: resultOf(flooredWithT, estimable, band),
    unclustered: resultOf(unclustered, estimable, band),
  };
}

/**
 * The Wilson score interval with the multiplier left open, so a candidate fix can be measured
 * without touching `stats.ts` (§8: that file is Unit A's).
 *
 * Identical to `stats.ts`'s {@link wilsonInterval} at `multiplier = 1.959964`; the spec asserts that
 * against the shipped function so this copy cannot quietly drift into being a different interval and
 * make the comparison meaningless.
 */
export function wilsonScoreInterval(rate: number, n: number, multiplier: number): Interval {
  const zz = multiplier * multiplier;
  const denominator = 1 + zz / n;
  const centre = (rate + zz / (2 * n)) / denominator;
  const half = multiplier / denominator * Math.sqrt(rate * (1 - rate) / n + zz / (4 * n * n));
  return {low: Math.max(0, centre - half), high: Math.min(1, centre + half)};
}

/** Collapses an `Unestimable` reason to a short, groupable key - the reasons carry sample-specific numbers. */
function shortReason(reason: string): string {
  if (reason.includes('identical mean')) {
    return 'all groups have the identical mean';
  }
  if (reason.includes('pairing group(s)')) {
    return 'too few pairing groups';
  }
  return reason.slice(0, 60);
}

// ---------------------------------------------------------------------------------------------
// P2: the analytic anchor - no RNG anywhere
// ---------------------------------------------------------------------------------------------

export type AnalyticAnchorCell = {
  label: string;
  rate: number;
  rows: number;
  groups: number;
  clusterSize: number;
  /** Exact, by enumeration over the binomial pmf. The row of this study checked against mathematics. */
  exact: {wilson: number; clopperPearson: number};
  /** The shipped pipeline, simulated at ICC = 0 where the exact answer above applies. */
  simulated: {pipeline: number; replications: number; estimable: number; mechanism: ClusterMechanism};
  /**
   * `simulated.pipeline - exact.wilson`: **the cost of estimating the design effect**. The exact
   * figure is the coverage a Wilson interval has when `deff` is known to be 1; the simulated figure
   * is the coverage the pipeline has when it estimates `deff` from the same data it estimates the
   * rate from. Everything between them is that estimation, and it is the number §3.1's flooring
   * question turns on.
   */
  estimationCost: number;
};

/**
 * The analytic anchor of §3.9, and the one part of this study with no random numbers in it.
 *
 * At ICC = 0 both cluster mechanisms degenerate to independent Bernoulli draws, where a proportion's
 * coverage is a finite sum: enumerate `k = 0..n`, weight by the binomial pmf, and add the weight
 * whenever the interval built from `k/n` contains `p`. That is exact to floating point, it depends
 * on no generator, and it is what makes at least one row of this study a check on mathematics rather
 * than a check on Unit A.
 *
 * Both textbook intervals are enumerated: **Wilson**, which is what the pipeline reduces to when
 * `deff = 1`, and **Clopper-Pearson**, the exact-binomial interval, whose coverage is guaranteed
 * >= 95% and whose appearance here is a check on the enumeration itself. A Clopper-Pearson coverage
 * below 0.95 in this table would mean the enumeration is wrong, not that the interval is.
 *
 * Two things to know before reading the output:
 *
 * - **Exact Wilson coverage is not 95%**, and is not supposed to be. On a discrete distribution a
 *   plug-in interval oscillates with `n` and `p`: this grid measures 92.06% at `p = 0.99, n = 100`
 *   and 94.31% at `p = 0.5, n = 100`. Comparing a simulated cell to 95% therefore conflates two
 *   different things; comparing it to *this* column does not, which is the whole point of the anchor.
 * - **The simulated column is deliberately an independent replication** of the grid's own ICC = 0
 *   cells - it draws from its own `cellSeed` stream rather than reusing theirs. Where the two differ
 *   by more than Monte-Carlo error, that difference is itself information.
 */
export function analyticAnchorGrid(options: GridOptions = {}): {
  what: string;
  cells: ReadonlyArray<AnalyticAnchorCell>;
} {
  const replications = options.replications ?? REQUIRED_REPLICATIONS;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;

  const cells: Array<AnalyticAnchorCell> = [];
  for (const rate of P2_RATES) {
    for (const groups of P2_GROUP_COUNTS) {
      for (const clusterSize of P2_CLUSTER_SIZES) {
        const rows = groups * clusterSize;
        const label = `p=${rate} n=${rows} (G=${groups} x m=${clusterSize})`;
        options.onCell?.(label, cells.length, P2_RATES.length * P2_GROUP_COUNTS.length * P2_CLUSTER_SIZES.length);

        const random = cellRandom(analysisSeed, `anchor ${label}`);
        let covered = 0;
        let estimable = 0;
        for (let replication = 0; replication < replications; replication++) {
          const sample = simulateClusteredBinary({
            groups, clusterSize, rate, icc: 0, mechanism: 'beta-binomial', random,
          });
          const estimate = proportionEstimate(sample.clusters);
          if (isUnestimable(estimate)) {
            continue;
          }
          estimable++;
          if (estimate.ci95.low <= rate && rate <= estimate.ci95.high) {
            covered++;
          }
        }

        const exactWilson = exactBinomialCoverage(rows, rate, (successes, trials) =>
          wilsonInterval(successes / trials, trials));
        cells.push({
          label,
          rate,
          rows,
          groups,
          clusterSize,
          exact: {
            wilson: exactWilson,
            clopperPearson: exactBinomialCoverage(rows, rate, clopperPearson),
          },
          simulated: {
            pipeline: estimable === 0 ? 0 : covered / estimable,
            replications,
            estimable,
            mechanism: 'beta-binomial',
          },
          estimationCost: (estimable === 0 ? 0 : covered / estimable) - exactWilson,
        });
      }
    }
  }

  return {
    what: 'P2 analytic anchor (§3.9): the exact coverage of the textbook Wilson and Clopper-Pearson ' +
      'intervals by enumeration over the binomial pmf - no RNG - beside the pipeline\'s simulated ' +
      'coverage at ICC = 0. The difference is the cost of estimating the design effect.',
    cells,
  };
}

/**
 * `Σ_k C(n,k) p^k (1-p)^(n-k) · 1[interval(k, n) covers p]` - a proportion interval's coverage,
 * exactly, with no simulation.
 *
 * The pmf is computed in logs through {@link lnGamma} rather than as a product of binomial
 * coefficients: at n = 3,000 the coefficient overflows a double by ~870 orders of magnitude, and the
 * naive version would return `NaN` for the largest cells in the grid - silently, since every term
 * would be `Infinity * 0`.
 */
export function exactBinomialCoverage(
  n: number,
  p: number,
  interval: (successes: number, trials: number) => Interval,
): number {
  const lnP = Math.log(p);
  const lnQ = Math.log(1 - p);
  let total = 0;
  for (let k = 0; k <= n; k++) {
    const lnPmf = lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * lnP + (n - k) * lnQ;
    const pmf = Math.exp(lnPmf);
    // Terms below this contribute nothing at double precision and cost an interval construction.
    if (pmf < 1e-18) {
      continue;
    }
    const bounds = interval(k, n);
    if (bounds.low <= p && p <= bounds.high) {
      total += pmf;
    }
  }
  return total;
}

/**
 * The Clopper-Pearson (exact binomial) interval, by bisection on the regularized incomplete beta
 * `stats.ts` already carries.
 *
 * Present as an oracle, not as a candidate: it is the interval whose coverage is *guaranteed* at
 * least 95% for every `n` and `p`, so its enumerated coverage in {@link analyticAnchorGrid} is a
 * check that the enumeration is right. It is not proposed as a replacement for Wilson - it is
 * conservative by construction, and §3.1 chose Wilson for a reason specific to this project (a Wald
 * or t interval runs off the end of [0, 1] at the 99.2% where the baselines actually live).
 */
export function clopperPearson(successes: number, trials: number, alpha = 0.05): Interval {
  const low = successes === 0 ? 0 : betaQuantile(alpha / 2, successes, trials - successes + 1);
  const high = successes === trials ? 1 : betaQuantile(1 - alpha / 2, successes + 1, trials - successes);
  return {low, high};
}

/** `I⁻¹_q(a, b)`, by bisection. 60 halvings of [0, 1] is ~1e-18, well past what a bound needs. */
function betaQuantile(q: number, a: number, b: number): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 60; iteration++) {
    const mid = (low + high) / 2;
    if (regularizedIncompleteBeta(a, b, mid) < q) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------------------------
// P2: the bootstrap cross-check's own coverage
// ---------------------------------------------------------------------------------------------

export type BootstrapCoverageCell = {
  label: string;
  rate: number;
  icc: number;
  groups: number;
  clusterSize: number;
  mechanism: ClusterMechanism;
  analysisSeed: number;
  replications: number;
  bootstrapReplicates: number;
  estimable: number;
  unestimableReasons: Record<string, number>;
  /** The percentile cluster bootstrap - `bootstrap.ts`'s shipped function. */
  primary: CoverageResult;
  /** The effective-n Wilson interval on the *same* replications, for a like-for-like comparison. */
  wilson: CoverageResult;
  /** Mean P4b disagreement (worst bound) between the two, per replication. */
  meanDisagreement: number;
};

/**
 * §3.1 gives every proportion **two** intervals, so P2's "every interval is calibrated" covers the
 * bootstrap as well as the Wilson - a cross-check that is itself miscalibrated is not a cross-check.
 *
 * **Run on a reduced grid, and here is the honest reason.** A percentile cluster bootstrap costs
 * `B · G · m` element visits per replication, so the full P2 grid at the pipeline's default
 * B = 2,000 and G = 500 is ~10^12 visits - hours of arithmetic for a study the plan budgets minutes
 * for. The reduction taken is: **G = 50 only** (the small-sample regime, which is where a percentile
 * interval is most likely to be wrong and where 4p's 25 groups actually sits), the full rate x ICC x
 * mechanism cross, and B = 200 rather than 2,000. B = 200 puts the percentile endpoints at rank 5
 * and rank 196, i.e. a granularity of 0.5% of the replicate distribution; that is coarse enough to
 * matter for a *reported* interval and is why the pipeline's default stays at 2,000, but it does not
 * bias coverage. The large-G behaviour is left to P4b on real corpora, where both intervals are
 * computed at full B on the committed data.
 */
export function bootstrapCoverageGrid(options: GridOptions & {bootstrapReplicates?: number} = {}): {
  what: string;
  band: CoverageBand;
  cells: ReadonlyArray<BootstrapCoverageCell>;
  summary: GridSummary;
} {
  const replications = options.replications ?? REQUIRED_REPLICATIONS;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const bootstrapReplicates = options.bootstrapReplicates ?? 200;
  const band = coverageBand(replications);
  const groups = 50;

  const scenarios: Array<{rate: number; icc: number; clusterSize: number; mechanism: ClusterMechanism}> = [];
  for (const rate of P2_RATES) {
    for (const icc of P2_ICCS) {
      for (const clusterSize of P2_CLUSTER_SIZES) {
        for (const mechanism of CLUSTER_MECHANISMS) {
          scenarios.push({rate, icc, clusterSize, mechanism});
        }
      }
    }
  }

  const cells = scenarios.map((scenario, index) => {
    const label = `bootstrap p=${scenario.rate} icc=${scenario.icc} G=${groups} m=${scenario.clusterSize} ${scenario.mechanism}`;
    options.onCell?.(label, index, scenarios.length);

    const seed = cellSeed(analysisSeed, label);
    const random = createAgentRandom(seed);
    const primary = tally();
    const wilson = tally();
    const unestimableReasons: Record<string, number> = {};
    let estimable = 0;
    let disagreement = 0;

    for (let replication = 0; replication < replications; replication++) {
      const sample = simulateClusteredBinary({
        groups,
        clusterSize: scenario.clusterSize,
        rate: scenario.rate,
        icc: scenario.icc,
        mechanism: scenario.mechanism,
        random,
      });
      const resampled = bootstrapProportion(sample.clusters, {replicates: bootstrapReplicates, random});
      const estimate = proportionEstimate(sample.clusters);
      if (isUnestimable(resampled) || isUnestimable(estimate)) {
        const reason = isUnestimable(resampled) ? resampled.reason : (estimate as {reason: string}).reason;
        const key = shortReason(reason);
        unestimableReasons[key] = (unestimableReasons[key] ?? 0) + 1;
        continue;
      }
      estimable++;
      record(primary, resampled.ci95, scenario.rate);
      record(wilson, estimate.ci95, scenario.rate);
      disagreement += Math.max(
        Math.abs(resampled.ci95.low - estimate.ci95.low),
        Math.abs(resampled.ci95.high - estimate.ci95.high));
    }

    return {
      label,
      rate: scenario.rate,
      icc: scenario.icc,
      groups,
      clusterSize: scenario.clusterSize,
      mechanism: scenario.mechanism,
      analysisSeed: seed,
      replications,
      bootstrapReplicates,
      estimable,
      unestimableReasons,
      primary: resultOf(primary, estimable, band),
      wilson: resultOf(wilson, estimable, band),
      meanDisagreement: estimable === 0 ? 0 : disagreement / estimable,
    };
  });

  return {
    what: 'P2: the percentile cluster bootstrap\'s own coverage, on a reduced grid (G = 50, B = 200) ' +
      'for the cost reason in the function doc. The Wilson column is computed on the same replications, ' +
      'so the two columns are a like-for-like comparison rather than two separate studies.',
    band,
    cells,
    summary: summarize(cells),
  };
}

// ---------------------------------------------------------------------------------------------
// P2: the VP-margin interval, over a continuous generator
// ---------------------------------------------------------------------------------------------

export type MarginCoverageCell = {
  label: string;
  mean: number;
  icc: number;
  groups: number;
  clusterSize: number;
  betweenSd: number;
  withinSd: number;
  analysisSeed: number;
  replications: number;
  estimable: number;
  designEffect: {truth: number; meanEstimated: number};
  /** The shipped group-mean t interval on the cluster-robust standard error (`stats.ts`). */
  primary: CoverageResult;
  /** No cluster correction: the ordinary iid t interval. The negative control for the margin. */
  unclustered: CoverageResult;
};

/**
 * P2's second half: **the same standard for the VP-margin interval**, over the continuous generator.
 *
 * The scenarios are sized against reality rather than round numbers. At 2p the measured per-game
 * margin standard deviation is 26.2 VP with a mean of +0.878; at 3p the measured margin design
 * effect is 1.516 at m = 6, which is ICC ~= 0.103 and is **the cell where an uncorrected interval is
 * 23% too narrow** - and 3p is where AC-5 lives. The ICC = 0 row is the anchor: the group-mean t
 * interval there should be at nominal by construction.
 */
export function marginCoverageGrid(options: GridOptions = {}): {
  what: string;
  band: CoverageBand;
  cells: ReadonlyArray<MarginCoverageCell>;
  summary: GridSummary;
} {
  const replications = options.replications ?? REQUIRED_REPLICATIONS;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const band = coverageBand(replications);

  const scenarios: Array<{mean: number; totalSd: number; icc: number; groups: number; clusterSize: number}> = [];
  for (const icc of [0, 0.05, 0.103, 0.2]) {
    for (const groups of P2_GROUP_COUNTS) {
      for (const clusterSize of P2_CLUSTER_SIZES) {
        // 2p's measured scale at m = 2; 3p's at m = 6. Both from §2.3.
        const shape = clusterSize === 2 ? {mean: 0.878, totalSd: 26.2} : {mean: -6.8, totalSd: 17};
        scenarios.push({...shape, icc, groups, clusterSize});
      }
    }
  }

  const cells = scenarios.map((scenario, index) => {
    const label = `margin mean=${scenario.mean} icc=${scenario.icc} G=${scenario.groups} m=${scenario.clusterSize}`;
    options.onCell?.(label, index, scenarios.length);

    const seed = cellSeed(analysisSeed, label);
    const random = createAgentRandom(seed);
    const betweenSd = scenario.totalSd * Math.sqrt(scenario.icc);
    const withinSd = scenario.totalSd * Math.sqrt(1 - scenario.icc);
    const primary = tally();
    const unclustered = tally();
    let estimable = 0;
    let designEffectTotal = 0;

    for (let replication = 0; replication < replications; replication++) {
      const sample = simulateClusteredContinuous({
        groups: scenario.groups,
        clusterSize: scenario.clusterSize,
        mean: scenario.mean,
        betweenSd,
        withinSd,
        random,
      });
      const estimate = meanEstimate(sample.clusters);
      if (isUnestimable(estimate)) {
        continue;
      }
      estimable++;
      designEffectTotal += estimate.design.designEffect;
      record(primary, estimate.ci95, scenario.mean);
      // The iid t interval on the same data: `sd/√n` on `n - 1` degrees of freedom.
      const half = 1.959964 * estimate.sd / Math.sqrt(estimate.n);
      record(unclustered, {low: estimate.mean - half, high: estimate.mean + half}, scenario.mean);
    }

    return {
      label,
      mean: scenario.mean,
      icc: scenario.icc,
      groups: scenario.groups,
      clusterSize: scenario.clusterSize,
      betweenSd,
      withinSd,
      analysisSeed: seed,
      replications,
      estimable,
      designEffect: {
        truth: 1 + (scenario.clusterSize - 1) * scenario.icc,
        meanEstimated: estimable === 0 ? 0 : designEffectTotal / estimable,
      },
      primary: resultOf(primary, estimable, band),
      unclustered: resultOf(unclustered, estimable, band),
    };
  });

  return {
    what: 'P2: coverage of the group-mean t interval for a continuous quantity (the VP margin), sized ' +
      'against the measured 2p and 3p margin scales of §2.3. The unclustered column is the negative control.',
    band,
    cells,
    summary: summarize(cells),
  };
}

// ---------------------------------------------------------------------------------------------
// P3: size, power, and the negative control
// ---------------------------------------------------------------------------------------------

export type SizeCell = {
  label: string;
  nullRate: number;
  icc: number;
  groups: number;
  clusterSize: number;
  mechanism: ClusterMechanism;
  analysisSeed: number;
  replications: number;
  estimable: number;
  alpha: number;
  /** The cluster-corrected one-sided test - what the pipeline ships. Must be <= alpha + MC error. */
  clustered: {rejections: number; size: number; withinNominal: boolean};
  /**
   * **The negative control.** The same test with no cluster correction. Its over-rejection at
   * ICC > 0 is the entire justification for the correction: a correction whose absence cannot be
   * shown to matter has not been justified.
   */
  unclustered: {rejections: number; size: number; inflationFactor: number};
  /** The upper Monte-Carlo bound on a nominal-alpha test at this replication count. */
  sizeUpperBound: number;
};

/**
 * Criterion P3's first half: **the empirical size of the one-sided threshold test under H0**, at
 * every ICC in the grid, with the unclustered test beside it.
 *
 * H0 is made exactly true by generating at the threshold - the data's marginal rate *is* the null -
 * so any rejection is a false positive by construction. The nominal size is 5% one-sided, and the
 * Monte-Carlo bound reported per cell is `alpha + 1.96·√(alpha(1-alpha)/R)`; at R = 2,000 that is
 * 5.96%.
 */
export function sizeGrid(options: GridOptions & {alpha?: number} = {}): {
  what: string;
  cells: ReadonlyArray<SizeCell>;
  summary: {cells: number; withinNominal: number; worst: {label: string; size: number} | undefined; meanUnclusteredInflation: number};
} {
  const replications = options.replications ?? REQUIRED_REPLICATIONS;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const alpha = options.alpha ?? 0.05;
  const sizeUpperBound = alpha + 1.959964 * Math.sqrt(alpha * (1 - alpha) / replications);

  // The thresholds the acceptance criteria are actually stated on: AC-7's gate (0.5), AC-2 (0.65)
  // and AC-3's two (0.80, 0.90). A size study at 0.5 only would leave every published AC threshold
  // untested, and the near-boundary behaviour at 0.90 is where a normal approximation is weakest.
  const scenarios: Array<{nullRate: number; icc: number; groups: number; clusterSize: number; mechanism: ClusterMechanism}> = [];
  for (const nullRate of [0.5, 0.65, 0.8, 0.9]) {
    for (const icc of P2_ICCS) {
      for (const clusterSize of P2_CLUSTER_SIZES) {
        for (const mechanism of CLUSTER_MECHANISMS) {
          scenarios.push({nullRate, icc, groups: 500, clusterSize, mechanism});
        }
      }
    }
  }

  const cells = scenarios.map((scenario, index) => {
    const label = `size p0=${scenario.nullRate} icc=${scenario.icc} G=${scenario.groups} m=${scenario.clusterSize} ${scenario.mechanism}`;
    options.onCell?.(label, index, scenarios.length);

    const seed = cellSeed(analysisSeed, label);
    const random = createAgentRandom(seed);
    let estimable = 0;
    let clustered = 0;
    let unclustered = 0;

    for (let replication = 0; replication < replications; replication++) {
      const sample = simulateClusteredBinary({
        groups: scenario.groups,
        clusterSize: scenario.clusterSize,
        rate: scenario.nullRate,
        icc: scenario.icc,
        mechanism: scenario.mechanism,
        random,
      });
      const test = thresholdTest(sample.clusters, {threshold: scenario.nullRate, hypothesis: label, alpha});
      if (isUnestimable(test)) {
        continue;
      }
      estimable++;
      if (test.rejected) {
        clustered++;
      }
      // The same z statistic with the design effect set to 1 - i.e. the interval and test the
      // runner's own game-level `wilson95` implies.
      const rows = test.design.rows;
      const standardError = Math.sqrt(scenario.nullRate * (1 - scenario.nullRate) / rows);
      if (normalUpperTail((test.observed - scenario.nullRate) / standardError) <= alpha) {
        unclustered++;
      }
    }

    const size = estimable === 0 ? 0 : clustered / estimable;
    const naiveSize = estimable === 0 ? 0 : unclustered / estimable;
    return {
      label,
      nullRate: scenario.nullRate,
      icc: scenario.icc,
      groups: scenario.groups,
      clusterSize: scenario.clusterSize,
      mechanism: scenario.mechanism,
      analysisSeed: seed,
      replications,
      estimable,
      alpha,
      clustered: {rejections: clustered, size, withinNominal: size <= sizeUpperBound},
      unclustered: {rejections: unclustered, size: naiveSize, inflationFactor: size === 0 ? 0 : naiveSize / size},
      sizeUpperBound,
    };
  });

  const worst = [...cells].sort((a, b) => b.clustered.size - a.clustered.size)[0];
  const clusteredCells = cells.filter((cell) => cell.icc > 0);
  return {
    what: 'P3: empirical size of the one-sided cluster-corrected threshold test under H0, at every ICC ' +
      'in the grid and at every threshold an acceptance criterion is stated on, with the unclustered ' +
      'test beside it as the negative control.',
    cells,
    summary: {
      cells: cells.length,
      withinNominal: cells.filter((cell) => cell.clustered.withinNominal).length,
      worst: worst === undefined ? undefined : {label: worst.label, size: worst.clustered.size},
      meanUnclusteredInflation: clusteredCells.length === 0 ?
        0 :
        clusteredCells.reduce((total, cell) => total + cell.unclustered.size, 0) / clusteredCells.length,
    },
  };
}

export type PermutationSizeCell = {
  label: string;
  icc: number;
  groups: number;
  clusterSize: number;
  mechanism: ClusterMechanism;
  analysisSeed: number;
  replications: number;
  permutationReplicates: number;
  alpha: number;
  size: number;
  withinNominal: boolean;
  sizeUpperBound: number;
};

/**
 * The group-level sign-flip randomization test's size (`stats.ts`'s {@link groupSignFlipTest}).
 *
 * Separate from {@link sizeGrid} because it is a different test with a different validity argument -
 * it assumes only that each group's centred statistic is symmetric about 0 under H0, which the
 * pairing design supplies by construction - and because it costs `permutationReplicates` sign flips
 * per replication, so it runs on a smaller grid.
 *
 * The `+1` in the p-value's numerator is what makes this test exact at its nominal level, and this
 * is the measurement that says so: without it the size lands near `alpha·(R+1)/R` and the excess is
 * exactly the observed statistic's own draw.
 */
export function permutationSizeGrid(options: GridOptions & {permutationReplicates?: number; alpha?: number} = {}): {
  what: string;
  cells: ReadonlyArray<PermutationSizeCell>;
} {
  const replications = options.replications ?? REQUIRED_REPLICATIONS;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const permutationReplicates = options.permutationReplicates ?? 499;
  const alpha = options.alpha ?? 0.05;
  const sizeUpperBound = alpha + 1.959964 * Math.sqrt(alpha * (1 - alpha) / replications);
  const groups = 100;

  const cells: Array<PermutationSizeCell> = [];
  for (const icc of P2_ICCS) {
    for (const clusterSize of P2_CLUSTER_SIZES) {
      for (const mechanism of CLUSTER_MECHANISMS) {
        const label = `permutation icc=${icc} G=${groups} m=${clusterSize} ${mechanism}`;
        options.onCell?.(label, cells.length, P2_ICCS.length * P2_CLUSTER_SIZES.length * CLUSTER_MECHANISMS.length);

        const seed = cellSeed(analysisSeed, label);
        const random = createAgentRandom(seed);
        let rejections = 0;
        let estimable = 0;
        for (let replication = 0; replication < replications; replication++) {
          // H0 for a head-to-head: the two identities are equally strong, so the per-group win rate
          // is centred on 0.5 and each group's centred statistic is symmetric about 0.
          const sample = simulateClusteredBinary({
            groups, clusterSize, rate: 0.5, icc, mechanism, random,
          });
          const groupMeans = sample.clusters.map((cluster) =>
            cluster.reduce((total, value) => total + value, 0) / cluster.length);
          const test = groupSignFlipTest(groupMeans, {
            centre: 0.5, hypothesis: label, replicates: permutationReplicates, random, alpha,
          });
          if (isUnestimable(test)) {
            continue;
          }
          estimable++;
          if (test.rejected) {
            rejections++;
          }
        }
        const size = estimable === 0 ? 0 : rejections / estimable;
        cells.push({
          label, icc, groups, clusterSize, mechanism,
          analysisSeed: seed,
          replications,
          permutationReplicates,
          alpha,
          size,
          withinNominal: size <= sizeUpperBound,
          sizeUpperBound,
        });
      }
    }
  }

  return {
    what: 'P3: empirical size of the group-level sign-flip randomization test under H0 (`stats.ts`). ' +
      'Its validity rests only on within-group symmetry, which the pairing design supplies.',
    cells,
  };
}

export type PowerCell = {
  label: string;
  trueRate: number;
  nullRate: number;
  designEffect: number;
  /** From `stats.ts`'s `requiredGames` - the calculator this cell is checking. */
  requiredGames: number;
  groups: number;
  clusterSize: number;
  games: number;
  icc: number;
  analysisSeed: number;
  replications: number;
  estimable: number;
  empiricalPower: number;
  /** The calculator's own prediction at exactly this sample size, from `stats.ts`'s `powerAt`. */
  calculatorPower: number;
  /** P3 requires these to agree within 2 pp. Reported so the reader sees the margin, not a boolean. */
  gap: number;
  withinTolerance: boolean;
};

/** P3's tolerance on "power agrees with the power calculator", pre-committed at 2 pp. */
export const POWER_TOLERANCE = 0.02;

/**
 * Criterion P3's second half: **the power calculator behind §2.5's tables is checked against a
 * simulation of the test it is a calculator for**.
 *
 * The design makes the check non-circular in the one way that matters. `requiredGames` computes N
 * from a normal approximation with the variance at the null; the simulation then *plays* that N
 * through the shipped {@link thresholdTest} against data whose true rate is known, and counts
 * rejections. If the approximation were wrong - or if the test's null variance did not match the
 * calculator's - the two would disagree, and the disagreement would show up here rather than in a
 * Milestone 4 sample-size decision that costs days of compute.
 *
 * The clustering is chosen so that the truth is exactly the design effect §2.5's tables assume:
 * `m = 2` with `ICC = 0.03` gives `deff = 1 + (2-1)·0.03 = 1.03` exactly, which is the measured 2p
 * figure the tables are computed at.
 */
export function powerGrid(options: GridOptions & {designEffect?: number} = {}): {
  what: string;
  tolerance: number;
  cells: ReadonlyArray<PowerCell>;
  summary: {cells: number; withinTolerance: number; worstGap: number};
} {
  const replications = options.replications ?? REQUIRED_REPLICATIONS;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const designEffect = options.designEffect ?? 1.03;
  const nullRate = 0.5;
  const clusterSize = 2;
  const icc = designEffect - 1;

  const cells = [0.65, 0.6, 0.55, 0.53, 0.52].map((trueRate, index, all) => {
    const needed = requiredGames({rate: trueRate, nullRate, designEffect});
    if (typeof needed !== 'number') {
      throw new Error(`the power calculator declined a §2.5 row: ${needed.reason}`);
    }
    const groups = requiredGroups(needed, clusterSize);
    const games = groups * clusterSize;
    const label = `power detect=${trueRate} n=${games} G=${groups} m=${clusterSize} icc=${icc.toFixed(4)}`;
    options.onCell?.(label, index, all.length);

    const seed = cellSeed(analysisSeed, label);
    const random = createAgentRandom(seed);
    let rejections = 0;
    let estimable = 0;
    for (let replication = 0; replication < replications; replication++) {
      const sample = simulateClusteredBinary({
        groups, clusterSize, rate: trueRate, icc, mechanism: 'beta-binomial', random,
      });
      const test = thresholdTest(sample.clusters, {threshold: nullRate, hypothesis: label});
      if (isUnestimable(test)) {
        continue;
      }
      estimable++;
      if (test.rejected) {
        rejections++;
      }
    }

    const empiricalPower = estimable === 0 ? 0 : rejections / estimable;
    const calculatorPower = powerAt(games, {rate: trueRate, nullRate, designEffect});
    return {
      label,
      trueRate,
      nullRate,
      designEffect,
      requiredGames: needed,
      groups,
      clusterSize,
      games,
      icc,
      analysisSeed: seed,
      replications,
      estimable,
      empiricalPower,
      calculatorPower,
      gap: empiricalPower - calculatorPower,
      withinTolerance: Math.abs(empiricalPower - calculatorPower) <= POWER_TOLERANCE,
    };
  });

  return {
    what: 'P3: empirical power of the shipped threshold test at the sample sizes §2.5\'s table prescribes, ' +
      'against the power calculator\'s own prediction at the same sample size. Clustering is m = 2 with ' +
      'ICC = 0.03, so the true design effect is exactly the 1.03 the tables assume.',
    tolerance: POWER_TOLERANCE,
    cells,
    summary: {
      cells: cells.length,
      withinTolerance: cells.filter((cell) => cell.withinTolerance).length,
      worstGap: Math.max(...cells.map((cell) => Math.abs(cell.gap))),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// P9: the two methodology hazards Milestone 3 is about to walk into
// ---------------------------------------------------------------------------------------------

export type OptionalStoppingResult = {
  what: string;
  nullRate: number;
  icc: number;
  clusterSize: number;
  groupsPerLook: number;
  maxGames: number;
  looks: number;
  alpha: number;
  analysisSeed: number;
  replications: number;
  /** The honest procedure: one test, at the pre-registered sample size. This is the 5% baseline. */
  singleLookSize: number;
  /** The dishonest one: reject the first time any look does. **This is the number for the write-up.** */
  anyLookSize: number;
  inflationFactor: number;
  /** Cumulative probability of having rejected by look `i`, so the shape of the leak is visible. */
  cumulativeByLook: ReadonlyArray<number>;
  /** The plan's pre-registered prediction (15-30%), so the write-up can report confirmed or refuted. */
  predictedRange: Interval;
  withinPrediction: boolean;
};

/**
 * **Hazard H7, half one: optional stopping**, measured rather than asserted.
 *
 * The procedure simulated is the one a person actually does: run the gate, look at the p-value every
 * 50 pairing groups, and stop the first time it crosses 0.05. Under H0 - the challenger is exactly
 * as strong as the incumbent - every one of those rejections is false. The single-look figure beside
 * it is the same data tested once at the end, which is what a pre-registered N buys.
 *
 * This is not a hypothetical for this project. Milestone 3 tunes evaluation weights *against harness
 * win rate*, and the temptation at 900 games with p = 0.06 is to run 200 more. The output of this
 * function is what turns "don't peek" from advice into a cost with a number on it, and it is why the
 * `gate` subcommand refuses a sample smaller than its pre-registered N.
 */
export function optionalStoppingStudy(options: GridOptions & {
  alpha?: number;
  groupsPerLook?: number;
  maxGames?: number;
  icc?: number;
} = {}): OptionalStoppingResult {
  const replications = options.replications ?? 10_000;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const alpha = options.alpha ?? 0.05;
  const groupsPerLook = options.groupsPerLook ?? 50;
  const maxGames = options.maxGames ?? 1_000;
  const clusterSize = 2;
  // The measured 2p figure: ICC 0.033 at m = 2 is a design effect of 1.033 (§2.3).
  const icc = options.icc ?? 0.033;
  const nullRate = 0.5;

  const maxGroups = Math.floor(maxGames / clusterSize);
  const looks = Math.floor(maxGroups / groupsPerLook);
  const label = `optional-stopping every ${groupsPerLook} groups to ${maxGames} games icc=${icc}`;
  options.onCell?.(label, 0, 1);
  const seed = cellSeed(analysisSeed, label);
  const random = createAgentRandom(seed);

  const rejectedAtLook = new Array<number>(looks).fill(0);
  let anyLook = 0;
  let singleLook = 0;

  for (let replication = 0; replication < replications; replication++) {
    const sample = simulateClusteredBinary({
      groups: maxGroups, clusterSize, rate: nullRate, icc, mechanism: 'beta-binomial', random,
    });
    let stopped = false;
    for (let look = 0; look < looks; look++) {
      const soFar = sample.clusters.slice(0, (look + 1) * groupsPerLook);
      const test = thresholdTest(soFar, {threshold: nullRate, hypothesis: label, alpha});
      if (isUnestimable(test)) {
        continue;
      }
      if (test.rejected && !stopped) {
        stopped = true;
        rejectedAtLook[look]++;
      }
      // The final look *is* the honest single test at the pre-registered N.
      if (look === looks - 1 && test.rejected) {
        singleLook++;
      }
    }
    if (stopped) {
      anyLook++;
    }
  }

  const anyLookSize = anyLook / replications;
  const cumulativeByLook: Array<number> = [];
  let running = 0;
  for (const count of rejectedAtLook) {
    running += count;
    cumulativeByLook.push(running / replications);
  }
  const predictedRange = {low: 0.15, high: 0.30};

  return {
    what: 'P9: the one-sided 5% false-positive rate under H0 when the gate is tested after every ' +
      `${groupsPerLook} pairing groups up to ${maxGames} games, against the same test run once at the end.`,
    nullRate,
    icc,
    clusterSize,
    groupsPerLook,
    maxGames,
    looks,
    alpha,
    analysisSeed: seed,
    replications,
    singleLookSize: singleLook / replications,
    anyLookSize,
    inflationFactor: singleLook === 0 ? 0 : anyLookSize / (singleLook / replications),
    cumulativeByLook,
    predictedRange,
    withinPrediction: anyLookSize >= predictedRange.low && anyLookSize <= predictedRange.high,
  };
}

export type SeedReuseResult = {
  what: string;
  variants: number;
  groups: number;
  clusterSize: number;
  games: number;
  trueRate: number;
  /** The shared per-group difficulty, on the logit scale: what one Engine seed does to every variant. */
  sharedSpread: number;
  /** The variant x seed interaction: the part of a variant's edge that is specific to these seeds. */
  interactionSd: number;
  analysisSeed: number;
  replications: number;
  /** Re-reporting the selected variant's win rate on the games it was selected on. The winner's curse. */
  reusedGames: number;
  /** Re-playing the *same seeds* with fresh agent noise. Only the interaction survives. */
  reusedSeeds: number;
  /** A disjoint seed block. The honest estimate, and unbiased by construction. */
  freshBlock: number;
  inflation: {reusedGames: number; reusedSeeds: number};
  predictedRange: Interval;
  withinPrediction: boolean;
};

/**
 * **Hazard H7, half two: seed reuse**, measured rather than asserted - and decomposed, because the
 * two halves of it call for different remedies.
 *
 * The procedure simulated is Milestone 3's, exactly: generate `variants` candidate agents that are
 * *all equally strong*, play each on one block of pairing groups, keep the best, and report its win
 * rate. Because the variants are identical by construction, every point of apparent edge is noise,
 * and three different ways of reporting it give three different numbers:
 *
 * - **`reusedGames`** - report the selected variant's rate on the games it was selected on. This is
 *   what "tune on the block, certify on the block" does, and it is a maximum of `k` noisy estimates,
 *   so it is biased upward by roughly `E[max of k standard normals] · SE`.
 * - **`reusedSeeds`** - re-play the same Engine seeds with fresh agent randomness. The sampling noise
 *   is gone but the **variant x seed interaction** is not: whatever it was about those deals that
 *   suited this variant still suits it. This is the number that says why re-running a gate on its own
 *   seed block after a change is not a gate (§3.8).
 * - **`freshBlock`** - a disjoint block. Unbiased, and the reason the seed-block allocation exists.
 *
 * The interaction term is the modelling choice worth arguing with, so it is a parameter and it is
 * reported: at `interactionSd = 0` the two reuse figures separate purely by sampling noise, and the
 * `reusedSeeds` inflation should collapse to zero. Running both is what distinguishes "reuse is bad
 * because of selection" from "reuse is bad because seeds have personalities".
 */
export function seedReuseStudy(options: GridOptions & {
  variants?: number;
  groups?: number;
  interactionSd?: number;
  sharedSpread?: number;
} = {}): SeedReuseResult {
  const replications = options.replications ?? 2_000;
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const variants = options.variants ?? 8;
  const groups = options.groups ?? 500;
  const clusterSize = 2;
  const interactionSd = options.interactionSd ?? 0.15;
  // Solved from the measured 2p ICC of 0.033 by the delta method: Var(logistic(σZ)) ≈ (σ/4)², so
  // σ ≈ 4√(0.033 · 0.25) = 0.363. Reported rather than hidden because it is an approximation, and
  // the realized design effect is what the coverage grid measures exactly.
  const sharedSpread = options.sharedSpread ?? 0.363;
  const trueRate = 0.5;

  const label = `seed-reuse k=${variants} G=${groups} interaction=${interactionSd}`;
  options.onCell?.(label, 0, 1);
  const seed = cellSeed(analysisSeed, label);
  const random = createAgentRandom(seed);

  let reusedGamesTotal = 0;
  let reusedSeedsTotal = 0;
  let freshBlockTotal = 0;

  for (let replication = 0; replication < replications; replication++) {
    // One block of pairing groups: a shared per-group difficulty, plus a per-(variant, group)
    // affinity that is a property of *these* seeds and does not transfer to another block.
    const difficulty = Array.from({length: groups}, () => sharedSpread * normal(random));
    const affinity = Array.from({length: variants}, () =>
      Array.from({length: groups}, () => interactionSd * normal(random)));

    const rates = affinity.map((own) => playBlock(difficulty, own, clusterSize, random));
    let best = 0;
    for (let variant = 1; variant < variants; variant++) {
      if (rates[variant] > rates[best]) {
        best = variant;
      }
    }

    reusedGamesTotal += rates[best];
    // Same seeds, same variant-specific affinity, fresh Bernoulli draws.
    reusedSeedsTotal += playBlock(difficulty, affinity[best], clusterSize, random);
    // A disjoint block: new difficulties, new affinities.
    const freshDifficulty = Array.from({length: groups}, () => sharedSpread * normal(random));
    const freshAffinity = Array.from({length: groups}, () => interactionSd * normal(random));
    freshBlockTotal += playBlock(freshDifficulty, freshAffinity, clusterSize, random);
  }

  const reusedGames = reusedGamesTotal / replications;
  const reusedSeeds = reusedSeedsTotal / replications;
  const freshBlock = freshBlockTotal / replications;
  const predictedRange = {low: 0.015, high: 0.03};
  const inflation = {reusedGames: reusedGames - freshBlock, reusedSeeds: reusedSeeds - freshBlock};

  return {
    what: `P9: selecting the best of ${variants} equally-strong variants on one ${groups}-group block, ` +
      'then reporting its win rate three ways: on the games it was selected on, on the same seeds ' +
      'with fresh agent randomness, and on a disjoint block.',
    variants,
    groups,
    clusterSize,
    games: groups * clusterSize,
    trueRate,
    sharedSpread,
    interactionSd,
    analysisSeed: seed,
    replications,
    reusedGames,
    reusedSeeds,
    freshBlock,
    inflation,
    predictedRange,
    withinPrediction: inflation.reusedGames >= predictedRange.low && inflation.reusedGames <= predictedRange.high,
  };
}

/** One variant's win rate over a block: `logistic(difficulty_g + affinity_g)` per group, `m` games each. */
function playBlock(
  difficulty: ReadonlyArray<number>,
  affinity: ReadonlyArray<number>,
  clusterSize: number,
  random: AgentRandom,
): number {
  let wins = 0;
  for (let group = 0; group < difficulty.length; group++) {
    // Log-odds of *this* variant beating the fixed incumbent on this seed. The opponent's rate is
    // `1 - rate` by construction, which is what makes a two-agent match zero-sum: a deal that
    // favours one side disfavours the other, and there is no third quantity to model.
    const rate = 1 / (1 + Math.exp(-(difficulty[group] + affinity[group])));
    for (let game = 0; game < clusterSize; game++) {
      if (random.next() < rate) {
        wins++;
      }
    }
  }
  return wins / (difficulty.length * clusterSize);
}

/** Box-Muller, matching `simulate.ts`'s convention (one normal per call, the second discarded). */
function normal(random: AgentRandom): number {
  const u = 1 - random.next();
  const v = random.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------------------------
// Adjudication
// ---------------------------------------------------------------------------------------------

export type CriterionVerdict = {
  criterion: 'P2' | 'P3' | 'P9';
  met: boolean;
  /** One line, with the number in it. A verdict with no number is an assertion. */
  statement: string;
};

/**
 * P2's verdict over the three coverage grids.
 *
 * **Under-coverage anywhere is a blocking failure** (§5, P2) - but "anywhere" has to be read against
 * the multiplicity stated at the top of this file: 96 + 48 + 16 cells at a 95% band produce ~8
 * excursions by chance. So a `fail` (outside the *pre-committed* [94.0%, 96.0%], which is already the
 * band widened by rounding) is a blocking failure; a `marginal` is reported and counted against
 * {@link expectedExcursions}. If the marginals cluster - one mechanism, one corner of the rate x ICC
 * grid, one direction of miss - that is a defect wearing a statistical disguise, and the per-cell
 * numbers in the artifact are what makes that visible.
 */
export function adjudicateP2(grids: ReadonlyArray<{what: string; summary: GridSummary}>): CriterionVerdict {
  const total = (pick: (summary: GridSummary) => number): number =>
    grids.reduce((sum, grid) => sum + pick(grid.summary), 0);
  const cells = total((summary) => summary.cells);
  const under = total((summary) => summary.failUnder);
  const over = total((summary) => summary.failOver);
  const outside = total((summary) => summary.observedOutsideBand);
  return {
    criterion: 'P2',
    // Under-coverage only. Over-coverage outside the band violates the letter of P2 and is reported
    // in the same sentence, but it is conservative - the fix for it is a *narrower* interval, which
    // is the direction that turns a safe estimator into an unsafe one, so it is Unit D's call and
    // not something this function should quietly pass or quietly block.
    met: under === 0,
    statement: `${cells} coverage cells: ${under} under-cover and ${over} over-cover the ` +
      'pre-committed [94.0%, 96.0%]; ' +
      `${outside} sit outside the ±1.96 Monte-Carlo band against ${expectedExcursions(cells).toFixed(1)} ` +
      'expected there by chance.',
  };
}

export function adjudicateP3(
  size: {cells: ReadonlyArray<SizeCell>},
  permutation: {cells: ReadonlyArray<PermutationSizeCell>},
  power: {cells: ReadonlyArray<PowerCell>; summary: {worstGap: number}},
): CriterionVerdict {
  const overSized = size.cells.filter((cell) => !cell.clustered.withinNominal);
  const overSizedPermutation = permutation.cells.filter((cell) => !cell.withinNominal);
  const outOfTolerance = power.cells.filter((cell) => !cell.withinTolerance);
  const control = size.cells.filter((cell) => cell.icc > 0);
  const worstControl = [...control].sort((a, b) => b.unclustered.size - a.unclustered.size)[0];
  return {
    criterion: 'P3',
    met: overSized.length === 0 && overSizedPermutation.length === 0 && outOfTolerance.length === 0,
    statement: `${overSized.length}/${size.cells.length} threshold-test cells and ` +
      `${overSizedPermutation.length}/${permutation.cells.length} permutation-test cells exceed nominal size; ` +
      `power agrees with the calculator to ${(power.summary.worstGap * 100).toFixed(1)} pp (tolerance 2 pp); ` +
      `the unclustered negative control reaches ${((worstControl?.unclustered.size ?? 0) * 100).toFixed(1)}% ` +
      'against a nominal 5%.',
  };
}

export function adjudicateP9(stopping: OptionalStoppingResult, reuse: SeedReuseResult): CriterionVerdict {
  return {
    criterion: 'P9',
    // P9 asks for two *measured figures*, not for them to land anywhere in particular - a refuted
    // prediction is a result, and bullet 2 published one. So the criterion is met when both
    // simulations produced a number with its procedure recorded; the predictions are reported beside.
    met: true,
    statement: `optional stopping: ${(stopping.anyLookSize * 100).toFixed(1)}% against a nominal ` +
      `${(stopping.alpha * 100).toFixed(0)}% (predicted 15-30%, ${stopping.withinPrediction ? 'confirmed' : 'REFUTED'}); ` +
      `best-of-${reuse.variants} seed reuse: +${(reuse.inflation.reusedGames * 100).toFixed(2)} pp on the ` +
      `selection games and +${(reuse.inflation.reusedSeeds * 100).toFixed(2)} pp on the same seeds replayed ` +
      `(predicted 1.5-3 pp, ${reuse.withinPrediction ? 'confirmed' : 'REFUTED'}).`,
  };
}
