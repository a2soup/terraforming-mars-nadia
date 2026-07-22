import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {
  applyDecision,
  DriverDecisionLimitError,
  IllegalMoveError,
  runGame,
  StuckGameError,
  UndoNotSupportedError,
} from '../../src/driver/embeddedDriver';
import {stubResponder, UnsupportedDecisionError} from '../../src/driver/stubResponder';
import {DecisionPoint} from '../../src/driver/decisionPoint';
import {stableState} from '../testUtils/stableState';
import {Phase} from '../../../src/common/Phase';
import {InputResponse} from '../../../src/common/inputs/InputResponse';
import {IGame} from '../../../src/server/IGame';
import {IPlayer} from '../../../src/server/IPlayer';
import {OrOptions} from '../../../src/server/inputs/OrOptions';
import {SelectOption} from '../../../src/server/inputs/SelectOption';
import {UndoActionOption} from '../../../src/server/inputs/UndoActionOption';

describe('runGame (embedded driver)', () => {
  it('drives simultaneous initial-card selection in generation order, then keeps advancing through real decisions without hanging or reprocessing', () => {
    const game = createGame({players: 2, seed: 1});
    const [red, green] = game.playersInGenerationOrder;
    const seen: Array<{playerId: string; type: string}> = [];

    // A recording wrapper around stubResponder (agent/src/driver/stubResponder.ts):
    // it only understands the 'initialCards' and 'card' decision shapes, so it
    // throws UnsupportedDecisionError as soon as the game asks for anything richer
    // (here, a prelude card's effect asking to place an ocean tile). That's expected
    // and fine for this test - the legal-action enumerator (Milestone 1, next bullet)
    // is what will make every decision type answerable. What this test verifies is
    // the driver loop itself: it must reach that point at all, resolving both
    // players' simultaneous starting decisions in generation order and then
    // continuing to surface each subsequent decision exactly once - proving
    // `player.process()` + `game.deferredActions.runAll()` (embeddedDriver.ts)
    // advances the game correctly without hanging or double-processing.
    const recordingResponder = (decision: DecisionPoint) => {
      seen.push({playerId: decision.player.id, type: decision.model.type});
      return stubResponder(decision);
    };

    // Resolve both players' simultaneous starting decisions individually first, so
    // we can check the immediate result of each (composite 'initialCards' response
    // correctly applied, not just recorded) before anything else happens - a prelude
    // played later in the same generation removes itself from preludeCardsInHand, so
    // that state can only be checked right after initial setup, not at the end.
    applyDecision(red, recordingResponder);
    expect(red.pickedCorporationCard, 'red should have a corporation').to.not.be.undefined;
    expect(red.preludeCardsInHand).to.have.length(2);

    applyDecision(green, recordingResponder);
    expect(green.pickedCorporationCard, 'green should have a corporation').to.not.be.undefined;
    expect(green.preludeCardsInHand).to.have.length(2);

    expect(seen).to.deep.eq([
      {playerId: red.id, type: 'initialCards'},
      {playerId: green.id, type: 'initialCards'},
    ]);
    expect(game.phase).to.eq(Phase.PRELUDES);

    // Now hand off to the full driver loop to prove it keeps advancing correctly
    // beyond a single decision: `player.process()` + `game.deferredActions.runAll()`
    // (embeddedDriver.ts) must resolve each subsequent real decision exactly once,
    // in the right order, without hanging or reprocessing, until it reaches
    // something the (deliberately minimal) stub can't answer.
    let caught: unknown;
    try {
      runGame(game, recordingResponder, {maxDecisions: 20});
    } catch (e) {
      caught = e;
    }

    expect(caught).to.be.instanceOf(UnsupportedDecisionError);
    const unsupported = caught as UnsupportedDecisionError;

    // The driver kept going past initial setup (several more real decisions were
    // surfaced) rather than stopping after the first two.
    expect(seen.length).to.be.greaterThan(2);

    // The last thing recorded is exactly the decision the responder failed on -
    // nothing was skipped or seen twice.
    const last = seen[seen.length - 1];
    expect(last).to.deep.eq({playerId: unsupported.decision.player.id, type: unsupported.decision.model.type});

    // The engine wasn't left in a half-applied state: since the responder throws
    // before embeddedDriver.applyDecision ever calls player.process(), the pending
    // input the driver couldn't answer is still there, unchanged.
    expect(unsupported.decision.player.getWaitingFor()).to.not.be.undefined;
  });

  it('stops with DriverDecisionLimitError when maxDecisions is exceeded before the game ends', () => {
    const game = createGame({players: 2, seed: 1});
    const [red] = game.playersInGenerationOrder;

    expect(() => runGame(game, stubResponder, {maxDecisions: 1})).to.throw(DriverDecisionLimitError);

    // The one decision under the cap was actually processed (proves the guard fires
    // on the *next* decision, not by silently skipping the allowed one).
    expect(red.pickedCorporationCard).to.not.be.undefined;
  });

  it('throws StuckGameError if no player has a pending input and the game has not reached Phase.END', () => {
    const fakePlayer = {id: 'p-red', getWaitingFor: () => undefined} as unknown as IPlayer;
    const fakeGame = {
      id: 'g-fake',
      phase: Phase.ACTION,
      playersInGenerationOrder: [fakePlayer],
    } as unknown as IGame;

    expect(() => runGame(fakeGame, stubResponder)).to.throw(StuckGameError);
  });

  it('wraps a rejected InputResponse in IllegalMoveError and leaves the pending decision unchanged', () => {
    const game = createGame({players: 2, seed: 1});
    const [red] = game.playersInGenerationOrder;

    // SelectInitialCards.process() requires exactly one response per sub-option
    // (corp, prelude, project) and rejects anything else (src/server/inputs/
    // SelectInitialCards.ts) - a real illegal move from the Engine's own rules,
    // not one invented for this test.
    const badResponder = (): InputResponse => ({type: 'initialCards', responses: []});

    expect(() => applyDecision(red, badResponder)).to.throw(IllegalMoveError);
    expect(red.pickedCorporationCard, 'nothing should have been applied').to.be.undefined;
    expect(red.getWaitingFor(), 'the pending decision should still be there, unchanged').to.not.be.undefined;
  });

  it('rejects a response that selects Undo, since embedded/headless play has no save history to restore', () => {
    const pass = new SelectOption('Pass', 'Pass');
    const undo = new UndoActionOption();
    const waitingFor = new OrOptions(pass, undo);
    const undoIndex = waitingFor.options.indexOf(undo);

    const fakePlayerWithUndo = {
      id: 'p-red',
      game: {} as IGame,
      getWaitingFor: () => waitingFor,
    } as unknown as IPlayer;

    const chooseUndo = (): InputResponse => ({type: 'or', index: undoIndex, response: {type: 'option'}});

    expect(() => applyDecision(fakePlayerWithUndo, chooseUndo)).to.throw(UndoNotSupportedError);
  });

  it('is reproducible under a fixed seed: two independently driven games reach byte-identical state', () => {
    const gameA = createGame({players: 2, seed: 5});
    const gameB = createGame({players: 2, seed: 5});

    // Drive both games with the same deterministic (if minimal) responder until it
    // hits a decision it can't answer - see the first test in this file for why full
    // completion isn't in reach yet. What matters for determinism is that the driver
    // itself introduces no randomness: two same-seed games driven the same way must
    // end up in exactly the same state.
    driveUntilUnsupported(gameA);
    driveUntilUnsupported(gameB);

    expect(stableState(gameA)).to.eq(stableState(gameB));
  });
});

function driveUntilUnsupported(game: IGame): UnsupportedDecisionError {
  try {
    runGame(game, stubResponder, {maxDecisions: 20});
  } catch (e) {
    if (e instanceof UnsupportedDecisionError) {
      return e;
    }
    throw e;
  }
  throw new Error('expected stubResponder to hit an unsupported decision type before Phase.END');
}
