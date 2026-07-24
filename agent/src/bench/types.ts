/**
 * Types for the Milestone 1, bullet 5 simulator-speed spike bench harness
 * (agent/docs/Milestone1_Bullet5_Prompts.md, sub-task A).
 *
 * This module defines the shapes shared by the harness (harness.ts), the CLI
 * (../runner/speedSpikeCli.ts) and every bench suite (gameRuntime.ts, cloneCost.ts,
 * forkCost.ts). It contains no logic.
 */

/** Summary statistics for a sample of timings, in milliseconds. */
export type BenchStats = {
  label: string;
  n: number;          // sample size, EXCLUDING warm-up iterations
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
  totalMs: number;
};

/** Everything needed to interpret a number six months from now. */
export type BenchEnvironment = {
  nodeVersion: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cores: number;
  totalMemoryBytes: number;
  /** 'tsx' when running transpiled-on-the-fly, 'compiled' when running from build/agent. */
  runtime: 'tsx' | 'compiled';
  /** The Engine pin (agent/CLAUDE.md §2) and the actual git HEAD, which should match it. */
  enginePin: string;
  gitHead: string;
  timestamp: string;  // ISO
};

/** Counts of console output suppressed during a measured run - reported as data, never printed. */
export type ConsoleCounts = {
  log: number;
  warn: number;
  error: number;
  /** Counts for the known noise patterns, keyed by the pattern name (see NOISE_PATTERNS in harness.ts). */
  matched: Record<string, number>;
};

export type BenchReport = {
  suite: string;
  environment: BenchEnvironment;
  stats: ReadonlyArray<BenchStats>;
  /** Suite-specific scalars and distributions - decisions per game, bytes, ratios, ... */
  metrics: Record<string, number | string | ReadonlyArray<number>>;
  consoleCounts: ConsoleCounts;
  notes: ReadonlyArray<string>;
};

export type BenchSuite = {
  name: string;
  description: string;
  run: (options: BenchSuiteOptions) => BenchReport;
};

export type BenchSuiteOptions = {
  /** Corpus size knob - games, snapshots, or iterations, per suite. Suites document their own default. */
  scale: number;
  /** Engine seed base; suites derive per-game seeds from it deterministically. */
  seed: number;
  /** Agent seed base, chosen independently of `seed` (SRS CON-5). */
  agentSeed: number;
  players: ReadonlyArray<number>;  // e.g. [2], or [2, 3, 4]
};
