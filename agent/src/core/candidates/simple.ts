import {InputResponse} from '@/common/inputs/InputResponse';
import {AgentRandom} from '../rng';
import {CandidateDraft, DecisionCandidateEnumerator} from './types';

/**
 * Candidate sets for the "simple" decision types - the ones whose legal set is a short,
 * directly enumerable list (no payment math, no nested sub-decisions). Mirrors
 * `core/enumerator/simple.ts` one-for-one and imports nothing from it: those enumerators
 * *sample* one element, these *enumerate* the offered elements.
 *
 * Per §3.5's pre-committed table:
 *
 * | Type | Candidate set |
 * | --- | --- |
 * | `option` | The single legal response. |
 * | `space`, `player`, `resource` | Every offered element. |
 * | `amount` | `min`, `max`, and up to 6 evenly-spaced interior values. |
 * | `card` | Singletons plus the minimum- and maximum-size subsets. |
 *
 * The first three rows are exhaustive and therefore ignore the rng; the last two are the two
 * places a reduction is applied, and each says below which factor it enumerates over and why.
 */

/**
 * How many interior values an `amount` candidate set carries between `min` and `max` (§3.5).
 * Ranges are usually tiny - and when `max - min - 1 <= 6` every interior value is included, so
 * the set is exhaustive - but `SelectAmount` has no upper bound in principle (a "how much heat
 * do you want to spend" input scales with the player's stock), and this bounds the pathological
 * case without a special case for it.
 */
const MAX_INTERIOR_AMOUNTS = 6;

/**
 * `option` (SelectOption): the Engine accepts exactly one response shape and ignores everything
 * else about the model, so there is precisely one candidate. This is the row that makes "the
 * pass branch is always available" true for the greedy agent (§3.1's behavioural prediction that
 * it will pass rather than take a VP-negative action rests on it).
 */
export const optionCandidates: DecisionCandidateEnumerator = () => {
  return {candidates: [{type: 'option'}]};
};

/**
 * `space` (SelectSpace): every offered space. `SelectSpace.process` only checks membership, so
 * the whole offered list is legal, and per §2.6 this is a genuinely VP-bearing decision - a
 * greenery adjacent to one of your own cities is worth 2 points, not 1, which is most of what
 * saves points-now from indifference. Enumerating the full list here is the whole reason the
 * baseline can see that at all.
 */
export const spaceCandidates: DecisionCandidateEnumerator = (decision) => {
  const {model} = decision;
  if (model.type !== 'space') {
    throw new Error(`spaceCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {candidates: model.spaces.map((spaceId) => ({type: 'space', spaceId}))};
};

/**
 * `player` (SelectPlayer): every offered player. `SelectPlayer.process` only checks membership.
 * (The response field is typed `ColorWithNeutral` because the same response shape is reused by
 * the out-of-scope `delegate` decision; `model.players` here is always a plain `Color`, which
 * widens into it without loss - the same note `enumeratePlayer` carries.)
 */
export const playerCandidates: DecisionCandidateEnumerator = (decision) => {
  const {model} = decision;
  if (model.type !== 'player') {
    throw new Error(`playerCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {candidates: model.players.map((player) => ({type: 'player', player}))};
};

/**
 * `resource` (SelectResource): every offered resource. `SelectResource.process` only checks that
 * the choice is in `include`.
 */
export const resourceCandidates: DecisionCandidateEnumerator = (decision) => {
  const {model} = decision;
  if (model.type !== 'resource') {
    throw new Error(`resourceCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {candidates: model.include.map((resource) => ({type: 'resource', resource}))};
};

/**
 * `amount` (SelectAmount): `min`, `max`, and up to {@link MAX_INTERIOR_AMOUNTS} evenly-spaced
 * interior values (§3.5). `SelectAmount.process` accepts any integer in `[min, max]`, so the
 * naive set is the whole range - short in practice, unbounded in principle.
 *
 * **The factor enumerated is the amount itself, thinned rather than sampled**, because the two
 * ends are where the signal is: an `amount` decision is nearly always "spend up to N of
 * something", and points-now (§3.1) is monotone in it - the argmax is at an endpoint far more
 * often than in the middle. Thinning keeps both endpoints exactly and spaces the rest, which is
 * strictly better than a uniform sample of the same size (which can miss `max` entirely).
 *
 * When the range is small enough that every interior value fits, the set is exhaustive: with
 * `interior = min(6, max - min - 1)`, the spacing formula lands on consecutive integers.
 */
export const amountCandidates: DecisionCandidateEnumerator = (decision) => {
  const {model} = decision;
  if (model.type !== 'amount') {
    throw new Error(`amountCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const {min, max} = model;
  if (max < min) {
    // The Engine does not offer an empty range (SelectAmount is constructed with min <= max, and
    // `enumerateAmount`'s intInRange would throw on one), so this is a diagnostic, not a path.
    throw new Error(`amountCandidates: SelectAmount offered an empty range [${min}, ${max}] to player ${decision.player.id}`);
  }

  const span = max - min;
  const interior = Math.min(MAX_INTERIOR_AMOUNTS, Math.max(0, span - 1));
  const amounts = new Set<number>([min, max]);
  for (let i = 1; i <= interior; i++) {
    amounts.add(Math.round(min + (span * i) / (interior + 1)));
  }

  return {candidates: [...amounts].sort((a, b) => a - b).map((amount) => ({type: 'amount', amount}))};
};

/**
 * `card` (SelectCard): choose between `min` and `max` distinct cards from the offered list.
 * `SelectCard.process` checks only the count and that every named card is on offer - it does
 * *not* check affordability (the Milestone-1 affordability caveat; `enumerateCard`'s doc comment
 * has the full account), so any k-subset is legal at this input.
 *
 * **Every k-subset is combinatorial, so this enumerates over one factor: which single card**
 * (§3.5). The set is
 *
 * - every **singleton** - one candidate per offered card, when a 1-card selection is in range;
 * - the **minimum-size** subset (the empty selection when `min === 0`, which is how "decline"
 *   stays reachable);
 * - the **maximum-size** subset.
 *
 * The two bulk subsets are drawn from a *single* sampled permutation, so they are nested
 * (the min-size subset is a prefix of the max-size one) and cost one shuffle rather than two.
 * That is the deliberate analogue of `enumerateCard`'s partial Fisher-Yates: the candidate
 * version of "draw a k-subset without touching the subset space" is "cap plus subsample", never
 * an expansion (§2.2).
 *
 * What this trades away, recorded so it is not rediscovered as a surprise: a greedy agent
 * choosing *which two* cards to keep from a discard-down-to-two decision sees only singletons
 * and the two bulk subsets, not all `C(n, 2)` pairs. Under points-now (§3.1) that costs
 * essentially nothing, because a card selection almost never changes current VP at all - it is
 * one of the decisions the appendix predicts will be entirely tie-broken. A Milestone-3 agent
 * with an economy term will want a richer set here, and this is the file it will grow in.
 */
export const cardCandidates: DecisionCandidateEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'card') {
    throw new Error(`cardCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const {cards, min} = model;
  // Can't select more distinct cards than are on offer, even if `max` says otherwise - the same
  // clamp `enumerateCard` applies, for the same reason.
  const upperBound = Math.min(model.max, cards.length);
  if (upperBound < min) {
    throw new Error(`cardCandidates: SelectCard offered ${cards.length} card(s) but requires at least ${min} to player ${decision.player.id}`);
  }

  const order = samplePermutation(rng, cards.length);
  const names = (count: number) => order.slice(0, count).map((i) => cards[i].name);

  const drafts: Array<InputResponse> = [{type: 'card', cards: names(min)}];
  if (min <= 1 && upperBound >= 1) {
    for (const card of cards) {
      drafts.push({type: 'card', cards: [card.name]});
    }
  }
  drafts.push({type: 'card', cards: names(upperBound)});

  return dedupe(drafts);
};

/**
 * A uniformly-random permutation of `[0, length)` by Fisher-Yates over the agent rng. Used for
 * the bulk `card` subsets: taking prefixes of one permutation gives nested uniform subsets of
 * every size at the cost of a single shuffle.
 */
export function samplePermutation(rng: AgentRandom, length: number): Array<number> {
  const indices = Array.from({length}, (_, i) => i);
  for (let i = 0; i < length - 1; i++) {
    const j = i + rng.nextInt(length - i);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

/**
 * Drops duplicate candidates, keeping first-seen order. Needed because the reductions above
 * overlap at the edges by construction - `min === 1` makes the minimum-size subset one of the
 * singletons, `min === max` collapses both bulk subsets onto each other - and a duplicate
 * candidate is a fork, a drain and a score paid twice for the same position.
 *
 * Keyed on `JSON.stringify`, which is exact rather than heuristic here: every response this
 * module builds is a plain object with a fixed key order (the `Payment` allocations in
 * `candidates/payment.ts` come from `Payment.EMPTY`-shaped literals, the `Units` in
 * `candidates/composite.ts` from `Units.keys` order), so structural equality and string equality
 * coincide.
 */
export function dedupe(responses: ReadonlyArray<InputResponse>): CandidateDraft {
  const seen = new Set<string>();
  const candidates: Array<InputResponse> = [];
  for (const response of responses) {
    const key = JSON.stringify(response);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(response);
    }
  }
  return {candidates};
}
