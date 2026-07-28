# Milestone 2, bullet 1 — phase prompts (the match runner)

Bullet 1 of Milestone 2: *"Build the match runner that plays N games between any two agent versions
under controlled seeds and records full histories. Two players is the primary setting; support three
players so the AC-5 competence check and the AC-8 calibration report can be produced."*

This bullet discharges **SRS FR-13** ("a headless match runner that plays large numbers of games
between specified agent versions (and baselines) under controlled seeds, recording outcomes and full
move histories") and builds the substrate for FR-14 (bullet 3, ratings), FR-DATA-1 (bullet 4, the
expert-distribution report), FR-15/AC-7 (the promotion gate), AC-3, AC-5 and AC-8.

It is the **first feature bullet since Milestone 1 bullet 4**. Bullets 5, 6 and 7 were verification
bullets that changed nothing; this one adds a new top-level agent module. The discipline that made
those bullets safe still applies and is restated in the preamble: `src/` is untouched (CON-1), and
the existing agent modules — `driver/`, `engine/`, `core/`, `determinism/` — are load-bearing,
spec-covered and **not modified by this bullet**, only wrapped.

**The thing to understand before reading further.** Every number this project will ever quote about
playing strength comes out of this runner: M3's tuned weights, M4's significance test, the AC-7
promotion gate, the AC-3/AC-5 evidence, the AC-8 calibration. `agent/CLAUDE.md` §9 says it outright —
*"Measure everything through the Milestone 2 harness — it is the single source of truth for
strength."* A biased runner does not produce a wrong number that someone later notices; it produces a
plausible number that steers two years of tuning. Two specific ways that happens are settled in
§4 below (seat balancing, and the record schema) rather than left to the implementer.

---

## 1. Scope — what this bullet is, and what it is not

**In scope (bullet 1):**

| | |
| --- | --- |
| A **named, versioned agent registry** | so "agent version" is a first-class, recordable identity, not a closure someone passed in |
| A **match specification**: lineup, player count, N, seeds | the reproducible unit of measurement |
| **Seat balancing / pairing** | the design that makes a win rate mean something (§4.1) |
| **Per-seat responder routing** | `runGame` takes one responder; a match needs one per seat |
| **Ranking with the Engine's real tiebreak** | placement, not just "who had most VP" (§4.2, hazard H1) |
| **The per-game record schema** | designed once against *every* downstream consumer (§4.3) |
| **Full history capture and replay verification** | FR-13's "full move histories", and proof they replay (§4.4) |
| **The batch loop, a CLI, an artifact writer** | `npm run match` |
| **Parallel execution and its throughput measurement** | the spike explicitly deferred this here (§4.5) |
| **The AC-1 legality accounting, absorbed** | decided: the runner carries the strict submission accounting so a promoted version's AC-1 re-run is a mode of a match, not a second run (§4.6) |

**Not in scope — later bullets of Milestone 2, do not build them here:**

- **Win rate, Elo/TrueSkill, confidence intervals, significance tests** — bullet 3. This bullet
  records the *inputs* to those statistics and computes nothing beyond the counts needed for its own
  pre-committed criteria (§6).
- **The greedy one-ply baseline (OSLA)** — bullet 2. This bullet ships the registry that will hold
  it, and `random-legal` is the only entry in it.
- **The expert-distribution report and the BGA↔engine reconciliation** — bullet 4. This bullet's job
  toward it is to record the fields it needs (§4.3) so bullet 4 is an analysis, not a re-run.
- **The regression suite of fixed seeds and reference games** — bullet 5.

The scope boundary that matters most: **the record schema is bullet 1's responsibility even though
bullets 3 and 4 are its consumers.** Re-running is cheap for the random-legal agent (~10 ms/game
compiled) and expensive for every agent after it. A schema that omits, say, the corporation each
player took costs a 1,000-game re-run today and a multi-hour one at M4.

---

## 2. What is already known — do not re-derive any of this

Everything here was established while writing this document, by reading the code at the pinned
Engine commit (`868714d72a434ab68fe08e5570ebc6863859ae15`) and by reading the Milestone 1
deliverables. Re-deriving it is wasted session time.

### The runner has more prior art than it looks like

| You need | It already exists | Where |
| --- | --- | --- |
| Create a headless 2–4p base+CorpEra+Prelude game from a seed | `createGame(config)` | `agent/src/engine/gameFactory.ts` |
| Drive a game to `Phase.END` with FR-9 recovery | `runGame(game, responder, options)` | `agent/src/driver/embeddedDriver.ts` |
| A batch loop that yields between games and survives failures | `runLegalityBatch` | `agent/src/legality/run.ts` |
| A seed schedule built from two independent progressions | `buildLegalityConfigs` | `agent/src/legality/seeds.ts` |
| Per-decision instrumentation without touching the driver | responder wrapper (`withMoveTrace`) | `agent/src/determinism/replay.ts` |
| Submission-boundary instrumentation | `Player.prototype.process` wrap | `agent/src/legality/submissionMonitor.ts` |
| A hash chain that localizes a divergence to a decision index | `MoveTrace` / `firstDivergence` | `agent/src/determinism/replay.ts` |
| Per-seat responders, already proven to work | `ReadonlyMap<PlayerId, EmbeddedResponder>` | `agent/demo/match.ts:53` |
| A named agent roster keyed by string | `AGENTS` record | `agent/demo/agents.ts` |
| A child-process worker | `childReplay.ts` | `agent/src/determinism/childReplay.ts` |
| CLI arg-parsing house style (switch over `argv`, no dependency) | `legalityCli.ts` | `agent/src/runner/legalityCli.ts` |
| Artifact write + percentile summary helpers | `artifact.ts`, `percentiles()` | `agent/src/legality/` |

**`runGame` needs no change to support per-seat agents.** `demo/match.ts` already routes by
`player.id` into a map and calls the driver's `applyDecision`. A match runner does the same thing
one level up: pass `runGame` a single responder that is a *router* closing over the seat map. The
driver stays untouched.

### The measured cost of a game (AC-1 artifact, `agent/docs/data/ac1_legality_run.json`)

1,500 random-legal games, single process, under `tsx`:

| | value |
| --- | --- |
| decisions/game | min 170, p50 **289**, p95 397, max 551, mean 296.5 |
| generations/game | min 9, p50 **20**, p95 30, max 41, mean 20.4 |
| duration/game | min 16 ms, p50 **32 ms**, p95 49 ms, max 96 ms, mean 33.2 ms |
| whole run | 50.9 s for 1,500 games |
| responder throws (FR-9 class B) | 8,480 — i.e. **~5.7 per game**, not an edge case (see H2) |
| Agent-attributable rejections | 0 |

Compiled (not `tsx`) the simulator is ~3.5× faster: **38.1 games/s at 2p on one core**
(`docs/Simulator_Speed_Spike.md` §5). So a 1,000-game 2p random-vs-random match is **~26 s on one
core compiled**, ~35 s under `tsx`. Cost is not a constraint for this bullet's own validation runs;
it becomes one the moment an M4 search agent is seated, which is why §4.5 exists.

### The Engine's real winner rule is in the *client*, and `computeResult` does not implement it

`agent/src/driver/gameResult.ts` computes `winners` as "everyone tied for max VP" and says so in its
own doc comment: *"not the game's full tiebreak rules … Real tiebreaking belongs to the match
harness/ratings pipeline (Milestone 2), not this driver."* This bullet is that harness.

The authoritative rule is `playersInPlace` / `winners` in
`src/client/components/GameEnd.vue:292-320`: **sort by `victoryPointsBreakdown.total`, then by
`megacredits`, descending; winners are everyone matching the leader on both.** There is no
server-side equivalent — `Game.gotoEndGame()` (`src/server/Game.ts:1116-1122`) only writes
`{corporation, playerScore}` rows to the database and never ranks. Do not go looking for one.

### What is free to read at `Phase.END`

All of this is on the live `IGame`/`IPlayer` the moment the game ends, and costs nothing to record —
but costs a full re-run to add later:

`player.getVictoryPoints()` (the whole `VictoryPointsBreakdown`: `terraformRating`, `milestones`,
`awards`, `greenery`, `city`, `victoryPoints`, `total`, plus `detailsCards`, `detailsMilestones`,
`detailsAwards`), `player.megaCredits`, `player.terraformRating`, `player.playedCards`,
`player.victoryPointsByGeneration` (a per-generation VP curve — free, and exactly the shape AC-8 and
M3 want), `game.generation`, `game.claimedMilestones`, `game.fundedAwards`.

### Milestone 1 facts that constrain this bullet

- **Determinism is verified move-for-move** under a fixed (engine seed, agent seed, engine commit,
  agent version) — 300 configs in-process, 24 cross-process, 12 under interleaving
  (`docs/Determinism_Verification.md`). This is what makes a *seed-addressed* history sound: a
  recorded match can be re-derived exactly rather than only replayed from a stored move list.
- **The M4 seed contract is settled but is M4 work.** Independent per-consumer streams addressed by
  name, derived by hashing `(runSeed, label)`. `agent/CLAUDE.md` §6: *"do not add a third seed to
  `rng.ts` now."* This bullet therefore uses explicit arithmetic progressions in the style of
  `legality/seeds.ts`, not a new hashing scheme. §4.1 states the schedule.
- **The 300-fingerprint determinism corpus is a standing regression check** and it hashes
  `JSON.stringify(GameResult)` into `resultHash` (`determinism/types.ts:57`). See hazard H1.
- **AC-1 is agent-specific and expires on every new agent version** (`agent/CLAUDE.md` §6, standing
  caveat). The match runner is where AC-7 and the re-run of AC-1 will both be invoked from; the
  record must carry enough identity for that (agent name **and** version, engine commit).

---

## 3. The four questions bullet 1 conflates

Stating them separately is what stops the runner from being "a loop that plays games."

1. **What is an agent version?** A recordable identity that makes two results comparable or not.
   Today an agent is an anonymous closure. (Unit A)
2. **What makes a win rate mean something?** Seat/turn-order advantage is real in Terraforming Mars
   and is not a rounding error. Unbalanced seating turns a 50/50 pair into whatever the seat
   advantage is. (Unit A, §4.1)
3. **What is a "full history", and is the recorded one true?** FR-13 says record them. A history that
   silently omits the decisions the FR-9 fallback resolved — ~5.7 per game — is worse than no
   history. (Unit B)
4. **Does the runner scale to the agents it exists to measure?** Random-legal is free. An M4 search
   agent at 250–500 sims/decision is not, and the ×8 core-scaling figure in the speed spike is
   explicitly *an assumption the spike deferred to this harness*. (Unit C)

---

## 4. Design decisions settled here — implement these, do not re-litigate them

These are settled in this document, before any code, for the same reason the criteria are
pre-committed: each one is a place where a defensible-looking local choice produces a
systematically wrong number.

### 4.1 Seat balancing: full-permutation pairing groups on a shared engine seed

**The problem.** In 2p Terraforming Mars the first player and the specific opening deal are both
advantages. `createGame` fixes `firstPlayerIndex = 0` and a fixed colour order
(`gameConfig.ts`), so seat 0 always leads. If agent A is always seated at 0, A's measured win rate is
(A's strength) + (the seat-0 advantage), and nothing in the output says which is which.

**The decision.** The unit of measurement is a **pairing group**, not a game:

- A group fixes one **engine seed** — so every game in the group starts from the identical board and
  identical deal. This is the variance reduction; it is real and it is the main reason to do this.
- A group plays the lineup in **every seat permutation**: `n!` games for `n ≤ 3` (2p → 2 games,
  3p → 6 games). For 4p use the **4 cyclic rotations**, not all 24 — full `S_4` is a 6× cost for
  balance a Latin square already gives. (4p support is confirmed in scope; see §4.7.)
- `N` is therefore specified as a **number of groups**; total games = groups × permutations. A CLI
  that accepts a raw game count must round it and say so, never silently truncate a group.

**Agent seeds travel with the lineup slot, not the seat.** Within a group, the agent in lineup
slot *k* uses the same agent seed in all permutations. State honestly what this buys: it is *not*
common random numbers in any strong sense — the two games diverge at the first decision and the
streams are consumed differently thereafter. It buys full specification of the group from
`(groupIndex)` alone, and it removes "the agent got a different seed" as a candidate explanation for
a within-group difference. The variance reduction comes from the shared **engine** seed.

**The mirror claim, stated correctly.** Sharing the engine seed makes the *initial position*
identical across the group — same board, same deal, same corporations offered to each seat. It does
**not** make the games mirror images; they diverge at the first decision. Do not write "paired
games" in the write-up in a way that implies more than this.

**The seed schedule** — two independent arithmetic progressions with distinct prime strides, in the
style of `legality/seeds.ts` and with bases clear of both the determinism corpus (base 500,000) and
the AC-1 run (bases 700,000 / 3,100,007), so match games are new games, not replays of either.
Pick the bases in Unit A and document them in the module the way `seeds.ts` documents its own.

### 4.2 Ranking: a new module, and `gameResult.ts` is not touched

Implement the `GameEnd.vue` rule — VP descending, then megacredits descending; ties share a
placement — in a **new** `agent/src/match/ranking.ts`, producing per-seat `placement` (1-based,
ties sharing the lower number), `isWinner`, and the VP margin to the next placement.

`placement` rather than a boolean win is not a nicety: **AC-5 is stated in placement terms** ("finishes
first at a rate significantly above the 1/N chance baseline"), and a 3p record that only says "won:
false" cannot distinguish second from third.

Do **not** change `computeResult` or the `GameResult` type — see hazard H1.

### 4.3 The record schema is designed once, against every downstream consumer

Before writing the types, list the consumers and what each needs. The schema must satisfy all of
them, because it is being written now and populated by every run from now on:

| Consumer | Needs from the record |
| --- | --- |
| Bullet 3 (FR-14 ratings) | per-game per-seat placement, win/loss/draw, VP margin, agent identity per seat |
| Bullet 4 (FR-DATA-1, AC-8) | winning score, TR at game end, generations-to-finish, **corporation per seat**, **cards played per seat**, milestones/awards claimed |
| M3 (evaluation tuning) | the above plus `victoryPointsByGeneration`, VP breakdown by component |
| AC-5 | placement distribution at 3p/4p |
| AC-7 / FR-15 promotion gate | agent name **and version** per seat, engine commit, run seed |
| **AC-1 / NFR-4, per agent version (§4.6)** | completion flag, failure class+message, decisions, fallback counts split by class, **and — under the legality mode — every `player.process()` submission with its rejections attributed by source** |
| Reproducibility (NFR-5) | engine seed, per-seat agent seed, group index, permutation index, harness version |

Two structural rules:

- **Per-run header, per-game rows.** Anything constant across the run (engine commit, agent
  versions, run seed, harness version, timestamp, the pairing policy) goes in a header written once.
  A 1,000-game artifact that repeats the engine commit 1,000 times is a file nobody will diff — the
  same lesson `legality/types.ts` records for `LegalityGameRecord` ("deliberately small and flat").
- **The move history is not in the game row.** It is a separate, tiered artifact (§4.4).

### 4.4 "Full histories": three tiers, and the recorded one must be verified

FR-13 says "recording outcomes and full move histories". Since determinism is verified, there are
two defensible meanings and the runner should offer both, explicitly tiered:

| Tier | Content | Cost | Use |
| --- | --- | --- | --- |
| `summary` (default) | the game record only (§4.3) | ~1 KB/game | ratings, AC-8, bulk runs |
| `trace` | + the move-trace hash chain from `determinism/replay.ts` | ~100 B/game | regression seeds, divergence localization |
| `moves` | + the full ordered list of **submitted** responses | ~30–60 KB/game | inspection, M3 debugging, expert review for AC-6 |

Estimate before committing: ~296 decisions/game × a serialized `InputResponse`. Measure it in Unit B
rather than guessing, and put the real number in the write-up.

**A seed-addressed history is the primary reproduction mechanism**; the `moves` tier is for human
and tool inspection, not for replay. Say this in the module doc, because the opposite assumption
(replay the move list to rebuild the game) is the natural one and it is fragile.

**The recorded history must be verified, not asserted.** The verification is: re-derive the game
from its record's seeds and check the move-trace hash matches, and — for `moves`-tier records —
check the stored move list equals the re-derived one. Criterion R3 (§6) is stated on this.

### 4.5 Parallelism is in scope, because the speed spike put it here

`docs/Simulator_Speed_Spike.md` §5, on the ×8 games/day column: *"That is an assumption, not a
measurement — the spike did not run a parallel harness. … it should still be verified when the
Milestone 2 harness is built."* This is that harness.

Build a **child-process pool** (prior art: `determinism/childReplay.ts`), not worker threads: games
are fully independent, the per-game payload is a small config, and a child process sidesteps every
question about the Engine's process-global state (`GameLoader`, the `Cache`, the `Database`
singleton) that a shared-heap worker would raise. Shard by pairing group, never by game — a group
split across workers is still correct but loses the "one group, one seed, adjacent in the output"
property that makes the artifact readable.

The runner's single-process path stays the reference implementation and the correctness oracle: the
parallel path must produce a **byte-identical artifact** modulo timing fields (criterion R6).

### 4.6 The match runner absorbs the AC-1 legality accounting

**Decided (project owner, 28 Jul 2026): yes.** The standing caveat in `agent/CLAUDE.md` §6 requires
the AC-1 legality battery to be re-run against every agent version promoted at the end of M3, M4, M5
and M6. Rather than keep `agent/src/legality/` as a parallel runner that plays its own games, the
match runner carries the accounting and an AC-1 re-run becomes **a mode of a match** — one lineup,
the pre-committed composition, legality instrumentation on.

The consolidation is sound: the two runners already do the same thing (create a game from a seed
pair, drive it with `runGame`, record completion and fallbacks, yield between games, survive
failures), and every promoted version has to be measured for strength anyway, so playing those games
twice buys nothing.

**But "absorbed" means the accounting moves, not that it relaxes — and this is where the work is.**
The match runner as specified in §4.3 records fallback counts split by class, which comes from
`onFallback`. That is **not** AC-1's accounting. The AC-1 write-up's central finding is that
`onFallback` cannot see a third population — the FR-9 fallback's own rejected `'or'`-branch probes —
and that a "zero illegal moves" claim which silently omits a population of rejected submissions *"is
not evidence, it is an accounting choice presented as a result"* (`legality/submissionMonitor.ts`
module doc). The strict denominator comes from wrapping `Player.prototype.process`, not from the
driver's callback.

So absorbing AC-1 concretely requires:

- The runner supports a **legality mode** that installs `SubmissionMonitor`
  (`agent/src/legality/submissionMonitor.ts`) around the batch and records its per-game counters and
  its cause tallies into the match artifact. Reuse that class; do not write a second one.
- The mode is **opt-in**, because the monitor is per-process global state and the pool (Unit C) shards
  across processes — each child installs its own, and the parent merges the tallies.
- Behaviour-neutrality is already proven for the monitor (`legality/instrumentationCheck.ts` plays the
  same configs through the uninstrumented determinism harness and the fully instrumented runner and
  compares). Reuse that check rather than re-arguing neutrality; criterion R8 states it.
- `agent/src/legality/` is **not deleted by this bullet.** It is the artifact-of-record for the M1
  result and the oracle R8 compares against. Retiring it, if ever, is a decision for whichever
  milestone first runs an AC-1 re-run through the match runner in anger — not a cleanup to do here.

**One caveat to record, because it is the reason the caveat exists.** The rationale offered for
absorbing was that a legality regression is unlikely. The Milestone 1 evidence argues the opposite
way: the AC-1 run *found a real defect* (the `initialCards` budget coupling, 59 rejected submissions
at ~1 per 25 games) that had hidden behind the FR-9 fallback since bullet 3 and was invisible at
20-game scale. Consolidating the two runners is a good call on its own merits — one code path, one
artifact, no duplicated games. It is **not** a reason to run fewer games, to sample rather than
instrument every submission, or to treat a clean result as assumable. The strict accounting is what
makes the claim worth anything, and it survives the move intact or the move should not happen.

### 4.7 Player counts, and what gets committed

**4p is in scope** (project owner, 28 Jul 2026). The type is `players: 2 | 3 | 4`, the pairing policy
is §4.1's cyclic rotations at 4p, and 4p is already exercised by 250 AC-1 games so nothing about it
is speculative. 2p remains primary; criteria are stated at 2p and 3p (§6) with 4p covered by the same
code path and a smoke-scale run.

**`moves`-tier histories are not committed** (project owner, 28 Jul 2026). The retention convention:

| Tier | Destination | Committed |
| --- | --- | --- |
| `summary`, `trace` | `agent/docs/data/` | yes, for named runs (matching the six existing M1 artifacts, ~1.3 MB total) |
| `moves` | `agent/runs/` | **no** — gitignored |

Unit A adds `agent/runs/` to the repo `.gitignore` (there is no `agent/.gitignore`; the root one is
the only one) and makes the CLI write `moves`-tier output there **by default**, so the ignore rule is
not the only thing standing between a 40 MB artifact and a commit. A default that writes to
`docs/data/` and relies on the operator remembering is the failure mode this convention exists to
prevent.

---

## 5. Known hazards, already located — hand these to the units, don't rediscover them

**H1 — `GameResult`'s shape is load-bearing for the committed determinism corpus.**
`determinism/replay.ts:158-162` hashes `JSON.stringify(result)` into `ReplayFingerprint.resultHash`,
and 300 of those hashes are committed in `docs/data/determinism_corpus.json` as a standing
regression check. **Adding a field to `GameResult`, or changing `computeResult`'s winner rule,
invalidates all 300 fingerprints** and would look exactly like a determinism regression. Ranking goes
in a new `match/ranking.ts`. `gameResult.ts` is not edited by this bullet. (Its other callers —
`demo/match.ts`, `demo/spectate.ts`, `test/driver/gameResult.spec.ts`,
`test/core/randomLegalAgent.integration.spec.ts` — are further reasons, but the corpus is the
blocking one.)

**H2 — a responder-wrapper history is missing whole decisions, not merely wrong at some.** Two
distinct effects, both measured at 1,500-game scale in the AC-1 run:

- The FR-9 fallback **substitutes a different move**: when `player.process(input)` rejects the
  responder's move, `applyDecision` resubmits `resubmitConservatively`'s response instead
  (`embeddedDriver.ts`). A wrapper that records the responder's return value records a move that
  was *not played*.
- When the responder **throws**, it never returns at all, so the wrapper records **nothing** for
  that decision — the decision is simply absent from the history. `agent/CLAUDE.md` §6 records this
  exact property of `moveTraceHash`: *"has no step for a decision the responder threw on."*

This is not rare: **8,480 responder throws across 1,500 games, ~5.7 per game**, all one benign
cause. Every history the runner produces will contain them.

Two instruments are available and both are proven: `EmbeddedDriverOptions.onFallback` carries
`{decision, rejectedInput, rejectionCause, fallbackInput}` and fires on both classes (with
`rejectedInput === undefined` marking the throw class); and `legality/submissionMonitor.ts` wraps
`Player.prototype.process` and sees every submission including the fallback's own rejected `'or'`
branch probes. Unit B decides which — and justifies it — but a plain responder wrapper alone is
**not** a correct answer.

**H3 — the batch loop must yield to the event loop between games.** `Game.gotoEndGame()` is unawaited
async, so a synchronous loop holds every finished game alive through its pending continuation,
~0.27 MB each. `legality/run.ts` documents this and solves it (`yieldEvery`, default 1). Any mid-run
read of process-global state must flush the event loop first; any heap sample must also force a
collection or it measures V8's laziness.

**H4 — `game.id` is not unique within a process.** `gameFactory.ts` builds `g-nadia-${seed}` and
**omits the player count**, so a 2p and a 3p game on the same engine seed share an id. Harmless under
embedded play (which never calls `GameLoader.add()`), but it means **the match record must not key
on `game.id`**. Key on `(runId, groupIndex, permutationIndex)`. Do not "fix" `gameFactory.ts` — the
id collision is a recorded, re-adjudicated-at-M5 item, and changing the id would change nothing
observable while touching a file the determinism corpus depends on.

**H5 — `tsx` understates the simulator ~3.5×.** Every throughput number in this bullet's write-up
must come from the compiled build (`npm run build:server`-equivalent output under `build/agent/`),
run as `node build/agent/agent/src/runner/matchCli.js …`. A games/s figure measured under `npx tsx`
is not a performance figure. (`docs/Simulator_Speed_Spike.md`; `agent/CLAUDE.md` §6.)

**H6 — `SeededRandom(integerSeed)` is degenerate.** `new SeededRandom(s)` collapses every integer
seed to one stream; `gameFactory.ts` divides by `2**32` and `rng.ts` seeds `currentSeed` directly to
work around it. Any *new* seed derivation this bullet adds must go through `createGame` /
`createAgentRandom` and must not construct `SeededRandom` itself. (Running Notes, 2026-07-22.)

**H7 — silence the routine per-decision logs on a long run, but only because the counts are strict.**
The driver `console.warn`s on **every** FR-9 fallback and the Engine logs `Marking <game> to be
evicted` on every finished game. At ~5.7 fallbacks/game that is thousands of lines. `legality/run.ts`
solves this (`silenceRoutineLogs`, auto-enabled above 100 games in `legalityCli.ts`) and its doc
comment states the condition under which it is safe: every fallback is counted through `onFallback`
anyway. Reuse the pattern *and* the accounting; don't reuse the silencing without the accounting.

**H8 — a failing game must not abort the run.** `legality/run.ts` records the failure's error class
and message and continues, and says why: stopping at the first failure throws away the diagnostic
value of the other N−1 games, including whether the failure is systematic or one seed. Same rule
here. A group with a failed game is, however, **not** a balanced group — decide in Unit A whether such
a group is excluded from the balanced statistics and record the decision in the artifact header.

**H9 — a mid-play snapshot can carry a negative resource** (Moss / Nitrophilic Moss with Viral
Enhancers; Running Notes 2026-07-27). Irrelevant to end-of-game records, listed so it is not
rediscovered if anything here starts sampling mid-game state.

**H10 — `demo/agents.ts` will duplicate the new registry.** It is a small roster with one entry and a
`create(seed)` factory shape that the real registry should subsume. Unit A owns the reconciliation
(re-export or delete); leaving two rosters that drift is the failure mode.

---

## 6. Pre-committed criteria — write these down before any number arrives

Commit this section **in its own commit, before any measurement code exists**, as bullets 5–7 did.
R1–R7 are what "bullet 1 is done" means.

- **R1 — Seat balance works, and was necessary.** Two numbers from the same validation run
  (random-legal vs random-legal at 2p, distinct agent seeds, ≥ 500 pairing groups = ≥ 1,000 games):
  - **R1a (balance):** the lineup-slot-A win rate over balanced groups has a 95% confidence interval
    containing 50%. (Compute the interval directly; this is not bullet 3's rating pipeline.)
  - **R1b (necessity):** the **seat-0 win rate over the same games** is reported. If seat 0's
    advantage is not distinguishable from zero at this sample size, say so plainly in the write-up —
    the pairing is still correct, but the document must not claim it corrected a bias it did not
    measure.
- **R2 — Reproducibility.** Two runs of the identical match specification, in the same process and
  in a fresh process, produce identical per-game records modulo the declared timing fields. Stated
  on ≥ 20 groups at 2p and ≥ 10 at 3p.
- **R3 — History fidelity.** For a sample of ≥ 50 recorded games including **at least 10 in which the
  FR-9 fallback fired at least once**, re-deriving the game from its record reproduces the move-trace
  hash exactly, and for `moves`-tier records the stored move list equals the re-derived one. If the
  sample contains no fallback games the criterion is **untested, not met** — say so and re-sample.
- **R4 — Ranking matches the Engine.** `match/ranking.ts` agrees with the `GameEnd.vue` rule on
  constructed cases covering: strict VP order; a VP tie broken by megacredits; a full tie on both
  (shared placement, multiple winners); and 3-way cases at 3p. Additionally, report how many real
  ties occurred in the validation run — if zero, the tie path is covered by construction only, and
  the write-up says that.
- **R5 — 3p is supported to the same standard, and 4p works.** R1a (against the 1/3 baseline for a
  symmetric lineup), R2, R3 and R4 all hold at 3p, with placement — not just win/loss — recorded per
  seat, over ≥ 100 pairing groups (= 600 games). **4p** (§4.7) is exercised at smoke scale — ≥ 25
  groups (= 100 games) — asserting completion, placement recording, and R2 reproducibility; the
  balance criterion R1a is *not* claimed at 4p, since the cyclic-rotation policy gives a Latin square
  rather than full permutation balance and 4p is not a criterion setting for any AC.
- **R6 — The parallel path is not a different runner.** For an identical specification, the pooled
  run's artifact is byte-identical to the single-process run's after the declared timing fields are
  stripped. Any divergence is a blocking failure, not a rounding difference.
- **R7 — Throughput, measured on the compiled build (H5).** Report games/s single-process and at
  W ∈ {2, 4, 8} workers at 2p. **Pre-committed threshold: ≥ 5× at 8 workers.** Below that, the
  `×8` column in `docs/Simulator_Speed_Spike.md` §5 is annotated with the measured figure and the
  M6 self-play budget is recomputed in the write-up — the point of the threshold is that missing it
  produces a documented revision, not a silent one.
- **R8 — The absorbed legality accounting is the same accounting (§4.6).** On a shared set of ≥ 50
  configs, the match runner in legality mode and `runLegalityBatch` report **identical** values for
  every counter AC-1 is adjudicated on: submissions, `rejectedResponder`, `rejectedFallbackProbe`,
  `responderThrows`, `fallbacksAfterRejection`, `fallbacksAfterThrow`, completion. Any difference is
  a blocking failure — it means the absorption changed what the number counts, which is the one
  outcome §4.6 exists to prevent. Additionally, `checkInstrumentationNeutrality`
  (`legality/instrumentationCheck.ts`) passes for the match runner's legality mode, so the
  instrumentation is shown not to perturb the games it measures.

**Non-criteria, stated so they are not smuggled in:** this bullet does not claim any agent is
stronger than any other, does not compute Elo, and does not compare anything to the expert dataset.
Random-legal vs random-legal at ~50% is a **self-test of the runner**, not a result about play.

---

## 7. Structure — four units, and why this shape

`A → (B, C) → D`.

Applying `agent/CLAUDE.md` §9's own tests to this bullet:

- **Is A a real dependency or just a shared denominator?** A real one. B, C and D all import A's
  types, its registry and its runner entry point; B extends the record it defines; C parallelizes the
  loop it writes; D runs it. This is a harness other units call — the dependency case, not the
  coordination case.
- **Are B and C comparable in size?** Roughly, with B the larger since §4.6's legality mode joined it:
  B is ~350 lines plus two verification runs; C is ~200 lines plus a measurement. Neither is the
  spine — A is (~40% of the bullet).
- **Does splitting cost a cold start?** B and A both key off the driver and the record types, which
  argues for merging them. They stay separate because B's hazard (H2) is the single subtlest thing in
  this bullet and it deserves a session that is *only* about it — merged into A it becomes the last
  item in a long unit and gets the obvious, wrong implementation. The absorbed legality mode (§4.6)
  lands in B for the same reason inverted: it is the *same instrument* at the *same boundary*, and
  splitting it from the history recorder would put two independent `Player.prototype.process`
  wrappers in one process. C keys off nothing A-specific beyond the config list, so it splits
  cleanly.
- **What warrants its own session?** D: it edits the source-of-truth documents (one writer, always)
  and it is pure judgment over the other units' output.

**Why not five units** (a separate "pairing/seat balance" unit): the pairing design is ~100 lines of
code and the judgment in it is already spent — §4.1 settles it. Splitting it out would buy a cold
start and no decision.

**Why parallelism is a unit and not a follow-up:** whether the runner is pool-shaped is decided by
A's interface (per-game config must be serializable and stateless), and that is expensive to retrofit.
C exists to make sure A's shape is validated by something that actually uses it, in the same bullet.

---

## 8. Routing — scale and which model to run each unit on

| Unit | Scale | Model | Why that model |
| --- | --- | --- | --- |
| **A** — runner core, registry, pairing, ranking, record, CLI | ~600–750 lines across ~6 new files + ~350 lines of spec; no long compute | **Opus** | This unit writes the schema and the pairing policy every later measurement inherits. The failure mode is not a bug — it is a runner that works and produces a subtly meaningless number, or a schema that costs a re-run at M4 to extend. That is judgment work, not transcription. |
| **B** — history capture + replay verification + the absorbed legality mode (§4.6) | ~350 lines + ~250 lines of spec; two ~50-game verification runs (~4 min) | **Opus** | H2 is a trap with an obvious wrong answer (wrap the responder) that passes a naive test, because a history missing 5.7 decisions per game still looks like a history. Recognizing that the instrument must sit at the submission boundary, and building the negative control that proves it, is the whole unit — and it is the same boundary the legality accounting lives on, which is why §4.6's mode lands here rather than in A. |
| **C** — process pool + throughput measurement | ~200 lines + ~100 lines of spec; ~20 min of compiled-build compute | **Sonnet** | Mechanical: fan out an existing config list over child processes, with `childReplay.ts` as prior art and one measurement against a pre-committed threshold. Escalate to Opus only if R6 (byte-identical artifacts) fails, since that means a real state-sharing surprise. |
| **D** — validation run, adjudication, write-up, document updates | ~5 min of compiled compute; ~500-line deliverable + edits to 4 documents | **Opus** | Judgment over other units' output plus edits to the SRS and the Implementation Plan. R1b in particular is a place where a cheap model reports the flattering number and omits the "we did not actually measure a seat bias" caveat. |

---

## 9. File ownership, so parallel work never edits the same file

| File | Owner | Note |
| --- | --- | --- |
| `agent/src/agents/registry.ts` | A | new — name, version, description, factory |
| `agent/src/match/types.ts` | A | new — the whole record schema, incl. fields B populates |
| `agent/src/match/pairing.ts` | A | new — groups, permutations, seed schedule |
| `agent/src/match/ranking.ts` | A | new — VP-then-MC placement |
| `agent/src/match/runner.ts` | A | new — the batch loop and per-seat routing |
| `agent/src/match/artifact.ts` | A | new — header + rows writer |
| `agent/src/runner/matchCli.ts` | A | new |
| `agent/package.json` | A | adds `"match"` (and, from C, `"match:pool"` if separate) — **A adds both entries up front so C never edits this file** |
| `agent/demo/agents.ts` | A | reconcile against the registry (H10) |
| `.gitignore` (repo root — there is no `agent/.gitignore`) | A | adds `agent/runs/` (§4.7) |
| `agent/test/match/*.spec.ts` (pairing, ranking, runner, registry) | A | |
| `agent/src/match/history.ts` | B | new |
| `agent/src/match/legality.ts` | B | new — §4.6's mode; wraps `legality/SubmissionMonitor`, writes no second monitor |
| `agent/test/match/history.spec.ts`, `agent/test/match/legality.spec.ts` | B | |
| `agent/src/match/pool.ts` | C | new — the parent-side pool |
| `agent/src/match/poolChild.ts` | C | new — the child entry point |
| `agent/test/match/pool.spec.ts` | C | |
| `agent/docs/Match_Runner.md` | D | the deliverable |
| `agent/docs/data/match_runner_validation.json` | D | the validation artifact |
| `agent/docs/Running_Notes.md` | D | one dated entry |
| `agent/CLAUDE.md`, `agent/docs/Terraforming_Mars_AI_SRS_v1.2.md`, `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md` | D | one writer, always |

**Nobody edits:** anything under `src/` (CON-1); `agent/src/driver/`, `agent/src/engine/`,
`agent/src/core/`, `agent/src/determinism/`, `agent/src/legality/` — read and import freely, wrap
freely, modify nothing. If a unit believes it must modify one of these, that is a finding to raise in
Unit D, not a change to make.

---

## 10. Shared preamble — prepend to every unit prompt below

> You are working on **Nadia**, an expert-level Terraforming Mars AI agent built on top of the
> terraforming-mars engine in this same repository. Read `agent/CLAUDE.md` first; it orients you and
> points at the two source-of-truth documents (`agent/docs/Terraforming_Mars_AI_SRS_v1.2.md`, the
> SRS, and `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md`, the Implementation Plan).
> `agent/docs/Running_Notes.md` is a dated engineering log — read it for prior art before
> investigating anything that smells like it has been hit before.
>
> Milestone 1 is complete. You are working on **Milestone 2, bullet 1: the match runner.** The plan
> for this bullet is `agent/docs/Milestone2_Bullet1_Prompts.md` — **read it in full before writing
> any code.** In particular: §2 lists facts already established (do not re-derive them), §4 settles
> the design decisions (implement them, do not re-litigate them), §5 lists hazards already located
> (do not rediscover them), §6 is the pre-committed criteria, and §9 says which files you own.
>
> Standing constraints:
> - **`src/` is immutable.** The Engine is rules ground truth (SRS CON-1). You never modify it, and
>   you never re-implement a rule the Engine already implements.
> - **Existing agent modules are load-bearing and spec-covered.** `driver/`, `engine/`, `core/`,
>   `determinism/` and `legality/` are not modified by this bullet. Instrument by wrapping, which is
>   the technique every Milestone 1 bullet used (see `determinism/replay.ts` and
>   `legality/submissionMonitor.ts` for two working examples).
> - **Engine seed and Agent seed are controlled separately** (SRS CON-5). Do not derive one from the
>   other, and do not construct `SeededRandom` directly (hazard H6).
> - Follow the style of the code around you. The existing agent modules carry heavy explanatory doc
>   comments that record *why*, including the wrong turns; match that — it is the house style and it
>   is why Milestone 1's findings survived.
> - Run `npm test` in `agent/` (not the repo root) for the agent suite. Any performance number must
>   come from the compiled build, never from `tsx` (hazard H5).

---

## Unit A — the runner core (do this first; B, C and D all depend on it)

**Goal.** A single-process match runner that plays a fully-specified match between named agent
versions and emits a reproducible artifact, with correct seat balancing and correct ranking.

### 1. The agent registry (`agent/src/agents/registry.ts`)

An agent is `{name, version, description, create(seed) => EmbeddedResponder}`. `version` is a
string the registry entry declares and is **recorded in every artifact** — this is what AC-7's
promotion gate and the per-version AC-1 re-run key on. `random-legal` at version `1` is the only
entry; the file's doc comment says where the greedy one-ply baseline (bullet 2) will go.

Reconcile `agent/demo/agents.ts` against it (H10): the demo should consume this registry rather than
keep its own roster.

### 2. Types (`agent/src/match/types.ts`)

Write the schema from §4.3's consumer table, not from what the runner happens to have handy. Header
(once per run) vs game rows (per game), with the fields §4.3 lists. Every field gets a doc comment
saying **which consumer needs it** — that is what stops the next person from pruning it as unused.

Include the history fields Unit B will populate, and mark them clearly as B's (`historyTier`, and
whatever B needs to reference or inline its records). B owns `history.ts`; it does not edit this file.

### 3. Pairing (`agent/src/match/pairing.ts`)

Implement §4.1: groups, permutations (`n!` for n ≤ 3, cyclic for 4p), the two-progression seed
schedule with its bases documented in the module the way `legality/seeds.ts` documents its own.
Export a pure function from a match specification to an ordered list of fully-resolved per-game
configs — pure, serializable, and stateless, because Unit C will ship these to child processes.

### 4. Ranking (`agent/src/match/ranking.ts`)

§4.2. Read `src/client/components/GameEnd.vue:292-320` before writing it and cite it in the doc
comment; that file is the only place the rule exists. Do not touch `gameResult.ts` (hazard H1).

### 5. The runner (`agent/src/match/runner.ts`)

The batch loop. Reuse the shape `legality/run.ts` established, and reuse its *reasons*, not just its
code: async loop with `yieldEvery` (H3), failures recorded and the run continued (H8), routine logs
silenced above a threshold only because the counts are strict (H7), progress callback.

Per-seat routing is a single responder that dispatches on `decision.player.id` into the seat map
(`demo/match.ts:53` is the working precedent). Record the fallback counts split by class exactly as
`legality/run.ts` does — `rejectedInput === undefined` distinguishes them, and they are the input to
the per-version AC-1 re-run.

Decide and document the H8 question: is a group containing a failed game excluded from the balanced
statistics? Record the answer in the artifact header, not only in a comment.

### 6. Artifact + CLI (`artifact.ts`, `agent/src/runner/matchCli.ts`, `package.json`)

`legalityCli.ts` is the style reference: a switch over `process.argv`, explicit errors on unknown
flags, no parsing dependency, a `--list` that resolves the specification without playing anything,
and a non-zero exit on a blocking failure. Add **both** the `match` and `match:pool` npm scripts now
so Unit C never edits `package.json` (§9).

Implement §4.7's retention convention here: add `agent/runs/` to the **repo-root** `.gitignore`, and
default `moves`-tier output to that directory while `summary`/`trace` default to `agent/docs/data/`.
The default is the mechanism; the ignore rule is the backstop.

### 7. Specs

Pairing (group/permutation completeness, seed independence, determinism of the config list), ranking
(R4's constructed cases — including the 3p ones), registry, and a small end-to-end runner test
(a handful of groups at 2p and 3p, asserting reproducibility per R2 at small scale). The large
validation runs belong to Unit D; keep the suite fast.

---

## Unit B — history capture, the absorbed legality mode, and proving both are true

**Goal.** The `trace` and `moves` tiers of §4.4, recording what was actually **submitted**; the
legality mode of §4.6; and the verification that makes both evidence rather than decoration.

These are one unit because they are one instrument: both live at the submission boundary, and having
two independent things wrap `Player.prototype.process` in the same process is a bug waiting to
happen. Read §4.6 before deciding the instrument in the next section — the answer to "what does the
history record" and "what does AC-1 count" is very likely the same object.

**Read hazard H2 first and take it literally.** The obvious implementation — wrap the responder and
record its return value — is wrong in two different ways, and it is wrong on ~5.7 decisions per game,
so a test on a single clean game will pass. Establish where the truth lives before writing the
recorder:

- `EmbeddedDriverOptions.onFallback` fires on both classes and carries `fallbackInput` (the move
  actually accepted) and `rejectedInput` (`undefined` when the responder threw).
- `legality/submissionMonitor.ts` wraps `Player.prototype.process` and sees every submission,
  including the fallback's own rejected `'or'`-branch probes — and its doc comment explains the
  attribution rule (the first `process()` after the responder returns is the responder's; everything
  after is a fallback probe) and why a prototype wrapper rather than a driver hook.

Choose one, justify the choice in the module doc against the other, and state what your chosen
instrument **cannot** see. Also decide, and document, whether the history records the rejected
attempts or only the accepted move: the accepted move is what the history *is*, but the rejected
attempts are exactly the population AC-1 re-runs care about, and dropping them silently is how the
AC-1 accounting nearly went wrong the first time.

**The verification (criterion R3).** Re-derive a recorded game from its seeds and compare against the
stored history. The move-trace machinery in `determinism/replay.ts` (`MoveTrace`, `stableStringify`,
`firstDivergence`) exists for exactly this and should be reused, not reimplemented — including
`stableStringify`, because key insertion order differs between a responder's move and the fallback's
and a plain `JSON.stringify` would report a divergence that is not one.

**Build a negative control.** A verification that passes must be shown capable of failing: perturb a
recorded history by one decision and confirm the check localizes the divergence to that index.
Without this, R3 passing means nothing.

**Measure, don't estimate, the `moves`-tier size per game** and report it — §4.4's 30–60 KB is a
guess and the write-up should carry the real figure. It also sets the retention convention's stakes
(§4.7), so it wants to be a real number.

### The legality mode (`agent/src/match/legality.ts`, §4.6)

An opt-in mode that installs `SubmissionMonitor` around the batch and folds its per-game counters and
cause tallies into the match record. **Reuse `agent/src/legality/submissionMonitor.ts` — import it,
do not reimplement it, do not modify it.** Read its module doc first: it explains the attribution
rule (the first `process()` after the responder returns is the responder's; everything after is a
fallback probe) and why it is a prototype wrapper rather than a driver hook. `agent/src/legality/`
stays in place as the artifact-of-record and as R8's oracle.

Two things to get right:

- **Criterion R8 is an equivalence, not a smoke test.** On a shared config set the two runners must
  agree on every counter AC-1 is adjudicated on, exactly. Write that comparison as a spec, not as a
  one-off script — it is the thing that will catch a future refactor quietly changing what "zero
  illegal moves" counts.
- **The mode is per-process.** `SubmissionMonitor` installs global state, so under Unit C's pool each
  child installs its own and the parent merges. Specify the merge semantics (counters sum; cause
  tallies merge by signature, summing counts and keeping one representative) so C implements them
  rather than inventing them.

Do **not** run an AC-1-scale battery here. This unit proves the accounting is equivalent; the actual
re-runs happen at M3 and later, against the agents that need them.

---

## Unit C — the process pool and the throughput measurement

**Goal.** Discharge R6 and R7, and settle the assumption `docs/Simulator_Speed_Spike.md` §5
explicitly deferred to this harness.

Child processes, not worker threads, for the reasons in §4.5 — and `determinism/childReplay.ts` is
the working precedent for spawning one and getting a result back. Shard by pairing group, never by
individual game.

**R6 first, R7 second.** Correctness before speed: prove the pooled artifact is byte-identical to the
single-process one (after stripping the declared timing fields) before measuring anything. A pool
that is fast and subtly different is worse than no pool, because every downstream number would then
depend on which path produced it.

**R7 is measured on the compiled build (H5).** Report games/s at 1, 2, 4 and 8 workers at 2p, with
the machine described. State the pre-committed 5×-at-8-workers threshold in the report *before* the
number, and if it is missed, say what the M6 self-play budget becomes — the spike's §5 table is
computed off the ×8 column and a revision there is the deliverable, not a footnote.

Watch for the ordinary pool hazards and note which of them actually bit: child startup cost
amortized over a shard (this is why shards are groups, not games), a child that dies mid-shard,
stdout interleaving, and — specific to this Engine — that every child must call
`ensureHeadlessEngine()` itself and must not inherit an environment that enables the wall-clock cache
sweep (`GAME_CACHE=sweep=auto`), which `ensureHeadlessEngine()` already refuses to bootstrap under.

**Legality mode across the pool (§4.6).** `SubmissionMonitor` is per-process global state: each child
installs its own and the parent merges. Unit B specifies the merge semantics — counters sum, cause
tallies merge by signature summing counts and keeping one representative — so implement those rather
than inventing your own. R6's byte-identical requirement applies to legality-mode artifacts too, and
that is the case most likely to expose a merge that isn't associative.

---

## Unit D — the validation run, adjudication, and the documents

**Goal.** Run the runner against its own criteria, adjudicate R1–R7 honestly, and update the
source-of-truth documents.

### 1. The validation run

Random-legal vs random-legal at 2p (≥ 500 groups = ≥ 1,000 games), at 3p (≥ 100 groups = 600 games)
and at 4p (≥ 25 groups = 100 games, smoke scale per R5), compiled build, plus the R2/R3/R6/R8 samples
the criteria specify. Write the `summary`-tier artifact to
`agent/docs/data/match_runner_validation.json`; `moves`-tier output from the R3 sample goes to
`agent/runs/` and is **not** committed (§4.7).

### 2. Adjudicate R1–R8 one at a time

For each: the number, whether it is met, and — where a criterion is met only by construction rather
than by observation (R4's tie path if no real tie occurred; R3 if the fallback sample was thin) — say
so explicitly. §6 pre-commits two places where the honest answer is "untested, not met"; take them.

R1b deserves particular care. If the seat-0 advantage is not distinguishable from zero at this sample
size, the correct write-up says the pairing is a correctness measure whose necessity this run did not
demonstrate — **not** that there is no seat advantage. Random-legal play is the weakest possible
instrument for detecting one, and a stronger agent may well show a bias this run cannot see. Note that
this measurement should be repeated at M3, when there is an agent capable of exploiting the tempo.

### 3. Deliverables

- **`agent/docs/Match_Runner.md`** — the deliverable: the design (§4's decisions and why), the
  criteria and their adjudication, the schema with its consumer table, the throughput numbers, and a
  "how to run it" section. This is the document M3 will read when it wants to know what its win rates
  mean.
- **`agent/docs/Running_Notes.md`** — one dated entry, in the established style: the findings worth
  not rediscovering, not a summary of the work. Candidates: whatever H2 actually turned out to
  require, the measured seat effect (or the absence of a measurable one), the real parallel scaling
  factor, and the `moves`-tier size.
- **`agent/CLAUDE.md`** — update §6's status to "Milestone 2 in progress; bullet 1 done", with the
  same density as the Milestone 1 entries: what exists, where it lives, and the three or four things
  a future session would otherwise rediscover.
- **The SRS and the Implementation Plan** — annotate FR-13 as discharged, note in Plan §7.2 whether
  the parallel-scaling assumption was confirmed or revised, and annotate
  `docs/Simulator_Speed_Spike.md` §5's ×8 column with the measured figure (that document explicitly
  asked for this).
- **The AC-1 standing caveat** — `agent/CLAUDE.md` §6 and Plan §7.2 both tell a future session to
  re-run `npm run legality` against every promoted version. Per §4.6 that is now a mode of the match
  runner. Update both to name the new command, and keep the caveat's substance intact: it must still
  say that AC-1 expires on every agent version and why (the M1 defect found at 1,500-game scale and
  invisible at 20). The change is *where the battery lives*, not *whether it runs*.

### 4. One thing to resist

Do not let "random-legal vs random-legal is ~50%" become a claim about anything except the runner.
It is a null-hypothesis self-test. The write-up should say what it would have meant if the number had
come out at 58% — that the runner is biased — and nothing about play strength.

---

## Appendix — the three open questions, answered

All three were raised with the project owner and decided on **28 Jul 2026, before any code**. They
are recorded here as the audit trail; the design sections above are where they are implemented.

1. **4p support — yes.** 4p is in scope. Implemented per §4.7 (`players: 2 | 3 | 4`, cyclic-rotation
   pairing) and covered by R5 at smoke scale. 2p stays primary and 4p is not a criterion setting for
   any acceptance criterion.
2. **`moves`-tier artifacts — not committed.** The retention convention is §4.7: `summary`/`trace` to
   `agent/docs/data/` and committed for named runs; `moves` to a gitignored `agent/runs/`, and that
   is the CLI's *default* destination, not merely what an operator is expected to type.
3. **The AC-1 re-run — absorbed into the match runner.** Decided per §4.6, which also records the one
   caveat: the Milestone 1 evidence is that a legality regression *did* occur and was invisible below
   1,500-game scale, so the consolidation must carry the strict submission accounting across intact
   (criterion R8) rather than settle for the driver's fallback counts. Consolidating the runners is
   the decision; running the battery less rigorously is not part of it.

**Open, and deliberately left for later:** whether `agent/src/legality/` is eventually retired in
favour of the absorbed mode. §4.6 keeps it — it is the M1 artifact-of-record and R8's oracle. Revisit
when a real AC-1 re-run has actually gone through the match runner (M3 at the earliest).
