import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom} from '../../src/core/rng';
import {applyDecision} from '../../src/driver/embeddedDriver';
import {EmbeddedResponder} from '../../src/driver/responder';
import {
  GameSnapshot,
  SnapshotFidelityError,
  UnsafeSnapshotError,
  assertSnapshotSafe,
  cloneGame,
  pendingSignature,
  restore,
  snapshot,
} from '../../src/engine/snapshot';
import {stableState, stableStateOf} from '../../src/engine/stableState';
import {Phase} from '../../../src/common/Phase';
import {IGame} from '../../../src/server/IGame';
import {LogMessage} from '../../../src/common/logs/LogMessage';

/**
 * Milestone 1, sub-task A: unit tests for the snapshot/restore module against real games
 * driven a few decisions deep with `randomLegalAgent` - see agent/docs/Milestone1_Bullet4_Prompts.md
 * and the 2026-07-22 Running Notes entry "Snapshot/restore fidelity is not universal" for the
 * design basis these tests are written against.
 *
 * `driveUntil`/`driveToQuiescentAction`/`driveToLaterResearchPhase` drive a real game with the
 * real agent + driver (not a fake `IGame`) until a phase/queue predicate holds, rather than a
 * hardcoded decision count - the exact decision index a given phase/queue state falls on is an
 * artifact of the enumerator's own choices, not something these tests should depend on.
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

/** A quiescent top-of-turn action decision: `assertSnapshotSafe`'s intended, common-case "safe" point. */
function driveToQuiescentAction(game: IGame, agent: EmbeddedResponder): void {
  driveUntil(game, agent, (g) => g.phase === Phase.ACTION && g.deferredActions.length === 0);
}

/**
 * A research phase *after* the game's initial one (every fresh game already starts in
 * `Phase.RESEARCH` via `gotoInitialResearchPhase` - see the `pendingSignature` test below, which
 * uses exactly that). Driving to a *later* research phase proves the guard fires on research in
 * general, not merely on the state a freshly-constructed game happens to start in.
 */
function driveToLaterResearchPhase(game: IGame, agent: EmbeddedResponder): void {
  driveUntil(game, agent, (g) => g.phase === Phase.RESEARCH && g.generation > 1);
}

function newDrivenGame(seed: number, agentSeed: number): {game: IGame; agent: EmbeddedResponder} {
  const game = createGame({players: 2, seed});
  const agent = randomLegalAgent(createAgentRandom(agentSeed));
  return {game, agent};
}

describe('pendingSignature', () => {
  it('is stable across two same-seed games and reflects every player\'s simultaneous pending input', () => {
    // The initial-research phase (`gotoInitialResearchPhase`, Game.ts) sets `waitingFor` on
    // every player at once, before any decision is ever applied - an easy, real multi-player
    // signature to assert against (Milestone1_Bullet4_Prompts.md, sub-task A section 4).
    const gameA = createGame({players: 2, seed: 4242});
    const gameB = createGame({players: 2, seed: 4242});
    expect(gameA.phase).to.equal(Phase.RESEARCH);

    const [red, green] = gameA.playersInGenerationOrder;
    expect(pendingSignature(gameA)).to.equal(`${red.id}:initialCards,${green.id}:initialCards`);
    expect(pendingSignature(gameA)).to.equal(pendingSignature(gameB));
  });
});

describe('assertSnapshotSafe', () => {
  it('throws for a game driven into Phase.RESEARCH', () => {
    const {game, agent} = newDrivenGame(4242, 5);
    driveToLaterResearchPhase(game, agent);

    expect(() => assertSnapshotSafe(game)).to.throw(UnsafeSnapshotError);
  });

  it('does not throw at a top-of-turn action decision', () => {
    const {game, agent} = newDrivenGame(4242, 5);
    driveToQuiescentAction(game, agent);

    expect(game.deferredActions.length).to.equal(0);
    expect(() => assertSnapshotSafe(game)).to.not.throw();
  });
});

describe('snapshot', () => {
  it('does not mutate the source game', () => {
    const {game, agent} = newDrivenGame(4242, 5);
    driveToQuiescentAction(game, agent);

    const before = stableState(game);
    snapshot(game);
    expect(stableState(game)).to.equal(before);
  });

  it('does not leave the restored clone aliasing the source game\'s gameLog or gameOptions (Engine fact 3)', () => {
    const {game, agent} = newDrivenGame(4242, 5);
    driveToQuiescentAction(game, agent);

    const snap = snapshot(game);
    const restored = restore(snap);

    expect(restored.gameOptions, 'gameOptions must not be the same object as the original\'s').to.not.equal(game.gameOptions);

    const originalLogLength = game.gameLog.length;
    restored.gameLog.push({} as LogMessage);
    expect(game.gameLog.length, 'appending to the restored clone\'s gameLog must not affect the original\'s').to.equal(originalLogLength);
  });
});

describe('restore', () => {
  it('produces 3 independent games from one snapshot, and leaves snap.state byte-identical before and after those restores', () => {
    const {game, agent} = newDrivenGame(4242, 5);
    driveToQuiescentAction(game, agent);

    const snap = snapshot(game);
    const stateBefore = JSON.stringify(snap.state);

    const clones = [restore(snap), restore(snap), restore(snap)];

    expect(
      JSON.stringify(snap.state),
      'restoring 3 times must not mutate the snapshot (Engine fact 3: deserialize consumes its argument, so restore must deep-copy again)',
    ).to.equal(stateBefore);

    expect(clones[0]).to.not.equal(clones[1]);
    expect(clones[1]).to.not.equal(clones[2]);
    expect(pendingSignature(clones[0])).to.equal(pendingSignature(clones[1]));

    const [a, b, c] = clones;
    const bLogLength = b.gameLog.length;
    a.gameLog.push({} as LogMessage);
    expect(b.gameLog.length, 'independent clones must not share a gameLog').to.equal(bLogLength);
    expect(c.gameLog.length, 'independent clones must not share a gameLog').to.equal(bLogLength);
  });

  it('throws SnapshotFidelityError when the snapshot\'s pending signature does not match the restored game\'s', () => {
    const {game, agent} = newDrivenGame(4242, 5);
    driveToQuiescentAction(game, agent);

    const snap = snapshot(game);
    const corrupted: GameSnapshot = {...snap, pending: `${snap.pending}-corrupted`};

    expect(() => restore(corrupted)).to.throw(SnapshotFidelityError);
  });

  it('produces a game whose gameLog is empty when stripLog was set, matching the unstripped snapshot under an ignoreLog comparison', () => {
    const {game, agent} = newDrivenGame(4242, 5);
    driveToQuiescentAction(game, agent);

    const unstripped = snapshot(game);
    const stripped = snapshot(game, {stripLog: true});

    const restoredStripped = restore(stripped);
    expect(restoredStripped.gameLog).to.have.length(0);

    expect(stableStateOf(stripped.state, {ignoreLog: true})).to.equal(stableStateOf(unstripped.state, {ignoreLog: true}));
  });
});

describe('cloneGame', () => {
  it('is snapshot + restore in one call: the clone is independent and driving it does not touch the original', () => {
    const {game, agent} = newDrivenGame(4242, 5);
    driveToQuiescentAction(game, agent);

    const before = stableState(game);
    const clone = cloneGame(game);

    expect(clone).to.not.equal(game);
    expect(pendingSignature(clone)).to.equal(pendingSignature(game));

    driveUntil(clone, agent, (g) => g.phase === Phase.END, 5000);
    expect(stableState(game), 'driving the clone to completion must not advance the original').to.equal(before);
  });
});
