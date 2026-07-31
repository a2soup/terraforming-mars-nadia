import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildObservationSet,
  clustersOf,
  crossCheckMarginToNext,
  gameClustersOf,
  identityGames,
  loadRatingInput,
  nullFirstPlaceRate,
  observationsOf,
  stratify,
} from '../../src/rating/observations';
import {MatchGameRecord, MatchRunReport, MatchSeatRecord, MatchStanding} from '../../src/match/types';
import {COMMITTED_CORPORA, loadCommittedReports} from './corpora';

/**
 * The observation model (Milestone2_Bullet3_Prompts.md §3.1, §3.2, §3.6), and **criterion P1**.
 *
 * P1 is the criterion that makes everything downstream trustworthy: re-deriving win counts,
 * placement counts and games-counted from the observation layer must reproduce `summary.bySlot` and
 * `summary.bySeat` **exactly** - integer equality, not "close" - on every committed run. A
 * disagreement is a defect in one of the two implementations and has to be found and named. It is
 * checked here as a spec rather than by hand because "I compared them once" is not a property that
 * survives the next edit to either side.
 *
 * Everything else in this file is a convention that has a plausible wrong answer: aggregating by
 * slot instead of identity (H2), reading `marginToNext` instead of computing the margin (§2.1), and
 * pooling artifacts that double-count or mix Engine pins (H5, H6).
 */
describe('rating observations (§3.1, §3.2, §3.6)', function() {
  this.timeout(120_000);

  // -------------------------------------------------------------------------------------------
  // P1: the observation model is faithful to the runner
  // -------------------------------------------------------------------------------------------

  /**
   * Recomputes `MatchStanding` from observation rows. Deliberately a **second implementation**
   * written from the rows rather than a call into `summarizeMatch`: a check that shares code with
   * the thing it checks proves only that the code runs.
   */
  function standingFromRows(
    rows: ReadonlyArray<{win: 0 | 1; tiedWinners: number; placement: number}>,
    players: number,
  ): Omit<MatchStanding, 'winRate' | 'winRateCi95'> {
    const placementCounts = new Array<number>(players).fill(0);
    let wins = 0;
    let sharedWins = 0;
    for (const row of rows) {
      placementCounts[row.placement - 1]++;
      if (row.win === 1) {
        wins++;
        if (row.tiedWinners > 1) {
          sharedWins++;
        }
      }
    }
    return {games: rows.length, wins, sharedWins, placementCounts};
  }

  describe('P1 - reproduces summarizeMatch exactly', () => {
    for (const corpus of COMMITTED_CORPORA) {
      it(`reproduces bySlot, bySeat and balancedGroups on ${corpus.label}`, function() {
        const artifacts = loadCommittedReports(corpus, this);
        for (const artifact of artifacts) {
          const {summary} = artifact.report;
          const {rows} = observationsOf(artifact);
          const label = `${artifact.path} ${summary.players}p`;

          for (const slot of summary.bySlot) {
            const recomputed = standingFromRows(rows.filter((row) => row.slot === slot.slot), summary.players);
            expect(recomputed, `${label} slot ${slot.slot}`).to.deep.equal({
              games: slot.games,
              wins: slot.wins,
              sharedWins: slot.sharedWins,
              placementCounts: [...slot.placementCounts],
            });
          }

          for (const seat of summary.bySeat) {
            const recomputed = standingFromRows(rows.filter((row) => row.seat === seat.seat), summary.players);
            expect(recomputed, `${label} seat ${seat.seat}`).to.deep.equal({
              games: seat.games,
              wins: seat.wins,
              sharedWins: seat.sharedWins,
              placementCounts: [...seat.placementCounts],
            });
          }

          // The balanced-group filter is what makes the two comparable at all (§3.1), so it is
          // checked directly rather than inferred from the counts above agreeing.
          const groups = new Set(rows.map((row) => row.clusterId)).size;
          expect(groups, `${label} balanced groups`).to.equal(summary.balancedGroups);
        }
      });
    }
  });

  describe('§2.1 - the margin comes from victoryPoints, not marginToNext', () => {
    it('agrees with marginToNext everywhere §2.1 says it must, on every committed run', function() {
      const artifacts = COMMITTED_CORPORA.flatMap((corpus) => loadCommittedReports(corpus, this));
      expect(artifacts.length, 'committed artifacts').to.be.greaterThan(0);
      for (const artifact of artifacts) {
        const {rows} = observationsOf(artifact);
        expect(crossCheckMarginToNext(rows), `${artifact.path}: marginToNext disagreements`).to.equal(0);
      }
    });

    it('is the gap to the best other seat, and sums to zero across a two-player game', function() {
      const report = fixtureReport({
        players: 2,
        lineup: ['alpha@1', 'beta@1'],
        games: [{groupIndex: 0, permutationIndex: 0, seating: [0, 1], vp: [55, 41], winners: [0]},
          {groupIndex: 0, permutationIndex: 1, seating: [1, 0], vp: [41, 55], winners: [1]}],
      });
      const {rows} = observationsOf(inMemory(report));
      const first = rows.filter((row) => row.permutationIndex === 0);
      expect(first.map((row) => row.margin)).to.deep.equal([14, -14]);
    });
  });

  describe('scores and the draw convention (§3.2, hazard H4)', () => {
    it('splits a shared win, which no committed game has ever exercised', () => {
      const report = fixtureReport({
        players: 2,
        lineup: ['alpha@1', 'beta@1'],
        games: [{groupIndex: 0, permutationIndex: 0, seating: [0, 1], vp: [50, 50], winners: [0, 1], placements: [1, 1]}],
      });
      const {rows} = observationsOf(inMemory(report));
      expect(rows.map((row) => row.win)).to.deep.equal([1, 1]);
      expect(rows.map((row) => row.score)).to.deep.equal([0.5, 0.5]);
      expect(rows.map((row) => row.tiedWinners)).to.deep.equal([2, 2]);
    });

    it('still records zero shared wins in bullet 1\'s 1,700 self-play games', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[0], this);
      const shared = artifacts.flatMap((artifact) => observationsOf(artifact).rows).filter((row) => row.tiedWinners > 1);
      expect(shared, 'shared wins in match_runner_validation.json').to.have.length(0);
    });

    /**
     * **Hazard H4 is now half false, and this is where that is recorded.**
     *
     * The plan states that 1,700 committed games contain **0 shared wins**, so "the draw convention
     * is nearly free to choose and *completely untested by data*". That was true of bullet 1's
     * self-play corpora and is no longer true of the project: this bullet's own 1,700-game corpus
     * contains exactly one shared win - `rating_corpus_3p.json`, group 1501, permutation 2, where
     * two `greedy-1ply@1` seats finished on **72 VP and 51 megacredits each**, so the Engine's real
     * winner rule (VP, then megacredits, `match/ranking.ts`) could not separate them and recorded
     * both as winners.
     *
     * The 0.5 convention fired and fired correctly: each row scores 0.5, and because both tied seats
     * hold the *same identity*, `identityGames` sums them back to 1 - the identity won that game
     * outright, which is the right answer. §3.2 says the difference between `winRate` and
     * `scoreRate` "is itself the finding" if ties ever appear; one has, at a rate of roughly 1 in
     * 1,700 games, and Unit D should say so rather than repeating that the path is untested.
     *
     * VP ties broken on megacredits, for comparison with §2.3's self-play figures (1.6% / 2.8% /
     * 3.0%): **0.3% at 2p, 2.5% at 3p, 3.0% at 4p** on the greedy-vs-random corpus. The 2p rate
     * collapses because `greedy-1ply@1` wins 98.8% of those games outright.
     */
    it('finds the project\'s first shared win in this bullet\'s own corpus, and splits it 0.5/0.5', function() {
      const corpus = COMMITTED_CORPORA.find((entry) => entry.file === 'rating_corpus_3p.json');
      const artifacts = loadCommittedReports(corpus as never, this);
      const rows = artifacts.flatMap((artifact) => observationsOf(artifact).rows);
      const shared = rows.filter((row) => row.tiedWinners > 1);

      expect(shared, 'shared-win rows at 3p').to.have.length(2);
      for (const row of shared) {
        expect(row.win, 'both tied seats are winners').to.equal(1);
        expect(row.score, 'and each scores 1 / tiedWinners').to.equal(0.5);
        expect(row.placement).to.equal(1);
        expect(row.margin, 'a tie is a zero margin').to.equal(0);
      }
      expect(new Set(shared.map((row) => row.victoryPoints)).size, 'tied on VP').to.equal(1);
      expect(new Set(shared.map((row) => row.megaCredits)).size, 'and on the megacredit tiebreak').to.equal(1);

      // Both tied seats hold the same identity, so the identity won that game outright.
      const game = identityGames(rows, shared[0].identity)
        .find((entry) => entry.groupIndex === shared[0].groupIndex && entry.permutationIndex === shared[0].permutationIndex);
      expect(game?.win).to.equal(1);
      expect(game?.score, '0.5 + 0.5 back to a whole win').to.equal(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  // H2: identity aggregation
  // -------------------------------------------------------------------------------------------

  describe('identity aggregation (hazard H2)', () => {
    /** 3p, `alpha` in two seats - the shape of this bullet's own 3p corpus. */
    const duplicated = fixtureReport({
      players: 3,
      lineup: ['alpha@1', 'alpha@1', 'beta@1'],
      games: [
        // seating[seat] = slot, so game 0 seats alpha at 0 and 1; game 1 seats alpha at 1 and 2.
        {groupIndex: 0, permutationIndex: 0, seating: [0, 1, 2], vp: [60, 40, 50], winners: [0], placements: [1, 3, 2]},
        {groupIndex: 0, permutationIndex: 1, seating: [2, 0, 1], vp: [40, 70, 50], winners: [1], placements: [3, 1, 2]},
      ],
    });

    it('gives an identity holding two seats two rows per game, and one game record', () => {
      const {rows} = observationsOf(inMemory(duplicated));
      const alpha = rows.filter((row) => row.identity === 'alpha@1');
      expect(alpha, 'alpha rows').to.have.length(4);
      expect(new Set(alpha.map((row) => row.seatsHeld))).to.deep.equal(new Set([2]));
      expect(identityGames(rows, 'alpha@1'), 'alpha games').to.have.length(2);
    });

    it("states the AC-5 null as seats held over players, not 1/players - 2/3, not 1/3", () => {
      const {rows} = observationsOf(inMemory(duplicated));
      expect(nullFirstPlaceRate(rows.filter((row) => row.identity === 'alpha@1'))).to.be.closeTo(2 / 3, 1e-12);
      expect(nullFirstPlaceRate(rows.filter((row) => row.identity === 'beta@1'))).to.be.closeTo(1 / 3, 1e-12);
    });

    it('counts a game as won if any of the identity\'s seats won - not the fraction of its rows', () => {
      const {rows} = observationsOf(inMemory(duplicated));
      const games = identityGames(rows, 'alpha@1');
      // Alpha wins both games: seat 0 in the first, seat 1 in the second. Its *game* rate is 100%.
      expect(games.map((game) => game.win)).to.deep.equal([1, 1]);
      // Its *row* rate is 2/4 = 50%, because its other seat lost each time. That is the number a
      // slot-blind row aggregation would compare against a 2/3 null and call incompetent.
      expect(rows.filter((row) => row.identity === 'alpha@1' && row.win === 1)).to.have.length(2);
      expect(rows.filter((row) => row.identity === 'alpha@1')).to.have.length(4);
    });
  });

  // -------------------------------------------------------------------------------------------
  // §3.6: the pooling guards
  // -------------------------------------------------------------------------------------------

  describe('pooling guards (§3.6, hazards H5 and H6)', () => {
    const base = fixtureReport({
      players: 2,
      lineup: ['alpha@1', 'beta@1'],
      games: [{groupIndex: 0, permutationIndex: 0, seating: [0, 1], vp: [55, 41], winners: [0]},
        {groupIndex: 0, permutationIndex: 1, seating: [1, 0], vp: [41, 55], winners: [1]}],
    });

    function pooling(...reports: ReadonlyArray<MatchRunReport>): () => void {
      const paths = reports.map((report, index) => writeTemp(`pool-${index}.json`, report));
      return () => buildObservationSet(paths);
    }

    it('refuses the same games under a different run id - the case a run-id check would miss', () => {
      const rerun = {...base, header: {...base.header, runId: 'a-different-run-id'}};
      expect(pooling(base, rerun)).to.throw(/same game twice/);
    });

    it('refuses a mismatched engineCommit', () => {
      const other = withProvenance(base, {engineCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'});
      expect(pooling(base, other)).to.throw(/provenance\.engineCommit/);
    });

    it('refuses a mismatched seedDerivationVersion', () => {
      const other = withProvenance(base, {seedDerivationVersion: 2});
      expect(pooling(base, other)).to.throw(/provenance\.seedDerivationVersion/);
    });

    it('refuses a mismatched harnessVersion', () => {
      const other = {...base, header: {...base.header, harnessVersion: '2', runId: 'later-harness'}};
      expect(pooling(base, other)).to.throw(/harnessVersion/);
    });

    it('names the offending files in every refusal', () => {
      const rerun = {...base, header: {...base.header, runId: 'a-different-run-id'}};
      expect(pooling(base, rerun)).to.throw(/pool-0\.json[\s\S]*pool-1\.json/);
    });

    it('allows two different matchups over the same group block, and reports the shared seeds', () => {
      // The refinement of §3.6's literal key: two genuinely different matchups on one seed block
      // are different games, and refusing them would break the connected comparison graph §3.4
      // needs. The shared initial positions are reported instead.
      const other = fixtureReport({
        players: 2,
        lineup: ['gamma@1', 'beta@1'],
        runId: 'gamma-vs-beta',
        games: [{groupIndex: 0, permutationIndex: 0, seating: [0, 1], vp: [52, 44], winners: [0]},
          {groupIndex: 0, permutationIndex: 1, seating: [1, 0], vp: [44, 52], winners: [1]}],
      });
      const set = buildObservationSet([writeTemp('mix-0.json', base), writeTemp('mix-1.json', other)]);
      expect(set.identities).to.deep.equal(['alpha@1', 'beta@1', 'gamma@1']);
      expect(set.sharedEngineSeeds, 'shared engine seeds').to.have.length(1);
      expect(set.sharedEngineSeeds[0].runIds).to.have.length(2);
    });

    it('refuses a summaries-only artifact with a message that says why', () => {
      const summariesOnly = writeTemp('summaries.json', {main: {runs: [{players: 2, summary: {}}]}} as never);
      expect(() => loadRatingInput(summariesOnly)).to.throw(/no per-game rows/);
    });
  });

  describe('loading', () => {
    it('accepts both a top-level report and reports nested in a validation artifact', function() {
      const nested = loadCommittedReports(COMMITTED_CORPORA[0], this);
      expect(nested.length, 'reports inside match_runner_validation.json').to.equal(3);
      expect(nested.map((artifact) => artifact.location))
        .to.deep.equal(['main.runs[0]', 'main.runs[1]', 'main.runs[2]']);

      const top = writeTemp('top-level.json', nested[0].report);
      expect(loadRatingInput(top).map((artifact) => artifact.location)).to.deep.equal(['']);
    });

    it('hashes the file, not the parsed report, so a claim traces back to bytes', function() {
      const corpus = COMMITTED_CORPORA[0];
      const artifacts = loadCommittedReports(corpus, this);
      expect(new Set(artifacts.map((artifact) => artifact.sha256)).size, 'one hash per file').to.equal(1);
      expect(artifacts[0].sha256).to.match(/^[0-9a-f]{64}$/);
    });
  });

  describe('clustering (§3.1)', () => {
    it('clusters on (runId, groupIndex) and nothing else', function() {
      const artifacts = loadCommittedReports(COMMITTED_CORPORA[0], this);
      const set = buildObservationSet([artifacts[0].path]);
      for (const players of set.playerCounts) {
        const rows = stratify(set, players);
        for (const cluster of clustersOf(rows)) {
          expect(new Set(cluster.map((row) => row.engineSeed)).size, 'one engine seed per cluster').to.equal(1);
          expect(new Set(cluster.map((row) => row.groupIndex)).size).to.equal(1);
          expect(new Set(cluster.map((row) => row.runId)).size).to.equal(1);
        }
      }
    });

    it('puts an identity\'s games in the same clusters its rows are in', () => {
      const {rows} = observationsOf(inMemory(fixtureReport({
        players: 3,
        lineup: ['alpha@1', 'alpha@1', 'beta@1'],
        games: [
          {groupIndex: 7, permutationIndex: 0, seating: [0, 1, 2], vp: [60, 40, 50], winners: [0], placements: [1, 3, 2]},
          {groupIndex: 7, permutationIndex: 1, seating: [2, 0, 1], vp: [70, 40, 50], winners: [0], placements: [1, 3, 2]},
        ],
      })));
      const clusters = gameClustersOf(identityGames(rows, 'alpha@1'));
      expect(clusters, 'one cluster').to.have.length(1);
      expect(clusters[0], 'two games in it').to.have.length(2);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

type FixtureGame = {
  groupIndex: number;
  permutationIndex: number;
  /** `seating[seat] = slot`. */
  seating: ReadonlyArray<number>;
  /** By seat. */
  vp: ReadonlyArray<number>;
  /** Seats that won. */
  winners: ReadonlyArray<number>;
  /** By seat; defaults to VP order. */
  placements?: ReadonlyArray<number>;
};

/**
 * A minimal `MatchRunReport`, hand-built so the conventions above can be exercised on games the
 * Engine has never produced - a shared win, in particular, which 1,700 committed games contain
 * zero of (hazard H4).
 */
function fixtureReport(spec: {
  players: 2 | 3 | 4;
  lineup: ReadonlyArray<string>;
  games: ReadonlyArray<FixtureGame>;
  runId?: string;
}): MatchRunReport {
  const identities = spec.lineup.map((entry) => {
    const [name, version] = entry.split('@');
    return {name, version};
  });
  const permutationsPerGroup = new Set(spec.games.map((game) => game.permutationIndex)).size;

  const games: Array<MatchGameRecord> = spec.games.map((game) => {
    const placements = game.placements ?? byVictoryPoints(game.vp);
    const seats: Array<MatchSeatRecord> = game.seating.map((slot, seat) => ({
      seat,
      slot,
      playerId: `p-${['red', 'green', 'yellow', 'blue'][seat]}` as MatchSeatRecord['playerId'],
      agent: identities[slot].name,
      agentVersion: identities[slot].version,
      agentSeed: 1_000 + slot,
      outcome: {
        placement: placements[seat],
        isWinner: game.winners.includes(seat),
        marginToNext: undefined,
        victoryPoints: game.vp[seat],
        megaCredits: 10,
        terraformRating: 30,
        vpBreakdown: {terraformRating: 30, milestones: 0, awards: 0, greenery: 0, city: 0, cards: 0, total: game.vp[seat]},
        victoryPointsByGeneration: [game.vp[seat]],
        corporations: [],
        preludes: [],
        projectCards: [],
      },
    }));
    return {
      groupIndex: game.groupIndex,
      permutationIndex: game.permutationIndex,
      engineSeed: 21_000_017 + game.groupIndex * 1_409,
      seating: game.seating,
      completed: true,
      generation: 14,
      decisions: 100,
      fallbacksAfterRejection: 0,
      fallbacksAfterThrow: 0,
      seats,
      claimedMilestones: [],
      fundedAwards: [],
      durationMs: 1,
    };
  });

  return {
    header: {
      runId: spec.runId ?? 'fixture',
      harnessVersion: '1',
      spec: {
        players: spec.players,
        lineup: identities,
        groups: new Set(spec.games.map((game) => game.groupIndex)).size,
        startGroup: Math.min(...spec.games.map((game) => game.groupIndex)),
        permutationsPerGroup,
        games: spec.games.length,
      },
      pairing: {
        policy: spec.players === 4 ? 'cyclic-rotation' : 'full-permutation',
        permutationsPerGroup,
        engineSeedBase: 21_000_017,
        engineSeedStride: 1_409,
        agentSeedBase: 27_000_023,
        agentSeedStride: 3_251,
        agentSeedSlotStride: 149,
      },
      historyTier: 'summary',
      legalityMode: false,
      incompleteGroupPolicy: 'excluded-from-balanced-statistics',
      provenance: {
        engineCommit: '868714d72a434ab68fe08e5570ebc6863859ae15',
        agentCommit: 'fixture',
        nodeVersion: process.version,
        agentVersion: '0.0.1',
        seedDerivationVersion: 1,
        env: {GAME_CACHE: undefined, MAX_GAME_DAYS: undefined},
        createdAt: '2026-07-30T00:00:00.000Z',
      },
    },
    summary: {
      players: spec.players,
      groups: new Set(spec.games.map((game) => game.groupIndex)).size,
      permutationsPerGroup,
      games: games.length,
      completed: games.length,
      failed: 0,
      balancedGroups: new Set(spec.games.map((game) => game.groupIndex)).size,
      totalDecisions: 100 * games.length,
      fallbacksAfterRejection: 0,
      fallbacksAfterThrow: 0,
      decisionsPerGame: {min: 100, p50: 100, p95: 100, max: 100, mean: 100},
      generationsPerGame: {min: 14, p50: 14, p95: 14, max: 14, mean: 14},
      bySlot: [],
      bySeat: [],
      timing: {wallClockMs: 1, durationMsPerGame: {min: 1, p50: 1, p95: 1, max: 1, mean: 1}},
    },
    games,
  };
}

/** 1-based placement from VP, ties sharing the lower number - `match/ranking.ts`'s rule. */
function byVictoryPoints(vp: ReadonlyArray<number>): ReadonlyArray<number> {
  return vp.map((own) => 1 + vp.filter((other) => other > own).length);
}

function withProvenance(report: MatchRunReport, patch: Partial<MatchRunReport['header']['provenance']>): MatchRunReport {
  return {
    ...report,
    header: {...report.header, runId: 'other-provenance', provenance: {...report.header.provenance, ...patch}},
  };
}

let temporaryDir: string | undefined;

function writeTemp(name: string, report: MatchRunReport): string {
  temporaryDir = temporaryDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-rating-'));
  const filePath = path.join(temporaryDir, name);
  fs.writeFileSync(filePath, JSON.stringify(report));
  return filePath;
}

/** A `LoadedArtifact` around an in-memory report, for the cases that never touch a file. */
function inMemory(report: MatchRunReport): Parameters<typeof observationsOf>[0] {
  return {path: '<fixture>', sha256: '0'.repeat(64), location: '', report};
}

after(() => {
  if (temporaryDir !== undefined) {
    fs.rmSync(temporaryDir, {recursive: true, force: true});
  }
});
