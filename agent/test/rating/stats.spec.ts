import {expect} from 'chai';
import {wilson95} from '../../src/match/runner';
import {analysisRandom} from '../../src/rating/bootstrap';
import {clustersOf, observationsOf} from '../../src/rating/observations';
import {
  clusterDesign,
  groupSignFlipTest,
  lnGamma,
  marginDistribution,
  meanEstimate,
  minimumDetectableRate,
  normalCdf,
  normalQuantile,
  normalUpperTail,
  powerAt,
  proportionEstimate,
  regularizedIncompleteBeta,
  requiredGames,
  requiredGroups,
  studentTQuantile,
  thresholdTest,
  wilsonInterval,
} from '../../src/rating/stats';
import {isUnestimable} from '../../src/rating/types';
import {COMMITTED_CORPORA, loadCommittedReports} from './corpora';

/**
 * The statistics core, and **criterion P4a**.
 *
 * Two kinds of check live here and they answer different questions:
 *
 * - **Against mathematics.** The special functions are hand-rolled (`stats.ts` explains why), and a
 *   quietly wrong `erfc` in the tail would make every p-value in this pipeline wrong in a direction
 *   nobody would ever see by inspection. Each is checked against a published value.
 * - **Against §2.3's pre-registered measurements.** The design-effect table was computed while the
 *   plan was written, *before* this estimator existed. Reproducing it is a check; disagreeing with
 *   it is a finding. Same for §2.5's two power tables.
 */
describe('rating statistics (§3.1, §2.5)', function() {
  this.timeout(120_000);

  // -------------------------------------------------------------------------------------------
  // Numerics, against published values
  // -------------------------------------------------------------------------------------------

  describe('special functions', () => {
    it('normalCdf and normalQuantile invert each other at the textbook points', () => {
      expect(normalCdf(1.959964)).to.be.closeTo(0.975, 1e-7);
      expect(normalCdf(0)).to.be.closeTo(0.5, 1e-15);
      expect(normalCdf(-2.5758293)).to.be.closeTo(0.005, 1e-8);
      expect(normalQuantile(0.975)).to.be.closeTo(1.9599640, 1e-7);
      expect(normalQuantile(0.95)).to.be.closeTo(1.6448536, 1e-7);
      expect(normalQuantile(0.8)).to.be.closeTo(0.8416212, 1e-7);
    });

    it('keeps its digits in the far tail, where a p-value at 99.2% actually lives', () => {
      // `1 - normalCdf(z)` has no digits left past z ~ 8.3; the upper tail is computed directly for
      // exactly this reason, and a gate p-value on a near-separated pair is in this regime.
      expect(normalUpperTail(6)).to.be.closeTo(9.865876e-10, 1e-15);
      expect(normalUpperTail(8)).to.be.closeTo(6.220961e-16, 1e-21);
      expect(normalUpperTail(10)).to.be.closeTo(7.619853e-24, 1e-29);
      expect(1 - normalCdf(10), 'the naive form has nothing left here').to.equal(0);
      // And a CDF is never outside [0, 1], which the composed rounding would otherwise allow -
      // a "probability" of 1 + 7e-16 becomes a *negative* tail the moment anyone subtracts it.
      expect(normalCdf(40)).to.equal(1);
      expect(normalCdf(-40)).to.equal(0);
    });

    it('lnGamma and the regularized incomplete beta match closed forms', () => {
      expect(lnGamma(0.5)).to.be.closeTo(Math.log(Math.sqrt(Math.PI)), 1e-12);
      expect(lnGamma(5)).to.be.closeTo(Math.log(24), 1e-12);
      // For integer a, b: I_x(a,b) = Σ_{j=a}^{a+b-1} C(a+b-1, j) x^j (1-x)^{a+b-1-j}.
      expect(regularizedIncompleteBeta(2, 3, 0.5)).to.be.closeTo(11 / 16, 1e-12);
      expect(regularizedIncompleteBeta(3, 2, 0.5)).to.be.closeTo(5 / 16, 1e-12);
    });

    it('reproduces published Student-t quantiles', () => {
      expect(studentTQuantile(0.975, 1)).to.be.closeTo(12.7062047, 1e-6);
      expect(studentTQuantile(0.975, 10)).to.be.closeTo(2.2281389, 1e-6);
      expect(studentTQuantile(0.975, 30)).to.be.closeTo(2.0422725, 1e-6);
      expect(studentTQuantile(0.975, 100)).to.be.closeTo(1.9839715, 1e-6);
      expect(studentTQuantile(0.025, 10)).to.be.closeTo(-2.2281389, 1e-6);
    });
  });

  describe('the Wilson interval', () => {
    it('agrees with match/runner.ts wilson95 whenever the effective n is the real n', () => {
      for (const [successes, trials] of [[992, 1_000], [516, 1_000], [0, 40], [40, 40], [1, 3]]) {
        const runner = wilson95(successes, trials);
        const here = wilsonInterval(successes / trials, trials);
        expect(here.low, `${successes}/${trials} low`).to.be.closeTo(runner.low, 1e-12);
        expect(here.high, `${successes}/${trials} high`).to.be.closeTo(runner.high, 1e-12);
      }
    });

    it('stays inside [0, 1] at 99.2%, which is where the baselines actually are', () => {
      const interval = wilsonInterval(0.992, 1_000);
      expect(interval.high).to.be.at.most(1);
      expect(interval.low).to.be.greaterThan(0.98);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The clustering
  // -------------------------------------------------------------------------------------------

  describe('the design effect', () => {
    it('is about 1 on independent rows and about m on perfectly correlated ones', () => {
      // A null with genuine between-group variation: group means cycle 0.5, 0.5, 1, 0.
      const independent = clusterDesign(nullClusters(400), binomial);
      expect(isUnestimable(independent)).to.equal(false);
      if (!isUnestimable(independent)) {
        expect(independent.designEffect, 'ICC 0').to.be.closeTo(1, 0.02);
      }
      // Perfectly correlated clusters: every row in a group identical. The finite-sample G/(G-1)
      // factor puts this at m·G/(G-1) rather than exactly m, which is the standard correction and
      // is the same factor §2.3's pre-registered table carries.
      const groups = 200;
      const correlated = clusterDesign(Array.from({length: groups}, (_u, g) => [g % 2, g % 2]), binomial);
      if (!isUnestimable(correlated)) {
        expect(correlated.designEffect, 'm = 2, ICC = 1').to.be.closeTo(2 * groups / (groups - 1), 1e-9);
        expect(correlated.icc).to.be.closeTo(2 * groups / (groups - 1) - 1, 1e-9);
      }
    });

    it('refuses a sample in which every group has the identical mean, rather than returning NaN', () => {
      // Every cluster is [0, 1]: the between-group variance is exactly 0, so `deff` would be 0, the
      // effective n infinite, the interval zero-width and the p-value `(p - p0) / 0` = NaN. This
      // spec is what found that (hazard H9 through the one door the types do not guard).
      const design = clusterDesign(chunk(alternating(400), 2), binomial);
      expect(isUnestimable(design)).to.equal(true);
      if (isUnestimable(design)) {
        expect(design.reason).to.match(/identical mean/);
      }
      const test = thresholdTest(chunk(alternating(400), 2), {threshold: 0.5, hypothesis: 'test'});
      expect(isUnestimable(test), 'and the test refuses too, rather than reporting NaN').to.equal(true);
    });

    it('satisfies deff = 1 + (m - 1)·ICC by construction, at every cluster size', () => {
      for (const m of [2, 4, 6]) {
        const clusters = Array.from({length: 300}, (_u, g) => new Array<number>(m).fill(g % 3 === 0 ? 1 : 0));
        const design = clusterDesign(clusters, binomial);
        if (!isUnestimable(design)) {
          expect(design.designEffect, `m = ${m}`).to.be.closeTo(1 + (m - 1) * design.icc, 1e-9);
        }
      }
    });

    it('reports an assumption rather than a NaN when every row is a win (hazard H3, H9)', () => {
      const design = clusterDesign(Array.from({length: 50}, () => [1, 1]), binomial);
      expect(isUnestimable(design)).to.equal(false);
      if (!isUnestimable(design)) {
        expect(Number.isNaN(design.designEffect), 'never NaN').to.equal(false);
        expect(design.effectiveN, 'falls back to the group count').to.equal(50);
        expect(design.note, 'and says it is an assumption').to.match(/unidentified/);
      }
    });

    it('is unestimable, with a reason, below two groups', () => {
      const design = clusterDesign([[1, 0]], binomial);
      expect(isUnestimable(design)).to.equal(true);
      if (isUnestimable(design)) {
        expect(design.reason).to.match(/at least 2/);
      }
    });

    it('never floors at 1 - a blocked design legitimately produces deff < 1 (§3.1)', () => {
      // Every group holds exactly one win and one loss: less between-group variance than binomial.
      const design = clusterDesign(Array.from({length: 200}, () => [1, 0]), binomial);
      if (!isUnestimable(design)) {
        expect(design.designEffect).to.be.lessThan(1);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // P4a: §2.3's pre-registered table
  // -------------------------------------------------------------------------------------------

  describe('P4a - reproduces §2.3 on the committed self-play corpora', () => {
    /** The table pre-registered in §2.3, before this estimator existed. */
    const EXPECTED = [
      {players: 2, groups: 500, m: 2, winRate: 0.5160, deffWin: 1.033, icc: 0.033, deffMargin: 1.043, meanMargin: 0.878, sdMargin: 26.2},
      {players: 3, groups: 100, m: 6, winRate: 0.3433, deffWin: 1.252, icc: 0.050, deffMargin: 1.516, meanMargin: -6.8, sdMargin: 17.1},
      {players: 4, groups: 25, m: 4, winRate: 0.3300, deffWin: 1.293, icc: 0.098, deffMargin: 1.184, meanMargin: -6.7, sdMargin: 13.7},
    ];

    it('reproduces every cell to three significant figures', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[0], this);
      for (const expected of EXPECTED) {
        const artifact = artifacts.find((entry) => entry.report.summary.players === expected.players);
        expect(artifact, `${expected.players}p run`).to.not.equal(undefined);
        const rows = observationsOf(artifact as never).rows.filter((row) => row.slot === 0);
        const clusters = clustersOf(rows);

        expect(clusters, `${expected.players}p groups`).to.have.length(expected.groups);
        const win = proportionEstimate(clusters.map((cluster) => cluster.map((row) => row.win)));
        const margin = meanEstimate(clusters.map((cluster) => cluster.map((row) => row.margin)));
        expect(isUnestimable(win) || isUnestimable(margin)).to.equal(false);
        if (isUnestimable(win) || isUnestimable(margin)) {
          return;
        }

        expect(win.design.meanClusterSize, `${expected.players}p m`).to.equal(expected.m);
        expect(win.rate, `${expected.players}p slot-0 win rate`).to.be.closeTo(expected.winRate, 5e-5);
        expect(win.design.designEffect, `${expected.players}p deff (win)`).to.be.closeTo(expected.deffWin, 5e-4);
        expect(win.design.icc, `${expected.players}p ICC`).to.be.closeTo(expected.icc, 5e-4);
        expect(margin.design.designEffect, `${expected.players}p deff (margin)`).to.be.closeTo(expected.deffMargin, 5e-4);
        expect(margin.mean, `${expected.players}p mean margin`).to.be.closeTo(expected.meanMargin, 0.05);
        expect(margin.sd, `${expected.players}p margin sd`).to.be.closeTo(expected.sdMargin, 0.05);
      }
    });

    it('leaves every point estimate exactly where the runner put it - only intervals move', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[0], this);
      for (const artifact of artifacts) {
        for (const slot of artifact.report.summary.bySlot) {
          const rows = observationsOf(artifact).rows.filter((row) => row.slot === slot.slot);
          const estimate = proportionEstimate(clustersOf(rows).map((cluster) => cluster.map((row) => row.win)));
          if (!isUnestimable(estimate)) {
            expect(estimate.rate, `slot ${slot.slot}`).to.equal(slot.winRate);
          }
        }
      }
    });

    it('produces an interval that is wider than the runner\'s uncorrected one, never narrower', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[0], this);
      for (const artifact of artifacts) {
        const rows = observationsOf(artifact).rows.filter((row) => row.slot === 0);
        const estimate = proportionEstimate(clustersOf(rows).map((cluster) => cluster.map((row) => row.win)));
        if (isUnestimable(estimate)) {
          continue;
        }
        const uncorrected = wilson95(estimate.successes, estimate.trials);
        const correctedWidth = estimate.ci95.high - estimate.ci95.low;
        expect(correctedWidth, `${artifact.report.summary.players}p width`)
          .to.be.greaterThan(uncorrected.high - uncorrected.low);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------------------------

  describe('the one-sided threshold test', () => {
    it('is the exact inverse of the power calculator', () => {
      // If a run is sized for 80% power against 0.55, then a realized rate of exactly 0.55 should
      // land the p-value where the calculator says it does. This is what makes criterion P3's
      // "power agrees with the calculator to within 2 pp" a check on both rather than a tautology.
      const games = requiredGames({rate: 0.55, nullRate: 0.5, designEffect: 1.0});
      expect(typeof games).to.equal('number');
      if (typeof games !== 'number') {
        return;
      }
      expect(powerAt(games, {rate: 0.55, nullRate: 0.5, designEffect: 1.0})).to.be.closeTo(0.8, 0.002);
    });

    it('does not reject on data drawn from the null', () => {
      const test = thresholdTest(nullClusters(1_000), {threshold: 0.5, hypothesis: 'test'});
      expect(isUnestimable(test)).to.equal(false);
      if (!isUnestimable(test)) {
        expect(test.rejected).to.equal(false);
        expect(test.pValue).to.be.closeTo(0.5, 0.01);
      }
    });

    it('refuses a degenerate threshold rather than dividing by zero (H9)', () => {
      const test = thresholdTest(nullClusters(100), {threshold: 1, hypothesis: 'test'});
      expect(isUnestimable(test)).to.equal(true);
    });
  });

  describe('the group sign-flip randomization test', () => {
    it('is reproducible from the analysis seed, and only from it', () => {
      const values = Array.from({length: 60}, (_u, g) => (g % 3 === 0 ? 0.8 : 0.4));
      const options = {centre: 0.5, hypothesis: 'test', replicates: 500};
      const a = groupSignFlipTest(values, {...options, random: analysisRandom(41_000_003)});
      const b = groupSignFlipTest(values, {...options, random: analysisRandom(41_000_003)});
      const c = groupSignFlipTest(values, {...options, random: analysisRandom(41_000_009)});
      expect(a).to.deep.equal(b);
      expect(a).to.not.deep.equal(c);
    });

    it('never reports a p-value of exactly zero - the +1 keeps the test valid at its nominal level', () => {
      const values = new Array(40).fill(1);
      const test = groupSignFlipTest(values, {
        centre: 0, hypothesis: 'test', replicates: 200, random: analysisRandom(41_000_003),
      });
      if (!isUnestimable(test)) {
        expect(test.pValue).to.be.greaterThan(0);
        expect(test.pValue).to.be.closeTo(1 / 201, 1e-12);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // P4a's companion: §2.5's power tables
  // -------------------------------------------------------------------------------------------

  describe('§2.5 - the power and sample-size tables', () => {
    const inputs = {nullRate: 0.5, designEffect: 1.03};

    it('reproduces the pre-registered sample sizes, and records the one row that differs', () => {
      expect(requiredGames({...inputs, rate: 0.65})).to.equal(69);
      expect(requiredGames({...inputs, rate: 0.55})).to.equal(635);
      expect(requiredGames({...inputs, rate: 0.53})).to.equal(1_767);
      expect(requiredGames({...inputs, rate: 0.52})).to.equal(3_978);
      // §2.5 says 157 here. The raw requirement is 157.03, and the plan's throwaway script rounded
      // to nearest where this rounds **up**: 157 games gives 79.9% power, not 80%. The plan's other
      // four rows are unaffected because none of them lands within half a game of an integer.
      expect(requiredGames({...inputs, rate: 0.60}), 'the one documented deviation').to.equal(158);
      expect(powerAt(157, {...inputs, rate: 0.60}), 'and why').to.be.lessThan(0.8);
      expect(powerAt(158, {...inputs, rate: 0.60})).to.be.greaterThan(0.8);
    });

    it('reproduces the pairing-group column', () => {
      expect(requiredGroups(69, 2)).to.equal(35);
      expect(requiredGroups(157, 2)).to.equal(79);
      expect(requiredGroups(635, 2)).to.equal(318);
      expect(requiredGroups(1_767, 2)).to.equal(884);
      expect(requiredGroups(3_978, 2)).to.equal(1_989);
    });

    it('reproduces the minimum-detectable-effect table exactly', () => {
      const expected: ReadonlyArray<[number, number]> =
        [[200, 0.589], [500, 0.556], [1_000, 0.540], [2_000, 0.528], [6_000, 0.516]];
      for (const [games, detectable] of expected) {
        const actual = minimumDetectableRate(games, inputs);
        expect(typeof actual, `${games} games`).to.equal('number');
        if (typeof actual === 'number') {
          expect(Number(actual.toFixed(3)), `${games} games`).to.equal(detectable);
        }
      }
    });

    it('says plainly that 1,000 games resolves a 4 pp edge and nothing finer', () => {
      const detectable = minimumDetectableRate(1_000, inputs);
      if (typeof detectable === 'number') {
        expect(detectable - 0.5).to.be.closeTo(0.04, 0.0005);
      }
    });

    it('refuses to size a run for an effect that is not there', () => {
      expect(isUnestimable(requiredGames({...inputs, rate: 0.5}) as never)).to.equal(true);
    });
  });

  describe('the margin distribution (§3.2)', () => {
    it('reports observed values, uninterpolated', () => {
      const distribution = marginDistribution([-10, -3, 0, 4, 22]);
      expect(distribution).to.deep.equal({min: -10, p5: -10, p50: 0, p95: 22, max: 22});
    });

    it('is unestimable on an empty sample rather than NaN (H9)', () => {
      expect(isUnestimable(marginDistribution([]))).to.equal(true);
    });
  });
});

function binomial(_values: ReadonlyArray<number>, mean: number): number {
  return mean * (1 - mean);
}

/**
 * A null sample at exactly 50% with genuine between-group variation: group means cycle
 * 0.5, 0.5, 1, 0. Deterministic, so no spec here is flaky, and non-degenerate, so the estimator
 * has a between-group variance to work with.
 */
function nullClusters(rows: number): ReadonlyArray<ReadonlyArray<number>> {
  const pattern: ReadonlyArray<ReadonlyArray<number>> = [[1, 0], [0, 1], [1, 1], [0, 0]];
  return Array.from({length: Math.floor(rows / 2)}, (_unused, group) => pattern[group % 4]);
}

/** `[1, 0, 1, 0, ...]` - exactly 50%, with no randomness to make a spec flaky. */
function alternating(length: number): ReadonlyArray<number> {
  return Array.from({length}, (_unused, index) => index % 2);
}

function chunk(values: ReadonlyArray<number>, size: number): ReadonlyArray<ReadonlyArray<number>> {
  const chunks: Array<ReadonlyArray<number>> = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}
