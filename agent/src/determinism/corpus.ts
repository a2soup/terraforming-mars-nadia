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

/**
 * The pinned Engine commit (agent/CLAUDE.md section 2) - the thing that actually determines Engine
 * behaviour, and therefore the only commit a fingerprint depends on. Verified at bullet-6
 * write-up time: this commit is an ancestor of HEAD and `git diff <pin>..HEAD -- src/` is empty,
 * so "the Engine is frozen at the pin" is a checked fact, not just policy.
 *
 * **Do not replace this with the repo's HEAD.** That was the original implementation and it made
 * every committed corpus unverifiable on the *next* commit, including docs-only ones: the header
 * recorded the agent commit that happened to produce it, `assertHeaderCompatible` compared it
 * against the current HEAD, and `--verify` threw `CorpusHeaderMismatchError` before it compared a
 * single fingerprint. See Determinism_Verification.md, "Defects this write-up fixed".
 */
const ENGINE_PIN = '868714d72a434ab68fe08e5570ebc6863859ae15';

export type CorpusEnvironment = {
  GAME_CACHE: string | undefined;
  MAX_GAME_DAYS: string | undefined;
};

/**
 * Everything needed to know whether a corpus is even comparable against a fresh run (hazard H4:
 * an unpinned environment is not a reproducibility contract). `env` only records the two
 * gameplay-reaching env vars the hazard list identifies (`GameLoader`'s sweep mode via
 * `GAME_CACHE`, and `Game.ts`'s `MAX_GAME_DAYS` read) - not the whole environment.
 *
 * **Recorded vs. compared.** `assertHeaderCompatible` rejects on only three of these fields:
 * `engineCommit`, `seedDerivationVersion`, and `env`. The rest (`agentCommit`, `nodeVersion`,
 * `agentVersion`, `createdAt`) are provenance - written down, never used to reject.
 *
 * The distinction is deliberate, and it is the difference between a check that works and one
 * that hides things. A header rejection means *"this comparison would be meaningless"*; a
 * fingerprint mismatch means *"something that matters changed"*. Node version and agent code are
 * in the second category: if a Node upgrade or a change to the enumerator alters a game, the
 * useful outcome is `--verify` reporting exactly which configs moved, not a blanket refusal to
 * look. Rejecting on those would convert this bullet's most informative signal into silence.
 */
export type CorpusHeader = {
  /** The pinned Engine commit ({@link ENGINE_PIN}) - compared. Not the repo's HEAD; see that constant. */
  engineCommit: string;
  /** Repo HEAD when the corpus was written. Provenance only - never compared (see the type doc). */
  agentCommit: string;
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
    engineCommit: ENGINE_PIN,
    agentCommit: readGitHead(),
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
 * `engineCommit` is the pinned Engine commit, which is a compiled-in constant rather than
 * something read from the environment, so both sides always know it. It is still compared
 * defensively (a corpus written before this field's meaning was fixed carries an agent commit
 * hash here, and must be rejected rather than silently compared): the `'unknown'` escape below
 * only matters for such legacy corpora and for anything that ever reintroduces a git read here.
 *
 * `nodeVersion`, `agentVersion` and `agentCommit` are deliberately *not* compared - see
 * {@link CorpusHeader} for why a changed agent or Node version must surface as a fingerprint
 * mismatch rather than a header rejection.
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
