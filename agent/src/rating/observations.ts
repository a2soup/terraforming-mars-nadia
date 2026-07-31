import * as crypto from 'crypto';
import * as fs from 'fs';
import {MatchGameRecord, MatchRunReport} from '../match/types';
import {ArtifactSource, Identity, Observation, ObservationSet} from './types';

/**
 * Match artifacts in, identity-keyed and group-clustered observations out (Milestone 2, bullet 3,
 * Unit A; agent/docs/Milestone2_Bullet3_Prompts.md §3.1, §3.2, §3.6).
 *
 * This module is the whole of the pipeline's contact with the runner's record schema, and it makes
 * four decisions that everything downstream inherits. Each one has a failure mode that produces a
 * *working pipeline reporting a confidently wrong number*, which is why each is written down here
 * rather than left to the reader of the code:
 *
 * 1. **The cluster is `(runId, groupIndex)`, not the game and not the run** (§3.1). Games in a
 *    pairing group share an Engine seed, so they share the board, the shuffles and the deal. The
 *    measured design effect on the committed self-play corpora is 1.033 at 2p, 1.252 at 3p and
 *    1.293 at 4p - small, but always in the anti-conservative direction and largest exactly where
 *    the acceptance criteria are weakest.
 * 2. **Aggregation is by `name@version`, never by lineup slot** (§3.6, hazard H2). See
 *    {@link Identity}. This bullet's 3p corpus seats `greedy-1ply` twice on purpose, because that
 *    is the only real data in the project that exercises the difference.
 * 3. **The margin is computed from `victoryPoints`, not read from `marginToNext`** (§2.1). The
 *    recorded field is the gap to the head of the *next placement group*: `undefined` at the last
 *    placement, and exactly 0 whenever the placement was decided on megacredits. That is honest and
 *    `ranking.ts` documents it, but it means the field carries a point mass at 0 that has nothing
 *    to do with how close the game was - and 1.6-3.0% of games are megacredit-decided VP ties.
 *    {@link Observation.marginToNext} is carried anyway, and {@link crossCheckMarginToNext}
 *    verifies that the two agree wherever §2.1 says they must.
 * 4. **Balanced groups only** (§3.1), matching the runner's own `incompleteGroupPolicy`. A partial
 *    group is a group in which some identity did not sit in every seat, so including it
 *    reintroduces exactly the seat bias the pairing exists to remove. The exclusions are counted
 *    and reported, never silent.
 *
 * **On pooling.** Two ways a list of artifacts silently produces a wrong number, both refused with
 * an error naming the offending files: double counting (hazard H5) and provenance mixing (H6). See
 * {@link assertPoolable} - and read the note there on why the collision key includes the seated
 * identities, which is a deliberate refinement of §3.6's literal wording.
 */

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

/** One `MatchRunReport` found inside one file, with the bytes it came from. */
export type LoadedArtifact = {
  path: string;
  sha256: string;
  /** `''` for a report at the top level, `main.runs[0]` for one nested in a validation artifact. */
  location: string;
  report: MatchRunReport;
};

/**
 * Reads a file and returns every `MatchRunReport` in it.
 *
 * **Both shapes are accepted, deliberately.** `docs/data/match_runner_validation.json` nests three
 * full reports under `main.runs[]`, while `npm run match --out` writes one at the top level. A
 * loader that handled only the second would exclude the only committed per-game data in the
 * project from its own validation (§2.2), so this walks the tree.
 *
 * A file with no report in it is an error rather than an empty result, and the message says the
 * likely reason: `docs/data/baselines_validation.json` carries **summaries only, no per-game
 * rows** (§2.2), so the 99.2% headline it reports cannot be re-analysed from what is committed.
 * That is the whole reason this bullet generates its own corpus.
 */
export function loadRatingInput(filePath: string): ReadonlyArray<LoadedArtifact> {
  const bytes = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;

  const found: Array<LoadedArtifact> = [];
  collectReports(parsed, '', (report, location) => found.push({path: filePath, sha256, location, report}));

  if (found.length === 0) {
    throw new Error(
      `${filePath} contains no match run report (a header + summary + per-game 'games' array). ` +
      'A summaries-only validation artifact - docs/data/baselines_validation.json is one - cannot ' +
      'be re-analysed: it has no per-game rows (Milestone2_Bullet3_Prompts.md §2.2).');
  }
  return found;
}

/** Walks the parsed JSON, reporting every subtree that is a `MatchRunReport` and not descending into one. */
function collectReports(node: unknown, location: string, emit: (report: MatchRunReport, location: string) => void): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (looksLikeRunReport(node)) {
    emit(node as unknown as MatchRunReport, location);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectReports(item, `${location}[${index}]`, emit));
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    collectReports(value, location === '' ? key : `${location}.${key}`, emit);
  }
}

function looksLikeRunReport(node: object): boolean {
  const candidate = node as Partial<MatchRunReport>;
  return candidate.header !== undefined &&
    typeof candidate.header === 'object' &&
    (candidate.header as {spec?: unknown}).spec !== undefined &&
    (candidate.header as {provenance?: unknown}).provenance !== undefined &&
    candidate.summary !== undefined &&
    Array.isArray(candidate.games);
}

// ---------------------------------------------------------------------------------------------
// Pooling guards (§3.6)
// ---------------------------------------------------------------------------------------------

/** `name@version`, the aggregation key. Kept local so `rating/` never depends on the registry. */
export function identityOf(seat: {agent: string; agentVersion: string}): Identity {
  return `${seat.agent}@${seat.agentVersion}`;
}

/**
 * Refuses the two ways a pooled analysis silently produces a wrong number (§3.6). Both throw with
 * a message **naming the offending files**, because "the numbers looked odd" is not a diagnosis.
 *
 * **Provenance mixing (hazard H6).** `engineCommit`, `harnessVersion` and `seedDerivationVersion`
 * must be identical across every pooled artifact. A pre-fix and a post-fix artifact pooled together
 * is the Milestone-1 `initialCards` lesson repeating as a statistic - and the ladder, which
 * accumulates over months, is where that would happen.
 *
 * **Double counting (hazard H5).** `--start-group` exists so a later run can extend an earlier one;
 * two artifacts with overlapping ranges over the same matchup are either a re-run or an overlap,
 * and pooling them counts the same games twice, in the precise direction of overconfidence. Note
 * that the check is on the *games*, not on run ids: a re-run under a different `--run-id` is the
 * case that matters and the one an id-based check would miss.
 *
 * **The collision key is `(players, engineSeed, seating, identities-by-seat)`, which is a
 * deliberate refinement of §3.6's literal `(players, engineSeed, seating)`.** The literal key is
 * wrong in a way that matters: it would refuse to pool a `greedy-vs-random` run with a
 * `heuristic-vs-random` run played over the same group block, which are entirely different games
 * and exactly the pooling the ladder needs in order to keep the comparison graph connected (§3.4).
 * §3.6's *prose* states the condition correctly - "the same `(players, lineup)` and overlapping
 * group ranges" - and adding the seated identities to the key is what implements that prose.
 * Seating stays in the key because without it a self-play run collides with itself: its two
 * permutations have identical identities by construction.
 *
 * What the refinement gives up is caught separately and reported rather than refused: see
 * {@link findSharedEngineSeeds}.
 */
export function assertPoolable(artifacts: ReadonlyArray<LoadedArtifact>): void {
  if (artifacts.length === 0) {
    throw new Error('no artifacts to pool');
  }

  const describe = (artifact: LoadedArtifact): string =>
    `${artifact.path}${artifact.location === '' ? '' : ` (${artifact.location})`} [${artifact.report.header.runId}]`;

  const reference = artifacts[0];
  for (const field of ['engineCommit', 'seedDerivationVersion'] as const) {
    const expected = reference.report.header.provenance[field];
    const offender = artifacts.find((artifact) => artifact.report.header.provenance[field] !== expected);
    if (offender !== undefined) {
      throw new Error(
        `cannot pool artifacts with different provenance.${field}: ` +
        `${describe(reference)} has ${JSON.stringify(expected)}, ` +
        `${describe(offender)} has ${JSON.stringify(offender.report.header.provenance[field])}. ` +
        'Pooling across Engine pins or seed-derivation versions is hazard H6 (§3.6).');
    }
  }
  const expectedHarness = reference.report.header.harnessVersion;
  const harnessOffender = artifacts.find((artifact) => artifact.report.header.harnessVersion !== expectedHarness);
  if (harnessOffender !== undefined) {
    throw new Error(
      `cannot pool artifacts with different harnessVersion: ${describe(reference)} has '${expectedHarness}', ` +
      `${describe(harnessOffender)} has '${harnessOffender.report.header.harnessVersion}'. ` +
      'The record schema changed between them, so the rows do not mean the same thing (§3.6).');
  }

  const seen = new Map<string, LoadedArtifact>();
  for (const artifact of artifacts) {
    for (const game of artifact.report.games) {
      const key = gameCollisionKey(artifact.report, game);
      const previous = seen.get(key);
      if (previous !== undefined) {
        throw new Error(
          `cannot pool artifacts that contain the same game twice: ${describe(previous)} and ` +
          `${describe(artifact)} both play ${artifact.report.summary.players}p group ` +
          `${game.groupIndex} (engineSeed ${game.engineSeed}, seating [${game.seating.join(',')}]) ` +
          `with the same identities. Pooling them would count those games twice (hazard H5, §3.6).`);
      }
      seen.set(key, artifact);
    }
  }
}

function gameCollisionKey(report: MatchRunReport, game: MatchGameRecord): string {
  const identities = [...game.seats]
    .sort((a, b) => a.seat - b.seat)
    .map(identityOf)
    .join(',');
  return `${report.summary.players}|${game.engineSeed}|${game.seating.join(',')}|${identities}`;
}

/**
 * Engine seeds played by more than one run in the pool. **Reported, not refused.**
 *
 * These are different games - different matchups, or the same matchup with different agent seeds -
 * so refusing them would block the pooling the ladder depends on. But they are played from the
 * *same initial position*, which means they are correlated across artifacts in a way the clustering
 * cannot see: the two runs have different `runId`s, so their rows land in different clusters and
 * the design effect never sees the shared board. Whether that matters depends on what is being
 * pooled, which is a judgement, which is why this is a number in the report rather than a rule in
 * the code.
 */
export function findSharedEngineSeeds(
  artifacts: ReadonlyArray<LoadedArtifact>,
): ObservationSet['sharedEngineSeeds'] {
  const runsBySeed = new Map<string, {engineSeed: number; players: 2 | 3 | 4; runIds: Set<string>}>();
  for (const artifact of artifacts) {
    const {players} = artifact.report.summary;
    for (const game of artifact.report.games) {
      const key = `${players}|${game.engineSeed}`;
      const entry = runsBySeed.get(key) ?? {engineSeed: game.engineSeed, players, runIds: new Set<string>()};
      entry.runIds.add(artifact.report.header.runId);
      runsBySeed.set(key, entry);
    }
  }
  return [...runsBySeed.values()]
    .filter((entry) => entry.runIds.size > 1)
    .map((entry) => ({engineSeed: entry.engineSeed, players: entry.players, runIds: [...entry.runIds].sort()}))
    .sort((a, b) => a.players - b.players || a.engineSeed - b.engineSeed);
}

// ---------------------------------------------------------------------------------------------
// Building the observation set
// ---------------------------------------------------------------------------------------------

/**
 * Groups in which every permutation was played and every game completed - the runner's own
 * `incompleteGroupPolicy: 'excluded-from-balanced-statistics'`, reproduced here so that criterion
 * P1 compares like with like (`match/runner.ts`'s `summarizeMatch` does exactly this).
 */
function balancedGroupsOf(report: MatchRunReport): {
  balanced: ReadonlyArray<MatchGameRecord>;
  excludedGroups: number;
  excludedGames: number;
} {
  const {permutationsPerGroup} = report.summary;
  const byGroup = new Map<number, Array<MatchGameRecord>>();
  for (const game of report.games) {
    const group = byGroup.get(game.groupIndex) ?? [];
    group.push(game);
    byGroup.set(game.groupIndex, group);
  }
  const balanced: Array<MatchGameRecord> = [];
  let excludedGroups = 0;
  let excludedGames = 0;
  for (const group of byGroup.values()) {
    if (group.length === permutationsPerGroup && group.every((game) => game.completed)) {
      balanced.push(...group);
    } else {
      excludedGroups++;
      excludedGames += group.length;
    }
  }
  return {balanced, excludedGroups, excludedGames};
}

/** One artifact's rows. Exported for the P1 spec, which needs them per run rather than pooled. */
export function observationsOf(artifact: LoadedArtifact): {
  rows: ReadonlyArray<Observation>;
  source: ArtifactSource;
} {
  const {report} = artifact;
  const {players} = report.summary;
  const {balanced, excludedGroups, excludedGames} = balancedGroupsOf(report);
  const rows: Array<Observation> = [];

  for (const game of balanced) {
    const seats = [...game.seats].sort((a, b) => a.seat - b.seat);
    const identities = seats.map(identityOf);
    // Winners come from the record, not recomputed: `match/ranking.ts` owns the Engine's real
    // winner rule (VP, then megacredits), which lives nowhere on the server side, and re-deriving
    // it here would be a second implementation to keep in step. P1 is what checks the reading.
    const tiedWinners = seats.filter((seat) => seat.outcome?.isWinner === true).length;

    for (const seat of seats) {
      const {outcome} = seat;
      if (outcome === undefined) {
        // Cannot happen in a balanced group (every game completed), but a row without an outcome
        // would otherwise become a silent `NaN` downstream, which is exactly hazard H9.
        throw new Error(
          `${artifact.path}: game (group ${game.groupIndex}, permutation ${game.permutationIndex}) ` +
          `is marked completed but seat ${seat.seat} has no outcome`);
      }
      const identity = identityOf(seat);
      const bestOther = Math.max(...seats.filter((other) => other.seat !== seat.seat)
        .map((other) => other.outcome?.victoryPoints ?? Number.NEGATIVE_INFINITY));

      rows.push({
        clusterId: `${report.header.runId}#${game.groupIndex}`,
        runId: report.header.runId,
        groupIndex: game.groupIndex,
        permutationIndex: game.permutationIndex,
        players,
        engineSeed: game.engineSeed,
        seat: seat.seat,
        slot: seat.slot,
        identity,
        win: outcome.isWinner ? 1 : 0,
        score: outcome.isWinner ? 1 / tiedWinners : 0,
        tiedWinners: outcome.isWinner ? tiedWinners : 0,
        placement: outcome.placement,
        margin: outcome.victoryPoints - bestOther,
        marginToNext: outcome.marginToNext,
        victoryPoints: outcome.victoryPoints,
        megaCredits: outcome.megaCredits,
        terraformRating: outcome.terraformRating,
        generation: game.generation,
        opponents: seats.filter((other) => other.seat !== seat.seat).map(identityOf),
        seatsHeld: identities.filter((other) => other === identity).length,
      });
    }
  }

  return {
    rows,
    source: {
      path: artifact.path,
      sha256: artifact.sha256,
      location: artifact.location,
      runId: report.header.runId,
      harnessVersion: report.header.harnessVersion,
      players,
      lineup: report.header.spec.lineup.map((identity) => `${identity.name}@${identity.version}`),
      startGroup: report.header.spec.startGroup,
      groups: report.summary.groups,
      games: report.summary.games,
      balancedGroups: report.summary.balancedGroups,
      excludedGroups,
      excludedGames,
      engineCommit: report.header.provenance.engineCommit,
      seedDerivationVersion: report.header.provenance.seedDerivationVersion,
    },
  };
}

/**
 * The pipeline's front door: artifact paths in, one pooled, guarded, identity-keyed observation set
 * out. Every statistic in `stats.ts`, every rating in Unit B's fits and every cell of Unit C's
 * calibration study runs over this type and nothing else.
 */
export function buildObservationSet(paths: ReadonlyArray<string>): ObservationSet {
  const artifacts = paths.flatMap((path) => loadRatingInput(path));
  assertPoolable(artifacts);

  const rows: Array<Observation> = [];
  const sources: Array<ArtifactSource> = [];
  let unbalancedGroups = 0;
  let excludedGames = 0;

  for (const artifact of artifacts) {
    const built = observationsOf(artifact);
    rows.push(...built.rows);
    sources.push(built.source);
    unbalancedGroups += built.source.excludedGroups;
    excludedGames += built.source.excludedGames;
  }

  return {
    rows,
    identities: [...new Set(rows.map((row) => row.identity))].sort(),
    playerCounts: [...new Set(rows.map((row) => row.players))].sort((a, b) => a - b),
    sources,
    exclusions: {unbalancedGroups, excludedGames},
    sharedEngineSeeds: findSharedEngineSeeds(artifacts),
  };
}

// ---------------------------------------------------------------------------------------------
// Selecting
// ---------------------------------------------------------------------------------------------

/** One player count's rows (§3.5: a rating scale is per player count, never pooled across them). */
export function stratify(set: ObservationSet, players: 2 | 3 | 4): ReadonlyArray<Observation> {
  return set.rows.filter((row) => row.players === players);
}

/** Rows for one identity. Aggregation by `name@version`, and this is the only way to do it (H2). */
export function rowsFor(rows: ReadonlyArray<Observation>, identity: Identity): ReadonlyArray<Observation> {
  return rows.filter((row) => row.identity === identity);
}

/**
 * Rows grouped into clusters, in a stable order. **The unit of analysis** (§3.1): every interval
 * and every test in this pipeline consumes this, never the flat row list.
 */
export function clustersOf(rows: ReadonlyArray<Observation>): ReadonlyArray<ReadonlyArray<Observation>> {
  const byCluster = new Map<string, Array<Observation>>();
  for (const row of rows) {
    const cluster = byCluster.get(row.clusterId) ?? [];
    cluster.push(row);
    byCluster.set(row.clusterId, cluster);
  }
  return [...byCluster.keys()].sort().map((key) => byCluster.get(key) as ReadonlyArray<Observation>);
}

/**
 * One (game, identity) record: the unit AC-2, AC-3, AC-5 and AC-7 are actually stated on.
 *
 * **Why this exists and why a row is not enough** (hazard H2). §3.2 defines the win rate as "the
 * fraction of *games* in which the identity was among the winners". When one identity holds two of
 * three seats, its rows and its games are different populations, and the two give different
 * answers: at equal strength the identity takes first place in **2/3** of games while only **1/3**
 * of its rows are first place. The plan states the null as `seats held / players` precisely because
 * the statistic is the game-level one. Aggregating rows instead would compare 1/3 against a 2/3
 * threshold and call a perfectly average agent incompetent, or - with the other threshold - call it
 * strong. Both are plausible numbers.
 *
 * `margin` stays a per-seat quantity throughout the pipeline (§3.2 defines it as `own VP - best
 * other seat's VP`), so it is summarised here as *this identity's best seat's* margin and reported
 * per row elsewhere. That split is documented on `IdentityReport`.
 */
export type IdentityGame = {
  clusterId: string;
  runId: string;
  groupIndex: number;
  permutationIndex: number;
  players: 2 | 3 | 4;
  identity: Identity;
  seatsHeld: number;
  /** 1 iff at least one of this identity's seats was among the winners. */
  win: 0 | 1;
  /** Sum of its seats' scores: two seats sharing a win give 0.5 + 0.5 = 1, which is right. */
  score: number;
  /** The best (numerically lowest) placement this identity achieved in the game. */
  placement: number;
  /** The margin of the seat that achieved that placement. */
  margin: number;
};

/**
 * Collapses an identity's rows to one record per game. See {@link IdentityGame} for why this is
 * not optional.
 */
export function identityGames(
  rows: ReadonlyArray<Observation>,
  identity: Identity,
): ReadonlyArray<IdentityGame> {
  const byGame = new Map<string, Array<Observation>>();
  for (const row of rows) {
    if (row.identity !== identity) {
      continue;
    }
    const key = `${row.runId}#${row.groupIndex}#${row.permutationIndex}`;
    const game = byGame.get(key) ?? [];
    game.push(row);
    byGame.set(key, game);
  }

  return [...byGame.keys()].sort().map((key) => {
    const seats = byGame.get(key) as ReadonlyArray<Observation>;
    const best = seats.reduce((a, b) => (b.placement < a.placement ? b : a));
    return {
      clusterId: best.clusterId,
      runId: best.runId,
      groupIndex: best.groupIndex,
      permutationIndex: best.permutationIndex,
      players: best.players,
      identity,
      seatsHeld: seats.length,
      win: seats.some((seat) => seat.win === 1) ? 1 : 0,
      score: seats.reduce((total, seat) => total + seat.score, 0),
      placement: best.placement,
      margin: best.margin,
    };
  });
}

/** {@link identityGames}, grouped into the pairing-group clusters every interval consumes (§3.1). */
export function gameClustersOf(games: ReadonlyArray<IdentityGame>): ReadonlyArray<ReadonlyArray<IdentityGame>> {
  const byCluster = new Map<string, Array<IdentityGame>>();
  for (const game of games) {
    const cluster = byCluster.get(game.clusterId) ?? [];
    cluster.push(game);
    byCluster.set(game.clusterId, cluster);
  }
  return [...byCluster.keys()].sort().map((key) => byCluster.get(key) as ReadonlyArray<IdentityGame>);
}

/**
 * The AC-5-style null first-place rate for an identity: **`seats held / players`, not
 * `1 / players`** (hazard H2). An identity holding 2 of 3 seats finishes first two thirds of the
 * time under the null, so comparing its 3p first-place rate against 1/3 would declare a
 * competence that is pure seat arithmetic.
 *
 * Returns `undefined` when the identity holds a different number of seats in different games,
 * which no balanced run produces but a pooled set of two different lineups can - and averaging the
 * two nulls would be a threshold nobody chose.
 */
export function nullFirstPlaceRate(rows: ReadonlyArray<Observation>): number | undefined {
  const heldCounts = new Set(rows.map((row) => `${row.seatsHeld}/${row.players}`));
  if (heldCounts.size !== 1) {
    return undefined;
  }
  return rows[0].seatsHeld / rows[0].players;
}

/**
 * Rows where `marginToNext` disagrees with the computed margin outside the two cases §2.1 explains
 * (the last placement, where it is `undefined`, and a megacredit-decided tie, where it is 0 with a
 * winner above). Expected to be 0; anything else means the record schema and this module disagree
 * about what the runner wrote, and that is a defect in one of the two.
 */
export function crossCheckMarginToNext(rows: ReadonlyArray<Observation>): number {
  let disagreements = 0;
  for (const row of rows) {
    if (row.marginToNext === undefined) {
      continue;
    }
    // `marginToNext` is the gap down to the next *placement group*; for a seat at placement 1 with
    // no tie, that is the gap to the best other seat, which is the computed margin.
    if (row.placement === 1 && row.tiedWinners === 1 && row.marginToNext !== row.margin) {
      // A VP tie broken on megacredits records 0 here while a winner exists (§2.1) - not a defect.
      if (row.marginToNext === 0 && row.margin === 0) {
        continue;
      }
      disagreements++;
    }
  }
  return disagreements;
}
