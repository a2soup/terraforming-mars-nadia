import {expect} from 'chai';
import {CorpusHeaderMismatchError} from '../../src/determinism/corpus';
import {
  assertCorpusComparable,
  assertCorpusValid,
  compareEntry,
  digestCorpus,
  entryKey,
  normalizePath,
  parseEntryKey,
  playRegressionEntry,
  RegressionCorpusError,
  tallyFieldsMoved,
} from '../../src/regression/corpus';
import {L1FixtureResult, L2GameEntry, RegressionCorpus, assertL2Entry} from '../../src/regression/types';
import {ensureHeadlessEngine} from '../../src/engine/headlessEngine';
import {playMatchGame} from '../../src/match/runner';
import {agentSeedForSlot, engineSeedForGroup} from '../../src/match/pairing';
import {loadSmoke, playedFrom} from './helpers';

/**
 * The record format and the per-field diff (Milestone 2, bullet 5, Unit A §2/§3/§7).
 *
 * Per the bullet's shared preamble - *"a regression suite that has never refused anything is
 * indistinguishable from one that works"* - every check below either **is** a refusal or has one
 * beside it. The four Unit A §7 names explicitly are the format, the per-field diff, header
 * rejection, and the ledger's refusal path; the last of those is in `ledger.spec.ts`, where it is
 * exercised through the CLI rather than against a value.
 */
describe('the L2 corpus format and its diff (§3.3)', function() {
  this.timeout(300_000);

  const corpus: RegressionCorpus = loadSmoke();
  const randomLegal2p = corpus.sections
    .flatMap((section) => section.entries)
    .find((entry) => entry.identity.agent === 'random-legal' && entry.identity.players === 2) as L2GameEntry;
  const greedyMixed = corpus.sections
    .flatMap((section) => section.entries)
    .find((entry) => entry.identity.agent === 'greedy-1ply' && entry.identity.lineup.includes('random-legal')) as L2GameEntry;

  before(() => {
    ensureHeadlessEngine();
  });

  // -------------------------------------------------------------------------------------------
  // The format
  // -------------------------------------------------------------------------------------------

  describe('the committed record', () => {
    it('carries the identity, the fingerprints, the semantics, the coverage and the why', () => {
      // §3.3's entry shape, asserted on the real artifact rather than on a value this spec built -
      // the distinction `rating/seedBlocks.ts` paid a milestone to learn.
      expect(Object.keys(randomLegal2p).sort()).to.deep.equal(
        ['coverage', 'fingerprints', 'identity', 'layer', 'semantics', 'why']);
      expect(randomLegal2p.why.length).to.be.greaterThan(20);
      expect(randomLegal2p.fingerprints.moveTraceHash).to.match(/^[0-9a-f]{64}$/);
      expect(randomLegal2p.fingerprints.traceCheckpoints.length).to.be.greaterThan(0);
    });

    it('commits the fields, not a hash of the fields - every VP component is separately readable', () => {
      // The whole of §3.3: "greenery VP moved by 2" has to be a different event from "the trace
      // differs", and a combined hash makes them the same event.
      const seat = randomLegal2p.semantics.seats[0];
      expect(Object.keys(seat.vpBreakdown).sort()).to.deep.equal(
        ['awards', 'cards', 'city', 'greenery', 'milestones', 'terraformRating', 'total']);
      expect(seat.vpBreakdown.total).to.equal(seat.victoryPoints);
    });

    it('a mixed lineup is filed under one section and records who actually sat', () => {
      expect(greedyMixed.identity.agent).to.equal('greedy-1ply');
      expect(greedyMixed.identity.lineup).to.deep.equal(['greedy-1ply', 'random-legal']);
      expect(greedyMixed.semantics.seats.map((seat) => seat.agent)).to.deep.equal(['greedy-1ply', 'random-legal']);
    });

    it('records why coverage is empty rather than letting "not measured" look like "nothing"', () => {
      // Bullet 3's hazard H9, one layer down: an unmeasured quantity reported as a zero is the
      // failure mode, not a rounding choice.
      expect(randomLegal2p.coverage.source).to.equal('not-derived');
    });

    it('round-trips its key', () => {
      const parsed = parseEntryKey(entryKey(greedyMixed.identity));
      expect(parsed.agent).to.equal('greedy-1ply');
      expect(parsed.players).to.equal(2);
      expect(parsed.groupIndex).to.equal(greedyMixed.identity.groupIndex);
      expect(parsed.permutationIndex).to.equal(greedyMixed.identity.permutationIndex);
      expect(() => parseEntryKey('greedy-1ply/2p/6100')).to.throw(/not an entry key/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The per-field diff, and its negative controls
  // -------------------------------------------------------------------------------------------

  describe('compareEntry', () => {
    it('reports nothing when the replay reproduces the record', () => {
      expect(compareEntry(randomLegal2p, playedFrom(randomLegal2p))).to.deep.equal([]);
    });

    it('names a moved fingerprint field, and only that field', () => {
      const diffs = compareEntry(randomLegal2p, playedFrom(randomLegal2p, (played) => {
        (played.fingerprints as {moveTraceHash: string}).moveTraceHash = 'f'.repeat(64);
      }));
      expect(diffs).has.length(1);
      expect(diffs[0].group).to.equal('fingerprint');
      expect(diffs[0].path).to.equal('fingerprints.moveTraceHash');
      expect(diffs[0].expected).to.equal(randomLegal2p.fingerprints.moveTraceHash);
    });

    it('does not compare traceCheckpoints - they localize, they do not detect', () => {
      // Comparing them would add no sensitivity (the chain is rolling, so anything they could see
      // has already moved moveTraceHash) and would turn one honest row into twelve.
      const diffs = compareEntry(randomLegal2p, playedFrom(randomLegal2p, (played) => {
        (played.fingerprints as {traceCheckpoints: unknown}).traceCheckpoints = [];
      }));
      expect(diffs).to.deep.equal([]);
    });

    it('addresses a nested semantic field by its full path', () => {
      const diffs = compareEntry(randomLegal2p, playedFrom(randomLegal2p, (played) => {
        played.semantics.seats[1].vpBreakdown.greenery += 2;
      }));
      expect(diffs).has.length(1);
      expect(diffs[0]).to.include({group: 'semantics', path: 'semantics.seats[1].vpBreakdown.greenery'});
      expect(diffs[0].actual).to.equal(randomLegal2p.semantics.seats[1].vpBreakdown.greenery + 2);
    });

    it('reports an array length change once, at the array, instead of a row per shifted index', () => {
      const before = randomLegal2p.semantics.seats[0].projectCards.length;
      const diffs = compareEntry(randomLegal2p, playedFrom(randomLegal2p, (played) => {
        (played.semantics.seats[0] as unknown as {projectCards: Array<unknown>}).projectCards =
          [...played.semantics.seats[0].projectCards].slice(0, -1);
      }));
      expect(diffs).has.length(1);
      expect(diffs[0].path).to.equal('semantics.seats[0].projectCards.length');
      expect(diffs[0].expected).to.equal(before);
    });

    it('sees a milestone claimed by a different seat', () => {
      const withMilestones = corpus.sections.flatMap((section) => section.entries)
        .find((entry) => entry.semantics.claimedMilestones.length > 0);
      expect(withMilestones, 'no smoke entry claims a milestone, so this control asserts nothing').is.not.undefined;
      const target = withMilestones as L2GameEntry;
      const diffs = compareEntry(target, playedFrom(target, (played) => {
        (played.semantics.claimedMilestones[0] as {seat: number}).seat = 99;
      }));
      expect(diffs.map((diff) => diff.path)).to.deep.equal(['semantics.claimedMilestones[0].seat']);
    });

    it('refuses an L1 result - §3.1\'s layer boundary, enforced at runtime and not only by the type', () => {
      const fixture: L1FixtureResult = {layer: 'l1', file: 'x.spec.ts', title: 'Immigrant City', passed: true};
      expect(() => assertL2Entry(fixture, 'a test')).to.throw(/only compares reference games/);
    });
  });

  describe('tallyFieldsMoved', () => {
    it('counts entries per field, not rows, and normalizes the seat index away', () => {
      // At 4p a field that moved in every seat is one finding, not four - and the ledger's
      // `fieldsMoved` is read as "how many entries did this field move in".
      expect(normalizePath('semantics.seats[3].vpBreakdown.city')).to.equal('semantics.seats[].vpBreakdown.city');
      const tally = tallyFieldsMoved([{
        identity: randomLegal2p.identity,
        why: randomLegal2p.why,
        diffs: [
          {group: 'semantics', path: 'semantics.seats[0].victoryPoints', expected: 1, actual: 2},
          {group: 'semantics', path: 'semantics.seats[1].victoryPoints', expected: 3, actual: 4},
        ],
      }]);
      expect(tally).to.deep.equal({'semantics.seats[].victoryPoints': 1});
    });
  });

  // -------------------------------------------------------------------------------------------
  // Header rejection (hazard H9)
  // -------------------------------------------------------------------------------------------

  describe('header compatibility', () => {
    it('accepts the committed corpus against this environment', () => {
      expect(() => assertCorpusComparable(corpus)).to.not.throw();
    });

    it('rejects a corpus written under a different Engine pin, before comparing anything', () => {
      const doctored: RegressionCorpus = {...corpus, header: {...corpus.header, engineCommit: 'deadbeef'.repeat(5)}};
      expect(() => assertCorpusComparable(doctored)).to.throw(CorpusHeaderMismatchError);
    });

    it('does NOT reject on a changed agent commit or Node version - those must surface as moved entries', () => {
      // The design decision this bullet inherits verbatim from `determinism/corpus.ts` (§2.2): a
      // header rejection means "this comparison would be meaningless", and a fingerprint mismatch
      // means "something that matters changed". Rejecting on the agent commit would convert this
      // suite's most informative signal into silence.
      const doctored: RegressionCorpus = {
        ...corpus,
        header: {...corpus.header, agentCommit: 'a'.repeat(40), nodeVersion: 'v18.0.0'},
      };
      expect(() => assertCorpusComparable(doctored)).to.not.throw();
    });

    it('rejects a corpus written by a different suite version', () => {
      expect(() => assertCorpusComparable({...corpus, suiteVersion: '0'})).to.throw(/record schema changed/);
    });

    it('digests content and not the write timestamp', () => {
      const later: RegressionCorpus = {...corpus, header: {...corpus.header, createdAt: new Date().toISOString()}};
      expect(digestCorpus(later)).to.equal(digestCorpus(corpus));
    });

    // The bug this pins shipped, and the thing that caught it was a *merge* - i.e. the most
    // ordinary event in the repository. `digestCorpus` hashed the header minus `createdAt`, so it
    // moved on every subsequent commit via `agentCommit`, and a rebaseline that moved nothing
    // recorded `corpusDigestBefore !== corpusDigestAfter` - the exact misleading signal the two
    // ledger digest fields exist to prevent. `createdAt` alone was never the whole rule.
    it('digests content and not any provenance field, including the agent commit', () => {
      const churned: RegressionCorpus = {...corpus, header: {
        ...corpus.header,
        agentCommit: '0'.repeat(40),
        nodeVersion: 'v99.0.0',
        agentVersion: '99.99.99',
        createdAt: new Date().toISOString(),
      }};
      expect(digestCorpus(churned), 'provenance churn is not a content change').to.equal(digestCorpus(corpus));
    });

    // Without this the assertion above is satisfied by a `digestCorpus` that returns a constant.
    it('still moves when the content moves', () => {
      const moved: RegressionCorpus = {...corpus, sections: corpus.sections.map((section, index) => index > 0 ? section : {
        ...section,
        entries: section.entries.map((entry, entryIndex) => entryIndex > 0 ? entry : {
          ...entry,
          fingerprints: {...entry.fingerprints, moveTraceHash: '0'.repeat(64)},
        }),
      })};
      expect(digestCorpus(moved)).to.not.equal(digestCorpus(corpus));
    });
  });

  // -------------------------------------------------------------------------------------------
  // Structural validation - the refusals that happen before an artifact is written
  // -------------------------------------------------------------------------------------------

  describe('assertCorpusValid', () => {
    /** The committed corpus with one entry doctored, to provoke exactly one refusal. */
    function doctored(mutate: (entry: L2GameEntry) => void): RegressionCorpus {
      const copy = JSON.parse(JSON.stringify(corpus)) as RegressionCorpus;
      mutate(copy.sections[0].entries[0] as L2GameEntry);
      return copy;
    }

    it('accepts the committed corpus', () => {
      expect(() => assertCorpusValid(corpus)).to.not.throw();
    });

    it('refuses an entry with no why (§3.3 - it is not decoration)', () => {
      expect(() => assertCorpusValid(doctored((entry) => {
        (entry as {why: string}).why = '  ';
      }))).to.throw(RegressionCorpusError, /no 'why'/);
    });

    it('refuses a duplicate key (hazard H4)', () => {
      const copy = JSON.parse(JSON.stringify(corpus)) as RegressionCorpus;
      const section = copy.sections[0];
      (section.entries as Array<L2GameEntry>).push(JSON.parse(JSON.stringify(section.entries[0])) as L2GameEntry);
      expect(() => assertCorpusValid(copy)).to.throw(/duplicate entry key/);
    });

    it('refuses a group index outside the R block (criterion S9)', () => {
      expect(() => assertCorpusValid(doctored((entry) => {
        (entry.identity as {groupIndex: number}).groupIndex = 1_234;
      }))).to.throw(/outside the R block/);
    });

    it('refuses an entry filed under a section it does not name', () => {
      expect(() => assertCorpusValid(doctored((entry) => {
        (entry.identity as {agent: string}).agent = 'greedy-1ply';
      }))).to.throw(/filed under section/);
    });

    it('refuses a seating that is not the pairing schedule\'s permutation', () => {
      // Which is what would make an entry unreproducible by the match runner from its own identity.
      expect(() => assertCorpusValid(doctored((entry) => {
        (entry.identity as {seating: ReadonlyArray<number>}).seating = [1, 0];
        (entry.identity as {permutationIndex: number}).permutationIndex = 0;
      }))).to.throw(/is not the pairing schedule's permutation/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The cross-check that keeps the duplicated seat reader honest
  // -------------------------------------------------------------------------------------------

  describe('the pinned game is the game the match runner plays', () => {
    /**
     * **The claim the whole L2 layer rests on.** Unit C selects entries from a `moves`-tier survey
     * played by `match/runner.ts`, and those entries are then verified by `regression/corpus.ts`
     * through `replay()`. If the two paths built even slightly different games - a different agent
     * seed per seat, a different wrapper order, a different driver-option merge - the pinned record
     * would describe a game the survey never saw, and every coverage claim in criterion S3 would be
     * about a different corpus than the one being verified.
     *
     * It also pins the twelve lines of `readSeatSemantics` that are knowingly duplicated from
     * `playMatchGame` (see that function's doc comment).
     */
    function assertSamePlay(entry: L2GameEntry): void {
      const {identity} = entry;
      const record = playMatchGame({
        groupIndex: identity.groupIndex,
        permutationIndex: identity.permutationIndex,
        players: identity.players,
        engineSeed: engineSeedForGroup(identity.groupIndex),
        seating: identity.seating,
        agentSeeds: identity.lineup.map((_, slot) => agentSeedForSlot(identity.groupIndex, slot)),
        lineup: identity.lineup,
      });
      const played = playRegressionEntry(identity);

      expect(record.completed, 'the match runner should have completed this game').is.true;
      expect(played.fingerprints.generation).to.equal(record.generation);

      // **The two `decisions` counts are not the same count, and this is the assertion that says
      // so.** `match/runner.ts`'s router increments *before* calling the agent, so it counts a
      // decision the responder threw on; `replay.ts`'s `withMoveTrace` records *after* the
      // responder returns, so it does not - the same property `agent/CLAUDE.md` §6 records as
      // "moveTraceHash has no step for a decision the responder threw on". The gap is therefore
      // exactly the responder-throw population, ~5.7 per game at the scale AC-1 measured.
      //
      // Asserting equality here would have been wrong, and asserting `<=` would have hidden the
      // relationship. This pins it, and it is what stops Unit C reading a 295-vs-300 as a defect.
      expect(record.decisions - played.fingerprints.decisions).to.equal(record.fallbacksAfterThrow);
      expect(played.fingerprints.fallbacks).to.equal(record.fallbacksAfterThrow + record.fallbacksAfterRejection);
      expect(played.semantics.claimedMilestones).to.deep.equal(record.claimedMilestones);
      expect(played.semantics.fundedAwards).to.deep.equal(record.fundedAwards);
      played.semantics.seats.forEach((seat, index) => {
        const outcome = record.seats[index].outcome;
        expect(outcome, `seat ${index} should have an outcome`).is.not.undefined;
        const {marginToNext: _margin, victoryPointsByGeneration: _curve, ...compared} = outcome as NonNullable<typeof outcome>;
        const {seat: _seat, slot: _slot, agent: _agent, agentVersion: _version, ...semantics} = seat;
        expect(semantics).to.deep.equal(compared);
      });
    }

    it('agrees with playMatchGame on a random-legal@1 game', () => {
      assertSamePlay(randomLegal2p);
    });

    it('agrees with playMatchGame on a greedy-1ply@1 game - the fork service included', () => {
      // The one that matters. `greedy-1ply@1` contributes both `driverOptions` and
      // `observeDecisions`, and a replay path that dropped either would produce an agent that
      // quietly stops being able to fork rather than one that fails (`registry.ts`'s warning).
      assertSamePlay(greedyMixed);
    });
  });
});
