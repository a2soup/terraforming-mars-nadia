# CLAUDE.md — Nadia: an expert-level AI agent for Terraforming Mars

This file orients a Claude Code session working on the **Nadia AI agent**. It is generated
from the two source-of-truth documents and should be kept consistent with them:

- SRS: [docs/Terraforming_Mars_AI_SRS_v1.2.md](docs/Terraforming_Mars_AI_SRS_v1.2.md)
- Implementation Plan: [docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md](docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md)

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

> Status note: as of this writing `agent/` contains only this file. Nothing in Milestone 1 has been
> built yet. The `MarsBot`/`automa` code under `src/server/automa/` is the **engine's built-in
> solo-mode scripted opponent**, *not* this Agent — do not confuse the two.

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
| 2 | Match harness, baselines, ratings, expert-distribution report | Sound win-rates/ratings for any two agents; baselines reproducible |
| 3 | Heuristic evaluation function | Beats baselines decisively (≥80% vs greedy, ≥90% vs random) |
| 4 | Look-ahead search under uncertainty (determinized / ISMCTS + belief model) | Beats pure-heuristic with significance **and** hits a justified sims-per-decision target |
| 5 | Strong non-RL agent, hardened + live-play adapter | Completes unattended online games; sets the reference strength RL must beat |
| 6 | Reinforcement learning via self-play (Python+PyTorch, optional expert warm-start) | Learned agent beats M5 with significance; monotonic improvement |
| 7 | Evaluation, tuning, acceptance | Primary AC (AC-1, AC-4, AC-6) met and documented |

**Current status: Milestone 1's exit criterion is fully met — the gating spike PASSED, Engine
determinism is verified, and the 1,000-game AC-1 legality run is done and clean.** Only bullet 7
(the card-coverage audit) remains outstanding in Milestone 1. `.nvmrc` pinned to
Node 22, Engine commit pinned. Bullet 1 (headless base + Corporate Era + Prelude game creation,
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

**Next up: bullet 7, the card-coverage audit** — the last outstanding Milestone-1 item.

**The gating first task (Plan §9, Milestone 1) — do this before any strategy work:**
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
5. **Card-coverage audit:** confirm every in-scope base + Corporate Era + Prelude card/corporation
   is implemented and test-covered at the pin; record gaps as known limitations.

**Decision gate after Milestone 5:** measure the classical agent's strength against AC-4, then
decide whether to commit to RL (M6) or ship M5. M6 requires ML expertise / a collaborator / library;
M5 is a valid stopping point with a strong classical deliverable.

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
  well above 1/N), AC-8 (distributional calibration vs the expert dataset — a **smell test only**).

---

## 8. Expert data: the one rule

The RuneDK93 top-25 BGA expert dataset (aggregate statistics, **not** move logs) and the TAG
prior-art paper are calibration/benchmark resources only. **The data measures the Agent and seeds
weak priors; it never defines correct play, and the Agent is always free to beat it** (SRS
FR-DATA-1..5, Plan §7.1 / Appendix A).

- **Do:** seed a *weak* opening-selection prior; sanity-check the Agent's card/corp win-rate profile
  isn't wildly inconsistent with expert play.
- **Don't:** set evaluation weights equal to observed win rates; treat the data as an oracle, hard
  constraint, or a target to imitate; let imitation be the final objective; narrow strategy to the
  expert metagame.
- Observed win rates are **confounded** (skill + draw luck + game length mixed with card strength) —
  weak, overridable hints only; prefer the skill-adjusted (WAP) column. Tune evaluation weights to
  **harness win rate**, never to the dataset. A BGA↔engine card-set/rules reconciliation is required
  before any quantitative comparison.

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
