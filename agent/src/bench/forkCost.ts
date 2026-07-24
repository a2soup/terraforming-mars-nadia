import {Phase} from '@/common/Phase';
import {InputResponse} from '@/common/inputs/InputResponse';
import {GameLoader} from '@/server/database/GameLoader';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
import {EmbeddedDriverOptions, applyDecision} from '../driver/embeddedDriver';
import {EmbeddedResponder} from '../driver/responder';
import {createGame} from '../engine/gameFactory';
import {
  GameSnapshot,
  SnapshotFidelityError,
  UnsafeSnapshotError,
  assertSnapshotSafe,
  pendingSignature,
  restore,
  snapshot,
} from '../engine/snapshot';
import {stableStateOf} from '../engine/stableState';
import {benchEnvironment, silenceConsole, summarize, timed} from './harness';
import {BenchReport, BenchStats, BenchSuite, BenchSuiteOptions} from './types';

/**
 * **Fork realism** - the Milestone 1, bullet 5 simulator-speed spike, sub-task D
 * (agent/docs/Milestone1_Bullet5_Prompts.md).
 *
 * **Why this suite exists, and why the obvious measurement is the wrong number.** Sub-task C
 * measures what a *clone* costs. But bullet 4 established that search cannot fork at an
 * arbitrary decision point: 28.0% of decision points do not round-trip, and the action-phase
 * failures are 100% silent (agent/docs/Running_Notes.md, 2026-07-22 and 2026-07-23 entries).
 * The strategy recorded for Milestone 4 is therefore *fork at the nearest quiescent (safe)
 * ancestor and replay the intervening sub-decisions*, under which the real cost of a fork is
 *
 * ```
 * fork_cost = restore + (replay_distance x replay_step)
 * ```
 *
 * Nobody has measured `replay_distance`, and - the part that matters most - **the replay
 * mechanism itself has never been run.** It is an assertion in the Running Notes, not a tested
 * behaviour. So this suite does two things, in this order: it *validates* replay against real
 * games, and only then measures what it costs. A replay-validation failure is not a bug to fix
 * here; it is the single most important result the spike can produce, because it would mean the
 * recorded Milestone 4 fork strategy does not work as written.
 *
 * **The operational definition of a forkable point, which is stricter than `assertSnapshotSafe`.**
 * The phase guard accepting a point does *not* mean a restore reproduces it: bullet 4's own audit
 * measured 165 action-phase points that the guard waved through and only the pending-signature
 * check caught. Search, restoring with the default `verify: 'pending'`, would see a throw at every
 * one of those and have to walk further back. So this suite records **two** densities:
 *
 * - `guardSafe` - `assertSnapshotSafe` accepts the point. This is bullet 4's figure.
 * - `forkable` - `guardSafe` **and** `restore(snap, {verify: 'pending'})` returns without
 *   throwing. This is the one search can actually use, and it is the one the nearest-ancestor
 *   walk below is computed against.
 *
 * Reporting only the first would overstate forkability by exactly the silent-failure population
 * bullet 4 spent a whole sub-task discovering.
 *
 * **Nothing here weakens a guard.** Unlike sub-task C (which must sample with `{unsafe: true}`
 * precisely because it is measuring the points the guard refuses), this suite's whole premise is
 * that the ancestor is a *faithful* fork point, so ancestors are snapshotted and restored with
 * every default in place. `{unsafe: true}` never appears in this file.
 *
 * **This is a benchmark, not a test:** it asserts no wall-clock duration, and it lives in
 * `agent/src/bench/`, run only via `agent/src/runner/speedSpikeCli.ts`.
 */

/**
 * Used only when `scale` is not a positive number. The CLI's own default is 20; this sub-task's
 * routine figure is 10 games per player count, and the committed run (sub-task E) should use >= 30
 * across 2/3/4 players. `scale` is games **per player count**, not games in total.
 */
const FALLBACK_SCALE = 10;

/**
 * One decision point of a driven game, recorded as it happened. `response` is the response the
 * Engine actually **accepted** - which is not always the agent's, since the driver's FR-9
 * conservative fallback may have substituted its own (see `recordedDrive`).
 */
type RecordedDecision = {
  /** 1-based index within its game - the coordinate bullet 4's audit and Running Notes both use. */
  readonly index: number;
  readonly phase: Phase;
  /** The player `applyDecision` was called with, i.e. the first waiting player in generation order. */
  readonly playerId: string;
  /** Deep-copied at record time so replaying it into many different games can never alias. */
  readonly response: InputResponse;
};

/** Why a replay did not reproduce its target. Each is a distinct, separately-counted finding. */
type ReplayFailure =
  /** Restoring the ancestor threw, despite that ancestor having verified when it was captured. */
  | 'restoreRejected'
  /** The replayed game offered the decision to a different player than the original did. */
  | 'playerMismatch'
  /** The Engine rejected a response it had accepted in the original game. */
  | 'processRejected'
  /** The replayed game reached Phase.END before the recorded responses ran out. */
  | 'endedEarly'
  /** The replayed game had no waiting player mid-replay, without having reached Phase.END. */
  | 'noWaitingPlayer'
  /** State matched, but the pending decision did not - the silent failure class, caught loudly. */
  | 'pendingMismatch'
  /** The pending decision matched but the serialized state did not. */
  | 'stateMismatch'
  /** Neither matched. */
  | 'bothMismatch';

/** One fork experiment: reach decision point `index` by restoring `ancestor` and replaying. */
type ForkOutcome = {
  readonly players: number;
  readonly seed: number;
  readonly index: number;
  readonly phase: Phase;
  readonly guardSafe: boolean;
  readonly forkable: boolean;
  /** 1-based index of the nearest forkable ancestor; equal to `index` when the point is itself forkable. */
  readonly ancestorIndex: number;
  /** `index - ancestorIndex`: how many recorded decisions had to be replayed. 0 for a direct fork. */
  readonly replayDistance: number;
  readonly restoreMs: number;
  /** Total across every replayed step; 0 when `replayDistance` is 0. */
  readonly replayMs: number;
  readonly failure?: ReplayFailure;
};

/** Everything the corpus loop accumulates, flattened into the report at the end. */
type Accumulator = {
  readonly forks: Array<ForkOutcome>;
  /** Every decision point seen, whether or not a fork experiment ran at it. */
  readonly points: Array<{players: number; phase: Phase; guardSafe: boolean; forkable: boolean}>;
  readonly snapshotMs: Array<number>;
  readonly replayStepMs: Array<number>;
  /** Maximal runs of consecutive forkable / non-forkable points, per game. */
  readonly forkableRuns: Array<number>;
  readonly unforkableRuns: Array<number>;
  /** Points reached before any forkable ancestor existed - no experiment possible, not a failure. */
  noAncestor: number;
  /** Decisions per game, so the fork numbers can be read against rollout length. */
  readonly decisionsPerGame: Array<number>;
  /** FR-9 conservative-fallback firings during the recording drives (the real hook, not the console). */
  fallbacks: number;
};

/** `assertSnapshotSafe`'s verdict as a boolean. Any throw other than {@link UnsafeSnapshotError} is a real bug. */
function isGuardSafe(game: IGame): boolean {
  try {
    assertSnapshotSafe(game);
    return true;
  } catch (error) {
    if (error instanceof UnsafeSnapshotError) {
      return false;
    }
    throw error;
  }
}

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

/** The response objects are replayed into many independently restored games; never share one. */
function copyResponse(response: InputResponse): InputResponse {
  return JSON.parse(JSON.stringify(response)) as InputResponse;
}

/**
 * Submits one already-known response - the replay counterpart of
 * {@link applyDecision}. Deliberately **not** `applyDecision`, for two reasons:
 *
 * 1. **It is the mechanism Milestone 4 would actually use.** Replay knows the answer, so it must
 *    not pay for `toDecisionPoint`'s `waitingFor.toModel(player)` (the HTTP-transport model,
 *    built on every decision - see sub-task B) or for `enumerate`. Timing a replay step through
 *    `applyDecision` would charge the fork for work a real replay never does, and the whole point
 *    of this suite is a cost number M4 can rely on.
 * 2. **The FR-9 conservative fallback must not fire here.** If the Engine rejects a response it
 *    previously accepted, that is a *replay divergence* and the most valuable signal this suite
 *    can emit; `applyDecision` would silently substitute a legal move of its own and the replay
 *    would look successful while having taken a different path.
 *
 * The post-process deferred drain, guard and all, is copied verbatim from `applyDecision` and
 * **must stay identical to it** - that guard is the fix for a real driver bug (an unconditional
 * `runAll()` silently overwriting a freshly-set `waitingFor`, agent/docs/Running_Notes.md,
 * 2026-07-22), and a replay that drained differently from the original drive would diverge for
 * reasons that have nothing to do with snapshot fidelity.
 */
function submitRecorded(player: IPlayer, response: InputResponse): void {
  player.process(response);
  if (player.getWaitingFor() === undefined) {
    player.game.deferredActions.runAll(() => {});
  }
}

/**
 * Replays `steps` into `restored`, timing each step into `stepMs`. Returns the failure kind, or
 * `undefined` if every step was accepted by the player the original drive offered it to.
 */
function replaySteps(
  restored: IGame,
  steps: ReadonlyArray<RecordedDecision>,
  stepMs: Array<number>,
): ReplayFailure | undefined {
  for (const step of steps) {
    if (restored.phase === Phase.END) {
      return 'endedEarly';
    }
    const player = nextWaitingPlayer(restored);
    if (player === undefined) {
      return 'noWaitingPlayer';
    }
    if (player.id !== step.playerId) {
      return 'playerMismatch';
    }
    try {
      stepMs.push(timed(() => submitRecorded(player, step.response)).ms);
    } catch {
      return 'processRejected';
    }
  }
  return undefined;
}

/**
 * Compares a replayed game against the live original, **both ways**: `pendingSignature` and
 * `stableStateOf`. Both, because bullet 4 spent an entire sub-task establishing that they fail
 * independently - state can match byte for byte while the pending decision has been silently
 * replaced (the whole action-phase failure population), and the pending signature can match by
 * coincidence while the state has diverged (the 2026-07-23 `Phase.PRELUDES` survivor).
 */
function validateReplay(restored: IGame, livePending: string, liveStable: string): ReplayFailure | undefined {
  const pendingOk = pendingSignature(restored) === livePending;
  const stateOk = stableStateOf(restored.serialize()) === liveStable;
  if (pendingOk && stateOk) {
    return undefined;
  }
  if (!pendingOk && !stateOk) {
    return 'bothMismatch';
  }
  return pendingOk ? 'stateMismatch' : 'pendingMismatch';
}

/**
 * Drives one full game to `Phase.END`, and at **every** decision point runs the fork experiment
 * the Milestone 4 strategy describes: restore the nearest forkable ancestor and replay forward to
 * this point, then check that the result is the same game.
 *
 * The ancestor is carried as a single rolling snapshot rather than a table of them - which is
 * both cheaper and exactly the access pattern search uses (snapshot once at a node, restore many
 * times from it). One restore happens per decision point either way: at a guard-safe point the
 * forkability probe *is* the distance-0 fork experiment, and at every other point the restore is
 * of the carried ancestor.
 */
function measureGame(players: number, seed: number, agentSeed: number, acc: Accumulator): void {
  const game = createGame({players, seed});
  const agent: EmbeddedResponder = randomLegalAgent(createAgentRandom(agentSeed));

  // The response the Engine actually accepted for the current decision. The agent's own return
  // value is the usual source, but when the FR-9 conservative fallback fires the driver submits
  // something else entirely - and it is the *accepted* response a replay has to reproduce, so
  // `onFallback` (the real hook, not console scraping) overwrites it.
  let accepted: InputResponse | undefined;
  const recorder: EmbeddedResponder = (decision) => {
    const response = agent(decision);
    accepted = response;
    return response;
  };
  const driverOptions: EmbeddedDriverOptions = {
    onFallback: (event) => {
      accepted = event.fallbackInput;
      acc.fallbacks++;
    },
  };

  const recorded: Array<RecordedDecision> = [];
  let ancestor: {index: number; snap: GameSnapshot} | undefined;
  let runLength = 0;
  let runForkable: boolean | undefined;

  while (game.phase !== Phase.END) {
    const player = nextWaitingPlayer(game);
    if (player === undefined) {
      throw new Error(`${players}p/seed=${seed}: no player has a pending input, but phase is '${game.phase}', not '${Phase.END}'`);
    }
    const index = recorded.length + 1;
    const phase = game.phase;

    // The live target: what the replay has to reproduce. Captured before anything is forked, and
    // read-only with respect to `game`.
    const livePending = pendingSignature(game);
    const liveStable = stableStateOf(game.serialize());

    const guardSafe = isGuardSafe(game);
    let forkable = false;
    let outcome: ForkOutcome | undefined;

    if (guardSafe) {
      // Snapshot with every default in place - the premise of the whole strategy is that the
      // ancestor is a faithful fork point, so this is the one place the guards must not be
      // relaxed (contrast sub-task C, which must relax them to measure what they refuse).
      const captured = timed(() => snapshot(game));
      acc.snapshotMs.push(captured.ms);

      try {
        const restored = timed(() => restore(captured.result, {verify: 'pending'}));
        forkable = true;
        // Adopted as the ancestor on the strength of the restore verifying, *before* the
        // state comparison below - deliberately, and not a missing guard. Search has no
        // original to compare a restore against; the guards returning cleanly is the entire
        // signal available to it. Adopting only ancestors that also passed a state comparison
        // would measure a fork strategy Milestone 4 cannot implement. If a state divergence
        // does slip through here, it is recorded as a failure on this outcome and will show up
        // again in every replay descended from it - which is the finding, loudly, rather than
        // a number quietly cleaned up by hindsight the real system does not have.
        ancestor = {index, snap: captured.result};
        // A forkable point's own fork experiment is this restore: replay distance 0, so the only
        // thing left to check is that the restored game really is the game that was captured.
        outcome = {
          players, seed, index, phase, guardSafe, forkable,
          ancestorIndex: index,
          replayDistance: 0,
          restoreMs: restored.ms,
          replayMs: 0,
          failure: validateReplay(restored.result, livePending, liveStable),
        };
      } catch (error) {
        if (!(error instanceof SnapshotFidelityError)) {
          throw error;
        }
        // The phase guard accepted this point but the pending-signature check refused the
        // restore: bullet 4's silent-failure population, seen here from search's side. Not
        // forkable, so it does not become the ancestor - fall through to the replay path.
      }
    }

    if (outcome === undefined) {
      if (ancestor === undefined) {
        // Before the first forkable point of the game there is nothing to fork from. Counted,
        // not a replay failure.
        acc.noAncestor++;
      } else {
        const forkFrom = ancestor;
        const ancestorIndex = forkFrom.index;
        // Pre-copied outside the timed region: the copy is replay bookkeeping, not replay cost.
        const steps = recorded.slice(ancestorIndex - 1).map((step) => ({...step, response: copyResponse(step.response)}));
        const stepMs: Array<number> = [];
        let failure: ReplayFailure | undefined;
        let restoreMs = 0;

        try {
          const restored = timed(() => restore(forkFrom.snap, {verify: 'pending'}));
          restoreMs = restored.ms;
          failure = replaySteps(restored.result, steps, stepMs) ?? validateReplay(restored.result, livePending, liveStable);
        } catch (error) {
          if (!(error instanceof SnapshotFidelityError)) {
            throw error;
          }
          failure = 'restoreRejected';
        }

        acc.replayStepMs.push(...stepMs);
        outcome = {
          players, seed, index, phase, guardSafe, forkable,
          ancestorIndex,
          replayDistance: index - ancestorIndex,
          restoreMs,
          replayMs: stepMs.reduce((sum, ms) => sum + ms, 0),
          failure,
        };
      }
    }

    if (outcome !== undefined) {
      acc.forks.push(outcome);
    }
    acc.points.push({players, phase, guardSafe, forkable});

    // Maximal runs of consecutive forkable / non-forkable points, for the clustering question.
    if (runForkable === undefined || runForkable === forkable) {
      runLength++;
    } else {
      (runForkable ? acc.forkableRuns : acc.unforkableRuns).push(runLength);
      runLength = 1;
    }
    runForkable = forkable;

    accepted = undefined;
    applyDecision(player, recorder, driverOptions);
    if (accepted === undefined) {
      throw new Error(`${players}p/seed=${seed} #${index}: the decision was applied but no accepted response was captured`);
    }
    recorded.push({index, phase, playerId: player.id, response: copyResponse(accepted)});
  }

  if (runForkable !== undefined) {
    (runForkable ? acc.forkableRuns : acc.unforkableRuns).push(runLength);
  }
  acc.decisionsPerGame.push(recorded.length);
}

/** `summarize`, but yields `undefined` for an empty sample instead of throwing. */
function maybeSummarize(label: string, samples: ReadonlyArray<number>): BenchStats | undefined {
  return samples.length === 0 ? undefined : summarize(label, samples);
}

function percentage(part: number, whole: number): number {
  return whole === 0 ? 0 : Number((100 * part / whole).toFixed(2));
}

function medianOf(samples: ReadonlyArray<number>): number {
  return samples.length === 0 ? 0 : summarize('median', samples).median;
}

/**
 * Density metrics broken down by a key (phase, or player count), in the shape sub-task E's cost
 * model consumes: for each group, how many points, how many the phase guard accepts, and how many
 * are genuinely forkable.
 */
function densityBreakdown(
  points: Accumulator['points'],
  keyOf: (point: Accumulator['points'][number]) => string,
  prefix: string,
): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const key of [...new Set(points.map(keyOf))].sort()) {
    const group = points.filter((point) => keyOf(point) === key);
    metrics[`${prefix}.${key}.points`] = group.length;
    metrics[`${prefix}.${key}.guardSafePct`] = percentage(group.filter((p) => p.guardSafe).length, group.length);
    metrics[`${prefix}.${key}.forkablePct`] = percentage(group.filter((p) => p.forkable).length, group.length);
  }
  return metrics;
}

/**
 * The suite. `scale` is **games per player count** (see {@link FALLBACK_SCALE}); `players` comes
 * from the CLI. Engine and agent seeds are derived from `seed` and `agentSeed` by independent
 * transforms - the agent seed is never a function of the engine seed (SRS CON-5) - so the whole
 * corpus is reproducible from the CLI invocation alone.
 */
export const forkCostSuite: BenchSuite = {
  name: 'fork-cost',
  description: 'Fork realism: validates the replay-from-quiescent-ancestor strategy and measures what a search fork actually costs.',
  run: (options: BenchSuiteOptions): BenchReport => {
    const scale = options.scale > 0 ? options.scale : FALLBACK_SCALE;
    const acc: Accumulator = {
      forks: [], points: [], snapshotMs: [], replayStepMs: [],
      forkableRuns: [], unforkableRuns: [], noAncestor: 0, decisionsPerGame: [], fallbacks: 0,
    };

    // Terminal states restore into Phase.END, where Game.deserialize calls
    // GameLoader.getInstance().mark(...) - construct that lazy singleton now so its one-off cost
    // is not attributed to whichever restore happens to hit END first.
    GameLoader.getInstance();

    // Silenced around the corpus loop only, so a crash anywhere else still prints. The counts are
    // findings in their own right: `cacheMark` is the per-restore END-phase log line, `fr9Fallback`
    // cross-checks the `onFallback` hook, and any `outOfScope` is a scope bug.
    const {counts} = silenceConsole(() => {
      for (const players of options.players) {
        for (let i = 0; i < scale; i++) {
          measureGame(players, options.seed + players * 100_000 + i, options.agentSeed + players * 7_919 + i * 104_729, acc);
        }
      }
    });

    const {forks, points} = acc;
    const failed = forks.filter((fork) => fork.failure !== undefined);
    const replayed = forks.filter((fork) => fork.replayDistance > 0);
    const replayedFailed = replayed.filter((fork) => fork.failure !== undefined);
    const distances = forks.map((fork) => fork.replayDistance);
    // The same distribution restricted to points that could not be forked directly. The
    // unrestricted median is 0 whenever most points are forkable, which is true but says nothing
    // about what a replay costs when one is actually needed - E wants both.
    const replayDistances = replayed.map((fork) => fork.replayDistance);
    const forkCosts = forks.map((fork) => fork.restoreMs + fork.replayMs);
    const unforkableTargets = forks.filter((fork) => !fork.forkable);

    const stats = [
      maybeSummarize('snapshot@guard-safe', acc.snapshotMs),
      maybeSummarize('restore@fork (verify=pending)', forks.map((fork) => fork.restoreMs)),
      maybeSummarize('replay-step (process+drain)', acc.replayStepMs),
      maybeSummarize('effective-fork-cost@all-points', forkCosts),
      maybeSummarize('effective-fork-cost@unforkable', unforkableTargets.map((fork) => fork.restoreMs + fork.replayMs)),
    ].filter((stat): stat is BenchStats => stat !== undefined);

    const failureCounts: Record<string, number> = {};
    for (const fork of failed) {
      const key = `replayFailures.${fork.failure}`;
      failureCounts[key] = (failureCounts[key] ?? 0) + 1;
    }

    const restoreMedian = medianOf(forks.map((fork) => fork.restoreMs));
    const forkMedian = medianOf(forkCosts);
    const distanceP95 = distances.length === 0 ? 0 : summarize('d', distances).p95;
    const unforkableRunMedian = medianOf(acc.unforkableRuns);
    const unforkableRunMax = acc.unforkableRuns.length === 0 ? 0 : Math.max(...acc.unforkableRuns);
    const replaySuccessPct = percentage(forks.length - failed.length, forks.length);

    const notes: Array<string> = [
      `Corpus: ${options.players.map((p) => `${p}p`).join('/')} x ${scale} games = ${options.players.length * scale} games, ` +
      `${points.length} decision points, ${forks.length} fork experiments.`,
      'A fork experiment ran at EVERY decision point: restore the nearest forkable ancestor, replay the recorded ' +
      'responses forward, then check the result against the live game by BOTH pendingSignature and stableStateOf.',
      '"guardSafe" is assertSnapshotSafe\'s verdict (bullet 4\'s figure). "forkable" additionally requires ' +
      'restore(snap, {verify: \'pending\'}) to return without throwing - the stricter, operational definition, ' +
      'because a restore search cannot verify is a fork search cannot take.',
      'Ancestors are snapshotted and restored with every default in place; {unsafe: true} never appears in this suite. ' +
      'restore@fork therefore includes the verify: \'pending\' surcharge, which is what a real fork pays.',
      'A replay step is player.process() plus the driver\'s own guarded deferred drain - no toModel, no enumerate - ' +
      'so it is NOT comparable to sub-task B\'s per-decision rollout cost and must not be substituted for it.',
      'Ancestors are carried as one rolling snapshot per game (snapshot-once / restore-many), which is both the ' +
      'cheap way to measure this and the access pattern search actually uses.',
      'Cache.mark does NOT distort this suite, unlike the clone-cost one: fork targets are decision points, so no ' +
      'restore ever lands in Phase.END, and the one mark per completed game comes from GameLoader.completeGame, ' +
      'which awaits a promise before logging - so it fires on a microtask after the measured region, not inside it. ' +
      'A matched.cacheMark of 0 alongside a visible "Marking ..." line on stdout is that, and is expected.',
      'Building for the compiled run needs BOTH steps, not just the first: `npx tsc -p agent/tsconfig.json && npx ' +
      'tsc-alias -p agent/tsconfig.json`. Plain tsc emits unrewritten `require("@/...")` calls (the Engine\'s own ' +
      'build:server script pairs tsc with tsc-alias for exactly this reason) and `node build/agent/...` fails to ' +
      'load. The corpus is byte-identical across tsx and compiled - same point counts, same fork counts - so the ' +
      'two runtimes\' timings are directly comparable.',
    ];

    // The replay-validation verdict, stated plainly either way. A failure here is the most
    // important result the spike can produce - it would mean the Milestone 4 fork strategy
    // recorded in the Running Notes does not work as written - so it is never softened.
    if (failed.length === 0) {
      notes.push(
        `REPLAY VALIDATION PASSED: all ${forks.length} forks reproduced their target exactly (state and pending decision), ` +
        `including all ${replayed.length} that required a non-zero replay. The Milestone 4 replay-from-quiescent-ancestor ` +
        'strategy is validated on this corpus.',
      );
    } else {
      const breakdown = Object.entries(failureCounts).map(([key, count]) => `${key.replace('replayFailures.', '')}=${count}`).join(', ');
      notes.push(
        `REPLAY VALIDATION FAILED: ${failed.length} of ${forks.length} forks (${percentage(failed.length, forks.length)}%) did not ` +
        `reproduce their target - ${breakdown}. Of the ${replayed.length} forks that required a non-zero replay, ` +
        `${replayedFailed.length} failed. This is a finding about the recorded Milestone 4 fork strategy, not a defect of this ` +
        'suite: the strategy does not hold as written, and sub-task E\'s gate analysis must account for it. Do NOT restrict the ' +
        'corpus until the number looks better.',
      );
    }

    // The clustering question, answered from the data rather than assumed: which of the two
    // worlds is this - forks sitting almost entirely on safe points, or long unsafe runs where
    // replay_distance x replay_step becomes the binding constraint?
    const clustered = distanceP95 <= 3;
    notes.push(
      `Clustering: unforkable runs have median length ${unforkableRunMedian}, max ${unforkableRunMax} (the longest is ` +
      'typically the leading game-setup run, which has no ancestor and so contributes no replay distance); replay ' +
      `distance median ${medianOf(distances)}, p95 ${distanceP95}, max ${distances.length === 0 ? 0 : Math.max(...distances)}, ` +
      `and median ${medianOf(replayDistances)} / p95 ${replayDistances.length === 0 ? 0 : summarize('d', replayDistances).p95} ` +
      'over just the points that could not be forked directly. ' +
      (clustered
        ? 'Unsafe points are short, isolated runs: a search that forks at or near the top of a turn sits almost entirely ' +
          'on forkable points, so effective fork cost is close to raw restore cost and the fork-realism concern is smaller ' +
          'than the raw 28%-unfaithful figure suggests.'
        : 'Unsafe points form long runs: replay distance is a real cost driver, and replay_distance x replay_step - not the ' +
          'restore - may be the binding constraint on Milestone 4 fork cost.'),
    );
    notes.push(
      `Effective fork cost (median ${forkMedian.toFixed(4)} ms) vs raw restore (median ${restoreMedian.toFixed(4)} ms): ` +
      `replay adds ${percentage(forkMedian - restoreMedian, restoreMedian)}% at the median.`,
    );

    if (acc.noAncestor > 0) {
      notes.push(
        `${acc.noAncestor} decision point(s) occurred before any forkable point existed in their game (game setup), so no ` +
        'fork experiment was possible there. Counted, not a failure - search does not fork during setup.',
      );
    }

    const metrics: Record<string, number | string | ReadonlyArray<number>> = {
      games: options.players.length * scale,
      gamesPerPlayerCount: scale,
      decisionPoints: points.length,
      forkExperiments: forks.length,
      pointsWithoutAncestor: acc.noAncestor,

      replaySuccessPct,
      replayFailures: failed.length,
      forksRequiringReplay: replayed.length,
      forksRequiringReplayFailed: replayedFailed.length,
      ...failureCounts,

      guardSafePct: percentage(points.filter((p) => p.guardSafe).length, points.length),
      forkablePct: percentage(points.filter((p) => p.forkable).length, points.length),
      guardSafeButNotForkablePct: percentage(points.filter((p) => p.guardSafe && !p.forkable).length, points.length),
      ...densityBreakdown(points, (p) => p.phase, 'byPhase'),
      ...densityBreakdown(points, (p) => `${p.players}p`, 'byPlayers'),

      replayDistanceMedian: medianOf(distances),
      replayDistanceP95: distanceP95,
      replayDistanceMax: distances.length === 0 ? 0 : Math.max(...distances),
      replayDistanceDistribution: distances,
      replayDistanceMedianWhenNeeded: medianOf(replayDistances),
      replayDistanceP95WhenNeeded: replayDistances.length === 0 ? 0 : summarize('d', replayDistances).p95,

      forkableRunLengthMedian: medianOf(acc.forkableRuns),
      forkableRunLengthMax: acc.forkableRuns.length === 0 ? 0 : Math.max(...acc.forkableRuns),
      unforkableRunLengthMedian: unforkableRunMedian,
      unforkableRunLengthMax: unforkableRunMax,
      unforkableRunLengthDistribution: acc.unforkableRuns,

      effectiveForkCostMedianMs: forkMedian,
      rawRestoreMedianMs: restoreMedian,
      replayOverheadPctAtMedian: percentage(forkMedian - restoreMedian, restoreMedian),

      decisionsPerGameMedian: medianOf(acc.decisionsPerGame),
      decisionsPerGameDistribution: acc.decisionsPerGame,
      fr9Fallbacks: acc.fallbacks,
      fr9FallbacksPerThousandDecisions: Number((1000 * acc.fallbacks / Math.max(points.length, 1)).toFixed(3)),

      seedBase: options.seed,
      agentSeedBase: options.agentSeed,
      clusteringVerdict: clustered ? 'unsafe points are short isolated runs' : 'unsafe points form long runs',
    };

    return {
      suite: forkCostSuite.name,
      environment: benchEnvironment(),
      stats,
      metrics,
      consoleCounts: counts,
      notes,
    };
  },
};
