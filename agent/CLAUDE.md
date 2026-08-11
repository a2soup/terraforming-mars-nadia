# CLAUDE.md — Nadia: an expert-level AI agent for Terraforming Mars

This file orients a Claude Code session working on the **Nadia AI agent**. It is generated
from the two source-of-truth documents and should be kept consistent with them:

- SRS: [docs/Terraforming_Mars_AI_SRS_v1.2.md](docs/Terraforming_Mars_AI_SRS_v1.2.md) — **currently v1.9**
- Implementation Plan: [docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md](docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md) — **currently v1.10**

> The `v1.2` in both **filenames is frozen and stale** — the live version is in each document's
> header and revision history. Don't infer a version from a filename, and don't rename the files
> (every cross-reference in `docs/` points at these paths).

If anything here conflicts with those documents, **the documents win** — update this file to match.

Also check [docs/Running_Notes.md](docs/Running_Notes.md) — a dated engineering log (not a
source of truth) of findings, gotchas, and decisions discovered while building the Agent, e.g.
engine quirks hit only by actually running code, not by reading it. Read it for prior-art before
re-investigating something; append a dated entry when you hit a similar finding.

The root [../CLAUDE.md](../CLAUDE.md) documents the *Engine* (the terraforming-mars codebase this
fork is built from): build/test commands, the card system, and engine architecture. Read it when
you need to understand how the game itself works. This file covers the *Agent* built on top of it.

---

## 1. What this project is

Nadia is an autonomous **AI agent that plays Terraforming Mars at the level of a strong human
player**. It does **not** implement the game. It observes game state, decides on moves, and submits
them to an existing digital implementation — the terraforming-mars engine, which is the code in
this same repository.

- **Scope:** base game + Corporate Era + Prelude, on the standard Tharsis board, 2–4 players.
  **2-player is the primary** training/evaluation setting; 3–4p is a competence target.
- **Out of scope (v1):** Venus, Colonies, Turmoil, Ares, Moon, Pathfinders, CEO, Underworld, Star
  Wars; alternate boards (Hellas/Elysium) beyond optional stretch; any play on third-party
  platforms (Board Game Arena, Asmodee) — those are ToS-gated and deferred (SRS CON-4/NFR-9).
- **Definition of "highly skilled" (primary bar):** AC-1 + AC-4 + AC-6 together (see §7).

### The single most important design decision

**Reuse the Engine as ground truth.** The engine already implements and tests every card and rule
in scope. The Agent drives it — live for real games, and headless as the simulator for search and
self-play. This removes essentially all rules risk. The Agent must **never** re-implement rules and
must **only** submit moves from the legal action set the Engine presents (SRS CON-1, CON-2).

---

## 2. Repository shape & the Engine pin

This repo is a **personal fork of terraforming-mars** (`a2soup/terraforming-mars-nadia`). It
contains the full Engine plus this `agent/` project.

- **Pinned Engine commit:** `868714d72a434ab68fe08e5570ebc6863859ae15` (`868714d72`,
  2026-07-20). This is the SRS `<TBD-PIN>`. The fork is treated as **frozen at this commit** for
  the Engine layer: do not pull upstream during the project, and treat all engine files as
  immutable rules ground truth. If the pin ever changes, re-verify the action model in §5 and note
  it here and in both source docs (Implementation Plan Milestone 1 / §9).
- **`agent/`** (this directory) — the Agent lives here as a **top-level module, isolated from the
  Engine tree** (SRS CON-1, NFR-7). Keeping Agent code out of `src/` keeps the engine layer clean
  and the Agent independently testable. Engine contact happens only through the transport layer
  (§4). Small, clearly-isolated, rules-neutral engine additions (a headless match runner, a seed
  hook) are permitted; changes to game logic are not.
- **`src/`** — the Engine (`server/`, `client/`, `common/`). See root CLAUDE.md.
- **`docs/`** — the SRS and Implementation Plan.

> Status note (11 Aug 2026): Milestones 1 and 2 are complete, and `agent/` now holds `src/`
> (engine harness, driver, enumerator, agents, match, rating, prior, regression, …), `test/`, and
> `docs/`. See §6 for what each bullet established and where it lives. The `MarsBot`/`automa` code
> under `src/server/automa/` is the **engine's built-in solo-mode scripted opponent**, *not* this
> Agent — do not confuse the two.

---

## 3. Toolchain

- **Node 22** (`.nvmrc` → `22`; `package.json` engines `22.x`). Run `nvm use` at the repo root.
- **Milestone 1–5 core language: TypeScript** — runs in the Engine's own Node process for the
  fastest embedded play and simplest integration (Plan §2.2). A **Python (PyTorch) core behind a
  Node bridge** is stood up only when entering the RL phase (Milestone 6), reusing the same match
  harness on both sides. Do not add the Python bridge before then.
- Engine build/test commands live in the root CLAUDE.md (`npm run build`, `npm run test:server`,
  etc.). Follow the surrounding code's style in any file you touch.

---

## 4. Architecture (four layers)

Observations flow up, actions flow down, through **one** decision-core interface, so the two
"brains" (heuristic/search, later learned) and the two transports (embedded, HTTP) are
interchangeable.

| Layer | Responsibility | Key components |
| --- | --- | --- |
| 1. Engine (reused) | Authoritative state, rules, card logic, serialization | terraforming-mars at the pinned commit; headless runner; seed control |
| 2. Transport / adapter | Deliver decision points to the core, return responses; abstract embedded vs HTTP | Embedded in-process driver; live-play HTTP client; state-serializer bridge |
| 3. Decision core | Turn an observation into a legal, strong move | Observation encoder; legal-action enumerator; evaluator; search; move selector |
| 4. Training & evaluation | Produce and measure strength | Match harness; rating pipeline; self-play generator; trainer & checkpoint store |

**The key interface** (everything hinges on this): conceptually
`decide(observation, legalActions) -> action`. The transport layer guarantees the same observation
and legal-action structures reach `decide` whether the game runs in-process or on a remote server.
The heuristic brain and the learned brain are two implementations of this one function
(SRS FR-INT-3, Plan §2.1).

**Two operating modes, one decision core:**
- **Embedded (headless):** call the Engine in-process; full state access; used for training,
  self-play, evaluation.
- **Live-play (adapter):** connect to a running game server over HTTP, read the `waitingFor` model,
  post responses — exactly what the web client does. Because live search cannot fork the server's
  hidden state, the core searches over a **locally reconstructed** Engine state (SRS FR-INT-6),
  built from the public observation plus a sampled determinization of hidden info. "Identical core,
  both modes" refers to this local-search core.

---

## 5. Engine interfaces you must master (re-verify against the pin)

The Agent's whole control surface is: the Engine advances until it needs a decision, exposes a typed
`PlayerInputModel`; the Agent reads it, enumerates the legal set, and submits a matching
`InputResponse`. Key files (verified present at the pinned commit):

- `src/common/inputs/InputResponse.ts` — the response union the Agent submits.
- `src/common/models/PlayerInputModel.ts` — the decision model the Engine presents.
- `src/server/Game.ts` / `src/server/SerializedGame.ts` — `serialize()` produces the
  `SerializedGame` snapshot used for snapshot/restore in search & self-play (SRS CON-3).

**Decision types in scope** (SRS §3.3): `option`, `and`, `or`, `initialCards`, `projectCard`,
`card`, `payment`, `space`, `player`, `amount`, `productionToLose`, `resource`/`resources`. The
Agent must produce a legal response for **every** one (SRS FR-9) or fall back to a safe legal move —
never stall or error. (`colony`, `delegate`, `party`, `policy`, `globalEvent`,
`aresGlobalParameters`, `claimedUndergroundToken` also exist in the union but are out-of-scope
expansions and should generally not arise; degrade gracefully if they do.)

**Canonical move factorization (SRS FR-ACT-4) — important.** For `payment` and composite
`and`/`or`/`projectCard-with-payment` decisions, the naive legal set is **combinatorial**, not a
short list. Generate moves through an explicit factorization with reductions (e.g. a canonical
cheapest-legal payment unless there's a strategic reason to deviate, FR-ACT-3) rather than
materializing the full cross-product. This same factorization is the structured/hierarchical action
representation for any learned policy (Milestone 6) — a flat softmax over all legal moves does not
exist for this action space.

**Belief model (SRS FR-OBS-2).** Maintain a belief over hidden info — undrawn-deck composition and a
distribution over opponents' hands — kept consistent with **every** observable card-flow event
(draws, Research buys, plays, discards, reveals), not just hand sizes. This is the basis for
determinized/information-set search and must never assume knowledge the Agent couldn't legally have.

---

## 6. Milestone roadmap & current status

Seven milestones, each with an exit criterion. Value appears early; the riskiest work (RL) is
attempted only on a foundation that already works.

| # | Milestone | Exit criterion (short) |
| --- | --- | --- |
| **1** | Engine harness + legal random player | 1,000 full legal games, 0 illegal moves / 0 crashes; move-for-move reproducible under fixed seeds; **simulator-speed spike** done |
| 2 | Match harness, baselines, ratings, corporation opening prior | Sound win-rates/ratings for any two agents; baselines reproducible |
| 3 | Heuristic evaluation function | Beats baselines decisively (≥80% vs greedy, ≥90% vs random) |
| 4 | Look-ahead search under uncertainty (determinized / ISMCTS + belief model) | Beats pure-heuristic with significance **and** hits a justified sims-per-decision target |
| 5 | Strong non-RL agent, hardened + live-play adapter | Completes unattended online games; sets the reference strength RL must beat |
| 6 | Reinforcement learning via self-play (Python+PyTorch, optional expert warm-start) | Learned agent beats M5 with significance; monotonic improvement |
| 7 | Evaluation, tuning, acceptance | Primary AC (AC-1, AC-4, AC-6) met and documented |

**Current status: Milestone 2 is COMPLETE — bullet 1 (the match runner, 28 Jul 2026), bullet 2
(the fixed baselines, 29 Jul 2026), bullet 3 (the rating pipeline, 31 Jul 2026), bullet 4 (the
corporation opening prior, 10 Aug 2026) and bullet 5 (the regression suite, 11 Aug 2026) are all
DONE.** Milestone 1 is complete (all seven bullets; see the build record below). `.nvmrc` pinned to
Node 22, Engine commit pinned. **Next up: Milestone 3 — the heuristic evaluation function.**

### Milestone 2, bullet 5 — the regression suite (done)

The standing check that keeps the runner, the ratings, the two frozen baselines and the Engine pin
meaning the same thing at M3 as they meant when they were adjudicated. Lives in
`agent/src/regression/` + `agent/test/regression/fixtures/` behind `npm run regression`. Full
results: [docs/Regression_Suite.md](docs/Regression_Suite.md); the design and the criteria were
pre-committed in [docs/Milestone2_Bullet5_Prompts.md](docs/Milestone2_Bullet5_Prompts.md) before any
code, and the negative controls in their own commit before any was run. **All nine criteria met — and
that is only readable alongside the gap table, because S1 is satisfied by recording what the suite
misses rather than by its missing nothing.**

Six things worth knowing before touching this area:

- **The gap the bullet existed to close: `greedy-1ply@1` had no fixed-seed standing check of any
  kind.** `determinism/replay.ts` hard-coded the random-legal agent, so the 300-fingerprint corpus
  covered one of the two frozen yardsticks. There are now **33 pinned games** (18 greedy, 15
  random-legal, at 2p/3p with a 4p smoke) plus 13 agent-independent L1 fixtures. **Three layers,
  defined by what invalidates them**: L1 survives every agent change M3→M7; L2 is scoped to an agent
  *version*, so a new agent adds a section and invalidates nothing; L3 is triage over L2.
- **The suite is blindest to exactly the change bullet 2 called version-defining.** A candidate-set
  reduction (`MAX_INTERIOR_AMOUNTS` 6→3) fired **nothing** — across 43 pinned games, both baselines,
  both corpora and all 300 determinism configs — and survived the corpus growing from 10 games to 33,
  so it is a standing gap rather than a sample-size artefact. **A promotion gate must not read a green
  suite as "the baseline is unchanged."** Two further gaps: anything on a line the corpus never
  reaches (Anti-Gravity Technology, 0 plays in 1,500 games *and* in a 950-game survey), and the
  ranking's megacredit tiebreak, whose coverage rests on the single pinned game with a real VP tie.
- **A seed cannot assert a card, and this is now measured rather than argued.** Three source-document
  statements said the divergent cards were "pinned in the M2 regression seed set"; a hash over a
  321-decision game reports the same event whether Decomposers over-granted or the enumerator
  reordered two options. Hackers' `bespokePlay` mutation moved **zero** pinned entries at 10 games —
  caught only by L1's direct assertion. Both instruments are needed; the seed proves reachability, the
  fixture asserts the value.
- **"Greedy play reaches further" is false, and the covering search had to be overridden.** Per game
  at 2p, `random-legal@1` plays 31.5 distinct cards and takes 5.8 card actions against greedy's 19.1
  and 2.9, at **1/75th the cost**. A search maximizing coverage per second pins almost nothing but
  cheap random-legal games — a corpus that covers the card pool beautifully and would not notice
  `greedy-1ply@1` changing at all. 18 of 33 greedy entries are **forced**; left to the search there
  were 5.
- **Three defects were found in this bullet's own code, all the same shape** — a check correct about
  the thing it looks at and silent about the thing beside it. The corpus digest hashed repo HEAD (so
  it moved on every commit); the ledger chain did not cover its own last entry (on a one-entry ledger,
  nothing was pinned); `--explain` reported "a different route to an identical outcome" for the case
  that is its exact opposite. All three passed their own specs; two were found by *using* the CLI.
  **A spec whose subject includes repo or file state has a hidden fixture — the commit you happen to
  be on.**
- **Two numbers that are not what the documents said.** `tsx` understates *this* workload by **1.4×**,
  not the ~3.5× recorded below (that figure is the speed spike's clone micro-benchmarks and does not
  transfer to whole-game play): the suite runs in **35.4 s compiled** against a 300 s budget. And
  `card_play_coverage.json` records **Sell Patents played 0 times in 1,500 games**, which is wrong —
  K4's observer wrapped `payAndExecute`, which Sell Patents never calls. No other row is affected; the
  unique chokepoint is `projectPlayed`.

### Milestone 2, bullet 3 — the rating pipeline (done)

FR-14, and the measurement machinery every strength claim from here on is stated in. Lives in
`agent/src/rating/` behind `npm run rate` (`report`, `design-effect`, `power`, `gate`, `elo`,
`ladder`) and `npm run rate:validate`. Full results:
[docs/Rating_Pipeline.md](docs/Rating_Pipeline.md); the design and the criteria were pre-committed in
[docs/Milestone2_Bullet3_Prompts.md](docs/Milestone2_Bullet3_Prompts.md) before any code. **Six of
nine criteria met; P2 (coverage) and P3 (power, narrowly) are not met and the reasons are the
deliverable's most useful content.**

Seven things worth knowing before touching this area:

- **The unit of analysis is the pairing group, never the game.** Games in a group share an Engine
  seed. Measured design effects: **1.033 / 1.252 / 1.293** at 2p/3p/4p on the win rate and
  **1.043 / 1.516 / 1.184** on the VP margin — so an uncorrected 3p margin interval is 23% too
  narrow, in the stratum where AC-5 lives, and an uncorrected test over-rejects at 7.6% against a
  nominal 5%. **The correction changes intervals and never point estimates**, so every win rate
  published in bullets 1 and 2 stands.
- **A win rate is the gate; the Elo is a summary.** No acceptance criterion in the SRS is stated as a
  rating. With two identities at 2p the Elo *is* the win rate transformed — but that statement is
  2p-only: at 3p `greedy-1ply@1` holds two of three seats, so its 99.5% identity win rate maps to 920
  Elo against a fitted 603. The ladder: **764 Elo [682, 862]** at 2p, 603 [538, 685] at 3p,
  623 [499, 791] at 4p, anchored at `random-legal@1`.
- **A statistics module cannot be validated by looking at its output.** All three defects the
  coverage grid found ran without error and produced plausible numbers, including a bootstrap
  interval that covered **60%** of the time at p = 0.99 — the regime the baselines occupy. It now
  refuses there, so **above ~99% there is no cross-check on the primary interval**.
- **The pre-committed coverage band was partly unattainable, and the analytic anchor is what showed
  it.** Exact Wilson coverage at p = 0.99, n = 100 is **92.06%** by enumeration — no estimator, no
  generator. P2 stands as not met rather than being rewritten to fit; the pipeline's own contribution
  is within ±1.7 pp and mean coverage is 0.9503 where arithmetic allows.
- **A correction that fixes one estimator can break another.** Bias correction is worth +2 pp on a
  Bradley–Terry rating gap and **−0.4 pp** on a clustered proportion, measured on identical
  replications. Applied where measured, computed-but-not-applied where not.
- **Two guards had specs, passed them, and had never once refused a real run** — the seed-block
  ledger was never being read, and once it was, a gate's own reservation blocked it. Both found by
  *using* the CLI. Seed blocks: development 0–1,999, gate 2,000–5,999, regression 6,000–6,999,
  harness 7,000–9,999, with all nine spent ranges in `docs/data/ladder.json`.
- **Two numbers M3 must plan around.** 1,000 games resolves a **4.0 pp** edge and nothing finer;
  certifying 53% takes 1,767 games (~4.7 days single-core at M4's budget). And testing at interim
  looks turns a 4.9% test into **16.5%**, while reporting the games a variant was selected on
  inflates its win rate by **+2.2 pp** — the latter is where nearly all the inflation lives, so
  "never report the selection games" is the cheap discipline that buys most of it.

### Milestone 2, bullet 2 — the fixed baselines (done)

`greedy-1ply@1`, the OSLA equivalent, joins `random-legal@1` as the second **frozen** baseline. Lives
in `agent/src/core/greedyOnePlyAgent.ts` + `agent/src/core/candidates/` + `agent/src/search/`, seatable
by name in the match runner. Full results: [docs/Baselines.md](docs/Baselines.md); the design and the
criteria were pre-committed in [docs/Milestone2_Bullet2_Prompts.md](docs/Milestone2_Bullet2_Prompts.md)
before any code. **All nine criteria met over 3,700 validation games**, zero failures.

Six things worth knowing before touching this area:

- **The objective is current victory points and nothing else** — `player.getVictoryPoints().total`,
  ties broken at random, **no megacredit term**. That term looks like the game's real tiebreak but
  inside a move chooser it is a *spending penalty*: it would produce an agent that never buys a card
  and never plays one. `greedy-1ply@1` is a **frozen yardstick** for AC-3, so any change to its move
  distribution — a candidate-set reduction, the drain boundary, the 64-cap, the 32-step drain budget,
  or anything altering which decisions are forkable — is a **new version**, not an improvement.
- **It wins 99.2% vs random-legal while tie-breaking 75.9% of its scored decisions**, with a median
  score spread of **0 VP**. Quote those two numbers together; a win rate alone says nothing about
  whether this agent is choosing or flipping. (The 99.2% is *above* the prior-art ~91% and outside the
  pre-committed 80–97% band — recorded as a discrepancy with untested hypotheses, deliberately **not**
  tuned toward the paper's figure.)
- **Hazard H7's two-way fork check is not sufficient**, and `bench/forkCost.ts`'s "26,026 forks, 100%
  exact reproduction" shares the blind spot. A fork can pass `pendingSignature` *and* `stableStateOf`
  and still sit on a regenerated decision. `search/pendingModel.ts` is the third, finer check, and it
  must gate **ancestor adoption** as well as fork certification. In production **every single
  validation failure was one only this check could see**.
- **Fork availability is 99.7% with ancestor replay** (66.2% direct), so the random-legal fallback is
  a 2.0% path, not a common one. But the **opening is unforkable outright** — all 1,000 `initialCards`
  decisions fell back — because no forkable ancestor exists before the first action phase.
- **AC-1 now holds for two agent versions**, `random-legal@1` and `greedy-1ply@1` (1,000 games,
  226,840 submissions, zero Agent-attributable rejections). It does **not** hold for anything M3
  produces — see the standing caveat in §7.
- **The AC-1 battery costs 12.6× more against a forking agent** (13,827 s vs 1,093 s), because the
  `Player.prototype.process` wrapper is entered ~15 times per real submission. M4's search is three
  orders of magnitude past one-ply; budget for it, and if it becomes prohibitive short-circuit the
  guard before the wrapper body rather than cutting the sample.

### Milestone 2, bullet 1 — the match runner (done)

The measurement instrument every later strength claim depends on (SRS FR-13). Lives in
`agent/src/match/` + `agent/src/agents/registry.ts`, behind `npm run match` (and `npm run match:pool`
for the process pool). Full results: [docs/Match_Runner.md](docs/Match_Runner.md); the design and the
criteria were pre-committed in [docs/Milestone2_Bullet1_Prompts.md](docs/Milestone2_Bullet1_Prompts.md)
before any code. **Seven of eight criteria met over 1,700 validation games** (1,000 at 2p, 600 at 3p,
100 at 4p; zero failures, zero Agent-attributable illegal-move rejections).

Five things worth knowing before touching this area:

- **The unit of measurement is a pairing group, not a game.** A group fixes one Engine seed and plays
  the lineup in *every* seat permutation (2 games at 2p, 6 at 3p, 4 cyclic rotations at 4p), so a win
  rate is not confounded with seat order. `N` is a group count; a game count that is not a whole
  number of groups is an unbalanced sample and the CLI rounds up rather than truncating. Win rates are
  reported twice — `bySlot` (the identity being compared) and `bySeat` (the same games by seat) — and
  the difference between them is the point.
- **`gameResult.ts` is not the ranking.** The Engine's real winner rule (VP, then megacredits) exists
  only in `src/client/components/GameEnd.vue:292-320` — there is no server-side equivalent — and is
  implemented in `match/ranking.ts`. `computeResult`/`GameResult` are deliberately untouched: the
  committed 300-fingerprint determinism corpus hashes `JSON.stringify(GameResult)`, so extending that
  type would look exactly like a determinism regression.
- **The AC-1 legality accounting is absorbed** (`--legality`), verified counter-for-counter against
  `npm run legality` on 50 shared configs. See the standing caveat in §7 below for what that changes
  and, more importantly, what it does not.
- **R7 (parallel throughput) is UNTESTED, not failed**, and with it the speed spike's ×8
  core-scaling assumption and the M6 self-play budget built on it. The measurement host was swapping
  (5.67 GB of 6.14 GB on 8 GB) and the *single-process* baseline swung 4.3× within one session on an
  identical spec. **Check `sysctl vm.swapusage` and free memory before believing any throughput
  number from this machine** — a whole afternoon went into an apparent 6× regression that was the host.
  One command on an idle host settles it: `matchValidationCli.js --phase r7`.
- **The seat advantage the pairing corrects was not demonstrated**, so the pairing's necessity rests
  on argument, not measurement: over 1,000 games seat 0 won 52.6% with a 95% CI of [49.5%, 55.7%].
  Random-legal play is the weakest possible instrument for a tempo advantage. **Re-measure at M3.**

### Milestone 2, bullet 4 — the corporation opening prior (done)

FR-DATA-1, and the whole of the project's contact with the RuneDK93 expert dataset. Lives in
`agent/src/prior/corporationPrior.ts` over `docs/data/corporation_prior.json`, built from
`docs/data/runedk93_prelude_corps.txt` (the upstream table vendored verbatim, MIT). Full results:
[docs/Corporation_Prior.md](docs/Corporation_Prior.md) — short by design. **17 of 17 corporations
reconciled, nothing unmatched in either direction.** 18 specs; no CLI.

**Bullet 4 was cut down to size on 10 Aug 2026 (SRS v1.7 / Plan v1.8) and delivered the same day.**
It had been "build the expert-distribution report." **AC-8 is withdrawn**, and with it the full
~200-card BGA↔engine card-set reconciliation, the distributional report (winning score / TR /
generations), the per-card win-rate profile comparison, and the 3-player calibration corpus. **If
this area starts growing a pipeline, that is the cut work coming back** — read the Plan v1.8 entry
first. Milestone 3's opening book is the table's only consumer; prelude and initial-card selection
get no dataset prior at all.

Five things worth knowing before touching this area:

- **WAP is not a win rate, and both source documents said it was.** It is a mean Elo-performance
  residual — mean of (`[2,1,0]` by finishing position) − (Elo-expected score) — on ~[−2, +2],
  centred near zero. Not a probability: never rescale it to [0, 1] or mix it with a rate. Both docs
  are corrected in place; the guardrails' "prefer WAP" now has a defined object.
- **The corpus is 3-player and the primary setting is 2-player.** Chance is **33.3%**, not 50%, so
  40.88% is +7.5 pp of edge. And corporation strength is not player-count invariant — Tharsis
  Republic's top WAP is partly an artefact of having more opponents building cities. **A 3p prior
  applied at 2p is a biased prior**, kept only because it is weak and short-lived.
- **Only 8 of 17 rows are separated from chance** at 95%. The middle nine span −5.0 to +3.9 pp with
  intervals that all contain 1/3. `corporationPriorRows()` ships the interval and a
  `separatedFromChance` flag so M3 does not rank noise, and applies **no weight** — that is M3's
  call about its own opening book, not the data layer's.
- **The skill adjustment reorders the table where it matters.** Spearman 0.92 between raw rate and
  WAP, but **CrediCor is 1st by rate and 6th by WAP** — the largest shift in the table. That is
  FR-DATA-3's confounding visible in the data: strong players pick CrediCor.
- **The two arithmetic identities are the checks worth having**, because they know nothing about
  this project: participations sum to 3 × 1,616 and wins sum to 1,616 (one winner per game, which
  also proves "Win Rate" is a first-place rate). They would catch a truncated download, a duplicated
  row, or an upstream regeneration against a different corpus. The vendored file hashes to its
  upstream blob SHA and the spec re-derives the artifact from it, so hand-editing the JSON fails.

**Milestone 2 bullet 5 (the regression suite) closed this out on 11 Aug 2026 — see above.**

Two consequences of the AC-8 cut worth carrying, both of which make the project's evidence base
*thinner*, not cleaner:
- **The eight Engine-vs-print divergences** ([docs/Card_Coverage_Audit.md](docs/Card_Coverage_Audit.md))
  no longer feed a reconciliation — all eight are project cards, and the surviving prior is
  corporations only. Their one downstream consumer is now the bullet-5 regression suite, plus the
  M3 evaluator, which fits to Engine value by CON-1. **Discharged 11 Aug 2026, and by a different
  mechanism than this line originally named**: "pinned in the regression *seed set*" is insufficient,
  because a hash over a whole game cannot distinguish a card's value changing from an enumerator
  reordering. Each divergence has an **L1 fixture asserting the Engine's number directly**
  (`agent/test/regression/fixtures/`), and the pinned corpus separately proves the line is reached —
  both, not either. See [docs/Regression_Suite.md](docs/Regression_Suite.md) §2 and the plan's §3.2.
- **The un-audited 204-card declarative tail lost its independent cross-check.** The reconciliation
  was named in the risk register as the second check on that tail; it is gone, so the tail rests on
  indirect test/play coverage alone. If an M3 card valuation looks wrong for no reason, read that
  card's `behavior` block before debugging the evaluator.

Bullet 5 inherited seed block `R` (6,000–6,999) and spent 6,090–6,099 and 6,100–6,499 of it, both
recorded in `docs/data/ladder.json` before any game was played; 6,000–6,029 remains spent from M2b1
and is correctly refused. **6,500–6,999 is reserved for the per-version L2 sections M3–M6 will each
need.** Bullet 3's lesson — *commit the per-game rows, not the summary* — was acted on and paid for
itself: a VP-breakdown reattribution with every total preserved moved 32 of 33 entries on semantic
fields with zero fingerprint fields, which no hash in the project would have caught.

Note that deliverables written before 10 Aug 2026 — [docs/Rating_Pipeline.md](docs/Rating_Pipeline.md),
[docs/Baselines.md](docs/Baselines.md), [docs/Match_Runner.md](docs/Match_Runner.md) and the
Milestone-2 prompt documents — describe bullet 4 in its pre-cut form and reference AC-8. They are
dated records and were deliberately left as written; the two source-of-truth documents win.

---

**Milestone 1 is complete — the build record follows.** The exit
criterion was met 24 Jul (gating spike PASSED, Engine determinism verified, 1,000-game AC-1 legality
run clean), and bullet 7 (the card-coverage audit) — the last outstanding item, which never gated the
exit criterion — is now done. Bullet 1 (headless base + Corporate Era + Prelude game creation,
`agent/src/engine/gameFactory.ts`), bullet 2 (embedded driver, `agent/src/driver/`), bullet 3
(legal-action enumerator, `agent/src/core/enumerator/`, + the random-legal agent,
`agent/src/core/randomLegalAgent.ts`), and bullet 4 (snapshot/restore for search/self-play, SRS
CON-3, `agent/src/engine/snapshot.ts` + `stableState.ts`) are done. The random-legal agent, driven
by the embedded driver, now completes full 2p/3p/4p games end to end (`Phase.END`), including an
FR-9 conservative fallback that recovers the one known composite-level affordability coupling plus
a genuine `SelectStandardProjectToPlay`/`SelectProjectCardToPlay` model-type overlap the Tier-1
batch surfaced — see `agent/docs/Running_Notes.md` (2026-07-22 entry) for both findings and the
driver fix (an unconditional `deferredActions.runAll()` double-drain bug) that the batch also
caught.

Bullet 4's `snapshot()`/`restore()`/`cloneGame()` clone a live `IGame` via the Engine's own
serialization, with two safety mechanisms neither of which is individually sufficient:
`assertSnapshotSafe` rejects known-unfaithful phases (research, drafting, and — after a branch-review
finding, see the 2026-07-23 Running Notes entries — preludes/CEOs too) and a mid-decision deferred
queue; `restore`'s default `verify: 'pending'` catches a silently-regenerated pending decision the
phase guard alone would miss (measured on a 12-game/3,869-point audit corpus: **28.0% of decision
points don't naively round-trip**, and action-phase failures are **100% silent** — `stableState`
matches byte-for-byte while the pending decision is quietly replaced). Sub-task D (in-memory save
history, closing the other half of CON-3) is deliberately deferred to Milestone 4, alongside the
replay-from-quiescent-ancestor mechanism it would feed — see the Running Notes wrap-up entry for the
reasoning.

Bullet 5, the **gating simulator-speed spike**, is done and **passed by 3–5×** — full results in
[docs/Simulator_Speed_Spike.md](docs/Simulator_Speed_Spike.md), which is the deliverable, with the
surprises summarized in the 2026-07-24 Running Notes entry. Headline: **5,248 simulations per
decision** at the NFR-1 10-second budget (depth-10 truncated rollouts; 3,442 with a 1 ms leaf eval)
against a pre-committed ≥1,000-to-proceed threshold, so **M4/M6 proceed with no rescope** and the
"state-clone cost" risk (Plan §7.2, currently *High*) should be downgraded. The bench suites live in
`agent/src/bench/` behind `agent/src/runner/speedSpikeCli.ts` (`--list` to enumerate). Four things
that document overturns, all of which will otherwise be rediscovered: `toModel` is only **7%** of a
decision (84% is Engine work CON-1 forbids touching, so there is little agent-side fat to cut);
bullet 4's 28%-unforkable figure costs only **1.6%** because unforkable points come in isolated runs
of length 1; `deserialize` no longer dominates the deep copy (that ratio was a `tsx` artifact — and
**`tsx` understates the simulator ~3.5×**, so no timing from a spec is a performance figure); and
`restore`'s default `verify: 'pending'` is **free** (0.0001 ms), so search should never disable it.
The replay-from-quiescent-ancestor strategy M4 depends on is now **validated, not assumed** — 26,026
fork experiments, 100% exact reproduction.

Bullet 6, **Engine-determinism verification, is done and all six pre-committed criteria are met** —
full results in [docs/Determinism_Verification.md](docs/Determinism_Verification.md), which is the
deliverable, with the findings summarized in the second 2026-07-24 Running Notes entry. Embedded
games are reproducible **move-for-move** (a rolling per-decision trace hash, not just end-state
equality): 300 configs in-process, 24 in a fresh process, 12 after 100 unrelated games in the same
process and under decision-by-decision interleaving. The Engine and Agent seeds are separately
seeded, now enforced by a CI-enforceable structural spec rather than by convention. The determinism
risk (Plan §7.2) drops Medium → Low. The machinery lives in `agent/src/determinism/`
(`npm run determinism -- --verify docs/data/determinism_corpus.json` re-runs the committed
300-fingerprint corpus as a standing check).

Four things worth knowing before touching this area:
- **Two hazards are "unreachable" only because embedded play never calls `GameLoader.add()`** — the
  shared `g-nadia-${seed}` id (it omits the player count) and an env-gated wall-clock cache sweep
  that *was* demonstrated to empty a live game's `gameLog` mid-play and crash it. Both are recorded
  for re-adjudication at Milestone 5, whose live adapter starts making that call.
  `ensureHeadlessEngine()` now refuses to bootstrap under `GAME_CACHE=sweep=auto`.
- **`Game.gotoEndGame()` is unawaited async**, so a synchronous batch loop holds every finished game
  alive (~0.27 MB each) until it yields. The AC-1 run yields between games and its heap is flat
  (64.6 → 65.8 MB across 1,500 games); any mid-run read of process-global state must flush the event
  loop first, and any heap sample must also force a collection or it measures V8's laziness.
- **The M4 seed contract is settled** (SRS CON-5, and §3 of the verification doc): independent
  per-consumer streams addressed by name, derived by hashing `(runSeed, label)` from one run seed.
  Implementing it is M4 work — do not add a third seed to `rng.ts` now.
- **A live game cannot be replayed from a seed** — `ApiCreateGame.ts:176` picks it with
  `Math.random()`. An M5 design constraint, recorded now.

**The AC-1 legality run is done and all seven pre-committed criteria are met** — full results in
[docs/AC1_Legality_Run.md](docs/AC1_Legality_Run.md), which is the deliverable, with the findings
summarized in the third 2026-07-24 Running Notes entry. **1,500 games (1,000×2p + 250 each 3p/4p) in
a single process: 1,500 completed, zero crashes, zero unrecovered illegal moves, and zero
Agent-attributable illegal-move rejections across 444,680 submissions** — so AC-1's legality clause
and NFR-4 are both met strictly, not by a lenient reading. The machinery lives in
`agent/src/legality/` behind `agent/src/runner/legalityCli.ts`
(`npm run legality -- --composition 2:100,3:50,4:50` for a shard; the runner exits non-zero if any
game fails to complete).

Four things worth knowing before re-running AC-1 for a future agent:
- **"Zero illegal moves" is a definition, and it carries the whole result.** An illegal move is a
  move *submitted to the Engine and rejected*. That splits the FR-9 fallbacks into a class that
  counts (the responder's move was rejected), a class that does not (the responder threw, nothing
  was submitted — 8,480 of these, all one benign cause), and a third population `onFallback` cannot
  see at all: the fallback's own rejected `'or'`-branch probes. The run wraps
  `Player.prototype.process` to observe all three.
- **The run found and fixed a real defect the ~20-game batch could never have seen**: 59
  Agent-attributable rejections, all the `initialCards` budget coupling, at ~1 per 25 games.
  `enumerateInitialCards` now caps the initial project-card count at the chosen corporation's
  budget. AC-1 must be re-run for every future agent — this one had hidden behind the FR-9 fallback
  since bullet 3.
- **`moveTraceHash` has no step for a decision the responder threw on** (`replay()` records after
  the responder returns), so a divergence confined to fallback-resolved decisions would not move it.
  The corpus still catches such a divergence via `stableStateHash` and its `fallbacks` count.
- **The committed determinism corpus must be regenerated after any enumerator change** — the cap
  changed 43 of its 300 configs, which is that corpus reporting a real behaviour change exactly as
  bullet 6 designed it to.

**Milestone 1 is complete. All bullets below are DONE — retained as the build record.**

**The gating first task (Plan §9, Milestone 1):**
1. Confirm a headless base + Corporate Era + Prelude game can be created and stepped through
   programmatically for 2–4 players.
2. Implement the embedded driver + the legal-action enumerator (built on the FR-ACT-4 factorization)
   and a random-legal agent. **The AC-1 legality run over this agent is DONE and clean (24 Jul
   2026)** — see [docs/AC1_Legality_Run.md](docs/AC1_Legality_Run.md).
3. **Simulator-speed spike (gating):** measure full-game headless runtime, serialize/deserialize
   (clone) round-trip time, and clones/second at the pin; compute how many search simulations the
   NFR-1 time budget actually buys. **This is the single biggest feasibility risk** (state-clone
   cost). If clone cost is prohibitive, design an incremental apply/undo copy path or rescope search
   depth and RL scale **before** committing Milestones 4/6.
4. **Verify Engine determinism — DONE, all criteria met (24 Jul 2026).** Verified under fixed seeds
   with the Agent's RNG seeded separately from the Engine's (SRS CON-5/NFR-5); residual
   non-determinism recorded and isolated. See [docs/Determinism_Verification.md](docs/Determinism_Verification.md).
5. **Card-coverage audit — DONE, all criteria met (27 Jul 2026).** Every in-scope card/corporation
   present (277/277) and reachable-as-classified; Engine test coverage 275/277; play coverage 273/274
   reachable over 1,500 games; all 73 logic-bearing cards read against the printed cards. Eight
   Engine-vs-print divergences catalogued, none an Agent defect. Gaps recorded as known limitations.
   See [docs/Card_Coverage_Audit.md](docs/Card_Coverage_Audit.md).

**Decision gate after Milestone 5:** measure the classical agent's strength against AC-4, then
decide whether to commit to RL (M6) or ship M5. M6 requires ML expertise / a collaborator / library;
M5 is a valid stopping point with a strong classical deliverable.

> **Standing caveat for M3–M6 planning: AC-1 is agent-specific and expires on every new agent
> version.** The AC-1 legality run above (`docs/AC1_Legality_Run.md`) proves the *random-legal*
> agent's legality — 1,500 games, zero Agent-attributable illegal-move rejections. It says nothing
> about the M3 heuristic agent, the M4 search agent, the M5 hardened agent, or any M6 promoted
> network, each of which submits different moves through the same enumerator/driver stack and can
> reach candidate-move code paths random play never did. This is not hypothetical: the M1 run
> itself found and fixed a real illegal-move-producing defect (the `initialCards` budget coupling)
> that had hidden behind the FR-9 fallback since bullet 3, invisible to a 20-game batch and only
> surfaced at 1,500-game scale. **Re-run the AC-1 legality battery against every agent version
> promoted at the end of M3, M4, M5, and M6**, as a promotion-gate step alongside the FR-15/AC-7
> significance test — not once at M1 and assumed forever after. Full detail and the risk-register
> entry: Implementation Plan §7.2.
>
> **Since 28 Jul 2026 the battery is a mode of the match runner** (Milestone 2 bullet 1, §4.6 of its
> plan): `npm run match -- --lineup <agent>,<agent> --groups 500 --legality`. It installs the same
> `legality/SubmissionMonitor` and was verified to produce **identical values on all nine adjudicated
> counters** against `npm run legality` over 50 shared configs, in both instrumentation variants
> (criterion R8, [docs/Match_Runner.md](docs/Match_Runner.md)). `agent/src/legality/` is retained as
> the M1 artifact-of-record and as that comparison's oracle — do not delete it.
>
> **What moved is where the battery lives, not whether it runs.** The consolidation was justified by
> not playing the same games twice, *not* by the odds of a regression being low — the M1 evidence
> points the other way. In particular: the driver's `onFallback` counts are **not** AC-1's accounting
> (they cannot see the FR-9 fallback's own rejected `'or'`-branch probes), so a promotion gate must
> pass `--legality` and read the strict counters, not the fallback counts a plain match already
> reports.

---

## 7. Acceptance criteria (what "done" means)

Strength is always measured on the target scope (base + CorpEra + Prelude), 2p primary, with
confidence intervals.

- **Primary bar (defines success): AC-1 + AC-4 + AC-6.**
  - **AC-1** — Legality & completion: ≥1,000 consecutive embedded games, zero illegal moves, zero
    unhandled errors.
  - **AC-4** — Expert-human benchmark: ≥50% win rate (or better-than-even placement) across ≥30
    games vs self-identified strong human players on the self-hosted engine. *Depends on securing a
    strong human opponent/reviewer early — a tracked project risk; fallback is head-to-head vs an
    agreed strong bot.*
  - **AC-6** — Strategic soundness: expert review of logged games finds no systematic blunders and
    coherent engine-building, timing, and milestone/award play.
- **Guardrails:** AC-2 (≥65% vs the project's own tuned heuristic), AC-7 (each promoted version
  beats the previous with significance).
- **Supporting evidence:** AC-3 (≥90% vs random, ≥80% vs greedy one-ply), AC-5 (3–4p placement
  well above 1/N).
- **AC-8 (distributional calibration vs the expert dataset) was withdrawn on 10 Aug 2026** (SRS
  v1.7). It was a smell test with no threshold, so it could not fail the project, yet it required
  the most expensive work in Milestone 2 to run at all. **The ID is retired, not reused** — there
  are seven acceptance criteria. No acceptance criterion now refers to the expert dataset.

---

## 8. Expert data: the one rule

The RuneDK93 top-25 BGA expert dataset (aggregate statistics, **not** move logs) and the TAG
prior-art paper are weak-prior resources only. **The data seeds weak priors; it never defines
correct play, and the Agent is always free to beat it** (SRS FR-DATA-1..5, Plan §7.1 / Appendix A).

**Scope, as of 10 Aug 2026 (SRS v1.7 / Plan v1.8):** the project ingests the **per-corporation win
rates and nothing else**. The per-card table and the score/TR/generation summaries are not ingested;
the distributional comparison they fed was withdrawn with AC-8. The guardrails below are *unchanged
in force* — they now govern a smaller surface, which is the safe direction.

- **Do:** seed a *weak* opening prior over corporation selection, from the committed table
  (`docs/data/corporation_prior.json`, via `src/prior/corporationPrior.ts` — built 10 Aug 2026,
  [docs/Corporation_Prior.md](docs/Corporation_Prior.md)).
- **Don't:** set evaluation weights equal to observed win rates; treat the data as an oracle, hard
  constraint, or a target to imitate; let imitation be the final objective; narrow strategy to the
  expert metagame. **Don't rebuild the card-set reconciliation or the distributional report** —
  both were cut deliberately.
- Observed win rates are **confounded** (skill + draw luck + game length mixed with card strength) —
  weak, overridable hints only; prefer the skill-adjusted (WAP) column and keep the sample size
  beside each entry. Tune evaluation weights to **harness win rate**, never to the dataset.
- **WAP is not a win rate** — a mean Elo-performance residual on ~[−2, +2], not a probability. Both
  source docs said otherwise until 10 Aug 2026. Don't rescale or clamp it.
- **The prior is 3-player data priming a 2-player-primary agent**, and chance in it is 33.3%. Both
  are real biases; the prior survives because it is weak and the harness overrules it.
- Reconciliation was **17 corporation names matched by hand** and is done (`docs/data/card_census.json`
  is the authoritative in-scope list). A corporation the two sources don't agree on gets **no
  prior** — flag it, never coerce it onto a near-match.

---

## 9. Standing conventions for Agent work

- **Never** submit a move outside the Engine-presented legal set; **never** read another player's
  hidden state from Engine internals in live-play mode (SRS CON-2).
- Keep the decision core decoupled from both the Engine and the transport (embedded vs HTTP) so
  either can change without touching strategy code (NFR-7).
- Control the Engine seed and the Agent's search/determinization seed **separately** (CON-5).
- Log, per decision, the options considered, the chosen move, and a brief score/rationale, at
  configurable verbosity (FR-11) — decisions must be inspectable (NFR-6).
- Reproducibility: pinned Engine commit, pinned deps, fixed seeds, checkpointed models, and a
  promotion gate that requires statistically significant improvement.
- Treat the Engine as ground truth: add regression games rather than working around apparent card
  bugs; report genuine Engine bugs upstream rather than silently patching rules.
- Measure everything through the Milestone 2 harness — it is the single source of truth for
  strength. Judge changes by win rate against fixed baselines, not intuition.

### Planning convention: decompose a plan into prompts for cold-start sessions

When planning a substantial piece of work (a Plan bullet, a milestone sub-goal), the house style is
to write a **plan document that decomposes the work into self-contained prompts**, each intended for
a session that starts cold — see `docs/Milestone1_Bullet4_Prompts.md`, `…Bullet5…`, `…Bullet6…`,
`…Bullet7…`. Each such document carries: what is already known (so nothing is re-derived), the
located hazards, criteria pre-committed *before* any measurement, a file-ownership table so parallel
work never collides, a shared preamble, and one prompt per unit of work.

Always include, for each unit: a **rough scale estimate** (lines of code, files, cards read, minutes
of compute) and a **model recommendation with the reason** — the reason is the useful part, because
it names what would go wrong if the work were run too cheaply.

**Fit the number of units and the parallelism to the work, not to the shape of the last plan.** The
decomposition is an output of analysing the task; it is not a template to fill. Bullets 5 and 6 both
landed on `A → (B, C, D in parallel) → E` because both genuinely had a shared harness plus three
comparable investigations over it. Bullet 3 did not (`A → (B, D) → C → E`), bullet 4 did not (four
units, no write-up unit), and bullet 7 did not — it split into a measurement pass, a tooling
question, a large *ranked, batched* review that is most of the effort, and a write-up. Before
settling a structure, ask:

- **Is the "do this first" unit a real dependency, or just a shared denominator?** A harness other
  units call is a dependency. A JSON file they could each derive in thirty lines is coordination —
  worth ordering, not worth a blocking phase.
- **Are the parallel units actually comparable in size?** If one is 70% of the effort, it is the
  spine, not a peer. Fan out *inside* it (over items, batches, cards) rather than across concerns.
- **Does splitting cost a cold start?** Two sessions re-deriving the same Engine internals is a real
  cost. Merge units that key off the same objects.
- **What genuinely warrants its own session?** Work that edits the source-of-truth documents (one
  writer, always), work whose size is unknown until attempted, and work that is pure judgment over
  other units' output.

The prompt-per-cold-session format is the convention. The count, the ordering and the fan-out are
findings about the task, and a plan should say why its shape fits the work.
