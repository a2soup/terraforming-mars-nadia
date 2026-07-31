import {AgentRandom, createAgentRandom} from '../core/rng';
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
  ci95: Interval;
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
  return {
    replicates,
    usable: estimates.length,
    point,
    ci95: {low: percentile(estimates, 0.025), high: percentile(estimates, 0.975)},
  };
}

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
