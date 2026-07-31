import {AgentRandom, createAgentRandom} from '../core/rng';
import {normalCdf, normalQuantile} from './stats';
import {DEFAULT_BOOTSTRAP_REPLICATES, Interval, Unestimable, unestimable} from './types';

/**
 * The seeded cluster bootstrap (Milestone 2, bullet 3, Unit A;
 * agent/docs/Milestone2_Bullet3_Prompts.md §3.1, §2.6, hazard H11).
 *
 * **What it is for.** Every proportion and every mean in this pipeline gets two intervals: the
 * effective-n Wilson or group-mean t interval from `stats.ts` (primary), and the percentile
 * interval from this module (cross-check). Criterion P4b requires them to agree within 0.5 pp on
 * both bounds on every real corpus. That is not belt-and-braces: two estimators built from the same
 * wrong assumption can both miscover, but two estimators *disagreeing* is unambiguous, and finding
 * that out on real corpora costs seconds.
 *
 * **Whole groups are resampled, never games** (§3.1). Resampling games would destroy exactly the
 * dependence the interval is supposed to account for and reproduce the too-narrow interval it is
 * meant to check.
 *
 * **Where the randomness comes from, and where it does not.** There are two seeds in this project -
 * the Engine seed and the Agent seed - and `agent/CLAUDE.md` §6 is explicit that the M4 seed
 * contract is settled and no third seed goes into `core/rng.ts`. A bootstrap needs a reproducible
 * stream and is neither: it touches no game and influences no move. So `rating/` takes an
 * **analysis seed**, builds its stream with the existing {@link createAgentRandom}, keeps it
 * entirely inside this module tree, and records it in every report. `core/rng.ts` is untouched.
 *
 * **Do not construct `SeededRandom` directly.** Its integer-seed constructor is degenerate - every
 * integer seed emits the identical stream, because `currentSeed = Math.floor(seed * 2**32)` is 0 in
 * the low 32 bits mulberry32 actually uses. `createAgentRandom` already works around it; that
 * finding cost a session in Milestone 1 (Running Notes, 2026-07-22) and the structural guard in
 * `test/determinism/rngSeparation.spec.ts` is what keeps it from being rediscovered.
 *
 * ---
 *
 * **What the calibration study found about this module, and what changed as a result** (Unit D,
 * 31 Jul 2026; `docs/data/rating_validation.json` → `p2.bootstrap`, and §3 of
 * `docs/Rating_Pipeline.md`). One defect, and one decision that had to be measured twice:
 *
 * 1. **At a boundary the percentile bootstrap does not degrade, it collapses.** At p = 0.99 over
 *    50 groups × 2 the study measured coverage of **0.60-0.64**, and the cause is exact rather than
 *    statistical: `0.99^100 = 36.6%` of samples contain no failure at all, every resample of an
 *    all-success sample is all-success, and the percentile interval is `[1, 1]` - a zero-width
 *    interval, stated with confidence, that excludes the truth. `1 − 0.366 = 0.634` is the measured
 *    coverage to three decimals. **That is the regime this project's baselines occupy**
 *    (`greedy-1ply@1` wins 98.8-99.2%), so it is not an edge case here. {@link clusterBootstrap} now
 *    refuses: an all-identical resample distribution returns {@link Unestimable}. The consequence is
 *    stated plainly rather than hidden - **above ~99% there is no independent cross-check on the
 *    primary interval**, and criterion P4b cannot be evaluated there.
 * 2. **The bias correction transfers from a rating gap to a proportion - but only at the shipped
 *    resample count, and finding that out took measuring the same question twice.** Unit B measured
 *    {@link biasCorrectedQuantiles} worth 2 pp of coverage on a Bradley-Terry gap (mis-placed, not
 *    too narrow - the widths agreed to 1%). Applying it to the proportion bootstrap was measured on
 *    the coverage grid as it then stood, at **B = 200**, and appeared to make things *worse*: 0.9418
 *    plain against 0.9380 corrected below p = 0.99. On that evidence the module quoted the plain
 *    interval. Re-running the same grid at the **shipped B = 2,000** reverses it: **0.9497 plain with
 *    5 under-covering cells, against 0.9523 corrected with none.** The first answer was an artifact
 *    of the study's own under-resampling, which is precisely the effect Unit B had already recorded
 *    one level down ("a 2.5% quantile from 200 draws is the fifth order statistic"), arriving again
 *    where it was being used to *make* a decision rather than to report one. The correction is
 *    applied; {@link BootstrapResult.percentileCi95} keeps the alternative visible.
 *
 * **The moral is not about bias correction.** It is that a study measuring a configuration nobody
 * ships can decide a question the wrong way while looking exactly like a study that decided it. The
 * grid runs at {@link DEFAULT_BOOTSTRAP_REPLICATES} for that reason, not for tidiness.
 *
 * **What is still true after both: the cross-check is mildly anti-conservative at 50 pairing groups**
 * (0.9523 over the p <= 0.9 cells, against 0.9503 for the effective-n Wilson interval it checks). It
 * is a cross-check, not a primary interval, and **must not be quoted on its own**. At 500 groups -
 * the sample size every 2p claim in this project is made at - the two agree to a fraction of a
 * point.
 */

/**
 * The analysis RNG. A thin, named wrapper so that "which seed is this?" has a one-word answer at
 * every call site, and so a `grep` for the analysis stream finds one function.
 */
export function analysisRandom(analysisSeed: number): AgentRandom {
  return createAgentRandom(analysisSeed);
}

export type BootstrapOptions = {
  replicates?: number;
  random: AgentRandom;
};

export type BootstrapResult = {
  replicates: number;
  /** Replicates on which the statistic was estimable. Fewer than `replicates` is itself a finding. */
  usable: number;
  /** The **bias-corrected** percentile interval - the one to quote (see {@link biasCorrectedQuantiles}). */
  ci95: Interval;
  /**
   * The plain 2.5%/97.5% percentile interval on the same resamples, kept as a diagnostic.
   *
   * The difference between this and {@link ci95} is how far the bias correction moved the interval,
   * which is worth being able to read: it is one of the four named causes criterion P4b's
   * Wilson-vs-bootstrap gap decomposes into (`test/rating/bootstrap.spec.ts`), and a large shift
   * means the resampling distribution is skewed enough to be worth looking at rather than a fact to
   * be quietly absorbed.
   */
  percentileCi95: Interval;
  /** The statistic on the original sample, for the P4b comparison against the primary interval. */
  point: number;
};

/**
 * Resamples whole clusters with replacement and returns the percentile interval of `statistic`.
 *
 * Generic in the cluster element so Unit B can pass the same resamples through a Bradley-Terry
 * refit (§3.3 takes rating intervals from exactly this, and deliberately not from the Hessian: the
 * near-separated regime this pool occupies is where the asymptotic normal approximation is worst).
 *
 * A resample on which `statistic` returns `undefined` - an identity that happens to be absent from
 * every drawn cluster, say - is skipped and counted rather than turned into a `NaN` that would
 * poison the quantiles (hazard H9). If too few resamples are usable the result is
 * {@link Unestimable} with that count in the reason.
 *
 * The quantiles are **bias-corrected**, with the plain percentile interval kept beside them as
 * {@link BootstrapResult.percentileCi95}; an all-identical resample distribution is refused rather
 * than collapsed to a zero-width interval. The measurements behind both are in this module's header.
 */
export function clusterBootstrap<T>(
  clusters: ReadonlyArray<ReadonlyArray<T>>,
  statistic: (resample: ReadonlyArray<ReadonlyArray<T>>) => number | undefined,
  options: BootstrapOptions,
): BootstrapResult | Unestimable {
  const replicates = options.replicates ?? DEFAULT_BOOTSTRAP_REPLICATES;
  if (clusters.length < 2) {
    return unestimable(`${clusters.length} pairing group(s): a cluster bootstrap needs at least 2 (§3.1)`);
  }
  const point = statistic(clusters);
  if (point === undefined) {
    return unestimable('the statistic is not estimable on the original sample');
  }

  const estimates: Array<number> = [];
  const resample: Array<ReadonlyArray<T>> = new Array(clusters.length);
  for (let replicate = 0; replicate < replicates; replicate++) {
    for (let i = 0; i < clusters.length; i++) {
      resample[i] = clusters[options.random.nextInt(clusters.length)];
    }
    const estimate = statistic(resample);
    if (estimate !== undefined && Number.isFinite(estimate)) {
      estimates.push(estimate);
    }
  }

  if (estimates.length < Math.max(2, replicates / 2)) {
    return unestimable(
      `only ${estimates.length} of ${replicates} bootstrap resamples produced an estimate; ` +
      'the statistic is too often undefined on this sample for a percentile interval to mean anything');
  }

  estimates.sort((a, b) => a - b);

  // The boundary collapse (see the module header). Every resample agreeing is not a narrow interval,
  // it is no interval: the resampling distribution of a statistic pinned at the edge of its range
  // carries no information about where the truth is, and `[1, 1]` asserts that it is exactly 1. The
  // study measured what shipping that costs - 0.60-0.64 coverage at p = 0.99 - and this is the
  // refusal it bought. Deliberately checked on the *resamples* rather than on `point`, so it also
  // catches a statistic that is constant for a reason nobody anticipated.
  if (estimates[0] === estimates[estimates.length - 1]) {
    return unestimable(
      `all ${estimates.length} bootstrap resamples returned the identical value ${estimates[0]}: ` +
      'the statistic is at the boundary of its range and the percentile bootstrap has no interval ' +
      'here (see rating/bootstrap.ts). The primary interval stands; it simply has no cross-check.');
  }

  const [lowQuantile, highQuantile] = biasCorrectedQuantiles(estimates, point);
  return {
    replicates,
    usable: estimates.length,
    point,
    ci95: {low: percentile(estimates, lowQuantile), high: percentile(estimates, highQuantile)},
    percentileCi95: {low: percentile(estimates, 0.025), high: percentile(estimates, 0.975)},
  };
}

/**
 * The bias-correction (`BC`) quantiles: where in the sorted resample distribution to read the
 * interval off, given how much of that distribution falls below the point estimate.
 *
 * **Why not the plain 2.5%/97.5% percentiles.** Unit B measured the plain percentile interval on a
 * rating gap at 92.5% coverage against a nominal 95%, over 200 replications of a five-identity round
 * robin. The interval was **mis-placed, not too narrow** - widths agreed to within 1% - so widening
 * it would have bought the coverage without fixing anything, which is exactly the shortcut §3.9 and
 * Unit D's brief are written against. Bias correction restored 94.5%.
 *
 * **The acceleration term (`BCa`) is not implemented.** It costs a jackknife - one refit per pairing
 * group, 500 extra fits on the 2p corpus - for a measured difference of 0.3 Elo on a 167 Elo
 * interval. If a deeper ladder with very unequal sample sizes finds a regime where the skew is
 * worse, the jackknife goes here, behind this same function.
 *
 * Moved here from `bradleyTerry.ts` by Unit D so that the rating interval and the proportion
 * cross-check share one implementation: they were fixed for the same reason by two different units,
 * and two copies of a correction is two things to get out of step.
 */
export function biasCorrectedQuantiles(sortedDraws: ReadonlyArray<number>, point: number): [number, number] {
  const below = sortedDraws.filter((draw) => draw < point).length;
  // Clamped to the half-integer positions the sample can actually resolve, so an all-above or
  // all-below bootstrap gives a large finite correction rather than an infinite one.
  const fraction = Math.min(Math.max(below / sortedDraws.length, 0.5 / sortedDraws.length),
    1 - 0.5 / sortedDraws.length);
  const z0 = normalQuantile(fraction);
  const adjust = (z: number): number => Math.min(Math.max(normalCdf(2 * z0 + z), 1e-4), 1 - 1e-4);
  return [adjust(-Z_975), adjust(Z_975)];
}

const Z_975 = 1.959964;

/**
 * The percentile bootstrap interval for a proportion over clustered 0/1 rows - the cross-check
 * `stats.ts`'s effective-n Wilson interval is compared against (P4b).
 */
export function bootstrapProportion(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  options: BootstrapOptions,
): BootstrapResult | Unestimable {
  return clusterBootstrap(clusters, meanOfAll, options);
}

/** The percentile bootstrap interval for a continuous quantity over clustered rows. */
export function bootstrapMean(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  options: BootstrapOptions,
): BootstrapResult | Unestimable {
  return clusterBootstrap(clusters, meanOfAll, options);
}

function meanOfAll(resample: ReadonlyArray<ReadonlyArray<number>>): number | undefined {
  let total = 0;
  let count = 0;
  for (const cluster of resample) {
    for (const value of cluster) {
      total += value;
      count++;
    }
  }
  return count === 0 ? undefined : total / count;
}

/**
 * Linear-interpolated quantile of a sorted array (the `numpy.percentile` default). Interpolated,
 * unlike `legality/run.ts`'s nearest-rank `percentiles`, and for the opposite reason: there the
 * point was that every reported value is one actually observed, whereas here the array holds
 * bootstrap replicates, which are not observations of anything and whose granularity is an artifact
 * of the replicate count.
 */
function percentile(sorted: ReadonlyArray<number>, q: number): number {
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/**
 * How far apart two intervals are, on their worst bound. Criterion P4b is stated on this: the
 * effective-n Wilson interval and the cluster bootstrap must agree within 0.5 pp on **both**
 * bounds on every real corpus, and a larger gap is a finding to investigate rather than a footnote.
 */
export function intervalDisagreement(a: Interval, b: Interval): number {
  return Math.max(Math.abs(a.low - b.low), Math.abs(a.high - b.high));
}
