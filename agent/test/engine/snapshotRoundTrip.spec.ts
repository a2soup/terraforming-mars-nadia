import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom} from '../../src/core/rng';
import {applyDecision, runGame} from '../../src/driver/embeddedDriver';
import {EmbeddedResponder} from '../../src/driver/responder';
import {
  SnapshotFidelityError,
  cloneGame,
  pendingSignature,
  restore,
  snapshot,
} from '../../src/engine/snapshot';
import {stableState} from '../../src/engine/stableState';
import {Phase} from '../../../src/common/Phase';
import {IGame} from '../../../src/server/IGame';

/**
 * Milestone 1, sub-task C: round-trip & independence - the test the bullet exists to make
 * possible (see agent/docs/Milestone1_Bullet4_Prompts.md, sub-task C, and the 2026-07-22 Running
 * Notes entry "Snapshot/restore fidelity is not universal" for the design basis). Only available
 * now that sub-task E landed a responder that can actually finish games.
 *
 * **What this proves that snapshot.spec.ts (sub-task A) does not:** A's own tests check the
 * module's unit-level contracts (no mutation, no aliasing, verification fires). This file drives
 * a cloned game *to completion* and shows the clone is a genuinely independent, faithful copy of
 * the original - the actual property search/self-play needs: fork one node, run N simulations
 * from it, without the simulations affecting each other or the original.
 */

function nextWaitingPlayer(game: IGame) {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

function driveUntil(game: IGame, agent: EmbeddedResponder, predicate: (game: IGame) => boolean, maxDecisions = 250): void {
  let decisions = 0;
  while (!predicate(game)) {
    if (game.phase === Phase.END) {
      throw new Error('driveUntil: reached Phase.END without satisfying the predicate');
    }
    const player = nextWaitingPlayer(game);
    if (player === undefined) {
      throw new Error(`driveUntil: no player has a pending input (phase=${game.phase})`);
    }
    if (decisions++ >= maxDecisions) {
      throw new Error(`driveUntil: predicate not satisfied within ${maxDecisions} decisions`);
    }
    applyDecision(player, agent);
  }
}

/** A quiescent mid-game action decision - safe to snapshot, and past the opening generation. */
function driveToQuiescentMidGameAction(game: IGame, agent: EmbeddedResponder): void {
  driveUntil(game, agent, (g) => g.phase === Phase.ACTION && g.generation > 1 && g.deferredActions.length === 0);
}

describe('snapshot/restore round-trip & independence (Milestone 1, sub-task C)', function() {
  this.timeout(30_000);

  describe('identical playout', () => {
    it('drives a clone of a mid-game snapshot and the original to Phase.END with separately-constructed same-seed agents and gets identical GameResult and stableState', () => {
      const game = createGame({players: 2, seed: 4242});
      const setupAgent = randomLegalAgent(createAgentRandom(5));
      driveToQuiescentMidGameAction(game, setupAgent);

      const clone = cloneGame(game);

      // Separately constructed agent instances on the same seed, one per game - sharing a
      // single agent instance across both drives would have the two runs consuming one RNG
      // stream (interleaved draws), which would prove nothing about the clone's independence.
      const originalResult = runGame(game, randomLegalAgent(createAgentRandom(77)));
      const cloneResult = runGame(clone, randomLegalAgent(createAgentRandom(77)));

      expect(cloneResult).to.deep.equal(originalResult);
      expect(stableState(clone)).to.equal(stableState(game));
    });
  });

  describe('negative controls', () => {
    it('two clones of the same snapshot, driven with different agent seeds, produce different results', () => {
      const game = createGame({players: 2, seed: 4242});
      const setupAgent = randomLegalAgent(createAgentRandom(5));
      driveToQuiescentMidGameAction(game, setupAgent);

      const snap = snapshot(game);
      const cloneA = restore(snap);
      const cloneB = restore(snap);

      const resultA = runGame(cloneA, randomLegalAgent(createAgentRandom(1)));
      const resultB = runGame(cloneB, randomLegalAgent(createAgentRandom(2)));

      expect(stableState(cloneA)).to.not.equal(stableState(cloneB));
      void resultA;
      void resultB;
    });

    it('driving a clone to completion leaves the snapshot object unchanged, so one snapshot is reusable for N simulations', () => {
      const game = createGame({players: 2, seed: 4242});
      const setupAgent = randomLegalAgent(createAgentRandom(5));
      driveToQuiescentMidGameAction(game, setupAgent);

      const snap = snapshot(game);
      const stateBefore = JSON.stringify(snap.state);

      const clone = restore(snap);
      runGame(clone, randomLegalAgent(createAgentRandom(99)));

      expect(JSON.stringify(snap.state), 'driving a restored clone to Phase.END must not mutate the snapshot it was restored from').to.equal(stateBefore);

      // The snapshot really is reusable: restoring it again after the first clone finished still
      // produces a fresh, independent game at the original mid-game point.
      const secondClone = restore(snap);
      expect(secondClone.phase).to.not.equal(Phase.END);
      expect(pendingSignature(secondClone)).to.equal(snap.pending);
    });

    it('driving a clone does not advance the original game at all', () => {
      const game = createGame({players: 2, seed: 4242});
      const setupAgent = randomLegalAgent(createAgentRandom(5));
      driveToQuiescentMidGameAction(game, setupAgent);

      const before = stableState(game);
      const clone = cloneGame(game);

      runGame(clone, randomLegalAgent(createAgentRandom(123)));

      expect(clone.phase).to.equal(Phase.END);
      expect(stableState(game), 'driving the clone to completion must not advance the original - the search-correctness property this bullet exists for').to.equal(before);
    });
  });

  describe('restore at an unsafe point is loud, not silent', () => {
    it('throws SnapshotFidelityError instead of returning a plausible-looking wrong game, at the first mid-action sub-decision found (e.g. a pending space from a tile placement)', () => {
      const game = createGame({players: 2, seed: 4242});
      const agent = randomLegalAgent(createAgentRandom(5));

      // Locate the first point, generically, where an unsafe snapshot+restore silently produces
      // a different pending decision than the live game actually has - exactly the class of
      // failure the default `verify: 'pending'` exists to catch loudly instead.
      let decisions = 0;
      const maxDecisions = 250;
      let found = false;
      while (!found) {
        if (game.phase === Phase.END) {
          throw new Error('drove to Phase.END without finding a mid-action sub-decision whose unsafe restore mismatches the live pending signature');
        }
        const player = nextWaitingPlayer(game);
        if (player === undefined) {
          throw new Error(`no player has a pending input (phase=${game.phase})`);
        }
        if (decisions++ >= maxDecisions) {
          throw new Error(`no mismatching mid-action sub-decision found within ${maxDecisions} decisions`);
        }
        applyDecision(player, agent);

        // If that decision ended the game, the top-of-loop check above will throw with a
        // clearer message on the next iteration; computing signatures on a finished game (no
        // player has a pending input, so both sides are the empty string) is harmless either way.
        const livePending = pendingSignature(game);
        const probe = snapshot(game, {unsafe: true});
        const restoredProbe = restore(probe, {verify: 'none'});
        if (pendingSignature(restoredProbe) !== livePending) {
          found = true;
        }
      }

      // `game` is now sitting exactly at the mismatching decision point found above. A real
      // snapshot+restore here (default verification) must throw rather than silently hand back a
      // game with a different, plausible-looking pending decision.
      const snap = snapshot(game, {unsafe: true});
      expect(() => restore(snap)).to.throw(SnapshotFidelityError);
    });
  });
});
