import {PlayerInputModel} from '@/common/models/PlayerInputModel';
import {DecisionEnumerator, EnumerateFn, NotYetImplementedDecisionError, OutOfScopeDecisionError} from './types';
import {enumerateAmount, enumerateCard, enumerateOption, enumeratePlayer, enumerateResource, enumerateSpace} from './simple';

export {NotYetImplementedDecisionError, OutOfScopeDecisionError} from './types';
export type {DecisionEnumerator, EnumerateFn} from './types';

type ModelType = PlayerInputModel['type'];

/**
 * Whether each decision type the Engine can present is in the Agent's scope (base + Corporate
 * Era + Prelude; SRS §3.3, CLAUDE.md §5) or belongs to an out-of-scope expansion.
 *
 * This is a total `Record` on purpose: if the Engine pin ever adds or renames a decision type,
 * this stops compiling, forcing a re-verification of the action model against the new pin
 * (CLAUDE.md §5, "re-verify against the pin") rather than silently mis-routing it.
 */
const SCOPE: Record<ModelType, 'inScope' | 'outOfScope'> = {
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
};

/**
 * The dispatch table: one {@link DecisionEnumerator} per in-scope decision type. Milestone 1's
 * sub-tasks populate this incrementally, each owning its own per-group module so this file
 * needs no further edits and parallel work never collides here:
 * - `simple.ts` (B): option [done], space, player, resource, amount, card
 * - `payment.ts` (C): payment, projectCard
 * - `composite.ts` (D): or, and, initialCards, resources, productionToLose
 *
 * A type that is in scope but absent here yields {@link NotYetImplementedDecisionError}; an
 * out-of-scope type yields {@link OutOfScopeDecisionError}.
 */
const ENUMERATORS: Partial<Record<ModelType, DecisionEnumerator>> = {
  option: enumerateOption,
  space: enumerateSpace,
  player: enumeratePlayer,
  resource: enumerateResource,
  amount: enumerateAmount,
  card: enumerateCard,
};

/**
 * Produces one uniformly-random legal move for a decision (SRS FR-ACT-1..4, FR-9), routing to
 * the enumerator for its type. Also the recursion entry point composite enumerators receive,
 * so nested sub-decisions are answered by exactly the same dispatch.
 */
export const enumerate: EnumerateFn = (decision, rng) => {
  const type = decision.model.type;
  const enumerator = ENUMERATORS[type];
  if (enumerator !== undefined) {
    return enumerator(decision, rng, enumerate);
  }
  if (SCOPE[type] === 'outOfScope') {
    throw new OutOfScopeDecisionError(decision);
  }
  throw new NotYetImplementedDecisionError(decision);
};
