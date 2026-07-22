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

  it('throws NotYetImplementedDecisionError for an in-scope type with no enumerator yet', () => {
    expect(() => enumerate(fakeDecision('amount'), rng)).to.throw(NotYetImplementedDecisionError);
  });

  it('throws OutOfScopeDecisionError for an out-of-scope expansion type', () => {
    expect(() => enumerate(fakeDecision('party'), rng)).to.throw(OutOfScopeDecisionError);
  });

  it('classifies every §3.3 in-scope type (other than the built option) as not-yet-implemented', () => {
    const inScopeUnbuilt: ReadonlyArray<PlayerInputModel['type']> = [
      'and', 'or', 'initialCards', 'projectCard', 'card', 'payment',
      'space', 'player', 'amount', 'productionToLose', 'resource', 'resources',
    ];
    for (const type of inScopeUnbuilt) {
      expect(() => enumerate(fakeDecision(type), rng), type).to.throw(NotYetImplementedDecisionError);
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
