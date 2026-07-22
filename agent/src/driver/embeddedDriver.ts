import {Phase} from '@/common/Phase';
import {InputResponse} from '@/common/inputs/InputResponse';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {PlayerInput} from '@/server/PlayerInput';
import {OrOptions} from '@/server/inputs/OrOptions';
import {UndoActionOption} from '@/server/inputs/UndoActionOption';
import {EmbeddedDecisionPoint, toDecisionPoint} from './decisionPoint';
import {EmbeddedResponder, Responder} from './responder';
import {computeResult, GameResult} from './gameResult';

const DEFAULT_MAX_DECISIONS = 100_000;

export type EmbeddedDriverOptions = {
  /**
   * Safety cap on decisions processed before giving up and throwing, so a driver or
   * engine stall becomes a diagnosable error instead of a hang. Default 100,000 -
   * comfortably above any real game, since a full game usually takes on the order of
   * hundreds of decisions.
   */
  maxDecisions?: number;
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
 * Thrown when `player.process(input)` rejects a response as illegal. The Engine
 * itself restores the player's pending input before rethrowing (Player.process), so
 * the decision is still there, unchanged, for a corrected response.
 */
export class IllegalMoveError extends Error {
  constructor(
    public readonly decision: EmbeddedDecisionPoint,
    public readonly input: InputResponse,
    public readonly cause: unknown,
  ) {
    super(`Illegal move for player ${decision.player.id} on a '${decision.model.type}' decision: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * Drives a headless game from its current state to completion (Phase.END),
 * surfacing each pending decision to `responder` and applying its response. Returns
 * the final outcome (gameResult.ts).
 *
 * Mirrors the Engine's own drive pattern used throughout its test suite (e.g.
 * tests/Game.spec.ts): `player.process(input)` then drain
 * `game.deferredActions.runAll()` before looking for the next pending input. When
 * more than one player has a pending input simultaneously (e.g. every player picks
 * their starting corporation/cards at once), they are resolved one at a time in
 * `playersInGenerationOrder` for reproducibility.
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

    applyDecision(player, responder);
  }
  return computeResult(game);
}

/**
 * Surfaces and applies exactly one pending decision for `player`. Exported for tests
 * that need to inspect individual steps rather than a full game run.
 */
export function applyDecision(player: IPlayer, responder: Responder | EmbeddedResponder): void {
  const waitingFor = player.getWaitingFor();
  if (waitingFor === undefined) {
    throw new Error(`applyDecision called for player ${player.id}, which has no pending input.`);
  }
  const decisionPoint = toDecisionPoint(player, waitingFor);
  const input = responder(decisionPoint);

  if (isUndoSelection(waitingFor, input)) {
    throw new UndoNotSupportedError(decisionPoint);
  }

  try {
    player.process(input);
  } catch (cause) {
    throw new IllegalMoveError(decisionPoint, input, cause);
  }
  player.game.deferredActions.runAll(() => {});
}

function isUndoSelection(waitingFor: PlayerInput, input: InputResponse): boolean {
  return input.type === 'or' && waitingFor instanceof OrOptions && waitingFor.options[input.index] instanceof UndoActionOption;
}

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}
