import {InputResponse} from '@/common/inputs/InputResponse';
import {PlayerInputModel} from '@/common/models/PlayerInputModel';
import {EmbeddedDecisionPoint} from '../../driver/decisionPoint';
import {AgentRandom} from '../rng';
import {andCandidates, initialCardsCandidates, orCandidates, productionToLoseCandidates, resourcesCandidates} from './composite';
import {paymentCandidates, projectCardCandidates} from './payment';
import {amountCandidates, cardCandidates, optionCandidates, playerCandidates, resourceCandidates, spaceCandidates} from './simple';
import {
  CANDIDATE_CAP,
  CandidateDraft,
  CandidateSet,
  CandidatesFn,
  DecisionCandidateEnumerator,
  NotYetImplementedCandidateError,
  OutOfScopeCandidateError,
} from './types';

export {CANDIDATE_CAP, NotYetImplementedCandidateError, OutOfScopeCandidateError} from './types';
export type {CandidateDraft, CandidateSet, CandidatesFn, DecisionCandidateEnumerator} from './types';

type ModelType = PlayerInputModel['type'];

/**
 * Whether each decision type the Engine can present is in the Agent's scope (base + Corporate
 * Era + Prelude; SRS §3.3) or belongs to an out-of-scope expansion.
 *
 * Deliberately a **duplicate** of `core/enumerator/index.ts`'s `SCOPE` rather than an import of
 * it: that file is not ours to change (§8), and the two tables answer different questions - "is
 * there a sampler for this type" and "is there a candidate set for this type" - which are equal
 * today and need not stay so. Like its twin, it is total on purpose: a decision type added or
 * renamed at a future Engine pin stops this file compiling, forcing a re-verification of the
 * action model rather than a silent mis-route.
 */
const SCOPE = {
  option: 'inScope',
  and: 'inScope',
  or: 'inScope',
  initialCards: 'inScope',
  projectCard: 'inScope',
  card: 'inScope',
  payment: 'inScope',
  space: 'inScope',
  player: 'inScope',
  amount: 'inScope',
  productionToLose: 'inScope',
  resource: 'inScope',
  resources: 'inScope',

  colony: 'outOfScope',
  delegate: 'outOfScope',
  party: 'outOfScope',
  globalEvent: 'outOfScope',
  aresGlobalParameters: 'outOfScope',
  claimedUndergroundToken: 'outOfScope',
  deltaProject: 'outOfScope',
} as const satisfies Record<ModelType, 'inScope' | 'outOfScope'>;

/** The thirteen in-scope decision types, derived from {@link SCOPE} rather than restated. */
export type InScopeModelType = {[K in ModelType]: (typeof SCOPE)[K] extends 'inScope' ? K : never}[ModelType];

/** Every in-scope decision type, as a value - the coverage denominator criterion G1c reports against. */
export const IN_SCOPE_TYPES: ReadonlyArray<InScopeModelType> =
  (Object.keys(SCOPE) as ReadonlyArray<ModelType>).filter(isInScope);

function isInScope(type: ModelType): type is InScopeModelType {
  return SCOPE[type] === 'inScope';
}

/**
 * The dispatch table: one {@link DecisionCandidateEnumerator} per in-scope decision type.
 *
 * Typed as a **total** `Record<InScopeModelType, ...>`, not the `Partial` its Milestone-1 twin
 * uses. That is not a style preference: M1 populated its table across four sub-tasks and needed
 * "in scope but not built yet" to be expressible, whereas this unit ships all thirteen at once,
 * so totality can be a compile-time guarantee instead of a runtime error - which is the
 * structural half of criterion G1c (every in-scope type has a candidate enumerator).
 */
const CANDIDATE_ENUMERATORS: Record<InScopeModelType, DecisionCandidateEnumerator> = {
  option: optionCandidates,
  space: spaceCandidates,
  player: playerCandidates,
  resource: resourceCandidates,
  amount: amountCandidates,
  card: cardCandidates,
  payment: paymentCandidates,
  projectCard: projectCardCandidates,
  or: orCandidates,
  and: andCandidates,
  initialCards: initialCardsCandidates,
  resources: resourcesCandidates,
  productionToLose: productionToLoseCandidates,
};

/**
 * Produces the bounded set of legal candidate moves for `decision` (SRS FR-ACT-1..4;
 * agent/docs/Milestone2_Bullet2_Prompts.md §3.5).
 *
 * This is the **public entry point**, and the one difference from {@link generate} - the
 * recursion entry composites receive - is that it deep-copies every candidate before handing it
 * out. That is deliberate, and it closes a hazard rather than being defensive for its own sake: a
 * one-ply agent submits its candidates into many independently restored forks and then submits
 * the winner into the live game, and `bench/forkCost.ts` records the same rule for recorded
 * responses ("replayed into many independently restored games; never share one object"). Within a
 * single set, candidates legitimately share sub-objects - an `or`'s branches wrap the same child
 * responses, an `initialCards` set shares one sampled prelude selection - so the copy is taken
 * once, at the boundary, instead of at every level of the recursion.
 *
 * The copy costs a JSON round trip over at most {@link CANDIDATE_CAP} small objects, against a
 * per-candidate fork/drain/score budget of ~1 ms (§2.8).
 */
export const candidates: CandidatesFn = (decision, rng) => {
  const set = generate(decision, rng);
  return {...set, candidates: set.candidates.map(copyResponse)};
};

/**
 * The internal dispatch and the recursion entry handed to composite generators: routes to the
 * generator for `decision`'s type and applies the {@link CANDIDATE_CAP} to whatever it drafted.
 * No copying - see {@link candidates} for where that happens and why it happens only once.
 */
const generate: CandidatesFn = (decision, rng) => {
  const type = decision.model.type;
  if (isInScope(type)) {
    return applyCap(decision, rng, CANDIDATE_ENUMERATORS[type](decision, rng, generate));
  }
  if (SCOPE[type] === 'outOfScope') {
    throw new OutOfScopeCandidateError(decision);
  }
  throw new NotYetImplementedCandidateError(decision);
};

/**
 * Applies the global {@link CANDIDATE_CAP}: beyond it the set is subsampled **uniformly**, and
 * the decision is counted as capped for the G7 diagnostics.
 *
 * Uniform, not "keep the ones that look promising", and pre-committed as such in §3.5 - a
 * heuristic here would be a hand-crafted feature by another name, which §1 puts out of scope for
 * this bullet, and it would bias what the frozen baseline can see in a way no later measurement
 * could untangle.
 *
 * The kept candidates are restored to their generated order rather than left in shuffled order,
 * so a set's order stays a property of the generators (min-then-singletons-then-max for `card`,
 * ascending for `amount`, branch order for `or`) whether or not the cap bit.
 */
function applyCap(decision: EmbeddedDecisionPoint, rng: AgentRandom, draft: CandidateDraft): CandidateSet {
  const type = decision.model.type;
  const generated = draft.candidates.length;
  const nestedCappedNodes = draft.nestedCappedNodes ?? 0;

  if (generated <= CANDIDATE_CAP) {
    return {type, candidates: draft.candidates, generated, capped: false, cappedNodes: nestedCappedNodes};
  }

  // Partial Fisher-Yates over the indices: a uniform CANDIDATE_CAP-subset while touching only
  // that many slots, never the C(generated, cap) subset space - the same device `enumerateCard`
  // uses to draw a k-subset, applied to candidates instead of cards.
  const indices = draft.candidates.map((_, i) => i);
  for (let i = 0; i < CANDIDATE_CAP; i++) {
    const j = i + rng.nextInt(indices.length - i);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const kept = indices.slice(0, CANDIDATE_CAP).sort((a, b) => a - b).map((i) => draft.candidates[i]);

  return {type, candidates: kept, generated, capped: true, cappedNodes: nestedCappedNodes + 1};
}

/** The same deep copy `bench/forkCost.ts` uses for recorded responses, for the same aliasing reason. */
function copyResponse(response: InputResponse): InputResponse {
  return JSON.parse(JSON.stringify(response)) as InputResponse;
}
