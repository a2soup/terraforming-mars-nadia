/**
 * The measuring instrument for the Milestone 1, bullet 5 simulator-speed spike
 * (agent/docs/Milestone1_Bullet5_Prompts.md, sub-task A).
 *
 * This module takes no measurements of its own - it is the timing, statistics and
 * console-suppression machinery that sub-tasks B, C and D build their suites on top of.
 * Correctness of this file (not any timing number) is covered by
 * agent/test/bench/harness.spec.ts.
 */
import {execSync} from 'child_process';
import * as os from 'os';
import * as path from 'path';
import {BenchEnvironment, BenchReport, BenchStats, ConsoleCounts} from './types';

/** The pinned Engine commit (agent/CLAUDE.md §2) - kept here so every report is self-describing. */
const ENGINE_PIN = '868714d72a434ab68fe08e5570ebc6863859ae15';

/**
 * Known-noise console patterns to count while a measured region is silenced (see
 * `silenceConsole`). These are *findings*, not cosmetic noise: `fr9Fallback` and `outOfScope`
 * in particular are numbers nothing else in the project has measured. Matching is a plain
 * substring test against each suppressed line, checked in declaration order.
 */
export const NOISE_PATTERNS: Record<string, string> = {
  cacheMark: 'Marking ',                          // Cache.mark on END-phase deserialize
  waitingForOverwrite: 'Overwriting waitingFor',  // Player.setWaitingFor
  fr9Fallback: '[embeddedDriver] FR-9 fallback',  // the conservative fallback firing
  outOfScope: 'OUT-OF-SCOPE DECISION',            // randomLegalAgent, should never fire in-scope
};

/** Times a single call with sub-millisecond resolution (`process.hrtime.bigint()`, not `Date.now()`). */
export function timed<T>(fn: () => T): {result: T; ms: number} {
  const start = process.hrtime.bigint();
  const result = fn();
  const end = process.hrtime.bigint();
  return {result, ms: Number(end - start) / 1e6};
}

/**
 * Default warm-up iteration count for `measure`: 3, or fewer for a very small sample, so a
 * 5-iteration `measure` call doesn't burn its entire sample on warm-up.
 */
function defaultWarmup(iterations: number): number {
  return Math.min(3, Math.ceil(iterations / 10));
}

/**
 * Runs `fn` `warmup` times (default: `defaultWarmup(iterations)`) and discards those timings -
 * V8 is still interpreting the first few passes and including them gives the sample a long,
 * unreal tail - then runs it `iterations` more times and returns summary statistics over
 * exactly those `iterations` samples.
 */
export function measure(
  label: string,
  iterations: number,
  fn: (i: number) => void,
  options?: {warmup?: number},
): BenchStats {
  const warmup = options?.warmup ?? defaultWarmup(iterations);
  for (let i = 0; i < warmup; i++) {
    fn(i);
  }
  const samples: Array<number> = [];
  for (let i = 0; i < iterations; i++) {
    samples.push(timed(() => fn(warmup + i)).ms);
  }
  return summarize(label, samples);
}

/**
 * Summary statistics over a sample of millisecond timings.
 *
 * `median` on an even-length sample is the mean of the two middle values (not either one
 * alone). `p95` uses the nearest-rank method: `sorted[ceil(0.95 * n) - 1]`. Both conventions
 * are stated here because an unstated percentile definition is not a number anyone can act on.
 * Sorts a copy - never mutates the caller's array.
 */
export function summarize(label: string, samples: ReadonlyArray<number>): BenchStats {
  if (samples.length === 0) {
    throw new Error(`summarize(${label}): cannot summarize an empty sample`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p95Index = Math.ceil(0.95 * n) - 1;
  const p95 = sorted[Math.min(p95Index, n - 1)];
  const totalMs = sorted.reduce((sum, v) => sum + v, 0);
  return {
    label,
    n,
    min: sorted[0],
    median,
    p95,
    max: sorted[n - 1],
    mean: totalMs / n,
    totalMs,
  };
}

/**
 * Replaces `console.log`/`warn`/`error` with counting stubs, runs `fn`, and restores the
 * originals in a `finally`. If `fn` throws and the originals were only restored on the success
 * path, every subsequent test and CLI run in this process would be silently muted, including
 * the error being thrown - so this restoration is the one place in this module where a mistake
 * is catastrophic rather than merely wrong (see agent/test/bench/harness.spec.ts's throw case).
 *
 * Suppressed lines are matched against `NOISE_PATTERNS` (first match wins) and counted in
 * `counts.matched`. Silencing is scoped to `fn` only - callers should wrap just the measured
 * region, not an entire suite, so a crash outside that region still prints normally.
 */
export function silenceConsole<T>(fn: () => T): {result: T; counts: ConsoleCounts} {
  const counts: ConsoleCounts = {log: 0, warn: 0, error: 0, matched: {}};

  const record = (stream: 'log' | 'warn' | 'error', args: ReadonlyArray<unknown>) => {
    counts[stream]++;
    const line = args.map((a) => String(a)).join(' ');
    for (const [name, pattern] of Object.entries(NOISE_PATTERNS)) {
      if (line.includes(pattern)) {
        counts.matched[name] = (counts.matched[name] ?? 0) + 1;
        break;
      }
    }
  };

  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: Array<unknown>) => record('log', args);
  console.warn = (...args: Array<unknown>) => record('warn', args);
  console.error = (...args: Array<unknown>) => record('error', args);

  try {
    const result = fn();
    return {result, counts};
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

/**
 * Detects whether this module is currently executing from `build/` (compiled) or `src/` (tsx,
 * transpiled on the fly). Milestones 4 and 6 run compiled JavaScript, so every bench report
 * must record which mode produced it.
 */
function detectRuntime(): 'tsx' | 'compiled' {
  return path.dirname(__filename).split(path.sep).includes('build') ? 'compiled' : 'tsx';
}

/** Reads the current git HEAD, degrading to `'unknown'` rather than throwing outside a checkout. */
function readGitHead(): string {
  try {
    return execSync('git rev-parse HEAD', {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim();
  } catch {
    return 'unknown';
  }
}

/** Captures the environment a bench run executed in, so a number is interpretable later. */
export function benchEnvironment(): BenchEnvironment {
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    runtime: detectRuntime(),
    enginePin: ENGINE_PIN,
    gitHead: readGitHead(),
    timestamp: new Date().toISOString(),
  };
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function fmtMs(ms: number): string {
  return ms.toFixed(ms < 1 ? 4 : 3);
}

/** Renders a `BenchReport` as a fixed-width plain-text table, suitable for pasting into a doc. */
export function formatReport(report: BenchReport): string {
  const lines: Array<string> = [];
  lines.push(`Suite: ${report.suite}`);
  lines.push('');

  lines.push(padRight('label', 32) + padRight('n', 8) + padRight('median', 10) + padRight('p95', 10) + padRight('min', 10) + padRight('max', 10) + 'mean');
  for (const s of report.stats) {
    lines.push(
      padRight(s.label, 32) +
      padRight(String(s.n), 8) +
      padRight(fmtMs(s.median), 10) +
      padRight(fmtMs(s.p95), 10) +
      padRight(fmtMs(s.min), 10) +
      padRight(fmtMs(s.max), 10) +
      fmtMs(s.mean),
    );
  }
  lines.push('');

  lines.push('Metrics:');
  for (const [key, value] of Object.entries(report.metrics)) {
    const rendered = Array.isArray(value)
      ? (value.length <= 10 ? `[${value.join(', ')}]` : `[${value.length} values]`)
      : value;
    lines.push(`  ${key}: ${rendered}`);
  }
  lines.push('');

  lines.push('Console counts (suppressed during measured regions):');
  lines.push(`  log=${report.consoleCounts.log} warn=${report.consoleCounts.warn} error=${report.consoleCounts.error}`);
  for (const [name, count] of Object.entries(report.consoleCounts.matched)) {
    lines.push(`  matched.${name}: ${count}`);
  }
  lines.push('');

  lines.push('Environment:');
  const env = report.environment;
  lines.push(`  node=${env.nodeVersion} platform=${env.platform} arch=${env.arch} runtime=${env.runtime}`);
  lines.push(`  cpu=${env.cpuModel} cores=${env.cores} totalMemoryBytes=${env.totalMemoryBytes}`);
  lines.push(`  enginePin=${env.enginePin} gitHead=${env.gitHead}`);
  lines.push(`  timestamp=${env.timestamp}`);
  lines.push('');

  lines.push('Notes:');
  for (const note of report.notes) {
    lines.push(`  - ${note}`);
  }

  return lines.join('\n');
}
