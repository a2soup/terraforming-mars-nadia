import {InputResponse} from '@/common/inputs/InputResponse';
import {Player} from '@/server/Player';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedResponder} from '../driver/responder';
import {causeSignature, errorClassName, representativeMessage} from './causes';
import {CauseTally, SubmissionSource} from './types';

/**
 * Counts **every** `player.process()` call made during a run and records which of them the Engine
 * rejected, attributed to the code that made them (criterion L5, agent/docs/AC1_Legality_Run.md).
 *
 * **Why this exists rather than just counting the driver's `onFallback` events.** `onFallback`
 * reports one event per recovered decision, carrying the *accepted* fallback response. It cannot
 * see the rejected candidates `resubmitConservatively` submits while walking an `'or'` decision's
 * branches looking for one the Engine accepts (embeddedDriver.ts). Those are real submissions of
 * moves the Engine rejects. They are deliberate, bounded recovery probes rather than blunders -
 * but a document claiming "zero illegal moves" that silently omits a population of rejected
 * submissions is not evidence, it is an accounting choice presented as a result. So the run
 * observes the submission boundary itself.
 *
 * **Why a prototype wrapper rather than a driver hook.** `embeddedDriver.ts` is load-bearing,
 * spec-covered code that this run *verifies*; changing it to measure it would mean the thing
 * measured is not the thing that has been running since bullet 3. Wrapping `Player.prototype.process`
 * is the same instrumentation technique bullet 5 used for its component breakdown and bullet 6 used
 * to diagnose the deferred-action double-drain: it observes the existing code path without altering
 * it. Behaviour-neutrality is not assumed - `checkInstrumentationNeutrality`
 * (`instrumentationCheck.ts`) plays the same configs through the uninstrumented determinism
 * harness and through the fully instrumented runner and compares what both observe.
 *
 * **Attribution rule.** Within one `applyDecision`, the driver calls the responder exactly once
 * and then submits its move at most once; every *further* submission for that decision comes from
 * the FR-9 fallback. So: the first `process()` after the responder returns a move is the
 * responder's, everything else is a fallback probe. The responder wrapper ({@link observeResponder})
 * is what marks that boundary - which is also how a responder that throws before producing a move
 * (class B - nothing submitted) is distinguished from one whose move was rejected (class A - an
 * illegal move).
 */

type ProcessFn = (input: InputResponse) => void;

/** Per-game counters, reset by {@link SubmissionMonitor.startGame}. */
export type GameCounters = {
  submissions: number;
  rejectedResponder: number;
  rejectedFallbackProbe: number;
  responderThrows: number;
};

export class SubmissionMonitor {
  private originalProcess: ProcessFn | undefined;
  /** True between the responder returning a move and that move being submitted - see the attribution rule. */
  private responderMovePending = false;
  private counters: GameCounters = emptyCounters();
  private readonly tallies = new Map<string, CauseTally>();

  /** Wraps `Player.prototype.process`. Idempotent; {@link uninstall} restores the original. */
  public install(): void {
    if (this.originalProcess !== undefined) {
      return;
    }
    const original = Player.prototype.process as ProcessFn;
    this.originalProcess = original;
    const monitor = this;
    Player.prototype.process = function(this: Player, input: InputResponse): void {
      const source: SubmissionSource = monitor.responderMovePending ? 'responder' : 'fallback-probe';
      monitor.responderMovePending = false;
      const decisionType = this.getWaitingFor()?.type ?? '<none>';
      monitor.counters.submissions++;
      try {
        original.call(this, input);
      } catch (cause) {
        if (source === 'responder') {
          monitor.counters.rejectedResponder++;
        } else {
          monitor.counters.rejectedFallbackProbe++;
        }
        monitor.tally(source, decisionType, cause);
        throw cause;
      }
    } as ProcessFn;
  }

  public uninstall(): void {
    if (this.originalProcess === undefined) {
      return;
    }
    Player.prototype.process = this.originalProcess;
    this.originalProcess = undefined;
  }

  public get installed(): boolean {
    return this.originalProcess !== undefined;
  }

  /** Resets the per-game counters (cause tallies accumulate across the whole run) and returns them. */
  public startGame(): void {
    this.counters = emptyCounters();
    this.responderMovePending = false;
  }

  public get gameCounters(): GameCounters {
    return {...this.counters};
  }

  public get causeTallies(): ReadonlyArray<CauseTally> {
    return [...this.tallies.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
  }

  /**
   * Wraps a responder so the monitor can see the decision boundary: which submission is the
   * responder's own, and whether the responder produced a move at all. Returns a responder the
   * driver cannot distinguish from the one passed in - it forwards the response unchanged and
   * rethrows unchanged.
   */
  public observeResponder(inner: EmbeddedResponder): EmbeddedResponder {
    return (decision: EmbeddedDecisionPoint): InputResponse => {
      this.responderMovePending = false;
      try {
        const response = inner(decision);
        this.responderMovePending = true;
        return response;
      } catch (cause) {
        // Class B: the responder never produced a move, so nothing was submitted and no illegal
        // move exists - but this is the dominant FR-9 fallback trigger, so it is counted here
        // under its own source rather than left invisible.
        this.counters.responderThrows++;
        this.tally('responder-throw', decision.model.type, cause);
        throw cause;
      }
    };
  }

  private tally(source: SubmissionSource | 'responder-throw', decisionType: string, cause: unknown): void {
    const errorClass = errorClassName(cause);
    const signature = causeSignature(cause);
    const key = `${source}|${decisionType}|${errorClass}|${signature}`;
    const existing = this.tallies.get(key);
    if (existing !== undefined) {
      existing.count++;
      return;
    }
    this.tallies.set(key, {
      source, decisionType, errorClass, signature,
      count: 1,
      representative: representativeMessage(cause),
    });
  }
}

function emptyCounters(): GameCounters {
  return {submissions: 0, rejectedResponder: 0, rejectedFallbackProbe: 0, responderThrows: 0};
}
