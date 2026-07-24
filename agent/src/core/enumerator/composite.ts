import {CardName} from '@/common/cards/CardName';
import {InputResponse} from '@/common/inputs/InputResponse';
import {Units} from '@/common/Units';
import {IPlayer} from '@/server/IPlayer';
import {ICorporationCard} from '@/server/cards/corporation/ICorporationCard';
import {AndOptions} from '@/server/inputs/AndOptions';
import {OrOptions} from '@/server/inputs/OrOptions';
import {SelectCard} from '@/server/inputs/SelectCard';
import {SelectInitialCards} from '@/server/inputs/SelectInitialCards';
import {SelectProductionToLose} from '@/server/inputs/SelectProductionToLose';
import {UndoActionOption} from '@/server/inputs/UndoActionOption';
import {toDecisionPoint} from '../../driver/decisionPoint';
import {AgentRandom} from '../rng';
import {DecisionEnumerator} from './types';

/**
 * Enumerators for the composite decision types - `or` (OrOptions), `and` (AndOptions),
 * `initialCards` (SelectInitialCards) - and the two resource-distribution types - `resources`
 * (SelectResources) and `productionToLose` (SelectProductionToLose).
 *
 * The first three are structurally identical from the enumerator's point of view: each wraps a
 * list of child `PlayerInput`s (`raw.options`), and the Engine's own `process()` wants either one
 * sub-response (`or`, picking a branch) or one sub-response per child in order (`and` /
 * `initialCards`). Per FR-ACT-4 these never materialize a cross-product of sub-decisions; each
 * child is answered independently, in order, via the `recurse: EnumerateFn` argument the dispatch
 * (enumerator/index.ts) hands every composite enumerator - the same top-level `enumerate` bound
 * over the same rng, so nested decisions of *any* type (including further composites) resolve
 * correctly without this module importing the dispatch directly.
 *
 * `resources` / `productionToLose` are combinatorial in a different sense - not nested
 * sub-decisions but a distribution of a fixed total across the six `Units` keys - so they sample
 * that distribution bucket-by-bucket ({@link sampleBoundedComposition}) rather than enumerating
 * every composition.
 */

/**
 * `or` (OrOptions, src/server/inputs/OrOptions.ts): pick one child and recurse into it.
 * `OrOptions.process` accepts any `{index, response}` where `index` is in range and `response` is
 * accepted by `options[index].process` - so every offered branch is equally legal to *choose*
 * (legality of the nested `response` is then `recurse`'s job, transitively the same rule one level
 * down). The one exception: the embedded driver rejects an `'or'` response that selects an
 * `UndoActionOption` branch outright (`embeddedDriver.ts`'s Undo guard - there is no save history to
 * restore against a headless game), so this enumerator never offers that branch a chance to be
 * picked, filtering it out *before* sampling rather than sampling then retrying.
 */
export const enumerateOr: DecisionEnumerator = (decision, rng, recurse) => {
  const {model, player} = decision;
  if (model.type !== 'or') {
    throw new Error(`enumerateOr called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const raw = decision.raw as OrOptions;
  const eligible = raw.options
    .map((option, index) => ({option, index}))
    .filter(({option}) => !(option instanceof UndoActionOption));
  if (eligible.length === 0) {
    // Every real OrOptions offers at least one non-Undo branch (Undo, when present, is always
    // alongside the actual action choices) - an all-Undo OrOptions would mean the Engine offered
    // nothing else to do, which should not happen for an in-scope decision (FR-9).
    throw new Error(`enumerateOr: every branch is UndoActionOption among ${raw.options.length} offered to player ${player.id}`);
  }
  const {option: chosen, index} = rng.pick(eligible);
  const response = recurse(toDecisionPoint(player, chosen), rng);
  return {type: 'or', index, response};
};

/**
 * `and` (AndOptions, src/server/inputs/AndOptions.ts): recurse into every child, in order.
 * `AndOptions.process` requires `responses.length === options.length` and each `responses[i]`
 * accepted by `options[i].process` - there is no branching to sample, only composition, so this
 * always answers every child (never a subset).
 */
export const enumerateAnd: DecisionEnumerator = (decision, rng, recurse) => {
  const {model, player} = decision;
  if (model.type !== 'and') {
    throw new Error(`enumerateAnd called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const raw = decision.raw as AndOptions;
  const responses = raw.options.map((option) => recurse(toDecisionPoint(player, option), rng));
  return {type: 'and', responses};
};

/**
 * `initialCards` (SelectInitialCards, src/server/inputs/SelectInitialCards.ts): the initial
 * corporation / prelude / CEO / starting-project-card selection, presented as one composite
 * decision at game start. Despite the dedicated class (it does not literally extend `AndOptions` -
 * see the class's own `TODO(kberg)` about that), its `toModel`/`process` shape is identical to
 * `AndOptions`: a `responses` array of the same length as `options`, each recursed into
 * independently and in order.
 *
 * **The one place a child's legality is not decided by the child's own input.** Every sub-input
 * here accepts its response on its own terms - `SelectCard.process` checks only count and
 * membership - but `SelectInitialCards.completed()` then rejects the *whole* composite if the
 * chosen project cards cost more than the chosen corporation's starting M€:
 * `cardsInHand.length * cardCost > corporation.startingMegaCredits` throws `Too many cards
 * selected`. So a uniformly-random project-card count is locally legal and globally illegal, and
 * no amount of care inside `enumerateCard` can see it: the budget depends on a *sibling* response.
 *
 * That coupling is why the driver's FR-9 fallback exists at all (Running Notes 2026-07-22, sub-task
 * E), and until the AC-1 legality run it was left to the fallback to absorb - which it did, at the
 * cost of the Agent submitting a move the Engine rejects. The run measured that cost at **59
 * rejections across 1,500 games** and, since they were the *only* Agent-attributable illegal moves
 * it found, this cap is the fix that takes NFR-4's "zero Agent-attributable illegal-move
 * rejections" from nearly-true to true. See agent/docs/AC1_Legality_Run.md.
 *
 * The cap is read from the Engine's own objects, mirroring `completed()` rather than restating it
 * (the same discipline `enumerateStandardProject` follows for `SelectStandardProjectToPlay.validate()`),
 * and applied by *truncating* the sampled selection rather than resampling: `enumerateCard`'s
 * partial Fisher-Yates already produces a uniformly random ordered sample, so its first `k` entries
 * are themselves a uniform subset of size `k`, and truncating consumes exactly the same rng draws
 * as before. The distributional consequence is real and worth naming: the selected count becomes
 * `min(uniform, cap)` rather than uniform over the affordable range, so it piles up slightly at the
 * cap. For a random-legal baseline that is irrelevant; a Milestone-3 agent will choose this count
 * deliberately anyway.
 */
export const enumerateInitialCards: DecisionEnumerator = (decision, rng, recurse) => {
  const {model, player} = decision;
  if (model.type !== 'initialCards') {
    throw new Error(`enumerateInitialCards called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const raw = decision.raw as SelectInitialCards;
  const responses = raw.options.map((option) => recurse(toDecisionPoint(player, option), rng));

  const corporation = chosenCorporation(raw, responses);
  const projectIndex = raw.inputs.project === undefined ? -1 : raw.options.indexOf(raw.inputs.project);
  if (corporation !== undefined && projectIndex >= 0) {
    const projectResponse = responses[projectIndex];
    if (projectResponse.type === 'card') {
      const cap = affordableCardCount(player, corporation);
      if (projectResponse.cards.length > cap) {
        responses[projectIndex] = {type: 'card', cards: projectResponse.cards.slice(0, cap)};
      }
    }
  }

  return {type: 'initialCards', responses};
};

/** The corporation the just-built `corp` sub-response selected, or `undefined` if it can't be identified. */
function chosenCorporation(raw: SelectInitialCards, responses: ReadonlyArray<InputResponse>): ICorporationCard | undefined {
  const corpInput = raw.inputs.corp;
  if (corpInput === undefined) {
    return undefined;
  }
  const corpResponse = responses[raw.options.indexOf(corpInput)];
  if (corpResponse?.type !== 'card' || corpResponse.cards.length !== 1) {
    return undefined;
  }
  return (corpInput as SelectCard<ICorporationCard>).cards.find((card) => card.name === corpResponse.cards[0]);
}

/**
 * The most project cards affordable under `corporation`, straight from `SelectInitialCards.completed()`'s
 * own predicate: the per-card cost is the corporation's `cardCost` override if it has one, else the
 * player's, and the Beginner Corporation is exempt from the check entirely.
 */
function affordableCardCount(player: IPlayer, corporation: ICorporationCard): number {
  if (corporation.name === CardName.BEGINNER_CORPORATION) {
    return Number.POSITIVE_INFINITY;
  }
  const cardCost = corporation.cardCost ?? player.cardCost;
  return cardCost <= 0 ? Number.POSITIVE_INFINITY : Math.floor(corporation.startingMegaCredits / cardCost);
}

/**
 * `resources` (SelectResources, src/server/inputs/SelectResources.ts): distribute `model.count`
 * across the six `Units` keys. `SelectResources.process` only checks that every field is
 * non-negative and the total is exactly `count` - it does not restrict *which* keys may be used
 * (unlike `resource`, SelectResource, which offers a restricted set) - so any composition of
 * `count` across `megacredits, steel, titanium, plants, energy, heat` is legal. Sampled
 * bucket-by-bucket via {@link sampleBoundedComposition} (each bucket's own "capacity" is simply
 * the whole `count`, since nothing here restricts a single key's share of it) rather than
 * materializing the combinatorial space of compositions.
 */
export const enumerateResources: DecisionEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'resources') {
    throw new Error(`enumerateResources called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const capacities = Units.keys.map(() => model.count);
  const units = unitsFromAmounts(sampleBoundedComposition(rng, model.count, capacities));
  return {type: 'resources', units};
};

/**
 * `productionToLose` (SelectProductionToLose, src/server/inputs/SelectProductionToLose.ts):
 * distribute `unitsToLose` steps of production loss across the production the player actually
 * has. `process` requires every field non-negative, the total to equal `unitsToLose`, and
 * `player.production.canAdjust(Units.negative(units))` - i.e. subtracting `units` from current
 * production must not take any resource below its floor. Every non-megacredit production floors
 * at 0; megacredit production floors at -5 (`Production extends BaseStock` with `minMegacredits =
 * -5`, src/server/player/Production.ts), so the *available* steps to lose there are
 * `production.megacredits + 5`, not `production.megacredits` - reading straight off
 * `production.canAdjust`'s own predicate rather than re-deriving it. We read the live production
 * off `raw.player` (the same object `canAdjust` will be checked against) rather than the model,
 * mirroring `payment.ts`'s preference for the live input over its serialized model.
 *
 * As with `resources`, this is sampled bucket-by-bucket via {@link sampleBoundedComposition},
 * this time with each bucket capped at the production actually available in it, so the sampled
 * distribution can never ask to lose more of a resource than the player has to lose.
 */
export const enumerateProductionToLose: DecisionEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'productionToLose') {
    throw new Error(`enumerateProductionToLose called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const input = decision.raw as SelectProductionToLose;
  const production = input.player.production;
  const capacities = Units.keys.map((key) => key === 'megacredits' ? production.megacredits + 5 : Math.max(0, production[key]));
  const units = unitsFromAmounts(sampleBoundedComposition(rng, input.unitsToLose, capacities));
  return {type: 'productionToLose', units};
};

/**
 * Distributes `total` indivisible steps across `capacities.length` buckets (in `Units.keys`
 * order), each capped at its own `capacities[i]`, sampled bucket-by-bucket per FR-ACT-4 rather
 * than by materializing the combinatorial space of legal distributions:
 *
 * At bucket `i`, the amount assigned is drawn uniformly from
 * `[max(0, remaining - capacityOfBucketsAfter(i)), min(capacities[i], remaining)]` - the lower
 * bound guarantees the buckets that come after `i` can still absorb whatever is left over (so the
 * process always lands on exactly `total`, never short), and the upper bound respects both this
 * bucket's own capacity and the amount actually left to place. `total` must not exceed the sum of
 * all capacities (guaranteed by the Engine only ever offering a decision the player can actually
 * satisfy) - checked up front so a violation surfaces as a clear diagnostic rather than an
 * out-of-range `intInRange` call partway through.
 */
function sampleBoundedComposition(rng: AgentRandom, total: number, capacities: ReadonlyArray<number>): number[] {
  const suffixCapacity: number[] = new Array(capacities.length + 1).fill(0);
  for (let i = capacities.length - 1; i >= 0; i--) {
    suffixCapacity[i] = suffixCapacity[i + 1] + capacities[i];
  }
  if (total > suffixCapacity[0]) {
    throw new Error(`sampleBoundedComposition: total ${total} exceeds the sum of capacities ${suffixCapacity[0]}`);
  }

  const amounts: number[] = [];
  let remaining = total;
  for (let i = 0; i < capacities.length; i++) {
    const capacityAfter = suffixCapacity[i + 1];
    const min = Math.max(0, remaining - capacityAfter);
    const max = Math.min(capacities[i], remaining);
    const amount = rng.intInRange(min, max);
    amounts.push(amount);
    remaining -= amount;
  }
  return amounts;
}

/** Zips an amounts array (in `Units.keys` order) back into a `Units`. */
function unitsFromAmounts(amounts: ReadonlyArray<number>): Units {
  const units = {} as Units;
  Units.keys.forEach((key, i) => {
    units[key] = amounts[i];
  });
  return units;
}
