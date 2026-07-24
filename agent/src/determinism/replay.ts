import {createHash} from 'crypto';
import {InputResponse} from '@/common/inputs/InputResponse';
import {createGame} from '../engine/gameFactory';
import {pendingSignature} from '../engine/snapshot';
import {stableState} from '../engine/stableState';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedResponder} from '../driver/responder';
import {runGame} from '../driver/embeddedDriver';
import {ReplayConfig, ReplayFingerprint, ReplayOptions, TraceStep} from './types';

/**
 * The determinism harness (Milestone 1, bullet 6, sub-task A): replays a fully-specified
 * {@link ReplayConfig} and returns comparable hashes (SRS CON-5/NFR-5). Everything else this
 * bullet builds - the seed x player-count sweep (sub-task B), the contamination/order
 * investigation (sub-task C), the corpus format (corpus.ts) - calls this.
 *
 * **Why a move trace, not just an end-state comparison (hazard H6).** NFR-5 requires
 * reproducibility *move-for-move*, not merely "reached the same end state". A `stableState`
 * (or `GameResult`) comparison alone can't tell you *that* two runs took the same route to get
 * there, and when it fails it hands you a ~200KB JSON diff with no indication of where the two
 * runs first disagreed. The move trace below is a rolling hash over the decision sequence,
 * captured by **wrapping the responder** - exactly the technique bullet 5 sub-task B used to
 * instrument runtime - rather than adding a hook to `embeddedDriver.ts`, which is untouched by
 * this bullet (see the Milestone1_Bullet6_Prompts.md preamble: existing agent modules are
 * load-bearing and spec-covered, and this bullet verifies, it does not fix or extend them).
 */

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * `JSON.stringify` with every object's keys sorted, recursively (array order is preserved - it's
 * meaningful). Two structurally-identical {@link InputResponse}s built by different code paths
 * (e.g. a real responder's move vs. the FR-9 conservative fallback's) can have different key
 * insertion order; hashing the raw `JSON.stringify` would then report a divergence that isn't
 * one - the worst possible outcome for a determinism check, because it looks like a real
 * finding. Exported so replay.spec.ts can verify this claim directly, and so anything downstream
 * that wants to hash a response the same way this module does can reuse it verbatim.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/** The rolling hash's starting value, folded into step 0's `previousHash`. */
const GENESIS_HASH = sha256Hex('nadia-determinism-move-trace-genesis');

/**
 * Accumulates the move trace: a hash chain over the decision sequence, one link per decision,
 * so a divergence between two traces can be localized to a decision index (see
 * {@link firstDivergence}) instead of just reporting "hashes differ". Recording full per-step
 * data (`capture: true`) is opt-in - see {@link ReplayOptions.diagnostics} - since a big sweep
 * (sub-tasks B/C) would otherwise hold every step of every replay in memory regardless of
 * whether anything ever diverges.
 */
class MoveTrace {
  private hash: string = GENESIS_HASH;
  private index = 0;
  private readonly steps: Array<TraceStep> = [];

  constructor(private readonly capture: boolean) {}

  record(stepInput: string): void {
    const previousHash = this.hash;
    this.hash = sha256Hex(`${previousHash}|${stepInput}`);
    if (this.capture) {
      this.steps.push({index: this.index, previousHash, stepInput, hash: this.hash});
    }
    this.index++;
  }

  get finalHash(): string {
    return this.hash;
  }

  get decisionCount(): number {
    return this.index;
  }

  get trace(): ReadonlyArray<TraceStep> {
    return this.steps;
  }
}

/**
 * Wraps an {@link EmbeddedResponder} to fold every decision it resolves into `trace`, then
 * returns the response unchanged. This is the "responder wrapper" instrumentation technique:
 * `embeddedDriver.ts` sees an ordinary responder and needs no changes.
 *
 * Three details, each called out in Milestone1_Bullet6_Prompts.md sub-task A section 2, that
 * decide whether this trace is worth anything:
 *
 * - `pendingSignature(decision.game)` (agent/src/engine/snapshot.ts) is free - it reads
 *   `PlayerInput.type` off each player and never calls `toModel()` (measured at 7% of a decision
 *   by the bullet-5 speed spike). Including it makes the trace sensitive to *which* decision was
 *   presented, not only to what the agent answered - two runs that reach a differently-shaped
 *   decision but coincidentally submit similar-looking responses would otherwise be
 *   indistinguishable.
 * - `decision.model.type` is used, not `decision.raw.type` - the model is already built by the
 *   time the responder sees it (reading it is free), and it is the field the live-play
 *   transport also has, unlike `raw`.
 * - The response is serialized via {@link stableStringify}, not a plain `JSON.stringify`, so key
 *   insertion order can never produce a false divergence.
 */
function withMoveTrace(inner: EmbeddedResponder, trace: MoveTrace): EmbeddedResponder {
  return (decision: EmbeddedDecisionPoint): InputResponse => {
    const before = pendingSignature(decision.game);
    const response = inner(decision);
    trace.record(`${before}|${decision.player.id}|${decision.model.type}|${stableStringify(response)}`);
    return response;
  };
}

/**
 * Replays `config` once: creates the game from its engine seed, drives it to completion with
 * the random-legal agent seeded from its agent seed, and returns a {@link ReplayFingerprint}.
 * Two replays of the same config, in the same or a different process, are expected to produce
 * identical fingerprints (SRS CON-5/NFR-5) - that expectation is what sub-tasks B and C sweep
 * and stress-test; this function only knows how to produce one fingerprint.
 */
export function replay(config: ReplayConfig, options: ReplayOptions = {}): ReplayFingerprint {
  const game = createGame({players: config.players, seed: config.engineSeed});
  const agent = randomLegalAgent(createAgentRandom(config.agentSeed));

  const captureDiagnostics = options.diagnostics === true;
  const trace = new MoveTrace(captureDiagnostics);

  let fallbacks = 0;
  const callerOnFallback = options.driverOptions?.onFallback;
  const result = runGame(game, withMoveTrace(agent, trace), {
    ...options.driverOptions,
    onFallback: (event) => {
      fallbacks++;
      callerOnFallback?.(event);
    },
  });

  const fingerprint: ReplayFingerprint = {
    config,
    moveTraceHash: trace.finalHash,
    stableStateHash: sha256Hex(stableState(game)),
    // `result` is already `computeResult(game)` - runGame() returns exactly that at Phase.END
    // (gameResult.ts / embeddedDriver.ts) - so hashing it here is equivalent to hashing a fresh
    // `computeResult(game)` call, without a redundant second one.
    resultHash: sha256Hex(JSON.stringify(result)),
    decisions: trace.decisionCount,
    fallbacks,
    generation: result.generation,
  };

  if (captureDiagnostics) {
    fingerprint.diagnostics = {
      stableState: stableState(game),
      trace: trace.trace,
    };
  }

  return fingerprint;
}

/**
 * Locates the first index at which two move traces diverge, given both were captured with
 * `{diagnostics: true}`. Returns `undefined` if every step matches and both traces have the same
 * length (i.e. no divergence). A length mismatch alone is reported at the first index beyond the
 * shorter trace (one run resolved more decisions than the other - itself a divergence).
 *
 * Comparing `hash` alone is sufficient (it is a rolling hash over everything at and before this
 * step - see {@link MoveTrace}), but the returned steps carry `stepInput` too, so the caller can
 * report *what* differed (the decision signature, player, type, and response) without re-running
 * anything.
 */
export function firstDivergence(
  a: ReadonlyArray<TraceStep>,
  b: ReadonlyArray<TraceStep>,
): {index: number; a?: TraceStep; b?: TraceStep} | undefined {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const stepA = a[i];
    const stepB = b[i];
    if (stepA?.hash !== stepB?.hash) {
      return {index: i, a: stepA, b: stepB};
    }
  }
  return undefined;
}
