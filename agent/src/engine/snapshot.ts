import {Phase} from '@/common/Phase';
import {Game} from '@/server/Game';
import {IGame} from '@/server/IGame';
import {SerializedGame} from '@/server/SerializedGame';
import {stableStateOf} from './stableState';

/**
 * Snapshot/restore for search and self-play (Milestone 1 bullet 4, SRS CON-3). This module
 * is the load-bearing input to the simulator-speed spike (a separate Milestone 1 item) - it
 * builds the clone primitive the spike measures, not the measurements themselves.
 *
 * **Why this exists, and why it is more than "deep-copy `serialize()`".** The Engine
 * (immutable ground truth, SRS CON-1) makes two design choices that a naive round-trip
 * check does not surface:
 *
 * 1. **The pending decision is not serialized.** `Player.waitingFor`/`waitingForCb`
 *    (`src/server/Player.ts`) are absent from `SerializedPlayer`, and `Game.serialize()`
 *    hardcodes `deferredActions: []` (`src/server/Game.ts:480`). `Game.deserialize`
 *    compensates by *regenerating* a decision from the phase (the dispatch at the end of
 *    the function), which is faithful for a top-of-turn decision and lossy for a
 *    mid-action sub-decision - and the lossy case leaves the serialized state
 *    byte-identical, so a state-only comparison silently passes. See the 2026-07-22
 *    Running Notes entry "Snapshot/restore fidelity is not universal" for the measured
 *    numbers (75/294 decision points in a probed 2p game, 29 of them silent).
 * 2. **`serialize()` aliases live objects** (`gameLog: this.gameLog`,
 *    `gameOptions: this.gameOptions`, `src/server/Game.ts:490-491`) and `Game.deserialize`
 *    both mutates its argument (`gameOptions.boardName = ...`) and re-aliases it
 *    (`game.gameLog = d.gameLog`). A deep copy is required at capture *and* again on every
 *    restore, since `deserialize` consumes the object it is handed.
 *
 * **Why `assertSnapshotSafe` and pending-signature verification are both needed - neither
 * is sufficient alone (this is the crux, see agent/docs/Milestone1_Bullet4_Prompts.md
 * sub-task A section 3):**
 *
 * - The **phase guard** (`assertSnapshotSafe`) catches every research-phase failure (restore
 *   re-draws cards, so the serialized state genuinely diverges) but *not* the action-phase
 *   ones: measured action-phase failures overwhelmingly have an empty deferred queue and sit
 *   in `Phase.ACTION`, so the guard alone happily accepts them.
 * - **Pending-signature verification** (`restore`'s default `verify: 'pending'`) catches
 *   every one of those action-phase failures, plus most of the research ones (a re-drawn
 *   deck usually also changes which decision is pending) - but not the residual research
 *   failures where the *signature* happens to match while the underlying deck and dealt
 *   cards have still changed, nor a rare `Phase.PRELUDES` case with the same shape (see
 *   immediately below).
 * - **Neither guard is individually complete, and - a correction to an earlier draft of this
 *   comment - "together" was not either, until `PRELUDES`/`CEOS` were added to the phase
 *   guard below.** A 120-game sweep across 2p/3p/4p (independent of sub-task B's 6-game
 *   fidelity-audit corpus) found one point - a mid-prelude `OrOptions` sub-decision - where
 *   `assertSnapshotSafe` accepted the point (`PRELUDES` wasn't yet in the unsafe-phase list)
 *   *and* the pending signature matched (`player:or` collides with the fresh top-of-turn
 *   `or` restore regenerated) *and* the serialized state still diverged (`phase: 'preludes'`
 *   vs `'action'` - restore silently promoted the player straight to their main action phase).
 *   That is exactly the failure class this module exists to make loud: both guards passed,
 *   `restore()` returned normally, and the returned game was a different game. See the
 *   2026-07-23 Running Notes entry ("the guard holds ... but preludes is not the clean phase
 *   the probe suggested") for the full account of why sub-task B's audit corpus (0/4 prelude
 *   points bad) missed this, and why "PRELUDES` is 36/43 fine, the pending check catches the
 *   other 7" - true on that corpus - turned out not to generalize.
 *
 * **Deliberately not used: the Engine's own `Cloner`** (`src/server/database/Cloner.ts`).
 * It is built for cross-*game* cloning: it rewrites every player id (a full recursive walk
 * of the serialized graph), sets `clonedGamedId`, and resets `createdTimeMs`. All three are
 * wrong for a search fork, which wants the same player ids and the same state.
 */

/** A captured, independently-restorable copy of a game's state, plus the metadata needed to verify a restore's fidelity. */
export type GameSnapshot = {
  /** Already deep-copied at capture time; never handed out by reference from the source game. */
  readonly state: SerializedGame;
  /** The pending-decision signature captured from the live game at snapshot time (see {@link pendingSignature}). */
  readonly pending: string;
  /** The game's phase at snapshot time - not itself a safety mechanism, just useful for reporting/audits (sub-task B). */
  readonly phase: Phase;
  /** Whether `state.gameLog` was replaced with `[]` at capture (see {@link SnapshotOptions.stripLog}). */
  readonly logStripped: boolean;
};

export type SnapshotOptions = {
  /**
   * Replaces `gameLog` with `[]` in the captured copy. `gameLog` is ~74% of the serialized
   * bytes and accounts for ~40% of restore cost (Running Notes cost table), so this is a
   * meaningful optimization for search, which never needs the log - but it changes what a
   * restored game *is* (no history), so it must not be assumed safe by default. Sub-task B
   * proves it rules-neutral (a game driven to completion from a stripped restore produces
   * the same `GameResult` as one from an unstripped restore of the same point) before it is
   * trusted anywhere in this bullet.
   */
  stripLog?: boolean;
  /**
   * Bypasses {@link assertSnapshotSafe}. Only ever set by the fidelity audit (sub-task B),
   * which must measure *precisely* the points the guard exists to refuse - taking a
   * measurement of where snapshotting is unfaithful requires being able to attempt it there.
   * Never set this for a real search/self-play snapshot.
   */
  unsafe?: boolean;
};

export type RestoreVerification =
  /** Compare `pendingSignature(restored)` to `snap.pending`; throw {@link SnapshotFidelityError} on mismatch. The default - cheap (a player walk) and the only mechanism that catches a silently-replaced pending decision (Engine fact 1 above). */
  | 'pending'
  /** Everything `'pending'` does, plus a `stableStateOf` comparison of the full serialized state. Costs a serialize + two stringifies; for tests, audits, and paranoid callers, not the search hot path. */
  | 'state'
  /** No verification at all. For the speed spike, so it can measure raw restore cost, and for the fidelity audit, which does its own by-hand comparison instead (see sub-task B). */
  | 'none';

export type RestoreOptions = {
  verify?: RestoreVerification;
};

/** Thrown by {@link assertSnapshotSafe} (and by {@link snapshot} unless `unsafe: true`) when the game is in a phase or mid-action state where a restore is known to be unfaithful. */
export class UnsafeSnapshotError extends Error {}

/** Thrown by {@link restore} when a restored game's observable state does not match what was captured - a caught fidelity failure, per the verification level requested. */
export class SnapshotFidelityError extends Error {}

/**
 * The players with a pending input, in `game.playersInGenerationOrder` (the driver's own
 * resolution order - see `embeddedDriver.ts` - so the signature is stable and matches how
 * the driver will actually consume it), each rendered as `` `${player.id}:${type}` `` and
 * joined. Cheap: `PlayerInput.type` is a plain property, so this never calls `toModel()` or
 * touches anything beyond `getWaitingFor()` per player.
 *
 * This is the highest-value function in the module - capturing it costs nothing, and it is
 * the only thing that detects Engine fact 1 (the pending decision is not serialized and can
 * be silently regenerated into something different on restore).
 */
export function pendingSignature(game: IGame): string {
  const parts: Array<string> = [];
  for (const player of game.playersInGenerationOrder) {
    const waitingFor = player.getWaitingFor();
    if (waitingFor !== undefined) {
      parts.push(`${player.id}:${waitingFor.type}`);
    }
  }
  return parts.join(',');
}

/**
 * Throws {@link UnsafeSnapshotError} if `game` is in a phase, or holds a mid-action
 * continuation, where a restore is known to be unfaithful (see this module's doc comment
 * for the measured failure modes this catches and does not catch).
 *
 * `PRELUDES`/`CEOS` are unsafe for the same reason `RESEARCH` is - a mid-phase sub-decision
 * (e.g. an ocean-tile placement queued behind a prelude in flight) can be silently discarded
 * and replaced by a fresh top-of-turn decision on restore - but the failure mode is rarer and
 * was missed by sub-task B's original 6-game fidelity-audit corpus (0/4 prelude points bad
 * there). A wider 120-game sweep found a prelude point where the *serialized state* diverged
 * (`phase: 'preludes'` restored as `'action'`) while the pending-signature check alone did not
 * catch it - the regenerated action-phase `OrOptions` happened to collide with the live
 * prelude `OrOptions` under the coarse `player:type` signature. Guarding the phase closes that
 * gap the same way it already does for research. See the 2026-07-23 Running Notes entry for
 * the full account.
 */
export function assertSnapshotSafe(game: IGame): void {
  const unsafePhases: ReadonlyArray<Phase> = [
    Phase.RESEARCH, Phase.DRAFTING, Phase.INITIALDRAFTING, Phase.PRELUDES, Phase.CEOS,
  ];
  if (unsafePhases.includes(game.phase)) {
    throw new UnsafeSnapshotError(
      `Game ${game.id} is in phase '${game.phase}', which can regenerate a different pending decision ` +
      `on restore (e.g. research re-draws cards, or a mid-prelude sub-decision is silently replaced by a ` +
      `fresh top-of-turn action) rather than reproducing it - snapshotting here is known to be unfaithful.`,
    );
  }
  if (game.deferredActions.length > 0) {
    throw new UnsafeSnapshotError(
      `Game ${game.id} has ${game.deferredActions.length} queued deferred action(s) - the pending ` +
      `decision is not serialized (Game.serialize() hardcodes deferredActions: []), so a restore here ` +
      `would silently discard whatever continuation they're guarding.`,
    );
  }
}

function deepCopy<T>(value: T): T {
  // Preferred over `structuredClone`, which the planning probe measured as *slower* than a
  // JSON round trip for a SerializedGame-shaped object (Running Notes cost table) - not the
  // usual advice, but this is the actual shape being copied here.
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Captures a restorable copy of `game`'s current state. Calls {@link assertSnapshotSafe}
 * unless `options.unsafe` is `true`. The returned {@link GameSnapshot} owns its own deep
 * copy of the serialized state - nothing in it aliases `game`.
 */
export function snapshot(game: IGame, options: SnapshotOptions = {}): GameSnapshot {
  if (options.unsafe !== true) {
    assertSnapshotSafe(game);
  }

  const pending = pendingSignature(game);
  const state = deepCopy(game.serialize());
  if (options.stripLog === true) {
    state.gameLog = [];
  }

  return {
    state,
    pending,
    phase: game.phase,
    logStripped: options.stripLog === true,
  };
}

/**
 * Restores an independent {@link IGame} from `snap`. Deep-copies `snap.state` again before
 * handing it to `Game.deserialize` - which both mutates and re-aliases the object it is
 * given (Engine fact 2 above) - so `snap` itself is left untouched and safe to restore from
 * again. Verifies the restore per `options.verify` (default `'pending'`, always on unless
 * explicitly relaxed): see {@link RestoreVerification} for what each level checks and costs.
 */
export function restore(snap: GameSnapshot, options: RestoreOptions = {}): IGame {
  const verify = options.verify ?? 'pending';
  const restored = Game.deserialize(deepCopy(snap.state));

  if (verify === 'none') {
    return restored;
  }

  const restoredPending = pendingSignature(restored);
  if (restoredPending !== snap.pending) {
    throw new SnapshotFidelityError(
      `Restored game ${restored.id}'s pending-decision signature ('${restoredPending}') does not match ` +
      `the snapshot's ('${snap.pending}') - the Engine regenerated a different pending decision than the ` +
      `one captured at snapshot time (see agent/docs/Running_Notes.md, "Snapshot/restore fidelity is not universal").`,
    );
  }

  if (verify === 'state') {
    const restoredState = stableStateOf(restored.serialize(), {ignoreLog: snap.logStripped});
    const snapshotState = stableStateOf(snap.state, {ignoreLog: snap.logStripped});
    if (restoredState !== snapshotState) {
      throw new SnapshotFidelityError(
        `Restored game ${restored.id}'s serialized state does not match the snapshot's, despite a ` +
        `matching pending-decision signature.`,
      );
    }
  }

  return restored;
}

/** `snapshot(game, options)` immediately followed by `restore(snap, options)` - a one-shot clone. */
export function cloneGame(game: IGame, options: SnapshotOptions & RestoreOptions = {}): IGame {
  return restore(snapshot(game, options), options);
}
