import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {
  applyDecision,
  DriverDecisionLimitError,
  EmbeddedDriverOptions,
  FallbackEvent,
  StuckGameError,
  UndoNotSupportedError,
  UnrecoverableIllegalMoveError,
  runGame,
} from '../../src/driver/embeddedDriver';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom} from '../../src/core/rng';
import {EmbeddedDecisionPoint} from '../../src/driver/decisionPoint';
import {stableState} from '../testUtils/stableState';
import {Phase} from '../../../src/common/Phase';
import {InputResponse} from '../../../src/common/inputs/InputResponse';
import {IGame} from '../../../src/server/IGame';
import {IPlayer} from '../../../src/server/IPlayer';
import {OrOptions} from '../../../src/server/inputs/OrOptions';
import {SelectOption} from '../../../src/server/inputs/SelectOption';
import {UndoActionOption} from '../../../src/server/inputs/UndoActionOption';

/**
 * `stubResponder` (the content-agnostic 'initialCards'/'card'-only stand-in built for Prompt 2,
 * before the legal-action enumerator existed) is retired as of this sub-task (Milestone 1,
 * sub-task E, item 3): `randomLegalAgent` now answers every in-scope decision, so driver tests
 * exercise the real agent instead of a stub that only understood two decision shapes. This also
 * makes these tests a better proof of the driver loop, since real games touch many more decision
 * types than the stub ever could.
 */
describe('runGame (embedded driver)', () => {
  it('drives simultaneous initial-card selection in generation order, then keeps advancing through many real decisions without hanging or reprocessing', () => {
    const game = createGame({players: 2, seed: 1});
    const [red, green] = game.playersInGenerationOrder;
    const agent = randomLegalAgent(createAgentRandom(1));
    const seen: Array<{playerId: string; type: string}> = [];

    const recordingResponder = (decision: EmbeddedDecisionPoint) => {
      seen.push({playerId: decision.player.id, type: decision.model.type});
      return agent(decision);
    };

    // Resolve both players' simultaneous starting decisions individually first, so we can check
    // the immediate result of each (composite 'initialCards' response correctly applied, not
    // just recorded) before anything else happens.
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

    // Now hand off to the full driver loop to prove it keeps advancing correctly well beyond
    // initial setup: a real game takes far more than 40 decisions to finish (Tier-1 batch, this
    // file's sibling `randomLegalAgent.integration.spec.ts`, sees generation counts alone in the
    // low tens with hundreds of decisions), so hitting `DriverDecisionLimitError` here - rather
    // than some other exception - is exactly the proof that the loop kept resolving decisions of
    // every kind (not just the two shapes `stubResponder` used to understand) without hanging or
    // reprocessing.
    expect(() => runGame(game, recordingResponder, {maxDecisions: 40})).to.throw(DriverDecisionLimitError);

    expect(seen.length).to.be.greaterThan(40, 'the driver kept going past the 2 simultaneous initial decisions');
    const typesSeen = new Set(seen.map((s) => s.type));
    expect(typesSeen.size, `expected a variety of decision types, saw only ${[...typesSeen]}`).to.be.greaterThan(2);
  });

  it('stops with DriverDecisionLimitError when maxDecisions is exceeded before the game ends', () => {
    const game = createGame({players: 2, seed: 1});
    const [red] = game.playersInGenerationOrder;
    const agent = randomLegalAgent(createAgentRandom(1));

    expect(() => runGame(game, agent, {maxDecisions: 1})).to.throw(DriverDecisionLimitError);

    // The one decision under the cap was actually processed (proves the guard fires on the
    // *next* decision, not by silently skipping the allowed one).
    expect(red.pickedCorporationCard).to.not.be.undefined;
  });

  it('throws StuckGameError if no player has a pending input and the game has not reached Phase.END', () => {
    const fakePlayer = {id: 'p-red', getWaitingFor: () => undefined} as unknown as IPlayer;
    const fakeGame = {
      id: 'g-fake',
      phase: Phase.ACTION,
      playersInGenerationOrder: [fakePlayer],
    } as unknown as IGame;

    const neverCalled = (): InputResponse => ({type: 'option'});
    expect(() => runGame(fakeGame, neverCalled)).to.throw(StuckGameError);
  });

  describe('the FR-9 conservative fallback (sub-task E, item 2 - and its item-4 widening)', () => {
    it('recovers when a responder throws instead of producing a move, resolving the decision via the conservative fallback and reporting it through onFallback', () => {
      const game = createGame({players: 2, seed: 1});
      const [red] = game.playersInGenerationOrder;

      // A responder that always fails to produce a move - the general shape of both couplings
      // this fallback recovers from (Running_Notes: the initial `card` over-selection, and the
      // `SelectStandardProjectToPlay` mismatch), reduced to the simplest possible reproduction so
      // this test only exercises the *mechanism*, not a specific coupling (which the Tier-1
      // integration spec covers with a real reproduction).
      const alwaysThrows = (): InputResponse => {
        throw new Error('this responder never produces a move');
      };

      const events: FallbackEvent[] = [];
      const options: EmbeddedDriverOptions = {onFallback: (e) => events.push(e)};

      expect(() => applyDecision(red, alwaysThrows, options)).to.not.throw();

      // The fallback actually resolved the real 'initialCards' decision: red picked a
      // corporation and two preludes (both sub-inputs have min===max), and - since the
      // conservative `card` handling selects `min` - zero project cards.
      expect(red.pickedCorporationCard, 'the fallback should have picked a corporation').to.not.be.undefined;
      expect(red.preludeCardsInHand).to.have.length(2);
      expect(red.cardsInHand).to.have.length(0);

      expect(events, 'onFallback should fire exactly once').to.have.length(1);
      expect(events[0].decision.model.type).to.equal('initialCards');
      expect(events[0].rejectedInput, 'the responder never produced an input to reject').to.be.undefined;
    });

    it('recovers when a responder produces a rejected move (the item-2 coupling shape: a well-formed but over-budget composite response)', () => {
      const game = createGame({players: 2, seed: 1});
      const [red] = game.playersInGenerationOrder;

      // SelectInitialCards.process() requires exactly one response per sub-option (corp,
      // prelude, project) and rejects anything else (src/server/inputs/SelectInitialCards.ts) -
      // a real illegal move from the Engine's own rules, not one invented for this test.
      const badResponder = (): InputResponse => ({type: 'initialCards', responses: []});

      const events: FallbackEvent[] = [];
      expect(() => applyDecision(red, badResponder, {onFallback: (e) => events.push(e)})).to.not.throw();

      expect(red.pickedCorporationCard, 'the fallback should have picked a corporation').to.not.be.undefined;
      expect(events).to.have.length(1);
      expect(events[0].rejectedInput).to.deep.equal({type: 'initialCards', responses: []});
    });

    it('tries every eligible branch of an `or` decision in order, not just the first, when an earlier branch is itself unresolvable', () => {
      // A hand-built 'or' with two branches: the first always rejects on process() (mirroring
      // the real SelectStandardProjectToPlay coupling's "looks fine, rejected at submission"
      // failure mode - Running_Notes), the second (a plain SelectOption "pass") always succeeds -
      // proving the fallback does not stop at the first branch and give up.
      const alwaysRejects = new SelectOption('first: always rejected on process()');
      (alwaysRejects as unknown as {process: () => never}).process = () => {
        throw new Error('first branch always rejects');
      };
      const pass = new SelectOption('second: pass, always legal');
      const raw = new OrOptions(alwaysRejects, pass);

      const game = createGame({players: 2, seed: 1});
      const [red] = game.playersInGenerationOrder;
      // Force the top-level decision to be exactly this hand-built 'or', bypassing the real
      // initialCards setup so the fallback's own branch-retry logic is what's under test, not
      // interactions with initial setup. `clearWaitingFor` first avoids `setWaitingFor`'s own
      // "Overwriting waitingFor" warning (Running_Notes) - deliberate here, not the bug it flags.
      red.clearWaitingFor();
      red.setWaitingFor(raw, () => {});

      const alwaysThrows = (): InputResponse => {
        throw new Error('responder cannot answer this decision');
      };

      const events: FallbackEvent[] = [];
      expect(() => applyDecision(red, alwaysThrows, {onFallback: (e) => events.push(e)})).to.not.throw();

      expect(events).to.have.length(1);
      expect(events[0].fallbackInput).to.deep.equal({type: 'or', index: 1, response: {type: 'option'}});
    });

    it('throws UnrecoverableIllegalMoveError when even the conservative fallback is rejected', () => {
      const game = createGame({players: 2, seed: 1});
      const [red] = game.playersInGenerationOrder;

      // A player whose process() rejects literally everything, including the fallback's own
      // trivially-legal 'option' response - constructed rather than reached organically, since
      // per this sub-task's own analysis the fallback is expected to always succeed for a real
      // in-scope decision (Running_Notes). This proves the "genuinely unrecoverable" path is
      // still surfaced rather than silently swallowed or retried forever.
      const rawInput = new SelectOption('Confirm');
      const fakePlayer = {
        id: red.id,
        game: game as IGame,
        getWaitingFor: () => rawInput,
        process: () => {
          throw new Error('this player rejects every move, including the conservative fallback');
        },
      } as unknown as IPlayer;

      const alwaysReturnsOption = (): InputResponse => ({type: 'option'});

      expect(() => applyDecision(fakePlayer, alwaysReturnsOption)).to.throw(UnrecoverableIllegalMoveError);
    });
  });

  it('wraps a responder that selects Undo in UndoNotSupportedError, since embedded/headless play has no save history to restore', () => {
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

  it('is reproducible under a fixed seed: two independently driven games reach byte-identical state after many real decisions', () => {
    const gameA = createGame({players: 2, seed: 5});
    const gameB = createGame({players: 2, seed: 5});

    // Drive both games the same bounded distance with the real random-legal agent (same engine
    // seed, same agent seed) - determinism of the driver loop itself (including the FR-9
    // fallback, which is a pure function of the decision, never of extra randomness) means two
    // such runs must land on exactly the same state, decision for decision.
    driveBounded(gameA, 60);
    driveBounded(gameB, 60);

    expect(stableState(gameA)).to.eq(stableState(gameB));
  });
});

function driveBounded(game: IGame, maxDecisions: number): void {
  const agent = randomLegalAgent(createAgentRandom(5));
  try {
    runGame(game, agent, {maxDecisions});
  } catch (e) {
    if (e instanceof DriverDecisionLimitError) {
      return;
    }
    throw e;
  }
}
