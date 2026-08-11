import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {PlayerId} from '@/common/Types';
import {SeatedAgent, createAgent, lookupAgent} from '../agents/registry';
import {
  CorpusHeader,
  assertHeaderCompatible,
  buildHeader,
} from '../determinism/corpus';
import {replay} from '../determinism/replay';
import {ReplayConfig, ReplayFingerprint, TraceStep} from '../determinism/types';
import {EmbeddedDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedResponder} from '../driver/responder';
import {errorClassName} from '../legality/causes';
import {agentSeedForSlot, engineSeedForGroup, permutationsFor} from '../match/pairing';
import {rankGame} from '../match/ranking';
import {seatPlayerId} from '../match/runner';
import {MatchVpBreakdown} from '../match/types';
import {SEED_BLOCKS} from '../rating/types';
import {
  L2GameEntry,
  REGRESSION_SUITE_VERSION,
  RegressionCorpus,
  RegressionEntry,
  RegressionEntryDiff,
  RegressionEntryIdentity,
  RegressionFieldDiff,
  RegressionFieldGroup,
  RegressionFingerprints,
  RegressionGameSemantics,
  RegressionSeatSemantics,
  RegressionSection,
  RegressionTraceCheckpoint,
  TRACE_CHECKPOINT_INTERVAL,
  assertL2Entry,
} from './types';

/**
 * The L2 corpus: playing a pinned reference game, saving it, and - the part that carries the whole
 * layer - comparing a re-run against what was committed **field by field** (Milestone 2, bullet 5,
 * Unit A §2/§3; agent/docs/Milestone2_Bullet5_Prompts.md §3.3).
 *
 * ---
 *
 * ## Why a per-field diff and not a boolean
 *
 * `determinism/corpus.ts` commits six hashes per config and answers one yes/no question over 300
 * games. That is the right trade there. It is the wrong trade here, because the question this layer
 * answers is *"what changed"*, over a curated set that has to justify its own existence years later.
 * The two events
 *
 * - "the move trace differs but every VP component is identical", and
 * - "greenery VP moved by 2"
 *
 * have different responses, and a combined hash makes them the same event. So {@link compareEntry}
 * returns every moved field with both values and a group (`fingerprint` / `semantics`), and that
 * grouping *is* L3.
 *
 * ---
 *
 * ## One game, played through `replay()`, and what that buys
 *
 * A pinned entry is played by `determinism/replay.ts`, now that §3.9 has given it an agent factory.
 * That is not incidental reuse - it is the reason `greedy-1ply@1` can be fingerprinted at all
 * (§2.1: `replay.ts` hard-coded the random-legal agent, so one of the two frozen yardsticks every
 * AC-3 claim is stated against had no fixed-seed standing check of any kind).
 *
 * **The game played here is the same game the match runner would play** for the same
 * `(players, groupIndex, permutationIndex)`: the same `createGame` call from the same derived engine
 * seed, the same per-seat agents from the same derived agent seeds, the same seat router, the same
 * merged driver options in the same order. It has to be, or C's `moves`-tier survey and the pinned
 * entry derived from it would describe different games. That claim is not left to inspection -
 * `test/regression/corpus.spec.ts` plays one config both ways and asserts the semantic fields are
 * identical, which is also what keeps the twelve duplicated lines of {@link readSeatSemantics} from
 * drifting away from `match/runner.ts`'s.
 *
 * **Seeds are derived, never written down** (§2.6, hazard H5). The identity carries a *group index*
 * in the R block; `match/pairing.ts` turns it into `engineSeed = 21,000,017 + 1,409 x group` and
 * `agentSeed = 27,000,023 + 3,251 x group + 149 x slot`. Writing a literal engine seed into a pinned
 * entry is how a corpus ends up outside the R block with nothing able to notice.
 */

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/**
 * `greedy-1ply@1/2p/g6100/p1` - the five-tuple of hazard H4, in one string. This is what
 * `--explain` takes and what a red line prints, so it is short, greppable, and contains no field
 * that is not part of the key.
 */
export function entryKey(identity: RegressionEntryIdentity): string {
  return `${identity.agent}@${identity.agentVersion}/${identity.players}p/g${identity.groupIndex}/p${identity.permutationIndex}`;
}

const ENTRY_KEY_PATTERN = /^(.+)@([^/]+)\/([234])p\/g(\d+)\/p(\d+)$/;

/** The parsed key `--explain` selects on. Throws with the expected shape rather than returning undefined. */
export function parseEntryKey(key: string): Omit<RegressionEntryIdentity, 'lineup' | 'seating'> {
  const match = ENTRY_KEY_PATTERN.exec(key);
  if (match === null) {
    throw new Error(`'${key}' is not an entry key. The shape is <agent>@<version>/<players>p/g<groupIndex>/p<permutationIndex>, e.g. greedy-1ply@1/2p/g6100/p1.`);
  }
  return {
    agent: match[1],
    agentVersion: match[2],
    players: Number(match[3]) as 2 | 3 | 4,
    groupIndex: Number(match[4]),
    permutationIndex: Number(match[5]),
  };
}

/** `random-legal@1` - the section a corpus files an entry under, and what `--agent` takes. */
export function sectionKey(section: {agent: string; agentVersion: string}): string {
  return `${section.agent}@${section.agentVersion}`;
}

// ---------------------------------------------------------------------------------------------
// Playing one entry
// ---------------------------------------------------------------------------------------------

export type PlayedEntry = {
  fingerprints: RegressionFingerprints;
  semantics: RegressionGameSemantics;
  /** Present only when asked for: the full per-decision trace, for `--explain` (§3.1's localization). */
  trace?: ReadonlyArray<TraceStep>;
};

export type PlayEntryOptions = {
  /** Capture the full move trace so a divergence can be localized and printed. Costs memory, not time. */
  diagnostics?: boolean;
};

/**
 * Plays one pinned game and returns everything a committed entry compares. Synchronous, like
 * `playMatchGame`: the event-loop yield hazard H8 requires belongs to the batch loop above, which is
 * the thing that runs many of these.
 */
export function playRegressionEntry(identity: RegressionEntryIdentity, options: PlayEntryOptions = {}): PlayedEntry {
  const {players, groupIndex} = identity;
  const config: ReplayConfig = {
    players,
    engineSeed: engineSeedForGroup(groupIndex),
    // `ReplayConfig` carries one agent seed and an L2 game has one per lineup slot, so this records
    // slot 0's and the factory below derives the rest from `(groupIndex, slot)`. The field is
    // provenance on this path, not the thing that seeds the game - the identity is the authority.
    agentSeed: agentSeedForSlot(groupIndex, 0),
  };

  let semantics: RegressionGameSemantics | undefined;
  // The seated agents, built inside the factory (once per game, so a searching agent may keep
  // per-game state in its closure - `registry.ts`'s contract) and read again afterwards for the
  // driver options they contribute.
  let seated: ReadonlyArray<{seat: number; slot: number; playerId: PlayerId; agent: SeatedAgent}> = [];

  const fingerprint = replay(config, {
    diagnostics: options.diagnostics === true,
    agent: () => {
      seated = seatAgents(identity);
      assertNoDriverCaps(seated, identity);
      return routerFor(seated, identity);
    },
    // Hazard H4 of bullet 2: a searching agent needs `onFallback` to learn which response the
    // Engine *accepted*. `replay()` composes its own fallback counter around whatever is passed
    // here, in the same order `match/runner.ts` composes its own - the runner's counter first, then
    // each agent's in seat order - so `greedy-1ply@1`'s fork service sees exactly what it sees in a
    // match. Built lazily via a getter-free indirection because `seated` is populated by the
    // factory above, which `replay()` calls after it reads this object.
    driverOptions: {
      onFallback: (event) => {
        for (const entry of seated) {
          entry.agent.driverOptions?.onFallback?.(event);
        }
      },
    },
    onGameEnd: (game) => {
      semantics = readGameSemantics(game, identity);
    },
  });

  if (semantics === undefined) {
    throw new Error(`${entryKey(identity)}: the game finished without producing semantics, which should be impossible - onGameEnd did not fire.`);
  }

  return {
    fingerprints: fingerprintsOf(fingerprint),
    semantics,
    ...(fingerprint.diagnostics === undefined ? {} : {trace: fingerprint.diagnostics.trace}),
  };
}

/**
 * **A refusal, not a merge.** `playMatchGame` lets a seated agent tighten the driver's stall cap
 * (`mergeDriverOptions` takes the strictest `maxDecisions` any party asked for). `replay()` reads
 * its `driverOptions` object before the agent factory has run, so this path cannot compute that
 * merge without threading a lazily-read field through - and an agent whose cap were silently
 * dropped would play a *different game here than in a match*, which is precisely the divergence
 * this whole module's "same game as the match runner" claim rests on.
 *
 * No registered agent sets `maxDecisions` today (`greedy-1ply@1` contributes only an `onFallback`,
 * `search/fork.ts:400`), so the honest handling is to refuse the case rather than to pretend to
 * handle it. If this ever throws, thread the cap through `ReplayOptions` - do not delete the check.
 */
function assertNoDriverCaps(
  seated: ReadonlyArray<{slot: number; agent: SeatedAgent}>,
  identity: RegressionEntryIdentity,
): void {
  for (const entry of seated) {
    if (entry.agent.driverOptions?.maxDecisions !== undefined) {
      throw new Error(
        `${entryKey(identity)}: agent '${identity.lineup[entry.slot]}' sets driverOptions.maxDecisions, ` +
        'which this path cannot apply (see assertNoDriverCaps). Applying it in a match and not here ' +
        'would make the pinned game a different game from the one the match runner plays.');
    }
  }
}

function seatAgents(
  identity: RegressionEntryIdentity,
): ReadonlyArray<{seat: number; slot: number; playerId: PlayerId; agent: SeatedAgent}> {
  return identity.seating.map((slot, seat) => ({
    seat,
    slot,
    playerId: seatPlayerId(seat),
    agent: createAgent(identity.lineup[slot], agentSeedForSlot(identity.groupIndex, slot)),
  }));
}

/**
 * The seat router, plus each contributing agent's whole-game observer wrapped around it in seat
 * order, innermost first - the same construction and the same order as `playMatchGame`. An agent
 * that contributes nothing leaves the router untouched, so `random-legal@1`'s games are the games
 * they were before this seam existed.
 */
function routerFor(
  seated: ReadonlyArray<{seat: number; slot: number; playerId: PlayerId; agent: SeatedAgent}>,
  identity: RegressionEntryIdentity,
): EmbeddedResponder {
  const bySeat = new Map(seated.map((entry) => [entry.playerId, entry.agent]));
  const router: EmbeddedResponder = (decision: EmbeddedDecisionPoint) => {
    const agent = bySeat.get(decision.player.id);
    if (agent === undefined) {
      throw new Error(`no agent is seated as player ${decision.player.id} in ${entryKey(identity)}.`);
    }
    return agent.respond(decision);
  };

  let observed = router;
  for (const entry of seated) {
    const wrap = entry.agent.observeDecisions;
    if (wrap !== undefined) {
      observed = wrap(observed);
    }
  }
  return observed;
}

function fingerprintsOf(fingerprint: ReplayFingerprint): RegressionFingerprints {
  return {
    moveTraceHash: fingerprint.moveTraceHash,
    stableStateHash: fingerprint.stableStateHash,
    resultHash: fingerprint.resultHash,
    decisions: fingerprint.decisions,
    fallbacks: fingerprint.fallbacks,
    generation: fingerprint.generation,
    traceCheckpoints: checkpointsOf(fingerprint),
  };
}

/**
 * Samples the rolling trace hash every {@link TRACE_CHECKPOINT_INTERVAL} decisions.
 *
 * Requires the diagnostics trace, which a bulk verify run does not capture - so on a verify the
 * list is empty and nothing compares it (see {@link RegressionFingerprints.traceCheckpoints}: the
 * checkpoints are localization data, never a compared field). A *generation* run captures
 * diagnostics precisely so the committed entry carries them.
 */
function checkpointsOf(fingerprint: ReplayFingerprint): ReadonlyArray<RegressionTraceCheckpoint> {
  const trace = fingerprint.diagnostics?.trace;
  if (trace === undefined) {
    return [];
  }
  const checkpoints: Array<RegressionTraceCheckpoint> = [];
  for (const step of trace) {
    if ((step.index + 1) % TRACE_CHECKPOINT_INTERVAL === 0) {
      checkpoints.push({decisionIndex: step.index, hash: step.hash});
    }
  }
  return checkpoints;
}

// ---------------------------------------------------------------------------------------------
// Reading the semantics off a finished game
// ---------------------------------------------------------------------------------------------

/**
 * The end-of-game numbers, read off the live `IGame` exactly as `match/runner.ts` reads them.
 *
 * **These twelve lines are duplicated from `playMatchGame`, knowingly.** Sharing them would mean
 * either refactoring bullet 1's runner - a load-bearing file whose artifacts criteria R2/R6 compare
 * byte for byte - or importing a shape that carries two fields this suite deliberately does not
 * compare. The duplication is instead pinned by a spec that plays one config through both paths and
 * asserts the semantics match, which catches drift more reliably than a shared function would have
 * prevented it: a shared function that changed meaning would change both sides at once.
 */
export function readGameSemantics(game: IGame, identity: RegressionEntryIdentity): RegressionGameSemantics {
  const ranking = rankGame(game);
  const seatOf = new Map(game.players.map((player, seat) => [player.id, seat]));

  return {
    seats: identity.seating.map((slot, seat): RegressionSeatSemantics => {
      const name = identity.lineup[slot];
      return {
        seat,
        slot,
        agent: name,
        agentVersion: lookupAgent(name).version,
        ...readSeatSemantics(game.players[seat], ranking[seat]),
      };
    }),
    claimedMilestones: game.claimedMilestones.map((claimed) => ({
      milestone: claimed.milestone.name,
      seat: seatOf.get(claimed.player.id) ?? -1,
    })),
    fundedAwards: game.fundedAwards.map((funded) => ({
      award: funded.award.name,
      seat: seatOf.get(funded.player.id) ?? -1,
    })),
  };
}

function readSeatSemantics(
  player: IPlayer,
  rank: {placement: number; isWinner: boolean; victoryPoints: number; megaCredits: number},
): Omit<RegressionSeatSemantics, 'seat' | 'slot' | 'agent' | 'agentVersion'> {
  return {
    placement: rank.placement,
    isWinner: rank.isWinner,
    victoryPoints: rank.victoryPoints,
    megaCredits: rank.megaCredits,
    terraformRating: player.terraformRating,
    vpBreakdown: readVpBreakdown(player.getVictoryPoints()),
    corporations: player.playedCards.corporations().map((card) => card.name),
    preludes: player.playedCards.preludes().map((card) => card.name),
    projectCards: player.playedCards.projects().map((card) => card.name),
  };
}

/** The in-scope subset of the Engine's `VictoryPointsBreakdown` - `match/types.ts`'s `MatchVpBreakdown`. */
function readVpBreakdown(breakdown: {
  terraformRating: number; milestones: number; awards: number; greenery: number; city: number;
  victoryPoints: number; total: number;
}): MatchVpBreakdown {
  return {
    terraformRating: breakdown.terraformRating,
    milestones: breakdown.milestones,
    awards: breakdown.awards,
    greenery: breakdown.greenery,
    city: breakdown.city,
    cards: breakdown.victoryPoints,
    total: breakdown.total,
  };
}

// ---------------------------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------------------------

/**
 * The fingerprint fields that are compared. **`traceCheckpoints` is not among them**, and the
 * reason is on the field itself: the chain is rolling, so any divergence a checkpoint could see has
 * already moved `moveTraceHash`, and comparing them would turn one honest mismatch row into twelve.
 */
export const COMPARED_FINGERPRINT_FIELDS = [
  'moveTraceHash', 'stableStateHash', 'resultHash', 'decisions', 'fallbacks', 'generation',
] as const;

/**
 * Every field of `expected` that `actual` does not reproduce, with both values and a dotted path.
 *
 * **Refuses anything that is not an L2 entry** (§3.1, made structural): the type system covers the
 * call sites in this repository, and {@link assertL2Entry} covers the ones that arrived as JSON.
 */
export function compareEntry(expected: RegressionEntry, actual: PlayedEntry): ReadonlyArray<RegressionFieldDiff> {
  assertL2Entry(expected, `comparing ${'identity' in expected ? entryKey(expected.identity) : 'an entry'}`);

  const diffs: Array<RegressionFieldDiff> = [];
  for (const field of COMPARED_FINGERPRINT_FIELDS) {
    if (expected.fingerprints[field] !== actual.fingerprints[field]) {
      diffs.push({
        group: 'fingerprint',
        path: `fingerprints.${field}`,
        expected: expected.fingerprints[field],
        actual: actual.fingerprints[field],
      });
    }
  }
  diffValues('semantics', 'semantics', expected.semantics, actual.semantics, diffs);
  return diffs;
}

/**
 * Recursive structural diff, emitting one row per differing **leaf** so a report says
 * `semantics.seats[1].vpBreakdown.greenery: 4 -> 6` rather than dumping two seat objects.
 *
 * A length change on an array is reported once, at the array's own path, and then not descended
 * into: "this seat played 3 more cards" is one event, and eleven rows about shifted indices would
 * bury it. That is the same judgement §3.3 makes about hashing - the report's job is to name the
 * event, not to maximize the number of differences it can list.
 */
function diffValues(
  group: RegressionFieldGroup,
  path: string,
  expected: unknown,
  actual: unknown,
  out: Array<RegressionFieldDiff>,
): void {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push({group, path: `${path}.length`, expected: expected.length, actual: actual.length});
      return;
    }
    expected.forEach((element, index) => diffValues(group, `${path}[${index}]`, element, actual[index], out));
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      diffValues(group, `${path}.${key}`, expected[key], actual[key], out);
    }
    return;
  }
  if (expected !== actual) {
    out.push({group, path, expected, actual});
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Replays one committed entry and diffs it. A throw becomes a `failure`, never an escaped exception. */
export function verifyEntry(entry: L2GameEntry): RegressionEntryDiff {
  try {
    const played = playRegressionEntry(entry.identity);
    return {identity: entry.identity, why: entry.why, diffs: compareEntry(entry, played)};
  } catch (error) {
    return {
      identity: entry.identity,
      why: entry.why,
      diffs: [],
      failure: {
        errorClass: errorClassName(error),
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** `{path: entries that moved it}` - the input to the ledger's tool-computed `fieldsMoved` (§3.5). */
export function tallyFieldsMoved(diffs: ReadonlyArray<RegressionEntryDiff>): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const entry of diffs) {
    // Per *entry*, not per row: an entry whose four seats all moved `victoryPoints` moved that field
    // once, because the ledger's question is "how many entries did this field move in".
    for (const field of new Set(entry.diffs.map((diff) => normalizePath(diff.path)))) {
      tally[field] = (tally[field] ?? 0) + 1;
    }
    if (entry.failure !== undefined) {
      tally['<failed to replay>'] = (tally['<failed to replay>'] ?? 0) + 1;
    }
  }
  return tally;
}

/**
 * `semantics.seats[2].vpBreakdown.greenery` -> `semantics.seats[].vpBreakdown.greenery`. The ledger
 * and the run report both want "which *field* moved", and a per-seat-index tally would report the
 * same finding under four names at 4p.
 */
export function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

// ---------------------------------------------------------------------------------------------
// The committed artifact
// ---------------------------------------------------------------------------------------------

export function buildRegressionCorpus(sections: ReadonlyArray<RegressionSection>): RegressionCorpus {
  return {header: buildHeader(), suiteVersion: REGRESSION_SUITE_VERSION, sections};
}

/** Thrown when a corpus is structurally invalid - see {@link assertCorpusValid} for the list. */
export class RegressionCorpusError extends Error {}

/**
 * Refuses a corpus that cannot mean what it claims to. Every check here is a thing that would
 * otherwise be discovered months later, by a reader rather than by a tool:
 *
 * - **An entry with no `why`.** §3.3 is explicit that this is not decoration: it is what stops a
 *   future session deleting a game it does not understand, and it is the only field a human reads
 *   first when the suite goes red. Enforced at save time, because "every pinned game carries one
 *   sentence" is not a property a review can maintain across four sessions.
 * - **A duplicate key.** The five-tuple of hazard H4 is the identity; two entries sharing one means
 *   a verify silently checks one game twice and never checks the other.
 * - **A group index outside the R block** (6,000-6,999). Criterion S9, checked here as well as by
 *   `assertBlockAvailable`, because the ledger check happens before the run and this one happens
 *   before the artifact is written - and it is the second that survives into the repository.
 * - **An entry filed under the wrong section**, which would make `--agent` select the wrong games.
 * - **A seating that is not a permutation the pairing schedule produces**, which would mean the
 *   entry cannot be reproduced by the match runner from its own identity.
 */
export function assertCorpusValid(corpus: RegressionCorpus): void {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  const block = SEED_BLOCKS.regression;

  for (const section of corpus.sections) {
    for (const entry of section.entries) {
      const key = entryKey(entry.identity);
      if (entry.layer !== 'l2') {
        problems.push(`${key}: layer '${(entry as RegressionEntry).layer}' in an L2 corpus (§3.1)`);
      }
      if (entry.why === undefined || entry.why.trim() === '') {
        problems.push(`${key}: no 'why'. Every pinned game carries one sentence naming what it covers (§3.3).`);
      }
      if (seen.has(key)) {
        problems.push(`${key}: duplicate entry key (hazard H4 - the five-tuple is the identity)`);
      }
      seen.add(key);
      if (entry.identity.agent !== section.agent || entry.identity.agentVersion !== section.agentVersion) {
        problems.push(`${key}: filed under section ${sectionKey(section)}, which it does not name`);
      }
      const {groupIndex} = entry.identity;
      if (groupIndex < block.from || groupIndex > block.to) {
        problems.push(`${key}: group ${groupIndex} is outside the R block (${block.from}-${block.to}) - criterion S9`);
      }
      const permutations = permutationsFor(entry.identity.players);
      const expectedSeating = permutations[entry.identity.permutationIndex];
      if (expectedSeating === undefined) {
        problems.push(`${key}: permutation ${entry.identity.permutationIndex} does not exist at ${entry.identity.players}p (${permutations.length} per group)`);
      } else if (JSON.stringify(expectedSeating) !== JSON.stringify(entry.identity.seating)) {
        problems.push(`${key}: seating ${JSON.stringify(entry.identity.seating)} is not the pairing schedule's permutation ${entry.identity.permutationIndex} (${JSON.stringify(expectedSeating)})`);
      }
      if (entry.identity.lineup.length !== entry.identity.players) {
        problems.push(`${key}: lineup names ${entry.identity.lineup.length} agent(s) for ${entry.identity.players} players`);
      }
    }
  }

  if (problems.length > 0) {
    throw new RegressionCorpusError(
      `this regression corpus is not valid and was not written:\n  ${problems.join('\n  ')}`);
  }
}

/**
 * Writes the corpus with the header and section metadata pretty-printed and the entries one per
 * line - `match/artifact.ts`'s call, for its reason: an entry is read as a record, not navigated as
 * a tree, and one-per-line keeps both `git diff` and a `grep` for a failing group usable.
 */
export function saveRegressionCorpus(filePath: string, corpus: RegressionCorpus): void {
  assertCorpusValid(corpus);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const sections = corpus.sections.map((section) => {
    const {entries, ...rest} = section;
    const head = JSON.stringify(rest, null, 6).slice(0, -2);
    const rows = entries.map((entry) => `        ${JSON.stringify(entry)}`).join(',\n');
    return `    ${head.trimStart()},\n      "entries": [\n${rows}\n      ]\n    }`;
  });
  const head = JSON.stringify({header: corpus.header, suiteVersion: corpus.suiteVersion}, null, 2);
  fs.writeFileSync(filePath, `${head.slice(0, head.length - 2)},\n  "sections": [\n${sections.join(',\n')}\n  ]\n}\n`);
}

export function loadRegressionCorpus(filePath: string): RegressionCorpus {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RegressionCorpus;
}

/**
 * Rejects a corpus whose header is not comparable against this environment **before** anything is
 * replayed (hazard H9). Reuses `determinism/corpus.ts`'s {@link assertHeaderCompatible} verbatim -
 * the Engine **pin** is compared, repo HEAD is not - rather than writing a second header check,
 * which is the mistake that once made every committed corpus unverifiable on the next docs-only
 * commit.
 */
export function assertCorpusComparable(corpus: RegressionCorpus, current: CorpusHeader = buildHeader()): void {
  assertHeaderCompatible(corpus.header, current);
  if (corpus.suiteVersion !== REGRESSION_SUITE_VERSION) {
    throw new Error(
      `this corpus was written by suite version ${corpus.suiteVersion} and this is version ` +
      `${REGRESSION_SUITE_VERSION}. The record schema changed, so a comparison would be reading old ` +
      'fields with new meanings (§3.3). Regenerate it deliberately, with a ledger claim (§3.5).');
  }
}

/**
 * A stable digest of the corpus's *content* - the ledger's `corpusDigest` (§3.5). Excludes the
 * header's `createdAt`, which moves on every write and would make two identical corpora look
 * different in the chain.
 */
export function digestCorpus(corpus: RegressionCorpus): string {
  const {createdAt: _createdAt, ...header} = corpus.header;
  return createHash('sha256').update(JSON.stringify({header, suiteVersion: corpus.suiteVersion, sections: corpus.sections})).digest('hex');
}

/** Every entry in the corpus, in order, flattened across sections. */
export function allEntries(corpus: RegressionCorpus): ReadonlyArray<L2GameEntry> {
  return corpus.sections.flatMap((section) => section.entries);
}

/** The entry matching a parsed `--explain` key, or `undefined`. */
export function findEntry(corpus: RegressionCorpus, key: string): L2GameEntry | undefined {
  return allEntries(corpus).find((entry) => entryKey(entry.identity) === key);
}
