import {IGame} from '@/server/IGame';

/**
 * **The speculation registry** (Milestone 2 bullet 2, Unit A; §3.2 and hazards H1/H2 of
 * agent/docs/Milestone2_Bullet2_Prompts.md).
 *
 * ---
 *
 * ## The problem this exists to solve
 *
 * `legality/submissionMonitor.ts` observes submissions by wrapping **`Player.prototype.process`**.
 * That is a prototype patch, so it is process-global: it sees every `Player` in the process,
 * including the players of every game a search forks. `match/history.ts` records at the same
 * boundary, for the same well-argued reason (see its module doc).
 *
 * The moment an agent forks - which is the whole of this bullet - every speculative move it submits
 * inside a clone flows through those instruments. Unaddressed, that means:
 *
 * - `--legality` counts tens of thousands of speculative submissions, **including deliberately
 *   rejected probes**, as real moves in real games. That is the promotion gate for AC-1
 *   (`agent/CLAUDE.md` §6), which must be re-run against every agent version from `greedy-1ply@1`
 *   onwards. It would report garbage for all of them.
 * - Recorded histories contain moves that were never played.
 *
 * The failure mode is not a crash. It is a legality number that stays *plausible* while counting
 * search probes as blunders, which is exactly the kind of number nobody re-derives.
 *
 * ---
 *
 * ## Why a `WeakSet` keyed on object identity, and not the game id (hazard H2)
 *
 * `restore()` calls `Game.deserialize` on a copy of the serialized state, and **the id is part of
 * that state**. A fork and its original are therefore two `IGame` objects with the *same*
 * `game.id`. Any identity check on the id is silently wrong - it would classify the live game as
 * speculative the instant its first fork existed, which is the most damaging possible direction for
 * the mistake. Object identity is the only thing that distinguishes them, so that is what the
 * registry is keyed on.
 *
 * `WeakSet` rather than `Set` because a speculative game is discarded as soon as its candidate has
 * been scored: a strong-referencing registry would pin every fork of every decision of every game
 * for the lifetime of the run. There is no membership enumeration and no `clear()`, which is fine -
 * nothing needs either, and both would be footguns.
 *
 * ---
 *
 * ## Why the `WeakSet` alone is not the whole answer, and why the flag alone is not either
 *
 * Both mechanisms are here, and each covers what the other cannot.
 *
 * - **The `WeakSet` is the positive guard** (§3.2: "the guard must be positive, not by
 *   convention"). A game is speculative because {@link registerSpeculative} was called on it at the
 *   moment `restore()` produced it, not because some ambient flag happened to be set. That is what
 *   makes {@link speculativeSubmission} safe to key an instrument's early return on.
 * - **The flag is the cross-check.** A `WeakSet` says "this submission went to a fork". It cannot
 *   say anything about the submission that went to the **live** game while a search was in
 *   progress - and that is the catastrophic bug: an agent that, mid-search, submits a candidate to
 *   the real game corrupts the actual match, silently, in a way no counter would ever reveal. So a
 *   speculation *scope* ({@link withSpeculation}) is carried alongside, and a submission to a
 *   non-speculative game while a scope is open throws {@link LiveSubmissionDuringSpeculationError}.
 *
 * Conversely the flag alone would be useless as the guard: it cannot distinguish a legitimate
 * speculative submission from that same bug, because both happen "while speculating".
 *
 * **Coverage of the cross-check, stated plainly rather than assumed.** The scope-based check runs
 * wherever {@link speculativeSubmission} is consulted, which is the two instruments - so it covers
 * *every* submission in the process during any `--legality` or history-tier run, i.e. every run in
 * which the corruption would matter to a recorded number. In an uninstrumented run it covers every
 * submission made through `search/fork.ts`'s own `submitInFork` entry point (which asserts on the
 * `WeakSet` directly, with no scope needed) but not a raw `player.process()` call an agent makes on
 * the live game behind the fork service's back. That residue is named here rather
 * than papered over; closing it would mean a third permanent `Player.prototype.process` wrapper,
 * which `match/history.ts` argues against at length and this bullet does not need.
 */

/** Thrown when a submission reaches a **non**-speculative game while a speculation scope is open (§3.2). */
export class LiveSubmissionDuringSpeculationError extends Error {
  constructor(game: IGame) {
    super(
      `A move was submitted to game ${game.id}, which is not a registered speculative fork, while ` +
      `speculation was in progress. A search must submit only into games produced by search/fork.ts ` +
      `(see agent/docs/Milestone2_Bullet2_Prompts.md §3.2). Note that a fork shares its original's id ` +
      `(hazard H2), so the id in this message does not tell you which game object was written to.`,
    );
  }
}

/**
 * Games produced by the fork service. Keyed on object identity (H2) and weakly held, so a fork is
 * collectable the instant the agent drops it.
 */
const SPECULATIVE = new WeakSet<IGame>();

/** Open {@link withSpeculation} scopes. A counter, not a boolean, so nesting is safe. */
let openScopes = 0;

/**
 * Whether the instrument guard is armed. Always `true` except inside
 * {@link runWithSpeculationCounted}, which exists solely to produce criterion G2b's negative
 * control.
 */
let guardArmed = true;

/**
 * Marks `game` as speculative and returns it, so a caller can write
 * `registerSpeculative(restore(snap))`. Called by `search/fork.ts` at the moment `restore()`
 * produces the game and **before** anything is submitted into it - a fork that is replayed into
 * before it is registered would have its replay steps counted as real moves, which is the very
 * thing this module prevents.
 */
export function registerSpeculative<T extends IGame>(game: T): T {
  SPECULATIVE.add(game);
  return game;
}

/** Whether `game` was produced by the fork service. Object identity; never the id (H2). */
export function isSpeculative(game: IGame): boolean {
  return SPECULATIVE.has(game);
}

/** Whether any {@link withSpeculation} scope is currently open. */
export function speculating(): boolean {
  return openScopes > 0;
}

/**
 * Runs `fn` with speculation marked as in progress, arming the cross-check described in the module
 * doc. **Synchronous by construction**: a speculation scope brackets a search, which is a
 * synchronous walk over forks, and an `async` version would leave the flag set across an `await`
 * where unrelated code could run under it.
 *
 * `search/fork.ts` opens a scope around its own replay; an agent should additionally wrap its whole
 * candidate-evaluation loop, so that a stray submission anywhere inside it is caught.
 */
export function withSpeculation<T>(fn: () => T): T {
  openScopes++;
  try {
    return fn();
  } finally {
    openScopes--;
  }
}

/**
 * **The instrument guard** (§3.2). Returns `true` when a submission to `game` must be counted
 * nowhere - the three-line early return `legality/submissionMonitor.ts` and `match/history.ts` each
 * take. Returns `false` for a real submission, and **throws** for the cross-check case.
 *
 * Deliberately one function rather than a boolean the instruments read: the ordering (speculative
 * first, cross-check second) and the negative-control escape hatch are decisions that belong in one
 * place, not duplicated at each call site where they could drift.
 */
export function speculativeSubmission(game: IGame): boolean {
  if (SPECULATIVE.has(game)) {
    return guardArmed;
  }
  if (openScopes > 0) {
    throw new LiveSubmissionDuringSpeculationError(game);
  }
  return false;
}

/**
 * Throws unless `game` is a registered fork. The always-on half of the cross-check: it needs no
 * open scope and no installed instrument, so it holds in every run, and it is what
 * `search/fork.ts`'s submission primitive asserts on before touching the Engine.
 */
export function assertSpeculative(game: IGame): void {
  if (!SPECULATIVE.has(game)) {
    throw new LiveSubmissionDuringSpeculationError(game);
  }
}

/**
 * **Criterion G2b's negative control, and nothing else.** Runs `fn` with the instrument guard
 * disarmed, so speculative submissions are counted by the instruments exactly as they would have
 * been had §3.2 never been implemented.
 *
 * This exists because "the guard works" is not a testable claim without a run in which it does not.
 * A test that cannot show the guard doing anything has not tested it, and a guard whose absence
 * produces the same numbers as its presence is either unnecessary or - far more likely - not
 * actually wired in. So the negative control is a first-class, permanent capability rather than a
 * temporary edit somebody makes and reverts.
 *
 * **Async on purpose.** A match run is `async`, so a synchronous `try/finally` would restore the
 * flag at the first `await` rather than at the end of the run. Nothing else in the process may
 * speculate concurrently while this is open - the flag is process-global, which is the same
 * constraint every `Player.prototype.process` wrapper in this codebase carries.
 */
export async function runWithSpeculationCounted<T>(fn: () => Promise<T>): Promise<T> {
  if (!guardArmed) {
    throw new Error('runWithSpeculationCounted is already in progress; the guard flag is process-global and does not nest.');
  }
  guardArmed = false;
  try {
    return await fn();
  } finally {
    guardArmed = true;
  }
}

/** Whether the instrument guard is armed. For assertions and for recording what a run measured. */
export function speculationGuardArmed(): boolean {
  return guardArmed;
}
