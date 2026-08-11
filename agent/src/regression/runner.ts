import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {lookupAgent} from '../agents/registry';
import {ENGINE_PIN, buildHeader, loadCorpus, verifyCorpus} from '../determinism/corpus';
import {TraceStep} from '../determinism/types';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {permutationsFor} from '../match/pairing';
import {
  PlayedEntry,
  allEntries,
  assertCorpusComparable,
  buildRegressionCorpus,
  compareEntry,
  digestCorpus,
  entryKey,
  findEntry,
  normalizePath,
  playRegressionEntry,
  saveRegressionCorpus,
  sectionKey,
  tallyFieldsMoved,
  verifyEntry,
} from './corpus';
import {
  RebaselineEntry,
  RebaselineLedger,
  appendRebaseline,
  loadRebaselineLedger,
  saveRebaselineLedger,
  verifyLedgerChain,
} from './ledger';
import {
  DeterminismCorpusResult,
  L1FixtureResult,
  L1LayerResult,
  L2GameEntry,
  L2LayerResult,
  L2SectionResult,
  RegressionCorpus,
  RegressionEntryDiff,
  RegressionEntryIdentity,
  RegressionLayer,
  RegressionRunResult,
  RegressionTraceCheckpoint,
  TRACE_CHECKPOINT_INTERVAL,
} from './types';

/**
 * The suite: one command, three layers, a non-zero exit (Milestone 2, bullet 5, Unit A §5;
 * agent/docs/Milestone2_Bullet5_Prompts.md §3.8).
 *
 * ```bash
 * npm run regression                       # all layers, exits non-zero on any failure
 * npm run regression -- --layer l1         # fixtures only - seconds, no games
 * npm run regression -- --layer l2 --agent greedy-1ply@1
 * npm run regression -- --explain <entry>  # L3 triage for one failed entry
 * npm run regression -- --rebaseline --layer l2 --claim "..."
 * ```
 *
 * **Pre-committed budget: the full suite runs in <= 5 minutes on the compiled build, <= 20 minutes
 * under `tsx`** (§3.8). Everything the suite does is sized to fit that, not the reverse. A suite
 * that takes an hour is a suite that runs at the end of the project instead of at every gate, and
 * then it is an archive. If it goes over, the corpus gets cut - the budget does not get revised
 * (criterion S6).
 *
 * ---
 *
 * ## Three things this runner does that are easy to get wrong
 *
 * **The determinism corpus is invoked, not absorbed** (§3.9, hazard H1). L2 runs `verifyCorpus`
 * over the committed 300 fingerprints and reports it as its own line. It does not move the file,
 * regenerate it, or reimplement it, and `npm run determinism -- --verify` keeps working unchanged.
 * That corpus is the artifact-of-record for Milestone 1 bullet 6 and the oracle any future
 * comparison is made against; what is being consolidated is *where you have to remember to run it*,
 * not *what it is*.
 *
 * **It is the single biggest line in the suite, and Unit A could not measure it** (hazard H6/H10).
 * Four runs of the identical call on this host under `tsx` gave **11 s, 102 s, 114 s and 124 s** - an
 * 11x spread - and `sysctl vm.swapusage` explains it: 4.6 GB of 5.1 GB swap in use with 64 MB of
 * free RAM on an 8 GB machine. That is precisely the condition bullet 1 recorded against its
 * criterion R7 (*"the single-process baseline swung 4.3x within one session on an identical
 * spec"*), so **no number in this paragraph is a performance figure** and criterion S6's budget
 * cannot be adjudicated from this session. Unit C must time the full suite on an idle host, on the
 * compiled build, and check swap before believing the result. What is safe to say is ordering: 300
 * determinism configs cost more than a 10-game L2 corpus, so size L2 against whatever the
 * determinism line actually measures rather than against the whole budget.
 *
 * **L1 with no fixtures reports `empty`, not `ok`** - and does not fail. Both halves are deliberate.
 * Reporting `ok` would be the purest instance of this bullet's second failure mode (*"a suite that
 * has never refused anything is indistinguishable from a suite that works"*), so the status is
 * distinct and the line says so in words. Failing would paint the suite red for every session
 * between Unit A landing and Unit B's fixtures landing, and a layer that is red for three sessions
 * is a layer people learn to skip - which is hazard H7's mechanism one level up.
 *
 * **Yield between games** (hazard H8). `Game.gotoEndGame()` is unawaited async, so a synchronous
 * batch holds every finished game alive through its pending continuation - about 0.27 MB each,
 * measured. The verify loop is `async` and yields, exactly as `match/runner.ts` and
 * `legality/run.ts` do, and for the same reason.
 */

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * The repo root, found by walking up until a directory containing `agent/package.json` appears -
 * `match/artifact.ts`'s technique, for its reason: a fixed number of `..` is right only when
 * running from source, and the compiled build puts this module several directories deeper.
 */
export function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(directory, 'agent', 'package.json'))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return process.cwd();
    }
    directory = parent;
  }
}

export function agentRoot(): string {
  return path.join(repoRoot(), 'agent');
}

export function dataPath(file: string): string {
  return path.join(agentRoot(), 'docs', 'data', file);
}

/** Unit C's committed corpus. Absent until Unit C lands, which the runner reports rather than throws on. */
export const DEFAULT_CORPUS_FILE = 'regression_suite.json';
/** Unit A's ~10-game smoke corpus: a format for C to write against and something for D to mutate on day one. */
export const SMOKE_CORPUS_FILE = 'regression_smoke.json';
export const DETERMINISM_CORPUS_FILE = 'determinism_corpus.json';
export const REBASELINE_LEDGER_FILE = 'regression_rebaselines.json';

/** Unit B's reference positions. */
export function fixturesDir(): string {
  return path.join(agentRoot(), 'test', 'regression', 'fixtures');
}

// ---------------------------------------------------------------------------------------------
// L1 - reference positions
// ---------------------------------------------------------------------------------------------

/**
 * Runs Unit B's fixtures by spawning mocha over `agent/test/regression/fixtures/`.
 *
 * **A child process rather than an in-process mocha, deliberately.** L1 asserts *Engine* behaviour
 * through `tests/TestGame.ts`, which brings the Engine's own test bootstrap
 * (`tests/testing/setup.ts`) with it; loading that into a process that is also about to play 200
 * full games would put the Engine's test doubles and this suite's real games in one heap. The
 * subprocess costs about a second and buys a guarantee that the two layers cannot contaminate each
 * other - which matters more here than anywhere, because L1's whole claim is that it is
 * agent-independent.
 *
 * **`directory` is a parameter only so this path can be tested before Unit B exists.** It is the one
 * piece of Unit A that another unit hits first: if the mocha-JSON parsing below is wrong, the symptom
 * is L1 reporting `failed` with "mocha did not produce a JSON report" on the day thirteen correct
 * fixtures land, and the natural reading of that is that the fixtures are broken. `runner.spec.ts`
 * points it at a scratch directory holding one passing and one failing spec, so the parse, the
 * failure attribution and the count are all exercised now rather than then.
 */
export function runL1(directory: string = fixturesDir()): L1LayerResult {
  const started = Date.now();
  const specs = fs.existsSync(directory) ?
    fs.readdirSync(directory).filter((file) => file.endsWith('.spec.ts')) :
    [];

  if (specs.length === 0) {
    return {layer: 'l1', status: 'empty', fixtures: 0, failures: [], durationMs: Date.now() - started};
  }

  const result = spawnSync(process.execPath, [
    require.resolve('mocha/bin/mocha.js'),
    '--import=tsx',
    '--require', path.join(repoRoot(), 'tests', 'testing', 'setup.ts'),
    '--reporter', 'json',
    path.join(directory, '*.spec.ts'),
  ], {cwd: agentRoot(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});

  const report = parseMochaJson(result.stdout ?? '');
  if (report === undefined) {
    return {
      layer: 'l1',
      status: 'failed',
      fixtures: specs.length,
      failures: [{
        layer: 'l1',
        file: path.relative(agentRoot(), directory),
        title: 'mocha did not produce a JSON report',
        passed: false,
        message: (result.stderr ?? '').slice(-4_000) || `exit ${result.status}`,
      }],
      durationMs: Date.now() - started,
    };
  }

  const failures: ReadonlyArray<L1FixtureResult> = report.failures.map((failure) => ({
    layer: 'l1' as const,
    file: failure.file === undefined ? '<unknown>' : path.relative(agentRoot(), failure.file),
    title: failure.fullTitle,
    passed: false,
    message: failure.err?.message ?? 'no message',
  }));

  return {
    layer: 'l1',
    status: failures.length === 0 ? 'ok' : 'failed',
    fixtures: report.stats.tests,
    failures,
    durationMs: Date.now() - started,
  };
}

type MochaJsonReport = {
  stats: {tests: number; passes: number; failures: number};
  failures: ReadonlyArray<{fullTitle: string; file?: string; err?: {message?: string}}>;
};

/**
 * mocha's `json` reporter writes the report to stdout, but anything the specs themselves logged
 * lands there too - and the Engine logs an eviction line per finished game. So the report is found
 * as the last balanced top-level object rather than by parsing the whole stream.
 */
function parseMochaJson(stdout: string): MochaJsonReport | undefined {
  const start = stdout.indexOf('{\n  "stats"');
  const candidate = start === -1 ? stdout : stdout.slice(start);
  try {
    const parsed = JSON.parse(candidate) as MochaJsonReport;
    return parsed.stats === undefined ? undefined : parsed;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// L2 - reference games
// ---------------------------------------------------------------------------------------------

export type L2Options = {
  /** Only this section, as `name@version`. Defaults to every section in the corpus. */
  agent?: string;
  /** Skip the committed determinism corpus. **Not for a gate run** - see the field's use below. */
  skipDeterminism?: boolean;
  onProgress?: (checked: number, total: number, diff: RegressionEntryDiff) => void;
};

/**
 * Verifies every selected pinned game, plus the determinism corpus's own line.
 *
 * `skipDeterminism` exists for Unit D, which runs the suite once per mutation and does not need 300
 * random-legal games re-verified each time. It is off by default and the report says when it fired,
 * because a suite invocation that quietly checked less than the suite is the thing a gate cannot
 * afford to be handed.
 */
export async function runL2(corpus: RegressionCorpus, options: L2Options = {}): Promise<L2LayerResult> {
  const started = Date.now();
  ensureHeadlessEngine();
  assertCorpusComparable(corpus);

  const selected = options.agent === undefined ?
    corpus.sections :
    corpus.sections.filter((section) => sectionKey(section) === options.agent);
  if (options.agent !== undefined && selected.length === 0) {
    throw new Error(
      `no section '${options.agent}' in this corpus. It carries: ` +
      `${corpus.sections.map(sectionKey).join(', ') || '(none)'}.`);
  }

  const total = selected.reduce((count, section) => count + section.entries.length, 0);
  let checked = 0;
  const sections: Array<L2SectionResult> = [];

  for (const section of selected) {
    const diffs: Array<RegressionEntryDiff> = [];
    for (const entry of section.entries) {
      const diff = verifyEntry(entry);
      diffs.push(diff);
      checked++;
      options.onProgress?.(checked, total, diff);
      // Hazard H8: let the finished game's `gotoEndGame` continuation run before the next one starts.
      await yieldToEventLoop();
    }
    const moved = diffs.filter((diff) => diff.diffs.length > 0 || diff.failure !== undefined);
    sections.push({
      agent: section.agent,
      agentVersion: section.agentVersion,
      frozen: section.frozen,
      entriesChecked: diffs.length,
      entriesMoved: moved.length,
      fieldsMoved: tallyFieldsMoved(moved),
      diffs: moved,
    });
  }

  const determinismCorpus = options.skipDeterminism === true ?
    {status: 'skipped' as const, configsChecked: 0, mismatches: 0, note: '--no-determinism was passed', durationMs: 0} :
    runDeterminismCorpus();

  const failed = sections.some((section) => section.entriesMoved > 0) || determinismCorpus.status === 'failed';
  return {
    layer: 'l2',
    status: failed ? 'failed' : (total === 0 && determinismCorpus.status === 'skipped' ? 'empty' : 'ok'),
    sections,
    determinismCorpus,
    durationMs: Date.now() - started,
  };
}

/** §3.9: the committed 300, run as their own reported line and never regenerated here. */
export function runDeterminismCorpus(): DeterminismCorpusResult {
  const started = Date.now();
  const file = dataPath(DETERMINISM_CORPUS_FILE);
  if (!fs.existsSync(file)) {
    return {
      status: 'skipped',
      configsChecked: 0,
      mismatches: 0,
      note: `${file} is missing - it is Milestone 1 bullet 6's artifact-of-record and should be in the repo`,
      durationMs: Date.now() - started,
    };
  }
  const report = verifyCorpus(loadCorpus(file));
  return {
    status: report.mismatches.length === 0 ? 'ok' : 'failed',
    configsChecked: report.configsChecked,
    mismatches: report.mismatches.length,
    durationMs: Date.now() - started,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Silences the driver's per-fallback `console.warn` and the Engine's per-game eviction line for the
 * duration of `fn` - `match/runner.ts`'s hazard-H7 handling, adopted here with its precondition
 * intact: **silence the routine logs only together with the accounting.**
 *
 * The precondition holds. `fallbacks` is one of the six compared fingerprint fields, so a change in
 * how often the FR-9 fallback fires is a diff row whether or not it was printed - the log line
 * carries no information the record does not. Without this, a full run prints ~5.7 warnings per
 * game across 310 games, which is several thousand lines of noise around six lines of verdict.
 */
async function withRoutineLogsSilenced<T>(silence: boolean, fn: () => Promise<T>): Promise<T> {
  if (!silence) {
    return fn();
  }
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

/** The synchronous form, for the one-game triage path. Same rule, same precondition. */
export function silencingRoutineLogs<T>(fn: () => T): T {
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

// ---------------------------------------------------------------------------------------------
// L3 - triage
// ---------------------------------------------------------------------------------------------

/**
 * What `--explain` produces for one entry. **L3's whole job is to say *what* moved rather than
 * *that* something moved** (§3.1), which is why this is three separate readings of the same
 * comparison rather than one verdict.
 */
export type RegressionExplanation = {
  key: string;
  why: string;
  /** Every moved field, grouped. Empty when the entry currently matches. */
  diffs: ReadonlyArray<{group: string; path: string; expected: unknown; actual: unknown}>;
  /**
   * The first decision at which the current run's move trace leaves the committed one, bracketed to
   * a {@link TRACE_CHECKPOINT_INTERVAL}-decision window by the committed checkpoints, plus the
   * current run's steps inside that window.
   *
   * `undefined` when the trace did not move, or when the pinned entry carries no checkpoints (an
   * entry generated without diagnostics - the report says which, because "we cannot localize" and
   * "there is nothing to localize" are different answers).
   */
  firstDivergence?: {
    /** The last checkpoint the two runs agreed on, or `-1` if they disagreed from the start. */
    lastAgreedDecision: number;
    /** The first checkpoint they disagreed on, or `undefined` if the disagreement is past the last one. */
    firstDisagreedDecision?: number;
    /** The current run's steps in the bracket, so the report names actual decisions, not indices. */
    window: ReadonlyArray<TraceStep>;
  };
  /** Present when localization was impossible, saying why. */
  localizationNote?: string;
};

/**
 * Re-runs one entry with the full trace captured and reports what moved.
 *
 * **Localization needs the old trace, and the corpus does not commit one** - 69.7 KB per game (§2.7)
 * is the wrong thing to commit. What it commits is the rolling hash every
 * {@link TRACE_CHECKPOINT_INTERVAL} decisions, ~800 bytes, which brackets the first divergence to a
 * 25-decision window. This function then prints the *current* run's steps in that window, which is
 * what a reader actually needs: the committed side of the window is, by construction, code that no
 * longer exists.
 */
export function explainEntry(corpus: RegressionCorpus, key: string): RegressionExplanation {
  const entry = findEntry(corpus, key);
  if (entry === undefined) {
    throw new Error(
      `no entry '${key}' in this corpus. It carries ${allEntries(corpus).length} entr(ies); the first few are ` +
      `${allEntries(corpus).slice(0, 3).map((candidate) => entryKey(candidate.identity)).join(', ')}.`);
  }
  ensureHeadlessEngine();

  const played: PlayedEntry = playRegressionEntry(entry.identity, {diagnostics: true});
  const diffs = compareEntry(entry, played);
  const explanation: RegressionExplanation = {key, why: entry.why, diffs: [...diffs]};

  const traceMoved = diffs.some((diff) => diff.path === 'fingerprints.moveTraceHash');
  if (!traceMoved) {
    return explanation;
  }
  const checkpoints = entry.fingerprints.traceCheckpoints;
  if (checkpoints.length === 0) {
    return {
      ...explanation,
      localizationNote:
        'the move trace moved, but this entry carries no trace checkpoints, so the divergence cannot be ' +
        'bracketed. An entry generated without diagnostics has nothing to localize against; regenerate ' +
        'the corpus with checkpoints (a rebaseline, §3.5) before relying on --explain for it.',
    };
  }
  return {...explanation, firstDivergence: bracket(checkpoints, played.trace ?? [])};
}

/**
 * Walks the committed checkpoints against the current trace and returns the window containing the
 * first disagreement, with the current run's steps inside it.
 */
function bracket(
  checkpoints: ReadonlyArray<RegressionTraceCheckpoint>,
  trace: ReadonlyArray<TraceStep>,
): NonNullable<RegressionExplanation['firstDivergence']> {
  const byIndex = new Map(trace.map((step) => [step.index, step]));
  let lastAgreed = -1;
  for (const checkpoint of checkpoints) {
    if (byIndex.get(checkpoint.decisionIndex)?.hash === checkpoint.hash) {
      lastAgreed = checkpoint.decisionIndex;
      continue;
    }
    return {
      lastAgreedDecision: lastAgreed,
      firstDisagreedDecision: checkpoint.decisionIndex,
      window: trace.filter((step) => step.index > lastAgreed && step.index <= checkpoint.decisionIndex),
    };
  }
  // Every checkpoint agreed, so the two runs diverged after the last one - which includes the case
  // where the current run simply resolved a different number of decisions.
  return {lastAgreedDecision: lastAgreed, window: trace.filter((step) => step.index > lastAgreed)};
}

/**
 * §3.1's third triage question: **is the delta confined to a stratum?** A change that moved every
 * entry at 3p and nothing at 2p is a different finding from one that moved eleven scattered games,
 * and the count alone cannot tell them apart.
 */
export function stratify(
  corpus: RegressionCorpus,
  result: L2LayerResult,
): ReadonlyArray<{stratum: string; moved: number; checked: number}> {
  // The corpus supplies the denominators and the result supplies the numerators, because
  // `section.diffs` carries only the entries that moved - "3 of 3 at 3p" and "3 of 60 at 3p" are
  // the two answers this function exists to tell apart, and the moved list alone gives neither.
  const moved = new Set(result.sections.flatMap((section) => section.diffs.map((diff) => entryKey(diff.identity))));
  const byStratum = new Map<string, {moved: number; checked: number}>();

  const bump = (stratum: string, didMove: boolean) => {
    const tally = byStratum.get(stratum) ?? {moved: 0, checked: 0};
    byStratum.set(stratum, {moved: tally.moved + (didMove ? 1 : 0), checked: tally.checked + 1});
  };

  const checkedSections = new Set(result.sections.map((section) => `${section.agent}@${section.agentVersion}`));
  for (const section of corpus.sections) {
    if (!checkedSections.has(sectionKey(section))) {
      continue; // `--agent` selected a subset; a section that was not run has no verdict.
    }
    for (const entry of section.entries) {
      const didMove = moved.has(entryKey(entry.identity));
      // The two dimensions a reader actually asks about: which agent version, and which player count.
      bump(sectionKey(section), didMove);
      bump(`${entry.identity.players}p`, didMove);
    }
  }
  return [...byStratum.entries()].map(([stratum, tally]) => ({stratum, ...tally}));
}

// ---------------------------------------------------------------------------------------------
// The whole suite
// ---------------------------------------------------------------------------------------------

export type SuiteOptions = {
  layers: ReadonlyArray<RegressionLayer>;
  corpus?: RegressionCorpus;
  agent?: string;
  skipDeterminism?: boolean;
  /** Let the driver's per-fallback warnings through. Off by default - see {@link withRoutineLogsSilenced}. */
  verbose?: boolean;
  onProgress?: L2Options['onProgress'];
};

export async function runSuite(options: SuiteOptions): Promise<RegressionRunResult> {
  const started = Date.now();
  const l1 = options.layers.includes('l1') ? runL1() : undefined;
  const l2 = options.layers.includes('l2') && options.corpus !== undefined ?
    await withRoutineLogsSilenced(options.verbose !== true, () => runL2(options.corpus as RegressionCorpus, {
      ...(options.agent === undefined ? {} : {agent: options.agent}),
      ...(options.skipDeterminism === undefined ? {} : {skipDeterminism: options.skipDeterminism}),
      ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
    })) :
    undefined;

  const failed = l1?.status === 'failed' || l2?.status === 'failed';
  return {
    status: failed ? 'failed' : 'ok',
    ...(l1 === undefined ? {} : {l1}),
    ...(l2 === undefined ? {} : {l2}),
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------------------------
// Rebaseline
// ---------------------------------------------------------------------------------------------

export type RebaselineOptions = {
  corpus: RegressionCorpus;
  corpusPath: string;
  ledgerPath: string;
  claim: string | undefined;
  layer: RegressionLayer;
  agent?: string;
  /** Compute and print, write nothing. Used by the specs and by an operator sizing the blast radius. */
  dryRun?: boolean;
  /** Let the driver's per-fallback warnings through. Off by default. */
  verbose?: boolean;
  onProgress?: L2Options['onProgress'];
};

export type RebaselineResult = {
  entry: RebaselineEntry;
  ledger: RebaselineLedger;
  corpus: RegressionCorpus;
  written: boolean;
};

/**
 * Regenerates the selected sections and records the event (§3.5).
 *
 * The order matters and is the point: **verify first, then regenerate, then write the ledger from
 * what the verification measured.** `entriesMoved` and `fieldsMoved` are therefore facts about this
 * run rather than a summary the operator supplied, which is what makes a 43-of-300 rebaseline and a
 * 300-of-300 rebaseline different rows in the record without anyone being asked to notice.
 *
 * **`coverage` and `why` are carried forward, never regenerated.** Coverage is derived from a
 * `moves`-tier survey at generation time (§2.7) and this path does not run one; `why` is the
 * operator's sentence about what the game is pinned for, and a game's purpose does not change
 * because its fingerprint did. If a rebaseline is large enough that the coverage record is no longer
 * true, that is a re-selection - Unit C's job - and not this command's.
 */
export async function rebaseline(options: RebaselineOptions): Promise<RebaselineResult> {
  return withRoutineLogsSilenced(options.verbose !== true, () => rebaselineInner(options));
}

async function rebaselineInner(options: RebaselineOptions): Promise<RebaselineResult> {
  const verified = await runL2(options.corpus, {
    ...(options.agent === undefined ? {} : {agent: options.agent}),
    skipDeterminism: true,
    ...(options.onProgress === undefined ? {} : {onProgress: options.onProgress}),
  });

  const moved = verified.sections.reduce((count, section) => count + section.entriesMoved, 0);
  const checked = verified.sections.reduce((count, section) => count + section.entriesChecked, 0);
  const fieldsMoved: Record<string, number> = {};
  for (const section of verified.sections) {
    for (const [field, count] of Object.entries(section.fieldsMoved)) {
      fieldsMoved[normalizePath(field)] = (fieldsMoved[normalizePath(field)] ?? 0) + count;
    }
  }

  const regenerated = await regenerateSections(options.corpus, options.agent);
  const updated: RegressionCorpus = {...regenerated, header: buildHeader()};

  const existing = loadRebaselineLedger(options.ledgerPath);
  const {ledger, entry} = appendRebaseline(existing, {
    layer: options.layer,
    claim: options.claim,
    agentCommit: buildHeader().agentCommit,
    enginePin: ENGINE_PIN,
    entriesMoved: moved,
    entriesTotal: checked,
    fieldsMoved,
    corpusDigestBefore: digestCorpus(options.corpus),
    corpusDigestAfter: digestCorpus(updated),
  });

  if (options.dryRun === true) {
    return {entry, ledger, corpus: updated, written: false};
  }
  saveRegressionCorpus(options.corpusPath, updated);
  saveRebaselineLedger(options.ledgerPath, ledger);
  return {entry, ledger, corpus: updated, written: true};
}

/** Replays every selected entry with diagnostics on, so the regenerated entries carry checkpoints. */
async function regenerateSections(corpus: RegressionCorpus, agent?: string): Promise<RegressionCorpus> {
  const sections = [];
  for (const section of corpus.sections) {
    if (agent !== undefined && sectionKey(section) !== agent) {
      sections.push(section);
      continue;
    }
    const entries = [];
    for (const entry of section.entries) {
      const played = playRegressionEntry(entry.identity, {diagnostics: true});
      entries.push({...entry, fingerprints: played.fingerprints, semantics: played.semantics});
      await yieldToEventLoop();
    }
    sections.push({...section, entries});
  }
  return {...corpus, sections};
}

// ---------------------------------------------------------------------------------------------
// The smoke corpus
// ---------------------------------------------------------------------------------------------

/**
 * **Unit A's ~10-game smoke corpus** (Unit A §7): a real committed artifact in the real format, so
 * Unit C has something to write against on day one and Unit D has something to mutate before C's
 * corpus exists. It is *not* Unit C's corpus and is not selected for coverage - its `why` lines say
 * what each entry is there to exercise, which is a property of the *format*, not of the game.
 *
 * **Seed range: R-block groups 6,090-6,099**, allocated in `ladder.json` before the games were
 * played, as §3.7 requires of anything that spends R. §3.7 reserves 6,030-6,099 as a gap after the
 * spent R3 range and 6,100-6,499 for Unit C's L2 corpus; taking the top ten groups of the gap
 * leaves 6,030-6,089 still empty and does not touch anything C or M3-M6 is promised.
 *
 * The lineups are chosen to exercise the parts of the format that a self-play-only corpus would
 * leave untested: both frozen baselines, two player counts, and - the one most likely to be got
 * wrong later - a **mixed lineup filed under one section**, which is what proves `identity.agent`
 * names the section rather than the whole table.
 */
export const SMOKE_GROUP_RANGE = {from: 6_090, to: 6_099};

type SmokeSpec = {
  agent: string;
  frozen: boolean;
  games: ReadonlyArray<{players: 2 | 3 | 4; groupIndex: number; permutationIndex: number; lineup: ReadonlyArray<string>; why: string}>;
};

const SMOKE_SPECS: ReadonlyArray<SmokeSpec> = [
  {
    agent: 'random-legal',
    frozen: true,
    games: [
      {players: 2, groupIndex: 6_090, permutationIndex: 0, lineup: ['random-legal', 'random-legal'], why: 'Format smoke: the cheapest possible entry - 2p self-play, identity permutation. If anything in the record schema is wrong, it is wrong here first.'},
      {players: 2, groupIndex: 6_090, permutationIndex: 1, lineup: ['random-legal', 'random-legal'], why: 'Format smoke: the same group in the mirrored seating, so a permutation index that is ignored produces two identical entries and is caught by the duplicate-key check.'},
      {players: 2, groupIndex: 6_091, permutationIndex: 0, lineup: ['random-legal', 'random-legal'], why: 'Format smoke: a second group, so a fingerprint that is constant across groups (a seed that never reaches the Engine) is visible.'},
      {players: 2, groupIndex: 6_091, permutationIndex: 1, lineup: ['random-legal', 'random-legal'], why: 'Format smoke: the second group mirrored, completing one balanced pairing group in the pinned set.'},
      {players: 3, groupIndex: 6_094, permutationIndex: 0, lineup: ['random-legal', 'random-legal', 'random-legal'], why: 'Format smoke at 3p: three seats, so a per-seat semantics array that is hard-coded to two entries fails here rather than in Unit C.'},
      {players: 3, groupIndex: 6_094, permutationIndex: 3, lineup: ['random-legal', 'random-legal', 'random-legal'], why: 'Format smoke at 3p: a non-zero permutation index, so the seating recorded on the entry is checked against the pairing schedule rather than assumed to be the identity.'},
    ],
  },
  {
    agent: 'greedy-1ply',
    frozen: true,
    games: [
      {players: 2, groupIndex: 6_092, permutationIndex: 0, lineup: ['greedy-1ply', 'greedy-1ply'], why: 'The gap §2.1 names: greedy-1ply@1 has never had a fixed-seed standing check of any kind. This is the first, and it exercises the fork service and the whole-game observer through the replay path.'},
      {players: 2, groupIndex: 6_092, permutationIndex: 1, lineup: ['greedy-1ply', 'greedy-1ply'], why: 'greedy-1ply@1 self-play, mirrored seating - the pair a shared-infrastructure change (M3 candidate enumeration) would move together.'},
      {players: 2, groupIndex: 6_093, permutationIndex: 0, lineup: ['greedy-1ply', 'random-legal'], why: 'A mixed lineup filed under the greedy-1ply@1 section: proves identity.agent names the section this game is pinned *for*, not every seat at the table.'},
      {players: 2, groupIndex: 6_093, permutationIndex: 1, lineup: ['greedy-1ply', 'random-legal'], why: 'The mixed lineup with the slots swapped between seats, so an agent-seed schedule that travels with the seat rather than the slot is visible as a divergence.'},
    ],
  },
];

/**
 * Plays the smoke corpus. Diagnostics are on so the committed entries carry trace checkpoints -
 * without them `--explain` has nothing to bracket against, and the smoke corpus is the artifact
 * Unit D localizes its first mutations on.
 */
export async function buildSmokeCorpus(
  onProgress?: (played: number, total: number, key: string) => void,
): Promise<RegressionCorpus> {
  return withRoutineLogsSilenced(true, () => buildSmokeCorpusInner(onProgress));
}

async function buildSmokeCorpusInner(
  onProgress?: (played: number, total: number, key: string) => void,
): Promise<RegressionCorpus> {
  ensureHeadlessEngine();
  const recordedAt = new Date().toISOString().slice(0, 10);
  const total = SMOKE_SPECS.reduce((count, spec) => count + spec.games.length, 0);
  let played = 0;

  const sections = [];
  for (const spec of SMOKE_SPECS) {
    const version = lookupAgent(spec.agent).version;
    const entries: Array<L2GameEntry> = [];
    for (const game of spec.games) {
      const identity: RegressionEntryIdentity = {
        agent: spec.agent,
        agentVersion: version,
        players: game.players,
        groupIndex: game.groupIndex,
        permutationIndex: game.permutationIndex,
        lineup: game.lineup,
        seating: permutationsFor(game.players)[game.permutationIndex],
      };
      const result = playRegressionEntry(identity, {diagnostics: true});
      entries.push({
        layer: 'l2',
        identity,
        fingerprints: result.fingerprints,
        semantics: result.semantics,
        // Not derived: this corpus runs no `moves`-tier survey, and an empty list that claimed to be
        // a measurement would be exactly the error `RegressionEntryCoverage.source` exists to prevent.
        coverage: {source: 'not-derived', standardProjects: [], cardActions: []},
        why: game.why,
      });
      played++;
      onProgress?.(played, total, entryKey(identity));
      await yieldToEventLoop();
    }
    const groups = entries.map((entry) => entry.identity.groupIndex);
    sections.push({
      agent: spec.agent,
      agentVersion: version,
      frozen: spec.frozen,
      recordedAt,
      groupRange: {from: Math.min(...groups), to: Math.max(...groups)},
      entries,
    });
  }

  return buildRegressionCorpus(sections);
}

/** Reads the ledger for `--ledger show`, reporting absence and emptiness as the different things they are. */
export function describeLedgerState(ledgerPath: string): {ledger?: RebaselineLedger; note: string; problems: ReadonlyArray<string>} {
  const ledger = loadRebaselineLedger(ledgerPath);
  if (ledger === undefined) {
    return {note: `no ledger at ${ledgerPath} - nothing has ever been rebaselined, and nothing has ever checked`, problems: []};
  }
  if (ledger.entries.length === 0) {
    return {ledger, note: `${ledgerPath} is present and empty: no layer has been rebaselined`, problems: []};
  }
  return {ledger, note: `${ledgerPath}: ${ledger.entries.length} rebaseline(s)`, problems: verifyLedgerChain(ledger)};
}
