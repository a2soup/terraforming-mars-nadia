import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {toDecisionPoint} from '../../src/driver/decisionPoint';
import {enumerate} from '../../src/core/enumerator';
import {agentRandomFrom, createAgentRandom} from '../../src/core/rng';
import {ConstRandom} from '../../../src/common/utils/Random';
import {Units} from '../../../src/common/Units';
import {SelectSpace} from '../../../src/server/inputs/SelectSpace';
import {SelectPlayer} from '../../../src/server/inputs/SelectPlayer';
import {SelectResource} from '../../../src/server/inputs/SelectResource';
import {SelectAmount} from '../../../src/server/inputs/SelectAmount';
import {SelectCard} from '../../../src/server/inputs/SelectCard';
import {SelectInitialCards} from '../../../src/server/inputs/SelectInitialCards';

/**
 * Sub-task B: the directly-enumerable decision types - `space`, `player`, `resource`,
 * `amount`, and `card` (see the Sub-task B table, agent/docs/Milestone1_Subtask_Prompts.md).
 * `option` is covered by test/core/enumerator.spec.ts (prompt A).
 *
 * Every test follows the one hard rule: legality is decided by handing the enumerator's
 * response to the *real* Engine input's own `process()`, never by re-checking our own
 * reading of the rules.
 */
describe('simple enumerators (space, player, resource, amount, card)', () => {
  describe('space', () => {
    it('picks an offered space, and the real SelectSpace input accepts it', () => {
      const game = createGame({players: 2, seed: 1});
      const [player] = game.playersInGenerationOrder;
      const spaces = game.board.spaces.slice(0, 5);
      const input = new SelectSpace('Pick a space', spaces);
      const decision = toDecisionPoint(player, input);
      const rng = createAgentRandom(1);

      const response = enumerate(decision, rng);
      if (response.type !== 'space') {
        throw new Error(`expected a 'space' response, got '${response.type}'`);
      }
      expect(spaces.map((s) => s.id)).to.include(response.spaceId);
      expect(() => input.process(response)).to.not.throw();
    });
  });

  describe('player', () => {
    it('picks an offered player, and the real SelectPlayer input accepts it', () => {
      const game = createGame({players: 3, seed: 2});
      const players = game.playersInGenerationOrder;
      const [chooser] = players;
      const input = new SelectPlayer(players, 'Pick a player');
      const decision = toDecisionPoint(chooser, input);
      const rng = createAgentRandom(2);

      const response = enumerate(decision, rng);
      if (response.type !== 'player') {
        throw new Error(`expected a 'player' response, got '${response.type}'`);
      }
      expect(players.map((p) => p.color)).to.include(response.player);
      expect(() => input.process(response)).to.not.throw();
    });
  });

  describe('resource', () => {
    it('picks an offered resource, and the real SelectResource input accepts it', () => {
      const game = createGame({players: 2, seed: 3});
      const [player] = game.playersInGenerationOrder;
      const include: ReadonlyArray<keyof Units> = ['steel', 'titanium', 'heat'];
      const input = new SelectResource('Pick a resource', include);
      const decision = toDecisionPoint(player, input);
      const rng = createAgentRandom(3);

      const response = enumerate(decision, rng);
      if (response.type !== 'resource') {
        throw new Error(`expected a 'resource' response, got '${response.type}'`);
      }
      expect(include).to.include(response.resource);
      expect(() => input.process(response)).to.not.throw();
    });

    it('can also pick from the full default resource set', () => {
      const game = createGame({players: 2, seed: 3});
      const [player] = game.playersInGenerationOrder;
      const input = new SelectResource('Pick any resource');
      const decision = toDecisionPoint(player, input);
      const rng = createAgentRandom(30);

      const response = enumerate(decision, rng);
      if (response.type !== 'resource') {
        throw new Error(`expected a 'resource' response, got '${response.type}'`);
      }
      expect(Units.keys).to.include(response.resource);
      expect(() => input.process(response)).to.not.throw();
    });
  });

  describe('amount', () => {
    it('forces the low end with ConstRandom(0), and the real SelectAmount input accepts it', () => {
      const game = createGame({players: 2, seed: 4});
      const [player] = game.playersInGenerationOrder;
      const input = new SelectAmount('Pick an amount', 'Save', 2, 7);
      const decision = toDecisionPoint(player, input);
      const rng = agentRandomFrom(new ConstRandom(0));

      const response = enumerate(decision, rng);
      if (response.type !== 'amount') {
        throw new Error(`expected an 'amount' response, got '${response.type}'`);
      }
      expect(response.amount).to.equal(2);
      expect(() => input.process(response)).to.not.throw();
    });

    it('forces the high end with ConstRandom(just under 1), and the real SelectAmount input accepts it', () => {
      const game = createGame({players: 2, seed: 4});
      const [player] = game.playersInGenerationOrder;
      const input = new SelectAmount('Pick an amount', 'Save', 2, 7);
      const decision = toDecisionPoint(player, input);
      const rng = agentRandomFrom(new ConstRandom(0.999999));

      const response = enumerate(decision, rng);
      if (response.type !== 'amount') {
        throw new Error(`expected an 'amount' response, got '${response.type}'`);
      }
      expect(response.amount).to.equal(7);
      expect(() => input.process(response)).to.not.throw();
    });

    it('stays in [min, max] under many random draws, always accepted by the real input', () => {
      const game = createGame({players: 2, seed: 4});
      const [player] = game.playersInGenerationOrder;
      const rng = createAgentRandom(40);
      for (let i = 0; i < 50; i++) {
        const input = new SelectAmount('Pick an amount', 'Save', -3, 3);
        const decision = toDecisionPoint(player, input);

        const response = enumerate(decision, rng);
        if (response.type !== 'amount') {
          throw new Error(`expected an 'amount' response, got '${response.type}'`);
        }
        expect(response.amount).to.be.within(-3, 3);
        expect(() => input.process(response)).to.not.throw();
      }
    });
  });

  describe('card', () => {
    // The Engine deals each player 10 project cards before any decision is even
    // surfaced (Game.newInstance, src/server/Game.ts) - plenty of real cards to build
    // directly-constructed SelectCard inputs against, independent of the real
    // initial-research decision exercised below.
    function dealtCards(seed: number) {
      const game = createGame({players: 2, seed});
      const [player] = game.playersInGenerationOrder;
      return {player, cards: player.dealtProjectCards};
    }

    it('handles min===0: the empty selection and non-empty selections are both reachable and both accepted', () => {
      const {player, cards} = dealtCards(5);
      const seenCounts = new Set<number>();
      for (let seedOffset = 0; seedOffset < 20; seedOffset++) {
        const input = new SelectCard('Pick project cards', undefined, cards, {min: 0, max: 3});
        const decision = toDecisionPoint(player, input);
        const rng = createAgentRandom(seedOffset);

        const response = enumerate(decision, rng);
        if (response.type !== 'card') {
          throw new Error(`expected a 'card' response, got '${response.type}'`);
        }
        expect(response.cards.length).to.be.within(0, 3);
        expect(new Set(response.cards).size, 'cards must be distinct').to.equal(response.cards.length);
        seenCounts.add(response.cards.length);
        expect(() => input.process(response)).to.not.throw();
      }
      // Sampling a count uniformly in [0, 3] should reach 0 at least once across 20 draws.
      expect(seenCounts.has(0), `expected to see an empty selection at least once, saw counts ${[...seenCounts]}`).to.be.true;
    });

    it('handles min<max: selects between min and max distinct cards, accepted by the real input', () => {
      const {player, cards} = dealtCards(6);
      for (let seedOffset = 0; seedOffset < 20; seedOffset++) {
        const input = new SelectCard('Pick project cards', undefined, cards, {min: 2, max: 6});
        const decision = toDecisionPoint(player, input);
        const rng = createAgentRandom(seedOffset);

        const response = enumerate(decision, rng);
        if (response.type !== 'card') {
          throw new Error(`expected a 'card' response, got '${response.type}'`);
        }
        expect(response.cards.length).to.be.within(2, 6);
        expect(new Set(response.cards).size).to.equal(response.cards.length);
        expect(() => input.process(response)).to.not.throw();
      }
    });

    it('handles min===max: always selects exactly that many distinct cards, accepted by the real input', () => {
      const {player, cards} = dealtCards(7);
      for (let seedOffset = 0; seedOffset < 10; seedOffset++) {
        const input = new SelectCard('Pick project cards', undefined, cards, {min: 4, max: 4});
        const decision = toDecisionPoint(player, input);
        const rng = createAgentRandom(seedOffset);

        const response = enumerate(decision, rng);
        if (response.type !== 'card') {
          throw new Error(`expected a 'card' response, got '${response.type}'`);
        }
        expect(response.cards).to.have.length(4);
        expect(new Set(response.cards).size).to.equal(4);
        expect(() => input.process(response)).to.not.throw();
      }
    });

    it('validates against a real initial-research card decision (SelectInitialCards\' project sub-input)', () => {
      const game = createGame({players: 2, seed: 8});
      const [player] = game.playersInGenerationOrder;

      // Right after game creation, each player's pending input is the composite
      // SelectInitialCards (corp + prelude + starting-project-card selection); its
      // `project` sub-input is a real SelectCard<IProjectCard> over the player's
      // actual dealt project cards (src/server/inputs/SelectInitialCards.ts) - the
      // "initial research" decision the affordability caveat (Sub-task B notes) is
      // about.
      const waitingFor = player.getWaitingFor();
      if (!(waitingFor instanceof SelectInitialCards)) {
        throw new Error(`expected the initial decision to be SelectInitialCards, got ${waitingFor?.constructor.name}`);
      }
      const projectInput = waitingFor.inputs.project;
      if (projectInput === undefined) {
        throw new Error('expected SelectInitialCards to have a project sub-input');
      }

      const decision = toDecisionPoint(player, projectInput);
      expect(decision.model.type).to.equal('card');

      const rng = createAgentRandom(8);
      const response = enumerate(decision, rng);
      if (response.type !== 'card') {
        throw new Error(`expected a 'card' response, got '${response.type}'`);
      }

      // The one hard rule: legality is whatever the real input's process() accepts -
      // here, that's SelectCard.process() itself (min/max/membership only; per the
      // affordability caveat it does not check whether the later corp-purchase
      // payment can cover these cards - that is out of scope for this enumerator).
      // (`projectInput` is typed as the general `PlayerInput` interface here, which
      // declares `process(response, player)`, unlike the concrete `SelectCard` class
      // used directly above - hence the second argument only on this call.)
      expect(() => projectInput.process(response, player)).to.not.throw();
    });
  });
});
