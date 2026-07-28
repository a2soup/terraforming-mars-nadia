import * as fs from 'fs';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {runMatchConfigs} from './runner';
import {WorkerInput, WorkerOutput} from './pool';

/**
 * The child entry point `pool.ts` spawns one of per shard (§4.5, Unit C). Reads a
 * {@link WorkerInput} from a file, plays that shard with the same `runMatchConfigs` the
 * single-process path uses - **this is what makes R6 (byte-identical artifacts) true by
 * construction rather than by a second implementation that has to be kept in sync** - and writes a
 * {@link WorkerOutput} to another file.
 *
 * **Never writes its result to stdout.** The Engine logs to stdout during play (module-load-time
 * logging, and - above the H7 threshold - the eviction line per finished game and the driver's
 * per-fallback warn, both silenced but not guaranteed silent under every capture mode), and
 * multiple children's stdout is unavoidably interleaved by the OS. `determinism/childReplay.ts`
 * established this discipline for a single-config replay; this module applies it to a whole shard.
 *
 * **Must call `ensureHeadlessEngine()` itself.** A child process shares nothing with its parent's
 * heap - not `GameLoader`'s singleton, not the no-op `Database`, not the behavior executor's
 * registration - so skipping this would either crash on the first decision or (worse, per
 * `headlessEngine.ts`'s own module doc) silently pick up whatever `GAME_CACHE` the child's
 * environment happens to carry. `pool.ts` passes the parent's `env` through explicitly for exactly
 * this reason - see its module doc.
 */

function runWorker(inPath: string, outPath: string): void {
  ensureHeadlessEngine();
  const input = JSON.parse(fs.readFileSync(inPath, 'utf8')) as WorkerInput;
  runMatchConfigs(input.configs, input.spec, {
    capture: input.capture,
    yieldEvery: input.yieldEvery,
    silenceRoutineLogs: input.silenceRoutineLogs,
  }).then((report) => {
    const output: WorkerOutput = {
      games: report.games,
      ...(report.instrumentation === undefined ? {} : {instrumentation: report.instrumentation}),
    };
    fs.writeFileSync(outPath, JSON.stringify(output));
  }).catch((error) => {
    // No result file: the parent's `runShard` treats a missing output file as "the child died"
    // and synthesizes per-config failure records rather than losing the shard's games entirely
    // (H8, applied at the shard level - see `pool.ts`'s module doc). Write the error alongside so
    // the synthesized failure message is the real cause, not just "no output file".
    fs.writeFileSync(`${outPath}.error`, error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
}

function main(): void {
  const inIndex = process.argv.indexOf('--worker-in');
  const outIndex = process.argv.indexOf('--worker-out');
  if (inIndex === -1 || outIndex === -1) {
    throw new Error('poolChild requires --worker-in <path> --worker-out <path>.');
  }
  runWorker(process.argv[inIndex + 1], process.argv[outIndex + 1]);
}

if (require.main === module) {
  main();
}
