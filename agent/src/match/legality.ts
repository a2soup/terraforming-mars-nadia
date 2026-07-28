import {AgentEntry, withTemporaryAgent} from '../agents/registry';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
import {EmbeddedResponder} from '../driver/responder';
import {replay} from '../determinism/replay';
import {ReplayConfig} from '../determinism/types';
import {NeutralityMismatch, NeutralityReport} from '../legality/instrumentationCheck';
import {runLegalityBatch} from '../legality/run';
import {GameCounters, SubmissionMonitor} from '../legality/submissionMonitor';
import {CauseTally, LegalityGameConfig} from '../legality/types';
import {resolveMatchSpec} from './pairing';
import {runMatchConfigs} from './runner';
import {MatchGameConfig, MatchGameRecord, MatchLegalityCounters, ResolvedMatchSpec} from './types';

/**
 * **The absorbed AC-1 legality accounting** (Milestone 2 bullet 1, Unit B; the decision is settled
 * in agent/docs/Milestone2_Bullet1_Prompts.md §4.6).
 *
 * The standing caveat in `agent/CLAUDE.md` §6 requires the AC-1 legality battery to be re-run
 * against every agent version promoted at the end of M3, M4, M5 and M6. Rather than keep
 * `agent/src/legality/` as a parallel runner that plays its own games, the match runner carries the
 * accounting and an AC-1 re-run becomes **a mode of a match**: one lineup, the pre-committed
 * composition, `--legality`. The consolidation is sound because the two runners already do the same
 * thing (create a game from a seed pair, drive it with `runGame`, record completion and fallbacks,
 * yield between games, survive failures), and every promoted version has to be measured for
 * strength anyway.
 *
 * **"Absorbed" means the accounting moves, not that it relaxes, and that is where the work is.**
 * The driver's `onFallback` counters the match record already carries
 * (`fallbacksAfterRejection`/`fallbacksAfterThrow`) are *not* AC-1's accounting. `onFallback` cannot
 * see a third population - the FR-9 fallback's own rejected `'or'`-branch probes
 * (`resubmitConservatively`, `driver/embeddedDriver.ts`) - and a "zero illegal moves" claim that
 * silently omits a population of rejected submissions is, in `legality/submissionMonitor.ts`'s own
 * words, *an accounting choice presented as a result*. The strict denominator comes from wrapping
 * `Player.prototype.process`.
 *
 * So this module **reuses {@link SubmissionMonitor} verbatim** - imports it, does not reimplement
 * it, does not modify it. {@link MatchLegalityMode} is deliberately thin: a counter mapping, the
 * per-game reset, and one place that documents that the match runner installs exactly *one* monitor.
 * Any temptation to write a second, "match-shaped" monitor should be read as the temptation to have
 * two definitions of "an illegal move", which is the outcome §4.6 exists to prevent.
 *
 * **`agent/src/legality/` is not deleted by this bullet.** It is the artifact-of-record for the
 * Milestone 1 result (docs/AC1_Legality_Run.md) and it is this module's oracle: criterion R8 is an
 * equivalence against it ({@link compareLegalityAccounting}). Retiring it, if ever, is a decision
 * for whichever milestone first runs an AC-1 re-run through the match runner in anger.
 *
 * **The caveat that is the reason the caveat exists.** The rationale offered for absorbing was that
 * a legality regression is unlikely. The Milestone 1 evidence argues the other way: the AC-1 run
 * *found a real defect* (the `initialCards` budget coupling, 59 rejected submissions at ~1 per 25
 * games) that had hidden behind the FR-9 fallback since bullet 3 and was invisible at 20-game scale.
 * Consolidating the runners is a good call on its own merits. It is **not** a reason to run fewer
 * games, to sample rather than instrument every submission, or to treat a clean result as assumable.
 */

// ---------------------------------------------------------------------------------------------
// The mode itself
// ---------------------------------------------------------------------------------------------

export const EMPTY_LEGALITY_COUNTERS: MatchLegalityCounters = {
  submissions: 0,
  rejectedResponder: 0,
  rejectedFallbackProbe: 0,
  responderThrows: 0,
};

/**
 * The four counter names AC-1 is adjudicated on, in one place, so {@link mergeLegalityCounters},
 * {@link compareLegalityAccounting} and Unit C's pool merge cannot drift apart by one field.
 */
export const LEGALITY_COUNTER_NAMES: ReadonlyArray<keyof MatchLegalityCounters> = [
  'submissions',
  'rejectedResponder',
  'rejectedFallbackProbe',
  'responderThrows',
];

/**
 * The monitor's {@link GameCounters} as the match record carries them. A straight rename-free copy
 * today; it exists so that if either shape ever gains a field, the compiler names the place where
 * the two have to be reconciled instead of one of them silently going unrecorded.
 */
export function toMatchLegalityCounters(counters: GameCounters): MatchLegalityCounters {
  return {
    submissions: counters.submissions,
    rejectedResponder: counters.rejectedResponder,
    rejectedFallbackProbe: counters.rejectedFallbackProbe,
    responderThrows: counters.responderThrows,
  };
}

/**
 * **The merge semantics Unit C's process pool implements** (§4.6: the monitor is per-process global
 * state, so each child installs its own and the parent merges). Specified here rather than left to
 * the pool, so there is one definition of what merging means.
 *
 * Counters **sum**. That is the only associative, order-independent choice, and order independence
 * is what makes a pooled artifact comparable to a single-process one at all (criterion R6): the
 * parent must not be able to change the totals by finishing shards in a different order.
 */
export function mergeLegalityCounters(
  parts: ReadonlyArray<MatchLegalityCounters | undefined>,
): MatchLegalityCounters {
  const merged = {...EMPTY_LEGALITY_COUNTERS};
  for (const part of parts) {
    if (part === undefined) {
      continue;
    }
    for (const name of LEGALITY_COUNTER_NAMES) {
      merged[name] += part[name];
    }
  }
  return merged;
}

/**
 * The identity of a cause tally: `(source, decision type, error class, normalized signature)`.
 *
 * **This must stay in step with `SubmissionMonitor`'s own internal key** (submissionMonitor.ts's
 * `tally()`), because a merge that keyed on less would silently fuse two genuinely different causes
 * into one row and criterion L6's "every distinct cause is named, never bucketed into other" would
 * quietly stop holding across a pooled run. `legality.spec.ts` pins the two together by merging a
 * single monitor's own tallies and asserting nothing collapses.
 */
export function causeTallyKey(tally: CauseTally): string {
  return `${tally.source}|${tally.decisionType}|${tally.errorClass}|${tally.signature}`;
}

/**
 * Merges cause tallies from several processes: **group by {@link causeTallyKey}, sum `count`, keep
 * one representative**. The representative is the first one encountered, which is arbitrary and
 * deliberately so - `representative` exists to keep `causeSignature`'s normalization auditable
 * (`legality/causes.ts`), and any one incident's verbatim message does that equally well. Sorted
 * most-frequent-first with the signature as a tiebreak, matching `SubmissionMonitor.causeTallies`,
 * so a merged list and an unmerged one are byte-comparable.
 */
export function mergeCauseTallies(
  parts: ReadonlyArray<ReadonlyArray<CauseTally> | undefined>,
): ReadonlyArray<CauseTally> {
  const merged = new Map<string, CauseTally>();
  for (const part of parts) {
    for (const tally of part ?? []) {
      const key = causeTallyKey(tally);
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, {...tally});
      } else {
        existing.count += tally.count;
      }
    }
  }
  return [...merged.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}

/**
 * The match runner's legality mode: one {@link SubmissionMonitor}, per process, with the per-game
 * reset and the counter mapping the match record wants.
 *
 * Thin on purpose. Everything difficult about this instrument - the attribution rule (the first
 * `process()` after the responder returns is the responder's, everything after is a fallback probe),
 * why it is a prototype wrapper rather than a driver hook, and why the third population exists at
 * all - is documented in `legality/submissionMonitor.ts` and is not restated or reinterpreted here.
 * Read that file before changing anything in this one.
 */
export class MatchLegalityMode {
  private readonly monitor = new SubmissionMonitor();

  public install(): void {
    this.monitor.install();
  }

  public uninstall(): void {
    this.monitor.uninstall();
  }

  public get installed(): boolean {
    return this.monitor.installed;
  }

  /** Resets the per-game counters. Cause tallies deliberately accumulate across the whole run. */
  public startGame(): void {
    this.monitor.startGame();
  }

  public get gameCounters(): MatchLegalityCounters {
    return toMatchLegalityCounters(this.monitor.gameCounters);
  }

  public get causeTallies(): ReadonlyArray<CauseTally> {
    return this.monitor.causeTallies;
  }

  /**
   * Wraps a responder so the monitor can see the decision boundary. Pass-through: the driver cannot
   * distinguish the result from the responder handed in.
   */
  public observeResponder(inner: EmbeddedResponder): EmbeddedResponder {
    return this.monitor.observeResponder(inner);
  }
}

// ---------------------------------------------------------------------------------------------
// Criterion R8: the absorbed accounting is the same accounting
// ---------------------------------------------------------------------------------------------

/**
 * Every field {@link compareLegalityAccounting} compares. The first six are exactly what criterion
 * R8 names ("submissions, `rejectedResponder`, `rejectedFallbackProbe`, `responderThrows`,
 * `fallbacksAfterRejection`, `fallbacksAfterThrow`, completion"); `decisions` and `generation` are
 * added as *witnesses that the two runners played the same game* - if they ever disagree, the
 * counter comparison above them was comparing two different games and means nothing.
 */
export const EQUIVALENCE_FIELDS = [
  'submissions',
  'rejectedResponder',
  'rejectedFallbackProbe',
  'responderThrows',
  'fallbacksAfterRejection',
  'fallbacksAfterThrow',
  'completed',
  'decisions',
  'generation',
] as const;

export type EquivalenceField = typeof EQUIVALENCE_FIELDS[number];

/**
 * Which instrumentation stack the match side ran with. Both are compared, because they are two
 * different claims:
 *
 * - `summary` - legality mode alone. The monitor is the *only* wrapper installed, which is exactly
 *   the AC-1 runner's own instrumentation, so this variant asks "did moving the accounting change
 *   it?".
 * - `trace` - legality mode plus the history recorder's own `Player.prototype.process` wrapper
 *   nested around it (`match/history.ts`). This variant asks the separate question "does recording
 *   the history change what the accounting counts?" - and it is the one that would catch a
 *   mis-ordered install or a double count.
 */
export type EquivalenceVariant = 'summary' | 'trace';

export type LegalityEquivalenceMismatch = {
  config: LegalityGameConfig;
  variant: EquivalenceVariant;
  field: EquivalenceField;
  /** `runLegalityBatch`'s value - the Milestone 1 artifact-of-record's own accounting. */
  legalityRunner: number;
  matchRunner: number;
};

export type LegalityEquivalenceReport = {
  configsChecked: number;
  /** Every mismatch found. **Any entry is a blocking failure of R8**, not a rounding difference. */
  mismatches: ReadonlyArray<LegalityEquivalenceMismatch>;
  /** Run totals from the oracle, so a passing comparison is visibly a comparison of real numbers. */
  totals: Record<EquivalenceField, number>;
  /**
   * True when the merged cause tallies agree on both sides, key for key and count for count. Not
   * one of R8's named counters, but the same question one level finer: the same submissions,
   * rejected for the same reasons.
   */
  causeTalliesAgree: boolean;
  legalityCauses: ReadonlyArray<CauseTally>;
  matchCauses: ReadonlyArray<CauseTally>;
};

/**
 * **Criterion R8.** Plays each config through `runLegalityBatch` (the Milestone 1 runner, the
 * oracle) and through the match runner in legality mode, and requires **identical** values for every
 * field in {@link EQUIVALENCE_FIELDS}. Any difference is a blocking failure: it means the absorption
 * changed what the number counts, which is the one outcome §4.6 exists to prevent.
 *
 * **Making the two runners play the same game, without disabling anything.** They do not seat
 * agents the same way. `runLegalityBatch` builds *one* `randomLegalAgent(createAgentRandom(agentSeed))`
 * and lets every player draw from that single RNG stream; the match runner builds one agent **per
 * seat** from that seat's own agent seed (§4.1 - agent seeds travel with the lineup slot). Two
 * agents seeded identically are not the same thing as one agent shared: the streams are consumed in
 * a different order, so the games diverge at the first decision. Comparing counters across two
 * *different games* would compare noise.
 *
 * The bridge is a fact about the agent rather than a substitution in the runner: `randomLegalAgent`
 * holds **no state but its `AgentRandom`**, so *n* per-seat agents sharing one `AgentRandom` are
 * behaviourally identical to one shared agent. {@link playThroughMatchRunner} therefore seats a
 * temporary registry entry whose `create` hands every seat an agent bound to the same stream
 * (`agents/registry.ts`'s `withTemporaryAgent`). The two runners play the same game - same engine
 * seed, same decisions, same submissions - while the match runner's loop, its per-seat construction
 * and its **seat router all run for real**.
 *
 * **This closed a real gap in the evidence.** The first version of this check substituted the
 * router away wholesale, which made the games identical but meant the comparison never exercised
 * the router, and left the match record's own `decisions` counter 0 by construction (it was read
 * from the history instead). So no single check compared the *real* per-seat match runner against
 * the Milestone-1 oracle: this one covered the accounting on a path that was not the real one, and
 * {@link checkMatchNeutrality} covered the real path but only against another match run, never
 * against the oracle. Since a promotion gate rests on this equivalence (§4.6), that composition was
 * weaker than it looked. It is now one direct measurement, and `decisions` is compared from the
 * router's own counter on both variants. {@link checkMatchNeutrality} remains, and is still worth
 * having: it asks the different question of whether instrumenting a game changes it.
 */
export async function compareLegalityAccounting(
  configs: ReadonlyArray<LegalityGameConfig>,
  options: {variants?: ReadonlyArray<EquivalenceVariant>} = {},
): Promise<LegalityEquivalenceReport> {
  const variants = options.variants ?? ['summary', 'trace'];
  const mismatches: Array<LegalityEquivalenceMismatch> = [];
  const totals = Object.fromEntries(EQUIVALENCE_FIELDS.map((field) => [field, 0])) as Record<EquivalenceField, number>;
  const legalityCauseParts: Array<ReadonlyArray<CauseTally>> = [];
  const matchCauseParts: Array<ReadonlyArray<CauseTally>> = [];

  for (const config of configs) {
    const oracleReport = await runLegalityBatch([config], {silenceRoutineLogs: true, heapSampleEvery: Number.MAX_SAFE_INTEGER});
    const [oracleGame] = oracleReport.games;
    const oracle: Record<EquivalenceField, number> = {
      submissions: oracleGame.submissions,
      rejectedResponder: oracleGame.rejectedResponder,
      rejectedFallbackProbe: oracleGame.rejectedFallbackProbe,
      responderThrows: oracleGame.responderThrows,
      fallbacksAfterRejection: oracleGame.fallbacksAfterRejection,
      fallbacksAfterThrow: oracleGame.fallbacksAfterThrow,
      completed: oracleGame.completed ? 1 : 0,
      decisions: oracleGame.decisions,
      generation: oracleGame.generation,
    };
    legalityCauseParts.push(oracleReport.causes);
    for (const field of EQUIVALENCE_FIELDS) {
      totals[field] += oracle[field];
    }

    for (const variant of variants) {
      const {record, causes} = await playThroughMatchRunner(config, variant);
      matchCauseParts.push(causes);
      const observed = observedFields(record, variant);
      for (const field of EQUIVALENCE_FIELDS) {
        // `decisions` is only observable on the `trace` variant (see the doc comment): at `summary`
        // tier no history is recorded and the router that would have counted them was replaced.
        if (observed[field] === undefined) {
          continue;
        }
        if (observed[field] !== oracle[field]) {
          mismatches.push({config, variant, field, legalityRunner: oracle[field], matchRunner: observed[field] as number});
        }
      }
    }
  }

  // The cause tallies are merged with the very function Unit C's pool will use, so a bug in the
  // merge semantics shows up here rather than for the first time inside a parallel run.
  //
  // `matchCauseParts` holds one entry per (config, variant) in that nested order, so the entries for
  // variant `v` are every `variants.length`-th one starting at `v`. Each variant is merged and
  // compared to the oracle separately: merging both variants together would play every game twice
  // and double every count, which would look exactly like a real disagreement.
  const legalityCauses = mergeCauseTallies(legalityCauseParts);
  const perVariant = variants.map((_variant, offset) =>
    mergeCauseTallies(matchCauseParts.filter((_part, index) => index % variants.length === offset)));

  return {
    configsChecked: configs.length,
    mismatches,
    totals,
    causeTalliesAgree: perVariant.every((causes) => sameCauses(legalityCauses, causes)),
    legalityCauses,
    matchCauses: perVariant[perVariant.length - 1] ?? [],
  };
}

function sameCauses(a: ReadonlyArray<CauseTally>, b: ReadonlyArray<CauseTally>): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((tally, index) => causeTallyKey(tally) === causeTallyKey(b[index]) && tally.count === b[index].count);
}

function observedFields(record: MatchGameRecord, _variant: EquivalenceVariant): Partial<Record<EquivalenceField, number>> {
  const counters = record.legality ?? EMPTY_LEGALITY_COUNTERS;
  return {
    submissions: counters.submissions,
    rejectedResponder: counters.rejectedResponder,
    rejectedFallbackProbe: counters.rejectedFallbackProbe,
    responderThrows: counters.responderThrows,
    fallbacksAfterRejection: record.fallbacksAfterRejection,
    fallbacksAfterThrow: record.fallbacksAfterThrow,
    completed: record.completed ? 1 : 0,
    generation: record.generation,
    // The **router's own** count, on both variants. This used to be readable only from the history
    // (`trace` tier), because the comparison substituted the router away and left this counter 0 by
    // construction. Now that the router runs for real, this is the direct like-for-like with the
    // oracle's own `decisions`: both increment before invoking the responder, so a decision the
    // responder threw on counts on both sides.
    decisions: record.decisions,
  };
}

/**
 * The name the shared-stream agent is registered under for the duration of one comparison. Chosen
 * so it cannot collide with a real roster entry, and so a stray occurrence in an artifact is
 * obviously not a real agent.
 */
const SHARED_STREAM_AGENT = 'r8-shared-stream-probe';

/**
 * One config, played by the match runner's **own loop, own per-seat construction and own seat
 * router** - nothing substituted - on a game made identical to the oracle's by seating agents that
 * share one RNG stream. See {@link compareLegalityAccounting} for why identity is required, and
 * `agents/registry.ts`'s `withTemporaryAgent` for why sharing a stream is sufficient.
 */
async function playThroughMatchRunner(
  config: LegalityGameConfig,
  variant: EquivalenceVariant,
): Promise<{record: MatchGameRecord; causes: ReadonlyArray<CauseTally>}> {
  const matchConfig: MatchGameConfig = {
    groupIndex: 0,
    permutationIndex: 0,
    players: config.players,
    engineSeed: config.engineSeed,
    seating: identitySeating(config.players),
    // Every slot on the oracle's single seed. The agent below is what makes them one *stream*
    // rather than n identically-seeded ones; this keeps the recorded seeds honest about which
    // seed produced the game.
    agentSeeds: new Array(config.players).fill(config.agentSeed),
    lineup: new Array(config.players).fill(SHARED_STREAM_AGENT),
  };

  // One stream for the whole game, handed to every seat - see the registry's doc for why this is
  // exactly the oracle's single-agent behaviour. Built per game, so consecutive configs in a
  // comparison do not bleed into one another.
  const shared = createAgentRandom(config.agentSeed);
  const entry: AgentEntry = {
    name: SHARED_STREAM_AGENT,
    version: '0-probe',
    description: 'R8 equivalence probe: every seat draws from one shared RNG stream (not a real agent).',
    create: () => randomLegalAgent(shared),
  };

  const capture = {historyTier: variant, legality: true} as const;
  return withTemporaryAgent(entry, async () => {
    // Resolved *inside* the registration: `resolveMatchSpec` looks every lineup name up in the
    // registry to record its version, so hoisting this out of the callback throws before the probe
    // agent exists.
    const spec = resolveMatchSpec({
      players: config.players,
      lineup: new Array(config.players).fill(SHARED_STREAM_AGENT),
      groups: 1,
    });
    const report = await runMatchConfigs([matchConfig], spec, {capture, silenceRoutineLogs: true});
    return {record: report.games[0], causes: report.instrumentation?.causes ?? []};
  });
}


function identitySeating(players: number): ReadonlyArray<number> {
  return [...Array(players).keys()];
}

// ---------------------------------------------------------------------------------------------
// Criterion R8, second half: the instrumentation does not perturb the games it measures
// ---------------------------------------------------------------------------------------------

/**
 * **The neutrality check `legality/instrumentationCheck.ts` performs, applied to the match runner's
 * legality mode.** Same comparison, same three observables, same like-for-like correction:
 *
 * - play each config through the **uninstrumented** determinism harness (`replay()`, which bullet 6
 *   established reproduces exactly for a fixed config), and
 * - through the **fully instrumented** match runner, and compare decisions resolved, FR-9 fallbacks
 *   fired, and generation reached.
 *
 * `replay()`'s own wrapper records its trace step *after* the responder returns, so a decision the
 * responder **threw** on (roughly 5-6 per game) never reaches its `decisions` count while the
 * instrumented runner does count it. The subtraction below is that correction - the same one
 * `checkInstrumentationNeutrality` documents having discovered the hard way, reused rather than
 * rediscovered.
 *
 * **Why not simply call `checkInstrumentationNeutrality`.** It hardwires `runLegalityBatch` as the
 * instrumented side, and `agent/src/legality/` is not modified by this bullet (§9), so it cannot be
 * parameterized. Its types are imported here rather than redeclared, so the two reports stay
 * comparable, and its findings are cited rather than re-derived. Like R8's counter comparison, this
 * uses the shared-stream device - `replay()` also drives every player from one agent stream, so a
 * per-seat match game is a *different game* and could not be compared to it at all.
 */
export async function checkNeutralityAgainstReplay(configs: ReadonlyArray<ReplayConfig>): Promise<NeutralityReport> {
  const mismatches: Array<NeutralityMismatch> = [];

  for (const config of configs) {
    const clean = replay(config);
    const {record} = await playThroughMatchRunner(config, 'trace');
    const decisions = record.history?.decisions ?? 0;
    const observed = {
      // Like-for-like with replay()'s own definition - see the doc comment.
      decisions: decisions - (record.legality?.responderThrows ?? 0),
      fallbacks: record.fallbacksAfterRejection + record.fallbacksAfterThrow,
      generation: record.generation,
    };
    for (const field of ['decisions', 'fallbacks', 'generation'] as const) {
      if (clean[field] !== observed[field]) {
        mismatches.push({config, field, clean: clean[field], instrumented: observed[field]});
      }
    }
  }

  return {configsChecked: configs.length, mismatches};
}

export type MatchNeutralityMismatch = {
  groupIndex: number;
  permutationIndex: number;
  /** The game-record field that differed between the instrumented and uninstrumented runs. */
  field: string;
  clean: string;
  instrumented: string;
};

export type MatchNeutralityReport = {
  gamesChecked: number;
  mismatches: ReadonlyArray<MatchNeutralityMismatch>;
};

/**
 * Fields an instrumented run is *expected* to differ on: the two the instrument exists to add, and
 * the one the artifact already declares as timing (`match/artifact.ts`).
 */
const INSTRUMENT_ADDED_FIELDS: ReadonlyArray<keyof MatchGameRecord> = ['history', 'legality', 'durationMs'];

/**
 * Neutrality on **real match games**, with the per-seat router in place: play the same configs twice
 * - once with no instrument at all (`summary` tier, legality off, so `resolveInstrument` returns
 * nothing and not one wrapper is installed) and once with the full stack (`trace` tier plus legality
 * mode) - and require the two game records to be **identical field for field**, except for the
 * fields the instrument exists to add.
 *
 * This is a strictly stronger statement than the three-observable comparison against `replay()`, and
 * it is the check that covers what that one cannot: the seat router, the ranking, every VP and card
 * field, and the placement. A wrapper that perturbed a game would have to leave the entire
 * end-of-game record intact at every config to slip through. It is also cheap, needs no shared-stream
 * distortion, and is the natural regression guard to keep running as the instrument changes.
 */
export async function checkMatchNeutrality(
  configs: ReadonlyArray<MatchGameConfig>,
  spec: ResolvedMatchSpec,
): Promise<MatchNeutralityReport> {
  const clean = await runMatchConfigs(configs, spec, {
    capture: {historyTier: 'summary', legality: false},
    silenceRoutineLogs: true,
  });
  const instrumented = await runMatchConfigs(configs, spec, {
    capture: {historyTier: 'trace', legality: true},
    silenceRoutineLogs: true,
  });

  const mismatches: Array<MatchNeutralityMismatch> = [];
  for (const [index, cleanGame] of clean.games.entries()) {
    const instrumentedGame = instrumented.games[index];
    const fields = new Set([...Object.keys(cleanGame), ...Object.keys(instrumentedGame)]) as Set<keyof MatchGameRecord>;
    for (const field of fields) {
      if (INSTRUMENT_ADDED_FIELDS.includes(field)) {
        continue;
      }
      const before = JSON.stringify(cleanGame[field]);
      const after = JSON.stringify(instrumentedGame[field]);
      if (before !== after) {
        mismatches.push({
          groupIndex: cleanGame.groupIndex,
          permutationIndex: cleanGame.permutationIndex,
          field,
          clean: truncate(before),
          instrumented: truncate(after),
        });
      }
    }
  }

  return {gamesChecked: clean.games.length, mismatches};
}

function truncate(value: string | undefined): string {
  const text = value ?? '<undefined>';
  return text.length <= 200 ? text : `${text.slice(0, 200)}...`;
}
