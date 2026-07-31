# The Rating Pipeline — Milestone 2, bullet 3

**Status: complete. Six of nine criteria met; P2 and P3 are not met and the reasons are the most
useful things in this document; P4b is met on two strata of three.** Date: 31 July 2026. Engine pin
`868714d72a434ab68fe08e5570ebc6863859ae15`.

This is the deliverable for Milestone 2 bullet 3: *"Build the rating pipeline: win rate, average VP
margin, and Elo/TrueSkill with confidence intervals."* It discharges **SRS FR-14** and supplies the
significance machinery **FR-15/AC-7** names but does not itself define. With it, the first half of
the Milestone 2 exit criterion — *"the harness reports statistically sound win rates and ratings for
any two agents"* — is met.

The design decisions and the criteria P1–P9 were pre-committed, before any code, in
[Milestone2_Bullet3_Prompts.md](Milestone2_Bullet3_Prompts.md) (commit `13defce47`). This document
adjudicates them against measurement. The evidence artifacts are
[docs/data/rating_validation.json](data/rating_validation.json) (the calibration study: 160 coverage
cells, 60 size cells, 5 power cells, 2 methodology simulations) and
[docs/data/ladder.json](data/ladder.json) (the two baselines rated, plus the seed-block ledger).

**What makes this bullet different from the two before it.** Bullets 1 and 2 built things that either
work or crash. This one builds a thing that always produces a number, and its failure mode is a
number that is wrong in a direction nobody can see. There is no game you can run to find out whether
a confidence interval is a 95% interval — so the load-bearing work here is not the estimators, it is
the coverage study that measures them, and **the most valuable results in this document are all
failures**: a coverage collapse that was fixed, a residual one that turns out to be arithmetic rather
than a defect, a decision the study first got backwards because the study itself was under-resourced,
and two guards that had never in their lives refused anything.

---

## 1. What was built

| Module | What it is |
| --- | --- |
| `agent/src/rating/types.ts` | The observation model, the report schema, the seed-block allocation. |
| `agent/src/rating/observations.ts` | Artifacts → identity-keyed, group-clustered rows; the pooling guards. |
| `agent/src/rating/stats.ts` | Design effect and ICC, effective-n Wilson, group-mean t, threshold tests, the power calculator. |
| `agent/src/rating/bootstrap.ts` | The seeded cluster bootstrap — the cross-check interval. |
| `agent/src/rating/simulate.ts` | The synthetic generator, with **two** cluster mechanisms (§3.9 of the plan). |
| `agent/src/rating/bradleyTerry.ts` | MAP Bradley–Terry at 2p, on the Elo scale, anchored at `random-legal@1`. |
| `agent/src/rating/plackettLuce.ts` | The same latent strength over 3–4p placements. |
| `agent/src/rating/ladder.ts` | The append-only ladder and its seed-block ledger. |
| `agent/src/rating/seedBlocks.ts` | The block allocation, as a checked function rather than a paragraph. |
| `agent/src/rating/report.ts` | Report assembly, input hashing, the timing-field strip. |
| `agent/src/rating/calibration.ts` | The coverage / size / power grid and the two methodology simulations. |
| `agent/src/runner/ratingCli.ts` | `npm run rate` — `report`, `design-effect`, `power`, `gate`, `elo`, `ladder`. |
| `agent/src/runner/ratingValidationCli.ts` | `npm run rate:validate` — this document's evidence. |

### How to run it

Win rates, margins and the AC-5 tests over one or more match artifacts:

```bash
npm run rate -- report docs/data/rating_corpus_2p.json
```

Ratings on the Elo scale, anchored at `random-legal@1`:

```bash
npm run rate -- elo docs/data/rating_corpus_2p.json docs/data/rating_corpus_3p.json
```

How many games a claim needs, and what a fixed budget can resolve:

```bash
npm run rate -- power --detect 0.53 --games 1000
```

The promotion gate. **Reserve the seed range first, play into it, then gate on it** — the claim
string must match the reservation's `--spent-by`:

```bash
npm run rate -- ladder allocate --block gate --groups 900 --spent-by "M3 gate: heuristic@1 vs greedy-1ply@1 at 2p" --preregistered-games 1800
```

```bash
npm run rate -- gate docs/data/m3_gate.json --challenger heuristic@1 --incumbent greedy-1ply@1 --preregistered-games 1800 --claim "M3 gate: heuristic@1 vs greedy-1ply@1 at 2p"
```

Re-run the whole calibration study (compiled build; minutes, not hours):

```bash
node build/agent/agent/src/runner/ratingValidationCli.js --phase all
```

---

## 2. What a rating from this pipeline means, and what it does not

Five things a reader of any number below needs to know.

**The unit of analysis is the pairing group, never the game.** Games in a group share an Engine seed
— the same board, the same shuffles, the same deal — so they are not independent draws. Every
interval and every test clusters on `(runId, groupIndex)`. The measured design effects are 1.033 /
1.252 / 1.293 at 2p / 3p / 4p on the win rate and 1.043 / 1.516 / 1.184 on the VP margin
(criterion P4a), so an uncorrected 3p margin interval is 23% too narrow — in the stratum where AC-5
lives.

**The correction changes intervals and never point estimates.** Over balanced groups every group has
the same size, so the mean of the group means *is* the pooled proportion. Every win rate published in
[Match_Runner.md](Match_Runner.md) and [Baselines.md](Baselines.md) stands unchanged; §5 restates
only their intervals, and neither restatement changes a verdict.

**A win rate is the gate; the Elo is a summary.** Not one acceptance criterion in the SRS is stated
as a rating — AC-2, AC-3, AC-5 and AC-7 are every one of them a rate with a threshold. So the
promotion gate is a one-sided cluster-corrected test on the head-to-head win rate, and the rating
never enters it. A pool rating borrows strength across the whole comparison graph, so a new agent's
number can move because some *other* pair was played; that is useful for ranking a ladder and
disqualifying for a gate.

**With two identities at 2p the Elo is the win rate, monotonically transformed, and carries no extra
information.** The CLI says so in its own output. The rating earns its keep as the pool grows — and
the statement is 2p-specific: at 3p it is false, because `greedy-1ply@1` holds two of three seats and
its 99.5% identity-level win rate maps to 920 Elo against a fitted 603.

**Above ~99% there is no cross-check.** The pipeline reports two intervals for every proportion, a
primary and a bootstrap, precisely so that a modelling error shows up as a disagreement. At the
boundary the bootstrap has no interval at all and now says so instead of inventing one (§3.2). That
is exactly the regime the baselines occupy, so the primary interval there is unchecked by anything
except the analytic anchor of §4.

---

## 3. What the calibration study changed in the estimators

Two defects and one decision that had to be measured twice. All three were settled by measurement,
none by review, and all three lived in code that ran without error and produced plausible numbers.

### 3.1 The design effect is now floored at 1 — the plan's open question, answered

§3.1 of the plan deliberately left this open and named P2's coverage at ICC = 0 as the measurement
that would settle it: an estimated `deff` below 1 narrows the interval, and a blocked design can
legitimately produce one, so flooring without evidence hides a real effect and not flooring is a bet.

The grid settles it. At ICC = 0, `deff` lands below 1 on **17–34% of replications** from estimation
noise alone. Both columns computed on the same replications:

| | mean coverage | under-covering cells | mean width |
| --- | --- | --- | --- |
| **floored (shipped)** | **0.9502** | **9** of 96 | 0.0784 |
| unfloored (retired) | 0.9486 | 11 of 96 | 0.0776 |
| floored + `t` on `G−1` df (rejected) | 0.9543 | 6 of 96 | 0.0800 |

Restricted to the 72 cells at `p ≤ 0.9`, where the binomial discreteness of §4's P2 does not
contaminate the comparison, the under-covering count is **3 floored against 5 unfloored**. The
`t`-multiplier variant removes under-coverage entirely but overshoots to 0.963 at 50 groups and
produces 27 over-covering cells, which trades one error for the other; it is kept as a column in the
artifact and not shipped.

The estimate and the application are separated rather than conflated: `ClusterDesign.designEffect`
carries what was measured, `appliedDesignEffect` carries `max(1, deff)`, and the CLI prints the floor
only when it bit. This matters because two of the six committed corpora genuinely report `deff < 1`
(0.9898 at 2p and 0.7846 at 4p for `greedy-1ply@1`), and a floored field would have hidden Unit A's
refutation of Appendix prediction 1.

**The floor has a price and it is charged where the design works best.** At 4p `deff = 0.78` — the
pairing removed 22% of the variance — and the floor declines to spend it. That widens the primary
interval and is the largest single term in P4b's 4p disagreement (§4, P4b).

### 3.2 The percentile bootstrap collapses at a boundary, and now refuses

At `p = 0.99` over 50 groups × 2 the study measured bootstrap coverage of **0.60–0.64**. The cause is
arithmetic, not statistics: `0.99¹⁰⁰ = 36.6%` of samples contain no failure at all, every resample of
an all-success sample is all-success, and the percentile interval is `[1, 1]` — a zero-width
interval, stated with confidence, that excludes the truth. `1 − 0.366 = 0.634` is the measured
coverage to three decimals.

`clusterBootstrap` now returns `Unestimable` when every resample agrees, with the reason. The
consequence is stated rather than hidden: **above ~99% there is no independent cross-check**, and
P4b cannot be evaluated there. The refusal fires on real data — in `rating_corpus_4p.json`,
`random-legal@1` won 0 of 100 games from seat 3, and that stratum now reports no bootstrap interval
instead of `[0, 0]`.

The check is on the resamples rather than on the point estimate, so it also catches a statistic that
is constant for a reason nobody anticipated.

### 3.3 The bias correction does transfer — and the first measurement said it did not

Unit B measured the plain percentile interval at 92.5% coverage on a Bradley–Terry rating gap and
fixed it with a bias correction (94.5%), finding it **mis-placed rather than too narrow** — widths
agreed to within 1%, so widening would have bought the coverage without fixing anything. The obvious
next move was to apply the same correction to every percentile interval in the module, and the
obvious check was to measure it on the coverage grid.

**The grid gave two opposite answers, and the difference was the grid.** Measured on identical
replications, over the 36 cells at `p ≤ 0.9`:

| | mean coverage | under-covering cells |
| --- | --- | --- |
| at **B = 200** — plain | 0.9418 | 14 of 36 |
| at **B = 200** — bias-corrected | 0.9380 | 24 of 36 |
| at **B = 2,000** (shipped) — plain | 0.9497 | 5 of 36 |
| at **B = 2,000** (shipped) — bias-corrected | **0.9523** | **0 of 36** |

The bootstrap grid had been running at 200 resamples for cost while the module ships 2,000. On that
evidence the correction was rejected and the module shipped the plain interval. Re-running the same
grid at the shipped count reverses it: the correction lifts coverage by 0.3 pp and removes every
under-covering cell.

**The first answer was an artifact of the study's own under-resampling** — a 2.5% quantile from 200
draws is the fifth order statistic and its own noise dominates. Unit B had already recorded exactly
that effect one level down, as a caution about quoting a rating interval from a few hundred
resamples. It reappeared one level up, where it was being used to *make* a decision rather than to
report one, and it decided it the wrong way.

So the correction is applied, `percentileCi95` keeps the alternative visible, and the grid now runs
at `DEFAULT_BOOTSTRAP_REPLICATES`. **The moral is not about bias correction**: a study measuring a
configuration nobody ships can decide a question wrongly while looking exactly like a study that
decided it.

**What is still true after all three fixes: the cross-check is mildly anti-conservative at 50 pairing
groups** (0.9523 against 0.9503 for the primary interval it checks). It is a cross-check, not a
primary interval, and must not be quoted on its own. At 500 groups — the sample size every 2p claim
in this project is made at — the two agree to a fraction of a point.

---

## 4. The criteria, adjudicated

| | Criterion | Verdict |
| --- | --- | --- |
| P1 | The observation model is faithful to the runner | **Met** — integer equality on all six committed runs |
| P2 | Every interval is calibrated to [94.0%, 96.0%] | **NOT MET** — and the analytic anchor shows the band was not attainable in four of the sixteen anchor cells |
| P3 | Every test's size and power are measured | **NOT MET narrowly** — size clean at 60/60, power misses on one of five rows by 0.44 pp of tolerance |
| P4a | The real-data design effect | **Met** — reproduces §2.3's pre-registered table to four decimals |
| P4b | Two interval methods agree within 0.5 pp | **Met at 2p and 3p; not at 4p**, decomposed into four measured causes |
| P5 | Ratings recover known strengths; separation handled | **Met** |
| P6 | The baselines get a rating, with the honest caveat | **Met** |
| P7 | Pooling refuses what it should refuse | **Met**, after Unit D found the ledger was never being read |
| P8 | The gate is one command, pre-registered and reproducible | **Met**, after Unit D found the workflow could not be completed |
| P9 | The two methodology hazards are quantified | **Met** — both predictions confirmed |

### P1 — the observation model is faithful. Met.

Re-deriving win counts, placement counts and balanced-group counts from the observation layer
reproduces `summary.bySlot`, `summary.bySeat` and `summary.balancedGroups` by **integer equality** on
all three runs in `match_runner_validation.json` and all three of this bullet's own corpora. Identity
aggregation is exercised against a lineup with a duplicated identity (the 3p corpus is
`greedy-1ply,greedy-1ply,random-legal` precisely for this), and the null first-place rate for an
identity holding 2 of 3 seats is 2/3 rather than 1/3.

This is also what makes Appendix prediction 7 checkable: **no published Milestone 2 point estimate
changed.**

### P2 — coverage. NOT MET, and the analytic anchor is what makes the verdict readable.

160 cells; **9 under-cover and 29 over-cover** the pre-committed [94.0%, 96.0%]. The criterion as
written is not met and this document does not soften it. Two things are worth reading off that split
before the detail: after the three changes of §3 the failures run **three to one in the conservative
direction**, and the bootstrap grid — which contributed 23 under-covering cells before them — now
contributes none. But the anchor of §3.9 — exact coverage by enumeration over the binomial pmf,
no RNG, no estimator, no generator — reframes most of what is left:

| | exact Wilson | Clopper–Pearson | pipeline |
| --- | --- | --- | --- |
| p = 0.5, n = 100 | 0.9431 | 0.9648 | 0.9405 |
| p = 0.65, n = 100 | 0.9543 | 0.9543 | 0.9590 |
| **p = 0.9, n = 100** | **0.9364** | 0.9557 | 0.9535 |
| **p = 0.99, n = 100** | **0.9206** | 0.9816 | 0.9240 |
| **p = 0.99, n = 300** | **0.9672** | 0.9885 | 0.9645 |
| p = 0.99, n = 3000 | 0.9470 | 0.9571 | 0.9470 |

**The pre-committed band is unattainable in four of the sixteen anchor cells by any interval.** A
95% Wilson interval on 100 Bernoulli trials at p = 0.99 covers 92.06% of the time, and that is a fact
about the discreteness of the binomial, not about this pipeline. Against that column the pipeline
sits within **−1.1 to +1.7 pp**, which is the part attributable to estimating the design effect —
and that is the quantity P2 was really trying to bound.

So the honest reading, in three parts:

- **Where the arithmetic allows it, the shipped estimator is calibrated.** Mean coverage over the 72
  proportion cells at `p ≤ 0.9` is **0.9503**, with 3 under-covering cells against 4.8 expected
  outside the Monte-Carlo band by chance. The bootstrap cross-check over the same region is 0.9523
  with **no** under-covering cells, and the margin's group-mean t interval is 0.9507 with none.
- **The criterion was mis-specified, not merely missed.** [94.0%, 96.0%] presumes an interval can be
  calibrated at any (p, n); at `p = 0.99, n = 100` nothing can be. A future restatement should be
  written against the exact interval's own coverage — the anchor column — rather than against 95%.
  It is recorded as a mis-specification here, and **not** rewritten to fit the result: P2 stands as
  not met.
- **The cluster correction is justified by measurement, not argument.** The unclustered negative
  control on the same replications: mean coverage **0.9222**, with **56 of 96 cells under-covering**.
  The margin's control is the same story — 0.9186 with 9 of 16 under-covering, against 0.9507 for
  the shipped interval.

The margin grid is otherwise clean: 15 of 16 cells pass, the exception over-covering at 0.9605. Of the
bootstrap grid's 14 over-covering cells, 12 are at `p = 0.99`, where it declines on a third of samples
and the ones it accepts are the ones with room to be conservative (§3.2).

### P3 — size and power. NOT MET, narrowly, and only on the calculator.

**Size is clean at 60/60.** Every one of the 48 threshold-test cells and 12 permutation-test cells
holds its nominal 5%: the worst clustered size is 0.0565 against a Monte-Carlo upper bound of 0.0596,
and the worst permutation size is 0.0560.

**The negative control earns the correction.** Dropping the clustering on the same replications takes
the one-sided 5% test to **13.15%** at ICC 0.2 with m = 6 — a 2.66× inflation — and to 7.6% at
ICC 0.05, which is the 3p regime where AC-5 lives. Mean inflation across the grid is +7.6 pp.

**Power misses on one row of five.** Against the shipped test at the sample sizes the calculator
itself prescribes:

| detect | games | empirical power | calculator | gap |
| --- | --- | --- | --- | --- |
| 65% | 70 | 0.7830 | 0.8074 | **−2.44 pp** |
| 60% | 158 | 0.7935 | 0.8022 | −0.87 pp |
| 55% | 636 | 0.7945 | 0.8007 | −0.62 pp |
| 53% | 1,768 | 0.8170 | 0.8002 | +1.68 pp |
| 52% | 3,978 | 0.7860 | 0.8000 | −1.40 pp |

The tolerance is 2 pp and the n = 70 row misses it by 0.44 pp. The cause is diagnosed and is not a
defect in the test: at 35 pairing groups the binomial is too discrete for a continuous normal
approximation to place the rejection boundary exactly, and the discreteness costs power rather than
size (which is why the size cells are clean). A continuity correction was considered and not added —
it would move one row of one table by a few games and put a second, differently-parameterized formula
in the path of every gate. Instead `requiredGames` documents the bound, `SMALL_SAMPLE_FLOOR = 150`
names it, and the `power` subcommand **prints the caveat** whenever it reports a figure at or below
that scale. Treat the returned number as a floor there.

### P4a — the real-data design effect. Met.

Reproduces §2.3's pre-registered table, computed independently during planning with a throwaway
script, to four decimals:

| | win rate deff | pre-registered | margin deff | pre-registered |
| --- | --- | --- | --- | --- |
| 2p (500 groups × 2) | 1.0331 | 1.033 | 1.0426 | 1.043 |
| 3p (100 groups × 6) | 1.2518 | 1.252 | 1.5160 | 1.516 |
| 4p (25 groups × 4) | 1.2928 | 1.293 | 1.1844 | 1.184 |

On this bullet's own greedy-vs-random corpora the figures are 0.9898 (2p), 1.0271 (3p) and 0.7846
(4p) — **Appendix prediction 1 refuted**, and discussed in §6.

### P4b — the two intervals agree. Met at 2p and 3p; not at 4p.

Met on every stratum whose effective sample size can express half a percentage point. At 4p — 100
rows per identity, 25 pairing groups — the gap is 2.4–3.5 pp, and it decomposes into four causes,
each measured on the spot rather than allowed for by a constant:

| cause | 4p slot 0 | what it is |
| --- | --- | --- |
| the design-effect floor | 1.10 pp | §3.1's price, charged because `deff = 0.78` here |
| Wilson-vs-Wald shape | 0.30 pp | the property Wilson was chosen for, at small n near the ends of [0, 1] |
| the bias-correction shift | 1.00 pp | the diagnostic column of §3.3 |
| the resample grid | 1.00 pp | every resample has exactly 100 rows, so the statistic moves in 1 pp steps |

The substantive question P4b asks — *do the two methods agree about the variance?* — is answered
yes everywhere it can be asked: the bootstrap's width and a Wald interval's width on the same
unfloored effective n agree to within one grid step. Two of the four 4p strata cannot be asked at
all: `random-legal@1` won **1** game from one seat and **0** from the other, and a bootstrap with one
event is not a cross-check (the spec gates on at least 5 observations of the rarer outcome). This is
Appendix prediction 8 arriving early — see §6.

### P5 — ratings recover known strengths, and separation is handled. Met.

Over synthetic pools with known latent strengths: rank order recovered in **100%** of 300
replications (Bradley–Terry, 5 identities) and 100% of 250 (Plackett–Luce, 3 identities); interval
coverage **95.7%** and **94.4%** against Monte-Carlo bands computed in code from the replication
count.

Separation is decided **structurally** — from reachability on the beat digraph — and not from the
size of the fitted number, which is the distinction that matters: on the real 2p corpus one game in
400 flips a pair between "unbounded above" and a two-sided interval while moving the point estimate
by a few hundred Elo out of several thousand. A separated pair reports a finite point estimate, a
lower bound, and an explicitly unbounded upper bound. Never `Infinity`, never `NaN`, never a
symmetric interval around a number the data cannot bound.

The shrinkage diagnostic is reported **per contrast**, not per parameter. The per-parameter ridge
diagonal is the wrong statistic: the likelihood sees only differences, so the level direction has
shrinkage 1 by construction and the diagonal mixes it into every entry — it reported ~50% on a
1,000-game two-agent pool where the prior moves the gap by 0.3%. `effectiveParameters` reports the
unidentified level honestly, once.

### P6 — the baselines are rated. Met.

`random-legal@1` anchored at 0 Elo, prior σ = 4 logits (695 Elo):

| | `greedy-1ply@1` | interval | games | prior shrinkage |
| --- | --- | --- | --- | --- |
| 2p (Bradley–Terry) | **764 Elo** | [682, 862] | 1,000 | 0.3% |
| 3p (Plackett–Luce) | 603 Elo | [538, 685] | 600 | 0.1% |
| 4p (Plackett–Luce) | 623 Elo | [499, 791] | 100 | 0.4% |

Every stratum has 1.00 of 2 parameters pinned by data rather than by the prior — the other is the
unidentified level — and 2,000 of 2,000 bootstrap resamples usable.

The 2p figure is quoted with its caveat in the CLI's own output: with two identities it is the
head-to-head win rate transformed, and the raw 98.80% maps to 766 Elo against the fitted 764. **This
is Appendix prediction 2 refuted in both halves** (§6). The 4p interval is 292 Elo wide over 25
pairing groups: reportable, not adjudicable.

### P7 — pooling refuses what it should refuse. Met, and it was not being asked.

All four refusals fire and name the offending files: overlapping group ranges for the same
`(players, lineup)`; mismatched `engineCommit`; mismatched `harnessVersion`; mismatched
`seedDerivationVersion`. Self-lineups contribute zero games to a rating fit and the exclusion is
reported (600 games at 3p, 100 at 4p). Degenerate strata yield an explicit unestimable rather than
`NaN`, and the 2p self-play run demonstrates it: `random-legal@1` holding both seats wins 100% of
games by construction, the between-group margin variance is 0, and the pipeline says so instead of
producing a confident nothing.

**But the seed-block half of this was inert.** `loadLedger` was written against a bare
`{allocations}` file while Unit B's ladder nests it under `ledger`, so on every real ladder it
returned an empty list, `assertBlockAvailable` read that as "no ladder yet", and the discipline of
§3.8 **warned instead of refusing — every time, since it was written**. The specs did not catch it
because they all pass a ledger built in memory, exercising every path except the one that reads the
file that exists. Fixed, and now covered end-to-end against the committed `ladder.json`.

### P8 — the gate. Met, after the workflow was found to be impossible.

`npm run rate -- gate` returns a verdict naming the test, the null, the pre-registered N and its seed
block, the observed rate with both intervals, the analysis seed, `z`, the p-value and pass/fail. Same
inputs plus same `analysisSeed` produce byte-identical output modulo the declared timing fields.

Running it end to end found the second defect. §3.8 requires each gate's seed range to be reserved
**before** the run; that reservation then sat in the ledger, and the gate the range had been reserved
*for* was refused by its own reservation. Every possible gate was blocked, so the only way to run one
would have been to skip the allocation — bypassing the discipline entirely, which is worse than not
having it. `assertBlockAvailable` now takes a `claim`: an overlap is permitted exactly when every
overlapping allocation was recorded under that same claim string, so a gate may run on the range it
reserved and on nobody else's, and a typo fails closed.

Both halves are demonstrated on the committed corpus: the gate refuses the range under another
claim, and passes under its own.

### P9 — the methodology hazards, quantified. Met. Both predictions confirmed.

**Optional stopping.** Testing after every 50 pairing groups up to 1,000 games, under H0, over 10,000
replications: a test that costs **4.87%** run once at the end costs **16.47%** run at ten interim
looks. A **3.38×** inflation of the false-positive rate, from a habit that leaves no trace in the
output. Predicted 15–30%; confirmed.

**Seed reuse.** Selecting the best of 8 equally-strong variants on one 500-group block, over 5,000
replications, and reporting its win rate three ways:

| reported on | win rate | inflation |
| --- | --- | --- |
| the games it was selected on | 52.23% | **+2.22 pp** |
| the same seeds, fresh agent randomness | 50.01% | +0.01 pp |
| a disjoint block | 50.00% | +0.00 pp |

Predicted 1.5–3 pp; confirmed. And the interaction sweep decomposes it, which is the part that
changes what M3 should do: the inflation is almost entirely **winner's curse on the games
themselves** rather than a variant × seed interaction — replaying the same seeds with fresh agent
randomness recovers to +0.01 pp, rising to only +0.70 pp at an interaction of 1.0 logit. So the
expensive discipline (never reuse a seed) buys little; the cheap one (never report the selection
games) buys almost all of it.

---

## 5. Restating the published intervals

§2.3 predicted the cluster correction would barely move anything at 2p. It did not:

| | published (game-level Wilson) | cluster-corrected | verdict |
| --- | --- | --- | --- |
| R1a, slot 0, 2p self-play | 51.60% [48.50%, 54.69%] | 51.60% **[48.45%, 54.74%]** | unchanged — contains 50% |
| R1b, seat 0, 2p self-play | 52.60% [49.50%, 55.68%] | 52.60% **[49.50%, 55.68%]** | unchanged — just contains 50% |

**Appendix prediction 3 confirmed: no verdict changes.** R1a is still met; R1b's first-seat advantage
is still not demonstrated. `Match_Runner.md` and `Baselines.md` carry a one-line annotation pointing
here rather than being rewritten.

**Baselines.md's G5 cannot be restated, and that is a finding about what gets committed.** Bullet 2
committed summaries only — `baselines_validation.json` carries no per-game rows — so its 99.2%
headline is not re-analysable by anything. This bullet's own 2p corpus, on a different seed block,
gives **98.80% (988/1,000), CI [97.91%, 99.31%]** against bullet 2's 99.2% [98.43%, 99.59%]: the two
intervals overlap substantially and the difference is 4 games. It is a second sample, not a
correction. **The lesson for bullet 4 and everything after: commit the rows, not the summary.**

---

## 6. The falsifiable predictions, adjudicated

The plan's appendix made eight. Two were refuted, one arrived a stratum early, five confirmed.

| | Prediction | Outcome |
| --- | --- | --- |
| 1 | The greedy-vs-random design effect will exceed 1.033 at 2p, likely 1.1–1.5 | **REFUTED** — 0.990 (2p), 0.985 (3p), 1.010 (4p) on the win rate, with slightly negative ICC, and 1.024 / 1.052 / 1.069 on the margin against self-play's 1.043 / 1.516 / 1.184. **A directed agent makes the deal matter *less*, not more** |
| 2 | The fitted Elo will be near +837 with an interval wider than [719, 956] | **REFUTED in both halves**, and the "something is wrong with the bootstrap" clause does **not** fire — see below |
| 3 | The restatement will not change R1a's or G5's verdict | **CONFIRMED** (§5) |
| 4 | Optional stopping every 50 groups will inflate the 5% test to 15–30% | **CONFIRMED** — 16.5% |
| 5 | Best-of-8 on a reused block will inflate the win rate by 1.5–3 pp | **CONFIRMED** — +2.22 pp |
| 6 | The unclustered test will over-reject measurably at 3p-like ICC | **CONFIRMED** — 7.6% at ICC 0.05 / m = 6, 13.2% at ICC 0.2 |
| 7 | No published point estimate will change | **CONFIRMED** — P1's integer equality |
| 8 | The 4p stratum will be too thin to support a rating interval worth quoting | **CONFIRMED** — 292 Elo wide over 25 groups, and H9's unestimable path fires twice in the 4p report |

**Prediction 1 is the one that changes a plan.** The reasoning behind it — a directed agent should
show a *larger* seed effect, because which cards the deal produces starts to matter — was wrong in
sign. Two real corpora now report `deff < 1`, so §3.1's "do not floor without evidence" is
load-bearing rather than hypothetical, and it is why the floor ships as an application rather than as
a replacement for the estimate. It also means the pairing design is buying *more* variance reduction
against a directed agent than against random play, which is the opposite of what the plan assumed
and is good news for every sample size from M3 onward.

**Prediction 2 is refuted diagnosably, which is the useful kind.** The point estimate is 764 rather
than ~837 because it tracks its own corpus's 988/1,000 to 2 Elo, where §2.4's figure came from bullet
2's 992/1,000 on a different seed block. The interval is *narrower* (180 Elo) than the pre-registered
237 — and the prediction said that would mean the bootstrap was broken. It does not: the
plain-percentile fitted interval is 190 Elo against 193 from a win-rate bootstrap and 194 from the
effective-n Wilson interval mapped through the Elo transform, so three independent routes agree. The
remaining 10 Elo of narrowing is the bias correction that the rating coverage study independently
requires. The prediction's escape clause was checked before it was dismissed.

---

## 7. Findings worth not rediscovering

- **A statistics module cannot be validated by looking at its output on real data.** Every estimator
  in §3 ran without error and produced plausible numbers, including the interval that covered 60% of
  the time. Only the coverage grid could see any of it.
- **A self-validating simulation shares the estimator's assumptions.** The mitigation that actually
  paid was the **analytic anchor** — exact binomial coverage by enumeration, no generator involved.
  It is what turns "9 cells under-cover" into "most of that is binomial discreteness and the
  estimation cost is ±1.7 pp", and without it P2's verdict is unreadable. The two cluster mechanisms
  paid less than expected: they differ by only 0.20–2.23% in total variation, largest in the
  off-centre high-ICC cells.
- **A study that measures a configuration nobody ships can decide a question the wrong way.** §3.3:
  the bias-correction question was measured on a grid running at 200 resamples while the module ships
  2,000, and the two configurations gave opposite answers. Unit B had already recorded the underlying
  effect as a caution about *reporting*; it reappeared where it was being used to *decide*. Grids run
  at shipped settings, and a decision made on a cheap measurement is a cheap decision.
- **A guard that has never refused anything has not been tested.** Both of the end-to-end defects
  (§4's P7 and P8) were in the seed-block discipline, which had specs, passed them, and had never
  once refused a real run. Both were found by *using* the CLI, not by reading it.
- **`--claim` is load-bearing, not ceremony.** Reserving a gate's seeds before the run and then
  running on them are two operations that must both be possible; getting that wrong made the
  discipline into something to bypass.
- **Report the estimate and apply the correction separately.** The `designEffect` /
  `appliedDesignEffect` split is what let the floor ship without hiding the two corpora that refuted
  prediction 1.
- **Commit the rows, not the summary** (§5).

---

## 8. Known limitations

- **P2 is not met**, and the pre-committed band is unattainable at the extremes (§4, P2). A restatement
  against the exact interval's own coverage is the right fix and is deliberately left to whoever
  needs it, rather than done here after seeing the result.
- **The power calculator overstates power below ~150 games** by up to 2.4 pp. Documented, named
  (`SMALL_SAMPLE_FLOOR`), and printed by the CLI at that scale.
- **Above ~99% there is no cross-check on the primary interval** (§3.2), which is the regime the
  current baselines occupy.
- **The bootstrap cross-check is mildly anti-conservative at 50 pairing groups** (0.9523 against the
  primary interval's 0.9503 over the same cells) and must never be quoted alone.
- **The 4p stratum is reportable, not adjudicable**: 25 pairing groups, a 292 Elo interval, and two
  of four strata with too few events for any cross-check.
- **TrueSkill is not implemented** and FR-14 is discharged by the Bradley–Terry / Plackett–Luce
  family. §3.3 of the plan records the reasoning; the SRS now carries it as an annotation. If a later
  milestone needs online updating over a large evolving pool, it goes behind the same interface.
- **The gate has never adjudicated a real promotion.** Its first genuine use is M3's. What is
  demonstrated here is the machinery, on a development-block corpus, plus both halves of the
  seed-block refusal.
- **No throughput claim is made anywhere in this document.** The host swaps; the study is arithmetic
  and its wall-clock time is not a measurement of anything.

---

## 9. Deviations from the plan

- **Two files the plan's §8 does not list**: `rating/seedBlocks.ts` (Unit A) and
  `test/rating/report.spec.ts` (Unit A). Neither collides with another unit.
- **A fourth seed block, `harness` (7,000–9,999)**, added by Unit D. §3.8 allocated three blocks
  covering 0–6,999, and seeding the ledger retroactively found that bullet 1's validation battery
  already spent 5,000–5,019 inside `gate`, 6,000–6,029 inside `regression`, and 7,000–7,039,
  8,000–8,999 and 9,000–9,009 **past the end of the allocation entirely**. Those were `random-legal`
  self-play runs that certified nothing, so no published claim is affected — but three of the five
  could not be recorded as spent at all. Adding a block was preferred to moving `gate` or
  `regression`, which would rewrite the meaning of an allocation the plan and the SRS both name. All
  nine ranges are now in the ledger.
- **`assertBlockAvailable` gained a `claim` parameter** (§4's P8) and `loadLedger` accepts the nested
  ladder shape (§4's P7). Both are bug fixes to Unit A's files, made by Unit D, as the plan
  anticipated for exactly this case.
- **The calibration study's bootstrap grid now runs at the shipped 2,000 resamples**, not the 200 it
  first used for cost — and that is not tidiness: at 200 the grid reversed the §3.3 decision. The
  saving was not worth having anyway; the ten-fold increase left the phase in the same order of
  magnitude. (Not a throughput claim — see §8. It is why a cost argument was rejected, not a
  measurement of anything.)
- **`rating_validation.json` gained columns** rather than being replaced: `unfloored` (the retired
  estimator), `biasCorrected` (the untaken option), and separate `estimable` counts for the bootstrap
  and Wilson columns, since the bootstrap now refuses where Wilson does not and one denominator would
  have made the Wilson column at p = 0.99 conditional on the wrong population.

---

## 10. Where this leaves Milestone 2

Bullet 3 is done. The first half of the exit criterion — *"the harness reports statistically sound
win rates and ratings for any two agents"* — is met, with the soundness measured rather than
asserted and the two criteria it fails published rather than adjusted.

Still open: **bullet 4** (the expert-distribution report, FR-DATA-1 / AC-8) and **bullet 5** (the
regression seed set). Bullet 5 inherits the seed-block allocation of §3.8 with block `R`
(6,000–6,999) reserved for it and 6,000–6,029 already recorded as spent by bullet 1's R3 run.

What the milestones after it inherit:

- **A promotion gate that is one command**, with a pre-registered N and a seed-block reservation that
  now actually refuses. M3, M4, M5 and M6 each run it against their immediate predecessor.
- **A sample-size budget instead of a habit.** 1,000 games resolves a 4.0 pp edge and nothing finer;
  certifying a 53% improvement takes 1,767 games. At M4's search budget that is ~4.7 days
  single-core, behind an ×8 core-scaling multiplier bullet 1 could not verify. From M4 onward the
  choice of N is a multi-day commitment and `npm run rate -- power` is where it gets made.
- **Two quantified methodology costs** (§4's P9) to argue M3's tuning discipline from — including the
  finding that reporting the selection games, not reusing the seeds, is where nearly all of the
  inflation lives.
