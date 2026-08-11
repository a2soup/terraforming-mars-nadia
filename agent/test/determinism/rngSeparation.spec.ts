import {expect} from 'chai';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Milestone 1, bullet 6, sub-task D — **P5: structural RNG separation** (SRS CON-5/NFR-5).
 *
 * Bullet 6's second clause is "confirm the Agent's search/determinization RNG is seeded
 * separately from the Engine's". The evidence that existed before this spec was *behavioural*:
 * vary one seed, the outcome changes (`randomLegalAgent.integration.spec.ts:149-189`). That
 * demonstrates the two seeds are not the same seed; it does **not** establish that no agent code
 * path reaches around both of them into `Math.random()`, the wall clock, `UnseededRandom`, or
 * the Engine's own `game.rng`. A behavioural check also only covers the code paths the test
 * happened to execute, and the decision core is going to grow through M3-M6.
 *
 * So this is a **source-level** guard: every `.ts` under `agent/src` is read and matched against
 * {@link RULES}. It is deliberately blunt - it matches text, including text inside comments, and
 * it does not parse TypeScript. A guard that needed to be right about scoping to be useful would
 * be a guard nobody trusts; this one is trivially auditable and its failure mode is a false
 * positive that a human resolves in one line of {@link ALLOWLIST}, never a silent false negative.
 *
 * **Allowlisting is by explicit file + rule + occurrence count, with a written reason, never by
 * pattern** (Milestone1_Bullet6_Prompts.md, sub-task D section 1). A pattern-based allowlist
 * grows silently; an occurrence-counted one fails the moment a second, unreviewed use appears in
 * an already-allowlisted file. Stale entries fail too - see 'the allowlist is exact'.
 *
 * **If this spec fails on a file you just added** (sub-tasks B and C both add modules under
 * `agent/src/determinism/`, and a cross-process or contamination harness plausibly wants to time
 * or timestamp something): the fix is to decide which side of the line the code is on. Timing
 * belongs in `agent/src/bench`; a timestamp that only ever lands in a report header belongs in
 * {@link ALLOWLIST} with a reason like corpus.ts's; anything that a decision or a game's state
 * can depend on belongs in neither, and is the failure this spec exists to catch.
 *
 * Per the bullet's preamble ("a green result is the suspicious one"), the scanner is itself
 * checked two ways: fixture strings that must be flagged (a broken regex would otherwise make
 * this file decorative), and an assertion that the walk actually reached the real source tree (a
 * broken walker reports zero violations and looks exactly like a pass).
 */

/** `agent/`, resolved from this file so the scan is independent of the cwd mocha was started in. */
const AGENT_ROOT = path.join(__dirname, '..', '..');
const SRC_ROOT = path.join(AGENT_ROOT, 'src');

/**
 * The one directory exempt from the rules below. `agent/src/bench/` is the bullet-5 speed-spike
 * harness: measuring wall-clock time is its entire job (`harness.ts:33` uses
 * `process.hrtime.bigint()`, `harness.ts:175` stamps a report with `new Date()`), and it
 * contains no decision logic. It is excluded wholesale, by directory, because that exemption is
 * about *what the directory is for* rather than about individual lines - and because a bench
 * file that started making decisions would be the wrong file in the wrong place regardless of
 * what this spec said.
 */
const EXCLUDED_DIRECTORIES: ReadonlyArray<string> = ['src/bench'];

type Rule = {
  id: string;
  /** Regex source, compiled fresh per scan so no `lastIndex` state is ever shared. */
  source: string;
  /** Shown verbatim in the failure message - the reader needs to know *why*, not just *what*. */
  why: string;
};

const RULES: ReadonlyArray<Rule> = [
  {
    id: 'math-random',
    source: String.raw`\bMath\s*\.\s*random\b`,
    why: 'unseeded randomness: a decision drawn from Math.random() is reproducible under no seed at all, ' +
      'so the game it appears in can never be replayed (NFR-5). Use createAgentRandom() (agent/src/core/rng.ts).',
  },
  {
    id: 'date-now',
    source: String.raw`\bDate\s*\.\s*now\b`,
    why: 'wall-clock read: any state derived from the clock differs between two replays of the same seeds. ' +
      'The four wall-clock field families the Engine already produces are stripped by stableState.ts; the Agent must add none.',
  },
  {
    id: 'new-date',
    source: String.raw`\bnew\s+Date\b`,
    why: 'wall-clock read - see date-now.',
  },
  {
    id: 'process-hrtime',
    source: String.raw`\bprocess\s*\.\s*hrtime\b`,
    why: 'high-resolution wall clock. Timing belongs in agent/src/bench (the one allowlisted directory), not in code that plays.',
  },
  {
    id: 'performance-now',
    source: String.raw`\bperformance\s*\.\s*now\b`,
    why: 'high-resolution wall clock - see process-hrtime. (Not in P5\'s literal list, which predates nobody using it; ' +
      'it is the same hazard by another name, and adding it now costs nothing.)',
  },
  {
    id: 'unseeded-random',
    source: String.raw`\bUnseededRandom\b`,
    why: 'the Engine\'s Math.random() wrapper (src/common/utils/Random.ts:37). SeededRandom and ConstRandom are ' +
      'deterministic and permitted; UnseededRandom is exactly the thing this bullet exists to keep out of agent code.',
  },
  {
    id: 'game-rng',
    source: String.raw`\.\s*rng\b`,
    why: 'a read of the Engine\'s own RNG (game.rng). Drawing from it makes the Agent\'s choices a function of the ' +
      'Engine seed and *advances the Engine\'s stream*, so the game itself changes depending on how much the Agent thought - ' +
      'which is precisely the coupling CON-5 forbids (see the M4 seed contract in Determinism_Verification.md).',
  },
];

type AllowlistEntry = {
  /** Path relative to `agent/`, e.g. `src/determinism/corpus.ts`. */
  file: string;
  rule: string;
  /** Exact number of matches expected. A second, unreviewed use in the same file fails the spec. */
  occurrences: number;
  reason: string;
};

const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  {
    file: 'src/determinism/corpus.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      'CorpusHeader.createdAt: a provenance timestamp stamped once when a corpus file is written, so a committed ' +
      'corpus records when it was produced. It is not compared by assertHeaderCompatible() (which checks engineCommit, ' +
      'seedDerivationVersion and the two gameplay-reaching env vars), never reaches a decision, and never enters a ' +
      'fingerprint - saveCorpus writes it into the header alone. Removing it would lose provenance and gain no determinism.',
  },
  {
    file: 'src/legality/run.ts',
    rule: 'date-now',
    occurrences: 6,
    reason:
      'AC-1 legality-run durations: the run\'s own wall-clock (`wallClockMs`), each game\'s `durationMs`, and the ' +
      'elapsed stamp on each L7 heap sample. Every one of them is *reported* - they land in the run summary and the ' +
      'committed artifact - and none is ever read back: no seed, no decision, and no game state derives from them ' +
      '(the run creates games from its seed schedule alone, seeds.ts). This is the same category as corpus.ts\'s ' +
      'createdAt above, at a slightly larger surface because a 1,500-game run reports timing per game as well as ' +
      'per run. Criterion L7 (agent/docs/AC1_Legality_Run.md) is what needs them: a run that cannot say how its ' +
      'heap and per-game cost moved over 1,500 games cannot answer the long-run stability question ' +
      'Determinism_Verification.md left open.',
  },
  {
    file: 'src/runner/legalityCli.ts',
    rule: 'date-now',
    occurrences: 2,
    reason:
      'The legality CLI\'s progress line ("N/1500 games (29.1 games/s)"). Console output on a run that takes ' +
      'roughly a minute; it reaches no file, no fingerprint and no decision.',
  },
  {
    file: 'src/runner/coverageCli.ts',
    rule: 'date-now',
    occurrences: 3,
    reason:
      'The Milestone 1 bullet 7 play sweep\'s progress line and elapsed-time summary ("N/1500 games (X games/s)" ' +
      '/ "sweep: N/M games completed in Xs"). Same category as legalityCli.ts\'s progress line above: console ' +
      'output only, reaches no file, no fingerprint and no decision - the sweep\'s games are built from its own ' +
      'seed schedule (coverage/playSweep.ts) and never read the clock.',
  },
  {
    file: 'src/match/runner.ts',
    rule: 'date-now',
    occurrences: 4,
    reason:
      'Match-runner durations: each game\'s `durationMs` and the run\'s `wallClockMs` (Milestone 2 bullet 1). Same ' +
      'category as legality/run.ts above - reported, never read back; a match\'s games are built from the pairing ' +
      'seed schedule alone (match/pairing.ts) and no seed, decision or game state derives from the clock. The ' +
      'match runner goes further than the legality run did: these two are the *only* non-deterministic fields it ' +
      'produces, they are declared as such in `MATCH_TIMING_FIELDS` (match/artifact.ts), and criteria R2 and R6 ' +
      '(Milestone2_Bullet1_Prompts.md §6) strip exactly them before requiring two runs of the same specification ' +
      'to be identical - so this allowlist entry and that criterion are two statements of the same fact.',
  },
  {
    file: 'src/runner/matchCli.ts',
    rule: 'date-now',
    occurrences: 2,
    reason:
      'The match CLI\'s progress line ("N/1000 games (38.1 games/s)"). Identical in kind to legalityCli.ts\'s above: ' +
      'console output on a long run, reaching no file, no fingerprint and no decision.',
  },
  {
    file: 'src/match/pool.ts',
    rule: 'date-now',
    occurrences: 2,
    reason:
      'The pool\'s own `wallClockMs` (Milestone 2 bullet 1, Unit C, §4.5): the wall-clock elapsed while every ' +
      'child\'s shard ran, in place of the single-process run\'s own timing since the pool never calls ' +
      '`runMatchConfigs` itself. Same category as `match/runner.ts`\'s entry above - reported into `MatchTiming`, ' +
      'stripped by the same `MATCH_TIMING_FIELDS`/`stripTimingFields` before any R2/R6 comparison, and never read ' +
      'back into a seed, a decision or a game\'s state. Each child\'s own games are built from the shard of ' +
      '`pairing.ts`\'s seed schedule it was handed; nothing about what a child plays depends on when the parent ' +
      'started its clock.',
  },
  {
    file: 'src/runner/matchValidationCli.ts',
    rule: 'date-now',
    occurrences: 4,
    reason:
      'The Unit D validation battery\'s own timing (Milestone 2 bullet 1): the per-phase elapsed line, and R7\'s ' +
      'per-worker-count wall-clock, which is the measurement R7 *is*. Same category as legality/run.ts and ' +
      'match/runner.ts above - reported, never read back; every game the battery plays is built from a pairing or ' +
      'legality seed schedule and nothing it measures feeds a seed, a decision or a game\'s state. This file sits ' +
      'closest to the `agent/src/bench` line of any outside it, since timing genuinely is part of its job (R7). It ' +
      'is not moved there because the other five phases are correctness checks (R1-R6, R8) that must run in the ' +
      'same battery and write the same artifact, and a bench directory that adjudicates criteria would be the ' +
      'wrong file in the wrong place in exactly the way EXCLUDED_DIRECTORIES\' own comment warns about.',
  },
  {
    file: 'src/runner/baselinesValidationCli.ts',
    rule: 'date-now',
    occurrences: 10,
    reason:
      'The Milestone 2 bullet 2 validation battery\'s own timing (Unit D): a per-phase elapsed line, and a ' +
      '`wallClockMs` on each of the five phases that plays games. Same category as `matchValidationCli.ts`\'s ' +
      'entry above, and for the same reason - reported, never read back. Every game the battery plays comes from ' +
      'a pairing or legality seed schedule, and no seed, decision or game state derives from the clock. The ' +
      'occurrence count is high because the battery has seven phases rather than six and each timed one needs a ' +
      '`started` stamp and a difference; there is no timing *criterion* here at all, unlike R7 next door. In fact ' +
      'the opposite: G7 requires the host\'s swap and free-memory state to be recorded beside every elapsed figure ' +
      'precisely so that nobody reads a throughput claim out of this artifact (agent/docs/Baselines.md §7, item 3).',
  },
  {
    file: 'src/rating/report.ts',
    rule: 'date-now',
    occurrences: 2,
    reason:
      'The rating report\'s own `timing.wallClockMs` (Milestone 2 bullet 3, Unit A): a `started` stamp and the ' +
      'difference, on an analysis that reads committed artifacts and plays no games at all. Same category as ' +
      '`match/runner.ts`\'s entry above, and structurally the same statement: these are declared in ' +
      '`RATING_TIMING_FIELDS` (rating/types.ts) and stripped by `stripRatingTimingFields` before criterion P8 ' +
      '(Milestone2_Bullet3_Prompts.md §5) requires two runs with the same inputs and the same `analysisSeed` to be ' +
      'byte-identical - so the allowlist entry and the criterion are two statements of the same fact. Nothing here ' +
      'can reach a game: this module never creates one. Its only randomness is the cluster bootstrap, which draws ' +
      'from `createAgentRandom(analysisSeed)` with `analysisSeed` defaulting to a recorded constant (§2.6, hazard ' +
      'H11) - and note the deliberate absence from this list of any third seed in `core/rng.ts`, which ' +
      'agent/CLAUDE.md §6 forbids.',
  },
  {
    file: 'src/rating/report.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      '`RatingReportHeader.createdAt`: a provenance timestamp stamped once when a rating report is assembled. ' +
      'Identical in kind to `corpus.ts`\'s `createdAt` at the top of this list - it records when the analysis was ' +
      'run, is never compared, and never reaches a decision, a fingerprint or a seed. It is also one of the three ' +
      'entries in `RATING_TIMING_FIELDS`, so P8\'s reproducibility comparison strips it explicitly.',
  },
  {
    file: 'src/rating/ladder.ts',
    rule: 'date-now',
    occurrences: 2,
    reason:
      'The ladder\'s own `timing.wallClockMs` (Milestone 2 bullet 3, Unit B): a `started` stamp and the ' +
      'difference, on an analysis that reads committed artifacts and plays no games. Identical in kind ' +
      'to `src/rating/report.ts`\'s entry above, and covered by the same mechanism: it is one of the ' +
      'three entries in `LADDER_TIMING_FIELDS`, which `stripLadderTimingFields` removes before two ' +
      'builds of one ladder are required to be identical. Nothing here can reach a game - this module ' +
      'never creates one - and its only randomness is the cluster bootstrap the rating fits refit on, ' +
      'which draws from `createAgentRandom(analysisSeed)` (§2.6, hazard H11).',
  },
  {
    file: 'src/rating/ladder.ts',
    rule: 'new-date',
    occurrences: 3,
    reason:
      'Two provenance stamps, both written once and never read back. `LadderHeader.createdAt` (twice: ' +
      '`buildLadder` and `emptyLadder`) is identical in kind to `corpus.ts`\'s and `report.ts`\'s ' +
      '`createdAt` above and is stripped by `LADDER_TIMING_FIELDS`. `SeedBlockAllocation.recordedAt` ' +
      'is the date a seed-block sub-range was recorded as spent (§3.8) - it is *data*, deliberately ' +
      'not stripped, because "recorded before the run" is the entire content of the commitment the ' +
      'ledger makes; the CLI\'s `--recorded-at` overrides it so a retroactive entry can carry the ' +
      'true date rather than today\'s. Neither reaches a decision, a fingerprint or a seed.',
  },
  {
    file: 'src/runner/baselinesValidationCli.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      '`generatedAt` on the assembled artifact: a provenance timestamp stamped once when ' +
      '`docs/data/baselines_validation.json` is written. Identical in kind to `corpus.ts`\'s `createdAt` at the ' +
      'top of this list - it records when the evidence was produced, is never compared, and never reaches a ' +
      'decision, a fingerprint or a seed.',
  },
  {
    file: 'src/runner/ratingValidationCli.ts',
    rule: 'date-now',
    occurrences: 3,
    reason:
      'The Milestone 2 bullet 3 calibration study\'s per-phase elapsed line and the `wallClockMs` it writes into ' +
      'each phase block (Unit C). Same category as `matchValidationCli.ts`\'s entry above - reported, never read ' +
      'back - but with less surface than any of them, because this battery **plays no games at all**: it is pure ' +
      'arithmetic over a seeded generator, so there is no game, no seed schedule and no decision for a clock read ' +
      'to reach even in principle. Its own randomness is `createAgentRandom(cellSeed(analysisSeed, label))` and ' +
      'nothing else, and every cell records the seed it used so one cell can be re-run in isolation. The figures ' +
      'exist so a reader knows what a re-run of a ~7-minute study costs; they are explicitly **not** a performance ' +
      'claim (hazard H10, and this host swaps).',
  },
  {
    file: 'src/runner/ratingValidationCli.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      '`generatedAt` on `docs/data/rating_validation.json`: a provenance timestamp stamped once when the ' +
      'calibration artifact is assembled. Identical in kind to `baselinesValidationCli.ts`\'s entry directly above ' +
      'and to `corpus.ts`\'s `createdAt` at the top of this list.',
  },
  {
    file: 'src/core/candidates/validation.ts',
    rule: 'date-now',
    occurrences: 2,
    reason:
      'The candidate-validation corpus run\'s own `wallClockMs` (Milestone 2 bullet 2, Unit B, criterion G1a). ' +
      'Same category as legality/run.ts above - one elapsed figure, reported in the run summary and the artifact, ' +
      'never read back: the corpus\'s games come from its own seed schedule ' +
      '(`buildCandidateValidationConfigs`), candidate sets are a pure function of the decision and the agent rng ' +
      'stream, and no seed, decision or game state derives from the clock. It is not a performance figure either ' +
      '(hazard H10 - `tsx` understates the simulator ~3.5x); it exists so a later run can be sized.',
  },
  {
    file: 'src/runner/candidatesCli.ts',
    rule: 'date-now',
    occurrences: 2,
    reason:
      'The candidates CLI\'s progress line ("N/200 games (0.42 games/s)"). Identical in kind to legalityCli.ts\'s ' +
      'and matchCli.ts\'s above: console output on a long run, reaching no file, no fingerprint and no decision.',
  },
  {
    file: 'src/regression/runner.ts',
    rule: 'date-now',
    occurrences: 11,
    reason:
      'The regression suite\'s own elapsed figures (Milestone 2 bullet 5, Unit A): a `started` stamp and a ' +
      '`durationMs` for each of L1, L2, the determinism-corpus line and the whole run, plus the smoke-corpus ' +
      'build. Same category as `match/runner.ts`\'s entry above - reported, never read back. A pinned game is ' +
      'built from its identity alone: `match/pairing.ts` derives the engine seed and every per-slot agent seed ' +
      'from the R-block group index (§2.6), so no seed, decision or game state can derive from the clock even in ' +
      'principle. **Structurally, these cannot reach a committed record at all**: a `RegressionRunResult` is ' +
      'console output, and the only things written to disk are `RegressionCorpus` (identity, fingerprints, ' +
      'semantics, coverage, why - no timing field exists on it) and the ledger. That is a stronger statement than ' +
      '`MATCH_TIMING_FIELDS` makes for the match runner, and it is why there is no `stripTimingFields` analogue ' +
      'here: there is nothing to strip.\n\n' +
      'The count is high because criterion S6 pre-commits a budget (<= 5 min compiled, <= 20 min under `tsx`) and ' +
      'the suite has to be able to say whether it held, per layer - a suite that cannot report its own cost is one ' +
      'that gets cut for the wrong reason. Note what that reporting is *not*: Unit A measured the same ' +
      'determinism-corpus verify at 11 s, 102 s, 114 s and 124 s in one session on a host with 4.6 GB of 5.1 GB ' +
      'swap in use, so none of these figures is a performance claim (hazard H10, and this host swaps - see the ' +
      '2026-08-11 Running_Notes entry).',
  },
  {
    file: 'src/regression/runner.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      '`RegressionSection.recordedAt`: the date a section of pinned games was generated, stamped once by ' +
      '`buildSmokeCorpus`. Provenance, in the same kind as `corpus.ts`\'s `createdAt` at the top of this list, ' +
      'with one difference worth stating - it is *data* rather than a header field, because §3.6 makes "generated ' +
      'once, at promotion, and frozen" the defining property of a section, and a section that cannot say when it ' +
      'was frozen cannot support that claim. It is never compared: `compareEntry` reads only the fingerprint and ' +
      'semantic groups, and a rebaseline carries the existing value forward rather than restamping it.',
  },
  {
    file: 'src/regression/ledger.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      '`RebaselineEntry.recordedAt`: when a pinned layer was regenerated (§3.5). Deliberately not stripped and ' +
      'deliberately data, for the same reason `ladder.ts`\'s `SeedBlockAllocation.recordedAt` is - the whole value ' +
      'of an append-only ledger is that its rows are dated, and `RebaselineRequest.recordedAt` overrides it so a ' +
      'spec can assert on a fixed value and a retroactive entry can carry its true date. It reaches no game: this ' +
      'module creates none, and the rebaseline path derives every seed it replays from the corpus identities.',
  },
  {
    file: 'src/regression/mutations.ts',
    rule: 'date-now',
    occurrences: 2,
    reason:
      '`ControlResult.wallClockMs`: how long one negative control took (Milestone 2 bullet 5, Unit D) - a ' +
      '`started` stamp and the subtraction that closes it. Same category as `src/regression/runner.ts`\'s entry ' +
      'above, and structurally further from a game than any of them: **this module plays nothing**. It edits a ' +
      'file in a scratch `git worktree`, spawns a child process, reads a JSON line back and reverts. Every game ' +
      'in a control run is played by that child, from a corpus identity whose engine and per-slot agent seeds ' +
      '`match/pairing.ts` derives from an R-block group index (§2.6), so no seed, decision or game state can ' +
      'derive from this clock read even in principle.\n\n' +
      'The figures are recorded rather than merely printed, and are therefore worth being explicit about: they ' +
      'are **not** performance figures and the record says so in `ControlsRecord.hostNote`, which carries the ' +
      '`sysctl vm.swapusage` reading taken at write time. The host held 4.1-4.2 GB of 5.1 GB swap throughout, and ' +
      'the same eleven controls ranged from 53 s to 400 s - which is the point of keeping the number beside the ' +
      'swap reading rather than dropping it (hazard H6, and Unit A\'s finding 1 in Running_Notes).',
  },
  {
    file: 'src/regression/mutations.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      '`ControlsRecord.recordedAt`: when the negative-control record was written. Provenance, in the same kind as ' +
      '`corpus.ts`\'s `createdAt` at the top of this list. It is never compared and cannot be: the record is read ' +
      'by `controls.spec.ts`, which checks the rows against the register (ids, classes, pre-registered ' +
      'predictions) and never looks at a date, and nothing replays from it.',
  },
  {
    file: 'src/runner/matchValidationCli.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      'The validation artifact\'s `generatedAt` provenance stamp, written once when the battery is assembled. ' +
      'Identical in kind to determinism/corpus.ts\'s `createdAt` above: it lands in the artifact header, is never ' +
      'compared, and never reaches a decision or a fingerprint.',
  },
];

type Violation = {file: string; line: number; rule: string; text: string};

/** Matches one rule against a blob of source, returning 1-based line numbers. Pure - used by both the tree scan and the fixtures. */
function scanText(text: string, rule: Rule): Array<{line: number; text: string}> {
  const pattern = new RegExp(rule.source, 'g');
  const hits: Array<{line: number; text: string}> = [];
  text.split('\n').forEach((line, index) => {
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      hits.push({line: index + 1, text: line.trim()});
    }
  });
  return hits;
}

function listTypeScriptFiles(directory: string): Array<string> {
  const found: Array<string> = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listTypeScriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** Path relative to `agent/`, with forward slashes, so entries read the same on any platform. */
function agentRelative(absolute: string): string {
  return path.relative(AGENT_ROOT, absolute).split(path.sep).join('/');
}

/** Every scanned file, as `agent/`-relative paths, sorted - the excluded directories already removed. */
function scannedFiles(): Array<string> {
  return listTypeScriptFiles(SRC_ROOT)
    .map(agentRelative)
    .filter((file) => !EXCLUDED_DIRECTORIES.some((directory) => file === directory || file.startsWith(directory + '/')))
    .sort();
}

/** Every rule hit in the scanned tree, allowlist *not* applied. */
function rawViolations(): Array<Violation> {
  const violations: Array<Violation> = [];
  for (const file of scannedFiles()) {
    const text = fs.readFileSync(path.join(AGENT_ROOT, file), 'utf8');
    for (const rule of RULES) {
      for (const hit of scanText(text, rule)) {
        violations.push({file, line: hit.line, rule: rule.id, text: hit.text});
      }
    }
  }
  return violations;
}

function isAllowlisted(violation: Violation): boolean {
  return ALLOWLIST.some((entry) => entry.file === violation.file && entry.rule === violation.rule);
}

function describeViolation(violation: Violation): string {
  const rule = RULES.find((candidate) => candidate.id === violation.rule);
  return `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.text}\n      -> ${rule?.why}`;
}

/** Files under `agent/src` (bench included) whose text imports the Engine's Random module. */
function filesImportingEngineRandom(): Array<{file: string; symbols: Array<string>}> {
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*'@\/common\/utils\/Random'/;
  const results: Array<{file: string; symbols: Array<string>}> = [];
  for (const file of listTypeScriptFiles(SRC_ROOT).map(agentRelative).sort()) {
    const match = importPattern.exec(fs.readFileSync(path.join(AGENT_ROOT, file), 'utf8'));
    if (match !== null) {
      results.push({file, symbols: match[1].split(',').map((symbol) => symbol.trim()).filter((symbol) => symbol.length > 0).sort()});
    }
  }
  return results;
}

describe('RNG separation (Milestone 1, bullet 6, sub-task D — P5)', () => {
  describe('the guard itself', () => {
    it('flags a fixture containing each forbidden construct', () => {
      // Negative control. Without this, a typo in any rule's regex turns that rule off silently
      // and the whole spec becomes decorative - it would still pass, on a tree it never matched.
      const fixtures: Record<string, string> = {
        'math-random': 'const roll = Math.random();',
        'date-now': 'const t = Date.now();',
        'new-date': 'const stamped = new Date().toISOString();',
        'process-hrtime': 'const start = process.hrtime.bigint();',
        'performance-now': 'const start = performance.now();',
        'unseeded-random': 'inplaceShuffle(cards, UnseededRandom.INSTANCE);',
        'game-rng': 'const pick = game.rng.nextInt(cards.length);',
      };

      for (const rule of RULES) {
        const fixture = fixtures[rule.id];
        expect(fixture, `every rule needs a fixture that must be flagged; ${rule.id} has none`).to.be.a('string');
        expect(scanText(fixture, rule), `rule '${rule.id}' failed to flag its own fixture: ${fixture}`).to.have.length(1);
      }
    });

    it('does not flag near-misses that are not the hazard', () => {
      // The other half of the control: a rule that flags everything is as useless as one that
      // flags nothing, and would push real code into the allowlist until the allowlist *is* the
      // codebase. Each of these is something agent code may legitimately contain.
      const clean = [
        'const seed = config.rngSeed;', // `rngSeed`, not a `.rng` read - \b stops the match
        'const source = myMath.randomize();', // not `Math.random` - \b stops the match at the `y`
        'const random = createAgentRandom(agentSeed);',
        'const updated = updateDateless(record);',
        'const rng = new SeededRandom(seed, seed);',
        'const conservative = new ConstRandom(0);',
      ].join('\n');

      for (const rule of RULES) {
        expect(scanText(clean, rule), `rule '${rule.id}' flagged a benign line`).to.have.length(0);
      }
    });

    it('actually walks the real source tree', () => {
      // A broken walker (wrong root, wrong extension filter, a readdir that silently returns
      // nothing) produces zero violations, which is indistinguishable from a pass. Pin down that
      // the scan reached files that certainly exist and that the one exclusion really excludes.
      const files = scannedFiles();

      expect(files.length, 'the agent source tree should be substantially larger than this').to.be.greaterThan(15);
      expect(files).to.include('src/core/rng.ts');
      expect(files).to.include('src/engine/gameFactory.ts');
      expect(files).to.include('src/determinism/replay.ts');
      expect(files.filter((file) => file.startsWith('src/bench/')), 'src/bench must be excluded, and it is not empty').to.be.empty;
      expect(listTypeScriptFiles(SRC_ROOT).map(agentRelative).filter((file) => file.startsWith('src/bench/')).length).to.be.greaterThan(0);
    });

    it('has an exact allowlist: every entry matches, matches the stated number of times, and none is stale', () => {
      const violations = rawViolations();

      for (const entry of ALLOWLIST) {
        expect(fs.existsSync(path.join(AGENT_ROOT, entry.file)), `allowlist entry names a file that no longer exists: ${entry.file}`).to.be.true;
        expect(RULES.map((rule) => rule.id), `allowlist entry names an unknown rule: ${entry.rule}`).to.include(entry.rule);
        expect(entry.reason.length, `allowlist entry ${entry.file} [${entry.rule}] must carry a written reason`).to.be.greaterThan(40);

        const matched = violations.filter((violation) => violation.file === entry.file && violation.rule === entry.rule);
        expect(matched.length,
          `allowlist entry ${entry.file} [${entry.rule}] expects ${entry.occurrences} occurrence(s) but found ${matched.length}. ` +
          'Either the allowlisted line moved out (delete the entry) or a new, unreviewed use appeared (review it, then update the count).',
        ).to.equal(entry.occurrences);
      }
    });
  });

  describe('P5 — no agent source outside agent/src/bench touches unseeded randomness or the clock', () => {
    it('finds no unallowlisted violation anywhere under agent/src', () => {
      const violations = rawViolations().filter((violation) => !isAllowlisted(violation));

      expect(violations.length,
        'P5 (blocking, Milestone1_Bullet6_Prompts.md): agent code outside agent/src/bench must draw randomness only from ' +
        'createAgentRandom() and must never read the wall clock. Each line below breaks the reproducibility contract in ' +
        'SRS CON-5/NFR-5 - fix it, or add an explicit ALLOWLIST entry in this file with a written reason:\n' +
        violations.map(describeViolation).join('\n'),
      ).to.equal(0);
    });
  });

  describe('the positive half of the contract — where randomness is *allowed* to come from', () => {
    /*
     * The rules above say what may not happen. Stated alone they would leave the next person to
     * add a search module (M4 determinization, M6 self-play) guessing at what may. The contract
     * is:
     *
     *   Agent decisions  <- AgentRandom, and only ever from createAgentRandom(agentSeed)
     *                       (agent/src/core/rng.ts) or agentRandomFrom(<a deterministic Random>).
     *   Engine state     <- the single `seed` argument createGame() hands Game.newInstance()
     *                       (agent/src/engine/gameFactory.ts), and nothing else.
     *
     * Two separate integers, neither derived from the other, each owning one side of "was that
     * the same game?" vs. "did the Agent make the same decisions?". M4 adds a third consumer
     * (determinization) as a third *named stream*, not as a borrowed draw from either of these -
     * see the seed contract in Determinism_Verification.md.
     */
    it('imports the Engine Random module in exactly two places, and never imports UnseededRandom', () => {
      const importers = filesImportingEngineRandom();

      expect(importers.map((importer) => importer.file)).to.deep.equal([
        // The Agent's own PRNG. Wraps SeededRandom so strategy code never holds an Engine class
        // (NFR-7) and so the seed-degeneracy workaround lives in exactly one place.
        'src/core/rng.ts',
        // ConstRandom(0) - the FR-9 conservative fallback's rng (embeddedDriver.ts:31). Constant
        // by construction: it returns the low end of every range, so it is a *deterministic*
        // Random, not a source of randomness at all.
        'src/driver/embeddedDriver.ts',
      ]);

      const symbols = new Set(importers.flatMap((importer) => importer.symbols));
      expect([...symbols].sort(), 'only deterministic Random implementations may be imported').to.deep.equal(['ConstRandom', 'Random', 'SeededRandom']);
      expect(symbols.has('UnseededRandom'), 'UnseededRandom is Math.random() with a class around it (src/common/utils/Random.ts:41)').to.be.false;
    });

    it('constructs Engine games in exactly one place, passing exactly one seed', () => {
      // The Engine's entire randomness surface for an in-scope game is the `seed` argument to
      // Game.newInstance (everything RNG-driven - board, all four deck shuffles, dealt cards -
      // is drawn from the SeededRandom built from it). Keeping the call in one file is what
      // makes "the Engine seed" a single, auditable thing rather than a convention.
      const callers = listTypeScriptFiles(SRC_ROOT)
        .map(agentRelative)
        .filter((file) => /\bGame\s*\.\s*newInstance\b/.test(fs.readFileSync(path.join(AGENT_ROOT, file), 'utf8')))
        .sort();

      expect(callers).to.deep.equal(['src/engine/gameFactory.ts']);

      const factory = fs.readFileSync(path.join(AGENT_ROOT, 'src/engine/gameFactory.ts'), 'utf8');
      expect(factory, 'the Engine seed must come from the caller-supplied config seed, not from anything ambient')
        .to.match(/resolved\.seed\s*\/\s*SEED_SCALE/);
    });

    it('routes every agent-side draw through createAgentRandom or an explicitly deterministic Random', () => {
      // `new SeededAgentRandom(...)` is private to rng.ts; every other file must go through one
      // of its two exported entry points. This is the assertion that fails when a future search
      // module quietly builds its own PRNG instead of taking an AgentRandom as a parameter.
      const constructors = listTypeScriptFiles(SRC_ROOT)
        .map(agentRelative)
        .filter((file) => /\bnew\s+SeededRandom\b/.test(fs.readFileSync(path.join(AGENT_ROOT, file), 'utf8')))
        .sort();

      expect(constructors, 'SeededRandom may only be constructed inside the Agent\'s own RNG module').to.deep.equal(['src/core/rng.ts']);

      const rng = fs.readFileSync(path.join(AGENT_ROOT, 'src/core/rng.ts'), 'utf8');
      expect(rng, 'createAgentRandom must remain the seeded entry point').to.match(/export function createAgentRandom\(seed: number\)/);
      expect(rng, 'agentRandomFrom must remain the (test/fallback) wrapper for an already-deterministic Random').to.match(/export function agentRandomFrom\(source: Random\)/);
    });
  });
});
