import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {replay} from './replay';
import {ReplayConfig, ReplayFingerprint} from './types';

/**
 * Process independence (Milestone 1, bullet 6, sub-task B, P2): every check sub-task A/bullet 5
 * ever ran replayed two games back-to-back in *one* Node process
 * (agent/docs/Milestone1_Bullet6_Prompts.md, "What is already known"). Nothing has ever
 * verified that a config replayed in a **fresh** process reproduces the fingerprint an
 * in-process run already committed to. This module spawns exactly that fresh process, per
 * config, via `tsx` re-invoking this same file in a small "worker" mode (see `main()` below) -
 * the same "responder wrapper"-style instrumentation-from-outside discipline sub-task A used,
 * applied here to process boundaries instead of the responder.
 *
 * `tsx` startup dominates a child invocation (~0.5-1s), which is why the sub-task caps this at
 * "≥20 configs is the target, not ≥1,000" rather than reusing the full sweep.
 */

const WORKER_FLAG = '--worker-configs';
const WORKER_OUT_FLAG = '--worker-out';

/** `tsx`'s package.json doesn't export `./dist/cli.mjs` directly, so resolve it relative to the package's own root instead of via a subpath import. */
const TSX_CLI_PATH = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

/** Everything a cross-process replay needs to be judged meaningful (hazard H4): what env it actually ran under. */
export type ChildReplayResult = {
  config: ReplayConfig;
  fingerprint: ReplayFingerprint;
};

/**
 * Spawns exactly one fresh `tsx` process to replay every config in `configs`, in order, and
 * returns one fingerprint per config. Passing more than one config to a single call means that
 * child no longer tests process independence for any config but the first (sub-task B's own
 * caveat) - callers that want a true per-config fresh process should use
 * {@link runOneConfigPerChildProcess} instead. This function exists for callers that
 * deliberately want to batch (e.g. a quick smoke check), and it is the primitive
 * `runOneConfigPerChildProcess` calls once per config.
 *
 * `env` is passed through explicitly (default: the current process's env) and is the caller's
 * responsibility to record alongside the result - a child that silently inherits a different
 * `GAME_CACHE` than intended makes any comparison meaningless (Milestone1_Bullet6_Prompts.md,
 * sub-task B, "Cross-process (P2)").
 */
export function runConfigsInFreshProcess(
  configs: ReadonlyArray<ReplayConfig>,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<ReplayFingerprint> {
  if (configs.length === 0) {
    return [];
  }
  // The child writes its result to a temp file rather than stdout: the Engine itself logs to
  // stdout during play (e.g. `Cache.mark`'s `console.log` - hazard H3 - and module-load-time
  // logging), so anything printed there is unavoidably interleaved with those lines and cannot
  // be parsed as clean JSON. A dedicated file sidesteps that entirely. Invoking tsx's CLI script
  // directly with the current `node` (rather than `npx tsx`) also avoids `npx`'s own stdout
  // resolution chatter, though the file handoff would be safe either way.
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-determinism-')), 'result.json');
  try {
    execFileSync(
      process.execPath,
      [TSX_CLI_PATH, __filename, WORKER_FLAG, JSON.stringify(configs), WORKER_OUT_FLAG, outPath],
      {env, stdio: ['ignore', 'ignore', 'inherit']},
    );
    return JSON.parse(fs.readFileSync(outPath, 'utf8')) as ReadonlyArray<ReplayFingerprint>;
  } finally {
    fs.rmSync(path.dirname(outPath), {recursive: true, force: true});
  }
}

/**
 * The P2-proper primitive: one fresh process *per* config, so every result genuinely tests
 * process independence rather than only the first config in a batch.
 */
export function runOneConfigPerChildProcess(
  configs: ReadonlyArray<ReplayConfig>,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<ChildReplayResult> {
  return configs.map((config) => ({
    config,
    fingerprint: runConfigsInFreshProcess([config], env)[0],
  }));
}

export type ProcessIndependenceMismatch = {
  config: ReplayConfig;
  field: string;
  inProcess: unknown;
  crossProcess: unknown;
};

export type ProcessIndependenceReport = {
  configsChecked: number;
  mismatches: ReadonlyArray<ProcessIndependenceMismatch>;
};

/**
 * P2 itself: compares each config's **in-process** fingerprint (computed by the caller, already
 * committed from sub-task A's harness - never a second child, per the sub-task's own note that
 * "two children agreeing tells you less than a child agreeing with the parent") against a fresh
 * **cross-process** replay of the same config.
 */
export function checkProcessIndependence(
  configs: ReadonlyArray<ReplayConfig>,
  inProcessFingerprints: ReadonlyMap<string, ReplayFingerprint>,
  env: NodeJS.ProcessEnv = process.env,
): ProcessIndependenceReport {
  const results = runOneConfigPerChildProcess(configs, env);
  const mismatches: Array<ProcessIndependenceMismatch> = [];

  const FIELDS = ['moveTraceHash', 'stableStateHash', 'resultHash', 'decisions', 'fallbacks', 'generation'] as const;

  for (const {config, fingerprint: crossProcess} of results) {
    const key = `${config.players}|${config.engineSeed}|${config.agentSeed}`;
    const inProcess = inProcessFingerprints.get(key);
    if (inProcess === undefined) {
      throw new Error(`No in-process fingerprint supplied for config ${key} - checkProcessIndependence requires one per config.`);
    }
    for (const field of FIELDS) {
      if (inProcess[field] !== crossProcess[field]) {
        mismatches.push({config, field, inProcess: inProcess[field], crossProcess: crossProcess[field]});
      }
    }
  }

  return {configsChecked: results.length, mismatches};
}

/** The worker entry point: parses a JSON `ReplayConfig[]` from argv and writes one `ReplayFingerprint` per config, as a JSON array, to `outPath` (never stdout - see {@link runConfigsInFreshProcess}). */
function runWorker(configsJson: string, outPath: string): void {
  ensureHeadlessEngine();
  const configs = JSON.parse(configsJson) as ReadonlyArray<ReplayConfig>;
  const fingerprints = configs.map((config) => replay(config));
  fs.writeFileSync(outPath, JSON.stringify(fingerprints));
}

function main(): void {
  const flagIndex = process.argv.indexOf(WORKER_FLAG);
  if (flagIndex !== -1) {
    const outIndex = process.argv.indexOf(WORKER_OUT_FLAG);
    if (outIndex === -1) {
      throw new Error(`${WORKER_FLAG} requires ${WORKER_OUT_FLAG} <path> to be given too.`);
    }
    runWorker(process.argv[flagIndex + 1], process.argv[outIndex + 1]);
    return;
  }

  // Standalone orchestrator mode: a small demonstration/smoke run, not the full P2 sweep (that's
  // driven by sweep.ts / whatever assembles P1+P2+P4 into a report - this file only owns the
  // cross-process primitive per Milestone1_Bullet6_Prompts.md's file-ownership table).
  ensureHeadlessEngine();
  const configs: ReadonlyArray<ReplayConfig> = [
    {players: 2, engineSeed: 500000, agentSeed: 1000003},
    {players: 3, engineSeed: 500977, agentSeed: 2000133},
  ];
  const inProcess = new Map(configs.map((config) => [`${config.players}|${config.engineSeed}|${config.agentSeed}`, replay(config)]));
  const report = checkProcessIndependence(configs, inProcess);
  console.log(`[childReplay] checked ${report.configsChecked} config(s) cross-process; ${report.mismatches.length} mismatch(es).`);
  for (const mismatch of report.mismatches) {
    console.error(`[childReplay] MISMATCH players=${mismatch.config.players} engineSeed=${mismatch.config.engineSeed}: ${mismatch.field} inProcess=${JSON.stringify(mismatch.inProcess)} crossProcess=${JSON.stringify(mismatch.crossProcess)}`);
  }
  if (report.mismatches.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
