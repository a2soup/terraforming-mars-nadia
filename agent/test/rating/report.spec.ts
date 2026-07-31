import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {buildObservationSet} from '../../src/rating/observations';
import {
  buildRatingReport,
  headToHead,
  resolveRatingOutputPath,
} from '../../src/rating/report';
import {
  assertBlockAvailable,
  assertWithinBlock,
  blockFor,
  loadLedger,
  nextFreeRange,
  rangeOf,
} from '../../src/rating/seedBlocks';
import {
  DEFAULT_ANALYSIS_SEED,
  LadderLedger,
  RATING_TIMING_FIELDS,
  isUnestimable,
  ratingReportsMatch,
  stripRatingTimingFields,
} from '../../src/rating/types';
import {COMMITTED_CORPORA, corpusPath, loadAvailableReports} from './corpora';

/**
 * Report assembly, the head-to-head comparison the gate is stated on, and the seed-block ledger.
 *
 * **A fifth spec file, which §8 does not list.** It is here because two defects surfaced by running
 * the CLI against a real corpus live at this level and nowhere else: `headToHead` reported
 * "PASS - beats itself with significance, p = 5e-111" on a self-lineup, and it counted rows rather
 * than games so a multi-seat identity's sample looked twice its real size. Neither is reachable
 * from `observations.spec.ts` or `stats.spec.ts`. No unit collides here - Unit B owns
 * `{bradleyTerry,plackettLuce,ladder}.spec.ts` and Unit C owns `calibration.spec.ts`.
 */
describe('the rating report (§3.4, §3.7, §3.8)', function() {
  this.timeout(180_000);

  const committed = corpusPath(COMMITTED_CORPORA[0]);

  // -------------------------------------------------------------------------------------------
  // P8's second half: reproducibility
  // -------------------------------------------------------------------------------------------

  describe('reproducibility (§3.7, criterion P8)', () => {
    it('is byte-identical for the same inputs and the same analysis seed', () => {
      const a = buildRatingReport([committed], {bootstrapReplicates: 200});
      const b = buildRatingReport([committed], {bootstrapReplicates: 200});
      expect(ratingReportsMatch(a, b)).to.equal(true);
      expect(JSON.stringify(stripRatingTimingFields(a)))
        .to.equal(JSON.stringify(stripRatingTimingFields(b)));
    });

    it('declares exactly the fields that legitimately differ, and strips only those', () => {
      const report = buildRatingReport([committed], {bootstrapReplicates: 50});
      expect([...RATING_TIMING_FIELDS]).to.deep.equal(['header.createdAt', 'header.nodeVersion', 'timing']);
      const stripped = stripRatingTimingFields(report) as Record<string, unknown>;
      expect(stripped).to.not.have.property('timing');
      expect((stripped.header as Record<string, unknown>)).to.not.have.property('createdAt');
      // Everything that is *not* declared has to survive, or the comparison is vacuous.
      expect((stripped.header as Record<string, unknown>).analysisSeed).to.equal(DEFAULT_ANALYSIS_SEED);
      expect(stripped).to.have.property('strata');
    });

    it('moves the bootstrap bounds - and nothing else - when the analysis seed changes', () => {
      const a = buildRatingReport([committed], {analysisSeed: DEFAULT_ANALYSIS_SEED, bootstrapReplicates: 200});
      const b = buildRatingReport([committed], {analysisSeed: DEFAULT_ANALYSIS_SEED + 4, bootstrapReplicates: 200});
      expect(ratingReportsMatch(a, b), 'a different seed is a different report').to.equal(false);
      // The point estimates are the data, not the seed; only the cross-check interval may move.
      for (const [index, stratum] of a.strata.entries()) {
        for (const [slot, entry] of stratum.bySlot.entries()) {
          const other = b.strata[index].bySlot[slot];
          if (!isUnestimable(entry.winRate) && !isUnestimable(other.winRate)) {
            expect(other.winRate.rate).to.equal(entry.winRate.rate);
            expect(other.winRate.ci95).to.deep.equal(entry.winRate.ci95);
          }
        }
      }
    });

    it('does not depend on the order the artifacts were named in', function() {
      const artifacts = loadAvailableReports();
      const paths = [...new Set(artifacts.map((artifact) => artifact.path))];
      if (paths.length < 2) {
        this.skip();
      }
      const forwards = buildRatingReport(paths, {bootstrapReplicates: 100});
      const backwards = buildRatingReport([...paths].reverse(), {bootstrapReplicates: 100});
      expect(ratingReportsMatch(forwards, backwards)).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // H9: nothing reaches an artifact as NaN
  // -------------------------------------------------------------------------------------------

  describe('hazard H9 - no NaN reaches the artifact', () => {
    it('serializes a self-play corpus - every degenerate path there is - with no null anywhere', () => {
      // `match_runner_validation.json` is the worst case on purpose: one identity in every seat, so
      // its game-level win rate is 100% (the ICC is unidentified), its per-group margin mean is
      // exactly 0 at 2p (the between-group variance is 0), and the 4p stratum is 25 groups.
      const report = buildRatingReport([committed], {bootstrapReplicates: 100});
      const serialized = JSON.stringify(report);
      expect(serialized).to.not.match(/:null/);
      expect(serialized).to.not.match(/NaN/);
      // And the degenerate paths really did fire, or this proves nothing.
      expect(serialized).to.match(/unidentified/);
      expect(serialized).to.match(/between-group variance is 0/);
    });

    it('reports an unestimable quantity as a reason a human can act on', () => {
      const report = buildRatingReport([committed], {bootstrapReplicates: 50});
      const stratum = report.strata.find((entry) => entry.players === 2);
      const test = stratum?.acFirstPlaceTests[0].test;
      expect(test).to.not.equal(undefined);
      if (test !== undefined && isUnestimable(test)) {
        expect(test.reason).to.match(/self-lineup|no single AC-5 null/);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // The head-to-head comparison the gate is stated on (§3.4)
  // -------------------------------------------------------------------------------------------

  describe('headToHead (§3.4, §3.6)', () => {
    const set = () => buildObservationSet([committed]);

    it('refuses a self-match rather than reporting that an agent beats itself', () => {
      // Before this refusal existed the gate printed "PASS - beats random-legal@1 with
      // significance, p = 4.75e-111" on the committed self-play corpus. The win rate was real: in a
      // self-lineup the challenger holds every seat, so it takes first place in 100% of games.
      const result = headToHead(set(), 'random-legal@1', 'random-legal@1', 2);
      expect(isUnestimable(result)).to.equal(true);
      if (isUnestimable(result)) {
        expect(result.reason).to.match(/cannot be gated against itself/);
      }
    });

    it('refuses a pair the corpus never seated together, naming the connectivity problem', () => {
      const result = headToHead(set(), 'greedy-1ply@1', 'random-legal@1', 2);
      expect(isUnestimable(result)).to.equal(true);
      if (isUnestimable(result)) {
        expect(result.reason).to.match(/not connected/);
      }
    });

    it('counts games, not rows, so a multi-seat identity does not double its own sample', function() {
      const artifacts = loadAvailableReports();
      const corpus = artifacts.find((artifact) =>
        artifact.report.summary.players === 3 &&
        new Set(artifact.report.header.spec.lineup.map((entry) => `${entry.name}@${entry.version}`)).size === 2);
      if (corpus === undefined) {
        this.skip();
      }
      const pooled = buildObservationSet([corpus.path]);
      const identities = [...new Set(pooled.rows.map((row) => row.identity))].sort();
      const duplicated = identities.find((identity) =>
        pooled.rows.some((row) => row.identity === identity && row.seatsHeld > 1));
      const other = identities.find((identity) => identity !== duplicated);
      if (duplicated === undefined || other === undefined) {
        this.skip();
      }
      const result = headToHead(pooled, duplicated, other, 3);
      if (!isUnestimable(result)) {
        const rows = pooled.rows.filter((row) => row.identity === duplicated).length;
        expect(result.games, 'games, not rows').to.be.lessThan(rows);
        expect(result.games).to.equal(rows / 2);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // Seed blocks (§3.8)
  // -------------------------------------------------------------------------------------------

  describe('seed-block discipline (§3.8, hazard H7)', () => {
    const ledger: LadderLedger = {
      allocations: [
        {block: 'gate', from: 2_000, to: 2_499, spentBy: 'M3 promotion gate', recordedAt: '2026-08-01'},
      ],
    };

    it('maps a group index to its block', () => {
      expect(blockFor(0)).to.equal('development');
      expect(blockFor(1_999)).to.equal('development');
      expect(blockFor(2_000)).to.equal('gate');
      expect(blockFor(6_500)).to.equal('regression');
      // 7,000-9,999 is the `harness` block, added by Unit D once the retroactive ledger seeding
      // found bullet 1's validation battery already spending 7,000-9,009 outside every block.
      expect(blockFor(9_000)).to.equal('harness');
      expect(blockFor(10_000), 'past the end of the allocation').to.equal(undefined);
    });

    it('refuses a range that leaves its block', () => {
      expect(() => assertWithinBlock('gate', 5_900, 6_100)).to.throw(/does not fit inside/);
      expect(() => assertWithinBlock('development', 0, 1_999)).to.not.throw();
    });

    it('refuses a range the ladder records as spent - a gate re-run on its own seeds is not a gate', () => {
      expect(() => assertBlockAvailable('gate', 2_400, 2_600, ledger, () => undefined))
        .to.throw(/already records as spent/);
      expect(() => assertBlockAvailable('gate', 2_400, 2_600, ledger, () => undefined))
        .to.throw(/M3 promotion gate/);
      expect(() => assertBlockAvailable('gate', 2_500, 2_999, ledger, () => undefined)).to.not.throw();
    });

    it('lets a gate run on the range it reserved, and on nobody else\'s', () => {
      // The end-to-end defect: §3.8 says reserve the range *before* the run, which put the gate's
      // own reservation in the ledger and made every possible gate refuse itself. A matching claim
      // is what distinguishes "my reservation" from "someone else's range".
      expect(() => assertBlockAvailable('gate', 2_000, 2_499, ledger, () => undefined, 'M3 promotion gate'))
        .to.not.throw();
      expect(() => assertBlockAvailable('gate', 2_000, 2_499, ledger, () => undefined, 'M4 promotion gate'))
        .to.throw(/which matches none of them/);
      expect(() => assertBlockAvailable('gate', 2_000, 2_499, ledger, () => undefined))
        .to.throw(/no --claim was given/);
    });

    it('refuses a claim that only partly covers the ranges it overlaps', () => {
      const two: LadderLedger = {
        allocations: [
          ...ledger.allocations,
          {block: 'gate', from: 2_500, to: 2_999, spentBy: 'M4 promotion gate', recordedAt: '2026-09-01'},
        ],
      };
      // Spanning both reservations with one of the two claims is not "my range".
      expect(() => assertBlockAvailable('gate', 2_400, 2_600, two, () => undefined, 'M3 promotion gate'))
        .to.throw(/already records as spent/);
    });

    it('warns loudly rather than blocking when no ladder exists yet', () => {
      const warnings: Array<string> = [];
      assertBlockAvailable('gate', 2_000, 2_499, undefined, (message) => warnings.push(message));
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.match(/no seed-block ledger found/);
    });

    it('finds the next free sub-range after what is already spent', () => {
      expect(nextFreeRange('gate', 100, ledger)).to.deep.equal({from: 2_500, to: 2_599});
      expect(nextFreeRange('gate', 100, undefined)).to.deep.equal({from: 2_000, to: 2_099});
      expect(nextFreeRange('regression', 5_000, undefined), 'larger than the block').to.equal(undefined);
    });

    it('describes a run\'s occupied range from its start and size', () => {
      expect(rangeOf(1_000, 500)).to.deep.equal({from: 1_000, to: 1_499});
    });

    /**
     * The regression guard for the defect that made every check above vacuous in production
     * (Unit D, 31 Jul 2026). The checks in this block all pass a `LadderLedger` built in memory, so
     * they exercised every path except reading the file that actually exists - and `loadLedger` was
     * written against a bare `{allocations}` shape while Unit B's ladder nests it under `ledger`. On
     * every real ladder it returned an empty list, `assertBlockAvailable` read that as "no ladder
     * yet", and the discipline warned instead of refusing.
     */
    describe('loadLedger, against the shape the ladder actually has', () => {
      const spent = [{block: 'gate' as const, from: 2_000, to: 2_099, spentBy: 'a gate', recordedAt: '2026-08-01'}];

      function writeTemp(contents: unknown): string {
        const file = path.join(os.tmpdir(), `ladder-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(file, JSON.stringify(contents));
        return file;
      }

      it('reads the nested ledger a committed ladder carries', () => {
        const file = writeTemp({header: {}, strata: [], ledger: {allocations: spent}, timing: {}});
        try {
          expect(loadLedger(file)?.allocations).to.deep.equal(spent);
        } finally {
          fs.unlinkSync(file);
        }
      });

      it('still reads a bare {allocations} file', () => {
        const file = writeTemp({allocations: spent});
        try {
          expect(loadLedger(file)?.allocations).to.deep.equal(spent);
        } finally {
          fs.unlinkSync(file);
        }
      });

      it('reports absence rather than an empty ledger when the file carries none', () => {
        const file = writeTemp({header: {}, strata: []});
        try {
          expect(loadLedger(file), 'an empty ledger and a missing one warn differently').to.equal(undefined);
        } finally {
          fs.unlinkSync(file);
        }
      });

      it('end to end: the committed ladder makes a spent range refuse', function() {
        const committed = path.join(__dirname, '..', '..', 'docs', 'data', 'ladder.json');
        if (!fs.existsSync(committed)) {
          this.skip();
        }
        const ledgerOnDisk = loadLedger(committed);
        expect(ledgerOnDisk, 'the committed ladder carries a ledger').to.not.equal(undefined);
        expect(ledgerOnDisk?.allocations.length, 'and it is not empty').to.be.greaterThan(0);
        // Groups 1000-1499 are the 2p rating corpus, recorded as spent by Unit D.
        expect(() => assertBlockAvailable('development', 1_000, 1_499, ledgerOnDisk, () => undefined))
          .to.throw(/already records as spent/);
      });
    });
  });

  describe('output paths', () => {
    it('resolves a bare filename into the committed data directory', () => {
      expect(resolveRatingOutputPath('rating_report.json')).to.match(/agent[/\\]docs[/\\]data[/\\]rating_report\.json$/);
    });
  });
});
