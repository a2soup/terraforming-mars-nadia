import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {toDecisionPoint} from '../../src/driver/decisionPoint';
import {enumerate, EnumerateFn} from '../../src/core/enumerator';
import {enumerateAnd, enumerateInitialCards, enumerateOr} from '../../src/core/enumerator/composite';
import {agentRandomFrom, createAgentRandom} from '../../src/core/rng';
import {ConstRandom} from '../../../src/common/utils/Random';
import {InputResponse} from '../../../src/common/inputs/InputResponse';
import {PlayerInput} from '../../../src/server/PlayerInput';
import {IPlayer} from '../../../src/server/IPlayer';
import {Units} from '../../../src/common/Units';
import {OrOptions} from '../../../src/server/inputs/OrOptions';
import {AndOptions} from '../../../src/server/inputs/AndOptions';
import {SelectOption} from '../../../src/server/inputs/SelectOption';
import {UndoActionOption} from '../../../src/server/inputs/UndoActionOption';
import {SelectInitialCards} from '../../../src/server/inputs/SelectInitialCards';
import {SelectResources} from '../../../src/server/inputs/SelectResources';
import {SelectProductionToLose} from '../../../src/server/inputs/SelectProductionToLose';

/**
 * Sub-task D: composite decision types (`or`, `and`, `initialCards`) and the two
 * resource-distribution types (`resources`, `productionToLose`) - see the Sub-task D table,
 * agent/docs/Milestone1_Subtask_Prompts.md.
 *
 * `or` / `and` / `initialCards` are unit-tested first against a **fake `recurse`** (a captured
 * stub returning fixed marker responses), which proves composition/ordering/Undo-skipping without
 * depending on any other enumerator being correct - the enumerators under test are imported
 * directly from `composite.ts` rather than through the `enumerate` dispatch. An integration test
 * then drives a real game through the real `initialCards` decision using the real `enumerate` as
 * `recurse`, so the whole recursive wiring is proven end to end too.
 *
 * `resources` / `productionToLose` have no sub-decisions to recurse into - they're tested directly
 * against the real Engine inputs' own `process()`, per the one hard rule.
 */
describe('composite enumerators (or, and, initialCards, resources, productionToLose)', () => {
  // A player is only needed here to build EmbeddedDecisionPoints (toDecisionPoint reads
  // `player.game` and calls `waitingFor.toModel(player)`) - none of the `or`/`and`/`initialCards`
  // unit tests below depend on the player's game state, so one shared real player suffices.
  function testPlayer(seed: number): IPlayer {
    const game = createGame({players: 2, seed});
    return game.playersInGenerationOrder[0];
  }

  // ---------------------------------------------------------------------------------------------
  // or / and / initialCards - unit tests against a fake `recurse`
  // ---------------------------------------------------------------------------------------------

  describe('or (OrOptions) - fake recurse', () => {
    it('never selects an UndoActionOption branch, and recurses into the branch it does select', () => {
      const player = testPlayer(100);
      const keep = new SelectOption('keep');
      const undo = new UndoActionOption();
      const discard = new SelectOption('discard');
      const raw = new OrOptions(keep, undo, discard);
      const decision = toDecisionPoint(player, raw);

      const calls: PlayerInput[] = [];
      const fakeRecurse: EnumerateFn = (childDecision) => {
        calls.push(childDecision.raw);
        return {type: 'option'};
      };

      const seenIndices = new Set<number>();
      for (let seed = 0; seed < 50; seed++) {
        calls.length = 0;
        const rng = createAgentRandom(seed);
        const response = enumerateOr(decision, rng, fakeRecurse);
        if (response.type !== 'or') {
          throw new Error(`expected an 'or' response, got '${response.type}'`);
        }
        expect(response.index, 'must never pick the Undo branch').to.not.equal(1);
        expect([0, 2]).to.include(response.index);
        expect(calls, 'recurse must be called exactly once, with the chosen branch').to.deep.equal([raw.options[response.index]]);
        expect(response.response).to.deep.equal({type: 'option'});
        seenIndices.add(response.index);
      }
      // Both non-Undo branches should be reachable across enough draws.
      expect(seenIndices, `expected to see both branches, saw ${[...seenIndices]}`).to.deep.equal(new Set([0, 2]));
    });

    it('throws a clear error if every branch is somehow Undo (should never occur for a real decision)', () => {
      const player = testPlayer(101);
      const raw = new OrOptions(new UndoActionOption());
      const decision = toDecisionPoint(player, raw);
      const fakeRecurse: EnumerateFn = () => ({type: 'option'});

      expect(() => enumerateOr(decision, createAgentRandom(0), fakeRecurse)).to.throw();
    });
  });

  describe('and (AndOptions) - fake recurse', () => {
    it('recurses into every child in order, and lines up responses 1:1 with options', () => {
      const player = testPlayer(102);
      const raw = new AndOptions(new SelectOption('a'), new SelectOption('b'), new SelectOption('c'));
      const decision = toDecisionPoint(player, raw);

      const calls: PlayerInput[] = [];
      // Distinguishable per-call markers, so we can prove `responses` isn't just N copies of the
      // same thing - each recurse call gets a different fixed response back.
      const markers: ReadonlyArray<InputResponse> = [
        {type: 'option'},
        {type: 'amount', amount: 7},
        {type: 'option'},
      ];
      const fakeRecurse: EnumerateFn = (childDecision) => {
        calls.push(childDecision.raw);
        return markers[calls.length - 1];
      };

      const response = enumerateAnd(decision, createAgentRandom(0), fakeRecurse);
      if (response.type !== 'and') {
        throw new Error(`expected an 'and' response, got '${response.type}'`);
      }
      expect(calls, 'children must be visited in order').to.deep.equal(raw.options);
      expect(response.responses).to.deep.equal(markers);
    });
  });

  describe('initialCards (SelectInitialCards) - fake recurse', () => {
    it('recurses into every sub-option in order, same shape as and', () => {
      const player = testPlayer(103);
      // SelectInitialCards's own constructor already builds real corp/prelude/project
      // sub-inputs from the player's dealt cards (see the integration test below for that real
      // shape) - here we only need *some* PlayerInputs to prove the composition/ordering
      // contract, so a hand-built AndOptions-shaped stand-in via SelectInitialCards itself,
      // driven off the real player, is the natural source of `raw.options`.
      const waitingFor = player.getWaitingFor();
      if (!(waitingFor instanceof SelectInitialCards)) {
        throw new Error(`expected the initial decision to be SelectInitialCards, got ${waitingFor?.constructor.name}`);
      }
      const decision = toDecisionPoint(player, waitingFor);

      const calls: PlayerInput[] = [];
      const fakeRecurse: EnumerateFn = (childDecision) => {
        calls.push(childDecision.raw);
        return {type: 'card', cards: []};
      };

      const response = enumerateInitialCards(decision, createAgentRandom(0), fakeRecurse);
      if (response.type !== 'initialCards') {
        throw new Error(`expected an 'initialCards' response, got '${response.type}'`);
      }
      expect(calls, 'sub-options must be visited in order').to.deep.equal(waitingFor.options);
      expect(response.responses).to.deep.equal(calls.map(() => ({type: 'card', cards: []})));
    });
  });

  // ---------------------------------------------------------------------------------------------
  // initialCards - integration test: real createGame, real enumerate as recurse
  // ---------------------------------------------------------------------------------------------

  describe('initialCards - integration', () => {
    it('drives a real createGame through the initial composite decision end-to-end', () => {
      const game = createGame({players: 2, seed: 200});
      const [player] = game.playersInGenerationOrder;
      const waitingFor = player.getWaitingFor();
      if (!(waitingFor instanceof SelectInitialCards)) {
        throw new Error(`expected the initial decision to be SelectInitialCards, got ${waitingFor?.constructor.name}`);
      }
      const decision = toDecisionPoint(player, waitingFor);
      expect(decision.model.type).to.equal('initialCards');

      // Force every nested `card` selection to its minimum count (ConstRandom(0) makes
      // enumerateCard's `rng.intInRange(min, upperBound)` always land on `min`). This keeps the
      // test deterministic and clear of the `card` affordability caveat (Sub-task B notes):
      // `SelectInitialCards.completed()` rejects the whole decision if the selected project
      // cards' total research cost exceeds the chosen corporation's starting M€, which the
      // `card` enumerator's own uniform-count sampling does not (and per the caveat, should not)
      // account for. Selecting the minimum (0) project cards sidesteps that entirely while still
      // exercising the real corp/prelude/project recursion through `enumerateInitialCards`.
      const rng = agentRandomFrom(new ConstRandom(0));
      const response = enumerate(decision, rng);
      if (response.type !== 'initialCards') {
        throw new Error(`expected an 'initialCards' response, got '${response.type}'`);
      }

      // The one hard rule: legality is whatever the real SelectInitialCards.process() accepts.
      expect(() => waitingFor.process(response, player)).to.not.throw();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // resources (SelectResources)
  // ---------------------------------------------------------------------------------------------

  describe('resources (SelectResources)', () => {
    it('samples a non-negative distribution over the Units keys summing to count, accepted by the real input', () => {
      for (const count of [0, 1, 5, 23]) {
        for (let seed = 0; seed < 15; seed++) {
          const player = testPlayer(1);
          const input = new SelectResources('Pick resources', count);
          const decision = toDecisionPoint(player, input);
          const rng = createAgentRandom(seed);

          const response = enumerate(decision, rng);
          if (response.type !== 'resources') {
            throw new Error(`expected a 'resources' response, got '${response.type}'`);
          }
          for (const key of Units.keys) {
            expect(response.units[key], `${key} must be non-negative`).to.be.at.least(0);
          }
          expect(Units.values(response.units).reduce((a, b) => a + b, 0)).to.equal(count);
          expect(() => input.process(response)).to.not.throw();
        }
      }
    });

    it('does not always dump the whole count into a single key (genuinely distributes, not just a canonical single-key pick)', () => {
      const player = testPlayer(2);
      const seenMultiKey = [];
      for (let seed = 0; seed < 30; seed++) {
        const input = new SelectResources('Pick resources', 12);
        const decision = toDecisionPoint(player, input);
        const response = enumerate(decision, createAgentRandom(seed));
        if (response.type !== 'resources') {
          throw new Error(`expected a 'resources' response, got '${response.type}'`);
        }
        const nonZeroKeys = Units.keys.filter((key) => response.units[key] > 0);
        if (nonZeroKeys.length > 1) {
          seenMultiKey.push(nonZeroKeys);
        }
      }
      expect(seenMultiKey.length, 'expected at least one draw to spread across multiple keys').to.be.greaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // productionToLose (SelectProductionToLose)
  // ---------------------------------------------------------------------------------------------

  describe('productionToLose (SelectProductionToLose)', () => {
    it('distributes unitsToLose across available production, accepted by the real input', () => {
      const player = testPlayer(3);
      player.production.override({megacredits: 3, steel: 2, titanium: 0, plants: 1, energy: 0, heat: 4});

      for (let seed = 0; seed < 20; seed++) {
        const input = new SelectProductionToLose('Lose production', 5, player);
        const decision = toDecisionPoint(player, input);
        const rng = createAgentRandom(seed);

        const response = enumerate(decision, rng);
        if (response.type !== 'productionToLose') {
          throw new Error(`expected a 'productionToLose' response, got '${response.type}'`);
        }
        for (const key of Units.keys) {
          expect(response.units[key], `${key} must be non-negative`).to.be.at.least(0);
        }
        expect(Units.values(response.units).reduce((a, b) => a + b, 0)).to.equal(5);
        expect(player.production.canAdjust(Units.negative(response.units)), 'must actually have that production to lose').to.be.true;
        expect(() => input.process(response, player)).to.not.throw();
      }
    });

    it('the MC-production floor: can lose megacredit production all the way down to exactly -5', () => {
      const player = testPlayer(4);
      // Megacredit production at 0, nothing else to lose from - the only way to cover
      // unitsToLose=5 is by taking megacredit production all the way to its floor (-5).
      player.production.override({megacredits: 0, steel: 0, titanium: 0, plants: 0, energy: 0, heat: 0});

      const input = new SelectProductionToLose('Lose production', 5, player);
      const decision = toDecisionPoint(player, input);
      const response = enumerate(decision, createAgentRandom(7));
      if (response.type !== 'productionToLose') {
        throw new Error(`expected a 'productionToLose' response, got '${response.type}'`);
      }

      // Legality (including the -5 floor check, `player.production.canAdjust`) is entirely
      // `process()`'s call to make - not re-derived here (the one hard rule). `process()` only
      // validates and invokes the (here, unset) callback; it does not itself mutate production -
      // that happens in the deferred action that normally owns this input in a real game - so
      // there is nothing further to assert about `player.production` after this call.
      expect(response.units).to.deep.equal({megacredits: 5, steel: 0, titanium: 0, plants: 0, energy: 0, heat: 0});
      expect(() => input.process(response, player)).to.not.throw();
    });

    it('the MC-production floor combined with another resource: MC contributes only up to its floor, the rest comes from elsewhere', () => {
      const player = testPlayer(5);
      // MC production capacity is exactly 0 + 5 = 5; steel production is exactly 3; together
      // they exactly cover unitsToLose=8, forcing both to be used to their full capacity.
      player.production.override({megacredits: 0, steel: 3, titanium: 0, plants: 0, energy: 0, heat: 0});

      const input = new SelectProductionToLose('Lose production', 8, player);
      const decision = toDecisionPoint(player, input);
      const response = enumerate(decision, createAgentRandom(11));
      if (response.type !== 'productionToLose') {
        throw new Error(`expected a 'productionToLose' response, got '${response.type}'`);
      }

      expect(response.units).to.deep.equal({megacredits: 5, steel: 3, titanium: 0, plants: 0, energy: 0, heat: 0});
      expect(() => input.process(response, player)).to.not.throw();
    });

    it('property: over randomized production levels and unitsToLose amounts, always legal per the real input', () => {
      const rng = createAgentRandom(9002);
      for (let i = 0; i < 100; i++) {
        const player = testPlayer(6 + (i % 3));
        const production = {
          megacredits: rng.nextInt(10) - 3, // may start below 0, still >= the -5 floor
          steel: rng.nextInt(6),
          titanium: rng.nextInt(6),
          plants: rng.nextInt(6),
          energy: rng.nextInt(6),
          heat: rng.nextInt(6),
        };
        player.production.override(production);

        const capacity = (production.megacredits + 5) + production.steel + production.titanium +
          production.plants + production.energy + production.heat;
        const unitsToLose = rng.nextInt(capacity + 1);

        const input = new SelectProductionToLose('Lose production', unitsToLose, player);
        const decision = toDecisionPoint(player, input);
        const response = enumerate(decision, createAgentRandom(rng.nextInt(1_000_000) + i));
        if (response.type !== 'productionToLose') {
          throw new Error(`expected a 'productionToLose' response, got '${response.type}'`);
        }

        expect(Units.values(response.units).reduce((a, b) => a + b, 0), `iteration ${i}`).to.equal(unitsToLose);
        expect(() => input.process(response, player), `iteration ${i}`).to.not.throw();
      }
    });
  });
});
