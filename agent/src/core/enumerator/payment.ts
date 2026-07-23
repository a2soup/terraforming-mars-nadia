import {CardName} from '@/common/cards/CardName';
import {Payment, PaymentOptions} from '@/common/inputs/Payment';
import {SPENDABLE_RESOURCES, SpendableResource} from '@/common/inputs/Spendable';
import {Units} from '@/common/Units';
import {IPlayer} from '@/server/IPlayer';
import {IStandardProjectCard} from '@/server/cards/IStandardProjectCard';
import {SelectPayment} from '@/server/inputs/SelectPayment';
import {SelectProjectCardToPlay} from '@/server/inputs/SelectProjectCardToPlay';
import {SelectStandardProjectToPlay} from '@/server/inputs/SelectStandardProjectToPlay';
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
 * `projectCard` (the `type` of `SelectCardToPlay`, src/server/inputs/SelectCardToPlay.ts): choose a
 * card to play and a payment covering its cost. **This one model type is produced by two different
 * Engine inputs** - both `SelectCardToPlay` subclasses, both reporting `type: 'projectCard'` and
 * exposing the same `cards`/`enabled` shape, but with different cost/eligibility/payment models:
 *
 * - `SelectProjectCardToPlay` - play a project card from hand. Cost/options/reserve come from
 *   `player.affordOptionsForCard(card)`; eligibility is affordability.
 * - `SelectStandardProjectToPlay` - play a standard project (power plant, asteroid, city, ...).
 *   Cost is `card.getAdjustedCost(player)` (or a discount override), the payable resources are
 *   `card.canPayWith(player)` plus the player's own heat/Luna flags, and eligibility additionally
 *   requires `card.canAct(player)` - see `SelectStandardProjectToPlay.validate()`.
 *
 * They must be factored separately (dispatching on the concrete `raw` input); feeding a standard
 * project through the hand-card path computes the wrong cost/options and gets rejected at
 * submission. Both are factored per FR-ACT-4: choose an eligible+affordable card, then compute one
 * canonical {@link cheapestLegalPayment} for it.
 */
export const enumerateProjectCard: DecisionEnumerator = (decision, rng) => {
  const {model, player, raw} = decision;
  if (model.type !== 'projectCard') {
    throw new Error(`enumerateProjectCard called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return raw instanceof SelectStandardProjectToPlay ?
    enumerateStandardProject(player, raw, rng) :
    enumerateHandCard(player, raw as SelectProjectCardToPlay, rng);
};

/**
 * The `SelectProjectCardToPlay` (play-from-hand) case. Keep only cards that are enabled (a
 * `config.enabled[i] === false` slot marks a card the Engine offered greyed-out) and affordable
 * (`player.canAfford(player.affordOptionsForCard(card))` - the same check
 * `Player.canPlay`/`getPlayableCards` uses), pick one uniformly, and pay via
 * {@link cheapestLegalPayment} driven by `affordOptionsForCard(card)` - whose `cost`, embedded
 * `PaymentOptions` flags, and `reserveUnits` are exactly what the Engine's `checkPaymentAndPlayCard`
 * validates against.
 */
function enumerateHandCard(player: IPlayer, input: SelectProjectCardToPlay, rng: Parameters<DecisionEnumerator>[1]) {
  const enabled = input.enabled;
  const candidates = input.cards.filter((card, i) => {
    if (enabled !== undefined && enabled[i] === false) {
      return false;
    }
    return player.canAfford(player.affordOptionsForCard(card));
  });
  if (candidates.length === 0) {
    // A play-a-card decision is only reached when at least one card is playable (it is normally
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
  return {type: 'projectCard', card: card.name, payment} as const;
}

/**
 * The `SelectStandardProjectToPlay` case. Keep only projects that are **actable** and affordable,
 * pick one uniformly, and pay for it with {@link cheapestLegalPayment} against the standard-project
 * cost/options/reserve ({@link standardProjectTarget}). Eligibility mirrors
 * `SelectStandardProjectToPlay.validate()`: skip a greyed-out (`enabled[i] === false`) project, and
 * require `card.canAct(player)` unless a discount override (`overriddenCost`) is in play - the
 * Engine's `validate()` skips the `canAct` re-check in exactly that discounted case.
 *
 * Throwing on an empty candidate set is correct here: the standard-projects menu is offered as one
 * branch of the action-phase `OrOptions` even when nothing in it is actable/affordable, so "picked
 * this branch but can do nothing in it" is a real (if suboptimal) situation the random agent can
 * reach - the driver's FR-9 fallback (embeddedDriver.ts) then retries another branch, which is the
 * intended recovery, not a bug to paper over here.
 */
function enumerateStandardProject(player: IPlayer, input: SelectStandardProjectToPlay, rng: Parameters<DecisionEnumerator>[1]) {
  const enabled = input.enabled;
  const candidates = input.cards.filter((card, i) => {
    if (enabled !== undefined && enabled[i] === false) {
      return false;
    }
    const details = input.extras.get(card.name);
    if (details?.overriddenCost === undefined && !card.canAct(player)) {
      return false;
    }
    const target = standardProjectTarget(player, card, details?.overriddenCost, details?.reserveUnits);
    return maxPayableValue(player, target.reserveUnits, target.paymentOptions) >= target.cost;
  });
  if (candidates.length === 0) {
    throw new Error(`enumerateProjectCard: no actable, affordable standard project among ${input.cards.length} offered to player ${player.id}`);
  }

  const card = rng.pick(candidates);
  const details = input.extras.get(card.name);
  const target = standardProjectTarget(player, card, details?.overriddenCost, details?.reserveUnits);
  const payment = cheapestLegalPayment(player, target);
  return {type: 'projectCard', card: card.name, payment} as const;
}

/**
 * The {@link PaymentTarget} for a standard project, mirroring `SelectStandardProjectToPlay.validate()`
 * (the source of truth): cost is the discount override if present else `card.getAdjustedCost(player)`,
 * and the payable resources are `card.canPayWith(player)` combined with the player's own
 * heat/Luna-titanium capability flags and expansion-corp tableau (Aurorai/Spire/Kuiper). All of it
 * is read from Engine methods rather than hardcoded, so it tracks the Engine's own rules.
 */
function standardProjectTarget(player: IPlayer, card: IStandardProjectCard, overriddenCost: number | undefined, reserveUnits: Units | undefined): PaymentTarget {
  const canPayWith = card.canPayWith(player);
  return {
    cost: overriddenCost ?? card.getAdjustedCost(player),
    paymentOptions: {
      heat: player.canUseHeatAsMegaCredits,
      steel: canPayWith.steel,
      titanium: canPayWith.titanium,
      lunaTradeFederationTitanium: player.canUseTitaniumAsMegacredits,
      seeds: canPayWith.seeds,
      auroraiData: player.tableau.has(CardName.AURORAI),
      spireScience: player.tableau.has(CardName.SPIRE),
      kuiperAsteroids: canPayWith.kuiperAsteroids ? player.tableau.has(CardName.KUIPER_COOPERATIVE) : false,
    },
    reserveUnits: reserveUnits ?? Units.EMPTY,
  };
}

/** The megacredit value of spending everything spendable (net of `reserve`) under `options`. */
function maxPayableValue(player: IPlayer, reserve: Units, options: Partial<PaymentOptions>): number {
  return player.payingAmount(spendableCounts(player, reserve) as Payment, options);
}

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
