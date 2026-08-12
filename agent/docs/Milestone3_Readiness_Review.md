# Milestone 3 readiness review — where the infrastructure will constrain the strategy

**Date:** 11 Aug 2026 · **Status:** review, not a source of truth · **Audience:** the project director

A read of everything built through Milestone 2 — `agent/src` (48k lines, 173 files), `agent/test`
(70 spec files), `agent/docs` (22 documents), and the Engine contact surface — against the question
"what will get in the way when we start building an agent that actually plays well?"

The short version: **what has been built is a very good laboratory and not yet a player.** Every
instrument answers a question of the form *did something change / is it legal / is A stronger than
B*. Milestone 3 is the first piece of work whose central question is *what is this position worth*,
and there is currently no code that answers anything like it. That is not a criticism — it is the
plan working as designed. But it means the transition ahead is larger than "next bullet", and the
laboratory's own habits will now be applied to a different kind of work, at a much higher decision
rate, on measuring equipment that is coarser and slower than the changes being measured.

Eleven things below. The first three are structural and worth acting on *before* any strategy code
is written; the rest are things to plan around.

---

## First, what is genuinely strong

Worth stating, because most of this document is about problems.

- **Legality accounting is real.** "Zero illegal moves" has a strict definition, an instrument that
  can see all three populations of rejected submissions, and 444,680 measured submissions behind it.
  It found a real defect that was invisible at 20-game scale.
- **Determinism is verified move-for-move**, not by end-state equality, with a committed 300-game
  corpus that re-runs on demand.
- **The fork machinery works and knows why it works.** 26,026 fork experiments at 100% reproduction,
  plus a third fidelity check the original design didn't know it needed. Search at M4 rests on this,
  and it is the part I'd trust most.
- **The statistics are honest.** Clustering by pairing group, design effects measured rather than
  assumed, a power calculator, a seed-block ledger that refuses reuse. Very few hobby projects have
  any of this; almost none have it *before* the tuning starts.
- **The documents record what they missed.** The regression suite's own "here is what this does not
  catch" section is the most useful page in the repo.

**And it all works right now**, checked while writing this rather than taken from the write-ups:
the agent test suite is green (**716 passing, 2 pending**), `agent/` type-checks clean, and
`npm run regression` passes end to end in 46.7 s — L1 27/27, the 300-config determinism corpus with
zero mismatches, and both frozen baselines reproducing all 33 pinned games. The starting line is
sound.

That foundation is why the problems below are worth taking seriously: they are the things that
foundation does *not* cover.

---

## 1. The frozen yardstick and the new agent share the same move-generation code

**This is the one to fix first, because it is cheap now and effectively impossible later.**

There is exactly one piece of code that answers "what moves are worth considering here":
`agent/src/core/candidates/`. `greedy-1ply@1` uses it. Anything Milestone 3 builds will use it too —
there is no alternative.

But `greedy-1ply@1` is a **frozen baseline**. AC-3's "wins ≥80% against greedy one-ply" only means
something if the greedy agent doesn't move. The registry says so explicitly, and names the changes
that would count as making a *new version* of it: "a reduction in `core/candidates/`, the drain
boundary, the 64-candidate cap, the 32-step drain budget, or anything that changes which decisions
are forkable."

Milestone 3 needs to change `core/candidates/` — see §2. So there are two ways this goes wrong:

- **You change it and the baseline moves.** `greedy-1ply@1` becomes `@2`, and every Milestone 2
  number — the 99.2% win rate, the Elo ladder, the design effects, the regression corpus's 18 greedy
  games — describes an agent that no longer exists. The AC-3 bar has to be re-measured against a
  different opponent, and you can no longer say "M3 beat the thing M2 adjudicated."
- **You change it and nothing notices.** The regression suite's own Gap 1 records that a
  candidate-set reduction (`MAX_INTERIOR_AMOUNTS` 6→3) fired **nothing** — not across 43 pinned
  games, both baselines, both corpora, or all 300 determinism configs — and that this survived the
  corpus growing from 10 games to 33. So the suite is blindest to precisely the change class that
  redefines the baseline. A green regression run is not evidence the yardstick held.

**Recommendation.** Before writing any evaluation code, give the candidate layer an explicit
*profile* (a version number that selects a set of generation rules). `greedy-1ply@1` pins profile 1
forever; Milestone 3 develops profile 2. This is a small, mechanical change today. Once M3's
strategy code is entangled with the shared generators, separating them means re-adjudicating the
baseline.

---

## 2. Three high-leverage decisions the agent currently cannot express

These are move-generation limits, not evaluation limits. No amount of clever scoring fixes them,
because the good move is not in the list being scored. Each was a deliberate, documented Milestone-1
or Milestone-2 simplification, and each is explicitly flagged as M3's job. Together they are, I
think, the largest single block of strategic work ahead.

**Payments are one canonical cheapest-legal allocation.** The enumerator picks the cheapest legal way
to pay and offers nothing else. As a TM player you know why that's wrong: with Electro Catapult in
play you pay for a card with all your steel *except one*, because that last steel is worth 7 M€ next
turn. Titanium held back for a space card, heat held under Helion, steel kept for a placement you can
see coming — none of these are expressible. The Running Notes flag this as an M3 action item in
almost exactly those words ("replace 'single canonical payment' with 'canonical payment + a bounded
set of strategic deviations'").

**Research-phase buying can't buy two of four.** The candidate set for a card-selection decision is:
the empty selection, each single card on its own, and one maximum-size selection drawn from a random
shuffle. So at Research the agent can consider *buy nothing*, *buy exactly this one card*, and *buy
all four* — and nothing in between. "Buy these two, skip those two" is the single most common answer
a strong player gives at that decision, and it is not in the set. This is stated plainly in the
source file: *"A Milestone-3 agent with an economy term will want a richer set here, and this is the
file it will grow in."*

**The opening deals itself.** For the `initialCards` decision the agent enumerates corporation ×
*how many* project cards to buy — but *which* cards is one random draw shared across every candidate,
and the prelude selection is a single random sample held fixed across the whole set. So corporation
choice is genuinely evaluated; keeping Business Empire over Research Outpost, or which two preludes,
is a coin flip.

> **A design for all three is in
> [Milestone3_Move_Set_Design.md](Milestone3_Move_Set_Design.md).** Short version: they share one
> root cause — the agent can only value a move by playing it — and one fix: a static evaluator that
> prices positions, cards and resources without playing them, after which *static evaluation
> proposes and fork-and-score disposes*.

---

## 3. The opening cannot be evaluated by the mechanism everything else uses

Related to the above but a different problem, and worth understanding on its own because it changes
what the opening book *has to be*.

The agent judges a move by **forking** the game — cloning it, playing the move into the clone, and
looking at where it lands. That mechanism is unavailable before the first action phase. The snapshot
guard refuses the `RESEARCH`, `DRAFTING`, `INITIALDRAFTING`, `PRELUDES` and `CEOS` phases as
unfaithful, all of those precede the first action, and replaying forward from an earlier point can't
help because there *is* no earlier point. Measured result: **all 1,000 `initialCards` decisions in
the baseline validation fell back to a random move.** The fork service names this outcome
`no-ancestor` and 97% of greedy's fallbacks are it.

So the corporation, the preludes and the starting hand — the decisions that carry an enormous share
of a game's variance, and that a strong human spends real time on — need a **completely different
mechanism** from every other decision: a static evaluator that scores cards and corporations *without
playing them*, plus the weak corporation prior from bullet 4.

That has a scheduling consequence worth flagging. The plan lists "build the card-feature schema" as a
*prerequisite work item* for M3, and it is easy to read that as tidy-up that can slip. It cannot: it
is the only available route to an opening book, and it is described as "a substantial task in its own
right" for the full ~277-card pool.

---

## 4. There is no observation layer, and the seam that exists hands over perfect information

Right now `decide()` receives a `DecisionPoint` that contains `player`, `model`, and **`game: IGame`**
— the whole live Engine game object. From there, every opponent's hand and the exact contents of the
deck are two property accesses away.

Nothing prevents an evaluator from reading them. CON-2's *"never read another player's hidden state"*
appears in the code only in its other sense (never submit an illegal move); there is no test, no lint
rule, and no type that stops it. Compare this with RNG separation, which *does* have a
CI-enforceable structural spec.

Why it matters, in order of when it bites:

- **M4** samples "determinizations" — plausible guesses at what opponents hold — and searches those.
  An evaluator that read the real hands would be tuned to information the search cannot supply, so
  its weights would be wrong in the setting it's actually used in.
- **M5** plays live over HTTP against a server that will not tell you opponents' hands. An evaluator
  that depends on them cannot run at all.
- And the failure is silent in both directions: the harness would show a *stronger* agent, because
  cheating works.

**Recommendation.** Define an explicit `Observation` type — what a player at the table can see, plus
a place for the belief model to plug in at M4 — build it from the decision point, and make strategy
code take *that* rather than `IGame`. Enforce it with a structural spec, the same way RNG separation
is enforced. Doing this before the evaluator exists costs a day; doing it after means auditing every
feature.

---

## 5. Candidate moves are scored with their sub-decisions resolved at random

When the greedy agent scores "play this city card", the card is played into a fork and any follow-up
decisions that belong to the same move — *where does the tile go* — are answered by **random legal
play**. All candidates share the same random stream, so the comparison between them is fair; but the
*level* of each score is "the value of this card with a randomly-chosen placement."

Measured cost today: median 0 random sub-decisions per candidate, p95 of 1, max 4. Small — because
the greedy objective is current VP and mostly can't see placement anyway.

For Milestone 3 this flips from a footnote to a central design question, because half the features on
the plan's own list — adjacency, city/greenery placement, board position — are exactly what that
random step is deciding. An evaluator that carefully weighs ocean adjacency, then evaluates every
city card with the city dropped at random, is measuring noise.

The fix is for the agent to resolve its own sub-decisions during evaluation rather than deferring to
random play, which is recursive and multiplies the per-decision cost. That is a real design decision
with a real price, and M3 should make it deliberately rather than inherit the current behaviour by
default.

---

## 6. The measuring instrument is coarser than most of the changes you'll want to measure

This is the constraint I'd most want you to internalise, because it governs how M3 has to be *worked*,
not just what it produces.

From the rating pipeline's own numbers:

- **1,000 games resolves a 4.0 pp edge and nothing finer.** Certifying a 53% win rate takes 1,767
  games.
- Most individual evaluation-weight changes are worth *far less* than 4 pp. So **most single tuning
  decisions are not certifiable with this harness**, at any sample size you can afford.
- Two traps, both measured rather than argued: peeking at results every 50 pairing groups turns a
  4.9% false-positive rate into **16.5%**; and picking the best of 8 variants and then reporting its
  win rate *on the games that selected it* inflates it by **+2.2 pp**.

Practical consequences for how M3 runs:

- Tune in **batches** — change a family of related features, measure once, keep or revert the batch.
  Don't try to certify individual weights.
- **Pre-register the sample size** (`npm run rate -- power`), reserve the seed range, run, report.
  Never report the games a variant was selected on — that's the cheap discipline that buys most of
  the protection.
- Accept that the final weight vector is chosen partly on noise, and that this is fine: the guard
  against it is the promotion gate against the *previous version*, not per-weight rigour.
- **Seed budget:** the development block is groups 0–1,999 and roughly 875 remain unrecorded. That
  is the entire tuning allowance before you start reusing games. Worth watching.

---

## 7. Compute: one 8 GB laptop, and the parallel speedup has still never been measured

Checked while writing this: the host has **8 GB of RAM, 8 cores, and 1.19 GB currently swapped**.
That is the machine every number in the project was measured on, and the documents are candid that it
has already corrupted measurements twice — a single-process throughput baseline swung **4.3×** within
one session on an identical configuration, and an apparent 6× regression that cost an afternoon
turned out to be the host.

The concrete gap: **criterion R7 — does the work parallelise across cores? — is UNTESTED**, not
failed. Every throughput figure, the self-play budget, and the Milestone-6 sizing rest on an assumed
×8 multiplier that has never been validly measured. On this machine, eight Node children at ~300 MB
each thrash instead of scaling.

Costs to plan around, single-core, from the measured runs:

| Run | Measured |
| --- | --- |
| 1,000 games, greedy vs random, 2p | ~18 min |
| 1,000 games, greedy vs greedy, with the AC-1 legality battery | **3 h 50 m** (12.6× the plain run) |
| An M3 agent in both seats | heavier than greedy in both directions — richer evaluation *and* self-play |

A tuning sweep of 30 variants × 500 games is plausibly a week of wall-clock on this box. And the
**AC-1 legality battery must be re-run against the M3 agent before promoting it** — it is
agent-specific and expires on every new version, and this is not a formality: the M1 run found a real
illegal-move defect at ~1 per 25 games that a 20-game batch could never have seen.

**The cheapest high-value action available right now** is to settle the compute story: run R7 on an
idle machine with ≥16 GB (`node build/agent/agent/src/runner/matchValidationCli.js --phase r7`), or
rent a box for the tuning runs, or explicitly adopt single-core budgets. Everything from M3's tuning
loop to M6's feasibility is currently sized off an unverified number.

---

## 8. There is no tuning loop, and the harness's agent model resists building one

The plan says: *"tune the weights against the match harness (start hand-set, then optimise)."* There
is no optimiser, no variant sweep, no experiment tracking — that's expected. The awkward part is that
the harness doesn't currently have a way to *hold* a variant.

An agent in the registry is a **name** plus a `create(seed)` function. Seed in, agent out — there is
no configuration parameter. The process pool spawns child processes and resolves agents by name from
command-line arguments, so a weight vector cannot be passed to a worker. The one escape hatch,
`withTemporaryAgent`, is deliberately narrow, mutates process-global state, and refuses to shadow an
existing name.

So today, seating "Nadia with weight vector A" against "Nadia with weight vector B" means either
registering both permanently or running single-process. That is exactly what a tuning loop needs to
do a few hundred times.

**Recommendation.** Make agent configuration a first-class, serializable object that the registry and
the pool both understand, before the first sweep rather than during it. Note the version discipline
still applies: a configuration that changes the move distribution is a new version for gate purposes,
even if the code didn't change.

---

## 9. Two content gaps that will bite the evaluator specifically

**Milestones and awards were never audited.** They fell outside the card-coverage audit's "cards and
corporations" wording. Measured Engine test coverage is **2 of 10 with a dedicated spec, 4 of 10 with
no test contact at all** — and the prior-art study the project drew on found milestones and awards to
be dominant win drivers. Milestone 3 is the first milestone that must reason about them explicitly,
and it is the first place where under-tested scoring rules can quietly cost games. This is also the
area where your own play knowledge is most valuable and least represented in the code: racing,
denial, and the timing of a claim are judgment, not arithmetic.

**204 declarative cards were never read against the printed cards.** The audit read all 73
logic-bearing cards; the declarative tail rests on indirect coverage only, and the independent
cross-check that would have caught a transcription error (a production value of 2 where the card
prints 1) was cut along with AC-8. There is a standing instruction already in the docs and it is the
right one: *if an M3 card valuation looks wrong for no reason, read that card's `behavior` block
before debugging the evaluator.*

**And eight catalogued Engine-vs-print divergences.** Immigrant City is playable at −4/−5 M€
production here; Decomposers over-grants via Ecology Experts; two cards are net-zero no-ops in
situations where the print isn't. The evaluator must be tuned to **the Engine's numbers, not the
printed ones** — that's correct for this project, and it will read as a bug to a human reviewer who
knows the cards. Each has a fixture asserting the Engine's value, carrying the printed value beside
it, precisely so nobody "fixes" it toward the card.

---

## 10. There is no external referent until M5 — and the M3 exit bar is weak

Milestone 3's exit criterion is ≥90% against random and ≥80% against greedy one-ply. Consider what
the greedy agent actually is:

- It already beats random-legal **99.2%** of the time.
- It **breaks ties at random on 75.9% of the decisions where it scored anything**, and the median
  decision has a score spread of **exactly 0 VP** — for half of all decisions every legal move looked
  identical to it.
- It values no production, no engine-building, no timing, no opponent, and is indifferent to
  corporation choice, initial cards and every research buy.

Beating that 80% of the time is a competence check, not evidence of skill. And the risk register is
explicit that since AC-8 was withdrawn there is **no external referent at all** between now and the
first AC-4 human benchmark: every strength claim in M3 and M4 is relative to the project's own frozen
baselines.

Two things follow, and they are both yours rather than the code's:

- **You are the external referent for the next two milestones.** `agent/demo/spectate.ts` seats Nadia
  against herself in the Engine's real web UI at one move every two seconds, from a player's own
  view. Watching games and naming what looks wrong is not a nice-to-have here; until M5 it is the
  only signal that isn't self-referential. Worth a standing weekly slot.
- **Pull the first AC-4 human benchmark as early as possible**, and secure the strong human
  opponent/reviewer now. The register already recommends running it as early as M5's exit criterion
  allows — discovering a systematic gap at M5 is far cheaper than discovering it at M7. AC-4 and AC-6
  are two of the three criteria that *define* success for this project, and both depend on a person
  who has not yet been secured.

---

## 11. None of this runs in CI

The GitHub workflow lints `src` and `tests`, builds, and runs the Engine's test suite. It does not
lint `agent/`, does not run the agent's ~713 tests, and does not run the regression suite or the
determinism corpus. Every standing check the last two milestones built is manual and local.

That was tolerable while changes were infrequent and each one ended in a written adjudication. During
weight tuning, changes are frequent and small, and the standing checks are exactly what stops a
"harmless" refactor from moving a frozen baseline. Adding `agent` to the lint scope and running the
agent test suite plus `npm run regression` on push is a small change with a good return, and it
partially compensates for gap §1.

---

## What I'd keep in mind as director

1. **The nature of the work changes here.** M1 and M2 answered questions with a single right answer —
   is it legal, is it deterministic, is A stronger than B. M3 asks *how much is a heat production
   worth in generation 4* — a question about Terraforming Mars, with no oracle. Your play knowledge
   becomes the scarce input, and the code becomes a way of testing it.

2. **The project's ceremony has to scale down, deliberately.** Pre-committing criteria, adjudicating
   against them and writing it up is excellent and it is why the foundation is trustworthy. But M2
   had five bullets; M3 has a few hundred small judgments. Applying bullet-level ceremony to every
   weight will stall the milestone. Decide up front where the bar sits: feature *design*, the
   candidate-set changes of §2, and promotion gates keep the full treatment; individual weights get
   batch-level evidence and a line in the notes.

3. **Do not read a green regression run as "nothing changed."** It is blindest exactly where M3 will
   be working. A promotion gate is three separate instruments — `--legality` for AC-1, `rate -- gate`
   for AC-7, and the regression suite for unintended change — and the suite is the weakest of the
   three for this milestone.

4. **Sample size is decided before the run, not after.** And never report the games a variant was
   selected on. Those two habits buy most of the statistical protection available.

5. **Settle the compute question early.** It is one afternoon on a borrowed machine, and it is
   currently the load-bearing assumption under M3's tuning budget, M4's search budget and M6's
   feasibility.

6. **Watch games.** Weekly. It is the only outside opinion this project receives before Milestone 5.

7. **Keep the M5 stopping point alive in your head.** A strong classical agent is a real deliverable,
   and the decision gate after M5 is a genuine decision, not a formality.

---

## Suggested order of work before writing evaluation code

| # | Item | Why now |
| --- | --- | --- |
| 1 | Profile/version the candidate layer (§1) | One-way door. Cheap today, re-adjudication later. |
| 2 | Define the `Observation` seam; forbid `IGame` in strategy code, enforced by a spec (§4) | Every feature written before this has to be audited after it. |
| 3 | Make agent configuration first-class and poolable (§8) | Blocks the tuning loop entirely. |
| 4 | Decide the sub-decision policy during evaluation (§5) | Changes the cost model and therefore the schedule. |
| 5 | Settle compute: run R7 on a ≥16 GB idle host, or adopt single-core budgets (§7) | Every M3–M6 budget rests on it. |
| 6 | Add `agent` to lint + run the agent tests and the regression suite in CI (§11) | Partial cover for §1's blind spot. |
| 7 | Audit the 10 milestones and awards (§9) | M3 is the first milestone that must reason about them. |
| 8 | Secure the strong human opponent/reviewer (§10) | Two of the three defining criteria depend on a person. |

Items 1–4 are the ones I'd treat as genuinely blocking. 5–8 can run alongside the card-feature
schema work.
