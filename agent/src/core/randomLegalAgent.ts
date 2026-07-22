import {EmbeddedResponder} from '../driver/responder';
import {AgentRandom} from './rng';
import {enumerate} from './enumerator';

/**
 * The random-legal agent (SRS Milestone 1, bullet 3): at each decision it asks the
 * legal-action enumerator for a uniformly-random legal move and submits it. It is the first,
 * simplest inhabitant of the decision core - the baseline every stronger agent is measured
 * against (Milestone 2) and the driver the simulator-speed spike runs on.
 *
 * It is an {@link EmbeddedResponder} (not a portable `Responder`): the enumerator reads the
 * local Engine `IPlayer` to compute legal payments and resource distributions, which is
 * sound in both embedded and live-play modes because search always runs over a locally
 * instantiated Engine state (SRS FR-INT-3/FR-INT-6, CLAUDE.md §4).
 *
 * Determinism (Milestone 1 exit criterion): the move sequence is a pure function of the
 * `rng` stream, so a fixed agent seed - independent of the Engine seed (SRS CON-5) - replays
 * identical games.
 *
 * Scope of this shell (sub-task A): it delegates to {@link enumerate}, which currently answers
 * `option` and reports every other in-scope type as not-yet-implemented. The remaining
 * enumerators (sub-tasks B/C/D), the per-decision logging (SRS FR-11/NFR-6), and the
 * graceful-fallback handling of any out-of-scope decision (FR-9) land with the final
 * integration sub-task (E).
 */
export function randomLegalAgent(rng: AgentRandom): EmbeddedResponder {
  return (decision) => enumerate(decision, rng);
}
