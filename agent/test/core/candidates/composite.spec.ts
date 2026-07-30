import {expect} from 'chai';
import {InputResponse} from '../../../../src/common/inputs/InputResponse';
import {Units} from '../../../../src/common/Units';
import {ICorporationCard} from '../../../../src/server/cards/corporation/ICorporationCard';
import {AndOptions} from '../../../../src/server/inputs/AndOptions';
import {OrOptions} from '../../../../src/server/inputs/OrOptions';
import {SelectAmount} from '../../../../src/server/inputs/SelectAmount';
import {SelectCard} from '../../../../src/server/inputs/SelectCard';
import {SelectInitialCards} from '../../../../src/server/inputs/SelectInitialCards';
import {SelectOption} from '../../../../src/server/inputs/SelectOption';
import {SelectProductionToLose} from '../../../../src/server/inputs/SelectProductionToLose';
import {SelectResources} from '../../../../src/server/inputs/SelectResources';
import {SelectSpace} from '../../../../src/server/inputs/SelectSpace';
import {UndoActionOption} from '../../../../src/server/inputs/UndoActionOption';
import {CANDIDATE_CAP, candidates} from '../../../src/core/candidates';
import {createAgentRandom} from '../../../src/core/rng';
import {toDecisionPoint} from '../../../src/driver/decisionPoint';
import {createGame} from '../../../src/engine/gameFactory';

/**
 * Unit B, the composite decision types (`or`, `and`, `initialCards`) and the two
 * resource-distribution types (`resources`, `productionToLose`) - §3.5's remaining rows.
 *
 * The `or` tests carry the reading recorded in `candidates/composite.ts`: an `or`'s candidate set
 * is the **union** of its branches' sets, because only one branch is ever taken, so expanding
 * them adds rather than multiplies. The `and` test carries the opposite: it is a genuine product,
 * so it stays at one sampled candidate.
 */
describe('candidate enumeration: composite types (or, and, initialCards, resources, productionToLose)', () => {
  const rng = createAgentRandom(97);

  function testPlayer(seed: number) {
    return createGame({players: 2, seed}).playersInGenerationOrder[0];
  }

  describe('or (OrOptions)', () => {
    it('expands every branch into its own candidates, indexed back to the branch it came from', () => {
      const player = testPlayer(1);
      const spaces = player.game.board.spaces.slice(0, 3);
      const build = () => new OrOptions(new SelectOption('pass'), new SelectSpace('place', spaces));
      const set = candidates(toDecisionPoint(player, build()), rng);

      // 1 candidate from the option branch + 3 from the space branch: a union, not a product.
      expect(set.candidates).to.have.length(4);
      expect(set.candidates.filter((c) => c.type === 'or' && c.index === 0)).to.have.length(1);
      expect(set.candidates.filter((c) => c.type === 'or' && c.index === 1)).to.have.length(3);
      for (const candidate of set.candidates) {
        expect(() => build().process(candidate, player), JSON.stringify(candidate)).to.not.throw();
      }
    });

    it('never offers an Undo branch, and keeps the surviving branches on their original indices', () => {
      const player = testPlayer(2);
      const build = () => new OrOptions(new SelectOption('keep'), new UndoActionOption(), new SelectOption('discard'));
      const set = candidates(toDecisionPoint(player, build()), rng);

      expect(set.candidates.map((c) => (c.type === 'or' ? c.index : -1))).to.deep.equal([0, 2]);
      for (const candidate of set.candidates) {
        expect(() => build().process(candidate, player)).to.not.throw();
      }
    });

    it('drops a branch that contributes nothing rather than failing the decision', () => {
      const player = testPlayer(3);
      player.megaCredits = 0;
      // A standard-projects menu with no money in it produces an empty set (see payment.spec.ts);
      // the enclosing `or` must still offer its other branch.
      const build = () => new OrOptions(new SelectOption('pass'), player.getStandardProjectOption());
      const set = candidates(toDecisionPoint(player, build()), rng);

      expect(set.candidates.every((c) => c.type === 'or' && c.index === 0)).to.be.true;
      expect(set.candidates).to.have.length(1);
    });

    it('throws when every branch is Undo (an Engine state that should not occur)', () => {
      const player = testPlayer(4);
      expect(() => candidates(toDecisionPoint(player, new OrOptions(new UndoActionOption())), rng)).to.throw();
    });
  });

  describe('and (AndOptions)', () => {
    it('offers exactly one candidate, with one response per child in order', () => {
      const player = testPlayer(5);
      const spaces = player.game.board.spaces.slice(0, 4);
      const build = () => new AndOptions(new SelectSpace('place', spaces), new SelectAmount('how much', 'Save', 0, 3));
      const set = candidates(toDecisionPoint(player, build()), rng);

      expect(set.candidates, 'an `and` is a genuine cross-product, so it stays at one sample').to.have.length(1);
      const [candidate] = set.candidates;
      if (candidate.type !== 'and') {
        throw new Error(`expected an 'and' candidate, got '${candidate.type}'`);
      }
      expect(candidate.responses.map((r) => r.type)).to.deep.equal(['space', 'amount']);
      expect(() => build().process(candidate, player)).to.not.throw();
    });
  });

  describe('initialCards (SelectInitialCards)', () => {
    /** A fresh game at the same seed deals the same cards, so a candidate built on one is valid on another. */
    function initialDecision(seed: number) {
      const player = createGame({players: 2, seed}).playersInGenerationOrder[0];
      const waitingFor = player.getWaitingFor();
      if (!(waitingFor instanceof SelectInitialCards)) {
        throw new Error(`expected SelectInitialCards, got ${waitingFor?.constructor.name}`);
      }
      return {player, waitingFor};
    }

    it('enumerates corporation x project-card count, and the real composite accepts every candidate', () => {
      const seed = 200;
      const {player, waitingFor} = initialDecision(seed);
      const set = candidates(toDecisionPoint(player, waitingFor), rng);

      const corpInput = waitingFor.inputs.corp as SelectCard<ICorporationCard>;
      const corpIndex = waitingFor.options.indexOf(corpInput);
      const projectIndex = waitingFor.options.indexOf(waitingFor.inputs.project!);
      const corpsOffered = corpInput.cards.map((c) => c.name);

      const chosenCorps = new Set<string>();
      const chosenCounts = new Set<number>();
      for (const candidate of set.candidates) {
        if (candidate.type !== 'initialCards') {
          throw new Error(`expected an 'initialCards' candidate, got '${candidate.type}'`);
        }
        const corp = candidate.responses[corpIndex];
        const project = candidate.responses[projectIndex];
        if (corp.type !== 'card' || project.type !== 'card') {
          throw new Error('expected card responses for the corp and project sub-inputs');
        }
        chosenCorps.add(corp.cards[0]);
        chosenCounts.add(project.cards.length);

        // The one hard rule, and the budget coupling with it: SelectInitialCards.completed()
        // rejects the whole composite when the cards cost more than the corporation's starting
        // M€, so "accepted by process()" *is* the cap being right. A fresh game per candidate
        // because processing this decision mutates hands and discards decks.
        const fresh = initialDecision(seed);
        expect(() => fresh.waitingFor.process(candidate, fresh.player), JSON.stringify(candidate)).to.not.throw();
      }

      expect([...chosenCorps].sort(), 'every offered corporation is a candidate').to.deep.equal([...corpsOffered].sort());
      expect(chosenCounts.has(0), 'buying nothing must stay reachable').to.be.true;
      expect(chosenCounts.size, 'several distinct card counts').to.be.greaterThan(1);
    });

    it('holds the prelude selection fixed across the set, so the enumerated factors are the only difference', () => {
      const {player, waitingFor} = initialDecision(201);
      const preludeIndex = waitingFor.options.indexOf(waitingFor.inputs.prelude!);
      expect(preludeIndex, 'a base + Corpera + Prelude game deals preludes').to.be.greaterThan(-1);

      const set = candidates(toDecisionPoint(player, waitingFor), rng);
      const preludes = set.candidates.map((c) => JSON.stringify(c.type === 'initialCards' ? c.responses[preludeIndex] : undefined));
      expect(new Set(preludes).size).to.equal(1);
    });
  });

  describe('resources (SelectResources)', () => {
    it('offers many distinct legal distributions, all accepted by the real input', () => {
      const player = testPlayer(6);
      const set = candidates(toDecisionPoint(player, new SelectResources('Pick resources', 12)), rng);

      expect(set.candidates.length, 'a count of 12 has thousands of compositions; the set samples them').to.be.greaterThan(10);
      expect(set.candidates.length).to.be.at.most(CANDIDATE_CAP);
      expect(new Set(set.candidates.map((c) => JSON.stringify(c))).size, 'distinct').to.equal(set.candidates.length);
      for (const candidate of set.candidates) {
        expect(totalOf(candidate)).to.equal(12);
        expect(() => new SelectResources('Pick resources', 12).process(candidate)).to.not.throw();
      }
    });

    it('collapses to the single legal distribution when the count is 0', () => {
      const player = testPlayer(7);
      const set = candidates(toDecisionPoint(player, new SelectResources('Pick resources', 0)), rng);
      expect(set.candidates).to.have.length(1);
    });
  });

  describe('productionToLose (SelectProductionToLose)', () => {
    it('offers distinct distributions the player can actually afford to lose', () => {
      const player = testPlayer(8);
      player.production.override({megacredits: 3, steel: 2, titanium: 0, plants: 1, energy: 0, heat: 4});
      const set = candidates(toDecisionPoint(player, new SelectProductionToLose('Lose production', 5, player)), rng);

      expect(set.candidates.length).to.be.greaterThan(1);
      for (const candidate of set.candidates) {
        expect(totalOf(candidate)).to.equal(5);
        expect(() => new SelectProductionToLose('Lose production', 5, player).process(candidate, player), JSON.stringify(candidate)).to.not.throw();
      }
    });
  });

  function totalOf(candidate: InputResponse): number {
    if (candidate.type !== 'resources' && candidate.type !== 'productionToLose') {
      throw new Error(`expected a units-bearing candidate, got '${candidate.type}'`);
    }
    return Units.values(candidate.units).reduce((a, b) => a + b, 0);
  }
});
