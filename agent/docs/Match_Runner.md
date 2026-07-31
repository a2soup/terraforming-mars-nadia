# The Match Runner — Milestone 2, bullet 1

**Status: complete, seven of eight criteria met; R7 (parallel throughput) is unmeasurable on this
host and is recorded as untested.** Date: 28 July 2026. Engine pin
`868714d72a434ab68fe08e5570ebc6863859ae15`.

This is the deliverable for Milestone 2 bullet 1: *"Build the match runner that plays N games
between any two agent versions under controlled seeds and records full histories. Two players is the
primary setting; support three players so the AC-5 competence check and the AC-8 calibration report
can be produced."* It discharges **SRS FR-13** and builds the substrate for FR-14 (bullet 3),
FR-DATA-1 (bullet 4), FR-15/AC-7, AC-3, AC-5 and AC-8.

The design decisions and the criteria R1–R8 were pre-committed, before any code, in
[Milestone2_Bullet1_Prompts.md](Milestone2_Bullet1_Prompts.md) (commit `4fd0d33db`). This document
adjudicates them against measurement. The evidence artifact is
[docs/data/match_runner_validation.json](data/match_runner_validation.json) (3.5 MB: 1,700 per-game
rows plus every check's output).

**This is the instrument every later strength claim depends on.** `agent/CLAUDE.md` §9: *"Measure
everything through the Milestone 2 harness — it is the single source of truth for strength."* M3's
tuned weights, M4's significance test, the AC-7 promotion gate and the AC-8 calibration all read its
output. That is why the validation below spends most of its effort on whether the runner's own
numbers mean what they appear to mean, and almost none on what random-legal play does.

---

## 1. What was built

| Module | What it is |
| --- | --- |
| `agent/src/agents/registry.ts` | Named, **versioned** agents. `random-legal@1` is the only entry; version is recorded in every row (AC-7, the per-version AC-1 re-run). |
| `agent/src/match/pairing.ts` | Pairing groups, seat permutations, the seed schedule (§4.1 of the plan). |
| `agent/src/match/ranking.ts` | The Engine's real winner rule: VP, then megacredits; placements with ties sharing a number. |
| `agent/src/match/runner.ts` | The batch loop, per-seat responder routing, the summary. |
| `agent/src/match/types.ts` | The record schema, designed once against every downstream consumer. |
| `agent/src/match/history.ts` | History capture at the submission boundary, and its verification. |
| `agent/src/match/legality.ts` | The absorbed AC-1 accounting (§4.6). |
| `agent/src/match/pool.ts`, `poolChild.ts` | The child-process pool. |
| `agent/src/match/artifact.ts` | Header + rows writer, the retention policy, the timing-field strip. |
| `agent/src/runner/matchCli.ts` | `npm run match`. |
| `agent/src/runner/matchValidationCli.ts` | The R1–R8 battery (this document's evidence). |

### How to run it

A 1,000-game 2p match (500 pairing groups × 2 permutations):

```bash
npx tsx agent/src/runner/matchCli.ts --players 2 --groups 500
```

Two named agents, three players, with full move histories:

```bash
npx tsx agent/src/runner/matchCli.ts --lineup random-legal,random-legal,random-legal --groups 100 --history moves
```

The AC-1 legality battery as a mode of a match, for a promoted agent version (§4.6):

```bash
npx tsx agent/src/runner/matchCli.ts --lineup <agent>,<agent> --groups 500 --legality
```

Re-run the whole validation battery (the numbers in §3 below):

```bash
node build/agent/agent/src/runner/matchValidationCli.js --phase all
```

**Any performance number must come from the compiled build** — `npx tsc -p agent/tsconfig.json &&
npx tsc-alias -p agent/tsconfig.json`, then the `node build/...` form. See §4.

---

## 2. What a measurement from this runner means

Three things a reader of a win rate from this harness needs to know.

**The unit of measurement is a pairing group, not a game.** A group fixes one engine seed — so every
game in it starts from the identical board and deal — and plays the lineup in every seat permutation
(2 games at 2p, 6 at 3p, 4 cyclic rotations at 4p). `N` is a number of groups; a game count that is
not a whole number of groups is an unbalanced sample, and the CLI rounds up and says so rather than
truncating. Sharing the engine seed makes the *initial position* identical across the group; it does
**not** make the games mirror images, because they diverge at the first decision.

**Win rates are reported two ways, and the difference is the point.** `bySlot` aggregates by lineup
slot — the identity being compared, seat effects balanced out by construction. `bySeat` aggregates
the same games by seat. R1a is stated on the first, R1b on the second, and reporting only the first
would hide whether the balancing was doing anything.

**Statistics stop at counts and one interval.** Win rate, placement counts, VP margin and a Wilson
95% interval are here because R1a is stated on them. Elo/TrueSkill, significance testing and the
rating pipeline are bullet 3; the expert-distribution report is bullet 4. This runner records their
inputs.

> **Annotation, 31 Jul 2026 — the intervals here are game-level, and bullet 3 restated them.** This
> runner's `winRateCi95` treats each game as an independent draw, which the pairing design makes
> slightly false: games in a group share an Engine seed. The measured design effects are 1.033 (2p),
> 1.252 (3p) and 1.293 (4p), so these intervals are 1.6-12% too narrow, in the anti-conservative
> direction. **No point estimate in this document changes** - over balanced groups the correction is
> exactly zero on the estimate - and neither R1a's nor R1b's verdict changes either: slot 0 becomes
> 51.60% [48.45%, 54.74%] against [48.50%, 54.69%], and seat 0's interval is unchanged to two
> decimals. `npm run rate -- report docs/data/match_runner_validation.json` reproduces both. See
> [Rating_Pipeline.md](Rating_Pipeline.md) §5.

---

## 3. The criteria, adjudicated

Pre-committed in [Milestone2_Bullet1_Prompts.md §6](Milestone2_Bullet1_Prompts.md) before any
measurement code existed.

| | Criterion | Verdict |
| --- | --- | --- |
| R1a | Seat balance works | **Met** |
| R1b | Seat balance was necessary | **Reported, and the honest answer is "not demonstrated"** |
| R2 | Reproducibility, same process and fresh process | **Met** |
| R3 | History fidelity | **Met** |
| R4 | Ranking matches the Engine | **Met; one path covered by construction only** |
| R5 | 3p to the same standard, 4p works | **Met** |
| R6 | The parallel path is not a different runner | **Met — after fixing a real defect it found** |
| R7 | Throughput ≥ 5× at 8 workers | **UNTESTED — not measurable on this host** |
| R8 | The absorbed legality accounting is the same accounting | **Met** — strengthened to run the real per-seat router |

### R1a — seat balance works. Met.

1,000 games (500 pairing groups), 2p, `random-legal@1` vs `random-legal@1` with distinct agent
seeds, all groups balanced:

| | win rate | 95% CI (Wilson) | placements |
| --- | --- | --- | --- |
| slot 0 | **51.60%** (516/1000) | **[48.50%, 54.69%]** | 516 / 484 |
| slot 1 | 48.40% (484/1000) | [45.31%, 51.50%] | 484 / 516 |

The interval contains 50%. R1a is met.

The residual 1.6 pp is not a seat effect — full-permutation pairing removes that by construction —
it is the two slots drawing from different agent-RNG streams, which is exactly the noise a 1,000-game
sample has.

### R1b — was the pairing necessary? Reported; not demonstrated at this sample size.

The same 1,000 games, aggregated by seat instead:

| | win rate | 95% CI (Wilson) | placements |
| --- | --- | --- | --- |
| seat 0 (leads) | **52.60%** (526/1000) | **[49.50%, 55.68%]** | 526 / 474 |
| seat 1 | 47.40% (474/1000) | [44.32%, 50.50%] | 474 / 526 |

The point estimate is a +2.6 pp first-seat advantage, and the interval **just** contains 50% (low
bound 49.50%). So: **this run did not demonstrate a seat bias**, and the honest statement is that the
pairing is a correctness measure whose necessity is unproven here — **not** that there is no seat
advantage.

Two reasons to keep the pairing regardless, and to re-measure later:

- **Random-legal play is the weakest possible instrument for detecting a tempo advantage.** Going
  first is worth something only to a player who can use the extra tempo; an agent choosing uniformly
  among legal moves largely cannot. A directed agent may well show a bias this run cannot see.
- The direction and rough size are what a first-player advantage would look like, and the sample is
  simply too small to resolve 2–3 pp. Resolving a 2.6 pp effect at 95% confidence needs on the order
  of 5,000–10,000 games.

**Re-measure R1b at M3**, when there is an agent capable of exploiting tempo. It is one flag on the
existing runner (`--groups`), not new work.

### R2 — reproducibility. Met.

Two runs of an identical specification agree on every field except the declared timing fields
(`MATCH_TIMING_FIELDS`: `header.provenance.createdAt`, `summary.timing`, `games[].durationMs`):

| | groups | games | same process | fresh process |
| --- | --- | --- | --- | --- |
| 2p | 20 | 40 | identical | identical |
| 3p | 10 | 60 | identical | identical |
| 4p | 5 | 20 | identical | identical |

The fresh-process leg goes through the ordinary CLI rather than a bespoke worker, so a CLI that
defaulted something differently would be caught here.

### R3 — history fidelity. Met.

60 games recorded at `moves` tier, then every one re-derived from its record's seeds and compared:

- **60/60 verified**, 0 failures — the move-trace hash and the stored move list both.
- **58 of the 60 games contained at least one FR-9 fallback**, against the 10 the criterion requires.
  R3 explicitly fails as *untested* on a thin fallback sample; it is not thin.
- The negative control works: perturbing one decision localizes the divergence to that index, and a
  history with a decision *removed* — the H2 failure mode — is caught (`test/match/history.spec.ts`).

**Measured sizes**, replacing the plan's §4.4 estimate:

| tier | bytes/game | plan's guess |
| --- | --- | --- |
| `summary` | 2,153 | ~1 KB |
| `moves` (sidecar) | **69,700** | 30–60 KB |

`moves` is ~17% above the top of the estimated range, which makes the §4.7 retention convention more
load-bearing, not less: a 1,000-game `moves` run is **~70 MB**. It defaults to the gitignored
`agent/runs/`, and `assertRetentionPolicy` refuses to write it into `agent/docs/data/`.

### R4 — ranking matches the Engine. Met; the full-tie path is covered by construction only.

The constructed cases (`test/match/ranking.spec.ts`) cover strict VP order, a VP tie broken by
megacredits, a full tie on both (shared placement, multiple winners), and the 3p three-way cases,
against the rule in `src/client/components/GameEnd.vue:292-320`.

Observed in the 1,700 validation games:

| | completed | VP ties at the top | of those, broken by megacredits | shared wins (full ties) |
| --- | --- | --- | --- | --- |
| 2p | 1,000 | 16 | 16 | 0 |
| 3p | 600 | 17 | 17 | 0 |
| 4p | 100 | 3 | 3 | 0 |

So the **megacredit tiebreak is exercised by real games 36 times** — it is not a code path that only
a unit test has ever reached, which is what R4's observed half exists to check. The **full-tie /
shared-win path is covered by construction only**: no game in 1,700 tied on both VP and megacredits.
Stated per §6 rather than left implicit.

### R5 — 3p to the same standard, 4p works. Met.

**3p**, 600 games (100 groups, all six permutations), all groups balanced, placement recorded per
seat:

| | win rate | 95% CI | placements (1st/2nd/3rd) |
| --- | --- | --- | --- |
| slot 0 | 34.33% | [30.64%, 38.22%] | 206 / 205 / 189 |
| slot 1 | 34.00% | [30.32%, 37.88%] | 204 / 204 / 192 |
| slot 2 | 31.67% | [28.07%, 35.50%] | 190 / 191 / 219 |

Every interval contains the 33.3% symmetric-lineup baseline. R2, R3 and R4 hold at 3p.

**4p** at smoke scale: 100 games (25 groups × 4 cyclic rotations), 100/100 completed, placements
recorded, and R2 reproducibility verified (5 groups, same process and fresh process). R1a is **not**
claimed at 4p — cyclic rotation is a Latin square rather than full permutation balance, and 4p is not
a criterion setting for any acceptance criterion.

Across all 1,700 games: **zero failures, zero Agent-attributable illegal-move rejections**
(`fallbacksAfterRejection` is 0 in every run; 9,689 fallbacks after a responder throw, the one benign
cause AC-1 catalogued).

### R6 — the parallel path is not a different runner. Met, after fixing a real defect.

| capture mode | games | workers | pooled artifact identical to single-process? |
| --- | --- | --- | --- |
| `summary`, no legality | 80 | 4 | identical |
| `trace` + legality mode | 80 | 4 | identical |

**The battery found a genuine divergence here, and it is the most useful thing this unit produced.**
On the first run the second leg failed. No game record differed and the summary was identical — the
difference was confined to `instrumentation.detail`:

```
single: {"historyTier":"trace","games":80,"decisionsRecorded":23676,...}
pooled: {"perWorker":[{...,"games":20,...},{...,"games":20,...},{...},{...}]}
```

`detail` is Unit B's free-form escape hatch, so Unit C's `mergeInstrumentation` deliberately refused
to guess at its shape and preserved each child's block under `perWorker`. That was the right call in
the absence of a merge rule — and wrong once R6 was actually measured, because it made the pooled
artifact structurally different from the single-process artifact **for every instrumented run**.
Neither unit was at fault: Unit B specified merge semantics for the legality counters and cause
tallies, which Unit C implemented; nobody specified them for `detail`. It is a seam gap, and only a
criterion that compares whole artifacts could have found it.

The fix puts the merge where the shape is owned: `mergeHistoryDetail` in `match/history.ts`, which
`pool.ts` now delegates to. Per-worker counts sum, run-level scalars must agree and are carried once,
`movesBytesPerGame` is recomputed from merged totals rather than averaged (averaging per-worker
averages weights uneven shards wrongly), and anything it has no rule for falls back to the original
`perWorker` shape — a visibly unmerged block is better than a wrong number. Six specs cover it,
including the byte-identity of the serialization, since R6 compares JSON strings and key order is
part of the criterion.

### R7 — throughput. UNTESTED: not measurable on this host.

**This criterion is neither met nor missed. The measurement is void**, and reporting a number from it
would be worse than reporting none.

What the host was doing throughout:

| | |
| --- | --- |
| Machine | Apple M2, 8 cores, **8 GB** |
| Swap in use | **5.67 GB of 6.14 GB**, constantly |
| Free memory | 124–411 MB |
| Load average | 4.4–12.7, from a running Terraforming Mars app and Claude's renderer |

Two symptoms make the invalidity concrete:

1. **The single-process baseline is not stable.** The identical 2p specification measured **9.0,
   38.3 and 39.4 games/s** in different runs of the same session — a 4.3× swing with nothing changed.
   The spike's own `game-runtime` suite, re-run unchanged at the same pin on the same machine,
   likewise reported both **7.5** and **41.4 games/s**. (The spike's recorded 38.1 games/s does
   reproduce; it just does not reproduce *reliably*.)
2. **Eight Node children do not fit.** Each peaks near 300 MB of heap; eight of them is ~2.4 GB on a
   host with ~120 MB free and 92% of swap already in use. The pool thrashes rather than scales.

The measurements that were taken, for the record (1,000 games, back-to-back, `--r7-workers 1,2,4`):
1 worker 9.0 games/s, 2 workers 1.50×, 4 workers 1.25×. An earlier 500-game sweep including 8
workers gave 1.32× / 1.34× / 1.02×. Both are measurements of a swapping host.

**What this leaves open.** `Simulator_Speed_Spike.md` §5 explicitly deferred verifying its ×8
core-scaling assumption to this harness, and that assumption is **still unverified**. The spike's
NFR-2 games/day table and the M6 self-play budget computed from it therefore still rest on an
untested multiplier. §6 pre-committed that missing the threshold triggers a documented revision of
that budget; a void measurement does not license a revision, so the honest outcome is to leave the
figures alone and mark the assumption open.

**To settle it**, on a host that is idle and not swapping (≥16 GB, nothing else running):

```bash
node build/agent/agent/src/runner/matchValidationCli.js --phase r7 --out-dir /tmp/v
```

The phase records `loadAverage`, `freeMemoryBytes` and swap usage per point precisely so a future
reader can tell whether the run was valid. If it is, R7 is a one-command check.

### R8 — the absorbed legality accounting is the same accounting. Met.

50 shared configs, played through **`runLegalityBatch`** (the Milestone 1 runner, the oracle) and
through the match runner in legality mode, in both instrumentation variants (`summary` = legality
mode alone; `trace` = legality mode with the history recorder's wrapper nested around it):

- **0 mismatches** across all nine adjudicated fields — submissions, `rejectedResponder`,
  `rejectedFallbackProbe`, `responderThrows`, `fallbacksAfterRejection`, `fallbacksAfterThrow`,
  `completed`, `decisions`, `generation`.
- **Cause tallies agree**, key for key and count for count — the same submissions rejected for the
  same reasons, one level finer than the counters.
- Run totals: 13,689 submissions, 0 rejected-responder, 0 rejected-fallback-probe, 218 responder
  throws, 50/50 completed.

Neutrality, so the instrument is shown not to perturb what it measures:

- `checkNeutralityAgainstReplay`: 12 configs through the uninstrumented determinism harness vs the
  fully instrumented runner — **0 mismatches**.
- `checkMatchNeutrality`: 20 real match games with the per-seat router in place, clean vs fully
  instrumented, compared **field for field** on the whole game record — **0 mismatches**.

So the AC-1 battery can be run as a mode of a match without changing what "zero illegal moves"
counts. `agent/src/legality/` is **retained** as the M1 artifact-of-record and as this comparison's
oracle.

**The comparison exercises the real per-seat router — this was fixed after the first adjudication.**
As first written, the check made the two runners play the same game by *substituting the router
away*: the match runner and `runLegalityBatch` construct agents differently (one agent shared across
seats drawing one RNG stream, versus one agent per seat from its own seed), so without some
intervention they play different games and comparing counters would compare noise. Substituting the
router bought identical games at the cost of never testing the router, and left the match record's
own `decisions` counter 0 by construction — so *no single check compared the real per-seat match
runner against the Milestone-1 oracle*: this one covered the accounting on a path that was not the
real one, and `checkMatchNeutrality` covered the real path but only against another match run.
Since a promotion gate rests on this equivalence, that composition was weaker than it looked.

The fix works on the agent instead of the runner. `randomLegalAgent` holds **no state but its
`AgentRandom`**, so *n* per-seat agents sharing one `AgentRandom` are behaviourally identical to one
shared agent. The comparison now seats a temporary registry entry (`withTemporaryAgent`,
`agents/registry.ts`) whose `create` hands every seat an agent bound to the same stream: the games
are identical to the oracle's *and* the runner's per-seat construction and seat router both run for
real. `decisions` is consequently compared from the router's own counter on both variants — and it
agrees exactly (13,689 on both sides), which is positive evidence the router ran rather than merely
an absence of failure.

*(A note on the fix's own history, since it bears on how much the number is worth: the first
attempt resolved the match spec **outside** the temporary registration, so every lookup threw and
the phase aborted — and a stale `r8.json` from the previous run made it look like a clean pass. The
numbers above come from a run whose artifact was deleted first and whose completion line was
checked. The registry seam and the ordering are both spec-covered.)*

---

## 4. Findings worth not rediscovering

**Absolute throughput on a shared workstation is not a measurement.** The single most expensive
detour in this unit was chasing an apparent 6× regression in the match runner that turned out to be
the host swapping. The sequence: the runner measured ~6 games/s where the spike recorded 38.1; the
M1 legality runner measured the same ~6.9, which ruled out the match runner; the spike's own suite
then reported 7.5 *and* 41.4 on consecutive runs, which ruled out the code entirely. Two hypotheses
were tested and disproved along the way — that `createGame` was excluded from the spike's timer
(it is excluded, but it is only 5% of a game) and that the seed schedule mattered (it does not).
**Before treating any throughput delta as a regression, check free memory and swap.** `machineState()`
in `matchValidationCli.ts` records both per point, which is why the R7 block is self-diagnosing.

**A criterion that compares whole artifacts finds things no unit test does.** R6's whole value was
the `detail` merge gap (§3, R6): both units were individually correct, both were spec-covered, and
the gap lived precisely between them. This is an argument for keeping byte-identity criteria rather
than field-by-field ones — the divergence was in a field nobody would have thought to assert on.

**`moves`-tier history costs 69.7 KB/game, not the 30–60 KB estimated.** A 1,000-game `moves` run is
~70 MB. The retention convention (§4.7: gitignored `agent/runs/` as the *default* destination, plus a
policy assertion in code) is the reason that never reaches a commit.

**The FR-9 fallback fires in 97% of games (58/60), not occasionally.** At ~5–8 per game it is the
normal case, not an edge case — which is why a history recorder built on the responder wrapper would
have been wrong nearly everywhere rather than rarely. Consistent with AC-1's 8,480 throws over 1,500
games.

**Real VP ties happen at ~1.6% of games and are always broken by megacredits.** 36 in 1,700. Full
ties on both keys did not occur at all. So the tiebreak matters in practice and the shared-win path
is rare enough that it will stay construction-covered for a long time.

**A path built by counting `..` from `__dirname` resolves inside `build/agent/` under the compiled
build.** `artifact.ts` documents this trap and solves it with `repoRoot()`; the validation CLI's
first assemble hand-rolled the join and wrote a 7 MB artifact into `build/agent/agent/docs/data/` —
a directory that exists nowhere and is not gitignored. Use `defaultOutputDir()`.

---

## 5. What the record schema carries, and why

Per-run header (written once) plus one row per game. Every field exists because a *named* consumer
needs it; the full table is in `src/match/types.ts`'s module doc. The short version:

| Consumer | Reads |
| --- | --- |
| Bullet 3 (FR-14 ratings) | `placement`, `isWinner`, `marginToNext`, per-seat agent identity |
| Bullet 4 (FR-DATA-1, AC-8) | `victoryPoints`, `terraformRating`, `generation`, `corporations`, `projectCards`, `preludes`, milestones/awards |
| M3 (evaluation tuning) | the above plus `victoryPointsByGeneration` and `vpBreakdown` |
| AC-5 | `placement` at 3p/4p |
| AC-7 / FR-15 | agent name **and version** per seat, `provenance.engineCommit`, the seeds |
| AC-1 / NFR-4 per version | `completed`, `failure`, `decisions`, `fallbacksAfter*`, and the legality-mode counters |
| Reproducibility (NFR-5) | `engineSeed`, per-seat `agentSeed`, `groupIndex`, `permutationIndex`, `harnessVersion` |

The reason this was designed up front rather than grown: re-running is cheap for `random-legal`
(1,000 games in ~26 s compiled, when the host cooperates) and expensive for every agent after it. A
field omitted today — the corporation each seat took, say — costs a 1,000-game re-run now and a
multi-hour one at M4.

**A game is identified by `(runId, groupIndex, permutationIndex)`, never by `game.id`** (hazard H4:
`gameFactory.ts` builds `g-nadia-${seed}` and omits the player count, so a 2p and a 3p game on the
same engine seed share an id).

---

## 6. Known limitations

1. **R7 is unverified** (§3), and with it the spike's ×8 core-scaling assumption and the M6 self-play
   budget derived from it. One command on an idle host settles it.
2. **R1b did not demonstrate a seat advantage**, so the pairing's necessity rests on argument rather
   than measurement. Re-measure at M3 with an agent that can use tempo.
3. **The full-tie ranking path is construction-covered only** — no game in 1,700 tied on both VP and
   megacredits.
4. **Only one agent exists.** Everything here is `random-legal@1` against itself. The registry holds
   one entry; the greedy one-ply baseline is bullet 2. A runner validated on a single agent has not
   been shown to handle two *different* agents' code paths, though nothing in it is agent-specific.
5. **The validation artifact is 3.5 MB**, larger than all six Milestone 1 artifacts combined
   (~1.3 MB). It carries 1,700 full per-game rows because they are the reusable asset — bullet 5's
   regression seed set and bullet 4's first real input — not only R1–R8 evidence.
6. **AC-1 has not been re-run through the absorbed mode in anger.** R8 proves the accounting is
   equivalent on 50 configs; the first real per-version battery happens at M3.
7. ~~R8's equivalence is a composition of two checks rather than one direct measurement.~~
   **Closed 28 Jul 2026** — see the R8 section above. The comparison now runs the real per-seat
   router.

---

## 7. Deviations from the plan

**One file was added outside Unit D's ownership.** The plan's §9 assigns Unit D only documents, but
R2, R6 and R8 are library functions with no entry point — Unit D had to produce their numbers.
`agent/src/runner/matchValidationCli.ts` is that entry point. It is permanent and re-runnable rather
than a scratch script, consistent with `legality/`, `determinism/` and `coverage/` all being kept.

**Two files owned by Units B and C were modified**, to fix the R6 defect: `match/history.ts` gained
`mergeHistoryDetail` and its specs, and `match/pool.ts` delegates to it (§3, R6). This is the
battery finding a real defect and it being fixed, which is what the battery is for.

**`agents/registry.ts` gained `withTemporaryAgent`**, to close the R8 gap (§3, R8). It registers an
agent for the duration of one call and is deliberately narrow — one production caller, a throw
rather than a silent shadow if the name already exists. It will also be what a test seats a fake
agent with from bullet 2 onward.

**One allowlist entry was added** to `test/determinism/rngSeparation.spec.ts` — the P5 structural spec
correctly flagged the validation CLI's wall-clock reads. The entry records why they are safe (timing
that is reported and never read back, and one provenance timestamp), in the format that spec
requires. The spec working on a file added months after it was written is the check earning its keep.

---

## 8. Where this leaves Milestone 2

Bullet 1 is done. The remaining bullets, unchanged:

- **Bullet 2** — fixed baselines: the greedy one-ply (OSLA) agent, plus the prior-art reference
  numbers. It slots into `agents/registry.ts` as one entry.
- **Bullet 3** — the rating pipeline: win rate, average VP margin, Elo/TrueSkill with confidence
  intervals, reading this runner's rows.
- **Bullet 4** — the expert-distribution report (FR-DATA-1) and the BGA↔engine reconciliation, which
  must treat the eight catalogued Engine-vs-print divergences
  ([Card_Coverage_Audit.md](Card_Coverage_Audit.md)) as known Engine-specific rules.
- **Bullet 5** — the regression suite of fixed seeds and reference games. The 1,700-game validation
  artifact is candidate seed material.
