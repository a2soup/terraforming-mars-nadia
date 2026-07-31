import {AgentRandom} from '../core/rng';
import {permutationsFor} from '../match/pairing';
import {Identity, Observation, ObservationSet} from './types';

/**
 * The synthetic generator (Milestone 2, bullet 3, Unit A; agent/docs/Milestone2_Bullet3_Prompts.md
 * §3.9, hazard H12). **This file is the instrument Units B and C validate against.** Everything
 * either of them can claim about coverage, size or power is a claim about data this module
 * produced, so a defect here is not a wrong number in one place - it is a green study that proves
 * nothing.
 *
 * ## Read this before "simplifying" it to one cluster mechanism
 *
 * A statistics module cannot be validated by running it on real data and looking at the output.
 * The method is: generate data from **known** parameters, run the pipeline, and check that the 95%
 * intervals contain the truth about 95% of the time. The trap - hazard H12, and the single most
 * likely way this whole bullet ends up green and worthless - is that **if the generator draws data
 * the same way the estimator assumes it was drawn, coverage is guaranteed by construction**.
 *
 * §3.9 requires three independent mitigations, and this file carries two of them:
 *
 * 1. **Two genuinely different cluster mechanisms**, {@link ClusterMechanism}. `beta-binomial`
 *    mixes the per-group success probability on the probability scale with a Beta distribution;
 *    `latent-difficulty` mixes it on the *logit* scale with a Normal, which is what a shared deal
 *    physically is - one seed favours a line of play, and every game in the group inherits that.
 *    The two produce different mixing densities (bounded-support Beta vs logit-normal), different
 *    tail behaviour, and the same ICC. **Coverage must hold under both.** Deleting one of them
 *    removes half the evidence and leaves the study looking identical.
 * 2. **An analytic anchor.** At `icc = 0` both mechanisms degenerate to independent Bernoulli
 *    draws, where the correct interval is known in closed form (Clopper-Pearson / exact binomial).
 *    Coverage there is a check against mathematics rather than against this file.
 *
 * The third mitigation lives outside this module: the primary interval and the bootstrap interval
 * must agree on the *committed real corpora* (criterion P4b). Two estimators built from the same
 * wrong assumption can both miscover; two estimators disagreeing is unambiguous.
 *
 * ### How different the two mechanisms actually are - measured, because it matters
 *
 * **This is a finding Unit C and Unit D should have, and it is not what §3.9 implies.** Fixing both
 * the marginal rate *and* the ICC pins a unimodal mixing density on [0, 1] tightly, so the two
 * mechanisms end up close. Total-variation distance between their group-sum distributions
 * (`m = 6`, 200,000 groups, the complete sufficient summary of a clustered-binary mixture):
 *
 * | p \ ICC | 0.05 | 0.20 |
 * | --- | --- | --- |
 * | 0.50 | 0.26% | 0.59% |
 * | 0.65 | 0.28% | 1.15% |
 * | 0.90 | 0.55% | **2.23%** |
 * | 0.99 | 0.20% | 0.50% |
 *
 * So the mechanisms are genuinely distinct, but by at most ~2%, and least distinct at `p = 0.5` -
 * which is exactly the cell a reader would assume carried the comparison. Read two consequences:
 *
 * - **Unit C's H12 evidence comes from the high-ICC, off-centre cells** (p = 0.65-0.90, ICC = 0.20),
 *   not from the p = 0.50 row. A grid that reported only the symmetric cells would be reporting a
 *   mechanism comparison that is barely a comparison.
 * - **The mechanism pair cannot detect an estimator that is wrong in a way common to every
 *   two-moment-matched mixture.** For that class of error the analytic anchor at ICC = 0 and the
 *   real-data agreement check (P4b) are doing the work, and §3.9's three mitigations are not equally
 *   strong. Say so rather than treating "coverage held under both mechanisms" as if it were
 *   independent evidence.
 *
 * ## A note on what "the truth" is
 *
 * At `icc > 0` there are two different true quantities and they are not the same number:
 *
 * - the **marginal** rate `E[p_g]`, which is what a proportion's confidence interval is supposed to
 *   cover, and
 * - the **conditional** latent strengths, which are what a Bradley-Terry fit is estimating.
 *
 * The binary and continuous generators below are constructed so the *marginal* is exact - that is
 * what a coverage study needs. {@link simulateObservations} reports the latent strengths exactly
 * (they are its inputs) and reports the marginal first-place rate only where it is exactly
 * computable, rather than quoting a quadrature approximation as ground truth.
 */

/**
 * The two mixing mechanisms of §3.9. Both are parameterized by the same intra-cluster correlation,
 * so a scenario grid can hold ICC fixed and vary only the mechanism - which is the comparison that
 * makes the pair worth having.
 */
export type ClusterMechanism =
  /** Per-group success probability drawn from a Beta with the target mean and ICC. */
  | 'beta-binomial'
  /**
   * Per-group offset on the **logit** scale, drawn from a Normal - a shared latent seed difficulty.
   * The centre is solved numerically so the marginal rate is exactly the target despite Jensen.
   */
  | 'latent-difficulty';

export const CLUSTER_MECHANISMS: ReadonlyArray<ClusterMechanism> = ['beta-binomial', 'latent-difficulty'];

// ---------------------------------------------------------------------------------------------
// Binary outcomes: the workhorse for the proportion coverage grid (P2)
// ---------------------------------------------------------------------------------------------

export type BinaryScenario = {
  groups: number;
  /** Rows per group. The real corpora have 2 (2p), 6 (3p) and 4 (4p). */
  clusterSize: number;
  /** The **marginal** success probability. Exact by construction under both mechanisms. */
  rate: number;
  /** Intra-cluster correlation. `0` degenerates to independent Bernoulli draws - the analytic anchor. */
  icc: number;
  mechanism: ClusterMechanism;
  random: AgentRandom;
};

export type BinarySample = {
  /** One array per group; the unit of analysis (§3.1). */
  clusters: ReadonlyArray<ReadonlyArray<number>>;
  truth: {
    rate: number;
    icc: number;
    mechanism: ClusterMechanism;
    /** `1 + (m - 1) · icc` - what the estimated design effect should converge to. */
    designEffect: number;
    /** The mixing distribution's parameters, so a failing cell can be re-created by hand. */
    parameters: Record<string, number>;
  };
};

/**
 * Clustered Bernoulli draws with an exactly-known marginal rate and an exactly-known ICC.
 *
 * The ICC of a binomial mixture is `Var(p_g) / (p(1-p))`, and the design effect over equal clusters
 * of size `m` is `1 + (m - 1) · ICC`. Both mechanisms below hit the same `Var(p_g)`; they differ in
 * the *shape* of the mixing density, which is the entire point (H12).
 */
export function simulateClusteredBinary(scenario: BinaryScenario): BinarySample {
  const {groups, clusterSize, rate, icc, mechanism, random} = scenario;
  if (rate <= 0 || rate >= 1) {
    throw new Error(`rate must be in (0, 1), got ${rate}`);
  }
  if (icc < 0 || icc >= 1) {
    throw new Error(`icc must be in [0, 1), got ${icc}`);
  }

  const draw = cachedClusterRateSampler(rate, icc, mechanism);
  const clusters: Array<Array<number>> = [];
  for (let group = 0; group < groups; group++) {
    const groupRate = draw.sample(random);
    const cluster: Array<number> = [];
    for (let row = 0; row < clusterSize; row++) {
      cluster.push(random.next() < groupRate ? 1 : 0);
    }
    clusters.push(cluster);
  }

  return {
    clusters,
    truth: {
      rate,
      icc,
      mechanism,
      designEffect: 1 + (clusterSize - 1) * icc,
      parameters: draw.parameters,
    },
  };
}

type ClusterRateSampler = {sample: (random: AgentRandom) => number; parameters: Record<string, number>};

/**
 * Samplers are cached by scenario, not by replication.
 *
 * The `latent-difficulty` mechanism has no closed form for either its mean or its variance, so
 * building one costs two nested bisections over a quadrature grid. Unit C's grid runs >= 2,000
 * replications *per cell* against a handful of distinct cells, so rebuilding per replication would
 * make the calibration study cost hours of arithmetic to produce numbers identical to these. The
 * cache is keyed on the full parameter triple and holds nothing random - the {@link AgentRandom} is
 * passed in at sample time - so it cannot make two runs of the same seed differ.
 */
const samplerCache = new Map<string, ClusterRateSampler>();

function cachedClusterRateSampler(rate: number, icc: number, mechanism: ClusterMechanism): ClusterRateSampler {
  const key = `${rate}|${icc}|${mechanism}`;
  const cached = samplerCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const built = clusterRateSampler(rate, icc, mechanism);
  samplerCache.set(key, built);
  return built;
}

/** A per-group success-probability sampler with mean `rate` and `Var = icc · rate · (1 - rate)`. */
function clusterRateSampler(
  rate: number,
  icc: number,
  mechanism: ClusterMechanism,
): ClusterRateSampler {
  if (icc === 0) {
    // The analytic anchor: no mixing at all, so the exact binomial answer applies and coverage
    // there is a check against mathematics rather than against this file (§3.9).
    return {sample: () => rate, parameters: {}};
  }

  if (mechanism === 'beta-binomial') {
    // Var(Beta) = pq/(α+β+1), so ICC = 1/(α+β+1) exactly. The mean is p by construction.
    const concentration = (1 - icc) / icc;
    const alpha = rate * concentration;
    const beta = (1 - rate) * concentration;
    return {
      sample: (random) => sampleBeta(random, alpha, beta),
      parameters: {alpha, beta, concentration},
    };
  }

  // latent-difficulty: p_g = logistic(centre + δ), δ ~ N(0, σ²). Neither the mean nor the variance
  // is available in closed form, so σ is solved for the target variance and `centre` for the target
  // mean - in that order, since the variance is far less sensitive to the centre than the reverse.
  const targetVariance = icc * rate * (1 - rate);
  const sigma = solveSigma(rate, targetVariance);
  const centre = solveCentre(rate, sigma);
  return {
    sample: (random) => logistic(centre + sigma * sampleNormal(random)),
    parameters: {sigma, centre, targetVariance},
  };
}

// ---------------------------------------------------------------------------------------------
// Continuous outcomes: the margin coverage grid
// ---------------------------------------------------------------------------------------------

export type ContinuousScenario = {
  groups: number;
  clusterSize: number;
  mean: number;
  /** Standard deviation of the per-group offset. Sets the ICC together with `withinSd`. */
  betweenSd: number;
  /** Standard deviation of the within-group noise. */
  withinSd: number;
  random: AgentRandom;
};

export type ContinuousSample = {
  clusters: ReadonlyArray<ReadonlyArray<number>>;
  truth: {mean: number; icc: number; designEffect: number; betweenSd: number; withinSd: number};
};

/**
 * A one-way random-effects generator for the VP-margin interval: `y = mean + b_g + e`, with
 * `b_g ~ N(0, betweenSd²)` and `e ~ N(0, withinSd²)`. The ICC is
 * `betweenSd² / (betweenSd² + withinSd²)` exactly.
 *
 * Sized against reality by the caller: at 2p the measured per-game margin standard deviation is
 * **26.2 VP** with a mean of +0.878, and the measured margin design effect is 1.043 at 2p, 1.516 at
 * 3p and 1.184 at 4p (§2.3). The 3p figure is the one that matters - the margin interval there is
 * 23% too narrow uncorrected, and AC-5 lives at 3p.
 */
export function simulateClusteredContinuous(scenario: ContinuousScenario): ContinuousSample {
  const {groups, clusterSize, mean, betweenSd, withinSd, random} = scenario;
  const clusters: Array<Array<number>> = [];
  for (let group = 0; group < groups; group++) {
    const offset = betweenSd * sampleNormal(random);
    const cluster: Array<number> = [];
    for (let row = 0; row < clusterSize; row++) {
      cluster.push(mean + offset + withinSd * sampleNormal(random));
    }
    clusters.push(cluster);
  }
  const icc = betweenSd ** 2 / (betweenSd ** 2 + withinSd ** 2);
  return {clusters, truth: {mean, icc, designEffect: 1 + (clusterSize - 1) * icc, betweenSd, withinSd}};
}

// ---------------------------------------------------------------------------------------------
// Full observation sets: what Unit B fits ratings to
// ---------------------------------------------------------------------------------------------

export type SimulationSpec = {
  players: 2 | 3 | 4;
  /**
   * One latent strength per **lineup slot**, in logits (multiply by `400 / ln 10` for the Elo
   * scale). A slot's identity may repeat - that is how a synthetic corpus exercises hazard H2.
   */
  strengths: ReadonlyArray<number>;
  /** One identity per slot; defaults to `sim-0@1`, `sim-1@1`, ... A repeat is deliberate and legal. */
  identities?: ReadonlyArray<Identity>;
  groups: number;
  /** Games per group. Defaults to the real pairing design's permutation count for this player count. */
  clusterSize?: number;
  /**
   * Per-group latent-difficulty spread, in logits, added independently to every slot's strength for
   * every game in the group. `0` gives independent games - the analytic anchor. This is the only
   * mechanism offered here: `beta-binomial` mixes a *binary* success probability and has no
   * canonical placement analogue, so forcing one would be inventing a model rather than testing one.
   */
  groupSpread?: number;
  /** Optional per-seat advantage in logits, so a seat effect can be generated deliberately. */
  seatAdvantage?: ReadonlyArray<number>;
  /** VP scale, for synthesizing a margin: `victoryPoints = vpBase + vpPerLogit · strength + noise`. */
  vp?: {base: number; perLogit: number; noiseSd: number};
  runId?: string;
  /** Group indices start here, so two synthetic corpora can be pooled without colliding. */
  startGroup?: number;
  random: AgentRandom;
};

export type SimulatedCorpus = {
  observations: ObservationSet;
  truth: {
    /** Exact by construction: these are the generator's inputs. What a rating fit is estimating. */
    strengths: Readonly<Record<Identity, number>>;
    /** The same strengths on the Elo scale, anchored at the first identity. */
    eloGaps: Readonly<Record<Identity, number>>;
    /**
     * Marginal first-place probability per identity. **Present only when `groupSpread` is 0**, where
     * Plackett-Luce gives it in closed form as `exp(θ_i) / Σ exp(θ_j)` summed over the seats the
     * identity holds. Above that it is `undefined` rather than a quadrature approximation quoted as
     * ground truth - a coverage study checked against an approximate truth is checking the
     * approximation.
     */
    firstPlaceRate?: Readonly<Record<Identity, number>>;
    groupSpread: number;
  };
};

/** Logits per Elo point. The scale conversion, in one place, so B and C cannot disagree about it. */
export const ELO_PER_LOGIT = 400 / Math.LN10;

/**
 * A full synthetic observation set with known latent strengths: what Unit B's rating recovery study
 * (criterion P5) fits, and what a `NaN`-free degenerate-stratum test is built from.
 *
 * Outcomes come from a **Plackett-Luce** ranking over `exp(θ_slot + δ_group,slot + seatAdvantage)`,
 * which at two players is exactly Bradley-Terry. That is the same family §3.3 fits, so this
 * generator is *not* independent of the estimator's model - it cannot be, since a rating study has
 * to know the truth - and that is precisely why the interval calibration in P2/P3 is done on the
 * binary and continuous generators above, where the mechanisms genuinely differ (H12).
 */
export function simulateObservations(spec: SimulationSpec): SimulatedCorpus {
  const {players, strengths, groups, random} = spec;
  if (strengths.length !== players) {
    throw new Error(`strengths must name one value per slot: expected ${players}, got ${strengths.length}`);
  }
  const identities = spec.identities ?? strengths.map((_unused, slot) => `sim-${slot}@1`);
  if (identities.length !== players) {
    throw new Error(`identities must name one per slot: expected ${players}, got ${identities.length}`);
  }
  const permutations = permutationsFor(players);
  const clusterSize = spec.clusterSize ?? permutations.length;
  const groupSpread = spec.groupSpread ?? 0;
  const seatAdvantage = spec.seatAdvantage ?? strengths.map(() => 0);
  const vp = spec.vp ?? {base: 60, perLogit: 8, noiseSd: 18};
  const runId = spec.runId ?? 'sim';
  const startGroup = spec.startGroup ?? 0;

  const rows: Array<Observation> = [];
  for (let group = 0; group < groups; group++) {
    const groupIndex = startGroup + group;
    const offsets = strengths.map(() => groupSpread * sampleNormal(random));
    for (let permutationIndex = 0; permutationIndex < clusterSize; permutationIndex++) {
      const seating = permutations[permutationIndex % permutations.length];
      // seatStrength[seat] is the strength of whoever is sitting there, this game.
      const seatStrength = seating.map((slot, seat) => strengths[slot] + offsets[slot] + seatAdvantage[seat]);
      const ranking = plackettLuceRanking(seatStrength, random);
      const placement = new Array<number>(players);
      ranking.forEach((seat, rank) => {
        placement[seat] = rank + 1;
      });

      // The VP totals are sampled independently of the ranking and then **handed out by
      // placement**, so the recorded placement and the recorded VP order always agree. Every real
      // record has that property (`ranking.ts` derives placement *from* VP), and a synthetic corpus
      // that broke it would let a bug that reads one instead of the other pass unnoticed.
      const sampledVp = seatStrength.map((strength) =>
        Math.round(vp.base + vp.perLogit * strength + vp.noiseSd * sampleNormal(random)));
      const sortedVp = [...sampledVp].sort((a, b) => b - a);
      const assignedVp = placement.map((rank) => sortedVp[rank - 1]);

      for (let seat = 0; seat < players; seat++) {
        const slot = seating[seat];
        const identity = identities[slot];
        const bestOther = Math.max(...assignedVp.filter((_unused, other) => other !== seat));
        rows.push({
          clusterId: `${runId}#${groupIndex}`,
          runId,
          groupIndex,
          permutationIndex,
          players,
          engineSeed: groupIndex,
          seat,
          slot,
          identity,
          win: placement[seat] === 1 ? 1 : 0,
          score: placement[seat] === 1 ? 1 : 0,
          tiedWinners: placement[seat] === 1 ? 1 : 0,
          placement: placement[seat],
          margin: assignedVp[seat] - bestOther,
          marginToNext: undefined,
          victoryPoints: assignedVp[seat],
          megaCredits: 0,
          terraformRating: 0,
          generation: 14,
          opponents: seating.filter((_unused, other) => other !== seat).map((other) => identities[other]),
          seatsHeld: identities.filter((other) => other === identities[slot]).length,
        });
      }
    }
  }

  const strengthByIdentity: Record<Identity, number> = {};
  identities.forEach((identity, slot) => {
    strengthByIdentity[identity] = strengths[slot];
  });
  const anchor = strengths[0];
  const eloGaps: Record<Identity, number> = {};
  for (const [identity, strength] of Object.entries(strengthByIdentity)) {
    eloGaps[identity] = (strength - anchor) * ELO_PER_LOGIT;
  }

  let firstPlaceRate: Record<Identity, number> | undefined;
  if (groupSpread === 0 && seatAdvantage.every((value) => value === 0)) {
    const weights = strengths.map((strength) => Math.exp(strength));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const rates: Record<Identity, number> = {};
    identities.forEach((identity, slot) => {
      // Summed over the seats the identity holds - which is the AC-5 null restated (hazard H2).
      rates[identity] = (rates[identity] ?? 0) + weights[slot] / total;
    });
    firstPlaceRate = rates;
  }

  return {
    observations: {
      rows,
      identities: [...new Set(identities)].sort(),
      playerCounts: [players],
      sources: [],
      exclusions: {unbalancedGroups: 0, excludedGames: 0},
      sharedEngineSeeds: [],
    },
    truth: {strengths: strengthByIdentity, eloGaps, ...(firstPlaceRate === undefined ? {} : {firstPlaceRate}), groupSpread},
  };
}

/** A Plackett-Luce ranking: repeatedly draw without replacement, proportional to `exp(strength)`. */
function plackettLuceRanking(strengths: ReadonlyArray<number>, random: AgentRandom): ReadonlyArray<number> {
  const remaining = strengths.map((_unused, index) => index);
  const ranking: Array<number> = [];
  while (remaining.length > 0) {
    const weights = remaining.map((index) => Math.exp(strengths[index]));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let threshold = random.next() * total;
    let chosen = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      threshold -= weights[i];
      if (threshold <= 0) {
        chosen = i;
        break;
      }
    }
    ranking.push(remaining[chosen]);
    remaining.splice(chosen, 1);
  }
  return ranking;
}

// ---------------------------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------------------------

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/** Box-Muller. One normal per call - the second is discarded, so the stream stays trivially seekable. */
function sampleNormal(random: AgentRandom): number {
  // `next()` is in [0, 1) and `log(0)` is -Infinity, so the lower endpoint is stepped over.
  const u = 1 - random.next();
  const v = random.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Beta via two Gamma draws: `X / (X + Y)` with `X ~ Γ(α)`, `Y ~ Γ(β)`. */
function sampleBeta(random: AgentRandom, alpha: number, beta: number): number {
  const x = sampleGamma(random, alpha);
  const y = sampleGamma(random, beta);
  return x + y === 0 ? 0.5 : x / (x + y);
}

/** Marsaglia-Tsang, with the standard boost for `shape < 1`. */
function sampleGamma(random: AgentRandom, shape: number): number {
  if (shape < 1) {
    return sampleGamma(random, shape + 1) * Math.pow(1 - random.next(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = sampleNormal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) {
      continue;
    }
    const u = 1 - random.next();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) {
      return d * v;
    }
  }
}

/**
 * Integrates `f(centre + sigma·z)` against a standard normal, by midpoint rule over [-8, 8].
 *
 * A grid rather than Gauss-Hermite: the integrand is a logistic, which is smooth and bounded, so
 * 801 midpoints over +/- 8 sigma give ~1e-6 relative - well inside what a target ICC needs - and a
 * grid is a thing a reader can check, where hard-coded quadrature nodes are a thing a reader has to
 * trust. The node count and the bisection depths below are also what keep a sampler build at
 * milliseconds; they are called once per scenario and cached, but Unit C's grid has many scenarios.
 */
function normalIntegral(f: (x: number) => number, centre: number, sigma: number): number {
  const nodes = 801;
  const from = -8;
  const to = 8;
  const step = (to - from) / nodes;
  let total = 0;
  let weight = 0;
  for (let i = 0; i < nodes; i++) {
    const z = from + (i + 0.5) * step;
    const density = Math.exp(-z * z / 2);
    total += density * f(centre + sigma * z);
    weight += density;
  }
  return total / weight;
}

/** The `sigma` whose logit-normal mixture has the target variance at the target marginal rate. */
function solveSigma(rate: number, targetVariance: number): number {
  let low = 1e-6;
  let high = 40;
  for (let iteration = 0; iteration < 60; iteration++) {
    const mid = (low + high) / 2;
    const centre = solveCentre(rate, mid);
    const mean = normalIntegral(logistic, centre, mid);
    const second = normalIntegral((x) => logistic(x) ** 2, centre, mid);
    if (second - mean * mean < targetVariance) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

/** The `centre` at which `E[logistic(centre + sigma·Z)] = rate`. Jensen means this is not `logit(rate)`. */
function solveCentre(rate: number, sigma: number): number {
  let low = -60;
  let high = 60;
  for (let iteration = 0; iteration < 60; iteration++) {
    const mid = (low + high) / 2;
    if (normalIntegral(logistic, mid, sigma) < rate) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}
