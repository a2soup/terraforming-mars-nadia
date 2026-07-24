# Milestone 1, bullet 6 — sub-task prompts (Engine determinism verification)

Bullet 6 of Milestone 1: *"Verify Engine determinism under a fixed seed (SRS CON-5/NFR-5), and
confirm the Agent's search/determinization RNG is seeded separately from the Engine's. Record any
residual non-determinism as a risk."*

SRS **CON-5** requires determinism under fixed seeds to be *verified, not assumed*, at Milestone 1,
with the Engine seed and the Agent seed controlled separately. **NFR-5** requires embedded games to
be reproducible **move-for-move** given fixed seeds, a fixed Engine commit and a fixed Agent
version, and requires any residual non-determinism to be **recorded and isolated**. Plan §7.2
already carries the risk row *"Engine non-determinism breaks reproducibility / self-play — Medium"*;
this bullet is what lets that row be re-rated with evidence instead of retired by assumption.

Like bullet 5, this is a **verification bullet, not a feature bullet**. It changes nothing in the
Engine and nothing in the existing agent modules. Its output is evidence, a reusable regression
corpus, and edits to source-of-truth documents.

---

## What is already known — do not re-derive any of this

Four earlier bullets already produced determinism evidence. Re-running these is wasted effort; the
value of bullet 6 is entirely in the gaps *below* them.

| Established | Where | Strength |
| --- | --- | --- |
| Two same-seed `createGame()` calls produce byte-identical serialized state for everything RNG-driven (board, all four deck orders, dealt cards, milestone/award selection) | Running Notes 2026-07-21, bullet 1b | Strong, but **setup only** — no moves played |
| Exactly four field families differ between same-seed runs, all wall-clock-derived: `name`, `createdTimeMs`, `gameLog[].timestamp`, `players[].timer` | Running Notes 2026-07-21; encoded in `agent/src/engine/stableState.ts` | Strong, and independently re-confirmed as the right exclusion set for clone comparison (2026-07-22) |
| `SeededRandom(integerSeed)` is degenerate — every integer seed collapses to one stream; both `gameFactory.ts` and `rng.ts` work around it in *different* ways | Running Notes 2026-07-22 | Fixed, tested, and a live trap for anyone adding a third seeded component |
| A full 2p game replays identically (same `GameResult` + same `stableState`) under a fixed (engine seed, agent seed) pair, and varying either seed alone diverges | `agent/test/core/randomLegalAgent.integration.spec.ts:149-189` | **One seed pair, 2p only, same process, back-to-back** |
| The driver loop itself is reproducible across many real decisions | `agent/test/driver/embeddedDriver.spec.ts:222` | Same caveat |
| Replay from a quiescent ancestor reproduces exactly — 26,026 fork experiments, 100% exact | `agent/docs/Simulator_Speed_Spike.md`, bullet 5 sub-task D | Strong; this is the M4 search-determinism story and it is **done** |

So: determinism has been **spot-checked**, never **swept**. Every existing data point is same-process
and back-to-back, and all but the fork corpus are 2-player. Bullet 6 exists to close five specific
gaps.

---

## The five gaps this bullet closes

1. **Breadth.** One (engine seed, agent seed) pair at 2p is not a verification. Needed: many seeds ×
   {2p, 3p, 4p}.
2. **Process independence.** Every existing check runs two games in *one* Node process, one after
   the other. Nothing has ever verified that a fresh process reproduces a game — which is exactly
   what a match harness, a training run resumed after a crash, and any "reproduce that bug from the
   seed" workflow all depend on.
3. **Contamination / order independence.** The self-play-critical property, and the one nobody has
   tested: does game *K* still reproduce its solo result when replayed *after* a hundred unrelated
   games in the same process? The Engine holds process-wide mutable state that embedded play touches
   on every `Game.save()` (see the hazard list below). Milestones 4 and 6 will run thousands of games
   per process; if state leaks between them, reproducibility dies quietly and self-play data is
   subtly poisoned.
4. **Unseeded randomness, audited rather than assumed.** The Engine calls `Math.random()` in several
   places. Bullet 1b found one of them (`generateGameName`). Nobody has enumerated the rest or
   established *which are reachable under the in-scope configuration* — and "unreachable today"
   silently becomes "reachable" the moment a game option changes.
5. **Structural** proof of RNG separation. The current evidence is behavioural (vary one seed, the
   outcome changes). That demonstrates the seeds are *not the same seed*; it does not establish that
   no agent code path reaches into `game.rng`, `UnseededRandom`, `Math.random()`, or the wall clock.
   A structural check is cheap, is enforceable in CI, and is what actually holds the line as the
   decision core grows through M3–M6.

---

## Known hazards, already located — hand these to the sub-tasks, don't rediscover them

All verified by reading the pinned Engine. Each is a *candidate* residual non-determinism; sub-tasks
C and D decide which are real.

**H1 — `GameLoader` is a process-wide singleton with a growing cache, and embedded play feeds it.**
`Game.save()` (`src/server/Game.ts:464`) calls `GameLoader.getInstance().saveGame(this)`
unconditionally, and it is called during setup and repeatedly during play (`Game.ts:734, 750, 1164`).
`GameLoader` holds a `Cache` keyed by game id. `createGame()` builds the id as `g-nadia-${seed}`
(`agent/src/engine/gameFactory.ts:42`) — which means **the id does not include the player count**, so
seed 5 at 2p and seed 5 at 3p share an id, and any repeat of a seed re-uses an id already resident.
Whether that matters depends on whether anything reads back from the cache during embedded play.
Determine it; do not assume it.

**H2 — a wall-clock-driven sweep can mutate live games' logs, and it is env-var-gated.**
`Cache.sweep()` trims `gameLog` from resident games by idle time; `GameLoader.restoreLog()`
(`GameLoader.ts:218-224`) reloads a trimmed log **from the database** — which under the headless
no-op `Database` (`agent/src/engine/headlessEngine.ts`) returns `{}`. The sweep default is
`sweep: 'manual'` (`GameLoader.ts:285`), but `sweep: 'auto'` is selectable via the `GAME_CACHE`
environment variable and installs a `setTimeout`-driven sweep (`Cache.ts:50, 189-191`). Under `auto`
this is a timer-driven mutation of live game state on a wall-clock schedule. Confirm the default
holds in the headless bootstrap, and decide whether `ensureHeadlessEngine()` should assert on it.

**H3 — `Cache.mark()` on every END-phase deserialize.** `Game.ts:1846-1847` calls
`GameLoader.getInstance().mark(game.id)` when a deserialized game is in `Phase.END`; `Cache.mark`
does a `console.log` and adds a `Map` entry. Bullet 5 already documented this as an unbounded map
under heavy restore load. Relevant here because it is *another* accumulating process-global that a
long-lived self-play process will grow.

**H4 — env vars reach gameplay.** `Game.ts:1696` reads `process.env.MAX_GAME_DAYS`. `GAME_CACHE`
reaches H2. `SERVER_ID`/`STATS_ID` reach `server-ids.ts`. A reproducibility contract that does not
pin the environment is not a contract.

**H5 — unseeded randomness call sites** (complete list at the pin, from
`grep -rn 'Math\.random' src/ --include=*.ts` plus `UnseededRandom` usages):

| Site | Reached under base + CorpEra + Prelude, Tharsis? | Note |
| --- | --- | --- |
| `src/server/Game.ts:328` `generateGameName(UnseededRandom.INSTANCE)` | **Always** | Affects `name` only, already stripped by `stableState` |
| `src/server/ma/MilestoneAwardSelector.ts:95` | Only if `moonExpansion` | Out of scope — but **verify** the guard, don't trust the read |
| `src/server/ma/MilestoneAwardSelector.ts:196` + `inplaceShuffle(…, UnseededRandom.INSTANCE)` at `:188-189` | Only if `randomMA !== NONE`, or if `boardName` falls to the `default` branch | `randomMA` defaults to `NONE` (`GameOptions.ts:129`) and Tharsis is an explicit case — so unreachable *by default*, and one option flip from reachable. This is the highest-value guard in the bullet |
| `src/server/turmoil/PoliticalAgendas.ts:108` | No — Turmoil | Out of scope |
| `src/server/cards/ceos/Asimov.ts:53` | No — CEO module | Out of scope |
| `src/server/utils/server-ids.ts:3` | Module load only | Not gameplay; but it *does* make module-load state differ per process — relevant to sub-task C |
| `src/server/routes/ApiCreateGame.ts:176` (`const seed = Math.random()`) | No — HTTP route | **Flag for Milestone 5:** the live-play server picks its own unseeded seed. Not a bullet-6 defect; a bullet-6 *finding* to carry forward |

**H6 — `stableState` equality is end-state equality, not move-for-move.** NFR-5 says *move-for-move*.
Two runs can in principle reach the same end state by different routes (unlikely, but unverified),
and — more practically — an end-state-only check tells you *that* a divergence happened and gives
you a 200KB JSON diff to find it in. A rolling move-trace hash localizes a divergence to the first
differing decision. Sub-task A builds this; it is the difference between a check that satisfies NFR-5
literally and one that satisfies it in spirit.

---

## Pre-committed criteria — write these down before any number arrives

Bullet 5's gate was pre-committed before its measurements; do the same here, so a marginal result
can't be argued into a pass. **P1–P3 and P5 are blocking**; P4 and P6 are recorded findings.

- **P1 (blocking) — in-process replay.** For every combination of `players ∈ {2,3,4}` × ≥50 engine
  seeds × ≥2 agent seeds, two replays in one process produce identical move-trace hash, identical
  `stableState`, and identical `GameResult`. **Any** failure is a Milestone-1 blocker, isolated
  before M4/M6 proceed — not a recorded risk.
- **P2 (blocking) — process independence.** For ≥20 of those configs, a replay in a **fresh Node
  process** produces the same three hashes as the in-process run.
- **P3 (blocking) — order independence.** For ≥10 configs, a replay performed *after* ≥100 unrelated
  games in the same process reproduces the solo-run hashes exactly. This is the property M6 self-play
  rests on.
- **P4 (recorded) — the exclusion set is still exactly four field families.** Every field that
  differs between same-seed replays is in {`name`, `createdTimeMs`, `gameLog[].timestamp`,
  `players[].timer`}. A *new* differing field is not automatically a failure — but it must be
  diagnosed, and it may only be added to `stableState`'s exclusion set with a written justification
  that it cannot affect rules state. Silently widening the strip set would hollow out every
  determinism claim in the project.
- **P5 (blocking) — structural RNG separation.** No file under `agent/src` outside `agent/src/bench`
  reads `Math.random`, `Date.now`, `new Date`, `process.hrtime`, `UnseededRandom`, or `game.rng` /
  `.rng`. Enforced by a spec, not by review. (`agent/src/bench/harness.ts:33` legitimately uses
  `process.hrtime.bigint()` — that is the whole reason `bench` is the one allowlisted directory.)
- **P6 (recorded) — unseeded-randomness reachability.** The Engine call sites reachable under the
  in-scope configuration are exactly `{generateGameName}`, and that one affects only a stripped
  field. Anything else reachable is recorded as a risk with its trigger condition.

If P1, P2 or P3 fails, **stop and isolate** — the Milestone 1 exit criterion says embedded games are
reproducible move-for-move under fixed seeds, and a failure here means that criterion is not met.

---

## Sequencing — decided: bullet 6 runs before the 1,000-game AC-1 run

`agent/CLAUDE.md` §6 currently orders the remaining Milestone 1 work as: the 1,000-game AC-1
determinism/legality run → bullet 6 → bullet 7. **This is inverted: bullet 6 completes first**, then
the AC-1 run, then bullet 7. Update §6 accordingly (sub-task E owns that edit).

Compute is not what drives this. A full game's median wall-clock is 20.7 ms (2p) / 23.8 ms (3p) /
20.4 ms (4p) under `tsx` (`agent/docs/Simulator_Speed_Spike.md`), so the AC-1 run is ~21 seconds of
compute and bullet 6's entire sweep is the same order. Neither is expensive enough to schedule
around. Three information-flow reasons drive it instead:

1. **Sub-task C sets the rules the AC-1 run has to follow.** A 1,000-game batch is precisely the
   contamination scenario C investigates — 1,000 games in one process, all feeding `GameLoader`'s
   cache, under ids (`g-nadia-${seed}`) that don't include the player count and therefore collide
   (H1). If C finds order-dependence, the AC-1 run needs a fresh process every *N* games and has to
   be re-run. Worse: run it first and a contaminated batch can come back **green**, banking a result
   that isn't evidence of anything.
2. **Sub-task D's option guard is a pre-flight check for the batch.** It fails the moment the game
   factory's configuration drifts into a `Math.random()` path — cheaper to learn before 1,000 games
   than after.
3. **Sub-task A's harness makes the AC-1 run produce the regression corpus for free**, instead of
   the batch being pure throwaway compute.

**The one real cost, stated plainly:** legality/completion (zero illegal moves, zero crashes) is
*independent* of determinism, and this ordering serializes it behind determinism work. The 1,000-game
run is the highest-yield remaining bug-finding activity in Milestone 1 — the 20-game Tier-1 batch
already surfaced two genuine driver bugs — so delaying it delays those discoveries, and if a blocking
criterion (P1–P3) fails, isolation work happens with the legality question still open.

**Cheap hedge if that becomes uncomfortable:** the AC-1 run only depends on A, B and C. D is a static
audit and E is a write-up; neither constrains how the batch is executed. Starting the AC-1 run once C
reports gives up nothing.

---

## Routing — scale, and which model to run each on

| sub-task | rough scale | model | why |
| --- | --- | --- | --- |
| **A** — determinism harness + corpus format | ~300 lines src, ~150 lines spec | **Sonnet** | Fully specified below. The one subtle piece — instrumenting the move trace via a *responder wrapper* rather than by editing `embeddedDriver.ts` — is the technique bullet 5 sub-task B already used, and is spelled out again |
| **B** — the sweep: seeds × player counts, in-process and cross-process | ~250 lines, mostly harness invocation | **Sonnet** | Mechanical once A exists. Sharp edge (child-process replay under `tsx`, and what to compare across the boundary) is called out |
| **C** — contamination / order independence | ~300 lines + genuine investigation | **Opus** | This bullet's analogue of bullet 5 sub-task D: "run a lot of real games and find out what the Engine actually does." H1/H2/H3 are hypotheses, not findings. Highest unknown-Engine-behaviour per line |
| **D** — unseeded-randomness audit + RNG-separation guard | ~150 lines of spec + real reading | **Opus** | Reachability analysis over Engine code. This is precisely where a fast pass says "unreachable" without checking, and no test catches a wrong answer |
| **E** — analysis, risk record, document updates | ~400 lines of markdown | **Opus** | Judgment, and it edits the SRS/Plan/CLAUDE.md. It also adjudicates the blocking criteria and writes up the M4 seed contract (§3) — a wrong call on either is expensive and slow to detect |

**Haiku is not appropriate for any of these.** A determinism harness that reports "identical" when it
is comparing the wrong thing looks exactly like a passing harness.

**A blocks everything. B, C and D are independent after that. E consumes all three.**
Order: **A → (B, C, D in parallel) → E.**

---

## File ownership, so parallel work never edits the same file

| sub-task | owns |
| --- | --- |
| A | `agent/src/determinism/{types,replay,corpus}.ts`, `agent/src/runner/determinismCli.ts`, `agent/test/determinism/replay.spec.ts`, an `npm run determinism` script in `agent/package.json` |
| B | `agent/src/determinism/sweep.ts`, `agent/src/determinism/childReplay.ts`, `agent/docs/data/determinism_corpus.json` |
| C | `agent/src/determinism/contamination.ts` |
| D | `agent/test/determinism/rngSeparation.spec.ts`, `agent/test/determinism/unseededRandomness.spec.ts` |
| E | `agent/docs/Determinism_Verification.md`, `agent/docs/Running_Notes.md`, `agent/docs/Terraforming_Mars_AI_SRS_v1.2.md`, `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md`, `agent/CLAUDE.md` |

**Nobody edits** `embeddedDriver.ts`, `snapshot.ts`, `stableState.ts`, `gameFactory.ts`, `rng.ts`, or
anything under `src/`. Sub-task D may *propose* a change to `stableState.ts`'s exclusion set (P4);
sub-task E applies it if justified.

---

## Shared preamble (prepend to every sub-task below)

> You are working on the **Nadia** Terraforming Mars agent, in the `agent/` module of a
> terraforming-mars fork. Read `agent/CLAUDE.md` (especially §2 on the Engine pin, §5 on the Engine
> interfaces, §6 for current status, and §9's standing conventions) and the root `CLAUDE.md`. Then
> read, in full:
> - `agent/docs/Milestone1_Bullet6_Prompts.md` — this document, especially *"What is already known"*,
>   *"Known hazards"* (H1–H6) and *"Pre-committed criteria"* (P1–P6). Every hazard you need has
>   already been located; your job is to determine which are real, not to find them again.
> - **Running Notes 2026-07-21, "Headless game-factory runner"** — its *Determinism finding* section
>   is the four-field exclusion set everything here builds on.
> - **Running Notes 2026-07-22, "`SeededRandom(integerSeed)` is degenerate"** — the seeding trap.
> - `agent/src/engine/stableState.ts` and `agent/src/core/rng.ts` in full — short, and they are the
>   two files that define what "the same game" and "the same agent" mean.
>
> **The one hard rule:** the Engine is **immutable ground truth** (SRS CON-1). This bullet verifies;
> it does not fix. If you find genuine Engine non-determinism, **record it** — do not patch `src/`.
> Likewise, do not edit the existing agent modules (`embeddedDriver.ts`, `snapshot.ts`,
> `stableState.ts`, `gameFactory.ts`, `rng.ts`); they are load-bearing and spec-covered. Instrument
> from the outside — every sub-task below says how. If you become convinced an existing file must
> change, stop and say so in your summary rather than changing it.
>
> **A green result is the suspicious one.** This bullet's failure mode is a harness that compares
> something trivially equal (two hashes of the same object, a `stableState` that strips the field
> that was going to differ, a "fresh process" that isn't) and reports determinism it never tested.
> For every check you write, include at least one **negative control** — a deliberately perturbed
> input that the check must flag. A check that has never failed has not been shown to work.
>
> **Cost discipline.** A 2p random-legal game is fast, but this bullet multiplies games by seeds by
> player counts by repetitions. Use the bullet-5 measurements in
> `agent/docs/Simulator_Speed_Spike.md` for a runtime estimate before launching a sweep, and note
> that **`tsx` understates the simulator ~3.5×** — no timing you take here is a performance figure.

---

## Sub-task A — the determinism harness and the corpus format (do this first)

Build the primitive everything else calls: *replay a fully-specified configuration and return
comparable hashes.*

### 1. Types (`agent/src/determinism/types.ts`)

```
ReplayConfig  = {players: 2|3|4, engineSeed: number, agentSeed: number}
ReplayFingerprint = {
  config: ReplayConfig,
  moveTraceHash: string,     // rolling hash over the decision sequence — see below
  stableStateHash: string,   // sha256 of stableState(game)
  resultHash: string,        // sha256 of JSON.stringify(computeResult(game))
  decisions: number,         // count of decision points consumed
  fallbacks: number,         // FR-9 conservative-fallback firings (via EmbeddedDriverOptions)
  generation: number,
}
```

Hashes, not raw state: the corpus must be committable and diffable. But keep the raw
`stableState` available behind an option — when a comparison fails you need the actual diff, and
re-running to get it wastes the failure.

### 2. The move trace (`replay.ts`) — the part that satisfies NFR-5 literally

NFR-5 says *move-for-move*, not *same end state* (hazard H6). Capture the move sequence by
**wrapping the responder**, exactly as bullet 5 sub-task B instrumented runtime — do **not** add a
hook to `embeddedDriver.ts`:

```
wrapped = (decision) => {
  const before = pendingSignature(decision.game);   // agent/src/engine/snapshot.ts:127
  const response = inner(decision);
  trace.update(`${before}|${decision.player.id}|${decision.model.type}|${stableStringify(response)}`);
  return response;
}
```

(`DecisionPoint` is `{player, model, game}` and `EmbeddedDecisionPoint` adds `raw` —
`agent/src/driver/decisionPoint.ts:11-25`. Use `model.type`, not `raw.type`: the model is already
built by the time the responder sees it, so reading it is free, and it is the field the live-play
transport will also have.)

Three details that decide whether this is worth anything:

- **`pendingSignature` is free** — it reads `PlayerInput.type` and never calls `toModel()` (which
  bullet 5 measured at 7% of a decision). Including it costs nothing and makes the trace sensitive to
  *which decision was presented*, not only to what the agent answered.
- **Serialize the `InputResponse` with sorted keys.** `JSON.stringify` preserves insertion order, so
  two structurally identical responses built by different code paths can hash differently. That would
  produce a false divergence — the worst possible outcome for this bullet, because it looks like a
  real finding.
- **The trace must be a rolling hash that records the first divergence index.** Store
  `(index, previousHash)` at each step so a comparison can report *"diverged at decision 147"* plus
  the two responses, rather than "hashes differ". Every downstream sub-task's failure reports depend
  on this.

`replay(config, options) -> ReplayFingerprint` composes `createGame` → `randomLegalAgent(createAgentRandom(agentSeed))` → wrapped responder → `runGame`.

### 3. Corpus format and CLI

`corpus.ts`: load/save a JSON array of `ReplayFingerprint`, with a header recording **Engine commit,
Node version, agent version, a `seedDerivationVersion` field, and the values of `GAME_CACHE` /
`MAX_GAME_DAYS`** (hazard H4). A corpus without its environment is not reproducible.

`seedDerivationVersion` is a forward hook for Milestone 4. `ReplayConfig` stays a flat
`{players, engineSeed, agentSeed}` here — do **not** implement seed derivation now — but M4 adds
per-consumer streams addressed by name and derived from a single run seed, and any change to that
derivation invalidates every committed fingerprint. Because the M4 contract derives each stream by
hashing `(runSeed, label)`, *adding* a stream won't bump this field — only changing the hash or
renaming a label will, which is why it's worth one string to record now rather than a format break
later. Set it to `1` and note in the doc comment that it is unused until M4. See sub-task E §3 for the
full contract.

`agent/src/runner/determinismCli.ts` with `--players`, `--seeds`, `--agent-seeds`, `--repeat`,
`--out`, `--verify <corpus.json>`, and `--list`. `--verify` is the durable payoff: it re-runs a
committed corpus and reports every divergence. Wire `npm run determinism` in `agent/package.json`.

### 4. Spec (`agent/test/determinism/replay.spec.ts`)

Correctness of the harness itself, not a determinism sweep (that's B). Must include the negative
controls: a trace that *does* diverge is detected and its first-divergence index is right; key-order
differences in an `InputResponse` do **not** produce a divergence; a corpus with a mismatched header
is rejected rather than silently compared.

---

## Sub-task B — the sweep: seeds, player counts, and a fresh process

Answers P1, P2 and P4.

### In-process (P1)

`sweep.ts`: for `players ∈ {2,3,4}` × ≥50 engine seeds × ≥2 agent seeds, run `replay` twice and
compare all three hashes. Report a table of (configs run, divergences, first-divergence details).
Seeds should be a **fixed, committed list** — not `Math.random()`, and not a bare range if a range
correlates with anything (it shouldn't, but a committed explicit list costs nothing and removes the
question).

Also assert the *independence* direction over the whole sweep, not on one pair: holding the engine
seed fixed and varying the agent seed must change the outcome for the large majority of configs, and
vice versa. Expect near-100%, not exactly 100% — two agent seeds can coincidentally produce the same
game, especially in short games. **Report the rate; do not assert equality to 1.0.** A hard assertion
here would be a flaky test that occasionally reports a determinism failure that isn't one.

### P4 — the exclusion set

For a sample of configs, diff the **raw** `serialize()` output (not `stableState`) between same-seed
replays and enumerate every differing JSON path. The expected answer is exactly the four known field
families. Report anything else with its path and both values. Do **not** add anything to
`stableState`'s exclusion set — that decision belongs to E.

### Cross-process (P2)

`childReplay.ts`: spawn a fresh Node process per config and read back a `ReplayFingerprint` as JSON.
Three things that will otherwise bite:

- **`tsx` startup dominates.** A child-process replay pays full module-load cost every time, so ≥20
  configs is the target, not ≥1,000. Batch several configs per child if it helps, but keep at least
  some children running exactly one config — a child that runs several configs no longer tests
  process independence for any but the first.
- **Compare against the in-process fingerprints from P1**, not against a second child. Two children
  agreeing tells you less than a child agreeing with the parent.
- **Pass the environment explicitly** and record it in the output. If a child inherits a different
  `GAME_CACHE` than the parent, a divergence is meaningless (and a *non*-divergence is worse — it
  means the env var doesn't do what H2 says, which is itself a finding worth reporting).

Negative control: perturb one child's agent seed by 1 and confirm the comparison flags it.

---

## Sub-task C — contamination and order independence (the investigation)

Answers P3, and turns hazards H1/H2/H3 into findings. This is the sub-task with real unknowns.

### 1. The core experiment

Pick ≥10 configs with known solo fingerprints (from A). For each:

1. Run it alone in a fresh process → fingerprint `solo`.
2. In a fresh process, run ≥100 *unrelated* games (varied player counts and seeds), then run the
   config → fingerprint `after`.
3. Compare. `solo === after` is P3.

Then the sharper variants, because the generic version may pass while a specific one fails:

- **Same-id collision (H1).** `createGame` ids are `g-nadia-${seed}` with no player count. Run
  `{players: 2, engineSeed: 5}` and then `{players: 3, engineSeed: 5}` — same id, different game —
  and check both against their solo fingerprints. Then run the *same* config twice and check the
  second against solo. If either diverges, you have found the bullet's headline result.
- **Interleaving.** Two games driven alternately, decision by decision, each compared against its
  solo fingerprint. `runGame` drives to completion, so use `applyDecision`
  (`embeddedDriver.ts:365`) to step them. This is the pattern M4 search and M6 self-play will
  actually produce, and it is the one least like anything tested so far.
- **Accumulation (H3).** Track `GameLoader` cache size / `Cache.mark` map growth across a long run.
  Bullet 5 flagged the mark map as unbounded; quantify it here (games resident after 100/500 games,
  and whether anything is ever evicted under `sweep: 'manual'`). A memory leak is not
  non-determinism, but a leak that triggers GC pressure or an eviction *is* a path to it, and M6 runs
  long processes.

### 2. The sweep hazard (H2) — decide it, don't leave it open

Establish empirically: (a) that `sweep` defaults to `'manual'` in the headless bootstrap; (b) what
happens under `GAME_CACHE` with `sweep=auto` and a short `idle_age` — specifically whether a live
game's `gameLog` is trimmed mid-play and whether `restoreLog` against the no-op `Database` corrupts
it. You can force this quickly with a short idle age rather than waiting an hour.

If it does corrupt a live game, that is a **recorded risk with a named trigger**, and the mitigation
is an assertion in the headless bootstrap — proposed by you, applied by E. Do not implement the
mitigation yourself (`headlessEngine.ts` is not yours to edit); write the recommendation.

### 3. What to report

For each hazard: **confirmed / not reachable / not applicable**, with the evidence. A hazard you
could not trigger is a legitimate result — say so and say what you tried, so nobody re-runs it in M4.
If P3 fails, isolate the *minimum* number of intervening games that reproduces it; that number is
what makes the finding actionable.

---

## Sub-task D — unseeded randomness and structural RNG separation

Answers P5 and P6. Two specs, both cheap, both enforceable in CI. This is the bullet's second
explicit clause ("confirm the Agent's search/determinization RNG is seeded separately from the
Engine's") turned into something that stays true.

### 1. `rngSeparation.spec.ts` (P5)

A source-level guard: read every `.ts` under `agent/src`, excluding `agent/src/bench` (which
legitimately times things — `harness.ts:33` uses `process.hrtime.bigint()`), and fail on
`Math.random`, `Date.now`, `new Date`, `process.hrtime`, `UnseededRandom`, and any read of `.rng` on
a game object. Allowlist by explicit path with a written reason, never by pattern — a pattern-based
allowlist silently grows.

Include a **positive** assertion too: the only randomness entering agent decision code is
`AgentRandom` from `createAgentRandom`, and the only randomness entering the Engine is the seed
passed to `Game.newInstance`. State it as a test with a comment explaining the contract, so the next
person to add a search module knows where the line is.

Negative control: a fixture string containing `Math.random()` must be flagged. Without it, a broken
regex passes silently and the guard is decorative.

### 2. `unseededRandomness.spec.ts` (P6)

For the H5 table: assert that a game created by `createGame()` has the option values that make each
out-of-scope site unreachable — `randomMA === RandomMAOptionType.NONE`, `boardName === THARSIS`,
`moonExpansion` false, `turmoilExtension` false, `venusNextExtension` false. This is the guard that
matters: it fails the day someone flips an option and silently reintroduces `Math.random()` into
milestone/award selection. Write the failure message to say *that*, not "expected NONE to equal
NONE".

Then verify the reachability claims by reading the code rather than trusting the table above — in
particular `MilestoneAwardSelector.ts:66-100`'s `default:` branch, which routes an unrecognised
board straight into the unseeded path. Report any site the table gets wrong; the table was built by
reading, not by execution.

### 3. Report

The completed H5 table with each row marked verified-unreachable / reachable-and-harmless /
reachable-and-material, plus the `ApiCreateGame.ts:176` finding carried forward as a Milestone-5
note (the live-play server chooses its own unseeded seed — which does not break embedded
reproducibility, but does mean a live game cannot be replayed from a seed the Agent knows).

---

## Sub-task E — analysis, the risk record, and the document updates

Consumes B, C and D. This is judgment, not code.

### 1. Adjudicate P1–P6

State each as met / not met, with the evidence and the sample size. If a blocking criterion failed,
say plainly that the Milestone 1 exit criterion "embedded games are reproducible move-for-move under
fixed seeds" is **not yet met**, and what has to happen. Do not soften a blocking failure into a
recorded risk — the pre-commitment above exists precisely to make that unavailable.

### 2. Decide the P4 question

If sub-task B found fields outside the known four, decide for each: extend `stableState`'s exclusion
set (with a written justification that it cannot affect rules state) or record it as residual
non-determinism. Apply the change if you make it; `stableState.ts`'s doc comment must grow the
reasoning, not just the field.

### 3. The seed contract for M4 onwards — already decided; write it up and make it real

Today there are two seeds: the Engine seed and the agent-decision seed. Milestone 4 adds a third
consumer — **determinization** (sampling opponents' hands and the deck from the belief model).

**The decision (made, not open): independent RNG streams per consumer, addressed by name, all derived
deterministically from a single documented run seed — so callers still pass one number.** Concretely,
a `streamFor(runSeed, label)` function over labels like `"engine"`, `"agent.decision"`,
`"agent.determinization"`, deriving each stream by **hashing `(runSeed, label)`** — *not* by
positional offsets from the run seed, and *not* as a fixed three-tuple.

**Why separate streams at all** (record this; it is stronger than the obvious experiment-control
argument): if determinization and move selection share a stream, the *number of draws search makes*
feeds back into which worlds get sampled. Search draws a variable number of times depending on tree
shape and expansion order, so changing an unrelated search parameter — exploration constant, sims
budget — shifts the determinization stream too, and an outcome difference can no longer be attributed
to the parameter that changed. A shared stream isn't merely less flexible; it makes M4's own tuning
uninterpretable. Separate streams also let you hold the game and the sampled worlds fixed while
varying search, or hold everything fixed and vary only the worlds to measure variance across
determinizations.

**Why namespaced-by-label rather than a three-tuple.** Three is not the final number. M4 alone
plausibly wants rollout policy separated from tree-selection tie-breaking; M6 adds network
initialisation, replay sampling, and Dirichlet exploration noise. Under a positional derivation each
new consumer perturbs the others, forcing a `seedDerivationVersion` bump that — by the freeze rule
below — invalidates every committed fingerprint and every self-play batch. Under label-hashing,
**adding a stream is additive: no existing stream changes, so prior corpora stay valid.** That turns
the freeze constraint from a recurring tax into a rare event.

Four things this commits you to. Write each into the contract:

- **Per-component override is not an escape hatch — it is the match harness's primary path.**
  Milestone 2 needs agent A and agent B to play *the same* 100 games, which means pinning the
  `"engine"` stream while the agent streams vary, on every harness invocation. The contract is: one
  run seed derives every stream by default, *and* any individual stream can be pinned or varied
  explicitly. Document the override path as the normal M2 mode, not the exception.
- **The derivation function is frozen once a corpus exists.** Changing how `(runSeed, label)` maps to
  a stream silently invalidates every committed fingerprint and self-play batch. Version it, and
  record the version in the corpus header alongside the Engine commit. Namespacing makes bumps rare;
  it does not make them free.
- **Hash derivation disposes of the `SeededRandom` degeneracy trap rather than managing it.** A
  32-bit value from splitmix64 or FNV over `runSeed ‖ label` gives well-separated states by
  construction, so you never reason about whether mulberry32 decorrelates near-adjacent seeds. What
  the derivation still must handle is that its two *consumers* disagree: `gameFactory.ts` divides its
  integer seed by 2\*\*32 before handing it to `Game.newInstance`, while `rng.ts` passes `currentSeed`
  directly (Running Notes 2026-07-22). The derivation has to know which convention each label feeds,
  or emit values correct under both. **This is the single most likely place for this bullet's work to
  be quietly undone.**
- **Labels are part of the frozen contract too.** Renaming `"agent.decision"` changes its stream as
  surely as changing the hash does. Keep the label set in one place with a comment saying so.

The contract belongs in `Determinism_Verification.md` and in the SRS's CON-5 annotation. Implementing
the derivation is **M4 work, not bullet 6** — do not add a third seed to `rng.ts` now. Bullet 6's job
is to write the contract down while the reasoning is fresh and while the corpus format can still
accommodate it.

### 4. Deliverables

- **`agent/docs/Determinism_Verification.md`** — the bullet's deliverable, mirroring
  `Simulator_Speed_Spike.md`'s role for bullet 5: what was verified, at what scale, the P1–P6
  adjudication, the completed H5 table, the residual-non-determinism register, and how to re-run
  everything (`npm run determinism -- --verify …`).
- **A committed regression corpus** (`agent/docs/data/determinism_corpus.json`) with its environment
  header. Note in the doc that this feeds Milestone 2's "regression suite of fixed seeds and
  reference games", so M2 doesn't rebuild it.
- **Running Notes entry** (dated, appended) — the findings that will otherwise be rediscovered,
  especially anything sub-task C turned up about process-global state.
- **Plan §7.2 risk register** — re-rate *"Engine non-determinism breaks reproducibility / self-play"*
  from Medium with evidence, and add rows for whatever residual non-determinism was actually found
  (H2's env-gated sweep is the likeliest candidate). NFR-5 requires residual non-determinism to be
  recorded **and isolated**: for each row, name the isolation mechanism, not just the risk.
- **Plan Milestone 1 bullet 6** — mark done with a one-line result and a pointer to the doc, in the
  same style as bullet 5's "DONE, PASSED (24 Jul 2026)" line.
- **SRS CON-5 / NFR-5** — annotate that the Milestone-1 verification these requirements demand has
  been performed, with the pointer.
- **`agent/CLAUDE.md` §6** — update current status and the "next up" line (bullet 7, the card-coverage
  audit, plus the 1,000-game AC-1 run if it hasn't happened yet).

### 5. One thing to resist

Do not let this become "determinism verified ✅". The honest headline is a scope statement: *what
was verified, at what scale, under which environment, and what remains unverified.* In particular,
if sub-task C could not trigger a hazard, that is not proof the hazard is absent — it is a bounded
negative result, and M4/M6 should inherit it as a bounded negative result. Bullet 5's write-up is the
model: it reported the numbers that overturned four documented assumptions, not just the pass.
