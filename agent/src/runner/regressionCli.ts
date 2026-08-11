/**
 * CLI for the regression suite (Milestone 2, bullet 5; the criteria S1-S9 it produces evidence for
 * are pre-committed in agent/docs/Milestone2_Bullet5_Prompts.md §5).
 *
 *   Everything. Exits non-zero on any failure - this is the gate invocation:
 *     npm run regression
 *
 *   The reference positions only - seconds, no games:
 *     npm run regression -- --layer l1
 *
 *   One agent's pinned games:
 *     npm run regression -- --layer l2 --agent greedy-1ply@1
 *
 *   L3 triage for one entry: what moved, and where the trace first left the committed one:
 *     npm run regression -- --explain greedy-1ply@1/2p/g6100/p1
 *
 *   Regenerate a pinned layer. Fails without --claim, and the ledger records what it measured:
 *     npm run regression -- --rebaseline --layer l2 --claim "M3 changed candidate enumeration; ..."
 *
 *   The ledger itself:
 *     npm run regression -- --ledger
 *
 * **Three instruments, three questions, and this is the fourth** (§2.1). `npm run match --
 * --legality` answers "is it legal?", `npm run rate` answers "is it stronger?",
 * `npm run determinism -- --verify` answers "is it deterministic?" - and this answers **"did
 * anything change that we didn't mean to change?"**. A green run here is not a legality result and
 * not a strength result (hazard H14); AC-1 still expires on every new agent version
 * (`agent/CLAUDE.md` §7).
 *
 * Follows the arg-parsing style of `determinismCli.ts`/`matchCli.ts`: a switch over `process.argv`,
 * explicit errors on unknown flags, no parsing dependency.
 */
import * as fs from 'fs';
import {entryKey, loadRegressionCorpus, saveRegressionCorpus} from '../regression/corpus';
import {assertRebaselineClaim, describeRebaseline} from '../regression/ledger';
import {
  DEFAULT_CORPUS_FILE,
  REBASELINE_LEDGER_FILE,
  SMOKE_CORPUS_FILE,
  buildSmokeCorpus,
  dataPath,
  describeLedgerState,
  explainEntry,
  rebaseline,
  runSuite,
  silencingRoutineLogs,
  stratify,
} from '../regression/runner';
import {
  L1LayerResult,
  L2LayerResult,
  REGRESSION_LAYERS,
  RegressionCorpus,
  RegressionLayer,
  RegressionRunResult,
} from '../regression/types';

type ParsedArgs = {
  layers: ReadonlyArray<RegressionLayer>;
  agent?: string;
  corpus?: string;
  ledger: string;
  explain?: string;
  rebaseline: boolean;
  claim?: string;
  dryRun: boolean;
  showLedger: boolean;
  smoke: boolean;
  skipDeterminism: boolean;
  generateSmoke: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let layers: ReadonlyArray<RegressionLayer> = ['l1', 'l2'];
  let agent: string | undefined;
  let corpus: string | undefined;
  let ledger = dataPath(REBASELINE_LEDGER_FILE);
  let explain: string | undefined;
  let doRebaseline = false;
  let claim: string | undefined;
  let dryRun = false;
  let showLedger = false;
  let smoke = false;
  let skipDeterminism = false;
  let generateSmoke = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--layer': {
      const value = argv[++i];
      const requested = value === undefined ? [] : value.split(',').map((layer) => layer.trim().toLowerCase());
      for (const layer of requested) {
        if (!REGRESSION_LAYERS.includes(layer as RegressionLayer)) {
          throw new Error(`--layer must be one of ${REGRESSION_LAYERS.join(', ')}, got '${layer}'`);
        }
      }
      if (requested.includes('l3')) {
        // L3 has no entries of its own - it is a *reading* of L2's comparison output (§3.1). Running
        // it as a layer would be a silent no-op, and a suite that reports OK having done nothing is
        // the failure mode this bullet is written against.
        throw new Error(
          '--layer l3 is not a runnable layer: L3 is triage over L2\'s output, not a set of checks. ' +
          'Use --explain <entry> for one entry, or run --layer l2 and read the report.');
      }
      if (requested.length === 0) {
        throw new Error('--layer needs at least one of l1, l2');
      }
      layers = requested as ReadonlyArray<RegressionLayer>;
      break;
    }
    case '--agent':
      agent = argv[++i];
      break;
    case '--corpus':
      corpus = argv[++i];
      break;
    case '--ledger':
      // Doubles as a flag and as a path: `--ledger` alone prints the ledger, `--ledger <path>`
      // points every other mode at a different one (which is how the specs exercise the refusal
      // path through this CLI without touching the committed record).
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        ledger = argv[++i];
      } else {
        showLedger = true;
      }
      break;
    case '--explain':
      explain = argv[++i];
      break;
    case '--rebaseline':
      doRebaseline = true;
      break;
    case '--claim':
      claim = argv[++i];
      break;
    case '--dry-run':
      dryRun = true;
      break;
    case '--smoke':
      smoke = true;
      break;
    case '--no-determinism':
      skipDeterminism = true;
      break;
    case '--show-ledger':
      showLedger = true;
      break;
    case '--generate-smoke':
      generateSmoke = true;
      smoke = true;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  return {
    layers, ledger, rebaseline: doRebaseline, dryRun, showLedger, smoke, skipDeterminism, generateSmoke,
    ...(agent === undefined ? {} : {agent}),
    ...(corpus === undefined ? {} : {corpus}),
    ...(explain === undefined ? {} : {explain}),
    ...(claim === undefined ? {} : {claim}),
  };
}

/**
 * Where the pinned games are read from. `--smoke` selects Unit A's ~10-game corpus, which exists so
 * Unit C has a format to write against and Unit D has something to mutate on day one; the default
 * is Unit C's real one.
 */
function corpusPathFor(args: ParsedArgs): string {
  return args.corpus ?? dataPath(args.smoke ? SMOKE_CORPUS_FILE : DEFAULT_CORPUS_FILE);
}

function loadCorpusOrReport(args: ParsedArgs): {corpus?: RegressionCorpus; path: string} {
  const filePath = corpusPathFor(args);
  if (!fs.existsSync(filePath)) {
    return {path: filePath};
  }
  return {corpus: loadRegressionCorpus(filePath), path: filePath};
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

function reportL1(l1: L1LayerResult): void {
  const seconds = (l1.durationMs / 1_000).toFixed(1);
  if (l1.status === 'empty') {
    // Loud, and deliberately not a failure. See runner.ts's module doc: reporting `ok` here would be
    // the purest form of "a suite that has never refused anything looks like a suite that works",
    // and failing would paint the suite red for every session before Unit B's fixtures land.
    console.log(`[regression] L1 reference positions: NOT BUILT - no fixtures under agent/test/regression/fixtures/.`);
    console.log('[regression]   This layer asserted nothing. It is the layer most likely to catch something ' +
      'and the cheapest to run (§3.8), and criterion S4 is stated on it.');
    return;
  }
  console.log(`[regression] L1 reference positions: ${l1.status.toUpperCase()} - ` +
    `${l1.fixtures - l1.failures.length}/${l1.fixtures} passed in ${seconds}s`);
  for (const failure of l1.failures) {
    console.error(`[regression]   FAILED ${failure.file}: ${failure.title}`);
    console.error(`[regression]     ${(failure.message ?? 'no message').split('\n')[0]}`);
  }
  if (l1.failures.length > 0) {
    console.error('[regression]   An L1 fixture asserts the **Engine\'s** behaviour at the pin, never the printed ' +
      'behaviour (§3.4, hazard H10). Before "fixing" one, read the three-part comment beside its assertion: ' +
      'changing it to match the printed card is a change to the fixture\'s meaning, not a fix.');
  }
}

function reportL2(corpus: RegressionCorpus | undefined, l2: L2LayerResult): void {
  const determinism = l2.determinismCorpus;
  console.log(`[regression] determinism corpus (§3.9, invoked not absorbed): ${determinism.status.toUpperCase()} - ` +
    `${determinism.configsChecked} config(s), ${determinism.mismatches} mismatch(es) in ` +
    `${(determinism.durationMs / 1_000).toFixed(1)}s${determinism.note === undefined ? '' : ` [${determinism.note}]`}`);

  if (l2.sections.length === 0) {
    console.log('[regression] L2 reference games: NOT BUILT - the corpus carries no sections (Unit C).');
    return;
  }

  for (const section of l2.sections) {
    const label = `${section.agent}@${section.agentVersion}${section.frozen ? ' (frozen)' : ''}`;
    const verdict = section.entriesMoved === 0 ? 'OK' : 'MOVED';
    console.log(`[regression] L2 ${label}: ${verdict} - ${section.entriesChecked - section.entriesMoved}/` +
      `${section.entriesChecked} entries reproduced`);

    for (const diff of section.diffs) {
      console.error(`[regression]   ${entryKey(diff.identity)}`);
      console.error(`[regression]     pinned for: ${diff.why}`);
      if (diff.failure !== undefined) {
        console.error(`[regression]     FAILED TO REPLAY: ${diff.failure.errorClass}: ${diff.failure.message.split('\n')[0]}`);
      }
      // Fingerprints first, then semantics: "the trace differs but every VP component is identical"
      // and "greenery VP moved by 2" are different events, and the order is how the reader sees which
      // one this is (§3.3).
      for (const field of diff.diffs) {
        console.error(`[regression]     ${field.group.padEnd(11)} ${field.path}: ` +
          `${short(field.expected)} -> ${short(field.actual)}`);
      }
      console.error(`[regression]     triage: npm run regression -- --explain ${entryKey(diff.identity)}`);
    }

    if (section.entriesMoved > 0 && section.frozen) {
      console.error(`[regression]   ${label} is a FROZEN baseline. If its own code did not change, this is a ` +
        'shared-infrastructure change moving a frozen yardstick - a **regression, not a rebaseline** (§3.1). ' +
        'The correct response is to adjudicate it and either revert or cut a new agent version. It is never ' +
        'to regenerate the corpus.');
    }
  }

  const moved = l2.sections.reduce((count, section) => count + section.entriesMoved, 0);
  if (moved > 0 && corpus !== undefined) {
    console.error('[regression] is the delta confined to a stratum? (§3.1)');
    for (const row of stratify(corpus, l2)) {
      console.error(`[regression]   ${row.stratum.padEnd(22)} ${row.moved}/${row.checked} moved`);
    }
  }
}

/** Values in a diff row are printed short - a `projectCards` array can be forty card names long. */
function short(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : (text.length <= 80 ? text : `${text.slice(0, 77)}...`);
}

function reportSuite(corpus: RegressionCorpus | undefined, result: RegressionRunResult): void {
  if (result.l1 !== undefined) {
    reportL1(result.l1);
  }
  if (result.l2 !== undefined) {
    reportL2(corpus, result.l2);
  }
  const seconds = result.durationMs / 1_000;
  console.log(`[regression] ${result.status.toUpperCase()} in ${seconds.toFixed(1)}s ` +
    `(budget §3.8: <= 300s compiled, <= 1200s under tsx - criterion S6)`);
  if (seconds > 1_200) {
    console.error('[regression] OVER BUDGET. §3.8 and criterion S6 are explicit that this is a failure to be ' +
      'fixed by cutting the corpus, not a number to revise upward: the whole design assumes it runs at every gate.');
  }
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------

function runShowLedger(args: ParsedArgs): void {
  const state = describeLedgerState(args.ledger);
  console.log(`[regression] ${state.note}`);
  for (const entry of state.ledger?.entries ?? []) {
    console.log(`[regression]   ${describeRebaseline(entry)}`);
  }
  for (const problem of state.problems) {
    console.error(`[regression]   CHAIN BROKEN: ${problem}`);
  }
  if (state.problems.length > 0) {
    process.exitCode = 1;
  }
}

function runExplain(args: ParsedArgs): void {
  const {corpus, path: corpusPath} = loadCorpusOrReport(args);
  if (corpus === undefined) {
    throw new Error(`no corpus at ${corpusPath} to explain an entry from (Unit C writes it; --smoke selects Unit A's).`);
  }
  // Silenced: triage output is read line by line, and the ~6 FR-9 warnings this one game emits
  // would sit between the diff rows and the divergence window. The counts are on the record.
  const explanation = silencingRoutineLogs(() => explainEntry(corpus, args.explain as string));

  console.log(`[regression] ${explanation.key}`);
  console.log(`[regression]   pinned for: ${explanation.why}`);
  if (explanation.diffs.length === 0) {
    console.log('[regression]   this entry currently reproduces its committed record exactly - nothing to explain.');
    return;
  }

  const fingerprints = explanation.diffs.filter((diff) => diff.group === 'fingerprint');
  const semantics = explanation.diffs.filter((diff) => diff.group === 'semantics');
  console.log(`[regression]   ${fingerprints.length} fingerprint field(s) and ${semantics.length} semantic field(s) moved.`);
  if (semantics.length === 0) {
    console.log('[regression]   **The trace moved and no semantic field did.** The game took a different route to ' +
      'an identical outcome: every VP component, placement, corporation and card list is unchanged. That is a ' +
      'different event from a scoring change and usually points at ordering rather than value (§3.3).');
  }
  for (const diff of explanation.diffs) {
    console.log(`[regression]     ${diff.group.padEnd(11)} ${diff.path}: ${short(diff.expected)} -> ${short(diff.actual)}`);
  }

  if (explanation.localizationNote !== undefined) {
    console.log(`[regression]   ${explanation.localizationNote}`);
  }
  const located = explanation.firstDivergence;
  if (located !== undefined) {
    console.log(`[regression]   first divergence is after decision ${located.lastAgreedDecision} and at or before ` +
      `${located.firstDisagreedDecision ?? 'the end of the game'} - the committed checkpoints agree up to the ` +
      'first of those (§3.1). The window below is **this** run\'s decisions; the committed side of it is code ' +
      'that no longer exists, which is why the corpus commits checkpoints and not a trace.');
    for (const step of located.window) {
      console.log(`[regression]     #${String(step.index).padStart(4)} ${step.stepInput.slice(0, 160)}`);
    }
  }
}

async function runRebaseline(args: ParsedArgs): Promise<void> {
  const {corpus, path: corpusPath} = loadCorpusOrReport(args);
  if (corpus === undefined) {
    throw new Error(`no corpus at ${corpusPath} to rebaseline.`);
  }
  const layer = args.layers.length === 1 ? args.layers[0] : 'l2';

  // `assertRebaselineClaim` throws from inside `rebaseline()` - but only *after* it has verified and
  // regenerated, which would waste minutes of games to reach a refusal that is knowable now. The
  // ledger module owns the rule; this is the same rule applied early, and the specs assert both.
  assertRebaselineClaim(args.claim);

  const result = await rebaseline({
    corpus,
    corpusPath,
    ledgerPath: args.ledger,
    claim: args.claim,
    layer,
    dryRun: args.dryRun,
    ...(args.agent === undefined ? {} : {agent: args.agent}),
  });

  console.log(`[regression] rebaseline ${result.written ? 'RECORDED' : '(dry run - nothing written)'}`);
  console.log(`[regression]   ${describeRebaseline(result.entry)}`);
  console.log(`[regression]   corpus ${result.entry.corpusDigestBefore.slice(0, 12)} -> ${result.entry.corpusDigestAfter.slice(0, 12)}`);
  if (result.written) {
    console.log(`[regression]   wrote ${corpusPath} and appended to ${args.ledger}`);
  }
  if (result.entry.entriesMoved === 0) {
    console.log('[regression]   NOTE: nothing had moved. A rebaseline that changes no fingerprint is a no-op with a ' +
      'ledger entry attached - which is harmless, and worth noticing before it becomes a habit.');
  }
}

/**
 * Regenerates Unit A's smoke corpus (see `runner.ts`'s `buildSmokeCorpus`). Deliberately a separate
 * flag from `--rebaseline`: the smoke corpus is a *format* artifact with no coverage record and no
 * selection behind it, so regenerating it is not the event §3.5's ledger exists to make expensive.
 * Unit C's corpus is regenerated through `--rebaseline`, with a claim.
 */
async function runGenerateSmoke(args: ParsedArgs): Promise<void> {
  const target = corpusPathFor(args);
  const corpus = await buildSmokeCorpus((played, total, key) => {
    console.log(`[regression] smoke ${played}/${total} ${key}`);
  });
  saveRegressionCorpus(target, corpus);
  console.log(`[regression] wrote ${corpus.sections.reduce((count, section) => count + section.entries.length, 0)} ` +
    `smoke entr(ies) in ${corpus.sections.length} section(s) to ${target}`);
}

async function runVerify(args: ParsedArgs): Promise<void> {
  const {corpus, path: corpusPath} = loadCorpusOrReport(args);
  if (corpus === undefined && args.layers.includes('l2')) {
    console.log(`[regression] no L2 corpus at ${corpusPath} - Unit C writes it. Running the layers that exist.`);
  }
  const result = await runSuite({
    layers: args.layers,
    ...(corpus === undefined ? {} : {corpus}),
    ...(args.agent === undefined ? {} : {agent: args.agent}),
    skipDeterminism: args.skipDeterminism,
  });
  reportSuite(corpus, result);
  if (result.status === 'failed') {
    process.exitCode = 1;
  }
}

export async function runRegressionCli(argv: ReadonlyArray<string>): Promise<void> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(usage());
    return;
  }
  const args = parseArgs(argv);

  if (args.generateSmoke) {
    await runGenerateSmoke(args);
    return;
  }
  if (args.showLedger) {
    runShowLedger(args);
    return;
  }
  if (args.explain !== undefined) {
    runExplain(args);
    return;
  }
  if (args.rebaseline) {
    await runRebaseline(args);
    return;
  }
  await runVerify(args);
}

function usage(): string {
  return [
    'usage: npm run regression -- [options]',
    '',
    '  (no options)              run every layer; exit non-zero on any failure',
    '  --layer l1|l2[,...]       run only these layers',
    '  --agent <name@version>    L2: only this section',
    '  --corpus <path>           read the pinned games from here',
    '  --smoke                   use Unit A\'s ~10-game smoke corpus instead of Unit C\'s',
    '  --no-determinism          skip the committed determinism corpus (not for a gate run)',
    '  --explain <entry>         L3 triage for one entry, e.g. greedy-1ply@1/2p/g6100/p1',
    '  --rebaseline --claim "…"  regenerate a pinned layer; fails without a claim (§3.5)',
    '  --dry-run                 with --rebaseline: compute and print, write nothing',
    '  --ledger [path]           print the rebaseline ledger, or point other modes at one',
    '  --generate-smoke          (re)build Unit A\'s smoke corpus - a format artifact, not a baseline',
    '',
    'A green run answers "did anything change that we did not mean to change?" and nothing else.',
    'It is not a legality result (AC-1 expires on every new agent version) and not a strength result.',
  ].join('\n');
}

/* c8 ignore start - the module-as-script guard, exercised by the specs through a child process. */
if (require.main === module) {
  runRegressionCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[regression] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */
