import {expect} from 'chai';
import {CardName} from '../../../../src/common/cards/CardName';
import {PaymentOptions} from '../../../../src/common/inputs/Payment';
import {Resource} from '../../../../src/common/Resource';
import {Asteroid} from '../../../../src/server/cards/base/Asteroid';
import {CarbonateProcessing} from '../../../../src/server/cards/base/CarbonateProcessing';
import {IPlayer} from '../../../../src/server/IPlayer';
import {SelectPayment} from '../../../../src/server/inputs/SelectPayment';
import {SelectProjectCardToPlay} from '../../../../src/server/inputs/SelectProjectCardToPlay';
import {SelectStandardProjectToPlay} from '../../../../src/server/inputs/SelectStandardProjectToPlay';
import {candidates} from '../../../src/core/candidates';
import {enumerateProjectCard} from '../../../src/core/enumerator/payment';
import {AgentRandom, createAgentRandom} from '../../../src/core/rng';
import {toDecisionPoint} from '../../../src/driver/decisionPoint';
import {createGame} from '../../../src/engine/gameFactory';

/**
 * Unit B, the payment-bearing decision types - §3.5's `payment` and `projectCard` rows.
 *
 * `projectCard` is the important set (§3.5: "it is where most of the agent's strength lives"),
 * and it is produced by *steering* the Milestone-1 enumerator rather than restating its payment
 * reduction. That technique rests on one internal fact about `enumerateProjectCard` - it calls
 * `rng.pick` exactly once, over the list it has already filtered to the eligible-and-affordable
 * cards - so the first test below asserts that coupling directly. If a future change to
 * `enumerator/payment.ts` breaks it, that test fails loudly rather than the candidate set
 * silently shrinking to one card and the greedy baseline quietly becoming a random one.
 */
describe('candidate enumeration: payment types (payment, projectCard)', () => {
  const rng = createAgentRandom(31337);

  function freshPlayer(seed: number): IPlayer {
    const player = createGame({players: 2, seed}).playersInGenerationOrder[0];
    player.megaCredits = 0;
    player.steel = 0;
    player.titanium = 0;
    player.plants = 0;
    player.heat = 0;
    player.canUseHeatAsMegaCredits = false;
    player.canUseTitaniumAsMegacredits = false;
    return player;
  }

  describe('the steering coupling this unit depends on', () => {
    it('enumerateProjectCard calls rng.pick exactly once, over the eligible cards', () => {
      const player = freshPlayer(10);
      player.megaCredits = 100;
      player.production.add(Resource.ENERGY, 1); // CarbonateProcessing decreases energy production
      player.cardsInHand = [new CarbonateProcessing(), new Asteroid()];
      const input = new SelectProjectCardToPlay(player);

      const picks: Array<number> = [];
      const spy: AgentRandom = {
        next: () => 0,
        nextInt: () => 0,
        intInRange: (min) => min,
        pick: <T>(items: ReadonlyArray<T>) => {
          picks.push(items.length);
          return items[0];
        },
      };
      enumerateProjectCard(toDecisionPoint(player, input), spy, () => ({type: 'option'}));

      expect(picks, 'exactly one pick, over the two eligible cards').to.deep.equal([2]);
    });
  });

  describe('payment (SelectPayment)', () => {
    it('offers the single canonical cheapest-legal allocation, accepted by the real input', () => {
      const player = freshPlayer(11);
      player.megaCredits = 20;
      player.steel = 10;

      const options: Partial<PaymentOptions> = {steel: true};
      const set = candidates(toDecisionPoint(player, new SelectPayment('Pay', 15, options)), rng);

      expect(set.candidates, 'payment variants stay deferred to Milestone 3 (§2.2, §3.5)').to.have.length(1);
      const [candidate] = set.candidates;
      if (candidate.type !== 'payment') {
        throw new Error(`expected a 'payment' candidate, got '${candidate.type}'`);
      }
      expect(candidate.payment.steel, 'the cheapest-legal reduction spends steel first').to.be.greaterThan(0);
      expect(() => new SelectPayment('Pay', 15, options).process(candidate, player)).to.not.throw();
    });
  });

  describe('projectCard (SelectProjectCardToPlay)', () => {
    it('offers one candidate per playable card, each with its own canonical payment', () => {
      const player = freshPlayer(12);
      player.megaCredits = 100;
      player.steel = 10;
      player.titanium = 10;
      player.production.add(Resource.ENERGY, 1);
      player.cardsInHand = [new CarbonateProcessing(), new Asteroid()];

      const set = candidates(toDecisionPoint(player, new SelectProjectCardToPlay(player)), rng);
      const cards = set.candidates.map((c) => (c.type === 'projectCard' ? c.card : undefined));

      expect([...cards].sort()).to.deep.equal([CardName.ASTEROID, CardName.CARBONATE_PROCESSING].sort());
      // Each card carries the payment its own cost model implies - a building card partly in
      // steel, a space card partly in titanium - which is what "per-card canonical payment" means.
      for (const candidate of set.candidates) {
        if (candidate.type !== 'projectCard') {
          throw new Error(`expected a 'projectCard' candidate, got '${candidate.type}'`);
        }
        if (candidate.card === CardName.CARBONATE_PROCESSING) {
          expect(candidate.payment.steel).to.be.greaterThan(0);
        } else {
          expect(candidate.payment.titanium).to.be.greaterThan(0);
        }
      }
    });

    it('every candidate is accepted by the real input on first submission', () => {
      // A fresh player per candidate: playing a card mutates the player, so reusing one would
      // make the second submission a test of a different position.
      const names = () => {
        const player = freshPlayer(13);
        player.megaCredits = 100;
        player.steel = 10;
        player.titanium = 10;
        player.production.add(Resource.ENERGY, 1);
        player.cardsInHand = [new CarbonateProcessing(), new Asteroid(), ...player.dealtProjectCards];
        return player;
      };

      const set = candidates(toDecisionPoint(names(), new SelectProjectCardToPlay(names())), rng);
      expect(set.candidates.length, 'the set should be non-trivial').to.be.greaterThan(2);
      for (const candidate of set.candidates) {
        const player = names();
        expect(() => new SelectProjectCardToPlay(player).process(candidate), JSON.stringify(candidate)).to.not.throw();
      }
    });

    it('never offers a disabled card, even when it is the cheaper one', () => {
      const player = freshPlayer(14);
      player.megaCredits = 100;
      player.steel = 10;
      player.titanium = 10;
      player.production.add(Resource.ENERGY, 1);
      const cards = [new CarbonateProcessing(), new Asteroid()];

      const set = candidates(toDecisionPoint(player, new SelectProjectCardToPlay(player, cards, {enabled: [false, true]})), rng);
      expect(set.candidates.map((c) => (c.type === 'projectCard' ? c.card : undefined))).to.deep.equal([CardName.ASTEROID]);
    });

    it('returns an empty set - not a throw - when nothing offered is affordable', () => {
      const player = freshPlayer(15);
      player.production.add(Resource.ENERGY, 1);
      player.cardsInHand = [new CarbonateProcessing(), new Asteroid()];

      const set = candidates(toDecisionPoint(player, new SelectProjectCardToPlay(player, [new CarbonateProcessing(), new Asteroid()])), rng);
      expect(set.candidates, 'an unaffordable branch contributes nothing rather than failing the decision').to.be.empty;
    });

    it('covers standard projects through their own cost model (SelectStandardProjectToPlay)', () => {
      // `getStandardProjectOption()` is the menu the Engine itself offers as an action-phase `or`
      // branch, enabled-flags and all - built rather than hand-assembled so the eligibility rules
      // under test are the Engine's.
      const richPlayer = (seed: number) => {
        const player = createGame({players: 2, seed}).playersInGenerationOrder[0];
        player.megaCredits = 100;
        player.plants = 20;
        player.heat = 20;
        return player;
      };

      const player = richPlayer(16);
      const set = candidates(toDecisionPoint(player, player.getStandardProjectOption()), rng);

      expect(set.candidates.length, 'a rich player should have several standard projects available').to.be.greaterThan(1);
      for (const candidate of set.candidates) {
        // Fresh player each time - a standard project spends real megacredits, so a second
        // candidate submitted to the same player would be judged against a poorer position.
        const fresh = richPlayer(16);
        expect(
          () => (fresh.getStandardProjectOption() as SelectStandardProjectToPlay).process(candidate),
          JSON.stringify(candidate),
        ).to.not.throw();
      }
    });
  });
});
