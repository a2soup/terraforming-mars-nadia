import {Payment, PaymentOptions} from '@/common/inputs/Payment';
import {SPENDABLE_RESOURCES, SpendableResource} from '@/common/inputs/Spendable';
import {Units} from '@/common/Units';
import {IPlayer} from '@/server/IPlayer';
import {SelectPayment} from '@/server/inputs/SelectPayment';
import {SelectProjectCardToPlay} from '@/server/inputs/SelectProjectCardToPlay';
import {DecisionEnumerator} from './types';

/**
 * Enumerators for the two payment-bearing decision types - `payment` (SelectPayment) and
 * `projectCard` (SelectProjectCardToPlay). Both reduce to the *same* FR-ACT-4 payment factor,
 * {@link cheapestLegalPayment}, which is deliberately the one place the payment reduction lives
 * (agent/docs/Running_Notes.md, 2026-07-22 "deferred payment reduction").
 *
 * **Milestone-1 simplification (do not lose).** For M1 the random-legal agent needs exactly one
 * legal payment per decision, so this returns a *single* canonical cheapest-legal `Payment`
 * (spend the cheapest alternate resources first, megacredits last, then trim overspend - the
 * client's proven `computeDefaultPayment` shape, src/client/components/PaymentDefaults.ts). The
 * strategically-meaningful payment *variants* (hold back a steel for Electro Catapult, keep a
 * titanium for next generation, ...) are explicitly deferred to Milestone 3; this factor is kept
 * isolated so M3 can grow a candidate set here without touching the enumerator wiring.
 *
 * **The one hard rule (types.ts).** "Cheapest-legal" is only ever *proposed* by the greedy
 * reduction; legality is decided by the Engine's own predicate, which SelectPayment.process and
 * SelectCardToPlay.process both apply: `player.canSpend(payment, reserveUnits)` AND
 * `player.payingAmount(payment, options) >= cost`. Every produced payment is verified against
 * that predicate before it is returned (see {@link cheapestLegalPayment}); nothing here
 * re-derives an exchange rate or an affordability rule - it drives entirely off the `IPlayer`
 * helpers so the Engine stays the single source of truth for card values, heat/Helion, and the
 * Luna titanium hook.
 */

/** The Engine's payment predicate, restated as a target for the reduction. */
type PaymentTarget = {
  /** The megacredit value the payment must cover (SelectPayment.amount / a card's cost). */
  cost: number;
  /**
   * Which non-megacredit resources may be spent, exactly as `player.payingAmount` reads them.
   * For a card this is `player.affordOptionsForCard(card)` (a `CanAffordOptions`, which *is* a
   * `Partial<PaymentOptions>` - it spreads `paymentOptionsForCard(card)`); for a bare payment it
   * is `SelectPayment.paymentOptions`, i.e. the very object `process` passes to `payingAmount`.
   */
  paymentOptions: Partial<PaymentOptions>;
  /** Units the Engine forbids spending (Moon reserve costs); empty for base + Corpera + Prelude. */
  reserveUnits: Units;
};

/**
 * `payment` (SelectPayment, src/server/inputs/SelectPayment.ts): pay at least `amount` M€ worth
 * of resources. `process` accepts iff `player.canSpend(payment, reserveUnits)` and
 * `player.payingAmount(payment, this.paymentOptions) >= amount`. We read `amount`,
 * `paymentOptions`, and `reserveUnits` from the live input (`raw`) rather than the serialized
 * model, because `paymentOptions` there is the *exact* object `process` will hand to
 * `payingAmount` - the model's copy is augmented with redundant heat/luna flags that
 * `payingAmount` ignores anyway (it reads the player's own capability flags for those).
 *
 * There is one canonical cheapest-legal payment for M1, so this leaf ignores the rng.
 */
export const enumeratePayment: DecisionEnumerator = (decision) => {
  const {model, player, raw} = decision;
  if (model.type !== 'payment') {
    throw new Error(`enumeratePayment called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const input = raw as SelectPayment;
  const payment = cheapestLegalPayment(player, {
    cost: input.amount,
    paymentOptions: input.paymentOptions,
    reserveUnits: input.reserveUnits ?? Units.EMPTY,
  });
  return {type: 'payment', payment};
};

/**
 * `projectCard` (SelectProjectCardToPlay, src/server/inputs/SelectProjectCardToPlay.ts): choose a
 * project card to play and a payment covering its cost. Factored per FR-ACT-4:
 *
 * 1. **Choose a card.** Keep only cards that are enabled (a `config.enabled[i] === false` slot
 *    marks a card the Engine offered greyed-out) and affordable
 *    (`player.canAfford(player.affordOptionsForCard(card))` - the same check
 *    `Player.canPlay`/`getPlayableCards` uses), then pick one uniformly. (The default card list is
 *    already `getPlayableCards()`, i.e. affordable; re-checking makes the enumerator correct for
 *    the config-supplied card lists some actions pass too.)
 * 2. **Pay for it** with the same {@link cheapestLegalPayment} reduction, driven by
 *    `affordOptionsForCard(card)` - whose `cost`, embedded `PaymentOptions` flags, and
 *    `reserveUnits` are exactly what the Engine's `checkPaymentAndPlayCard` uses to validate.
 */
export const enumerateProjectCard: DecisionEnumerator = (decision, rng) => {
  const {model, player, raw} = decision;
  if (model.type !== 'projectCard') {
    throw new Error(`enumerateProjectCard called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const input = raw as SelectProjectCardToPlay;
  const enabled = input.enabled;

  const candidates = input.cards.filter((card, i) => {
    if (enabled !== undefined && enabled[i] === false) {
      return false;
    }
    return player.canAfford(player.affordOptionsForCard(card));
  });
  if (candidates.length === 0) {
    // A `projectCard` decision is only reached when at least one card is playable (it is normally
    // one branch of an OrOptions whose sibling is "pass"), so an empty candidate set means the
    // model and the live affordability check disagree - surface it loudly rather than guess.
    throw new Error(`enumerateProjectCard: no enabled, affordable card among ${input.cards.length} offered to player ${player.id}`);
  }

  const card = rng.pick(candidates);
  const affordOptions = player.affordOptionsForCard(card);
  const payment = cheapestLegalPayment(player, {
    cost: affordOptions.cost,
    paymentOptions: affordOptions,
    reserveUnits: affordOptions.reserveUnits ?? Units.EMPTY,
  });
  return {type: 'projectCard', card: card.name, payment};
};

/**
 * The shared FR-ACT-4 payment factor: build one canonical cheapest-legal `Payment` covering
 * `target.cost`, then **verify it against the Engine's own predicate** before returning.
 *
 * The greedy proposal ({@link greedyPayment}) can, in principle, be wrong for an exotic
 * value/availability mix the reduction does not anticipate; rather than trust it, we check
 * `canSpend ∧ payingAmount >= cost` (exactly what `process` checks) and, on failure, fall back
 * first to an all-megacredits payment and finally to a thrown diagnostic. For any decision the
 * Engine would actually present, one of the first two always succeeds - the throw exists so that
 * a genuinely impossible target becomes a clear error instead of a silently-illegal move.
 */
function cheapestLegalPayment(player: IPlayer, target: PaymentTarget): Payment {
  const greedy = greedyPayment(player, target);
  if (isSufficient(player, greedy, target)) {
    return greedy;
  }

  // Fallback: cover the whole cost with plain megacredits. Correct whenever the player simply has
  // the money, and immune to any subtlety in the alternate-resource allocation above.
  const allMegacredits = Payment.of({megacredits: Math.max(target.cost, 0)});
  if (isSufficient(player, allMegacredits, target)) {
    return allMegacredits;
  }

  throw new Error(
    `cheapestLegalPayment: could not cover cost ${target.cost} for player ${player.id}; ` +
    `greedy paid ${player.payingAmount(greedy, target.paymentOptions)}, ` +
    `all-megacredits paid ${player.payingAmount(allMegacredits, target.paymentOptions)}. ` +
    `This decision should not have been offered as affordable.`);
}

/** The Engine's acceptance predicate (SelectPayment.process / checkPaymentAndPlayCard), verbatim. */
function isSufficient(player: IPlayer, payment: Payment, target: PaymentTarget): boolean {
  return player.canSpend(payment, target.reserveUnits) &&
    player.payingAmount(payment, target.paymentOptions) >= target.cost;
}

/**
 * The greedy cheapest-legal allocation, mirroring the client's proven `computeDefaultPayment`
 * (src/client/components/PaymentDefaults.ts): fill non-megacredit resources cheapest-first up to
 * the cost, trim any overspend from the most valuable resource down, then top up the remainder
 * with megacredits (spent last). Two properties this yields, both asserted by the tests:
 *
 * - **Legal** (barring the fallback cases): after the megacredit top-up the payment is worth at
 *   least `cost` whenever the player can afford it at all.
 * - **Never overpays**: the trim loop removes a unit only while doing so keeps the total at or
 *   above `cost`, so at the end removing *any* single spent unit would drop the total below `cost`
 *   - i.e. no strictly-cheaper legal payment exists by dropping a unit.
 *
 * Every value comes from `player.payingAmount` (a one-unit probe per resource), so steel/titanium
 * values, the Helion heat rate, and the Luna-Trade-Federation titanium discount are all taken
 * from the Engine rather than hardcoded here.
 */
function greedyPayment(player: IPlayer, target: PaymentTarget): Payment {
  const {cost, paymentOptions, reserveUnits} = target;
  const available = spendableCounts(player, reserveUnits);

  // Per-resource megacredit value, straight from the Engine. A single unit is linear in
  // `payingAmount` (it sums `count * multiplier`), so `payingAmount({r: 1})` is exactly the value
  // of one unit of `r` for this decision - and it is 0 precisely when `r` is not a usable form of
  // payment here, which is how we filter the spendable set.
  const value = {} as Record<SpendableResource, number>;
  for (const resource of SPENDABLE_RESOURCES) {
    value[resource] = player.payingAmount(unit(resource), paymentOptions);
  }

  // Non-megacredit resources we can actually spend, cheapest first. Megacredits are handled
  // separately as the final top-up (spent last). The index tiebreak keeps the order - and thus
  // the whole payment - deterministic for equal-valued resources (the agent-determinism exit
  // criterion), independent of Array.sort's stability guarantees.
  const order = SPENDABLE_RESOURCES
    .filter((r) => r !== 'megacredits' && available[r] > 0 && value[r] > 0)
    .sort((a, b) => value[a] - value[b] || SPENDABLE_RESOURCES.indexOf(a) - SPENDABLE_RESOURCES.indexOf(b));

  const payment = {...Payment.EMPTY};
  const megacreditsAvailable = available.megacredits;
  let coveredByAlternates = 0;

  for (const resource of order) {
    const rate = value[resource];
    // Minimum units needed to cover the part of `cost` that megacredits and previously-allocated
    // alternates cannot. `ceil` can overshoot by up to `rate - 1`; the trim pass fixes that.
    let count = Math.min(
      Math.ceil(Math.max(cost - megacreditsAvailable - coveredByAlternates, 0) / rate),
      available[resource]);
    // Greedily dump more of this resource while it still fits under `cost`, so alternate
    // resources are spent in preference to megacredits (which stay flexible). Heat is the
    // exception - worth the same as a megacredit, so there is no reason to burn more than needed.
    if (resource !== 'heat') {
      while (count < available[resource] && coveredByAlternates + (count + 1) * rate <= cost) {
        count++;
      }
    }
    payment[resource] = count;
    coveredByAlternates += count * rate;
  }

  // Trim overspend, most valuable resource first, but never below `cost`. This is what guarantees
  // the "never overpays" property: afterwards, for every spent resource, removing one unit drops
  // the total below `cost`.
  if (coveredByAlternates > cost) {
    for (let i = order.length - 1; i >= 0; i--) {
      const resource = order[i];
      const rate = value[resource];
      while (payment[resource] > 0 && coveredByAlternates - rate >= cost) {
        payment[resource]--;
        coveredByAlternates -= rate;
      }
    }
  }

  // Fill any remaining gap with megacredits (value 1 each), spent last.
  payment.megacredits = Math.min(megacreditsAvailable, Math.max(cost - coveredByAlternates, 0));
  return payment;
}

/**
 * The most of each resource the player may spend, excluding reserved units - a public-API
 * reconstruction of `Player.maxSpendable` (which is private): standard resources net of
 * `reserveUnits`, heat via `availableHeat()`, and card resources via `getSpendable()` (reserve
 * units never touch card resources, matching `maxSpendable`).
 */
function spendableCounts(player: IPlayer, reserve: Units): Record<SpendableResource, number> {
  return {
    megacredits: player.megaCredits - reserve.megacredits,
    steel: player.steel - reserve.steel,
    titanium: player.titanium - reserve.titanium,
    plants: player.plants - reserve.plants,
    heat: player.availableHeat() - reserve.heat,
    microbes: player.getSpendable('microbes'),
    floaters: player.getSpendable('floaters'),
    lunaArchivesScience: player.getSpendable('lunaArchivesScience'),
    spireScience: player.getSpendable('spireScience'),
    seeds: player.getSpendable('seeds'),
    auroraiData: player.getSpendable('auroraiData'),
    graphene: player.getSpendable('graphene'),
    kuiperAsteroids: player.getSpendable('kuiperAsteroids'),
  };
}

/** A payment of exactly one unit of `resource` - the probe used to read a resource's value. */
function unit(resource: SpendableResource): Payment {
  return Payment.of({[resource]: 1} as Partial<Payment>);
}
