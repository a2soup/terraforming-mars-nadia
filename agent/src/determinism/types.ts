import {IGame} from '@/server/IGame';
import {EmbeddedDriverOptions} from '../driver/embeddedDriver';
import {EmbeddedResponder} from '../driver/responder';
import {GameResult} from '../driver/gameResult';

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

/**
 * Builds the responder that will drive one replay. **Added by Milestone 2, bullet 5, Unit A**
 * (§3.9 of agent/docs/Milestone2_Bullet5_Prompts.md) and strictly additive: with no factory,
 * `replay()` builds `randomLegalAgent(createAgentRandom(config.agentSeed))` exactly as it always
 * did, and `test/regression/replayAgent.spec.ts` asserts the committed 300 fingerprints still
 * verify byte for byte after the change.
 *
 * **Why it takes the `game` and not only the `config`.** The regression suite's L2 layer replays
 * *match* games, where each seat is a separately-seeded agent and the responder is a router
 * dispatching on `decision.player.id`. A router cannot be built without the player ids, and the
 * ids exist only once the game does. A factory of `(config) => responder` would have forced the
 * caller to reconstruct `engine/gameFactory.ts`'s colour order by hand - which is how a router
 * silently seats the wrong agent.
 */
export type ReplayAgentFactory = (context: {config: ReplayConfig; game: IGame}) => EmbeddedResponder;

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
  /**
   * Who plays. Defaults to the random-legal agent seeded from `config.agentSeed` - the only
   * behaviour that existed before Milestone 2 bullet 5. See {@link ReplayAgentFactory}.
   */
  agent?: ReplayAgentFactory;
  /**
   * Called once, with the finished game, immediately before the fingerprint is built - i.e. while
   * the game is still live and every end-of-game number is still readable off it.
   *
   * The regression suite's L2 entries commit *semantic* fields (placement, VP breakdown,
   * corporations, ...) beside the hashes, precisely because "the trace differs but every VP
   * component is identical" and "greenery VP moved by 2" are different events (§3.3). Reading them
   * needs the `IGame`, which `replay()` otherwise drops on the floor; a second run to fetch them
   * would double the suite's cost against a budget (§3.8) the whole design is sized to.
   */
  onGameEnd?: (game: IGame, result: GameResult) => void;
};
