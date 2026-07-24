import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {Player} from '../../../src/server/Player';
import {CardName} from '../../../src/common/cards/CardName';
import {ConstRandom} from '../../../src/common/utils/Random';
import {createGame} from '../../src/engine/gameFactory';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {agentRandomFrom} from '../../src/core/rng';
import {applyDecision} from '../../src/driver/embeddedDriver';
import {buildArtifact, loadArtifact, saveArtifact} from '../../src/legality/artifact';
import {causeSignature, errorClassName} from '../../src/legality/causes';
import {percentiles, runLegalityBatch} from '../../src/legality/run';
import {
  AGENT_SEED_BASE,
  buildLegalityConfigs,
  DEFAULT_COMPOSITION,
  ENGINE_SEED_BASE,
} from '../../src/legality/seeds';
import {SubmissionMonitor} from '../../src/legality/submissionMonitor';
import {PhoboLog} from '../../../src/server/cards/corporation/PhoboLog';

/**
 * The AC-1 legality run's machinery (agent/docs/AC1_Legality_Run.md). The run itself is 1,500
 * games and is not a per-commit check; this spec is the part that has to keep working, so the run
 * can be re-executed and believed later.
 *
 * The one behavioural regression guard here is the last block: the initial project-card budget cap
 * the run's own findings put into `enumerateInitialCards`. That was the only Agent-attributable
 * illegal move in 1,500 games, and nothing else in the suite would notice it coming back.
 */
describe('AC-1 legality run', () => {
  describe('seed schedule (SRS CON-5)', () => {
    const configs = buildLegalityConfigs();

    it('produces the pre-committed composition: 1,000 at 2p plus 250 each at 3p/4p', () => {
      expect(configs).to.have.length(1500);
      expect(DEFAULT_COMPOSITION.map((c) => [c.players, c.games])).to.deep.equal([[2, 1000], [3, 250], [4, 250]]);
      expect(configs.filter((c) => c.players === 2)).to.have.length(1000);
      expect(configs.filter((c) => c.players === 3)).to.have.length(250);
      expect(configs.filter((c) => c.players === 4)).to.have.length(250);
    });

    it('gives every game its own engine seed and its own agent seed', () => {
      expect(new Set(configs.map((c) => c.engineSeed)).size).to.equal(configs.length);
      expect(new Set(configs.map((c) => c.agentSeed)).size).to.equal(configs.length);
    });

    it('keeps the two seed spaces independent: neither sequence is a function of the other', () => {
      // Two progressions with different bases and different strides. The check that matters is
      // that the *difference* between them is not constant - if it were, agentSeed would just be
      // engineSeed plus an offset, which is the coupling CON-5 rules out (and which the much
      // smaller Tier-1 batch's `seed * 13 + 97` schedule had).
      const differences = new Set(configs.map((c) => c.agentSeed - c.engineSeed));
      expect(differences.size).to.be.greaterThan(1);
      expect(configs[0].engineSeed).to.equal(ENGINE_SEED_BASE);
      expect(configs[0].agentSeed).to.equal(AGENT_SEED_BASE);
    });

    it('stays clear of the determinism corpus seed space, so the run is new evidence', () => {
      // The corpus sweeps engine seeds 500,000 + 977k for k < 50 (determinism/sweep.ts).
      const corpusSeeds = new Set(Array.from({length: 50}, (_, k) => 500_000 + k * 977));
      expect(configs.some((c) => corpusSeeds.has(c.engineSeed))).to.be.false;
    });
  });

  describe('cause classification (criterion L6)', () => {
    it('normalizes ids and numbers so repeat occurrences of one cause collapse to one signature', () => {
      const a = new Error('enumerateProjectCard: no actable, affordable standard project among 5 offered to player p-red');
      const b = new Error('enumerateProjectCard: no actable, affordable standard project among 12 offered to player p-green');
      expect(causeSignature(a)).to.equal(causeSignature(b));
      expect(causeSignature(a)).to.equal('enumerateProjectCard: no actable, affordable standard project among N offered to player <player>');
    });

    it('keeps genuinely different causes apart', () => {
      expect(causeSignature(new Error('Too many cards selected')))
        .to.not.equal(causeSignature(new Error('Did not spend enough')));
    });

    it('reports the error class, including for a non-Error throw', () => {
      expect(errorClassName(new TypeError('x'))).to.equal('TypeError');
      expect(errorClassName('a string')).to.equal('non-Error(string)');
    });
  });

  describe('percentiles', () => {
    it('reports nearest-rank values, so every number quoted is one actually observed', () => {
      const p = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(p).to.deep.equal({min: 1, p50: 5, p95: 10, max: 10, mean: 5.5});
    });

    it('degrades to NaN rather than throwing on an empty sample', () => {
      expect(Number.isNaN(percentiles([]).p50)).to.be.true;
    });
  });

  describe('SubmissionMonitor (criterion L5)', () => {
    it('restores Player.prototype.process on uninstall', () => {
      const before = Player.prototype.process;
      const monitor = new SubmissionMonitor();
      monitor.install();
      expect(Player.prototype.process).to.not.equal(before);
      expect(monitor.installed).to.be.true;
      monitor.uninstall();
      expect(Player.prototype.process).to.equal(before);
      expect(monitor.installed).to.be.false;
    });

    it('counts a responder throw as a class-B event with nothing submitted', () => {
      const monitor = new SubmissionMonitor();
      monitor.startGame();
      const responder = monitor.observeResponder(() => {
        throw new Error('no actable, affordable standard project among 5 offered to player p-red');
      });

      const game = createGame({players: 2, seed: 8801});
      const [red] = game.playersInGenerationOrder;
      const waitingFor = red.getWaitingFor()!;
      expect(() => responder({player: red, game, raw: waitingFor, model: waitingFor.toModel(red)})).to.throw();

      const counters = monitor.gameCounters;
      expect(counters.responderThrows, 'the throw is counted').to.equal(1);
      expect(counters.submissions, 'but nothing was submitted, so it is not an illegal move').to.equal(0);
      expect(monitor.causeTallies).to.have.length(1);
      expect(monitor.causeTallies[0].source).to.equal('responder-throw');
    });

    it('attributes a rejected responder move to the responder, not to the fallback', () => {
      const monitor = new SubmissionMonitor();
      monitor.install();
      try {
        monitor.startGame();
        const game = createGame({players: 2, seed: 8802});
        const [red] = game.playersInGenerationOrder;
        const responder = monitor.observeResponder(() => ({type: 'card', cards: ['not a real card' as CardName]}));

        // A 'card' response to the initialCards composite is the wrong shape entirely, so the
        // Engine rejects it - the driver then recovers via the FR-9 fallback, whose own
        // submissions must land in the other bucket.
        applyDecision(red, responder);

        const counters = monitor.gameCounters;
        expect(counters.rejectedResponder, 'the responder\'s own rejected move').to.equal(1);
        expect(counters.rejectedFallbackProbe, 'the fallback\'s response was accepted first time').to.equal(0);
        expect(counters.submissions, 'both the rejected move and the accepted fallback are submissions').to.equal(2);
      } finally {
        monitor.uninstall();
      }
    });
  });

  describe('the run loop', function() {
    this.timeout(60_000);

    it('plays a small batch to completion and reports the strict accounting', async () => {
      const report = await runLegalityBatch(buildLegalityConfigs([{players: 2, games: 2}, {players: 3, games: 1}]), {
        heapSampleEvery: 1,
        silenceRoutineLogs: true,
      });

      expect(report.summary.gamesRun).to.equal(3);
      expect(report.summary.gamesCompleted, 'every game reaches Phase.END').to.equal(3);
      expect(report.summary.gamesFailed).to.equal(0);
      expect(report.summary.unrecoverableIllegalMoves).to.equal(0);
      expect(report.games.every((g) => g.completed && g.decisions > 50 && g.generation > 1),
        'a "completed" game that took three decisions would not be a real game').to.be.true;
      expect(report.stability, 'L7 sampled every game here').to.have.length(3);

      // The accounting has to balance, or none of the class-A/class-B numbers mean anything:
      // every decision is one responder call, and every responder call either submits once or
      // throws; the fallback's own submissions are the remainder.
      for (const game of report.games) {
        const responderSubmissions = game.decisions - game.responderThrows;
        expect(game.submissions).to.be.at.least(responderSubmissions);
      }
    });

    it('records a failing game and keeps going rather than aborting the run', async () => {
      const monitor = new SubmissionMonitor();
      monitor.install();
      // Force every submission to fail, which the FR-9 fallback cannot route around either -
      // the driver surfaces UnrecoverableIllegalMoveError and the run must record it, not throw.
      Player.prototype.process = function() {
        throw new Error('forced failure');
      };
      let report;
      try {
        report = await runLegalityBatch(buildLegalityConfigs([{players: 2, games: 2}]), {silenceRoutineLogs: true});
      } finally {
        monitor.uninstall();
      }

      expect(report.summary.gamesRun, 'the second game still ran').to.equal(2);
      expect(report.summary.gamesCompleted).to.equal(0);
      expect(report.summary.gamesFailed).to.equal(2);
      expect(report.games[0].failure?.message).to.contain('forced failure');
    });
  });

  describe('the run artifact', () => {
    it('round-trips through save/load with the Engine pin in the header', async () => {
      const report = await runLegalityBatch(buildLegalityConfigs([{players: 2, games: 2}]), {silenceRoutineLogs: true});
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-legality-')), 'run.json');
      saveArtifact(file, buildArtifact(report));

      const loaded = loadArtifact(file);
      expect(loaded.header.engineCommit).to.equal('868714d72a434ab68fe08e5570ebc6863859ae15');
      expect(loaded.games).to.have.length(2);
      expect(loaded.summary).to.deep.equal(report.summary);
    });
  });

  describe('the initial project-card budget cap (the fix this run produced)', () => {
    it('never selects more initial project cards than the chosen corporation can pay for', () => {
      const game = createGame({players: 2, seed: 8001});
      const [red] = game.playersInGenerationOrder;

      // PhoboLog: 23 starting M€, default 3 M€/card -> 7 affordable, against 10 dealt.
      red.dealtCorporationCards.length = 0;
      red.dealtCorporationCards.push(new PhoboLog());

      // An rng pinned just under 1 forces every count to its upper bound - the exact rigging that
      // used to produce the illegal 10-card selection.
      applyDecision(red, randomLegalAgent(agentRandomFrom(new ConstRandom(0.999999))));

      expect(red.cardsInHand).to.have.length(7);
      expect(red.pickedCorporationCard?.name).to.equal(CardName.PHOBOLOG);
    });
  });
});
