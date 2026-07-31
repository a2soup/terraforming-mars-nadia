import {CorpusHeader} from '../determinism/corpus';

/**
 * The rating pipeline's types (SRS FR-14; Milestone 2, bullet 3, Unit A; the design is settled in
 * agent/docs/Milestone2_Bullet3_Prompts.md §3).
 *
 * **What makes this module different from every module before it.** `match/`, `legality/` and
 * `determinism/` build things that either work or crash. This one always produces a number, and
 * its failure mode is a number that is wrong in a direction nobody can see. There is no game you
 * can run to find out whether a confidence interval is a 95% interval, so two conventions run
 * through every type here and must survive any later edit:
 *
 * - **The unit of analysis is the pairing group, never the game** (§3.1). Games in a group share
 *   an Engine seed - the same board, the same shuffles, the same deal - so they are not
 *   independent draws. Measured design effects on the committed self-play corpora are 1.033 (2p),
 *   1.252 (3p) and 1.293 (4p) for the win rate, and 1.043 / 1.516 / 1.184 for the VP margin: small,
 *   real, and anti-conservative in every case. Every interval and every test in this pipeline
 *   clusters on {@link Observation.clusterId}.
 * - **An unestimable quantity is {@link Unestimable}, never `NaN`** (hazard H9). `wilson95(0, 0)`
 *   returns `{low: NaN, high: NaN}` and `standing`'s `winRate` is `NaN` on zero games
 *   (`match/runner.ts:563`); either one reaches a report as `null` through `JSON.stringify` and is
 *   then indistinguishable from a field that was never written. A stratum that cannot be estimated
 *   says so, with the reason, in the output.
 *
 * **The report is reproducible, and that includes the bootstrap** (§3.7). Same inputs plus the same
 * {@link RatingReportHeader.analysisSeed} produce a byte-identical report modulo
 * {@link RATING_TIMING_FIELDS}, exactly as `match/artifact.ts` does it for the runner. The analysis
 * seed is neither an Engine seed nor an Agent seed - it touches no game and influences no move -
 * so it is *not* a third seed in `core/rng.ts` (`agent/CLAUDE.md` §6 forbids that); it is a
 * parameter of `rating/`, consumed through `createAgentRandom` and recorded in every report.
 */

/** Bumped when a change to these types would make an old rating report misread by new code. */
export const RATING_PIPELINE_VERSION = '1';

/**
 * The default analysis seed (§2.6, §3.7). **A constant, never a clock and never an unseeded draw** -
 * a bootstrap interval that changes between two runs of the same command is not evidence, and the
 * promotion gate's verdict has to be repeatable by someone who was not in the room.
 *
 * Chosen clear of every seed space the project already plays in (`match/pairing.ts` tabulates
 * them) purely so a reader never has to wonder whether it collides with one. It could not: this
 * number never reaches `createGame`.
 */
export const DEFAULT_ANALYSIS_SEED = 41_000_003;

/** Bootstrap replicates when the caller does not say (§3.1's cross-check interval). */
export const DEFAULT_BOOTSTRAP_REPLICATES = 2_000;

// ---------------------------------------------------------------------------------------------
// The observation model
// ---------------------------------------------------------------------------------------------

/**
 * `name@version` - the key **everything** in this pipeline aggregates on (§3.6, hazard H2).
 *
 * Never the lineup slot. `summary.bySlot` is a slot statistic, and two slots routinely hold the
 * same identity: every self-play run does, and so does this bullet's 3p corpus
 * (`greedy-1ply,greedy-1ply,random-legal`), which exists precisely because it is the only real
 * data that exercises this. An identity holding 2 of 3 seats wins 2/3 of games under the null, not
 * 1/3, so a slot-keyed AC-5 comparison would silently measure it against the wrong threshold - and
 * produce a plausible number either way.
 */
export type Identity = string;

/**
 * One (game, seat) row: the atom of every statistic in this pipeline.
 *
 * A game contributes one row per seat, so a 3p game contributes three - and if one identity holds
 * two of those seats, two of the three rows carry that identity. That is the correct behaviour
 * ({@link Identity}) and it is why {@link seatsHeld} is on the row rather than derived later.
 */
export type Observation = {
  /**
   * `${runId}#${groupIndex}` - the cluster, and the unit of analysis (§3.1). Includes the run id
   * because two artifacts can legitimately carry the same group index over different lineups, and
   * those are different clusters. (Two artifacts carrying the same group index over the *same*
   * matchup are a double count, and `observations.ts`'s pooling guards refuse them before this point.)
   */
  clusterId: string;
  runId: string;
  groupIndex: number;
  permutationIndex: number;
  players: 2 | 3 | 4;
  /** Shared by every game in the cluster. This is what makes the cluster a cluster. */
  engineSeed: number;
  seat: number;
  /** The lineup slot. Recorded for the P1 cross-check against `summary.bySlot`; never aggregated on. */
  slot: number;
  identity: Identity;
  /** 1 iff this seat was among the winners - the runner's own definition, and AC-2/AC-3/AC-5's (§3.2). */
  win: 0 | 1;
  /** `1 / tiedWinners` for a winner, else 0. The Bradley-Terry convention (§3.2). */
  score: number;
  /** Seats tied at placement 1 in this game. 1 for an outright win, 0 for a loss. */
  tiedWinners: number;
  /** 1-based, ties sharing the lower number - `match/ranking.ts`'s rule, copied verbatim from the record. */
  placement: number;
  /**
   * `own VP - best other seat's VP`, computed from `victoryPoints` and **not** from the record's
   * `marginToNext` (§2.1). `marginToNext` is the gap to the head of the next *placement group*, so
   * it is `undefined` at the last placement and exactly 0 whenever the placement was decided on
   * megacredits - honest, and documented as such in `ranking.ts`, but it puts a point mass at 0
   * that has nothing to do with how close the game was. 1.6-3.0% of games are megacredit-decided
   * VP ties, so that mass is not negligible. `marginToNext` is carried below only as a cross-check.
   */
  margin: number;
  /** The record's own `marginToNext`, for the §2.1 cross-check and for nothing else. */
  marginToNext: number | undefined;
  victoryPoints: number;
  megaCredits: number;
  terraformRating: number;
  generation: number;
  /** Every other seat's identity, in seat order. Feeds Unit B's comparison graph. */
  opponents: ReadonlyArray<Identity>;
  /**
   * How many of this game's seats this identity held (hazard H2). 1 in a lineup of distinct
   * agents; 2 for `greedy-1ply` in this bullet's 3p corpus; `players` in any self-play run. The
   * AC-5-style null first-place rate for this identity is `seatsHeld / players`.
   */
  seatsHeld: number;
};

/** One pooled input artifact: what it was, and the exact bytes it was (§3.6). */
export type ArtifactSource = {
  /** As given on the command line, so an error message names something the operator typed. */
  path: string;
  /** SHA-256 of the whole file, so any rating claim traces back to the bytes it came from. */
  sha256: string;
  /** Where inside the file the report was found: `''` at top level, `main.runs[0]` when nested. */
  location: string;
  runId: string;
  harnessVersion: string;
  players: 2 | 3 | 4;
  lineup: ReadonlyArray<Identity>;
  startGroup: number;
  groups: number;
  games: number;
  /** Groups every permutation of which completed - the denominator this pipeline actually uses. */
  balancedGroups: number;
  /** Groups dropped by the balanced-group filter (§3.1) - never silent. */
  excludedGroups: number;
  /** Games in those groups. Not "failed games": a completed game in a broken group is here too. */
  excludedGames: number;
  engineCommit: string;
  seedDerivationVersion: number;
};

/**
 * The pooled observation set: rows, plus everything needed to say where they came from.
 *
 * **Spans player counts deliberately.** §3.5 forbids pooling 2p, 3p and 4p games into one latent
 * strength - an agent strong at 2p can be weak at 3p - so the *ratings* are per player count. The
 * observation set is not; it is the raw material, and stratifying it is the consumer's job
 * (`observations.ts`'s `stratify`). Keeping one set means the pooling guards run once over everything.
 */
export type ObservationSet = {
  rows: ReadonlyArray<Observation>;
  /** Sorted, so a report's identity order does not depend on artifact order (§3.7). */
  identities: ReadonlyArray<Identity>;
  /** Player counts present, ascending. */
  playerCounts: ReadonlyArray<2 | 3 | 4>;
  sources: ReadonlyArray<ArtifactSource>;
  /** What the balanced-group filter removed, in total (§3.1). */
  exclusions: {
    /** Groups in which some permutation was missing or some game failed. */
    unbalancedGroups: number;
    /** Games in those groups. Not "failed games" - a completed game in a broken group is here too. */
    excludedGames: number;
  };
  /**
   * Engine seeds that appear in more than one artifact under *different* matchups. Not an error -
   * those are different games - but they are correlated across artifacts in a way the clustering
   * cannot see, because they land in different clusters. Reported so a later reader can judge it.
   */
  sharedEngineSeeds: ReadonlyArray<{engineSeed: number; players: 2 | 3 | 4; runIds: ReadonlyArray<string>}>;
};

// ---------------------------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------------------------

/**
 * A quantity that could not be estimated, and why (hazard H9). **Never `NaN`.**
 *
 * The distinction this type exists to preserve: `NaN` serializes to `null`, at which point "we had
 * no games for this identity at 4p" and "this field was added after the artifact was written" look
 * identical to every reader and every downstream tool. 25 groups at 4p is a thin enough sample
 * that this path is expected to fire, not hypothetical (Appendix prediction 8).
 */
export type Unestimable = {estimable: false; reason: string};

export type Interval = {low: number; high: number};

export function unestimable(reason: string): Unestimable {
  return {estimable: false, reason};
}

/**
 * The narrowing guard for every `T | Unestimable` in this pipeline.
 *
 * A guard rather than an `estimable: true` discriminant on every result type: the discriminant
 * would be redundant noise in the artifact (a `ClusterDesign` nested inside an estimate that
 * already declares itself estimable), and the guard narrows the negative branch just as well.
 */
export function isUnestimable<T>(value: T | Unestimable): value is Unestimable {
  return (value as Unestimable).estimable === false;
}

/**
 * The clustering, reported alongside every estimate so a reader can see how much the correction
 * moved and judge it (§3.1). Hazard H1's numbers live here.
 */
export type ClusterDesign = {
  /** Rows contributing. */
  rows: number;
  /** Clusters contributing - the *real* sample size, and the one that matters. */
  groups: number;
  /** `rows / groups`. Equal to the permutation count in a single balanced run. */
  meanClusterSize: number;
  /**
   * `Var_cluster-robust / Var_binomial`. **Not floored at 1** (§3.1): a blocked design legitimately
   * produces `deff < 1`, and flooring it without evidence hides that. Criterion P2's coverage at
   * ICC = 0 is what decides whether flooring is needed; see `stats.ts`.
   */
  designEffect: number;
  /** `(deff - 1) / (m̄ - 1)`, the intra-cluster correlation implied by the design effect. */
  icc: number;
  /** `rows / deff`. The sample size the interval is actually computed on. */
  effectiveN: number;
  /**
   * Present only when the design effect could **not** be estimated from the data and a stated
   * fallback was used instead - the degenerate case where every row is a win (or every row a
   * loss), which leaves the intra-cluster correlation unidentified. `stats.ts` explains which end
   * of the identified range the fallback takes and why. A reader who sees this field is looking at
   * an assumption, not a measurement.
   */
  note?: string;
};

/** A proportion with its cluster-corrected interval and, when computed, the bootstrap cross-check. */
export type ProportionEstimate = {
  estimable: true;
  successes: number;
  trials: number;
  rate: number;
  design: ClusterDesign;
  /**
   * **Primary interval**: Wilson on the effective sample size `n / deff` (§3.1). Wilson rather than
   * a group-mean Wald or t interval because at 99.2% - which is exactly where this project's
   * baselines live - the latter runs off the end of [0, 1].
   */
  ci95: Interval;
  /** **Cross-check**: the seeded cluster bootstrap, percentile method. Criterion P4b compares them. */
  bootstrapCi95?: Interval;
};

/** A continuous quantity: group-mean t interval plus the same bootstrap cross-check (§3.1). */
export type MeanEstimate = {
  estimable: true;
  n: number;
  mean: number;
  /** Per-row standard deviation, not the standard error - the margin's 26 VP spread is the story. */
  sd: number;
  design: ClusterDesign;
  /** Group-mean t interval on `groups - 1` degrees of freedom. */
  ci95: Interval;
  bootstrapCi95?: Interval;
};

/**
 * A one-sided test of `p >= threshold`, which is the shape **every** acceptance criterion in the
 * SRS takes: AC-2 (>= 65% vs the tuned heuristic), AC-3 (>= 90% vs random, >= 80% vs greedy),
 * AC-5 (first place above 1/N) and AC-7's promotion gate. Not one criterion is stated as an Elo
 * (§3.4), which is why the rating never enters a gate.
 */
export type ThresholdTest = {
  /** What was tested, in words, so a verdict is readable without the code. */
  hypothesis: string;
  threshold: number;
  observed: number;
  /** The cluster-corrected z statistic; see `stats.ts` for the null variance it uses. */
  z: number;
  pValue: number;
  alpha: number;
  rejected: boolean;
  design: ClusterDesign;
};

/** The margin, in all three forms §3.2 requires, plus the distribution a mean alone hides. */
export type MarginReport = {
  /**
   * The FR-14 headline. **Not comparable across player counts** (§2.3): at 3p and 4p the margin is
   * measured against the *maximum* of N-1 opponents, which is above you most of the time, so a
   * perfectly average player scores about -6.8 VP. The flag below carries that warning into the
   * artifact rather than leaving it in a document.
   */
  overall: MeanEstimate | Unestimable;
  /** Conditional on winning. */
  ofVictory: MeanEstimate | Unestimable;
  /** Conditional on losing. */
  ofDefeat: MeanEstimate | Unestimable;
  /** min / p5 / p50 / p95 / max. A mean margin over a 26 VP standard deviation says almost nothing alone. */
  distribution: MarginDistribution | Unestimable;
  /** Always `false`, and present so the caveat is in the data rather than only in the prose. */
  comparableAcrossPlayerCounts: false;
  /**
   * Rows where the record's own `marginToNext` disagrees with the computed margin in a way §2.1
   * does *not* explain (i.e. not the last placement and not a megacredit-decided tie). Expected 0;
   * anything else is a defect in one of the two and must be named, not tolerated.
   */
  marginToNextDisagreements: number;
};

export type MarginDistribution = {min: number; p5: number; p50: number; p95: number; max: number};

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

/**
 * Per identity, within one player count (§3.5 - strata never pool across player counts).
 *
 * **Two aggregation levels live in this type, and the difference is hazard H2.** Whenever an
 * identity holds more than one seat in a lineup - which every self-play run does, and which this
 * bullet's 3p corpus does on purpose - "per game" and "per seat" stop being the same thing:
 *
 * - `winRate`, `scoreRate` and `placementCounts` are **per game**. That is the literal text of the
 *   criteria ("the fraction of games in which the identity was among the winners", §3.2) and it is
 *   what makes `seatsHeld / players` the right null: an identity in 2 of 3 seats takes first place
 *   two thirds of the time under the null, not one third.
 * - `margin`, `generations` and `terraformRating` are **per seat**, because §3.2 defines the margin
 *   as `own VP - best other seat's VP`, which is a seat's quantity and has no single game-level
 *   value when one identity holds several seats.
 *
 * Getting this backwards produces a plausible number either way, which is why it is written here
 * rather than left in the code.
 */
export type IdentityReport = {
  identity: Identity;
  /** Rows: (game, seat) pairs, so an identity holding two seats contributes two per game. */
  rows: number;
  games: number;
  /** Mean seats held per game (hazard H2). 1.0 in a lineup of distinct agents. */
  seatsPerGame: number;
  /** `seatsPerGame / players` - AC-5's null for *this* identity, not `1 / players` (H2). */
  nullFirstPlaceRate: number;
  /**
   * The fraction of **games** in which this identity was among the winners. **The number every AC
   * threshold is adjudicated on** (§3.2), because that is the literal text of the criteria.
   */
  winRate: ProportionEstimate | Unestimable;
  /**
   * The mean {@link Observation.score}: a shared win counts `1 / tiedWinners`. Reported beside
   * `winRate`, always, so a tie-inflated figure cannot hide. Never above `winRate`. The two differ
   * only if ties appear - at which point the difference is itself the finding, since 0 shared wins
   * have ever been observed in 1,700 committed games (hazard H4).
   */
  scoreRate: MeanEstimate | Unestimable;
  /** `placementCounts[i]` = **games** whose best seat for this identity finished in placement `i + 1`. */
  placementCounts: ReadonlyArray<number>;
  /** **Per seat**, not per game - see this type's doc. */
  margin: MarginReport;
  generations: MeanEstimate | Unestimable;
  terraformRating: MeanEstimate | Unestimable;
};

/** One player count's slice of the pooled corpus. */
export type StratumReport = {
  players: 2 | 3 | 4;
  games: number;
  groups: number;
  /** Sorted by identity, so report order never depends on artifact order (§3.7). */
  identities: ReadonlyArray<IdentityReport>;
  /**
   * By lineup slot within each run - the R1a question, restated cluster-correctly. Kept per run
   * because a slot index means nothing across two different lineups, and kept at all because a
   * self-play corpus has exactly one identity, whose game-level win rate is 100% by construction:
   * without this, the three committed self-play runs would report nothing informative.
   */
  bySlot: ReadonlyArray<{runId: string; slot: number; identity: Identity; winRate: ProportionEstimate | Unestimable}>;
  /** By seat, over the same rows - the R1b question, restated cluster-correctly. */
  bySeat: ReadonlyArray<{seat: number; winRate: ProportionEstimate | Unestimable}>;
  /** AC-5's test for every identity: is the first-place rate above `seatsHeld / players`? */
  acFirstPlaceTests: ReadonlyArray<{identity: Identity; test: ThresholdTest | Unestimable}>;
};

export type RatingReportHeader = {
  pipelineVersion: string;
  /** §2.6, §3.7. Recorded in every report; the whole reproducibility claim rests on it. */
  analysisSeed: number;
  bootstrapReplicates: number;
  inputs: ReadonlyArray<ArtifactSource>;
  /**
   * The provenance the inputs agreed on. `engineCommit`, `harnessVersion` and
   * `seedDerivationVersion` are *required* equal across every pooled artifact (§3.6, hazard H6);
   * this records what they agreed on. The remaining {@link CorpusHeader} fields come from the
   * first input and are provenance only, exactly as `determinism/corpus.ts` treats them.
   */
  pooledProvenance: {engineCommit: string; harnessVersion: string; seedDerivationVersion: number};
  /** Provenance of the *analysis*, not of the games. A declared timing field. */
  createdAt: string;
  nodeVersion: string;
};

export type RatingReport = {
  header: RatingReportHeader;
  exclusions: ObservationSet['exclusions'];
  sharedEngineSeeds: ObservationSet['sharedEngineSeeds'];
  strata: ReadonlyArray<StratumReport>;
  /** Wall-clock of the analysis. A declared timing field; never a claim about anything (H10). */
  timing: {wallClockMs: number};
};

/**
 * Fields whose values legitimately differ between two runs of the same analysis. Everything *not*
 * on this list is required to be identical given the same inputs and the same `analysisSeed`
 * (§3.7, criterion P8).
 *
 * Deliberately the same mechanism as `match/artifact.ts`'s `MATCH_TIMING_FIELDS` rather than
 * a second one: that module's doc explains why declaring these in code rather than in prose is
 * what makes the reproducibility criterion mechanically checkable instead of a matter of
 * judgement.
 */
export const RATING_TIMING_FIELDS: ReadonlyArray<string> = [
  'header.createdAt',
  'header.nodeVersion',
  'timing',
];

/** The report with {@link RATING_TIMING_FIELDS} removed, ready for a P8 comparison. */
export function stripRatingTimingFields(report: RatingReport): unknown {
  const {createdAt: _createdAt, nodeVersion: _nodeVersion, ...header} = report.header;
  const {timing: _timing, ...rest} = report;
  return {...rest, header};
}

/** True when two reports agree on everything except {@link RATING_TIMING_FIELDS}. */
export function ratingReportsMatch(a: RatingReport, b: RatingReport): boolean {
  return JSON.stringify(stripRatingTimingFields(a)) === JSON.stringify(stripRatingTimingFields(b));
}

// ---------------------------------------------------------------------------------------------
// The seed-block ledger interface (§3.8)
// ---------------------------------------------------------------------------------------------

/**
 * The interface to Unit B's ladder, declared here so Unit A's `gate` subcommand is not blocked on
 * Unit B (Unit A prompt §4). `rating/ladder.ts` implements it; `docs/data/ladder.json` is the
 * persisted form; **nothing in Unit A's files writes it**.
 *
 * The reason the gate consults a ledger at all is hazard H7, and it is the single largest
 * methodological risk in the milestones ahead: Milestone 3 tunes evaluation weights *against
 * harness win rate*, and if the seeds used to tune are the seeds used to certify, the certification
 * measures the tuning. That is unfixable after the fact and free to prevent today.
 */
export type SeedBlockAllocation = {
  block: SeedBlockName;
  /** Inclusive group-index range. */
  from: number;
  to: number;
  /** What spent it: a gate name, a run id, a bullet. */
  spentBy: string;
  /** ISO date the allocation was recorded - *before* the run, which is the whole point. */
  recordedAt: string;
  /** The sample size pre-registered for the run that spends this range (criterion P8). */
  preregisteredGames?: number;
};

export type LadderLedger = {
  allocations: ReadonlyArray<SeedBlockAllocation>;
};

/** The blocks of §3.8. Decided now because seed discipline cannot be retrofitted. */
export type SeedBlockName = 'development' | 'gate' | 'regression';

export const SEED_BLOCKS: Readonly<Record<SeedBlockName, {from: number; to: number; use: string}>> = {
  /** Tuning, debugging, smoke runs, anything iterated on. Bullets 1-3's published runs live here. */
  development: {from: 0, to: 1_999, use: 'tuning, debugging, smoke runs, anything iterated on'},
  /** Promotion gates only. Each gate gets a fresh, disjoint sub-range, recorded *before* the run. */
  gate: {from: 2_000, to: 5_999, use: 'promotion gates only, one disjoint sub-range per gate'},
  /** Bullet 5's fixed reference games. Never used for a strength estimate. */
  regression: {from: 6_000, to: 6_999, use: "bullet 5's fixed reference games; never a strength estimate"},
};

export type {CorpusHeader};
