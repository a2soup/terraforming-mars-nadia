# Milestone 2, bullet 5 — unit prompts (the regression suite)

**The bullet.** *"Establish a regression suite of fixed seeds and reference games."* It is the last
item in Milestone 2. It discharges no FR of its own — it is the standing check that keeps FR-13's
runner, FR-14's ratings, the two frozen baselines and the Engine pin meaning the same thing on the
day M3 lands as they meant on the day they were adjudicated.

**What makes this bullet different from the four before it.** Bullets 1–4 each built an instrument
and then *used it once*, at a moment when someone was watching. This bullet builds a thing whose
entire value is realized months later, in sessions nobody in this room will run, when it goes red on
a change somebody believed was harmless. Two failure modes follow from that, and they are the shape
of every decision below:

1. **A suite that goes red on every intentional change gets regenerated instead of read.** The
   determinism corpus already demonstrated this at small scale — the `initialCards` cap moved 43 of
   its 300 configs, which was that corpus working exactly as designed, and the correct response was a
   deliberate regeneration. Do that four more times and regeneration becomes reflex. **Layering by
   what is agent-invariant is the whole design**, and the layer boundary has to be structural, not
   advisory.
2. **A suite that has never refused anything is indistinguishable from a suite that works.** Bullet 3
   found two guards that had specs, passed them, and had never once refused a real run. This bullet's
   Unit D exists solely to make the suite fail on purpose and report which layers noticed.

**Read `agent/CLAUDE.md` §6 and §9 first.** Then read
[Card_Coverage_Audit.md](Card_Coverage_Audit.md) §3 and §5 (the eight divergences and the two
untested effects — this bullet is their only remaining downstream consumer),
[Determinism_Verification.md](Determinism_Verification.md) §2 (the corpus this suite extends and does
not replace), and [Milestone2_Bullet1_Prompts.md](Milestone2_Bullet1_Prompts.md) §4.3–§4.4 (the
record schema and the history tiers, both of which this bullet consumes rather than redesigns).

---

## 1. Scope — what this bullet is, and what it is not

**In scope.**

- A **three-layer regression suite** (§3.1) behind one command with a non-zero exit code:
  - **L1 — reference positions.** Small constructed scenarios asserting the Engine's behaviour at the
    pin on the cards that carry known risk: the eight Engine-vs-print divergences, the two effects the
    Engine's own suite never asserts, and Vitor's starting-M€ discrepancy. **Agent-independent** —
    these survive every agent change from here to M7.
  - **L2 — reference games.** Whole games pinned by `(agent, version, players, group index)`, with
    committed per-game rows, for both **frozen** baselines. Agent-version-scoped: a new agent adds a
    section and invalidates nothing.
  - **L3 — triage.** When L2 moves, report *what* moved — first divergent decision, which semantic
    fields changed, whether the delta is confined to a stratum — rather than a count of failures.
- A **coverage record** for the pinned corpus: which reachable cards, standard projects and card
  actions the pinned games actually exercise, derived from the `moves` tier at generation time and
  committed as a summary (§3.3).
- A **rebaseline ledger**: regenerating any pinned layer requires a written claim and an append-only
  entry (§3.5). A bare regenerate fails.
- **Negative controls**: pre-registered mutations, and a table of which layer caught each (§5, S1).
  Mutations nothing catches are committed as coverage gaps.
- The R-block seed allocation, recorded in `docs/data/ladder.json` before any game is played (§3.7).
- One deliverable document, `agent/docs/Regression_Suite.md`, and the artifacts behind it.

**Not in scope.**

- **No new agent, and no change to either frozen baseline.** If this bullet's work changes
  `random-legal@1`'s or `greedy-1ply@1`'s move distribution, that is a defect this bullet found, not
  a change this bullet makes (`agent/CLAUDE.md` §6, bullet 2).
- **No Engine modification.** CON-1. The eight divergences are *asserted as they are*, never fixed
  (§3.4 — this is the trap most likely to be walked into).
- **No strength claim.** No win rate, no Elo, no significance test appears in the deliverable. The
  R block is explicitly "never a strength estimate" (`rating/seedBlocks.ts`).
- **No throughput claim.** Same host, same swap problem (hazard H10 of bullet 1). §2.5's numbers are
  compute this bullet *spends*.
- **No replacement of the determinism corpus.** It is invoked, not absorbed and not regenerated
  (§3.9).
- **No CI wiring.** The suite exits non-zero; where it is invoked from is somebody else's decision.
- **No M4 seed-derivation work.** CON-5's `(runSeed, label)` streams stay a forward hook
  (`determinism/corpus.ts`'s `SEED_DERIVATION_VERSION`). Do not add a third seed to `rng.ts`.

---

## 2. What is already known — do not re-derive any of this

### 2.1 Three instruments, three questions — and the gap this bullet fills

| Question | Instrument | Scope today |
| --- | --- | --- |
| Is it legal? | AC-1 battery (`npm run match -- --legality`) | Any agent, re-run per version |
| Is it stronger? | Rating pipeline (`npm run rate`) | Any two agents |
| Is it deterministic? | `npm run determinism -- --verify` | **`random-legal@1` only** |
| **Did anything change that we didn't mean to change?** | **nothing** | — |

The fourth row is the bullet. The third row is the closest thing that exists and it is narrower than
it looks: `determinism/replay.ts:140` hard-codes `randomLegalAgent(createAgentRandom(...))`. So
**`greedy-1ply@1` — one of the two frozen yardsticks every AC-3 claim is stated against — has no
fixed-seed standing check of any kind.** M3 is about to change candidate enumeration and the search
plumbing underneath it. Nothing today would notice if `greedy-1ply@1` quietly stopped being
`greedy-1ply@1`.

### 2.2 The determinism corpus, measured

`docs/data/determinism_corpus.json`: **300 fingerprints, 139 KB**, each
`{config: {players, engineSeed, agentSeed}, moveTraceHash, stableStateHash, resultHash, decisions,
fallbacks, generation}`. Engine seeds `500,000 + 977k` for `k < 50`; agent seeds `1,000,003` /
`2,000,133`. Header comparison rejects on `engineCommit` (the **pin**, not HEAD), `seedDerivationVersion`
and the two gameplay-reaching env vars; `nodeVersion`/`agentCommit`/`agentVersion` are recorded and
deliberately **not** compared, so a Node upgrade surfaces as a fingerprint mismatch naming the moved
configs rather than a blanket refusal. That design decision is correct and this bullet inherits it
verbatim.

What it commits is **hashes**. For 300 cheap games that is the right trade. It is the wrong trade for
a curated set that has to explain itself — see §3.3.

### 2.3 The named consumers, and what each actually needs

Three places in the source documents route work *into* this bullet. Read what each one needs, not
just what it says:

| Consumer | Source | What it says | What it actually needs |
| --- | --- | --- | --- |
| The 8 Engine-vs-print divergences | Plan §7.2, SRS §2.6 footnote, `agent/CLAUDE.md` §6 | "the affected prelude/attack lines are pinned in the M2 regression seed set" — **this bullet is now their only downstream consumer** | A *direct assertion* per divergence. A pinned seed cannot do this — §3.2. |
| Hackers' `bespokePlay` steal; the City standard-project action | Plan §7.2 (risk row: "exercised in play but not asserted by any Engine unit test") | "both are added to the M2 regression seed set so a *silent* value regression is caught by fixed-reference games" | Same. The word doing the work is **silent**. |
| The low-frequency tail of reachable cards | Card_Coverage_Audit.md §6 | "the low-frequency tail of reachable cards, and the divergent cards in §3, are the seeds worth pinning" | Seed selection against measured per-card play frequency — §3.7. This one *is* a seed problem. |

The five escalating divergences: **Immigrant City** (legality — playable at M€ prod −4/−5),
**Energy Tapping** + **Power Supply Consortium** (value — net-zero no-ops when no player has energy
production, identical code), **Decomposers** + **Ecological Zone** (scoring — over-grant when played
via Ecology Experts; the Engine is internally inconsistent, Viral Enhancers does not). The three
non-escalating: **Virus** (option-list `slice(0, -1)` mishandling), **Hired Raiders** + **Sabotage**
("up to N" offered as `{maximum, none}`; the Miner award makes this non-contrived at 3–4p).

Two more worth pinning that the register does not name: **Vitor** hard-codes
`startingMegaCredits: 48` against a description and renderer that both say 45 — a silent 3 M€
discrepancy on 1 of 17 dealable corporations, trivially assertable, and exactly the class of thing a
pin move would break. And the **X3 prelude-fizzle 15 M€** mechanism, which is systemic and reachable
(Ecoline at 36 M€ buying 10 initial cards leaves 6).

### 2.4 The card tail, measured — do not re-run the sweep

From `docs/data/card_play_coverage.json` (1,500 games at the AC-1 composition, 27 Jul 2026): **274
reachable cards**, median **211** games observed, and the tail is short and specific.

| Games observed (of 1,500) | Cards |
| --- | --- |
| 0 | Anti-Gravity Technology |
| 2 | Interstellar Colony Ship |
| 5 | Mass Converter |
| 10 | Advanced Ecosystems |
| 17 | Quantum Extractor |
| 27–41 | AI Central, Gene Repair, Lightning Harvest, Birds |

**Five cards under 20, nine under 50.** Two consequences for seed selection. First, the tail is
almost entirely high-requirement cards (5 science tags, 3 energy production), which is a statement
about *random-legal play*, not about the card pool — greedy play reaches further, and the covering
search should run over `greedy-1ply@1` for that reason and not only for realism. Second,
**Anti-Gravity Technology was played zero times in 1,500 games**, so a covering set over any
achievable number of pinned games will have holes. Record them (S3). Do not manufacture a game that
reaches it by hand and call it coverage.

### 2.5 Cost, for planning the runs

From the committed rating corpora, under `tsx`, on this host:

| Corpus | Games | Wall clock | mean/game | p50 | p95 | max |
| --- | --- | --- | --- | --- | --- | --- |
| 2p `greedy-1ply@1` vs `random-legal@1` | 1,000 | 3,949 s | 3.95 s | 1.41 s | 11.35 s | 20.4 s |
| 3p `greedy-1ply@1`×2 vs `random-legal@1` | 600 | 1,125 s | 1.87 s | 1.51 s | 2.18 s | 193.9 s |

Three things to take from this and one not to. **Take:** the 2p mean is 2.8× its own median, so a
corpus budget must be set on wall clock, not on a game count; `tsx` understates the simulator ~3.5×,
so the compiled build is the number to quote (`agent/CLAUDE.md` §6, speed spike); and `random-legal`
is roughly two orders cheaper (~26 s per 1,000 games at 2p compiled), so its share of the corpus is
free and greedy's is the budget. **Do not take:** any comparison between the 2p and 3p rows as a
fact about player count — different lineups, and the 3p `max` of 193.9 s against a p95 of 2.18 s says
that host was doing something else at the time.

Working budget: **a 200-game L2 corpus of mixed baselines costs roughly 3–5 minutes compiled**, which
is the right order for a thing meant to run at every promotion gate. Size the corpus to the budget
(§3.8), not the other way round.

### 2.6 Seed namespaces: a group index is not an engine seed

Two namespaces exist and confusing them silently produces a corpus outside the R block:

- `determinism/replay.ts` takes a **raw** `engineSeed`. The committed corpus uses `500,000 + 977k`.
- The match runner takes a **group index** and derives `engineSeed = 21,000,017 + 1,409·group`,
  `agentSeed = 27,000,023 + 3,251·group + 149·slot` (`match/pairing.ts`).

**The R block (6,000–6,999) is group indices.** `rating/seedBlocks.ts` checks group indices, and
`ladder.json` records ranges in them. So L2's corpus is specified in group indices and the seeds are
derived, never written down as literals. `6,000–6,029` is already spent (M2b1 criterion R3, a
development run that certified nothing — but the range is used and `assertBlockAvailable` will
refuse it).

### 2.7 The `moves` tier costs 69.7 KB/game

Measured by bullet 1, Unit B, against a 30–60 KB estimate. A 200-game `moves`-tier corpus is ~14 MB
— too big to commit and the wrong thing to commit anyway (§3.3). Generate it, derive the coverage
record from it, commit the derived record, discard the move lists.

### 2.8 `testGame()` is available to agent specs, and nothing uses it yet

`agent/package.json`'s test script already loads `../tests/testing/setup.ts`, and `tests/TestGame.ts`
exports `testGame(count, customOptions?, idSuffix?)`. **No agent spec imports it today**, so Unit B
is the first, and the import path / `tsconfig` interaction is an unknown worth spending thirty
minutes on before committing to the approach (hazard H12).

---

## 3. Design decisions settled here — implement these, do not re-litigate them

### 3.1 Three layers, and the boundary is the point

The layers are defined by **what invalidates them**, not by what they test:

| Layer | Depends on | Invalidated by | Survives |
| --- | --- | --- | --- |
| **L1** reference positions | Engine at the pin | a pin move | every agent change, M3→M7 |
| **L2** reference games | Engine pin × agent **version** × shared agent infrastructure | a pin move; a genuine behaviour change in a frozen version | a *new* agent version (which adds a section) |
| **L3** triage | nothing — it reads L2's output | — | — |

Two consequences, both of which someone will want to argue with:

**A shared-infrastructure change that moves a frozen baseline is a regression, not a rebaseline.**
`greedy-1ply@1` does not own the enumerator, the driver, the fork service or the ranking. If M3
changes candidate enumeration and `greedy-1ply@1`'s fingerprints move, the agent's own code is
untouched and its behaviour changed anyway — which is precisely the event bullet 2 pre-committed
against: *"any change to its move distribution … is a **new version**, not an improvement."* L2 is
how that event becomes visible instead of theoretical. The correct response is to adjudicate it and
either revert or cut `greedy-1ply@2`; it is never to regenerate the corpus.

**L1 must not be allowed to drift into L2's job.** A reference position that plays fifteen moves to
set up a card is a reference *game* wearing a fixture's clothes, and it will break for reasons that
have nothing to do with the card. Keep L1 fixtures at the smallest state that reaches the assertion —
grant the card, grant the precondition, call the effect, assert the number.

### 3.2 A seed cannot assert a card — the source docs' phrasing is under-specified

Three places say the divergent cards are "pinned in the M2 regression seed set". Taken literally that
is a seed whose game happens to play Decomposers via Ecology Experts, hashed. Consider what that
detects. Decomposers over-grants +2 microbes; at 1 VP per 3 microbes the final score may or may not
move; the move trace certainly diverges from decision ~140 onward; and the report says *this 321-decision
game changed*. It would say the same thing if the enumerator reordered two options. **The seed proves
the line is reachable. It does not assert anything about the card.**

**Settled: each named card gets a direct L1 assertion, and the seed coverage record (§3.3) proves the
line is also exercised end-to-end.** Both, not either. This is a correction to the phrasing in the
source documents, not a reduction of their intent — the intent was "catch a *silent* value regression
on these cards", and a hash over a whole game is the one instrument that cannot do that. Unit E
records the correction in both source docs.

### 3.3 Commit the fields, not a hash of the fields

The determinism corpus commits six hashes per config because it is answering one yes/no question over
300 games. L2 is answering "what changed", over a curated set that has to justify its own existence
years later. So an L2 entry commits:

```
identity      agent, agentVersion, players, groupIndex, permutationIndex   (seeds derived, §2.6)
fingerprints  moveTraceHash, stableStateHash, resultHash, decisions, fallbacks, generation
semantics     per seat: placement, isWinner, victoryPoints, megaCredits, terraformRating,
              vpBreakdown (all six components), corporations, preludes, projectCards
              plus: claimedMilestones, fundedAwards
coverage      standardProjects used, card actions used   (derived from the moves tier, §2.7)
why           free text: what this game is pinned for
```

Every field except `coverage` and `why` is already on `MatchGameRecord` / `MatchSeatOutcome` — bullet 1
designed that schema against its whole consumer list precisely so this bullet would not need a re-run.
Read `match/types.ts`'s module doc before adding a field to it.

**Why the semantics and not a hash of them.** Because "the move trace differs but every VP component
is identical" and "greenery VP moved by 2" are different events with different responses, and a
combined hash makes them the same event. That distinction *is* L3.

**`why` is not decoration.** It is what stops a future session deleting a game it does not understand,
and it is the only field a human reads first when the suite goes red. Every pinned game carries one
sentence naming what it covers.

**This is bullet 3's explicit lesson, applied** (`agent/CLAUDE.md` §6): *"commit the per-game rows,
not the summary"* — `baselines_validation.json` carries summaries only, so bullet 2's headline 99.2%
cannot be re-analysed by anything.

### 3.4 An L1 fixture asserts Engine behaviour at the pin, never printed behaviour

This is the single most likely way this bullet produces something actively harmful.

A fixture for Immigrant City that asserts "playable at M€ production ≥ −5" looks, to a reader who has
not read the audit, exactly like a test encoding a bug. Someone will "fix" it. Then the suite asserts
the printed rule, the Engine asserts the Engine rule, and the fixture fails forever on correct code.

**Every L1 fixture carries, in the file, next to the assertion:**

1. The Engine behaviour being asserted, as a number.
2. The printed behaviour, as a number, and the fact that they differ.
3. A link to the audit entry (`Card_Coverage_Audit.md` §3, register row N) and the words *this
   fixture pins the Engine's behaviour by CON-1; it is not an endorsement, and changing it to match
   the print is a change to the fixture's meaning, not a fix.*

For the three `undecided` items pinned (Vitor, the X3 fizzle, one X5 no-op), the comment says
`undecided` and links the register row rather than claiming a divergence.

### 3.5 Rebaseline is an event with a ledger entry, not a flag

`npm run regression -- --rebaseline` alone fails. It requires `--claim "<what changed and why>"` and
appends to `docs/data/regression_rebaselines.json`:

```
{ recordedAt, layer, claim, agentCommit, enginePin,
  entriesMoved, entriesTotal, fieldsMoved: {moveTraceHash: n, victoryPoints: n, ...},
  previousDigest }
```

`entriesMoved` and `fieldsMoved` are computed by the tool, not typed by the operator — a rebaseline
that moved 43 of 300 configs and one that moved 300 of 300 are different events and the ledger has to
say which happened without being asked. `previousDigest` makes the chain auditable.

Modelled directly on `rating/seedBlocks.ts`'s allocation ledger, and for the same reason recorded
there: *a convention that lives only in a plan document is a convention that expires with the session
that wrote it.* And with the same failure mode already paid for once — bullet 3's ledger was never
being read, and once it was, a gate's own reservation blocked it, **both found by using the CLI**.
Unit D uses this CLI end to end (S7).

### 3.6 What a new agent version inherits, and what it does not

State this explicitly because M3 will ask:

- **Inherits:** all of L1. Every reference position applies to every agent forever, because none of
  them involve an agent.
- **Inherits:** the obligation that the *frozen* baselines' L2 entries still pass. This is the check
  that matters at a promotion gate and it is the one nothing does today (§2.1).
- **Does not inherit:** L2 entries of its own. A new version has no history to regress against. It
  gets a section generated **once, at promotion**, from a freshly allocated R sub-range, and frozen.
- **Does not replace:** the AC-1 legality battery. The standing caveat in `agent/CLAUDE.md` §7 is
  unchanged — AC-1 expires on every new agent version and this suite does not re-establish it. Three
  instruments, three questions (§2.1); the deliverable says so in its first paragraph so nobody at M4
  reads a green suite as a legality result.

### 3.7 Seed selection: a covering set over the R block, with the holes recorded

Reserve **6,100–6,499** in the R block for L2 (leaving 6,030–6,099 as a gap after the spent R3 range,
and 6,500–6,999 for the per-version sections M3–M6 will each need). Record the allocation in
`ladder.json` **before playing anything** — `npm run rate -- ladder allocate --block regression …`.

Selection is a two-pass, and the first pass is throwaway compute:

1. **Survey.** Play the reserved range with both baselines at 2p/3p (and a 4p smoke), `moves` tier,
   recording per game the set of cards played, standard projects used, card actions used, milestones
   claimed and awards funded. This is a few hundred games and it is not pinned — it is the search
   space.
2. **Cover.** Greedy set cover over that survey for the target set: the 274 reachable cards weighted
   toward the §2.4 tail, the ten named cards of §2.3, every standard project, every milestone and
   award. Break ties toward games that are cheap (`durationMs`) and short (`decisions`), because the
   suite's budget is §3.8's and a 20-second game buys the same coverage as a 1.4-second one.
3. **Trim to budget**, then record what is left uncovered and why.

**The holes are a deliverable, not an embarrassment.** Anti-Gravity Technology will be one of them
(§2.4). So, probably, will several card *actions* — the survey measures what the baselines do, and
`greedy-1ply@1` is a points-now chooser that will systematically underuse cards whose value is
delayed. Say that plainly; it is a fact about the instrument that M3 should know before it trusts the
coverage number.

### 3.8 One command, and it has to finish

**Pre-committed budget: the full suite runs in ≤ 5 minutes on the compiled build, ≤ 20 minutes under
`tsx`.** Everything above is sized to fit this, not the reverse. A suite that takes an hour is a
suite that runs at the end of the project instead of at every gate, and then it is an archive.

```bash
npm run regression                       # all layers, exits non-zero on any failure
npm run regression -- --layer l1         # fixtures only — seconds, no games
npm run regression -- --layer l2 --agent greedy-1ply@1
npm run regression -- --explain <entry>  # L3 triage for one failed entry
npm run regression -- --rebaseline --layer l2 --claim "..."
```

L1 is also plain mocha specs under `agent/test/regression/`, so `npm test` runs them without the CLI.
That redundancy is deliberate: the fixtures are the layer most likely to catch something and the
layer cheapest to run, so it should be impossible to skip.

### 3.9 The determinism corpus is invoked, not absorbed

`npm run regression` runs `verifyCorpus` over the committed 300 fingerprints as part of L2 and reports
it as its own line. It does **not** move the file, regenerate it, or reimplement it, and
`npm run determinism -- --verify` keeps working unchanged.

House precedent, and the reason is the same one bullet 1 gave for retaining `agent/src/legality/`:
the corpus is the artifact-of-record for M1 bullet 6 and the oracle any future comparison is made
against. What is being consolidated is *where you have to remember to run it*, not *what it is*.

**One structural change is required and it is strictly additive.** `determinism/replay.ts` hard-codes
the random-legal agent (§2.1). L2 needs the same fingerprint over a named agent, so `replay()` takes
an optional agent factory defaulting to today's behaviour — and a spec asserts that the committed 300
fingerprints still verify byte-for-byte after the change. If they move, the change was not additive
and that is the first thing this suite ever caught.

---

## 4. Hazards already located — hand these to the units, don't rediscover them

| # | Hazard | Mitigation |
| --- | --- | --- |
| H1 | **Duplicating the determinism corpus.** It is 300 fixed-seed games with committed hashes; a naive reading of this bullet rebuilds it. | §3.9. Invoke it. The new thing is *named agents*, *semantic rows*, and *L1*. |
| H2 | **Parameterizing `replay()` changes the committed fingerprints.** | §3.9's spec. Additive default, 300 must still verify. |
| H3 | **`moves`-tier bloat.** 69.7 KB/game; a 200-game corpus is ~14 MB. | §2.7. Derive coverage, commit the summary, discard the lists. |
| H4 | **`game.id` collides across player counts.** `g-nadia-${seed}` omits the count, so a 2p and a 3p game on one engine seed share an id. | Key on `(agent, version, players, groupIndex, permutationIndex)`. Never on `game.id`. |
| H5 | **Group index ≠ engine seed.** | §2.6. Specify in group indices; derive seeds. `assertBlockAvailable` before the run, allocation in `ladder.json` before the run. |
| H6 | **`tsx` understates the simulator ~3.5×.** No timing from a spec is a performance figure. | Quote compiled numbers. Check `sysctl vm.swapusage` and free memory before believing any of them (bullet 1 H10). |
| H7 | **A hash-only suite goes fully red on the first intentional agent change**, and then gets regenerated by reflex. | §3.1's layering, §3.5's ledger. The ledger is what makes reflex expensive. |
| H8 | **`Game.gotoEndGame()` is unawaited async**, so a synchronous batch holds every finished game alive (~0.27 MB each). | Yield between games (`--yield-every`, as the AC-1 run does). Any mid-run read of process-global state must flush the event loop first. |
| H9 | **The corpus header must compare the Engine pin, not repo HEAD.** Already paid for once — it made every committed corpus unverifiable on the next docs-only commit. | Reuse `CorpusHeader` and `assertHeaderCompatible` verbatim, as `match/types.ts` does. Do not write a second header type. |
| H10 | **An L1 fixture that asserts the printed rule will be "fixed" into permanent failure.** | §3.4's three-part comment, in the file, next to the assertion. |
| H11 | **Coverage holes get quietly filled by hand.** Anti-Gravity Technology was played 0/1,500. | S3 makes the hole list a criterion. A hand-built game is an L1 fixture and is labelled one — it is not coverage of the pinned corpus. |
| H12 | **No agent spec imports `testGame()` yet** (§2.8), so the import path / `tsconfig` interaction is unproven. | Unit A smoke-tests one import before Unit B builds thirteen fixtures on it. Thirty minutes, front-loaded. |
| H13 | **The 2p duration distribution has a fat tail** (mean 3.95 s against p50 1.41 s, p95 11.35 s). | §3.7's tie-break on `durationMs`. Size to wall clock (§3.8), verify against the real corpus, not the median. |
| H14 | **A green suite read as a legality or strength result.** | §3.6. The deliverable's first paragraph states the three-instrument split. |

---

## 5. Pre-committed criteria — write these down before any measurement code exists

Commit this section **in its own commit**, as bullets 1–3 did. S1–S9 are what "bullet 5 is done" means.

- **S1 — The suite refuses.** At least **eight pre-registered mutations**, chosen to hit distinct
  classes and written down before any is run: a card effect amount (a `behavior` production value); a
  card's `bespokePlay` (Hackers' steal count); a candidate-set reduction in `core/candidates/`; an
  enumerator ordering change; a ranking tiebreak in `match/ranking.ts`; a VP-breakdown component; a
  seed-schedule stride; and one **no-op control** (a comment). For each: which layers fired, and
  whether L3's first-divergence localization named the right decision. **A mutation no layer catches
  is recorded as a coverage gap in the deliverable**, not quietly dropped — and the no-op control
  firing anything is a blocking failure.
- **S2 — The suite passes clean, twice, in two processes.** Zero failures on the committed artifacts
  in-process and in a fresh process, header compatibility included. A pass that is not reproducible
  across processes is not a pass (bullet 6's own criterion, applied here).
- **S3 — Coverage is stated per card and the holes are named.** For all **274 reachable cards**, every
  standard project, every milestone and every award: exercised by the pinned corpus, or not, with the
  count. The ten named cards of §2.3 are exercised **or** individually recorded as unreachable by the
  baselines with the reason. No aggregate percentage is reported without the hole list beside it.
- **S4 — Every named card has a direct assertion.** L1 fixtures exist for all eight divergences, both
  untested effects (Hackers' `bespokePlay` steal of 2 M€ production; the City standard-project action),
  and Vitor. Each asserts the **Engine's** behaviour, carries §3.4's three-part comment, and
  cross-references its audit register row. A fixture that cannot be built is recorded with why —
  **untested, not met**, in bullet 1's R3 sense.
- **S5 — Both frozen baselines are pinned, at both counts that matter.** L2 entries for
  `random-legal@1` and `greedy-1ply@1` at 2p and 3p, plus a 4p smoke. `greedy-1ply@1` at 2p is the
  entry that closes §2.1's gap; a suite without it has not done the bullet.
- **S6 — The budget holds.** The full suite runs in **≤ 5 minutes compiled, ≤ 20 minutes under `tsx`**,
  measured and reported. Over budget is a **failure to be fixed by cutting the corpus**, not a number
  to revise upward — the whole design assumes it runs at every gate.
- **S7 — Rebaseline cannot be silent.** Demonstrated by attempting it: a bare `--rebaseline` is
  refused; with `--claim` it succeeds and the ledger entry carries tool-computed `entriesMoved` and
  `fieldsMoved`. Verified through the CLI, on the real committed artifact — not against an in-memory
  ledger (bullet 3's specs passed that way while the guard was off).
- **S8 — Per-game rows, not summaries.** Every committed L2 entry carries §3.3's semantic fields.
  Adjudicated by a stated re-analysis the artifact supports that a summary would not.
- **S9 — Seed-block discipline holds.** Every group range used is inside R (6,000–6,999), disjoint
  from the spent 6,000–6,029, allocated in `ladder.json` **before** the games were played, and
  `assertBlockAvailable` passes. The allocation entry names this bullet.

**Non-criteria, stated so they are not smuggled in.** This bullet does not claim any agent is stronger
than any other, does not re-establish AC-1 for anything, does not fix any Engine divergence, does not
measure throughput, and does not claim the pinned corpus is representative of play — it is *selected*,
which is the opposite of representative and is the correct property for a regression suite.

---

## 6. Structure — five units, and why this shape

**`(A ∥ B) → (C ∥ D) → E`.**

Not the `A → (B, C, D) → E` of bullets 5 and 6, and the difference is a finding about this task rather
than a preference. Applying `agent/CLAUDE.md` §9's four questions:

- **Is the first unit a real dependency?** For C and D, yes — both write and read A's corpus format
  and both run through A's CLI, and a format is the canonical thing that cannot be retrofitted.
  **For B, no.** L1 fixtures are mocha specs over `testGame()`; they touch no corpus, no seed and no
  CLI. Blocking thirteen card fixtures on a corpus format they never read would be coordination
  dressed as a dependency, so B starts immediately.
- **Are the parallel units comparable?** A and B are (a format + runner, against thirteen fixtures
  each requiring a card read against the audit). C and D are not quite — C is larger, but D is
  *adversarial work over C's output*, which is the one thing §9 names as warranting its own session.
  Merging D into C means the person who built the suite decides whether it catches things, and bullet
  3 measured what that produces: two guards with specs that had never refused a real run.
- **Does splitting cost a cold start?** B keys off Engine card classes and the audit document; C keys
  off the match runner, the pairing schedule and the ledger. Different object sets, so the split is
  free. A and C would both key off the corpus format, which is why C follows A rather than sitting
  beside it.
- **What warrants its own session?** E — it edits both source-of-truth documents (one writer, always)
  and adjudicates S1–S9, which is pure judgment over other units' output.

D's mutation harness is built against a small throwaway corpus A produces as a smoke test, so D
overlaps C and only its final control runs wait for C's committed artifact.

---

## 7. Routing — scale and which model to run each unit on

| Unit | Scale | Model | Why — i.e. what goes wrong if run cheaper |
| --- | --- | --- | --- |
| **A** — core, format, CLI, ledger | ~700 lines src + ~350 test, 6 files, ~half a day | **Opus** | The §3.3 record shape and the §3.1 layer boundary are the two decisions that cannot be retrofitted after M3 has generated entries against them. A format that omits `vpBreakdown` costs a re-run now and a multi-hour one at M4 — the exact cost bullet 1 designed its schema to avoid. |
| **B** — L1 reference positions | ~13 fixtures, ~550 lines; the reading is the work | **Opus** | Every fixture is a judgment about what the Engine does versus what the card prints, made by reading `bespokePlay` against a printed card. Get it backwards (H10/§3.4) and the artifact is a permanently-failing test that looks like a bug report. Bullet 7 rated this same reading as the most careful work in the milestone. |
| **C** — selection + corpus generation | ~450 lines + 2–5 h unattended compute; artifacts ~1–3 MB | **Opus** for the selection design and the budget trade; the generation runs are unattended | Set cover is mechanical; *what to cover, and which holes are acceptable* is not, and §3.7's honest answer ("greedy-1ply systematically underuses delayed-value cards, so the coverage number is about the instrument") is the kind of thing a cheaper run reports as 94%. |
| **D** — negative controls | ~350 lines + a few hours of control runs | **Opus** | The unit's entire product is finding what the suite *misses*. A run that confirms the eight mutations are caught and stops has produced nothing; the value is in the ninth mutation it thinks of and in refusing to soften a gap into a caveat. |
| **E** — adjudication, write-up, documents | ~450-line deliverable + edits to SRS, Plan, `agent/CLAUDE.md`, Running Notes | **Opus** | Adjudicating S1–S9 against evidence, and §3.2's correction to three source-document statements. One writer for the source docs, always. |

---

## 8. File ownership, so parallel work never collides

| Unit | Creates / owns | May read | Must not touch |
| --- | --- | --- | --- |
| **A** | `agent/src/regression/{types,corpus,runner,ledger}.ts`, `agent/src/runner/regressionCli.ts`, `agent/test/regression/{corpus,runner,ledger}.spec.ts`, the `regression` script in `agent/package.json`; **the additive change to `agent/src/determinism/replay.ts`** (§3.9) and its guard spec | everything | `docs/data/determinism_corpus.json`; anything under `src/` |
| **B** | `agent/test/regression/fixtures/*.spec.ts`, `agent/test/regression/fixtures/helpers.ts` | `src/server/cards/**`, `Card_Coverage_Audit.md`, `tests/TestGame.ts` | `agent/src/regression/**`; anything under `src/` |
| **C** | `agent/src/regression/{select,fingerprint}.ts`, `agent/docs/data/regression_suite.json`, `agent/docs/data/regression_coverage.json`, the R-block entry in `agent/docs/data/ladder.json` | A's modules, `match/**`, `card_play_coverage.json` | A's files; B's fixtures; any other `ladder.json` entry |
| **D** | `agent/src/regression/mutations.ts`, `agent/test/regression/controls.spec.ts`, `agent/docs/data/regression_controls.json` | everything | every other unit's files — **mutations are applied in a scratch worktree and reverted**, never committed |
| **E** | `agent/docs/Regression_Suite.md`, `agent/CLAUDE.md`, both source-of-truth documents, `agent/docs/Running_Notes.md`, `agent/docs/data/regression_rebaselines.json` (seeded) | everything | any source file |

`agent/package.json` is A's alone. If C or D needs a script, it asks A.

---

## 9. Shared preamble — prepend to every unit prompt below

> You are working on **Nadia**, an AI agent that plays Terraforming Mars by driving the
> terraforming-mars Engine in this same repository as ground truth. Read `agent/CLAUDE.md` first —
> §2 (the Engine pin and the isolation rule), §6 (current status and what each finished bullet
> established), and §9 (standing conventions). The Engine is **frozen at commit
> `868714d72a434ab68fe08e5570ebc6863859ae15`**; nothing under `src/` may be modified (SRS CON-1).
>
> You are implementing one unit of **Milestone 2, bullet 5 — the regression suite**. The plan is
> `agent/docs/Milestone2_Bullet5_Prompts.md`. Read §1–§5 in full before writing any code: §2 is
> measured fact you must not re-derive, §3 is settled design you must not re-litigate, §4 is a list
> of hazards already paid for once, and §5 is the criteria this bullet is adjudicated on — which
> were committed before any of this code existed and are not to be edited to fit a result.
>
> Two things about this bullet specifically. **First, the suite's value is realized months from now,
> by sessions that will not have your context** — so a pinned entry without a `why`, or an assertion
> without the comment §3.4 requires, is not finished work. **Second, a regression suite that has
> never refused anything is indistinguishable from one that works** (bullet 3 found two such guards).
> If your unit builds a check, make it fail on purpose at least once and say so.
>
> Run `nvm use` at the repo root (Node 22). Agent tests: `cd agent && npm test`. Follow the style of
> the surrounding code, and match the density of the doc comments in `agent/src/match/types.ts` and
> `agent/src/rating/seedBlocks.ts` — those files explain *why*, and the why is what survives.
> Append a dated entry to `agent/docs/Running_Notes.md` for anything you find that the plan did not
> predict.

---

## Unit A — the suite core: format, runner, CLI, ledger

**Depends on:** nothing. **Blocks:** C, D.

### 1. Settle H12 first, in thirty minutes

Before anything else: write one throwaway spec under `agent/test/regression/` that imports
`testGame` from `../../../tests/TestGame` and builds a 2p game. Confirm it runs under
`cd agent && npm test`. If the `tsconfig`/path interaction needs a change, make it now and tell Unit B
what the working import looks like — B is about to build thirteen fixtures on it (§2.8).

### 2. Types and the record (`regression/types.ts`)

§3.3's entry shape, exactly. Reuse `CorpusHeader` from `determinism/corpus.ts` for provenance (H9) —
do not write a second header type. Reuse `MatchSeatOutcome`'s fields rather than re-declaring them;
if a field you need is missing from `match/types.ts`, read that file's module doc before adding it,
and add it there rather than duplicating.

Declare the layer enum and make it structural: an entry knows which layer it belongs to, and the
runner refuses to compare an L1 entry against L2 machinery. §3.1's boundary is only real if it is
enforced by a type.

### 3. The corpus and its verification (`regression/corpus.ts`)

Load, save, verify. `assertHeaderCompatible` before comparing anything (H9). Verification returns a
**per-field** diff, not a boolean — §3.3's whole point — grouped so L3 can ask "did any semantic field
move, or only the trace?"

### 4. `replay()` takes an agent (`determinism/replay.ts`, §3.9)

Additive: an optional agent factory, defaulting to `randomLegalAgent(createAgentRandom(seed))`.
**Then write the guard spec**: re-verify the committed 300 fingerprints in
`docs/data/determinism_corpus.json` and assert zero mismatches. If any move, stop and report — that is
the change not being additive, and it is the first thing this suite ever caught.

### 5. The runner and CLI (`regression/runner.ts`, `runner/regressionCli.ts`)

§3.8's five invocations. Non-zero exit on any failure. L2 runs the committed determinism corpus as
one reported line (§3.9) and never regenerates it. Yield between games (H8).

### 6. The rebaseline ledger (`regression/ledger.ts`)

§3.5. `--rebaseline` without `--claim` fails. `entriesMoved` / `fieldsMoved` computed by the tool.
Append-only, `previousDigest` chained. Model it on `rating/seedBlocks.ts` and read that file's
comment about the ledger that was never being read.

### 7. Prove it, and hand off

A smoke corpus of ~10 games so C has a format to write against and D has something to mutate on day
one. Specs for the format, the per-field diff, header rejection, and the ledger's refusal path — the
refusal path exercised **through the CLI**, not against an in-memory ledger.

---

## Unit B — L1 reference positions

**Depends on:** nothing (take the working `testGame` import from Unit A §1 when it lands; do not
block on it — start by reading cards).

Thirteen fixtures under `agent/test/regression/fixtures/`. For each, the work is: read the card's
source at the pin, read its entry in `Card_Coverage_Audit.md` §3 and its register row in
Implementation Plan §7.2, decide the smallest state that reaches the assertion, and write it.

**The five escalating divergences.** Immigrant City (legality at M€ prod −4/−5); Energy Tapping and
Power Supply Consortium (net-zero no-ops when no player has energy production — one mechanism, two
fixtures because they are two cards); Decomposers and Ecological Zone (over-grant via Ecology Experts;
assert the Engine's +2 microbes / 3rd animal, **and** assert Viral Enhancers' correct behaviour beside
it, because the inconsistency between them is the finding).

**The three non-escalating.** Virus (the `slice(0, -1)` option-list mishandling — assert the option
set the Engine actually offers); Hired Raiders and Sabotage (`{maximum, none}` where the print grants
0..N).

**The two untested effects.** Hackers — `bespokePlay` defers
`DecreaseAnyProduction(player, MEGACREDITS, {count: 2, stealing: true})`; assert the steal resolves,
which the Engine's own `Hackers.spec.ts` never does. The City standard project — assert the action
executes, which the Engine's suite never does.

**Three `undecided` items**, labelled as such (§3.4): Vitor's `startingMegaCredits: 48` against a
description saying 45; the X3 prelude-fizzle 15 M€ (Eccentric Sponsor's path, which is genuinely
played and fizzles from inside `bespokePlay`); one X5 maxed-parameter no-op.

**Every fixture carries §3.4's three-part comment.** Engine number, printed number, register row, and
the sentence saying that changing it to match the print is a change of meaning rather than a fix. A
fixture without that comment is not done, and it is the difference between this unit producing an
asset and producing a landmine.

Fixtures stay minimal (§3.1). If one needs fifteen setup moves, say so and hand it to C as a seed to
pin instead — that is a real finding about the card's reachability, not a failure.

---

## Unit C — seed selection and the reference-game corpus

**Depends on:** A. **Runs beside:** D.

### 1. Allocate before you play

`npm run rate -- ladder allocate --block regression --groups 400 --spent-by "M2b5 L2 reference games"`
for **6,100–6,499** (§3.7). Confirm `assertBlockAvailable` passes and that 6,000–6,029 is refused.
Nothing is played before this lands.

### 2. Survey (throwaway compute)

Both baselines, 2p and 3p, plus a 4p smoke, `moves` tier, over the allocated range. Per game record
the card set, standard projects, card actions, milestones and awards. ~14 MB of move lists that you
will **not** commit (H3) — derive and discard.

### 3. Cover, trim, and record the holes

§3.7's greedy set cover, tie-broken toward cheap and short games (H13). Trim to §3.8's budget. Then
write the hole list: what the pinned corpus does not reach, and — for the cards the baselines
systematically underuse — why that is a statement about `greedy-1ply@1`'s points-now objective rather
than about the card pool. **The hole list is S3, and it is the part of this unit a cheaper run would
have reported as a percentage.**

### 4. Commit

`docs/data/regression_suite.json` (per-game rows per §3.3, each with its `why`) and
`docs/data/regression_coverage.json`. Verify the committed corpus passes in a fresh process (S2) and
time the full suite compiled and under `tsx` (S6). If it is over budget, cut the corpus — do not
revise the budget.

---

## Unit D — negative controls: make it fail on purpose

**Depends on:** A (start against A's smoke corpus). **Final controls run against:** C's committed corpus.

Pre-register the eight mutations of S1 **before running any of them**, in their own commit. Then, one
at a time, in a scratch worktree: apply, run the full suite, record which layers fired, whether L3's
first-divergence localization named the right decision, and revert. Mutations are never committed.

Three things this unit is for, in order of value:

1. **The mutation nothing catches.** Look for it deliberately — a change to a card whose line the
   corpus does not reach, a reordering that leaves every semantic field identical, a change in a
   fallback-resolved decision (`moveTraceHash` has no step for a decision the responder threw on, so
   a divergence confined to those would not move it — `agent/CLAUDE.md` §6). Each one found is a row
   in the deliverable's gap table.
2. **The no-op control.** A comment-only change must fire nothing. If it fires anything, the suite is
   non-deterministic and every other result in this bullet is void.
3. **The ledger, used as an operator would use it** (S7). Bullet 3's two dead guards were both found
   this way and neither was found by a spec.

---

## Unit E — adjudication, the write-up, and the documents

**Depends on:** A, B, C, D.

### 1. Adjudicate S1–S9 one at a time

Each gets its own verdict — met / not met / **untested** — against evidence, in that vocabulary
(bullet 1's R7 and bullet 3's P2/P3 are the precedents: a criterion that could not be measured is
*untested*, and a criterion the evidence does not support is *not met* and is **not** rewritten to
fit). If S6 failed and the corpus was cut to meet it, say what was cut.

### 2. Deliverables

- **`agent/docs/Regression_Suite.md`.** Opens with §2.1's three-instrument table and §3.6's
  inheritance rules, because those are what a promotion-gate session at M4 needs in its first
  paragraph (H14). Then the layers, the adjudication, the coverage record with its hole list, D's gap
  table, and the re-run commands.
- **`agent/CLAUDE.md` §6:** bullet 5 DONE, Milestone 2 complete. The "five things worth knowing"
  block, in the house style — lead with §2.1's gap (`greedy-1ply@1` had no standing check), §3.2's
  correction, §3.1's shared-infrastructure rule, D's gap table, and the budget.
- **Both source-of-truth documents.** Plan §9 Milestone 2 bullet 5 marked done with its findings, the
  exit criterion adjudicated, and the risk-register rows for the eight divergences and the two
  untested effects updated to name their now-existing consumer. **§3.2's correction is made in place
  in all three locations** that say the divergent cards are "pinned in the M2 regression seed set" —
  the intent stands, the mechanism named was insufficient, and the correction says both.
- **`Running_Notes.md`:** a dated entry for everything the plan did not predict.

### 3. Four things to resist

- **Reporting a coverage percentage without the hole list.** S3 forbids it, and the holes are the
  informative half.
- **Softening a D gap into a caveat.** A mutation the suite missed is a row in a table, not a
  sentence in a paragraph.
- **Rewriting a criterion to fit.** P2 stands as not met in the rating pipeline; that is the house
  precedent and it is why these documents are worth reading two milestones later.
- **Claiming the corpus is representative.** It is selected. That is the correct property and the
  deliverable should say so rather than implying breadth it does not have.

---

## Appendix — falsifiable predictions

Recorded now so the write-up can mark each hit or missed. A wrong prediction is a finding.

1. **`greedy-1ply@1`'s L2 fingerprints will be generated for the first time in this bullet and will
   not be reproducible from anything committed today.** (Certain, but state it — it is the gap.)
2. **At least two of D's eight mutations will not be caught by any layer**, and at least one of them
   will be a card-effect change on a line the corpus does not reach.
3. **The no-op control will fire nothing.** If it fires, everything else here is void.
4. **Anti-Gravity Technology will not be covered**, and it will not be alone — expect 3–8 reachable
   cards uncovered, concentrated in the §2.4 tail.
5. **Card *actions* will be worse covered than card *plays***, because `greedy-1ply@1` maximizes
   points-now and delayed-value actions are exactly what that objective discounts.
6. **The 5-minute compiled budget will hold; the 20-minute `tsx` budget will be closer than expected**,
   because the 2p duration tail (p95 11.35 s) dominates a small corpus more than a large one.
7. **Parameterizing `replay()` will leave all 300 committed fingerprints unmoved.** If not, the change
   was not additive.
8. **At least one L1 fixture will be impossible to build minimally** — most likely the X3 prelude
   fizzle, which needs a specific prelude in a specific hand at a specific M€ — and will be recorded
   as *untested* rather than forced.
