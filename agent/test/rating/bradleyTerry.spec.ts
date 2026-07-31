import {expect} from 'chai';
import {AgentRandom} from '../../src/core/rng';
import {analysisRandom} from '../../src/rating/bootstrap';
import {
  DEFAULT_PRIOR_SIGMA,
  ELO_PER_LOGIT,
  EloBounds,
  PREFERRED_ANCHOR,
  buildComparisonSet,
  contrastShrinkage,
  describePool,
  eloFromWinRate,
  eloGap,
  fitBradleyTerry,
  ratePairwise,
  solve,
  solveMatrix,
} from '../../src/rating/bradleyTerry';
import {buildObservationSet, stratify} from '../../src/rating/observations';
import {simulateObservations} from '../../src/rating/simulate';
import {Observation, isUnestimable} from '../../src/rating/types';
import {COMMITTED_CORPORA, loadCommittedReports} from './corpora';

/**
 * The pairwise fit, **criterion P5's Bradley-Terry half**, and **criterion P6**.
 *
 * The thing this file exists to catch is not a crash. `greedy-1ply@1` already wins 98.8% of this
 * bullet's own 2p corpus and 99.2% of bullet 2's, and the first Milestone 3 agent may well win
 * 1,000/1,000 - at which point a naive fit returns `Infinity`, `NaN`, or, worst of the three because
 * it looks like an answer, a large finite number with a symmetric interval around it. So the
 * separated cases below are deliberately constructed rather than waited for.
 */
describe('Bradley-Terry ratings (§3.3, §3.4)', function() {
  this.timeout(300_000);

  // -------------------------------------------------------------------------------------------
  // The mathematics, against closed forms
  // -------------------------------------------------------------------------------------------

  describe('the linear algebra', () => {
    it('solves a small system, and a matrix right-hand side, exactly', () => {
      const a = [[4, 1, 0], [1, 3, 1], [0, 1, 2]];
      const x = solve(a, [1, 2, 3]);
      const back = a.map((row) => row.reduce((total, entry, k) => total + entry * x[k], 0));
      expect(back[0]).to.be.closeTo(1, 1e-12);
      expect(back[1]).to.be.closeTo(2, 1e-12);
      expect(back[2]).to.be.closeTo(3, 1e-12);

      // A^-1 A = I, which is the identity `contrastShrinkage` leans on.
      const inverse = solveMatrix(a, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
      const product = a.map((row) => row.map((_unused, j) =>
        row.reduce((total, entry, k) => total + entry * inverse[k][j], 0)));
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          expect(product[i][j], `(${i},${j})`).to.be.closeTo(i === j ? 1 : 0, 1e-12);
        }
      }
    });

    it('refuses a singular matrix rather than returning Infinity', () => {
      expect(() => solve([[1, 2], [2, 4]], [1, 2])).to.throw(/singular/);
    });
  });

  describe('the fit against a closed form', () => {
    it('recovers the exact MAP gap on a hand-computable two-agent sample', () => {
      // With one identity winning `w` of `n` and a symmetric prior, the optimum sits at
      // theta = (g/2, -g/2) with `n sigma(g) - w = -g / (2 sigma²) x ... ` - rather than restate the
      // algebra, check the first-order condition the optimizer claims to have solved. That is the
      // strongest available check: it does not assume the optimizer's own arithmetic.
      const set = buildComparisonSet(twoAgentRows(700, 1_000));
      const fit = fitBradleyTerry(set, DEFAULT_PRIOR_SIGMA);
      expect(fit.converged, 'converged').to.equal(true);

      const [a, b] = fit.strengths;
      const precision = 1 / (DEFAULT_PRIOR_SIGMA * DEFAULT_PRIOR_SIGMA);
      const p = 1 / (1 + Math.exp(-(a - b)));
      // The residual is bounded by the Newton-decrement stopping rule rather than driven to zero.
      // At this sample's curvature (~236 nats per logit²) a residual of 1e-3 is 7e-4 Elo of
      // unclaimed improvement, against a figure this pipeline prints to the nearest Elo point. See
      // NEWTON_TOLERANCE for why the rule is on the decrement and why it is scale-relative.
      expect(700 - 1_000 * p - precision * a, 'gradient of the log posterior at the optimum').to.be.closeTo(0, 1e-3);
      expect(-(700 - 1_000 * p) - precision * b).to.be.closeTo(0, 1e-3);
      // And the prior is symmetric, so the strengths are equal and opposite.
      expect(a + b).to.be.closeTo(0, 1e-9);
    });

    it('sits within a hair of the raw win-rate Elo, which is what a two-agent Elo *is* (§3.4)', () => {
      const set = buildComparisonSet(twoAgentRows(700, 1_000));
      const fit = fitBradleyTerry(set, DEFAULT_PRIOR_SIGMA);
      const fitted = (fit.strengths[0] - fit.strengths[1]) * ELO_PER_LOGIT;
      expect(fitted).to.be.closeTo(eloFromWinRate(0.7) as number, 2);
    });

    it('shrinks the gap by a reportable, small amount at the pre-committed prior', () => {
      const set = buildComparisonSet(twoAgentRows(700, 1_000));
      const fit = fitBradleyTerry(set, DEFAULT_PRIOR_SIGMA);
      const shrinkage = contrastShrinkage(fit, 0, 1);
      // A weak prior against 1,000 games: fractions of a percent, and never zero (it is a prior).
      expect(shrinkage).to.be.greaterThan(0);
      expect(shrinkage).to.be.lessThan(0.01);
      // A very strong prior moves the same gap a great deal, which is what makes the number a real
      // diagnostic rather than a constant.
      expect(contrastShrinkage(fitBradleyTerry(set, 0.02), 0, 1)).to.be.greaterThan(0.5);
    });

    it('reports the level as unidentified, because it is (§3.3)', () => {
      // A Bradley-Terry likelihood sees only differences, so one of the two parameters is fixed
      // entirely by the prior. Printing that is the honest way to say what anchoring is for.
      const fit = fitBradleyTerry(buildComparisonSet(twoAgentRows(700, 1_000)), DEFAULT_PRIOR_SIGMA);
      expect(fit.effectiveParameters).to.be.closeTo(1, 0.01);
    });
  });

  // -------------------------------------------------------------------------------------------
  // P5, first half: recovery and coverage on synthetic pools with known strengths
  // -------------------------------------------------------------------------------------------

  describe('P5 - recovers known strengths, with calibrated intervals', () => {
    /**
     * Pre-committed here, before any number arrived. The replication count is lower than criterion
     * P2's 2,000 because each replication runs a **full bootstrap refit loop** rather than one
     * interval - and the tolerance band is therefore computed from this count in code rather than
     * chosen, exactly as Unit C is instructed to do for its own grid. At 300 replications the
     * +/-1.96 Monte-Carlo band on a nominal 95% is +/-2.47 pp.
     *
     * **The resample count is not a free parameter either.** A 2.5% quantile from 200 resamples is
     * the fifth order statistic and its own noise dominates: this same study covered 88-90% at
     * B = 200 and 92.5% at B = 600, on identical data and an identical estimator. That is a fact
     * about the study's instrument, not about the interval, and it is why
     * `DEFAULT_BOOTSTRAP_REPLICATES` is 2,000 for anything published.
     */
    const REPLICATIONS = 300;
    const BOOTSTRAP = 500;
    /** Five identities, a connected round-robin, and gaps of 0.7 logits (~122 Elo) between neighbours. */
    const STRENGTHS = [0, 0.7, 1.4, 2.1, 2.8];
    const GROUPS_PER_PAIR = 30;

    function monteCarloBand(replications: number): {low: number; high: number} {
      const halfWidth = 1.959964 * Math.sqrt(0.95 * 0.05 / replications);
      return {low: 0.95 - halfWidth, high: 0.95 + halfWidth};
    }

    it('recovers the rank order in >= 99% of replications, and covers at the nominal rate', function() {
      const random = analysisRandom(41_000_003);
      const band = monteCarloBand(REPLICATIONS);
      let rankOrderRecovered = 0;
      let covered = 0;
      let measured = 0;
      let anyUnbounded = 0;

      for (let replication = 0; replication < REPLICATIONS; replication++) {
        const rows = roundRobinRows(STRENGTHS, GROUPS_PER_PAIR, random, `sim${replication}`);
        const fit = ratePairwise(rows, {replicates: BOOTSTRAP, random});
        expect(fit.converged, `replication ${replication} converged`).to.equal(true);

        // Rank order, on the fitted strengths against the generator's.
        const order = fit.identities
          .map((_unused, index) => ({index, strength: fit.strengths[index]}))
          .sort((a, b) => a.strength - b.strength)
          .map((entry) => entry.index);
        if (order.every((index, position) => index === position)) {
          rankOrderRecovered++;
        }

        // Coverage of the gap between the extremes - the widest contrast, and the one a ladder
        // actually quotes.
        const gap = eloGap(fit, fit.identities[4], fit.identities[0]);
        expect(isUnestimable(gap)).to.equal(false);
        if (isUnestimable(gap)) {
          continue;
        }
        const truth = (STRENGTHS[4] - STRENGTHS[0]) * ELO_PER_LOGIT;
        if (gap.ci95.low === null || gap.ci95.high === null) {
          anyUnbounded++;
          continue;
        }
        measured++;
        if (gap.ci95.low <= truth && truth <= gap.ci95.high) {
          covered++;
        }
      }

      const recovery = rankOrderRecovered / REPLICATIONS;
      const coverage = covered / measured;
      // Reported, not just asserted: a criterion adjudicated from a pass/fail bit is a criterion
      // Unit D cannot write a number beside.
      console.log(`      [P5] rank order recovered ${(recovery * 100).toFixed(1)}% of ${REPLICATIONS} replications`);
      console.log(`      [P5] coverage of the extreme gap ${(coverage * 100).toFixed(1)}% ` +
        `(${covered}/${measured}), band [${(band.low * 100).toFixed(1)}%, ${(band.high * 100).toFixed(1)}%], ` +
        `${anyUnbounded} replication(s) separated`);

      expect(recovery, 'P5 rank-order recovery').to.be.at.least(0.99);
      expect(coverage, 'P5 interval coverage').to.be.within(band.low, band.high);
    });
  });

  // -------------------------------------------------------------------------------------------
  // P5, second half: separation
  // -------------------------------------------------------------------------------------------

  describe('P5 - separation is handled, not discovered (hazard H3)', () => {
    function separatedFit(random: AgentRandom) {
      // One identity wins every single game. The *unregularized* MLE diverges here.
      return ratePairwise(twoAgentRows(400, 400), {replicates: 300, random});
    }

    it('produces a finite point estimate where the MLE has none', () => {
      const fit = separatedFit(analysisRandom(41_000_003));
      for (const strength of fit.strengths) {
        expect(Number.isFinite(strength), 'finite').to.equal(true);
      }
      const gap = eloGap(fit, fit.identities[0], fit.identities[1]);
      expect(isUnestimable(gap)).to.equal(false);
      if (!isUnestimable(gap)) {
        expect(Number.isFinite(gap.elo)).to.equal(true);
        // Large, and held there by the prior rather than by the data.
        expect(gap.elo).to.be.greaterThan(1_000);
      }
    });

    it('reports a real lower bound and an explicitly unbounded upper one - never Infinity, NaN, or a symmetric interval', () => {
      const fit = separatedFit(analysisRandom(41_000_003));
      const gap = eloGap(fit, fit.identities[0], fit.identities[1]);
      expect(isUnestimable(gap)).to.equal(false);
      if (isUnestimable(gap)) {
        return;
      }

      expect(gap.ci95.high, 'the upper bound does not exist and says so').to.equal(null);
      expect(gap.ci95.low, 'the lower bound is real').to.be.a('number');
      expect(Number.isFinite(gap.ci95.low as number)).to.equal(true);
      expect(gap.ci95.unbounded?.end).to.equal('above');
      expect(gap.ci95.unbounded?.reason).to.match(/separated/);
      assertNoDisguisedInfinity(gap.ci95);

      // The trap this exists to close: the bootstrap replicates *are* all finite, so a percentile
      // interval computed without the structural check would look like an ordinary answer.
      expect(fit.bootstrap?.usable).to.be.greaterThan(200);
    });

    it('flips to a two-sided interval on a single counter-example, with the point estimate barely moving', () => {
      // The whole argument for deciding separation structurally rather than from the size of the
      // fitted number: one game out of 400 changes what may be claimed, and changes the point
      // estimate by a few hundred Elo out of several thousand.
      const random = analysisRandom(41_000_003);
      const separated = eloGap(separatedFit(random), 'a@1', 'b@1');
      const nearlySeparated = eloGap(
        ratePairwise(twoAgentRows(399, 400), {replicates: 300, random: analysisRandom(41_000_003)}),
        'a@1', 'b@1');

      expect(isUnestimable(separated) || isUnestimable(nearlySeparated)).to.equal(false);
      if (isUnestimable(separated) || isUnestimable(nearlySeparated)) {
        return;
      }
      expect(separated.ci95.high).to.equal(null);
      expect(nearlySeparated.ci95.high, 'one counter-example is enough to bound it').to.be.a('number');
      expect(nearlySeparated.ci95.unbounded).to.equal(undefined);
    });

    it('treats a shared result as a counter-example in both directions (§3.2, hazard H4)', () => {
      // Every game a shared win: neither identity has ever finished ahead of the other, so the pair
      // is *not* separated - the draw convention is what makes this true, and it has never been
      // exercised by data (0 shared wins in bullet 1's 1,700 games; one in this bullet's 3p corpus).
      const rows = pairwiseRows(Array.from({length: 100}, () => 0.5));
      const fit = ratePairwise(rows, {replicates: 200, random: analysisRandom(41_000_003)});
      const gap = eloGap(fit, 'a@1', 'b@1');
      expect(isUnestimable(gap)).to.equal(false);
      if (!isUnestimable(gap)) {
        expect(gap.ci95.unbounded, 'a drawn pair is bounded both ways').to.equal(undefined);
        expect(gap.elo).to.be.closeTo(0, 1e-6);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // §3.4: the comparison graph
  // -------------------------------------------------------------------------------------------

  describe('the comparison graph (§3.4)', () => {
    it('reports a disconnected pool per component, and refuses to bound across components', () => {
      // a beats b; c beats d; the two pairs never meet. There is no single scale here, and one
      // table over all four would imply one.
      const rows = [
        ...pairwiseRows(Array.from({length: 40}, () => 1), 'a@1', 'b@1', 'runA'),
        ...pairwiseRows(Array.from({length: 40}, () => 1), 'c@1', 'd@1', 'runC'),
      ];
      const pool = describePool(ratePairwise(rows, {replicates: 200, random: analysisRandom(41_000_003)}));

      expect(pool.connected).to.equal(false);
      expect(pool.components).to.have.length(2);
      expect(pool.components.map((component) => component.identities)).to.deep.equal([['a@1', 'b@1'], ['c@1', 'd@1']]);
      // Each component is anchored separately, and neither holds `random-legal@1`.
      expect(pool.components.every((component) => !component.usesPreferredAnchor)).to.equal(true);

      const across = eloGap(ratePairwise(rows, {}), 'a@1', 'c@1');
      expect(isUnestimable(across)).to.equal(false);
      if (!isUnestimable(across)) {
        expect(across.ci95.unbounded?.end).to.equal('both');
        expect(across.ci95.unbounded?.reason).to.match(/different components/);
        assertNoDisguisedInfinity(across.ci95);
      }
    });

    it('anchors at random-legal@1 whenever it is present', () => {
      const rows = pairwiseRows(Array.from({length: 60}, (_u, i) => (i % 10 === 0 ? 0 : 1)), 'greedy-1ply@1', PREFERRED_ANCHOR);
      const pool = describePool(ratePairwise(rows, {}));
      expect(pool.components[0].anchor).to.equal(PREFERRED_ANCHOR);
      expect(pool.components[0].usesPreferredAnchor).to.equal(true);
      expect(pool.components[0].ratings.find((rating) => rating.identity === PREFERRED_ANCHOR)?.elo).to.equal(0);
    });

    it('says so, rather than guessing, when there is no bootstrap to take an interval from', () => {
      const gap = eloGap(ratePairwise(twoAgentRows(700, 1_000), {}), 'a@1', 'b@1');
      expect(isUnestimable(gap)).to.equal(false);
      if (!isUnestimable(gap)) {
        expect(gap.ci95.low).to.equal(null);
        expect(gap.ci95.high).to.equal(null);
        // §3.3 forbids substituting a Hessian standard error here, and the message says why.
        expect(gap.ci95.unbounded?.reason).to.match(/Hessian/);
      }
    });

    it('refuses an identity that is not in the pool, by name', () => {
      const gap = eloGap(ratePairwise(twoAgentRows(700, 1_000), {}), 'nobody@1', 'b@1');
      expect(isUnestimable(gap)).to.equal(true);
      if (isUnestimable(gap)) {
        expect(gap.reason).to.match(/nobody@1 is not in the 2p pool/);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // §3.6: what a fit must refuse to count
  // -------------------------------------------------------------------------------------------

  describe('self-matches contribute nothing (§3.6)', () => {
    it('excludes them from the likelihood and reports the count', () => {
      const rows = [
        ...pairwiseRows(Array.from({length: 30}, () => 1), 'a@1', 'b@1', 'mixed'),
        ...pairwiseRows(Array.from({length: 20}, () => 1), 'a@1', 'a@1', 'self'),
      ];
      const set = buildComparisonSet(rows);
      expect(set.games, 'only the mixed games are fitted').to.equal(30);
      expect(set.selfMatchGames).to.equal(20);
      expect(describePool(ratePairwise(rows, {})).selfMatchGamesExcluded).to.equal(20);
    });

    it('rates a pool consisting only of self-play as having nothing to say', () => {
      const rows = pairwiseRows(Array.from({length: 40}, () => 1), 'a@1', 'a@1');
      const pool = describePool(ratePairwise(rows, {}));
      expect(pool.games).to.equal(0);
      expect(pool.selfMatchGamesExcluded).to.equal(40);
      // One identity, no comparisons: its rating is the anchor's 0, and the prior holds it there.
      expect(pool.components[0].ratings[0].elo).to.equal(0);
    });

    it('will not fit 3p rows, and names the module that will (§3.5)', () => {
      expect(() => buildComparisonSet(threePlayerRows())).to.throw(/plackettLuce/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // P6: the baselines, against §2.4's pre-registered figure
  // -------------------------------------------------------------------------------------------

  describe('P6 - the baselines get a rating, with the caveat', () => {
    it('rates greedy-1ply@1 on this bullet\'s 2p corpus and compares with §2.4', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[1], this);
      const set = buildObservationSet([artifacts[0].path]);
      const fit = ratePairwise(stratify(set, 2), {replicates: 2_000, random: analysisRandom(41_000_003)});
      const gap = eloGap(fit, 'greedy-1ply@1', PREFERRED_ANCHOR);
      expect(isUnestimable(gap)).to.equal(false);
      if (isUnestimable(gap) || gap.ci95.low === null || gap.ci95.high === null) {
        throw new Error('the 2p corpus should be bounded both ways: random-legal@1 wins 12 of 1,000');
      }

      // The corpus's own win rate, mapped through the same transform. This is the honest comparison:
      // §2.4's +837 was derived from bullet 2's 992/1,000 on a *different seed block*, and this
      // corpus is 988/1,000, so the pre-registered figure and this one are estimates of the same
      // quantity from different samples rather than two computations of one number.
      const impliedByThisCorpus = eloFromWinRate(0.988) as number;
      console.log(`      [P6] fitted ${gap.elo.toFixed(0)} Elo, 95% [${(gap.ci95.low).toFixed(0)}, ${(gap.ci95.high).toFixed(0)}]`);
      console.log(`      [P6] this corpus's raw win rate (988/1,000) maps to ${impliedByThisCorpus.toFixed(0)} Elo; ` +
        '§2.4 pre-registered +837 [719, 956] from bullet 2\'s 992/1,000 on a different seed block');

      expect(gap.elo, 'the fit tracks its own corpus\'s win rate (§3.4: it is that win rate)')
        .to.be.closeTo(impliedByThisCorpus, 10);
      expect(gap.ci95.low).to.be.lessThan(gap.elo);
      expect(gap.ci95.high).to.be.greaterThan(gap.elo);
      // The prior is doing essentially nothing at this sample size, and the report says so.
      expect(contrastShrinkage(fit, fit.identities.indexOf('greedy-1ply@1'), fit.identities.indexOf(PREFERRED_ANCHOR)))
        .to.be.lessThan(0.02);
    });
  });

  describe('eloFromWinRate', () => {
    it('reproduces §2.4\'s pre-registered mapping', () => {
      expect(eloFromWinRate(0.992) as number).to.be.closeTo(837, 1);
      expect(eloFromWinRate(0.9843) as number).to.be.closeTo(719, 1);
      expect(eloFromWinRate(0.9959) as number).to.be.closeTo(956, 2);
      expect(eloFromWinRate(0.5)).to.equal(0);
    });

    it('returns null rather than Infinity at the ends', () => {
      expect(eloFromWinRate(1)).to.equal(null);
      expect(eloFromWinRate(0)).to.equal(null);
    });
  });
});

// -----------------------------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------------------------

/** `wins` of `games` for `a@1` over `b@1`, two games per pairing group. */
function twoAgentRows(wins: number, games: number): ReadonlyArray<Observation> {
  return pairwiseRows(Array.from({length: games}, (_unused, index) => (index < wins ? 1 : 0)));
}

/**
 * One row pair per score in `scores` (1 = `a` won, 0.5 = shared, 0 = `b` won), packed two games to a
 * pairing group so that every fixture exercises the clustering rather than sidestepping it.
 */
function pairwiseRows(
  scores: ReadonlyArray<number>,
  a = 'a@1',
  b = 'b@1',
  runId = 'fixture',
): ReadonlyArray<Observation> {
  const rows: Array<Observation> = [];
  scores.forEach((score, game) => {
    const groupIndex = Math.floor(game / 2);
    const permutationIndex = game % 2;
    const tied = score === 0.5;
    [[a, score], [b, 1 - score]].forEach(([identity, own], seat) => {
      rows.push({
        clusterId: `${runId}#${groupIndex}`,
        runId,
        groupIndex,
        permutationIndex,
        players: 2,
        engineSeed: groupIndex,
        seat,
        slot: seat,
        identity: identity as string,
        win: (own as number) > 0 ? 1 : 0,
        score: own as number,
        tiedWinners: tied ? 2 : ((own as number) > 0 ? 1 : 0),
        placement: (own as number) > 0 ? 1 : 2,
        margin: (own as number) > 0 ? 10 : -10,
        marginToNext: undefined,
        victoryPoints: 60 + ((own as number) > 0 ? 10 : 0),
        megaCredits: 0,
        terraformRating: 20,
        generation: 12,
        opponents: [(identity === a ? b : a)],
        seatsHeld: a === b ? 2 : 1,
      });
    });
  });
  return rows;
}

/** A connected round robin over `strengths.length` identities, played with the real 2p pairing design. */
function roundRobinRows(
  strengths: ReadonlyArray<number>,
  groupsPerPair: number,
  random: AgentRandom,
  runPrefix: string,
): ReadonlyArray<Observation> {
  const rows: Array<Observation> = [];
  for (let i = 0; i < strengths.length; i++) {
    for (let j = i + 1; j < strengths.length; j++) {
      const corpus = simulateObservations({
        players: 2,
        strengths: [strengths[i], strengths[j]],
        identities: [`sim-${i}@1`, `sim-${j}@1`],
        groups: groupsPerPair,
        runId: `${runPrefix}-${i}-${j}`,
        random,
      });
      rows.push(...corpus.observations.rows);
    }
  }
  return rows;
}

/** A 3p row, for the "this module is 2p only" refusal. */
function threePlayerRows(): ReadonlyArray<Observation> {
  return pairwiseRows([1]).map((row) => ({...row, players: 3 as const}));
}

/**
 * The assertion criterion P5 is really about: an unbounded end is `null` **and nothing else**. A
 * `NaN` or an `Infinity` here both serialize to `null` through `JSON.stringify` and would then be
 * indistinguishable from the deliberate one - which is the whole reason the deliberate one is
 * accompanied by a reason string.
 */
function assertNoDisguisedInfinity(bounds: EloBounds): void {
  for (const end of [bounds.low, bounds.high]) {
    if (end !== null) {
      expect(Number.isFinite(end), `${end} must be finite or explicitly null`).to.equal(true);
    }
  }
  expect(bounds.unbounded, 'a null bound must always carry a reason').to.not.equal(undefined);
}
