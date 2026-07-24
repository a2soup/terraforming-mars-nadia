import {execSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {ReplayConfig, ReplayFingerprint} from './types';
import {replay} from './replay';

/**
 * Bumped only when the `(runSeed, label)` -> stream derivation Milestone 4 introduces (see
 * Milestone1_Bullet6_Prompts.md, sub-task E section 3) changes in a way that would invalidate
 * previously-committed fingerprints - e.g. the hash function or a stream label changes meaning.
 * `ReplayConfig` stays a flat `{players, engineSeed, agentSeed}` through Milestone 1; this field
 * is a forward hook recorded now so every corpus is self-describing about which derivation (if
 * any) produced its seeds, without implementing that derivation here.
 */
const SEED_DERIVATION_VERSION = 1;

export type CorpusEnvironment = {
  GAME_CACHE: string | undefined;
  MAX_GAME_DAYS: string | undefined;
};

/**
 * Everything needed to know whether a corpus is even comparable against a fresh run (hazard H4:
 * an unpinned environment is not a reproducibility contract). `env` only records the two
 * gameplay-reaching env vars the hazard list identifies (`GameLoader`'s sweep mode via
 * `GAME_CACHE`, and `Game.ts`'s `MAX_GAME_DAYS` read) - not the whole environment.
 */
export type CorpusHeader = {
  engineCommit: string;
  nodeVersion: string;
  agentVersion: string;
  seedDerivationVersion: number;
  env: CorpusEnvironment;
  createdAt: string;
};

export type Corpus = {
  header: CorpusHeader;
  fingerprints: ReadonlyArray<ReplayFingerprint>;
};

/** Reads the current git HEAD, degrading to `'unknown'` rather than throwing outside a checkout. */
function readGitHead(): string {
  try {
    return execSync('git rev-parse HEAD', {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
  } catch {
    return 'unknown';
  }
}

/** Reads `agent/package.json`'s own `version`, relative to this file so it's independent of cwd. */
function readAgentVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {version?: string};
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function currentEnvironment(): CorpusEnvironment {
  return {
    GAME_CACHE: process.env.GAME_CACHE,
    MAX_GAME_DAYS: process.env.MAX_GAME_DAYS,
  };
}

/** Builds a header describing the environment this process is running in, right now. */
export function buildHeader(): CorpusHeader {
  return {
    engineCommit: readGitHead(),
    nodeVersion: process.version,
    agentVersion: readAgentVersion(),
    seedDerivationVersion: SEED_DERIVATION_VERSION,
    env: currentEnvironment(),
    createdAt: new Date().toISOString(),
  };
}

export function buildCorpus(fingerprints: ReadonlyArray<ReplayFingerprint>): Corpus {
  return {header: buildHeader(), fingerprints};
}

/**
 * Writes `corpus` as pretty-printed, diffable JSON. Strips each fingerprint's `diagnostics`
 * (the full move trace and raw `stableState`) before writing - those exist for investigating a
 * single failed comparison in memory, not for a committed corpus, which needs to stay small
 * (Milestone1_Bullet6_Prompts.md, sub-task A section 3).
 */
export function saveCorpus(filePath: string, corpus: Corpus): void {
  const stripped: Corpus = {
    header: corpus.header,
    fingerprints: corpus.fingerprints.map(({diagnostics: _diagnostics, ...fingerprint}) => fingerprint),
  };
  fs.writeFileSync(filePath, JSON.stringify(stripped, null, 2) + '\n');
}

export function loadCorpus(filePath: string): Corpus {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Corpus;
}

/** Thrown when a corpus's header is not compatible with the environment attempting to verify it. */
export class CorpusHeaderMismatchError extends Error {}

/**
 * Throws {@link CorpusHeaderMismatchError} unless `header` was produced under an engine commit,
 * seed-derivation version, and gameplay-reaching environment (`GAME_CACHE`, `MAX_GAME_DAYS`)
 * compatible with `current` (default: right now). A corpus without a matching environment is not
 * a reproducibility check - it's a different, unstated question (hazard H4) - so this is a hard
 * rejection, not a warning: "a corpus with a mismatched header is rejected rather than silently
 * compared" (sub-task A's negative-control requirement).
 *
 * `engineCommit` is only compared when both sides know it (neither is `'unknown'`) - outside a
 * git checkout there is nothing meaningful to compare, and refusing to *ever* verify in that
 * case would be worse than not checking this one field.
 */
export function assertHeaderCompatible(header: CorpusHeader, current: CorpusHeader = buildHeader()): void {
  const mismatches: Array<string> = [];

  if (header.engineCommit !== 'unknown' && current.engineCommit !== 'unknown' && header.engineCommit !== current.engineCommit) {
    mismatches.push(`engineCommit: corpus=${header.engineCommit} current=${current.engineCommit}`);
  }
  if (header.seedDerivationVersion !== current.seedDerivationVersion) {
    mismatches.push(`seedDerivationVersion: corpus=${header.seedDerivationVersion} current=${current.seedDerivationVersion}`);
  }
  if (header.env.GAME_CACHE !== current.env.GAME_CACHE) {
    mismatches.push(`env.GAME_CACHE: corpus=${JSON.stringify(header.env.GAME_CACHE)} current=${JSON.stringify(current.env.GAME_CACHE)}`);
  }
  if (header.env.MAX_GAME_DAYS !== current.env.MAX_GAME_DAYS) {
    mismatches.push(`env.MAX_GAME_DAYS: corpus=${JSON.stringify(header.env.MAX_GAME_DAYS)} current=${JSON.stringify(current.env.MAX_GAME_DAYS)}`);
  }

  if (mismatches.length > 0) {
    throw new CorpusHeaderMismatchError(
      `Corpus header is not compatible with the current environment, so re-running it would not be a ` +
      `meaningful determinism check (SRS CON-5/NFR-5, hazard H4): ${mismatches.join('; ')}`,
    );
  }
}

/** The `ReplayFingerprint` fields `verifyCorpus` compares - every field except `config` itself and `diagnostics`. */
export const COMPARABLE_FINGERPRINT_FIELDS = ['moveTraceHash', 'stableStateHash', 'resultHash', 'decisions', 'fallbacks', 'generation'] as const;

export type ComparableFingerprintField = typeof COMPARABLE_FINGERPRINT_FIELDS[number];

export type FingerprintMismatch = {
  config: ReplayConfig;
  field: ComparableFingerprintField;
  expected: unknown;
  actual: unknown;
};

export type VerifyReport = {
  configsChecked: number;
  mismatches: ReadonlyArray<FingerprintMismatch>;
};

/** Whether two fingerprints agree on every {@link COMPARABLE_FINGERPRINT_FIELDS} field. */
export function fingerprintsMatch(a: ReplayFingerprint, b: ReplayFingerprint): boolean {
  return COMPARABLE_FINGERPRINT_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Re-runs every fingerprint in `corpus` (via `replay` by default - overridable so tests can
 * inject a fake) and reports every field that doesn't match. This is `--verify`'s durable
 * payoff (determinismCli.ts): a committed corpus becomes a standing regression check, not a
 * one-time measurement.
 *
 * Rejects the corpus outright (via {@link assertHeaderCompatible}) before comparing anything -
 * see that function's doc comment for why a mismatched header must not be silently compared.
 */
export function verifyCorpus(corpus: Corpus, replayFn: (config: ReplayConfig) => ReplayFingerprint = replay): VerifyReport {
  assertHeaderCompatible(corpus.header);

  const mismatches: Array<FingerprintMismatch> = [];
  for (const expected of corpus.fingerprints) {
    const actual = replayFn(expected.config);
    for (const field of COMPARABLE_FINGERPRINT_FIELDS) {
      if (expected[field] !== actual[field]) {
        mismatches.push({config: expected.config, field, expected: expected[field], actual: actual[field]});
      }
    }
  }
  return {configsChecked: corpus.fingerprints.length, mismatches};
}
