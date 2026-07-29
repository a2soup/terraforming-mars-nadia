import {InputResponse} from '@/common/inputs/InputResponse';
import {ICorporationCard} from '@/server/cards/corporation/ICorporationCard';
import {IProjectCard} from '@/server/cards/IProjectCard';
import {OrOptions} from '@/server/inputs/OrOptions';
import {SelectCard} from '@/server/inputs/SelectCard';
import {SelectInitialCards} from '@/server/inputs/SelectInitialCards';
import {UndoActionOption} from '@/server/inputs/UndoActionOption';
import {EmbeddedDecisionPoint, toDecisionPoint} from '../../driver/decisionPoint';
import {enumerate} from '../enumerator';
import {enumerateInitialCards} from '../enumerator/composite';
import {EnumerateFn} from '../enumerator/types';
import {AgentRandom} from '../rng';
import {dedupe, samplePermutation} from './simple';
import {CANDIDATE_CAP, CandidateDraft, DecisionCandidateEnumerator} from './types';

/**
 * Candidate sets for the composite decision types - `or` (OrOptions), `and` (AndOptions),
 * `initialCards` (SelectInitialCards) - and the two resource-distribution types, `resources`
 * (SelectResources) and `productionToLose` (SelectProductionToLose). Mirrors
 * `core/enumerator/composite.ts`.
 *
 * This is the file where "never materialize a cross-product" does most of its work, and the
 * three composites resolve it three different ways for three different reasons:
 *
 * - **`or` is a union, not a product** - only one branch is taken, so the candidate set is the
 *   *sum* of the branches' sets, which is bounded by construction. It is therefore expanded.
 * - **`and` is a genuine product** - every child is answered, so expanding it multiplies. It gets
 *   one candidate with each child sampled once.
 * - **`initialCards` is a product with one factor that matters** - the corporation and the number
 *   of project cards bought, with the cards themselves sampled.
 */

/**
 * How many draws a `resources` / `productionToLose` candidate set takes from the enumerator's
 * distribution. Duplicates are dropped afterwards, so the set is usually smaller than this.
 */
const COMPOSITION_SAMPLES = CANDIDATE_CAP;

/**
 * `or` (OrOptions): **every branch, expanded into its own candidates** - the union of the
 * branches' candidate sets, each wrapped as `{type: 'or', index, response}`. `OrOptions.process`
 * accepts any `{index, response}` with `index` in range and `response` accepted by
 * `options[index].process`, so this is legal exactly when the child candidates are.
 *
 * `UndoActionOption` branches are filtered out *before* expanding, never sampled-then-retried -
 * the embedded driver rejects an Undo selection outright (there is no save history to restore
 * against a headless game), so offering the greedy agent a branch it may not take would be a
 * candidate that is legal to the Engine and illegal to the driver.
 *
 * **Reading of §3.5's `or` row, recorded because the row is ambiguous and the two readings
 * produce very different agents.** The row says "One candidate per branch, with the branch's own
 * contents produced by one sampled child response, not a cross-product." Read literally - one
 * sampled response per branch - the action-phase decision (a single `OrOptions` whose branches
 * are play-a-card, standard projects, claim a milestone, fund an award, convert plants, convert
 * heat, pass) would offer the agent exactly one *randomly chosen* card to play, and the
 * `projectCard` row's own text - "one candidate per playable card ... this is the important set,
 * it is where most of the agent's strength lives" - could never take effect, because a
 * `projectCard` decision is only ever reached as a branch of this `or`. Two further parts of the
 * plan settle it: the 64-candidate cap and its "count of capped decisions" diagnostic (§3.5, G7)
 * only mean something if a decision can generate tens of candidates, and §2.8's cost model - "a
 * greedy decision costs roughly `candidates x (fork + drain + score)`", predicting 2-3 orders of
 * magnitude over random play - matches a set of tens, not of eight. So the union reading is the
 * one implemented, and "not a cross-product" is taken to forbid *crossing* branches (or crossing
 * a branch's own sub-factors, which the `and` row handles), not to forbid expanding them. Flagged
 * for Unit D as a plan ambiguity resolved here, not a decision re-litigated.
 *
 * A branch that produces no candidates is simply not offered. That is not an error and not rare:
 * the standard-projects branch is offered by the Engine whether or not anything in it is actable
 * and affordable, and `candidates/payment.ts` reports "nothing playable" as an empty set. The
 * driver's FR-9 fallback resolves the same situation by trying the next branch; doing it here
 * means the greedy agent never even considers a branch it could not complete. A branch whose
 * generation *throws*, by contrast, propagates - the only ways that happens are an out-of-scope
 * nested type (a scope finding, which must stay loud, exactly as `enumerateOr` leaves it) and the
 * impossible-state diagnostics the leaf generators carry.
 */
export const orCandidates: DecisionCandidateEnumerator = (decision, rng, recurse) => {
  const {model, player} = decision;
  if (model.type !== 'or') {
    throw new Error(`orCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const raw = decision.raw as OrOptions;
  const eligible = raw.options
    .map((option, index) => ({option, index}))
    .filter(({option}) => !(option instanceof UndoActionOption));
  if (eligible.length === 0) {
    // Mirrors `enumerateOr`'s identical guard: every real OrOptions offers at least one non-Undo
    // branch, so this would mean the Engine offered nothing to do (FR-9).
    throw new Error(`orCandidates: every branch is UndoActionOption among ${raw.options.length} offered to player ${player.id}`);
  }

  const candidates: Array<InputResponse> = [];
  let nestedCappedNodes = 0;
  for (const {option, index} of eligible) {
    const childSet = recurse(toDecisionPoint(player, option), rng);
    nestedCappedNodes += childSet.cappedNodes;
    for (const response of childSet.candidates) {
      candidates.push({type: 'or', index, response});
    }
  }
  return {candidates, nestedCappedNodes};
};

/**
 * `and` (AndOptions): **one candidate, each child sampled once** (§3.5). `AndOptions.process`
 * requires one response per child, in order, so the candidate set over an `and` is the genuine
 * cross-product of its children's sets - unbounded, and worth almost nothing: an `and` in this
 * scope bundles sub-choices of a single already-chosen action (place a tile *and* pick a
 * resource), where the interaction between the children is exactly the kind of thing points-now
 * cannot see anyway (§3.1).
 *
 * Produced by running the Milestone-1 enumerator over the whole composite, which is precisely
 * "each child sampled once" and reuses the recursion that has been driving legal play since
 * Milestone 1 rather than restating it.
 */
export const andCandidates: DecisionCandidateEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'and') {
    throw new Error(`andCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {candidates: [enumerate(decision, rng)]};
};

/**
 * `initialCards` (SelectInitialCards): **corporation x project-card count**, with the cards
 * themselves sampled and the corporation-budget cap enforced (§3.5, §2.2).
 *
 * The enumerated factors are the two that a strategy could care about - which corporation, and
 * how many cards to buy at 3 M€ each. Which *specific* cards are bought is sampled once and
 * shared by every candidate, so the candidates differ only in the enumerated factors: the set is
 * `corporations x counts`, not `corporations x C(10, k)`. The single sampled ordering also makes
 * the counts nested (buying k+1 cards means buying the same k plus one more), which is the same
 * "one shuffle, take prefixes" device `cardCandidates` uses.
 *
 * **The budget cap is applied by the Milestone-1 code, not restated here.** `SelectInitialCards`
 * has the one coupling in the game where a child's legality depends on a *sibling* response:
 * `completed()` rejects the whole composite when the chosen project cards cost more than the
 * chosen corporation's starting M€, which no per-input check can see. `enumerateInitialCards`
 * already enforces it by truncating the project selection to `affordableCardCount(player, corp)`
 * - the fix the Milestone-1 AC-1 run added after measuring 59 real illegal moves from it, at ~1
 * per 25 games. Rather than mirror that arithmetic (and risk it drifting), this drives
 * `enumerateInitialCards` itself with a `recurse` that returns the intended response for each
 * child in order, and lets it do the truncation. Candidates that collapse onto each other
 * because two counts truncate to the same cap are removed by {@link dedupe}, which is why the
 * set is typically far smaller than `corporations x (max + 1)`.
 *
 * Under points-now this decision is predicted to be entirely tie-broken - every in-scope
 * corporation starts at the same TR and a bought card is worth no victory points at the moment
 * of buying (§3.1, appendix prediction 2). The set is enumerated properly anyway: predicting a
 * tie is not the same as arranging one, and the tie-break fraction (G7) is only meaningful if
 * the agent genuinely had alternatives to be indifferent between.
 */
export const initialCardsCandidates: DecisionCandidateEnumerator = (decision, rng) => {
  const {model, player} = decision;
  if (model.type !== 'initialCards') {
    throw new Error(`initialCardsCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  const raw = decision.raw as SelectInitialCards;

  // One sampled response per child. Every candidate starts from these and overrides only the
  // corporation and the project-card count, so the prelude (and, out of scope, CEO) selections
  // are held fixed across the set rather than crossed with it.
  const sampled = raw.options.map((option) => enumerate(toDecisionPoint(player, option), rng));

  const corpInput = raw.inputs.corp;
  const projectInput = raw.inputs.project;
  if (corpInput === undefined || projectInput === undefined) {
    // Not reachable for a base + Corporate Era + Prelude game (SelectInitialCards always pushes
    // both), but the Engine's own `Inputs` type makes them optional, so degrade to the sampled
    // response rather than assuming.
    return {candidates: [{type: 'initialCards', responses: sampled}]};
  }
  const corpIndex = raw.options.indexOf(corpInput);
  const projectIndex = raw.options.indexOf(projectInput);

  const corporations = (corpInput as SelectCard<ICorporationCard>).cards;
  const projectCards = (projectInput as SelectCard<IProjectCard>).cards;
  const {min, max} = (projectInput as SelectCard<IProjectCard>).config;
  const order = samplePermutation(rng, projectCards.length);
  const upperBound = Math.min(max, projectCards.length);

  const drafts: Array<InputResponse> = [];
  for (const corporation of corporations) {
    for (let count = min; count <= upperBound; count++) {
      const responses = sampled.slice();
      responses[corpIndex] = {type: 'card', cards: [corporation.name]};
      responses[projectIndex] = {type: 'card', cards: order.slice(0, count).map((i) => projectCards[i].name)};

      // `enumerateInitialCards` visits `raw.options` in order, so a cursor over `responses` is
      // exactly the intended per-child answer. It then applies the corporation-budget truncation
      // to whatever the project child returned - which is the whole point of routing through it.
      let cursor = 0;
      const forced: EnumerateFn = () => responses[cursor++];
      drafts.push(enumerateInitialCards(decision, rng, forced));
    }
  }
  return dedupe(drafts);
};

/**
 * `resources` (SelectResources): **up to {@link COMPOSITION_SAMPLES} draws from
 * `sampleBoundedComposition`'s distribution**, deduplicated (§3.5). `SelectResources.process`
 * accepts any non-negative composition of `count` across the six `Units` keys, so the naive set
 * is `C(count + 5, 5)` - 3,003 distributions for a count of 10 - and enumerating it would spend
 * the entire per-decision budget on a decision that, under points-now, is nearly always a tie
 * (none of the six resources is worth a victory point).
 *
 * Sampling the enumerator's own distribution rather than writing a second one keeps the candidate
 * set drawn from exactly the space Milestone 1 validated against `process()`.
 */
export const resourcesCandidates: DecisionCandidateEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'resources') {
    throw new Error(`resourcesCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return sampleDistinct(decision, rng);
};

/**
 * `productionToLose` (SelectProductionToLose): the same reduction as `resources`, over the
 * distribution `enumerateProductionToLose` samples - which is capped per bucket at the production
 * the player actually has to lose, including the -5 megacredit-production floor. Unlike
 * `resources` this decision is *not* usually a tie under points-now in a later generation, but
 * what separates the candidates is the production lost rather than any victory point, so the
 * sampled set is the right shape here too.
 */
export const productionToLoseCandidates: DecisionCandidateEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'productionToLose') {
    throw new Error(`productionToLoseCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return sampleDistinct(decision, rng);
};

/**
 * Draws {@link COMPOSITION_SAMPLES} responses from the Milestone-1 enumerator for `decision` and
 * returns the distinct ones. Stops early once the cap is reached; a decision whose legal set is
 * smaller than the sample count (a `count` of 0 or 1) simply yields that set.
 */
function sampleDistinct(decision: EmbeddedDecisionPoint, rng: AgentRandom): CandidateDraft {
  const drafts: Array<InputResponse> = [];
  for (let i = 0; i < COMPOSITION_SAMPLES; i++) {
    drafts.push(enumerate(decision, rng));
  }
  return dedupe(drafts);
}
