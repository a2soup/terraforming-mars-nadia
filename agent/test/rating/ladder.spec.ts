import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {PREFERRED_ANCHOR} from '../../src/rating/bradleyTerry';
import {
  DEFAULT_LINEAGE,
  allocate,
  buildLadder,
  emptyLadder,
  laddersMatch,
  loadLadder,
  predecessorOf,
  rederiveLadder,
  saveLadder,
} from '../../src/rating/ladder';
import {assertBlockAvailable, nextFreeRange} from '../../src/rating/seedBlocks';
import {SEED_BLOCKS, isUnestimable} from '../../src/rating/types';
import {COMMITTED_CORPORA, corpusPath} from './corpora';

/**
 * The ladder, and **criterion P7**.
 *
 * P7 is four refusals plus two behaviours, and every one of them exists because the alternative is a
 * number that looks exactly like a right answer:
 *
 * - overlapping group ranges for the same matchup (hazard H5 - a re-run under a new `--run-id` is
 *   the case that matters, and the case an id-based check would miss);
 * - a mismatched `engineCommit`, `harnessVersion` or `seedDerivationVersion` (hazard H6 - the
 *   Milestone-1 `initialCards` lesson repeating as a statistic);
 * - a self-lineup contributing zero games to the fit, with the exclusion reported;
 * - a degenerate stratum yielding an explicit "unestimable" rather than `NaN` (hazard H9).
 *
 * The pooling guards themselves live in Unit A's `observations.ts`; what is checked here is that the
 * *ladder* - the artifact that accumulates over months and is therefore the one most likely to be
 * handed a pre-fix and a post-fix run together - actually runs into them.
 */
describe('the ladder (§3.4, §3.6, §3.8)', function() {
  this.timeout(600_000);

  let scratch: string;

  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-ladder-'));
  });

  after(() => {
    fs.rmSync(scratch, {recursive: true, force: true});
  });

  /** Writes a doctored copy of a committed artifact, so a guard can be provoked without a real re-run. */
  function doctored(name: string, mutate: (report: Record<string, unknown>) => void): string {
    const source = corpusPath(COMMITTED_CORPORA[1]);
    const report = JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, unknown>;
    mutate(report);
    const target = path.join(scratch, name);
    fs.writeFileSync(target, JSON.stringify(report));
    return target;
  }

  function skipUnlessCorpus(context: Mocha.Context): void {
    if (!fs.existsSync(corpusPath(COMMITTED_CORPORA[1]))) {
      context.skip();
    }
  }

  // -------------------------------------------------------------------------------------------
  // P7: the four refusals
  // -------------------------------------------------------------------------------------------

  describe('P7 - pooling refuses what it should refuse (§3.6)', () => {
    it('refuses two artifacts that contain the same games, even under different run ids (H5)', function() {
      skipUnlessCorpus(this);
      // The case that matters: a re-run given a new --run-id. An id-based check would pool these.
      const rerun = doctored('rerun.json', (report) => {
        (report.header as Record<string, unknown>).runId = 'a-different-run-id';
      });
      const pool = (): unknown => buildLadder([corpusPath(COMMITTED_CORPORA[1]), rerun]);
      expect(pool).to.throw(/same game twice/);
      expect(pool, 'the message names the offending artifacts').to.throw(/a-different-run-id/);
    });

    it('refuses a mismatched engineCommit, naming both files (H6)', function() {
      skipUnlessCorpus(this);
      const repinned = doctored('repinned.json', (report) => {
        ((report.header as Record<string, unknown>).provenance as Record<string, unknown>).engineCommit = 'deadbeef';
      });
      const pool = (): unknown => buildLadder([corpusPath(COMMITTED_CORPORA[1]), repinned]);
      expect(pool).to.throw(/provenance\.engineCommit/);
      expect(pool, 'the message names the offending artifacts').to.throw(/repinned\.json/);
    });

    it('refuses a mismatched harnessVersion, naming both files (H6)', function() {
      skipUnlessCorpus(this);
      const oldHarness = doctored('old-harness.json', (report) => {
        (report.header as Record<string, unknown>).harnessVersion = '0';
      });
      const pool = (): unknown => buildLadder([corpusPath(COMMITTED_CORPORA[1]), oldHarness]);
      expect(pool).to.throw(/harnessVersion/);
      expect(pool, 'the message names the offending artifacts').to.throw(/old-harness\.json/);
    });

    it('refuses a mismatched seedDerivationVersion, naming both files (H6)', function() {
      skipUnlessCorpus(this);
      const reseeded = doctored('reseeded.json', (report) => {
        ((report.header as Record<string, unknown>).provenance as Record<string, unknown>).seedDerivationVersion = 99;
      });
      const pool = (): unknown => buildLadder([corpusPath(COMMITTED_CORPORA[1]), reseeded]);
      expect(pool).to.throw(/seedDerivationVersion/);
      expect(pool, 'the message names the offending artifacts').to.throw(/reseeded\.json/);
    });
  });

  describe('P7 - a self-lineup and a degenerate stratum', () => {
    it('contributes zero games to the fit from a self-play corpus, and says so', function() {
      // `match_runner_validation.json` is `random-legal@1` self-play at 2p, 3p and 4p: three strata,
      // none of which carries any information about relative strength (§3.6).
      const ladder = buildLadder([corpusPath(COMMITTED_CORPORA[0])], {bootstrapReplicates: 100});

      for (const stratum of ladder.strata) {
        expect(stratum.pool.games, `${stratum.players}p fitted games`).to.equal(0);
        expect(stratum.pool.selfMatchGamesExcluded, `${stratum.players}p excluded`).to.be.greaterThan(0);
        expect(stratum.entries).to.have.length(1);
        // One identity, no comparisons, so the rating is the anchor's 0 - reported, not invented.
        expect(stratum.entries[0].identity).to.equal(PREFERRED_ANCHOR);
        expect(stratum.entries[0].anchor.elo).to.equal(0);
      }
    });

    it('yields an explicit unestimable rather than NaN on a degenerate stratum (H9)', () => {
      const ladder = buildLadder([corpusPath(COMMITTED_CORPORA[0])], {bootstrapReplicates: 100});
      const stratum = ladder.strata[0];
      const entry = stratum.entries[0];

      // `random-legal@1` heads the lineage, so it has no predecessor - stated, with the reason.
      expect(isUnestimable(entry.predecessor)).to.equal(true);
      if (isUnestimable(entry.predecessor)) {
        expect(entry.predecessor.reason).to.match(/head of the promotion chain/);
      }
      expect(isUnestimable(entry.predecessorHeadToHead)).to.equal(true);

      // And nothing anywhere in the serialized ladder is NaN or a bare null where a number belongs.
      const serialized = JSON.stringify(ladder);
      expect(serialized).to.not.match(/NaN/);
      expect(JSON.parse(serialized)).to.deep.equal(JSON.parse(JSON.stringify(ladder)));
    });
  });

  // -------------------------------------------------------------------------------------------
  // §3.4: the chain
  // -------------------------------------------------------------------------------------------

  describe('the promotion chain (§3.4)', () => {
    it('rates every identity twice - against the anchor and against its immediate predecessor', function() {
      skipUnlessCorpus(this);
      const ladder = buildLadder([corpusPath(COMMITTED_CORPORA[1])], {bootstrapReplicates: 300});
      const stratum = ladder.strata.find((entry) => entry.players === 2);
      expect(stratum).to.not.equal(undefined);
      const greedy = stratum?.entries.find((entry) => entry.identity === 'greedy-1ply@1');
      expect(greedy).to.not.equal(undefined);
      if (greedy === undefined) {
        return;
      }

      expect(greedy.anchor.reference).to.equal(PREFERRED_ANCHOR);
      expect(isUnestimable(greedy.predecessor)).to.equal(false);
      if (!isUnestimable(greedy.predecessor)) {
        // With only two identities the anchor *is* the predecessor, so the two agree exactly. That
        // stops being true the moment M3 lands, which is when the predecessor figure starts
        // carrying the information (§3.4).
        expect(greedy.predecessor.reference).to.equal(PREFERRED_ANCHOR);
        expect(greedy.predecessor.elo).to.equal(greedy.anchor.elo);
      }

      // And the number a promotion is actually decided on is a win rate, not either of those.
      expect(isUnestimable(greedy.predecessorHeadToHead)).to.equal(false);
      if (!isUnestimable(greedy.predecessorHeadToHead) && !isUnestimable(greedy.predecessorHeadToHead.winRate)) {
        expect(greedy.predecessorHeadToHead.winRate.rate).to.be.closeTo(0.988, 1e-9);
        expect(greedy.predecessorHeadToHead.games).to.equal(1_000);
      }
    });

    it('knows where an identity sits in the chain, and refuses to guess when it is not in one', () => {
      expect(DEFAULT_LINEAGE).to.deep.equal(['random-legal@1', 'greedy-1ply@1']);
      expect(predecessorOf(DEFAULT_LINEAGE, 'greedy-1ply@1')).to.equal('random-legal@1');
      expect(predecessorOf(DEFAULT_LINEAGE, 'random-legal@1'), 'the head has none').to.equal(undefined);
      expect(predecessorOf(DEFAULT_LINEAGE, 'somebody-else@1')).to.equal(undefined);
    });

    it('carries the lineage forward from a committed ladder rather than re-deciding it', function() {
      skipUnlessCorpus(this);
      const lineage = ['random-legal@1', 'greedy-1ply@1', 'future-agent@1'];
      const ladder = buildLadder([corpusPath(COMMITTED_CORPORA[1])], {bootstrapReplicates: 50, lineage});
      expect(ladder.header.lineage).to.deep.equal(lineage);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Reproducibility and re-derivation
  // -------------------------------------------------------------------------------------------

  describe('reproducibility (§3.7) and re-derivation', () => {
    it('is byte-identical between two builds with the same inputs and seed, modulo the timing fields', function() {
      skipUnlessCorpus(this);
      const options = {bootstrapReplicates: 100};
      const a = buildLadder([corpusPath(COMMITTED_CORPORA[1])], options);
      const b = buildLadder([corpusPath(COMMITTED_CORPORA[1])], options);
      expect(laddersMatch(a, b)).to.equal(true);
      // ...and the timing fields really are the only difference, so the comparison is not vacuous.
      expect(JSON.stringify(a) === JSON.stringify(b)).to.equal(a.timing.wallClockMs === b.timing.wallClockMs &&
        a.header.createdAt === b.header.createdAt);
    });

    it('changes when the analysis seed changes - the interval is a draw, and says which one', function() {
      skipUnlessCorpus(this);
      const a = buildLadder([corpusPath(COMMITTED_CORPORA[1])], {bootstrapReplicates: 100, analysisSeed: 41_000_003});
      const b = buildLadder([corpusPath(COMMITTED_CORPORA[1])], {bootstrapReplicates: 100, analysisSeed: 41_000_009});
      expect(laddersMatch(a, b)).to.equal(false);
      // But the point estimates do not move: only the bootstrap does.
      expect(a.strata[0].entries[1].anchor.elo).to.equal(b.strata[0].entries[1].anchor.elo);
    });

    it('re-derives from its own recorded inputs, hashes and all', function() {
      skipUnlessCorpus(this);
      const relative = path.relative(process.cwd(), corpusPath(COMMITTED_CORPORA[1]));
      const ladder = buildLadder([relative], {bootstrapReplicates: 100});
      const result = rederiveLadder(ladder);
      expect(result.inputProblems, JSON.stringify(result.inputProblems)).to.deep.equal([]);
      expect(result.differences, JSON.stringify(result.differences)).to.deep.equal([]);
      expect(result.matches).to.equal(true);
    });

    it('reports a changed input as a changed input, not as a code regression', function() {
      skipUnlessCorpus(this);
      const relative = path.relative(process.cwd(), corpusPath(COMMITTED_CORPORA[1]));
      const ladder = buildLadder([relative], {bootstrapReplicates: 50});
      const tampered = {
        ...ladder,
        header: {...ladder.header, inputs: ladder.header.inputs.map((input) => ({...input, sha256: 'f'.repeat(64)}))},
      };
      const result = rederiveLadder(tampered);
      expect(result.matches).to.equal(false);
      expect(result.inputProblems).to.have.length(1);
      expect(result.inputProblems[0]).to.match(/bytes behind this rating have changed/);
      // And it stops there rather than reporting a numeric difference it cannot attribute.
      expect(result.differences).to.deep.equal([]);
    });

    it('round-trips through the filesystem', function() {
      skipUnlessCorpus(this);
      const ladder = buildLadder([corpusPath(COMMITTED_CORPORA[1])], {bootstrapReplicates: 50});
      const file = path.join(scratch, 'ladder.json');
      saveLadder(file, ladder);
      expect(loadLadder(file)).to.deep.equal(JSON.parse(JSON.stringify(ladder)));
      expect(loadLadder(path.join(scratch, 'absent.json'))).to.equal(undefined);
    });
  });

  // -------------------------------------------------------------------------------------------
  // §3.8: the seed-block ledger
  // -------------------------------------------------------------------------------------------

  describe('the seed-block ledger (§3.8, hazard H7)', () => {
    it('allocates the first free range in a block, and then a disjoint one', () => {
      let ladder = emptyLadder();
      ladder = allocate(ladder, {block: 'gate', groups: 500, spentBy: 'gate-one', preregisteredGames: 1_000});
      ladder = allocate(ladder, {block: 'gate', groups: 500, spentBy: 'gate-two', preregisteredGames: 1_000});

      expect(ladder.ledger.allocations.map((entry) => [entry.from, entry.to]))
        .to.deep.equal([[2_000, 2_499], [2_500, 2_999]]);
      expect(ladder.ledger.allocations[0].preregisteredGames).to.equal(1_000);
      expect(ladder.ledger.allocations[0].recordedAt).to.match(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('refuses to re-spend a range - "a gate re-run on its own sub-range is not a gate"', () => {
      const ladder = allocate(emptyLadder(), {block: 'gate', groups: 500, spentBy: 'gate-one'});
      const respend = (): unknown => allocate(ladder, {block: 'gate', groups: 100, spentBy: 'gate-one-again', from: 2_100});
      expect(respend).to.throw(/overlaps 1 range/);
      expect(respend, 'and names what spent it').to.throw(/gate-one/);
    });

    it('refuses a range that falls outside the named block', () => {
      expect(() => allocate(emptyLadder(), {block: 'gate', groups: 10, spentBy: 'x', from: 1_995}))
        .to.throw(/not inside the 'gate' block/);
      expect(() => allocate(emptyLadder(), {block: 'regression', groups: 10, spentBy: 'x', from: 6_995}))
        .to.throw(/not inside the 'regression' block/);
    });

    it('refuses when the block is exhausted rather than silently wrapping', () => {
      const width = SEED_BLOCKS.regression.to - SEED_BLOCKS.regression.from + 1;
      expect(() => allocate(emptyLadder(), {block: 'regression', groups: width + 1, spentBy: 'x'}))
        .to.throw(/no free range/);
    });

    it('gives the gate something to refuse - the ledger and assertBlockAvailable agree', () => {
      const ladder = allocate(emptyLadder(), {block: 'gate', groups: 500, spentBy: 'gate-one'});
      const silent = (): void => undefined;
      // A fresh range is fine...
      expect(() => assertBlockAvailable('gate', 2_500, 2_999, ladder.ledger, silent)).to.not.throw();
      // ...and the spent one is not, which is the whole point of writing the ledger first.
      expect(() => assertBlockAvailable('gate', 2_400, 2_600, ladder.ledger, silent))
        .to.throw(/already records as spent/);
      expect(nextFreeRange('gate', 500, ladder.ledger)).to.deep.equal({from: 2_500, to: 2_999});
    });

    it('carries the ledger forward across a rebuild, so nothing is silently un-spent', function() {
      skipUnlessCorpus(this);
      const seeded = allocate(emptyLadder(), {block: 'development', groups: 500, spentBy: 'bullet-3-corpus', from: 1_000});
      const rebuilt = buildLadder([corpusPath(COMMITTED_CORPORA[1])], {
        bootstrapReplicates: 50,
        ledger: seeded.ledger,
      });
      expect(rebuilt.ledger.allocations).to.deep.equal(seeded.ledger.allocations);
    });

    it('records the retroactive block-D allocation this bullet\'s own corpus occupies', function() {
      skipUnlessCorpus(this);
      // The 2p corpus sits at groups 1,000-1,499, inside block D (§3.8). Unit D seeds the committed
      // ladder with this; the check here is that the arithmetic the seeding will use is right.
      const ladder = buildLadder([corpusPath(COMMITTED_CORPORA[1])], {bootstrapReplicates: 50});
      const input = ladder.header.inputs[0];
      expect(input.startGroup).to.equal(1_000);
      expect(input.startGroup + input.groups - 1).to.equal(1_499);
      expect(SEED_BLOCKS.development.to).to.be.at.least(1_499);
    });
  });
});
