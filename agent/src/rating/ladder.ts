import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {analysisRandom} from './bootstrap';
import {
  DEFAULT_PRIOR_SIGMA,
  EloBounds,
  PREFERRED_ANCHOR,
  PoolFit,
  PoolFitOptions,
  PoolRating,
  contrastShrinkage,
  describePool,
  eloGap,
  ratePairwise,
} from './bradleyTerry';
import {buildObservationSet, nullFirstPlaceRate, stratify} from './observations';
import {BootstrapContext, HeadToHead, headToHead} from './report';
import {ratePlacements} from './plackettLuce';
import {blockFor, nextFreeRange} from './seedBlocks';
import {
  ArtifactSource,
  DEFAULT_ANALYSIS_SEED,
  DEFAULT_BOOTSTRAP_REPLICATES,
  Identity,
  LadderLedger,
  Observation,
  ObservationSet,
  SeedBlockAllocation,
  SeedBlockName,
  Unestimable,
  isUnestimable,
  unestimable,
} from './types';

/**
 * The ladder (Milestone 2, bullet 3, Unit B; agent/docs/Milestone2_Bullet3_Prompts.md §3.4, §3.6,
 * §3.8).
 *
 * **What it is for.** AC-7 says each promoted version beats the previous one with significance. Over
 * six more milestones that is a *chain* of comparisons, and the difference between a chain anyone
 * can audit and a folder of runs nobody can is this file. The ladder records, per player count and
 * per identity: the rating relative to the `random-legal@1` anchor **and** relative to the immediate
 * predecessor, the head-to-head win rate the gate is actually decided on, the artifacts that fed it
 * with their SHA-256s, and the seed-block ledger of §3.8.
 *
 * ## The three properties that make it an audit trail rather than a cache
 *
 * **1. It is re-derivable.** {@link rederiveLadder} reloads the recorded inputs, checks their hashes,
 * refits, and compares. If a committed ladder cannot reproduce its own ratings from its own recorded
 * inputs, it is a cache of numbers whose provenance has drifted - which is the failure mode a
 * months-long accumulating record is *most* prone to and the one nobody notices, because a stale
 * number looks exactly like a fresh one.
 *
 * **2. It refuses to pool what it must refuse** (§3.6, hazards H5 and H6). `observations.ts` does the
 * refusing - overlapping group ranges for the same matchup (a re-run under a new `--run-id` is the
 * case that matters, so the check is on the games and not on run ids), and any mismatch in
 * `engineCommit`, `harnessVersion` or `seedDerivationVersion`. The ladder is where those guards earn
 * their keep, because it is the artifact that accumulates over months and therefore the one most
 * likely to be handed a pre-fix and a post-fix run together. Errors name the offending files.
 *
 * **3. It records seeds as spent, before they are spent** (§3.8, hazard H7). Milestone 3 tunes
 * evaluation weights against harness win rate; if the seeds used to tune are the seeds used to
 * certify, the certification measures the tuning. That is unfixable after the fact, free to prevent
 * today, and criterion P9 measures its cost rather than asserting it.
 *
 * ## And the property it deliberately does not have
 *
 * **The ladder is not a gate.** Not one acceptance criterion in the SRS is stated as an Elo (§3.4):
 * AC-2, AC-3, AC-5 and AC-7 are every one of them a rate with a threshold. A pool rating is a
 * *derived, model-dependent* quantity - it borrows strength across the whole comparison graph, so a
 * new agent's rating can move because some other pair was played. That is useful for ranking a
 * ladder and disqualifying for a gate, and it is why {@link LadderEntry} carries the head-to-head win
 * rate beside the rating: the number the promotion decision is made on is the one in
 * `predecessorHeadToHead`, not the one in `predecessor`.
 */

/** Bumped when a change here would make an old `ladder.json` misread by new code. */
export const LADDER_VERSION = '1';

/**
 * The promotion chain as of Milestone 2 bullet 2, oldest first (`agent/CLAUDE.md` §6).
 *
 * **Explicit rather than derived from the ratings**, because a chain derived from fitted strength is
 * not an audit trail - it would reorder itself the moment a rating moved, which is exactly when you
 * want it to have stayed put. Each promotion appends one identity; §3.4's corollary is that the new
 * version must have been played against the one before it, which AC-7 requires anyway and which is
 * what keeps the comparison graph connected.
 */
export const DEFAULT_LINEAGE: ReadonlyArray<Identity> = ['random-legal@1', 'greedy-1ply@1'];

/** Same mechanism as `RATING_TIMING_FIELDS` (§3.7): what may differ between two builds of one ladder. */
export const LADDER_TIMING_FIELDS: ReadonlyArray<string> = [
  'header.createdAt',
  'header.nodeVersion',
  'timing',
];

// ---------------------------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------------------------

/** A rating relative to some named reference, on the Elo scale. */
export type RelativeRating = {
  reference: Identity;
  elo: number;
  ci95: EloBounds;
};

export type LadderEntry = {
  players: 2 | 3 | 4;
  identity: Identity;
  games: number;
  /** Relative to {@link PREFERRED_ANCHOR}, or to the component's own anchor when it is absent. */
  anchor: RelativeRating;
  /**
   * Relative to the immediate predecessor in the lineage (§3.4). **This is where the information
   * is**: the anchor-relative figure loses resolution as soon as everything beats `random-legal@1`
   * essentially every game, and the chain's uncertainty accumulates along the predecessor links.
   */
  predecessor: RelativeRating | Unestimable;
  /**
   * The head-to-head win rate against the predecessor, with its cluster-corrected interval and the
   * one-sided test. **The number a promotion is decided on** (§3.4) - the ratings above are context.
   *
   * **The null is `seats held / players`, not 0.5** (hazard H2). At 2p between two distinct
   * identities those are the same number and the distinction is invisible. At 3p they are not: this
   * bullet's corpus seats `greedy-1ply@1` twice, so it takes first place two thirds of the time at
   * equal strength, and testing its 3p rate against 0.5 would certify a competence that is pure seat
   * arithmetic. That is AC-5's form exactly, and `observations.ts` owns the null.
   */
  predecessorHeadToHead: HeadToHead | Unestimable;
  /** The prior's share of the *anchor* gap above (§3.3); see `bradleyTerry.ts`'s `contrastShrinkage`. */
  shrinkage: number;
};

export type LadderStratum = {
  players: 2 | 3 | 4;
  /** The fit, arranged per component of the comparison graph (§3.4). */
  pool: PoolRating;
  entries: ReadonlyArray<LadderEntry>;
};

export type LadderHeader = {
  ladderVersion: string;
  analysisSeed: number;
  bootstrapReplicates: number;
  priorSigma: number;
  anchor: Identity;
  lineage: ReadonlyArray<Identity>;
  inputs: ReadonlyArray<ArtifactSource>;
  pooledProvenance: {engineCommit: string; harnessVersion: string; seedDerivationVersion: number};
  createdAt: string;
  nodeVersion: string;
};

export type Ladder = {
  header: LadderHeader;
  strata: ReadonlyArray<LadderStratum>;
  /**
   * The seed-block ledger of §3.8. **Append-only and carried forward unchanged by every rebuild**:
   * a rebuild that dropped it would silently un-spend every range a previous gate had claimed.
   */
  ledger: LadderLedger;
  timing: {wallClockMs: number};
};

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

export type LadderOptions = {
  analysisSeed?: number;
  bootstrapReplicates?: number;
  priorSigma?: number;
  lineage?: ReadonlyArray<Identity>;
  /** Carried forward from an existing ladder. Never regenerated - the ledger is append-only (§3.8). */
  ledger?: LadderLedger;
};

/** 2p goes to Bradley-Terry, 3p and 4p to Plackett-Luce - and the three never pool (§3.3, §3.5). */
export function rateStratum(
  rows: ReadonlyArray<Observation>,
  players: 2 | 3 | 4,
  options: PoolFitOptions = {},
): PoolFit {
  return players === 2 ? ratePairwise(rows, options) : ratePlacements(rows, options);
}

/**
 * Artifact paths in, one ladder out.
 *
 * The pooling guards run inside {@link buildObservationSet} - before a single strength is fitted -
 * so a double-counted or provenance-mixed pool throws with the offending files named rather than
 * producing a rating that is quietly wrong (§3.6).
 */
export function buildLadder(paths: ReadonlyArray<string>, options: LadderOptions = {}): Ladder {
  const started = Date.now();
  const analysisSeed = options.analysisSeed ?? DEFAULT_ANALYSIS_SEED;
  const bootstrapReplicates = options.bootstrapReplicates ?? DEFAULT_BOOTSTRAP_REPLICATES;
  const priorSigma = options.priorSigma ?? DEFAULT_PRIOR_SIGMA;
  const lineage = options.lineage ?? DEFAULT_LINEAGE;

  // Sorted, and one RNG stream created once and threaded through every stratum in player-count
  // order, for the reason `report.ts` gives: a per-stratum stream would be reproducible too, but it
  // would couple the numbers to the order the strata happen to be written in the code.
  const set = buildObservationSet([...paths].sort());
  const random = analysisRandom(analysisSeed);

  const strata = set.playerCounts.map((players): LadderStratum => {
    const rows = stratify(set, players);
    const fit = rateStratum(rows, players, {priorSigma, replicates: bootstrapReplicates, random});
    const pool = describePool(fit);
    return {
      players,
      pool,
      entries: buildEntries(set, fit, pool, lineage, {replicates: bootstrapReplicates, random}),
    };
  });

  const first = set.sources[0];
  return {
    header: {
      ladderVersion: LADDER_VERSION,
      analysisSeed,
      bootstrapReplicates,
      priorSigma,
      anchor: PREFERRED_ANCHOR,
      lineage,
      inputs: set.sources,
      pooledProvenance: {
        engineCommit: first.engineCommit,
        harnessVersion: first.harnessVersion,
        seedDerivationVersion: first.seedDerivationVersion,
      },
      createdAt: new Date().toISOString(),
      nodeVersion: process.version,
    },
    strata,
    ledger: options.ledger ?? {allocations: []},
    timing: {wallClockMs: Date.now() - started},
  };
}

function buildEntries(
  set: ObservationSet,
  fit: PoolFit,
  rating: PoolRating,
  lineage: ReadonlyArray<Identity>,
  bootstrap: BootstrapContext,
): ReadonlyArray<LadderEntry> {
  return fit.identities.map((identity): LadderEntry => {
    const component = rating.components.find((candidate) => candidate.identities.includes(identity));
    const anchorGap = eloGap(fit, identity, component?.anchor ?? identity);
    if (isUnestimable(anchorGap)) {
      throw new Error(`${identity} has no anchor in its own component: ${anchorGap.reason}`);
    }

    const predecessor = predecessorOf(lineage, identity);
    const predecessorGap = predecessor === undefined ?
      unestimable(lineageReason(lineage, identity)) :
      eloGap(fit, identity, predecessor);

    return {
      players: fit.players,
      identity,
      games: fit.gamesPerIdentity[fit.identities.indexOf(identity)],
      anchor: {reference: anchorGap.reference, elo: anchorGap.elo, ci95: anchorGap.ci95},
      predecessor: isUnestimable(predecessorGap) ?
        predecessorGap :
        {reference: predecessorGap.reference, elo: predecessorGap.elo, ci95: predecessorGap.ci95},
      predecessorHeadToHead: predecessor === undefined ?
        unestimable(lineageReason(lineage, identity)) :
        headToHead(set, identity, predecessor, fit.players, {
          bootstrap,
          // `seats held / players`, never 0.5 (hazard H2) - see the field's doc.
          threshold: nullFirstPlaceRate(stratify(set, fit.players).filter((row) => row.identity === identity)) ?? 0.5,
        }),
      shrinkage: contrastShrinkage(
        fit,
        fit.identities.indexOf(identity),
        fit.identities.indexOf(anchorGap.reference)),
    };
  });
}

/** The identity immediately before `identity` in the lineage, or `undefined` at the head/off-chain. */
export function predecessorOf(lineage: ReadonlyArray<Identity>, identity: Identity): Identity | undefined {
  const position = lineage.indexOf(identity);
  return position > 0 ? lineage[position - 1] : undefined;
}

function lineageReason(lineage: ReadonlyArray<Identity>, identity: Identity): string {
  return lineage.indexOf(identity) === 0 ?
    `${identity} is the head of the promotion chain, so it has no predecessor to be rated against ` +
    '(it is the anchor the chain is measured from - §3.4)' :
    `${identity} is not in the recorded promotion chain [${lineage.join(' -> ')}], so it has no ` +
    'immediate predecessor. Add it to the lineage when it is promoted (§3.4); a rating relative to ' +
    'an identity nobody promoted it over is not evidence for AC-7.';
}

// ---------------------------------------------------------------------------------------------
// Re-derivation: the property that makes it auditable rather than a cache
// ---------------------------------------------------------------------------------------------

export type Rederivation = {
  matches: boolean;
  /** Every input whose bytes no longer hash to what the ladder recorded, or that is missing. */
  inputProblems: ReadonlyArray<string>;
  /** Strata that re-derived to different numbers, described. */
  differences: ReadonlyArray<string>;
};

/**
 * Reloads a ladder's recorded inputs and refits, checking that the committed ratings come back.
 *
 * **The hash check is half the value.** Re-deriving from *different bytes* and getting the same
 * numbers would be a coincidence; re-deriving from different bytes and getting different numbers
 * would look like a code regression when it is a data change. So the SHA-256 of every input is
 * verified first and reported separately from the numeric comparison.
 *
 * Input paths are recorded exactly as the operator typed them (`ArtifactSource.path`), so a relative
 * path re-derives only from the same working directory. That is deliberate: rewriting them to
 * absolute paths at build time would bake one machine's checkout layout into a committed artifact.
 */
export function rederiveLadder(ladder: Ladder): Rederivation {
  const inputProblems: Array<string> = [];
  for (const input of ladder.header.inputs) {
    if (!fs.existsSync(input.path)) {
      inputProblems.push(
        `${input.path} is missing (recorded sha256 ${input.sha256.slice(0, 12)}). Re-derivation ` +
        'resolves the paths the ladder recorded, relative to the current working directory.');
      continue;
    }
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(input.path)).digest('hex');
    if (sha256 !== input.sha256) {
      inputProblems.push(
        `${input.path} hashes to ${sha256.slice(0, 12)} but the ladder recorded ` +
        `${input.sha256.slice(0, 12)}: the bytes behind this rating have changed.`);
    }
  }
  if (inputProblems.length > 0) {
    return {matches: false, inputProblems, differences: []};
  }

  const rebuilt = buildLadder([...new Set(ladder.header.inputs.map((input) => input.path))], {
    analysisSeed: ladder.header.analysisSeed,
    bootstrapReplicates: ladder.header.bootstrapReplicates,
    priorSigma: ladder.header.priorSigma,
    lineage: ladder.header.lineage,
    ledger: ladder.ledger,
  });

  const differences: Array<string> = [];
  const before = JSON.stringify(ladder.strata);
  const after = JSON.stringify(rebuilt.strata);
  if (before !== after) {
    for (const players of [2, 3, 4] as const) {
      const a = JSON.stringify(ladder.strata.find((stratum) => stratum.players === players) ?? null);
      const b = JSON.stringify(rebuilt.strata.find((stratum) => stratum.players === players) ?? null);
      if (a !== b) {
        differences.push(`${players}p re-derived to different numbers`);
      }
    }
  }
  return {matches: differences.length === 0, inputProblems, differences};
}

/** The ladder with {@link LADDER_TIMING_FIELDS} removed - the P8-style reproducibility comparison. */
export function stripLadderTimingFields(ladder: Ladder): unknown {
  const {createdAt: _createdAt, nodeVersion: _nodeVersion, ...header} = ladder.header;
  const {timing: _timing, ...rest} = ladder;
  return {...rest, header};
}

export function laddersMatch(a: Ladder, b: Ladder): boolean {
  return JSON.stringify(stripLadderTimingFields(a)) === JSON.stringify(stripLadderTimingFields(b));
}

// ---------------------------------------------------------------------------------------------
// The seed-block ledger (§3.8)
// ---------------------------------------------------------------------------------------------

export type AllocationRequest = {
  block: SeedBlockName;
  groups: number;
  /** What is spending the range: a gate name, a run id, a bullet. Recorded verbatim. */
  spentBy: string;
  /** The sample size pre-registered for the run (criterion P8). */
  preregisteredGames?: number;
  /** An explicit start, when a range is being recorded retroactively rather than allocated. */
  from?: number;
  recordedAt?: string;
};

/**
 * Appends a fresh, disjoint sub-range to the ledger and returns the updated ladder.
 *
 * **Append-only, and recorded before the run** - which is the whole content of §3.8. A gate re-run on
 * its own sub-range after a change is not a gate: the second run's seeds are the seeds the change was
 * made in response to, and nothing in the output would say so. `seedBlocks.ts`'s
 * `assertBlockAvailable` is what refuses the re-run later; this is what gives it something to refuse.
 */
export function allocate(ladder: Ladder, request: AllocationRequest): Ladder {
  if (!Number.isInteger(request.groups) || request.groups < 1) {
    throw new Error(`groups must be a positive integer, got ${request.groups}`);
  }
  const range = request.from === undefined ?
    nextFreeRange(request.block, request.groups, ladder.ledger) :
    {from: request.from, to: request.from + request.groups - 1};
  if (range === undefined) {
    throw new Error(
      `the '${request.block}' block has no free range of ${request.groups} group(s) left. ` +
      'Widen the block in types.ts SEED_BLOCKS - deliberately, and in one place - rather than ' +
      'reusing a spent range (§3.8, hazard H7).');
  }

  const landing = blockFor(range.from);
  if (landing !== request.block || blockFor(range.to) !== request.block) {
    throw new Error(
      `group range ${range.from}-${range.to} is not inside the '${request.block}' block ` +
      `(${range.from} falls in ${landing ?? 'no block'}). Seed-block discipline is not advisory (§3.8).`);
  }
  const clash = ladder.ledger.allocations.filter((allocation) =>
    allocation.block === request.block && allocation.from <= range.to && allocation.to >= range.from);
  if (clash.length > 0) {
    throw new Error(
      `group range ${range.from}-${range.to} overlaps ${clash.length} range(s) already spent: ` +
      `${clash.map((allocation) => `${allocation.from}-${allocation.to} by '${allocation.spentBy}'`).join('; ')}. ` +
      'Allocate a fresh, disjoint sub-range (§3.8).');
  }

  const allocation: SeedBlockAllocation = {
    block: request.block,
    from: range.from,
    to: range.to,
    spentBy: request.spentBy,
    recordedAt: request.recordedAt ?? new Date().toISOString().slice(0, 10),
    ...(request.preregisteredGames === undefined ? {} : {preregisteredGames: request.preregisteredGames}),
  };
  return {
    ...ladder,
    ledger: {
      allocations: [...ladder.ledger.allocations, allocation]
        .sort((a, b) => a.block.localeCompare(b.block) || a.from - b.from),
    },
  };
}

/** An empty ladder carrying only a ledger - what `ladder allocate` writes before any corpus exists. */
export function emptyLadder(ledger: LadderLedger = {allocations: []}): Ladder {
  return {
    header: {
      ladderVersion: LADDER_VERSION,
      analysisSeed: DEFAULT_ANALYSIS_SEED,
      bootstrapReplicates: 0,
      priorSigma: DEFAULT_PRIOR_SIGMA,
      anchor: PREFERRED_ANCHOR,
      lineage: DEFAULT_LINEAGE,
      inputs: [],
      pooledProvenance: {engineCommit: '', harnessVersion: '', seedDerivationVersion: 0},
      createdAt: new Date().toISOString(),
      nodeVersion: process.version,
    },
    strata: [],
    ledger,
    timing: {wallClockMs: 0},
  };
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

export function saveLadder(filePath: string, ladder: Ladder): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(ladder, null, 2)}\n`);
}

export function loadLadder(filePath: string): Ladder | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Ladder;
}

export type {HeadToHead};
