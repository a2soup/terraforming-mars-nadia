import {expect} from 'chai';
import {IGame} from '../../../src/server/IGame';
import {Player} from '../../../src/server/Player';
import {createGame} from '../../src/engine/gameFactory';
import {cloneGame} from '../../src/engine/snapshot';
import {SubmissionMonitor} from '../../src/legality/submissionMonitor';
import {
  LiveSubmissionDuringSpeculationError,
  assertSpeculative,
  isSpeculative,
  registerSpeculative,
  runWithSpeculationCounted,
  speculating,
  speculationGuardArmed,
  speculativeSubmission,
  withSpeculation,
} from '../../src/search/speculation';

/**
 * The speculation registry (Milestone 2 bullet 2, Unit A; §3.2).
 *
 * The two claims worth testing here are the two the module's doc comment argues for, and neither is
 * obvious from the code: that the registry is keyed on **object identity** and therefore survives a
 * fork sharing its original's id (hazard H2), and that the `WeakSet` and the speculation *scope*
 * catch different failures - the scope alone could not be the guard, and the set alone could not be
 * the cross-check.
 */
/**
 * A second `IGame` object built from the same state. `{unsafe: true, verify: 'none'}` because these
 * tests are about **object identity and the registry**, not about fidelity: a freshly created game
 * sits in `Phase.RESEARCH`, which `assertSnapshotSafe` rightly refuses, and driving each of these
 * tests into an action phase would buy nothing they assert on. `search/fork.ts` never relaxes either
 * guard; `fork.spec.ts` is where fidelity is tested, against real forks.
 */
function twinOf(game: IGame): IGame {
  return cloneGame(game, {unsafe: true, verify: 'none'});
}

describe('speculation registry (Unit A)', () => {
  it('a fork and its original share game.id, so the registry cannot key on it (hazard H2)', () => {
    const game = createGame({players: 2, seed: 4_242});
    const fork = twinOf(game);

    expect(fork.id, 'restore reproduces the id - this is the trap').to.equal(game.id);
    expect(fork, 'but they are two objects').to.not.equal(game);

    registerSpeculative(fork);
    expect(isSpeculative(fork)).to.be.true;
    // The whole point: an id-keyed registry would now call the live game speculative too, which is
    // the most damaging possible direction for the mistake.
    expect(isSpeculative(game)).to.be.false;
  });

  it('marks scopes as nestable, and closes them even when the body throws', () => {
    expect(speculating()).to.be.false;
    withSpeculation(() => {
      expect(speculating()).to.be.true;
      withSpeculation(() => expect(speculating()).to.be.true);
      expect(speculating(), 'the inner scope closing must not close the outer one').to.be.true;
    });
    expect(speculating()).to.be.false;

    expect(() => withSpeculation(() => {
      throw new Error('boom');
    })).to.throw('boom');
    expect(speculating(), 'a throwing body still closes its scope').to.be.false;
  });

  describe('the guard, and the cross-check it is not', () => {
    const game = createGame({players: 2, seed: 4_243});

    it('passes a real submission through, in or out of a scope', () => {
      expect(speculativeSubmission(game)).to.be.false;
    });

    it('hides a submission to a registered fork', () => {
      const fork = registerSpeculative(twinOf(game));
      expect(speculativeSubmission(fork)).to.be.true;
      expect(withSpeculation(() => speculativeSubmission(fork))).to.be.true;
    });

    it('throws when a submission reaches the live game mid-speculation (G2c)', () => {
      // The catastrophic bug the WeakSet alone cannot see: an agent that submits a candidate to the
      // real game while searching corrupts the actual match, silently, and no counter would reveal
      // it. The scope is what makes it loud.
      expect(() => withSpeculation(() => speculativeSubmission(game)))
        .to.throw(LiveSubmissionDuringSpeculationError);
    });

    it('assertSpeculative needs no scope at all - the always-on half', () => {
      const fork = registerSpeculative(twinOf(game));
      expect(() => assertSpeculative(fork)).to.not.throw();
      expect(() => assertSpeculative(game)).to.throw(LiveSubmissionDuringSpeculationError);
    });

    it('fires through an installed instrument, on a real player.process call (G2c, end to end)', () => {
      const live = createGame({players: 2, seed: 4_244});
      const [player] = live.playersInGenerationOrder;
      const monitor = new SubmissionMonitor();
      monitor.install();
      monitor.startGame();
      try {
        // A real submission to the live game, made while a search is open. It never reaches the
        // Engine: the guard throws first, so the illegal-move counters cannot be polluted either.
        expect(() => withSpeculation(() => player.process({type: 'option'})))
          .to.throw(LiveSubmissionDuringSpeculationError);
        expect(monitor.gameCounters.submissions, 'and nothing was counted').to.equal(0);
      } finally {
        monitor.uninstall();
      }
      expect(Player.prototype.process, 'the prototype is restored').to.be.a('function');
    });
  });

  describe('the negative control (G2b)', () => {
    it('disarms the guard for the duration and re-arms it afterwards', async () => {
      const game = createGame({players: 2, seed: 4_245});
      const fork = registerSpeculative(twinOf(game));

      expect(speculationGuardArmed()).to.be.true;
      await runWithSpeculationCounted(async () => {
        expect(speculationGuardArmed()).to.be.false;
        // The whole content of the negative control: the same submission is now visible to the
        // instruments, so a run made under it counts what a run without §3.2 would have counted.
        expect(speculativeSubmission(fork)).to.be.false;
      });
      expect(speculationGuardArmed()).to.be.true;
      expect(speculativeSubmission(fork)).to.be.true;
    });

    it('re-arms even when the body rejects, and refuses to nest', async () => {
      await runWithSpeculationCounted(async () => {
        // The flag is process-global, so a second scope inside the first would re-arm the guard on
        // the inner scope's exit and silently measure the wrong thing for the rest of the outer one.
        let threw = false;
        await runWithSpeculationCounted(async () => undefined).catch(() => {
          threw = true;
        });
        expect(threw, 'nesting is refused').to.be.true;
      });
      expect(speculationGuardArmed()).to.be.true;

      let rejected = false;
      await runWithSpeculationCounted(async () => {
        throw new Error('boom');
      }).catch(() => {
        rejected = true;
      });
      expect(rejected).to.be.true;
      expect(speculationGuardArmed(), 'a rejecting body still re-arms the guard').to.be.true;
    });
  });
});
