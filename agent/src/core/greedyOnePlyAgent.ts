import {Phase} from '@/common/Phase';
import {InputResponse} from '@/common/inputs/InputResponse';
import {PlayerId} from '@/common/Types';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {SeatedAgent} from '../agents/registry';
import {applyDecision} from '../driver/embeddedDriver';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedResponder} from '../driver/responder';
import {
  ForkService,
  ForkStats,
  ForkUnavailableReason,
  copyResponse,
  mergeForkStats,
} from '../search/fork';
import {assertSpeculative, withSpeculation} from '../search/speculation';
import {CandidateSet, candidates} from './candidates';
import {NotYetImplementedDecisionError, OutOfScopeDecisionError} from './enumerator';
import {randomLegalAgent} from './randomLegalAgent';
import {AgentRandom, createAgentRandom} from './rng';

/**
 * **The greedy one-ply agent, `greedy-1ply@1`** (Milestone 2 bullet 2, Unit C; §3.1 and §3.4 of
 * agent/docs/Milestone2_Bullet2_Prompts.md).
 *
 * At every decision it asks `core/candidates/` for the bounded set of moves worth considering,
 * plays each one into its own fork of the live position (`search/fork.ts`), drains that fork to the
 * end of the move, scores the position with the **Engine's own** `player.getVictoryPoints().total`,
 * and plays the argmax - breaking ties uniformly at random from its seeded stream.
 *
 * This is the OSLA equivalent from the prior-art paper, and it is one of the two **frozen fixed
 * baselines** every later strength claim is measured against.
 *
 * ---
 *
 * ## It is deliberately myopic, and that is the feature
 *
 * The objective is **points now, victory points only, no second term** (§3.1). Not points-plus-
 * economy, not margin over the best opponent, and - the non-obvious one - **no megacredit
 * tiebreak**. `match/ranking.ts` breaks VP ties on megacredits because that is the rule for ranking
 * *finished* games; inside a move chooser the same term is not a tiebreak but a **spending
 * penalty**, under which every candidate that costs money scores strictly below passing. Followed
 * through, that agent buys no cards at initial selection, buys none at any research phase, and
 * therefore never plays a project card in its entire life. That is not myopic-but-recognizable
 * play, it is a crippled agent, and it would make both the AC-3 bar and the prior-art comparison
 * meaningless.
 *
 * Milestone 3's whole contribution is valuing production, engine-building and timing. A baseline
 * that already valued them would turn AC-3's ">= 80% vs greedy one-ply" into a moving target. So
 * **nothing here may acquire a weight, a tuned term, or a hand-crafted feature**, and if the
 * baseline turns out to be only weakly better than random that is a finding to record, not a defect
 * to tune away (§3.1's "no escalation" rule).
 *
 * What this predicts it will *do*, recorded in the plan before any measurement and checkable from
 * {@link GreedyDecisionRecord}: claim milestones eagerly (+5 immediately), fund awards it currently
 * leads, raise TR at every opportunity, place greeneries next to its own cities (+2 rather than +1),
 * play cards with printed VP - and be **indifferent, i.e. random, across corporation choice, initial
 * card purchases and every research-phase buy**, all of which are VP-neutral at the moment of
 * choosing. {@link GreedyStats.byType} is where that prediction is falsifiable.
 *
 * ---
 *
 * ## The four decisions with a plausible wrong answer (§6 of the plan: "why C gets its own session")
 *
 * Each of these has an implementation that works, plays legally, runs fine, and quietly measures
 * something else.
 *
 * ### 1. The drain boundary (§3.4)
 *
 * A single `InputResponse` does not produce an evaluable position: playing a card cascades into
 * tile placement, resource choices and deferred actions, all still belonging to the same player.
 * Scoring immediately after submission scores a half-resolved position - card paid for, tile not yet
 * placed. So a candidate is drained before it is scored, and the drain stops at the **first** of:
 * the game ended; the next waiting player is not this agent's own player; the move completed
 * ({@link moveCompleted}); or the step budget ran out.
 *
 * The wrong answer is "drain until the next decision, whoever's it is". It is simpler and it makes
 * the agent score every candidate against a **randomly-played opponent reply** - opponent modelling
 * by accident, and a large source of noise. The second wrong answer is draining into the agent's own
 * *next* action, which turns a one-ply agent into a random-two-ply agent and multiplies its cost.
 * {@link moveCompleted} is the boundary between "finish resolving the move I just made" and "start
 * making a new one", and it is checked against the Engine (`actionsTakenThisRound`), not assumed.
 *
 * ### 2. Common random numbers (§3.4)
 *
 * The intervening sub-decisions are resolved by random-legal play, so a candidate's score partly
 * reflects a coin flip - which space the tile landed on, which resource was taken. **The drain RNG
 * is reconstructed from the same per-decision seed before every candidate**, so all candidates are
 * compared under identical sampled sub-choices. Without this the argmax is substantially noise, and
 * the result would look like a weak baseline when it is a noisy measurement.
 *
 * ### 3. Score the drained position, in the fork
 *
 * `getVictoryPoints()` is side-effect-free, so scoring cannot corrupt anything - but scoring the
 * *live* game would score the position before the candidate, i.e. the same number for every
 * candidate, and the agent would silently degenerate to its tie-break (which is random-legal by
 * another name). {@link GreedyStats.tieBreakFraction} is the number that would catch it.
 *
 * ### 4. The fallback is a common path, not a rare one
 *
 * §2.3.1's third fidelity check makes the fork service correctly refuse forks the original ~72%
 * forkability figure counted, and the service refuses rather than hands back a fork on a different
 * decision. The whole game-setup prefix - corporation choice, initial cards, preludes - has no
 * forkable ancestor at all. So the agent falls back to the random-legal move often, by design;
 * it **counts** every one with its reason ({@link GreedyFallbackReason}), and it keeps
 * `randomLegalAgent`'s behaviour exactly, including letting the driver's FR-9 conservative
 * resubmission handle a throw (SRS FR-9: never stall, never error).
 *
 * ---
 *
 * ## Streams: one per job, so a change to one cannot shift another (hazard H8)
 *
 * Four independent {@link AgentRandom}s, all from {@link createAgentRandom} at fixed offsets of the
 * seat's agent seed - `SeededRandom` is never constructed directly, and nothing is ever derived from
 * the Engine seed (SRS CON-5).
 *
 * | Stream | Job |
 * | --- | --- |
 * | `choiceRandom` | Breaking ties among argmax candidates - the only place the agent's *own* choice is random. |
 * | `candidateRandom` | The sampling `core/candidates/` does (the `card` k-subset, the cap's subsample). |
 * | `drainSeedRandom` | One seed per decision, replayed for every candidate - the common-random-numbers device above. |
 * | `fallbackRandom` | The random-legal move taken when the greedy path is unavailable. |
 *
 * Splitting them is what makes the diagnostics safe to add: a run with `onDecision` attached draws
 * exactly the same numbers as one without.
 */

// ---------------------------------------------------------------------------------------------
// Diagnostics (criterion G7, SRS FR-11 / NFR-6)
// ---------------------------------------------------------------------------------------------

/**
 * Why a decision was answered by the random-legal fallback instead of by the greedy path. Counted
 * separately because they mean different things, and because §5's G7 asks for "fork-unavailable
 * count **and the fallback taken**" rather than one number.
 */
export type GreedyFallbackReason =
  /** The candidate set was empty - e.g. a `projectCard` decision whose offered cards are all unaffordable. */
  | 'no-candidates'
  /** No fork could be produced at this decision. `forkUnavailableByReason` says why. */
  | 'fork-unavailable'
  /** The Engine refused a candidate inside a fork. Criterion G1a says this is 0; a non-zero count is a finding. */
  | 'candidate-rejected'
  /** A candidate's drain hit the step budget, so its position is not comparable with the others'. */
  | 'drain-budget-exhausted'
  /** A drain step failed outright (even the driver's FR-9 fallback could not resolve it). */
  | 'drain-failed'
  /** Candidate generation threw for a reason that is not a scope error (those are rethrown). */
  | 'candidate-generation-failed'
  /** The fork's waiting player is not the one the live decision belongs to. Should be unreachable. */
  | 'player-mismatch';

/**
 * One decision, as the agent decided it (SRS FR-11: the options considered, the chosen move, and a
 * brief score/rationale, at configurable verbosity).
 *
 * Emitted through {@link GreedyOnePlyOptions.onDecision}, which is **off by default**: a 2p game is
 * ~223 decisions and a validation run is a thousand games, so the aggregate
 * {@link GreedyStats} is what a run normally keeps. The per-decision stream is here so Unit D can
 * check the plan's own falsifiable predictions (§Appendix) without re-running anything.
 */
export type GreedyDecisionRecord = {
  readonly playerId: PlayerId;
  readonly decisionType: string;
  /** Candidates the generator produced, before the 64-cap subsample. */
  readonly generated: number;
  /** Candidates actually offered - `<= generated`, and `<= CANDIDATE_CAP`. */
  readonly offered: number;
  /** This node or a descendant was subsampled to the cap. */
  readonly capped: boolean;
  /** Candidates that were forked, applied, drained and scored. 0 on a fallback or a single candidate. */
  readonly scored: number;
  /** VP total of the best candidate's drained position, when anything was scored. */
  readonly bestScore?: number;
  /** VP total of the worst candidate's drained position - `bestScore - worstScore` is the spread greedy saw. */
  readonly worstScore?: number;
  /** How many candidates shared the top score. `> 1` means the choice was random. */
  readonly tiedForBest?: number;
  /** Drain steps summed over every scored candidate, and the largest single drain. */
  readonly drainSteps?: number;
  readonly drainStepsMax?: number;
  /** Set when the greedy path was not taken. */
  readonly fallback?: GreedyFallbackReason;
  /** Set when `fallback === 'fork-unavailable'`. */
  readonly forkUnavailable?: ForkUnavailableReason;
  /** Replay distance of the first fork taken at this decision - 0 when the live point was itself forkable. */
  readonly replayDistance?: number;
  /** The move submitted to the live game. */
  readonly chosen: InputResponse;
};

/**
 * A small-integer distribution, kept as a `value -> count` map rather than a raw array.
 *
 * Every quantity summarized this way is a bounded small integer (candidate counts are capped at 64,
 * drain steps at the budget, score spreads are single-digit VP), so the map is tiny, exact, and -
 * the part that matters - **mergeable**: a pooled run sums the maps of its shards and gets the same
 * median and p95 a single-process run would have reported. An array of 200,000 per-decision numbers
 * has neither property.
 */
export type Histogram = Record<number, number>;

/** The three-number summary the write-up carries, matching the shape Unit B's artifact uses. */
export type Distribution = {
  readonly count: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
};

/** Per-decision-type accounting - where §3.1's behavioural predictions become falsifiable. */
export type GreedyTypeStats = {
  decisions: number;
  scored: number;
  tieBroken: number;
  singleCandidate: number;
  fallbacks: number;
};

/** Everything the agent counts, for the G7 diagnostics. Mergeable across seats, games and shards. */
export type GreedyStats = {
  /** Live decisions this agent answered. */
  decisions: number;
  /** Decisions where >= 2 candidates were forked, drained and scored, so an argmax was really taken. */
  scored: number;
  /**
   * Of {@link scored}, the decisions where the top score was shared by more than one candidate and
   * the choice was therefore random.
   *
   * **This is the single most informative number in the bullet** (§5, G7): it measures how much of
   * "greedy" is actually greedy. A 90% win rate with an 80% tie-break fraction means something very
   * different from a 90% win rate with a 10% one, and only the second is a greedy agent. §3.1
   * predicts it will be *high*, because most single moves change current VP by zero.
   */
  tieBroken: number;
  /** Decisions with exactly one candidate: played directly, no fork, no choice, not a tie-break. */
  singleCandidate: number;
  /** Decisions answered by the random-legal fallback. */
  fallbacks: number;
  fallbacksByReason: Record<GreedyFallbackReason, number>;
  /** Why the fork service refused, over the decisions where it did. */
  forkUnavailableByReason: Record<ForkUnavailableReason, number>;
  /** Decisions whose candidate set hit the 64-cap, at this node or below. */
  cappedDecisions: number;
  /** Candidates forked, applied, drained and scored, in total. */
  candidatesScored: number;
  /** Candidates the Engine refused on first submission inside a fork. Criterion G1a says 0. */
  candidatesRejected: number;
  /** Drains that hit the step budget. Every one is counted, never swallowed (G7). */
  drainOverruns: number;
  /** FR-9 conservative resubmissions the driver made *inside* a drain. Speculative, so counted nowhere else. */
  drainFallbacks: number;
  /** Offered candidate-set size, per decision. */
  candidateCounts: Histogram;
  /** Drain steps, per scored candidate. */
  drainSteps: Histogram;
  /** `bestScore - worstScore`, per scored decision: the VP spread the objective could actually see. */
  scoreSpread: Histogram;
  /** How many candidates shared the top score, per scored decision. */
  tieSize: Histogram;
  byType: Record<string, GreedyTypeStats>;
  /** The configured drain budget, recorded so a reported overrun count carries its own threshold. */
  drainBudget: number;
  /** The fork service's own accounting - G3's coverage figures and the H7-correction refusal count. */
  fork: ForkStats;
};

export type GreedyOnePlyOptions = {
  /**
   * Passed to the {@link ForkService}: the fraction of forks whose full serialized state is compared
   * against the live game's (the expensive third of the three-way check). Default 0; criterion G3
   * asks for >= 0.05.
   */
  validateRate?: number;
  /**
   * Maximum random-legal sub-decisions resolved while draining one candidate to the end of its move.
   *
   * **Pre-committed at 32** (§5, G7), before any measurement, so it is a design parameter and not a
   * performance patch applied after seeing a slow run. A drain that hits it abandons the *whole
   * decision* to the random-legal fallback rather than scoring a position the other candidates were
   * not compared against - see {@link GreedyFallbackReason}.
   */
  drainBudget?: number;
  /** Per-decision structured records (SRS FR-11 / NFR-6). Off by default - see {@link GreedyDecisionRecord}. */
  onDecision?: (record: GreedyDecisionRecord) => void;
  /** `console.log` one line per decision. Off by default, as `randomLegalAgent`'s equivalent is. */
  logDecisions?: boolean;
};

/** §5's pre-committed drain step budget. Exported so a spec asserts against the constant, not a copy. */
export const DEFAULT_DRAIN_BUDGET = 32;

/** The offsets that give each job its own stream. Fixed constants, so a seat's streams are reproducible. */
const CANDIDATE_STREAM_OFFSET = 1_000_003;
const DRAIN_SEED_STREAM_OFFSET = 2_000_029;
const FALLBACK_STREAM_OFFSET = 3_000_017;
/** Per-decision drain seeds are drawn from this range; wide enough that repeats are irrelevant. */
const DRAIN_SEED_RANGE = 2 ** 31;

// ---------------------------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------------------------

/** A seated {@link greedyOnePlyAgent}, plus the handle its diagnostics are read through. */
export type GreedyAgent = SeatedAgent & {stats: () => GreedyStats};

/**
 * Builds the greedy one-ply agent for one seat of one game.
 *
 * Constructed **once per game** by `match/runner.ts`, which is what lets the {@link ForkService} in
 * this closure hold that game's rolling ancestor and recorded responses.
 */
export function greedyOnePlyAgent(seed: number, options: GreedyOnePlyOptions = {}): GreedyAgent {
  const drainBudget = options.drainBudget ?? DEFAULT_DRAIN_BUDGET;
  const service = new ForkService({validateRate: options.validateRate});

  const choiceRandom = createAgentRandom(seed);
  const candidateRandom = createAgentRandom(seed + CANDIDATE_STREAM_OFFSET);
  const drainSeedRandom = createAgentRandom(seed + DRAIN_SEED_STREAM_OFFSET);
  const fallback: EmbeddedResponder = randomLegalAgent(createAgentRandom(seed + FALLBACK_STREAM_OFFSET));

  const counters = emptyStats(drainBudget);

  const respond: EmbeddedResponder = (decision: EmbeddedDecisionPoint): InputResponse => {
    counters.decisions++;
    const type = decision.model.type;
    const byType = typeStats(counters, type);
    byType.decisions++;

    // The per-decision seed is drawn whether or not it ends up being used, so the stream advances
    // once per decision regardless of which path this decision takes. A seed drawn only on the
    // greedy path would make the whole agent's randomness depend on fork availability, which is
    // exactly the kind of coupling criterion G6 (reproducibility) exists to rule out.
    const drainSeed = drainSeedRandom.nextInt(DRAIN_SEED_RANGE);

    let set: CandidateSet;
    try {
      set = candidates(decision, candidateRandom);
    } catch (error) {
      // Scope errors are dispatch-level findings, not "this state tripped up a working handler":
      // `randomLegalAgent` surfaces them loudly and `embeddedDriver` deliberately does not apply the
      // FR-9 fallback to them. Same treatment here - retrying would only hide the signal.
      if (error instanceof OutOfScopeDecisionError || error instanceof NotYetImplementedDecisionError) {
        throw error;
      }
      return fallbackMove(decision, 'candidate-generation-failed', {});
    }

    counters.candidateCounts[set.candidates.length] = (counters.candidateCounts[set.candidates.length] ?? 0) + 1;
    if (set.cappedNodes > 0) {
      counters.cappedDecisions++;
    }

    if (set.candidates.length === 0) {
      // Legal and expected (see `candidates/types.ts`): the fallback lets the random-legal path -
      // and behind it the driver's FR-9 conservative resubmission - resolve it exactly as it does
      // for `random-legal@1`.
      return fallbackMove(decision, 'no-candidates', {generated: set.generated, capped: set.cappedNodes > 0});
    }

    if (set.candidates.length === 1) {
      // The argmax of a one-element set, with no fork spent to discover it. Not a tie-break: there
      // was no choice to make, and folding it into the tie-break fraction would inflate the one
      // number §5 calls the most informative in the bullet.
      counters.singleCandidate++;
      byType.singleCandidate++;
      const chosen = set.candidates[0];
      emit(decision, {
        generated: set.generated,
        offered: 1,
        capped: set.cappedNodes > 0,
        scored: 0,
        chosen,
      });
      return chosen;
    }

    const evaluation = withSpeculation(() => evaluate(decision, set, drainSeed));
    if (evaluation.fallback !== undefined) {
      return fallbackMove(decision, evaluation.fallback, {
        generated: set.generated,
        offered: set.candidates.length,
        capped: set.cappedNodes > 0,
        forkUnavailable: evaluation.forkUnavailable,
      });
    }

    const {scores, drainStepsTotal, drainStepsMax, replayDistance} = evaluation;
    const best = Math.max(...scores);
    const tied: Array<number> = [];
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] === best) {
        tied.push(i);
      }
    }
    const worst = Math.min(...scores);
    const index = tied.length === 1 ? tied[0] : choiceRandom.pick(tied);
    const chosen = set.candidates[index];

    counters.scored++;
    byType.scored++;
    counters.candidatesScored += scores.length;
    counters.scoreSpread[best - worst] = (counters.scoreSpread[best - worst] ?? 0) + 1;
    counters.tieSize[tied.length] = (counters.tieSize[tied.length] ?? 0) + 1;
    if (tied.length > 1) {
      counters.tieBroken++;
      byType.tieBroken++;
    }

    emit(decision, {
      generated: set.generated,
      offered: set.candidates.length,
      capped: set.cappedNodes > 0,
      scored: scores.length,
      bestScore: best,
      worstScore: worst,
      tiedForBest: tied.length,
      drainSteps: drainStepsTotal,
      drainStepsMax,
      replayDistance,
      chosen,
    });
    return chosen;
  };

  /**
   * Forks once per candidate, applies it, drains to the end of the move, and scores.
   *
   * Returns a fallback reason instead of partial scores whenever *any* candidate could not be
   * evaluated. That is deliberate and it is the conservative reading §3.4 asks for: an argmax over a
   * subset that silently dropped the candidates which were hard to evaluate is a *biased* argmax,
   * and the bias would run exactly along the moves with the most cascading consequences - the
   * interesting ones. Better to take the random-legal move and count why.
   */
  function evaluate(decision: EmbeddedDecisionPoint, set: CandidateSet, drainSeed: number): {
    scores: Array<number>;
    drainStepsTotal: number;
    drainStepsMax: number;
    replayDistance: number;
    fallback?: GreedyFallbackReason;
    forkUnavailable?: ForkUnavailableReason;
  } {
    const scores: Array<number> = [];
    let drainStepsTotal = 0;
    let drainStepsMax = 0;
    let replayDistance = 0;

    for (let i = 0; i < set.candidates.length; i++) {
      const outcome = service.fork();
      if (!outcome.available) {
        counters.forkUnavailableByReason[outcome.reason]++;
        return {scores, drainStepsTotal, drainStepsMax, replayDistance, fallback: 'fork-unavailable', forkUnavailable: outcome.reason};
      }
      if (i === 0) {
        replayDistance = outcome.replayDistance;
      }
      if (outcome.player.id !== decision.player.id) {
        // Unreachable: the fork service certifies the fork against the live game's
        // `pendingModelSignature`, which pins which players are waiting and with what. Checked
        // anyway, because "unreachable" is a claim about the Engine and the alternative is scoring
        // somebody else's move as if it were ours.
        return {scores, drainStepsTotal, drainStepsMax, replayDistance, fallback: 'player-mismatch'};
      }

      // Common random numbers (§3.4): every candidate is drained under the *same* stream of sampled
      // sub-choices, reconstructed here rather than continued, so the comparison between candidates
      // is not partly a comparison between coin flips.
      const drainRandom: AgentRandom = createAgentRandom(drainSeed);
      const drainResponder = randomLegalAgent(drainRandom);

      const phaseBefore = outcome.game.phase;
      const actionsBefore = outcome.player.actionsTakenThisRound;
      try {
        // The Engine's own definition of legal, on first submission and with no retry (SRS CON-2).
        // A copy, because the same candidate object is submitted into several forks and then
        // returned to the live game.
        outcome.player.process(copyResponse(set.candidates[i]));
        drainQueue(outcome.game, outcome.player);
      } catch {
        counters.candidatesRejected++;
        return {scores, drainStepsTotal, drainStepsMax, replayDistance, fallback: 'candidate-rejected'};
      }

      let steps: number;
      try {
        steps = drain(outcome.game, outcome.player, phaseBefore, actionsBefore, drainResponder);
      } catch {
        return {scores, drainStepsTotal, drainStepsMax, replayDistance, fallback: 'drain-failed'};
      }
      if (steps > drainBudget) {
        counters.drainOverruns++;
        return {scores, drainStepsTotal, drainStepsMax, replayDistance, fallback: 'drain-budget-exhausted'};
      }
      counters.drainSteps[steps] = (counters.drainSteps[steps] ?? 0) + 1;
      drainStepsTotal += steps;
      drainStepsMax = Math.max(drainStepsMax, steps);

      // §3.1: the Engine's own score function, over the Engine's own state (SRS CON-1). There is no
      // rule to get wrong here and nothing to maintain, and `calculateVictoryPoints` is
      // side-effect-free, so scoring cannot perturb the position it is reading.
      scores.push(outcome.player.getVictoryPoints().total);
    }

    return {scores, drainStepsTotal, drainStepsMax, replayDistance};
  }

  /**
   * Resolves the agent's own sub-decisions until the candidate move is finished (§3.4's four
   * conditions), returning the number of steps taken. A return value greater than `drainBudget`
   * means the budget stopped it.
   *
   * The steps go through `applyDecision`, not through a bare `process`, and that is a deliberate
   * departure from hazard H6 - which governs *replay*, where a rejected step must surface as a
   * divergence rather than be silently substituted. A drain is not a replay: these are freshly
   * sampled random-legal moves with no recorded original to diverge from, and resolving them the
   * way the live driver resolves the very same sub-decisions (including the FR-9 conservative
   * resubmission, which is deterministic and so preserves common random numbers) is the most
   * faithful available answer to "what position does this move actually reach". The one thing that
   * would be unsafe - a drain step escaping to the live game - is ruled out positively by
   * {@link assertSpeculative} before the first step.
   */
  function drain(game: IGame, self: IPlayer, phaseBefore: Phase, actionsBefore: number, responder: EmbeddedResponder): number {
    assertSpeculative(game);
    let steps = 0;
    for (;;) {
      if (game.phase === Phase.END) {
        return steps;
      }
      const waiting = nextWaitingPlayer(game);
      // Condition 2: never drain through an opponent's decision. Standing random-legal in for the
      // opponent would score every candidate against a randomly-played reply - opponent modelling by
      // accident, and a large source of noise.
      if (waiting === undefined || waiting.id !== self.id) {
        return steps;
      }
      // Condition 3: never drain into the agent's own *next* move.
      if (moveCompleted(game, waiting, phaseBefore, actionsBefore)) {
        return steps;
      }
      if (steps >= drainBudget) {
        return steps + 1;
      }
      applyDecision(waiting, responder, {onFallback: () => {
        counters.drainFallbacks++;
      }});
      steps++;
    }
  }

  function fallbackMove(
    decision: EmbeddedDecisionPoint,
    reason: GreedyFallbackReason,
    detail: {generated?: number; offered?: number; capped?: boolean; forkUnavailable?: ForkUnavailableReason},
  ): InputResponse {
    counters.fallbacks++;
    counters.fallbacksByReason[reason]++;
    typeStats(counters, decision.model.type).fallbacks++;
    // `randomLegalAgent`'s behaviour is kept intact, throw included: the driver's FR-9 conservative
    // resubmission is what handles the known `projectCard`/standard-project coupling, and swallowing
    // the throw here would replace a mechanism validated over 1,500 games with an untested one.
    const chosen = fallback(decision);
    emit(decision, {
      generated: detail.generated ?? 0,
      offered: detail.offered ?? 0,
      capped: detail.capped ?? false,
      scored: 0,
      fallback: reason,
      forkUnavailable: detail.forkUnavailable,
      chosen,
    });
    return chosen;
  }

  function emit(decision: EmbeddedDecisionPoint, record: Omit<GreedyDecisionRecord, 'playerId' | 'decisionType'>): void {
    if (options.onDecision === undefined && options.logDecisions !== true) {
      return;
    }
    const full: GreedyDecisionRecord = {playerId: decision.player.id, decisionType: decision.model.type, ...record};
    options.onDecision?.(full);
    if (options.logDecisions === true) {
      console.log(
        `[greedy-1ply] player ${full.playerId}: ${full.decisionType} ` +
        `(${full.offered}/${full.generated} candidates, ${full.scored} scored` +
        `${full.bestScore === undefined ? '' : `, best ${full.bestScore} VP, ${full.tiedForBest} tied`}` +
        `${full.fallback === undefined ? '' : `, fallback: ${full.fallback}`}) -> ${JSON.stringify(full.chosen)}`,
      );
    }
  }

  return {
    respond,
    driverOptions: service.driverOptions,
    observeDecisions: (inner) => service.observeDecisions(inner),
    stats: () => ({
      ...counters,
      fallbacksByReason: {...counters.fallbacksByReason},
      forkUnavailableByReason: {...counters.forkUnavailableByReason},
      candidateCounts: {...counters.candidateCounts},
      drainSteps: {...counters.drainSteps},
      scoreSpread: {...counters.scoreSpread},
      tieSize: {...counters.tieSize},
      byType: Object.fromEntries(Object.entries(counters.byType).map(([type, stats]) => [type, {...stats}])),
      fork: service.stats,
    }),
  };
}

/**
 * §3.4's condition 3, verified against the Engine rather than assumed.
 *
 * **In `Phase.ACTION`,** `player.actionsTakenThisRound` (`src/server/Player.ts:125`) is the boundary.
 * It is incremented in `takeAction`'s `runWhenEmpty` continuation (`Player.ts:1550`), i.e. once the
 * whole action has resolved and immediately before the "Take your first/next action" input is built
 * (`Player.ts:1556`) - which is exactly the moment the move being evaluated is finished and the next
 * one would begin.
 *
 * The comparison is `!==`, not `>`, and that is the conservative reading Unit C's prompt asks for.
 * The counter is also **reset to 0** when the player's turn ends (`Player.ts:1495`), so a strict
 * `>` would read a reset as "not yet advanced" and keep draining. In practice condition 2 catches
 * that case a step later - the reset accompanies `playerIsFinishedTakingActions()` - but "in
 * practice" is not the standard here: stopping early costs a slightly under-resolved position for
 * one candidate, while stopping late scores a *different move*.
 *
 * **Outside `Phase.ACTION`** there is no per-move counter, so the phase itself is the boundary: a
 * prelude, a research buy or the initial-cards selection is finished when the phase moves on.
 *
 * Exported for `test/core/greedyOnePlyAgent.spec.ts`, which checks the *Engine* claim above rather
 * than the arithmetic here: that where this returns `true` mid-`ACTION` with the same player still
 * waiting, the decision it stopped at is the top-of-turn action menu - i.e. the next move, not the
 * middle of this one.
 */
export function moveCompleted(game: IGame, self: IPlayer, phaseBefore: Phase, actionsBefore: number): boolean {
  if (phaseBefore === Phase.ACTION) {
    return game.phase !== Phase.ACTION || self.actionsTakenThisRound !== actionsBefore;
  }
  return game.phase !== phaseBefore;
}

/**
 * The driver's own guarded deferred drain, applied after a candidate is submitted.
 *
 * Copied from `applyDecision` and **must stay identical to it**: the guard is the fix for a real
 * driver bug (an unconditional `runAll()` overwriting a freshly-set `waitingFor`, Running Notes
 * 2026-07-22), and a candidate that resolved differently from the way the live driver would have
 * resolved it is scoring a position the live game could not reach.
 */
function drainQueue(game: IGame, player: IPlayer): void {
  if (player.getWaitingFor() === undefined) {
    game.deferredActions.runAll(() => {});
  }
}

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

// ---------------------------------------------------------------------------------------------
// Stats: construction, merging, summarizing
// ---------------------------------------------------------------------------------------------

const FALLBACK_REASONS: ReadonlyArray<GreedyFallbackReason> = [
  'no-candidates',
  'fork-unavailable',
  'candidate-rejected',
  'drain-budget-exhausted',
  'drain-failed',
  'candidate-generation-failed',
  'player-mismatch',
];

const FORK_UNAVAILABLE_REASONS: ReadonlyArray<ForkUnavailableReason> = [
  'no-game',
  'no-ancestor',
  'restore-rejected',
  'replay-failed',
  'validation-failed',
];

function emptyStats(drainBudget: number): GreedyStats {
  return {
    decisions: 0,
    scored: 0,
    tieBroken: 0,
    singleCandidate: 0,
    fallbacks: 0,
    fallbacksByReason: Object.fromEntries(FALLBACK_REASONS.map((reason) => [reason, 0])) as Record<GreedyFallbackReason, number>,
    forkUnavailableByReason: Object.fromEntries(FORK_UNAVAILABLE_REASONS.map((reason) => [reason, 0])) as Record<ForkUnavailableReason, number>,
    cappedDecisions: 0,
    candidatesScored: 0,
    candidatesRejected: 0,
    drainOverruns: 0,
    drainFallbacks: 0,
    candidateCounts: {},
    drainSteps: {},
    scoreSpread: {},
    tieSize: {},
    byType: {},
    drainBudget,
    fork: mergeForkStats([]),
  };
}

function typeStats(counters: GreedyStats, type: string): GreedyTypeStats {
  let stats = counters.byType[type];
  if (stats === undefined) {
    stats = {decisions: 0, scored: 0, tieBroken: 0, singleCandidate: 0, fallbacks: 0};
    counters.byType[type] = stats;
  }
  return stats;
}

function addHistogram(into: Histogram, part: Histogram): void {
  for (const [value, count] of Object.entries(part)) {
    into[Number(value)] = (into[Number(value)] ?? 0) + count;
  }
}

/**
 * Sums the stats of several agents - one per seat, per game, or per pool shard - into a run-level
 * block. Exact for every field, including the distributions (see {@link Histogram}).
 */
export function mergeGreedyStats(parts: ReadonlyArray<GreedyStats>): GreedyStats {
  const merged = emptyStats(parts[0]?.drainBudget ?? DEFAULT_DRAIN_BUDGET);
  for (const part of parts) {
    merged.decisions += part.decisions;
    merged.scored += part.scored;
    merged.tieBroken += part.tieBroken;
    merged.singleCandidate += part.singleCandidate;
    merged.fallbacks += part.fallbacks;
    merged.cappedDecisions += part.cappedDecisions;
    merged.candidatesScored += part.candidatesScored;
    merged.candidatesRejected += part.candidatesRejected;
    merged.drainOverruns += part.drainOverruns;
    merged.drainFallbacks += part.drainFallbacks;
    for (const reason of FALLBACK_REASONS) {
      merged.fallbacksByReason[reason] += part.fallbacksByReason[reason] ?? 0;
    }
    for (const reason of FORK_UNAVAILABLE_REASONS) {
      merged.forkUnavailableByReason[reason] += part.forkUnavailableByReason[reason] ?? 0;
    }
    addHistogram(merged.candidateCounts, part.candidateCounts);
    addHistogram(merged.drainSteps, part.drainSteps);
    addHistogram(merged.scoreSpread, part.scoreSpread);
    addHistogram(merged.tieSize, part.tieSize);
    for (const [type, stats] of Object.entries(part.byType)) {
      const into = typeStats(merged, type);
      into.decisions += stats.decisions;
      into.scored += stats.scored;
      into.tieBroken += stats.tieBroken;
      into.singleCandidate += stats.singleCandidate;
      into.fallbacks += stats.fallbacks;
    }
  }
  merged.fork = mergeForkStats(parts.map((part) => part.fork));
  return merged;
}

/** The `{count, median, p95, max}` summary of a {@link Histogram}. */
export function summarize(histogram: Histogram): Distribution {
  const entries = Object.entries(histogram)
    .map(([value, count]) => [Number(value), count] as const)
    .sort(([a], [b]) => a - b);
  const count = entries.reduce((total, [, n]) => total + n, 0);
  if (count === 0) {
    return {count: 0, median: 0, p95: 0, max: 0};
  }
  const at = (fraction: number): number => {
    const target = Math.min(count, Math.max(1, Math.ceil(fraction * count)));
    let seen = 0;
    for (const [value, n] of entries) {
      seen += n;
      if (seen >= target) {
        return value;
      }
    }
    return entries[entries.length - 1][0];
  };
  return {count, median: at(0.5), p95: at(0.95), max: entries[entries.length - 1][0]};
}

/**
 * The tie-break fraction (§5, G7): the share of decisions where the agent really chose, on which it
 * nevertheless chose at random.
 *
 * The denominator is {@link GreedyStats.scored} - decisions where two or more candidates were
 * actually scored - and **not** every decision. Decisions with one candidate, and decisions that
 * fell back, involved no choice at all, and folding them in would report a number about fork
 * availability dressed up as a number about the objective. Both populations are counted separately
 * and the write-up reports all three; this function is the one that answers "how much of greedy is
 * actually greedy".
 */
export function tieBreakFraction(stats: GreedyStats): number {
  return stats.scored === 0 ? 0 : stats.tieBroken / stats.scored;
}

// ---------------------------------------------------------------------------------------------
// Collecting diagnostics from a run (Unit D's handle)
// ---------------------------------------------------------------------------------------------

type Collector = {
  options: GreedyOnePlyOptions;
  agents: Array<GreedyAgent>;
};

/**
 * The active {@link withGreedyDiagnostics} scope, or `undefined`.
 *
 * **Process-global, and deliberately so.** `agents/registry.ts` builds an agent from a *seed alone*
 * (`create(seed)`), which is the seam that keeps `match/runner.ts` ignorant of which brain is in
 * which seat - so a run has no handle on the agents it created and no way to pass them options.
 * `search/speculation.ts`'s `runWithSpeculationCounted` solves the identical problem the identical
 * way, and carries the same constraint: nothing else in the process may run a greedy agent
 * concurrently while a scope is open.
 */
let collector: Collector | undefined;

/**
 * Runs `fn` with `options` applied to every `greedy-1ply` agent the registry creates inside it, and
 * returns the merged {@link GreedyStats} beside `fn`'s own value.
 *
 * This is how Unit D turns a match run into the G7 diagnostics without re-running anything, and how
 * it sets G3's `validateRate` on an agent the runner constructs on its behalf.
 *
 * **Async on purpose**, like its counterpart in `speculation.ts`: a match run is `async`, so a
 * synchronous `try/finally` would tear the scope down at the first `await` rather than at the end of
 * the run.
 */
export async function withGreedyDiagnostics<T>(
  options: GreedyOnePlyOptions,
  fn: () => Promise<T>,
): Promise<{value: T; stats: GreedyStats; agents: number}> {
  if (collector !== undefined) {
    throw new Error('withGreedyDiagnostics is already in progress; the collector is process-global and does not nest.');
  }
  const scope: Collector = {options, agents: []};
  collector = scope;
  try {
    const value = await fn();
    return {value, stats: mergeGreedyStats(scope.agents.map((agent) => agent.stats())), agents: scope.agents.length};
  } finally {
    collector = undefined;
  }
}

/**
 * The registry's constructor: {@link greedyOnePlyAgent} under whatever {@link withGreedyDiagnostics}
 * scope is open, registered with it so its stats can be collected at the end of the run.
 */
export function createGreedyOnePlyAgent(seed: number): GreedyAgent {
  const agent = greedyOnePlyAgent(seed, collector?.options ?? {});
  collector?.agents.push(agent);
  return agent;
}
