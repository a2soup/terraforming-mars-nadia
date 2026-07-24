# Engine determinism verification — results and residual-risk register

Milestone 1, bullet 6 (SRS **CON-5** / **NFR-5**). CON-5 requires determinism under fixed seeds to
be *verified, not assumed*, with the Engine seed and the Agent seed controlled separately. NFR-5
requires embedded games to be reproducible **move-for-move**, and requires any residual
non-determinism to be **recorded and isolated**.

This document is the deliverable. The sub-task plan is
[Milestone1_Bullet6_Prompts.md](Milestone1_Bullet6_Prompts.md); the pass/fail criteria (P1–P6) and
hazards (H1–H6) referenced throughout were pre-committed there, before any measurement.

---

## Verdict

**All six criteria met.** Under the pinned Engine, on the reference environment below, embedded
games are reproducible move-for-move — across seeds, player counts, process boundaries, and after
hundreds of unrelated games in the same process. The two RNGs are separately seeded, and that
separation is now enforced structurally rather than by convention.

The honest headline is a scope statement, not a tick:

> **What was verified:** the random-legal agent, on base + Corporate Era + Prelude / Tharsis,
> 2–4 players, on one machine, one OS, one Node version, at one Engine pin, with no search and no
> determinization. 300 committed fingerprints reproduce exactly, in-process and cross-process, and
> survive 100 games of interference.
>
> **What was not:** cross-platform and cross-Node determinism; determinism under parallelism;
> anything involving search or determinization (Milestone 4 adds a third RNG stream — its contract
> is written below but not implemented); and long-run heap behaviour. The 1,000-game AC-1 run is a
> separate Milestone 1 item and remains outstanding.

Two hazards resolved to **"not reachable, but only by accident of what embedded play doesn't call
yet"** — a bounded negative result that Milestone 5 will invalidate, not a clean bill of health.
See the register.

**Three defects were found and fixed during adjudication**, one of which had already silently
disabled the bullet's main durable artifact. See *Defects this write-up fixed*.

---

## Reference environment

| | |
| --- | --- |
| Engine pin | `868714d72a434ab68fe08e5570ebc6863859ae15` — verified an ancestor of HEAD, with `git diff <pin>..HEAD -- src/` **empty**, so "the Engine is frozen at the pin" is a checked fact, not policy |
| Node | v22.23.1 (`.nvmrc` → 22) |
| Platform | darwin arm64 (Apple M2), same reference hardware as the bullet-5 spike |
| Runner | `tsx` (understates the simulator ~3.5× — no timing here is a performance figure) |
| `GAME_CACHE` | unset → `sweep: 'manual'` (now enforced; see H2) |
| `MAX_GAME_DAYS` | unset |
| Agent version | 0.0.1, `seedDerivationVersion` 1 |

---

## Criteria adjudication

| | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| **P1** | In-process replay, ≥50 seeds × {2,3,4}p × ≥2 agent seeds | **MET** (blocking) | **300 configs replayed twice each: 0 mismatches** across all six comparable fields |
| **P2** | ≥20 configs reproduce in a **fresh process** | **MET** (blocking) | **24 configs, one fresh process each: 0 mismatches** (60.5 s). *Was not met as delivered — see defect 2* |
| **P3** | Replay after ≥100 unrelated games in-process reproduces the solo run | **MET** (blocking) | **12 configs across 2p/3p/4p, 0 failures** after 100 noise games; plus interleaved play |
| **P4** | Differing fields stay within the four known families | **MET** (recorded) | **8,193 differing fields across 15 configs, every one in the four families.** `stableState` unchanged |
| **P5** | Structural RNG separation | **MET** (blocking) | Enforced spec; zero violations outside `agent/src/bench`; one allowlist entry |
| **P6** | Unseeded-randomness reachability | **MET** (recorded) | Exactly **3 unseeded draws per game**, all in `GameName.ts`, **none during play** |

### P1 — breadth

50 committed engine seeds (base 500,000, stride 977) × {2,3,4} players × 2 agent seeds
(1,000,003 / 2,000,133, chosen with no arithmetic relationship to each other or to the engine
seeds). Each config replayed twice in one process and compared on `moveTraceHash`,
`stableStateHash`, `resultHash`, `decisions`, `fallbacks`, `generation`.

```
[sweep] P1: 0 mismatch(es) out of 300 config(s).
```

**Seed independence, measured over the whole sweep rather than one pair:** varying only the agent
seed changed the outcome in **100.0% of 150 pairs**; varying only the engine seed changed it in
**100.0% of 7,350 pairs**. The sub-task plan explicitly predicted "near-100%, not exactly 100%" and
forbade asserting equality to 1.0 — the rate is reported, not asserted, and it happened to come out
clean. That is a fact about this sample, not a guarantee; two agent seeds *can* coincide, especially
in a short game.

### P2 — process independence

Every determinism check this project had ever run before this bullet — bullet 1b's, bullet 3's,
bullet 4's, bullet 5's — replayed two games **back-to-back in one process**. Nothing had ever
verified a fresh process.

24 configs (3 player counts × the first 8 committed engine seeds × the first agent seed, so every
one is also a corpus entry), each replayed in its own `tsx` child, compared against the **parent's**
in-process fingerprint — never against a second child, since two children agreeing says less than a
child agreeing with the parent.

```
[childReplay] checked 24 config(s) cross-process; 0 mismatch(es).
```

This matters more than it looks: `src/server/utils/server-ids.ts:3` generates `SERVER_ID`/`STATS_ID`
from `Math.random()` at module load, so module-load state genuinely does differ per process. P2
establishes that nothing downstream of that reaches game state.

### P3 — contamination and order independence

The property Milestones 4 and 6 rest on, and the one nobody had tested. Five experiments, each with
a control:

- **Order independence.** 12 configs across 2p/3p/4p each reproduced their **fresh-process solo**
  fingerprint exactly after **100 unrelated games** in the same process. Negative control (a one-off
  agent seed in the "after" child) diverged on all six fields and was caught.
- **Interleaving** — the actual M4/M6 access pattern. 2p, 3p and 4p games driven **alternately, one
  decision each per round** (281 / 287 / 271 decisions) each reproduced their solo trace
  decision-for-decision. A control first proved that hand-stepping via `applyDecision` reproduces
  `runGame`'s trace exactly, so the comparison is like-for-like; a perturbation injected at decision
  40 was detected at decision 40.
- **Shared-id collision, accumulation, wall-clock sweep** — see the hazard register.

### P4 — the exclusion set is still exactly four families

Raw `serialize()` diffed between same-seed replays for 15 sampled configs: **8,193 differing
fields, every one** in `name`, `createdTimeMs`, `gameLog[].timestamp`, `players[].timer`.

**No change to `stableState`'s exclusion set was needed or made.** The sub-task plan warned that
silently widening the strip set would hollow out every determinism claim in the project; that
question simply did not arise.

### P5 — structural RNG separation

The pre-bullet evidence was behavioural (vary one seed, the outcome changes), which shows the seeds
are not the *same* seed but says nothing about whether agent code reaches the wall clock or the
Engine's RNG. Now enforced as a spec over every `.ts` under `agent/src` outside `agent/src/bench`:
no `Math.random`, `Date.now`, `new Date`, `process.hrtime`, `performance.now`, `UnseededRandom`, or
`.rng` read. Allowlisting is by explicit **file + rule + occurrence count** with a written reason, so
a stale entry, or a second unreviewed use in an already-listed file, fails too. One entry today:
`corpus.ts`'s header timestamp.

The positive half is asserted too, so the contract is stated rather than implied:

- The Engine `Random` module is imported in **exactly two** files — `core/rng.ts` (the Agent's PRNG)
  and `driver/embeddedDriver.ts` (`ConstRandom(0)`, the FR-9 fallback's deterministic-by-construction
  rng). Only `Random`, `SeededRandom`, `ConstRandom` may be imported; `UnseededRandom` never.
- `Game.newInstance` is called in **exactly one** file (`engine/gameFactory.ts`), passing exactly one
  seed.
- `new SeededRandom` appears **only** inside `core/rng.ts`, so a future search module cannot quietly
  build its own PRNG instead of taking an `AgentRandom` parameter.

Both specs were confirmed to fail against real perturbations (a `Math.random`/`Date.now` added to
`randomLegalAgent.ts`; `randomMA` flipped to `LIMITED` in `gameFactory.ts`), then reverted.

### P6 — unseeded randomness, measured rather than read

With `Math.random` replaced by a counting wrapper, creating **and playing a full game** at 2p, 3p and
4p consumes **exactly three unseeded draws**, all of them in `GameName.ts`, and **none during play**.

The completed H5 inventory, asserted as data so the table cannot rot:

| Site | Rule | Verdict | Note |
| --- | --- | --- | --- |
| `Game.ts:328` (`generateGameName`) | UnseededRandom | **reachable-and-harmless** | Always reached; 3 draws/game. Affects `name` only, which `stableState` strips |
| `ma/MilestoneAwardSelector.ts:188` | UnseededRandom | verified-unreachable | Candidate-milestone shuffle. Guarded by `randomMA=NONE` **and** by Tharsis being an explicit case — two independent options, either of which reopens it |
| `ma/MilestoneAwardSelector.ts:189` | UnseededRandom | verified-unreachable | Candidate-award shuffle, same guard |
| `ma/MilestoneAwardSelector.ts:196` | Math.random | verified-unreachable | Milestone-vs-award coin flip, same guard |
| `ma/MilestoneAwardSelector.ts:95` | Math.random | verified-unreachable | Moon MA coin flip; guarded by `moonExpansion=false` |
| `cards/ceos/Asimov.ts:53` | UnseededRandom | verified-unreachable | CEO module. Would be the **only** site to fire *during play* |
| `turmoil/PoliticalAgendas.ts:108` | Math.random | verified-unreachable | Turmoil |
| `routes/ApiCreateGame.ts:114` | Math.random | verified-unreachable | HTTP route: random board choice |
| `routes/ApiCreateGame.ts:176` | Math.random | verified-unreachable | HTTP route: `const seed = Math.random()` — **carried forward as a Milestone 5 finding** |
| `common/utils/Random.ts:41` | — | not-applicable | `UnseededRandom.next()`'s own body — the line every site above actually calls |

**Two corrections to the plan's H5 table**, both found by execution rather than reading:

1. **The table was incomplete.** `ApiCreateGame.ts:114` and `Random.ts:41` were missing.
2. **The `default:` branch is not hypothetical.** The plan flagged that
   `MilestoneAwardSelector`'s board `switch` routes an unrecognised board into the unseeded path.
   `BoardName.HOLLANDIA` **is in the enum and absent from that switch** — so an in-scope-looking
   config with that board silently gets unseeded milestone/award selection even with
   `randomMA=NONE`. The option guard now pins `boardName` for exactly this reason.

**The Milestone 5 finding, stated plainly:** the live-play server picks its game seed with
`Math.random()`. That is not an embedded-play defect and not a bullet-6 blocker, but it means a live
game is created under a seed the Agent never sees and therefore **cannot replay**. Live-play
reproducibility will need a different mechanism (recorded move logs, or a seed the adapter supplies).

---

## Residual non-determinism register

NFR-5 requires residual non-determinism to be recorded **and isolated**. Each row names its
isolation mechanism, not just the risk.

| # | Residual non-determinism | Status | Isolation |
| --- | --- | --- | --- |
| R1 | **Wall-clock fields in serialized state** — `name` (unseeded), `createdTimeMs`, `gameLog[].timestamp`, `players[].timer` | Present by design, bounded and re-confirmed at 8,193 observations | `stableState()` strips exactly these four. P4 re-verifies the set is complete; a new field fails loudly rather than being absorbed |
| R2 | **`GAME_CACHE=sweep=auto` mutates live game state on a wall-clock timer** (H2) | Mechanism **confirmed**; unreachable today | **New:** `ensureHeadlessEngine()` now refuses to bootstrap under `sweep=auto` (`assertSweepIsManual`), naming the hazard and the fix. Spec-covered, incl. `sweep=auto` appearing anywhere in the `;`-separated list |
| R3 | **`GameLoader` cache is a process-wide singleton keyed by an id that omits player count** (`g-nadia-${seed}`) (H1) | **Not reachable** under embedded play | Bounded negative result — the cache is never populated because `Game.save()` → `saveGame()` goes straight to the Database. **Nothing enforces that.** M5 live play calls `add()`/`getGame()` and will reopen it |
| R4 | **`Cache.mark` map grows without release** (H3) | **Confirmed, bounded** | +504 entries over 500 games — one per *distinct* game id, so `g-nadia-${seed}` bounds it by distinct seeds, not games played. Accounting leak, not GC pressure. Heap not adjudicated (needs `--expose-gc`) |
| R5 | **Environment reaches gameplay** (`GAME_CACHE`, `MAX_GAME_DAYS`) (H4) | Recorded | Both captured in every corpus header and compared by `assertHeaderCompatible`; a corpus generated under a different environment is rejected, not silently compared |
| R6 | **Live-play seeds are unseeded** (`ApiCreateGame.ts:176`) | Out of scope for embedded determinism | Recorded as a Milestone 5 design constraint (above) |

### An incidental finding worth more than it looks

**`Game.gotoEndGame()` is an unawaited async call.** A synchronous batch loop therefore defers every
finished game's completion work — and holds each finished `Game` alive through its pending
continuation — until the loop yields. Measured at **~0.27 MB per queued game**, and visible in the
data: mid-batch, `Cache.mark` had fired **404** times against **504** games actually finished.

Two consequences, both immediate:

- **Any mid-run reading of process-global state must flush the event loop first**, or it reads the
  wrong moment. This silently corrupted the first accumulation measurements.
- **The 1,000-game AC-1 run should yield periodically** rather than looping synchronously, or it will
  hold ~270 MB of finished games plus their continuations before the first yield.

---

## Defects this write-up fixed

Sub-tasks A–D each passed their own checks. These three were only visible when adjudicating the
whole, which is what sub-task E is for.

**1. The committed corpus could not be verified — at all.** `corpus.ts` recorded `engineCommit` as
`git rev-parse HEAD`, and `assertHeaderCompatible` compared it against the *current* HEAD. So the
corpus stopped verifying on the very next commit — including a docs-only one. It was already
unverifiable by the time it merged: `--verify` threw `CorpusHeaderMismatchError` before comparing a
single fingerprint, which killed the bullet's main durable artifact silently, because a corpus that
refuses to run looks the same as one nobody ran.

Fixed by separating the two ideas the field conflated:

- `engineCommit` now holds the **pinned Engine commit** — the thing that actually determines Engine
  behaviour, and which does not move — and is compared.
- `agentCommit` records repo HEAD as **provenance, never compared.**
- `nodeVersion` / `agentVersion` likewise recorded, not compared.

The principle, now written into `CorpusHeader`'s doc comment: a header rejection means *"this
comparison would be meaningless"*; a fingerprint mismatch means *"something that matters changed"*.
A changed agent or Node version belongs in the second category — the useful outcome is `--verify`
naming the configs that moved, not a blanket refusal to look. Rejecting on those would have turned
this bullet's most informative signal into silence.

**2. P2 had never been run at its pre-committed scale.** The criterion says ≥20 configs; the spec
covered **1** and the standalone runner did **2**, described in its own comment as "a small
demonstration/smoke run, not the full P2 sweep". The machinery was complete and correctly
negative-controlled — it had simply never been pointed at 20+ configs. Adjudicated by running it at
24 (0 mismatches), and the run now **lives in the standalone entry point** rather than in a scratch
file, so it stays repeatable.

**3. H2's isolation was recommended but not applied.** Sub-task C explicitly left it for E. Applied
as `assertSweepIsManual()` in `ensureHeadlessEngine()`. This required giving C's own H2 probe an
explicit `allowAutoSweep` opt-out — the guard and the experiment that justifies its existence have
to coexist, and that is the only caller permitted to use it.

**End-to-end proof that the fix works**, which was impossible before it:

```
[determinism] verified 300 config(s) from docs/data/determinism_corpus.json
[determinism] OK - 0 mismatches.
```

The corpus was also **fully regenerated** under the fixed code, hours after and in a different
process from the original run: **only the header changed — all 300 fingerprints reproduced
byte-for-byte.** That is an independent, unplanned replication of P1 at full scale.

---

## The seed contract for Milestone 4 onwards

Today there are two seeds: the Engine seed (`createGame({seed})` → `Game.newInstance`) and the
agent-decision seed (`createAgentRandom(agentSeed)`). Milestone 4 adds a third consumer —
**determinization**, sampling opponents' hands and the deck from the belief model.

**The contract: independent RNG streams per consumer, addressed by name, all derived
deterministically from a single documented run seed — so callers still pass one number.** Concretely
a `streamFor(runSeed, label)` over labels like `"engine"`, `"agent.decision"`,
`"agent.determinization"`, deriving each stream by **hashing `(runSeed, label)`** — not by positional
offsets, and not as a fixed three-tuple.

**Why separate streams.** The obvious reason is experiment control. The stronger reason: if
determinization and move selection share a stream, *the number of draws search makes* feeds back into
which worlds get sampled. Search draws a variable number of times depending on tree shape and
expansion order, so changing an unrelated search parameter — exploration constant, sims budget —
shifts the determinization stream too, and an outcome difference can no longer be attributed to the
parameter that changed. A shared stream does not merely constrain experiments; it makes M4's own
tuning uninterpretable.

**Why namespaced-by-label.** Three is not the final number: M4 plausibly wants rollout policy
separated from tree-selection tie-breaking, and M6 adds network initialisation, replay sampling and
Dirichlet exploration noise. Under a positional derivation, each new consumer perturbs the others and
forces a `seedDerivationVersion` bump that invalidates every committed fingerprint and self-play
batch. Under label-hashing, **adding a stream is additive** — no existing stream changes, so prior
corpora stay valid.

Four commitments:

- **Per-component override is not an escape hatch — it is the match harness's primary path.**
  Milestone 2 needs agent A and agent B to play *the same* 100 games, i.e. pin `"engine"` while the
  agent streams vary, on every invocation. One run seed derives every stream by default, *and* any
  stream can be pinned or varied explicitly.
- **The derivation is frozen once a corpus exists.** Record `seedDerivationVersion` in the header
  (already done — it is `1`, and unused until M4). Namespacing makes bumps rare, not free.
- **Hash derivation disposes of the `SeededRandom` degeneracy trap rather than managing it.** A
  32-bit value from splitmix64 or FNV over `runSeed ‖ label` gives well-separated states by
  construction. What it must still handle is that the two consumers disagree: `gameFactory.ts`
  divides by 2³² before calling `Game.newInstance`, while `rng.ts` passes `currentSeed` directly
  (Running Notes, 2026-07-22). The derivation must know which convention each label feeds. **This is
  the single most likely place for this bullet's work to be quietly undone.**
- **Labels are part of the frozen contract.** Renaming `"agent.decision"` changes its stream as
  surely as changing the hash does. Keep the label set in one place.

Implementing the derivation is **M4 work**; nothing was added to `rng.ts` now.

---

## What this changes

- **Plan §7.2** — *"Engine non-determinism breaks reproducibility / self-play"* is re-rated
  **Medium → Low**, with the evidence cited and the residual register above as the standing record.
- **CON-5 / NFR-5** — the Milestone-1 verification both requirements demand has been performed.
- **The regression corpus** (`docs/data/determinism_corpus.json`, 300 fingerprints with an
  environment header) becomes a standing check. It is also the **seed of Milestone 2's "regression
  suite of fixed seeds and reference games"** — M2 should extend it, not rebuild it.
- **Milestone 4** inherits a written seed contract instead of an open question, and inherits R3 as a
  bounded negative result rather than a clean bill of health.
- **Milestone 5** inherits two findings: live games are created under an unseeded seed and cannot be
  replayed from one (R6), and its use of `GameLoader.add()`/`getGame()` reopens R3 and R2.

---

## How to reproduce

From `agent/`:

```bash
npm test
```

```bash
npm run determinism -- --verify docs/data/determinism_corpus.json
```

```bash
npm run determinism:sweep
```

```bash
npm run determinism:cross-process
```

```bash
npx tsx src/determinism/contamination.ts --experiment all
```

For the heap figures R4 leaves unadjudicated, the accumulation experiment needs a collectable heap:

```bash
node --expose-gc --import tsx src/determinism/contamination.ts --experiment accumulation
```

To regenerate the corpus (the seed lists are committed in `src/determinism/sweep.ts`):

```bash
npm run determinism -- --players 2,3,4 --seeds "$(npx tsx -e "import {ENGINE_SEEDS} from './src/determinism/sweep'; console.log(ENGINE_SEEDS.join(','))" | tail -1)" --agent-seeds 1000003,2000133 --out docs/data/determinism_corpus.json
```

---

## One thing to resist

Do not read this as "determinism verified ✅". Two of the four hazards resolved to *not reachable
because embedded play doesn't call `GameLoader.add()`* — a fact about today's call graph, not about
the Engine. Milestone 5's live-play adapter is precisely the code that starts calling it, and the
mechanism behind R2 was demonstrated to empty a live game's log mid-play and then crash it. When that
milestone arrives, R2 and R3 must be re-adjudicated, not assumed to have stayed closed.
