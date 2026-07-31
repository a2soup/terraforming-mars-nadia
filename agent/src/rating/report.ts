import * as fs from 'fs';
import * as path from 'path';
import {AgentRandom} from '../core/rng';
import {defaultOutputDir} from '../match/artifact';
import {analysisRandom, bootstrapMean, bootstrapProportion} from './bootstrap';
import {
  IdentityGame,
  buildObservationSet,
  clustersOf,
  crossCheckMarginToNext,
  gameClustersOf,
  identityGames,
  nullFirstPlaceRate,
  stratify,
} from './observations';
import {marginDistribution, meanEstimate, proportionEstimate, thresholdTest} from './stats';
import {
  DEFAULT_ANALYSIS_SEED,
  DEFAULT_BOOTSTRAP_REPLICATES,
  Identity,
  IdentityReport,
  Interval,
  MarginReport,
  MeanEstimate,
  Observation,
  ObservationSet,
  ProportionEstimate,
  RATING_PIPELINE_VERSION,
  RatingReport,
  StratumReport,
  Unestimable,
  isUnestimable,
  unestimable,
} from './types';

/**
 * Report assembly and artifact I/O (Milestone 2, bullet 3, Unit A;
 * agent/docs/Milestone2_Bullet3_Prompts.md §3.7).
 *
 * **Reproducibility is the contract, and it includes the bootstrap.** Same inputs plus the same
 * `analysisSeed` produce a byte-identical report modulo the declared timing fields
 * (`types.ts`'s `RATING_TIMING_FIELDS`), which is criterion P8's second half. Three things make
 * that hold and each is easy to break:
 *
 * - **Every iteration order is sorted**, never insertion order. Identities, strata, clusters and
 *   runs are all sorted before anything consumes them, so pooling `a.json b.json` and
 *   `b.json a.json` cannot produce two different reports.
 * - **One RNG stream, consumed in that fixed order.** The analysis RNG is created once per report
 *   and threaded through; it is never re-seeded mid-report and never created per estimate. A
 *   per-estimate stream would be reproducible too but would silently couple the numbers to the
 *   order estimates happen to be written in the code.
 * - **Nothing reads the clock except the declared timing fields.** `analysisSeed` defaults to a
 *   constant, never to a clock and never to an unseeded draw (§3.7).
 *
 * The pattern is `match/artifact.ts`'s, deliberately reused rather than reinvented: that module's
 * doc explains why declaring the non-deterministic fields in code rather than in prose is what
 * makes the criterion mechanically checkable.
 */

export type RatingReportOptions = {
  analysisSeed?: number;
  bootstrapReplicates?: number;
  /** Skip the bootstrap cross-check. Faster, and strictly less evidence - P4b needs both intervals. */
  skipBootstrap?: boolean;
};

/**
 * The pipeline's top-level entry point: artifact paths in, one report out.
 *
 * Note what this function does **not** produce: an Elo, a ladder, or a promotion verdict. Ratings
 * are Unit B's (`bradleyTerry.ts`, `plackettLuce.ts`) and the gate is a win-rate test, never a
 * rating (§3.4) - every acceptance criterion in the SRS is a rate with a threshold, and not one of
 * them is stated as an Elo.
 */
export function buildRatingReport(paths: ReadonlyArray<string>, options: RatingReportOptions = {}): RatingReport {
  const started = Date.now();
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const bootstrapReplicates = options.bootstrapReplicates ?? DEFAULT_BOOTSTRAP_REPLICATES;
  const random = analysisRandom(analysisSeed);

  const set = buildObservationSet([...paths].sort());
  const bootstrap = options.skipBootstrap === true ?
    undefined :
    {replicates: bootstrapReplicates, random};

  const strata = set.playerCounts.map((players) => buildStratum(set, players, bootstrap));
  const first = set.sources[0];

  return {
    header: {
      pipelineVersion: RATING_PIPELINE_VERSION,
      analysisSeed,
      bootstrapReplicates: options.skipBootstrap === true ? 0 : bootstrapReplicates,
      inputs: set.sources,
      pooledProvenance: {
        engineCommit: first.engineCommit,
        harnessVersion: first.harnessVersion,
        seedDerivationVersion: first.seedDerivationVersion,
      },
      createdAt: new Date().toISOString(),
      nodeVersion: process.version,
    },
    exclusions: set.exclusions,
    sharedEngineSeeds: set.sharedEngineSeeds,
    strata,
    timing: {wallClockMs: Date.now() - started},
  };
}

/** The bootstrap's replicate count and the one analysis stream, or `undefined` to skip it. */
export type BootstrapContext = {replicates: number; random: AgentRandom} | undefined;

function buildStratum(set: ObservationSet, players: 2 | 3 | 4, bootstrap: BootstrapContext): StratumReport {
  const rows = stratify(set, players);
  const identities = [...new Set(rows.map((row) => row.identity))].sort();

  return {
    players,
    games: new Set(rows.map((row) => `${row.runId}#${row.groupIndex}#${row.permutationIndex}`)).size,
    groups: new Set(rows.map((row) => row.clusterId)).size,
    identities: identities.map((identity) => buildIdentityReport(rows, identity, players, bootstrap)),
    bySlot: slotKeys(rows).map(({runId, slot, identity}) => ({
      runId,
      slot,
      identity,
      winRate: withBootstrapProportion(
        clustersOf(rows.filter((row) => row.runId === runId && row.slot === slot)).map((cluster) => cluster.map((row) => row.win)),
        bootstrap),
    })),
    bySeat: [...Array(players).keys()].map((seat) => ({
      seat,
      winRate: withBootstrapProportion(
        clustersOf(rows.filter((row) => row.seat === seat)).map((cluster) => cluster.map((row) => row.win)),
        bootstrap),
    })),
    acFirstPlaceTests: identities.map((identity) => ({
      identity,
      test: firstPlaceTest(rows, identity, players),
    })),
  };
}

/** `(runId, slot)` pairs present, sorted - a slot index means nothing across two different lineups. */
function slotKeys(rows: ReadonlyArray<Observation>): ReadonlyArray<{runId: string; slot: number; identity: Identity}> {
  const keys = new Map<string, {runId: string; slot: number; identity: Identity}>();
  for (const row of rows) {
    keys.set(`${row.runId}#${row.slot}`, {runId: row.runId, slot: row.slot, identity: row.identity});
  }
  return [...keys.keys()].sort().map((key) => keys.get(key) as {runId: string; slot: number; identity: Identity});
}

function buildIdentityReport(
  rows: ReadonlyArray<Observation>,
  identity: Identity,
  players: 2 | 3 | 4,
  bootstrap: BootstrapContext,
): IdentityReport {
  const own = rows.filter((row) => row.identity === identity);
  const games = identityGames(rows, identity);
  const gameClusters = gameClustersOf(games);
  const seatClusters = clustersOf(own);

  const placementCounts = new Array<number>(players).fill(0);
  for (const game of games) {
    placementCounts[game.placement - 1]++;
  }

  const seatsPerGame = games.length === 0 ? 0 : own.length / games.length;

  return {
    identity,
    rows: own.length,
    games: games.length,
    seatsPerGame,
    // `seatsPerGame / players` (hazard H2). When the identity holds a *different* number of seats in
    // different pooled runs this is an average of two thresholds, which is a threshold nobody chose
    // - so `firstPlaceTest` below refuses outright in that case rather than testing against it.
    nullFirstPlaceRate: seatsPerGame / players,
    winRate: withBootstrapProportion(project(gameClusters, (game) => game.win), bootstrap),
    scoreRate: withBootstrapMean(project(gameClusters, (game) => game.score), bootstrap),
    placementCounts,
    margin: buildMarginReport(own, seatClusters, bootstrap),
    generations: withBootstrapMean(project(seatClusters, (row) => row.generation), bootstrap),
    terraformRating: withBootstrapMean(project(seatClusters, (row) => row.terraformRating), bootstrap),
  };
}

/**
 * The margin in all three forms §3.2 requires, plus the distribution.
 *
 * **The margin is never a gate** (hazard H8). It is not a monotone function of win probability - a
 * change that gains 20 VP in games already won moves the margin and not the win rate - so it is a
 * diagnostic for *how* games are won, and AC-7 is decided on the win rate. The temptation to gate
 * on the smoother statistic when the win rate is inconclusive is real, and the SRS's phrasing
 * ("average VP margin") does not warn against it.
 */
function buildMarginReport(
  rows: ReadonlyArray<Observation>,
  clusters: ReadonlyArray<ReadonlyArray<Observation>>,
  bootstrap: BootstrapContext,
): MarginReport {
  const wins = clusters.map((cluster) => cluster.filter((row) => row.win === 1)).filter((cluster) => cluster.length > 0);
  const losses = clusters.map((cluster) => cluster.filter((row) => row.win === 0)).filter((cluster) => cluster.length > 0);

  return {
    overall: withBootstrapMean(project(clusters, (row) => row.margin), bootstrap),
    ofVictory: withBootstrapMean(project(wins, (row) => row.margin), bootstrap),
    ofDefeat: withBootstrapMean(project(losses, (row) => row.margin), bootstrap),
    distribution: marginDistribution(rows.map((row) => row.margin)),
    comparableAcrossPlayerCounts: false,
    marginToNextDisagreements: crossCheckMarginToNext(rows),
  };
}

/**
 * AC-5's test, with **this identity's** null: `seats held / players`, not `1 / players` (H2).
 *
 * Returns unestimable rather than a number in the two cases where a threshold test would be
 * meaningless: a self-lineup, where the identity holds every seat and wins by construction (the
 * null is 1, so there is nothing above it to test), and a pooled set in which the identity holds
 * different seat counts in different runs.
 */
function firstPlaceTest(
  rows: ReadonlyArray<Observation>,
  identity: Identity,
  players: 2 | 3 | 4,
): ReturnType<typeof thresholdTest> {
  const own = rows.filter((row) => row.identity === identity);
  const nullRate = nullFirstPlaceRate(own);
  if (nullRate === undefined) {
    return unestimable(
      `${identity} holds different numbers of seats in different pooled runs, so it has no single ` +
      'AC-5 null (§3.6, hazard H2)');
  }
  if (nullRate >= 1) {
    return unestimable(
      `${identity} holds all ${players} seats, so its null first-place rate is 1 and there is ` +
      'nothing above it to test - a self-lineup carries no information about relative strength (§3.6)');
  }
  return thresholdTest(project(gameClustersOf(identityGames(rows, identity)), (game) => game.win), {
    threshold: nullRate,
    hypothesis: `${identity} takes first place more often than its ${players}p seat share of ${nullRate.toFixed(4)}`,
  });
}

// ---------------------------------------------------------------------------------------------
// Estimates with their bootstrap cross-check
// ---------------------------------------------------------------------------------------------

function project<T>(
  clusters: ReadonlyArray<ReadonlyArray<T>>,
  valueOf: (item: T) => number,
): ReadonlyArray<ReadonlyArray<number>> {
  return clusters.map((cluster) => cluster.map(valueOf));
}

/**
 * The primary interval plus the bootstrap cross-check, on a proportion. Criterion P4b compares the
 * two on every real corpus and requires agreement within 0.5 pp on both bounds - two methods that
 * disagree mean one is wrong, and finding that out on real corpora is cheap.
 */
function withBootstrapProportion(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  bootstrap: BootstrapContext,
): ProportionEstimate | Unestimable {
  const estimate = proportionEstimate(clusters);
  if (isUnestimable(estimate) || bootstrap === undefined) {
    return estimate;
  }
  const resampled = bootstrapProportion(clusters, bootstrap);
  return isUnestimable(resampled) ? estimate : {...estimate, bootstrapCi95: resampled.ci95};
}

function withBootstrapMean(
  clusters: ReadonlyArray<ReadonlyArray<number>>,
  bootstrap: BootstrapContext,
): MeanEstimate | Unestimable {
  const estimate = meanEstimate(clusters);
  if (isUnestimable(estimate) || bootstrap === undefined) {
    return estimate;
  }
  const resampled = bootstrapMean(clusters, bootstrap);
  return isUnestimable(resampled) ? estimate : {...estimate, bootstrapCi95: resampled.ci95};
}

// ---------------------------------------------------------------------------------------------
// The head-to-head comparison the gate is stated on (§3.4)
// ---------------------------------------------------------------------------------------------

export type HeadToHead = {
  challenger: Identity;
  incumbent: Identity;
  players: 2 | 3 | 4;
  /** Games in which both identities were seated. */
  games: number;
  groups: number;
  winRate: ProportionEstimate | Unestimable;
  /** `H0: challenger's win rate = threshold` against `H1: >`. The gate's test. */
  test: ReturnType<typeof thresholdTest>;
};

/**
 * The head-to-head win rate of one identity against another, over the games in which both were
 * seated - **the statistic every acceptance criterion and the promotion gate are stated on**
 * (§3.4).
 *
 * The rating never enters this. A pool rating is a *derived, model-dependent* quantity: it borrows
 * strength across the whole comparison graph, so a new agent's rating can move because some other
 * pair was played. That is useful for ranking a ladder and disqualifying for a gate.
 */
export function headToHead(
  set: ObservationSet,
  challenger: Identity,
  incumbent: Identity,
  players: 2 | 3 | 4,
  options: {threshold?: number; bootstrap?: BootstrapContext} = {},
): HeadToHead | Unestimable {
  const threshold = options.threshold ?? 0.5;
  // A self-match is 50/50 by symmetry and carries no information about relative strength (§3.6).
  // Refused rather than answered, because the answer it *would* give is spectacular and wrong: for
  // a self-lineup every seat belongs to the challenger, so its game-level win rate is 100% by
  // construction and the gate reports "PASS - beats itself with significance, p = 5e-111". Found by
  // running the gate against `match_runner_validation.json`, which is a self-play corpus.
  if (challenger === incumbent) {
    return unestimable(
      `${challenger} cannot be gated against itself: a self-match is 50/50 by symmetry and carries ` +
      'no information about relative strength (§3.6). In a self-lineup the challenger holds every ' +
      'seat, so its game-level win rate is 100% and any test of it is meaningless.');
  }

  const rows = stratify(set, players).filter((row) =>
    row.identity === challenger && row.opponents.includes(incumbent));
  if (rows.length === 0) {
    return unestimable(
      `no ${players}p games in which ${challenger} was seated against ${incumbent}; ` +
      'the comparison graph is not connected here (§3.4)');
  }
  const games = identityGames(rows, challenger);
  const clusters = gameClustersOf(games);
  const values = project(clusters, (game: IdentityGame) => game.win);

  return {
    challenger,
    incumbent,
    players,
    // Games, not rows: an identity holding two seats contributes two rows to one game (H2), and
    // reporting the row count would inflate the sample the gate claims to have run on.
    games: games.length,
    groups: clusters.length,
    winRate: withBootstrapProportion(values, options.bootstrap),
    test: thresholdTest(values, {
      threshold,
      hypothesis: `${challenger} beats ${incumbent} at ${players}p more often than ${(threshold * 100).toFixed(1)}%`,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Artifact I/O
// ---------------------------------------------------------------------------------------------

/**
 * Where a rating report writes by default. `agent/docs/data/`, reusing `match/artifact.ts`'s
 * repo-root walk rather than a second copy of it - that function's doc explains why a fixed number
 * of `..` is wrong under the compiled build, which is the build every run for data uses (H10).
 */
export function defaultRatingOutputDir(): string {
  return defaultOutputDir('summary');
}

/** Resolves `--out`: a bare filename lands in {@link defaultRatingOutputDir}, a path is respected. */
export function resolveRatingOutputPath(out: string): string {
  return out.includes(path.sep) || out.includes('/') ? path.resolve(out) : path.join(defaultRatingOutputDir(), out);
}

export function saveRatingReport(filePath: string, report: RatingReport): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
}

export function loadRatingReport(filePath: string): RatingReport {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RatingReport;
}

/** How far apart two intervals are on their worst bound - P4b's statistic, re-exported for the CLI. */
export function intervalGap(a: Interval, b: Interval): number {
  return Math.max(Math.abs(a.low - b.low), Math.abs(a.high - b.high));
}
