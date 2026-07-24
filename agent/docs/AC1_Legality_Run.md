# AC-1 legality run — results and adjudication

> **Verdict: all seven criteria met. AC-1's legality clause and NFR-4 are both met, strictly.**
> 1,500 consecutive games (1,000 × 2p + 250 each 3p/4p) in a single process, **1,500 completed,
> zero crashes, zero unrecovered illegal moves, and zero Agent-attributable illegal-move
> rejections across 444,680 submissions to the Engine.** The last of those was not true when the
> run started — it took a fix the run itself found. Jump to [Results](#results).

---

# Criteria (pre-committed)

Milestone 1's exit criterion, legality half: *"the random-legal agent plays >= 1,000 full games
start-to-finish with zero illegal moves and zero crashes (AC-1 mechanics)"* (Implementation Plan
§4, Milestone 1). The reproducibility half of the same criterion is already met and evidenced by
[Determinism_Verification.md](Determinism_Verification.md); the simulator-speed spike by
[Simulator_Speed_Spike.md](Simulator_Speed_Spike.md). This document is the deliverable for what
remains.

**This section was written and committed before any measurement code existed.** Everything below
the *Results* divider was written afterwards. The point of splitting the commits is that the bar
cannot have been chosen to fit the number.

Requirements in scope:

- **AC-1** (SRS §6) — "Plays >= 1,000 consecutive embedded games with zero illegal moves and zero
  unhandled errors." One third of the primary acceptance bar.
- **NFR-4** (SRS §5) — "In embedded mode the Agent shall produce **zero** Agent-attributable
  illegal-move rejections, and its unhandled-error rate shall be low enough that the probability of
  any failure across a 1,000-game run is under 5% (i.e. per-game failure probability <= ~5x10^-5)."

---

## The definitional question, settled up front

AC-1 says "zero illegal moves". The random-legal agent triggers the FR-9 conservative fallback
several times per game (the bullet-5 spike measured 16.2 / 20.9 / 27.3 fallbacks per 1,000
decisions at 2p / 3p / 4p). Whether that is already a failure depends entirely on what "an illegal
move" means, so it is fixed here, before counting:

> **An illegal move is a move submitted to the Engine and rejected by it.** Concretely: a
> `player.process(response)` call that throws.

That is the only reading under which NFR-4's own wording — "illegal-move **rejections**" — means
anything, and it is the reading that matches what the criterion is protecting against: the Agent
putting the game into a state the rules forbid, or wedging it.

It has a consequence that must not be quietly enjoyed. The FR-9 fallback fires for **two** distinct
reasons (`embeddedDriver.ts`, `FallbackEvent.rejectedInput`):

| | What happened | Was a move submitted? | Counts as an illegal move? |
| --- | --- | --- | --- |
| **A** | The responder produced a move and the Engine rejected it | yes | **yes** |
| **B** | The responder threw before producing a move (e.g. `enumerateStandardProject` finds no actable, affordable project in a branch the agent picked) | no | no |

Class B is not an illegal move by any reading — nothing was submitted, the game state was never at
risk. But it is the *dominant* fallback trigger (Running Notes, 2026-07-22: 221 of 223 residual
fallbacks in a 36-game batch), so reporting only class A would flatter the result. **Both are
counted and both are reported**, separately, with per-cause breakdowns. A reader who disagrees with
the definition above can apply their own and get their own number from the same table.

There is also a third population the driver's `onFallback` hook cannot see: the fallback's own
`'or'` branch probing submits candidate branches and keeps the first the Engine *accepts*
(`resubmitConservatively`), so its rejected probes are real `process()` rejections too. They are
deliberate, bounded recovery probes rather than blunders — but they are submissions, so they are
counted as well, via instrumentation that observes **every** `process()` call in the run rather
than trusting the driver's own reporting. Three populations, one denominator.

---

## Criteria

Blocking criteria must all pass for Milestone 1's exit criterion to be claimed. Recorded criteria
are measured and written down whatever they say; they do not gate on their own, but L5 carries a
pre-committed *action*, below.

| | Criterion | Kind |
| --- | --- | --- |
| **L1** | **>= 1,000 consecutive 2-player games**, in a single process, each reaching `Phase.END` | blocking |
| **L2** | **250 3-player + 250 4-player games** to `Phase.END`, same standard — breadth beyond the primary setting | blocking |
| **L3** | **Zero crashes**: no error escapes `runGame` for any game in the run — including `StuckGameError`, `DriverDecisionLimitError`, `UndoNotSupportedError`, `OutOfScopeDecisionError`, `NotYetImplementedDecisionError`, and anything thrown from the Engine | blocking |
| **L4** | **Zero unrecovered illegal moves**: zero `UnrecoverableIllegalMoveError` across the whole run | blocking |
| **L5** | **Strict rejection accounting**: every `player.process()` call in the run is counted, every rejection attributed to responder / fallback-probe and classified by cause | recorded, with a pre-committed action |
| **L6** | **No unclassified causes**: every distinct rejection or responder-throw cause signature observed is named in the write-up, not bucketed into "other" | recorded |
| **L7** | **Long-run stability**: heap and per-game runtime sampled across the run; the trend is reported. Closes the "long-run heap behaviour was not verified" gap [Determinism_Verification.md](Determinism_Verification.md) left open | recorded |

**L5's pre-committed action.** If class-A rejections (responder-submitted, Engine-rejected) are
non-zero *and* attributable to a bounded, identifiable cause, that cause is fixed and the whole run
re-executed, with before-and-after numbers both reported. If they are non-zero and *not* bounded —
many distinct causes, or a cause that cannot be fixed without violating CON-1 — the run is reported
as **not meeting NFR-4's strict wording**, with the residual named, rather than the definition being
loosened to fit. AC-1 is adjudicated on L1–L4; NFR-4 is adjudicated on L5. They are allowed to
disagree, and if they do, the write-up says so.

## What would falsify this

Stated now so a pass cannot be assembled after the fact. Any of the following means the run fails
and Milestone 1's exit criterion is not met:

- Any game that does not reach `Phase.END` — a hang, a stuck game, a decision-limit trip, or a
  thrown error.
- Any `UnrecoverableIllegalMoveError`: both the responder's move and every fallback branch rejected.
- A class-A rejection cause that is *not* one of the couplings already recorded in the Running Notes
  — that would mean an unknown enumerator gap, not a known cost.
- Games that complete but are not real games: a completion rate that depends on a suspiciously low
  decision count, generation count, or a degenerate final score distribution. Sanity distributions
  are reported alongside the counts for exactly this reason.

## Run design

- **Composition.** 1,000 games at 2p (the SRS's primary evaluation setting — the headline AC-1
  claim rests on these alone), plus 250 at 3p and 250 at 4p as breadth. 1,500 games total; AC-1 asks
  for 1,000.
- **Single process.** "Consecutive" is read strictly: one process, one loop, no restarts — which
  also makes L7's leak check meaningful and re-tests the contamination question bullet 6 answered
  for 100 games at 15x the scale. A separate fresh-process shard confirms the result is not a
  property of one process's history.
- **Periodic event-loop yields.** `Game.gotoEndGame()` is unawaited async, so a synchronous batch
  loop holds every finished game alive through its pending continuation (~0.27 MB each) until it
  yields — measured in bullet 6, and the reason that entry flagged this run specifically. The runner
  yields between games so finished games can actually be collected and so any mid-run measurement
  reads a settled heap.
- **Seeds.** Engine and Agent seeds are two separate arithmetic progressions with unrelated bases
  and different strides, so neither is derivable from the other (SRS CON-5) while the whole run
  stays reproducible from the schedule alone. Both bases are chosen away from the determinism
  corpus's seed space (base 500,000, stride 977) so this run is genuinely new evidence rather than a
  re-measurement of games bullet 6 already replayed.
- **Instrumentation must not change the result.** The `process()` counting wraps a prototype method;
  a run with instrumentation and one without are compared on the determinism harness's own
  fingerprints to show the wrapper is behaviour-neutral. If it is not, the instrumented numbers are
  worthless and the check is what says so.

---

# Results

## Reference environment

| | |
| --- | --- |
| Engine pin | `868714d72a434ab68fe08e5570ebc6863859ae15` — re-verified: an ancestor of HEAD, with `git diff <pin>..HEAD -- src/` **empty**, so "frozen at the pin" stays a checked fact |
| Node | v22.23.1 (`.nvmrc` → 22) |
| Platform | darwin arm64 (Apple M2) — the same reference hardware as bullets 5 and 6 |
| Runner | `tsx` for the headline run; the compiled build (`tsc` + `tsc-alias`) for the cross-runner shards |
| `GAME_CACHE` / `MAX_GAME_DAYS` | both unset |
| Agent version | 0.0.1, `seedDerivationVersion` 1 |
| Artifact | [data/ac1_legality_run.json](data/ac1_legality_run.json) — header, summary, cause tallies, 60 stability samples, and all 1,500 per-game rows |
| Reproduced | The whole run was executed **four times** (pre-fix, post-fix, and twice more while finalizing). The two post-fix runs agree on every per-game row and every summary field except wall-clock timings — 1,500 games reproducing exactly, in different processes |

## Criteria adjudication

| | Criterion | Verdict | Evidence |
| --- | --- | --- | --- |
| **L1** | ≥1,000 consecutive 2p games to `Phase.END`, single process | **MET** (blocking) | **1,000 / 1,000** |
| **L2** | 250 3p + 250 4p to the same standard | **MET** (blocking) | **250 / 250** and **250 / 250** |
| **L3** | Zero crashes | **MET** (blocking) | **0 errors escaped `runGame`** across 1,500 games / 444,680 decisions |
| **L4** | Zero unrecovered illegal moves | **MET** (blocking) | **0 `UnrecoverableIllegalMoveError`** |
| **L5** | Strict rejection accounting | **MET** (recorded), and its pre-committed action was **triggered and carried out** | **0 class-A rejections after the fix**, down from 59; **0 fallback-probe rejections**; 8,480 class-B |
| **L6** | No unclassified causes | **MET** (recorded) | Exactly **one** distinct cause in the whole final run, named below |
| **L7** | Long-run stability | **MET** (recorded) | Post-collection heap **64.6 → 65.8 MB** over 1,500 games; per-game runtime flat |

## L1–L4 — completion and crashes

```
[legality] 1500/1500 games completed in 51.7s (2p 1000/1000, 3p 250/250, 4p 250/250)
[legality] decisions: 444,680 total, median 289/game (p95 397, max 551)
[legality] submissions to the Engine: 444,680
[legality] L4 unrecovered illegal moves: 0
```

Against NFR-4's stated tolerance — a per-game failure probability of ~5×10⁻⁵, i.e. under 5% chance
of any failure in 1,000 games — the observed rate is **0 / 1,500**.

**These are real games, not degenerate ones.** The pre-committed falsification list names
"games that complete but are not real games" as a failure mode, so the distributions are reported
rather than asserted away:

| | 2p (n=1,000) | 3p (n=250) | 4p (n=250) |
| --- | --- | --- | --- |
| Decisions/game, median (min–max) | 276 (170–500) | 308 (219–509) | 316 (211–551) |
| Generations/game, median (min–max) | 22 (14–41) | 17 (12–32) | 14 (9–22) |
| Victory points, median (min–max) | 77 (35–143) | 61 (32–107) | 49 (24–94) |
| Games ending in a VP tie | 13 | 6 | 10 |

Generation counts fall as the player count rises, exactly as real Terraforming Mars does (more
players terraform faster), and the 2p decision median of 276 matches the bullet-5 spike's
independently measured 278. Nothing here looks like a game that ended early.

## L5 — the strict accounting, and the defect it found

This is the criterion with teeth, and it did not pass on the first attempt.

**Before the fix** (same 1,500 configs, commit `76116fd`):

| Population | Count | Is it an illegal move? |
| --- | --- | --- |
| **A** — responder submitted, Engine rejected | **59** | **yes** |
| **B** — responder threw, nothing submitted | 8,421 | no |
| Fallback `'or'`-branch probes rejected | 0 | yes, but deliberate |
| Unrecoverable | 0 | — |

All 59 class-A rejections had a single cause: `initialCards :: InputError: Too many cards selected`.

**The defect.** `SelectInitialCards` presents the opening choice as one composite — corporation,
preludes, starting project cards — and each sub-input accepts its own response on its own terms:
`SelectCard.process` checks count and membership, nothing else. Then `completed()` rejects the
*whole composite* if `cardsInHand.length * cardCost > corporation.startingMegaCredits`. The budget
therefore depends on a **sibling** response, and no amount of care inside `enumerateCard` can see
it — which is precisely why the FR-9 fallback was built to absorb this case back in bullet 3.

Absorbing it is not the same as not doing it. Under NFR-4's wording — "**zero** Agent-attributable
illegal-move rejections" — a recovered rejection is still a rejection, so the honest reading of the
pre-fix run is **AC-1 met, NFR-4 not met**. That is the disagreement the criteria section said
would be reported rather than smoothed over, and it is what L5's pre-committed action existed for:
one bounded, identifiable cause, so fix it and re-run.

**The fix** ([composite.ts](../src/core/enumerator/composite.ts)): `enumerateInitialCards`
truncates the sampled project-card selection to the count the chosen corporation can afford,
reading the cap from the Engine's own objects (`corporation.cardCost ?? player.cardCost`,
`startingMegaCredits`, and the Beginner Corporation exemption) rather than restating the rule — the
same discipline `enumerateStandardProject` follows for `SelectStandardProjectToPlay.validate()`.
Truncation rather than resampling, so the rng draws are unchanged; the distributional cost is that
the selected count becomes `min(uniform, cap)` rather than uniform over the affordable range, which
is irrelevant for a random-legal baseline and moot once Milestone 3 chooses this count deliberately.

**After the fix** (the headline run):

| Population | Count | Rate |
| --- | --- | --- |
| Submissions to the Engine | 444,680 | — |
| **A — responder submitted, Engine rejected** | **0** | **0** |
| Fallback `'or'`-branch probes rejected | **0** | 0 |
| **B — responder threw, nothing submitted** | 8,480 | 5.65/game; 17.2 / 20.0 / 24.8 per 1,000 decisions at 2p / 3p / 4p |
| Unrecoverable | 0 | — |

The accounting balances exactly, which is the check that the three populations are complete:
444,680 decisions − 8,480 responder throws + 8,480 fallback submissions = 444,680 submissions.
Every fallback was accepted on its first branch.

## L6 — every cause, named

One distinct cause survives in the final run:

| Count | Source | Decision | Cause |
| --- | --- | --- | --- |
| 8,480 | responder-throw | `or` | `Error: enumerateProjectCard: no actable, affordable standard project among N offered to player <player>` |

**This is not a defect, and it should not be "fixed".** The action-phase `OrOptions` offers the
standard-projects menu as a branch whether or not anything in it is actable and affordable; a
uniformly-random branch choice walks into it while broke, the enumerator correctly declines to
invent a move, and the driver retries another branch. Nothing is submitted, so nothing illegal
happens. It is a measurement of *how often a random agent picks a branch it cannot complete*, which
is a statement about random play, not about legality — and the Running Notes already flagged the
branch filter that removes it (skip branches with no legal completion) as natural Milestone-3 work.

Worth keeping in view for one reason: at 5.65 per game it is frequent enough that if the fallback
ever *stopped* working, a great many games would break at once. It is load-bearing today.

## L7 — long-run stability

Sixty samples, one per 25 games, each taken after an event-loop yield **and** a forced collection
(`--expose-gc`) — without the collection the curve measures V8's laziness rather than the run's
retention:

| | first 15 samples (games 25–375) | last 15 samples (games 1,125–1,500) |
| --- | --- | --- |
| `heapUsed`, mean | 64.6 MB | 65.8 MB |
| `rss`, mean | 307.1 MB | 318.3 MB |

Heap moves **+1.2 MB across 1,500 games** — flat. RSS drifts +11 MB, roughly 7 KB/game, which is
allocator behaviour rather than retention: the heap it would have to be retained *in* did not grow.
Per-game runtime is likewise flat (median 32 ms, p95 49 ms, max 96 ms; games/s drifted 30.3 → 29.0
over the run, which is the pending-continuation backlog described below, not degradation).

This closes the gap [Determinism_Verification.md](Determinism_Verification.md) explicitly left
open ("long-run heap behaviour" was in its *what was not verified* list), and it is the payoff for
yielding between games: `Game.gotoEndGame()` is unawaited async, so a synchronous loop would have
held every finished game alive through its pending continuation (~0.27 MB each) and produced a
convincing-looking leak that was really a backlog.

## Cross-runner and cross-process

The headline run is one process under `tsx`. Three further runs of 200 games (100 × 2p, 50 each
3p/4p), each in a **fresh process** under the **compiled build**, produced identical results to one
another — same completions, same 1,244 class-B events, zero class-A — and their first 100 2p games
match the headline run's first 100 **exactly** on decisions, generation, class-B count and every
player's victory points. So the result is not a property of one process's history or of one
TypeScript runner, and bullet 6's cross-process determinism finding now also holds across a runner
change it never tested.

## Instrumentation neutrality

The strict accounting wraps `Player.prototype.process` and the responder. Twelve configs played
through the uninstrumented determinism harness and through the fully instrumented runner agree on
decisions resolved, fallbacks fired and generation reached — so the instrumented numbers describe
the same games an uninstrumented run plays.

That check earned its keep immediately: its first run reported ten mismatches, all of which turned
out to be a **counting-definition difference rather than a behavioural one**, and one worth
recording. `replay()` records its trace step *after* the responder returns
([replay.ts](../src/determinism/replay.ts), `withMoveTrace`), so a decision the responder **threw**
on never reaches `trace.record`. Consequences:

- The corpus's `decisions` field excludes class-B decisions; the legality runner's includes them.
  Comparing them like-for-like requires subtracting the throws (3p engine seed 500,977: 326 vs 337,
  and exactly 11 throws in that game).
- More usefully: **`moveTraceHash` has no step for a decision the responder threw on**, and
  therefore none for what the FR-9 fallback submitted in its place. A divergence confined to
  fallback-resolved decisions would not move it. The corpus still catches such a divergence — via
  `stableStateHash` and the separately-compared `fallbacks` count — but not by the field anyone
  would assume, and that is worth knowing before relying on the trace hash for something it does
  not cover.

## Side effects worth knowing about

**The determinism corpus was regenerated, and that is the corpus working.** The budget cap changes
which cards a player starts with whenever the old code would have over-selected, so it changes the
game. `--verify` against the committed 300-fingerprint corpus reported **43 configs changed
(14.3%)**, on every comparable field, before regeneration. This is exactly the design the bullet-6
write-up argued for — agent code changes must surface as *fingerprint mismatches* naming the
configs that moved, not as a header rejection that refuses to look — and it is the first time that
design has been exercised by a real behaviour change. The regenerated corpus verifies clean
(`--repeat 2`, 0 mismatches).

**An integration test was inverted, deliberately.** `randomLegalAgent.integration.spec.ts` asserted
that the over-budget selection *triggered* the FR-9 fallback. With the cap in place it cannot, so
that test now asserts the cap holds (7 cards under PhoboLog's 23 M€, not 10 and not the fallback's
0), and a **new** test covers the fallback's recovery by building an over-budget response by hand.
Verifying a safety net through a defect it now prevents is how a safety net quietly loses its
coverage.

## What this run does *not* establish

- **It is the random-legal agent's legality, not the future agent's.** Every Milestone 3–6 agent
  will submit different moves; AC-1 must be re-run for each, which is what the committed runner is
  for. The one enumerator defect this run found had been sitting behind the FR-9 fallback since
  bullet 3, invisible to a 20-game batch.
- **Scope is base + Corporate Era + Prelude on Tharsis, 2–4 players**, one machine, one OS, one Node
  version, one Engine pin. Out-of-scope expansions were never exercised, so the `OutOfScopeDecisionError`
  path remains untested by this run (0 occurrences).
- **It says nothing about move quality.** A random-legal agent playing 1,500 legal games is a
  statement about the interface, not about strength. AC-3 through AC-8 are Milestones 2+.
- **The FR-9 fallback is still load-bearing** at 5.65 events/game. Zero class-A rejections means the
  Agent submits nothing illegal; it does not mean the fallback could be removed.

## How to reproduce

From the repo root with `node_modules` installed (`npm ci`). The compiled build is ~46 games/s
against `tsx`'s ~29, and both produce identical games:

```bash
npx tsc -p agent/tsconfig.json && npx tsc-alias -p agent/tsconfig.json
```

```bash
node --expose-gc build/agent/agent/src/runner/legalityCli.js --out agent/docs/data/ac1_legality_run.json
```

`--expose-gc` matters for criterion L7 only; the run works without it. A smaller shard is
`--composition 2:100,3:50,4:50`, the neutrality check is `--check-instrumentation 12`, and
`--list` prints the resolved seed schedule without playing anything. The runner exits non-zero if
any game fails to complete or any unrecovered illegal move occurs, so it is usable as a gate.
