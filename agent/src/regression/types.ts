import {CardName} from '@/common/cards/CardName';
import {CorpusHeader} from '../determinism/corpus';
import {MatchAwardRecord, MatchMilestoneRecord, MatchSeatOutcome, MatchSeatRecord} from '../match/types';

/**
 * The regression suite's record schema (Milestone 2, bullet 5, Unit A; the design is settled in
 * agent/docs/Milestone2_Bullet5_Prompts.md §3.1 and §3.3).
 *
 * **What this suite is for, in one sentence, because a reader three milestones from now will need
 * it before anything else:** three instruments already answer "is it legal?", "is it stronger?" and
 * "is it deterministic?"; this one answers **"did anything change that we didn't mean to change?"**,
 * and it is the only one of the four that covers `greedy-1ply@1` at all (§2.1). A green suite is
 * **not** a legality result and **not** a strength result (hazard H14).
 *
 * ---
 *
 * ## The layers are defined by what invalidates them, and the boundary is structural
 *
 * | Layer | Depends on | Invalidated by | Survives |
 * | --- | --- | --- | --- |
 * | **L1** reference positions | the Engine at the pin | a pin move | every agent change, M3 to M7 |
 * | **L2** reference games | Engine pin x agent **version** x shared agent infrastructure | a pin move; a genuine behaviour change in a frozen version | a *new* agent version, which adds a section |
 * | **L3** triage | nothing - it reads L2's output | - | - |
 *
 * The boundary is the whole design (§3.1), so it is enforced by a type rather than by a convention:
 * {@link RegressionEntry} is a discriminated union on `layer`, the comparison machinery in
 * `corpus.ts` accepts only {@link L2GameEntry}, and {@link assertL2Entry} is the runtime half for
 * entries that arrived as JSON rather than as a checked value.
 *
 * **A shared-infrastructure change that moves a frozen baseline is a regression, not a rebaseline.**
 * `greedy-1ply@1` does not own the enumerator, the driver, the fork service or the ranking. If M3
 * changes candidate enumeration and its fingerprints move, the agent's own code is untouched and its
 * behaviour changed anyway - which is exactly the event bullet 2 pre-committed against ("any change
 * to its move distribution ... is a **new version**, not an improvement"). The correct response is to
 * adjudicate and either revert or cut `greedy-1ply@2`. It is never to regenerate the corpus, which
 * is what `ledger.ts` exists to make expensive.
 *
 * ---
 *
 * ## Read this before pruning a field, and before adding one
 *
 * Every field on {@link L2GameEntry} is either a *fingerprint* (cheap, sensitive, uninformative
 * about what moved), a *semantic* field (expensive to add later, and the only thing that can tell
 * "the trace differs but every VP component is identical" from "greenery VP moved by 2"), or
 * *provenance* (`coverage`, `why`) that is never compared. That three-way split is what L3 reads,
 * and it is the reason the suite commits the fields rather than a hash of the fields (§3.3):
 *
 * > a combined hash makes two different events the same event.
 *
 * This is bullet 3's explicit lesson applied (`agent/CLAUDE.md` §6): *commit the per-game rows, not
 * the summary*. `baselines_validation.json` carries summaries only, so bullet 2's headline 99.2%
 * cannot be re-analysed by anything, including the rating pipeline.
 *
 * Almost nothing here is newly invented. The semantic fields are `Pick`ed from
 * {@link MatchSeatOutcome} and {@link MatchSeatRecord} rather than re-declared, because bullet 1
 * designed that schema against its whole consumer list precisely so this bullet would not need a
 * re-run - read `match/types.ts`'s module doc before adding a field to it. The provenance header is
 * {@link CorpusHeader} verbatim (hazard H9): the Engine **pin** is compared, repo HEAD is not, and
 * writing a second header type is how that trap gets re-sprung.
 */

/** Bumped when a change to this schema would make a committed corpus misread by new code. */
export const REGRESSION_SUITE_VERSION = '1';

// ---------------------------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------------------------

/**
 * `l1` reference positions, `l2` reference games, `l3` triage. L3 has no entries of its own - it is
 * a *reading* of L2's comparison output - and appears here because the CLI's `--layer` takes it and
 * because a layer set with a hole in it invites someone to number their own.
 */
export type RegressionLayer = 'l1' | 'l2' | 'l3';

export const REGRESSION_LAYERS: ReadonlyArray<RegressionLayer> = ['l1', 'l2', 'l3'];

// ---------------------------------------------------------------------------------------------
// L1: reference positions
// ---------------------------------------------------------------------------------------------

/**
 * **L1 has no committed entries, and that is deliberate.** A reference position is a mocha spec
 * under `agent/test/regression/fixtures/` (Unit B) that grants a card, grants its precondition,
 * calls the effect and asserts the number. There is nothing to pin: the assertion *is* the record,
 * it lives next to the §3.4 comment explaining why the number is what it is, and `npm test` runs it
 * whether or not anybody remembers this CLI exists (§3.8 - that redundancy is the point).
 *
 * So an L1 entry is a *result*, produced by running those specs, never loaded from disk. It carries
 * `layer: 'l1'` so that {@link assertL2Entry} can refuse it if it ever reaches L2's machinery, which
 * is §3.1's boundary made structural rather than advisory.
 */
export type L1FixtureResult = {
  layer: 'l1';
  /** Spec file, relative to `agent/`. */
  file: string;
  /** Mocha's full title for the assertion. */
  title: string;
  passed: boolean;
  /** Present only on a failure. */
  message?: string;
};

/**
 * The L1 layer's outcome. `status` distinguishes the two green-looking states that must never be
 * confused: a suite whose fixtures all passed, and a suite with **no fixtures at all**.
 *
 * *"A suite that has never refused anything is indistinguishable from a suite that works"* is this
 * bullet's second stated failure mode, and zero fixtures reporting `ok` is its purest form. Unit A
 * ships before Unit B, so `empty` is a real state on a real checkout rather than a hypothetical -
 * it is reported loudly and, deliberately, is **not** a hard failure, because a layer that is red
 * for three units' worth of sessions is a layer people learn to ignore (hazard H7's mechanism,
 * one level up).
 */
export type L1LayerResult = {
  layer: 'l1';
  status: 'ok' | 'failed' | 'empty';
  fixtures: number;
  failures: ReadonlyArray<L1FixtureResult>;
  durationMs: number;
};

// ---------------------------------------------------------------------------------------------
// L2: reference games
// ---------------------------------------------------------------------------------------------

/**
 * What identifies a pinned game. **Never `game.id`** (hazard H4): `gameFactory.ts` builds
 * `g-nadia-${seed}` and omits the player count, so a 2p and a 3p game on one engine seed share an
 * id.
 *
 * **Seeds are derived, never written down** (§2.6, hazard H5). `groupIndex` is a *group index* in
 * the R block (6,000-6,999), not an engine seed; `match/pairing.ts` derives
 * `engineSeed = 21,000,017 + 1,409 x group` and `agentSeed = 27,000,023 + 3,251 x group + 149 x slot`
 * from it. Confusing the two namespaces silently produces a corpus outside the R block, which is
 * the one error `assertBlockAvailable` cannot catch after the fact.
 */
export type RegressionEntryIdentity = {
  /**
   * The agent version this entry is **pinned for** - the section it is filed under, and the first
   * element of the §3.6 inheritance rule ("a new version gets a section generated once, at
   * promotion, and frozen").
   *
   * For a mixed lineup this is one of the seats, not all of them: a game is pinned *for* an agent,
   * and `lineup` below records who actually sat. An entry is filed under exactly one section, so
   * the five-tuple `(agent, agentVersion, players, groupIndex, permutationIndex)` stays unique
   * across the corpus.
   */
  agent: string;
  agentVersion: string;
  players: 2 | 3 | 4;
  /** R-block group index. See the type doc: a group index is not an engine seed. */
  groupIndex: number;
  /** Index of this permutation within the group's permutation list (`match/pairing.ts`). */
  permutationIndex: number;
  /**
   * Who sat where: `lineup[slot]` is an agent name, and `seating[seat]` is the slot in that seat.
   * Not part of the key, and recorded anyway - a mixed-lineup entry whose opponents are unnamed is
   * a row nobody can act on, and it costs two short arrays.
   */
  lineup: ReadonlyArray<string>;
  seating: ReadonlyArray<number>;
};

/**
 * The cheap, sensitive half: `determinism/replay.ts`'s fingerprint, unchanged in meaning. Sensitive
 * to everything and informative about nothing, which is precisely why the semantic fields below
 * exist beside it.
 *
 * **One known blind spot, recorded because Unit D will go looking for it** (`agent/CLAUDE.md` §6):
 * `moveTraceHash` has no step for a decision the responder *threw* on - `replay()` records after the
 * responder returns - so a divergence confined to fallback-resolved decisions would not move it.
 * `stableStateHash`, `fallbacks` and the semantic fields are what catch that class.
 */
export type RegressionFingerprints = {
  moveTraceHash: string;
  stableStateHash: string;
  resultHash: string;
  /**
   * Decisions folded into the move trace - **not** the same number as `MatchGameRecord.decisions`,
   * and the difference is not a defect. `match/runner.ts`'s router increments before calling the
   * agent, so it counts a decision the responder threw on; `replay.ts` records after the responder
   * returns, so it does not. The gap is exactly the responder-throw population (~5.7 per game at
   * the scale AC-1 measured), and `corpus.spec.ts` asserts that identity rather than leaving a
   * "295 vs 300" for someone to investigate as a bug.
   */
  decisions: number;
  fallbacks: number;
  generation: number;
  /**
   * The rolling move-trace hash sampled every {@link TRACE_CHECKPOINT_INTERVAL} decisions.
   *
   * **This field is what makes L3's "first divergent decision" possible at all**, and it is worth
   * being explicit about why, because the obvious reading of §3.1 is that localization comes free.
   * It does not: localizing a divergence needs the *old* trace, and re-running the entry today
   * produces only the new one. The committed final hash says "this game changed" and nothing more.
   * Committing the full trace would cost 69.7 KB per game (§2.7, measured, against a 30-60 KB
   * estimate) - the wrong thing to commit. A checkpoint every 25 decisions costs ~12 hashes per
   * game, under 800 bytes, and brackets the first divergence to a 25-decision window that
   * `--explain` then prints from a diagnostics re-run.
   *
   * **Not compared.** A checkpoint mismatch adds no sensitivity over `moveTraceHash` - the chain is
   * rolling, so any earlier divergence necessarily moves the final hash - and comparing them would
   * turn one honest mismatch row into twelve. They are read only by the triage path.
   */
  traceCheckpoints: ReadonlyArray<RegressionTraceCheckpoint>;
};

/** One sampled link of the move-trace hash chain: the rolling hash after `decisionIndex` decisions. */
export type RegressionTraceCheckpoint = {decisionIndex: number; hash: string};

/**
 * Decisions between committed trace checkpoints. 25 is a budget choice, not a measured one: at the
 * ~296 decisions per 2p game the AC-1 run measured, it is ~12 checkpoints per game and under 800
 * bytes, so a 200-game corpus spends ~160 KB to buy §3.1's localization. Changing it changes the
 * meaning of every committed entry, so it is a rebaseline (§3.5), not a tuning knob.
 */
export const TRACE_CHECKPOINT_INTERVAL = 25;

/**
 * The end-of-game numbers this suite compares, per seat. Everything except the two identity fields
 * is `Pick`ed straight from {@link MatchSeatOutcome} - bullet 1's schema, reused rather than
 * restated, so the two can never disagree about what `vpBreakdown` means.
 *
 * **Two of `MatchSeatOutcome`'s fields are deliberately absent**, and the reason is the same in
 * both cases - they are informative in a rating corpus and noise in a regression comparison:
 *
 * - `marginToNext` is a function of the other seats' `victoryPoints`, already compared here, so it
 *   can only ever fire as a second row about the same event.
 * - `victoryPointsByGeneration` is a per-generation array. A one-generation shift in *tempo* that
 *   ends at an identical score is a real thing, but it moves `moveTraceHash` too, and as a compared
 *   field it would report a 12-element array diff where the trace hash already said "this game
 *   changed". It stays available on the match runner's own records for M3's tuning, which is the
 *   consumer bullet 1 added it for.
 */
export type RegressionSeatSemantics =
  Pick<MatchSeatRecord, 'seat' | 'slot' | 'agent' | 'agentVersion'> &
  Pick<MatchSeatOutcome,
    'placement' | 'isWinner' | 'victoryPoints' | 'megaCredits' | 'terraformRating' |
    'vpBreakdown' | 'corporations' | 'preludes' | 'projectCards'>;

/** The game-level semantics: the two things that are not per-seat. */
export type RegressionGameSemantics = {
  seats: ReadonlyArray<RegressionSeatSemantics>;
  claimedMilestones: ReadonlyArray<MatchMilestoneRecord>;
  fundedAwards: ReadonlyArray<MatchAwardRecord>;
};

/**
 * What this game exercises, derived from the `moves` tier **once, at generation time**, and never
 * recomputed (§2.7, §3.3).
 *
 * **Not compared, and the reason is the budget.** Recomputing coverage on a verify run means
 * recording the move list on every entry of every run - 69.7 KB per game and the instrumentation
 * cost with it - against a suite that has to finish in five minutes (§3.8). So coverage is
 * *provenance about what the entry is pinned for*, feeding the S3 coverage record; a change in what
 * a game covers necessarily moves the trace hash and the semantic fields anyway, so nothing is lost
 * from the *detection* side by not comparing it.
 *
 * Cards played are not here because they are already in each seat's `projectCards`, and milestones
 * and awards because they are in {@link RegressionGameSemantics}. What is left is exactly the two
 * things recoverable from nowhere else - and, not coincidentally, the two §2.3 names as needing an
 * end-to-end witness: the City standard project, and card *actions*.
 */
export type RegressionEntryCoverage = {
  /**
   * Where these lists came from. **`'not-derived'` and "empty" are different answers**, and
   * conflating them is the same error bullet 3's hazard H9 names (an unestimable quantity printed
   * as `NaN` rather than as its reason): a game that used no standard projects and a game nobody
   * measured both produce `[]`, and only one of them is a coverage fact. Unit A's smoke corpus is
   * `'not-derived'` because it runs no `moves`-tier survey; Unit C's corpus is `'moves-tier'`.
   */
  source: 'moves-tier' | 'not-derived';
  /** Standard projects executed in this game, by their Engine card names. */
  standardProjects: ReadonlyArray<CardName>;
  /** Cards whose `action()` was taken at least once - **not** cards played. Prediction 5's subject. */
  cardActions: ReadonlyArray<CardName>;
};

/**
 * One pinned reference game.
 *
 * **`why` is not decoration.** It is what stops a future session deleting a game it does not
 * understand, and it is the first field a human reads when the suite goes red. Every pinned game
 * carries one sentence naming what it covers - an entry without one is not finished work, and
 * `corpus.ts` refuses to save it.
 */
export type L2GameEntry = {
  layer: 'l2';
  identity: RegressionEntryIdentity;
  fingerprints: RegressionFingerprints;
  semantics: RegressionGameSemantics;
  coverage: RegressionEntryCoverage;
  /** One sentence: what this game is pinned for. Required; see the type doc. */
  why: string;
};

/** Every entry shape, discriminated on `layer` - §3.1's boundary, as a type. */
export type RegressionEntry = L1FixtureResult | L2GameEntry;

/**
 * The runtime half of the layer boundary, for entries that arrived as JSON and are therefore
 * `L2GameEntry` only by assertion. Cheap, and it turns "an L1 result reached L2's diff" from a
 * confusing per-field mismatch report into one sentence naming the mistake.
 */
export function assertL2Entry(entry: RegressionEntry, context: string): asserts entry is L2GameEntry {
  if (entry.layer !== 'l2') {
    throw new Error(
      `${context}: this is an '${entry.layer}' entry and L2's machinery only compares reference games. ` +
      'L1 reference positions are mocha fixtures asserting Engine behaviour at the pin; they have no ' +
      'fingerprints, no seeds and no agent, and they survive every agent change (§3.1). Run them with ' +
      "`npm run regression -- --layer l1` or with `npm test`.");
  }
}

// ---------------------------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------------------------

/**
 * One agent version's pinned games. **Sections are how §3.6's inheritance rule is structural
 * rather than remembered:** a new agent version adds a section and invalidates nothing, because
 * nothing outside its own section refers to it.
 *
 * What a new version *does* inherit is the obligation that the **frozen** baselines' sections still
 * pass - that is the check that matters at a promotion gate and the one nothing does today (§2.1).
 * What it does not inherit is L2 entries of its own: a new version has no history to regress
 * against, so it gets a section generated once, at promotion, from a freshly allocated R sub-range,
 * and frozen.
 */
export type RegressionSection = {
  agent: string;
  agentVersion: string;
  /** `random-legal@1` and `greedy-1ply@1` are the two frozen baselines (`agent/CLAUDE.md` §6). */
  frozen: boolean;
  /** ISO date the section was generated. Provenance; never compared. */
  recordedAt: string;
  /** The R-block group range this section occupies, for the S9 audit. Inclusive. */
  groupRange: {from: number; to: number};
  entries: ReadonlyArray<L2GameEntry>;
};

/**
 * A committed L2 corpus. `header` is {@link CorpusHeader} verbatim (H9) - the Engine **pin** is
 * compared, `agentCommit`/`nodeVersion` are recorded and deliberately not, so a Node upgrade
 * surfaces as a fingerprint mismatch naming the moved entries rather than as a blanket refusal.
 * That design decision is `determinism/corpus.ts`'s and this bullet inherits it verbatim (§2.2).
 */
export type RegressionCorpus = {
  header: CorpusHeader;
  suiteVersion: string;
  sections: ReadonlyArray<RegressionSection>;
};

// ---------------------------------------------------------------------------------------------
// Comparison output - the thing L3 reads
// ---------------------------------------------------------------------------------------------

/**
 * Which half of the record a moved field belongs to. **This grouping is L3** (§3.3): "the move trace
 * differs but every VP component is identical" and "greenery VP moved by 2" are different events
 * with different responses, and a report that cannot tell them apart is a report that gets read as
 * a count of failures.
 */
export type RegressionFieldGroup = 'fingerprint' | 'semantics';

/** One field that moved, with both values, addressed by a dotted path into the entry. */
export type RegressionFieldDiff = {
  group: RegressionFieldGroup;
  /** e.g. `fingerprints.moveTraceHash`, `semantics.seats[1].vpBreakdown.greenery`. */
  path: string;
  expected: unknown;
  actual: unknown;
};

/** One entry's comparison. `diffs` empty means it matched. */
export type RegressionEntryDiff = {
  identity: RegressionEntryIdentity;
  /** The pinned entry's `why`, carried into the report so a red line explains itself in place. */
  why: string;
  diffs: ReadonlyArray<RegressionFieldDiff>;
  /** Present when the re-run threw rather than producing a fingerprint. */
  failure?: {errorClass: string; message: string};
};

/**
 * The determinism corpus's own line (§3.9). The committed 300 fingerprints are **invoked, not
 * absorbed**: this suite runs `verifyCorpus` over them and reports the result beside its own, and
 * it does not move the file, regenerate it, or reimplement it. `npm run determinism -- --verify`
 * keeps working unchanged. What is being consolidated is *where you have to remember to run it*,
 * not *what it is*.
 */
export type DeterminismCorpusResult = {
  status: 'ok' | 'failed' | 'skipped';
  configsChecked: number;
  mismatches: number;
  /** Why it was skipped (`--no-determinism`, or the file is absent). */
  note?: string;
  durationMs: number;
};

export type L2LayerResult = {
  layer: 'l2';
  status: 'ok' | 'failed' | 'empty';
  /** One per section actually run, in corpus order. */
  sections: ReadonlyArray<L2SectionResult>;
  determinismCorpus: DeterminismCorpusResult;
  durationMs: number;
};

export type L2SectionResult = {
  agent: string;
  agentVersion: string;
  frozen: boolean;
  entriesChecked: number;
  /** Entries with at least one diff or a failure. */
  entriesMoved: number;
  /** Per compared field path, how many entries moved it - the input to `fieldsMoved` in the ledger. */
  fieldsMoved: Readonly<Record<string, number>>;
  diffs: ReadonlyArray<RegressionEntryDiff>;
};

/** The whole suite's verdict. The CLI exits non-zero iff `status` is `'failed'`. */
export type RegressionRunResult = {
  status: 'ok' | 'failed';
  l1?: L1LayerResult;
  l2?: L2LayerResult;
  durationMs: number;
};
