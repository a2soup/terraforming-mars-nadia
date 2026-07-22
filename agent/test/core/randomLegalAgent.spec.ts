import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {toDecisionPoint, EmbeddedDecisionPoint} from '../../src/driver/decisionPoint';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {NotYetImplementedDecisionError} from '../../src/core/enumerator';
import {createAgentRandom} from '../../src/core/rng';
import {SelectOption} from '../../../src/server/inputs/SelectOption';
import {PlayerInputModel} from '../../../src/common/models/PlayerInputModel';
import {IPlayer} from '../../../src/server/IPlayer';
import {IGame} from '../../../src/server/IGame';
import {PlayerInput} from '../../../src/server/PlayerInput';

function fakeDecision(type: PlayerInputModel['type']): EmbeddedDecisionPoint {
  return {
    player: {id: 'p-test'} as unknown as IPlayer,
    model: {type} as PlayerInputModel,
    game: {} as IGame,
    raw: {} as PlayerInput,
  };
}

describe('randomLegalAgent', () => {
  it('produces an Engine-accepted response for an option decision', () => {
    const game = createGame({players: 2, seed: 1});
    const [player] = game.playersInGenerationOrder;
    const input = new SelectOption('Confirm');
    const decision = toDecisionPoint(player, input);

    const agent = randomLegalAgent(createAgentRandom(0));
    const response = agent(decision);

    expect(response).to.deep.equal({type: 'option'});
    expect(() => input.process(response)).to.not.throw();
  });

  it('delegates to the enumerator - a not-yet-built in-scope type surfaces as NotYetImplementedDecisionError', () => {
    const agent = randomLegalAgent(createAgentRandom(0));
    expect(() => agent(fakeDecision('space'))).to.throw(NotYetImplementedDecisionError);
  });

  it('is a pure function of its rng seed - same seed yields the same choice', () => {
    const decision = (() => {
      const game = createGame({players: 2, seed: 1});
      const [player] = game.playersInGenerationOrder;
      return toDecisionPoint(player, new SelectOption('Confirm'));
    })();

    const first = randomLegalAgent(createAgentRandom(42))(decision);
    const second = randomLegalAgent(createAgentRandom(42))(decision);
    expect(first).to.deep.equal(second);
  });
});
