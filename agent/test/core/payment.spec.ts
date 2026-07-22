import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {toDecisionPoint} from '../../src/driver/decisionPoint';
import {enumerate} from '../../src/core/enumerator';
import {AgentRandom, createAgentRandom} from '../../src/core/rng';
import {IPlayer} from '../../../src/server/IPlayer';
import {SelectPayment} from '../../../src/server/inputs/SelectPayment';
import {SelectProjectCardToPlay} from '../../../src/server/inputs/SelectProjectCardToPlay';
import {Payment, PaymentOptions} from '../../../src/common/inputs/Payment';
import {SPENDABLE_RESOURCES} from '../../../src/common/inputs/Spendable';
import {CardName} from '../../../src/common/cards/CardName';
import {Resource} from '../../../src/common/Resource';
import {CarbonateProcessing} from '../../../src/server/cards/base/CarbonateProcessing';
import {Asteroid} from '../../../src/server/cards/base/Asteroid';

/**
 * Sub-task C: the payment-bearing decision types - `payment` (SelectPayment) and `projectCard`
 * (SelectProjectCardToPlay). These are property-style tests: they set up real `createGame`
 * players across a spread of stock/rate states and assert two things about *every* reduction,
 * both decided by the *real* Engine, never by re-checking our own reading of the rules:
 *
 *  - **Legal**: `player.canSpend(payment, reserveUnits)` and `player.payingAmount(payment,
 *    options) >= amount`, verified by handing the response to the real input's own `process()`.
 *  - **Never overpays**: removing any single spent unit drops `payingAmount` below `amount` - i.e.
 *    there is no strictly-cheaper legal payment reachable by dropping a unit (SRS FR-ACT-3).
 */
describe('payment enumerators (payment, projectCard)', () => {
  // ---------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------

  type Stock = {megacredits?: number, steel?: number, titanium?: number, plants?: number, heat?: number};

  /** A fresh, resource-clean player from a real base + Corpera + Prelude game. */
  function freshPlayer(seed: number): IPlayer {
    const game = createGame({players: 2, seed});
    const player = game.playersInGenerationOrder[0];
    setStock(player, {});
    player.canUseHeatAsMegaCredits = false;
    player.canUseTitaniumAsMegacredits = false;
    return player;
  }

  function setStock(player: IPlayer, stock: Stock): void {
    player.megaCredits = stock.megacredits ?? 0;
    player.steel = stock.steel ?? 0;
    player.titanium = stock.titanium ?? 0;
    player.plants = stock.plants ?? 0;
    player.heat = stock.heat ?? 0;
  }

  /**
   * The heart of the "never overpays" property: with a legal payment worth at least `amount`,
   * removing one unit of *any* resource the payment spends must drop its value below `amount`.
   * That is exactly "no strictly-cheaper legal payment exists by dropping a unit" - the value the
   * Engine assigns each unit (via `payingAmount`) is what decides it, so the assertion is immune
   * to our own beliefs about exchange rates.
   */
  function assertMinimal(player: IPlayer, payment: Payment, options: Partial<PaymentOptions>, amount: number): void {
    expect(player.payingAmount(payment, options), 'payment must cover the amount').to.be.at.least(amount);
    for (const resource of SPENDABLE_RESOURCES) {
      if (payment[resource] > 0) {
        const reduced: Payment = {...payment, [resource]: payment[resource] - 1};
        expect(
          player.payingAmount(reduced, options),
          `removing one ${resource} should drop the payment below ${amount} (it overpaid)`,
        ).to.be.below(amount);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // payment (SelectPayment)
  // ---------------------------------------------------------------------------------------------

  describe('payment (SelectPayment)', () => {
    type Scenario = {
      name: string,
      stock: Stock,
      options: Partial<PaymentOptions>,
      amount: number,
      canUseHeat?: boolean,
      canUseTitaniumAsMc?: boolean,
      steelValueBumps?: number,
    };

    const scenarios: ReadonlyArray<Scenario> = [
      {
        name: 'pays with megacredits when no other resource is a usable form of payment',
        stock: {megacredits: 20, steel: 10, titanium: 10},
        options: {},
        amount: 15,
      },
      {
        name: 'spends steel first for a steel-allowed cost, topping up with megacredits',
        stock: {megacredits: 20, steel: 10},
        options: {steel: true},
        amount: 15,
      },
      {
        name: 'covers an odd cost that steel alone must overshoot (trim leaves it minimal)',
        stock: {steel: 10},
        options: {steel: true},
        amount: 15,
      },
      {
        name: 'uses titanium for a space-tag (titanium-allowed) cost',
        stock: {megacredits: 5, titanium: 10},
        options: {titanium: true},
        amount: 20,
      },
      {
        name: 'Helion spends heat as megacredits when it has no real money',
        stock: {heat: 10},
        options: {},
        amount: 8,
        canUseHeat: true,
      },
      {
        name: 'Helion spends its real megacredits first, heat only covers the excess',
        stock: {megacredits: 3, heat: 10},
        options: {},
        amount: 8,
        canUseHeat: true,
      },
      {
        name: 'Luna Trade Federation titanium counts as megacredits (at the -1 discount) even when titanium is not an allowed option',
        stock: {titanium: 10},
        options: {},
        amount: 8,
        canUseTitaniumAsMc: true,
      },
      {
        name: 'reads the steel value from the Engine, not a hardcoded 2 (steel worth 4 here)',
        stock: {steel: 10},
        options: {steel: true},
        amount: 12,
        steelValueBumps: 2,
      },
      {
        name: 'a zero cost is covered by the empty payment',
        stock: {megacredits: 5},
        options: {},
        amount: 0,
      },
    ];

    for (const scenario of scenarios) {
      it(scenario.name, () => {
        const player = freshPlayer(1);
        setStock(player, scenario.stock);
        player.canUseHeatAsMegaCredits = scenario.canUseHeat ?? false;
        player.canUseTitaniumAsMegacredits = scenario.canUseTitaniumAsMc ?? false;
        for (let i = 0; i < (scenario.steelValueBumps ?? 0); i++) {
          player.increaseSteelValue();
        }

        const input = new SelectPayment('Pay', scenario.amount, scenario.options);
        const decision = toDecisionPoint(player, input);
        const response = enumerate(decision, createAgentRandom(1));
        if (response.type !== 'payment') {
          throw new Error(`expected a 'payment' response, got '${response.type}'`);
        }

        // Legal: the real Engine input accepts it on the first submission.
        expect(() => input.process(response, player)).to.not.throw();
        // Minimal: no strictly-cheaper legal payment by dropping a unit.
        assertMinimal(player, response.payment, input.paymentOptions, scenario.amount);
      });
    }

    it('property: legal and minimal across randomized stock, rates, and payment options', () => {
      // Reuse a small pool of real players (SelectPayment.process is non-mutating - it only
      // validates and calls a no-op callback - so a player can be re-tested with fresh stock).
      const players = [freshPlayer(2), freshPlayer(3), freshPlayer(4), freshPlayer(5)];
      const rng = createAgentRandom(9001);

      for (let i = 0; i < 300; i++) {
        const player = players[i % players.length];
        setStock(player, {
          megacredits: rng.nextInt(25),
          steel: rng.nextInt(12),
          titanium: rng.nextInt(12),
          plants: rng.nextInt(12),
          heat: rng.nextInt(12),
        });
        player.canUseHeatAsMegaCredits = rng.next() < 0.5;
        player.canUseTitaniumAsMegacredits = rng.next() < 0.5;

        const options: Partial<PaymentOptions> = {
          steel: rng.next() < 0.5,
          titanium: rng.next() < 0.5,
          plants: rng.next() < 0.5,
        };

        // Choose an affordable amount: at most the value of spending everything available.
        const everything = Payment.of({
          megacredits: player.megaCredits,
          steel: player.steel,
          titanium: player.titanium,
          plants: player.plants,
          heat: player.availableHeat(),
        });
        const maxValue = player.payingAmount(everything, options);
        const amount = rng.nextInt(maxValue + 1);

        const input = new SelectPayment('Pay', amount, options);
        const decision = toDecisionPoint(player, input);
        const response = enumerate(decision, agentRandomSeed(rng, i));
        if (response.type !== 'payment') {
          throw new Error(`expected a 'payment' response, got '${response.type}'`);
        }

        expect(() => input.process(response, player), `iteration ${i} (amount ${amount})`).to.not.throw();
        assertMinimal(player, response.payment, input.paymentOptions, amount);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // projectCard (SelectProjectCardToPlay)
  //
  // These construct the real Engine input directly on a real `createGame` player with an
  // affordable card in hand, then assert its own `process()` accepts (and actually plays) the
  // enumerator's move. Driving a game to a *naturally-occurring* projectCard decision instead
  // isn't possible yet: it sits behind the action phase, which is reached through the composite
  // `initialCards` / prelude decisions that `enumerate` cannot answer until sub-task D lands.
  // `new SelectProjectCardToPlay(player)` is exactly the object the Engine builds when a player
  // plays a card, so its `process()` is the same end-to-end acceptance.
  // ---------------------------------------------------------------------------------------------

  describe('projectCard (SelectProjectCardToPlay)', () => {
    it('chooses a building-tag card and pays with steel; the real input plays it end-to-end', () => {
      const player = freshPlayer(10);
      setStock(player, {megacredits: 3, steel: 5});
      player.production.add(Resource.ENERGY, 1); // CarbonateProcessing decreases energy production
      player.cardsInHand = [new CarbonateProcessing()];

      const input = new SelectProjectCardToPlay(player);
      const decision = toDecisionPoint(player, input);
      const response = enumerate(decision, createAgentRandom(1));
      if (response.type !== 'projectCard') {
        throw new Error(`expected a 'projectCard' response, got '${response.type}'`);
      }

      expect(response.card).to.equal(CardName.CARBONATE_PROCESSING);
      expect(response.payment.steel, 'a building card should be paid partly with steel').to.be.greaterThan(0);

      const card = input.cards.find((c) => c.name === response.card)!;
      const affordOptions = player.affordOptionsForCard(card);
      assertMinimal(player, response.payment, affordOptions, affordOptions.cost);

      expect(() => input.process(response)).to.not.throw();
    });

    it('chooses a space-tag card and pays with titanium; the real input plays it end-to-end', () => {
      const player = freshPlayer(11);
      setStock(player, {megacredits: 5, titanium: 5});
      player.cardsInHand = [new Asteroid()];

      const input = new SelectProjectCardToPlay(player);
      const decision = toDecisionPoint(player, input);
      const response = enumerate(decision, createAgentRandom(1));
      if (response.type !== 'projectCard') {
        throw new Error(`expected a 'projectCard' response, got '${response.type}'`);
      }

      expect(response.card).to.equal(CardName.ASTEROID);
      expect(response.payment.titanium, 'a space card should be paid partly with titanium').to.be.greaterThan(0);

      const card = input.cards.find((c) => c.name === response.card)!;
      const affordOptions = player.affordOptionsForCard(card);
      assertMinimal(player, response.payment, affordOptions, affordOptions.cost);

      expect(() => input.process(response)).to.not.throw();
    });

    it('never picks a disabled card even when it is cheaper', () => {
      const player = freshPlayer(12);
      setStock(player, {megacredits: 100, steel: 10, titanium: 10});
      player.production.add(Resource.ENERGY, 1);
      const carbonate = new CarbonateProcessing(); // cost 6, would be the cheaper pick
      const asteroid = new Asteroid(); // cost 14
      const cards = [carbonate, asteroid];
      // Mark the cheaper card disabled; the enumerator must skip it despite affordability.
      const input = new SelectProjectCardToPlay(player, cards, {enabled: [false, true]});

      for (let seed = 0; seed < 20; seed++) {
        const decision = toDecisionPoint(player, input);
        const response = enumerate(decision, createAgentRandom(seed));
        if (response.type !== 'projectCard') {
          throw new Error(`expected a 'projectCard' response, got '${response.type}'`);
        }
        expect(response.card, 'must never choose the disabled card').to.equal(CardName.ASTEROID);
      }
    });

    it('property: over several real games, the chosen card is enabled + affordable and the real input accepts the move', () => {
      for (let seed = 20; seed < 30; seed++) {
        const game = createGame({players: 2, seed});
        const player = game.playersInGenerationOrder[0];
        setStock(player, {megacredits: 100, steel: 20, titanium: 20, plants: 20});
        player.production.add(Resource.ENERGY, 1);
        // Guarantee a non-empty, requirement-free playable set alongside the dealt hand.
        player.cardsInHand = [new Asteroid(), new CarbonateProcessing(), ...player.dealtProjectCards];

        const input = new SelectProjectCardToPlay(player);
        const playable = input.cards.map((c) => c.name);
        expect(playable.length, `seed ${seed} should have playable cards`).to.be.greaterThan(0);

        const decision = toDecisionPoint(player, input);
        const response = enumerate(decision, createAgentRandom(seed));
        if (response.type !== 'projectCard') {
          throw new Error(`expected a 'projectCard' response, got '${response.type}'`);
        }

        // Chosen card is one the Engine offered and is genuinely affordable.
        expect(playable, `seed ${seed}`).to.include(response.card);
        const card = input.cards.find((c) => c.name === response.card)!;
        expect(player.canAfford(player.affordOptionsForCard(card)), `seed ${seed}: chosen card must be affordable`).to.be.true;

        const affordOptions = player.affordOptionsForCard(card);
        assertMinimal(player, response.payment, affordOptions, affordOptions.cost);

        // End-to-end: the real Engine input accepts (and plays) the move.
        expect(() => input.process(response), `seed ${seed}`).to.not.throw();
      }
    });
  });
});

/**
 * Derives an independent {@link AgentRandom} per iteration so a failing property case is
 * reproducible in isolation, while the outer `rng` still advances the scenario parameters.
 */
function agentRandomSeed(rng: AgentRandom, i: number): AgentRandom {
  return createAgentRandom(rng.nextInt(1_000_000) + i);
}
