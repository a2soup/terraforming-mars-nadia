import {DecisionEnumerator} from './types';

/**
 * Enumerators for the "simple" decision types - those whose legal set is a short, directly
 * enumerable list (no payment math, no nested sub-decisions).
 *
 * Milestone 1 sub-task B fills in the rest of this file: `space`, `player`, `resource` (pick
 * one from the offered set), `amount` (an integer in [min, max]), and `card` (a subset of
 * size [min, max]). `option` lives here as the first, trivial member - it also proves out the
 * dispatch wiring (enumerator/index.ts) end to end.
 */

/**
 * `option` (SelectOption, src/server/inputs/SelectOption.ts): a single confirm/take. The
 * Engine accepts exactly one response shape and ignores everything else about the model, so
 * there is precisely one legal move regardless of the rng.
 */
export const enumerateOption: DecisionEnumerator = () => {
  return {type: 'option'};
};

/**
 * `space` (SelectSpace, src/server/inputs/SelectSpace.ts): choose a board space from the
 * offered list. `SelectSpace.process` only checks membership (`spaceId` is one of
 * `this.spaces`), so every offered space is equally legal - pick uniformly.
 */
export const enumerateSpace: DecisionEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'space') {
    throw new Error(`enumerateSpace called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {type: 'space', spaceId: rng.pick(model.spaces)};
};

/**
 * `player` (SelectPlayer, src/server/inputs/SelectPlayer.ts): choose one of the offered
 * players by color. `SelectPlayer.process` only checks membership, so every offered player is
 * equally legal - pick uniformly. (The response field is typed `ColorWithNeutral` because the
 * same response shape is reused by the out-of-scope `delegate` decision, which can also target
 * the neutral seat; `model.players` here is always a plain `Color`, which widens into it
 * without loss.)
 */
export const enumeratePlayer: DecisionEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'player') {
    throw new Error(`enumeratePlayer called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {type: 'player', player: rng.pick(model.players)};
};

/**
 * `resource` (SelectResource, src/server/inputs/SelectResource.ts): choose one resource type
 * from the offered set. `SelectResource.process` only checks that the choice is in
 * `this.include`, so every offered resource is equally legal - pick uniformly.
 */
export const enumerateResource: DecisionEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'resource') {
    throw new Error(`enumerateResource called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {type: 'resource', resource: rng.pick(model.include)};
};

/**
 * `amount` (SelectAmount, src/server/inputs/SelectAmount.ts): choose an integer amount.
 * `SelectAmount.process` accepts anything with `min <= amount <= max`, so every integer in
 * that inclusive range is equally legal - sample uniformly with `rng.intInRange`.
 */
export const enumerateAmount: DecisionEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'amount') {
    throw new Error(`enumerateAmount called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {type: 'amount', amount: rng.intInRange(model.min, model.max)};
};

/**
 * `card` (SelectCard, src/server/inputs/SelectCard.ts): choose between `min` and `max`
 * distinct cards from the offered list. `SelectCard.process` checks only the count (within
 * [min, max]) and that every named card is in the offered list (`getCardFromPlayerInput`) - it
 * does *not* check affordability (see the `card` affordability caveat in
 * agent/docs/Milestone1_Subtask_Prompts.md, Sub-task B), so any k-subset of the offered cards
 * is legal at this input regardless of whether a later payment for those cards would succeed.
 * We deliberately don't second-guess that here - affordability fallout, if any, is for the
 * random-legal agent's integration batch (Sub-task E) to observe, not for this enumerator to
 * pre-empt with game-rule logic of its own.
 *
 * The naive legal set here is combinatorial (every subset of every size in [min, max]), so per
 * FR-ACT-4 this is generated through an explicit two-factor sample rather than materialized:
 * first a count `k` in [min, max] (clamped to the number of cards actually on offer - `k`
 * cannot exceed `cards.length` since the chosen cards must be distinct), then `k` distinct
 * cards without replacement. The "distinct without replacement" factor is done with a partial
 * Fisher-Yates shuffle of the card indices, taking the first `k` - this draws a uniformly
 * random k-subset while touching only `k` array slots, never the full `C(cards.length, k)`
 * subset space.
 */
export const enumerateCard: DecisionEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'card') {
    throw new Error(`enumerateCard called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const {cards, min, max} = model;
  // Can't select more distinct cards than are on offer, even if `max` says otherwise.
  const upperBound = Math.min(max, cards.length);
  const count = rng.intInRange(min, upperBound);

  const indices = cards.map((_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + rng.nextInt(indices.length - i);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return {type: 'card', cards: indices.slice(0, count).map((i) => cards[i].name)};
};
