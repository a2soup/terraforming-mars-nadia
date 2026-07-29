import {InputResponse} from '@/common/inputs/InputResponse';
import {PlayerInputModel} from '@/common/models/PlayerInputModel';
import {EmbeddedDecisionPoint} from '../../driver/decisionPoint';
import {NotYetImplementedDecisionError, OutOfScopeDecisionError} from '../enumerator/types';
import {AgentRandom} from '../rng';

/**
 * The candidate-set contract - Milestone 2, bullet 2, Unit B
 * (agent/docs/Milestone2_Bullet2_Prompts.md §3.5).
 *
 * **What this is, and how it differs from `core/enumerator/`.** The Milestone-1 enumerator
 * answers "give me *one* uniformly-random legal move" (`DecisionEnumerator`). A one-ply agent
 * needs "give me *the set of moves worth considering*" - the same FR-ACT-4 factorization
 * applied a second time, for a different purpose. That method was expected to arrive at
 * Milestone 4 (`enumerator/types.ts`'s own closing note); it arrives here instead, because the
 * greedy one-ply baseline needs it.
 *
 * **Add, never modify** (§3.5, and the file-ownership table in §8). Everything here lives in
 * new files that *import from* `core/enumerator/` and edit none of it. Two hard reasons:
 *
 * - The committed 300-fingerprint determinism corpus (`agent/docs/data/determinism_corpus.json`)
 *   must be regenerated after any enumerator change - the Milestone-1 `initialCards` cap changed
 *   43 of its 300 configs. A candidate API that leaves `enumerate` byte-identical costs nothing;
 *   one that refactors the sampling path costs a corpus regeneration and destroys this bullet's
 *   ability to tell a real regression from its own churn. Criterion G1b is exactly that check.
 * - `random-legal@1`'s move distribution must not change, or its `version` is a lie and every
 *   Milestone-1 number - including AC-1 - stops describing the agent in the registry.
 *
 * A consequence worth stating plainly: where a candidate generator needs a reduction the
 * enumerator already implements (the canonical cheapest-legal payment, the `initialCards`
 * corporation-budget cap), it **drives the enumerator's own code** rather than restating it -
 * see `candidates/payment.ts` and `candidates/composite.ts` for the two places this happens and
 * how. Restating those reductions would be the same rules-duplication risk CON-1 exists to
 * avoid, one level up.
 *
 * **The one hard rule is unchanged from Milestone 1:** a candidate is legal iff the Engine's own
 * `process()` accepts it on first submission. Not our reading of the rules - criterion G1a
 * measures this against `process()` over real games, it is not asserted from the type system.
 */

/**
 * The global per-decision candidate cap (§3.5). Beyond it the set is uniformly subsampled and
 * the decision is counted as capped, for the G7 diagnostics.
 *
 * **Pre-committed as a design parameter**, before any measurement, precisely so it can never be
 * read as a performance patch applied after seeing a slow run. A greedy decision costs roughly
 * `candidates x (fork + drain + score)` at ~1 ms a fork (§2.8), so the cap is also the agent's
 * worst-case per-decision budget.
 */
export const CANDIDATE_CAP = 64;

/**
 * What a per-type generator returns: the raw list, before the {@link CANDIDATE_CAP} is applied.
 *
 * The cap deliberately lives in exactly one place - the dispatch (`candidates/index.ts`) - so no
 * generator can forget it and so the "how many decisions hit the cap" diagnostic (G7) is counted
 * once, centrally. `nestedCappedNodes` is how a composite generator reports capping that happened
 * *below* it (an `or` branch whose own set was subsampled), which the dispatch cannot see.
 */
export type CandidateDraft = {
  readonly candidates: ReadonlyArray<InputResponse>;
  /** Nodes strictly below this one whose own set was subsampled. Composites sum their children's. */
  readonly nestedCappedNodes?: number;
};

/**
 * A bounded set of legal candidate moves for one decision, plus the bookkeeping Unit C needs to
 * emit the G7 diagnostics without re-deriving anything.
 *
 * An **empty** `candidates` is a legal, expected outcome, not an error: a `projectCard` decision
 * whose offered cards are all unaffordable produces one (the Milestone-1 enumerator throws in
 * that case, and the driver's FR-9 fallback absorbs it - see `candidates/payment.ts`). The
 * consumer falls back to a random-legal move and counts it; it must never stall (SRS FR-9).
 */
export type CandidateSet = {
  readonly type: PlayerInputModel['type'];
  readonly candidates: ReadonlyArray<InputResponse>;
  /** How many were produced *before* this node's subsample; `>= candidates.length`. */
  readonly generated: number;
  /** Whether this node's own set was subsampled down to {@link CANDIDATE_CAP}. */
  readonly capped: boolean;
  /** This node plus every descendant whose set was subsampled - the count G7 aggregates. */
  readonly cappedNodes: number;
};

/**
 * The recursion entry point handed to composite candidate generators - the candidate-set
 * counterpart of the enumerator's `EnumerateFn`, and bound over the same rng for the same
 * reasons (a composite must be able to produce its children's candidates without importing the
 * dispatch module directly).
 */
export type CandidatesFn = (decision: EmbeddedDecisionPoint, rng: AgentRandom) => CandidateSet;

/**
 * A per-decision-type candidate generator - the unit of work `simple.ts` / `payment.ts` /
 * `composite.ts` implement and register in the dispatch table. The dispatch guarantees
 * `decision.model.type` matches before calling, so implementations may narrow on it, exactly as
 * the Milestone-1 enumerators do.
 *
 * **Contract:**
 * - Every returned response is **legal at this decision**: accepted by the Engine's own
 *   `process()` on first submission (G1a).
 * - **Never materialize a cross-product.** Where the naive set is combinatorial, the set ranges
 *   over *one* factor with the others sampled, and the generator's doc comment says which factor
 *   and why (§3.5's table is the pre-committed list).
 * - The rng is the Agent's own seeded stream (SRS CON-5, hazard H8). Generators that sample use
 *   it; generators that enumerate exhaustively ignore it.
 */
export type DecisionCandidateEnumerator = (
  decision: EmbeddedDecisionPoint,
  rng: AgentRandom,
  recurse: CandidatesFn,
) => CandidateDraft;

/**
 * Thrown for a decision type belonging to an out-of-scope expansion (Venus, Colonies, Turmoil,
 * Ares, Underworld, ...). Extends the enumerator's {@link OutOfScopeDecisionError} on purpose:
 * the embedded driver and the random-legal agent both key off that class to surface a scope
 * finding loudly instead of quietly papering over it (`embeddedDriver.ts` deliberately does
 * *not* apply the FR-9 fallback to it), and a candidate-path scope miss deserves exactly the
 * same treatment. Only the message is specialized.
 */
export class OutOfScopeCandidateError extends OutOfScopeDecisionError {
  constructor(decision: EmbeddedDecisionPoint) {
    super(decision);
    this.message = `Decision type '${decision.model.type}' is an out-of-scope expansion, so it has no candidate enumerator (player ${decision.player.id}).`;
  }
}

/**
 * Thrown for a decision type that is neither in `SCOPE` nor out of it - i.e. a type the Engine
 * presented that this module has never heard of.
 *
 * Unlike the Milestone-1 enumerator's version, this is **not** reachable by an in-scope type
 * being unimplemented: the candidate dispatch table is a *total* `Record` over the in-scope
 * types, so an unimplemented one fails to compile (a strictly stronger guarantee than M1's
 * incrementally-populated `Partial` needed, since M1 shipped the table across four sub-tasks and
 * this unit ships it at once). What it does guard is pin drift at runtime - a compiled build
 * meeting a decision type that was not in the union it was compiled against - which is precisely
 * the case where a clear error beats a silent mis-route.
 */
export class NotYetImplementedCandidateError extends NotYetImplementedDecisionError {
  constructor(decision: EmbeddedDecisionPoint) {
    super(decision);
    this.message = `No candidate enumerator for decision type '${decision.model.type}', which is in neither the in-scope nor the out-of-scope list (player ${decision.player.id}).`;
  }
}
