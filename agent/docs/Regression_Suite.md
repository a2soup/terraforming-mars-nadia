# The regression suite — Milestone 2, bullet 5

**What this document is.** The deliverable for *"establish a regression suite of fixed seeds and
reference games"*, the last item in Milestone 2. It records what was built, what the nine
pre-committed criteria adjudicated to, what the suite provably catches, and — at greater length,
because it is the more useful half — **what it provably does not**.

The design and the criteria were pre-committed in
[Milestone2_Bullet5_Prompts.md](Milestone2_Bullet5_Prompts.md) before any code existed, and the
negative controls were pre-registered in their own commit before any of them was run. Section
references below (§3.1, §3.4, …) are to that plan.

---

## 1. Read this first: three instruments, three questions, and this is the fourth

A green run of this suite is **not** a legality result and **not** a strength result. Four questions,
four instruments, and confusing them is the one way to misuse this document:

| Question | Instrument | Scope |
| --- | --- | --- |
| Is it legal? | `npm run match -- --legality` | Any agent, **re-run per version** |
| Is it stronger? | `npm run rate` | Any two agents |
| Is it deterministic? | `npm run determinism -- --verify` | `random-legal@1` only |
| **Did anything change that we didn't mean to change?** | **`npm run regression`** | **This bullet** |

**AC-1 still expires on every new agent version** (`agent/CLAUDE.md` §7). This suite does not
re-establish it, does not measure strength, and says nothing about whether a new agent plays well.

### What a new agent version inherits

| | Inherits | Why |
| --- | --- | --- |
| **L1 reference positions** | **All of them, forever** | No agent is involved. Invalidated by an Engine pin move and by nothing else. |
| **The frozen baselines' L2 entries** | **Yes — this is the promotion-gate check** | `random-legal@1` and `greedy-1ply@1` must still reproduce. If shared infrastructure moved them, that is a regression (§3.1), not a rebaseline. |
| **L2 entries of its own** | **No** | A new version has no history to regress against. It gets a section generated once, at promotion, from a fresh R sub-range, and frozen. |

---

## 2. What was built

### L1 — reference positions (agent-independent)

**13 fixtures, 27 tests, ~4 s**, under `agent/test/regression/fixtures/`. Small constructed
scenarios asserting what the **Engine at the pin** does on the cards that carry known risk:

- **The five escalating Engine-vs-print divergences** — Immigrant City, Energy Tapping, Power Supply
  Consortium, Decomposers, Ecological Zone. The Decomposers/Ecological Zone fixture also asserts
  Viral Enhancers' *correct* behaviour beside them, because the inconsistency between the three is
  the actual finding.
- **The three non-escalating** — Virus, Hired Raiders, Sabotage.
- **The two effects the Engine's own suite never asserts** — Hackers' `bespokePlay` production
  attack, and the City standard-project action.
- **Three `undecided` items** — Vitor's `startingMegaCredits: 48` against a description saying 45,
  the X3 prelude-fizzle 15 M€ (both routes in one fixture), and Aquifer Pumping as the X5
  maxed-parameter no-op.

Every fixture carries, in the file next to the assertion: the Engine number, the printed number, its
audit register row, and the sentence that changing it toward the print is a change of meaning rather
than a fix (§3.4). **Two fixtures do not carry that last sentence — Hackers and City — and that is
correct**: those are the untested-effect cards, where Engine and print *agree*. Both headers say so
explicitly, and say that a future failure there is a real regression in one of them rather than a
temptation toward a printed number.

### L2 — reference games (agent-version-scoped)

**33 pinned games + the 300-config determinism corpus, ~31 s.**

| Section | 2p | 3p | 4p | Total | Frozen |
| --- | --- | --- | --- | --- | --- |
| `greedy-1ply@1` | 8 | 6 | 4 | **18** | yes |
| `random-legal@1` | 8 | 5 | 2 | **15** | yes |

Selected by greedy set cover over a **950-game survey** at `moves` tier across R-block groups
6,100–6,399 (950 completed, 0 failures). Each entry commits **the fields, not a hash of the fields**
(§3.3): identity, six fingerprints plus trace checkpoints, full per-seat semantics (placement,
VP, megacredits, TR, all six VP-breakdown components, corporations, preludes, project cards),
milestones, awards, derived coverage, and a `why` sentence naming what the game is pinned for.

The determinism corpus is **invoked, not absorbed** (§3.9): `npm run regression` runs it as its own
reported line and never regenerates it; `npm run determinism -- --verify` keeps working unchanged.
The one structural change this needed — an optional agent factory on `replay()` — is additive, and
all 300 committed fingerprints re-verify byte-for-byte.

### L3 — triage

Reads L2's output. Groups moved fields into fingerprint and semantic, brackets a trace divergence to
a 25-decision window from the committed checkpoints, and prints the window. **Its honest scope is
"roughly where", not "what caused it"** — see §5.

### The rebaseline ledger

`--rebaseline` alone fails; it requires `--claim`, and the entry records `entriesMoved` and
`fieldsMoved` **computed by the tool, not typed by the operator**. Entries chain by `previousDigest`
and the ledger carries a `headDigest`. Committed seeded and empty at
`docs/data/regression_rebaselines.json` — which the CLI reports as *"present and empty: no layer has
been rebaselined"*, deliberately distinct from a missing file.

---

## 3. Adjudication — S1 through S9

**Nine criteria, nine met.** That is an unusual result in this project and it should be read with the
gap table in §5 firmly attached: the criteria were written to be *adjudicable*, and S1 is explicitly
satisfied by recording what the suite misses rather than by the suite missing nothing.

| | Criterion | Verdict |
| --- | --- | --- |
| **S1** | The suite refuses | **MET** — with two standing gaps recorded |
| **S2** | Passes clean, twice, in two processes | **MET** |
| **S3** | Coverage per card, holes named | **MET** — 322/323, one hole |
| **S4** | Every named card has a direct assertion | **MET** — 13 fixtures |
| **S5** | Both frozen baselines pinned at both counts | **MET** |
| **S6** | Runtime budget | **MET with room** — 35.4 s against 300 s |
| **S7** | Rebaseline cannot be silent | **MET** — and it found a defect |
| **S8** | Per-game rows, not summaries | **MET** |
| **S9** | Seed-block discipline | **MET** |

### S1 — the suite refuses

**Eleven mutations: the eight pre-registered classes plus three added while looking deliberately for
something nothing catches.** Pre-registration is a separate, earlier commit than any result. Each
mutation was applied in a throwaway `git worktree`, run through the whole suite, and reverted;
nothing under `src/` was modified in the repository.

Each was run **twice** — against Unit A's 10-game smoke corpus and against the committed 33-game
corpus — because the difference between those two columns is the only direct measurement in this
bullet of what selection buys.

| | Class | Pre-reg | 10-game corpus | 33-game corpus |
| --- | --- | --- | --- | --- |
| M1 | card-effect amount (Mine: 1→2 steel prod) | yes | caught | caught |
| M2 | `bespokePlay` (Hackers) | yes | **caught less** — L1 + determinism only | caught, all three channels |
| M3 | candidate-set reduction | yes | **UNCAUGHT** | **UNCAUGHT** |
| M4 | enumerator ordering | yes | caught | caught |
| M5 | ranking tiebreak | yes | uncaught *(as predicted)* | **caught more** — one real VP tie |
| M6 | VP-breakdown component | yes | caught | caught |
| M7 | seed-schedule stride | yes | caught | caught |
| M8 | **no-op control** | yes | **fired nothing** | **fired nothing** |
| M9 | unreached card effect | no | uncaught *(by design)* | uncaught *(by design)* |
| M10 | candidate ordering | no | caught — `l2:greedy-1ply@1` only | same |
| M11 | fallback branch order | no | caught | caught |

**Nine of eleven landed on their pre-registered channels in each run.** The no-op control fired
nothing in both, which is the precondition for reading any other row — falsifiable prediction 3
holds, so the rest of the record stands.

### S2 — clean, twice, in two processes

Zero failures on the committed artifacts. Verified four times in four fresh processes: twice by Unit
D as the baseline for its control runs, and twice again after the merges and the three defect fixes:

```
L1 reference positions: OK - 27/27
determinism corpus:     OK - 300 config(s), 0 mismatch(es)
L2 greedy-1ply@1  (frozen): OK - 18/18 entries reproduced
L2 random-legal@1 (frozen): OK - 15/15 entries reproduced
```

### S3 — coverage, and the hole

**322 of 323 targets are exercised by the pinned corpus.** No aggregate figure appears in this
document without the hole beside it, which is the whole of S3's requirement:

| Target group | Targets | Pinned | Survey |
| --- | --- | --- | --- |
| card / projectCards | 215 | **214** | 214 |
| card / corporationCards | 17 | 17 | 17 |
| card / preludeCards | 35 | 35 | 35 |
| card / standardProjects | 6 | 6 | 6 |
| card / standardActions | 2 | 2 | 2 |
| action / projectCards | 36 | 36 | 36 |
| action / corporationCards | 2 | 2 | 2 |
| milestone | 5 | 5 | 5 |
| award | 5 | 5 | 5 |

**The hole is Anti-Gravity Technology**, and it is the same zero the card-coverage audit measured:
0 plays in 1,500 games there, 0 in this 950-game survey, by either baseline. It requires 7 science
tags. It was **not** manufactured into coverage by a hand-built game (hazard H11); it is a row in the
hole list, and Unit D turned it into mutation M9 to demonstrate what an unreached line costs.

All **ten named cards** of §2.3 are exercised, none marginally — the thinnest is Power Supply
Consortium at 4 pinned games, and City at 32 of 33.

### S4 — direct assertions

13 fixtures / 27 tests covering all eight divergences, both untested effects, and three `undecided`
items. Every fixture was **made to fail on purpose once** by Unit B, in a scratch copy since deleted:
re-run with its key assertion replaced by the printed number (or, for Hackers and City, by a silent
value regression), all thirteen went red. None is vacuously true.

### S5 — both baselines, both counts

See the table in §2. Both frozen baselines at 2p and 3p with a 4p smoke. **`greedy-1ply@1` at 2p is
the entry that closes the gap this bullet exists for** (§2.1 of the plan): before this bullet, the
project's only fixed-seed standing check covered `random-legal@1` alone.

### S6 — the budget, and the host caveat

| | Compiled | Under `tsx` |
| --- | --- | --- |
| **Budget** | ≤ 300 s | ≤ 1,200 s |
| Unit C, back to back | 36.3 s / 36.5 s | 46.3 s / 50.6 s |
| This adjudication, back to back | **35.4 s** | 44.0 s / 48.5 s |

**Met with an 8.5× margin, and nothing was cut to meet it** (`trimmedGames: 0`). Swap was checked
before every figure quoted here (2.6 GB of 4.1 GB in use, 1.5 GB free) — a discipline this bullet
learned the hard way; see §6.

### S7 — rebaseline cannot be silent

Adjudicated by an operator transcript through the CLI on real files: the gate run with M1 applied
failed and named both moved entries with their `why` lines and the §3.1 shared-infrastructure
warning; a bare `--rebaseline` was refused before replaying anything; `--claim "fix"` was refused as
too short; `--dry-run` computed `2/10 entries moved [fingerprints.stableStateHash x2]` and wrote
nothing; the real rebaseline recorded the corpus digest transition; and the suite then ran green
against a corpus pinning mutated behaviour — which is the point, and the only thing between that
state and a future reader is the claim sentence.

**S7 is also the criterion that found a defect**, which is what it was for. See §6.

### S8 — per-game rows, not summaries

Every committed entry carries the §3.3 fields. The stated re-analysis a summary would not support is
**M6**: attributing city-adjacency VP to the greenery component with every total unchanged moved 32
of 33 entries on semantic fields with **zero** fingerprint fields, and left all 300 determinism
configs clean. The artifact answers *which component* moved — `vpBreakdown.greenery` and
`vpBreakdown.city`, totals identical — and no hash of the semantic block could. This is bullet 3's
recorded lesson (*"commit the per-game rows, not the summary"*) paying for itself in one row.

### S9 — seed-block discipline

| Range | Spent by |
| --- | --- |
| 6,000–6,029 | M2b1 criterion R3 — pre-existing, and correctly **refused** to new runs |
| 6,090–6,099 | Unit A smoke corpus |
| 6,100–6,499 | Unit C L2 reference games (survey used 6,100–6,399) |

All inside R, all disjoint, and both new allocations recorded in `docs/data/ladder.json` in a commit
that precedes the one playing the games. 6,500–6,999 remains reserved for the per-version sections
M3–M6 will each need.

---

## 4. What the suite catches

Stated positively and briefly, because §5 is the part worth reading:

- **A card's declarative `behavior` value changing** (M1) — the single most likely silent effect of a
  pin move, and the class whose independent cross-check was lost when AC-8 was withdrawn.
- **A `bespokePlay` effect changing** (M2) — caught by L1's direct assertion regardless of corpus,
  and by L2 once the corpus reaches the card.
- **Enumerator and candidate ordering** (M4, M10). M10 fired on `l2:greedy-1ply@1` and nothing else,
  18 of 18 entries against 0 of 15 random-legal — that channel did not exist before this bullet.
- **A VP-breakdown reattribution with totals preserved** (M6) — semantic fields only, invisible to
  every hash in the project.
- **A seed-schedule change** (M7).
- **A fallback-branch reordering** (M11) — visible, though attributed to the wrong decision (§5).

---

## 5. What the suite does not catch

### Gap 1 — candidate-set reductions (M3). The important one.

Reducing `MAX_INTERIOR_AMOUNTS` from 6 to 3 — **a candidate-set reduction, which bullet 2 names
explicitly as making `greedy-1ply@1` a new version rather than an improvement** — fired nothing.
Across all 43 pinned games, both baselines, both corpora, and the 300 determinism configs.

It survived the corpus growing from 10 games to 33, so it is **a standing gap, not a sample-size
artefact**. Only `greedy-1ply@1` reads `core/candidates/`, and it fires only when some `amount`
decision has a span above 4 — which the pinned games do not contain.

**This matters at M3.** The change class the suite is blindest to is precisely the class bullet 2
pre-committed as version-defining. A promotion gate that reads a green suite as "the baseline is
unchanged" is reading something the suite did not check. Closing it needs a pinned game containing a
wide `amount` decision, and that is a selection change, not a code change.

### Gap 2 — anything on a line the corpus does not reach (M9)

Anti-Gravity Technology's discount changed from 2 M€ to 3 and nothing noticed, because nothing plays
it. A suite cannot catch a change to code it never executes. The honest response is the hole list,
not a hand-built game (hazard H11).

### Gap 3 — the ranking, except where a tie actually occurs (M5)

`match/ranking.ts` is the only server-side implementation of the game's real winner rule. No
fingerprint reads it — `resultHash` hashes `computeResult`, which ranks on VP alone — so dropping its
megacredit tiebreak surfaces only as a `placement`/`isWinner` diff in a game with a genuine VP tie.
At 10 pinned games there was none; at 33 there is exactly one, a greedy 3p entry, and it fired with
**no fingerprint field at all**. The coverage is real but it rests on one game.

### Limit — L3 answers "roughly where", not "what caused it"

**Its localization named the right decision in neither case where "right" was checkable.** For M1 and
M2 the bracketed 25-decision window did not contain the mutated card, in either corpus. The reason is
structural rather than a bug: the first *divergence* is not the first *play of the mutated card* — it
is the first decision whose offered set or chosen response changed as a consequence, which can be
dozens of decisions later. Three of the four agent-side mutations bracketed to `(-1, 24]`, i.e.
"somewhere in the first 25 decisions", which is where the opening deal and the first generation's
buys are packed.

The fallback blind spot is narrower than its usual statement but real in a different way: M11 changes
exactly the decisions `moveTraceHash` has no step for, and the trace moved anyway (a fallback that
changes state changes the `pendingSignature` folded into every later step) — but L3 bracketed to the
first recorded decision *after* the fallback, never to the fallback itself. **So such a divergence is
not invisible; it is visible and attributed to the wrong decision.**

---

## 6. Findings — the things that should change what somebody does

### 1. Three defects, one shape, and two were found by *using* the tool

| Defect | Symptom | Found by |
| --- | --- | --- |
| `digestCorpus` hashed the corpus header | The ledger's content digest moved on **every commit**, so a rebaseline moving nothing recorded the artifact as changed | merging Units A and B |
| `verifyLedgerChain` did not cover its head | An edit to the ledger's **last** entry was undetectable — and on a one-entry ledger, that is every entry | Unit D, editing the file as an operator would |
| `--explain`'s branch gated on semantics alone | Reported *"a different route to an identical outcome"* for the case that is its exact opposite | Unit D, reading the output |

All three are **a check that is correct about the thing it looks at and silent about the thing beside
it**. All three passed their own specs. All three are fixed, each with a guard verified to fail
without the fix.

The ledger one is the sharpest. The existing spec edits entry 0 of a two-entry ledger and asserts the
refusal — a real, passing test of the half of the property that worked. The half that did not work
was the half the project depends on. And the failure is worse than a missed tamper: the next
legitimate rebaseline chains onto the edited row's digest, making the tamper permanently
self-consistent.

**`rating/seedBlocks.ts` already recorded this lesson** after bullet 3's two dead guards. It now has
three more instances, and the sharper statement is: *a spec whose subject includes repo state or file
state has a hidden fixture — the commit you happen to be on, or the file you happened to construct.*

### 2. "Greedy play reaches further" is false, and it is false in the direction that matters

§3.7 of the plan assumed the covering search should run over `greedy-1ply@1` because stronger play
reaches more cards. Measured over the survey, per game at 2p:

| | distinct cards | card actions | generations | ms/game (`tsx`) |
| --- | --- | --- | --- | --- |
| `random-legal@1` | **31.5** | **5.8** | 23.2 | **32** |
| `greedy-1ply@1` | 19.1 | 2.9 | 15.5 | 2,372 |

Maximizing current victory points buys fewer cards, plays fewer of them, and reaches the endgame
before a delayed-value engine ever runs — at **~75× the cost**. So `random-legal@1` is both the
broader and the vastly cheaper covering instrument.

**The consequence is structural.** A covering search maximizing coverage per second pins almost
nothing but cheap random-legal games — a corpus that covers the card pool beautifully and would not
notice `greedy-1ply@1` changing at all, which is the exact gap this bullet exists to close. Required
cells are the answer: 18 of 33 pinned games are `greedy-1ply@1`, seeded before the covering step and
never trimmed. **Left to the search alone the corpus had 5 greedy entries, all of them forced.**

### 3. A card-effect change can move `stableStateHash` and nothing else

On the 10-game corpus, M1 moved `fingerprints.stableStateHash` **alone** in both entries that noticed
it: every decision byte-identical, every semantic field unchanged. The field carrying the whole
detection is the one inherited from the determinism corpus, not the semantic block §3.3 argued for —
and L3 had nothing to localize, because localization brackets a *trace* divergence.

On the 33-game corpus the same mutation moved the trace and eleven semantic fields. So this is a
property of *which games are pinned*, not of the mutation. **Do not prune `stableStateHash` from the
compared fields on the argument that the semantic fields subsume it. They do not.**

### 4. `card_play_coverage.json` has one wrong zero, and the cross-check is what found it

That artifact records **Sell Patents played 0 times in 1,500 games**. It is played in essentially
every random-legal game. K4's observer wraps `StandardProjectCard.payAndExecute`, and Sell Patents
never calls it — `Game.getStandardProjects()` filters it out of the menu and `Player.getActions()`
offers `sellPatents.action(this)` instead, whose callback calls `projectPlayed` directly. The zero was
a fact about the instrument, read as a fact about reachability.

The unique chokepoint for all six standard projects is `projectPlayed`, which is what this bullet's
observer wraps. **No other K4 number is affected** — every other section reaches
`playCard`/`playCorporationCard`/`actionUsed`, which are unique. Worth re-running the sweep at M3 if
anything ever depends on that row.

The independent `moves`-tier derivation is the only thing that would have caught it: **0
disagreements over 950 games** on the five derivable standard projects. It also re-measured the
move-list cost at **70,625 B/game** against the plan's recorded 69.7 KB.

### 5. `tsx` understates *this* workload by 1.4×, not 3.5×

Whole-suite, same host, back to back: 36.3 s / 36.5 s compiled against 46.3 s / 50.6 s under `tsx`.
Per line: the determinism corpus 1.7×, L2's 33 games 1.4×, L1 identical because `runL1` spawns mocha
under `tsx` either way. **The ~3.5× figure in `agent/CLAUDE.md` §6 comes from the speed spike's
clone/deserialize micro-benchmarks and does not transfer to whole-game play**, where Engine work the
JIT warms up dominates. Both figures are correct about their own workload; neither generalizes.

### 6. The host cost two sessions, again

Units A and B measured the same determinism-corpus verify at 11 s, 102 s, 114 s and 124 s in one
session, with 4.6 GB of 5.1 GB swap in use. A full agent test run took 24 minutes on a swapping host
and 4 minutes on a recovered one. **This is bullet 1's hazard H10 recurring for the third time.**
Check `sysctl vm.swapusage` and free memory before believing any timing this repository produces.

---

## 7. How to re-run

```bash
cd agent
npm run regression                          # everything; non-zero exit on any failure
npm run regression -- --layer l1            # fixtures only, seconds, no games
npm run regression -- --layer l2 --agent greedy-1ply@1
npm run regression -- --explain greedy-1ply@1/2p/g6226/p1
npm run regression -- --ledger              # the rebaseline record
```

For the compiled build (the figure S6 is stated on), **both** steps are required or every `@/` import
fails at require time:

```bash
npx tsc --build agent/tsconfig.json && npx tsc-alias -p agent/tsconfig.json
```

Regenerating a pinned layer is an event, not a flag:

```bash
npm run regression -- --rebaseline --layer l2 --claim "<what changed and why this is not a regression>"
```

Selection and the survey (Unit C's, rarely needed — it spends R-block seeds):

```bash
npx tsx src/regression/select.ts --help
```

---

## 8. Artifacts

| File | What |
| --- | --- |
| `docs/data/regression_suite.json` | The 33 pinned games, per-game rows with `why` |
| `docs/data/regression_coverage.json` | 323 target rows, per-stratum survey stats, the hole list |
| `docs/data/regression_controls.json` | 11 mutations × 2 corpora, plus the S7 operator transcript |
| `docs/data/regression_smoke.json` | Unit A's 10-game corpus (format exercise; still used by specs) |
| `docs/data/regression_rebaselines.json` | The ledger — seeded, empty |
| `docs/data/ladder.json` | R-block allocations |
| `agent/src/regression/` | Types, corpus, runner, ledger, selection, fingerprints, mutations |
| `agent/test/regression/fixtures/` | The 13 L1 reference positions |

---

## 9. The prediction scorecard

The plan closed with eight falsifiable predictions. Recording hits and misses is the point of having
written them down.

| | Prediction | Outcome |
| --- | --- | --- |
| 1 | `greedy-1ply@1`'s L2 fingerprints generated for the first time here | **Held** (stated as certain) |
| 2 | ≥2 of the eight mutations uncaught, ≥1 a card-effect change on an unreached line | **Split.** Two uncaught at 10 games (M3, M5); **one** at 33 (M3). The unreached-line half was satisfied by M9, which was *built* as that experiment rather than observed — so the clause is true by construction, not by prediction. |
| 3 | The no-op control fires nothing | **Held**, in both runs |
| 4 | Anti-Gravity Technology uncovered, and 3–8 reachable cards uncovered in total | **Half missed.** It is uncovered; the total is **one**, not 3–8 |
| 5 | Card *actions* worse covered than card *plays* | **Split, and only split reporting shows it.** For the corpus: false — 38/38 actions against 274/275 plays, because random-legal reaches every one. Within `greedy-1ply@1`: exactly right, half the card actions per game |
| 6 | Compiled budget holds; `tsx` budget closer than expected | **Half missed.** Compiled held with 8.5× margin; `tsx` was **not** close (24× margin), because finding 5 |
| 7 | Parameterizing `replay()` leaves all 300 fingerprints unmoved | **Held** |
| 8 | ≥1 L1 fixture impossible to build minimally, most likely the X3 fizzle | **Missed.** The fizzle needs an empty hand and one `playCard` call, and putting both of its routes in one fixture is what pins the audit's finding |

---

## 10. Bottom line

The suite answers a question nothing in this project answered before, and the specific thing it
closes is that **`greedy-1ply@1` — one of the two frozen yardsticks every AC-3 claim is stated
against — had no fixed-seed standing check of any kind** while M3 is about to change the shared
infrastructure underneath it.

It is honest about being **selected rather than representative**, which is the correct property for a
regression suite and the wrong one for an estimate: nothing here is a strength claim, and no win rate
appears in this document.

Three things to carry into Milestone 3. **Gap 1 is the one that bites**: the change class the suite
is blindest to (a candidate-set reduction) is exactly the class bullet 2 pre-committed as
version-defining, so a promotion gate must not read a green suite as "the baseline is unchanged".
**L3 answers "roughly where"** and should be quoted that way. And **the covering instrument is
`random-legal@1`, not `greedy-1ply@1`** — which means any future section for a stronger agent needs
its games forced in rather than found by a search.
