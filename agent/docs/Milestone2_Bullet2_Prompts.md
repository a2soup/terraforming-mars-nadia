# Milestone 2, bullet 2 — unit prompts (the fixed baselines)

> **Plan bullet.** *"Implement fixed baselines: random-legal and a greedy one-ply agent (the OSLA
> equivalent from the prior-art paper). Record the paper's published reference numbers (default MCTS
> beats OSLA ~75%, random ~98%; OSLA beats random ~91%) as external sanity checks."*
> (`agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md`, Milestone 2.)

This document decomposes that bullet into four self-contained prompts for cold-start sessions, in the
house style (`agent/CLAUDE.md` §9). It carries what is already known so nothing is re-derived, the
hazards already located, the design decisions settled in advance, the criteria pre-committed *before*
any measurement, and a file-ownership table so parallel work never collides.

**Commit §1–§9 in their own commit, before any implementation code exists.** Bullets 5, 6, 7 and
bullet 1 all did this, and it is the only thing that makes "pre-committed" mean anything.

---

## 1. Scope — what this bullet is, and what it is not

**Is:**

- A **greedy one-ply agent** (`greedy-1ply@1`) seated in the bullet-1 match runner alongside the
  existing `random-legal@1`, both frozen as fixed baselines for every later strength claim.
- The three pieces of machinery that agent needs and that do not exist: **candidate-set
  enumeration**, an **instrument-safe forking service**, and the **save-history/replay** mechanism
  that makes unforkable decision points forkable.
- The **AC-1 legality re-run against `greedy-1ply@1`** — mandatory, per the standing caveat in
  `agent/CLAUDE.md` §6. This is the first agent version since the random-legal one, and it is the
  first agent that reaches candidate-move code paths random play never did.
- A recorded table of the **prior-art reference numbers** with a pre-committed statement of what
  would count as a discrepancy worth investigating.

**Is not:**

- Not the rating pipeline (bullet 3), not the expert-distribution report (bullet 4), not the
  regression seed set (bullet 5). No Elo, no significance machinery beyond a Wilson interval, which
  `match/runner.ts` already has.
- **Not a good agent, and not a step toward one.** The greedy baseline is deliberately myopic. Its
  weaknesses are the feature: the M3 heuristic's whole contribution is the thing this agent cannot
  see, and AC-3's "≥80% vs greedy one-ply" only measures that if the baseline stays dumb and frozen.
- **Not a heuristic evaluation function.** Nothing in this bullet may introduce a weight, a tuned
  term, or a hand-crafted feature. See §3.1.
- Not M4's search. The forking service built here is deliberately the *simplest thing that supports
  one ply*; ISMCTS, determinization, and belief maintenance stay in M4.

---

## 2. What is already known — do not re-derive any of this

### 2.1 The measurement half is already built and validated

Milestone 2 bullet 1 delivered the match runner (`agent/docs/Match_Runner.md`). Seating a new agent
is **one entry in `agent/src/agents/registry.ts`** — the file already reserves `'greedy-1ply'` in a
comment and explains the `version` discipline. Pairing groups, seat-permutation balancing,
`match/ranking.ts` (the real `GameEnd.vue` winner rule), artifacts, the process pool
(`npm run match:pool`) and the absorbed `--legality` mode all work and need no changes for their own
sake. What they *do* need is §3.2.

### 2.2 The enumerator returns one move, not a set

`agent/src/core/enumerator/` implements `DecisionEnumerator = (decision, rng, recurse) =>
InputResponse` — **exactly one uniformly-random legal move** per decision, generated through the
FR-ACT-4 factorization so the combinatorial cases are never materialized. Its own doc comment
(`enumerator/types.ts`) records that the candidate-set method was expected to arrive at M4. It
arrives here instead.

Facts about it that a candidate enumerator must preserve:

- **`payment` reduces to one canonical cheapest-legal allocation** (`payment.ts`,
  `cheapestLegalPayment` / `greedyPayment`), and the file's own note says a *set* of strategic
  payment variants is deferred to Milestone 3. **That deferral stands in this bullet** (§3.5) — it is
  what keeps candidate sets tractable.
- **`enumerateInitialCards` caps the initial project-card count at the chosen corporation's budget**
  (`composite.ts`, `affordableCardCount`). This is the defect the M1 AC-1 run found and fixed at
  1-per-25-games; do not undo it, and mirror it in the candidate path.
- `card` uses a partial Fisher–Yates over indices to draw a k-subset without touching the subset
  space. The candidate analogue of that factor is a **cap plus subsample**, not an expansion.

### 2.3 The replay mechanism is already written and already validated — as bench code

`agent/src/bench/forkCost.ts` (M1 bullet 5, sub-task D) implements and validated the exact strategy
this bullet needs: **restore the nearest quiescent (forkable) ancestor and replay the intervening
recorded decisions.** Do not design this from scratch. Read that file first. It supplies:

| Piece | What it is |
| --- | --- |
| `submitRecorded(player, response)` | The replay counterpart of `applyDecision`: `player.process(response)` plus the *guarded* deferred drain, deliberately **not** `applyDecision` (no `toModel`, no `enumerate`, and crucially no FR-9 fallback — a rejected replay step must surface as a divergence, not be silently substituted). |
| `replaySteps(restored, steps, stepMs)` | Walks recorded steps, checking the offered player matches, returning a typed `ReplayFailure`. |
| `validateReplay(restored, livePending, liveStable)` | Compares **both** `pendingSignature` and `stableStateOf` — bullet 4 established these fail independently, so checking one is not checking. |
| The rolling-ancestor pattern | A single carried snapshot, not a table — cheaper, and it is exactly search's snapshot-once/restore-many access pattern. |
| `copyResponse` | Recorded responses are replayed into many independently restored games; never share one object. |

**Measured, at the pin, on the compiled build:** effective fork cost **0.979 ms** median (raw restore
0.963 ms; replay adds **1.6%**), replay distance **median 0 / p95 3 / max 5**, and **26,026 fork
experiments with 100% exact reproduction**. Restore-many from one snapshot runs at **1,697/s** vs
1,061/s for independent clones. `restore`'s default `verify: 'pending'` costs **0.0001 ms** — free;
never disable it. Log-stripped snapshots roughly halve restore cost late-game and are rules-neutral
(bullet 4 proved this).

**The one thing `forkCost.ts` gets right that a re-implementation will get wrong:** it records the
response the **Engine accepted**, not the one the responder returned. When the FR-9 fallback fires,
the driver submits something else entirely, so the recorder overwrites from the `onFallback` hook.
The AC-1 run measured **8,480 responder throws across 1,500 games (~5.7 per game)** — this is not an
edge case, and `match/history.ts` has a long doc comment on the same trap.

### 2.4 Snapshot fidelity, and which points are unforkable

`assertSnapshotSafe` (`agent/src/engine/snapshot.ts`) rejects `RESEARCH`, `DRAFTING`,
`INITIALDRAFTING`, `PRELUDES`, `CEOS`, and any game with a non-empty `deferredActions` queue.
Separately, **28.0% of decision points do not naively round-trip**, and the action-phase failures are
**100% silent** — `stableState` matches byte-for-byte while the pending decision is quietly replaced.
`forkCost.ts` therefore uses a stricter operational definition than the phase guard: a point is
`forkable` only if `assertSnapshotSafe` accepts it **and** `restore(snap, {verify: 'pending'})`
returns without throwing.

### 2.5 A restored game shares its `id` with the original

`restore()` calls `Game.deserialize` on a copy of the serialized state, and the id is part of that
state. **A fork and its original are two `IGame` objects with the same `game.id`.** Anything that
needs to tell a real game from a speculative one must use **object identity**, never the id. (Related
standing hazard, `agent/CLAUDE.md` §6: the shared `g-nadia-${seed}` id omits the player count, and is
"unreachable" only because embedded play never calls `GameLoader.add()`.)

### 2.6 The scoring function already exists in the Engine, and works mid-game

`player.getVictoryPoints()` → `src/server/game/calculateVictoryPoints.ts` is a **side-effect-free**
function of live state. Its `total` counts, for in-scope modules:

- **Terraform rating** (so TR is already inside VP — TR-vs-VP was never a real fork).
- **Card victory points** from the tableau, via each card's own `getVictoryPoints(player)`.
- **Claimed milestones: 5 each**, from `game.claimedMilestones`.
- **Funded awards**, scored against *current* standings via `AwardScorer` — so an award you fund
  while leading it scores immediately.
- **Greenery tiles: 1 each**, plus **1 for each of your own cities adjacent to any greenery**.

That last clause matters more than it looks: it means **board placement is not VP-neutral**, which is
most of what saves points-now from indifference. See §3.1.

### 2.7 The turn boundary is a real Engine field

`player.actionsTakenThisRound` (`src/server/Player.ts:125`) is incremented in `takeAction`
(`Player.ts:1550`), immediately before the "Take your first action" / "Take your next action" input
is built (`Player.ts:1556`). This is the signal the drain rule keys on (§3.4).

### 2.8 Cost, for planning the runs

Per-decision cost of random-legal play is **0.0927 ms**; a 2p game is **20.7 ms** median,
~223 decisions. A greedy decision costs roughly `candidates × (fork + drain + score)`, so expect
**2–3 orders of magnitude** more per game. Plan every validation run for the pool
(`npm run match:pool`), and read the standing warning in `agent/CLAUDE.md` §6 before believing any
throughput number from the measurement host — **check `sysctl vm.swapusage` and free memory first.**
Any performance figure comes from the compiled build; **`tsx` understates the simulator ~3.5×**.

---

## 3. Design decisions settled here — implement these, do not re-litigate them

These were settled in a strategy session before this document was written. Each records *why*,
because the reason is the part that stops a later session from quietly reversing it.

### 3.1 The objective: points-now, victory points only, ties broken by the seeded RNG

**The agent maximizes its own `player.getVictoryPoints().total` in the position reached after its
candidate move is applied and drained (§3.4). Ties are broken uniformly at random from the seeded
agent RNG. There is no second term.**

Why each half of that:

- **Points-now, not points-plus-economy.** This is the OSLA equivalent, and the prior-art paper's
  heuristic is characterized in our own SRS as the myopic "points now" one. More importantly, M3's
  entire contribution is valuing production, engine-building and timing. A baseline that already
  values production makes AC-3's "≥80% vs greedy one-ply" measure something other than what it was
  written to measure, and turns a frozen yardstick into a moving target.
- **The Engine's own score function, not a re-derived one.** `getVictoryPoints()` is the Engine's
  code over the Engine's state (SRS CON-1). There is no rule to get wrong and nothing to maintain.
- **No megacredit tiebreak** — and this is the non-obvious part. `match/ranking.ts` breaks VP ties on
  megacredits because that is the rule for ranking *finished games*. Inside a move chooser the same
  term is not a tiebreak, it is a **spending penalty**: every candidate that costs money would score
  strictly below passing. Followed through, that agent buys zero cards at initial selection, buys
  zero cards at every research phase, and therefore **never plays a project card in its entire
  life** — an agent whose action space is standard projects only. That is not myopic-but-recognizable
  play, it is a crippled agent, and it would make both the AC-3 bar and the prior-art comparison
  meaningless. Drop the term.
- **Own VP, not margin over the best opponent.** Margin is the better objective and is exactly the
  kind of thing M3 gets to explore. Keep the baseline dumb.

**What this predicts the agent will actually do** (recorded here so §5's diagnostics can falsify it):
claim milestones eagerly (+5 immediately); fund awards it currently leads; raise TR at every
opportunity, including via standard projects; place greeneries adjacent to its own cities (+2 rather
than +1, §2.6); play cards with printed VP; and be **indifferent — i.e. random — across corporation
choice, initial card purchases, and every research-phase buy**, all of which are VP-neutral at the
moment of choosing.

**No escalation, and this is deliberate.** An earlier draft of this design proposed a pre-committed
tiebreak ladder to fall back on if points-now proved too indifferent. Dropping the megacredit term
removes the degenerate failure mode that ladder existed to catch, so the ladder is gone and is
replaced by a rule: **if the greedy baseline turns out to be only weakly better than random, that is
a finding to record, not a defect to tune away.** Adding terms after seeing the number is fitting a
baseline to a foreign engine's published figure, which is precisely what SRS FR-DATA-1..5 and
`agent/CLAUDE.md` §8 forbid. Whether the baseline needs strengthening is a decision for M3, when the
AC-3 bar is actually used, made with the diagnostics of §5 in hand.

### 3.2 Fork safety is the blocking precondition, and it is not optional

`legality/submissionMonitor.ts` observes submissions by wrapping **`Player.prototype.process`** — a
prototype patch, so it is process-global and sees every `Player` in the process, including the
players of every cloned game. `match/history.ts` records at the same boundary, for the same
well-argued reason.

The moment an agent forks, **every speculative move it submits inside a clone flows through those
instruments.** Unaddressed, this means:

- `--legality` counts tens of thousands of speculative submissions — including deliberately rejected
  probes — as real moves in real games. That is the **promotion gate for AC-1**, which
  `agent/CLAUDE.md` §6 requires be re-run against every promoted agent version from here on. It would
  report garbage for `greedy-1ply` and for every M4/M5/M6 agent after it.
- Recorded histories contain moves that were never played.

**The fix: a speculation registry keyed on object identity** (§2.5 — the id is useless), living in
its own module, with `SubmissionMonitor` and the history instrument each consulting it in a
three-line early return. Speculative submissions pass straight through to the original `process` and
are counted nowhere.

Two constraints on the fix:

- **`legality/runLegalityBatch` — the M1 artifact-of-record and R8's oracle — is not touched.** The
  R8 equivalence check must be re-run and must still produce **identical** values on all nine
  counters for `random-legal`, and `checkInstrumentationNeutrality` must still pass. A guard that
  changes what the instrument counts for a non-forking agent is a blocking failure.
- **The guard must be positive, not by convention.** Register the forked `IGame` in a `WeakSet` at
  the moment `restore()` produces it inside the fork service; do not rely on a "we are currently
  speculating" flag alone. A flag cannot distinguish a speculative submission from a bug in which the
  agent submits to the *live* game mid-search — and that bug, if it happened, would be silent and
  catastrophic. Carry the flag too, as a **cross-check**: a submission to a non-speculative game
  while speculation is in progress is a defect, and should throw.

### 3.3 Save-history/replay is moved up from M4 — and the honest reason is not the obvious one

The M1 wrap-up deferred in-memory save history to M4, alongside the replay-from-quiescent-ancestor
mechanism. **This bullet moves it up.** But the justification has to be stated accurately, because
the obvious one does not survive contact with §3.1:

The obvious claim would be "so greedy can play the opening and the research phases greedily." Under
points-now that claim is **false**. Corporation choice is a tie (every in-scope corporation starts at
the same TR — *verify this against the pin; it is the claim that makes the tie*), initial card
purchases are VP-neutral, and research buys are VP-neutral. Three of the four unforkable populations
give the greedy agent nothing to be greedy about, and it will tie-break randomly through all of them
whether or not it can fork there.

The three reasons that *do* hold:

1. **Preludes are not neutral.** Preludes granting immediate TR score strictly higher, and the
   opening prelude pair is a large swing. This is real signal in a phase `assertSnapshotSafe`
   currently refuses.
2. **M4 de-risking, which is the main one.** Building this mechanism now, with one simple
   deterministic consumer whose every decision can be diffed, is far better than building it under
   ISMCTS where a fidelity bug hides inside a stochastic search and shows up as "the search is
   somehow weak."
3. **It is cheaper than "moving up M4 work" sounds** — §2.3. The mechanism exists, was run 26,026
   times with 100% reproduction, and the two traps around it (record the *accepted* response;
   validate both ways) are already mapped in prose.

**Do not carry the false claim into the write-up.** The validation will show the opening is still
effectively random, and a document that promised otherwise reads as a failure when it is a
prediction.

**Scope limit:** what is built here is a *rolling ancestor plus recorded accepted responses for the
current game*, sufficient to fork at an arbitrary decision point. It is not a general save/restore
API, not a game-tree store, and not the M4 belief/determinization layer.

### 3.4 Evaluation happens after draining to the agent's next real decision

A single `InputResponse` does not produce an evaluable position: playing a card cascades into tile
placement, resource choices, and deferred actions, all still belonging to the same player. Scoring
immediately after submission scores a half-resolved position — card paid for, tile not yet placed.

**The rule.** After submitting a candidate into the fork, run the guarded drain (`submitRecorded`'s,
verbatim — §2.3), then continue responding **with random-legal** while all of these hold, and stop at
the first that fails:

1. the game is not at `Phase.END`;
2. the next waiting player is **this agent's own player**;
3. the move has not completed — in `Phase.ACTION`, `player.actionsTakenThisRound` has not advanced
   past the value captured **before** the candidate was submitted (§2.7); outside `Phase.ACTION`, the
   phase has not changed;
4. the drain step budget (pre-committed, §5 G7) is not exhausted.

Then score.

Three things this rule is carefully doing:

- **Never drain through an opponent's decision.** Standing random-legal in for the opponent would
  score every candidate against a randomly-played reply — opponent modelling by accident, and a large
  source of noise.
- **Never drain into the agent's own *next* action.** Condition 3 is the boundary between "finish
  resolving the move I just made" and "start making a new one." Getting this wrong turns a one-ply
  agent into a random-two-ply agent and multiplies its cost.
- **Common random numbers.** The intervening sub-decisions are resolved by random-legal, so a
  candidate's score partly reflects a coin flip — which space the tile landed on, which resource was
  taken. **Reset the drain RNG to the same per-decision seed before each candidate**, so every
  candidate is compared under identical sampled sub-choices. Without this the argmax is substantially
  noise, and the result would look like a weak baseline when it is a noisy measurement. Derive the
  per-decision seed from the agent's own seeded stream; do not touch the Engine seed (SRS CON-5).

### 3.5 Candidate enumeration adds, never modifies

The candidate path goes in **new files** (`agent/src/core/candidates/`), importing from and mirroring
`core/enumerator/` without editing it. Two reasons, both hard:

- **The committed 300-fingerprint determinism corpus.** `agent/CLAUDE.md` §6 records that the corpus
  must be regenerated after any enumerator change — the M1 `initialCards` cap changed 43 of its 300
  configs. A candidate API that leaves `enumerate` byte-identical costs nothing; one that refactors
  the sampling path costs a corpus regeneration and destroys this bullet's ability to tell a real
  regression from its own churn. §5 G1 makes this a criterion.
- `random-legal@1`'s move distribution must not change, or its `version` is a lie and every M1
  number — including AC-1 — stops describing the agent in the registry.

**Reductions, per decision type, pre-committed:**

| Type | Candidate set |
| --- | --- |
| `option` | The single legal response. |
| `space`, `player`, `resource` | Every offered element. These are short lists and, per §2.6, `space` is genuinely VP-bearing. |
| `amount` | `min`, `max`, and up to 6 evenly-spaced interior values. Ranges are usually tiny; the cap bounds the pathological case. |
| `card` | Every k-subset is combinatorial. Enumerate **singletons plus the minimum-size and maximum-size subsets**, then uniformly subsample to the cap. |
| `payment` | The **one** canonical cheapest-legal allocation (§2.2). Payment variants remain M3's job. |
| `projectCard` | One candidate per playable card (hand cards and standard projects), each paired with its canonical payment. This is the important set — it is where most of the agent's strength lives. |
| `or` | One candidate per branch, with the branch's own contents produced by **one sampled** child response, not a cross-product. |
| `and` | One candidate: each child sampled once. A cross-product here buys almost nothing and is unbounded. |
| `initialCards` | Corporation × card-count, with the §2.2 budget cap enforced; cards themselves sampled. |
| `resources`, `productionToLose` | Sample up to the cap from `sampleBoundedComposition`'s distribution rather than enumerating compositions. |

**A global cap of 64 candidates per decision**, with uniform subsampling beyond it and the number of
capped decisions recorded in the artifact. Pre-committed here so it is a design parameter and not a
performance patch applied after seeing a slow run.

**Every candidate must be legal on first submission.** That is the same definition the M1 enumerator
tests use (the Engine's own `process()`, not our belief about the rules), and it is G1.

### 3.6 What the prior-art numbers can and cannot check

Recorded reference figures (SRS §1.5; Gaina, Goodman, Perez-Liebana, *TAG: Terraforming Mars*, AIIDE
2021): **default MCTS beats OSLA ~75%; MCTS beats random ~98%; OSLA beats random ~91%.**

- **Only the third is checkable at M2.** The other two require an MCTS agent that does not exist
  until M4. Record all three; adjudicate one.
- **TAG is a different engine** — base + Corporate Era only (no Prelude, which *is* in our scope), a
  few cards unimplemented, acknowledged rule simplifications, and a different OSLA heuristic. A
  mismatch is expected and is **not** evidence of a defect here.
- **Pre-committed interpretation rule**, so "external sanity check" does not degrade into a number
  nobody can act on:
  - Greedy beating random **at all, with significance** is the criterion (G5).
  - A result **inside 80–97%** is consistent with the reference and needs no further comment.
  - A result **below 80%** or **above 97%** is a *discrepancy worth investigating* — investigated by
    reading the diagnostics of G7 and the behavioural predictions of §3.1, and reported honestly
    whether or not it resolves. It is **not** grounds for changing the objective (§3.1).
  - The MCTS rows are carried forward untouched and revisited at M4.

---

## 4. Hazards already located — hand these to the units, don't rediscover them

- **H1 — The prototype wrapper sees clones.** §3.2. The blocking one.
- **H2 — A fork and its original share `game.id`.** §2.5. Any identity check on the id is silently
  wrong. Use object identity.
- **H3 — Recording the responder's return value records moves that were never played.** The FR-9
  fallback substitutes a different response, and a responder that *throws* returns nothing at all
  (~5.7 times per game). Record the **accepted** response, via `onFallback`. `forkCost.ts` and
  `match/history.ts` both solved this; copy them.
- **H4 — The registry's `create(seed) => EmbeddedResponder` has nowhere to hang a driver hook.** The
  fork service needs `onFallback` to record accepted responses, and it must see **every** player's
  decisions (the ancestor walk replays opponents' moves too), which a responder alone cannot. The
  registry entry and `playMatchGame` need a small, explicit extension so an agent can contribute
  driver options. This is a real interface change to bullet-1 files — Unit A owns it, and it must not
  change behaviour for agents that supply nothing.
- **H5 — `restore()` must keep `verify: 'pending'`.** It costs 0.0001 ms and it is the only thing
  that catches a silently regenerated pending decision. Never pass `verify: 'none'` to buy speed.
- **H6 — Replay must not go through `applyDecision`.** The FR-9 fallback would silently substitute a
  legal move and the replay would look successful having taken a different path. Use
  `submitRecorded`'s semantics, including its **guarded** drain — the guard is the fix for a real
  driver bug (an unconditional `runAll()` overwriting a freshly-set `waitingFor`).
- **H7 — Validate a fork both ways.** `pendingSignature` **and** `stableStateOf`. Bullet 4 spent a
  whole sub-task establishing that these fail independently.
- **H8 — Do not construct `SeededRandom` directly** (M1 hazard H6); go through `createAgentRandom`.
  Engine seed and agent seed stay separate (SRS CON-5), and the drain's common-random-numbers seed
  (§3.4) is derived from the agent stream, never the Engine's.
- **H9 — `Game.gotoEndGame()` is unawaited async**, so a synchronous batch loop holds every finished
  game alive (~0.27 MB). Greedy runs are long; yield between games, and force a collection before any
  heap sample.
- **H10 — Timing from `tsx` is not a performance figure** (~3.5× understated). Compiled build only,
  and check host swap first (§2.8).

---

## 5. Pre-committed criteria — write these down before any number arrives

G1–G9 are what "bullet 2 is done" means.

- **G1 — Candidate enumeration is legal and additive.**
  - **G1a (legality):** over ≥ 200 real games with every candidate set generated at every in-scope
    decision, **every candidate is accepted by the Engine's own `process()` on first submission.**
    Measured, not asserted from the type system.
  - **G1b (additivity):** `npm run determinism -- --verify docs/data/determinism_corpus.json` passes
    against the **unchanged committed corpus**, and `random-legal@1`'s recorded move-trace hashes are
    unchanged. Any corpus change is a blocking failure, not a regeneration (§3.5).
  - **G1c (coverage):** every in-scope decision type in `SCOPE` has a candidate enumerator and is
    exercised at least once by the G1a corpus. Types not reached are named, not silently absent.
- **G2 — Fork safety, proven three ways.**
  - **G2a (equivalence preserved):** with the guard installed, the R8 check — match runner
    `--legality` vs `runLegalityBatch` over the same ≥ 50 shared configs — still reports **identical**
    values on all nine adjudicated counters for `random-legal`. `checkInstrumentationNeutrality`
    passes.
  - **G2b (negative control):** a run with `greedy-1ply` seated, executed twice — once with the guard
    and once with speculative submissions deliberately counted — shows a **large** difference in
    `submissions`, and the guarded figure matches the count of decisions actually played. A test that
    cannot show the guard doing anything has not tested it.
  - **G2c (cross-check fires):** a deliberately induced submission to the live game during
    speculation throws (§3.2).
- **G3 — Fork fidelity in production.** Over a sampled ≥ 5% of greedy decisions across ≥ 100 games,
  every fork is validated with `pendingSignature` **and** `stableStateOf` against the live original.
  **Zero silent divergences.** Report forkability coverage: the fraction of greedy decisions where a
  fork was obtainable, with and without ancestor replay — the "without" figure is the ~72% baseline
  §2.4 predicts, and the gap is what §3.3 bought.
- **G4 — AC-1 for `greedy-1ply@1`.** ≥ 1,000 consecutive embedded games with `greedy-1ply` in every
  seat, under `--legality`: 1,000 completed, zero unhandled errors, **zero Agent-attributable
  illegal-move rejections** across all submissions. Adjudicated on the strict counters, not on the
  driver's `onFallback` counts (`agent/CLAUDE.md` §6 says why). Plus 3p/4p smoke completion.
- **G5 — Greedy beats random at 2p, with significance.** ≥ 500 pairing groups (= 1,000 games),
  `greedy-1ply` vs `random-legal`, distinct agent seeds. Report the `bySlot` win rate with a 95%
  Wilson interval, and the `bySeat` rate beside it. **Criterion: the interval lies entirely above
  50%.** The ~91% reference is compared against per §3.6's interpretation rule and is **not** a
  target.
- **G6 — Greedy is reproducible.** Two runs of an identical match specification — same process and
  fresh process — produce identical per-game records modulo the declared timing fields, on ≥ 20 groups
  at 2p and ≥ 10 at 3p. This is R2 restated for a stochastic-tie-breaking agent, and it is the check
  that the common-random-numbers seeding (§3.4) is actually deterministic.
- **G7 — Diagnostics are reported, not optional.** Every greedy run records, and the write-up
  publishes:
  - the **tie-break fraction**: proportion of decisions where the winning score was shared by more
    than one candidate and the choice was therefore random. *This is the single most informative
    number in the bullet* — it measures how much of "greedy" is actually greedy (§3.1).
  - candidate-count distribution (median, p95, max) and the count of decisions hitting the 64 cap;
  - fork-unavailable count and the fallback taken;
  - drain steps per candidate (median, p95) and drain-budget overruns — **pre-committed budget: 32
    steps**, with every overrun counted and reported rather than swallowed;
  - decisions/s and games/s on the compiled build, with host swap state recorded (§2.8).
- **G8 — 3p and 4p.** `greedy-1ply` completes at 3p (≥ 100 groups) and 4p (≥ 25 groups) against
  `random-legal`, with **placement** recorded per seat and the first-place rate reported against the
  1/N baseline.
- **G9 — The reference table is recorded with its interpretation rule**, all three rows, per §3.6,
  including the two rows that cannot be adjudicated until M4 and are marked as such.

**Non-criteria, stated so they are not smuggled in.** This bullet does not compute Elo, does not
claim `greedy-1ply` is a strong agent, does not compare anything to the expert dataset, does not tune
any parameter to any published figure, and does not claim the M4 search mechanism is finished — only
that its fork/replay substrate exists and is validated under one simple consumer.

---

## 6. Structure — four units, and why this shape

`(A, B) → C → D`.

Applying `agent/CLAUDE.md` §9's own tests:

- **Is there a real "do this first" dependency?** Two of them, and they are independent of each
  other. **A** (fork service + instrument safety) and **B** (candidate enumeration) share no files,
  no objects and no hazards: A lives in `search/`, `legality/`, `match/`, `agents/` and keys off
  snapshot/restore and the prototype wrappers; B lives in `core/candidates/` and keys off the
  `PlayerInputModel` union. They genuinely parallelize. **C** (the agent) needs both.
- **Are A and B comparable in size?** Yes — A is ~350 lines plus a demanding verification burden
  (G2's three proofs, re-running R8), B is ~450 lines plus heavy per-type specs. Neither is the
  spine; the bullet has two.
- **Why is A one unit and not two?** "Make forks possible" and "make forks invisible to the
  instruments" key off exactly the same objects — the same `IGame` clones, the same
  `Player.prototype.process` boundary, the same `WeakSet`. Splitting them buys a cold start on shared
  material and creates an ordering hazard where the fork service exists for a session before anything
  stops it corrupting the AC-1 counters. Merge.
- **Why does C get its own session when it is the fewest lines?** Because it is the most judgment per
  line. The drain boundary (§3.4), the common-random-numbers seeding, the scoring call, and the
  unforkable-point fallback are four decisions where a plausible-looking wrong answer produces an
  agent that *works*, plays legally, and is quietly measuring the wrong thing. Appended to the end of
  A or B it becomes the last item in a long unit and gets the obvious implementation.
- **What warrants its own session regardless?** D: it edits the source-of-truth documents (one
  writer, always), it runs the long compute, and it is pure judgment over the other units' output.

**Why not a fifth unit for the AC-1 re-run:** it is a mode flag on a run D is already doing, and its
adjudication belongs with the rest of the adjudication.

---

## 7. Routing — scale and which model to run each unit on

| Unit | Scale | Model | Why that model |
| --- | --- | --- | --- |
| **A** — fork service, save-history/replay, speculation registry, instrument guard, registry/runner plumbing | ~350 lines across ~3 new files + ~5 small edits to existing ones; ~300 lines of spec; two verification runs (~10 min) | **Opus** | It modifies instrumentation that bullet 1 certified counter-for-counter against the M1 oracle, and the thing it protects is the AC-1 promotion gate for **every future agent version**. The failure mode is not a crash — it is a legality number that stays plausible while counting speculative probes as real moves. G2b (the negative control) is the kind of test a cheap run declares unnecessary. |
| **B** — candidate enumeration for all 13 in-scope decision types | ~450 lines across ~4 new files + ~400 lines of spec; ~200 games of validation compute | **Opus** | The reductions in §3.5 are the FR-ACT-4 factorization applied a second time, for a different purpose, and a candidate set that is merely *legal* but systematically omits the strong moves produces a baseline that looks weak for reasons nobody can see. Also carries the "add, never modify" constraint (G1b), which is easy to violate while tidying. |
| **C** — the greedy one-ply agent | ~200 lines + ~250 lines of spec | **Opus** | Highest judgment-to-line ratio in the bullet. §3.4's drain boundary in particular has a wrong answer (drain until the next decision, whoever's it is) that is simpler, passes tests, runs fine, and silently makes the agent score every move against a randomly-played opponent reply. |
| **D** — validation runs, AC-1 re-run, adjudication, write-up, document updates | ~4–6 h of pooled compiled compute; ~500-line deliverable + edits to 4 documents | **Opus** | Judgment over other units' output plus edits to the SRS and Implementation Plan. Two specific traps: reporting the greedy-vs-random figure without the tie-break fraction beside it, and quietly repairing the objective if the number disappoints (§3.1). |

**There is no Sonnet unit in this bullet, and that is the finding.** Bullet 1 had one — the process
pool, which was mechanical fan-out over an existing config list with prior art to copy. Bullet 2 has
no comparable unit: every piece of it either changes certified measurement infrastructure, decides a
reduction that shapes what the baseline can see, or interprets a number. This is the concrete sense
in which this bullet is harder than the ones before it: not more code, but no cheap code.

---

## 8. File ownership, so parallel work never collides

| File | Owner | Note |
| --- | --- | --- |
| `agent/src/search/speculation.ts` | A | new — the `WeakSet` registry, `isSpeculative(game)`, the speculation-in-progress cross-check |
| `agent/src/search/fork.ts` | A | new — rolling ancestor, recorded accepted responses, `forkAt()`; productionizes `bench/forkCost.ts`'s validated mechanism |
| `agent/src/legality/submissionMonitor.ts` | A | **edit** — the early-return guard only. Bullet 1's "nobody edits `legality/`" rule is lifted *for this file, for this guard only*. `run.ts`/`runLegalityBatch` (the R8 oracle) stays untouched. |
| `agent/src/match/history.ts` | A | **edit** — the same guard at the same boundary |
| `agent/src/agents/registry.ts` | A | **edit** — the `AgentEntry` extension for driver options (H4). A does the plumbing; **C adds the `greedy-1ply` entry** (different region, and C runs after A) |
| `agent/src/match/runner.ts` | A | **edit** — thread agent-supplied driver options through `playMatchGame`; no behaviour change when none are supplied |
| `agent/test/search/*.spec.ts`, `agent/test/match/legality.spec.ts` (additions) | A | |
| `agent/src/core/candidates/{index,simple,payment,composite}.ts` | B | new — mirrors `core/enumerator/`, imports it, edits none of it |
| `agent/test/core/candidates/*.spec.ts` | B | |
| `agent/src/core/greedyOnePlyAgent.ts` | C | new |
| `agent/src/agents/registry.ts` (the `greedy-1ply` entry) | C | after A |
| `agent/test/core/greedyOnePlyAgent.spec.ts` | C | |
| `agent/docs/Baselines.md` | D | the deliverable |
| `agent/docs/data/baselines_validation.json` | D | the validation artifact |
| `agent/docs/Running_Notes.md` | D | one dated entry |
| `agent/CLAUDE.md`, `agent/docs/Terraforming_Mars_AI_SRS_v1.2.md`, `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md` | D | one writer, always |

**Nobody edits:** anything under `src/` (CON-1); `agent/src/driver/`, `agent/src/engine/`,
`agent/src/core/enumerator/`, `agent/src/determinism/`, `agent/src/bench/`, `agent/src/legality/run.ts`.
Read and import freely, wrap freely, modify nothing. If a unit believes it must modify one of these,
that is a finding to raise in Unit D, not a change to make.

---

## 9. Shared preamble — prepend to every unit prompt below

> You are working on **Nadia**, an expert-level Terraforming Mars AI agent built on top of the
> terraforming-mars engine in this same repository. Read `agent/CLAUDE.md` first; it orients you and
> points at the two source-of-truth documents (`agent/docs/Terraforming_Mars_AI_SRS_v1.2.md`, the
> SRS, and `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md`, the Implementation Plan).
> `agent/docs/Running_Notes.md` is a dated engineering log — read it for prior art before
> investigating anything that smells like it has been hit before.
>
> Milestone 1 is complete and Milestone 2 bullet 1 (the match runner,
> `agent/docs/Match_Runner.md`) is done. You are working on **Milestone 2, bullet 2: the fixed
> baselines.** The plan for this bullet is `agent/docs/Milestone2_Bullet2_Prompts.md` — **read it in
> full before writing any code.** §2 lists facts already established (do not re-derive them), §3
> settles the design decisions (implement them, do not re-litigate them), §4 lists hazards already
> located (do not rediscover them), §5 is the pre-committed criteria, and §8 says which files you own.
>
> Standing constraints:
> - **`src/` is immutable.** The Engine is rules ground truth (SRS CON-1). You never modify it, and
>   you never re-implement a rule the Engine already implements. The greedy agent's evaluation is the
>   Engine's own `player.getVictoryPoints()`, not a re-derived score.
> - **Never submit a move outside the Engine-presented legal set** (SRS CON-2), and never make the
>   agent read hidden state it could not legally have.
> - **Engine seed and Agent seed are controlled separately** (SRS CON-5). Do not derive one from the
>   other, and do not construct `SeededRandom` directly (hazard H8).
> - Instrument by wrapping, which is the technique every Milestone 1 bullet used. The one exception
>   in this bullet is the guard of §3.2, which is scoped in §8.
> - Follow the style of the code around you. The existing agent modules carry heavy explanatory doc
>   comments that record *why*, including the wrong turns; match that — it is the house style and it
>   is why Milestone 1's findings survived.
> - Run `npm test` in `agent/` (not the repo root). Any performance number comes from the compiled
>   build, never from `tsx` (hazard H10), and check host swap before believing it.

---

## Unit A — forking, made possible and made invisible

**Goal.** A fork service that can produce a speculative `IGame` positioned at *any* decision point of
a live game, and a guarantee that nothing submitted inside one is ever counted by the legality or
history instruments.

**Read first:** `agent/src/bench/forkCost.ts` in full (§2.3 — it is the validated prior art, not a
starting point to improve on), `agent/src/engine/snapshot.ts`,
`agent/src/legality/submissionMonitor.ts`, `agent/src/match/history.ts`.

### 1. The speculation registry (`agent/src/search/speculation.ts`)

Object-identity `WeakSet` of speculative games (H2 — the id is shared and useless). Exports
registration, `isSpeculative(game)`, and a scope helper that marks speculation as in progress. The
cross-check of §3.2 — a submission to a **non**-speculative game while speculation is in progress —
throws. Document why the flag alone is insufficient and why the `WeakSet` alone is not the whole
answer either.

### 2. The instrument guard

Three-line early returns in `submissionMonitor.ts` and `history.ts`: a speculative submission passes
straight through to the original `process` and is counted nowhere. Keep the logic in
`speculation.ts`; the instruments only consult it. **`legality/run.ts` is not touched** — it is R8's
oracle.

### 3. The fork service (`agent/src/search/fork.ts`)

Maintains, for one live game: a rolling nearest-forkable-ancestor snapshot and the list of **accepted**
responses since it (H3 — via `onFallback`, and copy responses per `copyResponse`). Exposes a fork at
the current decision point: restore the ancestor with `verify: 'pending'` (H5), replay with
`submitRecorded` semantics (H6), register the result as speculative, hand it back. Log-stripped
snapshots are the default for speculative use (§2.3). Validation (`pendingSignature` **and**
`stableStateOf`, H7) is available and sampled rather than always-on — G3 sets the rate; make the rate
a parameter and record it.

Returns a typed "no fork available" result rather than throwing, so the agent can take its fallback.

### 4. The plumbing (H4)

`AgentEntry` gains an optional way to contribute `EmbeddedDriverOptions`; `playMatchGame` merges them.
**No behaviour change when an agent supplies none** — prove it: `random-legal`'s artifacts for an
identical spec must be byte-identical before and after, modulo declared timing fields.

### 5. Prove G2

All three parts. G2b (the negative control) is the one that matters: a run where speculative
submissions are deliberately counted, beside the guarded run, showing a large difference. Re-run the
R8 equivalence check (`match/legality.ts`'s existing machinery) and
`checkInstrumentationNeutrality`; **identical values on all nine counters or stop and report**.

---

## Unit B — candidate-set enumeration

**Goal.** For every in-scope decision, a bounded set of legal candidate moves, generated through the
FR-ACT-4 factorization, in new files that leave `core/enumerator/` untouched.

**Read first:** all of `agent/src/core/enumerator/` (`types.ts` for the contract and the
factorization rules, then `simple.ts`, `payment.ts`, `composite.ts`), and the M1 sub-task notes they
reference.

### 1. The candidate contract (`agent/src/core/candidates/index.ts`)

Mirror the enumerator's dispatch: a total `Record` over the `PlayerInputModel` union so a new decision
type at a future pin fails to compile rather than being silently mis-routed. Same `NotYetImplemented`
/ `OutOfScope` error split. The recursion entry point mirrors `EnumerateFn`.

### 2. Per-type candidate generators

Implement §3.5's table exactly. Two rules that carry the unit:

- **Candidates are legal by the Engine's definition** — accepted by `process()` on first submission —
  not by our reading of the rules. Every spec asserts against `process()`, exactly as the M1
  enumerator specs do.
- **Never materialize a cross-product.** Where the naive set is combinatorial, the candidate set is
  over *one* factor with the others sampled, and the doc comment says which factor and why. `payment`
  stays canonical-cheapest (§2.2); do not "improve" it here.

Mirror `enumerateInitialCards`' corporation-budget cap (§2.2) — it exists because the M1 AC-1 run
found real illegal moves without it.

### 3. The 64-candidate cap

Global, uniform subsample beyond it, count of capped decisions exposed for the artifact (G7).

### 4. Prove G1

G1a over ≥ 200 real games: generate every candidate set at every decision and submit each candidate
into a throwaway fork to confirm the Engine accepts it. G1b is the one to run *last and loudly*:
`npm run determinism -- --verify docs/data/determinism_corpus.json` against the **unchanged** committed
corpus. If it fails, you modified the sampling path; revert rather than regenerate. G1c: name any
in-scope type the corpus never reached.

---

## Unit C — the greedy one-ply agent

**Goal.** `greedy-1ply@1` in the registry: at every decision, evaluate each candidate by the position
it reaches, and play the argmax.

**Read first:** §3.1 and §3.4 of this plan, `agent/src/core/randomLegalAgent.ts` (the FR-9 fallback
shape you must preserve), and Units A and B's delivered interfaces.

### 1. The agent

For each decision: get candidates (B), snapshot-once/fork-many (A), apply, drain per §3.4, score with
`player.getVictoryPoints().total` for **this agent's own player**, take the argmax, break ties
uniformly from the seeded agent RNG.

Non-negotiable details, each with a wrong answer that works:

- **Common random numbers.** Reset the drain RNG to the same per-decision seed before every candidate
  (§3.4). Derive it from the agent's stream (H8).
- **The drain boundary** is §3.4's four conditions. Verify condition 3 against the Engine —
  `actionsTakenThisRound` (§2.7) — rather than assuming; if it does not behave as described at the
  pin, that is a finding for Unit D, and the conservative reading (stop earlier) is the safe one.
- **Score the *drained* position**, and score it in the fork, never in the live game.
- **Fallback:** when no fork is available, or the drain budget is exhausted, or a candidate throws,
  fall back to the random-legal move for that decision and **count it**. Never stall, never error
  (SRS FR-9). Keep `randomLegalAgent`'s existing conservative-resubmission behaviour intact.

### 2. Registry entry

`greedy-1ply@1`, with a description that says what it maximizes and — briefly — what it deliberately
ignores. Read the `version` discipline in `registry.ts`'s doc comment and honour it.

### 3. Diagnostics (G7)

The agent is the only place that knows the tie-break fraction, candidate counts, cap hits, drain steps
and fork-unavailable counts. Emit them through a structured per-decision record at configurable
verbosity (SRS FR-11, NFR-6) so Unit D can aggregate without re-running anything.

### 4. Sanity, before handing to D

A short run (~20 games at 2p vs `random-legal`) confirming completion, a non-trivial tie-break
fraction, and games/s on the compiled build — enough for D to size its runs. **Do not adjudicate G5
here**, and do not react to the win rate.

---

## Unit D — validation, adjudication, and the write-up

**Goal.** Run the measurements, adjudicate G1–G9 one at a time, and write the deliverable.

### 1. The runs

Pooled, compiled build, host swap checked and recorded (§2.8, H10):

| Run | Spec | Feeds |
| --- | --- | --- |
| Greedy vs random, 2p | ≥ 500 groups (1,000 games) | G5, G7, G3 |
| Greedy vs greedy, 2p, `--legality` | ≥ 500 groups (1,000 games) | **G4 (AC-1)**, G2b |
| Greedy vs random, 3p | ≥ 100 groups (600 games) | G8 |
| Greedy vs random, 4p | ≥ 25 groups (100 games) | G8 |
| Reproducibility | ≥ 20 groups 2p, ≥ 10 groups 3p, same process and fresh | G6 |

### 2. Adjudicate G1–G9 one at a time

Each gets its number, its verdict, and — where it was not met — what that costs and what it does not
cost. G4 is adjudicated on the **strict** legality counters, not the driver's `onFallback` counts
(`agent/CLAUDE.md` §6 explains why they are not the same accounting).

### 3. Deliverables

- `agent/docs/Baselines.md` — the results document: what the baselines are, the frozen objective and
  why (§3.1), the reference-number table with §3.6's interpretation rule, every G-criterion
  adjudicated, and the diagnostics.
- `agent/docs/data/baselines_validation.json` — the artifact.
- One dated `Running_Notes.md` entry with what the Engine taught you that the plan got wrong.
- Updates to `agent/CLAUDE.md` §6 (status, and the standing-caveat entry recording that AC-1 now
  holds for `greedy-1ply@1` as well as `random-legal@1`), and to the SRS / Implementation Plan where
  this bullet closes or changes something.

### 4. Four things to resist

- **Reporting the greedy-vs-random win rate without the tie-break fraction beside it.** They are one
  result. A 90% win rate with an 80% tie-break fraction means something very different from a 90% win
  rate with a 10% one, and only the second is a greedy agent.
- **Repairing the objective if the number disappoints.** §3.1. Record the finding.
- **Claiming §3.3's false benefit.** The write-up says plainly that the opening and research phases
  remain effectively random under points-now, that this was predicted, and that the mechanism was
  built for preludes and for M4.
- **Treating a TAG mismatch as a defect.** §3.6. Different engine, different scope, different
  heuristic.

---

## Appendix — falsifiable predictions

Recorded before measurement so the validation can check the plan's own understanding, not just the
code's. Each is cheap to check from Unit C's per-decision records.

1. The tie-break fraction is **high** — most decisions will have several candidates sharing the top
   score, because most single moves change current VP by zero.
2. Corporation choice, initial card purchases and research-phase buys are **entirely tie-broken**
   (VP-neutral), so greedy's opening is statistically indistinguishable from random-legal's.
3. Prelude selection is **not** tie-broken where a prelude grants immediate TR.
4. Greedy claims milestones markedly earlier and more often than random-legal (+5 VP, immediately).
5. Greedy funds awards it currently leads, and rarely funds others.
6. Greedy's greeneries cluster adjacent to its own cities at a higher rate than random-legal's (+2
   rather than +1, §2.6).
7. Greedy's standard-project usage is high and its project-card play is *not* suppressed (this is the
   prediction that would have been false under a megacredit tiebreak, §3.1 — it is recorded as the
   check that the objective is the intended one).

A prediction that fails is a finding for the Running Notes, not an error to hide.
