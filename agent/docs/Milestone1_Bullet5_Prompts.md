# Milestone 1, bullet 5 — sub-task prompts (the gating simulator-speed spike)

Bullet 5 of Milestone 1: *"Measure full-game headless runtime, serialize/deserialize (clone)
round-trip time, and achievable clones/second at the pinned commit; from these, compute how many
search simulations the NFR-1 time budget actually buys. This gates the realism of Milestones 4 and 6
(SRS NFR-2). If clone cost is prohibitive, design an incremental apply/undo copy path or rescope
search depth and RL scale before proceeding."*

This is the **gating** item: Milestones 4 and 6 are not committed until it produces numbers. Bullet 4
built the snapshot/restore primitive this spike measures; the spike does not extend that primitive,
it characterizes it and turns the characterization into a decision.

These are written to be pasted into a fresh Claude Code session, each starting cold. Order:
**A → (B, C, D in parallel) → E**.

---

## Routing — scale, and which model to run each on

| sub-task | rough scale | model | why |
| --- | --- | --- | --- |
| **A** — bench harness | ~250–350 lines src, ~120 lines spec | **Sonnet** | Mechanical and fully specified below. Two sharp edges (console restoration on throw; percentile math on an even-length sample) are called out explicitly, so they don't need to be discovered. |
| **B** — full-game runtime | ~250 lines, no new spec | **Sonnet** | Straightforward batch measurement. One non-obvious technique — instrumenting via a *responder wrapper* rather than by touching the driver — is spelled out in full; if that section doesn't land immediately, escalate to Opus rather than editing `embeddedDriver.ts`. |
| **C** — clone cost | ~300 lines, no new spec | **Sonnet** | The most mechanical of the three measurement tasks. Its trap (you must sample with `unsafe: true`, exactly as bullet 4's sub-task B did) is the same trap that bullet already documented, and is restated below. |
| **D** — fork realism | ~300 lines + genuine investigation | **Opus** | Bullet 5's analogue of bullet 4's sub-task B: the "drive real games and find out what the Engine actually does" task. Its central mechanism — replay from a quiescent ancestor — has **never been run**; it is asserted in the Running Notes as the natural M4 strategy and has not been validated. Highest unknown-Engine-behavior per line in the bullet. |
| **E** — analysis & gate | ~400 lines of markdown, ~40 lines of arithmetic | **Opus** | Judgment, not code: it decides whether M4/M6 proceed, and it edits source-of-truth documents. A wrong call here is expensive and slow to detect. |

**Haiku is not appropriate for any of these.** A is the closest, but its correctness details (restore
`console` in a `finally`, don't report a mean where a median is wanted, don't let warm-up iterations
into the sample) are exactly the kind that a fast pass drops silently and that no test will catch,
because a benchmark that reports plausible-but-wrong numbers still looks green.

**A blocks everything.** B, C and D are genuinely independent after that — separate files, separate
corpora, no shared state — and E consumes all three.

---

## Shared preamble (prepend to every sub-task below)

> You are working on the **Nadia** Terraforming Mars agent, in the `agent/` module of a
> terraforming-mars fork. Read `agent/CLAUDE.md` (especially §2 on the Engine pin, §5 on the Engine
> interfaces, and §6 for current status) and the root `CLAUDE.md`. Then read, in full, these two
> **Running Notes** entries — they contain every number this spike starts from and the Engine facts
> that make the naive measurement wrong:
> - **2026-07-22, "Snapshot/restore fidelity is *not* universal, and 25% of the failures are
>   silent"** — especially its *Cost preview* table and its closing *Implication for Milestone 4*.
> - **2026-07-23, "Fidelity audit: the guard holds across 2p/3p/4p, but `preludes` is not the clean
>   phase the probe suggested"** — the measured 28.0%-of-decision-points-don't-round-trip figure.
>
> **The one hard rule:** the Engine is **immutable ground truth** (SRS CON-1). This is a measurement
> task; it changes nothing, in the Engine *or* in the agent. In particular you will be tempted to add
> a timing hook to `agent/src/driver/embeddedDriver.ts` or `agent/src/engine/snapshot.ts` — **do
> not**. Those files are load-bearing and already covered by specs; instrument from the outside
> (each sub-task below says how). If you become convinced an existing agent file genuinely must
> change to take a measurement, stop and say so in your summary rather than changing it.
>
> **Benchmarks are not tests.** Nothing you write may assert a wall-clock duration. Timing
> assertions are flaky, they fail on a loaded machine, and they turn a measurement into a
> maintenance burden. The measurement code lives in `agent/src/bench/` and is run **only** via its
> CLI; the only thing in `agent/test/` is sub-task A's correctness spec for the harness's own
> statistics and console handling. The numbers themselves live in a committed document (sub-task E),
> not in an assertion.
>
> **Four things that will corrupt a measurement if you don't handle them** (all verified, all
> already in the codebase):
> 1. **`Cache.mark()` fires on every END-phase `Game.deserialize`.** `src/server/Game.ts:1846-1847`
>    calls `GameLoader.getInstance().mark(game.id)` when the deserialized game is in `Phase.END`, and
>    `Cache.mark` (`src/server/database/Cache.ts:62-65`) does a `console.log('Marking …')` **and**
>    adds a `Map` entry. Under a spike that restores terminal states thousands of times this is both
>    stdout spam that dominates the timing and a genuinely unbounded map (every clone shares one game
>    id, so it's one entry — but the log line is per restore). Silence it and count it.
> 2. **The FR-9 conservative fallback `console.warn`s every time it fires**
>    (`embeddedDriver.ts`, in `applyDecision`), as does the Engine's own
>    `Player.setWaitingFor` "Overwriting waitingFor" path. Console I/O is slow enough to distort
>    per-decision timings by a wide margin.
> 3. **`randomLegalAgent`'s per-decision trace logging is off by default** — leave it off.
> 4. **`node_modules` may not be installed in a fresh worktree** — `npm ci` at the repo root if so.
>
> **Reference hardware, to record in every report:** the numbers in this bullet were taken on an
> **Apple M2, 8 cores, Node v22.23.1**, at the pinned Engine commit `868714d72`. Every sub-task's
> report must capture its own environment (sub-task A provides the helper) rather than assuming this
> one, because "reference hardware" is load-bearing in the Milestone 4 exit criterion.
>
> **Measure compiled output, not just `tsx`.** The agent test suite runs under `tsx` (esbuild
> transpile), but Milestones 4 and 6 will run compiled JavaScript. Report the reference numbers from
> the compiled build and note the `tsx` delta; if they differ by more than a few percent that is
> itself a finding. Build with `npx tsc -p agent/tsconfig.json` (output lands in `build/agent`).
>
> **Style:** match the surrounding agent files (`agent/src/engine/*.ts`, `agent/src/driver/*.ts`) —
> thorough doc comments that explain *why*, `expect`-style Chai tests with descriptive names.
>
> **Definition of done:** your bench module runs cleanly end to end via the CLI and emits both a
> human-readable table and `--json`; the full agent suite stays green; the agent type-checks. Run
> from the `agent/` dir:
> ```
> npx mocha --import=tsx --require ../tests/testing/setup.ts "test/**/*.spec.ts"
> ```
> and from the repo root: `npx tsc -p agent/tsconfig.json --noEmit`. (The agent module is not wired
> into the repo's root ESLint, so there is no lint step.)

---

## File ownership, so parallel work never edits the same file

| sub-task | owns |
| --- | --- |
| A | `agent/src/bench/harness.ts` (new), `agent/src/bench/types.ts` (new), `agent/test/bench/harness.spec.ts` (new), `agent/src/runner/speedSpikeCli.ts` (new, skeleton + `--suite harness-selftest`), `agent/package.json` (add the `bench` script) |
| B | `agent/src/bench/gameRuntime.ts` (new) |
| C | `agent/src/bench/cloneCost.ts` (new) |
| D | `agent/src/bench/forkCost.ts` (new) |
| E | `agent/docs/Simulator_Speed_Spike.md` (new), `agent/docs/Running_Notes.md` (append), `agent/CLAUDE.md` (§6 status), and — only if the gate triggers a rescope — `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md` and `agent/docs/Terraforming_Mars_AI_SRS_v1.2.md` |

B, C and D each **register** their suite with the CLI A creates. A must define that registration
seam (a plain exported record of `name -> () => BenchReport`) so the three can add an entry each
without colliding; keep the CLI's own file owned by A and have B/C/D export a suite object that A's
registry imports. If a merge conflict in the registry import list is unavoidable, it is a two-line
conflict — acceptable, and better than three sub-tasks sharing a runner file.

---

## Sub-task A — the bench harness (do this first; everything else depends on it)

**Owns:** `agent/src/bench/harness.ts`, `agent/src/bench/types.ts`, `agent/test/bench/harness.spec.ts`,
`agent/src/runner/speedSpikeCli.ts`, the `bench` script in `agent/package.json`.

You are building the measuring instrument, not taking any measurement. Nothing in this sub-task
creates a game.

### 1. Types (`types.ts`)

```ts
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
  /** Counts for the known noise patterns, keyed by the pattern name (see NOISE_PATTERNS). */
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
```

### 2. The harness (`harness.ts`)

```ts
export function timed<T>(fn: () => T): {result: T; ms: number};
export function measure(label: string, iterations: number, fn: (i: number) => void, options?: {warmup?: number}): BenchStats;
export function summarize(label: string, samples: ReadonlyArray<number>): BenchStats;
export function silenceConsole<T>(fn: () => T): {result: T; counts: ConsoleCounts};
export function benchEnvironment(): BenchEnvironment;
export function formatReport(report: BenchReport): string;
```

Details that matter:

- **`timed`** uses `process.hrtime.bigint()`, not `Date.now()`. Convert to fractional milliseconds
  (`Number(delta) / 1e6`) — several of the operations being measured are well under a millisecond
  (`serialize()` was ~0.03 ms in the planning probe), so millisecond-integer resolution would report
  zero.
- **`measure`** runs `warmup` iterations (default 3, or `Math.min(3, Math.ceil(iterations / 10))`,
  whichever you document) whose timings are **discarded**, then `iterations` sampled ones. Getting
  this wrong is the classic benchmark error: V8 will still be interpreting the first few passes and
  the sample gets a long tail that isn't real. State the warm-up count in the report's `notes`.
- **`summarize`** — sort a **copy** of the samples. `median` on an even-length sample is the mean of
  the two middle values. `p95` uses the nearest-rank method (`sorted[Math.ceil(0.95 * n) - 1]`);
  whichever convention you choose, name it in the doc comment, because a p95 whose definition is
  unstated is not a number anyone can act on. Report **median and p95 as the headline**, not the
  mean — these distributions have tails (GC pauses, a late-game game log) and the mean will overstate
  the typical cost while hiding the worst case. Include the mean anyway, so E can see the skew.
- **`silenceConsole`** replaces `console.log` / `console.warn` / `console.error` with counting stubs,
  runs `fn`, and **restores the originals in a `finally`**. This is the one place in this sub-task
  where a mistake is catastrophic rather than merely wrong: if `fn` throws and you restore only on
  the success path, every subsequent test and CLI run in that process is silently muted, including
  the error you were trying to see. The spec below tests exactly this.
  - It also matches each suppressed line against a known-noise table and increments `counts.matched`:
    ```ts
    const NOISE_PATTERNS = {
      cacheMark: 'Marking ',                       // Cache.mark on END-phase deserialize
      waitingForOverwrite: 'Overwriting waitingFor', // Player.setWaitingFor
      fr9Fallback: '[embeddedDriver] FR-9 fallback', // the conservative fallback firing
      outOfScope: 'OUT-OF-SCOPE DECISION',           // randomLegalAgent, should never fire in-scope
    };
    ```
    These counts are **findings, not noise to be thrown away**: `fr9Fallback` tells E how often the
    fallback fires across a large corpus (a number nothing else in the project has), and any nonzero
    `outOfScope` is a scope bug that must be surfaced loudly in the report even though it was
    swallowed at the console.
  - Do **not** make silencing optional-by-default-on. Suites opt in around the measured region only,
    so a crash outside the measured region still prints.
- **`benchEnvironment`** — `process.version`, `process.platform`, `process.arch`, `os.cpus()[0].model`,
  `os.cpus().length`, `os.totalmem()`. Detect `runtime` by checking whether `__filename` resolves
  under `build/` (compiled) or `src/` (tsx); document the check. Read `gitHead` with
  `execSync('git rev-parse HEAD')` wrapped in a try/catch that degrades to `'unknown'` rather than
  throwing — a bench run must not fail because it was invoked outside a git checkout.
- **`formatReport`** — a fixed-width table of `stats` (label, n, median, p95, min, max), then the
  `metrics`, then the console counts, then the environment block, then the notes. E will paste this
  into a document, so make it readable as plain text.

### 3. The CLI (`speedSpikeCli.ts`)

```
npx tsx agent/src/runner/speedSpikeCli.ts --suite <name> [--scale N] [--seed N] [--agent-seed N] [--players 2,3,4] [--json]
npx tsx agent/src/runner/speedSpikeCli.ts --list
```

Follow the existing arg-parsing style of `agent/src/runner/createGameCli.ts` exactly (a `switch` over
`process.argv`, explicit errors on unknown flags) — do not add a dependency. Call
`ensureHeadlessEngine()` once at start-up, before any suite runs.

Maintain a suite registry:

```ts
const SUITES: ReadonlyArray<BenchSuite> = [harnessSelfTest /* A */, /* B, C, D append here */];
```

Ship one suite of your own, `harness-selftest`: it measures a few pure-CPU no-ops so the CLI can be
exercised end to end before B/C/D exist. Add to `agent/package.json`:
`"bench": "tsx src/runner/speedSpikeCli.ts"`.

### 4. Spec (`agent/test/bench/harness.spec.ts`)

Correctness of the instrument only. **No timing assertions.**

- `summarize` computes min/median/p95/max/mean correctly on hand-written samples, including an
  **even-length** sample (median = mean of the two middle values) and a single-element sample.
- `measure` calls its function exactly `warmup + iterations` times, and the returned `n` equals
  `iterations` — i.e. warm-up iterations are genuinely excluded from the sample, not merely run.
- `silenceConsole` suppresses output, counts by stream, and increments the right `matched` key for a
  line containing `'Marking g-nadia-1 to be evicted'`.
- **`silenceConsole` restores `console.log` when the wrapped function throws** — assert on function
  identity (`expect(console.log).to.equal(original)`) after catching, not on behaviour. This is the
  single most important test in the file.
- `benchEnvironment` returns a populated object with a plausible `runtime` and does not throw when
  `git` is unavailable (stub or simply assert it doesn't throw).

---

## Sub-task B — full-game headless runtime

**Depends on A.** **Owns:** `agent/src/bench/gameRuntime.ts`.

Produces the first of the three required measurements, plus the per-decision cost that sub-tasks D
and E both need.

### What to measure

Drive complete games with `randomLegalAgent` via `runGame`, across `--players` (default `[2]`, but
the committed run must cover 2/3/4) with distinct engine seeds and independently-derived agent seeds
(CON-5 — never make the agent seed a function of the engine seed).

**Headline numbers:**
- Wall-clock per complete game — median/p95, per player count.
- Decisions per game — median/p95/min/max, per player count, plus the **full distribution** in
  `metrics` (E needs it to model rollout length).
- Games per second and **decisions per second** — decisions/s is the number E actually uses, because
  a search rollout is measured in decisions, not games.
- Generations per game (sanity: a base+CorpEra+Prelude game should land around 8–12; a wildly
  different number means something is wrong with the corpus, not with the timing).

**Component breakdown — the part with a real finding in it.** `toDecisionPoint`
(`agent/src/driver/decisionPoint.ts:33`) calls `waitingFor.toModel(player)` on **every decision**.
That is the HTTP-transport model — the same object the web client receives — and it is built
unconditionally on the embedded search hot path, where the enumerator works mostly from `raw`. If it
is a large share of per-decision cost, making it lazy is a straight multiplier on every Milestone 4
and 6 throughput number, and this spike is the right place to find out. Measure, per decision:

1. `decision.raw.toModel(decision.player)` — the model construction.
2. `enumerate(decision, throwawayRng)` — the agent's own move selection.
3. The residual (total game time minus the sum of 1 and 2 across the game) — Engine work:
   `player.process()`, the deferred drain, and the driver loop.

**How to instrument without touching the driver.** Wrap the responder. The driver hands your
responder a fully-built `EmbeddedDecisionPoint`, which is the injection point you need — no change to
`embeddedDriver.ts` or `decisionPoint.ts`:

```ts
function instrumentedResponder(inner: EmbeddedResponder, acc: Accumulator, throwaway: AgentRandom): EmbeddedResponder {
  return (decision) => {
    // Re-time toModel: it is a pure model constructor over live state, safe to call again.
    acc.toModelMs.push(timed(() => decision.raw.toModel(decision.player)).ms);
    // Re-time enumerate against a THROWAWAY rng so the real agent's stream is untouched
    // and the game stays reproducible.
    acc.enumerateMs.push(timed(() => enumerate(decision, throwaway)).ms);
    return inner(decision);   // the real, seeded agent decides
  };
}
```

Two things to get right here:
- **The throwaway rng is not optional.** Calling `enumerate` with the real agent's rng would advance
  its stream and change the game, so the instrumented run would no longer be the same game as the
  clean one. Use a second `createAgentRandom` with its own seed.
- **The instrumented run is not the timing source for the total.** It carries measurable overhead.
  Run each configuration **twice**: once clean (`runGame` with the plain agent) for the wall-clock
  total, once instrumented for the breakdown. Report the ratio of instrumented to clean total as an
  `overheadFactor` metric so E knows how much to trust the decomposition, and put a note in the
  report saying the components are shares, not absolutes.

**Also report:**
- `process.memoryUsage().rss` before and after the batch, and peak `heapUsed` — E needs to know
  whether self-play at scale is memory-bound as well as CPU-bound.
- Fallback counts from `runGame`'s `onFallback` callback (not from the console counter — use the real
  hook here), as a rate per 1,000 decisions. This is a genuinely new number: nothing so far has
  measured how often the FR-9 fallback fires over a large corpus.
- **Cross-check:** confirm no game hits `Phase.END` via `DriverDecisionLimitError` and that
  `computeResult` succeeds for every game. A benchmark that is silently timing crashed games is worse
  than no benchmark.

Default `scale`: 20 games per player count for a routine run; the committed run in sub-task E should
use at least 100 per player count. Silence the console (A's helper) around the batch, not around the
whole suite.

---

## Sub-task C — clone round-trip cost

**Depends on A.** **Owns:** `agent/src/bench/cloneCost.ts`.

Produces the second and third required measurements: clone round-trip time, and clones/second.

### The trap — read this before writing a line

**You must sample with `snapshot(game, {unsafe: true})` and `restore(snap, {verify: 'none'})`.** The
whole point is a cost *curve* across the game, and 28.0% of decision points are ones
`assertSnapshotSafe` refuses (bullet 4, 2026-07-23 Running Notes). Use the defaults and the suite
throws on exactly the points you are trying to measure — or, worse, quietly measures only the cheap
early-game ones and reports a flattering average. This is the same trap bullet 4's sub-task B
documented for the fidelity audit; the resolution is identical.

Then report the curve **twice**: over all decision points, and restricted to the points
`assertSnapshotSafe` accepts (record the verdict per point without acting on it). The safe-points-only
figure is the one search would actually see; the all-points figure is what shows the shape.

### What to measure

Build a corpus by driving games with `randomLegalAgent` and capturing at a **stratified** set of
decision indices — early (~10% through), mid (~50%), late (~90%), and terminal — across 2/3/4
players, so the growth in cost is visible rather than averaged away.

**Component timings**, each measured separately (this is what makes the report actionable — the
planning probe found `deserialize` dominates at roughly 3× the copy and 50× the serialize, and E
needs that ratio confirmed at scale):

| component | how |
| --- | --- |
| `game.serialize()` | direct |
| deep copy | `JSON.parse(JSON.stringify(serialized))`. Note: `deepCopy` is **private** to `snapshot.ts` — do not export it; reimplement the same JSON round-trip locally and say in a comment that it must stay identical to the one in `snapshot.ts` |
| `structuredClone` | measure it too, and confirm or refute the probe's counter-intuitive finding that it is **slower** than the JSON round-trip for this object shape |
| `Game.deserialize()` | direct |
| `pendingSignature()` | direct |
| `stableStateOf()` | direct, both `ignoreLog` values |

**Composite timings:** `snapshot()`, `restore()` at each of `verify: 'none' | 'pending' | 'state'`,
and `cloneGame()`. The delta between `'none'` and `'pending'` is the price of the safety mechanism
that makes forking non-silent — E will want to state it explicitly, because "verification is
effectively free" is a claim worth having a number behind.

**Both `stripLog` settings**, plus the serialized-size breakdown: total bytes, `gameLog` bytes, and
the log's share, as a function of decision index. The probe measured 74% at one point mid-game; the
share grows over a game and this is the mechanism behind the cost curve.

**The access pattern that actually matters: snapshot-once, restore-many.** This is what search does
when it forks N simulations from one node, and it is *not* the same as N independent clones — the
serialize and the capture-side copy happen once. Measure `restore()` throughput from a single
snapshot at N = 100 and report **restores/second**, which is the honest "clones/second" figure for
search. Report the naive independent-clone rate too, and label clearly which is which; the naive one
is the number the bullet literally asks for and the restore-many one is the number Milestone 4 will
live on.

**Noise to handle:** late-game and terminal snapshots restore into `Phase.END`, which triggers the
`Cache.mark` console.log on every single restore (see the shared preamble). Silence and count it —
and report the count, because at self-play scale that log line is a real cost, not a cosmetic one.
Also call `GameLoader.getInstance()` once before the measured region so its lazy singleton
construction isn't attributed to the first restore.

Default `scale`: 10 games' worth of stratified snapshots; the committed run should use at least 50.

---

## Sub-task D — fork realism: what a search fork actually costs

**Depends on A.** **Owns:** `agent/src/bench/forkCost.ts`.

**This sub-task exists because the obvious version of this spike would report the wrong number.** C
measures what a clone costs. But bullet 4 established that search **cannot fork at an arbitrary
decision point**: 28.0% of them don't round-trip, and the action-phase failures are 100% silent. The
strategy already recorded for Milestone 4 is *fork at the nearest quiescent (safe) ancestor and
replay the intervening sub-decisions.* Under that strategy the real cost of a fork is

```
fork_cost  =  restore  +  (replay_distance × per_decision_cost)
```

and nobody has measured `replay_distance` or validated that replay works at all. Do both.

### 1. Validate the replay mechanism — do this first, it may not hold

The replay strategy is **an assertion in the Running Notes, not a tested behaviour.** Before
measuring its cost, prove it works:

- Drive a game, recording at every decision point: the decision index, the phase, whether
  `assertSnapshotSafe` accepts it, and the `InputResponse` actually submitted (the driver's
  `onFallback` hook tells you when the submitted response was the fallback's rather than the
  agent's — you need the response that was *accepted*, so capture accordingly).
- Pick a target point T that `assertSnapshotSafe` **rejects**. Find the nearest preceding point A
  that it accepts. Snapshot at A (safe, so `verify: 'pending'` can stay on — do not weaken it here,
  the whole premise is that A is a faithful fork point).
- Restore from A and replay the recorded responses for decisions A+1 … T via `player.process()`,
  using a **replay responder** that returns recorded responses in order rather than re-running the
  agent. Re-running the agent would work only if its rng state were also captured, which it isn't —
  and capturing it isn't the mechanism M4 will use anyway.
- Assert the replayed state at T matches the original: `stableStateOf` **and** `pendingSignature`.
  Both, for the reason bullet 4 spent a whole sub-task on — the state can match byte-for-byte while
  the pending decision has been silently replaced.

**Report the replay success rate across a real corpus, and treat a failure as a finding, not a bug to
fix here.** If replay does not reliably reproduce the target state, that is *the most important
result in the entire spike* — it means the recorded Milestone 4 fork strategy doesn't work as
written, and E's gate analysis has to account for it. Write it up prominently; do not quietly
restrict the corpus until the number looks good.

### 2. Measure the distribution

- **Safe-point density:** what fraction of decision points can be forked directly? Break down by
  phase and player count. This refines bullet 4's 28.0% into the form search needs.
- **Replay distance:** for every point, decisions back to the nearest safe ancestor — median, p95,
  max, and the full distribution. If the p95 is small (a handful of decisions) the fork strategy is
  cheap and M4 is largely unaffected; if there are long unsafe runs, `replay_distance ×
  per_decision_cost` could exceed the restore cost outright and becomes the binding constraint.
  Either outcome is a real result.
- **Per-replay-step cost:** time the replay `process()` calls. Expect this to differ from B's overall
  per-decision cost — replay skips `toModel` and skips `enumerate` entirely (the response is already
  known), so it should be *cheaper* than a rollout step. Report both so E doesn't conflate them.
- **Effective fork cost:** compose the above into a single distribution and report median/p95. This
  is the number E's cost model consumes.

### 3. One more thing worth checking while you're here

Are unsafe points **clustered** or **uniformly scattered**? A search that forks at the top of a turn
(the natural design) may sit almost entirely on safe points, in which case the effective fork cost is
close to the raw restore cost and the whole concern is smaller than it looks. Report the safe/unsafe
run-length distribution, and state plainly which of those two worlds the data shows. E needs the
answer to that question specifically.

Default `scale`: 10 games; the committed run should use at least 30, across 2/3/4 players.

---

## Sub-task E — analysis, the gate decision, and the write-up

**Depends on B, C and D.** **Owns:** `agent/docs/Simulator_Speed_Spike.md` (new),
`agent/docs/Running_Notes.md` (append a dated entry), `agent/CLAUDE.md` (§6 status), and — only if the
gate triggers a rescope — the Implementation Plan and SRS.

This sub-task writes almost no code. It turns three reports into a decision.

### 1. The cost model

A search simulation is not a clone. Model it as:

```
sim_cost  ≈  restore  +  (replay_distance × replay_step)  +  (rollout_depth × rollout_step)  +  eval
```

- `restore` and its `verify` surcharge — from C (use the **restore-many** figure, not the naive
  independent-clone one).
- `replay_distance`, `replay_step` — from D.
- `rollout_step` — from B's per-decision cost. State explicitly whether you are using the
  `toModel`-inclusive figure or the residual, and why; if B found `toModel` to be a large share, model
  **both** cases, because "make the decision model lazy" is then a live, cheap mitigation and E should
  quantify what it buys.
- `eval` — unknown until Milestone 3. Treat it as a parameter and show sensitivity, rather than
  assuming it away. Say so explicitly: an unmeasured term silently set to zero is how a gate analysis
  ends up wrong.

Produce a table of **simulations per decision** over `rollout_depth ∈ {full playout, 20, 10, 5, 1}` ×
node position `{early, mid, late}`, inverted against the NFR-1 budgets (**10 s** routine, **60 s**
complex). `full playout` uses B's remaining-decisions distribution, not a guess.

### 2. NFR-2: self-play throughput

From B's games/second: complete games per day, single-core and ×8 (the reference box has 8 cores;
assume near-linear scaling for independent games via worker threads, and **say that you assumed it**
rather than presenting it as measured). Compare against NFR-2's "on the order of thousands of complete
games per day". Note the memory figures — if RSS per worker makes 8-way parallelism infeasible, that
constrains the answer and belongs in the report.

### 3. The gate — thresholds pre-committed before the numbers arrived

These were fixed in advance, deliberately, so the gate is a decision rather than a rationalization.
Evaluate against **simulations per decision at the 10-second NFR-1 budget with truncated rollouts**:

| measured | verdict |
| --- | --- |
| **≥ 1,000** | M4 and M6 proceed as planned. Record the measured figure as the Milestone 4 exit criterion's `N`. |
| **100 – 1,000** | M4 proceeds **with mandatory mitigations** (below) and an `N` set at the low end of the measured range; M6's scale is rescoped to measured throughput, not assumed. |
| **< 100** | **Explicit rescope required before M4 is committed.** Do not proceed to Milestone 2 work without recording the rescope. |

State the verdict in one sentence, near the top of the document, with the number next to it.

### 4. Mitigations, in the order they should be applied

Cost the ones the data supports; do not present the whole list as if each were free.

1. **Truncated rollouts + the Milestone 3 heuristic as leaf evaluation.** Already the planned M4
   design (Implementation Plan §5.2). Removes the dominant `rollout_depth × rollout_step` term and is
   therefore the first and largest lever.
2. **Log-stripped snapshots** (`stripLog: true`) — ~40% off restore per the probe, and already proven
   rules-neutral by bullet 4's sub-task B, so it is available now rather than pending work.
3. **Snapshot-once / restore-many per search root** — free; an access pattern, not a change. C
   measures exactly this.
4. **A lazy decision model** — pending B's `toModel` share. Cheap to build, and it multiplies every
   rollout step.
5. **Worker-thread parallelism** — across cores for self-play; root parallelization for search.
6. **Rescope search width/depth and RL scale** to the measured throughput.

### 5. The plan's "incremental apply/undo copy path" — resolve it, don't drop it

The Implementation Plan offers this as the remedy if clone cost is prohibitive. Address it explicitly,
because leaving a source-of-truth suggestion unresolved is how it gets rediscovered in six months.
The expected finding, to verify rather than assume:

- The Engine has **no undo journal**. Its "undo" (`src/server/routes/PlayerInput.ts`) is
  restore-from-save-history, i.e. the same serialization path — not an incremental mechanism at all.
- An incremental apply/undo path would require mutation tracking inside Engine internals, which
  **CON-1 forbids** (the Engine is immutable ground truth; that constraint is the load-bearing reason
  the project has essentially no rules risk).
- The honest substitute is mitigations 1–3 plus D's fork-at-quiescent-ancestor strategy.

Write that up as *investigated and rejected, with reasons*, or — if you find the Engine offers
something the above misses — write up what you actually found. Either way it stops being an open
suggestion.

### 6. Deliverables

- **`agent/docs/Simulator_Speed_Spike.md`** — the verdict sentence up top; environment and pin; the
  three measurement tables (B, C, D); the cost model and the sims-per-decision table; the NFR-1 and
  NFR-2 verdicts; the mitigation ledger; the apply/undo resolution; and a "how to reproduce" section
  with the exact CLI invocations and seeds. Every number carries its sample size.
- **A dated Running Notes entry** in the established style: what was measured, what surprised you,
  and what the next milestone must not rediscover. D's replay-validation result and B's `toModel`
  share are the two most likely surprises.
- **`agent/CLAUDE.md` §6** — update the status paragraph and the "Next up" line (the remaining
  Milestone 1 items are the 1,000-game AC-1 determinism/legality run, bullet 6's Engine-determinism
  verification, and bullet 7's card-coverage audit).
- **If and only if the gate triggers a rescope:** update Milestone 4's exit criterion in the
  Implementation Plan with the justified `N`, and update the SRS NFR-2 hard target `X` — the SRS says
  that target "shall be established from that measurement," so leaving it as `X` after the
  measurement exists is an unmet requirement, not a formatting detail.

### 7. One thing to resist

If the numbers come back uncomfortable, the temptation is to widen the definition of a "simulation"
until the threshold is met. Don't. The thresholds above were set before the data existed precisely so
that this sub-task cannot do that. A `< 100` verdict is a **successful** spike — it is exactly the
outcome the bullet was written to catch, caught at the cheapest possible moment, which is the entire
reason it gates Milestones 4 and 6 rather than following them.
