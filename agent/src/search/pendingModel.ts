import {IGame} from '@/server/IGame';
import {toDecisionPoint} from '../driver/decisionPoint';

/**
 * The **contents** of every waiting player's pending decision, as the serialized model the Agent
 * actually reasons about (`waitingFor.toModel(player)`, the same construction `toDecisionPoint`
 * uses in both transports).
 *
 * ---
 *
 * ## Why this exists: hazard H7's two-way check does not certify a fork
 *
 * This was the main finding of Unit B's G1a corpus run, and it arrived after Unit A had already
 * been written against the two-way check. `pendingSignature` **and** `stableStateOf` - the pair
 * Milestone 1 bullet 4 established fail independently, and which `bench/forkCost.ts` validated
 * 26,026 forks with - are together **still not sufficient** to certify that a fork is sitting on
 * the same decision as the live game.
 *
 * Unit B's first 2-game smoke run demonstrated it: 29 candidates were "rejected by the Engine",
 * every one an `or` whose branch response did not match the branch, some with `Invalid index` - an
 * index the candidate enumerator cannot generate for the decision it was looking at. The forks had
 * passed both checks and were nevertheless positioned at a *different* `or`: a regenerated
 * top-of-turn `OrOptions` in place of the live mid-action one.
 *
 * That follows from exactly what each check can see:
 *
 * - **`pendingSignature` is deliberately coarse** - `` `${player.id}:${type}` `` - so a mid-action
 *   `OrOptions` sub-decision and the top-of-turn "take your next action" `OrOptions` that
 *   `Game.deserialize` regenerates in its place are **the same string**.
 * - **The pending decision is not serialized at all** (`Game.serialize()` hardcodes
 *   `deferredActions: []`), so `stableStateOf` is **byte-identical** across the substitution.
 *
 * This is precisely bullet 4's "action-phase failures are 100% silent" population, seen from a new
 * angle: it is silent to the *validation* too. It did not surface in `bench/forkCost.ts` because
 * that suite only ever asked whether the **state** came back, which it did. An agent that forks in
 * order to *try a move* has a strictly stronger requirement - it must land on **the same decision**,
 * or its move is answering a different question - and that is the requirement this function checks.
 *
 * ## Why a string comparison is sound here
 *
 * Both sides are built by the same `toModel` code path on the same Engine build, so key order is
 * identical by construction and a plain `JSON.stringify` is a faithful comparison. (This is the
 * reason no `stableStateOf`-style canonicalization is needed: that machinery exists for serialized
 * *state*, whose key order can legitimately differ between a live object and a deserialized one.)
 *
 * ## Cost
 *
 * One `toModel` per waiting player plus a stringify. `toModel` is ~7% of a decision (~0.0065 ms)
 * against a fork cost of ~1 ms, so this is affordable on **every** fork - and callers that fork
 * many times per decision should cache the live side, which changes only when the decision does.
 */
export function pendingModelSignature(game: IGame): string {
  const parts: Array<string> = [];
  for (const player of game.playersInGenerationOrder) {
    const waitingFor = player.getWaitingFor();
    if (waitingFor !== undefined) {
      parts.push(JSON.stringify({id: player.id, model: toDecisionPoint(player, waitingFor).model}));
    }
  }
  return parts.join('|');
}
