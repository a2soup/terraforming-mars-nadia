import {CardName} from '@/common/cards/CardName';
import {PlayerId} from '@/common/Types';
import {CorpusHeader} from '../determinism/corpus';
import {CauseTally} from '../legality/types';
import {Percentiles} from '../legality/types';
import {AgentIdentity} from '../agents/registry';

/**
 * The match runner's record schema (Milestone 2, bullet 1, Unit A; the design is settled in
 * agent/docs/Milestone2_Bullet1_Prompts.md §4.3).
 *
 * **Read this before pruning a field as unused.** Every field below is here because a *named
 * downstream consumer* needs it, and each one says which. The schema was designed once, against
 * the whole consumer list, rather than growing out of whatever the runner happened to have handy,
 * for a specific reason: re-running is cheap for `random-legal` (~26 s for 1,000 games compiled)
 * and expensive for every agent after it. A field omitted today - the corporation each seat took,
 * say - costs a 1,000-game re-run now and a multi-hour one at M4. The consumers:
 *
 * | Consumer | What it reads |
 * | --- | --- |
 * | Bullet 3 (FR-14 ratings) | per-seat `placement`, `isWinner`, `marginToNext`, agent identity per seat |
 * | Bullet 4 (FR-DATA-1, AC-8) | `victoryPoints`, `terraformRating`, `generation`, `corporations`, `projectCards`, `preludes`, `claimedMilestones`, `fundedAwards` |
 * | M3 (evaluation tuning) | the above plus `victoryPointsByGeneration` and `vpBreakdown` |
 * | AC-5 (3p/4p competence) | `placement` at 3p/4p - a boolean "won" cannot tell second from third |
 * | AC-7 / FR-15 (promotion gate) | agent **name and version** per seat, `provenance.engineCommit`, the seeds |
 * | AC-1 / NFR-4 per version (§4.6) | `completed`, `failure`, `decisions`, `fallbacksAfter*`, and - in legality mode - {@link MatchLegalityCounters} |
 * | Reproducibility (NFR-5) | `engineSeed`, per-seat `agentSeed`, `groupIndex`, `permutationIndex`, `harnessVersion` |
 *
 * **Two structural rules** (§4.3), both of which are about the artifact staying readable at
 * 1,000+ rows:
 *
 * - **Per-run header, per-game rows.** Anything constant across the run - the Engine pin, the
 *   agent versions, the pairing policy, the seed schedule - lives in {@link MatchRunHeader},
 *   written once. `legality/types.ts` records the same lesson for its own row type
 *   ("deliberately small and flat"): an artifact that repeats the Engine commit 1,000 times is a
 *   file nobody will diff.
 * - **The move history is not in the game row.** It is tiered and separate (§4.4) - see
 *   {@link HistoryTier} and {@link MatchGameHistory}, which Unit B populates.
 *
 * **Identity: do not key a record on `game.id`** (hazard H4). `gameFactory.ts` builds
 * `g-nadia-${seed}` and omits the player count, so a 2p and a 3p game on the same engine seed
 * share an id. A game is identified by `(runId, groupIndex, permutationIndex)` - `runId` in the
 * header, the other two on the row.
 */

/** Bumped when a change to this schema would make an old artifact misread by new code. */
export const MATCH_HARNESS_VERSION = '1';

// ---------------------------------------------------------------------------------------------
// The match specification: the reproducible unit of measurement
// ---------------------------------------------------------------------------------------------

/**
 * What to play. The *specification* of a match, not its result - pure data, and the thing a
 * re-run has to match for two artifacts to be comparable.
 *
 * `groups` counts **pairing groups**, not games (§4.1): a group fixes one engine seed and plays
 * the lineup in every seat permutation, so `games = groups × permutationsPerGroup`. That is the
 * unit because it is the unit the seat balance is achieved over; a "number of games" that is not
 * a whole number of groups is an unbalanced sample wearing a balanced sample's name.
 */
export type MatchSpec = {
  players: 2 | 3 | 4;
  /**
   * One agent name (a key of the registry) per **lineup slot**. Length must equal `players`.
   * Slots are the identities being compared; seats are where they sit, and the pairing rotates
   * slots through seats (§4.1).
   */
  lineup: ReadonlyArray<string>;
  /** Number of pairing groups to play. */
  groups: number;
  /**
   * Index of the first group in the seed schedule (default 0). Lets a later run extend an
   * earlier one with fresh games instead of replaying it: `--start-group 500 --groups 500`
   * continues where a 500-group run stopped.
   */
  startGroup?: number;
};

/** A {@link MatchSpec} with the registry consulted and the derived counts computed. */
export type ResolvedMatchSpec = {
  players: 2 | 3 | 4;
  /** Slot k's agent, with the version that will be recorded in every row (AC-7). */
  lineup: ReadonlyArray<AgentIdentity>;
  groups: number;
  startGroup: number;
  /** `n!` for n ≤ 3, 4 cyclic rotations at 4p (§4.1). */
  permutationsPerGroup: number;
  /** `groups × permutationsPerGroup`. */
  games: number;
};

/**
 * One fully-resolved game. **Pure, serializable and stateless, deliberately**: Unit C's process
 * pool ships these to child processes, so nothing here may be a closure, a class instance or a
 * reference to live Engine state.
 */
export type MatchGameConfig = {
  /** Absolute group index in the seed schedule (already includes `startGroup`). */
  groupIndex: number;
  /** Index of this permutation within the group's permutation list. */
  permutationIndex: number;
  players: 2 | 3 | 4;
  /** Shared by every game in the group - this is the variance reduction (§4.1). */
  engineSeed: number;
  /** `seating[seat]` is the lineup slot sitting in that seat. A permutation of `0..players-1`. */
  seating: ReadonlyArray<number>;
  /** `agentSeeds[slot]`: travels with the lineup slot, not the seat, and is constant across the group (§4.1). */
  agentSeeds: ReadonlyArray<number>;
  /** `lineup[slot]`: the agent name, repeated per config so a child process needs nothing else. */
  lineup: ReadonlyArray<string>;
};

// ---------------------------------------------------------------------------------------------
// Per-game records
// ---------------------------------------------------------------------------------------------

/**
 * The end-of-game numbers for one seat. Everything here is free to read off the live `IGame` at
 * `Phase.END` and costs a full re-run to add later, which is why the list is generous.
 */
export type MatchSeatOutcome = {
  /**
   * 1-based, ties sharing the lower number (1, 1, 3). **Placement, not a boolean win**: AC-5 is
   * stated in placement terms, and a 3p record that says only `isWinner: false` cannot
   * distinguish second from third. See `match/ranking.ts` for the rule.
   */
  placement: number;
  /** True for every seat tied at placement 1 - the Engine's own `winners` rule (`GameEnd.vue`). */
  isWinner: boolean;
  /**
   * VP gap down to the best seat in the *next* placement group; `undefined` for the last
   * placement. Bullet 3's margin-aware ratings (and any "how close was it" question) need this,
   * and it cannot be recovered from a win/loss flag.
   */
  marginToNext: number | undefined;
  /** `player.getVictoryPoints().total` - the Engine's own total, the primary sort key. */
  victoryPoints: number;
  /** `player.megaCredits` - the Engine's tiebreak, recorded so a tie can be audited, not just trusted. */
  megaCredits: number;
  /** Bullet 4 (AC-8) reports TR at game end as part of the expert-distribution comparison. */
  terraformRating: number;
  /** M3 tunes against the VP components, not just the total. */
  vpBreakdown: MatchVpBreakdown;
  /**
   * The per-generation VP curve the Engine already maintains (`IPlayer.victoryPointsByGeneration`).
   * Free at `Phase.END`, and exactly the shape AC-8's calibration and M3's tuning want - a scoring
   * *tempo*, not just a final score.
   */
  victoryPointsByGeneration: ReadonlyArray<number>;
  /**
   * Bullet 4 / FR-DATA-1: the expert dataset is a per-corporation and per-card win-rate table, so
   * a reconciliation needs the corporation this seat actually played. In scope (base + Corporate
   * Era + Prelude) this is always exactly one; it is an array because the Engine's own model is.
   */
  corporations: ReadonlyArray<CardName>;
  /** Bullet 4 / FR-DATA-1, prelude half. */
  preludes: ReadonlyArray<CardName>;
  /**
   * Every project card this seat played, in play order. The per-card half of FR-DATA-1, and the
   * single most expensive field to add later (it cannot be reconstructed from anything else).
   */
  projectCards: ReadonlyArray<CardName>;
};

/** The subset of the Engine's `VictoryPointsBreakdown` that exists in scope (base + CorpEra + Prelude). */
export type MatchVpBreakdown = {
  terraformRating: number;
  milestones: number;
  awards: number;
  greenery: number;
  city: number;
  /** Card VP (the Engine calls this `victoryPoints`) - VP printed on played cards and their resources. */
  cards: number;
  total: number;
};

/**
 * One seat: who sat there and how it finished. Identity is always present - a failed game still
 * records who was playing, or the failure cannot be attributed to a version (AC-7, AC-1).
 * `outcome` is absent exactly when the game did not complete.
 */
export type MatchSeatRecord = {
  /** 0-based seat index: the seat's position in `game.players`, i.e. its turn order (seat 0 leads). */
  seat: number;
  /** The lineup slot seated here. R1a aggregates by slot; R1b aggregates by seat. */
  slot: number;
  /** Engine player id (`p-red`, ...). Recorded so a `moves`-tier history can be joined back to a seat. */
  playerId: PlayerId;
  agent: string;
  /** The registry-declared version (AC-7, and the AC-1 re-run's key). */
  agentVersion: string;
  /** This slot's agent seed, constant across the group (§4.1). Reproducibility (NFR-5). */
  agentSeed: number;
  outcome?: MatchSeatOutcome;
};

/** Who claimed/funded what. Bullet 4's expert-distribution report compares these rates directly. */
export type MatchMilestoneRecord = {milestone: string; seat: number};
export type MatchAwardRecord = {award: string; seat: number};

/**
 * The strict submission accounting, populated only in **legality mode** (§4.6) by Unit B's
 * `match/legality.ts`, which wraps `legality/SubmissionMonitor`. Absent otherwise.
 *
 * These are *not* the same numbers as `fallbacksAfterRejection`/`fallbacksAfterThrow` below, and
 * the difference is the entire point of criterion R8. The driver's `onFallback` cannot see the
 * FR-9 fallback's own rejected `'or'`-branch probes; only a `Player.prototype.process` wrapper
 * can. A "zero illegal moves" claim that silently omits a population of rejected submissions is,
 * in `submissionMonitor.ts`'s own words, an accounting choice presented as a result.
 */
export type MatchLegalityCounters = {
  /** Every `player.process()` call during this game, whoever made it. The strict denominator. */
  submissions: number;
  /** Rejected submissions of a move the *responder* chose. NFR-4 is adjudicated on this. */
  rejectedResponder: number;
  /** Rejected submissions from the FR-9 fallback's own `'or'`-branch probes - recovery working as designed. */
  rejectedFallbackProbe: number;
  /** The responder threw before producing a move: nothing was submitted, so not an illegal move. */
  responderThrows: number;
};

/** How much history to record (§4.4). Costs are per game, measured by Unit B. */
export type HistoryTier =
  /** The game record only (~1 KB/game). Ratings, AC-8, bulk runs. */
  | 'summary'
  /** + the move-trace hash chain from `determinism/replay.ts` (~100 B/game). Regression seeds, divergence localization. */
  | 'trace'
  /** + the full ordered list of **submitted** responses. Inspection, M3 debugging, AC-6 expert review. */
  | 'moves';

/**
 * The history attached to one game. **Unit B owns the population of this field** (`match/history.ts`)
 * and the meaning of every optional member; Unit A declares it here because `MatchGameRecord`
 * lives in this file and §9 makes this file A's.
 *
 * The `detail` escape hatch exists so Unit B is never blocked on an A-owned file: anything it
 * needs that is not modelled here goes there, and `history.ts`'s module doc is where its shape is
 * documented.
 *
 * **A recorded history is not the primary reproduction mechanism.** Determinism is verified
 * move-for-move under a fixed `(engine seed, agent seed, engine commit, agent version)`
 * (docs/Determinism_Verification.md), so a game is re-derived from its record's *seeds*. The
 * `moves` tier is for human and tool inspection. The opposite assumption - replay the move list
 * to rebuild the game - is the natural one and it is fragile.
 */
export type MatchGameHistory = {
  tier: HistoryTier;
  /** The rolling hash over the decision sequence (`determinism/replay.ts`'s `MoveTrace`). `trace` tier and above. */
  moveTraceHash?: string;
  /** Decisions the history covers. */
  decisions?: number;
  /** `moves` tier: the sidecar file the move list was written to, relative to the artifact's directory. */
  movesFile?: string;
  /** `moves` tier: this game's index within that file. */
  movesIndex?: number;
  /** Unit B's own tier-specific detail; see `match/history.ts`. */
  detail?: Record<string, unknown>;
};

/**
 * One game. Identified by `(runId, groupIndex, permutationIndex)` - never by `game.id` (H4).
 *
 * A failed game is a full row, not a gap: `completed: false` plus `failure`, with seat identities
 * intact and `outcome` absent. Stopping a run at the first failure would throw away the
 * diagnostic value of the other N−1 games, including whether the failure is systematic or one
 * seed (H8, and `legality/run.ts` before it).
 */
export type MatchGameRecord = {
  groupIndex: number;
  permutationIndex: number;
  engineSeed: number;
  /** `seating[seat] = slot`. Repeated on the row because it is what makes the row self-describing. */
  seating: ReadonlyArray<number>;
  /** `true` iff the game reached `Phase.END` with no error escaping `runGame`. */
  completed: boolean;
  /** Present only when `completed` is false. */
  failure?: {errorClass: string; message: string};
  /** Generations to finish - a bullet 4 / AC-8 headline number, and a sanity signal on any run. */
  generation: number;
  /** Decision points the responders resolved. */
  decisions: number;
  /** FR-9 fallbacks where the responder *submitted* a move the Engine rejected (class A). */
  fallbacksAfterRejection: number;
  /** FR-9 fallbacks where the responder threw before producing a move (class B - nothing submitted). */
  fallbacksAfterThrow: number;
  seats: ReadonlyArray<MatchSeatRecord>;
  claimedMilestones: ReadonlyArray<MatchMilestoneRecord>;
  fundedAwards: ReadonlyArray<MatchAwardRecord>;
  /** Legality mode only (§4.6) - Unit B. */
  legality?: MatchLegalityCounters;
  /** `trace`/`moves` tiers only (§4.4) - Unit B. */
  history?: MatchGameHistory;
  /** **A declared timing field** (see `artifact.ts`): stripped before an R2/R6 comparison. */
  durationMs: number;
};

// ---------------------------------------------------------------------------------------------
// Run-level: header, summary, report
// ---------------------------------------------------------------------------------------------

/** The pairing policy actually used, recorded so an artifact says how its balance was achieved. */
export type PairingPolicy = 'full-permutation' | 'cyclic-rotation';

export type MatchPairingDescription = {
  policy: PairingPolicy;
  permutationsPerGroup: number;
  /** The seed schedule's constants, so an artifact can be re-derived without reading the source. */
  engineSeedBase: number;
  engineSeedStride: number;
  agentSeedBase: number;
  agentSeedStride: number;
  agentSeedSlotStride: number;
};

/**
 * Written once per run. Everything constant across the run lives here (§4.3).
 *
 * `provenance` reuses the determinism corpus's {@link CorpusHeader} verbatim - the same question
 * (which Engine pin, which Node, which gameplay-reaching env vars) with the same trap already
 * paid for once: `engineCommit` is the **Engine pin**, not repo HEAD, or the artifact stops
 * meaning anything on the next docs-only commit.
 */
export type MatchRunHeader = {
  /** Identifies the run; with `(groupIndex, permutationIndex)` it identifies a game (H4). */
  runId: string;
  harnessVersion: string;
  spec: ResolvedMatchSpec;
  pairing: MatchPairingDescription;
  historyTier: HistoryTier;
  /** True when the strict AC-1 submission accounting was installed (§4.6). */
  legalityMode: boolean;
  /**
   * How a group containing a failed game is treated in the balanced statistics (H8). Recorded
   * here, not only in a comment, because a reader of the artifact has to know whether the win
   * rates below are over balanced groups or over whatever completed.
   */
  incompleteGroupPolicy: 'excluded-from-balanced-statistics';
  provenance: CorpusHeader;
};

/**
 * Win/placement counts for one lineup slot, over **balanced groups only** (every game in the
 * group completed - see `incompleteGroupPolicy`). Criterion R1a is adjudicated on this.
 *
 * This is the runner's own self-test, not a rating: §1 puts win rates, Elo and significance
 * tests in bullet 3. The interval below exists because R1a is stated on it directly - "the
 * lineup-slot-A win rate has a 95% confidence interval containing 50%" - and for no other reason.
 */
export type MatchStanding = {
  games: number;
  /** Games in which this slot/seat was among the winners. A shared win counts as a win for each tied seat. */
  wins: number;
  /** Of those, how many were shared with another seat - so a tie-inflated win rate is visible, not hidden. */
  sharedWins: number;
  /** `placementCounts[i]` = games finished in placement `i + 1`. AC-5 reads this. */
  placementCounts: ReadonlyArray<number>;
  winRate: number;
  /** Wilson score interval at 95% (see `runner.ts`). */
  winRateCi95: {low: number; high: number};
};

export type MatchSlotStanding = MatchStanding & {slot: number; agent: string; agentVersion: string};
export type MatchSeatStanding = MatchStanding & {seat: number};

/** The declared timing fields, grouped so `stripTimingFields` can remove them surgically. */
export type MatchTiming = {
  wallClockMs: number;
  durationMsPerGame: Percentiles;
};

export type MatchSummary = {
  players: 2 | 3 | 4;
  groups: number;
  permutationsPerGroup: number;
  games: number;
  completed: number;
  failed: number;
  /** Groups in which every game completed - the denominator of `bySlot`/`bySeat` (H8). */
  balancedGroups: number;
  totalDecisions: number;
  fallbacksAfterRejection: number;
  fallbacksAfterThrow: number;
  decisionsPerGame: Percentiles;
  generationsPerGame: Percentiles;
  /** Criterion R1a: does the pairing balance the seats? Aggregated by lineup slot. */
  bySlot: ReadonlyArray<MatchSlotStanding>;
  /**
   * Criterion R1b: was the pairing *necessary*? Aggregated by seat over the same games. If seat
   * 0's advantage is not distinguishable from zero at this sample size, the write-up says so -
   * the pairing is still correct, but nothing may claim it corrected a bias it did not measure.
   */
  bySeat: ReadonlyArray<MatchSeatStanding>;
  /** Legality mode only (§4.6) - the run-level totals of {@link MatchLegalityCounters}. */
  legality?: MatchLegalityCounters;
  timing: MatchTiming;
};

/** Run-level instrumentation output. Unit B populates; absent on a plain `summary`-tier run. */
export type MatchInstrumentationReport = {
  /** Legality mode (§4.6): every distinct rejection cause observed, most frequent first. */
  causes?: ReadonlyArray<CauseTally>;
  /** Unit B's own run-level detail (e.g. the measured `moves`-tier bytes/game). */
  detail?: Record<string, unknown>;
};

export type MatchRunReport = {
  header: MatchRunHeader;
  summary: MatchSummary;
  games: ReadonlyArray<MatchGameRecord>;
  instrumentation?: MatchInstrumentationReport;
};
