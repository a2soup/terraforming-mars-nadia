import {expect} from 'chai';
import {CardName} from '@/common/cards/CardName';
import {ensureHeadlessEngine} from '../../src/engine/headlessEngine';
import {buildMatchConfigs} from '../../src/match/pairing';
import {playMatchGame} from '../../src/match/runner';
import {MatchHistoryInstrument, MemoryMovesSink} from '../../src/match/history';
import {allEntries, assertCorpusValid, entryKey, loadRegressionCorpus} from '../../src/regression/corpus';
import {dataPath} from '../../src/regression/runner';
import {L2GameEntry} from '../../src/regression/types';
import {
  CoverageObserver,
  crossCheckStandardProjects,
  identityFor,
  menuStandardProjectNames,
  standardProjectsFromMoves,
} from '../../src/regression/fingerprint';
import {
  CoverageRecordRow,
  DEFAULT_SURVEY,
  FROZEN_BASELINES,
  L2_GROUP_RANGE,
  NAMED_CARDS,
  loadCoverageRecord,
  REQUIRED_CELLS,
  SurveyGameRow,
  SurveyStratum,
  assertAllocationRecorded,
  assertSurveyWithinAllocation,
  buildTargets,
  coverGames,
  rarityWeight,
  targetsCoveredBy,
  whyFor,
} from '../../src/regression/select';

/**
 * Unit C's own checks (Milestone 2, bullet 5;
 * agent/docs/Milestone2_Bullet5_Prompts.md §3.7).
 *
 * The bullet's shared preamble asks that a unit which builds a check make it fail on purpose at
 * least once. Three of these do:
 *
 * - **the fork guard** - one `greedy-1ply@1` game is observed twice, once with `isSpeculative`
 *   honoured and once with it disarmed, and the second must see strictly more. That is the only
 *   evidence the guard on the survey path does anything, and it is `search/speculation.ts`'s own
 *   argument applied to this instrument;
 * - **the allocation guard** - a stratum outside 6,100-6,499, and two strata sharing an engine seed,
 *   are both refused before anything is played;
 * - **the S5 floor** - a covering search given a budget too small for it still returns the required
 *   cells, because a corpus without `greedy-1ply@1` at 2p has not done the bullet (§2.1).
 */
describe('Unit C: seed selection (§3.7)', function() {
  this.timeout(600_000);

  const entryKeyOf = (entry: L2GameEntry) => entryKey(entry.identity);

  before(() => {
    ensureHeadlessEngine();
  });

  // -------------------------------------------------------------------------------------------
  // The allocation
  // -------------------------------------------------------------------------------------------

  describe('the R-block allocation, checked before anything is played (S9)', () => {
    it('accepts the default survey against the committed ladder', () => {
      // Reads `docs/data/ladder.json` on disk, not an in-memory ledger. Bullet 3's two dead guards
      // both passed specs that never touched the real file.
      assertAllocationRecorded();
    });

    it('keeps every stratum inside 6,100-6,499', () => {
      for (const stratum of DEFAULT_SURVEY) {
        expect(stratum.startGroup).to.be.at.least(L2_GROUP_RANGE.from);
        expect(stratum.startGroup + stratum.groups - 1).to.be.at.most(L2_GROUP_RANGE.to);
      }
    });

    it('refuses a stratum that leaves the allocation', () => {
      const escaping: SurveyStratum = {
        label: 'escapes', agent: 'random-legal', players: 2,
        lineup: ['random-legal', 'random-legal'], startGroup: 6_000, groups: 10,
      };
      expect(() => assertSurveyWithinAllocation([escaping])).to.throw(/outside the allocated 6100-6499/);
    });

    it('refuses two strata that share engine seeds', () => {
      const first: SurveyStratum = {
        label: 'first', agent: 'random-legal', players: 2,
        lineup: ['random-legal', 'random-legal'], startGroup: 6_100, groups: 10,
      };
      const second: SurveyStratum = {...first, label: 'second', startGroup: 6_105};
      expect(() => assertSurveyWithinAllocation([first, second])).to.throw(/overlaps/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Targets and weights
  // -------------------------------------------------------------------------------------------

  describe('the target set (§2.4, §3.7)', () => {
    const targets = buildTargets();

    it('carries the 274 reachable cards, Sell Patents, and the ten milestones and awards', () => {
      const cards = targets.filter((target) => target.kind === 'card');
      expect(cards.filter((target) => target.scope === 'reachable')).to.have.length(274);
      expect(cards.filter((target) => target.scope === 'reachable-by-other-route').map((target) => target.name))
        .to.deep.equal([CardName.SELL_PATENTS_STANDARD_PROJECT]);
      expect(targets.filter((target) => target.kind === 'milestone')).to.have.length(5);
      expect(targets.filter((target) => target.kind === 'award')).to.have.length(5);
    });

    it('excludes what cannot appear in a Nadia game at all', () => {
      // Buffer Gas is solo+63TR only and Beginner Corporation is never dealt. A corpus that failed
      // to cover them would be reporting a fact about the game options, not a hole.
      expect(targets.map((target) => target.name)).to.not.include(CardName.BUFFER_GAS_STANDARD_PROJECT);
      expect(targets.map((target) => target.name)).to.not.include(CardName.BEGINNER_CORPORATION);
    });

    it('weights the §2.4 tail above the median card, and the §2.3 names above both', () => {
      // Anti-Gravity Technology: 0 of 1,500. The median reachable card: 211.
      expect(rarityWeight(0)).to.be.greaterThan(rarityWeight(211) * 10);
      expect(rarityWeight(1_499)).to.be.lessThan(rarityWeight(211));

      const named = targets.filter((target) => target.named);
      expect(named.map((target) => target.name).sort()).to.deep.equal([...NAMED_CARDS].sort());
      const decomposers = targets.find((target) => target.name === CardName.DECOMPOSERS);
      const equallyRare = targets.find((target) =>
        !target.named && target.kind === 'card' &&
        target.sweepGamesObserved === decomposers?.sweepGamesObserved);
      if (equallyRare !== undefined) {
        expect(decomposers?.weight).to.be.greaterThan(equallyRare.weight);
      }
    });

    it('names the City **standard project**, not a project card called City', () => {
      const city = targets.find((target) => target.named && target.name === CardName.CITY_STANDARD_PROJECT);
      expect(city?.section, 'the §2.3 name is the standard project').to.equal('standardProjects');
    });
  });

  // -------------------------------------------------------------------------------------------
  // The covering search
  // -------------------------------------------------------------------------------------------

  describe('the covering search (§3.7) and the budget trim (§3.8)', () => {
    /** A synthetic survey: enough to exercise the rules without playing anything. */
    function row(spec: {
      agent: string; players: 2 | 3 | 4; group: number; permutation: number;
      cards: ReadonlyArray<CardName>; ms: number; decisions?: number;
    }): SurveyGameRow {
      const lineup = Array<string>(spec.players).fill(spec.agent);
      return {
        identity: identityFor({
          agent: spec.agent, players: spec.players,
          groupIndex: spec.group, permutationIndex: spec.permutation, lineup,
        }),
        stratum: `${spec.players}p ${spec.agent}`,
        completed: true,
        durationMs: spec.ms,
        decisions: spec.decisions ?? 100,
        generation: 12,
        cards: spec.cards,
        standardProjects: [],
        cardActions: [],
        milestones: [],
        awards: [],
        crossCheck: {observerOnly: [], movesOnly: []},
      };
    }

    const cheapAndBroad = row({agent: 'random-legal', players: 2, group: 6_100, permutation: 0, ms: 100, cards: [CardName.ANTS, CardName.BIRDS, CardName.VIRUS]});
    const dearAndBroad = row({agent: 'random-legal', players: 2, group: 6_101, permutation: 0, ms: 20_000, cards: [CardName.ANTS, CardName.BIRDS, CardName.VIRUS]});
    const rows = [dearAndBroad, cheapAndBroad];

    it('prefers the cheap game to the expensive one covering the same targets (H13)', () => {
      const cover = coverGames(rows, {budgetMs: 1_000_000, requiredCells: []});
      expect(cover.selected.map((pick) => pick.row.identity.groupIndex)).to.deep.equal([6_100]);
      // The expensive twin adds nothing, so it is never picked at all - not picked and then trimmed.
      expect(cover.trimmed).to.have.length(0);
    });

    it('seeds the S5 floor before covering, and never trims it (§2.1)', () => {
      const survey = [
        ...rows,
        row({agent: 'greedy-1ply', players: 2, group: 6_160, permutation: 0, ms: 9_000, cards: [CardName.ANTS]}),
        row({agent: 'greedy-1ply', players: 2, group: 6_160, permutation: 1, ms: 9_000, cards: [CardName.ANTS]}),
      ];
      // A budget far below the cost of the required greedy games. They are pinned anyway: a suite
      // without `greedy-1ply@1` at 2p has not closed §2.1's gap, whatever it costs.
      const cover = coverGames(survey, {
        budgetMs: 50,
        requiredCells: [{agent: 'greedy-1ply', players: 2, minimum: 2}],
      });
      const greedy = cover.selected.filter((pick) => pick.row.identity.agent === 'greedy-1ply');
      expect(greedy).to.have.length(2);
      expect(greedy.every((pick) => pick.reason === 'required')).is.true;
      expect(cover.predictedMs).to.be.greaterThan(cover.budgetMs);
    });

    it('itemizes the two kinds of hole differently', () => {
      const cover = coverGames(rows, {budgetMs: 50, requiredCells: []});
      // Nothing fits the budget, so every target the survey reached is lost to the trim, and every
      // target it never reached is a different row. "The baselines cannot do this" and "we could not
      // afford it" are different findings and the record must not merge them.
      expect(cover.selected).to.have.length(0);
      expect(cover.lostToTrim).to.include('card:Ants');
      expect(cover.unreachedBySurvey).to.include('card:Anti-Gravity Technology');
      expect(cover.unreachedBySurvey).to.not.include('card:Ants');
    });

    it('recomputes newTargets over the kept set, so every why is true of the artifact', () => {
      // The invariant, rather than a fixed pick order: each kept game's `newTargets` are what *it*
      // alone contributes to the committed corpus, they never overlap, and together they are exactly
      // what the corpus covers. Computed during the search instead, a `why` could omit a target its
      // game is the only committed one to reach, because a later-trimmed game had claimed it first.
      const survey = [
        row({agent: 'random-legal', players: 2, group: 6_100, permutation: 0, ms: 10, cards: [CardName.ANTS]}),
        row({agent: 'random-legal', players: 2, group: 6_101, permutation: 0, ms: 4_000, cards: [CardName.BIRDS, CardName.MASS_CONVERTER]}),
        row({agent: 'random-legal', players: 2, group: 6_102, permutation: 0, ms: 5, cards: [CardName.BIRDS]}),
      ];
      const cover = coverGames(survey, {budgetMs: 30, requiredCells: []});
      const claimed = cover.selected.flatMap((pick) => pick.newTargets);
      expect(new Set(claimed).size, 'no two kept games claim the same target').to.equal(claimed.length);

      const covered = new Set<string>();
      for (const pick of cover.selected) {
        for (const key of targetsCoveredBy(pick.row)) {
          covered.add(key);
        }
      }
      expect([...claimed].sort()).to.deep.equal([...covered].sort());
    });

    it("writes a why that names what the game was pinned for (§3.3)", () => {
      const targets = buildTargets();
      const cover = coverGames(rows, {targets, budgetMs: 1_000_000, requiredCells: []});
      const why = whyFor(cover.selected[0], targets);
      expect(why).to.match(/Virus/);
      expect(why).to.match(/target/);
      expect(why.trim()).to.not.equal('');
    });

    it('covers a target only through the lists the survey actually recorded', () => {
      const covered = targetsCoveredBy({...cheapAndBroad, standardProjects: [CardName.CITY_STANDARD_PROJECT], cardActions: [CardName.SEARCH_FOR_LIFE], milestones: ['Mayor'], awards: ['Banker']});
      expect([...covered].sort()).to.deep.equal([
        // `action:Search For Life` and `card:Search For Life` are both here: a card whose action was
        // taken was necessarily played, and the two are separate targets on purpose.
        'action:Search For Life',
        'award:Banker', 'card:Ants', 'card:Birds', 'card:City', 'card:Search For Life', 'card:Virus', 'milestone:Mayor',
      ]);
    });

    it('scores playing a card and taking its action as different targets (prediction 5)', () => {
      const played = targetsCoveredBy({...cheapAndBroad, cards: [CardName.SEARCH_FOR_LIFE], cardActions: []});
      const acted = targetsCoveredBy({...cheapAndBroad, cards: [CardName.SEARCH_FOR_LIFE], cardActions: [CardName.SEARCH_FOR_LIFE]});
      expect([...played]).to.deep.equal(['card:Search For Life']);
      expect([...acted].sort()).to.deep.equal(['action:Search For Life', 'card:Search For Life']);

      // Convert Plants has no separate `action:` target: its action *is* its use, so a second target
      // would be a second name for the same row - which is what made `action/standardProjects 0/1`
      // read as a hole when Sell Patents had one.
      const targets = buildTargets().filter((target) => target.kind === 'action').map((target) => target.name);
      expect(targets).to.not.include(CardName.CONVERT_PLANTS);
      expect(targets).to.not.include(CardName.SELL_PATENTS_STANDARD_PROJECT);
      expect(targets).to.include(CardName.SEARCH_FOR_LIFE);
    });

    it('has a required-cell list that names both frozen baselines at 2p and 3p plus a 4p smoke (S5)', () => {
      const cells = REQUIRED_CELLS.map((cell) => `${cell.agent}/${cell.players}p`);
      expect(cells).to.have.members([
        'random-legal/2p', 'random-legal/3p', 'random-legal/4p',
        'greedy-1ply/2p', 'greedy-1ply/3p', 'greedy-1ply/4p',
      ]);
    });

    it('marks a section frozen from the named list, not from the registry\'s current version (§3.1)', () => {
      // `lookupAgent(name).version === agentVersion` is a different question and answers `true` for
      // every agent M3-M6 adds. A new version's section is born unfrozen and is added to the list
      // deliberately, at the moment it is frozen - that is what makes "a shared-infrastructure change
      // that moves a frozen baseline is a regression, not a rebaseline" enforceable.
      expect([...FROZEN_BASELINES].sort()).to.deep.equal(['greedy-1ply@1', 'random-legal@1']);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The committed artifacts
  // -------------------------------------------------------------------------------------------

  describe('the committed corpus and coverage record', () => {
    /**
     * Reads the files in the repository, not values built in memory. Bullet 3's two dead guards both
     * passed specs that never opened the file that actually exists, and §3.7's whole output is two
     * committed artifacts - so the checks that matter are the ones a future session can run on a
     * fresh checkout without a survey (which is gitignored throwaway compute, by design).
     */
    const corpus = loadRegressionCorpus(dataPath('regression_suite.json'));
    const record = loadCoverageRecord(dataPath('regression_coverage.json'));

    it('is structurally valid, and every group is inside the allocation (S9)', () => {
      assertCorpusValid(corpus);
      const groups = allEntries(corpus).map((entry) => entry.identity.groupIndex);
      expect(Math.min(...groups)).to.be.at.least(L2_GROUP_RANGE.from);
      expect(Math.max(...groups)).to.be.at.most(L2_GROUP_RANGE.to);
      // Disjoint from the range M2b1's criterion R3 already spent (§2.6).
      expect(groups.every((group) => group < 6_000 || group > 6_029)).is.true;
    });

    it('pins both frozen baselines at 2p and 3p with a 4p smoke (S5)', () => {
      const cells = new Map<string, number>();
      for (const entry of allEntries(corpus)) {
        const key = `${entry.identity.agent}/${entry.identity.players}p`;
        cells.set(key, (cells.get(key) ?? 0) + 1);
      }
      for (const cell of REQUIRED_CELLS) {
        expect(cells.get(`${cell.agent}/${cell.players}p`) ?? 0, `${cell.agent} at ${cell.players}p`)
          .to.be.at.least(cell.minimum);
      }
      expect(corpus.sections.every((section) => section.frozen), 'both sections are frozen baselines').is.true;
    });

    it('carries a why on every entry, and coverage derived from the survey (§3.3)', () => {
      for (const entry of allEntries(corpus)) {
        expect(entry.why.trim(), entryKeyOf(entry)).to.not.equal('');
        expect(entry.coverage.source, entryKeyOf(entry)).to.equal('moves-tier');
        expect(entry.fingerprints.traceCheckpoints.length, `${entryKeyOf(entry)} needs checkpoints for --explain`)
          .to.be.greaterThan(0);
      }
    });

    it('exercises all ten §2.3 named cards, or records each one as a hole with its reason (S3)', () => {
      for (const name of NAMED_CARDS) {
        const row = record.rows.find((candidate) => candidate.kind === 'card' && candidate.name === name);
        expect(row, `${name} must appear in the coverage record`).is.not.undefined;
        if ((row as CoverageRecordRow).pinnedGames === 0) {
          // Not a failure - S3 allows "individually recorded as unreachable by the baselines with the
          // reason". It is a failure to be silent about it.
          expect((row as CoverageRecordRow).hole, `${name} is uncovered and must say why`).is.not.undefined;
        }
      }
    });

    it('never reports a total without the hole list beside it (S3)', () => {
      expect(record.totals.length).to.be.greaterThan(0);
      expect(record.holes).to.deep.equal(record.rows.filter((row) => row.pinnedGames === 0));
      for (const hole of record.holes) {
        expect(hole.hole, `${hole.kind}/${hole.name}`).is.oneOf(['not-reached-by-baselines', 'lost-to-budget-trim']);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // The instrument
  // -------------------------------------------------------------------------------------------

  describe('the coverage observer (fingerprint.ts)', () => {
    const menu = menuStandardProjectNames();

    it('sees Sell Patents, which K4 scored 0 in 1,500 games', () => {
      // The K4 sweep wrapped `payAndExecute`; Sell Patents calls `projectPlayed` directly from its
      // own action callback and never calls `payAndExecute` at all, so it was invisible to that
      // instrument and filed as `reachable-by-other-route` with zero observations. It is played in
      // essentially every random-legal game.
      const observer = new CoverageObserver();
      observer.install();
      try {
        observer.startGame();
        playMatchGame(buildMatchConfigs({players: 2, lineup: ['random-legal', 'random-legal'], groups: 1, startGroup: 6_100})[0]);
        const coverage = observer.finishGame();
        expect(coverage.standardProjects).to.include(CardName.SELL_PATENTS_STANDARD_PROJECT);
        expect(observer.strayObservations).to.equal(0);
      } finally {
        observer.uninstall();
      }
    });

    it('agrees with the moves-tier derivation on the five menu standard projects', () => {
      const observer = new CoverageObserver();
      const history = new MatchHistoryInstrument({historyTier: 'moves', legality: false}, {sink: new MemoryMovesSink()});
      observer.install();
      history.install();
      try {
        observer.startGame();
        playMatchGame(buildMatchConfigs({players: 2, lineup: ['random-legal', 'random-legal'], groups: 1, startGroup: 6_101})[0], history);
        const coverage = observer.finishGame();
        const check = crossCheckStandardProjects(
          coverage.standardProjects,
          standardProjectsFromMoves(history.recordedDecisions, menu),
          menu);
        expect(check).to.deep.equal({observerOnly: [], movesOnly: []});
      } finally {
        history.uninstall();
        observer.uninstall();
      }
    });

    it('the fork guard is load-bearing: counting speculative plays reports strictly more', () => {
      // The negative control. `greedy-1ply@1` clones the game at every scored decision and plays
      // candidate moves into the clone; a prototype patch is process-global, so without
      // `isSpeculative` every one of those lands in the coverage lists - plausibly, and enormously.
      const config = buildMatchConfigs({players: 2, lineup: ['greedy-1ply', 'greedy-1ply'], groups: 1, startGroup: 6_160})[0];

      const measure = (countSpeculative: boolean) => {
        const observer = new CoverageObserver(countSpeculative);
        observer.install();
        try {
          observer.startGame();
          playMatchGame(config);
          return observer.finishGame();
        } finally {
          observer.uninstall();
        }
      };

      const guarded = measure(false);
      const unguarded = measure(true);
      expect(unguarded.cardActions.length + unguarded.standardProjects.length)
        .to.be.greaterThan(guarded.cardActions.length + guarded.standardProjects.length);
      // Every real play is still a play: the guard removes forks, it does not filter the game.
      for (const name of guarded.standardProjects) {
        expect(unguarded.standardProjects).to.include(name);
      }
    });
  });
});
