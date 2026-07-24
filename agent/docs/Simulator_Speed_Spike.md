# Simulator-speed spike — results and gate decision

**Milestone 1, bullet 5** (Implementation Plan §4 Milestone 1; SRS NFR-1, NFR-2). This is the
**gating** measurement: Milestones 4 and 6 are not committed until it produces numbers.

---

## Verdict

> **PROCEED. Milestones 4 and 6 go ahead as planned, with no rescope.**
>
> At the NFR-1 routine budget of **10 seconds**, with depth-10 truncated rollouts and the
> Milestone 3 heuristic as leaf evaluation, the measured cost model buys **5,248 simulations per
> decision** (3,442 if leaf evaluation costs a full 1 ms). The pre-committed gate threshold was
> **≥ 1,000 → proceed**. The result clears it by 3–5×, and clears it in every rollout-depth
> configuration except a full random playout from the opening (≈ 400/decision — still above the
> `< 100` rescope floor, and not the design Milestone 4 will use).
>
> **State-clone cost is no longer the project's biggest feasibility risk.** It should be
> downgraded in the risk register (Implementation Plan §7.2).

Two secondary results carry more weight than the headline, because both were open questions that
could have invalidated the Milestone 4 plan on their own:

- **The replay-from-quiescent-ancestor fork strategy works.** It was an assertion in the Running
  Notes that had never been executed. Validated on **26,026 fork experiments across 90 games,
  100% exact reproduction** (state *and* pending decision), including all 7,021 that required a
  non-zero replay.
- **Replay is nearly free.** Unforkable points sit in short, isolated runs (median run length 1,
  replay distance median 0 / p95 3 / max 5), so the effective fork cost is **0.979 ms** against a
  raw restore of **0.963 ms** — replay adds **1.6%**. The 28%-of-points-unforkable figure from
  bullet 4 sounded like a structural obstacle; it costs 1.6%.

---

## Reference environment

Every number below is from this machine and this pin. The Milestone 4 exit criterion names
"reference hardware", so this block is load-bearing, not decoration.

| | |
| --- | --- |
| CPU | Apple M2, 8 cores |
| Memory | 8 GB |
| Node | v22.23.1 |
| Runtime | **compiled** (`tsc` + `tsc-alias` → `build/agent`), not `tsx` |
| Engine pin | `868714d72a434ab68fe08e5570ebc6863859ae15` |
| Measured at | `36345d408` |
| Date | 2026-07-24 |

**Compiled vs `tsx` matters a lot here** — more than the "note the delta" the sub-task prompt
anticipated. The planning probe's figures (Running Notes, 2026-07-22) were taken under `tsx` and
put a full clone at ~1.5 ms; compiled, the same operation is **0.94 ms** and `Game.deserialize`
drops from ~1.44–1.63 ms to **0.43 ms**, roughly 3.5×. The agent test suite runs under `tsx`, so
any figure taken there understates the simulator by a wide margin. Sub-task D confirmed the two
runtimes produce byte-identical corpora (same point counts, same fork counts), so the timings are
directly comparable and only the constant differs.

**Statistical conventions:** medians and p95 throughout, never means — these distributions have GC
and game-log tails that make the mean overstate typical cost. `median` on an even sample is the
mean of the two middle values; `p95` is nearest-rank (`sorted[ceil(0.95n) − 1]`). Warm-up
iterations are excluded from every sample.

---

## 1. Full-game headless runtime (sub-task B)

`--suite game-runtime --scale 100 --players 2,3,4` — 100 games per player count, each played twice
(clean for wall-clock, instrumented for the component breakdown). Random-legal agent throughout.

| | 2p | 3p | 4p |
| --- | --- | --- | --- |
| Game wall-clock, median | 20.7 ms | 23.8 ms | 20.4 ms |
| Game wall-clock, p95 | 61.5 ms | 59.2 ms | 32.6 ms |
| Decisions/game, median | 278 | 302.5 | 322.5 |
| Decisions/game, p95 | 384 | 419 | 458 |
| Generations/game, median | 22 | 17 | 14 |
| **Games/second** | **38.1** | **34.4** | **46.6** |
| **Decisions/second** | **10,787** | **10,760** | **15,606** |
| FR-9 fallbacks per 1,000 decisions | 16.2 | 20.9 | 27.3 |

**Per-decision cost: 0.0927 ms** at 2p (the reciprocal of decisions/second). This is the single
number the cost model consumes as `rollout_step`.

### Component breakdown — and a hypothesis that was wrong

The spike was designed partly to test a suspicion: `toDecisionPoint` builds the full
HTTP-transport model via `waitingFor.toModel(player)` on **every** decision
([decisionPoint.ts:33](../src/driver/decisionPoint.ts:33)), including on the embedded search hot
path where the enumerator works mostly from `raw`. If that were a large share of per-decision
cost, making it lazy would be a cheap multiplier on every M4/M6 throughput number.

**It is not. `toModel` is 7.0% of per-decision cost** (7.0% at 3p, 7.5% at 4p).

| component | share of a decision |
| --- | --- |
| `toModel` (HTTP-transport model construction) | 7.0% |
| `enumerate` (the agent's own move selection) | 8.6% |
| Engine residual (`process`, deferred drain, driver loop) | **84.4%** |

A lazy decision model buys ~7%, and the enumerator is not the bottleneck either. **84% of the cost
is the Engine advancing its own state**, which is exactly the part CON-1 forbids optimizing. That
is a useful thing to know before anyone spends a week on agent-side micro-optimization: there is
very little agent-side fat to cut. Mitigation #4 from the sub-task E plan is hereby costed at ~7%
and demoted.

*Method caveat:* components come from a separate instrumented run carrying its own overhead
(measured `overheadFactor` 1.07 / 1.11 / 1.19 for 2p/3p/4p), so they are **shares of the
instrumented total**, not absolutes to subtract from the clean wall-clock. The retimed `enumerate`
call threw on 460/28,333 2p decisions ("no affordable standard project" — a state fact, not a bug);
those decisions contribute no `enumerate` sample and fold into the residual, so the residual share
is very slightly overstated and `enumerate`'s very slightly understated.

### The generation-count anomaly, explained

The suite flagged median generations/game of 22 (2p), 17 (3p), 14 (4p), outside the ~8–12 a real
game lands in. **This is not a corpus bug — it is what random play looks like.** A random-legal
agent raises global parameters only incidentally, so games run long. It matters for the cost model
in one specific way: **decisions/game measured here is an upper bound on what a strong policy will
need.** A competent agent finishing in ~11 generations would produce roughly 150 decisions/game,
which makes full-playout rollouts about 1.9× cheaper than the table below assumes. The model uses
the measured (random) figure, so it errs conservative.

**Memory:** peak heap 341 MB, RSS 95 → 146 MB across 600 games. Not a constraint on 8-way
parallelism at 8 GB.

---

## 2. Clone round-trip cost (sub-task C)

`--suite clone-cost --scale 50 --players 2,3,4` — 50 games, 200 stratified decision points
(early ≈10%, mid ≈50%, late ≈90%, terminal). Sampled with `{unsafe: true}` / `verify: 'none'` so
the curve covers guard-refused points rather than only the cheap ones.

All figures are medians in milliseconds.

| component | early | mid | late | terminal |
| --- | --- | --- | --- | --- |
| `serialize()` | 0.012 | 0.013 | 0.015 | 0.016 |
| JSON deep copy | 0.140 | 0.333 | 0.554 | 0.603 |
| `structuredClone` | 0.174 | 0.434 | 0.710 | 0.776 |
| `Game.deserialize()` | 0.387 | 0.427 | 0.472 | 0.365 |
| `pendingSignature()` | 0.0001 | 0.0001 | 0.0001 | 0.0000 |
| `stableStateOf` (with log) | 0.059 | 0.127 | 0.213 | 0.232 |
| `stableStateOf` (no log) | 0.030 | 0.032 | 0.034 | 0.035 |
| **`snapshot()`** | 0.159 | 0.358 | 0.588 | 0.640 |
| **`restore(verify: 'none')`** | 0.532 | 0.786 | 1.063 | 1.005 |
| **`restore(verify: 'pending')`** | 0.528 | 0.783 | 1.053 | 1.005 |
| `restore(verify: 'state')` | 0.751 | 1.176 | 1.619 | 1.637 |
| `restore(verify:'none', log-stripped)` | 0.458 | 0.508 | 0.545 | 0.460 |
| **`cloneGame()` (naive, end-to-end)** | 0.794 | 1.267 | 1.784 | 1.767 |
| serialized bytes | 25,892 | 53,987 | 82,502 | 88,779 |
| `gameLog` share of bytes | 31.9% | 64.5% | 75.0% | 76.6% |

**Throughput:**

- **Restores/second from one snapshot (the search access pattern): 1,697/s**
- Naive independent clones/second: 1,061/s

### Four findings

1. **The safety mechanism is free.** `restore(verify: 'pending')` and `restore(verify: 'none')` are
   indistinguishable (0.783 vs 0.786 ms at mid-game — inside noise), because `pendingSignature` costs
   **0.0001 ms**, a player walk reading a plain property. The verification that turns bullet 4's
   silent-corruption failure mode into a loud throw costs nothing measurable. **Search should never
   run with `verify: 'none'`.** This retires the question of whether the guard is affordable.
2. **`deserialize` no longer dominates.** The probe (under `tsx`) found deserialize ≈3× the copy;
   compiled, it is 0.427 vs 0.333 ms at mid-game — roughly comparable. The copy grows with the game
   log while deserialize stays flat, so by the late game the copy is *larger* (0.554 vs 0.472). The
   snapshot-once/restore-many access pattern is still right, but the reasoning behind it has
   changed and the old ratio should not be quoted.
3. **`structuredClone` is confirmed slower than a JSON round-trip** at every stratum (0.434 vs
   0.333 mid-game, ~30% worse). The probe's counter-intuitive finding replicates at scale. Do not
   reach for it.
4. **Log-stripping is worth more late than early.** It cuts restore by 14% early but **52% late**
   (1.063 → 0.545 ms), because `gameLog` grows from 32% to 77% of serialized bytes. Since search
   forks from wherever the game currently is, and games spend most of their decisions past the
   midpoint, the effective saving is toward the high end. Bullet 4 already proved log-stripping
   rules-neutral, so this is available now.

*Reporting wart, noted so nobody quotes it:* this suite's `safeFractionByStratum` is the *median*
of a 0/1 safe indicator — a majority vote, not a fraction — so it reads `1.0` for every stratum
while the sibling `safePointFraction` correctly reports 0.85 over the same sample. Sub-task D's
`guardSafePct` / `forkablePct` are authoritative for density and are what this document uses.

---

## 3. Fork realism (sub-task D)

`--suite fork-cost --scale 30 --players 2,3,4` — 90 games, **26,955 decision points, 26,026 fork
experiments** (one at every decision point that had a forkable ancestor; the 929 without one are
game setup, before any ancestor exists).

This is the sub-task that exists because the obvious version of the spike reports the wrong number.
Sub-task C says a clone costs ~1 ms. But search cannot fork at an arbitrary point, so the number
that matters is `restore + replay_distance × replay_step`.

### Replay validation — the result that mattered most

> **26,026 / 26,026 forks reproduced their target exactly — 100%.** Both by `pendingSignature` and
> by `stableStateOf`. Including all **7,021** that required a non-zero replay.

The Milestone 4 fork strategy is validated rather than assumed. Had this failed, it would have been
the most important output of the spike and M4 would have needed redesign; it did not.

### Forkability density

Two densities, because the phase guard accepting a point does **not** mean a restore reproduces it:

| | all | 2p | 3p | 4p |
| --- | --- | --- | --- | --- |
| `guardSafe` (`assertSnapshotSafe` accepts) | 80.0% | 81.1% | 80.5% | 78.5% |
| **`forkable`** (guard **and** `verify: 'pending'` passes) | **70.5%** | 71.4% | 71.1% | 69.2% |
| guard-safe but *not* forkable | 9.5% | | | |

That 9.5% gap is exactly the silent-failure population bullet 4 spent a sub-task discovering.
Reporting only `guardSafe` would overstate forkability by that margin. By phase:

| phase | points | guardSafe | forkable |
| --- | --- | --- | --- |
| action | 21,510 | 99.7% | 87.8% |
| research | 4,663 | 0% | 0% |
| preludes | 659 | 0% | 0% |
| production | 123 | 100% | 100% |

### Distance, clustering, and cost

| | |
| --- | --- |
| Replay distance, median / p95 / max | **0 / 3 / 5** |
| Replay distance when replay is needed, median / p95 | 1 / 4 |
| Unforkable run length, median / max | **1** / 16 |
| Forkable run length, median / max | 4 / 24 |
| Replay step (`process` + guarded drain) | **0.025 ms** median, 0.088 p95 |
| Raw restore at a fork (`verify: 'pending'`) | **0.963 ms** median, 1.458 p95 |
| **Effective fork cost** | **0.979 ms** median, 1.481 p95 |
| Replay overhead at the median | **+1.6%** |

**Verdict on clustering:** unsafe points are *short isolated runs*, not long stretches. A search
that forks at or near the top of a turn sits almost entirely on forkable points. This is the
favorable one of the two worlds sub-task D was asked to distinguish, and it is why the
28%-unfaithful headline from bullet 4 translates into a 1.6% cost rather than a structural problem.

A replay step (0.025 ms) is **3.7× cheaper** than a rollout step (0.093 ms) because it skips both
`toModel` and `enumerate` — the response is already known. These two must not be conflated.

---

## 4. The cost model

```
sim_cost  ≈  fork  +  rollout_depth × rollout_step  +  eval
```

| term | value | source |
| --- | --- | --- |
| `fork` (restore + replay, `verify: 'pending'`) | **0.979 ms** | D |
| `fork` with log-stripped snapshots | **0.481 ms** | C + D |
| `rollout_step` | **0.0927 ms** | B |
| `eval` | **unknown until Milestone 3** | — |

`eval` is a parameter, not zero. A leaf evaluation that touches every card and tile could plausibly
cost 0.1–1 ms, so the table below sweeps it. Setting an unmeasured term to zero is how a gate
analysis ends up wrong, so all four columns are shown.

### Simulations per decision, 10-second NFR-1 budget

| rollout | eval=0 | eval=0.1 ms | eval=0.5 ms | eval=1 ms |
| --- | --- | --- | --- | --- |
| truncated d=1 | 9,335 | 8,538 | 6,364 | 4,828 |
| truncated d=5 | 6,934 | 6,485 | 5,149 | 4,095 |
| **truncated d=10** | **5,248** | **4,986** | **4,157** | **3,442** |
| truncated d=20 | 3,530 | 3,410 | 3,001 | 2,609 |
| full playout, late (28 decisions left) | 2,812 | 2,735 | 2,466 | 2,195 |
| full playout, mid (139 left) | 721 | 716 | 696 | 673 |
| full playout, early (250 left) | 414 | 412 | 405 | 397 |

At the 60-second complex-decision budget every figure is 6× larger (d=10, eval=1 ms → 20,650).

With log-stripped snapshots, d=10 rises from 5,248 to **7,100** at eval=0.

### Against the pre-committed thresholds

| threshold (set before the data existed) | measured | outcome |
| --- | --- | --- |
| **≥ 1,000 → proceed as planned** | **5,248** (d=10, eval=0) · **3,442** (d=10, eval=1 ms) | ✅ **met** |
| 100–1,000 → proceed with mandatory mitigations | — | not triggered |
| < 100 → explicit rescope before M4 | — | not triggered |

Only full random playouts from the opening (≈ 400) fall into the middle band, and that is not the
Milestone 4 design — §5.2 of the Implementation Plan already specifies heuristic leaf evaluation
over random rollouts, for strength reasons independent of speed.

**Recommended Milestone 4 exit-criterion target: `N = 1,000` simulations per decision** at the
10-second budget on this reference hardware. That is deliberately set ~3–5× *below* the measured
capability, so the criterion stays achievable when leaf evaluation turns out costlier than modeled,
when the search adds tree-management overhead the model omits, or on slower hardware — while still
being 10× the rescope floor.

---

## 5. NFR-2: self-play throughput — and a tension worth naming

**Raw simulator throughput is enormous** and NFR-2's "on the order of thousands of complete games
per day" is met with five orders of magnitude to spare *for random play*:

| | games/s (1 core) | games/day (1 core) | games/day (×8) |
| --- | --- | --- | --- |
| 2p | 38.1 | 3.29 M | 26.3 M |
| 3p | 34.4 | 2.97 M | 23.8 M |
| 4p | 46.6 | 4.02 M | 32.2 M |

×8 assumes near-linear scaling of independent games across the 8 cores via worker threads. **That
is an assumption, not a measurement** — the spike did not run a parallel harness. Memory supports
it (peak heap 341 MB single-process against 8 GB), and the games are genuinely independent, so it
is a reasonable assumption; it should still be verified when the Milestone 2 harness is built.

**But those are random-agent games, and NFR-2 is about the search agent.** A search agent spending
the full NFR-1 live budget of 10 s per decision would take 278 × 10 s ≈ **46 minutes per game** —
about **31 games/day/core**. NFR-1 and NFR-2 are therefore *different operating points of the same
engine*, and they cannot both hold at the same simulation count. Solving for the sims/decision each
throughput target implies (d=10):

| self-play target (×8 cores) | ms/decision | sims/decision | log-stripped |
| --- | --- | --- | --- |
| 1,000 games/day | 2,486 | 1,305 | 1,766 |
| **5,000 games/day** | **497** | **261** | **353** |
| 20,000 games/day | 124 | 65 | 88 |

*(at the measured 278 decisions/game; a strong policy finishing in ~11 generations would need ~150
decisions/game, raising each figure ~1.9× — 5,000 games/day becomes 484 sims, or 655 log-stripped.)*

**The practical reading:** self-play at "thousands of games per day" runs at roughly **250–500
simulations per decision**, not the 5,000 the live-play budget allows. That is a normal and
expected split — AlphaZero-family systems likewise self-play at far lower simulation counts than
they use at evaluation time — but it should be written into the Milestone 6 budget explicitly
rather than discovered later. **Log-stripping is the highest-value lever in this regime**, buying
~35% more simulations at the same throughput, and it is already proven rules-neutral.

---

## 6. Mitigation ledger

Costed against the data rather than listed as if each were free.

| # | mitigation | measured value | status |
| --- | --- | --- | --- |
| 1 | Truncated rollouts + M3 heuristic leaf eval | 7–13× vs full playout (414 → 5,248 at d=10) | **Already the M4 design.** The single largest lever, and free — it is what §5.2 already specifies. |
| 2 | Log-stripped snapshots | restore −14% early, **−52% late**; +35% sims in the self-play regime | **Available now** (bullet 4 proved rules-neutrality). Recommended as the default for search-only snapshots. |
| 3 | Snapshot-once / restore-many | 1,697 vs 1,061 clones/s (**+60%**) | Free — an access pattern, not a change. Adopt in the M4 search loop. |
| 4 | Lazy decision model (skip `toModel`) | **~7%** | **Demoted.** The hypothesis that this was a large share was wrong; not worth the complexity yet. |
| 5 | Worker-thread parallelism | ×8 assumed, not measured | Deferred to the M2 harness, where it belongs. |
| 6 | Rescope search width/depth, RL scale | — | **Not required.** |

### The plan's "incremental apply/undo copy path" — investigated and rejected

The Implementation Plan offers this as the remedy if clone cost proved prohibitive. Resolving it so
it stops being an open suggestion:

- **The Engine has no undo journal.** Its user-facing undo
  ([PlayerInput.ts:70-72](../../src/server/routes/PlayerInput.ts:70)) computes
  `lastSaveId - 2` and calls `gameLoader.restoreGameAt(...)` — it is restore-from-save-history,
  i.e. the *same* serialization path, not an incremental mechanism at all.
- **Building one would require mutation tracking inside Engine internals**, across ~1,000 card
  implementations that mutate player and board state directly. That is precisely what **CON-1**
  forbids, and CON-1 is the load-bearing reason this project carries essentially no rules risk.
  Trading that away to save a millisecond would be a catastrophic exchange.
- **It is unnecessary.** The measured fork cost is 0.979 ms and the gate clears by 3–5×. There is
  no problem for it to solve.

**Rejected.** The honest substitutes are mitigations 1–3 plus the fork-at-quiescent-ancestor
strategy validated in §3.

---

## 7. Incidental findings

- **FR-9 fallback rate, measured for the first time at scale:** 16.2 / 20.9 / 27.3 per 1,000
  decisions at 2p/3p/4p — around 1.6–2.7% of decisions, rising with player count. Every occurrence
  is the known `SelectStandardProjectToPlay` / `SelectProjectCardToPlay` overlap
  (`enumerateProjectCard` fed a standard project). The fallback recovers all of them, but this is a
  real and quantified enumerator gap, and fixing `enumerateProjectCard` would remove a per-decision
  cost as well as a correctness wart. Worth doing before Milestone 3.
- **`Cache.mark` noise is worse than expected at clone volumes:** 13,500 suppressed `console.log`
  lines in the clone-cost run alone (one per END-phase restore). Harmless once silenced, but at
  self-play scale it is a genuine cost, and the map it populates is unbounded.
- **An unawaited Engine async tail escapes console silencing.** `Game.gotoEndGame()` sets
  `phase = END` synchronously, then calls `gameLoader.completeGame(this)` without awaiting; the
  caller does not await either. `completeGame` logs on a later microtask — after any synchronous
  measured region has returned and restored the real `console.log`. Consequence beyond cosmetics:
  **`--json` output is not pure JSON**, because stray `Marking ...` lines land after the report.
  Any tooling that consumes these reports must slice from the first `{` to the last `}`. Engine
  behavior, out of scope to change (CON-1).
- **`safeFractionByStratum` in the clone-cost suite is a median of a boolean** (a majority vote),
  not a fraction, and reads misleadingly as 100%. Flagged for a follow-up fix; §3's figures are
  authoritative.

---

## 8. What this changes

- **Risk register (Implementation Plan §7.2):** "Simulator too slow to clone for useful search /
  self-play (state-clone cost)" — currently **High**, described as "the single biggest feasibility
  risk". It has been measured and cleared by 3–5×. **Recommend downgrading to Low**, with this
  document as the evidence.
- **Milestone 4 exit criterion:** the `N` placeholder can be filled with **1,000 simulations per
  decision** at the 10 s budget on the reference hardware in §0.
- **SRS NFR-2** requires a hard state-clone-cost target `X` "established from that measurement".
  The measurement now exists: a fork costs **0.979 ms** (0.481 ms log-stripped). A defensible `X`
  is **≤ 2 ms per fork on reference hardware**, ~2× headroom over measured.
- **Milestone 6 budgeting** should use the §5 self-play operating point (≈250–500 sims/decision at
  thousands of games/day), not the §4 live-play figure.

Per sub-task E's own scope, the SRS and Implementation Plan are **not** edited here — that was
specified for a rescope outcome, and no rescope was triggered. The three values above are supplied
so those edits are a one-line change each whenever they are made.

---

## 9. How to reproduce

From the repo root, with `node_modules` installed (`npm ci`):

```bash
npx tsc -p agent/tsconfig.json && npx tsc-alias -p agent/tsconfig.json
```

Both steps are required — plain `tsc` emits unrewritten `require("@/...")` calls and
`node build/agent/...` fails to load. Then:

```bash
node build/agent/agent/src/runner/speedSpikeCli.js --suite game-runtime --scale 100 --players 2,3,4
```

```bash
node build/agent/agent/src/runner/speedSpikeCli.js --suite clone-cost --scale 50 --players 2,3,4
```

```bash
node build/agent/agent/src/runner/speedSpikeCli.js --suite fork-cost --scale 30 --players 2,3,4
```

All three used the default seeds (`--seed 1 --agent-seed 1000003`; the agent seed is independent of
the engine seed per SRS CON-5). Add `--json` for machine-readable output — and slice from the first
`{` to the last `}`, per §7. `--list` enumerates the suites.

Sample sizes: 300 games / 600 game-runs (B), 50 games and 200 stratified points (C), 90 games and
26,026 fork experiments (D).
