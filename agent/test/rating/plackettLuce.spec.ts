import {expect} from 'chai';
import {analysisRandom} from '../../src/rating/bootstrap';
import {
  ELO_PER_LOGIT,
  PREFERRED_ANCHOR,
  bradleyTerryCurvature,
  describePool,
  eloGap,
} from '../../src/rating/bradleyTerry';
import {buildObservationSet, stratify} from '../../src/rating/observations';
import {
  buildPlacementSet,
  expandTies,
  plackettLuceCurvature,
  ratePlacements,
  tieConvention,
} from '../../src/rating/plackettLuce';
import {simulateObservations} from '../../src/rating/simulate';
import {Observation, isUnestimable} from '../../src/rating/types';
import {COMMITTED_CORPORA, loadCommittedReports} from './corpora';

/**
 * The multiplayer fit, and **criterion P5's Plackett-Luce half**.
 *
 * Two properties carry most of the weight here and neither is visible in an output that looks fine:
 *
 * - **Plackett-Luce must reduce to Bradley-Terry at two players.** If it does not, the 2p and 3p
 *   ladders are on different scales while claiming to be on the same one, and nothing in either
 *   report would say so. The first test compares the two fits on identical data.
 * - **An identity holding several seats is aggregated by identity, never by slot** (hazard H2). The
 *   3p corpus is `greedy-1ply,greedy-1ply,random-legal` for exactly this reason, and it is the only
 *   real data in the project that exercises it.
 */
describe('Plackett-Luce ratings (§3.3, §3.5)', function() {
  this.timeout(300_000);

  describe('the model', () => {
    it('reduces exactly to Bradley-Terry at two players', () => {
      // The claim is about the likelihoods, and it is checked on them directly: a two-element
      // Plackett-Luce choice is a Bradley-Terry comparison, term for term. If the two ever stopped
      // agreeing, the 2p and 3p ladders would be on silently different scales while both claiming
      // the Elo one - which nothing in either report would say.
      //
      // (`buildPlacementSet` refuses 2p rows on purpose, §3.3 routing them to `bradleyTerry.ts`, so
      // the comparison is made at this level rather than by fitting the same rows twice.)
      const theta = [0.3, -0.2];
      const pairwise = bradleyTerryCurvature(theta, [[{i: 0, j: 1, count: 7, score: 5}]]);
      const placement = plackettLuceCurvature(theta, [[
        {pattern: {groups: [[0], [1]]}, count: 5},
        {pattern: {groups: [[1], [0]]}, count: 2},
      ]]);

      expect(placement.value).to.be.closeTo(pairwise.value, 1e-12);
      for (let k = 0; k < 2; k++) {
        expect(placement.gradient[k], `gradient ${k}`).to.be.closeTo(pairwise.gradient[k], 1e-12);
        for (let l = 0; l < 2; l++) {
          expect(placement.information[k][l], `information (${k},${l})`)
            .to.be.closeTo(pairwise.information[k][l], 1e-12);
        }
      }
    });

    it('has the softmax gradient and information a hand computation gives', () => {
      // Three identities, one game, ordering 0 > 1 > 2, at equal strengths. The first link is a
      // uniform choice over three, the second over two, so the gradient is
      // (1 - 1/3 - 0, -1/3 + 1 - 1/2, -1/3 - 1/2) = (2/3, 1/6, -5/6).
      const curvature = plackettLuceCurvature([0, 0, 0], [[{pattern: {groups: [[0], [1], [2]]}, count: 1}]]);
      expect(curvature.gradient[0]).to.be.closeTo(2 / 3, 1e-12);
      expect(curvature.gradient[1]).to.be.closeTo(1 / 6, 1e-12);
      expect(curvature.gradient[2]).to.be.closeTo(-5 / 6, 1e-12);
      expect(curvature.value, 'log(1/3) + log(1/2)').to.be.closeTo(Math.log(1 / 3) + Math.log(1 / 2), 1e-12);

      // The information is positive semi-definite with zero row sums (only differences are
      // identified), which is what makes the penalized system solvable and the objective concave.
      for (const row of curvature.information) {
        expect(row.reduce((total, entry) => total + entry, 0)).to.be.closeTo(0, 1e-12);
      }
    });

    it('averages over the orderings of a tied group, and says which convention that is', () => {
      expect(tieConvention).to.match(/average of the log-likelihoods/);

      // {0,1} tied at the top, 2 third. Two orderings: 0>1>2 and 1>0>2, averaged.
      const tied = plackettLuceCurvature([0, 0, 0], [[{pattern: {groups: [[0, 1], [2]]}, count: 1}]]);
      const a = plackettLuceCurvature([0, 0, 0], [[{pattern: {groups: [[0], [1], [2]]}, count: 1}]]);
      const b = plackettLuceCurvature([0, 0, 0], [[{pattern: {groups: [[1], [0], [2]]}, count: 1}]]);
      expect(tied.value).to.be.closeTo((a.value + b.value) / 2, 1e-12);
      for (let k = 0; k < 3; k++) {
        expect(tied.gradient[k], `gradient ${k}`).to.be.closeTo((a.gradient[k] + b.gradient[k]) / 2, 1e-12);
      }
      // And the convention is symmetric in the tied identities, which the rejected
      // break-by-seat-index alternative is not.
      expect(tied.gradient[0]).to.be.closeTo(tied.gradient[1], 1e-12);
    });

    it('enumerates tie orderings exactly, and only once per pattern object', () => {
      expect(expandTies({groups: [[0], [1], [2]]})).to.deep.equal([[0, 1, 2]]);
      expect(expandTies({groups: [[0, 1], [2]]})).to.deep.equal([[0, 1, 2], [1, 0, 2]]);
      expect(expandTies({groups: [[0, 1, 2, 3]]})).to.have.length(24);

      const pattern = {groups: [[0, 1], [2]]};
      expect(expandTies(pattern), 'memoized on the pattern object').to.equal(expandTies(pattern));
    });
  });

  // -------------------------------------------------------------------------------------------
  // P5: recovery and coverage over placements
  // -------------------------------------------------------------------------------------------

  describe('P5 - recovers known strengths from placements, with calibrated intervals', () => {
    /** See `bradleyTerry.spec.ts`'s P5 block for why both counts are what they are. */
    const REPLICATIONS = 250;
    const BOOTSTRAP = 500;
    const STRENGTHS = [0, 0.6, 1.2];
    const GROUPS = 60;

    function monteCarloBand(replications: number): {low: number; high: number} {
      const halfWidth = 1.959964 * Math.sqrt(0.95 * 0.05 / replications);
      return {low: 0.95 - halfWidth, high: 0.95 + halfWidth};
    }

    it('recovers the rank order and covers the extreme gap at the nominal rate', () => {
      const random = analysisRandom(41_000_003);
      const band = monteCarloBand(REPLICATIONS);
      let recovered = 0;
      let covered = 0;
      let measured = 0;

      for (let replication = 0; replication < REPLICATIONS; replication++) {
        const corpus = simulateObservations({
          players: 3,
          strengths: STRENGTHS,
          groups: GROUPS,
          runId: `sim${replication}`,
          random,
        });
        const fit = ratePlacements(corpus.observations.rows, {replicates: BOOTSTRAP, random});
        expect(fit.converged, `replication ${replication}`).to.equal(true);

        const order = fit.identities
          .map((_unused, index) => index)
          .sort((a, b) => fit.strengths[a] - fit.strengths[b]);
        if (order.every((index, position) => index === position)) {
          recovered++;
        }

        const gap = eloGap(fit, fit.identities[2], fit.identities[0]);
        if (isUnestimable(gap) || gap.ci95.low === null || gap.ci95.high === null) {
          continue;
        }
        measured++;
        const truth = (STRENGTHS[2] - STRENGTHS[0]) * ELO_PER_LOGIT;
        if (gap.ci95.low <= truth && truth <= gap.ci95.high) {
          covered++;
        }
      }

      const recovery = recovered / REPLICATIONS;
      const coverage = covered / measured;
      console.log(`      [P5/PL] rank order recovered ${(recovery * 100).toFixed(1)}% of ${REPLICATIONS} replications`);
      console.log(`      [P5/PL] coverage ${(coverage * 100).toFixed(1)}% (${covered}/${measured}), band ` +
        `[${(band.low * 100).toFixed(1)}%, ${(band.high * 100).toFixed(1)}%]`);

      expect(recovery, 'P5 rank-order recovery over placements').to.be.at.least(0.99);
      expect(coverage, 'P5 interval coverage over placements').to.be.within(band.low, band.high);
    });

    it('handles a separated identity over placements the same way as at 2p (hazard H3)', () => {
      // A last-placed identity that nothing has ever finished behind: the gap has no lower bound,
      // and the fitted number is held finite only by the prior.
      const dominated = ratePlacements(alwaysLastRows(), {replicates: 200, random: analysisRandom(41_000_003)});
      const gap = eloGap(dominated, 'loser@1', 'a@1');
      expect(isUnestimable(gap)).to.equal(false);
      if (isUnestimable(gap)) {
        return;
      }
      expect(gap.ci95.low, 'nothing has ever finished behind it, so nothing bounds it below').to.equal(null);
      expect(gap.ci95.high).to.be.a('number');
      expect(Number.isFinite(gap.elo)).to.equal(true);
      expect(gap.ci95.unbounded?.end).to.equal('below');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Hazard H2: the duplicated identity, on the only real data that exercises it
  // -------------------------------------------------------------------------------------------

  describe('the duplicated identity (hazard H2)', () => {
    it('aggregates two seats of one identity into one strength on the committed 3p corpus', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[2], this);
      const set = buildObservationSet([artifacts[0].path]);
      const placements = buildPlacementSet(stratify(set, 3));

      // Three seats, two identities: the lineup is greedy,greedy,random.
      expect(placements.identities).to.deep.equal(['greedy-1ply@1', 'random-legal@1']);
      expect(placements.games).to.equal(600);
      expect(placements.selfMatchGames).to.equal(0);
      // Both identities appear in every game, so both counts are the game count.
      expect(placements.gamesPerIdentity).to.deep.equal([600, 600]);
      // The project's first shared win lives here (Unit A's finding); the pattern set records it.
      expect(placements.tiedGames, 'the one shared win in the corpus').to.equal(1);
    });

    it('rates the 3p corpus without a NaN anywhere, and anchors at random-legal@1', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[2], this);
      const set = buildObservationSet([artifacts[0].path]);
      const pool = describePool(ratePlacements(stratify(set, 3), {
        replicates: 500,
        random: analysisRandom(41_000_003),
      }));

      expect(pool.model).to.equal('plackett-luce');
      expect(pool.connected).to.equal(true);
      expect(pool.components[0].anchor).to.equal(PREFERRED_ANCHOR);
      for (const rating of pool.components[0].ratings) {
        expect(Number.isFinite(rating.elo), `${rating.identity} elo`).to.equal(true);
        expect(Number.isNaN(rating.shrinkage)).to.equal(false);
        for (const bound of [rating.ci95.low, rating.ci95.high]) {
          expect(bound === null || Number.isFinite(bound), `${rating.identity} bound`).to.equal(true);
        }
      }
      const greedy = pool.components[0].ratings.find((rating) => rating.identity === 'greedy-1ply@1');
      expect(greedy?.elo, 'greedy is far above random at 3p too').to.be.greaterThan(300);
    });

    it('reports the 4p stratum, thin as it is, rather than pretending it is adjudicable', function() {
      // Appendix prediction 8: 25 groups is too thin for a rating interval worth quoting. The right
      // behaviour is to publish it with its width visible, not to suppress it and not to quote it.
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[3], this);
      const set = buildObservationSet([artifacts[0].path]);
      const pool = describePool(ratePlacements(stratify(set, 4), {
        replicates: 500,
        random: analysisRandom(41_000_003),
      }));
      const greedy = pool.components[0].ratings.find((rating) => rating.identity === 'greedy-1ply@1');
      expect(greedy).to.not.equal(undefined);
      if (greedy === undefined || greedy.ci95.low === null || greedy.ci95.high === null) {
        return;
      }
      const width = greedy.ci95.high - greedy.ci95.low;
      console.log(`      [4p] ${greedy.elo.toFixed(0)} Elo, 95% [${greedy.ci95.low.toFixed(0)}, ` +
        `${greedy.ci95.high.toFixed(0)}] - width ${width.toFixed(0)} Elo over ${pool.groups} pairing groups`);
      expect(pool.groups).to.equal(25);
      expect(width, 'the 4p interval is wide, and that is the finding').to.be.greaterThan(200);
    });
  });

  describe('what the placement fit refuses (§3.5, §3.6)', () => {
    it('will not fit 2p rows, and names the module that will', () => {
      expect(() => buildPlacementSet(twoSeatPlacementRows(1, 1))).to.throw(/bradleyTerry/);
    });

    it('will not mix player counts into one scale', () => {
      const three = placementRows(3, 2, () => [0, 1, 2]);
      const four = placementRows(4, 2, () => [0, 1, 2, 3]);
      expect(() => buildPlacementSet([...three, ...four])).to.throw(/per player count/);
    });

    it('excludes a whole-lineup self-match and counts it', () => {
      const rows = [
        ...placementRows(3, 10, () => [0, 1, 2], ['a@1', 'b@1', 'c@1'], 'mixed'),
        ...placementRows(3, 10, () => [0, 1, 2], ['a@1', 'a@1', 'a@1'], 'self'),
      ];
      const set = buildPlacementSet(rows);
      expect(set.games).to.equal(10);
      expect(set.selfMatchGames).to.equal(10);
    });
  });
});

// -----------------------------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------------------------

/** For the "2p only" refusal, and for the Bradley-Terry equivalence check. */
function twoSeatPlacementRows(wins: number, games: number): ReadonlyArray<Observation> {
  const rows: Array<Observation> = [];
  for (let game = 0; game < games; game++) {
    const aWon = game < wins;
    [['a@1', aWon], ['b@1', !aWon]].forEach(([identity, won], seat) => {
      rows.push(baseRow({
        runId: 'fixture',
        groupIndex: Math.floor(game / 2),
        permutationIndex: game % 2,
        players: 2,
        seat,
        identity: identity as string,
        placement: won === true ? 1 : 2,
        opponents: [identity === 'a@1' ? 'b@1' : 'a@1'],
      }));
    });
  }
  return rows;
}

/** `games` games at `players` seats, each seat's placement given by `placementsFor(game)[seat]`. */
function placementRows(
  players: 3 | 4,
  games: number,
  placementsFor: (game: number) => ReadonlyArray<number>,
  identities?: ReadonlyArray<string>,
  runId = 'fixture',
): ReadonlyArray<Observation> {
  const names = identities ?? Array.from({length: players}, (_unused, seat) => `p${seat}@1`);
  const rows: Array<Observation> = [];
  for (let game = 0; game < games; game++) {
    const placements = placementsFor(game);
    for (let seat = 0; seat < players; seat++) {
      rows.push(baseRow({
        runId,
        groupIndex: Math.floor(game / players),
        permutationIndex: game % players,
        players,
        seat,
        identity: names[seat],
        placement: placements[seat] + 1,
        opponents: names.filter((_unused, other) => other !== seat),
        seatsHeld: names.filter((name) => name === names[seat]).length,
      }));
    }
  }
  return rows;
}

/** Three identities where `loser@1` finishes last in every game: separated from below. */
function alwaysLastRows(): ReadonlyArray<Observation> {
  return placementRows(3, 60, (game) => (game % 2 === 0 ? [0, 1, 2] : [1, 0, 2]), ['a@1', 'b@1', 'loser@1']);
}

function baseRow(overrides: Partial<Observation> & {
  runId: string;
  groupIndex: number;
  permutationIndex: number;
  players: 2 | 3 | 4;
  seat: number;
  identity: string;
  placement: number;
  opponents: ReadonlyArray<string>;
}): Observation {
  return {
    clusterId: `${overrides.runId}#${overrides.groupIndex}`,
    slot: overrides.seat,
    engineSeed: overrides.groupIndex,
    win: overrides.placement === 1 ? 1 : 0,
    score: overrides.placement === 1 ? 1 : 0,
    tiedWinners: overrides.placement === 1 ? 1 : 0,
    margin: overrides.placement === 1 ? 8 : -8,
    marginToNext: undefined,
    victoryPoints: 70 - overrides.placement * 5,
    megaCredits: 0,
    terraformRating: 22,
    generation: 12,
    seatsHeld: 1,
    ...overrides,
  };
}
