import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {toDecisionPoint, EmbeddedDecisionPoint} from '../../src/driver/decisionPoint';
import {enumerate, NotYetImplementedDecisionError, OutOfScopeDecisionError} from '../../src/core/enumerator';
import {createAgentRandom} from '../../src/core/rng';
import {SelectOption} from '../../../src/server/inputs/SelectOption';
import {PlayerInputModel} from '../../../src/common/models/PlayerInputModel';
import {IPlayer} from '../../../src/server/IPlayer';
import {IGame} from '../../../src/server/IGame';
import {PlayerInput} from '../../../src/server/PlayerInput';

// A decision point stripped to just what the dispatch reads (`model.type`, `player.id`).
// The classification/error paths never touch the player, game, or raw input, so faking them
// keeps these tests independent of which real Engine inputs happen to exist for each type.
function fakeDecision(type: PlayerInputModel['type']): EmbeddedDecisionPoint {
  return {
    player: {id: 'p-test'} as unknown as IPlayer,
    model: {type} as PlayerInputModel,
    game: {} as IGame,
    raw: {} as PlayerInput,
  };
}

const rng = createAgentRandom(0);

describe('enumerate (legal-action dispatch)', () => {
  it('answers an option decision with the sole legal response, which the real Engine accepts', () => {
    const game = createGame({players: 2, seed: 1});
    const [player] = game.playersInGenerationOrder;
    const input = new SelectOption('Confirm');
    const decision = toDecisionPoint(player, input);

    const response = enumerate(decision, rng);

    expect(response).to.deep.equal({type: 'option'});
    // The definition of "legal" is that the Engine's own process() accepts it.
    expect(() => input.process(response)).to.not.throw();
  });

  it('NotYetImplementedDecisionError carries the offending decision and names its type in the message', () => {
    // As of sub-task D (composite.ts), every in-scope §3.3 type has a registered enumerator (see
    // the next test), so this error is no longer reachable through `enumerate` for any real
    // decision type - it remains live only as a defensive fallback should the §3.3 scope ever
    // grow a type before its enumerator is built. Unit-test the error class directly rather than
    // trying to force it through a real (now nonexistent) unbuilt-in-scope-type path.
    const decision = fakeDecision('or');
    const error = new NotYetImplementedDecisionError(decision);
    expect(error.decision).to.equal(decision);
    expect(error.message).to.include('or');
  });

  it('throws OutOfScopeDecisionError for an out-of-scope expansion type', () => {
    expect(() => enumerate(fakeDecision('party'), rng)).to.throw(OutOfScopeDecisionError);
  });

  it('after sub-task D, every §3.3 in-scope type is registered (never falls back to NotYetImplementedDecisionError)', () => {
    // Sub-task B (simple.ts) filled in 'space', 'player', 'resource', 'amount', 'card'; sub-task C
    // (payment.ts) filled in 'payment', 'projectCard'; sub-task D (composite.ts) filled in the
    // rest - 'and', 'or', 'initialCards', 'productionToLose', 'resources' - completing the
    // dispatch table (enumerator/index.ts). 'option' (prompt A) is covered by the first test in
    // this file. No in-scope type remains unbuilt, so this file's job is now to confirm dispatch
    // *coverage* is complete, not to find a not-yet-built example.
    //
    // `fakeDecision`'s stub `raw`/`player` are enough to prove routing (the dispatch only reads
    // `model.type` before delegating) but not enough for every enumerator to run to completion -
    // several construct real objects from `raw` and will throw *some* error against a stub. That
    // is fine here: we only assert the dispatch didn't fall back to NotYetImplementedDecisionError
    // (i.e. the type is registered), which is the one thing this file - as opposed to
    // simple.spec.ts / payment.spec.ts / composite.spec.ts, which cover full per-type behavior
    // against real Engine inputs - is responsible for checking.
    const inScope: ReadonlyArray<PlayerInputModel['type']> = [
      'and', 'or', 'initialCards', 'projectCard', 'card', 'payment',
      'space', 'player', 'amount', 'productionToLose', 'resource', 'resources',
    ];
    for (const type of inScope) {
      expect(() => enumerate(fakeDecision(type), rng), type).to.not.throw(NotYetImplementedDecisionError);
    }
  });

  it('classifies every out-of-scope expansion type as out-of-scope', () => {
    const outOfScope: ReadonlyArray<PlayerInputModel['type']> = [
      'colony', 'delegate', 'party', 'globalEvent',
      'aresGlobalParameters', 'claimedUndergroundToken', 'deltaProject',
    ];
    for (const type of outOfScope) {
      expect(() => enumerate(fakeDecision(type), rng), type).to.throw(OutOfScopeDecisionError);
    }
  });
});
