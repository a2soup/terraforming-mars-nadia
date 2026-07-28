/** Command-line parsing for `spectate.ts`. Deliberately tiny - no dependencies. */
import {MAX_PLAYERS, MIN_PLAYERS} from '../src/engine/gameConfig';
import {agentNames, AGENTS, DEFAULT_AGENT} from './agents';

export type SpectateOptions = {
  players: number;
  /** One agent name per seat, in seating order. */
  agents: ReadonlyArray<string>;
  /** One display name per seat, in seating order. */
  names: ReadonlyArray<string>;
  /** 1-based seat whose first-person view gets opened for the human. */
  seat: number;
  /** Engine seed: board setup and every shuffle (SRS CON-5). */
  seed: number;
  /** Agent seed: the base for each seat's own move-choice RNG, independent of `seed`. */
  agentSeed: number;
  delayMs: number;
  port: number;
  open: boolean;
};

export const USAGE = `
Watch Nadia play Terraforming Mars against herself, in the engine's own UI.

  npx tsx agent/demo/spectate.ts [options]

Options
  --players=N        Number of Nadias at the table, ${MIN_PLAYERS}-${MAX_PLAYERS}. Default 2.
  --agents=a,b       Which agent plays which seat, in order. Default: every seat plays
                     '${DEFAULT_AGENT}'. See --list-agents.
  --names=a,b        Display names for the seats. Default: Nadia-1, Nadia-2, ...
  --seat=N           Which seat's first-person view to watch, 1-based. Default 1.
  --seed=N           Engine seed - board and shuffles. Default: random.
  --agent-seed=N     Base seed for the agents' own move choices. Default: random.
                     Same --seed and --agent-seed replays exactly the same game.
  --delay=MS         Milliseconds between decisions. Default 2000.
  --port=N           Port for the local game server. Default 8080.
  --no-open          Don't open a browser; just print the URL.
  --list-agents      Print the available agents and exit.
  --help             Print this and exit.

While it's running (in this terminal)
  p or space         Pause / resume
  s                  While paused, advance exactly one decision
  q or Ctrl-C        Quit
`.trimStart();

const KNOWN_FLAGS = new Set([
  'players', 'agents', 'names', 'seat', 'seed', 'agent-seed', 'delay', 'port', 'no-open', 'open',
  'list-agents', 'help',
]);

export function agentListing(): string {
  return agentNames().map((name) => `  ${name.padEnd(16)}${AGENTS[name].description}`).join('\n');
}

/** A random seed in a range that stays readable when it's echoed back in the banner. */
function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

function parseFlags(argv: ReadonlyArray<string>): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument '${arg}' - every option starts with '--'. Try --help.`);
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const value = eq === -1 ? 'true' : body.slice(eq + 1);
    if (!KNOWN_FLAGS.has(key)) {
      throw new Error(`unknown option '--${key}'. Try --help.`);
    }
    flags.set(key, value);
  }
  return flags;
}

function integer(flags: Map<string, string>, key: string, fallback: number): number {
  const raw = flags.get(key);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`--${key} must be an integer, got '${raw}'`);
  }
  return value;
}

function list(flags: Map<string, string>, key: string): Array<string> | undefined {
  const raw = flags.get(key);
  return raw === undefined ? undefined : raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export type ParseResult =
  | {kind: 'help'}
  | {kind: 'list-agents'}
  | {kind: 'options'; options: SpectateOptions};

export function parseOptions(argv: ReadonlyArray<string>): ParseResult {
  const flags = parseFlags(argv);
  if (flags.has('help')) {
    return {kind: 'help'};
  }
  if (flags.has('list-agents')) {
    return {kind: 'list-agents'};
  }

  const players = integer(flags, 'players', 2);
  if (players < MIN_PLAYERS || players > MAX_PLAYERS) {
    throw new Error(`--players must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}, got ${players}`);
  }

  const agents = list(flags, 'agents') ?? new Array(players).fill(DEFAULT_AGENT);
  if (agents.length !== players) {
    throw new Error(`--agents needs exactly ${players} entries (one per seat), got ${agents.length}`);
  }
  for (const agent of agents) {
    if (AGENTS[agent] === undefined) {
      throw new Error(`unknown agent '${agent}'. Known agents:\n${agentListing()}`);
    }
  }

  const names = list(flags, 'names') ?? Array.from({length: players}, (_, i) => `Nadia-${i + 1}`);
  if (names.length !== players) {
    throw new Error(`--names needs exactly ${players} entries (one per seat), got ${names.length}`);
  }

  const seat = integer(flags, 'seat', 1);
  if (seat < 1 || seat > players) {
    throw new Error(`--seat must be between 1 and ${players}, got ${seat}`);
  }

  const delayMs = integer(flags, 'delay', 2000);
  if (delayMs < 0) {
    throw new Error(`--delay must not be negative, got ${delayMs}`);
  }

  const port = integer(flags, 'port', 8080);
  if (port < 1 || port > 65535) {
    throw new Error(`--port must be between 1 and 65535, got ${port}`);
  }

  const seed = integer(flags, 'seed', randomSeed());
  if (seed < 0) {
    throw new Error(`--seed must not be negative, got ${seed}`);
  }
  const agentSeed = integer(flags, 'agent-seed', randomSeed());
  if (agentSeed < 0) {
    throw new Error(`--agent-seed must not be negative, got ${agentSeed}`);
  }

  return {
    kind: 'options',
    options: {players, agents, names, seat, seed, agentSeed, delayMs, port, open: !flags.has('no-open')},
  };
}
