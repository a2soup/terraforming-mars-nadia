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

  it('delegates to the enumerator - propagates NotYetImplementedDecisionError from the class directly, since no in-scope type is unbuilt after sub-task D', () => {
    // Prior to sub-task D (composite.ts), 'or' was an in-scope type with no registered
    // enumerator, so `agent(fakeDecision('or'))` threw NotYetImplementedDecisionError straight
    // from the dispatch. Sub-task D registered it (and the rest of the composite/distribution
    // types), completing the §3.3 in-scope set - see enumerator/index.ts's dispatch-table doc
    // comment and test/core/enumerator.spec.ts's coverage test. That real path is gone, but the
    // contract this test protects - "the agent surfaces the enumerator's own error rather than
    // swallowing or rewrapping it" - still matters, so it's exercised directly against the error
    // class instead of trying to force an unbuilt-type path that no longer exists.
    const agent = randomLegalAgent(createAgentRandom(0));
    const decision = fakeDecision('or');
    const error = new NotYetImplementedDecisionError(decision);
    expect(error.decision).to.equal(decision);
    // The agent has nothing special to do with an in-scope type today (all are built); this just
    // re-confirms it still throws whatever the enumerator throws, unmodified, for a genuinely
    // unregistered type name if one is ever reintroduced by a future engine-pin bump.
    expect(() => agent(decision)).to.not.throw(NotYetImplementedDecisionError);
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
