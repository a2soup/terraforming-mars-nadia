# AC-1 legality run — criteria (pre-committed)

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
