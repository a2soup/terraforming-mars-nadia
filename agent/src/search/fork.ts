import {Phase} from '@/common/Phase';
import {InputResponse} from '@/common/inputs/InputResponse';
import {PlayerId} from '@/common/Types';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedDriverOptions} from '../driver/embeddedDriver';
import {EmbeddedResponder} from '../driver/responder';
import {
  GameSnapshot,
  SnapshotFidelityError,
  UnsafeSnapshotError,
  pendingSignature,
  restore,
  snapshot,
} from '../engine/snapshot';
import {stableStateOf} from '../engine/stableState';
import {pendingModelSignature} from './pendingModel';
import {assertSpeculative, isSpeculative, registerSpeculative, withSpeculation} from './speculation';

/**
 * **The fork service** (Milestone 2 bullet 2, Unit A; §2.3, §3.3 and hazards H3/H5/H6/H7 of
 * agent/docs/Milestone2_Bullet2_Prompts.md).
 *
 * Produces a speculative `IGame` positioned at an arbitrary decision point of a live game, so a
 * one-ply agent can try a candidate move and look at the position it reaches.
 *
 * ---
 *
 * ## This is a productionization, not a design
 *
 * `agent/src/bench/forkCost.ts` (Milestone 1 bullet 5, sub-task D) already implements and
 * **validates** the strategy: restore the nearest quiescent (forkable) ancestor and replay the
 * intervening recorded decisions. Measured at the pin on the compiled build: effective fork cost
 * **0.979 ms** median (raw restore 0.963 ms; replay adds 1.6%), replay distance median 0 / p95 3 /
 * max 5, and **26,026 fork experiments with 100% exact reproduction**. Restore-many from one
 * snapshot runs at 1,697/s against 1,061/s for independent clones.
 *
 * Everything difficult here was learned there, and is copied rather than re-derived:
 *
 * | Piece | Why it is the way it is |
 * | --- | --- |
 * | {@link submitInFork} | The replay counterpart of `applyDecision`: `player.process` plus the **guarded** deferred drain, deliberately *not* `applyDecision` - no `toModel`, no `enumerate`, and crucially no FR-9 fallback, so a rejected replay step surfaces as a divergence instead of being silently substituted (H6). |
 * | The guard on that drain | It is the fix for a real driver bug (an unconditional `runAll()` overwriting a freshly-set `waitingFor`, Running Notes 2026-07-22). A replay that drained differently from the original drive would diverge for reasons that have nothing to do with snapshot fidelity. |
 * | `verify: 'pending'` on every restore | Costs 0.0001 ms - free - and is the only thing that catches a silently regenerated pending decision. Never relaxed to buy speed (H5). |
 * | Both-ways validation | `pendingSignature` **and** `stableStateOf`. Milestone 1 bullet 4 spent a whole sub-task establishing that these fail independently (H7). **Necessary but not sufficient** - see the section below. |
 * | One rolling ancestor, not a table | Cheaper, and it is exactly search's snapshot-once / restore-many access pattern. |
 * | {@link copyResponse} | Recorded responses are replayed into many independently restored games; never share one object. |
 *
 * ---
 *
 * ## Three-way validation: what `bench/forkCost.ts` could not have caught (the H7 correction)
 *
 * Hazard H7 as the plan states it - check `pendingSignature` **and** `stableStateOf`, because they
 * fail independently - is **necessary and still not sufficient**, and this module was originally
 * written believing it was. Unit B's G1a corpus run found the gap: forks that passed both checks
 * were sitting on a *regenerated top-of-turn `OrOptions`* instead of the live mid-action one, and
 * candidate responses aimed at the live decision came back as Engine rejections (`Invalid index`).
 *
 * Both checks are blind to that substitution by construction - `pendingSignature` is only
 * `` `${player.id}:${type}` ``, and the pending decision is not serialized at all - so this is
 * bullet 4's "action-phase failures are 100% silent" population, silent to the validation too.
 * `bench/forkCost.ts`'s **"26,026 forks, 100% exact reproduction" carries the same blind spot**: it
 * asked whether the *state* came back, which it did. An agent that forks in order to try a move
 * needs the strictly stronger property that it landed on **the same decision**.
 *
 * So {@link pendingModelSignature} is a third, strictly finer check, and it is applied to **both**
 * things this module does with a restore: adopting an ancestor ({@link ForkService.tryForkHere})
 * and certifying a fork ({@link ForkService.finish}). On Unit B's corpus the finer check refused
 * 1,017 restores as ancestors and skipped 281 probe points that the two-way check had accepted;
 * with it, Engine rejections went to zero. {@link ForkStats.modelRefusedHere} counts the refusals
 * so the rate is reported rather than assumed.
 *
 * **A consequence for the write-up:** §2.4's ~72% forkability is an overstatement for an agent that
 * forks to try a move, because it was measured under the two-way definition. The honest figure is
 * this module's `direct + replayed` against `attempts`, and the gap is a number Unit D reports.
 *
 * ---
 *
 * ## Recording the response the **Engine accepted** (hazard H3 - the one a re-implementation gets wrong)
 *
 * The obvious recorder captures what the responder returned. That records moves that were never
 * played, for two distinct reasons Milestone 1 measured at 1,500-game scale:
 *
 * 1. when `player.process()` rejects the responder's move, the driver submits
 *    `resubmitConservatively`'s response **instead**; and
 * 2. when the responder *throws* it returns nothing at all - **8,480 times across 1,500 games,
 *    ~5.7 per game**. This is not an edge case.
 *
 * So the recorder brackets each decision and takes the response from `EmbeddedDriverOptions.onFallback`
 * whenever the fallback fires, exactly as `bench/forkCost.ts` and `match/history.ts` both do. A
 * decision that never resolved at all (the game failed there) drops the ancestor rather than
 * recording a gap it could later replay across.
 *
 * ## Seeing **every** player's decisions (hazard H4)
 *
 * The ancestor walk replays opponents' moves too, so a responder bound to one seat is not enough.
 * {@link ForkService.observeDecisions} wraps the match runner's *router* - the one responder the
 * driver sees, dispatching on player id - so one wrapper observes every seat. `agents/registry.ts`
 * lets an agent contribute that wrapper and its driver options; `match/runner.ts` merges them, and
 * does nothing at all when an agent contributes neither.
 *
 * ## Where the ancestor comes from: probing at fork time, not at every decision
 *
 * `bench/forkCost.ts` probes forkability at *every* decision point, because measuring the density
 * of forkable points was its whole purpose. Production does not need that: it needs an ancestor,
 * and it pays ~1 ms per probe. So {@link ForkService.fork} probes the **current** point when it is
 * asked for a fork, adopting it as the new ancestor when it verifies, and otherwise replays from
 * the ancestor it is already carrying. The ancestor is therefore always one of the *asking* agent's
 * own earlier decision points, which makes replay distance somewhat longer than the bench's median
 * of 0 and costs nothing else - a replay step is `process` plus a drain, and the bench measured
 * replay at 1.6% of fork cost. {@link ForkStats} records the distances, so this trade is a number
 * rather than an assumption.
 *
 * **A consequence worth stating before anyone is surprised by it.** `assertSnapshotSafe` refuses
 * `RESEARCH`, `DRAFTING`, `INITIALDRAFTING`, `PRELUDES` and `CEOS`, and those phases all precede
 * the first `ACTION`-phase decision of a game. A game therefore has **no forkable ancestor at all**
 * until its first action phase, so no amount of replay makes the opening forkable - including
 * prelude selection, which §3.3 of the plan hoped replay would reach. {@link ForkStats.noAncestor}
 * counts exactly those decisions so the write-up can report it rather than assert it.
 */

// ---------------------------------------------------------------------------------------------
// What a fork is, and what "no fork" is
// ---------------------------------------------------------------------------------------------

/** One decision of the live game, recorded as the Engine accepted it (see the module doc on H3). */
export type RecordedStep = {
  /** The player `applyDecision` was called with, i.e. the first waiting player in generation order. */
  readonly playerId: PlayerId;
  /** Deep-copied at record time, so replaying it into many independently restored games can never alias. */
  readonly response: InputResponse;
};

/** Why no fork could be produced. Each is separately counted, because they mean different things. */
export type ForkUnavailableReason =
  /** The service has not seen a decision yet, so it does not know which game it is serving. */
  | 'no-game'
  /** No forkable point has occurred in this game yet - game setup. Not a failure (see the module doc). */
  | 'no-ancestor'
  /** Restoring the carried ancestor threw, despite that ancestor having verified when it was adopted. */
  | 'restore-rejected'
  /** A recorded response did not replay: the Engine rejected it, or the game took a different shape. */
  | 'replay-failed'
  /** The replay landed on a position that is not the live one - caught by the always-on pending check. */
  | 'validation-failed';

/**
 * Why a replay did not reproduce its target. Mirrors `bench/forkCost.ts`'s vocabulary, plus
 * `pendingModelMismatch` - the failure that vocabulary had no name for because the two-way check
 * could not see it (see the module doc's H7 correction).
 */
export type ReplayFailure =
  | 'playerMismatch'
  | 'processRejected'
  | 'endedEarly'
  | 'noWaitingPlayer'
  | 'pendingMismatch'
  | 'stateMismatch'
  | 'bothMismatch'
  /** State and pending signature both matched, but the fork is on a *different decision*. */
  | 'pendingModelMismatch';

export type ForkAvailable = {
  readonly available: true;
  /** The speculative game, already registered with `search/speculation.ts`. */
  readonly game: IGame;
  /** The player in `game` that the live decision belongs to - the same id, a different object. */
  readonly player: IPlayer;
  /** How many recorded responses had to be replayed. 0 when the live point was itself forkable. */
  readonly replayDistance: number;
  /** True when this fork's `stableStateOf` was compared against the live game's (the sampled half of H7). */
  readonly stateValidated: boolean;
};

export type ForkUnavailable = {
  readonly available: false;
  readonly reason: ForkUnavailableReason;
  readonly detail?: string;
};

/**
 * A typed "no fork available" result rather than a throw, so the agent can take its FR-9 fallback
 * without a `try`. A fork being unavailable is an ordinary, expected outcome - most of game setup
 * is unforkable - and modelling it as an exception would make the common path the exceptional one.
 */
export type ForkOutcome = ForkAvailable | ForkUnavailable;

/** Everything the service counts, for criterion G3 and the G7 diagnostics. */
export type ForkStats = {
  /** Decisions observed on the live game, all seats. */
  decisions: number;
  /** Calls to {@link ForkService.fork}. */
  attempts: number;
  /** Attempts where the **live** point itself restored - G3's "without ancestor replay" figure. */
  direct: number;
  /** Attempts satisfied by restoring an ancestor and replaying forward. */
  replayed: number;
  unavailable: number;
  unavailableByReason: Record<ForkUnavailableReason, number>;
  /** Attempts made before this game had any forkable ancestor (game setup). */
  noAncestor: number;
  replayDistanceTotal: number;
  replayDistanceMax: number;
  /**
   * Submissions made **by replay itself**, across every attempt including failed ones. Distinct
   * from the candidates an agent submits, and part of the same population the speculation guard
   * hides - so criterion G2b's "submissions hidden" adds up only with this term in it.
   */
  replaySubmissions: number;
  /** Forks whose `stableStateOf` was compared against the live game's (the sampled half of H7). */
  stateValidated: number;
  /**
   * Live points that restored cleanly - phase guard and `verify: 'pending'` both satisfied - and
   * were still **refused as ancestors** because {@link pendingModelSignature} showed the restore
   * sitting on a different decision (the module doc's H7 correction). These are the points the
   * two-way check would have adopted; a non-zero count is this check earning its keep, and a zero
   * count over a real corpus means it is not being exercised.
   */
  modelRefusedHere: number;
  /** Validation failures, by kind. **Any entry is a G3 failure**, not a rounding difference. */
  validationFailures: Partial<Record<ReplayFailure, number>>;
  /** The configured sampling rate, recorded so a reported figure carries its own denominator. */
  validateRate: number;
  /** `onFallback` events that arrived with no decision open. Should be 0; counted rather than assumed. */
  fallbacksOutsideDecision: number;
};

export type ForkServiceOptions = {
  /**
   * Strip `gameLog` from ancestor snapshots. **Default `true`**: the log is ~74% of the serialized
   * bytes and ~40% of restore cost, Milestone 1 bullet 4 proved stripping it rules-neutral, and a
   * speculative game is scored and thrown away without anyone reading its history.
   */
  stripLog?: boolean;
  /**
   * Fraction of forks whose full serialized state is compared against the live game's - the
   * expensive half of H7. Default 0. Criterion G3 asks for >= 5%, i.e. `0.05`.
   *
   * Sampled by a **deterministic stride** (`round(1 / rate)`) rather than an RNG draw, for two
   * reasons: it must not consume the agent's seeded stream (hazard H8 - a diagnostic that shifts
   * the agent's own randomness would make G6's reproducibility check measure the diagnostic), and a
   * deterministic sample is one a failed run can be re-examined at rather than hunted for.
   */
  validateRate?: number;
};

// ---------------------------------------------------------------------------------------------
// The replay primitives (copied from bench/forkCost.ts - see the module doc)
// ---------------------------------------------------------------------------------------------

/** The response objects are replayed into many independently restored games; never share one. */
export function copyResponse(response: InputResponse): InputResponse {
  return JSON.parse(JSON.stringify(response)) as InputResponse;
}

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

/**
 * Submits one response **into a speculative game**: `player.process` plus the driver's own guarded
 * deferred drain, and nothing else.
 *
 * Deliberately **not** `applyDecision` (H6). `applyDecision` builds the HTTP-transport model, calls
 * `enumerate`, and - the part that matters - carries the FR-9 conservative fallback, which would
 * silently substitute a legal move of its own. A replay that "succeeded" having taken a different
 * path is worse than one that failed. The drain and its guard are copied verbatim from
 * `applyDecision` and **must stay identical to it**: the guard is the fix for a real driver bug
 * (Running Notes, 2026-07-22), and a replay that drained differently from the original drive would
 * diverge for reasons that have nothing to do with snapshot fidelity.
 *
 * The {@link assertSpeculative} call is the always-on half of §3.2's cross-check: it needs no open
 * scope and no installed instrument, so an agent that submits through this function can never reach
 * the live game by accident. It is one `WeakSet` lookup.
 */
export function submitInFork(player: IPlayer, response: InputResponse): void {
  assertSpeculative(player.game);
  player.process(response);
  if (player.getWaitingFor() === undefined) {
    player.game.deferredActions.runAll(() => {});
  }
}

/**
 * Replays `steps` into `restored`. Returns the failure kind (or `undefined` if every step landed)
 * and how many submissions it made - which is not `steps.length` on a failure, and is part of the
 * population the speculation guard has to hide, so criterion G2b's arithmetic needs it.
 */
function replaySteps(restored: IGame, steps: ReadonlyArray<RecordedStep>): {failure?: ReplayFailure; submitted: number} {
  let submitted = 0;
  for (const step of steps) {
    if (restored.phase === Phase.END) {
      return {failure: 'endedEarly', submitted};
    }
    const player = nextWaitingPlayer(restored);
    if (player === undefined) {
      return {failure: 'noWaitingPlayer', submitted};
    }
    if (player.id !== step.playerId) {
      return {failure: 'playerMismatch', submitted};
    }
    submitted++;
    try {
      submitInFork(player, copyResponse(step.response));
    } catch {
      return {failure: 'processRejected', submitted};
    }
  }
  return {submitted};
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

/** A decision of the live game that has been presented but whose accepted response is not final yet. */
type OpenDecision = {
  readonly playerId: PlayerId;
  response?: InputResponse;
};

/**
 * One live game's fork service: a rolling nearest-forkable-ancestor snapshot, the accepted
 * responses since it, and {@link fork}.
 *
 * **Per game, not per run.** The recorded responses and the ancestor describe one game, and an
 * agent is constructed per game by `match/runner.ts` (`createAgent` inside `playMatchGame`), so an
 * agent that owns a service owns exactly one game's worth of state. The service latches onto
 * whichever game presents it a decision first and ignores decisions from any other, which is both
 * the assertion and the recovery.
 */
export class ForkService {
  private readonly stripLog: boolean;
  private readonly validateStride: number;
  private readonly rate: number;

  private game: IGame | undefined;
  /** The nearest point known to restore faithfully, and nothing else. */
  private ancestor: GameSnapshot | undefined;
  /** Accepted responses for every decision since {@link ancestor} was taken, in order. */
  private steps: Array<RecordedStep> = [];
  private open: OpenDecision | undefined;
  /** {@link liveModelSignature}'s cache for the decision currently open. */
  private liveModel: string | undefined;

  private counters: ForkStats;

  constructor(options: ForkServiceOptions = {}) {
    this.stripLog = options.stripLog ?? true;
    this.rate = options.validateRate ?? 0;
    this.validateStride = this.rate > 0 ? Math.max(1, Math.round(1 / this.rate)) : 0;
    this.counters = emptyStats(this.rate);
  }

  public get stats(): ForkStats {
    return {...this.counters, unavailableByReason: {...this.counters.unavailableByReason}, validationFailures: {...this.counters.validationFailures}};
  }

  /** The live game this service is serving, once it has seen a decision. For tests and diagnostics. */
  public get liveGame(): IGame | undefined {
    return this.game;
  }

  // -------------------------------------------------------------------------------------------
  // Observing the live game
  // -------------------------------------------------------------------------------------------

  /**
   * Wraps the driver's responder - in a match, the **router**, so this sees every seat's decisions
   * (H4). Returns a responder the driver cannot distinguish from the one handed in: it forwards the
   * response unchanged and rethrows unchanged.
   *
   * A decision presented for an already-speculative game passes straight through unrecorded. That
   * cannot happen through the match runner, whose router only ever serves the live game, but an
   * agent that drove a fork with this wrapper would otherwise corrupt its own recording, and the
   * check is one `WeakSet` lookup.
   */
  public observeDecisions(inner: EmbeddedResponder): EmbeddedResponder {
    return (decision: EmbeddedDecisionPoint): InputResponse => {
      if (isSpeculative(decision.game)) {
        return inner(decision);
      }
      this.beginDecision(decision);
      const response = inner(decision);
      // The responder's move, which is the accepted one unless the Engine rejects it - in which
      // case `onFallback` below overwrites this with what the driver submitted instead (H3).
      if (this.open !== undefined) {
        this.open.response = copyResponse(response);
      }
      return response;
    };
  }

  /**
   * The driver options this service needs. Only `onFallback`, and only to correct the recorded
   * response to the one the Engine accepted (H3) - including the ~5.7-per-game case where the
   * responder threw and never returned one at all.
   */
  public get driverOptions(): EmbeddedDriverOptions {
    return {
      onFallback: (event) => {
        if (isSpeculative(event.decision.game)) {
          return;
        }
        if (this.open === undefined) {
          this.counters.fallbacksOutsideDecision++;
          return;
        }
        this.open.response = copyResponse(event.fallbackInput);
      },
    };
  }

  private beginDecision(decision: EmbeddedDecisionPoint): void {
    this.closeOpenDecision();
    if (this.game === undefined) {
      this.game = decision.game;
    } else if (this.game !== decision.game) {
      // A second live game through one service. Nothing in the runner does this; rather than
      // record two games' decisions into one replay list, start over on the new one.
      this.reset(decision.game);
    }
    this.counters.decisions++;
    this.open = {playerId: decision.player.id};
    this.liveModel = undefined;
  }

  /**
   * Folds the previous decision into the replay list. Called at the start of the next decision,
   * which is the first moment its accepted response is final: the driver resolves decision *k*
   * completely - responder, submission, fallback, drain - before presenting *k+1*.
   */
  private closeOpenDecision(): void {
    const open = this.open;
    this.liveModel = undefined;
    if (open === undefined) {
      return;
    }
    this.open = undefined;
    if (open.response === undefined) {
      // The decision never resolved: the responder produced nothing *and* the FR-9 fallback failed,
      // so the game is about to fail here. Drop the ancestor rather than keep a replay list with a
      // hole in it - a replay across a gap would diverge silently, which is the one outcome this
      // module exists to prevent.
      this.ancestor = undefined;
      this.steps = [];
      return;
    }
    this.steps.push({playerId: open.playerId, response: open.response});
  }

  private reset(game: IGame | undefined): void {
    this.game = game;
    this.ancestor = undefined;
    this.steps = [];
    this.open = undefined;
    this.liveModel = undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Forking
  // -------------------------------------------------------------------------------------------

  /**
   * A speculative game positioned at the live game's **current** decision point.
   *
   * Two paths, in order:
   *
   * 1. **The live point itself.** `snapshot` (which runs `assertSnapshotSafe`) then
   *    `restore(..., {verify: 'pending'})`. If both return, this point is forkable by the strict
   *    operational definition `bench/forkCost.ts` established - the phase guard accepting a point
   *    does *not* mean a restore reproduces it, and the action-phase failures are 100% silent - so
   *    it is adopted as the new ancestor and the replay list is cleared.
   * 2. **The carried ancestor, replayed forward.** Restore it, replay every accepted response
   *    since, and check the result lands on the live decision.
   *
   * Each call returns an **independent** game: restore-many from one snapshot is the access pattern
   * this is built for (1,697/s measured), so an agent scoring N candidates calls this N times.
   *
   * **Call this while a decision is being answered** - from inside the responder
   * {@link observeDecisions} wraps, which is where an agent naturally forks. The replay list holds
   * the decisions the driver has *finished with*, and the decision in flight is finished with only
   * once the driver has submitted it and any FR-9 fallback has corrected the recorded response
   * (H3). Called between decisions instead, the replay would be one step short. That misuse is
   * caught rather than silently served - the always-on pending check in {@link finish} sees the
   * wrong decision and returns `validation-failed` - but it costs a fork, so it is a contract, not
   * merely a safety net.
   */
  public fork(): ForkOutcome {
    const game = this.game;
    if (game === undefined) {
      return this.unavailable('no-game');
    }
    this.counters.attempts++;

    const direct = this.tryForkHere(game);
    if (direct !== undefined) {
      // Counted only once the fork has validated: a fork that did not reproduce the live position
      // is not a fork that was obtained, and G3's coverage figures would overstate themselves.
      const outcome = this.finish(game, direct, 0);
      if (outcome.available) {
        this.counters.direct++;
      }
      return outcome;
    }

    const ancestor = this.ancestor;
    if (ancestor === undefined) {
      this.counters.noAncestor++;
      return this.unavailable('no-ancestor');
    }

    const steps = this.steps;
    let restored: IGame;
    try {
      restored = registerSpeculative(restore(ancestor, {verify: 'pending'}));
    } catch (error) {
      if (!(error instanceof SnapshotFidelityError)) {
        throw error;
      }
      // The ancestor verified when it was adopted and does not now. Keep it - it may still be the
      // best available at a later point - but report this attempt as unavailable.
      return this.unavailable('restore-rejected', error.message);
    }

    // The replay is bracketed as speculation so that a submission escaping to the live game inside
    // it throws rather than corrupting the match (§3.2's cross-check).
    const replay = withSpeculation(() => replaySteps(restored, steps));
    this.counters.replaySubmissions += replay.submitted;
    if (replay.failure !== undefined) {
      return this.unavailable('replay-failed', replay.failure);
    }

    const outcome = this.finish(game, restored, steps.length);
    if (outcome.available) {
      this.counters.replayed++;
      this.counters.replayDistanceTotal += steps.length;
      this.counters.replayDistanceMax = Math.max(this.counters.replayDistanceMax, steps.length);
    }
    return outcome;
  }

  /**
   * The live point's own fork, or `undefined` when this point is not forkable.
   *
   * **Adoption requires all three checks, not the restore verifying.** `bench/forkCost.ts` adopted
   * ancestors on the strength of the guards returning cleanly, and this module originally copied
   * that - on the reasoning that a search has no original to compare a restore against. That
   * reasoning is wrong *here*: `tryForkHere` restores a snapshot of the **live game**, which is
   * sitting right there, so the finer comparison is available and the bench's standard was simply
   * the strongest one available to a suite measuring density. Adopting a point whose restore lands
   * on a regenerated decision would poison every later replay descended from it, silently (the
   * module doc's H7 correction).
   */
  private tryForkHere(game: IGame): IGame | undefined {
    let snap: GameSnapshot;
    try {
      snap = snapshot(game, {stripLog: this.stripLog});
    } catch (error) {
      if (error instanceof UnsafeSnapshotError) {
        return undefined;
      }
      throw error;
    }

    let restored: IGame;
    try {
      restored = restore(snap, {verify: 'pending'});
    } catch (error) {
      if (error instanceof SnapshotFidelityError) {
        // The phase guard accepted this point but the pending-signature check refused the restore:
        // Milestone 1 bullet 4's silent-failure population, seen from search's side.
        return undefined;
      }
      throw error;
    }

    if (pendingModelSignature(restored) !== this.liveModelSignature(game)) {
      // Restored faithfully by both of H7's checks and still on a different decision. Not forkable
      // here, and - the load-bearing half - **not adopted**, so no later replay starts from it.
      this.counters.modelRefusedHere++;
      return undefined;
    }

    this.ancestor = snap;
    this.steps = [];
    return registerSpeculative(restored);
  }

  /**
   * {@link pendingModelSignature} of the live game, computed once per decision.
   *
   * An agent scoring N candidates forks N times within one decision, and the live game is untouched
   * throughout (it only ever touches forks), so the signature is invariant across those calls. The
   * cache is cleared whenever a decision opens or closes, so the misuse case - forking between
   * decisions - recomputes rather than serving a stale answer.
   */
  private liveModelSignature(live: IGame): string {
    if (this.liveModel === undefined) {
      this.liveModel = pendingModelSignature(live);
    }
    return this.liveModel;
  }

  /**
   * Validates a fork against the live game and packages the result.
   *
   * **`pendingSignature` and {@link pendingModelSignature} are checked on every fork,
   * `stableStateOf` on a sample.** The three fail independently (H7 and the module doc's correction
   * to it), so none substitutes for another - but they do not cost the same. The pending check is a
   * player walk reading a plain property; the model check is one `toModel` per waiting player
   * (~7% of a decision, against a ~1 ms fork), with the live side cached per decision; the state
   * check serializes **both** games and stringifies them, which is the same order of magnitude as
   * the restore itself.
   *
   * So the two cheap checks are always on - the agent's correctness depends on the fork offering
   * *the decision it is about to answer*, which is exactly what the model check certifies and what
   * the other two cannot see - and the expensive one is sampled at
   * {@link ForkServiceOptions.validateRate} for criterion G3.
   */
  private finish(live: IGame, forked: IGame, replayDistance: number): ForkOutcome {
    const pendingOk = pendingSignature(forked) === pendingSignature(live);
    const wanted = this.validateStride > 0 && this.counters.attempts % this.validateStride === 0;
    const stateOk = wanted ?
      stableStateOf(forked.serialize(), {ignoreLog: this.stripLog}) === stableStateOf(live.serialize(), {ignoreLog: this.stripLog}) :
      undefined;

    if (wanted) {
      this.counters.stateValidated++;
    }
    if (!pendingOk || stateOk === false) {
      const kind: ReplayFailure = pendingOk ? 'stateMismatch' : stateOk === false ? 'bothMismatch' : 'pendingMismatch';
      this.counters.validationFailures[kind] = (this.counters.validationFailures[kind] ?? 0) + 1;
      return this.unavailable('validation-failed', kind);
    }

    // Both of H7's checks passed and the fork can still be on a different decision - the whole
    // point of the correction. Checked last because it is the finest and the other two are cheaper.
    if (pendingModelSignature(forked) !== this.liveModelSignature(live)) {
      this.counters.validationFailures.pendingModelMismatch = (this.counters.validationFailures.pendingModelMismatch ?? 0) + 1;
      return this.unavailable('validation-failed', 'pendingModelMismatch');
    }

    const player = nextWaitingPlayer(forked);
    if (player === undefined) {
      // Unreachable given a matching pending signature; kept because "unreachable" is a claim about
      // the Engine, and the alternative is a non-null assertion that would fail as a crash.
      return this.unavailable('validation-failed', 'noWaitingPlayer');
    }

    return {available: true, game: forked, player, replayDistance, stateValidated: wanted};
  }

  private unavailable(reason: ForkUnavailableReason, detail?: string): ForkUnavailable {
    this.counters.unavailable++;
    this.counters.unavailableByReason[reason]++;
    return detail === undefined ? {available: false, reason} : {available: false, reason, detail};
  }
}

function emptyStats(validateRate: number): ForkStats {
  return {
    decisions: 0,
    attempts: 0,
    direct: 0,
    replayed: 0,
    unavailable: 0,
    unavailableByReason: {
      'no-game': 0,
      'no-ancestor': 0,
      'restore-rejected': 0,
      'replay-failed': 0,
      'validation-failed': 0,
    },
    noAncestor: 0,
    replayDistanceTotal: 0,
    replayDistanceMax: 0,
    replaySubmissions: 0,
    stateValidated: 0,
    modelRefusedHere: 0,
    validationFailures: {},
    validateRate,
    fallbacksOutsideDecision: 0,
  };
}

/** Sums the stats of several services - one per game, or one per seat - into a run-level block. */
export function mergeForkStats(parts: ReadonlyArray<ForkStats>): ForkStats {
  const merged = emptyStats(parts[0]?.validateRate ?? 0);
  for (const part of parts) {
    merged.decisions += part.decisions;
    merged.attempts += part.attempts;
    merged.direct += part.direct;
    merged.replayed += part.replayed;
    merged.unavailable += part.unavailable;
    merged.noAncestor += part.noAncestor;
    merged.replayDistanceTotal += part.replayDistanceTotal;
    merged.replayDistanceMax = Math.max(merged.replayDistanceMax, part.replayDistanceMax);
    merged.replaySubmissions += part.replaySubmissions;
    merged.stateValidated += part.stateValidated;
    merged.modelRefusedHere += part.modelRefusedHere;
    merged.fallbacksOutsideDecision += part.fallbacksOutsideDecision;
    for (const reason of Object.keys(part.unavailableByReason) as Array<ForkUnavailableReason>) {
      merged.unavailableByReason[reason] += part.unavailableByReason[reason];
    }
    for (const [kind, count] of Object.entries(part.validationFailures) as Array<[ReplayFailure, number]>) {
      merged.validationFailures[kind] = (merged.validationFailures[kind] ?? 0) + count;
    }
  }
  return merged;
}
