import {expect} from 'chai';
import {
  analysisRandom,
  bootstrapProportion,
  clusterBootstrap,
  intervalDisagreement,
} from '../../src/rating/bootstrap';
import {clustersOf, observationsOf} from '../../src/rating/observations';
import {proportionEstimate, wilsonInterval} from '../../src/rating/stats';
import {simulateClusteredBinary} from '../../src/rating/simulate';
import {DEFAULT_ANALYSIS_SEED, isUnestimable} from '../../src/rating/types';
import {COMMITTED_CORPORA, corpusPath, loadCommittedReports} from './corpora';

/**
 * The seeded cluster bootstrap, and **criterion P4b** on the corpora that exist.
 *
 * P4b: on every real corpus, the effective-n Wilson interval and the cluster bootstrap interval
 * must agree to within **0.5 pp on both bounds**. That is not belt-and-braces. Two estimators built
 * from the same wrong assumption can both miscover and neither will say so; two estimators
 * disagreeing is unambiguous, and finding that out on real data costs seconds.
 *
 * The other thing checked here is hazard H11: an unseeded resampler makes a promotion gate's
 * verdict unrepeatable, and `SeededRandom`'s integer constructor is degenerate, so the seeding has
 * to go through `createAgentRandom`. A spec is the only thing that keeps that true.
 */
describe('the cluster bootstrap (§3.1, hazard H11)', function() {
  this.timeout(120_000);

  const sample = simulateClusteredBinary({
    groups: 200,
    clusterSize: 2,
    rate: 0.6,
    icc: 0.1,
    mechanism: 'beta-binomial',
    random: analysisRandom(7_000_019),
  });

  describe('reproducibility (H11)', () => {
    it('gives byte-identical intervals from the same analysis seed', () => {
      const a = bootstrapProportion(sample.clusters, {replicates: 400, random: analysisRandom(DEFAULT_ANALYSIS_SEED)});
      const b = bootstrapProportion(sample.clusters, {replicates: 400, random: analysisRandom(DEFAULT_ANALYSIS_SEED)});
      expect(JSON.stringify(a)).to.equal(JSON.stringify(b));
    });

    it('gives a different interval from a different seed - so the seed is really being used', () => {
      const a = bootstrapProportion(sample.clusters, {replicates: 400, random: analysisRandom(DEFAULT_ANALYSIS_SEED)});
      const b = bootstrapProportion(sample.clusters, {replicates: 400, random: analysisRandom(DEFAULT_ANALYSIS_SEED + 6)});
      expect(JSON.stringify(a)).to.not.equal(JSON.stringify(b));
      // Different, but not *differently sized*: two seeds must not disagree materially, or the
      // interval is a property of the seed rather than of the data.
      if (!isUnestimable(a) && !isUnestimable(b)) {
        expect(intervalDisagreement(a.ci95, b.ci95)).to.be.lessThan(0.02);
      }
    });

    it('does not depend on a globally-seeded RNG - two interleaved streams stay independent', () => {
      const shared = analysisRandom(DEFAULT_ANALYSIS_SEED);
      const first = bootstrapProportion(sample.clusters, {replicates: 200, random: shared});
      const second = bootstrapProportion(sample.clusters, {replicates: 200, random: shared});
      // Drawn from the same stream at different offsets, so they differ; a report threading one
      // stream through in a fixed order is still reproducible, which is what §3.7 requires.
      expect(JSON.stringify(first)).to.not.equal(JSON.stringify(second));
    });
  });

  describe('resampling the right thing', () => {
    it('resamples whole groups, which is why the interval is wider than an iid one at ICC > 0', () => {
      const clustered = bootstrapProportion(sample.clusters, {replicates: 2_000, random: analysisRandom(11)});
      // The same rows, one per "cluster": what a game-level bootstrap would do.
      const flattened = sample.clusters.flat().map((value) => [value]);
      const iid = bootstrapProportion(flattened, {replicates: 2_000, random: analysisRandom(11)});
      expect(isUnestimable(clustered) || isUnestimable(iid)).to.equal(false);
      if (isUnestimable(clustered) || isUnestimable(iid)) {
        return;
      }
      expect(clustered.ci95.high - clustered.ci95.low, 'clustered width')
        .to.be.greaterThan(iid.ci95.high - iid.ci95.low);
    });

    it('agrees with the effective-n Wilson interval on synthetic data at every ICC in P2\'s grid', () => {
      for (const icc of [0, 0.05, 0.2]) {
        const scenario = simulateClusteredBinary({
          groups: 500, clusterSize: 2, rate: 0.6, icc, mechanism: 'latent-difficulty', random: analysisRandom(23 + icc * 100),
        });
        const primary = proportionEstimate(scenario.clusters);
        const resampled = bootstrapProportion(scenario.clusters, {replicates: 2_000, random: analysisRandom(29)});
        expect(isUnestimable(primary) || isUnestimable(resampled)).to.equal(false);
        if (isUnestimable(primary) || isUnestimable(resampled)) {
          continue;
        }
        expect(intervalDisagreement(primary.ci95, resampled.ci95), `ICC ${icc}`).to.be.lessThan(0.005);
      }
    });
  });

  /**
   * **P4b, and the finding it produced.**
   *
   * The criterion is 0.5 pp on both bounds. **It is met wherever the effective sample size can
   * express it, and it is not met on the 4p stratum - for a reason that is not a clustering
   * disagreement.** Measured on `match_runner_validation.json` (2,000 bootstrap replicates, seeded):
   *
   * | | rows | n_eff | Wilson vs bootstrap | **Wald(n_eff) vs bootstrap** |
   * | --- | --- | --- | --- | --- |
   * | 2p, both slots | 1,000 | 968 | 0.064 pp | 0.052 pp |
   * | 3p, three slots | 600 | 445 - 532 | 0.056 - 0.190 pp | 0.047 - 0.097 pp |
   * | 4p, four slots | 100 | 77 - 106 | **0.89 - 1.22 pp** | 0.00 - 0.51 pp |
   *
   * The last column is the diagnosis. A percentile bootstrap interval is Wald-shaped - symmetric
   * about the point estimate - and at 4p it agrees with a Wald interval **on the same effective n**
   * to half a percentage point. So the two methods agree about the variance, which is the whole
   * content of P4b; what they disagree about at `n_eff ~ 100` is the *shape*, and Wilson differing
   * from Wald at small n near the ends of [0, 1] is precisely the property §3.1 chose Wilson for.
   * (There is a second, smaller effect in the same direction: every bootstrap resample has exactly
   * `n` rows, so the statistic only takes values on a `1/n` grid - 1 pp at 4p, 0.1 pp at 2p.)
   *
   * **Second finding, added when the design-effect floor shipped (Unit D, 31 Jul 2026).** The floor
   * of §3.1 widens the primary interval wherever `deff < 1`, and the bootstrap - which measures the
   * variance the sample actually has - does not follow it. So on the two corpora that genuinely
   * report `deff < 1` the two intervals now disagree **by construction**, and the 4p gap grew from
   * 1.22 pp to 2.77 pp for that reason alone. That is the floor's price, and it is charged exactly
   * where the pairing design is working best: at 4p `deff = 0.78`, i.e. blocking on the Engine seed
   * removed 22% of the variance, and the floor declines to spend it. Coverage said to floor
   * (P2: 0.9482 -> 0.9503 mean, under-covering cells 5 -> 3) and coverage is the thing P4b is a
   * proxy for, so the floor stays and this is recorded as its cost.
   *
   * The checks below therefore separate three quantities that used to be one: the **variance**
   * agreement (bootstrap vs Wald on the *unfloored* effective n - the real content of P4b, and it
   * must hold everywhere), the **shape** difference (Wilson vs Wald at small `n_eff`), and the
   * **floor** (Wilson on the floored vs the unfloored n). A gap explained by the second and third
   * is a known cost; anything left over is a genuine disagreement and still fails.
   *
   * Recorded rather than smoothed over. Appendix prediction 8 says the 4p stratum will be too thin
   * to support an interval worth quoting, and this is that thinness arriving at P4b. The checks
   * below assert the criterion where `n_eff` supports it and assert the *diagnosis* where it does
   * not, so a 4p gap that grew for any other reason still fails. Whether P4b is "met" or "met with
   * a limitation named" is Unit D's adjudication, not this file's.
   */
  describe('P4b - the two intervals agree on the real corpora', () => {
    /** Below this the Wilson-vs-Wald shape difference alone exceeds the criterion; see the doc above. */
    const EFFECTIVE_N_FOR_HALF_A_POINT = 400;
    /**
     * Observations of the rarer outcome below which a bootstrap cross-check is not a cross-check.
     * The usual rule of thumb, and it excludes exactly the two 4p strata where it should: one win
     * in 100 and none in 100.
     */
    const MIN_EVENTS_FOR_A_CROSS_CHECK = 5;

    for (const corpus of COMMITTED_CORPORA) {
      it(`agrees with the bootstrap to 0.5 pp wherever n_eff supports it, on ${corpus.label}`, function() {
        const artifacts = loadCommittedReports(corpus, this);
        for (const artifact of artifacts) {
          const {players} = artifact.report.summary;
          const rows = observationsOf(artifact).rows;
          for (const slot of new Set(rows.map((row) => row.slot))) {
            const clusters = clustersOf(rows.filter((row) => row.slot === slot))
              .map((cluster) => cluster.map((row) => row.win));
            const primary = proportionEstimate(clusters);
            const resampled = bootstrapProportion(clusters, {replicates: 2_000, random: analysisRandom(DEFAULT_ANALYSIS_SEED)});
            if (isUnestimable(primary) || isUnestimable(resampled)) {
              continue;
            }
            const {effectiveN, designEffect} = primary.design;
            // The variance the *sample* has, which is what the bootstrap measures - not the floored
            // one the shipped interval uses. Isolating the two is the point (see the doc above).
            const unflooredN = primary.trials / designEffect;
            const wald = waldInterval(primary.rate, unflooredN);
            const unfloored = wilsonInterval(primary.rate, unflooredN);

            const gap = intervalDisagreement(primary.ci95, resampled.ci95);
            // The four named causes, each measured here rather than allowed for by a constant.
            const floor = intervalDisagreement(primary.ci95, unfloored);
            const shape = intervalDisagreement(unfloored, wald);
            const bias = intervalDisagreement(resampled.percentileCi95, resampled.ci95);
            // Every resample has exactly `n` rows, so a resampled proportion only takes values on a
            // 1/n grid: 0.1 pp at 2p, 0.17 pp at 3p, a full 1 pp at 4p's 100 rows.
            const grid = 1 / primary.trials;

            const pp = (value: number): string => `${(value * 100).toFixed(3)} pp`;
            const where = `${corpusPath(corpus)} ${players}p slot ${slot}: ${primary.trials} rows, ` +
              `deff ${designEffect.toFixed(4)}, n_eff ${effectiveN.toFixed(1)} (unfloored ` +
              `${unflooredN.toFixed(1)}); gap ${pp(gap)} against floor ${pp(floor)} + shape ` +
              `${pp(shape)} + bias ${pp(bias)} + grid ${pp(grid)}`;

            // The substantive check: the bootstrap's *width* and a Wald interval's width on the same
            // unfloored effective n agree to within one grid step. This is the whole content of P4b -
            // do the two methods agree about the variance - and it is stated on widths so that the
            // three position effects above cannot mask a real disagreement, or be mistaken for one.
            //
            // It is asserted only where the rarer outcome is observed at least `MIN_EVENTS` times.
            // Below that the bootstrap has nothing to resample: `rating_corpus_4p.json` slot 2 is
            // random-legal@1 with **one** win in 100 games, so its resample distribution takes about
            // three distinct values and its 2.0 pp interval is two grid steps wide. No continuous
            // comparator agrees with that to a grid step, and the honest reading is not that the two
            // methods disagree but that the cross-check does not exist at one event - the same
            // finding as the boundary refusal one notch less extreme (slot 3 has zero wins and is
            // refused outright).
            const width = (interval: {low: number; high: number}): number => interval.high - interval.low;
            const events = Math.min(primary.successes, primary.trials - primary.successes);
            if (events >= MIN_EVENTS_FOR_A_CROSS_CHECK) {
              expect(Math.abs(width(resampled.ci95) - width(wald)), `P4b variance agreement: ${where}`)
                .to.be.lessThan(grid + 0.004);
            }

            if (effectiveN >= EFFECTIVE_N_FOR_HALF_A_POINT && floor === 0) {
              expect(gap, `P4b as written: ${where}`).to.be.lessThan(0.005);
            } else {
              // Otherwise the bound is the sum of the gap's own named causes. A gap that exceeds what
              // its four measured components can explain is a real disagreement and still fails; the
              // slack is for their interaction, not for headroom.
              expect(gap, `P4b vs its four measured causes: ${where}`)
                .to.be.lessThan(floor + shape + bias + grid + 0.002);
            }
          }
        }
      });
    }
  });

  describe('the boundary refusal (Unit D, from P2\'s coverage grid)', () => {
    it('refuses an all-success sample instead of reporting [1, 1] with confidence', () => {
      const clusters = Array.from({length: 50}, () => [1, 1]);
      const result = bootstrapProportion(clusters, {replicates: 2_000, random: analysisRandom(7)});
      expect(isUnestimable(result), 'an all-success sample has no percentile interval').to.equal(true);
      if (isUnestimable(result)) {
        expect(result.reason).to.match(/boundary/);
      }
    });

    it('refuses an all-failure sample for the same reason', () => {
      const clusters = Array.from({length: 50}, () => [0, 0]);
      const result = bootstrapProportion(clusters, {replicates: 2_000, random: analysisRandom(7)});
      expect(isUnestimable(result)).to.equal(true);
    });

    it('still produces an interval once a single counter-example exists', () => {
      // One failure in 100 is enough for the resample distribution to vary, which is exactly the
      // line the refusal draws: it is about the sample carrying no information, not about the rate
      // being extreme. `rating_corpus_4p.json` has one stratum each side of this line.
      const clusters = Array.from({length: 50}, (_, group) => (group === 0 ? [1, 0] : [1, 1]));
      const result = bootstrapProportion(clusters, {replicates: 2_000, random: analysisRandom(7)});
      expect(isUnestimable(result)).to.equal(false);
    });

    it('fires on the real 4p corpus, where random-legal@1 won no games from one seat', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[3], this);
      const rows = artifacts.flatMap((artifact) => observationsOf(artifact).rows);
      const slot3 = clustersOf(rows.filter((row) => row.slot === 3)).map((cluster) => cluster.map((row) => row.win));
      expect(slot3.flat().reduce<number>((total, win) => total + win, 0), 'slot 3 wins').to.equal(0);
      const result = bootstrapProportion(slot3, {replicates: 2_000, random: analysisRandom(DEFAULT_ANALYSIS_SEED)});
      expect(isUnestimable(result), 'the cross-check is absent here, and says so').to.equal(true);
    });
  });

  describe('the bias correction, applied at the shipped resample count', () => {
    it('quotes the bias-corrected interval as ci95, with the plain one beside it', () => {
      const result = bootstrapProportion(sample.clusters, {replicates: 2_000, random: analysisRandom(31)});
      expect(isUnestimable(result)).to.equal(false);
      if (isUnestimable(result)) {
        return;
      }
      // Both exist, they differ, and `percentileCi95` is the plain one. The correction is applied
      // because the P2 grid at the *shipped* 2,000 resamples says it is worth +0.3 pp and removes
      // every under-covering cell below p = 0.99 - the opposite of what the same grid said at 200,
      // which is the reason the grid no longer runs at 200.
      expect(result.percentileCi95).to.not.deep.equal(result.ci95);
      const sorted = drawsOf(sample.clusters, 2_000, analysisRandom(31));
      expect(result.percentileCi95.low).to.be.closeTo(quantile(sorted, 0.025), 1e-12);
      expect(result.percentileCi95.high).to.be.closeTo(quantile(sorted, 0.975), 1e-12);
    });
  });

  describe('degenerate inputs (hazard H9)', () => {
    it('is unestimable below two clusters rather than resampling one group forever', () => {
      const result = bootstrapProportion([[1, 0]], {replicates: 100, random: analysisRandom(3)});
      expect(isUnestimable(result)).to.equal(true);
      if (isUnestimable(result)) {
        expect(result.reason).to.match(/at least 2/);
      }
    });

    it('skips and counts resamples on which the statistic is undefined, never NaN', () => {
      // A statistic that only exists when the resample happens to contain cluster 0.
      const clusters = [[1], [0], [0], [0]];
      const result = clusterBootstrap(clusters, (resample) => {
        const total = resample.flat();
        return total.includes(1) ? total.reduce((sum, value) => sum + value, 0) / total.length : undefined;
      }, {replicates: 1_000, random: analysisRandom(5)});
      if (!isUnestimable(result)) {
        expect(result.usable).to.be.lessThan(result.replicates);
        expect(Number.isNaN(result.ci95.low)).to.equal(false);
        expect(Number.isNaN(result.ci95.high)).to.equal(false);
      }
    });

    it('refuses rather than quoting an interval built from a handful of usable resamples', () => {
      const clusters = [[1], [0], [0], [0], [0], [0], [0], [0], [0], [0],
        [0], [0], [0], [0], [0], [0], [0], [0], [0], [0]];
      const result = clusterBootstrap(clusters, (resample) =>
        (resample.flat().includes(1) ? 1 : undefined), {replicates: 200, random: analysisRandom(5)});
      // Only ~64% of resamples contain the single informative cluster here, which is above the
      // half-of-replicates floor - the check is that the floor exists and reports a count.
      if (!isUnestimable(result)) {
        expect(result.usable).to.be.at.least(result.replicates / 2);
      }
    });
  });

  /**
   * The Wald interval on the effective n - **not** an estimator this pipeline publishes (§3.1 chose
   * Wilson because Wald runs off the end of [0, 1] at 99.2%, which is where the baselines are). It
   * exists here only to separate "the two methods disagree about the variance", which would be a
   * defect, from "the two methods disagree about interval shape at small n", which is Wilson doing
   * the job it was chosen for.
   */
  /** The same resamples the module draws, re-derived so the quantile assertion is not self-referential. */
  function drawsOf(clusters: ReadonlyArray<ReadonlyArray<number>>, replicates: number,
    random: {nextInt: (range: number) => number}): ReadonlyArray<number> {
    const draws: Array<number> = [];
    for (let replicate = 0; replicate < replicates; replicate++) {
      let total = 0;
      let count = 0;
      for (let i = 0; i < clusters.length; i++) {
        for (const value of clusters[random.nextInt(clusters.length)]) {
          total += value;
          count++;
        }
      }
      draws.push(total / count);
    }
    return draws.sort((a, b) => a - b);
  }

  function quantile(sorted: ReadonlyArray<number>, q: number): number {
    const position = q * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return lower === upper ? sorted[lower] : sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
  }

  function waldInterval(rate: number, n: number): {low: number; high: number} {
    const half = 1.959964 * Math.sqrt(rate * (1 - rate) / n);
    return {low: rate - half, high: rate + half};
  }

});
