import {expect} from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {
  NOMINAL_COVERAGE,
  PRECOMMITTED_BAND,
  REQUIRED_REPLICATIONS,
  adjudicateP2,
  analyticAnchorGrid,
  cellSeed,
  clopperPearson,
  coverageBand,
  coverageVerdict,
  exactBinomialCoverage,
  expectedExcursions,
  marginCoverageGrid,
  optionalStoppingStudy,
  powerGrid,
  proportionCoverageCell,
  seedReuseStudy,
  sizeGrid,
  wilsonScoreInterval,
} from '../../src/rating/calibration';
import {wilsonInterval} from '../../src/rating/stats';

/**
 * The calibration study's own tests (Milestone 2, bullet 3, Unit C).
 *
 * **A spec over a study that measures things has an awkward job**, and it is worth naming: it cannot
 * assert the study's *answers* without either duplicating the study (in which case it is slow and
 * proves nothing new) or hard-coding the numbers it happened to produce (in which case a genuine
 * regression in the estimator turns into a failing test that a later session "fixes" by updating the
 * constant). So this spec asserts three other things instead:
 *
 * 1. **The machinery that makes the study unwidenable**: the band is computed from the replication
 *    count, the three-way verdict has the boundaries it claims, and the pre-committed [94.0%, 96.0%]
 *    really is the ±1.96 band at 2,000 replications rather than a number someone liked.
 * 2. **The parts that are exact**, against mathematics: the enumerated binomial coverage is checked
 *    against a hand-computable case and against Clopper-Pearson's guarantee, and Clopper-Pearson is
 *    checked against a published interval.
 * 3. **That each study runs, is reproducible from its seed, and reports the direction of its
 *    findings** - on replication counts small enough for a test suite, which is why nothing here
 *    asserts a coverage figure is in band. That claim belongs to the committed artifact, which is
 *    produced at the full 2,000 replications by `npm run rate:validate`.
 *
 * The committed artifact is then checked for *what it is* rather than re-derived: that it exists,
 * that it was produced at or above P2's replication floor, and that its recorded verdicts match what
 * `adjudicate*` would say about the cells it carries. That last one is the check that matters - it
 * is what stops a hand-edited verdict from surviving in the file.
 */
describe('the calibration study (§3.9, criteria P2/P3/P9)', function() {
  this.timeout(240_000);

  // -------------------------------------------------------------------------------------------
  // The tolerance machinery: the part that makes the study impossible to quietly widen
  // -------------------------------------------------------------------------------------------

  describe('the tolerance band is arithmetic, not taste', () => {
    it('reproduces the pre-committed [94.0%, 96.0%] at 2,000 replications', () => {
      const band = coverageBand(REQUIRED_REPLICATIONS);
      // 0.95 ± 1.96·√(0.95·0.05/2000) = 0.95 ± 0.00955. The plan's band is this, rounded outward to
      // one decimal place - which is why a cell between the two is `marginal` and not `pass`.
      expect(band.standardError).to.be.closeTo(0.004873, 1e-6);
      expect(band.low).to.be.closeTo(0.94045, 1e-5);
      expect(band.high).to.be.closeTo(0.95955, 1e-5);
      expect(band.low).to.be.greaterThan(PRECOMMITTED_BAND.low);
      expect(band.high).to.be.lessThan(PRECOMMITTED_BAND.high);
    });

    it('narrows as replications rise, so more work can never buy a wider tolerance', () => {
      const small = coverageBand(500);
      const large = coverageBand(20_000);
      expect(large.high - large.low).to.be.lessThan(small.high - small.low);
      // The whole point: `--replications` is not a dial that makes a failing cell pass.
      expect(large.low).to.be.greaterThan(small.low);
    });

    it('splits pass / marginal / fail at the boundaries it claims', () => {
      const band = coverageBand(REQUIRED_REPLICATIONS);
      expect(coverageVerdict(NOMINAL_COVERAGE, band)).to.equal('pass');
      expect(coverageVerdict(0.9405, band)).to.equal('pass');
      // Outside the Monte-Carlo band but inside the criterion as written down.
      expect(coverageVerdict(0.9402, band)).to.equal('marginal');
      expect(coverageVerdict(0.9599, band)).to.equal('marginal');
      // Outside the criterion itself, in both directions.
      expect(coverageVerdict(0.9399, band)).to.equal('fail');
      expect(coverageVerdict(0.9601, band)).to.equal('fail');
    });

    it('states the multiplicity rather than leaving a reader to be surprised by it', () => {
      // 96 + 48 + 16 cells at a 95% band. Roughly eight excursions are *expected*, and reading them
      // as eight defects is the mistake this number exists to prevent.
      expect(expectedExcursions(160)).to.be.closeTo(8, 1e-9);
    });

    it('adjudicates P2 on under-coverage, and names over-coverage separately', () => {
      const grid = (failUnder: number, failOver: number) => ({
        what: 'test',
        summary: {
          cells: 10,
          pass: 10 - failUnder - failOver,
          marginal: 0,
          fail: failUnder + failOver,
          failUnder,
          failOver,
          expectedOutsideBand: 0.5,
          observedOutsideBand: failUnder + failOver,
          worst: undefined,
          worstUnderCoverage: undefined,
        },
      });
      expect(adjudicateP2([grid(0, 0)]).met).to.equal(true);
      // Conservative, and reported - an interval that is too wide understates a claim rather than
      // overstating it, and "fixing" it means narrowing, which is the dangerous direction.
      const over = adjudicateP2([grid(0, 3)]);
      expect(over.met).to.equal(true);
      expect(over.statement).to.contain('3 over-cover');
      expect(adjudicateP2([grid(1, 0)]).met).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The analytic anchor: checked against mathematics, with no generator involved
  // -------------------------------------------------------------------------------------------

  describe('the analytic anchor (§3.9)', () => {
    it('enumerates a binomial coverage a reader can check by hand', () => {
      // n = 1, p = 0.5: the two outcomes each have mass 0.5, and Wilson at 0/1 and 1/1 both contain
      // 0.5 (the score interval at n = 1 is [0.0546, 0.9454] either way), so coverage is exactly 1.
      expect(exactBinomialCoverage(1, 0.5, (successes, trials) => wilsonInterval(successes / trials, trials)))
        .to.be.closeTo(1, 1e-12);
      // A degenerate interval covers nothing except where it lands, so the enumeration's weights are
      // exercised rather than short-circuited: only k with k/n === p contributes.
      const point = exactBinomialCoverage(10, 0.5, (successes, trials) =>
        ({low: successes / trials, high: successes / trials}));
      // P(k = 5 | n = 10, p = 0.5) = 252/1024.
      expect(point).to.be.closeTo(252 / 1024, 1e-12);
    });

    it('keeps its digits where a naive binomial coefficient would overflow', () => {
      // C(3000, 1500) is ~10^902. Computed as a product it is `Infinity`, every term becomes
      // `Infinity · 0 = NaN`, and the study would report `NaN` coverage as a passing number in JSON.
      const coverage = exactBinomialCoverage(3_000, 0.5, (successes, trials) =>
        wilsonInterval(successes / trials, trials));
      expect(Number.isFinite(coverage), 'coverage is finite at n = 3,000').to.equal(true);
      expect(coverage).to.be.within(0.9, 1);
    });

    it('gives Clopper-Pearson its guaranteed >= 95% coverage, which checks the enumeration itself', () => {
      // Clopper-Pearson is conservative *by construction* at every n and p. If this enumeration said
      // otherwise, the enumeration would be what is wrong - which is exactly why it is the oracle.
      for (const n of [20, 100, 300]) {
        for (const p of [0.5, 0.65, 0.9]) {
          expect(exactBinomialCoverage(n, p, clopperPearson), `n=${n} p=${p}`).to.be.at.least(0.95);
        }
      }
    });

    it('matches a published Clopper-Pearson interval', () => {
      // The textbook case: 2 successes in 20 trials is [0.0123, 0.3170].
      const interval = clopperPearson(2, 20);
      expect(interval.low).to.be.closeTo(0.0123, 1e-4);
      expect(interval.high).to.be.closeTo(0.3170, 1e-4);
      // The boundaries are exact rather than approximated: 0 successes has a lower bound of exactly 0.
      expect(clopperPearson(0, 20).low).to.equal(0);
      expect(clopperPearson(20, 20).high).to.equal(1);
    });

    it('agrees with the pipeline at ICC = 0, where mathematics has the answer', () => {
      const grid = analyticAnchorGrid({replications: 400});
      expect(grid.cells).to.have.length(16);
      for (const cell of grid.cells) {
        // Not a coverage assertion - 400 replications cannot support one. What is asserted is that
        // the *exact* column is a real coverage figure and that the simulated column is in the same
        // neighbourhood, i.e. the pipeline has not gone somewhere else entirely at ICC = 0.
        expect(cell.exact.wilson, cell.label).to.be.within(0.9, 1);
        expect(cell.exact.clopperPearson, cell.label).to.be.at.least(0.95);
        expect(cell.simulated.pipeline, cell.label).to.be.within(0.85, 1);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // Each study runs, and is reproducible from its seed
  // -------------------------------------------------------------------------------------------

  describe('reproducibility (§3.7, hazard H11)', () => {
    it('derives a cell stream from the cell parameters, not from its position in the grid', () => {
      // The property this buys: a reader can re-run one cell of the committed artifact and get the
      // identical number, and adding a cell to the grid does not perturb any cell already published.
      expect(cellSeed(1, 'p=0.5 icc=0 G=50 m=2 beta-binomial'))
        .to.equal(cellSeed(1, 'p=0.5 icc=0 G=50 m=2 beta-binomial'));
      expect(cellSeed(1, 'a')).to.not.equal(cellSeed(1, 'b'));
      expect(cellSeed(1, 'a')).to.not.equal(cellSeed(2, 'a'));
      expect(cellSeed(41_000_003, 'a')).to.be.greaterThan(0);
      expect(Number.isInteger(cellSeed(41_000_003, 'a'))).to.equal(true);
    });

    it('reproduces a coverage cell exactly from the same analysis seed', () => {
      const scenario = {
        rate: 0.65, icc: 0.05, groups: 50, clusterSize: 2, mechanism: 'beta-binomial' as const,
        replications: 200, analysisSeed: 41_000_003,
      };
      const first = proportionCoverageCell(scenario);
      const second = proportionCoverageCell(scenario);
      expect(second).to.deep.equal(first);
      const different = proportionCoverageCell({...scenario, analysisSeed: 41_000_004});
      expect(different.primary.covered).to.not.equal(first.primary.covered);
    });

    it('keeps the candidate-fix interval identical to the shipped one at z = 1.96', () => {
      // `flooredWithT` is only interpretable as a comparison if the *only* thing that differs from
      // the shipped interval is the multiplier. This is what stops the local copy of the Wilson
      // formula from drifting into a different interval and turning the comparison into noise.
      for (const n of [37, 100, 1_000]) {
        for (const rate of [0, 0.5, 0.65, 0.992, 1]) {
          const mine = wilsonScoreInterval(rate, n, 1.959964);
          const shipped = wilsonInterval(rate, n);
          expect(mine.low, `n=${n} p=${rate}`).to.be.closeTo(shipped.low, 1e-15);
          expect(mine.high, `n=${n} p=${rate}`).to.be.closeTo(shipped.high, 1e-15);
        }
      }
      // And the multiplier does what it is there for: a bigger one gives a wider interval.
      const wider = wilsonScoreInterval(0.65, 100, 2.01);
      expect(wider.high - wider.low).to.be.greaterThan(wilsonInterval(0.65, 100).high - wilsonInterval(0.65, 100).low);
    });

    it('records the direction of a miss, not only the coverage', () => {
      const cell = proportionCoverageCell({
        rate: 0.99, icc: 0, groups: 50, clusterSize: 2, mechanism: 'beta-binomial',
        replications: 300, analysisSeed: 41_000_003,
      });
      // At p = 0.99 with 100 rows the sample is very often all-successes, so the estimator's stated
      // degenerate fallback fires and the misses are one-sided. Coverage alone would hide both facts.
      expect(cell.primary.covered + cell.primary.missedLow + cell.primary.missedHigh).to.equal(cell.estimable);
      expect(cell.designEffect.degenerate, 'the degenerate-design path fires here').to.be.greaterThan(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The negative control, and P9's two simulations
  // -------------------------------------------------------------------------------------------

  describe('the negative control (P3)', () => {
    it('shows the unclustered test over-rejecting where the clustered one does not', () => {
      // The whole justification for the cluster correction. If this ever stopped being true the
      // correction would be unjustified rather than justified, and the right response would be to
      // say so - not to keep a correction because it is already written.
      const grid = sizeGrid({replications: 400});
      const clustered = grid.cells.filter((cell) => cell.icc >= 0.2 && cell.clusterSize === 6);
      expect(clustered.length).to.be.greaterThan(0);
      const meanNaive = clustered.reduce((total, cell) => total + cell.unclustered.size, 0) / clustered.length;
      const meanCorrected = clustered.reduce((total, cell) => total + cell.clustered.size, 0) / clustered.length;
      expect(meanNaive, 'unclustered size at ICC 0.20, m = 6').to.be.greaterThan(0.10);
      expect(meanCorrected, 'the corrected test stays near nominal').to.be.lessThan(0.10);
    });
  });

  describe('P3 power against the calculator', () => {
    it('runs every §2.5 row and reports the gap rather than a boolean', () => {
      const grid = powerGrid({replications: 300});
      expect(grid.cells.map((cell) => cell.trueRate)).to.deep.equal([0.65, 0.6, 0.55, 0.53, 0.52]);
      for (const cell of grid.cells) {
        // The design is what makes the check non-circular: the sample size comes from the
        // calculator, the rejections come from the shipped test, and the ICC is set so the true
        // design effect is exactly the 1.03 the tables assume.
        expect(cell.icc).to.be.closeTo(0.03, 1e-12);
        expect(cell.games).to.be.at.least(cell.requiredGames);
        expect(cell.calculatorPower, cell.label).to.be.closeTo(0.8, 0.01);
        // 300 replications is ±4.5 pp, so this is a sanity bound, not P3's 2 pp tolerance.
        expect(cell.empiricalPower, cell.label).to.be.within(0.70, 0.90);
      }
    });
  });

  describe('P9: the two hazards Milestone 3 is about to walk into', () => {
    it('measures optional stopping inflating the one-sided 5% test', () => {
      const study = optionalStoppingStudy({replications: 600, analysisSeed: 41_000_003});
      expect(study.looks).to.equal(10);
      expect(study.cumulativeByLook).to.have.length(10);
      // Monotone by construction (a cumulative first-rejection curve), and ending at the headline.
      for (let look = 1; look < study.cumulativeByLook.length; look++) {
        expect(study.cumulativeByLook[look]).to.be.at.least(study.cumulativeByLook[look - 1]);
      }
      expect(study.cumulativeByLook[9]).to.be.closeTo(study.anyLookSize, 1e-12);
      expect(study.anyLookSize, 'peeking costs more than the nominal alpha').to.be.greaterThan(study.alpha);
      expect(study.singleLookSize, 'one test at the pre-registered N stays near nominal').to.be.lessThan(0.10);
    });

    it('measures the winner\'s curse from selecting on a seed block, and separates its two halves', () => {
      const study = seedReuseStudy({replications: 400, analysisSeed: 41_000_003});
      expect(study.reusedGames, 'the selection games overstate the winner')
        .to.be.greaterThan(study.freshBlock);
      // The fresh block is unbiased by construction: every variant has the same true rate, so a
      // disjoint block estimates it. If this drifted from 0.5 the generator would be the problem.
      expect(study.freshBlock, 'a disjoint block is unbiased').to.be.closeTo(study.trueRate, 0.01);
      expect(study.inflation.reusedGames).to.be.closeTo(study.reusedGames - study.freshBlock, 1e-12);
    });

    it('collapses the same-seed inflation to nothing when seeds have no personalities', () => {
      // The decomposition's control: with no variant x seed interaction, re-playing the same seeds
      // with fresh randomness is as honest as a fresh block, and the entire inflation is selection
      // noise on the games themselves. This is what makes the sweep in the CLI a measurement of the
      // interaction rather than a restatement of the winner's curse.
      const study = seedReuseStudy({replications: 400, analysisSeed: 41_000_003, interactionSd: 0});
      expect(Math.abs(study.inflation.reusedSeeds), 'no interaction, no surviving inflation')
        .to.be.lessThan(0.01);
      expect(study.inflation.reusedGames, 'but the selection games are still inflated')
        .to.be.greaterThan(0.005);
    });
  });

  describe('the margin interval over a continuous generator (P2)', () => {
    it('sizes its scenarios against the measured 2p and 3p margin scales', () => {
      const grid = marginCoverageGrid({replications: 200});
      expect(grid.cells).to.have.length(16);
      const threePlayer = grid.cells.find((cell) => cell.clusterSize === 6 && cell.icc === 0.103);
      expect(threePlayer, 'the 3p cell where an uncorrected interval is 23% too narrow').to.not.equal(undefined);
      expect(threePlayer?.designEffect.truth).to.be.closeTo(1.515, 1e-3);
      for (const cell of grid.cells.filter((candidate) => candidate.icc >= 0.103)) {
        // The point of the correction, on the margin: the uncorrected interval is narrower, so it
        // covers less. A cell where it did not would mean the clustering is not being applied.
        expect(cell.unclustered.meanWidth, cell.label).to.be.lessThan(cell.primary.meanWidth);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // The committed artifact
  // -------------------------------------------------------------------------------------------

  describe('docs/data/rating_validation.json', () => {
    const artifactPath = path.join(__dirname, '..', '..', 'docs', 'data', 'rating_validation.json');

    it('exists, and was produced at or above P2\'s replication floor', function() {
      if (!fs.existsSync(artifactPath)) {
        // Optional in the same way `corpora.ts` treats this bullet's corpora: a checkout made before
        // the study ran should still have a green suite, and a skip says so where a vacuous pass
        // would not.
        this.skip();
      }
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      expect(artifact.settings.replications).to.be.at.least(REQUIRED_REPLICATIONS);
      expect(artifact.settings.meetsReplicationFloor).to.equal(true);
      expect(artifact.settings.precommittedBand).to.deep.equal(PRECOMMITTED_BAND);
      expect(artifact.verdicts.map((verdict: {criterion: string}) => verdict.criterion))
        .to.deep.equal(['P2', 'P3', 'P9']);
    });

    it('carries verdicts that match the cells it carries', function() {
      if (!fs.existsSync(artifactPath)) {
        this.skip();
      }
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      // The check that matters: a verdict edited by hand, or left stale after a re-run of one phase,
      // would survive every other test in this file. Re-deriving it from the recorded cells is what
      // makes the artifact self-consistent rather than merely present.
      const rederived = adjudicateP2([artifact.p2.proportion, artifact.p2.bootstrap, artifact.p2.margin]);
      expect(rederived).to.deep.equal(artifact.p2.verdict);
    });

    it('carries every scenario\'s parameters, so one cell can be re-run', function() {
      if (!fs.existsSync(artifactPath)) {
        this.skip();
      }
      const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      const cell = artifact.p2.proportion.cells[0];
      const rerun = proportionCoverageCell({
        rate: cell.rate,
        icc: cell.icc,
        groups: cell.groups,
        clusterSize: cell.clusterSize,
        mechanism: cell.mechanism,
        replications: cell.replications,
        analysisSeed: artifact.settings.analysisSeed,
      });
      expect(rerun.primary.coverage, `re-running ${cell.label} from the artifact's own parameters`)
        .to.equal(cell.primary.coverage);
    });
  });
});
