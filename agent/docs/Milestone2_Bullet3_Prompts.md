# Milestone 2, bullet 3 — unit prompts (the rating pipeline)

**The bullet.** *"Build the rating pipeline: win rate, average VP margin, and Elo/TrueSkill with
confidence intervals."* It discharges **SRS FR-14** and supplies the significance machinery
**FR-15/AC-7** names but does not itself define. It is the last piece of the Milestone 2 exit
criterion's first half — *"the harness reports statistically sound win rates and ratings for any two
agents"*.

**What makes this bullet different from the two before it.** Bullets 1 and 2 built things that
either work or crash. This one builds a thing that *always produces a number*, and the failure mode
is a number that is wrong in a direction nobody can see. Every previous bullet could be adjudicated
by running games and counting; there is no game you can run to find out whether a confidence interval
is a 95% interval. So the central design decision of this bullet is not which estimator to use — it
is that **every interval and every test is validated by a coverage simulation against known ground
truth**, and that a miscovering interval is a blocking failure rather than a tolerance to widen.

**Read `agent/CLAUDE.md` §6 and §9 first.** Then read
[Milestone2_Bullet1_Prompts.md](Milestone2_Bullet1_Prompts.md) §4.1 and §4.3 (the pairing-group
design and the record schema — this bullet is that schema's first named consumer) and
[Match_Runner.md](Match_Runner.md) §2 and §5.

---

## 1. Scope — what this bullet is, and what it is not

**In scope.**

- A **statistics core** over match artifacts: win rate, placement rate, average VP margin, each with
  a confidence interval that respects the pairing-group design (§3.1).
- A **rating** on the Elo scale, fitted by maximum a-posteriori Bradley–Terry over a pool of agent
  versions, with its multiplayer generalization for 3–4p placements, and intervals (§3.3).
- **Hypothesis tests** for the thresholds the acceptance criteria are stated on: AC-2 (≥65% vs the
  project heuristic), AC-3 (≥90% vs random, ≥80% vs greedy), AC-5 (first place above 1/N), and
  **AC-7's promotion gate** (this version beats the previous one with significance).
- A **power / sample-size calculator**, because from Milestone 4 onward the gate's sample size is a
  multi-day compute decision and must be derived, not guessed (§2.5).
- A **ladder**: a committed, append-only record of which versions have been compared, on which seed
  blocks, with what result — so AC-7's chain is one auditable table rather than a folder of runs.
- A **calibration study** that measures the coverage of every interval and the size and power of
  every test against a generator with known ground truth, plus the two methodology hazards M3 is
  about to walk into (optional stopping and seed reuse), demonstrated rather than asserted.
- One deliverable document, `agent/docs/Rating_Pipeline.md`, and the artifacts behind it.

**Not in scope.**

- **No new agent, and no tuning of an existing one.** Both baselines are frozen (`agent/CLAUDE.md`
  §6). This bullet measures; it does not improve anything.
- **No expert-dataset comparison** — that is bullet 4 (FR-DATA-1, AC-8). No card or corporation
  win-rate tables here.
- **No regression seed set** — bullet 5. But this bullet **allocates the seed blocks** bullet 5 will
  freeze (§3.8), because that allocation is free now and impossible to retrofit.
- **No TrueSkill.** §3.3 records the reason and the SRS annotation this requires.
- **No AC-1 re-run.** The corpus this bullet generates seats `random-legal@1` and `greedy-1ply@1`,
  both of which already hold AC-1. Nothing new is seated, so the standing caveat does not fire.
- **No throughput claim.** This host cannot produce one (hazard H10 of bullet 1, restated in
  `agent/CLAUDE.md` §6). The corpus generation is compute this bullet *spends*, not compute it
  *measures*.

---

## 2. What is already known — do not re-derive any of this

### 2.1 The input schema was designed for this bullet, and it is sufficient

`agent/src/match/types.ts` names bullet 3 as its first consumer and lists what it reads: per-seat
`placement`, `isWinner`, `marginToNext`, and agent identity per seat. Two corrections to that list,
both from reading the schema against the statistics that are actually needed:

- **`marginToNext` is not the margin you want.** It is the gap to the head of the *next placement
  group*, so it is `undefined` for the last placement and is **0 whenever the placement was decided
  on megacredits** — honest, and documented as such in `ranking.ts`, but it means the field has a
  point mass at 0 that has nothing to do with how close the game was. The signed margin
  (`own VP − best other seat's VP`) is recoverable exactly from `seats[].outcome.victoryPoints`,
  which every row carries. **Compute the margin from `victoryPoints`; use `marginToNext` only as a
  cross-check.**
- **Everything else needed is present.** `MatchRunHeader` carries the run id, resolved spec (lineup
  with versions, groups, `startGroup`, `permutationsPerGroup`), the pairing description with the seed
  schedule constants, `harnessVersion`, `incompleteGroupPolicy`, and a `provenance` block with
  `engineCommit`, `nodeVersion`, `seedDerivationVersion` and `env`. `MatchGameRecord` carries
  `groupIndex`, `permutationIndex`, `engineSeed`, `seating`, `completed`, `failure`, `generation` and
  the per-seat outcomes. **Nothing has to be added to the runner and no games have to be replayed.**

`agent/src/match/artifact.ts` provides `loadMatchArtifact`. `agent/src/match/runner.ts` provides
`wilson95` and `summarizeMatch`, and `agent/src/legality/run.ts` provides `percentiles`.

### 2.2 Three artifacts are already committed, and they contain per-game rows

| Artifact | Contents |
| --- | --- |
| `docs/data/match_runner_validation.json` → `main.runs[]` | Three full `MatchRunReport`s with per-game rows: 2p `random-legal@1` self-play, 500 groups / 1,000 games; 3p, 100 groups / 600 games; 4p, 25 groups / 100 games |
| `docs/data/baselines_validation.json` → `main.runs[]` | **Summaries only, no per-game rows** for `greedy-1ply@1` vs `random-legal@1`. The 99.2% headline cannot be re-analysed from what is committed |
| `docs/data/ac1_legality_run.json` | Milestone 1's legality run; not a match artifact, not an input here |

So there is real per-game data for the self-play case and **none for the only genuinely two-agent
comparison in the project**. Unit A generates and commits that corpus (§2.5).

### 2.3 Measurements taken during planning — reproduce these, do not re-discover them

Computed from `match_runner_validation.json` with a throwaway script while writing this plan. They
are pre-registered here so that Unit A reproducing them is a *check*, and Unit A disagreeing with
them is a *finding*.

**Games within a pairing group are correlated, and the effect grows with player count.** Treating
the group mean as the unit and comparing its variance to the binomial expectation `p(1−p)/m`:

| | groups | m | slot-0 win rate | design effect (win) | ICC | design effect (VP margin) |
| --- | --- | --- | --- | --- | --- | --- |
| 2p | 500 | 2 | 0.5160 | **1.033** | 0.033 | **1.043** |
| 3p | 100 | 6 | 0.3433 | **1.252** | 0.050 | **1.516** |
| 4p | 25 | 4 | 0.3300 | **1.293** | 0.098 | **1.184** |

Read this as: at 2p the runner's game-level Wilson interval is about 1.6% too narrow — negligible.
At 3p it is about 12% too narrow on the win rate and **23% too narrow on the margin**, which is
exactly where AC-5 lives. The correction is small but real, it goes the anti-conservative way, and it
is larger where the criteria are weakest. Two caveats: these are `random-legal` self-play, the
*weakest possible* instrument for a seed effect (`Match_Runner.md` R1b makes the same point about
seat advantage), and a directed agent should show a larger ICC because which cards the seed deals
starts to matter. **Predict a larger design effect on the greedy-vs-random corpus** (Appendix).

**The cluster correction changes intervals, never point estimates.** Over balanced groups every group
has the same size, so the mean of the group means is exactly the game-level proportion. Every win
rate published in `Match_Runner.md` and `Baselines.md` stands as a point estimate; only the intervals
are restated.

**Full ties do not occur, and near-ties do.** Over all 1,700 committed games: **0 shared wins** (no
two seats tied on VP *and* megacredits). VP ties broken by megacredits: 16/1,000 at 2p (1.6%),
17/600 at 3p (2.8%), 3/100 at 4p (3.0%). So the draw convention is nearly free to choose and
**completely untested by data** — carry it, and say it is untested (H4).

**The margin's scale.** At 2p, slot 0's mean signed margin is **+0.878 VP** with a per-game standard
deviation of **26.2 VP**. At 3p and 4p the mean margin against the *best other seat* is −6.8 and −6.7
VP, because the maximum of N−1 opponents is usually above you. **A mean margin is not comparable
across player counts** and must be reported with the conditional forms (§3.2).

### 2.4 The published two-agent numbers, and what an Elo of them looks like

From `Baselines.md` G5: `greedy-1ply@1` beats `random-legal@1` **992/1,000** at 2p, Wilson
[98.43%, 99.59%], `bySeat` 49.8%/50.2%, 0 shared wins. Mapping the point estimate and the Wilson
bounds through the Elo scale (`−400·log₁₀(1/p − 1)`) gives **+837 Elo, [719, 956]**. Pre-registered so
that Unit B's fitted figure has something to be compared against; the fitted interval will be wider
(cluster correction plus the prior).

Note what that means for the pool: with two agents the Elo *is* the win rate, monotonically
transformed. §3.4 says what to do about that.

### 2.5 Cost, for planning the runs

Measured, from the committed artifacts' own `timing` blocks (both on the 8 GB host that swaps —
order-of-magnitude only):

- 2p `random-legal` self-play, 1,000 games: **176 s** (mean 113 ms/game).
- 2p `greedy-1ply` vs `random-legal`, 1,000 games: **1,093 s** (mean 1,093 ms/game), 237 decisions
  per game.

So Unit A's corpus is roughly: 2p greedy-vs-random 500 groups ≈ **18 min**; 3p mixed lineup 100
groups (600 games) ≈ **30 min** at an assumed 1.5–2× the 2p per-game cost; 4p 25 groups ≈ **5 min**.
Call it **one hour** of compiled-build compute, single process. That is the entire compute budget of
this bullet apart from the calibration study, which is pure arithmetic and costs minutes.

**The number that matters for later milestones is not this one.** It is the sample size the gate
needs. One-sided α = 0.05, 80% power, null 50%, at the measured 2p design effect of 1.03:

| True win rate to detect | games | pairing groups (2p) |
| --- | --- | --- |
| 65% | 69 | 35 |
| 60% | 157 | 79 |
| 55% | 635 | 318 |
| 53% | 1,767 | 884 |
| 52% | 3,978 | 1,989 |

and inverted — the minimum detectable win rate above 50% at 80% power:

| games | 200 | 500 | 1,000 | 2,000 | 6,000 |
| --- | --- | --- | --- | --- | --- |
| detectable | 58.9% | 55.6% | **54.0%** | 52.8% | 51.6% |

**1,000 games — the sample every Milestone 2 claim so far has used — resolves a 4 pp edge and
nothing finer.** At Milestone 4, a game at the exit-criterion search budget is on the order of
230 decisions × ~1 s, so ~230 s; the 1,767 games needed to certify a 53% improvement is ~4.7 days
single-core, and the ×8 core-scaling that would make it 14 hours is the multiplier bullet 1 could
**not** verify (R7, still untested). Add the AC-1 battery's 12.6×-and-worse multiplier on top for the
promotion gate's legality half. **This is why the power calculator is in scope**: from M4 onward the
choice of N is a multi-day commitment and the honest options are "budget it" or "state a wider
minimum detectable effect", not "run 1,000 games because that is what we ran last time".

### 2.6 Randomness: there are two seeds and this bullet needs a third, without adding one to `rng.ts`

`agent/CLAUDE.md` §6 is explicit: *"The M4 seed contract is settled … do not add a third seed to
`rng.ts` now."* A bootstrap needs a reproducible random stream, and it is neither an Engine seed nor
an Agent seed — it touches no game and influences no move. Resolution: `rating/` takes an
**`analysisSeed`**, constructs its stream with the existing `createAgentRandom(analysisSeed)`, keeps
it entirely inside `rating/`, and records it in every report. `rng.ts` is not modified. Note the
Milestone-1 gotcha this avoids by using the wrapper: the Engine's `new SeededRandom(integerSeed)` is
degenerate — every integer seed emits the identical stream (Running Notes, 2026-07-22).

---

## 3. Design decisions settled here — implement these, do not re-litigate them

### 3.1 The unit of analysis is the pairing group, not the game

Every interval and every test in this pipeline clusters on `(runId, groupIndex)`. Games in a group
share an Engine seed — the same board, the same shuffles, the same deal — so they are not independent
draws, and §2.3 measures the size of that.

- **Point estimates** are the ordinary pooled ones (unchanged — §2.3).
- **Primary interval for a proportion:** Wilson on an **effective sample size** `n/deff`, with `deff`
  estimated from the between-group variance of the group means. Wilson rather than a group-mean
  Wald/t interval because at 99.2% the latter runs off the end of [0, 1], which is precisely the
  regime this project's baselines live in.
- **Cross-check interval:** a **cluster bootstrap** resampling whole groups with replacement
  (percentile method), seeded from `analysisSeed`. Required to agree with the primary within a
  pre-committed tolerance on real data (criterion P4b) — two methods that disagree mean one is wrong,
  and finding that out on real corpora is cheap.
- **Continuous quantities** (VP margin, generations, TR) use the group-mean t interval plus the same
  bootstrap cross-check.
- **Do not floor `deff` at 1 without evidence.** A blocked design legitimately produces `deff < 1`.
  But a `deff` estimated below 1 from noise narrows the interval anti-conservatively, so the
  calibration study must check coverage at ICC = 0 (criterion P2); if it under-covers, floor at 1 and
  record that as a measured decision rather than a precaution.
- **Balanced groups only**, matching the runner's own `incompleteGroupPolicy`. A partial group is a
  group in which some identity did not sit in every seat. Count and report the exclusions.

### 3.2 Scores and margins: state the convention, report both forms

**Score.** Per seat per game: win = 1, shared win = 1/(number of tied winners), otherwise 0. At 2p a
shared win is 0.5, which is the Bradley–Terry convention. Because zero shared wins have ever been
observed (§2.3) this convention is **untested by data** and the write-up must say so.

**Win rate.** Report two numbers side by side, always:
- `winRate` — the fraction of games in which the identity was among the winners. This is the runner's
  definition and the one AC-2/AC-3/AC-5 are written in. Shared wins count as wins.
- `scoreRate` — the mean score above. Never above `winRate`.

**AC thresholds are adjudicated on `winRate`**, because that is the literal text of the criteria, and
`scoreRate` is reported beside it so a tie-inflated figure cannot hide. The two differ only if ties
appear, at which point the difference is itself the finding.

**Margin.** `margin = own VP − best other seat's VP`. Report three forms:
- unconditional mean (with its interval) — the FR-14 headline, and **flagged as not comparable across
  player counts** (§2.3);
- mean **margin of victory**, conditional on winning;
- mean **margin of defeat**, conditional on losing;
plus the distribution (min/p5/p50/p95/max), because a mean margin over a 26-VP standard deviation is
a nearly contentless statistic on its own.

**The margin is never a gate.** It is not a monotone function of win probability — a change that
gains 20 VP in games already won moves the margin and not the win rate — so it is a diagnostic for
*how* games are won, and AC-7 is decided on the win rate. This is stated as a hazard (H8) because the
temptation to gate on the smoother statistic is real and the SRS's phrasing ("average VP margin")
does not warn against it.

### 3.3 What "Elo/TrueSkill" means here: Bradley–Terry MAP on the Elo scale, and no TrueSkill

FR-14 says "Elo/TrueSkill". The slash is a family, not two requirements. This bullet implements:

- **Pairwise: Bradley–Terry**, one latent strength per identity, fitted by **maximum a posteriori**
  with a weak zero-mean Gaussian prior on the strengths (σ pre-committed, reported, and its shrinkage
  reported alongside every rating). Presented on the Elo scale (`400/ln 10` per logit) with
  `random-legal@1` **anchored at 0**.
- **Multiplayer: Plackett–Luce** over the recorded placements, the same latent-strength parameter, so
  a 3p result and a 2p result speak the same language *within* a player count (but see §3.5).
- **Intervals** from the cluster bootstrap of §3.1 — refit the model on each resample. Not from the
  Hessian: the near-separated regime this pool actually occupies is where the asymptotic normal
  approximation is worst.

**Not implemented: online Elo with a K-factor.** It is order-dependent, so a re-analysis of the same
artifacts in a different order gives a different answer — which breaks the reproducibility this whole
harness exists to provide — and it produces no interval. The K-factor Elo's advantage is tracking a
player whose strength drifts; an agent version is frozen by definition (`registry.ts`: bump the
version whenever the move distribution can change).

**Not implemented: TrueSkill.** Its value is online updating over a large, continuously changing
ladder with partial information; this project has a handful of frozen versions and complete match
records, and re-fitting a MAP model over everything takes milliseconds. Worse, TrueSkill's σ is the
width of an approximate-message-passing posterior, and treating it as a confidence interval is
exactly the kind of unvalidated claim this bullet exists to prevent — whereas a bootstrap interval
around a MAP fit can be, and is, coverage-tested (P5). If a later milestone needs online updates over
a large pool, TrueSkill goes behind the same interface. **Unit D annotates FR-14 in the SRS to record
that the requirement is discharged by the Bradley–Terry/Plackett–Luce family and why**, rather than
leaving a reader to assume TrueSkill exists somewhere.

**Separation must be handled, not discovered.** `greedy-1ply@1` already wins 99.2%; the first M3
agent may well win 1,000/1,000, at which point the unregularized MLE diverges. The prior makes the
fit finite; the *interval* must still tell the truth, so a separated pair reports a **one-sided
bound** ("≥ X Elo above") and never a finite upper bound presented as if estimated. A silent
`Infinity`, a `NaN`, or a large finite number with a symmetric interval are all failures (P5).

### 3.4 The rating is a summary; the gate is a win rate

AC-2, AC-3, AC-5 and AC-7 are every one of them stated as a rate with a threshold. **Not one
acceptance criterion in the SRS is stated as an Elo.** So the promotion gate is a one-sided test on
the head-to-head win rate against the incumbent, clustered per §3.1 — the rating never enters it.

This is a deliberate constraint, not an omission. A pool rating is a *derived, model-dependent*
quantity: it borrows strength across the whole comparison graph, so a new agent's rating can move
because some other pair was played. That property is useful for ranking a ladder and disqualifying
for a gate. The write-up must state plainly that with two agents the Elo is a monotone transform of
the win rate and carries no additional information (§2.4) — the rating earns its keep only as the
pool grows.

**Corollary, for the ladder to keep meaning anything:** the comparison graph must stay **connected**,
and each new version must be played against **its immediate predecessor** — which AC-7 requires
anyway. Report each rating twice: relative to the `random-legal@1` anchor, and relative to the
immediate predecessor. The anchor-relative figure loses resolution as soon as everything beats random
100% of the time; the predecessor-relative figure is where the information is, and the chain's
uncertainty accumulates along it.

### 3.5 One rating scale per player count

Do not pool 2p, 3p and 4p games into a single latent strength. An agent strong at 2p can be weak at
3p (different tempo, different milestone race, different kingmaking), so a pooled rating averages two
quantities the project cares about separately — 2p is the primary evaluation setting, 3–4p is a
distinct competence target (`agent/CLAUDE.md` §1). The ladder carries `rating[players][identity]`. A
pooled figure may be *reported* as a convenience, explicitly flagged as assuming strength transfers.

### 3.6 Pooling artifacts: refuse to double count, refuse to mix pins

The pipeline takes a list of artifacts and pools them. Two ways that silently produces a wrong
number, both of which must be **rejected with an error naming the offending artifacts**:

- **Double counting.** `--start-group` exists so a later run can extend an earlier one. Two artifacts
  with the same `(players, lineup)` and overlapping group ranges are either a re-run or an overlap,
  and pooling them counts the same games twice. Detect on `(players, engineSeed, seating)`
  collisions, not on run ids — a re-run with a different `--run-id` is the case that matters.
- **Mixing provenance.** `provenance.engineCommit`, `harnessVersion` and `provenance.seedDerivationVersion`
  must be identical across every pooled artifact. A pre-fix and a post-fix artifact pooled together
  is the Milestone-1 `initialCards` lesson repeating as a statistic.

Two further rules:
- **Aggregate by identity, not by slot.** `bySlot` is a lineup-slot statistic; two slots can hold the
  same `name@version` (every self-play run, and the 3p mixed lineup this bullet generates). All
  aggregation keys on `name@version`.
- **A self-match contributes nothing to a rating fit.** `random-legal@1` vs `random-legal@1` is
  50/50 by symmetry and carries no information about relative strength; include it in seat-effect
  estimation, exclude it from the Bradley–Terry likelihood, and say how many games were excluded.

Every report records the **SHA-256 of each input artifact file** and the identities, seed blocks and
game counts that fed it, so any rating claim can be traced back to the exact bytes it came from.

### 3.7 The report is reproducible, and that includes the bootstrap

Same inputs plus same `analysisSeed` ⇒ byte-identical report, modulo a declared timing-field list,
exactly as `match/artifact.ts` does it for the runner (`MATCH_TIMING_FIELDS` / `stripTimingFields`).
Reuse that pattern; do not invent a second one. `analysisSeed` defaults to a constant recorded in the
report, never to a clock or `Math.random`.

### 3.8 Seed-block discipline — decided now because it cannot be retrofitted

Milestone 3 tunes evaluation weights *against harness win rate* (Implementation Plan, M3). If the
seeds used to tune are the seeds used to certify, the certification measures the tuning. This is the
single largest methodological risk in the milestones ahead of us, it costs nothing to prevent today,
and it is unfixable after the fact. So this bullet allocates group-index blocks and the ladder
records the allocation:

| Block | Group indices | Use |
| --- | --- | --- |
| **D — development** | 0 – 1,999 | Tuning, debugging, smoke runs, anything iterated on. Every published Milestone 2 run so far lives here (bullets 1 and 2 used 0–499). |
| **G — gate** | 2,000 – 5,999 | Promotion gates only. **Each gate is allocated a fresh, disjoint sub-range, recorded in the ladder before the run.** A gate re-run on its own sub-range after a change is not a gate. |
| **R — regression** | 6,000 – 6,999 | Reserved for bullet 5's fixed reference games. Never used for a strength estimate. |

Unit A implements the allocation as a checked function (`--block gate` refuses a range that the
ladder already records as spent) and Unit D records it in the SRS/Plan, because a convention that
lives only in a plan document is a convention that expires with the session that wrote it.

### 3.9 Validation is by coverage simulation, and the generator must not share the estimator's assumptions

A statistics module cannot be validated by running it on real data and looking at the output. The
method is: generate synthetic match artifacts from **known** parameters, run the pipeline, and check
that the 95% intervals contain the truth about 95% of the time and that each test rejects at its
nominal rate under H0. Pre-committed tolerance bands come from the replication count, not from taste
(P2).

The trap in self-validation: if the generator draws data the same way the estimator assumes it was
drawn, coverage is guaranteed by construction and the study proves nothing. Three mitigations, all
required:

- **An analytic anchor.** At ICC = 0 the correct answer is known in closed form (Clopper–Pearson /
  exact binomial). Coverage there is a check against mathematics, not against the generator.
- **Two different cluster mechanisms.** A beta-binomial group effect *and* a "shared latent seed
  difficulty" mechanism (a per-group offset applied to both seats' strengths, which is what a shared
  deal physically is). Coverage must hold under both.
- **A real-data agreement check.** The primary interval and the bootstrap interval must agree on the
  committed corpora (P4b). Two estimators built from the same wrong assumption can both miscover;
  two estimators disagreeing is unambiguous.

---

## 4. Hazards already located — hand these to the units, don't rediscover them

| | Hazard | Where it bites | Mitigation |
| --- | --- | --- | --- |
| **H1** | **Within-group correlation.** Games in a pairing group share the Engine seed. Measured design effect 1.03 / 1.25 / 1.29 at 2p / 3p / 4p, and 1.04 / 1.52 / 1.18 for the VP margin (§2.3). | Every interval and every test. The runner's own `winRateCi95` is game-level and therefore slightly too narrow. | §3.1: cluster on `(runId, groupIndex)`, effective-n Wilson + cluster bootstrap. |
| **H2** | **Duplicate identities in a lineup.** Every self-play run, and this bullet's 3p mixed lineup, puts one `name@version` in two slots. `bySlot` is not a per-identity statistic; and an identity holding 2 of 3 seats has a **2/3** null first-place rate, not 1/3. | Identity aggregation; AC-5's null; the Bradley–Terry likelihood. | §3.6: aggregate by identity; state the null as *seats held / players*; exclude self-matches from the fit. |
| **H3** | **Separation.** 99.2% today, plausibly 100% at M3. The unregularized Bradley–Terry MLE diverges; a naive implementation returns `Infinity`, `NaN`, or a large finite number with a symmetric interval. | The rating fit and its interval. | §3.3: MAP with a reported prior; one-sided bound on separation; P5 tests it deliberately. |
| **H4** | **Ties are unobserved, not absent.** 0 shared wins in 1,700 games; 1.6–3.0% of games are VP ties broken on megacredits, where `marginToNext` is 0 while a winner exists. | The draw convention; any margin statistic built on `marginToNext`. | §3.2: compute margins from `victoryPoints`; carry the 0.5 convention and state that data has never exercised it. |
| **H5** | **Pooling double-counts.** `--start-group` overlap, or the same spec re-run under a new `--run-id`. | Every pooled statistic, silently and in the precise direction of overconfidence. | §3.6: collision detection on `(players, engineSeed, seating)`. |
| **H6** | **Provenance mixing.** Pooling artifacts from different Engine pins, harness versions or seed-derivation versions. | Any multi-artifact analysis, and the ladder in particular, which accumulates over months. | §3.6: hard equality check, error naming the offenders. |
| **H7** | **Optional stopping and seed reuse.** Running until significance, or certifying on the seeds you tuned on. Both inflate the false-positive rate; neither leaves a trace in the output. | M3's weight tuning, then every gate after it. | §3.8's blocks; a pre-registered N recorded in the ladder *before* the run; P9 quantifies both effects so the write-up can argue from a number. |
| **H8** | **The margin is not a monotone effect measure.** A bigger mean margin does not imply a higher win probability. | Any temptation to gate on the smoother statistic when the win rate is inconclusive. | §3.2: margin is descriptive; the gate is the win rate. |
| **H9** | **`NaN` leaks.** `wilson95(0, 0)` returns `{low: NaN, high: NaN}` and `winRate` is `NaN` on zero games (`runner.ts:563`). A degenerate stratum — an identity with no completed games, a player count with no data — propagates `NaN` into a report and through `JSON.stringify` as `null`. | Any stratified report; especially 4p, where 25 groups is a thin sample. | Represent an unestimable quantity explicitly (absent, with a stated reason), never as `NaN`. Test it. |
| **H10** | **No throughput claim from this host.** It swaps (documented repeatedly in `agent/CLAUDE.md` §6). `tsx` also understates the simulator ~3.5×. | The corpus-generation run. | Compiled build for the corpus; record host swap state; **make no performance claim anywhere in the deliverable.** The one number that matters is the power table, which is arithmetic. |
| **H11** | **Bootstrap irreproducibility.** An unseeded resampler makes the gate's verdict unrepeatable; `new SeededRandom(integerSeed)` is degenerate (Running Notes, 2026-07-22). | The gate; P8. | §2.6: `createAgentRandom(analysisSeed)`, recorded in the report. Do not add a seed to `rng.ts`. |
| **H12** | **Self-validating simulation.** A generator that draws data exactly as the estimator assumes proves nothing. | The whole calibration study — the unit whose output everything else's credibility rests on. | §3.9's three mitigations: analytic anchor, two cluster mechanisms, real-data agreement. |

---

## 5. Pre-committed criteria — write these down before any number arrives

P1–P9 are what "bullet 3 is done" means. Committed **before** any estimator exists.

- **P1 — The observation model is faithful to the runner.** Re-deriving win counts, placement counts
  and games-counted from the observation layer reproduces `summary.bySlot` and `summary.bySeat`
  **exactly** (integer equality) on all three committed runs in `match_runner_validation.json` and on
  every run in this bullet's own corpus. A disagreement is a defect in one of the two and must be
  found and named, not tolerated. Additionally: identity aggregation is tested against a lineup with
  a duplicated identity (H2), and the balanced-group exclusion count matches
  `summary.balancedGroups`.
- **P2 — Every interval is calibrated.** Over **≥ 2,000 synthetic replications per scenario**, each
  95% interval's empirical coverage lies within **[94.0%, 96.0%]** — the ±1.96 Monte-Carlo band at
  n = 2,000, stated here so it cannot be widened later. Scenario grid: true rate
  p ∈ {0.50, 0.65, 0.90, 0.99}; ICC ∈ {0, 0.05, 0.20}; groups ∈ {50, 500}; cluster size m ∈ {2, 6};
  both cluster mechanisms of §3.9. Same standard for the VP-margin interval over a continuous
  generator. **Under-coverage anywhere is a blocking failure**, to be fixed in the estimator.
- **P3 — Every test's size and power are measured.** Under H0 each one-sided test rejects at ≤ 5%
  within Monte-Carlo error, at every ICC in the grid. Power is reported at the §2.5 effect sizes and
  agrees with the power calculator to within 2 pp. **And the negative control:** the *unclustered*
  test is shown to over-reject at ICC > 0, with the measured figure — a correction whose absence
  cannot be shown to matter has not been justified.
- **P4 — The real-data design effect, and two methods agreeing.**
  - **P4a:** design effect and ICC for win rate and VP margin, at 2p/3p/4p, on the committed
    self-play runs, reproducing §2.3's table (1.033 / 1.252 / 1.293 and 1.043 / 1.516 / 1.184) to
    three significant figures; and the same statistics on this bullet's greedy-vs-random corpus,
    where the value is unknown and predicted larger (Appendix).
  - **P4b:** on every real corpus, the effective-n Wilson interval and the cluster bootstrap interval
    agree to within **0.5 pp on both bounds**. A larger gap is a finding to investigate, not a
    footnote.
- **P5 — Ratings recover known strengths, and separation is handled.** On synthetic pools of ≥ 5
  identities with known latent strengths and a connected comparison graph: rank order recovered in
  ≥ 99% of replications at a pre-committed separation, interval coverage within P2's band, and the
  prior's shrinkage reported. A deliberately **separated** pair (one identity wins every game)
  produces a finite point estimate, a reported lower bound, and an **explicitly unbounded** upper
  bound — never `Infinity`, `NaN`, or a symmetric interval. Same for the Plackett–Luce fit over
  synthetic placements.
- **P6 — The baselines get a rating, with the honest caveat.** `greedy-1ply@1` vs `random-legal@1` at
  2p over ≥ 500 groups: point estimate and interval on the Elo scale, compared to §2.4's
  win-rate-derived **+837 [719, 956]**, plus the 3p/4p figures from the mixed-lineup corpus. The
  write-up states in plain words that a two-agent Elo is a monotone transform of the win rate and
  adds no information, and that the anchor-relative scale loses resolution once everything beats
  random.
- **P7 — Pooling refuses what it should refuse.** Demonstrated by test, each with an error message
  naming the offending artifacts: overlapping group ranges for the same `(players, lineup)`;
  mismatched `engineCommit`; mismatched `harnessVersion`; mismatched `seedDerivationVersion`. Plus: a
  self-lineup contributes zero games to the rating fit and the exclusion is reported; and a
  degenerate stratum yields an explicit "unestimable" rather than `NaN` (H9).
- **P8 — The gate is one command, pre-registered and reproducible.** `npm run rate -- gate` takes two
  identities and the artifacts, and returns a verdict naming: the test, the null, the pre-registered
  N and its seed block, the observed rate, the interval, the p-value, and pass/fail. Same inputs and
  same `analysisSeed` ⇒ byte-identical output modulo the declared timing fields. It **refuses** to
  run on a seed block the ladder records as already spent (§3.8), and refuses to report a verdict on
  a sample smaller than the pre-registered N.
- **P9 — The two methodology hazards are quantified, not asserted.** By simulation:
  - **Optional stopping:** testing after every 50 groups up to 1,000 games, under H0, inflates the
    one-sided 5% false-positive rate to a measured figure (predicted 15–30%).
  - **Seed reuse:** selecting the best of k = 8 noisy variants on a seed block and re-testing on the
    *same* block inflates the estimated win rate by a measured amount versus a fresh block
    (predicted 1.5–3 pp at 500 groups).
  Both figures, with their sample sizes, go in the write-up and into the Implementation Plan's risk
  register — this is the evidence M3's methodology will be argued from.

**Non-criteria, stated so they are not smuggled in.** This bullet does not implement TrueSkill, does
not implement online Elo, does not claim either baseline is strong, does not compare anything to the
expert dataset, does not tune any parameter, does not add or modify an agent, does not re-run AC-1,
and makes **no** throughput claim.

---

## 6. Structure — four units, and why this shape

`A → (B, C) → D`.

Applying `agent/CLAUDE.md` §9's own tests:

- **Is the "do this first" unit a real dependency or a shared denominator?** A real dependency, twice
  over. **A** produces (i) the observation type every later unit consumes and (ii) the synthetic
  generator both B and C fit their validation around, and (iii) the greedy-vs-random corpus that does
  not currently exist in per-game form (§2.2). B cannot fit a rating without an identity-keyed
  observation set, and C cannot run a coverage study without a generator. This is not a JSON file
  three sessions could each derive in thirty lines.
- **Are B and C comparable in size, and do they collide?** Yes and no, respectively. **B** is
  estimator mathematics over identities (Bradley–Terry, Plackett–Luce, the prior, the ladder); **C**
  is a scenario grid plus two methodology simulations over A's generator. They share A's types and
  nothing else — no files, no objects, no hazards (B owns H3 and the pool hazards, C owns H12 and
  H7). They genuinely parallelize, and C's output is the thing most likely to send work back to A,
  so running it beside B rather than after it is what gets that feedback while B is still in flight.
- **Why is A one unit and not two?** Because the observation model, the statistics over it, and the
  generator *into* it key off exactly the same type. A generator is a function producing the
  observation set; splitting it from the model it produces buys a cold start on shared material and
  creates an ordering hazard where the estimators exist for a session before anything can tell
  whether they are calibrated. Merge. A also does its own small smoke-coverage check (a few hundred
  replications at one scenario) so it cannot hand C something obviously miscalibrated.
- **Why does C get its own session at all, rather than being folded into D?** Bullet 2's D ran the
  compute and adjudicated, which worked because the compute was "play games and count". Here the
  measurement *is* a designed experiment with its own correctness problem (H12), and it is the unit
  whose output every other claim in the bullet rests on. Folded into D it becomes the thing done
  after the write-up is already drafted.
- **What warrants its own session regardless?** D: it edits the source-of-truth documents (one
  writer, always) and it is pure judgment over other units' output.

**Why the shape differs from bullet 2's `(A, B) → C → D`:** bullet 2 had two independent
prerequisites and no shared substrate. This bullet has one substrate that is genuinely upstream of
everything (the observation model, the generator, the corpus) and a two-way fan-out over it. The
fan-out is two rather than three because there is no third concern: the statistics *are* A, and the
adjudication *is* D.

**Why there is no separate unit for the CLI:** every subcommand is a thin shell over the unit that
owns the computation, and a fifth session would spend most of its budget re-deriving the argument
conventions of `matchCli.ts`.

---

## 7. Routing — scale and which model to run each unit on

| Unit | Scale | Model | Why that model |
| --- | --- | --- | --- |
| **A** — observation model, statistics core, cluster bootstrap, power calculator, synthetic generator, CLI, corpus generation | ~900 lines across ~6 new files + `package.json`; ~500 lines of spec; ~1 h of compiled-build compute | **Opus** | Two decisions here have wrong answers that produce a working pipeline reporting confidently wrong intervals: clustering on the wrong key (game instead of group, or run instead of group), and aggregating by slot instead of identity (H2), which at 3p silently compares an identity holding two seats against a 1/3 null. Both pass every test a cheap run would think to write, because the output is a plausible number either way. |
| **B** — Bradley–Terry + Plackett–Luce MAP fits, Elo scale, anchoring, separation handling, the ladder | ~550 lines across ~3 new files + a CLI edit; ~350 lines of spec | **Opus** | Separation (H3) is live *today* at 99.2% and will be total at M3. The failure mode is not a crash: it is a finite-looking rating with a symmetric interval on a pair the data cannot bound above. Also owns the pooling guards (H5, H6), where the wrong answer is a ladder that silently double-counts a re-run. |
| **C** — the calibration study: coverage grid, size/power, the two methodology simulations, the validation artifact | ~500 lines + ~300 lines of spec; minutes of compute | **Opus** | This is the closest thing in the bullet to mechanical fan-out over a grid, and Sonnet is defensible for *executing* it. Opus is recommended because the unit's entire value is its willingness to report a failure: the two available shortcuts are widening a tolerance until coverage passes, and writing a generator that shares the estimator's assumptions so coverage cannot fail (H12). Both produce a green study and a worthless one. |
| **D** — adjudication, the write-up, the source-of-truth documents, the ladder seeding | ~600-line deliverable + edits to 4 documents | **Opus** | Judgment over other units' output plus edits to the SRS and Implementation Plan. Three specific traps: presenting the two-agent Elo as if it added information (§3.4), reporting a mean VP margin at 3p/4p without the max-of-N−1 caveat (§2.3), and accepting an under-covering interval as "close enough" instead of sending it back to A. |

**The routing finding for this bullet:** as in bullet 2 there is no cheap unit, but for a new reason.
Bullet 2 had no cheap code because everything touched certified measurement infrastructure. Here
everything touches a *number nobody can check by inspection*. The whole bullet's correctness rests on
one unit (C) being willing to fail another unit's work.

---

## 8. File ownership, so parallel work never collides

| File | Owner | Note |
| --- | --- | --- |
| `agent/src/rating/types.ts` | A | new — observation set, report schema, declared timing fields |
| `agent/src/rating/observations.ts` | A | new — artifacts → identity-keyed, group-clustered observations; balanced-group filter; score and margin conventions (§3.2) |
| `agent/src/rating/stats.ts` | A | new — proportions (effective-n Wilson), group-mean t intervals, design effect / ICC, one-sided threshold tests, permutation test, power / MDE |
| `agent/src/rating/bootstrap.ts` | A | new — seeded cluster resampler + percentile intervals; `createAgentRandom(analysisSeed)` only (§2.6, H11) |
| `agent/src/rating/simulate.ts` | A | new — the synthetic generator; **both** cluster mechanisms of §3.9. Consumed by B and C |
| `agent/src/rating/report.ts` | A | new — assembly, input hashing, artifact I/O, `stripTimingFields` in the `match/artifact.ts` pattern |
| `agent/src/runner/ratingCli.ts` | A | new — `report`, `power`, `design-effect`, `gate` subcommands |
| `agent/package.json` | A | **edit** — adds `rate`, `rate:validate` and `ladder` scripts in one pass, so B and C need no edit here |
| `agent/docs/data/rating_corpus_2p.json`, `…_3p.json`, `…_4p.json` | A | new — the greedy-vs-random and mixed-lineup corpora, `summary` tier, compiled build |
| `agent/test/rating/{observations,stats,bootstrap,simulate}.spec.ts` | A | |
| `agent/src/rating/bradleyTerry.ts` | B | new — pairwise MAP fit, Elo scale, anchoring, separation handling |
| `agent/src/rating/plackettLuce.ts` | B | new — placement fit for 3–4p |
| `agent/src/rating/ladder.ts` | B | new — pool assembly, pooling guards (§3.6), seed-block allocation ledger (§3.8), persistence |
| `agent/src/runner/ratingCli.ts` (the `elo` and `ladder` subcommands) | B | **edit**, after A — a new region of A's dispatch table, following bullet 2's `registry.ts` precedent |
| `agent/test/rating/{bradleyTerry,plackettLuce,ladder}.spec.ts` | B | |
| `agent/src/rating/calibration.ts` | C | new — the coverage / size / power grid and the two methodology simulations |
| `agent/src/runner/ratingValidationCli.ts` | C | new — `npm run rate:validate` (`--phase` per criterion, following `matchValidationCli.ts`) |
| `agent/docs/data/rating_validation.json` | C | new — the calibration artifact |
| `agent/test/rating/calibration.spec.ts` | C | |
| `agent/docs/Rating_Pipeline.md` | D | the deliverable |
| `agent/docs/data/ladder.json` | D | the seeded ladder + the seed-block ledger |
| `agent/docs/Running_Notes.md` | D | one dated entry |
| `agent/CLAUDE.md`, `agent/docs/Terraforming_Mars_AI_SRS_v1.2.md`, `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md` | D | one writer, always |
| `agent/docs/Match_Runner.md`, `agent/docs/Baselines.md` | D | **annotation only** — restate R1a/R1b/G5 intervals under the cluster-correct method if they move materially (§2.3 predicts they barely do at 2p). Do not rewrite the adjudications. |

**Nobody edits:** anything under `src/` (CON-1); `agent/src/match/`, `agent/src/legality/`,
`agent/src/driver/`, `agent/src/engine/`, `agent/src/core/`, `agent/src/search/`,
`agent/src/determinism/`, `agent/src/bench/`, `agent/src/agents/registry.ts`, `agent/src/core/rng.ts`
(§2.6). This bullet is **pure downstream analysis plus one match run through the existing CLI** —
read and import freely, modify nothing. If a unit believes the runner must change to make a statistic
possible, that is a finding for Unit D, not a change to make: the record schema was designed against
this consumer list and the claim that it is insufficient is itself worth reporting.

---

## 9. Shared preamble — prepend to every unit prompt below

> You are working on **Nadia**, an expert-level Terraforming Mars AI agent built on top of the
> terraforming-mars engine in this same repository. Read `agent/CLAUDE.md` first; it orients you and
> points at the two source-of-truth documents (`agent/docs/Terraforming_Mars_AI_SRS_v1.2.md`, the
> SRS, and `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md`, the Implementation Plan).
> `agent/docs/Running_Notes.md` is a dated engineering log — read it for prior art before
> investigating anything that smells like it has been hit before.
>
> Milestone 1 is complete. Milestone 2 bullet 1 (the match runner,
> `agent/docs/Match_Runner.md`) and bullet 2 (the fixed baselines, `agent/docs/Baselines.md`) are
> done. You are working on **Milestone 2, bullet 3: the rating pipeline (SRS FR-14).** The plan for
> this bullet is `agent/docs/Milestone2_Bullet3_Prompts.md` — **read it in full before writing any
> code.** §2 lists facts already established, including measurements taken during planning (do not
> re-derive them; reproducing them is a criterion). §3 settles the design decisions (implement them,
> do not re-litigate them). §4 lists hazards already located (do not rediscover them). §5 is the
> pre-committed criteria, and §8 says which files you own.
>
> Standing constraints:
> - **This bullet writes no game logic and modifies no existing module.** It reads committed match
>   artifacts and runs the existing `npm run match` CLI. `src/` is immutable (SRS CON-1) and so, for
>   this bullet, is everything under `agent/src/` outside `agent/src/rating/` and the two new CLIs
>   (§8).
> - **The unit of analysis is the pairing group, never the game** (§3.1). Games within a group share
>   an Engine seed; the design effect is measured in §2.3.
> - **Aggregate by `name@version` identity, never by lineup slot** (§3.6, hazard H2).
> - **No unseeded randomness anywhere.** The bootstrap uses `createAgentRandom(analysisSeed)` and
>   `analysisSeed` is recorded in every report. Do **not** add a seed to `agent/src/core/rng.ts`
>   (`agent/CLAUDE.md` §6), and do not construct `SeededRandom` directly — its integer-seed
>   constructor is degenerate (Running Notes, 2026-07-22).
> - **Never report `NaN`** (hazard H9). An unestimable quantity is absent, with a stated reason.
> - **Make no throughput or performance claim** (hazard H10). This host swaps; `tsx` understates the
>   simulator ~3.5×. Any run you do for data uses the compiled build.
> - Follow the style of the code around you. The existing agent modules carry heavy explanatory doc
>   comments that record *why*, including the wrong turns; match that — it is the house style and it
>   is why Milestone 1's findings survived.
> - Run `npm test` in `agent/` (not the repo root).

---

## Unit A — the observation model, the statistics, the generator, and the corpus

**Goal.** Everything downstream of a match artifact and upstream of a rating: a faithful,
identity-keyed, group-clustered observation set; the interval and test machinery over it; a generator
that produces synthetic observation sets from known parameters; and the greedy-vs-random corpus that
does not yet exist in per-game form.

**Read first:** `agent/src/match/types.ts` **in full** (it is the input contract and its doc comment
names you as its consumer), `agent/src/match/runner.ts:474-609` (`summarizeMatch`, `standing`,
`wilson95` — you must reproduce these exactly, per P1), `agent/src/match/artifact.ts` (the timing-field
and retention patterns you are copying), `agent/src/legality/run.ts:228` (`percentiles`),
`agent/src/core/rng.ts`.

### 1. Types and the observation model (`rating/types.ts`, `rating/observations.ts`)

A loader that takes N artifact paths and produces one pooled observation set:

- One row per (game, identity-seat), carrying: cluster id `(runId, groupIndex)`, `players`,
  `engineSeed`, `seat`, `slot`, identity `name@version`, `win` (0/1), `score` (§3.2), `placement`,
  `margin` computed from `victoryPoints` (§2.1), and the opponents' identities.
- Balanced-group filtering matching `incompleteGroupPolicy`, with the exclusion count reported.
- The pooling guards of §3.6: seed-range overlap detection on `(players, engineSeed, seating)`, and
  hard equality on `engineCommit` / `harnessVersion` / `seedDerivationVersion`. Errors name the
  offending files.
- SHA-256 of every input file, carried into the report.
- Identity aggregation (H2). A lineup with a duplicated identity must aggregate over both its seats,
  and the AC-5-style null for that identity is `seatsHeld / players`, not `1 / players`.

Note `MatchRunReport`s are sometimes nested inside a validation artifact
(`match_runner_validation.json` → `main.runs[]`) rather than being one at top level. Accept both.

### 2. Statistics (`rating/stats.ts`, `rating/bootstrap.ts`)

Design effect / ICC from between-group variance; effective-n Wilson; group-mean t intervals for
continuous quantities; a seeded cluster bootstrap (§3.1); one-sided threshold tests for
`p ≥ threshold` and a group-level permutation test for the head-to-head comparison; the power / MDE
calculator behind §2.5's tables (your implementation must reproduce both of those tables).

Do not floor the design effect at 1 (§3.1) — leave it estimated, and note in the doc comment that
criterion P2 is what decides whether flooring is needed.

### 3. The generator (`rating/simulate.ts`)

Synthetic observation sets from known parameters: latent strengths per identity, player count,
cluster size, groups, and **both** cluster mechanisms of §3.9 (beta-binomial group effect; per-group
latent-difficulty offset). Also a continuous outcome for margin coverage. Seeded, reproducible, and
documented as the instrument Units B and C validate against — including the H12 warning, in the file,
so nobody later "simplifies" it to one mechanism.

### 4. The CLI and `package.json`

`agent/src/runner/ratingCli.ts` with `report`, `power`, `design-effect` and `gate` subcommands, plus
a dispatch table B extends. Follow `matchCli.ts`'s argument conventions and `artifact.ts`'s `--out`
resolution and retention behaviour. Add all three npm scripts (`rate`, `rate:validate`, `ladder`) now.

The `gate` subcommand implements P8 including the seed-block refusal — but the ledger it consults is
B's (`rating/ladder.ts`). Define the ledger *interface* here and have `gate` degrade to a loud warning
when no ledger file exists yet, so you are not blocked on B.

### 5. The corpus (compiled build)

Via the existing `npm run match`, `--history summary`, in **block D** (§3.8):

- 2p `greedy-1ply,random-legal`, ≥ 500 groups → `docs/data/rating_corpus_2p.json`
- 3p `greedy-1ply,greedy-1ply,random-legal`, ≥ 100 groups → `…_3p.json` (the duplicated identity is
  deliberate: it is the only real data that exercises H2)
- 4p `greedy-1ply,greedy-1ply,random-legal,random-legal`, ≥ 25 groups → `…_4p.json`

Record host swap state in your notes; claim nothing about speed.

### 6. Prove P1 and P4a, and smoke-test coverage

P1 against all three committed self-play runs and your own corpus, as an automated spec, not a manual
comparison. P4a's table to three significant figures against §2.3. Then a small coverage smoke run
(one scenario, ≥ 500 replications) so you do not hand Unit C something obviously miscalibrated —
report the number you got, and if it is outside [93%, 97%] stop and fix the estimator before handing
over.

**Hand off:** the observation type, the generator's signature, the measured design effects, and the
corpus paths.

---

## Unit B — ratings, the pool, and the ladder

**Goal.** A rating on the Elo scale for every identity in a pool, with an interval that tells the
truth when the data cannot bound a pair, and a ladder that accumulates comparisons over months
without silently double-counting or mixing Engine pins.

**Read first:** §3.3, §3.4, §3.5, §3.6 and hazard H3 of this plan; Unit A's `rating/types.ts`,
`observations.ts`, `bootstrap.ts` and `simulate.ts`; `agent/src/agents/registry.ts`'s doc comment on
why `version` is the load-bearing field.

### 1. The pairwise fit (`rating/bradleyTerry.ts`)

MAP Bradley–Terry with a weak zero-mean Gaussian prior on the strengths; report σ and the shrinkage
it induces. Anchor `random-legal@1` at 0 Elo. Exclude self-matches (§3.6) and report the excluded
game count. Intervals by refitting on Unit A's cluster bootstrap resamples.

Separation (H3) is the part to get right, and it is live today at 99.2%: detect it structurally (a
pair, or a set of pairs, with no counter-example on the comparison graph), return a finite point
estimate from the prior, and report the interval as **one-sided with an explicitly unbounded end**.
Assert against `Infinity` and `NaN` in the code, not only in tests.

Also implement the connectivity check of §3.4: a disconnected comparison graph has no single scale,
and the right output is a per-component report with the components named, not one table that implies
comparability.

### 2. The multiplayer fit (`rating/plackettLuce.ts`)

Plackett–Luce over recorded placements, same latent strength, same prior, same bootstrap. Handle tied
placements (rare, and unobserved — H4) by an explicitly documented convention. Per player count, not
pooled (§3.5).

### 3. The ladder (`rating/ladder.ts`)

An append-only record keyed by `(players, name@version)`: current rating with its interval relative to
the anchor **and** relative to the immediate predecessor (§3.4); the comparisons that fed it (with
Unit A's artifact hashes); and the **seed-block ledger** of §3.8 — which group ranges are spent, by
which gate, on which date. Loading a ladder and re-deriving it from its recorded inputs must give the
same ratings; that is the property that makes it auditable rather than a cache.

### 4. CLI and P5/P6/P7

Add `elo` and `ladder` subcommands to A's dispatch table. Prove P5 against A's generator (this is
your own coverage study, on the ratings specifically — do not wait for Unit C, whose grid covers A's
statistics). Prove P6 on A's 2p corpus against §2.4's pre-registered +837 [719, 956], and P7's four
refusals plus the self-lineup exclusion and the H9 degenerate-stratum behaviour.

---

## Unit C — the calibration study, and the two hazards M3 is about to walk into

**Goal.** Establish, by measurement against known ground truth, that every interval in this pipeline
is a 95% interval and every test has its nominal size — and quantify the two methodological failures
Milestone 3 is otherwise going to commit.

**Read first:** §3.9 and hazard H12 of this plan (your unit's central correctness problem is that a
study can be green and worthless); §5's P2, P3 and P9; Unit A's `simulate.ts` and `stats.ts`;
`agent/src/runner/matchValidationCli.ts` for the `--phase`-per-criterion CLI pattern to follow.

### 1. The coverage grid (P2)

The full scenario grid of P2, ≥ 2,000 replications per cell, both cluster mechanisms, plus the
**analytic anchor**: at ICC = 0 compare against the exact binomial answer, so at least one row of the
study is checked against mathematics rather than against Unit A's generator. Tolerance band is
[94.0%, 96.0%] and is computed from the replication count in code — if you find yourself wanting to
widen it, the estimator is what needs to change.

### 2. Size and power (P3)

Empirical size under H0 at each ICC; power at §2.5's effect sizes cross-checked against A's
calculator to within 2 pp; and the negative control — the *unclustered* test's over-rejection at
ICC > 0, reported as a number. Without that number the cluster correction is unjustified rather than
justified.

### 3. The methodology simulations (P9)

Optional stopping, and best-of-k selection on a reused seed block, per P9. These are pure simulation
— no games, no Engine — and they are the most durable thing this unit produces, because they turn
"don't peek" and "don't tune on your test seeds" from advice into a measured cost. Report the sample
sizes and the exact procedure simulated, since the magnitudes depend on both.

### 4. The artifact

`docs/data/rating_validation.json`, one section per phase, following
`match_runner_validation.json`'s shape: a provenance header, the per-cell numbers (not just
pass/fail), and every scenario's parameters, so a later reader can re-run one cell.

**Report failures as failures.** If a coverage cell is out of band, the deliverable is that finding
plus the diagnosis — Unit D would far rather learn that an interval under-covers than publish a
document that says it does not.

---

## Unit D — adjudication, the write-up, and the documents

**Goal.** Decide whether P1–P9 are met, publish `agent/docs/Rating_Pipeline.md`, seed the ladder, and
update the four documents.

**Read first:** Units A, B and C's output; `agent/docs/Match_Runner.md` and `agent/docs/Baselines.md`
as the format to match; §5's criteria; the Appendix's predictions.

### 1. Adjudicate P1–P9 one at a time

One verdict per criterion, in a table, with the number beside it. "Met", "met with a limitation
named", "not met", or "untested, and here is the one command that would test it" — bullet 1's R7
established that last verdict as a legitimate and useful one, and it is better than a soft pass.

### 2. Deliverables

- **`agent/docs/Rating_Pipeline.md`** — what was built, how to run it, **what a rating from it means
  and what it does not**, the criteria adjudicated, the findings worth not rediscovering, known
  limitations, deviations from this plan.
- **`agent/docs/data/ladder.json`** — the two baselines rated, at 2p/3p/4p, with the seed-block
  ledger initialized per §3.8 (block D marked spent through the ranges bullets 1–3 used).
- **`agent/docs/Running_Notes.md`** — one dated entry with the findings.
- **`agent/CLAUDE.md`** — a bullet-3 section in §6; update "Next up" to bullets 4–5.
- **SRS** — discharge annotation under FR-14 in the style of the FR-13 and NFR-5 annotations,
  **including §3.3's statement that TrueSkill is deliberately not implemented and why**. Note against
  AC-2/AC-3/AC-5/AC-7 that the tests now exist and where.
- **Implementation Plan** — mark bullet 3 done in Milestone 2; add the §2.5 power/sample-size finding
  and P9's two measured inflations to the risk register (the gate's sample size is now a named
  compute cost on the M4/M6 critical path, compounding with the AC-1 battery entry already there);
  record the §3.8 seed-block allocation.
- **Annotations only** to `Match_Runner.md` (R1a/R1b) and `Baselines.md` (G5) if the cluster-correct
  intervals move materially. §2.3 predicts they barely do at 2p; if so, say that — "we checked and it
  did not matter" is a result.

### 3. Four things to resist

- **Presenting the two-agent Elo as if it added information.** It is the win rate in different units
  (§2.4, §3.4). Say so in the document, next to the number.
- **Reporting a mean VP margin at 3p/4p without the max-of-N−1 caveat.** It is negative for a
  perfectly average player and it is not comparable across player counts (§2.3).
- **Accepting an under-covering interval.** If C reports a cell out of band, the fix is in A's
  estimator. Widening the band, dropping the cell, or footnoting it are the three ways this bullet
  fails while looking finished.
- **Letting the rating become the gate.** Every acceptance criterion is a rate with a threshold
  (§3.4). If the write-up ends up implying a promotion could be argued from an Elo, rewrite it.

---

## Appendix — falsifiable predictions

Recorded so the write-up can report them as confirmed or refuted, in the style of bullet 2's appendix
(where one prediction failed and was published as failed).

1. **The greedy-vs-random design effect will exceed the self-play figure of 1.033 at 2p** — likely
   1.1–1.5 — because a directed agent makes the deal matter, where random play averages over it. If
   it does *not*, the pairing design's variance reduction is doing less than §2.3 suggests and that
   is worth knowing before M4 budgets samples off it.
2. **The fitted Elo gap will be close to +837 but with a wider interval than [719, 956]** — the
   cluster correction and the prior both widen it. If the fitted interval comes out *narrower*,
   something is wrong with the bootstrap.
3. **The cluster-corrected restatement of R1a and G5 will not change either verdict.** At 2p the
   correction is ~1.6% on the interval width.
4. **Optional stopping every 50 groups to 1,000 games will inflate the one-sided 5% test to
   15–30%.**
5. **Best-of-8 selection on a reused 500-group block will inflate the estimated win rate by
   1.5–3 pp.**
6. **The unclustered test will over-reject at 3p by a measurable margin at ICC ≈ 0.05** — enough to
   justify the correction, not enough to invalidate any Milestone 2 number published so far.
7. **No published Milestone 2 point estimate will change.** Only intervals (§2.3). If a point
   estimate moves, the observation model disagrees with `summarizeMatch` and P1 has found a real
   defect in one of them.
8. **The 4p stratum will be too thin to support a rating interval worth quoting** (25 groups, design
   effect 1.29). Expect the honest output to be "reported, not adjudicable", and expect H9's
   degenerate-stratum path to fire somewhere in the 4p report.
