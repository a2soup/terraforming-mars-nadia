import {EmbeddedResponder} from '../driver/responder';
import {AgentRandom} from './rng';
import {enumerate, OutOfScopeDecisionError} from './enumerator';

export type RandomLegalAgentOptions = {
  /**
   * Per-decision trace logging (SRS FR-11 / NFR-6): for every decision, logs the player, the
   * decision type, and the chosen move via `console.log`. **Off by default** - a full game is
   * hundreds of decisions, and the default (tests, the Tier-1 batch) should stay quiet; turn
   * this on to inspect an individual game's move sequence.
   */
  logDecisions?: boolean;
};

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
 * identical games. Note that this only covers *this* agent's own choices: the embedded driver
 * (`embeddedDriver.ts`) may additionally resubmit a *different*, fully deterministic move of
 * its own (the FR-9 conservative fallback) when the Engine rejects one of this agent's moves -
 * that resubmission is no less deterministic (it depends only on the decision, never on any
 * rng), so overall game replay under a fixed engine seed + fixed agent seed remains exact.
 *
 * **FR-9 out-of-scope handling:** `enumerate` throws {@link OutOfScopeDecisionError} for a
 * decision type belonging to an out-of-scope expansion (Venus, Colonies, Turmoil, ...). That
 * should never happen in a base + Corporate Era + Prelude game (CLAUDE.md §1); if it does, it's
 * a scope/coverage finding worth surfacing loudly rather than a routine event, so this always
 * logs it via `console.error` (regardless of `logDecisions`) before rethrowing it unmodified -
 * there is nothing this agent can legally do instead of surfacing it (the FR-9 *legal-move*
 * safety net only covers in-scope decisions; see `embeddedDriver.ts`'s conservative fallback for
 * that).
 */
export function randomLegalAgent(rng: AgentRandom, options: RandomLegalAgentOptions = {}): EmbeddedResponder {
  return (decision) => {
    let response;
    try {
      response = enumerate(decision, rng);
    } catch (error) {
      if (error instanceof OutOfScopeDecisionError) {
        console.error(`[randomLegalAgent] OUT-OF-SCOPE DECISION (should not occur in base + Corporate Era + Prelude play): ${error.message}`);
      }
      throw error;
    }

    if (options.logDecisions === true) {
      console.log(`[randomLegalAgent] player ${decision.player.id}: ${decision.model.type} -> ${JSON.stringify(response)}`);
    }
    return response;
  };
}
