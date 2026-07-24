/**
 * CLI for the Milestone 1, bullet 5 simulator-speed spike bench suites
 * (agent/docs/Milestone1_Bullet5_Prompts.md, sub-task A).
 *
 *   npx tsx agent/src/runner/speedSpikeCli.ts --suite <name> [--scale N] [--seed N] [--agent-seed N] [--players 2,3,4] [--json]
 *   npx tsx agent/src/runner/speedSpikeCli.ts --list
 *
 * Follows the arg-parsing style of createGameCli.ts: a switch over process.argv, explicit
 * errors on unknown flags, no dependency added for parsing.
 */
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {benchEnvironment, formatReport, measure} from '../bench/harness';
import {forkCostSuite} from '../bench/forkCost';
import {BenchReport, BenchSuite, BenchSuiteOptions} from '../bench/types';

/**
 * Sub-task A's own suite: a few pure-CPU no-ops, so the CLI, the registry and the report
 * formatting can all be exercised end to end before sub-tasks B, C and D exist. Takes no
 * Engine or game dependency.
 */
const harnessSelfTest: BenchSuite = {
  name: 'harness-selftest',
  description: 'Pure-CPU no-op timings, to exercise the CLI before real suites exist.',
  run: (options: BenchSuiteOptions): BenchReport => {
    const noop = measure('noop', options.scale, () => {
      let x = 0;
      for (let i = 0; i < 1000; i++) x += i;
    });
    const sleepless = measure('array-alloc', options.scale, () => {
      const arr = new Array(1000).fill(0).map((_, i) => i);
      void arr;
    });
    return {
      suite: harnessSelfTest.name,
      environment: benchEnvironment(),
      stats: [noop, sleepless],
      metrics: {
        scale: options.scale,
        seed: options.seed,
        agentSeed: options.agentSeed,
        players: options.players,
      },
      consoleCounts: {log: 0, warn: 0, error: 0, matched: {}},
      notes: ['harness-selftest measures nothing about the Engine; it only exercises the harness itself.'],
    };
  },
};

// B, C and D append their suite objects here as they land (see the file-ownership table in
// Milestone1_Bullet5_Prompts.md: this array is the only place their registration may conflict,
// and any such conflict is a two-line one).
const SUITES: ReadonlyArray<BenchSuite> = [harnessSelfTest, forkCostSuite];

type ParsedArgs = {
  list: boolean;
  suite?: string;
  scale: number;
  seed: number;
  agentSeed: number;
  players: ReadonlyArray<number>;
  json: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let list = false;
  let suite: string | undefined;
  let scale = 20;
  let seed = 1;
  let agentSeed = 1000003; // independent of `seed` by construction (SRS CON-5)
  let players: ReadonlyArray<number> = [2];
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--list':
      list = true;
      break;
    case '--suite':
      suite = argv[++i];
      break;
    case '--scale':
      scale = Number(argv[++i]);
      break;
    case '--seed':
      seed = Number(argv[++i]);
      break;
    case '--agent-seed':
      agentSeed = Number(argv[++i]);
      break;
    case '--players':
      players = argv[++i].split(',').map(Number);
      break;
    case '--json':
      json = true;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  return {list, suite, scale, seed, agentSeed, players, json};
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    for (const s of SUITES) {
      console.log(`${s.name}\t${s.description}`);
    }
    return;
  }

  if (args.suite === undefined) {
    throw new Error('--suite is required (use --list to see available suites)');
  }

  const suite = SUITES.find((s) => s.name === args.suite);
  if (suite === undefined) {
    throw new Error(`Unknown suite: ${args.suite} (use --list to see available suites)`);
  }

  ensureHeadlessEngine();

  const report = suite.run({
    scale: args.scale,
    seed: args.seed,
    agentSeed: args.agentSeed,
    players: args.players,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
}

main();
