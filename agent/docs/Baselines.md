# The Fixed Baselines — Milestone 2, bullet 2

**Status: complete. All nine pre-committed criteria met**, over **3,700 validation games** (1,000 at
2p vs random, 1,000 at 2p mirror under the AC-1 battery, 600 at 3p, 100 at 4p, 200 for the prediction
checks, plus the reproducibility and guard legs) with **zero failures and zero Agent-attributable
illegal-move rejections**. Date: 29 July 2026. Engine pin
`868714d72a434ab68fe08e5570ebc6863859ae15`.

| Criterion | Verdict |
| --- | --- |
| **G1** — candidate enumeration is legal and additive | **Met** — 843,871 candidates, 0 rejected; determinism corpus unchanged |
| **G2** — fork safety, proven three ways | **Met** — counters identical to bullet 1; 60,589 speculative submissions hidden |
| **G3** — fork fidelity in production | **Met** — 0 silent divergences; 99.7% fork availability |
| **G4** — AC-1 for `greedy-1ply@1` | **Met** — 1,000/1,000 games, 0 illegal moves across 226,840 submissions |
| **G5** — greedy beats random at 2p | **Met** — 99.2%, CI [98.4%, 99.6%] (above §4's band; investigated, not adjusted) |
| **G6** — reproducibility | **Met** — identical in-process and fresh-process at 2p and 3p |
| **G7** — diagnostics reported | **Met** — tie-break fraction **75.9%**, median score spread **0 VP** |
| **G8** — 3p and 4p | **Met** — 97.3% and 94.0% first place, against 33.3% / 25.0% baselines |
| **G9** — reference table with its interpretation rule | **Met** — §4 |

**The two numbers to carry forward** are G5 and G7 together: this agent wins **99.2%** of games
against random-legal while resolving **75.9%** of its scored decisions by coin flip, with a median
score spread of exactly **zero VP**. Neither number means much alone.

This is the deliverable for Milestone 2 bullet 2: *"Implement fixed baselines: random-legal and a
greedy one-ply agent (the OSLA equivalent from the prior-art paper). Record the paper's published
reference numbers (default MCTS beats OSLA ~75%, random ~98%; OSLA beats random ~91%) as external
sanity checks."*

The design decisions and the criteria G1–G9 were pre-committed, before any code, in
[Milestone2_Bullet2_Prompts.md](Milestone2_Bullet2_Prompts.md) (commit `5e957566e`). This document
adjudicates them against measurement. The evidence artifact is
[docs/data/baselines_validation.json](data/baselines_validation.json).

**What a "baseline" is for, and why this one is deliberately weak.** `greedy-1ply@1` is a fixed
yardstick, not a step toward a strong agent. AC-3 asks the finished Agent to win ≥ 80% against a
greedy one-ply player and ≥ 90% against random-legal; M3's exit criterion repeats those numbers. Both
only measure what they were written to measure if the yardstick stays frozen and stays dumb — so this
agent maximizes *current victory points and nothing else*, and every temptation to make it cleverer
was declined in the plan before any of it was built.

---

## 1. What was built

| Module | What it is |
| --- | --- |
| `agent/src/core/candidates/` | Candidate-set enumeration for all 13 in-scope decision types, mirroring `core/enumerator/` without modifying it (Unit B). |
| `agent/src/search/speculation.ts` | The speculation registry: which `IGame` objects are forks, and the guard that keeps their submissions out of the legality and history instruments (Unit A). |
| `agent/src/search/fork.ts` | The fork service: rolling nearest-forkable-ancestor snapshot, recorded **accepted** responses, and a fork at any decision point (Unit A). |
| `agent/src/search/pendingModel.ts` | The third fidelity check, added after Unit B found the two-way check insufficient (§5.1). |
| `agent/src/search/forkProbe.ts` | The G2b negative control: an agent that forks and submits into forks, so the guard can be shown *doing* something. |
| `agent/src/core/greedyOnePlyAgent.ts` | `greedy-1ply@1` itself (Unit C). |
| `agent/src/runner/baselinesValidationCli.ts` | The G1–G9 battery (this document's evidence). |

### How to run it

A greedy-vs-random match:

```bash
npx tsx agent/src/runner/matchCli.ts --lineup greedy-1ply,random-legal --groups 500
```

The validation battery, one phase per process (they share process-global state and must not overlap):

```bash
node build/agent/agent/src/runner/baselinesValidationCli.js --phase all --out-dir /tmp/v
```

---

## 2. What `greedy-1ply@1` is

**The objective: current victory points, and nothing else.** At every decision the agent takes the
bounded candidate set, plays each candidate into its own fork of the live position, drains that fork
to the end of the move, scores it with the Engine's own `player.getVictoryPoints().total`, and plays
the argmax. Ties are broken uniformly from its seeded stream.

Three choices inside that sentence carry the design, and each has a plausible alternative that was
rejected in the plan:

- **No megacredit tiebreak.** `match/ranking.ts` breaks VP ties on megacredits because that is the
  rule for ranking *finished games*. Inside a move chooser the same term is not a tiebreak, it is a
  **spending penalty**: every candidate that costs money scores strictly below passing. Followed
  through, that agent buys zero cards at initial selection, zero at every research phase, and
  therefore never plays a project card in its entire life. Prediction 7 in §6 is the measurement that
  confirms the term is absent.
- **Own VP, not margin over the best opponent.** Margin is the better objective, which is exactly why
  it belongs to M3 and not to a frozen baseline.
- **The Engine's own score function**, not a re-derived one — so there is no rule to get wrong
  (SRS CON-1). It counts TR, card VP, claimed milestones (5 each), funded awards against current
  standings, greeneries, and cities adjacent to greeneries. That last clause is why board placement
  is not VP-neutral, and it is most of what saves "points now" from indifference.

**What the agent structurally cannot see:** production, card draw, tempo, opponent threat, and any
value that arrives later than the end of its own move. This is the list M3's evaluation function
exists to add.

---

## 3. The criteria, adjudicated

### G1 — candidate enumeration is legal and additive. Met.

**G1a (legality).** Over **200 real games**, every candidate set was generated at every in-scope
decision and each candidate submitted into a throwaway fork:

| | |
| --- | --- |
| Decision points | 60,143 (59,862 validated) |
| Candidates generated | 849,360 |
| Candidates submitted | 843,871 |
| **Candidates the Engine rejected** | **0** |
| Decisions hitting the 64-candidate cap | 89 |
| Empty candidate sets | 0 |

Zero rejections across 843,871 submissions, measured against the Engine's own `process()` rather
than asserted from the type system. The 5,489 generated-but-not-submitted candidates are the
decisions where no fork was obtainable (§5.1's stricter definition), not skipped work.

**G1b (additivity). The committed 300-fingerprint determinism corpus verifies unchanged** — 300
configs, **0 mismatches**, re-run as part of this battery rather than trusted from Unit B's session.
This is the criterion that proves the candidate path was *added* rather than refactored into the
sampling path: `random-legal@1`'s move distribution is untouched, so its `version` is still honest
and every Milestone 1 number — including AC-1 — still describes the agent in the registry.

**G1c (coverage).** Nine of the thirteen in-scope types were exercised by the corpus: `amount`,
`card`, `initialCards`, `option`, `or`, `payment`, `player`, `projectCard`, `space`. **Four were not
reached: `and`, `productionToLose`, `resource`, `resources`.** They are named rather than silently
absent, which is what G1c asks — but *named is not tested*, and §7 records them as a real gap.

### G2 — fork safety, proven three ways. Met.

**G2a (equivalence preserved).** The decisive form of this check: bullet 1's R8 seed schedule was
re-used **verbatim**, so this is a before/after on the same 50 games, comparable against the totals
committed in `match_runner_validation.json`.

| Counter | Bullet 1 (no guard) | Now (guard installed) |
| --- | --- | --- |
| submissions | 13,689 | **13,689** |
| rejectedResponder | 0 | **0** |
| rejectedFallbackProbe | 0 | **0** |
| responderThrows | 218 | **218** |
| fallbacksAfterRejection | 0 | **0** |
| fallbacksAfterThrow | 218 | **218** |
| completed | 50 | **50** |
| decisions | 13,689 | **13,689** |
| generation | 1,107 | **1,107** |

Identical on every field, 0 mismatches between the oracle (`runLegalityBatch`) and the match runner
in both instrumentation variants, and the cause tallies agree. `checkMatchNeutrality` passes over 20
games with 0 mismatches. The guard did not change what the instruments count for a non-forking
agent, which is the one outcome §3.2 existed to prevent.

**G2b (negative control).** 30 games played three times — guarded, guard disarmed, and
`random-legal@1` in the probe's place:

| | Guarded | Guard disarmed |
| --- | --- | --- |
| submissions | **8,812** | **69,401** |
| rejectedFallbackProbe | **0** | **8,395** |

**60,589 submissions hidden — a 7.9× inflation had the guard not existed**, and the arithmetic
closes exactly: `submissionsHidden` (60,589) = probe's own speculative submissions (33,654) + the
fork service's replay submissions (26,935). The guarded run reports *exactly* what a non-speculating
agent playing the same games reports, on every counter (`guardedMatchesReference: true`).

The `rejectedFallbackProbe` row is the concrete harm avoided: without the guard, AC-1 would have
reported **8,395 rejected submissions that never happened in a real game**, and a promotion gate
reading that number would have been reading fiction. Zero deliberately-illegal probes were accepted.

**G2c (cross-check fires).** A submission aimed at the live game during speculation throws
(`LiveSubmissionDuringSpeculationError`), verified in `test/search/speculation.spec.ts` both directly
and end-to-end through an installed instrument.

### G3 — fork fidelity in production. Met, and the third check earned its place.

Over the three main runs, with `stableStateOf` sampled at the pre-committed 5%:

| | 2p | 3p | 4p |
| --- | --- | --- | --- |
| Fork attempts | 959,905 | 421,016 | 54,973 |
| Forked **directly** (live point restorable) | 66.2% | 66.5% | 66.0% |
| **Forked, with ancestor replay** | **99.7%** | **99.6%** | **99.5%** |
| Mean replay distance | 1.83 | 2.56 | 3.35 |
| State-compared (the expensive half) | 47,527 | 20,771 | 2,702 |
| **Silent divergences** | **0** | **0** | **0** |

**Every validation failure in production was a `pendingModelMismatch`** — 82 at 2p, 7 at 3p, 1 at
4p. Not one `pendingMismatch`, `stateMismatch` or `bothMismatch` fired. In other words **100% of the
forks this service refused were forks the two-way check of hazard H7 would have handed to the
agent**, and a further 3,844 restores (2p) were refused as *ancestors* on the same evidence. §5.1 was
not a theoretical correction.

**Two numbers in the plan turned out to be wrong in opposite directions**, and both matter:

- The direct-fork rate is **66.2%**, below §2.4's ~72% — as §5.1 predicted, because the three-way
  definition is stricter than the one that produced the old figure.
- **Overall availability is 99.7%, not "materially lower" as the corrected plan warned.**
  Replay-from-quiescent-ancestor covers almost the entire gap at a mean distance under 2 steps. The
  warning I added to Unit C's prompt — treat the fallback as a common path — was wrong: the fallback
  fires on **2.0%** of decisions, and 97% of those are `no-ancestor`, i.e. game setup before any
  forkable point exists at all.

### G4 — AC-1 for `greedy-1ply@1`. Met.

**1,000 consecutive embedded games, `greedy-1ply` in every seat, under `--legality`.** This discharges
the standing caveat in `agent/CLAUDE.md` §6: AC-1 is agent-specific and expires on every new agent
version, and this is the first new version since `random-legal@1`.

| | |
| --- | --- |
| Games completed | **1,000 / 1,000** |
| Unhandled errors / failures | **0** |
| Submissions observed | **226,840** |
| **`rejectedResponder`** (Agent-attributable illegal moves) | **0** |
| `rejectedFallbackProbe` | **0** |
| `responderThrows` | **1** |
| Candidates rejected inside forks | **0** |

Adjudicated on the **strict** counters from the `Player.prototype.process` monitor, not the driver's
`onFallback` counts — `agent/CLAUDE.md` §6 records why those are not the same accounting. Zero
Agent-attributable illegal-move rejections across 226,840 submissions, so AC-1's legality clause and
NFR-4 are met strictly rather than by a lenient reading.

**The single most surprising number here is the `responderThrows` count: 1.** `random-legal@1`
produced **8,480 across 1,500 games (~5.7 per game)**, all from one benign cause —
`enumerateProjectCard: no actable, affordable standard project`. The greedy agent hit that same cause
**once in 1,000 games**. The reason is structural: greedy answers from an enumerated *candidate set*
and only submits a move it has already constructed and scored, whereas the random-legal agent samples
a branch first and discovers afterwards that nothing in it is affordable. A search agent is not just
stronger than the random one, it is **better behaved at the submission boundary** — which is worth
knowing before reading too much into fallback counts as a health signal for future agents.

Fork behaviour over the same run was consistent with G3: 1,671,895 attempts, 65.4% direct, **99.7%
with replay**, 6,450 ancestors refused by the model check, and **145 validation failures — every one
a `pendingModelMismatch`**, again with none of the two-way kinds firing.

### G5 — greedy beats random at 2p, with significance. Met; and the margin is a discrepancy under §4's rule.

**1,000 games, 500 pairing groups, greedy-1ply@1 vs random-legal@1, zero failures.**

| | Win rate | 95% Wilson CI |
| --- | --- | --- |
| `greedy-1ply@1` | **99.2%** | **[98.4%, 99.6%]** |

> **Annotation, 31 Jul 2026 — this figure cannot be restated, and that is the finding.** Milestone 2
> bullet 3 corrects win-rate intervals for the pairing design (games in a group share an Engine
> seed). It cannot correct this one: `docs/data/baselines_validation.json` carries **summaries only,
> with no per-game rows**, so the 99.2% is not re-analysable by anything. Bullet 3 played its own
> 2p corpus on a different seed block (groups 1,000-1,499) and got **98.80% (988/1,000), 95%
> [97.91%, 99.31%]** - overlapping this interval substantially, a difference of 4 games, and a second
> sample rather than a correction. The lesson for every later bullet: **commit the rows, not the
> summary.** See [Rating_Pipeline.md](Rating_Pipeline.md) §5.
| `random-legal@1` | 0.8% | [0.4%, 1.6%] |

The interval lies entirely above 50%, so the criterion is met. By seat, over the same games: seat 0
49.8% [46.7%, 52.9%], seat 1 50.2% — the pairing did its job and the result is not a seat artifact.

**99.2% is above §4's 97% ceiling, so the interpretation rule makes this a discrepancy worth
investigating.** It is reported, not adjusted; per §3.1 of the plan and §4 above, the objective is
not being changed to move a number toward a foreign engine's published figure. Four hypotheses, none
of which this bullet tested:

1. **Different game.** TAG is base + Corporate Era only. This project's scope includes **Prelude**,
   and preludes granting immediate TR are exactly the VP-bearing choice a points-now agent sees
   clearly (§6, prediction 3). TAG's OSLA never had that lever.
2. **Milestones are worth 5 VP immediately**, and the Engine's own score function counts them the
   moment they are claimed. Greedy claims them eagerly (§6, prediction 4), and the prior-art study
   itself identifies milestones and awards as dominant win drivers. Whether TAG's OSLA heuristic
   weighted them the same way is not something this project can determine.
3. **The opponent may be weaker here than TAG's random.** A richer card pool gives random-legal more
   ways to waste a turn, and this engine's random-legal additionally throws ~5.7 times per game into
   an FR-9 fallback.
4. **The 24% of decisions greedy does *not* tie-break are the high-value ones** — claim a milestone,
   raise TR, place a scoring greenery — so a small fraction of genuinely-greedy decisions can carry a
   large share of the VP.

What the number does **not** license: any claim that this agent is strong, or that its 99.2%
predicts anything about M3's ≥ 90%-vs-random bar. It beats a uniformly random player, which is a low
bar met decisively.

### G6 — greedy is reproducible. Met.

| Leg | Games | Same process, twice | Fresh process |
| --- | --- | --- | --- |
| 2p, 20 groups | 40 | **identical** | **identical** |
| 3p, 10 groups | 60 | **identical** | **identical** |

Per-game records identical modulo the declared timing fields, with the fresh-process leg going
through the ordinary `matchCli` entry point rather than a bespoke worker. For a *stochastic* agent
this is the check that the common-random-numbers drain seeding and the per-seat streams are
genuinely deterministic rather than merely seeded — a tie-breaking agent that reproduced only
in-process would have a hidden dependence on process state.

### G7 — the diagnostics, reported. Met.

From the 2p run (130,475 greedy decisions):

| | |
| --- | --- |
| **Tie-break fraction** | **75.9%** (89,647 of 118,069 scored decisions) |
| Decisions scored (≥ 2 candidates forked) | 118,069 |
| Single-candidate decisions (no choice) | 9,796 |
| Fallbacks to random-legal | 2,610 (2.0%) — **all** `fork-unavailable`, 97% of them `no-ancestor` |
| Candidates scored | 957,295 |
| **Candidates the Engine rejected** | **0** |
| Candidate-set size | median 6, p95 19, max 64 |
| Decisions hitting the 64-cap | **7** of 130,475 |
| Drain steps per candidate | median 0, p95 1, **max 4** |
| **Drain-budget overruns** | **0** (budget 32) |
| Score spread (best − worst), per decision | **median 0**, p95 5, max 16 |
| Tie size, per scored decision | median 3, p95 10, max 49 |

**Read the first and last rows together — that is the whole character of this agent.** Three
quarters of its scored decisions are resolved by a coin flip, and the median decision has a score
spread of **exactly zero VP**: for half of all decisions, every legal candidate looked identical to
the objective. §3.1 predicted this ("most single moves change current VP by zero") and the
measurement is stronger than the prediction. **A 99.2% win rate with a 75.9% tie-break fraction is a
very different object from a 99.2% win rate with a 10% one**, and only the second would be an agent
whose strength came from choosing well throughout.

Two pre-committed parameters turned out to be far larger than needed, and both should be left alone
rather than tuned: the **64-candidate cap** binds on 0.005% of decisions, and the **32-step drain
budget** was never once reached (observed max 4). They were set before measurement to bound a
pathological case; that they are loose is the correct outcome, not slack to reclaim.

### G8 — 3p and 4p. Met.

| | Games | Greedy first-place rate | 95% CI | Baseline |
| --- | --- | --- | --- | --- |
| 3p | 600 | **97.3%** | [95.7%, 98.4%] | 33.3% |
| 4p | 100 | **94.0%** | [87.5%, 97.2%] | 25.0% |

Zero failures at either count; placement recorded per seat, not a win/loss flag. By seat the rates
sit near 1/N (3p: 32.2% / 34.0% / 33.8%; 4p: 28.0% / 25.0% / 24.0% / 23.0%), confirming the
permutation pairing removed seat order as a confound at both counts. Random-legal's placements at 3p
are near-uniform across 2nd and 3rd, which is what a uniformly random player should look like once
the one strong seat is removed.

### G9 — the reference table, recorded with its interpretation rule. Met.

§4 carries all three published figures, marks the two that cannot be adjudicated until an MCTS agent
exists (M4), and states the pre-committed interpretation rule verbatim. The one adjudicable figure
was compared in G5 and **falls outside the pre-committed band**, which §4's rule classifies as a
discrepancy worth investigating rather than a failure or a licence to retune. That is recorded there,
with hypotheses, and nothing in the agent was changed in response.

---

## 4. The prior-art reference numbers

Recorded per criterion G9, from the SRS §1.5 citation (Gaina, Goodman, Perez-Liebana, *TAG:
Terraforming Mars*, AIIDE 2021).

| Published result | Value | Adjudicable here? |
| --- | --- | --- |
| OSLA beats random | ~91% | **Yes** — this bullet's G5. |
| Default MCTS beats OSLA | ~75% | No — needs an MCTS agent, which does not exist until M4. |
| Default MCTS beats random | ~98% | No — same. |

**The interpretation rule, pre-committed in §3.6 of the plan**, restated here because a sanity check
nobody can act on is not a check:

- Greedy beating random **at all, with significance** is the criterion.
- **80–97%** is consistent with the reference and needs no comment.
- **Below 80% or above 97%** is a discrepancy worth investigating — investigated by reading the G7
  diagnostics and the §6 predictions, and reported honestly whether or not it resolves.
- It is **not** grounds for changing the objective. Tuning a frozen baseline to hit a foreign
  engine's published figure is precisely what SRS FR-DATA-1..5 forbids.

**Why a mismatch is expected rather than alarming.** TAG is a different engine: base + Corporate Era
only (no Prelude, which *is* in this project's scope), a few cards unimplemented, acknowledged rule
simplifications, and its own OSLA heuristic which is not this one. The comparison is a smell test on
the direction and rough magnitude of the gap, nothing more.

---

## 5. Findings worth not rediscovering

### 5.1 Hazard H7's two-way fork check does not certify a fork

**This is the most important engineering finding of the bullet**, and it invalidates a claim carried
since Milestone 1.

Bullet 4 established that `pendingSignature` and `stableStateOf` fail independently, so a fork must
be validated by both. Units A and C were built on that. Unit B's first 2-game smoke run then produced
29 "Engine rejections" — every one an `or` whose branch response did not match the branch, some with
`Invalid index`, an index the candidate enumerator cannot generate for the decision it was looking
at. The forks had passed **both** checks and were sitting on a *regenerated top-of-turn `OrOptions`*
in place of the live mid-action one.

Both checks are blind to that substitution by construction:

- `pendingSignature` is only `` `${player.id}:${type}` ``, so a mid-action `OrOptions` and the
  top-of-turn "take your next action" `OrOptions` are **the same string**.
- The pending decision is **not serialized at all** (`Game.serialize()` hardcodes
  `deferredActions: []`), so `stableStateOf` is **byte-identical** across the substitution.

This is bullet 4's "action-phase failures are 100% silent" population seen from a new angle: it is
silent to the *validation* too.

**`bench/forkCost.ts`'s "26,026 forks, 100% exact reproduction" carries the same blind spot.** That
result is sound for the question it asked — what does a fork cost, and does the state come back — and
is not a sound basis for certifying a fork that an agent will *answer a decision in*. An agent
forking to try a move needs the strictly stronger property that it landed on the same decision.

The fix is a third, strictly finer check (`search/pendingModel.ts`), comparing
`waitingFor.toModel(player)` on both sides, applied to **both** uses of a restore: adopting an
ancestor and certifying a fork. Gating ancestor *adoption* is the load-bearing half — an ancestor
whose restore lands on a regenerated decision silently poisons every replay descended from it.

**Consequence for anyone quoting the old number:** §2.4's ~72% forkability was measured under the
weaker definition and is an overstatement for an agent that forks to try a move. The honest figure is
in §3's G3 adjudication.

### 5.2 The AC-1 legality battery costs far more against a forking agent, and it will get worse

The G4 run — 1,000 games, greedy in both seats, `--legality` — took **13,827 s (3 h 50 m)** against
the 2p greedy-vs-random run's **1,093 s (18 m)** for the same game count: a **12.6× ratio**. Both
numbers come from a host that was swapping throughout (and macOS resized the swap file mid-run, from
6,144 MB to 3,072 MB), so treat 12.6× as an observation of an order of magnitude, not a clean
measurement. The reason it is large at all is structural rather than incidental.

`SubmissionMonitor` observes by wrapping `Player.prototype.process`. The §3.2 guard makes speculative
submissions *uncounted*, but it cannot make them *unwrapped*: every candidate submitted into a fork
and every replay step still enters the wrapper, does a `getWaitingFor()` lookup and a guard check,
and returns. In the G4 run itself the monitor recorded **226,840 real submissions** while the fork
service made **1,671,895 fork attempts and 1,055,362 replay submissions**, on top of roughly 1.7
million candidate submissions — so the wrapper was entered on the order of **fifteen times per real
submission**, and every one of those entries is work done solely to be discarded by the guard.

**This scales with search effort, so M4 is where it bites.** A one-ply agent forks ~7 times per
decision; an ISMCTS agent at the M4 target of ≥ 1,000 simulations per decision is three orders of
magnitude past that. Re-running the AC-1 battery against an M4 or M6 agent at 1,000-game scale on
this instrument should be budgeted deliberately, and if it becomes prohibitive the fix is to make the
guard short-circuit *before* the wrapper body rather than inside it — not to reduce the sample, which
is the one thing M1 proved cannot be done safely (the `initialCards` defect appeared at ~1 per 25
games and was invisible to a 20-game batch).

### 5.3 The drain boundary is `!==`, not `>`

§3.4's condition 3 stops the drain when the move being evaluated has completed, detected in
`Phase.ACTION` by `player.actionsTakenThisRound` (`src/server/Player.ts:125`), which is incremented
in `takeAction` (`Player.ts:1550`) immediately before the "Take your first/next action" input is
built (`Player.ts:1556`).

The comparison is `!==` rather than `>` because the counter is **also reset to 0** when the player's
turn ends (`Player.ts:1495`). A strict `>` reads that reset as "not yet advanced" and keeps draining.
Condition 2 catches it a step later in practice, but the asymmetry is the point: stopping early costs
a slightly under-resolved position for one candidate, while stopping late scores a **different
move**.

---

## 6. The Appendix predictions, checked

The plan's Appendix recorded seven falsifiable predictions **before measurement**, so the plan's own
understanding could be tested and not just the code's. Per-decision-type behaviour, from the 2p run:

| Decision type | Decisions | Scored | Tie-broken | Single candidate | Fallbacks |
| --- | --- | --- | --- | --- | --- |
| `or` (the action menu) | 87,509 | 80,400 | **68.3%** | 7,025 | 84 |
| `space` | 21,240 | 20,595 | **85.9%** | 214 | 431 |
| `card` (research buys) | 19,042 | 16,921 | **99.8%** | 1,113 | 1,008 |
| `payment` | 1,329 | 0 | — | **1,329** | 0 |
| `initialCards` | 1,000 | 0 | — | 0 | **1,000** |
| `amount` | 191 | 113 | 93.8% | 78 | 0 |
| `projectCard` | 106 | 4 | 25.0% | 15 | 87 |
| `player` | 58 | 36 | 69.4% | 22 | 0 |

**1. The tie-break fraction is high. CONFIRMED** — 75.9% overall, with a median score spread of 0 VP.

**2. The opening and research buys are entirely tie-broken. CONFIRMED, and by two different
mechanisms.** `card` decisions — the research-phase buys — are **99.8%** tie-broken, which is the
prediction almost exactly. But `initialCards` is not tie-broken at all: **all 1,000 of them (one per
game) fall back to random-legal**, because game setup has no forkable ancestor and the agent never
gets to score anything. The prediction was right about the outcome and wrong about the route.

**3. Prelude selection is not tie-broken where a prelude grants immediate TR. NOT MEASURABLE as
stated.** Preludes are resolved inside `or`/`card` decisions rather than a distinct type, and the
per-type counters cannot isolate them. §3.3 of the plan justified moving up the save-history
mechanism partly on this prediction, so it is worth being blunt: **the prelude claim is unverified**,
and the honest reading of the fork data is that replay's value showed up in the 33% of *mid-game*
points that are not directly forkable, not in the opening — which remains unforkable regardless.

**A note on `payment`:** every one of its 1,329 decisions had exactly one candidate. That is §3.5's
canonical-cheapest reduction working as designed, and it means the agent makes **no payment choices
at all** — a real limitation of the baseline, and one M3 will need to lift.

Predictions 4–7 are about outcomes, and were checked on their own 200-game sample (2p, its own seed
range, so a prediction is not confirmed by the games that produced the win rate it explains):

| Per game, per agent | `greedy-1ply@1` | `random-legal@1` | Ratio |
| --- | --- | --- | --- |
| Milestones claimed | **2.215** | 0.585 | 3.8× |
| Awards funded | **2.380** | 0.620 | 3.8× |
| Greenery VP | **15.750** | 6.170 | 2.6× |
| City-adjacency VP | **14.220** | 5.875 | 2.4× |
| Card VP | **5.080** | 3.085 | 1.6× |
| Terraform rating | **48.795** | 37.270 | 1.3× |
| Total VP | **106.095** | 60.750 | 1.7× |
| **Games with any card VP** | **95.5%** | 88.0% | — |

**4. Greedy claims milestones markedly more often. CONFIRMED** — 2.215 per game against 0.585, of a
maximum of three. Milestones are +5 VP the instant they are claimed, which is exactly what a
points-now objective sees.

**5. Greedy funds awards it leads, and rarely others. CONFIRMED on the rate** — 2.380 per game
against 0.620. The "it leads" half is *not* separately verified: the record shows which seat funded
an award, not whether that seat was ahead on it at the time.

**6. Greedy's greeneries cluster adjacent to its own cities. NOT CONFIRMED.** Greedy earns 2.6× the
greenery VP and 2.4× the city-adjacency VP, but the *ratio* of city-adjacency VP to greenery VP is
**0.90 for greedy against 0.95 for random** — slightly lower, not higher. Greedy does much more of
both, which is not the same claim. The prediction as written is unsupported by this proxy, and the
proxy is weak anyway (city-adjacency VP counts cities next to *any* greenery, including opponents').
Testing it properly needs board geometry the match record does not carry.

**7. Project-card play is not suppressed. CONFIRMED, and this is the important one.** Greedy scores
card VP in **95.5% of games** (random-legal: 88.0%). This is the direct falsifier for the megacredit
tiebreak: had that term survived into the objective, spending would have been strictly penalized,
greedy would have bought nothing at initial selection or research, and this figure would have been
**0%**. It is the measurement that confirms the agent implements the objective §2 describes.

---

## 7. Known limitations

1. **Four in-scope decision types were never reached** by G1a's 200-game corpus: `and`,
   `productionToLose`, `resource`, `resources`. Their candidate enumerators exist and are unit-tested,
   but they have **no evidence at corpus scale**, and G1c's requirement was only that they be named.
   Any of them could carry a candidate-legality defect that 843,871 submissions did not touch. They
   are the first thing to check if a future agent hits an illegal move.
2. **The opening is effectively random, as predicted, and replay did not change that.** Corporation
   choice, initial card purchases and research buys are VP-neutral, so greedy tie-breaks through all
   of them. §3.3 of the plan predicted this and warned against claiming otherwise; the measurement
   confirms it (§6, predictions 1–2). What ancestor replay bought was **preludes** and the 33% of
   mid-game points that are not directly forkable — not the opening, which has no forkable ancestor
   at all until the first action phase.
3. **Wall-clock figures from this host are not measurements.** The machine was swapping throughout
   (4.5–4.7 GB of 6.14 GB in use, ~55 MB free, 8 GB total), which `agent/CLAUDE.md` §6 records as
   having produced a 4.3× swing on an identical specification within one session. The elapsed times
   in the artifact are recorded with `loadAverage`, `freeMemoryBytes` and `vm.swapusage` beside them
   so a later reader can tell they were taken on a loaded host. **No throughput claim is made in this
   document**, and none should be read out of it.
4. **§2.4's ~72% forkability figure is withdrawn**, not adjusted — it was measured under the two-way
   definition §5.1 shows to be insufficient. The replacement figures are in G3, and they are not
   comparable to it.
5. **The tie-break fraction is 75.9%, and that is a property of the objective, not a defect.** But it
   does mean the phrase "greedy one-ply agent" oversells what happens at three quarters of its
   decisions. Anyone quoting AC-3's "≥ 80% vs greedy one-ply" should know the yardstick is a mostly
   random player with a strong preference at the moments that score.
6. **The prior-art comparison remains a smell test.** Only one of the three published numbers is
   adjudicable here at all, and the engines differ in scope, card set and rules. The 99.2% is
   reported against ~91% as a direction-and-magnitude check, and §5's hypotheses for the gap are
   untested.

---

## 8. Where this leaves Milestone 2

**Bullet 2 is complete.** Both fixed baselines now exist, are versioned, are frozen, and are seatable
by name in the match runner: `random-legal@1` and `greedy-1ply@1`. AC-3's two yardsticks are in place
and reproducible, which is what this bullet owed Milestone 3.

Still open in Milestone 2: **bullet 3** (the rating pipeline, FR-14), **bullet 4** (the
expert-distribution report, FR-DATA-1), and **bullet 5** (the regression seed set). Nothing in this
bullet blocks them; bullet 3 in particular can now compute ratings over two genuinely different
agents rather than one agent against itself.

**What M3 inherits, and the one discipline that matters.** `greedy-1ply@1` is the AC-3 denominator.
Its registry entry says so, and says that *any* change to its move distribution — a reduction in
`core/candidates/`, the drain boundary, the 64-cap, the 32-step budget, or anything altering which
decisions are forkable — is a **new version**, not an improvement to this one. A yardstick that moves
between the measurement that set the bar and the measurement that clears it is not a yardstick.

**And the standing AC-1 caveat now has two entries, not one.** `agent/CLAUDE.md` §6 requires the
legality battery to be re-run against every promoted agent version. It has been run against
`random-legal@1` (Milestone 1) and now against `greedy-1ply@1` (G4). It has **not** been run against
anything M3 will produce, and the M3 heuristic will reach candidate-move paths this agent never did —
including, for the first time, decisions where the argmax is not a tie.
