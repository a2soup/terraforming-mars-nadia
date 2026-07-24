/**
 * CLI for the Milestone 1, bullet 6 determinism harness (agent/docs/Milestone1_Bullet6_Prompts.md,
 * sub-task A). Two modes:
 *
 *   Generate a corpus:
 *     npx tsx agent/src/runner/determinismCli.ts --players 2,3,4 --seeds 1,2,3 --agent-seeds 10,20 --out corpus.json
 *
 *   Verify a committed corpus against the current Engine/environment - the durable payoff:
 *     npx tsx agent/src/runner/determinismCli.ts --verify agent/docs/data/determinism_corpus.json
 *
 *   Preview the resolved configs without running anything:
 *     npx tsx agent/src/runner/determinismCli.ts --players 2,3 --seeds 1,2 --agent-seeds 10 --list
 *
 * Follows the arg-parsing style of createGameCli.ts/speedSpikeCli.ts: a switch over
 * process.argv, explicit errors on unknown flags, no dependency added for parsing.
 */
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {ReplayConfig, ReplayFingerprint} from '../determinism/types';
import {replay} from '../determinism/replay';
import {buildCorpus, fingerprintsMatch, loadCorpus, saveCorpus, verifyCorpus} from '../determinism/corpus';

type ParsedArgs = {
  players: ReadonlyArray<number>;
  seeds: ReadonlyArray<number>;
  agentSeeds: ReadonlyArray<number>;
  repeat: number;
  out?: string;
  verify?: string;
  list: boolean;
};

function parseNumberList(raw: string): ReadonlyArray<number> {
  return raw.split(',').map(Number);
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let players: ReadonlyArray<number> = [2];
  let seeds: ReadonlyArray<number> | undefined;
  let agentSeeds: ReadonlyArray<number> = [1000003]; // independent-looking default (SRS CON-5), matching speedSpikeCli's convention
  let repeat = 1;
  let out: string | undefined;
  let verify: string | undefined;
  let list = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--players':
      players = parseNumberList(argv[++i]);
      break;
    case '--seeds':
      seeds = parseNumberList(argv[++i]);
      break;
    case '--agent-seeds':
      agentSeeds = parseNumberList(argv[++i]);
      break;
    case '--repeat':
      repeat = Number(argv[++i]);
      break;
    case '--out':
      out = argv[++i];
      break;
    case '--verify':
      verify = argv[++i];
      break;
    case '--list':
      list = true;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  for (const p of players) {
    if (p !== 2 && p !== 3 && p !== 4) {
      throw new Error(`--players must each be 2, 3, or 4, got ${p}`);
    }
  }
  if (verify === undefined && seeds === undefined) {
    throw new Error('--seeds is required unless --verify is given (use --list to preview the resolved configs)');
  }
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new Error(`--repeat must be a positive integer, got ${repeat}`);
  }

  return {players, seeds: seeds ?? [], agentSeeds, repeat, out, verify, list};
}

function buildConfigs(args: ParsedArgs): ReadonlyArray<ReplayConfig> {
  const configs: Array<ReplayConfig> = [];
  for (const players of args.players as ReadonlyArray<2 | 3 | 4>) {
    for (const engineSeed of args.seeds) {
      for (const agentSeed of args.agentSeeds) {
        configs.push({players, engineSeed, agentSeed});
      }
    }
  }
  return configs;
}

function runVerify(verifyPath: string): void {
  ensureHeadlessEngine();
  const corpus = loadCorpus(verifyPath);
  const report = verifyCorpus(corpus);

  console.log(`[determinism] verified ${report.configsChecked} config(s) from ${verifyPath}`);
  if (report.mismatches.length === 0) {
    console.log('[determinism] OK - 0 mismatches.');
    return;
  }

  for (const mismatch of report.mismatches) {
    console.error(
      `[determinism] MISMATCH players=${mismatch.config.players} engineSeed=${mismatch.config.engineSeed} ` +
      `agentSeed=${mismatch.config.agentSeed}: ${mismatch.field} expected=${JSON.stringify(mismatch.expected)} ` +
      `actual=${JSON.stringify(mismatch.actual)}`,
    );
  }
  console.error(`[determinism] ${report.mismatches.length} mismatch(es) across ${report.configsChecked} config(s).`);
  process.exitCode = 1;
}

function runGenerate(args: ParsedArgs): void {
  const configs = buildConfigs(args);

  if (args.list) {
    for (const config of configs) {
      console.log(JSON.stringify(config));
    }
    return;
  }

  ensureHeadlessEngine();

  const fingerprints: Array<ReplayFingerprint> = [];
  let inconsistentConfigs = 0;

  for (const config of configs) {
    const first = replay(config);
    for (let i = 1; i < args.repeat; i++) {
      const repeated = replay(config);
      if (!fingerprintsMatch(first, repeated)) {
        inconsistentConfigs++;
        console.error(
          `[determinism] players=${config.players} engineSeed=${config.engineSeed} agentSeed=${config.agentSeed}: ` +
          `${args.repeat} in-process replays did not all match (P1) - this is a Milestone-1 blocker, not a ` +
          'recorded risk.',
        );
      }
    }
    fingerprints.push(first);
  }

  if (args.out !== undefined) {
    saveCorpus(args.out, buildCorpus(fingerprints));
    console.log(`[determinism] wrote ${fingerprints.length} fingerprint(s) to ${args.out}`);
  } else {
    console.log(JSON.stringify(fingerprints, null, 2));
  }

  if (inconsistentConfigs > 0) {
    process.exitCode = 1;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.verify !== undefined) {
    runVerify(args.verify);
    return;
  }

  runGenerate(args);
}

main();
