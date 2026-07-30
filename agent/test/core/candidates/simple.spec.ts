import {expect} from 'chai';
import {InputResponse} from '../../../../src/common/inputs/InputResponse';
import {Units} from '../../../../src/common/Units';
import {SelectAmount} from '../../../../src/server/inputs/SelectAmount';
import {SelectCard} from '../../../../src/server/inputs/SelectCard';
import {SelectPlayer} from '../../../../src/server/inputs/SelectPlayer';
import {SelectResource} from '../../../../src/server/inputs/SelectResource';
import {SelectSpace} from '../../../../src/server/inputs/SelectSpace';
import {candidates} from '../../../src/core/candidates';
import {createAgentRandom} from '../../../src/core/rng';
import {toDecisionPoint} from '../../../src/driver/decisionPoint';
import {createGame} from '../../../src/engine/gameFactory';

/**
 * Unit B, the simple decision types (`option`, `space`, `player`, `resource`, `amount`, `card`) -
 * §3.5's first four rows.
 *
 * Every test obeys the same hard rule the Milestone-1 enumerator specs do, and it is criterion
 * G1a in miniature: **legality is whatever the real Engine input's own `process()` accepts on
 * first submission**, never our own re-reading of the rules. Each candidate is submitted to a
 * *freshly constructed* input, because `process()` is the thing under test and reusing one input
 * across candidates would let an earlier submission's side effects decide a later verdict.
 */
describe('candidate enumeration: simple types (option, space, player, resource, amount, card)', () => {
  const rng = createAgentRandom(4242);

  function testPlayer(seed: number) {
    return createGame({players: 2, seed}).playersInGenerationOrder[0];
  }

  describe('space', () => {
    it('offers every space on the board list, and the real SelectSpace accepts each', () => {
      const player = testPlayer(1);
      const spaces = player.game.board.spaces.slice(0, 7);
      const set = candidates(toDecisionPoint(player, new SelectSpace('Pick a space', spaces)), rng);

      expect(set.candidates).to.have.length(spaces.length);
      expect(set.candidates.map((c) => (c.type === 'space' ? c.spaceId : undefined))).to.deep.equal(spaces.map((s) => s.id));
      for (const candidate of set.candidates) {
        expect(() => new SelectSpace('Pick a space', spaces).process(candidate)).to.not.throw();
      }
    });
  });

  describe('player', () => {
    it('offers every player, and the real SelectPlayer accepts each', () => {
      const game = createGame({players: 3, seed: 2});
      const players = game.playersInGenerationOrder;
      const set = candidates(toDecisionPoint(players[0], new SelectPlayer(players, 'Pick a player')), rng);

      expect(set.candidates).to.have.length(3);
      expect(set.candidates.map((c) => (c.type === 'player' ? c.player : undefined))).to.deep.equal(players.map((p) => p.color));
      for (const candidate of set.candidates) {
        expect(() => new SelectPlayer(players, 'Pick a player').process(candidate)).to.not.throw();
      }
    });
  });

  describe('resource', () => {
    it('offers every included resource, and the real SelectResource accepts each', () => {
      const player = testPlayer(3);
      const include: ReadonlyArray<keyof Units> = ['steel', 'titanium', 'heat'];
      const set = candidates(toDecisionPoint(player, new SelectResource('Pick a resource', include)), rng);

      expect(set.candidates.map((c) => (c.type === 'resource' ? c.resource : undefined))).to.deep.equal([...include]);
      for (const candidate of set.candidates) {
        expect(() => new SelectResource('Pick a resource', include).process(candidate)).to.not.throw();
      }
    });

    it('covers the full default resource set when the input restricts nothing', () => {
      const player = testPlayer(3);
      const set = candidates(toDecisionPoint(player, new SelectResource('Pick any resource')), rng);
      expect(set.candidates).to.have.length(Units.keys.length);
    });
  });

  describe('amount', () => {
    function amountsFor(min: number, max: number): ReadonlyArray<number> {
      const player = testPlayer(4);
      const set = candidates(toDecisionPoint(player, new SelectAmount('Pick an amount', 'Save', min, max)), rng);
      for (const candidate of set.candidates) {
        expect(() => new SelectAmount('Pick an amount', 'Save', min, max).process(candidate)).to.not.throw();
      }
      return set.candidates.map((c) => (c.type === 'amount' ? c.amount : Number.NaN));
    }

    it('always offers both endpoints, in ascending order, all accepted by the real input', () => {
      for (const [min, max] of [[0, 0], [2, 3], [-3, 3], [0, 5], [1, 40]]) {
        const amounts = amountsFor(min, max);
        expect(amounts[0], `min for [${min}, ${max}]`).to.equal(min);
        expect(amounts[amounts.length - 1], `max for [${min}, ${max}]`).to.equal(max);
        expect([...amounts].sort((a, b) => a - b), `ascending for [${min}, ${max}]`).to.deep.equal([...amounts]);
        expect(new Set(amounts).size, `distinct for [${min}, ${max}]`).to.equal(amounts.length);
      }
    });

    it('is exhaustive for a short range and thinned to at most 8 values for a long one', () => {
      // 6 interior values is the whole interior here, so the set is every legal amount.
      expect(amountsFor(0, 7)).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7]);
      // A 101-value range still costs 8 candidates: both ends plus 6 evenly-spaced interiors.
      expect(amountsFor(0, 100)).to.deep.equal([0, 14, 29, 43, 57, 71, 86, 100]);
    });

    it('a degenerate single-value range yields exactly one candidate', () => {
      expect(amountsFor(5, 5)).to.deep.equal([5]);
    });
  });

  describe('card', () => {
    function cardNames(candidate: InputResponse): ReadonlyArray<string> {
      return candidate.type === 'card' ? candidate.cards : [];
    }

    it('offers every singleton plus the min- and max-size subsets, all accepted by the real input', () => {
      const player = testPlayer(5);
      const cards = player.dealtProjectCards;
      const config = {min: 0, max: 3};
      const set = candidates(toDecisionPoint(player, new SelectCard('Pick project cards', undefined, cards, config)), rng);

      const sizes = set.candidates.map((c) => cardNames(c).length);
      expect(sizes.filter((n) => n === 0), 'the empty (min-size) selection').to.have.length(1);
      expect(sizes.filter((n) => n === 1), 'one candidate per offered card').to.have.length(cards.length);
      expect(sizes.filter((n) => n === 3), 'the max-size subset').to.have.length(1);
      expect(set.candidates).to.have.length(cards.length + 2);

      for (const candidate of set.candidates) {
        expect(new Set(cardNames(candidate)).size, 'cards must be distinct').to.equal(cardNames(candidate).length);
        expect(() => new SelectCard('Pick project cards', undefined, cards, config).process(candidate)).to.not.throw();
      }
    });

    it('clamps the max-size subset to the number of cards actually offered', () => {
      const player = testPlayer(6);
      const cards = player.dealtProjectCards.slice(0, 2);
      const config = {min: 1, max: 9};
      const set = candidates(toDecisionPoint(player, new SelectCard('Pick', undefined, cards, config)), rng);

      expect(Math.max(...set.candidates.map((c) => cardNames(c).length))).to.equal(2);
      for (const candidate of set.candidates) {
        expect(() => new SelectCard('Pick', undefined, cards, config).process(candidate)).to.not.throw();
      }
    });

    it('deduplicates when the reductions collapse onto each other (min === max === 1)', () => {
      const player = testPlayer(7);
      const cards = player.dealtProjectCards.slice(0, 4);
      const config = {min: 1, max: 1};
      const set = candidates(toDecisionPoint(player, new SelectCard('Pick one', undefined, cards, config)), rng);

      // The min-size subset, every singleton, and the max-size subset are all 1-card selections;
      // after dedupe exactly the four singletons survive.
      expect(set.candidates).to.have.length(4);
      expect(new Set(set.candidates.map((c) => cardNames(c)[0])).size).to.equal(4);
    });

    it('respects a min above 1: no singletons, both bulk subsets legal', () => {
      const player = testPlayer(8);
      const cards = player.dealtProjectCards;
      const config = {min: 2, max: 4};
      const set = candidates(toDecisionPoint(player, new SelectCard('Pick', undefined, cards, config)), rng);

      expect(set.candidates.map((c) => cardNames(c).length).sort()).to.deep.equal([2, 4]);
      for (const candidate of set.candidates) {
        expect(() => new SelectCard('Pick', undefined, cards, config).process(candidate)).to.not.throw();
      }
    });
  });
});
