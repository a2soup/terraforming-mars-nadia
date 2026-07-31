import {AgentRandom} from '../core/rng';
import {
  ClusterDesign,
  Interval,
  MarginDistribution,
  MeanEstimate,
  ProportionEstimate,
  ThresholdTest,
  Unestimable,
  isUnestimable,
  unestimable,
} from './types';

/**
 * The statistics core (Milestone 2, bullet 3, Unit A; agent/docs/Milestone2_Bullet3_Prompts.md
 * §3.1, §3.2, §2.5).
 *
 * **Everything here clusters on the pairing group.** Games in a group share an Engine seed, so
 * they share the board, the shuffles and the deal, and they are not independent draws. The
 * measured design effects on the committed self-play corpora - reproduced by criterion P4a - are:
 *
 * | | groups | m | design effect (win) | ICC | design effect (VP margin) |
 * | --- | --- | --- | --- | --- | --- |
 * | 2p | 500 | 2 | 1.033 | 0.033 | 1.043 |
 * | 3p | 100 | 6 | 1.252 | 0.050 | 1.516 |
 * | 4p | 25 | 4 | 1.293 | 0.098 | 1.184 |
 *
 * Read that as: at 2p the runner's game-level Wilson interval is about 1.6% too narrow, which is
 * negligible; at 3p it is 12% too narrow on the win rate and **23% too narrow on the margin**,
 * which is exactly where AC-5 lives. The correction is small, real, and anti-conservative in every
 * cell - and it is largest where the acceptance criteria are weakest. Both caveats belong with the
 * numbers: these are `random-legal` self-play, the *weakest possible* instrument for a seed effect,
 * and a directed agent should show a larger ICC because which cards the seed deals starts to
 * matter.
 *
 * **The design effect is not floored at 1** (§3.1). A blocked design legitimately produces
 * `deff < 1`, and flooring it without evidence hides that. A `deff` estimated below 1 from noise
 * *does* narrow the interval anti-conservatively, so this is not a free choice - it is a bet that
 * criterion P2's coverage grid settles. **P2's coverage at ICC = 0 is what decides whether
 * flooring is needed**; if it under-covers there, the fix is to floor and to record that as a
 * measured decision rather than a precaution. Unit C owns that measurement.
 *
 * **Nothing here ever returns `NaN`** (hazard H9). A quantity that cannot be estimated comes back
 * as {@link Unestimable} with the reason, because `NaN` serializes to `null` and a `null` in a
 * report is indistinguishable from a field nobody wrote.
 */

// ---------------------------------------------------------------------------------------------
// Clustering: the design effect and the ICC
// ---------------------------------------------------------------------------------------------

/**
 * The design effect, as the ratio of a **cluster-robust (linearization) variance** to the variance
 * an independent sample of the same size would have.
 *
 * For a ratio estimator `θ̂ = Σ_g s_g / Σ_g n_g` over `G` clusters, the linearized variance is
 *
 * ```
 * V_cluster = G / ((G - 1) · N²) · Σ_g (s_g - θ̂ · n_g)²        with N = Σ_g n_g
 * ```
 *
 * and the design effect is `V_cluster / V_independent`, where `V_independent` is `p(1-p)/N` for a
 * proportion and `s²/N` for a continuous quantity.
 *
 * **Why this form rather than "the variance of the group means".** Over balanced groups the two are
 * algebraically identical - with every `n_g = m` this reduces to `m · s²_between / V_independent`,
 * which is exactly the estimator §2.3's pre-registered table was computed with, and P4a checks that
 * to three significant figures. The general form is used anyway because a *pooled* observation set
 * need not have equal cluster sizes: pool a `greedy-vs-random` run with a self-play run and an
 * identity's rows per group differ between them. The group-mean form would then weight a 2-row
 * group like a 12-row one.
 *
 * **The degenerate case is an assumption, and it is labelled as one.** When every row is a success
 * (or every row a failure) the between-cluster variance is 0 *and* so is `p(1-p)`, so the design
 * effect is 0/0 and the ICC is unidentified - every value in [0, 1] is consistent with the data.
 * Reporting `deff = 1` would silently pick the anti-conservative end of that range, on data that
 * says nothing. This function picks the other end (`deff = m̄`, i.e. ICC = 1, i.e. the effective
 * sample size is the number of *groups*) and writes {@link ClusterDesign.note} saying so. That
 * regime is not hypothetical: `greedy-1ply@1` already wins 99.2%, and the first Milestone 3 agent
 * may well win 1,000/1,000 (hazard H3).
 *
 * **The mirror-image degenerate case is refused outright.** If every pairing group happens to have
 * the *same* mean while the rows still vary, the estimated between-group variance is 0, the design
 * effect is 0, and the interval collapses to zero width with a `NaN` p-value behind it. That is a
 * fact about the sample and never about the design, so it returns {@link Unestimable} rather than a
 * confident nothing.
 */
export function clusterDesign(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  independentVariance: (values: ReadonlyArray<number>, mean: number) => number,
): ClusterDesign | Unestimable {
  const groups = clusters.length;
  const rows = clusters.reduce((total, cluster) => total + cluster.length, 0);

  if (rows === 0) {
    return unestimable('no observations');
  }
  if (groups < 2) {
    return unestimable(`${groups} pairing group(s): a between-group variance needs at least 2 (§3.1)`);
  }

  const values = clusters.flat();
  const mean = sum(values) / rows;
  const meanClusterSize = rows / groups;

  const residualSquares = clusters.reduce((total, cluster) => {
    const residual = sum(cluster) - mean * cluster.length;
    return total + residual * residual;
  }, 0);
  const clusterVariance = groups / ((groups - 1) * rows * rows) * residualSquares;
  const independent = independentVariance(values, mean) / rows;

  if (independent <= 0) {
    // Degenerate: every value identical. The ICC is unidentified; take the conservative end.
    const designEffect = meanClusterSize;
    return {
      rows,
      groups,
      meanClusterSize,
      designEffect,
      icc: 1,
      effectiveN: groups,
      note: 'every observation identical, so the intra-cluster correlation is unidentified; ' +
        'the conservative end (ICC = 1, effective n = groups) is assumed, not estimated',
    };
  }

  if (clusterVariance <= 0) {
    // Every pairing group has exactly the same mean, so the *estimated* between-group variance is
    // zero. Left alone this produces `deff = 0`, an infinite effective n, a zero-width interval and
    // - via `(p̂ - p0) / 0` - a `NaN` p-value, which is hazard H9 arriving through the one door the
    // type system does not guard. It is a fact about the sample, never about the design, and the
    // honest output is that this estimator cannot produce an interval here. Found by
    // `test/rating/stats.spec.ts` on a perfectly blocked null, not in review.
    return unestimable(
      `all ${groups} pairing groups have the identical mean, so the between-group variance is 0; ` +
      'no cluster-robust interval exists for this sample (§3.1)');
  }

  const designEffect = clusterVariance / independent;
  return {
    rows,
    groups,
    meanClusterSize,
    designEffect,
    // With a mean cluster size of 1 there is no within-cluster pair for a correlation to describe.
    icc: meanClusterSize > 1 ? (designEffect - 1) / (meanClusterSize - 1) : 0,
    effectiveN: rows / designEffect,
  };
}

/** `V_independent` for a proportion: `p(1-p)`. */
function binomialVariance(_values: ReadonlyArray<number>, mean: number): number {
  return mean * (1 - mean);
}

/** `V_independent` for a continuous quantity: the sample variance of the individual values. */
function sampleVariance(values: ReadonlyArray<number>, mean: number): number {
  if (values.length < 2) {
    return 0;
  }
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
}

// ---------------------------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------------------------

const Z_975 = 1.959964;

/**
 * The Wilson score interval at 95%, parameterized by a **rate and a sample size** rather than by
 * two integer counts, because the sample size this pipeline uses is `n / deff` and is not an
 * integer.
 *
 * Identical to `match/runner.ts`'s `wilson95(successes, trials)` when `n = trials` and
 * `p = successes / trials`; `test/rating/stats.spec.ts` asserts that against the runner's own
 * function, so the two cannot drift.
 *
 * Wilson rather than a group-mean Wald or t interval, for a reason specific to this project: at
 * 99.2% - which is where `greedy-1ply@1` actually sits - a Wald interval runs off the end of
 * [0, 1], and that is the regime the baselines live in, not an edge case (§3.1).
 */
export function wilsonInterval(rate: number, n: number): Interval {
  const denominator = 1 + Z_975 * Z_975 / n;
  const centre = (rate + Z_975 * Z_975 / (2 * n)) / denominator;
  const half = Z_975 / denominator * Math.sqrt(rate * (1 - rate) / n + Z_975 * Z_975 / (4 * n * n));
  return {low: Math.max(0, centre - half), high: Math.min(1, centre + half)};
}

/**
 * A proportion over clustered data: the pooled point estimate, the design effect, and the
 * effective-n Wilson interval (§3.1).
 *
 * **The point estimate is the ordinary pooled one and the clustering never moves it.** Over
 * balanced groups every group has the same size, so the mean of the group means *is* the
 * game-level proportion - which is why every win rate published in `Match_Runner.md` and
 * `Baselines.md` stands unchanged and only the intervals are restated (§2.3).
 */
export function proportionEstimate(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
): ProportionEstimate | Unestimable {
  const design = clusterDesign(clusters, binomialVariance);
  if (isUnestimable(design)) {
    return design;
  }
  const values = clusters.flat();
  const successes = sum(values);
  const trials = values.length;
  const rate = successes / trials;
  return {
    estimable: true,
    successes,
    trials,
    rate,
    design,
    ci95: wilsonInterval(rate, design.effectiveN),
  };
}

/**
 * A continuous quantity over clustered data: the pooled mean with a **t interval on the
 * cluster-robust standard error**, on `groups - 1` degrees of freedom (§3.1).
 *
 * Over balanced groups this is exactly the group-mean t interval the plan asks for; the
 * cluster-robust form is used for the same reason as in {@link clusterDesign} - a pooled set need
 * not have equal cluster sizes.
 */
export function meanEstimate(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
): MeanEstimate | Unestimable {
  const design = clusterDesign(clusters, sampleVariance);
  if (isUnestimable(design)) {
    return design;
  }
  const values = clusters.flat();
  const n = values.length;
  const mean = sum(values) / n;
  const variance = sampleVariance(values, mean);

  const residualSquares = clusters.reduce((total, cluster) => {
    const residual = sum(cluster) - mean * cluster.length;
    return total + residual * residual;
  }, 0);
  const standardError = Math.sqrt(design.groups / ((design.groups - 1) * n * n) * residualSquares);
  const half = studentTQuantile(0.975, design.groups - 1) * standardError;

  return {
    estimable: true,
    n,
    mean,
    sd: Math.sqrt(variance),
    design,
    ci95: {low: mean - half, high: mean + half},
  };
}

/**
 * min / p5 / p50 / p95 / max, nearest-rank and uninterpolated, so every reported value is one that
 * was actually observed - the same convention as `legality/run.ts`'s `percentiles`, which is where
 * that reasoning is written down.
 *
 * Reported alongside every mean margin because a mean over a 26 VP standard deviation (the
 * measured 2p figure) is a nearly contentless statistic on its own (§3.2).
 */
export function marginDistribution(values: ReadonlyArray<number>): MarginDistribution | Unestimable {
  if (values.length === 0) {
    return unestimable('no observations');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(Math.max(Math.ceil(q * sorted.length) - 1, 0), sorted.length - 1)];
  return {min: sorted[0], p5: at(0.05), p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]};
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/**
 * The one-sided test `H0: p = threshold` against `H1: p > threshold`, cluster-corrected.
 *
 * **This is the shape every acceptance criterion in the SRS takes** - AC-2 (>= 65% vs the tuned
 * heuristic), AC-3 (>= 90% vs random and >= 80% vs greedy), AC-5 (first place above `seats/N`), and
 * AC-7's promotion gate. Not one criterion is stated as an Elo, which is why the rating never
 * enters a gate (§3.4).
 *
 * The null variance is `p0(1-p0) · deff / n`, taken **at the null** rather than at the observed
 * rate. That is what makes this test the exact inverse of {@link requiredGames}: the power
 * calculator's `z_α √(p0 q0)` term is this denominator, so criterion P3's "power agrees with the
 * calculator to within 2 pp" is a real check on both rather than a tautology on neither.
 */
export function thresholdTest(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  options: {threshold: number; hypothesis: string; alpha?: number},
): ThresholdTest | Unestimable {
  const alpha = options.alpha ?? 0.05;
  const estimate = proportionEstimate(clusters);
  if (isUnestimable(estimate)) {
    return estimate;
  }
  const {threshold} = options;
  if (threshold <= 0 || threshold >= 1) {
    return unestimable(`threshold ${threshold} is outside (0, 1), so the null variance is degenerate`);
  }
  const standardError = Math.sqrt(threshold * (1 - threshold) * estimate.design.designEffect / estimate.trials);
  const z = (estimate.rate - threshold) / standardError;
  const pValue = normalUpperTail(z);
  return {
    hypothesis: options.hypothesis,
    threshold,
    observed: estimate.rate,
    z,
    pValue,
    alpha,
    rejected: pValue <= alpha,
    design: estimate.design,
  };
}

export type PermutationTest = {
  hypothesis: string;
  observed: number;
  /** Sign-flip replicates drawn. The p-value's resolution is `1 / (replicates + 1)`. */
  replicates: number;
  pValue: number;
  alpha: number;
  rejected: boolean;
  groups: number;
};

/**
 * A **group-level randomization test**: the head-to-head comparison, done without assuming
 * anything about the shape of the within-group correlation.
 *
 * The exchangeable unit is the pairing group, not the game (§3.1), so the randomization has to
 * happen at that level. Under the null - the two identities are equally strong - the pairing
 * design makes each group's centred statistic symmetric about 0: the lineup plays every seat
 * permutation, so swapping the two identities' labels within a group is a relabelling of games
 * that were actually played. Flipping each group's sign independently therefore samples the null
 * distribution directly. Monte-Carlo over `replicates` draws rather than all `2^G`, seeded from
 * the analysis seed (§2.6, hazard H11).
 *
 * The p-value is `(1 + #{T* >= T}) / (replicates + 1)` - the `+1` is not a rounding convenience,
 * it is what keeps the test valid at its nominal level (the observed statistic is itself one draw
 * from the null under H0), and without it the test over-rejects at exactly the rate criterion P3
 * measures.
 */
export function groupSignFlipTest(
  groupValues: ReadonlyArray<number>,
  options: {centre: number; hypothesis: string; replicates: number; random: AgentRandom; alpha?: number},
): PermutationTest | Unestimable {
  const alpha = options.alpha ?? 0.05;
  const groups = groupValues.length;
  if (groups < 2) {
    return unestimable(`${groups} pairing group(s): a randomization test needs at least 2 (§3.1)`);
  }
  const centred = groupValues.map((value) => value - options.centre);
  const observed = sum(centred) / groups;

  let atLeastAsExtreme = 0;
  for (let replicate = 0; replicate < options.replicates; replicate++) {
    let total = 0;
    for (const value of centred) {
      total += options.random.next() < 0.5 ? -value : value;
    }
    if (total / groups >= observed) {
      atLeastAsExtreme++;
    }
  }

  const pValue = (1 + atLeastAsExtreme) / (options.replicates + 1);
  return {
    hypothesis: options.hypothesis,
    observed: observed + options.centre,
    replicates: options.replicates,
    pValue,
    alpha,
    rejected: pValue <= alpha,
    groups,
  };
}

// ---------------------------------------------------------------------------------------------
// Power and sample size (§2.5)
// ---------------------------------------------------------------------------------------------

export type PowerInputs = {
  /** The true rate to detect. */
  rate: number;
  /** The null. 0.5 for a head-to-head gate; 0.65 / 0.80 / 0.90 for AC-2 / AC-3. */
  nullRate: number;
  /** The clustering penalty. 1.03 is the measured 2p figure (§2.3); 1.25 at 3p, 1.29 at 4p. */
  designEffect: number;
  alpha?: number;
  power?: number;
};

/**
 * Games needed for a one-sided test at `alpha` to reach `power` against a true rate of `rate`.
 *
 * **This is the number that matters for later milestones, and it is arithmetic rather than
 * compute** (§2.5). At Milestone 4 a game at the exit-criterion search budget is on the order of
 * 230 decisions x ~1 s, so the 1,767 games needed to certify a 53% improvement is ~4.7 days
 * single-core - and the x8 core-scaling that would make it 14 hours is the multiplier bullet 1
 * could **not** verify (R7, still untested). From M4 onward the choice of N is a multi-day
 * commitment, so the honest options are "budget it" or "state a wider minimum detectable effect",
 * not "run 1,000 games because that is what we ran last time".
 *
 * **1,000 games - the sample every Milestone 2 claim so far has used - resolves a 4 pp edge and
 * nothing finer** ({@link minimumDetectableRate} at n = 1,000, deff 1.03: 54.0%).
 *
 * The normal-approximation formula, with the variance evaluated at the null for the size term and
 * at the alternative for the power term:
 *
 * ```
 * n = deff · (z_α √(p0 q0) + z_β √(p1 q1))² / (p1 - p0)²
 * ```
 *
 * **Reproducing §2.5's pre-registered table.** At deff = 1.03 this gives 69 / 158 / 635 / 1,767 /
 * 3,978 games to detect 65% / 60% / 55% / 53% / 52%. Four of those five match the plan's table
 * exactly; the 60% row differs by one game (158 here, 157 there) because the raw requirement is
 * 157.03 and the plan's throwaway script rounded to nearest where this rounds **up**. Rounding a
 * sample size down is wrong in the direction that matters - 157 games gives 79.9% power, not 80% -
 * so the discrepancy is recorded here rather than reproduced. Everything else in both of §2.5's
 * tables reproduces exactly.
 */
export function requiredGames(inputs: PowerInputs): number | Unestimable {
  const alpha = inputs.alpha ?? 0.05;
  const power = inputs.power ?? 0.8;
  const {rate, nullRate, designEffect} = inputs;

  if (rate <= nullRate) {
    return unestimable(`a rate of ${rate} is not above the null of ${nullRate}: there is no effect to detect`);
  }
  const zAlpha = normalQuantile(1 - alpha);
  const zBeta = normalQuantile(power);
  const numerator = (zAlpha * Math.sqrt(nullRate * (1 - nullRate)) + zBeta * Math.sqrt(rate * (1 - rate))) ** 2;
  return Math.ceil(designEffect * numerator / (rate - nullRate) ** 2);
}

/** Games rounded up to a whole number of pairing groups - a partly-played group is not a balanced sample. */
export function requiredGroups(games: number, permutationsPerGroup: number): number {
  return Math.ceil(games / permutationsPerGroup);
}

/**
 * The inverse of {@link requiredGames}: the smallest true rate a run of `games` games can detect at
 * the given power. Reproduces §2.5's second table exactly (200 -> 58.9%, 500 -> 55.6%,
 * 1,000 -> 54.0%, 2,000 -> 52.8%, 6,000 -> 51.6%, at deff 1.03).
 *
 * This is the honest thing to report when the sample size is fixed by a compute budget rather than
 * by a criterion, which from Milestone 4 onward it will be.
 */
export function minimumDetectableRate(
  games: number,
  inputs: Omit<PowerInputs, 'rate'>,
): number | Unestimable {
  if (games < 1) {
    return unestimable(`${games} games`);
  }
  let low = inputs.nullRate;
  let high = 0.999999;
  const needed = (rate: number): number => {
    const required = requiredGames({...inputs, rate});
    return typeof required === 'number' ? required : Number.POSITIVE_INFINITY;
  };
  if (needed(high) > games) {
    return unestimable(`${games} games cannot detect any effect at this power and design effect`);
  }
  for (let iteration = 0; iteration < 200; iteration++) {
    const mid = (low + high) / 2;
    if (needed(mid) > games) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

/** The power a run of `games` games actually has against `rate`. Used by criterion P3's cross-check. */
export function powerAt(games: number, inputs: PowerInputs): number {
  const alpha = inputs.alpha ?? 0.05;
  const {rate, nullRate, designEffect} = inputs;
  const zAlpha = normalQuantile(1 - alpha);
  const nullSe = Math.sqrt(nullRate * (1 - nullRate) * designEffect / games);
  const altSe = Math.sqrt(rate * (1 - rate) * designEffect / games);
  return 1 - normalCdf((nullRate + zAlpha * nullSe - rate) / altSe);
}

// ---------------------------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------------------------
//
// Implemented here rather than pulled in as a dependency: this project pins its dependencies and
// adding one for four special functions is a poor trade. Everything below is a standard algorithm
// with a standard accuracy claim, and `test/rating/stats.spec.ts` checks each against published
// values - a hand-rolled `erfc` that is quietly wrong in the tail would make every p-value in this
// pipeline wrong in a direction nobody would see, which is exactly this bullet's failure mode.

/**
 * `P(Z <= z)` for a standard normal. Full double precision via {@link erfc}, clamped to [0, 1]:
 * the composed rounding of `0.5 * (1 + Q(1/2, z²/2))` can land a few ulps outside, and a
 * "probability" of 1.0000000000000007 turns into a *negative* tail the moment anyone subtracts it.
 */
export function normalCdf(z: number): number {
  return Math.min(1, Math.max(0, 0.5 * erfc(-z / Math.SQRT2)));
}

/** `P(Z > z)`. Computed directly rather than as `1 - normalCdf(z)` so the far tail keeps its digits. */
export function normalUpperTail(z: number): number {
  return Math.min(1, Math.max(0, 0.5 * erfc(z / Math.SQRT2)));
}

/** The standard normal quantile. Acklam's rational approximation, refined by one Halley step. */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    throw new Error(`normalQuantile requires 0 < p < 1, got ${p}`);
  }
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const low = 0.02425;

  let x: number;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  const error = normalCdf(x) - p;
  const density = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const u = error / density;
  return x - u / (1 + x * u / 2);
}

/**
 * The Student-t quantile, by bisection on the CDF. Slower than a closed form and used a handful of
 * times per report, where the alternative is a table of magic constants nobody can check.
 */
export function studentTQuantile(p: number, df: number): number {
  if (df < 1) {
    throw new Error(`studentTQuantile requires df >= 1, got ${df}`);
  }
  if (p <= 0 || p >= 1) {
    throw new Error(`studentTQuantile requires 0 < p < 1, got ${p}`);
  }
  if (p < 0.5) {
    return -studentTQuantile(1 - p, df);
  }
  let low = 0;
  let high = 1e6;
  for (let iteration = 0; iteration < 200; iteration++) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, df) < p) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

/** `P(T <= t)` for `df` degrees of freedom, via the regularized incomplete beta. */
export function studentTCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedIncompleteBeta(df / 2, 0.5, x);
  return t >= 0 ? 1 - tail : tail;
}

/** `erfc(x)`, via the regularized incomplete gamma. Relative accuracy ~1e-14. */
function erfc(x: number): number {
  return x >= 0 ? incompleteGammaQ(0.5, x * x) : 1 + incompleteGammaP(0.5, x * x);
}

/** `P(a, x)`: series below the crossover, the continued fraction's complement above it. */
function incompleteGammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) {
    throw new Error(`incompleteGammaP requires a > 0 and x >= 0, got a=${a} x=${x}`);
  }
  if (x === 0) {
    return 0;
  }
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
}

/** `Q(a, x) = 1 - P(a, x)`, computed on whichever side keeps its digits. */
function incompleteGammaQ(a: number, x: number): number {
  if (x === 0) {
    return 1;
  }
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

function gammaSeries(a: number, x: number): number {
  let term = 1 / a;
  let total = term;
  for (let n = 1; n < 1000; n++) {
    term *= x / (a + n);
    total += term;
    if (Math.abs(term) < Math.abs(total) * 1e-16) {
      break;
    }
  }
  return total * Math.exp(-x + a * Math.log(x) - lnGamma(a));
}

/** Lentz's modified continued fraction for `Q(a, x)`. */
function gammaContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = b + an / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) {
      break;
    }
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** `I_x(a, b)`, the regularized incomplete beta, by Lentz's continued fraction. */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  // The continued fraction converges quickly only on one side of the symmetry point; reflect when
  // it would not, using I_x(a,b) = 1 - I_{1-x}(b,a).
  if (x >= (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(b, a, 1 - x);
  }
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return front * betaContinuedFraction(a, b, x) / a;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) {
    d = tiny;
  }
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) {
      d = tiny;
    }
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) {
      c = tiny;
    }
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) {
      break;
    }
  }
  return h;
}

/** `ln Γ(z)`, Lanczos approximation (g = 7, n = 9). Accurate to ~1e-15 for `z > 0`. */
export function lnGamma(z: number): number {
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection, so the approximation is only ever evaluated where it is accurate.
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  const x = z - 1;
  let series = coefficients[0];
  for (let i = 1; i < 9; i++) {
    series += coefficients[i] / (x + i);
  }
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(series);
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}
