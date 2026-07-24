import {EmbeddedDriverOptions} from '../driver/embeddedDriver';

/**
 * A fully-specified game to replay: which Engine seed builds it, which agent seed drives the
 * random-legal agent, and how many players. The primitive everything in this bullet (Milestone
 * 1, bullet 6 - Engine determinism verification, SRS CON-5/NFR-5) is built on top of. The two
 * seeds are chosen independently of one another (CON-5) - nothing here couples them.
 */
export type ReplayConfig = {
  players: 2 | 3 | 4;
  engineSeed: number;
  agentSeed: number;
};

/**
 * One step of the move trace (see replay.ts's doc comment on {@link firstDivergence}): the
 * exact string that was folded into the rolling hash for one decision, plus the hash before and
 * after, so a divergence between two traces can be localized to a decision index and the two
 * differing steps can be inspected directly rather than re-run to find them.
 */
export type TraceStep = {
  /** 0-based position of this decision in the trace. */
  index: number;
  /** The rolling hash after the *previous* step (or the trace's genesis value, for index 0). */
  previousHash: string;
  /** `` `${pendingSignature}|${playerId}|${modelType}|${stableStringify(response)}` `` - see replay.ts. */
  stepInput: string;
  /** The rolling hash after this step: `sha256(previousHash + '|' + stepInput)`. */
  hash: string;
};

/**
 * Diagnostic data a {@link ReplayFingerprint} carries only when explicitly requested
 * (`ReplayOptions.diagnostics`) - never persisted to a saved corpus (corpus.ts strips it before
 * writing). Re-running a config to get this after a comparison already failed wastes the
 * failure; capturing it up front avoids that, at the cost of holding the full per-decision trace
 * and the raw `stableState` string in memory.
 */
export type ReplayDiagnostics = {
  /** `stableState(game)` at the end of the replay - the actual JSON to diff, not just its hash. */
  stableState: string;
  /** Every step folded into `moveTraceHash`, in order. */
  trace: ReadonlyArray<TraceStep>;
};

/**
 * The comparable, corpus-committable outcome of replaying a {@link ReplayConfig} once. Hashes,
 * not raw state, so a corpus of these stays small and diffable; `diagnostics` is the escape
 * hatch back to raw state when a comparison actually fails.
 */
export type ReplayFingerprint = {
  config: ReplayConfig;
  /** The final rolling hash over the decision sequence (NFR-5's "move-for-move", not just end state - see replay.ts). */
  moveTraceHash: string;
  /** `sha256(stableState(game))` at the end of the replay. */
  stableStateHash: string;
  /** `sha256(JSON.stringify(GameResult))`. */
  resultHash: string;
  /** Count of decision points the responder resolved (driver-level decisions, not sub-decisions inside a composite). */
  decisions: number;
  /** FR-9 conservative-fallback firings during this replay (via `EmbeddedDriverOptions.onFallback`). */
  fallbacks: number;
  generation: number;
  /** Present only when `replay()` was called with `{diagnostics: true}`. See {@link ReplayDiagnostics}. */
  diagnostics?: ReplayDiagnostics;
};

export type ReplayOptions = {
  /**
   * Also populates `diagnostics` on the returned fingerprint (the raw `stableState` string and
   * the full per-step move trace). Off by default: a sweep over many configs (sub-tasks B/C)
   * would otherwise hold hundreds of full traces in memory for configs that never diverge.
   */
  diagnostics?: boolean;
  /**
   * Passed through to the embedded driver (e.g. `maxDecisions`). `onFallback` is wrapped
   * internally so `ReplayFingerprint.fallbacks` is always counted correctly; if the caller also
   * supplies `onFallback`, both fire.
   */
  driverOptions?: EmbeddedDriverOptions;
};
