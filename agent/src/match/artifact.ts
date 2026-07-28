import * as fs from 'fs';
import * as path from 'path';
import {HistoryTier, MatchRunReport} from './types';

/**
 * Reading and writing the match artifact.
 *
 * **The artifact *is* the report.** Unlike `legality/artifact.ts`, which adds a provenance header
 * at save time, {@link MatchRunReport} already carries its header - the runner needs the run id and
 * the pairing description while it is running, not only when it writes. So there is no separate
 * artifact type to keep in step with the report type, and no way for the two to drift.
 *
 * Two things this module owns beyond `JSON.parse`/`stringify`:
 *
 * 1. **The declared timing fields** ({@link MATCH_TIMING_FIELDS}, {@link stripTimingFields}).
 *    Criteria R2 (two runs of the same specification produce identical records) and R6 (the pooled
 *    artifact is byte-identical to the single-process one) are both stated "modulo the declared
 *    timing fields". Declaring them in code rather than in prose is what makes those criteria
 *    mechanically checkable instead of a matter of judgement, and it is why the runner keeps its
 *    non-deterministic output to a minimum: every field on this list is a field R6 cannot check.
 * 2. **The retention convention** ({@link defaultOutputDir}, §4.7). `summary`/`trace` artifacts are
 *    small and are committed for named runs; `moves`-tier output is tens of megabytes and is not.
 *    The default destination is the mechanism that enforces that; the `.gitignore` entry for
 *    `agent/runs/` is the backstop. A default that wrote to `docs/data/` and relied on the operator
 *    remembering is the failure mode the convention exists to prevent.
 */

/**
 * Fields whose values legitimately differ between two runs of the same specification. Everything
 * *not* on this list is required to be identical, which is the whole content of R2 and R6.
 *
 * Paths are dotted, with `games[]` meaning "on every game row".
 */
export const MATCH_TIMING_FIELDS: ReadonlyArray<string> = [
  'header.provenance.createdAt',
  'summary.timing',
  'games[].durationMs',
];

/** The artifact with {@link MATCH_TIMING_FIELDS} removed, ready for an R2/R6 comparison. */
export function stripTimingFields(report: MatchRunReport): unknown {
  const {createdAt: _createdAt, ...provenance} = report.header.provenance;
  const {timing: _timing, ...summary} = report.summary;
  return {
    ...report,
    header: {...report.header, provenance},
    summary,
    games: report.games.map(({durationMs: _durationMs, ...game}) => game),
  };
}

/** True when two reports agree on everything except {@link MATCH_TIMING_FIELDS}. */
export function reportsMatch(a: MatchRunReport, b: MatchRunReport): boolean {
  return JSON.stringify(stripTimingFields(a)) === JSON.stringify(stripTimingFields(b));
}

/**
 * The repo root, found by walking up from this file until a directory containing
 * `agent/package.json` appears.
 *
 * Not `path.join(__dirname, '..', '..', '..')`, which is right only when running from source: the
 * compiled build puts this module at `build/agent/agent/src/match/artifact.js` (hazard H5 requires
 * every throughput number to come from that build), and a fixed number of `..` would resolve the
 * default output directory to `build/agent/agent/docs/data` - a path that exists nowhere, is not
 * gitignored, and would silently swallow a validation artifact. Walking up finds the real root
 * from either layout, because the compiled tree contains no `package.json` to stop at.
 *
 * Falls back to the working directory if no such ancestor exists (an unpacked copy of the agent
 * outside the repo), which keeps `--out` usable rather than throwing on module load.
 */
function repoRoot(): string {
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

/**
 * Where a run of this tier writes by default (§4.7):
 *
 * | Tier | Destination | Committed |
 * | --- | --- | --- |
 * | `summary`, `trace` | `agent/docs/data/` | yes, for named runs |
 * | `moves` | `agent/runs/` | **no** - gitignored |
 */
export function defaultOutputDir(tier: HistoryTier): string {
  return tier === 'moves' ?
    path.join(repoRoot(), 'agent', 'runs') :
    path.join(repoRoot(), 'agent', 'docs', 'data');
}

/** The committed-artifact directory, used by {@link assertRetentionPolicy}. */
function committedDir(): string {
  return path.join(repoRoot(), 'agent', 'docs', 'data');
}

/**
 * Refuses to write a `moves`-tier artifact into the committed data directory (§4.7's backstop, in
 * code). A 40 MB artifact that reaches `git status` has already cost someone the decision it was
 * meant to make for them, and "the operator will remember" is not a retention convention.
 */
export function assertRetentionPolicy(filePath: string, tier: HistoryTier): void {
  if (tier !== 'moves') {
    return;
  }
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(committedDir() + path.sep)) {
    throw new Error(
      `refusing to write a 'moves'-tier artifact to ${resolved}: agent/docs/data/ is committed and ` +
      `moves-tier output is not (Milestone2_Bullet1_Prompts.md §4.7). Write it under agent/runs/ instead.`,
    );
  }
}

/**
 * Resolves `--out`. A bare filename (no directory separator) is resolved against the tier's
 * default directory, so `--out validation.json` lands in the right place without the operator
 * knowing the convention; an explicit path is respected, subject to
 * {@link assertRetentionPolicy}.
 */
export function resolveOutputPath(out: string, tier: HistoryTier): string {
  const resolved = out.includes(path.sep) || out.includes('/') ?
    path.resolve(out) :
    path.join(defaultOutputDir(tier), out);
  assertRetentionPolicy(resolved, tier);
  return resolved;
}

/**
 * Writes the artifact with the header and summary pretty-printed and the game rows one per line.
 * Fully pretty-printing 1,000+ rows would triple the file for no gain - the same call
 * `legality/artifact.ts` made, for the same reason: a per-game row is read as a record, not
 * navigated as a tree, and one-per-line keeps both `git diff` and a `grep` for a failing seed
 * usable.
 */
export function saveMatchArtifact(filePath: string, report: MatchRunReport): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const {games, ...rest} = report;
  const head = JSON.stringify(rest, null, 2);
  const rows = games.map((game) => `    ${JSON.stringify(game)}`).join(',\n');
  fs.writeFileSync(filePath, `${head.slice(0, head.length - 2)},\n  "games": [\n${rows}\n  ]\n}\n`);
}

export function loadMatchArtifact(filePath: string): MatchRunReport {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as MatchRunReport;
}
