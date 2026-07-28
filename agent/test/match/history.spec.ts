import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {CardName} from '../../../src/common/cards/CardName';
import {InputResponse} from '../../../src/common/inputs/InputResponse';
import {Player} from '../../../src/server/Player';
import {stableStringify} from '../../src/determinism/replay';
import {applyDecision} from '../../src/driver/embeddedDriver';
import {createGame} from '../../src/engine/gameFactory';
import {saveMatchArtifact} from '../../src/match/artifact';
import {
  MatchHistoryInstrument,
  MemoryMovesSink,
  RecordedDecision,
  RecordedGameHistory,
  loadMovesFile,
  movesFileName,
  recordGameHistory,
  traceRecordedDecisions,
  verifyGameRecord,
  verifyMatchArtifact,
} from '../../src/match/history';
import {buildMatchConfigs, resolveMatchSpec} from '../../src/match/pairing';
import {buildMatchHeader, runMatchConfigs} from '../../src/match/runner';
import {MatchCaptureOptions} from '../../src/match/runner';
import {MatchSpec} from '../../src/match/types';

/**
 * The history recorder (Milestone 2 bullet 1, Unit B; §4.4 and hazard H2).
 *
 * The first two blocks are the ones that matter. H2 says a responder-wrapper history is missing whole
 * decisions and wrong on others, and that a test on one clean game passes anyway - so those two
 * failure modes are reproduced here directly, at the `applyDecision` level, rather than hoped to be
 * covered by a full-game assertion. If either block ever starts passing for a recorder that reads the
 * responder's return value, the block is wrong, not the recorder.
 *
 * Criterion R3 (a recorded history is verified, not asserted) is the last three blocks: a
 * re-derivation that matches, an artifact-level sample, and the negative control that proves the
 * check is capable of failing.
 */
describe('match history (Unit B)', function() {
  this.timeout(180_000);

  const twoPlayer: MatchSpec = {players: 2, lineup: ['random-legal', 'random-legal'], groups: 1};
  const movesCapture: MatchCaptureOptions = {historyTier: 'moves', legality: true};

  /** Drives exactly one decision through the instrument with a rigged responder. */
  function driveOneDecision(seed: number, responder: () => InputResponse): ReadonlyArray<RecordedDecision> {
    const instrument = new MatchHistoryInstrument(movesCapture, {sink: new MemoryMovesSink(), captureSteps: true});
    const [config] = buildMatchConfigs({players: 2, lineup: ['random-legal', 'random-legal'], groups: 1});
    const originalWarn = console.warn;
    console.warn = () => {};
    instrument.install();
    try {
      const wrapped = instrument.beginGame(config, responder);
      const game = createGame({players: 2, seed});
      const [red] = game.playersInGenerationOrder;
      applyDecision(red, wrapped);
      return instrument.recordedDecisions;
    } finally {
      instrument.uninstall();
      console.warn = originalWarn;
    }
  }

  describe('hazard H2, first failure mode: the FR-9 fallback substitutes a different move', () => {
    it('records the move the Engine accepted, not the one the responder returned', () => {
      // A 'card' response to the `initialCards` composite is the wrong shape entirely, so the Engine
      // rejects it and the driver recovers with `resubmitConservatively`'s own move instead. This is
      // the decision a responder wrapper would record a *rejected* move for, as though it were play.
      const responderMove: InputResponse = {type: 'card', cards: ['not a real card' as CardName]};
      const decisions = driveOneDecision(8_902, () => responderMove);

      expect(decisions).to.have.length(1);
      const [decision] = decisions;
      expect(decision.accepted, 'the decision resolved').to.not.be.undefined;
      expect(stableStringify(decision.accepted), 'the responder\'s move was not what was played')
        .to.not.equal(stableStringify(responderMove));
      expect(decision.acceptedFrom, 'it came from the FR-9 fallback').to.equal('fallback-probe');
      expect(decision.responderThrew, 'the responder did produce a move; it was rejected').to.be.undefined;
    });

    it('keeps the rejected attempt, attributed to the responder - the population AC-1 counts', () => {
      const decisions = driveOneDecision(8_903, () => ({type: 'card', cards: ['not a real card' as CardName]}));

      const [decision] = decisions;
      expect(decision.rejected, 'the rejected submission is recorded, not dropped').to.have.length(1);
      const [rejection] = decision.rejected ?? [];
      expect(rejection.source, 'a responder-attributable rejection is an illegal move under AC-1').to.equal('responder');
      expect(rejection.response.type).to.equal('card');
      expect(rejection.errorClass).to.be.a('string').and.not.equal('');
      expect(rejection.signature, 'normalized so causes group (legality/causes.ts)').to.be.a('string');
      expect(rejection.message, 'and the verbatim message, so the normalization stays auditable').to.be.a('string');
    });
  });

  describe('hazard H2, second failure mode: a responder that throws submits nothing at all', () => {
    it('still records the decision - the step a responder-wrapper trace has none for', () => {
      const decisions = driveOneDecision(8_904, () => {
        throw new Error('no actable, affordable standard project among 5 offered to player p-red');
      });

      // `agent/CLAUDE.md` §6 on the determinism corpus: `moveTraceHash` "has no step for a decision
      // the responder threw on", because `replay.ts` records *after* the responder returns. At ~5.7
      // throws per game, a history with that gap is missing whole decisions.
      expect(decisions, 'the decision is present').to.have.length(1);
      const [decision] = decisions;
      expect(decision.responderThrew).to.be.true;
      expect(decision.accepted, 'and the fallback\'s move, which is what was actually played').to.not.be.undefined;
      expect(decision.acceptedFrom).to.equal('fallback-probe');
      expect(decision.rejected, 'nothing was submitted by the responder, so nothing was rejected').to.be.undefined;
    });
  });

  describe('the third population: the FR-9 fallback\'s own rejected \'or\'-branch probes', () => {
    it('records a probe rejection as a fallback probe, not as the responder\'s illegal move', () => {
      // **This population is why the instrument sits at the submission boundary at all** (§4.6), and
      // it is the one population real play does not produce: the AC-1 run's own 1,500 games recorded
      // `rejectedFallbackProbe: 0` (docs/data/ac1_legality_run.json), because the fallback's first
      // eligible branch is always accepted. `onFallback` cannot see these at all - it reports one
      // event per decision, carrying only the branch that worked.
      //
      // So it is constructed: reject the first two submissions of the first `'or'` decision. The
      // first is the agent's own move (class A, an illegal move under AC-1's definition); the second
      // is `resubmitConservatively`'s first branch probe (a real rejected submission, and recovery
      // working as designed). The rig is installed *before* the instrument, so the instrument's own
      // wrapper captures the rig as its inner `process` and the whole stack observes the rejections.
      const original = Player.prototype.process;
      let rejected = 0;
      Player.prototype.process = function(this: Player, input: InputResponse): void {
        if (rejected < 2 && this.getWaitingFor()?.type === 'or') {
          rejected++;
          throw new Error('rigged rejection');
        }
        original.call(this, input);
      };

      let record;
      let history;
      try {
        const [config] = buildMatchConfigs(twoPlayer);
        ({record, history} = recordGameHistory(config, {legality: true, silenceRoutineLogs: true}));
      } finally {
        Player.prototype.process = original;
      }

      expect(rejected, 'the rig fired on one decision').to.equal(2);
      expect(record.completed, 'and the FR-9 fallback still carried the game to the end').to.be.true;

      const derailed = history.decisions.filter((decision) => (decision.rejected?.length ?? 0) > 0);
      expect(derailed, 'exactly the rigged decision carries rejections').to.have.length(1);
      expect(derailed[0].rejected?.map((rejection) => rejection.source))
        .to.deep.equal(['responder', 'fallback-probe']);
      expect(derailed[0].acceptedFrom, 'and the branch that was finally accepted').to.equal('fallback-probe');
      // The two rejections land in different buckets. Conflating them would be the easy way to a
      // flattering "zero illegal moves", which is the accounting mistake §4.6 exists to prevent.
      expect(record.legality?.rejectedResponder).to.equal(1);
      expect(record.legality?.rejectedFallbackProbe).to.equal(1);
      expect(record.fallbacksAfterRejection, 'the driver saw one recovered decision').to.equal(1);
    });
  });

  describe('a full game', () => {
    it('records one entry per driver decision, every one with the move that was played', () => {
      const [config] = buildMatchConfigs(twoPlayer);
      const {record, history, steps} = recordGameHistory(config, {legality: true, silenceRoutineLogs: true});

      expect(record.completed).to.be.true;
      expect(history.decisions).to.have.length(record.decisions);
      expect(steps, 'one trace step per decision').to.have.length(record.decisions);
      expect(history.decisions.every((decision) => decision.accepted !== undefined),
        'a completed game resolved every decision').to.be.true;
      expect(history.decisions.every((decision) => decision.seat >= 0),
        'every decision is attributed to a seat').to.be.true;
      expect(new Set(history.decisions.map((decision) => decision.playerId)).size,
        'both seats were asked').to.equal(2);
    });

    it('agrees with the driver\'s own fallback counters, which is what makes it auditable', () => {
      const [config] = buildMatchConfigs(twoPlayer);
      const {record, history} = recordGameHistory(config, {legality: true, silenceRoutineLogs: true});

      const fromFallback = history.decisions.filter((decision) => decision.acceptedFrom === 'fallback-probe');
      const threw = history.decisions.filter((decision) => decision.responderThrew === true);
      expect(fromFallback.length, 'a decision the fallback resolved is a decision onFallback fired for')
        .to.equal(record.fallbacksAfterRejection + record.fallbacksAfterThrow);
      expect(threw.length).to.equal(record.fallbacksAfterThrow);
      // The measured Milestone 1 rate is ~5.7 responder throws per game, all one benign cause. A game
      // with none would make every assertion above vacuous, so it is asserted rather than assumed.
      expect(threw.length, 'the H2 population really is present in an ordinary game').to.be.greaterThan(0);

      const rejections = history.decisions.reduce((total, decision) => total + (decision.rejected?.length ?? 0), 0);
      expect(record.legality?.rejectedResponder ?? -1)
        .to.equal(rejections - (record.legality?.rejectedFallbackProbe ?? 0));
    });

    it('recomputes its own hash from the stored decisions - what makes a stored history checkable', () => {
      const [config] = buildMatchConfigs(twoPlayer);
      const {history} = recordGameHistory(config, {silenceRoutineLogs: true});

      expect(traceRecordedDecisions(history.decisions).hash).to.equal(history.moveTraceHash);
    });

    it('produces the same hash on a second recording of the same config (R2, extended to the history)', () => {
      const [config] = buildMatchConfigs(twoPlayer);
      expect(recordGameHistory(config, {silenceRoutineLogs: true}).history.moveTraceHash)
        .to.equal(recordGameHistory(config, {silenceRoutineLogs: true}).history.moveTraceHash);
    });
  });

  describe('the tiers (§4.4)', () => {
    it('records nothing at summary tier, and installs no wrapper of its own', async () => {
      const spec = resolveMatchSpec(twoPlayer);
      const report = await runMatchConfigs(buildMatchConfigs(spec), spec, {
        capture: {historyTier: 'summary', legality: true},
        silenceRoutineLogs: true,
      });

      expect(report.games.every((game) => game.history === undefined), 'no history at summary tier').to.be.true;
      expect(report.games.every((game) => game.legality !== undefined), 'but the accounting is there').to.be.true;
      // At summary tier plus legality mode the SubmissionMonitor is the *only* wrapper in the
      // process - byte-identical instrumentation to the AC-1 runner's, which is what criterion R8
      // compares against. The observable consequence is that the recorder's own decision bracket
      // never runs.
      const instrument = new MatchHistoryInstrument({historyTier: 'summary', legality: true});
      instrument.install();
      try {
        const [config] = buildMatchConfigs(twoPlayer);
        const wrapped = instrument.beginGame(config, () => ({type: 'option'}));
        expect(wrapped, 'the responder is still observed, for the monitor\'s attribution rule').to.be.a('function');
        expect(instrument.recordedDecisions, 'but nothing is bracketed').to.have.length(0);
      } finally {
        instrument.uninstall();
      }
    });

    it('carries the hash but not the moves at trace tier', async () => {
      const spec = resolveMatchSpec(twoPlayer);
      const report = await runMatchConfigs(buildMatchConfigs(spec), spec, {
        capture: {historyTier: 'trace', legality: false},
        silenceRoutineLogs: true,
      });

      for (const game of report.games) {
        expect(game.history?.tier).to.equal('trace');
        expect(game.history?.moveTraceHash).to.match(/^[0-9a-f]{64}$/);
        expect(game.history?.decisions).to.equal(game.decisions);
        expect(game.history?.movesFile, 'no sidecar at trace tier').to.be.undefined;
      }
    });

    it('writes one sidecar per pairing group, named from the group alone (so sharding is invisible)', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-moves-'));
      const spec = resolveMatchSpec({players: 2, lineup: ['random-legal', 'random-legal'], groups: 2});
      const report = await runMatchConfigs(buildMatchConfigs(spec), spec, {
        capture: {historyTier: 'moves', legality: false, movesDir: directory},
        silenceRoutineLogs: true,
      });

      // The name is a function of the group index and nothing else. That is what makes criterion R6
      // hold at this tier: Unit C's pool shards by whole groups, so a game's sidecar is the same file
      // whether one process played the run or eight did.
      expect(report.games.map((game) => game.history?.movesFile))
        .to.deep.equal([movesFileName(0), movesFileName(0), movesFileName(1), movesFileName(1)]);
      expect(report.games.map((game) => game.history?.movesIndex)).to.deep.equal([0, 1, 0, 1]);
      expect(fs.readdirSync(directory).sort()).to.deep.equal([movesFileName(0), movesFileName(1)]);

      const group0 = loadMovesFile(path.join(directory, movesFileName(0)));
      expect(group0).to.have.length(2);
      expect(group0[0].moveTraceHash).to.equal(report.games[0].history?.moveTraceHash);
      expect(group0[1].seating, 'permutation 1 is the mirror').to.deep.equal([1, 0]);

      // Measured, not estimated (§4.4 guessed 30-60 KB and asked for the real figure). The band here
      // is deliberately wide - the number that goes in the write-up is Unit D's, from a real run.
      const bytesPerGame = report.instrumentation?.detail?.movesBytesPerGame as number;
      expect(bytesPerGame).to.be.greaterThan(5_000).and.lessThan(500_000);
      expect(report.instrumentation?.detail?.strayProcessCalls, 'every submission belonged to a decision').to.equal(0);
    });

    it('truncates a sidecar it has already written in this run rather than appending twice', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-moves-'));
      const spec = resolveMatchSpec(twoPlayer);
      const capture: MatchCaptureOptions = {historyTier: 'moves', legality: false, movesDir: directory};
      await runMatchConfigs(buildMatchConfigs(spec), spec, {capture, silenceRoutineLogs: true});
      await runMatchConfigs(buildMatchConfigs(spec), spec, {capture, silenceRoutineLogs: true});

      // Otherwise the second run's `movesIndex` values would point at the first run's lines - a
      // history that is present, indexed, and wrong.
      expect(loadMovesFile(path.join(directory, movesFileName(0)))).to.have.length(2);
    });
  });

  describe('installation', () => {
    it('restores Player.prototype.process exactly, in either mode', () => {
      const before = Player.prototype.process;
      for (const capture of [movesCapture, {historyTier: 'trace', legality: false} as const]) {
        const instrument = new MatchHistoryInstrument(capture, {sink: new MemoryMovesSink()});
        instrument.install();
        expect(Player.prototype.process, `${capture.historyTier}/${capture.legality}`).to.not.equal(before);
        instrument.uninstall();
        // LIFO teardown of the nested wrappers. A leaked wrapper would silently instrument every
        // later test in this process, which is the kind of failure that shows up somewhere else.
        expect(Player.prototype.process).to.equal(before);
      }
    });

    it('is idempotent, so a double install cannot leave a wrapper behind', () => {
      const before = Player.prototype.process;
      const instrument = new MatchHistoryInstrument(movesCapture, {sink: new MemoryMovesSink()});
      instrument.install();
      instrument.install();
      instrument.uninstall();
      expect(Player.prototype.process).to.equal(before);
    });
  });

  describe('criterion R3: the recorded history is verified, not asserted', () => {
    it('re-derives a game from its record\'s seeds and reproduces the history exactly', () => {
      const spec = resolveMatchSpec(twoPlayer);
      const [config] = buildMatchConfigs(spec);
      const {record, history} = recordGameHistory(config, {legality: false, silenceRoutineLogs: true});
      const header = buildMatchHeader(spec, {capture: {historyTier: 'moves', legality: false}});

      const verification = verifyGameRecord({...record, history: {tier: 'moves', moveTraceHash: history.moveTraceHash,
        decisions: history.decisions.length}}, header, history);

      expect(verification.ok, JSON.stringify(verification.divergence)).to.be.true;
      expect(verification.movesCompared, 'the stored move list itself was compared').to.be.true;
      expect(verification.rowMatchesSidecar, 'and the row addresses its own sidecar line').to.be.true;
      expect(verification.storedHash).to.equal(verification.rederivedHash);
      expect(verification.fallbackDecisions, 'and the sample exercises the fallback path (R3)').to.be.greaterThan(0);
    });

    it('verifies a written artifact end to end, sidecars and all', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-r3-'));
      const spec = resolveMatchSpec({players: 2, lineup: ['random-legal', 'random-legal'], groups: 3});
      const report = await runMatchConfigs(buildMatchConfigs(spec), spec, {
        capture: {historyTier: 'moves', legality: true, movesDir: directory},
        silenceRoutineLogs: true,
      });
      const artifact = path.join(directory, 'run.json');
      saveMatchArtifact(artifact, report);

      // `requireFallbackGames` is set low only because this is a 6-game sample; R3's own requirement
      // is 10 fallback games out of 50, and Unit D runs it at that size.
      const result = verifyMatchArtifact(artifact, {sample: 6, requireFallbackGames: 3});

      expect(result.sampled).to.equal(6);
      expect(result.failures, JSON.stringify(result.failures.map((f) => f.divergence))).to.have.length(0);
      expect(result.fallbackSampleSufficient, 'the sample reaches the fallback games (R3)').to.be.true;
      expect(result.ok).to.be.true;
      expect(result.verifications.every((verification) => verification.movesCompared)).to.be.true;
    });

    it('reports a thin fallback sample as untested rather than passing quietly', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-r3-thin-'));
      const spec = resolveMatchSpec(twoPlayer);
      const report = await runMatchConfigs(buildMatchConfigs(spec), spec, {
        capture: {historyTier: 'trace', legality: false},
        silenceRoutineLogs: true,
      });
      const artifact = path.join(directory, 'run.json');
      saveMatchArtifact(artifact, report);

      // §6: "if the sample contains no fallback games the criterion is untested, not met". A demand
      // this sample cannot meet must come back as not-ok, not as a pass with a footnote.
      const result = verifyMatchArtifact(artifact, {sample: 2, requireFallbackGames: 99});
      expect(result.failures, 'every game verified').to.have.length(0);
      expect(result.fallbackSampleSufficient).to.be.false;
      expect(result.ok, 'but R3 is not claimed on it').to.be.false;
    });
  });

  describe('the negative control: a verification that passes must be able to fail', () => {
    it('localizes a one-decision perturbation to that decision index', () => {
      const spec = resolveMatchSpec(twoPlayer);
      const [config] = buildMatchConfigs(spec);
      const {record, history} = recordGameHistory(config, {silenceRoutineLogs: true});
      const header = buildMatchHeader(spec, {capture: {historyTier: 'moves', legality: false}});

      const target = Math.floor(history.decisions.length / 2);
      const perturbed: RecordedGameHistory = {
        ...history,
        decisions: history.decisions.map((decision, index) =>
          index === target ? {...decision, pendingSignature: 'perturbed'} : decision),
      };

      const verification = verifyGameRecord(
        {...record, history: {tier: 'moves', moveTraceHash: history.moveTraceHash, decisions: history.decisions.length}},
        header,
        perturbed,
      );

      expect(verification.ok, 'a perturbed history must not verify').to.be.false;
      expect(verification.divergence?.index, 'and the divergence is localized, not just detected')
        .to.equal(target);
      expect(verification.movesDivergenceIndex).to.equal(target);
      expect(verification.divergence?.stored?.stepInput).to.contain('perturbed');
      expect(verification.divergence?.rederived?.stepInput).to.not.contain('perturbed');
      // Everything before the perturbation still agreed - which is what "localized" means, and what
      // a whole-file hash comparison could never tell you.
      expect(verification.divergence?.stored?.previousHash).to.equal(verification.divergence?.rederived?.previousHash);
    });

    it('fails a history that is missing a decision - the H2 failure mode, as a control', () => {
      const spec = resolveMatchSpec(twoPlayer);
      const [config] = buildMatchConfigs(spec);
      const {record, history} = recordGameHistory(config, {silenceRoutineLogs: true});
      const header = buildMatchHeader(spec, {capture: {historyTier: 'moves', legality: false}});

      // Drop the first decision the responder threw on: exactly the history a responder wrapper
      // would have produced. If the verification cannot see this, R3 means nothing.
      const dropped = history.decisions.findIndex((decision) => decision.responderThrew === true);
      expect(dropped, 'the game must contain a throw for this control to test anything').to.be.at.least(0);
      const missing: RecordedGameHistory = {
        ...history,
        decisions: history.decisions.filter((_decision, index) => index !== dropped),
      };

      const verification = verifyGameRecord(
        {...record, history: {tier: 'moves', moveTraceHash: history.moveTraceHash, decisions: history.decisions.length}},
        header,
        missing,
      );

      expect(verification.ok).to.be.false;
      expect(verification.divergence?.index).to.equal(dropped);
      expect(verification.storedDecisions).to.equal(verification.rederivedDecisions - 1);
    });

    it('catches a row that addresses the wrong sidecar line', () => {
      // An off-by-one `movesIndex` loads a different game's history: present, indexed, and wrong.
      // Simulated by handing game 0's row the history of game 1 - the mirror permutation of the same
      // pairing group, so both are real histories of the same starting position.
      const spec = resolveMatchSpec(twoPlayer);
      const configs = buildMatchConfigs(spec);
      const own = recordGameHistory(configs[0], {silenceRoutineLogs: true});
      const neighbour = recordGameHistory(configs[1], {silenceRoutineLogs: true});
      const header = buildMatchHeader(spec, {capture: {historyTier: 'moves', legality: false}});

      const verification = verifyGameRecord(
        {...own.record, history: {tier: 'moves', moveTraceHash: own.history.moveTraceHash,
          decisions: own.history.decisions.length}},
        header,
        neighbour.history,
      );

      expect(verification.rowMatchesSidecar).to.be.false;
      expect(verification.ok).to.be.false;
    });
  });
});
