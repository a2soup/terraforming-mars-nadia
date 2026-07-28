/**
 * A game of Terraforming Mars, played out one decision at a time on a timer so a human can
 * follow along.
 *
 * This is deliberately *not* the agent's `runGame` driver (agent/src/driver/embeddedDriver.ts),
 * which runs a whole game to completion in one synchronous burst - that would starve the web
 * server and the game would be over before the browser rendered a single frame. Instead it
 * reuses that driver's `applyDecision` (so the FR-9 fallback, the deferred-action draining and
 * every other hard-won detail still apply) and paces the calls with `setTimeout`, leaving the
 * event loop free to serve the UI in between.
 */
import {InputResponse} from '@/common/inputs/InputResponse';
import {Phase} from '@/common/Phase';
import {Color} from '@/common/Color';
import {PlayerId} from '@/common/Types';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {applyDecision} from '../src/driver/embeddedDriver';
import {computeResult, GameResult} from '../src/driver/gameResult';
import {EmbeddedResponder} from '../src/driver/responder';

export type DecisionInfo = {
  /** 1-based count of decisions resolved so far this game. */
  index: number;
  generation: number;
  playerName: string;
  color: Color;
  /** The Engine's decision type, e.g. 'projectCard', 'or', 'space'. */
  decisionType: string;
  /**
   * What the agent chose. `undefined` if its move was rejected and the driver's conservative
   * fallback had to step in - which the driver logs loudly on its own.
   */
  response: InputResponse | undefined;
};

export type MatchEvents = {
  onDecision: (info: DecisionInfo) => void;
  onFinish: (result: GameResult) => void;
  onError: (error: unknown) => void;
};

export class PacedMatch {
  private timer: NodeJS.Timeout | undefined;
  private paused = false;
  private stopped = false;
  private decisions = 0;

  constructor(
    private readonly game: IGame,
    private readonly responders: ReadonlyMap<PlayerId, EmbeddedResponder>,
    private readonly delayMs: number,
    private readonly events: MatchEvents) {}

  public get isPaused(): boolean {
    return this.paused;
  }

  public get isRunning(): boolean {
    return !this.stopped;
  }

  public get decisionCount(): number {
    return this.decisions;
  }

  public start(): void {
    this.schedule();
  }

  public pause(): void {
    if (this.paused || this.stopped) {
      return;
    }
    this.paused = true;
    this.clearTimer();
  }

  public resume(): void {
    if (!this.paused || this.stopped) {
      return;
    }
    this.paused = false;
    this.schedule();
  }

  public togglePause(): void {
    this.paused ? this.resume() : this.pause();
  }

  /** Resolves exactly one decision and stays paused. No-op unless paused. */
  public step(): void {
    if (!this.paused || this.stopped) {
      return;
    }
    this.tick(false);
  }

  public stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.tick(true), this.delayMs);
  }

  private tick(scheduleNext: boolean): void {
    this.timer = undefined;
    if (this.stopped) {
      return;
    }

    if (this.finishIfEnded()) {
      return;
    }

    const player = this.nextWaitingPlayer();
    if (player === undefined) {
      this.stopped = true;
      this.events.onError(new Error(
        `no player is waiting for input, but the game is in phase '${this.game.phase}', not '${Phase.END}'.`));
      return;
    }

    const responder = this.responders.get(player.id);
    if (responder === undefined) {
      this.stopped = true;
      this.events.onError(new Error(`no agent is seated as player ${player.id}.`));
      return;
    }

    const decisionType = player.getWaitingFor()?.type ?? 'unknown';
    let response: InputResponse | undefined;
    const capturing: EmbeddedResponder = (decision) => {
      response = responder(decision);
      return response;
    };

    try {
      applyDecision(player, capturing);
    } catch (error) {
      this.stopped = true;
      this.events.onError(error);
      return;
    }

    this.decisions++;
    this.events.onDecision({
      index: this.decisions,
      generation: this.game.generation,
      playerName: player.name,
      color: player.color,
      decisionType,
      response,
    });

    if (this.finishIfEnded()) {
      return;
    }
    if (scheduleNext) {
      this.schedule();
    }
  }

  /**
   * Reports the final result and stops, if the game is over. A method rather than an inline
   * check in both places `tick` needs it: TypeScript narrows `game.phase` at the first check
   * and keeps that narrowing across the `applyDecision` call in between - it has no way to
   * know the call is what ends the game - so an inline second check reads as dead code.
   */
  private finishIfEnded(): boolean {
    if (this.game.phase !== Phase.END) {
      return false;
    }
    this.stopped = true;
    this.events.onFinish(computeResult(this.game));
    return true;
  }

  /**
   * Same rule the headless driver uses: when several players are waiting at once (everyone
   * choosing their starting corporation, say), resolve them in generation order.
   */
  private nextWaitingPlayer(): IPlayer | undefined {
    return this.game.playersInGenerationOrder.find((player) => player.getWaitingFor() !== undefined);
  }
}
