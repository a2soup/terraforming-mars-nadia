import {InputResponse} from '@/common/inputs/InputResponse';
import {EmbeddedDecisionPoint} from '../../driver/decisionPoint';
import {AgentRandom} from '../rng';

/**
 * The recursion entry point handed to composite enumerators. It is the top-level
 * {@link enumerate} (enumerator/index.ts) bound over the same rng, so a composite decision
 * (`or` / `and` / `initialCards` / `projectCard`) can produce legal responses for its
 * sub-decisions without importing the dispatch module directly (which would be circular and
 * harder to unit-test). A composite builds each child's {@link EmbeddedDecisionPoint} with
 * `toDecisionPoint(player, childRawInput)` (driver/decisionPoint.ts) and calls this.
 */
export type EnumerateFn = (decision: EmbeddedDecisionPoint, rng: AgentRandom) => InputResponse;

/**
 * A per-decision-type move generator: the unit of work each Milestone-1 sub-task implements
 * and registers in the dispatch table (enumerator/index.ts). The dispatch guarantees
 * `decision.model.type` matches this enumerator's type before calling it, so implementations
 * may narrow on that.
 *
 * **Contract (SRS FR-ACT-1..4, FR-9):**
 * - Returns exactly one **uniformly-random legal** move for `decision`. "Legal" means the
 *   Engine's own `PlayerInput.process()` for this decision accepts the response on the first
 *   submission - that, not our own belief about the rules, is the definition, and every test
 *   asserts against `process()`.
 * - For decision types whose naive legal set is combinatorial - `payment`, and composite
 *   `and` / `or` / `projectCard`-with-payment, plus the `card` / `resources` /
 *   `productionToLose` distributions - the move is generated **through the FR-ACT-4
 *   factorization**: sample each factor in turn (a branch, then its contents; a card, then a
 *   payment for it; a legal count, then an assignment). Never materialize the full
 *   cross-product.
 * - Must **always** succeed for an in-scope decision (never throw, never stall): there is
 *   always at least one legal move, and the enumerator must find one (FR-9). Payment reduces
 *   to a canonical cheapest-legal allocation (FR-ACT-3); see the Milestone-1 simplification
 *   note in agent/docs/Running_Notes.md (2026-07-22) - a single canonical payment now, a set
 *   of strategic variants deferred to Milestone 3.
 *
 * `recurse` is supplied for composite/nested types; leaf enumerators ignore it.
 *
 * (Milestone 1 needs one sampled move per decision. The same per-type factorization is where
 * a future reduced-candidate enumeration for search - Milestone 4 - and the hierarchical
 * policy head - Milestone 6 - will hang; this signature is expected to grow a candidate-set
 * method then, reusing the very same factor structure.)
 */
export type DecisionEnumerator = (
  decision: EmbeddedDecisionPoint,
  rng: AgentRandom,
  recurse: EnumerateFn,
) => InputResponse;

/**
 * Thrown for an **in-scope** decision type (SRS §3.3) that does not yet have a registered
 * enumerator. Distinct from {@link OutOfScopeDecisionError} so a partially-built enumerator
 * (Milestone 1 is delivered as several sub-tasks) reports "not built yet" rather than looking
 * like a genuine unsupported-decision bug.
 */
export class NotYetImplementedDecisionError extends Error {
  constructor(public readonly decision: EmbeddedDecisionPoint) {
    super(`No enumerator yet for in-scope decision type '${decision.model.type}' (player ${decision.player.id}).`);
  }
}

/**
 * Thrown for a decision type belonging to an out-of-scope expansion (Venus, Colonies,
 * Turmoil, Ares, Underworld, ...). These should not arise in the base + Corporate Era +
 * Prelude scope (CLAUDE.md §1); if one does, that is a scope/coverage finding to record, not
 * something to silently paper over. The random-legal agent's FR-9 graceful-fallback handling
 * of this case is added with the agent (Milestone 1, final sub-task).
 */
export class OutOfScopeDecisionError extends Error {
  constructor(public readonly decision: EmbeddedDecisionPoint) {
    super(`Decision type '${decision.model.type}' is an out-of-scope expansion (player ${decision.player.id}).`);
  }
}
