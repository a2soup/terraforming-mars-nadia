import {AgentRandom} from '../core/rng';
import {biasCorrectedQuantiles} from './bootstrap';
import {ELO_PER_LOGIT} from './simulate';
import {
  DEFAULT_BOOTSTRAP_REPLICATES,
  Identity,
  Observation,
  Unestimable,
  unestimable,
} from './types';

/**
 * The pairwise rating fit (Milestone 2, bullet 3, Unit B;
 * agent/docs/Milestone2_Bullet3_Prompts.md §3.3, §3.4, hazard H3).
 *
 * **What FR-14's "Elo/TrueSkill" is discharged by, and what it is not.** The slash is a family, not
 * two requirements. This module fits **Bradley-Terry by maximum a posteriori** - one latent strength
 * per identity, a weak zero-mean Gaussian prior on the strengths - and presents the result on the
 * Elo scale (`400 / ln 10` per logit) with `random-legal@1` anchored at 0. `plackettLuce.ts` is the
 * same latent strength fitted over 3-4p placements. Two things are deliberately absent:
 *
 * - **No online Elo with a K-factor.** It is order-dependent, so re-analysing the same artifacts in
 *   a different order gives a different answer - which breaks the reproducibility the whole harness
 *   exists to provide - and it produces no interval. Its one advantage, tracking a player whose
 *   strength drifts, does not apply: an agent version is frozen by definition (`registry.ts` - bump
 *   the version whenever the move distribution can change).
 * - **No TrueSkill.** Its value is online updating over a large, continuously changing ladder with
 *   partial information. This project has a handful of frozen versions and complete match records,
 *   and re-fitting a MAP model over everything takes milliseconds. Worse, TrueSkill's sigma is the
 *   width of an approximate-message-passing posterior, and treating it as a confidence interval is
 *   exactly the unvalidated claim this bullet exists to prevent - whereas a bootstrap interval
 *   around a MAP fit can be, and is, coverage-tested (criterion P5). If a later milestone needs
 *   online updates over a large pool, TrueSkill goes behind this module's interface.
 *
 * ## The three things that are easy to get wrong here
 *
 * **1. Separation (hazard H3) is live today, not hypothetical.** `greedy-1ply@1` wins 98.8% of this
 * bullet's own 2p corpus and 99.2% of bullet 2's, and the first Milestone 3 agent may well win
 * 1,000/1,000 - at which point the *unregularized* Bradley-Terry MLE diverges. The failure mode is
 * not a crash. A naive implementation returns `Infinity`, `NaN`, or - worst of the three, because it
 * looks like an answer - a large finite number with a symmetric interval around it. The prior makes
 * the point estimate finite; the *interval* must still tell the truth, so this module detects
 * separation **structurally** (see {@link boundedness}) and reports a one-sided bound with an
 * explicitly `null` end. {@link assertFinite} enforces the rest in the code, not only in tests.
 *
 * **2. The interval comes from the cluster bootstrap, never from the Hessian.** §3.3 is explicit,
 * and the reason is this pool specifically: the near-separated regime it occupies is where the
 * asymptotic normal approximation is worst. The Hessian is computed anyway, but only for the
 * shrinkage diagnostic below - it never becomes a standard error. The bootstrap interval is
 * **bias-corrected** rather than a plain percentile, and {@link biasCorrectedQuantiles} carries the
 * coverage measurement that forced that - a plain percentile interval covers 92.5% where it should
 * cover 95%, and it is mis-placed rather than too narrow.
 *
 * **3. With two agents the Elo is the win rate, monotonically transformed** (§2.4, §3.4). It carries
 * no additional information, and the write-up has to say so next to the number. The rating earns its
 * keep only as the pool grows, and **the gate is never a rating**: every acceptance criterion in the
 * SRS - AC-2, AC-3, AC-5, AC-7 - is a rate with a threshold, and a pool rating borrows strength
 * across the whole comparison graph, so a new agent's rating can move because some *other* pair was
 * played. Useful for ranking a ladder; disqualifying for a gate.
 */

// ---------------------------------------------------------------------------------------------
// Scale, anchor, prior
// ---------------------------------------------------------------------------------------------

export {ELO_PER_LOGIT};

/**
 * The identity anchored at 0 Elo (§3.3). `random-legal@1` because it is the project's fixed floor:
 * frozen since Milestone 1, seated in every corpus, and the only identity guaranteed to still be in
 * the pool at Milestone 6.
 *
 * **The anchor-relative scale loses resolution as soon as everything beats random 100% of the time**
 * (§3.4). That is not a reason to move the anchor - a moving anchor makes two ladder entries written
 * a year apart incomparable - it is the reason every rating is also reported relative to its
 * *immediate predecessor*, which is where the information actually is once the pool is deep.
 */
export const PREFERRED_ANCHOR: Identity = 'random-legal@1';

/**
 * The prior's standard deviation on each latent strength, in logits. **Pre-committed here and
 * reported in every fit**, per §3.3.
 *
 * 4 logits is ~695 Elo, so an identity one prior standard deviation from the pool mean is 695 Elo
 * from it. That is weak against the ~837 Elo gap the two baselines already show (§2.4): the prior
 * cannot manufacture that headline, and the measured shrinkage on the real 2p corpus is 0.3% of the
 * gap (reported per rating by {@link contrastShrinkage}). It is strong enough to keep a
 * *fully* separated pair finite - at 1,000 games with no counter-example the MAP gap settles near
 * 8.2 logits (~1,420 Elo) rather than running away - which is the point of having one at all.
 *
 * Changing this number changes every rating in the ladder, so it is a constant with a name rather
 * than a default buried in an options object.
 */
export const DEFAULT_PRIOR_SIGMA = 4;

/**
 * Convergence tolerance on the **Newton decrement**, `gradᵀ (L + I/sigma²)^-1 grad / 2` - an estimate
 * of how much log-posterior is left to gain, in the units of the objective itself.
 *
 * Deliberately not a tolerance on the raw gradient. A gradient test needs a scale, and this
 * objective has no fixed one: a 1,000-game log-likelihood is a few hundred nats while a 25-game one
 * is a few dozen, so any absolute gradient threshold is either unreachable on the large corpus or
 * met prematurely on the small one. **Measured**: with a 1e-10 gradient test the 2p fit ran all 200
 * iterations without ever declaring convergence, spending ~40 wasted backtracking evaluations on
 * each of the last 190, at 350 ms per fit - which at 2,000 bootstrap refits is twelve minutes for a
 * number that was correct to 15 digits after the sixth iteration. The decrement test converges the
 * same fit in 3 iterations and 0.4 ms.
 *
 * **Relative to the objective's own magnitude, and that too was measured rather than assumed.** An
 * absolute 1e-14 looks tighter and is in fact unreachable: a 1,000-game log-posterior is around -500
 * nats, so double precision resolves it to ~1e-13, and an Armijo test on a decrement below that is
 * comparing rounding noise - the fit then runs out of backtracking and reports `converged: false` on
 * an answer that was correct to twelve digits. At 1e-12 x |value| the 2p corpus stops with a
 * gradient residual around 1e-4, which is under 0.002 Elo of unclaimed improvement: four orders of
 * magnitude below anything this pipeline prints.
 */
const NEWTON_TOLERANCE = 1e-12;

/**
 * The decrement below which a *failed* backtracking search still counts as convergence.
 *
 * A strictly concave objective with a positive-definite Hessian always has an ascent direction
 * unless the optimum has been reached to within floating-point resolution, so backtracking that
 * bottoms out is almost always the second thing rather than the first. Distinguishing them matters:
 * `converged: false` is a real signal and must not be spent on arithmetic noise.
 */
const NEWTON_STALL_TOLERANCE = 1e-6;

// ---------------------------------------------------------------------------------------------
// Bounds and gaps
// ---------------------------------------------------------------------------------------------

/**
 * An Elo interval in which **an unbounded end is `null`, never `Infinity` and never a plausible
 * finite number** (hazard H3, criterion P5).
 *
 * `Infinity` serializes to `null` through `JSON.stringify` and is then indistinguishable from a
 * field nobody wrote - the same trap `Unestimable` exists for on the `NaN` side (hazard H9). Here
 * the `null` is deliberate and always accompanied by {@link unbounded}, which says which end and
 * why, so a reader can never mistake "the data cannot bound this above" for "we did not compute it".
 */
export type EloBounds = {
  low: number | null;
  high: number | null;
  /** Present iff `low` or `high` is `null`. */
  unbounded?: {end: 'above' | 'below' | 'both'; reason: string};
};

/** One identity's strength relative to another, on the Elo scale. */
export type EloGap = {
  subject: Identity;
  reference: Identity;
  /**
   * Elo. **Always finite**, including under separation - that is what the prior buys. A finite point
   * estimate beside an unbounded interval end is the honest output; a finite point estimate beside a
   * symmetric interval is the failure P5 tests for.
   */
  elo: number;
  ci95: EloBounds;
  /** Bootstrap resamples on which both identities appeared and the refit converged. */
  usableReplicates: number;
  /** Absent when no bootstrap was run: then `ci95` is `{low: null, high: null}` with a reason. */
  replicates?: number;
};

// ---------------------------------------------------------------------------------------------
// The comparison set
// ---------------------------------------------------------------------------------------------

/**
 * One pairing group's aggregated pairwise record, in canonical `i < j` order.
 *
 * **Aggregated, because the bootstrap refits 2,000 times.** A resample that carried individual games
 * would cost `groups x games-per-group` work per replicate; carrying per-cluster sufficient
 * statistics makes a refit cost `iterations x identities²` regardless of how many games are behind
 * it. The Bradley-Terry likelihood depends on the data only through these counts, so nothing is lost.
 */
export type PairTally = {
  i: number;
  j: number;
  /** Comparisons between the two, in this cluster. */
  count: number;
  /** `i`'s total score: 1 per outright win, 0.5 per shared win (§3.2). */
  score: number;
};

export type ComparisonSet = {
  identities: ReadonlyArray<Identity>;
  /** One entry per pairing group - **the unit of analysis and the unit every resample draws** (§3.1). */
  clusters: ReadonlyArray<ReadonlyArray<PairTally>>;
  games: number;
  /**
   * Games excluded because both seats held the same identity (§3.6). A self-match is 50/50 by
   * symmetry and carries no information about relative strength; leaving it in would add a pile of
   * `score = count / 2` evidence pinning the pair at equality, which is not evidence at all.
   */
  selfMatchGames: number;
};

/**
 * Pairwise comparisons from 2p observation rows, keyed by identity (never by lineup slot - §3.6,
 * hazard H2).
 *
 * 2p only, deliberately. §3.3 fits placements at 3-4p with Plackett-Luce rather than decomposing a
 * multiplayer game into pairs: the pairwise decomposition of a 3p result double-counts the shared
 * game and has no principled weight, and a rating that pooled the two would be a quantity nobody
 * chose. `plackettLuce.ts` is where 3p and 4p go.
 */
export function buildComparisonSet(rows: ReadonlyArray<Observation>): ComparisonSet {
  const wrongCount = rows.find((row) => row.players !== 2);
  if (wrongCount !== undefined) {
    throw new Error(
      `buildComparisonSet is 2p only, and got a ${wrongCount.players}p row (run ${wrongCount.runId}). ` +
      'Fit 3p and 4p placements with plackettLuce.ts (§3.3); a rating scale is per player count (§3.5).');
  }

  const identities = [...new Set(rows.map((row) => row.identity))].sort();
  const indexOf = new Map(identities.map((identity, index) => [identity, index]));

  const byGame = new Map<string, Array<Observation>>();
  for (const row of rows) {
    const key = `${row.runId}#${row.groupIndex}#${row.permutationIndex}`;
    const game = byGame.get(key) ?? [];
    game.push(row);
    byGame.set(key, game);
  }

  // Sorted keys, so two runs over the same artifacts build the identical set (§3.7).
  const byCluster = new Map<string, Map<string, PairTally>>();
  let games = 0;
  let selfMatchGames = 0;

  for (const key of [...byGame.keys()].sort()) {
    const seats = (byGame.get(key) as ReadonlyArray<Observation>).slice().sort((a, b) => a.seat - b.seat);
    if (seats.length !== 2) {
      throw new Error(`2p game ${key} has ${seats.length} seat rows; the observation set is malformed`);
    }
    if (seats[0].identity === seats[1].identity) {
      selfMatchGames++;
      continue;
    }
    games++;

    const a = indexOf.get(seats[0].identity) as number;
    const b = indexOf.get(seats[1].identity) as number;
    const [i, j] = a < b ? [a, b] : [b, a];
    const scoreForI = a < b ? seats[0].score : seats[1].score;

    const cluster = byCluster.get(seats[0].clusterId) ?? new Map<string, PairTally>();
    const tallyKey = `${i}|${j}`;
    const tally = cluster.get(tallyKey) ?? {i, j, count: 0, score: 0};
    tally.count++;
    tally.score += scoreForI;
    cluster.set(tallyKey, tally);
    byCluster.set(seats[0].clusterId, cluster);
  }

  return {
    identities,
    clusters: [...byCluster.keys()].sort().map((clusterId) =>
      [...(byCluster.get(clusterId) as Map<string, PairTally>).values()].sort((x, y) => x.i - y.i || x.j - y.j)),
    games,
    selfMatchGames,
  };
}

// ---------------------------------------------------------------------------------------------
// The optimizer
// ---------------------------------------------------------------------------------------------

/**
 * A log-likelihood's value, gradient and **observed information** (`-Hessian`, positive
 * semi-definite) at one parameter vector. Both fits in this bullet supply one of these and share
 * everything below.
 */
export type Curvature = {
  value: number;
  gradient: Array<number>;
  information: Array<Array<number>>;
};

export type Maximum = {
  theta: Array<number>;
  /** The log *posterior* at the optimum: the log-likelihood minus the prior penalty. */
  value: number;
  iterations: number;
  converged: boolean;
  /** The likelihood's observed information at the optimum. Used for shrinkage only - never for an interval. */
  information: Array<Array<number>>;
};

/**
 * Newton's method with backtracking, on `logLikelihood(theta) - |theta|² / (2 sigma²)`.
 *
 * The objective is **strictly concave** for any finite `sigma` - the Bradley-Terry and Plackett-Luce
 * log-likelihoods are concave, and the Gaussian prior is strictly concave - so there is exactly one
 * maximum, it is finite, and Newton reaches it. That is the whole answer to hazard H3's point
 * estimate: separation is a statement about the *unpenalized* likelihood, which has no maximum, and
 * the prior is what replaces "diverges" with "large, and reported as unbounded above".
 *
 * The backtracking line search is not decoration. Started from zero against a 99% win rate the first
 * Newton step overshoots badly, and an unguarded step there lands in a region where the next
 * information matrix is numerically singular.
 */
export function maximizeLogPosterior(
  parameters: number,
  logLikelihood: (theta: ReadonlyArray<number>) => Curvature,
  priorSigma: number,
): Maximum {
  if (!(priorSigma > 0) || !Number.isFinite(priorSigma)) {
    throw new Error(`priorSigma must be a positive finite number, got ${priorSigma}`);
  }
  const precision = 1 / (priorSigma * priorSigma);
  const objective = (theta: ReadonlyArray<number>, curvature: Curvature): number =>
    curvature.value - 0.5 * precision * theta.reduce((total, value) => total + value * value, 0);

  let theta = new Array<number>(parameters).fill(0);
  let curvature = logLikelihood(theta);
  let value = objective(theta, curvature);
  let iterations = 0;
  let converged = false;

  for (; iterations < 100; iterations++) {
    const gradient = curvature.gradient.map((component, k) => component - precision * theta[k]);
    const matrix = curvature.information.map((row, k) =>
      row.map((entry, l) => entry + (k === l ? precision : 0)));
    const step = solve(matrix, gradient);

    // The Newton decrement, which for a positive-definite `matrix` is non-negative and is the
    // objective's own estimate of what is left to gain. See NEWTON_TOLERANCE for why the test is
    // here and not on the gradient.
    const slope = step.reduce((total, component, k) => total + component * gradient[k], 0);
    const scale = Math.max(1, Math.abs(value));
    if (slope / 2 < NEWTON_TOLERANCE * scale) {
      converged = true;
      break;
    }

    // Backtracking with the Armijo condition. `t` bottoming out means the step direction is not an
    // ascent direction, which for a strictly concave objective means numerical trouble rather than a
    // modelling one - reported as `converged: false` rather than silently returning the last point.
    let t = 1;
    let accepted = false;
    while (t > 1e-12) {
      const candidate = theta.map((component, k) => component + t * step[k]);
      const candidateCurvature = logLikelihood(candidate);
      const candidateValue = objective(candidate, candidateCurvature);
      if (candidateValue >= value + 1e-4 * t * slope) {
        theta = candidate;
        curvature = candidateCurvature;
        value = candidateValue;
        accepted = true;
        break;
      }
      t /= 2;
    }
    if (!accepted) {
      converged = slope / 2 < NEWTON_STALL_TOLERANCE * scale;
      break;
    }
  }

  return {theta, value, iterations, converged, information: curvature.information};
}

// ---------------------------------------------------------------------------------------------
// The Bradley-Terry log-likelihood
// ---------------------------------------------------------------------------------------------

/**
 * `sum over comparisons of s log sigma(theta_i - theta_j) + (n - s) log sigma(theta_j - theta_i)`,
 * with its gradient and observed information.
 *
 * `log sigma(x)` is written as `-log1p(exp(-x))` on the positive side and `x - log1p(exp(x))` on the
 * negative side so that a 99.9% pair - which puts `x` around 7 and, under separation, around 8 -
 * does not lose its digits to `log(1 - 1e-7)`.
 */
export function bradleyTerryCurvature(
  theta: ReadonlyArray<number>,
  clusters: ReadonlyArray<ReadonlyArray<PairTally>>,
): Curvature {
  const k = theta.length;
  const gradient = new Array<number>(k).fill(0);
  const information = Array.from({length: k}, () => new Array<number>(k).fill(0));
  let value = 0;

  for (const cluster of clusters) {
    for (const tally of cluster) {
      const delta = theta[tally.i] - theta[tally.j];
      const p = logistic(delta);
      value += tally.score * logSigmoid(delta) + (tally.count - tally.score) * logSigmoid(-delta);

      const residual = tally.score - tally.count * p;
      gradient[tally.i] += residual;
      gradient[tally.j] -= residual;

      const curvature = tally.count * p * (1 - p);
      information[tally.i][tally.i] += curvature;
      information[tally.j][tally.j] += curvature;
      information[tally.i][tally.j] -= curvature;
      information[tally.j][tally.i] -= curvature;
    }
  }

  return {value, gradient, information};
}

// ---------------------------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------------------------

export type StrengthFit = {
  identities: ReadonlyArray<Identity>;
  /** Latent strengths in logits, in `identities` order. Multiply by {@link ELO_PER_LOGIT} for Elo. */
  strengths: ReadonlyArray<number>;
  priorSigma: number;
  logPosterior: number;
  iterations: number;
  converged: boolean;
  /**
   * The likelihood's observed information at the optimum. Kept for {@link contrastShrinkage} and for
   * {@link effectiveParameters} - **never for a standard error** (§3.3: rating intervals come from
   * the cluster bootstrap, because the near-separated regime this pool occupies is exactly where the
   * asymptotic normal approximation is worst).
   */
  information: ReadonlyArray<ReadonlyArray<number>>;
  /**
   * `tr[(L + I/sigma²)^-1 L]` - how many of the `identities.length` parameters the data actually
   * pins, where `L` is the observed information above.
   *
   * **Expect this to be one less than the identity count, and that is correct.** A Bradley-Terry or
   * Plackett-Luce likelihood depends on the strengths only through their *differences*, so the
   * overall level is unidentified by the data and is fixed entirely by the prior. A 2-identity pool
   * over a thousand games reports 1.00 of 2. That number is worth printing precisely because it says
   * out loud what anchoring is for.
   */
  effectiveParameters: number;
};

export function fitBradleyTerry(set: ComparisonSet, priorSigma = DEFAULT_PRIOR_SIGMA): StrengthFit {
  return fitStrengths(
    set.identities,
    (theta) => bradleyTerryCurvature(theta, set.clusters),
    priorSigma);
}

/** The shared tail of both fits: maximize, check for `NaN`/`Infinity`, compute the shrinkage. */
export function fitStrengths(
  identities: ReadonlyArray<Identity>,
  logLikelihood: (theta: ReadonlyArray<number>) => Curvature,
  priorSigma: number,
): StrengthFit {
  const maximum = maximizeLogPosterior(identities.length, logLikelihood, priorSigma);
  maximum.theta.forEach((strength, index) =>
    assertFinite(strength, `fitted strength for ${identities[index]}`));

  const dataShare = dataShareMatrix(maximum.information, priorSigma);

  return {
    identities,
    strengths: maximum.theta,
    priorSigma,
    logPosterior: maximum.value,
    iterations: maximum.iterations,
    converged: maximum.converged,
    information: maximum.information,
    effectiveParameters: identities.reduce((total, _unused, k) => total + clamp01(dataShare[k][k]), 0),
  };
}

/** `M = (L + I/sigma²)^-1 L`: the share of each direction of the estimate the *data* determines. */
function dataShareMatrix(
  information: ReadonlyArray<ReadonlyArray<number>>,
  priorSigma: number,
): Array<Array<number>> {
  const precision = 1 / (priorSigma * priorSigma);
  const penalized = information.map((row, k) => row.map((entry, l) => entry + (k === l ? precision : 0)));
  return solveMatrix(penalized, information);
}

/**
 * **The prior's share of one rating gap**, `1 - (cᵀ M c) / (cᵀ c)` for the contrast
 * `c = e_subject - e_reference`. 0 means the data determines the gap entirely; 1 means the prior
 * does. This is the number §3.3 requires "reported alongside every rating".
 *
 * **It is a contrast and not a per-parameter diagonal, and the difference is not cosmetic.** The
 * likelihood sees only differences of strengths, so the level direction carries no information at
 * all and its shrinkage is 1 by construction. A per-parameter diagonal mixes that unidentified
 * direction into every entry and reports ~50% shrinkage on a 1,000-game two-agent pool where the
 * prior in fact moves the *gap* by a quarter of a percent - a diagnostic that cries wolf on every
 * fit is a diagnostic nobody reads by the third one. {@link StrengthFit.effectiveParameters} is
 * where the unidentified level is reported honestly, once.
 *
 * On a genuinely separated pair this goes to 1 as intended, which is the second, independent signal
 * that the interval's unbounded end is prior-determined (hazard H3) - the first being
 * {@link boundedness}, which decides it structurally and does not depend on this number at all.
 */
export function contrastShrinkage(fit: StrengthFit, subject: number, reference: number): number {
  if (subject === reference) {
    return 0;
  }
  const dataShare = dataShareMatrix(fit.information, fit.priorSigma);
  // cᵀ M c for c = e_subject - e_reference, over cᵀc = 2.
  const quadratic = dataShare[subject][subject] - dataShare[subject][reference] -
    dataShare[reference][subject] + dataShare[reference][reference];
  return clamp01(1 - quadratic / 2);
}

// ---------------------------------------------------------------------------------------------
// The pool: the fit plus everything needed to say what its intervals may claim
// ---------------------------------------------------------------------------------------------

export type PoolFitOptions = {
  priorSigma?: number;
  /** Bootstrap replicates. The interval comes from these and never from the Hessian (§3.3). */
  replicates?: number;
  /**
   * The analysis stream (§2.6, hazard H11). **Omit it and there is no interval** - the report then
   * says so rather than quoting a Hessian standard error, which is the substitution §3.3 forbids.
   */
  random?: AgentRandom;
};

export type PoolFit = StrengthFit & {
  players: 2 | 3 | 4;
  model: 'bradley-terry' | 'plackett-luce';
  games: number;
  groups: number;
  selfMatchGames: number;
  /** Games each identity played in this stratum, in `identities` order. */
  gamesPerIdentity: ReadonlyArray<number>;
  /**
   * `beats[i]` lists every identity `i` has ever finished strictly ahead of, and both directions for
   * a shared result. **The separation graph** - see {@link boundedness}.
   */
  beats: ReadonlyArray<ReadonlyArray<number>>;
  /** `played[i]` lists every identity `i` has ever sat against. **The comparison graph** (§3.4). */
  played: ReadonlyArray<ReadonlyArray<number>>;
  bootstrap?: {
    replicates: number;
    usable: number;
    /** `strengths[r][k]`, one row per usable resample. Every interval in this bullet is a percentile of these. */
    strengths: ReadonlyArray<ReadonlyArray<number>>;
  };
};

/**
 * Fits a 2p pool: the MAP strengths, the two graphs, and the cluster-bootstrap replicates every
 * interval is a percentile of.
 */
export function ratePairwise(
  rows: ReadonlyArray<Observation>,
  options: PoolFitOptions = {},
): PoolFit {
  const set = buildComparisonSet(rows);
  const priorSigma = options.priorSigma ?? DEFAULT_PRIOR_SIGMA;
  const fit = fitBradleyTerry(set, priorSigma);

  const beats = emptyAdjacency(set.identities.length);
  const played = emptyAdjacency(set.identities.length);
  const gamesPerIdentity = new Array<number>(set.identities.length).fill(0);
  for (const cluster of set.clusters) {
    for (const tally of cluster) {
      played[tally.i].add(tally.j);
      played[tally.j].add(tally.i);
      gamesPerIdentity[tally.i] += tally.count;
      gamesPerIdentity[tally.j] += tally.count;
      if (tally.score > 0) {
        beats[tally.i].add(tally.j);
      }
      if (tally.score < tally.count) {
        beats[tally.j].add(tally.i);
      }
    }
  }

  return {
    ...fit,
    players: 2,
    model: 'bradley-terry',
    games: set.games,
    groups: set.clusters.length,
    selfMatchGames: set.selfMatchGames,
    gamesPerIdentity,
    beats: beats.map(sortedArray),
    played: played.map(sortedArray),
    bootstrap: options.random === undefined ?
      undefined :
      bootstrapStrengths(
        set.clusters,
        (resample) => fitBradleyTerry({...set, clusters: resample}, priorSigma).strengths,
        {replicates: options.replicates ?? DEFAULT_BOOTSTRAP_REPLICATES, random: options.random},
        set.identities.length),
  };
}

/**
 * Refits on cluster resamples and collects **every** identity's strength per replicate (§3.1).
 *
 * One refit per replicate rather than one per identity: the ladder needs an interval on each
 * identity *and* on each predecessor gap, and those are all percentiles of the same joint sample, so
 * refitting per quantity would be both slower and wrong - the gaps would come from unrelated
 * resamples and their intervals would not be jointly interpretable.
 *
 * The resampling loop mirrors `bootstrap.ts`'s `clusterBootstrap` exactly - whole clusters, drawn
 * with replacement from the same {@link AgentRandom} - rather than calling it, because that function
 * reduces a resample to one number and this one needs the whole strength vector. A replicate in
 * which the refit fails to converge or produces a non-finite strength is **skipped and counted**,
 * never allowed to poison a percentile (hazard H9).
 */
export function bootstrapStrengths<C>(
  clusters: ReadonlyArray<C>,
  fitOne: (resample: ReadonlyArray<C>) => ReadonlyArray<number>,
  options: {replicates: number; random: AgentRandom},
  parameters: number,
): PoolFit['bootstrap'] {
  if (clusters.length < 2) {
    return {replicates: options.replicates, usable: 0, strengths: []};
  }
  const strengths: Array<ReadonlyArray<number>> = [];
  const resample: Array<C> = new Array(clusters.length);
  for (let replicate = 0; replicate < options.replicates; replicate++) {
    for (let i = 0; i < clusters.length; i++) {
      resample[i] = clusters[options.random.nextInt(clusters.length)];
    }
    const drawn = fitOne(resample);
    if (drawn.length === parameters && drawn.every((value) => Number.isFinite(value))) {
      strengths.push(drawn.slice());
    }
  }
  return {replicates: options.replicates, usable: strengths.length, strengths};
}

// ---------------------------------------------------------------------------------------------
// Separation, connectivity, and what an interval is allowed to claim
// ---------------------------------------------------------------------------------------------

/**
 * Which ends of `theta_subject - theta_reference` the **data** can bound, decided structurally from
 * the beat graph rather than from the size of the fitted number (§3.3, hazard H3).
 *
 * The Bradley-Terry MLE is finite exactly when the beat digraph is strongly connected (Ford's
 * condition). The refinement that matters for a *pair* falls out of the same argument. A direction
 * `d` along which the log-likelihood never decreases must satisfy `d_u >= d_v` for every edge
 * `u -> v` (u beat v at least once): pushing `theta_u - theta_v` up can only help a term u won, and
 * would drive to `-infinity` any term v won. So:
 *
 * - the gap is **unbounded above** iff there is *no* directed path `reference -> ... -> subject`
 *   (with such a path, `d_reference >= d_subject` on every recession direction, so the gap cannot be
 *   pushed up);
 * - the gap is **unbounded below** iff there is no directed path `subject -> ... -> reference`.
 *
 * Two identities in the same strongly connected component have paths both ways, so their gap is
 * bounded both ways - which is the real 2p corpus, where `random-legal@1` takes 12 games off
 * `greedy-1ply@1` and the pair is therefore *not* separated. Take those 12 games away and the answer
 * flips to "unbounded above", with no change in the size of any fitted number. **That is the whole
 * point of deciding this structurally**: the fitted gap looks much the same either side of the line.
 */
export function boundedness(fit: PoolFit, subject: number, reference: number): {above: boolean; below: boolean} {
  return {
    above: reachable(fit.beats, reference, subject),
    below: reachable(fit.beats, subject, reference),
  };
}

function reachable(adjacency: ReadonlyArray<ReadonlyArray<number>>, from: number, to: number): boolean {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift() as number;
    if (node === to) {
      return true;
    }
    for (const next of adjacency[node]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * The connected components of the **comparison** graph (§3.4), as sorted identity lists, in a stable
 * order.
 *
 * A disconnected graph has no single scale: two identities that never met, and whose opponents never
 * met, have no data relating them at all, and the prior alone decides their gap. The right output is
 * a per-component table with the components named, not one table that implies comparability - which
 * is why {@link describePool} reports components rather than a flat list. **The corollary for the
 * ladder is that every new version must be played against its immediate predecessor**, which AC-7
 * requires anyway; that is what keeps the graph connected as the pool grows.
 */
export function componentsOf(fit: PoolFit): ReadonlyArray<ReadonlyArray<number>> {
  const seen = new Set<number>();
  const components: Array<Array<number>> = [];
  for (let start = 0; start < fit.identities.length; start++) {
    if (seen.has(start)) {
      continue;
    }
    const component: Array<number> = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const node = queue.shift() as number;
      component.push(node);
      for (const next of fit.played[node]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    components.push(component.sort((a, b) => a - b));
  }
  return components;
}

/**
 * `theta_subject - theta_reference` on the Elo scale, with the interval the data actually supports.
 *
 * The percentile interval is computed from the bootstrap replicates and then **overridden at any end
 * the beat graph cannot bound**. That override is the criterion-P5 behaviour and it cannot be
 * skipped: a separated pair's bootstrap replicates are all finite (the prior sees to that) and their
 * 97.5th percentile is a perfectly plausible-looking number that is a statement about
 * {@link DEFAULT_PRIOR_SIGMA} and about nothing else.
 */
export function eloGap(fit: PoolFit, subject: Identity, reference: Identity): EloGap | Unestimable {
  const s = fit.identities.indexOf(subject);
  const r = fit.identities.indexOf(reference);
  if (s < 0 || r < 0) {
    return unestimable(
      `${s < 0 ? subject : reference} is not in the ${fit.players}p pool ` +
      `(${fit.identities.join(', ') || 'no identities'})`);
  }
  const elo = assertFinite((fit.strengths[s] - fit.strengths[r]) * ELO_PER_LOGIT, `${subject} vs ${reference} Elo`);
  if (s === r) {
    return {subject, reference, elo: 0, ci95: {low: 0, high: 0}, usableReplicates: 0};
  }

  const bounds = boundedness(fit, s, r);
  const unboundedEnd = bounds.above && bounds.below ?
    undefined :
    (bounds.above ? 'below' : bounds.below ? 'above' : 'both') as 'above' | 'below' | 'both';
  const reason = unboundedEnd === undefined ? undefined : separationReason(fit, subject, reference, unboundedEnd);

  if (fit.bootstrap === undefined || fit.bootstrap.usable < 2) {
    // No interval is available at either end. The reason names the *structural* problem first when
    // there is one: "these two identities are in different components" is a fact about the data that
    // a bootstrap would not have fixed, and reporting only "no bootstrap was run" would send a
    // reader off to add replicates that cannot help.
    const missing = fit.bootstrap === undefined ?
      'No cluster bootstrap was run (no analysis stream was supplied), and §3.3 takes rating ' +
      'intervals from the bootstrap and deliberately not from the Hessian: the near-separated ' +
      'regime this pool occupies is where the asymptotic normal approximation is worst.' :
      `Only ${fit.bootstrap.usable} bootstrap resample(s) produced a fit.`;
    return {
      subject,
      reference,
      elo,
      ci95: {
        low: null,
        high: null,
        unbounded: {end: 'both', reason: reason === undefined ? missing : `${reason} ${missing}`},
      },
      usableReplicates: fit.bootstrap?.usable ?? 0,
      ...(fit.bootstrap === undefined ? {} : {replicates: fit.bootstrap.replicates}),
    };
  }

  const gaps = fit.bootstrap.strengths.map((draw) => (draw[s] - draw[r]) * ELO_PER_LOGIT).sort((a, b) => a - b);
  const [lowQuantile, highQuantile] = biasCorrectedQuantiles(gaps, elo);
  const low = unboundedEnd === 'below' || unboundedEnd === 'both' ? null : percentile(gaps, lowQuantile);
  const high = unboundedEnd === 'above' || unboundedEnd === 'both' ? null : percentile(gaps, highQuantile);

  return {
    subject,
    reference,
    elo,
    ci95: {
      low: low === null ? null : assertFinite(low, `${subject} vs ${reference} lower bound`),
      high: high === null ? null : assertFinite(high, `${subject} vs ${reference} upper bound`),
      ...(unboundedEnd === undefined ? {} : {unbounded: {end: unboundedEnd, reason: reason as string}}),
    },
    usableReplicates: fit.bootstrap.usable,
    replicates: fit.bootstrap.replicates,
  };
}

function separationReason(fit: PoolFit, subject: Identity, reference: Identity, end: 'above' | 'below' | 'both'): string {
  if (end === 'both') {
    return `${subject} and ${reference} are in different components of the comparison graph: no chain ` +
      'of played matches connects them, so no data bounds their gap in either direction. Play them ' +
      'against each other, or against a common opponent (§3.4).';
  }
  const stronger = end === 'above' ? subject : reference;
  const weaker = end === 'above' ? reference : subject;
  return `${stronger} is separated from ${weaker}: no chain of played matches has ${weaker} ` +
    `finishing ahead of ${stronger}, so the data places no upper bound on the gap and the point ` +
    `estimate is held finite only by the prior (sigma = ${fit.priorSigma} logits). The bound below ` +
    'is real; the one above does not exist and is reported as null rather than as a number (H3, P5).';
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export type EloRating = {
  identity: Identity;
  /** Elo relative to this component's anchor. Always finite. */
  elo: number;
  ci95: EloBounds;
  /** The prior's share of *this gap*; see {@link contrastShrinkage} for why it is a contrast. */
  shrinkage: number;
  /** Games this identity played in the fitted stratum. */
  games: number;
};

export type RatingComponent = {
  index: number;
  /** {@link PREFERRED_ANCHOR} when present in the component, else its first identity, recorded either way. */
  anchor: Identity;
  usesPreferredAnchor: boolean;
  identities: ReadonlyArray<Identity>;
  ratings: ReadonlyArray<EloRating>;
};

export type PoolRating = {
  players: 2 | 3 | 4;
  model: PoolFit['model'];
  priorSigma: number;
  games: number;
  groups: number;
  selfMatchGamesExcluded: number;
  converged: boolean;
  effectiveParameters: number;
  bootstrap: {replicates: number; usable: number} | undefined;
  /**
   * **One table per component, never one table over all of them** (§3.4). `connected` below is the
   * one-line answer to "may these numbers be compared?".
   */
  components: ReadonlyArray<RatingComponent>;
  connected: boolean;
  /** Every pair whose gap the data cannot bound on at least one side (hazard H3). */
  separations: ReadonlyArray<{subject: Identity; reference: Identity; end: 'above' | 'below' | 'both'; reason: string}>;
};

/** The fit, arranged for a reader: per component, anchored, with the separations called out. */
export function describePool(fit: PoolFit): PoolRating {
  const components = componentsOf(fit).map((component, index) => {
    const identities = component.map((k) => fit.identities[k]);
    const anchor = identities.includes(PREFERRED_ANCHOR) ? PREFERRED_ANCHOR : identities[0];
    return {
      index,
      anchor,
      usesPreferredAnchor: anchor === PREFERRED_ANCHOR,
      identities,
      ratings: identities.map((identity): EloRating => {
        const gap = eloGap(fit, identity, anchor);
        if (isUnestimableGap(gap)) {
          throw new Error(`${identity} vanished from its own component: ${gap.reason}`);
        }
        return {
          identity,
          elo: gap.elo,
          ci95: gap.ci95,
          shrinkage: contrastShrinkage(fit, fit.identities.indexOf(identity), fit.identities.indexOf(anchor)),
          games: fit.gamesPerIdentity[fit.identities.indexOf(identity)],
        };
      }),
    };
  });

  const separations: Array<PoolRating['separations'][number]> = [];
  for (let i = 0; i < fit.identities.length; i++) {
    for (let j = i + 1; j < fit.identities.length; j++) {
      const bounds = boundedness(fit, i, j);
      if (bounds.above && bounds.below) {
        continue;
      }
      const end = (bounds.above ? 'below' : bounds.below ? 'above' : 'both') as 'above' | 'below' | 'both';
      separations.push({
        subject: fit.identities[i],
        reference: fit.identities[j],
        end,
        reason: separationReason(fit, fit.identities[i], fit.identities[j], end),
      });
    }
  }

  return {
    players: fit.players,
    model: fit.model,
    priorSigma: fit.priorSigma,
    games: fit.games,
    groups: fit.groups,
    selfMatchGamesExcluded: fit.selfMatchGames,
    converged: fit.converged,
    effectiveParameters: fit.effectiveParameters,
    bootstrap: fit.bootstrap === undefined ?
      undefined :
      {replicates: fit.bootstrap.replicates, usable: fit.bootstrap.usable},
    components,
    connected: components.length === 1,
    separations,
  };
}

function isUnestimableGap(gap: EloGap | Unestimable): gap is Unestimable {
  return (gap as Unestimable).estimable === false;
}

/**
 * The Elo a two-agent win rate implies, `-400 log10(1/p - 1)` - the mapping §2.4 pre-registers
 * `greedy-1ply@1`'s +837 [719, 956] through.
 *
 * Kept here so the write-up's "with two agents the Elo is the win rate, monotonically transformed"
 * (§3.4) is a function anyone can call rather than an assertion in prose. Returns `null` at 0 or 1,
 * where the mapping is unbounded - the same refusal to print `Infinity` as {@link EloBounds}.
 */
export function eloFromWinRate(rate: number): number | null {
  if (!(rate > 0) || !(rate < 1)) {
    return null;
  }
  return -400 * Math.log10(1 / rate - 1);
}

// ---------------------------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------------------------

/**
 * The guard §3.3 asks for **in the code, not only in the tests**. A `NaN` strength reaching a report
 * serializes to `null` and becomes indistinguishable from a field nobody wrote; an `Infinity` does
 * the same. Both mean the fit failed, and a failed fit must say so where it happened.
 */
export function assertFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `${what} is ${value}, which must never reach a rating report (hazard H3/H9). A non-finite ` +
      'strength means the fit diverged - which the Gaussian prior of §3.3 exists to prevent, so ' +
      'this is a defect in the fit rather than a property of the data.');
  }
  return value;
}

export function logistic(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** `log sigma(x)`, evaluated on whichever side keeps its digits. */
function logSigmoid(x: number): number {
  return x >= 0 ? -Math.log1p(Math.exp(-x)) : x - Math.log1p(Math.exp(x));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The **bias-corrected** percentile pair for a 95% interval, re-exported from `bootstrap.ts`.
 *
 * ## Why the plain percentile interval was not good enough, measured rather than argued
 *
 * §3.1 specifies the percentile method for the *proportions* in `stats.ts`. For a **rating gap** it
 * under-covers, because a Bradley-Terry gap estimated near the edge of the probability scale has a
 * skewed sampling distribution and a small upward bias, and the plain percentile method inherits
 * both. Measured on a five-identity round robin with 30 pairing groups per pair and a true extreme
 * gap of 486 Elo, over 200 replications at 600 resamples each:
 *
 * | method | coverage | mean width |
 * | --- | --- | --- |
 * | percentile | 92.5% | 168.8 |
 * | bias-corrected | **94.5%** | 167.4 |
 * | bias-corrected and accelerated (BCa) | **94.5%** | 167.1 |
 *
 * The interval was **mis-placed, not too narrow** - the widths agree to within 1%, so widening it
 * would have bought the coverage without fixing the defect. Unit C's coverage grid then found the
 * proportion cross-check needed the same correction for the same reason, so **the implementation
 * moved to `bootstrap.ts`** and is re-exported here: two copies of one correction is two things to
 * get out of step. The full note - including why the acceleration term is not implemented, and why
 * 200 resamples is not enough - is on the function there.
 */
export {biasCorrectedQuantiles};

/** Linear-interpolated quantile of a sorted array - `bootstrap.ts`'s convention, for the same reason. */
export function percentile(sorted: ReadonlyArray<number>, q: number): number {
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/** `A x = b` by Gaussian elimination with partial pivoting. `A` is small (one row per identity). */
export function solve(a: ReadonlyArray<ReadonlyArray<number>>, b: ReadonlyArray<number>): Array<number> {
  return solveMatrix(a, b.map((value) => [value])).map((row) => row[0]);
}

/** `A X = B` for a small dense `A`. Used for the Newton step and for the shrinkage diagnostic. */
export function solveMatrix(
  a: ReadonlyArray<ReadonlyArray<number>>,
  b: ReadonlyArray<ReadonlyArray<number>>,
): Array<Array<number>> {
  const n = a.length;
  const columns = b[0]?.length ?? 0;
  const matrix = a.map((row, i) => [...row, ...b[i]]);

  for (let pivot = 0; pivot < n; pivot++) {
    let best = pivot;
    for (let row = pivot + 1; row < n; row++) {
      if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) {
        best = row;
      }
    }
    if (Math.abs(matrix[best][pivot]) < 1e-300) {
      // Cannot happen once the prior is added - `L + I/sigma²` is positive definite for any finite
      // sigma - so reaching here means the caller dropped the prior, not that the data is degenerate.
      throw new Error(
        `singular matrix at pivot ${pivot}: the penalized information must be positive definite ` +
        '(the Gaussian prior of §3.3 is what guarantees that)');
    }
    [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]];

    const scale = matrix[pivot][pivot];
    for (let column = pivot; column < n + columns; column++) {
      matrix[pivot][column] /= scale;
    }
    for (let row = 0; row < n; row++) {
      if (row === pivot || matrix[row][pivot] === 0) {
        continue;
      }
      const factor = matrix[row][pivot];
      for (let column = pivot; column < n + columns; column++) {
        matrix[row][column] -= factor * matrix[pivot][column];
      }
    }
  }

  return matrix.map((row) => row.slice(n));
}

function emptyAdjacency(size: number): Array<Set<number>> {
  return Array.from({length: size}, () => new Set<number>());
}

function sortedArray(values: Set<number>): ReadonlyArray<number> {
  return [...values].sort((a, b) => a - b);
}
