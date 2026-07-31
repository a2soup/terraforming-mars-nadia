import {expect} from 'chai';
import {analysisRandom} from '../../src/rating/bootstrap';
import {gameClustersOf, identityGames} from '../../src/rating/observations';
import {proportionEstimate} from '../../src/rating/stats';
import {
  CLUSTER_MECHANISMS,
  ELO_PER_LOGIT,
  simulateClusteredBinary,
  simulateClusteredContinuous,
  simulateObservations,
} from '../../src/rating/simulate';
import {isUnestimable} from '../../src/rating/types';

/**
 * The synthetic generator - the instrument Units B and C validate against - plus **Unit A's own
 * coverage smoke run**.
 *
 * Two things are checked and they are not the same thing:
 *
 * 1. **The generator produces what it claims.** A generator whose marginal rate is not the rate it
 *    was asked for, or whose ICC is not the ICC it was asked for, makes every coverage number Unit
 *    C reports a measurement of the generator rather than of the estimator. Both mechanisms are
 *    checked against their stated targets at large sample size.
 * 2. **The two mechanisms are genuinely different** (hazard H12). If `beta-binomial` and
 *    `latent-difficulty` produced the same mixing density there would be one mechanism wearing two
 *    names, and §3.9's central mitigation would be decorative. The difference is asserted on a
 *    third moment, not just on the two the parameters fix.
 *
 * The coverage smoke at the end is Unit A's hand-off gate: one scenario, 1,000 replications, and if
 * it lands outside [93%, 97%] the estimator is wrong and Unit C should not be handed it.
 */
describe('the synthetic generator (§3.9, hazard H12)', function() {
  this.timeout(180_000);

  describe('the binary generator hits its stated parameters', () => {
    for (const mechanism of CLUSTER_MECHANISMS) {
      it(`reaches the target marginal rate and ICC under '${mechanism}'`, () => {
        for (const rate of [0.5, 0.65, 0.9]) {
          for (const icc of [0.05, 0.2]) {
            const sample = simulateClusteredBinary({
              groups: 20_000, clusterSize: 6, rate, icc, mechanism, random: analysisRandom(31 + Math.round(icc * 100)),
            });
            const estimate = proportionEstimate(sample.clusters);
            expect(isUnestimable(estimate)).to.equal(false);
            if (isUnestimable(estimate)) {
              continue;
            }
            const where = `${mechanism} p=${rate} icc=${icc}`;
            expect(estimate.rate, `${where}: marginal rate`).to.be.closeTo(rate, 0.01);
            expect(estimate.design.icc, `${where}: ICC`).to.be.closeTo(icc, 0.02);
            expect(estimate.design.designEffect, `${where}: deff`).to.be.closeTo(sample.truth.designEffect, 0.12);
          }
        }
      });
    }

    it('degenerates to independent Bernoulli draws at ICC 0 - the analytic anchor', () => {
      for (const mechanism of CLUSTER_MECHANISMS) {
        const sample = simulateClusteredBinary({
          groups: 20_000, clusterSize: 6, rate: 0.65, icc: 0, mechanism, random: analysisRandom(37),
        });
        const estimate = proportionEstimate(sample.clusters);
        if (!isUnestimable(estimate)) {
          expect(estimate.design.designEffect, `${mechanism} at ICC 0`).to.be.closeTo(1, 0.05);
        }
      }
    });

    /**
     * **H12, measured rather than asserted - and the answer is smaller than §3.9 implies.**
     *
     * At cluster size `m` the complete sufficient summary of a clustered-binary mixture is the
     * distribution of the group sum over `0..m`, so total-variation distance between the two
     * mechanisms' histograms is the honest measure of how different they are. Fixing both the
     * marginal rate and the ICC pins a unimodal density on [0, 1] tightly, and the measured answer
     * (200,000 groups, m = 6) is 0.20% - 2.23% depending on the cell, **largest at p = 0.90 with
     * ICC = 0.20 and smallest in the symmetric p = 0.50 row a reader would assume carried it.**
     *
     * So the mechanisms are distinct, and that is asserted here. But they are not *far apart*, and
     * `simulate.ts`'s module doc carries the full table plus what follows for Unit C: the pair
     * cannot detect an estimator that is wrong in a way common to every two-moment-matched mixture,
     * so §3.9's other two mitigations are carrying more weight than the plan implies.
     */
    it('gives the two mechanisms genuinely different mixing densities (H12)', () => {
      const groups = 50_000;
      const clusterSize = 6;
      const histograms = CLUSTER_MECHANISMS.map((mechanism) => {
        const sample = simulateClusteredBinary({
          groups, clusterSize, rate: 0.9, icc: 0.2, mechanism, random: analysisRandom(41),
        });
        const counts = new Array<number>(clusterSize + 1).fill(0);
        for (const cluster of sample.clusters) {
          counts[cluster.reduce((total, value) => total + value, 0)]++;
        }
        return counts.map((count) => count / groups);
      });
      const totalVariation = 0.5 * histograms[0]
        .reduce((total, share, bin) => total + Math.abs(share - histograms[1][bin]), 0);

      expect(totalVariation,
        `total variation between the two mechanisms' group-sum distributions at p=0.90, ICC=0.20: ` +
        `${(totalVariation * 100).toFixed(2)}%. If this reaches zero there is one mechanism wearing ` +
        'two names and §3.9\'s central mitigation is decorative.').to.be.greaterThan(0.01);
      // And the other half of the finding: they are close, so this is weak evidence, not strong.
      expect(totalVariation, 'and they are never far apart').to.be.lessThan(0.05);
    });

    it('is reproducible from the analysis seed, and only from it', () => {
      const scenario = {groups: 50, clusterSize: 2, rate: 0.6, icc: 0.1, mechanism: 'beta-binomial'} as const;
      const a = simulateClusteredBinary({...scenario, random: analysisRandom(53)});
      const b = simulateClusteredBinary({...scenario, random: analysisRandom(53)});
      const c = simulateClusteredBinary({...scenario, random: analysisRandom(59)});
      expect(a.clusters).to.deep.equal(b.clusters);
      expect(a.clusters).to.not.deep.equal(c.clusters);
    });

    it('refuses parameters it cannot honour rather than silently producing something else', () => {
      const random = analysisRandom(61);
      expect(() => simulateClusteredBinary({groups: 10, clusterSize: 2, rate: 0, icc: 0, mechanism: 'beta-binomial', random}))
        .to.throw(/rate must be in/);
      expect(() => simulateClusteredBinary({groups: 10, clusterSize: 2, rate: 0.5, icc: 1, mechanism: 'beta-binomial', random}))
        .to.throw(/icc must be in/);
    });
  });

  describe('the continuous generator', () => {
    it('hits its stated mean and ICC - the shape the VP margin needs', () => {
      // Sized against the measured 3p margin: sd ~17 VP with a design effect of 1.516 at m = 6,
      // which is ICC ~0.103 and the cell where an uncorrected interval is 23% too narrow.
      const icc = 0.103;
      const total = 17;
      const sample = simulateClusteredContinuous({
        groups: 20_000,
        clusterSize: 6,
        mean: -6.8,
        betweenSd: total * Math.sqrt(icc),
        withinSd: total * Math.sqrt(1 - icc),
        random: analysisRandom(67),
      });
      expect(sample.truth.icc).to.be.closeTo(icc, 1e-9);
      const values = sample.clusters.flat();
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      expect(mean, 'mean').to.be.closeTo(-6.8, 0.2);
      expect(sample.truth.designEffect).to.be.closeTo(1 + 5 * icc, 1e-9);
    });
  });

  describe('full observation sets (what Unit B fits)', () => {
    it('recovers the win rate implied by the latent strengths at two players', () => {
      const gap = Math.log(0.75 / 0.25);
      const corpus = simulateObservations({
        players: 2, strengths: [gap, 0], groups: 5_000, random: analysisRandom(71),
      });
      expect(corpus.truth.firstPlaceRate?.['sim-0@1']).to.be.closeTo(0.75, 1e-12);
      expect(corpus.truth.eloGaps['sim-1@1']).to.be.closeTo(-gap * ELO_PER_LOGIT, 1e-9);

      const games = identityGames(corpus.observations.rows, 'sim-0@1');
      const observed = games.filter((game) => game.win === 1).length / games.length;
      expect(observed, 'empirical win rate').to.be.closeTo(0.75, 0.02);
    });

    it('produces rows the real pipeline consumes, clustered on the pairing group', () => {
      const corpus = simulateObservations({
        players: 2, strengths: [0.5, 0], groups: 300, groupSpread: 0.8, random: analysisRandom(73),
      });
      const clusters = gameClustersOf(identityGames(corpus.observations.rows, 'sim-0@1'));
      expect(clusters, 'one cluster per group').to.have.length(300);
      const estimate = proportionEstimate(clusters.map((cluster) => cluster.map((game) => game.win)));
      expect(isUnestimable(estimate)).to.equal(false);
      if (!isUnestimable(estimate)) {
        // A per-group latent difficulty is exactly what makes games in a group correlated, so a
        // generator that produced no design effect here would be generating the wrong thing.
        expect(estimate.design.designEffect, 'deff under a group spread').to.be.greaterThan(1.05);
      }
    });

    it('exercises hazard H2: one identity holding two of three seats', () => {
      const corpus = simulateObservations({
        players: 3,
        strengths: [0.4, 0.4, 0],
        identities: ['duplicated@1', 'duplicated@1', 'other@1'],
        groups: 400,
        random: analysisRandom(79),
      });
      expect(corpus.observations.identities).to.deep.equal(['duplicated@1', 'other@1']);
      const rows = corpus.observations.rows.filter((row) => row.identity === 'duplicated@1');
      expect(new Set(rows.map((row) => row.seatsHeld))).to.deep.equal(new Set([2]));
      // The closed-form first-place probability sums over the seats the identity holds, which is
      // the AC-5 null restated: two of three equal seats take first place two thirds of the time.
      const equal = simulateObservations({
        players: 3,
        strengths: [0, 0, 0],
        identities: ['duplicated@1', 'duplicated@1', 'other@1'],
        groups: 10,
        random: analysisRandom(83),
      });
      expect(equal.truth.firstPlaceRate?.['duplicated@1']).to.be.closeTo(2 / 3, 1e-12);
    });

    it('keeps the recorded placement and the recorded VP order in agreement, as every real record does', () => {
      const corpus = simulateObservations({
        players: 4, strengths: [1, 0.5, 0, -0.5], groups: 200, random: analysisRandom(89),
      });
      const byGame = new Map<string, Array<{placement: number; victoryPoints: number}>>();
      for (const row of corpus.observations.rows) {
        const key = `${row.groupIndex}#${row.permutationIndex}`;
        byGame.set(key, [...(byGame.get(key) ?? []), row]);
      }
      for (const seats of byGame.values()) {
        const sorted = [...seats].sort((a, b) => a.placement - b.placement);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i - 1].victoryPoints, 'a better placement never has fewer VP')
            .to.be.at.least(sorted[i].victoryPoints);
        }
      }
    });

    it('withholds the marginal first-place rate when it is not exactly computable', () => {
      const corpus = simulateObservations({
        players: 3, strengths: [0.4, 0.2, 0], groups: 10, groupSpread: 0.7, random: analysisRandom(97),
      });
      // Quoting a quadrature approximation as ground truth would make a coverage study a check on
      // the approximation, so it is absent instead. The strengths, which *are* exact, remain.
      expect(corpus.truth.firstPlaceRate).to.equal(undefined);
      expect(corpus.truth.strengths['sim-0@1']).to.equal(0.4);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Unit A's coverage smoke (the hand-off gate)
  // -------------------------------------------------------------------------------------------

  /**
   * **The smoke run Unit A owes Unit C** (Unit A prompt §6): one scenario, >= 500 replications, and
   * if empirical coverage lands outside [93%, 97%] the estimator is wrong and gets fixed *before*
   * the handover rather than being discovered by the calibration study.
   *
   * This is not P2. P2 is a 2,000-replication grid over four rates x three ICCs x two group counts x
   * two cluster sizes x two mechanisms, in a [94.0%, 96.0%] band computed from the replication
   * count, and it is Unit C's. This is one cell, deliberately picked in the awkward part of the
   * space: 100 groups (not 500), ICC 0.05 (small but real), and the beta-binomial mechanism.
   */
  describe('coverage smoke - one scenario, 1,000 replications', () => {
    it('covers the truth at close to 95% for the effective-n Wilson interval', () => {
      const replications = 1_000;
      const rate = 0.65;
      const random = analysisRandom(101);
      let covered = 0;
      let estimable = 0;

      for (let replication = 0; replication < replications; replication++) {
        const sample = simulateClusteredBinary({
          groups: 100, clusterSize: 2, rate, icc: 0.05, mechanism: 'beta-binomial', random,
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

      const coverage = covered / estimable;
      // Reported in the hand-off, not only asserted: the number is the point.
      console.log(`[smoke] effective-n Wilson coverage at p=0.65, ICC=0.05, 100 groups x 2, ` +
        `beta-binomial: ${(coverage * 100).toFixed(1)}% over ${estimable}/${replications} estimable replications`);
      expect(estimable, 'estimable replications').to.equal(replications);
      expect(coverage, 'coverage').to.be.within(0.93, 0.97);
    });
  });
});
