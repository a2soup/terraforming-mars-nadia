import {Phase} from '@/common/Phase';
import {InputResponse} from '@/common/inputs/InputResponse';
import {ConstRandom} from '@/common/utils/Random';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {PlayerInput} from '@/server/PlayerInput';
import {AndOptions} from '@/server/inputs/AndOptions';
import {OrOptions} from '@/server/inputs/OrOptions';
import {SelectInitialCards} from '@/server/inputs/SelectInitialCards';
import {UndoActionOption} from '@/server/inputs/UndoActionOption';
import {enumerate, NotYetImplementedDecisionError, OutOfScopeDecisionError} from '../core/enumerator';
import {agentRandomFrom} from '../core/rng';
import {EmbeddedDecisionPoint, toDecisionPoint} from './decisionPoint';
import {EmbeddedResponder, Responder} from './responder';
import {computeResult, GameResult} from './gameResult';

const DEFAULT_MAX_DECISIONS = 100_000;

/**
 * The FR-9 conservative fallback's rng: every method returns the low end of its range /
 * the first element offered, never anything drawn from real randomness. Feeding this through
 * the *exact same* `enumerate` dispatch the B/C/D sub-tasks implemented (untouched by this
 * sub-task) is enough to get a fully deterministic, guaranteed-legal response for *every*
 * in-scope decision type - see {@link buildConservativeResponse}'s doc comment for why.
 *
 * This is exactly the `agentRandomFrom(new ConstRandom(0))` trick already used deliberately in
 * `composite.spec.ts`'s `initialCards` integration test to sidestep the same affordability
 * coupling this fallback exists to recover from - reused here as the drive path's own permanent
 * safety net rather than a one-off test trick.
 */
const CONSERVATIVE_RNG = agentRandomFrom(new ConstRandom(0));

/**
 * Builds (without submitting) a fully deterministic, guaranteed-legal-*at-its-own-input* response
 * for any in-scope decision (SRS FR-9's "never stall or error" safety net) - the construction
 * half of Milestone 1 sub-task E's fallback. {@link resubmitConservatively} is what actually
 * submits candidates via `player.process()` and is what `applyDecision` calls; this function is
 * the "build one candidate" primitive it (and this function itself, recursively, for composite
 * children) uses.
 *
 * **Coupling #1, anticipated going in** (Milestone1_Subtask_Prompts.md, sub-task E item 2): the
 * initial project-card `card` decision (part of the `initialCards` composite,
 * SelectInitialCards.ts) is a decision whose legal set the pure per-input enumerator cannot see
 * - `SelectCard.process` only checks count/membership, but `SelectInitialCards.completed()`
 * separately rejects the *whole* composite if the selected project cards' research cost exceeds
 * the chosen corporation's starting M€. A uniformly random `card` count (sub-task B) can
 * therefore over-select and produce a response that looks locally legal but is rejected one
 * level up.
 *
 * **The fix:** for `card`, select exactly `min` (affordable under any corporation, since 0 cards
 * cost 0 M€ - closes coupling #1; the corp/prelude/CEO sub-inputs inside `initialCards` all have
 * `min === max`, so this changes nothing about *them*, only the free-choice project-card count).
 * For `or`, take the first eligible (non-Undo) branch - `resubmitConservatively` is what tries
 * *further* branches if this one turns out not to work; this function only ever builds one
 * candidate per call, it does not know how to retry. For `and` / `initialCards`, recurse into
 * every child in order, same as their real enumerators. Every other type's *random* move is
 * already unconditionally legal at its own input regardless of which value produces it
 * (space/player/resource membership, amount/resources/productionToLose range and floor checks,
 * the payment reduction's own verified-before-returning legality), so those are answered by
 * running the real `enumerate` dispatch (untouched B/C/D code) with {@link CONSERVATIVE_RNG} - a
 * rng that always returns the low end of its range / the first element, so e.g. `enumerateCard`'s
 * `intInRange(min, max)` always lands on `min`, matching the `card` handling above via the *same*
 * code path (this is exactly the `agentRandomFrom(new ConstRandom(0))` trick already used
 * deliberately in `composite.spec.ts`'s `initialCards` integration test, reused here as the drive
 * path's permanent safety net).
 */
function buildConservativeResponse(decision: EmbeddedDecisionPoint): InputResponse {
  const {model, player, raw} = decision;

  switch (model.type) {
  case 'or': {
    const {option, index} = firstEligibleBranch(raw as OrOptions, player.id);
    return {type: 'or', index, response: buildConservativeResponse(toDecisionPoint(player, option))};
  }
  case 'and': {
    const options = (raw as AndOptions).options;
    return {type: 'and', responses: options.map((option) => buildConservativeResponse(toDecisionPoint(player, option)))};
  }
  case 'initialCards': {
    const options = (raw as SelectInitialCards).options;
    return {type: 'initialCards', responses: options.map((option) => buildConservativeResponse(toDecisionPoint(player, option)))};
  }
  default:
    return enumerate(decision, CONSERVATIVE_RNG);
  }
}

/** The non-`UndoActionOption` branches of `raw`, each paired with its index in `raw.options`. */
function eligibleBranches(raw: OrOptions): Array<{option: PlayerInput; index: number}> {
  return raw.options
    .map((option, index) => ({option, index}))
    .filter(({option}) => !(option instanceof UndoActionOption));
}

function firstEligibleBranch(raw: OrOptions, playerId: string): {option: PlayerInput; index: number} {
  const eligible = eligibleBranches(raw);
  if (eligible.length === 0) {
    // Every real OrOptions offers at least one non-Undo branch - see enumerateOr's identical
    // guard (composite.ts). Not expected to be reachable for a real decision.
    throw new Error(`buildConservativeResponse: an 'or' decision for player ${playerId} has no eligible (non-Undo) branch`);
  }
  return eligible[0];
}

/**
 * Resolves `decisionPoint` via the FR-9 conservative fallback and actually **submits** it via
 * `player.process()` - not just constructs a candidate and hopes it's accepted, which
 * {@link buildConservativeResponse} alone cannot guarantee. This distinction is itself a real
 * finding (Tier-1 batch, item 4; see agent/docs/Running_Notes.md): the `'projectCard'` decision
 * type is shared by two different Engine input classes - `SelectProjectCardToPlay` (play a card
 * from hand) and `SelectStandardProjectToPlay` (play a standard project) - both report `type:
 * 'projectCard'` and expose the same `cards`/`enabled` shape (their common base,
 * `SelectCardToPlay`), but standard projects use a different cost/eligibility model. Sub-task C's
 * `enumerateProjectCard` (payment.ts, untouched by this sub-task) was built and tested only
 * against `SelectProjectCardToPlay`; fed a `SelectStandardProjectToPlay`, it can fail two
 * different ways depending on state: if *no* standard project happens to be affordable, its
 * candidate filter finds nothing and throws immediately (never even producing a response); if
 * *one* happens to look affordable by coincidence, it still computes the payment using the wrong
 * (project-card) payment-options model, which `SelectStandardProjectToPlay`'s own `validate()`
 * then rejects at submission time. The first failure mode is caught by `buildConservativeResponse`
 * itself throwing (nothing to construct); the second is only detectable by actually attempting
 * `player.process()` - which is exactly why this function exists as a separate, submitting layer
 * rather than folding retry into `buildConservativeResponse`.
 *
 * For an `'or'` decision, this tries each eligible (non-Undo) branch **in order**, building and
 * *submitting* the whole decision with that branch's own conservative response, and stops at the
 * first branch whose submission is accepted - covering both of the failure modes above,
 * regardless of which one a given branch hits. Every real action-phase `OrOptions` includes a
 * `SelectOption` "pass" branch (Running_Notes, 2026-07-21/22), which is always both constructible
 * and accepted (`enumerateOption`/`SelectOption.process` ignore everything), so this always
 * terminates successfully as long as *some* branch works - in practice, always. For every other
 * decision type there is no branch to retry - a single `buildConservativeResponse` +
 * `player.process()` attempt, whose failure propagates directly (there is nothing else to try at
 * *this* level; `and`/`initialCards`' own children are all built via `buildConservativeResponse`,
 * which does not retry a nested `'or'` beyond its first branch - a bounded gap, not yet observed
 * in practice: no in-scope `and`/`initialCards` composite nests an `'or'` today).
 *
 * Returns the accepted response (useful for logging what actually worked). Throws if nothing
 * works - {@link applyDecision} wraps that as {@link UnrecoverableIllegalMoveError}.
 */
function resubmitConservatively(player: IPlayer, decisionPoint: EmbeddedDecisionPoint): InputResponse {
  const {model, raw} = decisionPoint;

  if (model.type !== 'or') {
    const candidate = buildConservativeResponse(decisionPoint);
    player.process(candidate);
    return candidate;
  }

  const eligible = eligibleBranches(raw as OrOptions);
  let lastError: unknown;
  for (const {option, index} of eligible) {
    let candidate: InputResponse;
    try {
      candidate = {type: 'or', index, response: buildConservativeResponse(toDecisionPoint(player, option))};
    } catch (buildError) {
      lastError = buildError;
      continue;
    }
    try {
      player.process(candidate);
      return candidate;
    } catch (processError) {
      // This branch built cleanly but the Engine rejected it (e.g. the SelectStandardProjectToPlay
      // payment mismatch above) - move on to the next eligible branch rather than giving up.
      lastError = processError;
    }
  }
  throw lastError ?? new Error(`resubmitConservatively: an 'or' decision for player ${player.id} has no eligible (non-Undo) branch to try`);
}

/**
 * Reported to {@link EmbeddedDriverOptions.onFallback} whenever a responder's move is rejected
 * and the driver recovers via {@link resubmitConservatively}. Carries enough to log or count the
 * occurrence - the fallback firing at all is the signal worth surfacing (SRS FR-9), regardless
 * of whether the caller wants the detail. `rejectedInput` is `undefined` when the responder
 * never produced a move at all (it threw before returning one - see `applyDecision`'s doc
 * comment for a real example: a `projectCard` decision whose live candidate set turned out
 * empty), as opposed to producing one the Engine then rejected.
 */
export type FallbackEvent = {
  decision: EmbeddedDecisionPoint;
  rejectedInput: InputResponse | undefined;
  rejectionCause: unknown;
  fallbackInput: InputResponse;
};

export type EmbeddedDriverOptions = {
  /**
   * Safety cap on decisions processed before giving up and throwing, so a driver or
   * engine stall becomes a diagnosable error instead of a hang. Default 100,000 -
   * comfortably above any real game, since a full game usually takes on the order of
   * hundreds of decisions.
   */
  maxDecisions?: number;
  /**
   * Called whenever the Engine rejects a responder's move and the driver recovers via the FR-9
   * conservative fallback (see {@link resubmitConservatively}). Always also logged via
   * `console.warn` regardless of this callback - a fallback firing is a "should be rare, worth
   * knowing about" signal on its own, distinct from the agent's routine per-decision trace
   * logging (SRS FR-11 / `randomLegalAgent.ts`), which is off by default. `onFallback` exists so
   * a caller (a test, the Tier-1 integration batch) can *count* occurrences without scraping
   * console output.
   */
  onFallback?: (event: FallbackEvent) => void;
};

/** Thrown when no player has a pending input but the game hasn't reached Phase.END. */
export class StuckGameError extends Error {
  constructor(game: IGame) {
    super(`Game ${game.id} has no player with a pending input, but phase is '${game.phase}', not '${Phase.END}'.`);
  }
}

/** Thrown when `maxDecisions` is exceeded without the game reaching Phase.END. */
export class DriverDecisionLimitError extends Error {
  constructor(game: IGame, maxDecisions: number) {
    super(`Game ${game.id} did not reach Phase.END within ${maxDecisions} decisions.`);
  }
}

/**
 * Thrown when a responder selects Undo. Embedded/headless play runs on a no-op
 * Database (see headlessEngine.ts) with no persisted save history, so the
 * restore-a-prior-save mechanics real Undo relies on (src/server/routes/PlayerInput.ts)
 * are meaningless here. A Responder must never choose it; the driver enforces that
 * rather than trusting every responder to know this.
 */
export class UndoNotSupportedError extends Error {
  constructor(decision: EmbeddedDecisionPoint) {
    super(`Player ${decision.player.id} selected Undo, which embedded/headless play does not support.`);
  }
}

/**
 * Thrown when a decision could not be resolved: either `player.process(input)` rejected a
 * response the responder *did* produce, or the responder failed to produce one at all (it
 * threw - see `applyDecision`'s doc comment). The Engine itself restores the player's pending
 * input before rethrowing a `process()` rejection (`Player.process`), so the decision is still
 * there, unchanged, either way - which is exactly what makes the fallback-and-resubmit below
 * possible. `applyDecision` constructs this internally on *either* kind of failure, for *either*
 * attempt; when the first attempt fails it is caught and never surfaces to the caller (see
 * {@link UnrecoverableIllegalMoveError} for when it does). `input` is `undefined` when the
 * responder itself threw.
 */
export class IllegalMoveError extends Error {
  constructor(
    public readonly decision: EmbeddedDecisionPoint,
    public readonly input: InputResponse | undefined,
    public readonly cause: unknown,
  ) {
    super(
      `Illegal move for player ${decision.player.id} on a '${decision.model.type}' decision: ` +
      `${input === undefined ? 'the responder failed to produce a move' : `move ${JSON.stringify(input)}`} - ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Thrown when *both* a responder's move and the FR-9 conservative fallback ({@link
 * resubmitConservatively}) were rejected by the Engine for the same decision. Per that
 * function's own doc comment this should be rare for an in-scope decision (every eligible
 * branch of an `'or'` would have to be unresolvable). Seeing this means either a genuinely
 * out-of-scope/unexpected Engine state, or - more likely, if it's ever actually observed - a
 * gap in the fallback's own reasoning worth investigating directly, not something to retry
 * further. Carries both attempts' {@link IllegalMoveError}s so the original responder's
 * mistake and the fallback's own failure can both be inspected.
 */
export class UnrecoverableIllegalMoveError extends Error {
  constructor(
    public readonly original: IllegalMoveError,
    public readonly fallback: IllegalMoveError,
  ) {
    super(
      `Both the responder's move and the FR-9 conservative fallback were rejected for player ` +
      `${original.decision.player.id} on a '${original.decision.model.type}' decision. ` +
      `Original: ${original.message} Fallback: ${fallback.message}`,
    );
  }
}

/**
 * Drives a headless game from its current state to completion (Phase.END),
 * surfacing each pending decision to `responder` and applying its response. Returns
 * the final outcome (gameResult.ts).
 *
 * Mirrors the Engine's own drive pattern used throughout its test suite (e.g.
 * tests/Game.spec.ts): `player.process(input)`, then drain
 * `game.deferredActions.runAll()` *only if the player has no pending input of its own yet* -
 * see `applyDecision`'s doc comment for why the guard is there (a real driver bug the Tier-1
 * batch surfaced, agent/docs/Running_Notes.md). When more than one player has a pending input
 * simultaneously (e.g. every player picks their starting corporation/cards at once), they are
 * resolved one at a time in `playersInGenerationOrder` for reproducibility.
 */
export function runGame(game: IGame, responder: Responder | EmbeddedResponder, options: EmbeddedDriverOptions = {}): GameResult {
  const maxDecisions = options.maxDecisions ?? DEFAULT_MAX_DECISIONS;

  let decisions = 0;
  while (game.phase !== Phase.END) {
    const player = nextWaitingPlayer(game);
    if (player === undefined) {
      throw new StuckGameError(game);
    }
    if (decisions >= maxDecisions) {
      throw new DriverDecisionLimitError(game, maxDecisions);
    }
    decisions++;

    applyDecision(player, responder, options);
  }
  return computeResult(game);
}

/**
 * Surfaces and applies exactly one pending decision for `player`. Exported for tests
 * that need to inspect individual steps rather than a full game run.
 *
 * **FR-9 fallback-and-resubmit** (Milestone 1 sub-task E, item 2 - widened per a genuine second
 * coupling the Tier-1 batch surfaced, see below). Two distinct ways a responder can fail to
 * produce an applied move for a decision, both recovered the same way:
 *
 * 1. **The responder's move is rejected by `player.process()`** - the coupling the sub-task E
 *    prompt anticipated: a `card` decision's own input only checks count/membership, but a
 *    composite ancestor (`SelectInitialCards.completed()`) can reject the whole thing on a
 *    budget check the per-input enumerator can't see.
 * 2. **The responder itself throws, never producing a move, *or* produces one that "looks"
 *    fine but is rejected for a reason specific to the sub-decision** - a coupling *not*
 *    anticipated going in, found only by actually driving real games to `Phase.END` (Tier-1
 *    batch, item 4): the `'projectCard'` decision type is shared by *two* different Engine input
 *    classes - `SelectProjectCardToPlay` (play a card from hand) and `SelectStandardProjectToPlay`
 *    (play a standard project) - both report `type: 'projectCard'` (`SelectCardToPlay.ts`, their
 *    common base class) and both expose the same `cards`/`enabled` shape, but standard projects
 *    use a different cost/eligibility model (`card.canAct`/`card.getAdjustedCost`, not
 *    `player.affordOptionsForCard`/`canAfford`). Sub-task C's `enumerateProjectCard` (payment.ts,
 *    untouched by this sub-task) was built and tested only against `SelectProjectCardToPlay`; fed
 *    a `SelectStandardProjectToPlay`, it fails two different ways depending on state: no
 *    affordable candidate at all (throws immediately) or an affordable-*looking* candidate whose
 *    computed payment is simply wrong for a standard project (a rejected `player.process()` deep
 *    inside an `'or'` branch). See agent/docs/Running_Notes.md (dated entry) for the full finding
 *    and why fixing `enumerateProjectCard` itself is left as follow-up, not done here.
 *
 * Both cases are recovered identically: retry with {@link resubmitConservatively}, which builds
 * and *submits* a response computed fresh from *this* decision (not the failed sub-decision).
 * For an `'or'` decision (which is what actually failed above; `SelectStandardProjectToPlay` was
 * one branch deep either way) it tries each non-Undo branch in order, actually submitting each
 * one, and stops at the first that's accepted - so a broken branch elsewhere in the same
 * `OrOptions` (as long as it isn't every branch - in practice the ever-present "pass" branch is
 * always resolvable) is simply skipped past, regardless of *which* of the two ways it's broken.
 * This is safe to retry because `player.process()` restores the pending input on rejection
 * (`Player.process`, confirmed in agent/docs/Running_Notes.md, 2026-07-21/22) and the responder
 * call has no side effects of its own to undo. The fallback is logged loudly (`console.warn`) and
 * reported via `options.onFallback` every time it fires, so a batch run can tell how often either
 * coupling actually bites.
 *
 * {@link OutOfScopeDecisionError} and {@link NotYetImplementedDecisionError} are deliberately
 * *not* retried: both are dispatch-level ("this decision type has no handler at all", not
 * "this particular state tripped up an otherwise-working handler"), so
 * `buildConservativeResponse` - which dispatches through the exact same `enumerate` - would fail
 * identically; retrying would only hide the loud, immediate signal FR-9 wants for those cases.
 *
 * Only if the fallback *itself* cannot find any branch that's accepted - which should be rare
 * for any in-scope decision - does this throw ({@link UnrecoverableIllegalMoveError}).
 */
export function applyDecision(player: IPlayer, responder: Responder | EmbeddedResponder, options: EmbeddedDriverOptions = {}): void {
  const waitingFor = player.getWaitingFor();
  if (waitingFor === undefined) {
    throw new Error(`applyDecision called for player ${player.id}, which has no pending input.`);
  }
  const decisionPoint = toDecisionPoint(player, waitingFor);

  let input: InputResponse | undefined;
  let cause: unknown;
  try {
    input = responder(decisionPoint);
    if (isUndoSelection(waitingFor, input)) {
      throw new UndoNotSupportedError(decisionPoint);
    }
    player.process(input);
  } catch (thrown) {
    if (thrown instanceof UndoNotSupportedError || thrown instanceof OutOfScopeDecisionError || thrown instanceof NotYetImplementedDecisionError) {
      throw thrown;
    }
    cause = thrown;
  }

  if (cause !== undefined) {
    const original = new IllegalMoveError(decisionPoint, input, cause);

    let fallbackInput: InputResponse;
    try {
      fallbackInput = resubmitConservatively(player, decisionPoint);
    } catch (fallbackCause) {
      // The fallback itself couldn't find any branch/response that the Engine would accept -
      // genuinely unrecoverable, not something a further retry would fix.
      throw new UnrecoverableIllegalMoveError(original, new IllegalMoveError(decisionPoint, undefined, fallbackCause));
    }

    const event: FallbackEvent = {decision: decisionPoint, rejectedInput: input, rejectionCause: cause, fallbackInput};
    console.warn(
      `[embeddedDriver] FR-9 fallback: player ${player.id}'s '${waitingFor.type}' decision could not be resolved ` +
      `(${original.message}) - resubmitted the conservative fallback (accepted: ${JSON.stringify(fallbackInput)}) instead.`,
    );
    options.onFallback?.(event);
  }

  // Drain any deferred actions left over from this decision - **but only if `player` doesn't
  // already have a fresh pending input**. This guard is the fix for a genuine driver bug the
  // Tier-1 batch surfaced (see agent/docs/Running_Notes.md, dated entry): `Player.process()`'s
  // own callback chain (`waitingForCb`, wired up via `Player.takeAction()` /
  // `Player.runWhenEmpty()`) already drains `game.deferredActions` itself whenever the decision
  // it just resolved calls back into that machinery - which is most of them (the main
  // action-phase loop, prelude selection, ...). If it does, `player.getWaitingFor()` is already
  // set to the *next* real decision by the time `process()` returns, and calling `runAll()`
  // again here unconditionally does not no-op - `DeferredActionsQueue.run()` doesn't check
  // whether the target player already has a pending `waitingFor`, so a *second*, unrelated
  // deferred action still queued for the same player (e.g. a second prelude's own tile
  // placement, queued moments earlier but not yet reached by the internal chain) gets popped
  // and executed too, silently overwriting the fresh decision the internal chain just set
  // (`Player.setWaitingFor`'s own "Overwriting waitingFor X with Y" warning) - permanently
  // losing whatever continuation the overwritten decision was guarding. Only call `runAll()`
  // ourselves when the player has *no* pending input yet, which is exactly the case where the
  // decision just resolved did *not* route through that self-draining machinery (e.g. the
  // simultaneous `initialCards` setup, whose completion callback doesn't set `waitingFor` on
  // the just-processed player at all) and something still needs to advance the queue.
  if (player.getWaitingFor() === undefined) {
    player.game.deferredActions.runAll(() => {});
  }
}

function isUndoSelection(waitingFor: PlayerInput, input: InputResponse): boolean {
  return input.type === 'or' && waitingFor instanceof OrOptions && waitingFor.options[input.index] instanceof UndoActionOption;
}

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}
