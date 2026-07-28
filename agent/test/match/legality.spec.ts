import {expect} from 'chai';
import {Player} from '../../../src/server/Player';
import {createGame} from '../../src/engine/gameFactory';
import {buildLegalityConfigs} from '../../src/legality/seeds';
import {SubmissionMonitor} from '../../src/legality/submissionMonitor';
import {CauseTally} from '../../src/legality/types';
import {
  EMPTY_LEGALITY_COUNTERS,
  MatchLegalityMode,
  causeTallyKey,
  checkMatchNeutrality,
  checkNeutralityAgainstReplay,
  compareLegalityAccounting,
  mergeCauseTallies,
  mergeLegalityCounters,
} from '../../src/match/legality';
import {buildMatchConfigs, resolveMatchSpec} from '../../src/match/pairing';
import {runMatchConfigs} from '../../src/match/runner';

/**
 * The absorbed AC-1 legality accounting (Milestone 2 bullet 1, Unit B; §4.6).
 *
 * **Criterion R8 is an equivalence, not a smoke test**, so it is written here as a spec rather than
 * as a one-off script: this is the check that will catch a future refactor quietly changing what
 * "zero illegal moves" counts. The two halves are separate claims and both are needed -
 * {@link compareLegalityAccounting} says the absorbed accounting counts the same things as
 * `runLegalityBatch`, and the two neutrality checks say the instrumentation does not perturb the
 * games it measures.
 *
 * The merge-semantics block is Unit C's contract: `SubmissionMonitor` is per-process global state, so
 * each pool child installs its own and the parent merges. Specifying the merge here, with tests, is
 * what stops the pool from inventing its own.
 */
describe('match legality mode (Unit B)', function() {
  this.timeout(300_000);

  describe('merge semantics (specified here so Unit C\'s pool implements rather than invents them)', () => {
    it('sums counters, and does so independently of the order shards finish in', () => {
      const a = {submissions: 10, rejectedResponder: 1, rejectedFallbackProbe: 2, responderThrows: 3};
      const b = {submissions: 5, rejectedResponder: 0, rejectedFallbackProbe: 4, responderThrows: 1};

      const forwards = mergeLegalityCounters([a, b]);
      expect(forwards).to.deep.equal({submissions: 15, rejectedResponder: 1, rejectedFallbackProbe: 6, responderThrows: 4});
      // Order independence is what makes a pooled artifact comparable to a single-process one (R6):
      // the parent must not be able to change the totals by draining shards in a different order.
      expect(mergeLegalityCounters([b, a])).to.deep.equal(forwards);
      expect(mergeLegalityCounters([a, undefined, b])).to.deep.equal(forwards);
      expect(mergeLegalityCounters([])).to.deep.equal(EMPTY_LEGALITY_COUNTERS);
    });

    it('merges cause tallies by signature, summing counts and keeping one representative', () => {
      const one: CauseTally = {
        source: 'responder', decisionType: 'or', errorClass: 'Error',
        signature: 'no affordable project among N', count: 3, representative: 'no affordable project among 5',
      };
      const same: CauseTally = {...one, count: 4, representative: 'no affordable project among 12'};
      const different: CauseTally = {...one, signature: 'Too many cards selected', count: 1};

      const merged = mergeCauseTallies([[one, different], [same]]);
      expect(merged).to.have.length(2);
      expect(merged[0].count, 'the same cause summed').to.equal(7);
      expect(merged[0].representative, 'one representative kept - the first seen').to.equal('no affordable project among 5');
      expect(merged[1].signature, 'a genuinely different cause stays separate').to.equal('Too many cards selected');
      // Most-frequent-first with the signature as a tiebreak, matching SubmissionMonitor.causeTallies,
      // so a merged list and an unmerged one are byte-comparable.
      expect(merged.map((tally) => tally.count)).to.deep.equal([7, 1]);
    });

    it('keys on exactly what SubmissionMonitor keys on, so nothing collapses that it kept apart', () => {
      const monitor = new SubmissionMonitor();
      monitor.startGame();
      // Two throws that differ only in the decision type - one of the four axes of the key.
      const game = createGame({players: 2, seed: 9_101});
      const [red] = game.playersInGenerationOrder;
      const waitingFor = red.getWaitingFor();
      for (const decisionType of ['or', 'projectCard']) {
        const responder = monitor.observeResponder(() => {
          throw new Error('no actable, affordable standard project among 5 offered to player p-red');
        });
        expect(() => responder({
          player: red, game, raw: waitingFor as never,
          model: {...(waitingFor as never as {}), type: decisionType} as never,
        })).to.throw();
      }

      expect(monitor.causeTallies, 'the monitor kept them apart').to.have.length(2);
      // Merging a single process's own tallies must be the identity. If `causeTallyKey` keyed on less
      // than the monitor's own key, this is where two distinct causes would fuse - and criterion L6's
      // "every distinct cause is named, never bucketed into other" would quietly stop holding across
      // a pooled run.
      expect(mergeCauseTallies([monitor.causeTallies])).to.deep.equal([...monitor.causeTallies]);
      expect(new Set(monitor.causeTallies.map(causeTallyKey)).size).to.equal(2);
    });
  });

  describe('the mode installs exactly one monitor', () => {
    it('restores Player.prototype.process on uninstall', () => {
      const before = Player.prototype.process;
      const mode = new MatchLegalityMode();
      mode.install();
      expect(mode.installed).to.be.true;
      expect(Player.prototype.process).to.not.equal(before);
      mode.uninstall();
      expect(Player.prototype.process).to.equal(before);
      expect(mode.installed).to.be.false;
    });

    it('reports the strict accounting per game and sums it into the run', async () => {
      const spec = resolveMatchSpec({players: 2, lineup: ['random-legal', 'random-legal'], groups: 1});
      const report = await runMatchConfigs(buildMatchConfigs(spec), spec, {
        capture: {historyTier: 'summary', legality: true},
        silenceRoutineLogs: true,
      });

      expect(report.games.every((game) => game.legality !== undefined)).to.be.true;
      expect(report.summary.legality?.submissions).to.equal(
        report.games.reduce((total, game) => total + (game.legality?.submissions ?? 0), 0));
      // The AC-1 headline for `random-legal@1`: no Agent-attributable rejection, and the class-B
      // throws present and counted. A run where `submissions` were zero would satisfy every
      // "rejected === 0" assertion and mean nothing, so the denominator is asserted too.
      expect(report.summary.legality?.submissions).to.be.greaterThan(100);
      expect(report.summary.legality?.rejectedResponder).to.equal(0);
      expect(report.summary.legality?.responderThrows).to.be.greaterThan(0);
    });
  });

  describe('criterion R8: the absorbed accounting is the same accounting', () => {
    // The AC-1 run's own seed schedule, so this compares the match runner against the Milestone 1
    // artifact-of-record on the very games that artifact adjudicated. 20 configs here for suite
    // speed; R8 is stated on >= 50 and Unit D runs it at that size through the same function.
    const configs = buildLegalityConfigs([{players: 2, games: 12}, {players: 3, games: 4}, {players: 4, games: 4}]);

    it('agrees with runLegalityBatch on every counter AC-1 is adjudicated on', async () => {
      const report = await compareLegalityAccounting(configs);

      expect(report.configsChecked).to.equal(configs.length);
      expect(report.mismatches, JSON.stringify(report.mismatches.slice(0, 5))).to.have.length(0);
      // A comparison of two zeroes is not a comparison. These are the numbers R8 is about, and they
      // have to be real for the equality above to say anything.
      expect(report.totals.submissions).to.be.greaterThan(1_000);
      expect(report.totals.responderThrows, 'the third population is present in the sample').to.be.greaterThan(0);
      expect(report.totals.completed).to.equal(configs.length);
      expect(report.causeTalliesAgree, 'the same submissions, rejected for the same reasons').to.be.true;
      expect(report.legalityCauses.length, 'and there were causes to agree about').to.be.greaterThan(0);
    });
  });

  describe('the instrumentation does not perturb the games it measures', () => {
    it('observes what the uninstrumented determinism harness observes (instrumentationCheck\'s comparison)', async () => {
      const configs = buildLegalityConfigs([{players: 2, games: 4}, {players: 3, games: 2}]);
      const report = await checkNeutralityAgainstReplay(configs);

      expect(report.configsChecked).to.equal(configs.length);
      expect(report.mismatches, JSON.stringify(report.mismatches)).to.have.length(0);
    });

    it('leaves a real per-seat match game byte-identical, field for field', async () => {
      // The stronger of the two checks, and the one that exercises the seat router: the whole game
      // record has to survive the instrumentation unchanged, not just three counters.
      const spec = resolveMatchSpec({players: 2, lineup: ['random-legal', 'random-legal'], groups: 2});
      const report = await checkMatchNeutrality(buildMatchConfigs(spec), spec);

      expect(report.gamesChecked).to.equal(4);
      expect(report.mismatches, JSON.stringify(report.mismatches.slice(0, 3))).to.have.length(0);
    });

    it('holds at 3p too, where six permutations share one engine seed', async () => {
      const spec = resolveMatchSpec({players: 3, lineup: new Array(3).fill('random-legal'), groups: 1});
      const report = await checkMatchNeutrality(buildMatchConfigs(spec), spec);

      expect(report.gamesChecked).to.equal(6);
      expect(report.mismatches, JSON.stringify(report.mismatches.slice(0, 3))).to.have.length(0);
    });
  });
});
