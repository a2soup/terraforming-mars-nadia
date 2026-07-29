import {InputResponse} from '@/common/inputs/InputResponse';
import {enumerate} from '../enumerator';
import {enumeratePayment, enumerateProjectCard} from '../enumerator/payment';
import {AgentRandom} from '../rng';
import {DecisionCandidateEnumerator} from './types';

/**
 * Candidate sets for the two payment-bearing decision types - `payment` (SelectPayment) and
 * `projectCard` (SelectCardToPlay, in both its subclasses). Mirrors `core/enumerator/payment.ts`
 * and, unusually for this directory, **drives that file's code rather than restating it**. The
 * reason is worth stating up front, because the alternative looks easier and is worse.
 *
 * `cheapestLegalPayment` / `greedyPayment` / `standardProjectTarget` / `spendableCounts` are
 * module-private in `enumerator/payment.ts`, and §8's ownership table forbids editing that file
 * (even to add an `export`, which would be behaviour-neutral - the rule is absolute because the
 * determinism corpus is the thing it protects). That leaves two options: re-derive ~150 lines of
 * payment reduction here, or call the enumerator and *steer* which card it picks. Re-deriving
 * would duplicate the one piece of Milestone-1 code that reads steel/titanium values, the Helion
 * heat rate and the Luna titanium hook straight off `IPlayer` - exactly the rules-duplication
 * CON-1 exists to prevent, and it would drift. Steering costs a small, documented coupling to one
 * internal fact ({@link SteeredPick}) and gives candidates that are legal for precisely the
 * reason the Milestone-1 ones are.
 *
 * **`payment` stays canonical-cheapest** (§2.2, §3.5). The strategically-meaningful payment
 * variants - hold back a steel for Electro Catapult, keep a titanium for next generation - remain
 * Milestone 3's job, and that deferral is what keeps candidate sets tractable: a set of payments
 * per card would multiply the `projectCard` set by the number of variants for no gain under
 * points-now (§3.1), where the only thing a payment changes is which resources are left over, and
 * leftover resources are worth zero victory points.
 */

/**
 * An {@link AgentRandom} that forces `pick` to a chosen index and records how many elements it
 * was offered - the mechanism that turns "sample one legal move" into "enumerate the factor".
 *
 * **The coupling, stated explicitly so it is checked and not assumed:** `enumerateProjectCard`
 * calls `rng.pick` exactly once, on the list of cards it has already filtered down to the
 * eligible-and-affordable ones (`enumerateHandCard` / `enumerateStandardProject` in
 * `enumerator/payment.ts`). So driving it with `SteeredPick(i)` yields the i-th eligible card
 * paired with the canonical payment the Engine's own predicate verified, and `offered` after the
 * first call is the size of that eligible set - which the caller cannot compute up front without
 * re-implementing the filter. `candidates/payment.spec.ts` asserts this coupling directly (one
 * `pick`, over the eligible set) so a future change to the enumerator breaks a test here rather
 * than silently reducing the candidate set to a single card.
 *
 * Every non-`pick` method answers with the low end of its range rather than drawing from the
 * agent's own stream. Two reasons: the enumerator is being used here as a *function of the game
 * state*, called once per candidate, so it must not consume a variable number of draws from the
 * stream that decides real moves (which would make rng consumption depend on how many cards
 * happened to be affordable - deterministic, but needlessly coupled, and a nuisance for the G6
 * reproducibility check); and answering in-place keeps this file free of any Engine `Random`
 * import, which the CI-enforced RNG-separation spec (`test/determinism/rngSeparation.spec.ts`)
 * permits in exactly two files, neither of them this one (NFR-7). Today no non-`pick` call is
 * made at all; these are defence in depth.
 */
class SteeredPick implements AgentRandom {
  /** The size of the list handed to the most recent `pick`. 0 if `pick` was never reached. */
  public offered = 0;

  constructor(private readonly index: number) {}

  public next(): number {
    return 0;
  }

  public nextInt(): number {
    return 0;
  }

  public intInRange(min: number): number {
    return min;
  }

  public pick<T>(items: ReadonlyArray<T>): T {
    if (items.length === 0) {
      throw new Error('pick called on an empty array');
    }
    this.offered = items.length;
    // Clamped rather than asserted: the caller derives `index` from a previous call's `offered`
    // on the same unmodified game state, so out-of-range cannot happen - and if the enumerator
    // ever grew a second `pick` over a shorter list, clamping degrades to a duplicate candidate
    // (which `dedupe` removes) instead of a throw that would look like an Engine rejection.
    return items[Math.min(this.index, items.length - 1)];
  }
}

/**
 * `payment` (SelectPayment): the one canonical cheapest-legal allocation (§3.5), produced by the
 * Milestone-1 reduction itself. One candidate, always - `enumeratePayment` ignores the rng
 * because there is nothing to sample.
 */
export const paymentCandidates: DecisionCandidateEnumerator = (decision, rng) => {
  const {model} = decision;
  if (model.type !== 'payment') {
    throw new Error(`paymentCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }
  return {candidates: [enumeratePayment(decision, rng, enumerate)]};
};

/**
 * `projectCard` (SelectCardToPlay): **one candidate per playable card**, each paired with its
 * canonical cheapest-legal payment (§3.5). This is the important set - it is where most of the
 * agent's strength lives, and it is the set that makes the difference between an agent that can
 * choose a card and one that plays a random affordable card.
 *
 * The enumerated factor is *which card*; the payment factor is the single canonical allocation
 * per card, so this is `n` candidates rather than `n x payments`. Both Engine inputs behind this
 * model type are covered without distinguishing them here, because `enumerateProjectCard` already
 * does: `SelectProjectCardToPlay` (play from hand - eligibility is affordability) and
 * `SelectStandardProjectToPlay` (standard projects - eligibility additionally requires
 * `card.canAct`, and the cost/payment model differs). Feeding one through the other's path
 * produces a move the Engine rejects, which is a real Milestone-1 finding, not a hypothetical.
 *
 * **An empty set is a legal outcome.** `enumerateProjectCard` throws when *no* offered card is
 * eligible-and-affordable - routinely reachable, since the standard-projects menu is offered as
 * an `or` branch whether or not anything in it can be paid for. Milestone 1 leaves that to the
 * driver's FR-9 fallback; here it means "this branch contributes no candidates", which `or`
 * handles by simply not offering it (see `candidates/composite.ts`). The throw is swallowed for
 * that reason and no other - it is the only failure mode this call has, and turning it into an
 * empty set at this one place keeps the whole rest of the candidate path free of the special case.
 *
 * Cost: the filter runs once per candidate, so this is O(cards^2) affordability checks for a
 * hand of `cards`. With a real hand (single digits to low teens) that is a few hundred
 * `canAfford` calls per decision, against a fork/drain/score budget three orders of magnitude
 * larger (§2.8) - measured, not assumed, by the G1a corpus run.
 */
export const projectCardCandidates: DecisionCandidateEnumerator = (decision) => {
  const {model} = decision;
  if (model.type !== 'projectCard') {
    throw new Error(`projectCardCandidates called for a '${model.type}' decision - dispatch should guarantee this never happens`);
  }

  const probe = new SteeredPick(0);
  let first: InputResponse;
  try {
    first = enumerateProjectCard(decision, probe, enumerate);
  } catch {
    return {candidates: []};
  }

  const seen = new Set<string>([JSON.stringify(first)]);
  const candidates: Array<InputResponse> = [first];
  for (let i = 1; i < probe.offered; i++) {
    let response: InputResponse;
    try {
      response = enumerateProjectCard(decision, new SteeredPick(i), enumerate);
    } catch {
      // Unreachable in principle: the eligible set is a pure function of the (unmodified) game
      // state, so a call that succeeded at index 0 succeeds at every index. Skipped rather than
      // rethrown so that a future eligibility rule with a per-card failure mode costs one
      // candidate instead of the whole decision.
      continue;
    }
    const key = JSON.stringify(response);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(response);
    }
  }
  return {candidates};
};
