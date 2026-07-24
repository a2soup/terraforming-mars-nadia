import {IGame} from '@/server/IGame';
import {createGame} from '../engine/gameFactory';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {createAgentRandom} from '../core/rng';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {runGame} from '../driver/embeddedDriver';
import {
  COMPARABLE_FINGERPRINT_FIELDS,
  ComparableFingerprintField,
  fingerprintsMatch,
} from './corpus';
import {firstDivergence, replay} from './replay';
import {ReplayConfig, ReplayFingerprint, TraceStep} from './types';

/**
 * The seed x player-count sweep (Milestone 1, bullet 6, sub-task B; see
 * agent/docs/Milestone1_Bullet6_Prompts.md). Answers P1 (in-process replay reproducibility),
 * P4 (the exclusion set is still exactly the four known field families) and, via
 * childReplay.ts, P2 (process independence). This file is "mechanical once sub-task A exists"
 * (the routing table's own description): everything here composes `replay()` and `corpus.ts`'s
 * comparison helpers, which sub-task A already built and tested.
 *
 * Every check here is committed, not sampled from `Math.random()` - a fixed, explicit list
 * costs nothing and removes any question about whether a generated range happens to correlate
 * with something (Milestone1_Bullet6_Prompts.md sub-task B, "In-process (P1)"). The lists are
 * written out in full below rather than built by a `for` loop over consecutive integers, so
 * they read as an explicit, auditable set rather than "a bare range".
 */

// 50 engine seeds: base 500,000 with a fixed prime stride of 977, so the list is spread out and
// visibly not a trivial 1..50 range, while still being a plain, auditable, committed list.
export const ENGINE_SEEDS: ReadonlyArray<number> = [
  500000, 500977, 501954, 502931, 503908, 504885, 505862, 506839, 507816, 508793,
  509770, 510747, 511724, 512701, 513678, 514655, 515632, 516609, 517586, 518563,
  519540, 520517, 521494, 522471, 523448, 524425, 525402, 526379, 527356, 528333,
  529310, 530287, 531264, 532241, 533218, 534195, 535172, 536149, 537126, 538103,
  539080, 540057, 541034, 542011, 542988, 543965, 544942, 545919, 546896, 547873,
];

// Two agent seeds, chosen with no arithmetic relationship to each other or to the engine seeds
// above (SRS CON-5: the two seed spaces are independent by construction, and the sweep must not
// accidentally couple them).
export const AGENT_SEEDS: ReadonlyArray<number> = [1000003, 2000133];

export const SWEEP_PLAYER_COUNTS: ReadonlyArray<2 | 3 | 4> = [2, 3, 4];

/** Cross product of `players` x `engineSeeds` x `agentSeeds`, in a fixed, deterministic order. */
export function buildSweepConfigs(
  players: ReadonlyArray<2 | 3 | 4> = SWEEP_PLAYER_COUNTS,
  engineSeeds: ReadonlyArray<number> = ENGINE_SEEDS,
  agentSeeds: ReadonlyArray<number> = AGENT_SEEDS,
): ReadonlyArray<ReplayConfig> {
  const configs: Array<ReplayConfig> = [];
  for (const p of players) {
    for (const engineSeed of engineSeeds) {
      for (const agentSeed of agentSeeds) {
        configs.push({players: p, engineSeed, agentSeed});
      }
    }
  }
  return configs;
}

function configKey(config: ReplayConfig): string {
  return `${config.players}|${config.engineSeed}|${config.agentSeed}`;
}

/** Replays every config once and returns a lookup keyed by `configKey`, for reuse across checks. */
export function computeFingerprints(configs: ReadonlyArray<ReplayConfig>): Map<string, ReplayFingerprint> {
  const map = new Map<string, ReplayFingerprint>();
  for (const config of configs) {
    map.set(configKey(config), replay(config));
  }
  return map;
}

/** One config that failed to reproduce itself in-process (P1) - a Milestone-1 blocker, never a recorded risk. */
export type InProcessMismatch = {
  config: ReplayConfig;
  fields: ReadonlyArray<ComparableFingerprintField>;
  firstDivergenceIndex?: number;
  divergingSteps?: {a?: TraceStep; b?: TraceStep};
};

export type InProcessSweepReport = {
  configsRun: number;
  mismatches: ReadonlyArray<InProcessMismatch>;
};

/**
 * P1: for every config, replay it twice in this process and confirm the fingerprints agree on
 * every comparable field. On a mismatch, re-replays with `{diagnostics: true}` to localize the
 * first diverging decision (hazard H6) rather than reporting only "hashes differ" - the
 * re-replay is safe because a same-process mismatch is expected to reproduce deterministically;
 * if it doesn't, that non-reproduction is itself the headline finding and is reported as such
 * (a `firstDivergenceIndex` of `undefined` alongside a recorded `fields` mismatch means exactly
 * that: the second localization attempt didn't reproduce the first mismatch).
 */
export function runInProcessSweep(configs: ReadonlyArray<ReplayConfig>): InProcessSweepReport {
  const mismatches: Array<InProcessMismatch> = [];

  for (const config of configs) {
    const a = replay(config);
    const b = replay(config);
    if (fingerprintsMatch(a, b)) {
      continue;
    }

    const fields = COMPARABLE_FINGERPRINT_FIELDS.filter((field) => a[field] !== b[field]);
    const da = replay(config, {diagnostics: true});
    const db = replay(config, {diagnostics: true});
    const divergence = firstDivergence(da.diagnostics!.trace, db.diagnostics!.trace);

    mismatches.push({
      config,
      fields,
      firstDivergenceIndex: divergence?.index,
      divergingSteps: divergence && {a: divergence.a, b: divergence.b},
    });
  }

  return {configsRun: configs.length, mismatches};
}

export type IndependenceReport = {
  /** Fraction of (players, engineSeed) pairs where varying the agent seed changed every hash. Expect near-100%, not exactly 1.0 (Milestone1_Bullet6_Prompts.md sub-task B). */
  agentSeedVariationDivergenceRate: number;
  agentSeedVariationPairsChecked: number;
  /** Fraction of (players, agentSeed) pairs where varying the engine seed changed every hash. */
  engineSeedVariationDivergenceRate: number;
  engineSeedVariationPairsChecked: number;
};

/**
 * Asserts the *independence* direction over the whole sweep (Milestone1_Bullet6_Prompts.md
 * sub-task B): holding the engine seed fixed and varying the agent seed should change the
 * outcome for the large majority of configs, and vice versa. Reports a rate rather than
 * asserting equality to 1.0 - two agent seeds can coincidentally reach the same game,
 * especially in short games, and a hard assertion here would be a flaky test reporting a
 * determinism failure that isn't one.
 */
export function checkIndependence(
  fingerprints: ReadonlyMap<string, ReplayFingerprint>,
  players: ReadonlyArray<2 | 3 | 4> = SWEEP_PLAYER_COUNTS,
  engineSeeds: ReadonlyArray<number> = ENGINE_SEEDS,
  agentSeeds: ReadonlyArray<number> = AGENT_SEEDS,
): IndependenceReport {
  let agentSeedVariationPairsChecked = 0;
  let agentSeedVariationDivergences = 0;
  let engineSeedVariationPairsChecked = 0;
  let engineSeedVariationDivergences = 0;

  const get = (config: ReplayConfig): ReplayFingerprint | undefined => fingerprints.get(configKey(config));

  for (const p of players) {
    // Engine seed fixed, agent seed varied.
    for (const engineSeed of engineSeeds) {
      for (let i = 0; i < agentSeeds.length; i++) {
        for (let j = i + 1; j < agentSeeds.length; j++) {
          const a = get({players: p, engineSeed, agentSeed: agentSeeds[i]});
          const b = get({players: p, engineSeed, agentSeed: agentSeeds[j]});
          if (a === undefined || b === undefined) {
            continue;
          }
          agentSeedVariationPairsChecked++;
          if (!fingerprintsMatch(a, b)) {
            agentSeedVariationDivergences++;
          }
        }
      }
    }

    // Agent seed fixed, engine seed varied.
    for (const agentSeed of agentSeeds) {
      for (let i = 0; i < engineSeeds.length; i++) {
        for (let j = i + 1; j < engineSeeds.length; j++) {
          const a = get({players: p, engineSeed: engineSeeds[i], agentSeed});
          const b = get({players: p, engineSeed: engineSeeds[j], agentSeed});
          if (a === undefined || b === undefined) {
            continue;
          }
          engineSeedVariationPairsChecked++;
          if (!fingerprintsMatch(a, b)) {
            engineSeedVariationDivergences++;
          }
        }
      }
    }
  }

  return {
    agentSeedVariationDivergenceRate: agentSeedVariationPairsChecked > 0 ? agentSeedVariationDivergences / agentSeedVariationPairsChecked : NaN,
    agentSeedVariationPairsChecked,
    engineSeedVariationDivergenceRate: engineSeedVariationPairsChecked > 0 ? engineSeedVariationDivergences / engineSeedVariationPairsChecked : NaN,
    engineSeedVariationPairsChecked,
  };
}

/** One JSON path that differed between two raw serializations of the same config. */
export type FieldDiff = {path: string; a: unknown; b: unknown};

/**
 * The four known field families (Running Notes 2026-07-21; `stableState.ts`'s doc comment) that
 * are expected to differ between same-seed replays, because they're wall-clock-derived rather
 * than RNG-driven. Expressed as path *classifiers* (array indices collapsed to `[]`) so a diff
 * at `players[2].timer.sumElapsed` and one at `players[0].timer.sumElapsed` both classify as the
 * same family, matching how `stableState.ts` strips the whole `timer` key regardless of index.
 */
const KNOWN_FAMILY_CLASSIFIERS: ReadonlyArray<{name: string; matches: (path: string) => boolean}> = [
  {name: 'name', matches: (path) => path === 'name'},
  {name: 'createdTimeMs', matches: (path) => path === 'createdTimeMs'},
  {name: 'gameLog[].timestamp', matches: (path) => /^gameLog\[\d+\]\.timestamp$/.test(path)},
  {name: 'players[].timer', matches: (path) => /^players\[\d+\]\.timer(\..*)?$/.test(path)},
];

/** The exact known exclusion set (P4's expected answer), exported so callers/tests can assert against it directly. */
export const KNOWN_FIELD_FAMILIES: ReadonlyArray<string> = KNOWN_FAMILY_CLASSIFIERS.map((c) => c.name);

/** Classifies a diff path into one of the known families, or into a generic (index-collapsed) family name otherwise. */
export function classifyFieldFamily(path: string): string {
  const known = KNOWN_FAMILY_CLASSIFIERS.find((c) => c.matches(path));
  return known ? known.name : path.replace(/\[\d+\]/g, '[]');
}

/** Recursively diffs two JSON-shaped values, collecting every leaf path at which they disagree. */
export function diffJson(a: unknown, b: unknown, path = ''): ReadonlyArray<FieldDiff> {
  const out: Array<FieldDiff> = [];
  diffJsonInto(a, b, path, out);
  return out;
}

function diffJsonInto(a: unknown, b: unknown, path: string, out: Array<FieldDiff>): void {
  if (a === b) {
    return;
  }
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  const aIsObject = a !== null && typeof a === 'object';
  const bIsObject = b !== null && typeof b === 'object';

  if (aIsArray || bIsArray) {
    const aArr = aIsArray ? (a as ReadonlyArray<unknown>) : [];
    const bArr = bIsArray ? (b as ReadonlyArray<unknown>) : [];
    const length = Math.max(aArr.length, bArr.length);
    for (let i = 0; i < length; i++) {
      diffJsonInto(aArr[i], bArr[i], `${path}[${i}]`, out);
    }
    return;
  }

  if (aIsObject && bIsObject) {
    const aRec = a as Record<string, unknown>;
    const bRec = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aRec), ...Object.keys(bRec)]);
    for (const key of keys) {
      diffJsonInto(aRec[key], bRec[key], path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }

  out.push({path, a, b});
}

/** Replays `config` once and returns the *raw* `serialize()` output (not `stableState`) - what P4 needs to diff. */
function rawSerialize(config: ReplayConfig): unknown {
  const game: IGame = createGame({players: config.players, seed: config.engineSeed});
  const agent = randomLegalAgent(createAgentRandom(config.agentSeed));
  runGame(game, agent);
  // Round-trip through JSON so the diff only ever sees plain JSON-shaped values, matching what
  // actually gets persisted/compared - `serialize()`'s declared type is already JSON-safe, this
  // just normalizes it defensively.
  return JSON.parse(JSON.stringify(game.serialize()));
}

export type P4ConfigResult = {config: ReplayConfig; diffs: ReadonlyArray<FieldDiff>};

export type P4Report = {
  configsSampled: number;
  results: ReadonlyArray<P4ConfigResult>;
  /** Family names seen across every sampled config that are outside {@link KNOWN_FIELD_FAMILIES}. */
  unexpectedFamilies: ReadonlyArray<string>;
};

/**
 * P4: for a sample of configs, diffs the raw `serialize()` output (not `stableState`) between
 * two same-seed replays and enumerates every differing JSON path, classified into a field
 * family. The expected answer is exactly {@link KNOWN_FIELD_FAMILIES}; anything else is
 * reported with its path and both values so sub-task E can adjudicate it (P4 is a *recorded*
 * criterion - this function only reports, it does not decide whether to extend
 * `stableState.ts`'s exclusion set).
 */
export function runP4Diff(configs: ReadonlyArray<ReplayConfig>): P4Report {
  const results: Array<P4ConfigResult> = [];
  const unexpectedFamilies = new Set<string>();

  for (const config of configs) {
    const a = rawSerialize(config);
    const b = rawSerialize(config);
    const diffs = diffJson(a, b);
    for (const diff of diffs) {
      const family = classifyFieldFamily(diff.path);
      if (!KNOWN_FIELD_FAMILIES.includes(family)) {
        unexpectedFamilies.add(family);
      }
    }
    results.push({config, diffs});
  }

  return {configsSampled: configs.length, results, unexpectedFamilies: [...unexpectedFamilies].sort()};
}

function formatDivergingStep(label: string, step: TraceStep | undefined): string {
  if (step === undefined) {
    return `  ${label}: <no step recorded at this index>`;
  }
  return `  ${label}: ${step.stepInput}`;
}

function main(): void {
  ensureHeadlessEngine();

  const configs = buildSweepConfigs();
  console.log(`[sweep] P1: replaying ${configs.length} configs twice each, in-process...`);
  const p1 = runInProcessSweep(configs);
  console.log(`[sweep] P1: ${p1.mismatches.length} mismatch(es) out of ${p1.configsRun} config(s).`);
  for (const mismatch of p1.mismatches) {
    console.error(
      `[sweep] P1 MISMATCH players=${mismatch.config.players} engineSeed=${mismatch.config.engineSeed} ` +
      `agentSeed=${mismatch.config.agentSeed}: fields=${mismatch.fields.join(',')} ` +
      `firstDivergenceIndex=${mismatch.firstDivergenceIndex ?? '<not reproduced>'}`,
    );
    if (mismatch.divergingSteps) {
      console.error(formatDivergingStep('a', mismatch.divergingSteps.a));
      console.error(formatDivergingStep('b', mismatch.divergingSteps.b));
    }
  }

  console.log('[sweep] computing single-fingerprint pass for the independence check...');
  const fingerprints = computeFingerprints(configs);
  const independence = checkIndependence(fingerprints);
  console.log(
    `[sweep] independence: varying agent seed changes outcome ${(independence.agentSeedVariationDivergenceRate * 100).toFixed(1)}% ` +
    `of ${independence.agentSeedVariationPairsChecked} pair(s); varying engine seed changes outcome ` +
    `${(independence.engineSeedVariationDivergenceRate * 100).toFixed(1)}% of ${independence.engineSeedVariationPairsChecked} pair(s).`,
  );

  const p4Sample = buildSweepConfigs(SWEEP_PLAYER_COUNTS, ENGINE_SEEDS.slice(0, 5), AGENT_SEEDS.slice(0, 1));
  console.log(`[sweep] P4: diffing raw serialize() for ${p4Sample.length} sampled config(s)...`);
  const p4 = runP4Diff(p4Sample);
  const totalDiffs = p4.results.reduce((sum, r) => sum + r.diffs.length, 0);
  console.log(`[sweep] P4: ${totalDiffs} differing field(s) across ${p4.configsSampled} config(s).`);
  if (p4.unexpectedFamilies.length > 0) {
    console.error(`[sweep] P4: unexpected field families (outside the known four): ${p4.unexpectedFamilies.join(', ')}`);
    for (const result of p4.results) {
      for (const diff of result.diffs) {
        if (!KNOWN_FIELD_FAMILIES.includes(classifyFieldFamily(diff.path))) {
          console.error(`  players=${result.config.players} engineSeed=${result.config.engineSeed}: ${diff.path} a=${JSON.stringify(diff.a)} b=${JSON.stringify(diff.b)}`);
        }
      }
    }
  } else {
    console.log(`[sweep] P4: every differing field is one of the known four families: ${KNOWN_FIELD_FAMILIES.join(', ')}.`);
  }

  if (p1.mismatches.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
