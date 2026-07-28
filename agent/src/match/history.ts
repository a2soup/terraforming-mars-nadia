import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {InputResponse} from '@/common/inputs/InputResponse';
import {PlayerId} from '@/common/Types';
import {IGame} from '@/server/IGame';
import {Player} from '@/server/Player';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedResponder} from '../driver/responder';
import {pendingSignature} from '../engine/snapshot';
import {firstDivergence, stableStringify} from '../determinism/replay';
import {TraceStep} from '../determinism/types';
import {causeSignature, errorClassName} from '../legality/causes';
import {SubmissionSource} from '../legality/types';
import {defaultOutputDir} from './artifact';
import {MatchLegalityMode} from './legality';
import {MatchCaptureOptions, MatchInstrument, playMatchGame, seatPlayerId} from './runner';
import {
  MatchGameConfig,
  MatchGameHistory,
  MatchGameRecord,
  MatchInstrumentationReport,
  MatchRunHeader,
} from './types';

/**
 * **Full move histories, recorded at the boundary where the truth is** (SRS FR-13; Milestone 2
 * bullet 1, Unit B; §4.4 of agent/docs/Milestone2_Bullet1_Prompts.md).
 *
 * FR-13 says the match runner records "outcomes and full move histories". This module is the
 * histories half, and the whole difficulty in it is *where to stand to observe them*.
 *
 * ---
 *
 * ## The instrument, and why the obvious one is wrong (hazard H2)
 *
 * The obvious implementation is to wrap the responder and record what it returns. Milestone 1
 * measured, at 1,500-game scale, two distinct reasons that produces a history of moves that were
 * never played:
 *
 * 1. **The FR-9 fallback substitutes a different move.** When `player.process(input)` rejects the
 *    responder's move, `applyDecision` (`driver/embeddedDriver.ts`) resubmits
 *    `resubmitConservatively`'s response *instead*. A wrapper that records the responder's return
 *    value records a move the Engine rejected, as though it had been played.
 * 2. **When the responder throws, it never returns at all**, so a wrapper records **nothing** for
 *    that decision - the decision is simply absent from the history. `agent/CLAUDE.md` §6 records
 *    this exact property of the determinism corpus's `moveTraceHash`: *"has no step for a decision
 *    the responder threw on."*
 *
 * This is not an edge case. The AC-1 run measured **8,480 responder throws across 1,500 games,
 * ~5.7 per game**, all one benign cause. Every history this runner produces contains them, and a
 * test on a single clean game passes anyway - which is exactly why the wrong answer is the one that
 * survives review.
 *
 * **Two instruments were available, both proven** (§5, H2):
 *
 * | Instrument | Sees | Cannot see |
 * | --- | --- | --- |
 * | `EmbeddedDriverOptions.onFallback` | one event per *recovered decision*, carrying `fallbackInput` (accepted) and `rejectedInput` (`undefined` when the responder threw) | the FR-9 fallback's own rejected `'or'`-branch probes; anything about decisions that did not need recovery |
 * | `Player.prototype.process` wrapper (`legality/submissionMonitor.ts`) | **every submission**, accepted or rejected, whoever made it | which lineup slot / what the responder *intended* where it never submitted |
 *
 * **The choice: the `Player.prototype.process` wrapper**, for three reasons, in order of weight.
 *
 * - **It is the only instrument whose output is a record of what the Engine was actually asked to
 *   do.** `onFallback` would reconstruct the accepted move correctly (responder's move when no
 *   fallback event fired, `fallbackInput` when one did), so a history of *accepted* moves is
 *   obtainable either way. What `onFallback` cannot reconstruct is the population of *rejected*
 *   submissions, because it reports one event per decision and the fallback may probe several `'or'`
 *   branches before one is accepted. Those probes are real submissions of moves the Engine rejected.
 * - **The rejected attempts are exactly the population an AC-1 re-run is adjudicated on** (§4.6),
 *   and dropping them silently is how the Milestone 1 accounting nearly went wrong the first time:
 *   *"a document claiming 'zero illegal moves' that silently omits a population of rejected
 *   submissions is not evidence, it is an accounting choice presented as a result"*
 *   (`legality/submissionMonitor.ts`). So this module records **both** - the accepted move, which is
 *   what the history *is*, and every rejected attempt beside it, attributed to its source.
 * - **It is the same boundary the absorbed legality accounting lives on**, which is why §4.6's mode
 *   is in this unit and shares this one wrapper rather than installing a second one (see "One
 *   wrapper" below).
 *
 * **What this instrument cannot see, stated so nobody assumes otherwise:**
 *
 * - **A decision the responder never submitted anything for and the fallback resolved.** The
 *   responder's *intent* on a decision it threw on does not exist - it produced no move. The history
 *   records `responderThrew: true` and the fallback's accepted move, which is the complete truth
 *   about what was played, but it is not a record of what the agent "wanted". Nothing can be.
 * - **Sub-decisions inside a composite.** `Player.process` is called once per top-level decision;
 *   `AndOptions`/`OrOptions`/`SelectInitialCards` dispatch to child inputs *inside* that call
 *   (`src/server/inputs/*.ts`). The recorded `InputResponse` is the whole composite response, which
 *   is the unit the Agent chooses and submits, so this is the right granularity - but it means the
 *   history has one entry per driver decision, not one per leaf choice.
 * - **Which lineup slot made a submission**, directly. It is derived from the player id via the
 *   config's seating (`seat`/`playerId` on every entry), which is exact but is a join, not an
 *   observation.
 * - **A submission made while no decision is open.** None occur in embedded play - every
 *   `player.process()` comes from `applyDecision` - but rather than assume it, stray calls are
 *   counted and reported as `strayProcessCalls` in the run-level detail. A non-zero value is a
 *   finding about the driver, not a rounding error.
 *
 * ## One wrapper, nested, with one owner
 *
 * Legality mode (§4.6) needs `SubmissionMonitor`, which installs its own `Player.prototype.process`
 * wrapper. The history recorder needs one too. Two *independent* things wrapping a prototype method
 * in one process is a bug waiting to happen - so there is one owner (this class), one install order,
 * and LIFO teardown:
 *
 * ```
 * driver -> [history recorder] -> [SubmissionMonitor] -> Player.prototype.process   (the real one)
 * driver -> [history recorder] -> [monitor.observeResponder] -> the router -> the seat's agent
 * ```
 *
 * **The monitor is the inner layer at both boundaries, deliberately.** The AC-1 counters are the
 * load-bearing numbers, so they are the ones insulated from this module's code: with the monitor
 * innermost, a throw from *this* module's bookkeeping cannot land inside the monitor's `try` and be
 * counted as an Engine rejection. Were the order reversed, a bug here would inflate
 * `rejectedResponder` - the single number NFR-4 is adjudicated on.
 *
 * At `summary` tier with legality mode on, this module installs **no** process wrapper of its own:
 * the monitor is then the only wrapper in the process, byte-identically to the AC-1 runner's own
 * instrumentation. Criterion R8 compares both stacks against `runLegalityBatch` for exactly that
 * reason (`match/legality.ts`).
 *
 * ## A seed-addressed history is the primary reproduction mechanism
 *
 * Determinism is verified move-for-move under a fixed `(engine seed, agent seed, engine commit,
 * agent version)` (docs/Determinism_Verification.md), so **a recorded game is re-derived from its
 * record's seeds**, not replayed from its stored move list. The `moves` tier exists for human and
 * tool inspection - reading what happened, M3 debugging, AC-6 expert review - and
 * {@link verifyGameRecord} is the check that the two agree. The opposite assumption (feed the stored
 * moves back into a fresh game to rebuild it) is the natural one and it is fragile: the Engine's
 * decision sequence depends on state the move list does not carry.
 *
 * ## The submission trace, and how it differs from the determinism corpus's move trace
 *
 * {@link SubmissionTrace} is a rolling hash chain, one link per **decision**, built exactly the way
 * `determinism/replay.ts`'s `MoveTrace` builds its own (`sha256(previousHash + '|' + stepInput)`,
 * responses serialized with that module's {@link stableStringify}) and emitting the same
 * {@link TraceStep} shape, so {@link firstDivergence} localizes a mismatch to a decision index
 * without a line of new comparison logic.
 *
 * `MoveTrace` itself is *not* exported and `agent/src/determinism/` is not modified by this bullet
 * (§9), so the chain construction is mirrored here rather than shared. That is the one piece of
 * duplication in this module and it is deliberate; {@link SUBMISSION_TRACE_GENESIS} is a *different*
 * genesis value than `replay.ts`'s so the two hashes can never be mistaken for each other in an
 * artifact.
 *
 * They are also not measuring the same thing, and this trace is strictly the stronger of the two:
 *
 * | | `determinism` move trace | this submission trace |
 * | --- | --- | --- |
 * | one link per | decision the responder *returned* on | decision, always |
 * | a decision the responder threw on | **no step at all** | a step, with `responderThrew` and the fallback's accepted move |
 * | a move the Engine rejected | invisible | recorded, with its source and error class |
 * | the move the Engine *accepted* | not necessarily (it records the responder's return value) | always |
 */

// ---------------------------------------------------------------------------------------------
// The recorded history
// ---------------------------------------------------------------------------------------------

/**
 * One `player.process()` call the Engine **rejected**, kept beside the accepted move rather than
 * discarded. See the module doc: this population is what an AC-1 re-run is adjudicated on, and a
 * history that silently omits it is the accounting mistake §4.6 exists to prevent.
 */
export type RecordedRejection = {
  /**
   * `'responder'` - the agent's own move was submitted and rejected. **This is an illegal move under
   * AC-1's definition** and the number NFR-4 is adjudicated on.
   * `'fallback-probe'` - one of `resubmitConservatively`'s `'or'`-branch probes. A real rejected
   * submission, and recovery working as designed.
   */
  source: SubmissionSource;
  response: InputResponse;
  /** `InputError`, `Error`, ... - see `legality/causes.ts`. */
  errorClass: string;
  /** The cause message with ids and numbers normalized away (`causeSignature`), so causes group. */
  signature: string;
  /** The verbatim message of this incident, so the normalization above stays auditable. */
  message: string;
};

/**
 * One decision, as it actually resolved. `accepted` is the move the Engine took; everything else is
 * what it took to get there.
 */
export type RecordedDecision = {
  /** 0-based position in this game's decision sequence - the index {@link firstDivergence} reports. */
  index: number;
  playerId: PlayerId;
  /** Seat index, joined from the config's seating. Lets a history be read against `MatchSeatRecord`. */
  seat: number;
  /** `PlayerInputModel.type` (`'or'`, `'projectCard'`, `'initialCards'`, ...). */
  decisionType: string;
  /**
   * `pendingSignature(game)` before the responder was called (`engine/snapshot.ts`): which players
   * were waiting, and for what. Free to read, and it makes the trace sensitive to *which* decision
   * was presented rather than only to what was answered - the same reason `replay.ts` includes it.
   */
  pendingSignature: string;
  /**
   * The response the Engine accepted. Absent only when the decision never resolved, i.e. the game
   * failed here (`UnrecoverableIllegalMoveError`, or a throw the driver deliberately does not
   * retry) - in which case this is the last decision in the history and the record's `failure`
   * says why.
   */
  accepted?: InputResponse;
  /** Where the accepted move came from: the agent, or the FR-9 fallback. */
  acceptedFrom?: SubmissionSource;
  /**
   * Present and `true` when the responder threw before producing a move (class B - nothing was
   * submitted, so no illegal move exists). Omitted otherwise, because it is ~5.7 decisions per game
   * out of ~296 and a `false` on every other line is 290 bytes per game of nothing.
   */
  responderThrew?: true;
  /** Every rejected submission at this decision, in order. Omitted when there were none. */
  rejected?: ReadonlyArray<RecordedRejection>;
};

/**
 * One game's `moves`-tier history: the decision list plus enough identity to re-derive the game
 * without the run artifact. Self-describing on purpose - a sidecar file is something a human opens
 * on its own, and a history that can only be interpreted next to its artifact is one that gets
 * misread.
 */
export type RecordedGameHistory = {
  groupIndex: number;
  permutationIndex: number;
  players: 2 | 3 | 4;
  engineSeed: number;
  seating: ReadonlyArray<number>;
  /** `agentSeeds[slot]`, as `MatchGameConfig` carries them. */
  agentSeeds: ReadonlyArray<number>;
  lineup: ReadonlyArray<string>;
  /** The final rolling hash - the same value the game row's `history.moveTraceHash` carries. */
  moveTraceHash: string;
  decisions: ReadonlyArray<RecordedDecision>;
};

// ---------------------------------------------------------------------------------------------
// The trace chain
// ---------------------------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * The chain's starting value. **Deliberately different from `replay.ts`'s genesis**, so a submission
 * trace hash and a determinism move trace hash can never be compared to each other by accident -
 * they measure different things (see the module doc's comparison table) and a coincidental match
 * would be far more misleading than a mismatch.
 */
export const SUBMISSION_TRACE_GENESIS = sha256Hex('nadia-match-submission-trace-genesis');

/**
 * The exact string folded into the chain for one decision. Everything that decides *what happened*
 * is in here: which decision was presented, to whom, what the Engine accepted, where that came
 * from, whether the responder threw, and every rejected attempt with its error class.
 *
 * Responses go through {@link stableStringify}, never a plain `JSON.stringify`: a structurally
 * identical response built by two different code paths - the agent's own move and the FR-9
 * fallback's, which is precisely the pair that meets at a recovered decision - can have different
 * key insertion order, and hashing the raw form would report a divergence that is not one. That is
 * the worst possible failure for a verification check, because it looks like a real finding.
 *
 * Each rejection contributes its **source, error class and rejected response**, but not its verbatim
 * message: the message is a deterministic function of the state that produced it, so it would add no
 * sensitivity, and every extra byte of free text in a hash is one more thing that can move for a
 * reason nobody wants to chase. The messages are still recorded on the decision itself at `moves`
 * tier, where {@link verifyGameRecord}'s element-wise comparison does check them.
 *
 * The `|` / `;` / `:` delimiters carry the same theoretical ambiguity `replay.ts`'s pipe-joined step
 * input carries, and are kept for the same reason: a step string is *printed* in a divergence report,
 * and a readable one is worth more than a nestable encoding. Every field here is either
 * fixed-vocabulary (player id, decision type, source, the two flags) or JSON, so producing a
 * collision would take a card name containing a delimiter - and card names are a closed enum.
 */
export function submissionStepInput(decision: RecordedDecision): string {
  const accepted = decision.accepted === undefined ? '<unresolved>' : stableStringify(decision.accepted);
  const rejected = (decision.rejected ?? [])
    .map((rejection) => `${rejection.source}:${rejection.errorClass}:${stableStringify(rejection.response)}`)
    .join(';');
  return [
    decision.pendingSignature,
    decision.playerId,
    decision.decisionType,
    accepted,
    decision.acceptedFrom ?? '-',
    decision.responderThrew === true ? 'threw' : '-',
    rejected === '' ? '-' : rejected,
  ].join('|');
}

/**
 * The rolling hash over a game's decision sequence. Same construction as `determinism/replay.ts`'s
 * `MoveTrace` (see the module doc for why it is mirrored rather than imported), so the steps it
 * emits are directly comparable by {@link firstDivergence}.
 */
class SubmissionTrace {
  private hash: string = SUBMISSION_TRACE_GENESIS;
  private index = 0;
  private readonly steps: Array<TraceStep> = [];

  constructor(private readonly capture: boolean) {}

  public record(stepInput: string): void {
    const previousHash = this.hash;
    this.hash = sha256Hex(`${previousHash}|${stepInput}`);
    if (this.capture) {
      this.steps.push({index: this.index, previousHash, stepInput, hash: this.hash});
    }
    this.index++;
  }

  public get finalHash(): string {
    return this.hash;
  }

  public get decisionCount(): number {
    return this.index;
  }

  public get trace(): ReadonlyArray<TraceStep> {
    return this.steps;
  }
}

/**
 * Recomputes the chain over an already-recorded decision list. This is what makes a stored
 * `moves`-tier history verifiable *and* localizable: the stored decisions are folded back into a
 * chain, and {@link firstDivergence} compares them step for step against a re-derivation's, so a
 * mismatch is reported as "decision 137 differs, here are both steps" rather than "the hashes
 * differ".
 */
export function traceRecordedDecisions(
  decisions: ReadonlyArray<RecordedDecision>,
): {hash: string; steps: ReadonlyArray<TraceStep>} {
  const trace = new SubmissionTrace(true);
  for (const decision of decisions) {
    trace.record(submissionStepInput(decision));
  }
  return {hash: trace.finalHash, steps: trace.trace};
}

// ---------------------------------------------------------------------------------------------
// Where moves-tier sidecars go
// ---------------------------------------------------------------------------------------------

/**
 * Where a game's `moves`-tier history is written. Everything a caller needs to know about the sink
 * is the file name and the line index it landed on, which is what the game row records.
 */
export interface MovesSink {
  write(history: RecordedGameHistory): {file: string; index: number};
  /** Bytes written so far, so the run can report a **measured** cost per game (§4.4). */
  readonly bytesWritten: number;
  readonly files: ReadonlyArray<string>;
  close(): void;
}

/**
 * **One sidecar file per pairing group**, named from the group index alone -
 * `match-moves-g000123.jsonl`, one JSON object per line, one line per game.
 *
 * The naming is the interesting decision. It has to be *deterministic from the game's own identity*,
 * because `history.movesFile` lands in the artifact and is **not** one of the declared timing fields
 * (`match/artifact.ts`), so criteria R2 (two runs of a specification produce identical records) and
 * R6 (the pooled artifact is byte-identical to the single-process one) both apply to it. A name
 * derived from the process, the wall clock or the shard boundaries would fail R6 the moment Unit C's
 * pool split a run across workers.
 *
 * Keying on the **group** is what makes sharding invisible: pool shards are always whole pairing
 * groups (§4.5), so a game's group - and therefore its sidecar - is the same whether one process
 * played the run or eight did. The cost is a file per group rather than one per run, which is
 * genuinely worse to look at for a large run; that is an acceptable price for a tier that exists for
 * inspection, is capped at the R3 sample in practice, and is gitignored either way (§4.7).
 *
 * A file is **truncated on first write within a run** and appended to afterwards, so re-running a
 * specification overwrites its histories rather than appending a second copy behind the first -
 * which would leave every `movesIndex` in the new artifact pointing at the old run's lines.
 */
export class FileMovesSink implements MovesSink {
  private readonly counts = new Map<string, number>();
  private written = 0;

  constructor(private readonly directory: string) {}

  public write(history: RecordedGameHistory): {file: string; index: number} {
    const file = movesFileName(history.groupIndex);
    const target = path.join(this.directory, file);
    const index = this.counts.get(file) ?? 0;
    const line = `${JSON.stringify(history)}\n`;

    if (index === 0) {
      fs.mkdirSync(this.directory, {recursive: true});
      fs.writeFileSync(target, line);
    } else {
      fs.appendFileSync(target, line);
    }
    this.counts.set(file, index + 1);
    this.written += Buffer.byteLength(line);
    return {file, index};
  }

  public get bytesWritten(): number {
    return this.written;
  }

  public get files(): ReadonlyArray<string> {
    return [...this.counts.keys()];
  }

  public close(): void {
    // Nothing to release: each write is a self-contained `writeFileSync`/`appendFileSync`. Holding a
    // descriptor per group would be faster and would also mean a crashed run leaves partial lines;
    // at this tier's scale (an inspection sample, not the bulk path) durability is worth more.
  }
}

/** Collects histories in memory instead of on disk. Used by verification and by the specs. */
export class MemoryMovesSink implements MovesSink {
  public readonly histories: Array<RecordedGameHistory> = [];
  private written = 0;

  public write(history: RecordedGameHistory): {file: string; index: number} {
    const index = this.histories.length;
    this.histories.push(history);
    this.written += Buffer.byteLength(`${JSON.stringify(history)}\n`);
    return {file: '<memory>', index};
  }

  public get bytesWritten(): number {
    return this.written;
  }

  public get files(): ReadonlyArray<string> {
    return [];
  }

  public close(): void {
    // Nothing to release.
  }
}

/** `match-moves-g000123.jsonl`. Zero-padded so a directory listing sorts in group order. */
export function movesFileName(groupIndex: number): string {
  return `match-moves-g${String(groupIndex).padStart(6, '0')}.jsonl`;
}

/** Reads a sidecar file back, one {@link RecordedGameHistory} per line. */
export function loadMovesFile(filePath: string): ReadonlyArray<RecordedGameHistory> {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedGameHistory);
}

// ---------------------------------------------------------------------------------------------
// The instrument
// ---------------------------------------------------------------------------------------------

type ProcessFn = (input: InputResponse) => void;

/** A decision the responder has been asked, whose submissions have not all arrived yet. */
type OpenDecision = {
  index: number;
  playerId: PlayerId;
  seat: number;
  decisionType: string;
  pendingSignature: string;
  responderThrew: boolean;
  accepted?: InputResponse;
  acceptedFrom?: SubmissionSource;
  rejected: Array<RecordedRejection>;
};

export type MatchHistoryOptions = {
  /** Where `moves`-tier histories go. Defaults to a {@link FileMovesSink} on `capture.movesDir`. */
  sink?: MovesSink;
  /**
   * Keep the per-decision {@link TraceStep}s of each game, so a failed comparison can be localized
   * without replaying anything. Off in bulk runs for the same reason `ReplayOptions.diagnostics` is:
   * a 1,000-game run would otherwise hold ~296,000 steps for games that never diverge.
   */
  captureSteps?: boolean;
};

/**
 * The history recorder and, in legality mode, the AC-1 accounting - one object, because they are one
 * instrument at one boundary. See the module doc for the install order and why it is that way round.
 *
 * Exported (rather than only reachable through {@link createMatchInstrument}) so verification and the
 * specs can drive it a decision at a time: `install()`, `beginGame(config, responder)`, then
 * `applyDecision(player, wrapped)` from the driver, then read {@link recordedDecisions}. That path
 * is how the H2 trap is demonstrated as a test rather than argued in a comment.
 */
export class MatchHistoryInstrument implements MatchInstrument {
  private readonly tier: MatchCaptureOptions['historyTier'];
  private readonly legalityMode: MatchLegalityMode | undefined;
  private readonly sink: MovesSink | undefined;
  private readonly captureSteps: boolean;

  /** Set only while this instrument's own process wrapper is installed. */
  private originalProcess: ProcessFn | undefined;
  private open: OpenDecision | undefined;
  private trace = new SubmissionTrace(false);
  private decisions: Array<RecordedDecision> = [];
  private steps: ReadonlyArray<TraceStep> = [];
  private seatOf = new Map<PlayerId, number>();

  private games = 0;
  private decisionsRecorded = 0;
  private rejectionsRecorded = 0;
  private strayProcessCalls = 0;
  private strayInThisGame = 0;

  constructor(private readonly capture: MatchCaptureOptions, options: MatchHistoryOptions = {}) {
    this.tier = capture.historyTier;
    this.legalityMode = capture.legality ? new MatchLegalityMode() : undefined;
    this.captureSteps = options.captureSteps === true;
    // Only `moves` tier has anything to write, so a sink is built (or accepted) only there - the
    // default destination being `agent/runs/`, per §4.7's retention convention.
    this.sink = this.tier === 'moves' ?
      options.sink ?? new FileMovesSink(capture.movesDir ?? defaultOutputDir('moves')) :
      undefined;
  }

  /** The steps of the game most recently finished, when `captureSteps` was set. */
  public get capturedSteps(): ReadonlyArray<TraceStep> {
    return this.steps;
  }

  /**
   * The decisions recorded for the game in progress (or the one just finished), flushing whatever is
   * still open. For the specs and for {@link recordGameHistory}; the bulk path reads them through
   * the sink. Only populated at `moves` tier - see {@link closeOpenDecision}.
   */
  public get recordedDecisions(): ReadonlyArray<RecordedDecision> {
    this.closeOpenDecision();
    return this.decisions;
  }

  // -------------------------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------------------------

  /**
   * Installs the monitor first (innermost) and this recorder's wrapper second (outermost). LIFO
   * teardown in {@link uninstall} restores the prototype exactly, and `history.spec.ts` asserts that
   * rather than trusting it - a leaked wrapper would silently instrument every later test in the
   * process.
   */
  public install(): void {
    this.legalityMode?.install();
    if (this.tier === 'summary' || this.originalProcess !== undefined) {
      // `summary` + legality mode installs *only* the monitor, so the process carries byte-identical
      // instrumentation to the AC-1 runner's (module doc; criterion R8 compares both stacks).
      return;
    }
    const original = Player.prototype.process as ProcessFn;
    this.originalProcess = original;
    const recorder = this;
    Player.prototype.process = function(this: Player, input: InputResponse): void {
      recorder.observeSubmission(this, input, original);
    } as ProcessFn;
  }

  public uninstall(): void {
    if (this.originalProcess !== undefined) {
      Player.prototype.process = this.originalProcess;
      this.originalProcess = undefined;
    }
    this.legalityMode?.uninstall();
    this.sink?.close();
  }

  // -------------------------------------------------------------------------------------------
  // Per-game
  // -------------------------------------------------------------------------------------------

  public beginGame(config: MatchGameConfig, responder: EmbeddedResponder): EmbeddedResponder {
    this.seatOf = new Map(config.seating.map((_slot, seat) => [seatPlayerId(seat), seat]));
    this.open = undefined;
    this.trace = new SubmissionTrace(this.captureSteps);
    this.decisions = [];
    this.steps = [];
    this.strayInThisGame = 0;
    this.legalityMode?.startGame();

    // The monitor is the inner wrapper at this boundary too (module doc). It marks the decision
    // boundary for its own attribution rule; this recorder brackets decisions with its own state
    // because it needs the pending signature and the seat as well, neither of which the monitor
    // exposes.
    const observed = this.legalityMode?.observeResponder(responder) ?? responder;
    return this.tier === 'summary' ? observed : this.bracketDecisions(observed);
  }

  public endGame(config: MatchGameConfig, record: MatchGameRecord, _game: IGame | undefined): MatchGameRecord {
    this.closeOpenDecision();
    this.games++;

    const legality = this.legalityMode?.gameCounters;
    if (this.tier === 'summary') {
      return legality === undefined ? record : {...record, legality};
    }

    this.steps = this.trace.trace;
    const history: MatchGameHistory = {
      tier: this.tier,
      moveTraceHash: this.trace.finalHash,
      decisions: this.trace.decisionCount,
    };
    if (this.tier === 'moves' && this.sink !== undefined) {
      const {file, index} = this.sink.write(this.buildGameHistory(config));
      history.movesFile = file;
      history.movesIndex = index;
    }
    if (this.strayInThisGame > 0) {
      // Surfaced per game as well as per run, because "which game" is the first question about it.
      history.detail = {strayProcessCalls: this.strayInThisGame};
    }

    return {...record, history, ...(legality === undefined ? {} : {legality})};
  }

  public finish(): MatchInstrumentationReport | undefined {
    const causes = this.legalityMode?.causeTallies;
    const bytes = this.sink?.bytesWritten ?? 0;
    const detail: Record<string, unknown> = {
      historyTier: this.tier,
      games: this.games,
      decisionsRecorded: this.decisionsRecorded,
      // Rejected submissions the history kept rather than dropped - the population §4.6 is about.
      rejectedSubmissionsRecorded: this.rejectionsRecorded,
      strayProcessCalls: this.strayProcessCalls,
    };
    if (this.tier === 'moves') {
      // §4.4 estimated 30-60 KB/game and asked for the real figure. This is it, measured, not
      // estimated - and it is what sets the stakes of the retention convention (§4.7).
      detail.movesBytes = bytes;
      detail.movesBytesPerGame = this.games === 0 ? 0 : Math.round(bytes / this.games);
      detail.movesFiles = this.sink?.files.length ?? 0;
      if (this.capture.movesDir !== undefined) {
        detail.movesDir = this.capture.movesDir;
      }
    }
    return {...(causes === undefined || causes.length === 0 ? {} : {causes}), detail};
  }

  // -------------------------------------------------------------------------------------------
  // The two boundaries
  // -------------------------------------------------------------------------------------------

  /**
   * Brackets each decision: records what was presented, and whether the responder produced a move at
   * all. The submissions that follow are attributed against this bracket (see
   * {@link observeSubmission}).
   */
  private bracketDecisions(inner: EmbeddedResponder): EmbeddedResponder {
    return (decision: EmbeddedDecisionPoint): InputResponse => {
      // The previous decision's submissions have all arrived by now - the driver calls the responder
      // for decision k+1 only after decision k is resolved - so this is where it is folded in.
      this.closeOpenDecision();
      this.open = {
        index: this.decisions.length,
        playerId: decision.player.id,
        seat: this.seatOf.get(decision.player.id) ?? -1,
        decisionType: decision.model.type,
        pendingSignature: pendingSignature(decision.game),
        responderThrew: false,
        rejected: [],
      };
      try {
        return inner(decision);
      } catch (thrown) {
        // Class B: no move was produced, so nothing will be submitted *by the responder*. Everything
        // submitted for this decision from here on is the FR-9 fallback's. Recording the flag is what
        // makes this decision appear in the history at all - the gap H2 names in a responder-wrapper
        // trace, and the one `moveTraceHash` still has.
        if (this.open !== undefined) {
          this.open.responderThrew = true;
        }
        throw thrown;
      }
    };
  }

  /**
   * Every `player.process()` call: what was submitted, and whether the Engine took it.
   *
   * **The attribution rule is `submissionMonitor.ts`'s**, derived here from this module's own
   * decision bracket rather than shared through the monitor's private state: within one
   * `applyDecision`, the driver calls the responder once and submits its move at most once, so **the
   * first submission after the responder returns a move is the responder's and every later one is a
   * fallback probe**. If the responder threw, it returned no move, so *all* of that decision's
   * submissions are the fallback's.
   */
  private observeSubmission(player: Player, input: InputResponse, original: ProcessFn): void {
    const open = this.open;
    if (open === undefined) {
      // No decision is open. Does not happen in embedded play; counted rather than assumed away.
      this.strayProcessCalls++;
      this.strayInThisGame++;
      original.call(player, input);
      return;
    }

    const source: SubmissionSource =
      open.responderThrew === false && open.rejected.length === 0 && open.accepted === undefined ?
        'responder' :
        'fallback-probe';

    try {
      original.call(player, input);
    } catch (cause) {
      open.rejected.push({
        source,
        response: cloneResponse(input),
        errorClass: errorClassName(cause),
        signature: causeSignature(cause),
        message: cause instanceof Error ? cause.message : String(cause),
      });
      this.rejectionsRecorded++;
      throw cause;
    }
    // Accepted. `applyDecision` stops at the first accepted submission, so this fires at most once
    // per decision; the guard is not load-bearing, it is a statement of that invariant.
    if (open.accepted === undefined) {
      open.accepted = cloneResponse(input);
      open.acceptedFrom = source;
    }
  }

  /** Folds the open decision into the trace (and, at `moves` tier, into the stored list). */
  private closeOpenDecision(): void {
    const open = this.open;
    if (open === undefined) {
      return;
    }
    this.open = undefined;
    const decision: RecordedDecision = {
      index: open.index,
      playerId: open.playerId,
      seat: open.seat,
      decisionType: open.decisionType,
      pendingSignature: open.pendingSignature,
      ...(open.accepted === undefined ? {} : {accepted: open.accepted, acceptedFrom: open.acceptedFrom}),
      ...(open.responderThrew ? {responderThrew: true as const} : {}),
      ...(open.rejected.length === 0 ? {} : {rejected: open.rejected}),
    };
    this.trace.record(submissionStepInput(decision));
    this.decisionsRecorded++;
    // At `trace` tier the decision has served its purpose once it is hashed, so only `moves` tier
    // retains the list: a 1,000-game trace run holds one decision at a time, not 296,000.
    if (this.tier === 'moves') {
      this.decisions.push(decision);
    }
  }

  private buildGameHistory(config: MatchGameConfig): RecordedGameHistory {
    return {
      groupIndex: config.groupIndex,
      permutationIndex: config.permutationIndex,
      players: config.players,
      engineSeed: config.engineSeed,
      seating: config.seating,
      agentSeeds: config.agentSeeds,
      lineup: config.lineup,
      moveTraceHash: this.trace.finalHash,
      decisions: this.decisions,
    };
  }
}

/**
 * Deep-copies a submitted response before storing it.
 *
 * Two reasons, and the second is the one that would bite. The Engine's input classes pass
 * `input.response` / `input.responses[i]` down to child inputs (`OrOptions`, `AndOptions`,
 * `SelectInitialCards`), so a stored reference is a reference into a live object graph the Engine
 * still holds; and the `moves`-tier sidecar is written at the *end* of the game, so a later mutation
 * would silently rewrite history that was already believed. `stableStringify` is used for the round
 * trip rather than a plain `JSON.stringify` so the stored form has sorted keys - the same
 * normalization the trace hashes, which means the stored moves and the hash can never disagree about
 * key order.
 */
function cloneResponse(response: InputResponse): InputResponse {
  return JSON.parse(stableStringify(response)) as InputResponse;
}

/**
 * **Unit A's contract** (`match/runner.ts`'s `INSTRUMENT_MODULE`): the runner resolves this module by
 * name at run time and calls this factory. Keeping it a named export rather than a class the runner
 * imports is what lets `runner.ts` compile and run with no reference to this file at all, which is
 * how the `summary`-tier runner shipped before this unit existed.
 */
export function createMatchInstrument(capture: MatchCaptureOptions): MatchInstrument {
  return new MatchHistoryInstrument(capture);
}

// ---------------------------------------------------------------------------------------------
// Criterion R3: the recorded history is verified, not asserted
// ---------------------------------------------------------------------------------------------

/**
 * Plays one game with the history recorder attached and returns everything it observed, in memory.
 * The primitive {@link verifyGameRecord} re-derives with, and the one the specs use to look at a real
 * history without writing a file.
 */
export function recordGameHistory(
  config: MatchGameConfig,
  options: {
    legality?: boolean;
    /**
     * Silences the driver's per-fallback `console.warn` (hazard H7). Safe here for the same reason
     * `legality/run.ts` gives for the same silencing: **every fallback is recorded anyway** - by the
     * `responderThrew`/`acceptedFrom` fields of the very history being built - so the log line
     * carries nothing the output doesn't. Verification sets it, because re-deriving R3's 50-game
     * sample would otherwise print ~285 warnings over the report they are meant to support.
     */
    silenceRoutineLogs?: boolean;
  } = {},
): {record: MatchGameRecord; history: RecordedGameHistory; steps: ReadonlyArray<TraceStep>} {
  const sink = new MemoryMovesSink();
  const instrument = new MatchHistoryInstrument(
    {historyTier: 'moves', legality: options.legality === true},
    {sink, captureSteps: true},
  );
  const originalWarn = console.warn;
  const originalLog = console.log;
  if (options.silenceRoutineLogs === true) {
    console.warn = () => {};
    console.log = () => {};
  }
  instrument.install();
  let record: MatchGameRecord;
  try {
    record = playMatchGame(config, instrument);
  } finally {
    instrument.uninstall();
    console.warn = originalWarn;
    console.log = originalLog;
  }
  return {record, history: sink.histories[0], steps: instrument.capturedSteps};
}

export type HistoryVerification = {
  groupIndex: number;
  permutationIndex: number;
  ok: boolean;
  storedHash: string;
  rederivedHash: string;
  storedDecisions: number;
  rederivedDecisions: number;
  /** True when the stored move list itself was compared, not only the hash (`moves` tier only). */
  movesCompared: boolean;
  /**
   * `moves` tier: does the sidecar line the row points at carry the row's own hash? False means the
   * row's `movesIndex` addresses the wrong line - a history that is present, indexed and wrong, which
   * is a different defect from a history that is present and stale.
   */
  rowMatchesSidecar?: boolean;
  /**
   * The first decision index at which the two histories disagree, and both steps, via
   * {@link firstDivergence}. Absent when they match.
   */
  divergence?: {index: number; stored?: TraceStep; rederived?: TraceStep};
  /**
   * First decision index at which the *stored move lists* differ, when they do. Can be set while
   * `divergence` is not: the element-wise comparison also covers the rejections' verbatim messages,
   * which the hash deliberately does not fold in.
   */
  movesDivergenceIndex?: number;
  /**
   * Decisions in this game that the FR-9 fallback resolved. **Criterion R3's sample requirement is
   * stated on this**: a sample with no fallback games leaves the interesting half of the recorder
   * untested, and R3 then reads "untested, not met" rather than "met".
   */
  fallbackDecisions: number;
};

/**
 * **Criterion R3, for one game.** Re-derives the game from the record's own seeds and compares the
 * result against what was recorded:
 *
 * - the submission trace hash must match exactly, and
 * - for a `moves`-tier record, the stored decision list must equal the re-derived one, element for
 *   element.
 *
 * On a mismatch the divergence is localized to a decision index with {@link firstDivergence} - the
 * machinery `determinism/replay.ts` built for exactly this, reused rather than reimplemented,
 * including {@link stableStringify}.
 *
 * **This is a re-derivation, not a replay.** The stored moves are never fed back into a fresh game;
 * the seeds are, and the resulting history is compared to what was written down. That is the
 * mechanism verified determinism actually supports (see the module doc).
 */
export function verifyGameRecord(
  record: MatchGameRecord,
  header: MatchRunHeader,
  stored?: RecordedGameHistory,
): HistoryVerification {
  const config = configFromRecord(record, header);
  // Re-derived under the *same* instrumentation the run used, so a difference cannot be explained by
  // "the verification ran a different stack".
  const rederived = recordGameHistory(config, {legality: header.legalityMode, silenceRoutineLogs: true});

  const storedHash = stored?.moveTraceHash ?? record.history?.moveTraceHash ?? '<absent>';
  const storedDecisions = stored?.decisions.length ?? record.history?.decisions ?? 0;
  const rederivedDecisions = rederived.history.decisions.length;

  const verification: HistoryVerification = {
    groupIndex: record.groupIndex,
    permutationIndex: record.permutationIndex,
    ok: storedHash === rederived.history.moveTraceHash && storedDecisions === rederivedDecisions,
    storedHash,
    rederivedHash: rederived.history.moveTraceHash,
    storedDecisions,
    rederivedDecisions,
    movesCompared: stored !== undefined,
    fallbackDecisions: rederived.history.decisions
      .filter((decision) => decision.acceptedFrom === 'fallback-probe' || decision.responderThrew === true)
      .length,
  };

  if (stored !== undefined) {
    // Does the sidecar line the row addresses belong to the row at all? Checked before anything is
    // concluded from its contents; `record.history` is absent only for a summary-tier row, which
    // `verifyMatchArtifact` never samples.
    verification.rowMatchesSidecar = record.history?.moveTraceHash === undefined ||
      record.history.moveTraceHash === stored.moveTraceHash;
    if (verification.rowMatchesSidecar === false) {
      verification.ok = false;
    }

    const storedTrace = traceRecordedDecisions(stored.decisions);
    const divergence = firstDivergence(storedTrace.steps, rederived.steps);
    if (divergence !== undefined) {
      verification.divergence = {index: divergence.index, stored: divergence.a, rederived: divergence.b};
      verification.ok = false;
    }
    const movesDivergenceIndex = firstMovesDifference(stored.decisions, rederived.history.decisions);
    if (movesDivergenceIndex !== undefined) {
      verification.movesDivergenceIndex = movesDivergenceIndex;
      verification.ok = false;
    }
  }
  // A `trace`-tier record carries no steps, so a mismatch there cannot be localized - the two hashes
  // are the whole finding. Re-recording the run at `moves` tier is what makes it localizable, which
  // is the reason that tier exists (§4.4) and what the CLI below says to do.

  return verification;
}

/**
 * Element-wise comparison of two decision lists, via {@link stableStringify} so key insertion order
 * can never manufacture a difference. Returns the first differing index, or `undefined`.
 */
export function firstMovesDifference(
  stored: ReadonlyArray<RecordedDecision>,
  rederived: ReadonlyArray<RecordedDecision>,
): number | undefined {
  const length = Math.max(stored.length, rederived.length);
  for (let index = 0; index < length; index++) {
    if (stableStringify(stored[index]) !== stableStringify(rederived[index])) {
      return index;
    }
  }
  return undefined;
}

/**
 * Rebuilds the {@link MatchGameConfig} that produced a game, **from the artifact alone** - the row's
 * seeds and seating plus the header's player count and lineup. That the artifact is sufficient for
 * this is the whole content of "reproducibility (NFR-5)" in §4.3's consumer table; if it ever
 * stopped being sufficient, R3 would have nothing to stand on.
 */
export function configFromRecord(record: MatchGameRecord, header: MatchRunHeader): MatchGameConfig {
  const agentSeeds = header.spec.lineup.map((_identity, slot) => {
    const seat = record.seats.find((candidate) => candidate.slot === slot);
    if (seat === undefined) {
      throw new Error(
        `game (group ${record.groupIndex}, permutation ${record.permutationIndex}) has no seat for lineup slot ${slot}; ` +
        `the record cannot be re-derived.`,
      );
    }
    return seat.agentSeed;
  });
  return {
    groupIndex: record.groupIndex,
    permutationIndex: record.permutationIndex,
    players: header.spec.players,
    engineSeed: record.engineSeed,
    seating: record.seating,
    agentSeeds,
    lineup: header.spec.lineup.map((identity) => identity.name),
  };
}

// ---------------------------------------------------------------------------------------------
// Verifying a whole artifact (criterion R3 at sample scale)
// ---------------------------------------------------------------------------------------------

export type ArtifactVerificationOptions = {
  /** How many games to verify. Default 50, which is R3's pre-committed sample size. */
  sample?: number;
  /**
   * How many of them must be games the FR-9 fallback fired in. Default 10, R3's requirement. Falling
   * short is reported, never silently tolerated: *"if the sample contains no fallback games the
   * criterion is untested, not met"*.
   */
  requireFallbackGames?: number;
  /** Where the `moves` sidecars live. Defaults to the artifact's own directory. */
  movesDir?: string;
};

export type ArtifactVerification = {
  runId: string;
  historyTier: string;
  sampled: number;
  /** Every sampled game verified, and the fallback-sample requirement was met. */
  ok: boolean;
  failures: ReadonlyArray<HistoryVerification>;
  /** Sampled games in which at least one decision was resolved by the FR-9 fallback. */
  fallbackGames: number;
  requiredFallbackGames: number;
  /** False when the sample was too thin for R3 to be claimed - see {@link ArtifactVerificationOptions}. */
  fallbackSampleSufficient: boolean;
  verifications: ReadonlyArray<HistoryVerification>;
};

/**
 * **Criterion R3, at sample scale.** Verifies a sample of an artifact's games, biased towards the
 * ones that exercise the FR-9 fallback because those are the ones the naive recorder gets wrong.
 *
 * The sample is chosen deterministically - fallback games first, in artifact order, then the rest -
 * so re-running the verification checks the same games and a failure can be re-examined rather than
 * hunted for.
 */
export function verifyMatchArtifact(
  artifactPath: string,
  options: ArtifactVerificationOptions = {},
): ArtifactVerification {
  // Loaded here rather than imported at the top so this module has no load-time dependency on
  // `artifact.ts`'s file-system helpers beyond `defaultOutputDir`.
  const report = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
    header: MatchRunHeader;
    games: ReadonlyArray<MatchGameRecord>;
  };
  const sampleSize = options.sample ?? 50;
  const requiredFallbackGames = options.requireFallbackGames ?? 10;
  const movesDir = options.movesDir ?? path.dirname(path.resolve(artifactPath));

  const playable = report.games.filter((game) => game.history !== undefined);
  const withFallback = playable.filter((game) => game.fallbacksAfterRejection + game.fallbacksAfterThrow > 0);
  const without = playable.filter((game) => game.fallbacksAfterRejection + game.fallbacksAfterThrow === 0);
  const sample = [...withFallback, ...without].slice(0, sampleSize);

  const cache = new Map<string, ReadonlyArray<RecordedGameHistory>>();
  const verifications = sample.map((game) => {
    const stored = loadStoredHistory(game, movesDir, cache);
    return verifyGameRecord(game, report.header, stored);
  });

  const fallbackGames = verifications.filter((verification) => verification.fallbackDecisions > 0).length;
  const failures = verifications.filter((verification) => verification.ok === false);
  const fallbackSampleSufficient = fallbackGames >= requiredFallbackGames;

  return {
    runId: report.header.runId,
    historyTier: report.header.historyTier,
    sampled: verifications.length,
    ok: failures.length === 0 && fallbackSampleSufficient,
    failures,
    fallbackGames,
    requiredFallbackGames,
    fallbackSampleSufficient,
    verifications,
  };
}

function loadStoredHistory(
  game: MatchGameRecord,
  movesDir: string,
  cache: Map<string, ReadonlyArray<RecordedGameHistory>>,
): RecordedGameHistory | undefined {
  const file = game.history?.movesFile;
  const index = game.history?.movesIndex;
  if (file === undefined || index === undefined) {
    return undefined;
  }
  let histories = cache.get(file);
  if (histories === undefined) {
    histories = loadMovesFile(path.join(movesDir, file));
    cache.set(file, histories);
  }
  return histories[index];
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

/**
 * Runs the R3 verification over a written artifact:
 *
 *   npx tsx agent/src/match/history.ts --artifact agent/runs/2p_random-legal@1_vs_random-legal@1_g0-24.json
 *
 * A `moves`-tier artifact is verified in full (hash *and* stored move list); a `trace`-tier one is
 * verified on the hash alone, and a divergence there is reported without an index - re-record the run
 * at `moves` tier to localize it.
 *
 * Exits non-zero on any failure **and** when the fallback sample is too thin, because "the sample
 * contained no fallback games" is R3's own definition of *untested, not met* and an exit code is the
 * only version of that statement nobody can overlook. `matchCli.ts` is Unit A's file (§9), so
 * verification is invoked here rather than as a flag on it.
 */
function main(): void {
  const argv = process.argv.slice(2);
  let artifact: string | undefined;
  let sample: number | undefined;
  let requireFallbackGames: number | undefined;
  let movesDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--artifact':
      artifact = argv[++i];
      break;
    case '--sample':
      sample = Number(argv[++i]);
      break;
    case '--require-fallbacks':
      requireFallbackGames = Number(argv[++i]);
      break;
    case '--moves-dir':
      movesDir = argv[++i];
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }
  if (artifact === undefined) {
    throw new Error('--artifact <path to a match artifact> is required.');
  }

  const result = verifyMatchArtifact(artifact, {sample, requireFallbackGames, movesDir});
  console.log(`[history] ${result.runId}: verified ${result.sampled} games at '${result.historyTier}' tier, ` +
    `${result.failures.length} failed`);
  console.log(`[history] fallback games in the sample: ${result.fallbackGames} ` +
    `(R3 requires ${result.requiredFallbackGames})` +
    `${result.fallbackSampleSufficient ? '' : ' - R3 is UNTESTED, not met; re-sample'}`);
  for (const failure of result.failures) {
    console.error(`[history] FAILED group=${failure.groupIndex} permutation=${failure.permutationIndex}: ` +
      `stored ${failure.storedHash.slice(0, 16)} vs re-derived ${failure.rederivedHash.slice(0, 16)}` +
      `${failure.divergence === undefined ? '' : `, first divergence at decision ${failure.divergence.index}`}` +
      `${failure.movesDivergenceIndex === undefined ? '' : `, stored moves differ at ${failure.movesDivergenceIndex}`}` +
      `${failure.rowMatchesSidecar === false ? ', and the row does not address its own sidecar line' : ''}`);
    if (failure.divergence === undefined && failure.movesCompared === false) {
      console.error('  a trace-tier mismatch cannot be localized; re-record this run at \'moves\' tier (§4.4).');
    }
    if (failure.divergence?.stored !== undefined) {
      console.error(`  stored     : ${failure.divergence.stored.stepInput}`);
    }
    if (failure.divergence?.rederived !== undefined) {
      console.error(`  re-derived : ${failure.divergence.rederived.stepInput}`);
    }
  }
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
