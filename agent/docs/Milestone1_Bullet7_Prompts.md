# Milestone 1, bullet 7 — phase prompts (card-coverage audit)

Bullet 7 of Milestone 1: *"Confirm that every in-scope base + Corporate Era + Prelude card and
corporation is implemented and test-covered at the pinned commit (the rules-ground-truth
assumption); record any gaps as known limitations."*

This bullet does not discharge an acceptance criterion. It audits an **assumption** — SRS §2.6:
*"The chosen Engine commit correctly implements the base game, Corporate Era, and Prelude rules; its
card implementations are treated as the rules ground truth."* That single sentence is what makes
SRS CON-1 (never re-implement rules) safe, and CON-1 is the project's largest risk reduction. If it
is wrong anywhere, the Agent inherits the error silently and every downstream measurement — M2 win
rates, M3 evaluation weights, M6 self-play targets — is computed against a subtly wrong game.

The Plan is explicit that this bullet **does not gate the Milestone 1 exit criterion** (Plan
Milestone 1, exit-criterion paragraph). It is the last outstanding Milestone-1 work item, and its
output is evidence plus a register of known limitations, not a pass/fail gate. That does not make it
optional: it is the only planned activity that ever looks at the ground-truth assumption directly.

Like bullets 5 and 6, this is a **verification bullet, not a feature bullet**. It changes nothing in
the Engine and nothing in the existing agent modules. Output is a census, three measurements, a
known-limitations register, and edits to the source-of-truth documents.

---

## What is already known — do not re-derive any of this

Everything in this section was measured while writing this document, by static analysis at the
pinned commit (`868714d72a434ab68fe08e5570ebc6863859ae15`). Re-deriving it is wasted effort. The
value of bullet 7 is entirely in what these numbers *don't* answer.

### The in-scope set, counted

`GameCards` (`src/server/GameCards.ts:48-64`) selects manifests from `GameOptions`. Nadia's factory
sets exactly `{boardName: THARSIS, corporateEra: true, preludeExtension: true}`
(`agent/src/engine/gameFactory.ts:13-17`), so the in-scope manifests are exactly
`BASE_CARD_MANIFEST`, `CORP_ERA_CARD_MANIFEST` and `PRELUDE_CARD_MANIFEST`. That is **277 manifest
entries**:

| Section | base | corpera | prelude | total |
| --- | --- | --- | --- | --- |
| `projectCards` | 137 | 71 | 7 | **215** |
| `corporationCards` | 11 | 2 | 5 | **18** |
| `preludeCards` | — | — | 35 | **35** |
| `standardProjects` | 7 | — | — | **7** |
| `standardActions` | 2 | — | — | **2** |

`GameCards.getCorporationCards()` filters `BEGINNER_CORPORATION` (`GameCards.ts:88`), so **17
corporations are dealable**. No in-scope entry carries `compatibility` or `instantiate: false`; no
in-scope manifest declares `cardsToRemove`.

### The printed-set cross-check has already been run once, and it passes

Every one of the 277 entries carries a `metadata.cardNumber`. Extracted and sorted:

- **001–208, contiguous, no gaps, no duplicates** — exactly the printed base + Corporate Era project
  card set (137 + 71 = 208).
- **P01–P42, contiguous** — the Prelude module's 35 preludes plus 7 project cards.
- **18 R-series** (`R00 R03 R08 R09 R10 R13 R16 R17 R18 R19 R24 R27 R30 R31 R32 R34 R35 R43`) — the
  corporation numbering is **global across all modules and therefore sparse**, so contiguity proves
  nothing here. Corporations must be checked against the printed list by name.
- `SP2 SP3 SP4 SP6 SP7 SP8 SP9` for the seven standard projects, and **`SA2` twice** — both
  `CONVERT_PLANTS` and `CONVERT_HEAT` claim card number `SA2`. Cosmetic, but it means card number is
  not a unique key.

So the *presence* question is already answered with high confidence for project cards and preludes.
Phase M's job on presence is to make this a committed, re-runnable artifact and to close the one
hole (corporations, by name against the printed list) — not to rediscover it.

### Spec-file coverage, counted

Mapping every manifest entry through its `Factory` import to a source file, then looking for a
same-stem `*.spec.ts` anywhere under `tests/`: **274 of 277 have one.** The three that do not:

| Entry | Source | Test situation |
| --- | --- | --- |
| `CITY_STANDARD_PROJECT` | `src/server/cards/base/standardProjects/CityStandardProject.ts` | No spec. Referenced incidentally by `tests/cards/pathfinders/PrefabricationofHumanHabitats.spec.ts` and `tests/cards/corporation/CrediCor.spec.ts` |
| `SELL_PATENTS_STANDARD_PROJECT` | `src/server/cards/base/standardProjects/SellPatentsStandardProject.ts` | No spec. Referenced incidentally by `tests/cards/underworld/LaborTrafficking.spec.ts` and `tests/cards/base/StandardTechnology.spec.ts` |
| `SF_MEMORIAL` | `src/server/cards/prelude/SFMemorial.ts` | **Zero references anywhere under `tests/`** |

Two of the three are standard projects the Agent uses in essentially every game. `SF_MEMORIAL` is
the only in-scope entry with no test contact at all.

### The implementation surface, classified

Of the 277 in-scope source files: **189 are declarative only** (a `behavior` block, no imperative
override), **58 have neither** (metadata / victory-point cards), **27 are imperative only**, and
**3 are both**. The entire imperative surface, counted by override:

| Override | Count | Override | Count |
| --- | --- | --- | --- |
| `bespokePlay` | 34 | `canPayWith` | 4 |
| `bespokeCanPlay` | 17 | `getAvailableSpaces` | 3 |
| `canAct` | 16 | `canPlay` | 2 |
| `action` | 12 | `onStandardProject` | 2 |
| `onCardPlayed` | 11 | `getCardDiscount` | 2 |
| `onTilePlaced` | 7 | `onScienceTagAdded` | 2 |
| `actionEssence` | 7 | `initialAction` | 2 |
| `onNonCardTagAdded` | 5 | `play`, `getVictoryPoints` | 1 each |

Roughly **70 cards carry the whole imperative surface**. A flat review of 277 cards is mostly
reading `behavior: {production: {plants: 1}}` over and over. A ranked review of ~70 is the job.

### Engine issue markers already located in in-scope files

`grep TODO/FIXME` over `base/`, `prelude/` and `corporation/` returns six hits, of which two are
behavioural and four are cosmetic or unrelated:

- `src/server/cards/base/Virus.ts:36` — *"Special case for Mons Insurance owner"* (Mons Insurance is
  out of scope, so this is likely inert here — **verify, don't assume**).
- `src/server/cards/prelude/EccentricSponsor.ts:24` — the prelude cannot detect during `canPlay`
  that it will fizzle. This is a *legality-relevant* comment and is the single most interesting
  marker in the set: it describes a card that can be legally selected and then do nothing.
- Cosmetic / unrelated: `base/Herbivores.ts:42`, `corporation/UnitedNationsMarsInitiative.ts:22`
  (both description spacing), `prelude/ValleyTrust.ts:34` (warning plumbing),
  `corporation/ICorporationCard.ts:14` (a dated removal note).

### What the Agent has never recorded

The AC-1 artifact (`agent/docs/data/ac1_legality_run.json`, 1,500 games) stores per game:
`players, engineSeed, agentSeed, completed, decisions, generation, fallbacksAfterRejection,
fallbacksAfterThrow, responderThrows, submissions, rejectedResponder, rejectedFallbackProbe,
victoryPoints, winners, durationMs`. **There is no card-level data anywhere in it.** Play-coverage
is new instrumentation over the existing runner, not a re-read of the existing artifact. It is
cheap — that run averaged ~96 ms per game — but it is a new run.

---

## The four questions bullet 7 conflates

"Implemented and test-covered" reads like one question. It is four, with four different methods and
four different failure modes. Conflating them is how this audit produces a green checkmark that
means nothing.

1. **Presence.** Does a class and a manifest entry exist for every printed in-scope card? *Method:*
   external enumeration. *Status:* essentially answered above; needs committing.
2. **Reachability.** Of the entries that exist, which can actually appear in a Nadia
   2–4p Tharsis game? *Method:* read the Engine's own runtime filters. *Status:* not done, and the
   answer is **not** 277 (see H3).
3. **Correctness.** Does the implementation match the printed card? *Method:* human reading against
   card text, ranked by imperative surface. *Status:* not done. This is the only question that
   actually tests the ground-truth assumption.
4. **Test coverage.** Does the Engine's suite exercise the card's effect? *Method:* coverage
   measurement — but **not** file-level line coverage (see H4). *Status:* only the crudest proxy
   (spec-file existence) has been measured.

A gap in (1) is a missing card. A gap in (2) is a scoping correction. A gap in (3) is an Engine bug
and a hit on the SRS §2.6 assumption. A gap in (4) is a *risk* of (3), not an instance of it. The
deliverable must keep these separate, because their downstream consequences are completely
different.

---

## Known hazards — hand these to the phase prompts, don't rediscover them

**H1 — the audit is circular if the manifest defines "every in-scope card."** You cannot answer
"is every card implemented?" by asking the implementation what it implements. A card that was never
written has no manifest entry, no class, and no `cardNumber` — it is invisible to every check that
starts from the code. The census needs at least one enumeration that does not originate in
`src/server/cards/`. `cardNumber` is the cheapest such anchor (it encodes the *printed* numbering,
so a missing card shows up as a gap in the sequence) but it is still Engine-authored metadata. Treat
it as a strong internal check and say so; do not present it as external validation.

**H2 — `cardNumber` contiguity works for project cards and preludes, and not for corporations.**
Numbers already verified: 001–208 complete, P01–P42 complete, R-series sparse and global,
`SA2` duplicated. Corporations need a by-name check against the printed list: base + Corporate Era
is **13 corporation cards including Beginner Corporation** (11 in the base manifest, 2 in corpera),
so 12 dealable; Prelude adds 5, giving 18 entries and **17 dealable**. Confirm those names, don't
count them.

**H3 — manifest-in-scope ≠ reachable in a Nadia game, and standard projects are where it bites.**
`Game.getStandardProjects()` (`src/server/Game.ts:1630-1662`) applies runtime filters on top of the
manifest:

- `SELL_PATENTS_STANDARD_PROJECT` — `return false`, *"sell patents is not displayed as a card"*. It
  is real and reachable, just routed through a different decision.
- `BUFFER_GAS_STANDARD_PROJECT` — `this.isSoloMode() && gameOptions.soloTR`. Nadia is 2–4p, so this
  card is **in the manifest and unreachable in every Nadia game**. Its own text says "Solo games
  only."

So the seven manifest standard projects are, in Nadia's configuration, **five reachable as standard
projects** (Aquifer, City, Power Plant, Greenery, Asteroid), **one reachable by another route**
(Sell Patents), and **one out of configuration** (Buffer Gas). Any denominator of 7 is wrong; so is
any denominator of 5. The census must carry the classification, not a count.

**H4 — file-level coverage is *positively misleading* for 247 of 277 in-scope cards.** 189 in-scope
cards are pure `behavior` declarations and 58 have no behaviour at all. Their source files are a
constructor and a metadata literal — almost no executable statements. A line/branch coverage tool
will report ~100% for a declarative card **whose effect has never executed once**, because the
effect lives in `src/server/behavior/Executor.ts`, not in the card file. Running c8 and reporting
"98% of in-scope card files covered" would be the single most plausible-looking wrong answer this
bullet can produce. For declarative cards the signal that works is *was this card instantiated and
played during the suite*, which is instrumentation, not coverage.

**H5 — spec-file existence is a weak proxy and `it()` count is a decoy.** Median `it()` count across
in-scope specs is 2; 95 entries have ≤1. That is not a finding: a single `it()` is entirely
appropriate for a one-line declarative card, and inadequate for a three-branch `bespokeCanPlay`.
Rank by imperative surface (H8 in the previous section's table), never by test count. Do not put an
`it()`-count table in the deliverable; someone will read it as a coverage ranking.

**H6 — three entries have no dedicated spec; one has no test contact at all.** Listed above:
`CITY_STANDARD_PROJECT`, `SELL_PATENTS_STANDARD_PROJECT`, `SF_MEMORIAL`. The first two are used in
almost every game and have incidental coverage through other cards' specs; the third has none.
These are already-found gaps — the phases should confirm and characterise them, and spend their
search budget elsewhere.

**H7 — there is no coverage tooling in the repo, and adding some has a cost.** No `nyc`, `c8` or
`istanbul` in `devDependencies`; no `.nycrc`, no `.mocharc`. Adding one to the root `package.json`
changes the pinned dependency set that SRS CON-5 requires to be fixed, for a one-off measurement.
Run it through `npx` instead and record the exact version and command line in the artifact header.
Budget for `tsx` + source-map + c8 attribution being fiddly: if per-file attribution lands on
transpiled output, say so and fall back to the instrumentation approach in H4 rather than reporting
numbers you don't trust.

**H8 — random play is not uniform play, and a never-played card is not a broken card.** The play
sweep will find cards the random-legal agent never played. Some will be genuinely unreachable; most
will be cards it could not afford or whose requirement it never satisfied. Diagnose each; a bare
list of unplayed names is not a finding. The mirror caveat also applies, and is the same one the
standing AC-1 note makes: **coverage by random play says nothing about the M3/M4/M5/M6 agents**,
which will concentrate play on strong cards and reach code paths random play spread thin. Say this
in the deliverable in the same terms `agent/CLAUDE.md` §6 uses for AC-1.

**H9 — renames and replacements exist and are currently inert.** `CARD_RENAMES`
(`src/common/cards/CardRenames.ts`) maps five alternate spellings to canonical names, and
`cardsToRemove` lets a later module replace an earlier one's card — `PROMO_CARD_MANIFEST` removes
`DEIMOS_DOWN`, `GREAT_DAM` and `MAGNETIC_FIELD_GENERATORS`. Promo is off in Nadia's configuration,
so no replacement is active today. Record the resolution rule the census uses anyway: FR-DATA-1's
required BGA↔engine reconciliation at Milestone 2 will hit renames head-on, and a census that
silently ignored them would be the wrong thing to reuse there.

**H10 — the Engine is immutable, including when it is wrong.** If phase R finds a genuine rules
divergence, the response is `agent/CLAUDE.md` §9: *"add regression games rather than working around
apparent card bugs; report genuine Engine bugs upstream rather than silently patching rules."* Do
not patch `src/`. A confirmed divergence becomes a known-limitation entry, a risk-register row, and
an upstream report — in that order.

---

## Pre-committed criteria — write these down before any number arrives

Bullets 5 and 6 pre-committed their gates before measuring; do the same. Bullet 7 does not gate the
Milestone 1 exit criterion, so most criteria here are **recorded**, not blocking. Two carry an
**escalation** rule instead: they cannot be argued down into a footnote, because the assumption they
test is load-bearing for the whole project.

- **K1 (recorded, escalating) — presence.** Every printed in-scope card, prelude and corporation has
  a manifest entry and an instantiable class, established against an enumeration that does not
  originate in `src/server/cards/`. *Escalation:* a genuinely missing card is not a known limitation
  — it falsifies SRS §2.6 and requires a Plan/SRS amendment and a scope decision (ban the card,
  or accept a divergence from the printed game), taken before Milestone 2 builds baselines on it.
- **K2 (recorded) — reachability.** Every one of the 277 manifest entries is classified
  `reachable` / `reachable-by-other-route` / `unreachable-in-config`, each with the Engine code
  reference that decides it. The census carries the classification, not just a count.
- **K3 (recorded) — Engine test coverage.** Every in-scope entry is placed in exactly one class:
  `direct` (a dedicated spec that instantiates and exercises it), `behavioural` (executed during the
  suite via another spec or an Executor path, evidenced by instrumentation), or `uncovered`.
  **Pre-committed threshold: ≥95% of in-scope entries in `direct` or `behavioural`.** Every
  `uncovered` entry is individually listed with a limitation entry, whatever the percentage.
- **K4 (recorded) — play coverage.** In a sweep of ≥1,000 games at the AC-1 composition, **≥95% of
  entries classified `reachable` are observed played at least once**, and 100% of corporations and
  preludes are observed chosen at least once. Every unobserved entry gets a written diagnosis
  (unaffordable / requirement never met / genuinely unreachable / suspected defect). A bare list
  does not satisfy this criterion.
- **K5 (recorded, escalating) — bespoke review.** Every in-scope card carrying an imperative
  override is read against its printed text. *Escalation:* a divergence that changes which moves are
  legal, or that changes scoring, is an Engine defect — it goes to the risk register with a named
  downstream impact and an upstream report, not into a list of curiosities. A divergence that is
  cosmetic (wording, rendering) is recorded and dismissed in one line.
- **K6 (recorded) — the register.** Every gap from K1–K5 appears in **one** known-limitations
  register with: what, severity, which of the four questions it belongs to, which milestone it first
  bites, and what would have to change to close it. Gaps scattered across separate phase reports do
  not satisfy this.
- **K7 (recorded) — repeatability.** The census, the coverage classification and the play-coverage
  result are committed as data artifacts with environment headers, re-runnable by one documented
  command. If the Engine pin ever moves (`agent/CLAUDE.md` §2 requires re-verification if it does),
  re-running this audit must be a command, not a project.

If K3 or K4 lands below its threshold, that is a **recorded** result with the residue enumerated —
not a stop. If K1 or K5 escalates, stop and say plainly that SRS §2.6 is not sound as written.

---

## Sequencing and relationship to the rest of Milestone 1

Bullet 7 is last, has no dependants inside Milestone 1, and does not gate the exit criterion. There
is no ordering argument to make; it runs now because it is what is left.

Two things it feeds forward, both worth building for deliberately rather than discovering later:

1. **Milestone 2's BGA↔engine reconciliation (FR-DATA-1).** The Plan requires reconciling the Board
   Game Arena card set and rules version against the Engine before any quantitative comparison to
   the expert dataset. A committed, name-keyed census of the in-scope set with rename resolution is
   most of one side of that reconciliation. Build the census so M2 can consume it rather than
   rebuild it — the same way bullet 6's fingerprint corpus was built to feed M2's regression suite.
2. **Milestone 3's card-feature schema.** The Plan gives M3 a card-feature schema. The census —
   name, module, type, tags, cost, imperative surface, reachability — is its skeleton. Do **not**
   design the feature schema here; do emit the census in a shape that can carry extra columns.

**Cost.** Everything here is cheap except the reading. The play sweep is ~1,500 games at ~96 ms ≈
2.5 minutes under `tsx`. The Engine suite is ~6,700 tests, minutes not hours, and slower under
coverage instrumentation. Reading ~70 cards against printed card text is a person's (or a model's)
sustained attention, and it is plausibly 70% of the bullet's total effort. **That asymmetry, not a
template, decides the structure below.**

---

## Structure — four phases, and why this bullet is not shaped like bullets 5 and 6

Bullets 5 and 6 both decomposed as `A → (B, C, D in parallel) → E`, where **A built a harness every
other sub-task called** (`agent/src/bench/harness.ts`, `replay()`) and B, C and D were
comparably-sized independent *investigations* over it. That shape fit those bullets. It does not fit
this one, and copying it would distort the work in three specific ways:

- **There is no shared harness here.** What the measurement work needs in common is the *list of
  in-scope cards*, which is `new GameCards(options)` — about thirty lines, not a primitive worth a
  session boundary. A census-first ordering buys **one agreed denominator**, which is a coordination
  benefit, not a dependency, and does not justify a blocking phase of its own.
- **The work is not three peers plus bookends.** It is one small scripting job, one genuine tooling
  unknown, one large reading queue, and one write-up. Giving the play sweep equal billing with the
  card review would overstate a few hours of mechanical work and understate the bullet's substance.
- **The one place a real fan-out helps is inside the review** — ~70 independent cards — not across
  concerns. Splitting the census from the play sweep instead costs two cold starts, each
  re-deriving how `GameCards` and the legality runner work, which is exactly the waste a routing
  table exists to avoid.

So: **four phases, with the parallelism inside phase R where the volume is.**

```
  M ──┐
      ├──> R (R1 … Rn, parallel batches) ──> W
  I ──┘
```

**M and I are independent and start together. R consumes both. W consumes everything.**

| phase | rough scale | model | why |
| --- | --- | --- | --- |
| **M** — the measurement pass: census, reachability, and the play sweep | ~500 lines src, ~200 lines spec, one ~3-minute run | **Sonnet** | One coherent scripting job against one set of Engine objects. The hard parts (which manifests, which filters, which numbers) are already measured in this document; it must be exact, not clever. Splitting it would make a second session re-derive the first session's context |
| **I** — the coverage instrument: decide it, build it, measure K3 | ~250 lines + real tooling wrangling | **Opus** | H4 is a trap a fast pass walks straight into — c8 will report ~100% on declarative cards and look right. **Choosing the instrument correctly is the whole job**, and it may fail and need the fallback. Separate from M precisely because its size is unknown until someone tries it |
| **R** — the review: implementations against printed card text, in ranked batches | ~70 cards read; ~40–60 lines of findings per batch of ~12 | **Opus** per batch | The only phase that tests the ground-truth assumption, and the one where a fast pass says "looks right" without reading the card text and no test catches the wrong answer. Fan out over batches **only after §1's ranking pass**, which consumes M's and I's output — an unranked fan-out reads 277 cards shallowly instead of 70 properly |
| **W** — adjudication, the limitations register, document updates | ~450 lines of markdown | **Opus** | Judgment over others' output, and it is the only writer of the SRS/Plan/CLAUDE.md. It adjudicates K1–K7 and decides what escalates |

**Haiku is not appropriate for any of these.** An audit that reports full coverage because it
measured the wrong thing looks exactly like an audit that passed.

**On sizing R's fan-out.** Batch count follows the ranking, not a target concurrency: batch 1 is the
`bespokeCanPlay`/`canPlay` cards (legality-deciding, highest consequence) and should be read before
the rest fan out, because what it finds changes what the other batches look for. Six batches of ~12
is a reasonable default for the remainder. If the budget only covers two batches, read the top two —
a real read of 24 cards beats a skim of 70, and W records exactly what went unread.

---

## File ownership, so parallel work never edits the same file

| phase | owns |
| --- | --- |
| M | `agent/src/coverage/{types,census,reachability,playSweep}.ts`, `agent/src/runner/coverageCli.ts`, `agent/test/coverage/census.spec.ts`, `agent/docs/data/card_census.json`, `agent/docs/data/card_play_coverage.json`, an `npm run coverage` script in `agent/package.json` |
| I | `agent/src/coverage/engineTestCoverage.ts`, `agent/test/coverage/engineTestCoverage.spec.ts`, `agent/docs/data/card_test_coverage.json` |
| R | `agent/docs/data/card_bespoke_review.json` — **one file, appended by batch**: each batch writes only its own `CardName` keys and never rewrites another batch's. If batches run concurrently, give each batch its own `card_bespoke_review.<batch>.json` and let W merge; a shared file with concurrent writers is a lost-findings bug, not a merge conflict you will notice |
| W | `agent/docs/Card_Coverage_Audit.md`, `agent/docs/Running_Notes.md`, `agent/docs/Terraforming_Mars_AI_SRS_v1.2.md`, `agent/docs/Terraforming_Mars_AI_Implementation_Plan_v1.2.md`, `agent/CLAUDE.md` |

**Nobody edits anything under `src/`** — not to add a test, not to fix a typo, not to patch a card.
**Nobody edits** `embeddedDriver.ts`, `snapshot.ts`, `stableState.ts`, `gameFactory.ts`, `rng.ts`,
`legalityCli.ts`, or anything under `agent/src/legality/`; phase M composes with the legality runner
from the outside, as bullet 6 composed with the driver. If you become convinced an existing file
must change, stop and say so in your summary rather than changing it.

---

## Shared preamble (prepend to every phase prompt below)

> You are working on the **Nadia** Terraforming Mars agent, in the `agent/` module of a
> terraforming-mars fork. Read `agent/CLAUDE.md` (especially §2 on the Engine pin, §5 on the Engine
> interfaces, §6 for current status, and §9's standing conventions) and the root `CLAUDE.md` —
> particularly its *Card System* section, which describes the five things every card comprises.
> Then read, in full:
> - `agent/docs/Milestone1_Bullet7_Prompts.md` — this document, especially *"What is already
>   known"*, *"The four questions bullet 7 conflates"*, *"Known hazards"* (H1–H10) and
>   *"Pre-committed criteria"* (K1–K7). Every number in the first section was measured at the pin;
>   start from it rather than re-deriving it, and correct it if you find it wrong.
> - `src/server/GameCards.ts` and `src/server/cards/CardFactorySpec.ts` in full — short, and they
>   define what "in scope" means mechanically.
> - `agent/src/engine/gameFactory.ts` — 53 lines, and it is the only place Nadia's game
>   configuration is decided.
>
> **The one hard rule:** the Engine is **immutable ground truth** (SRS CON-1). This bullet audits
> that claim; it does not repair it. If you find a genuine Engine defect, **record it** — do not
> patch `src/`, and do not add a test under `tests/`. Per `agent/CLAUDE.md` §9, genuine Engine bugs
> are reported upstream, not silently patched.
>
> **A green result is the suspicious one.** This bullet's failure mode is an audit that measures
> something trivially true — a census that enumerates the manifest and declares the manifest
> complete, a coverage number that counts constructor lines on declarative cards, a play sweep that
> counts cards *dealt* rather than *played*. For every check you write, include at least one
> **negative control**: a deliberately removed card, an unexecuted branch, a card excluded from
> play, that the check must flag. A check that has never failed has not been shown to work.
>
> **Keep the four questions separate.** Presence, reachability, correctness and test coverage have
> different methods and different consequences. Do not let them collapse into a single
> per-card boolean; the deliverable's usefulness depends entirely on which of the four a given gap
> belongs to.

---

## Phase M — the measurement pass: census, reachability, play sweep

One session, one set of Engine objects, three outputs: **what is in scope** (K1), **what "in scope"
means for each entry** (K2), and **what the Agent has actually played** (K4). These are one job
because they all key off the same instantiated card set; splitting them would make a second cold
session re-derive `GameCards`, the manifest structure and the legality runner from scratch.

Do them in the order below — the census is not a blocking dependency for the sweep, but having the
denominator settled before you reconcile against it saves rework.

### 1. Types (`agent/src/coverage/types.ts`)

```
CardScope = 'reachable' | 'reachable-by-other-route' | 'unreachable-in-config'

CensusEntry = {
  name: CardName,
  module: 'base' | 'corpera' | 'prelude',
  section: 'projectCards' | 'corporationCards' | 'preludeCards' | 'standardProjects' | 'standardActions',
  cardNumber: string,          // metadata.cardNumber — the printed number
  type: CardType,
  tags: Array<Tag>,
  cost?: number,
  sourceFile: string,          // repo-relative
  scope: CardScope,
  scopeReason: string,         // the Engine code reference that decides it, e.g. 'Game.ts:1640 solo+soloTR only'
  imperativeOverrides: Array<string>,   // e.g. ['bespokeCanPlay', 'canAct']
  declarative: boolean,        // has a `behavior` block
}

Census = {header: CensusHeader, entries: Array<CensusEntry>}
```

`CensusHeader` records **Engine commit, agent commit, Node version, the exact `GameOptions` used,
and the generation timestamp** — the same discipline as the determinism corpus header. A census
without its game options is not interpretable.

### 2. Building it (`census.ts`)

Instantiate through the Engine, not by parsing source. `new GameCards(options)` with Nadia's exact
options gives you the live card objects; `ALL_MODULE_MANIFESTS` (`src/server/cards/AllManifests.ts`)
gives you the module attribution that `GameCards` throws away. Read `cardNumber`, `type`, `tags`,
`cost` off the instantiated card, not off the file.

Two things must come from source inspection because they are not on the object:
`imperativeOverrides` and `sourceFile`. Derive the source file from the manifest's import statements
(the `Factory` symbol resolves to exactly one import path) — do not guess it from the card name;
several class names differ from their card names, and `standardProjects` and `corporation` live in
subdirectories.

**Presence check (K1).** Emit, alongside the census: the sorted `cardNumber` sequence with gaps and
duplicates called out, and a by-name comparison of the 18 corporations against a **literal list of
the printed base + Corporate Era + Prelude corporation names written into the spec file as data**.
That literal list is the one piece of non-Engine-derived truth in the whole audit (H1) — write it by
hand from the printed cards, comment it as such, and never generate it. The expected result is
already known (001–208 complete, P01–P42 complete, 17 dealable corporations + Beginner); a check
that reproduces it is doing its job, and a check that *cannot fail* is not.

### 3. Reachability (`reachability.ts`) — K2

For each entry, classify and cite. The known cases:

- `SELL_PATENTS_STANDARD_PROJECT` → `reachable-by-other-route`, `Game.ts:1637`.
- `BUFFER_GAS_STANDARD_PROJECT` → `unreachable-in-config`, `Game.ts:1640` (solo + `soloTR`).
- Everything else in `standardProjects` → `reachable`.
- `BEGINNER_CORPORATION` → `unreachable-in-config`, `GameCards.ts:88`.

Do not stop at the known cases. Read `Game.getStandardProjects()` in full, check whether any
in-scope *project card* or *prelude* is gated by anything beyond `compatibility` (none carries
`compatibility`, but a card can gate itself in `canPlay`), and check whether `GameCards`'
`filterBannedCards` / `filterReplacedCards` can fire under Nadia's options (they should not — no
`bannedCards`, no in-scope `cardsToRemove` — confirm both, and record the rename-resolution rule per
H9). A card whose `canPlay` can never be satisfied on Tharsis at 2–4p is a genuine finding; a card
that is merely *hard* to play is not — that distinction belongs to the play sweep's diagnosis (§5),
not here.

### 4. The play sweep (`playSweep.ts`) — K4

The Engine's tests say what the Engine's authors exercised. This says what *Nadia* exercised end to
end, through the enumerator, the driver and the Engine together. It is the coverage number that is
actually about this project, and nobody has it (H10).

Compose with the existing legality runner from the outside; do not modify `agent/src/legality/`.
Run the AC-1 composition (1,000 × 2p plus 250 each at 3p/4p, or a documented equivalent ≥1,000
games) with an observer that records, per game:

- every project card **played** (not drawn, not held — played),
- every corporation **chosen**,
- every prelude **played**,
- every standard project and standard action **used**.

"Played" is the definitional load-bearing word here, exactly as "an illegal move is a move submitted
and rejected" was for AC-1. Write the definition down before you measure: a card is played when the
Engine accepts the play and the card enters the player's played cards. A card that was drawn,
bought, discarded, or offered and declined is **not** played, and a run that counts those will
report ~100% coverage and mean nothing.

The instrumentation technique: wrap the responder (as bullet 6's move trace did) to observe
`projectCard` / `card` / `initialCards` responses, **or** read each finished game's final state
(`player.playedCards`, `player.corporations`) — the second is simpler, cheaper and less likely to
miscount, but it misses cards played and later removed from play. Use the state read as the primary
count and note the limitation; if any in-scope card can leave played cards once played, say which.

Also record **frequency**, not just a boolean. "Played 4 times in 1,500 games" and "played 3,000
times" are very different confidence levels for the same green tick, and the tail is what phase R
should read first.

### 5. Reconcile the sweep against the census

Join on `CardName`. Report:

- coverage of `reachable` entries, against the pre-committed ≥95% (K4);
- 100% expected for corporations and preludes — every one of the 17 corporations and 35 preludes
  should appear many times over 1,500 games; **any that does not is a defect signal, not a tail**;
- every `unreachable-in-config` entry that was nevertheless played — that would mean §3's
  reachability classification is wrong, which is a finding about your own census, not about the
  card. Fix it and say you did;
- the frequency distribution, with the bottom decile named.

Do not diagnose the unplayed tail yourself beyond the obvious mechanical causes (cost above anything
the agent accumulated; a requirement no observed game satisfied). Hand the list, with per-card
frequency and the games that came closest, to R and W. And do not present play coverage as a
correctness result — a card played 3,000 times without a crash is evidence the *interface* works,
not that the *rules* are right. That distinction is the whole point of keeping the four questions
separate.

Emit `agent/docs/data/card_play_coverage.json`, keyed by `CardName`, joinable to the census.

### 6. CLI and spec

`agent/src/runner/coverageCli.ts` with `--census`, `--sweep`, `--out`, `--verify <census.json>` and
`--list`, wired to `npm run coverage` in `agent/package.json`. `--verify` re-runs the census and
diffs against the committed artifact — the durable payoff, and the thing that makes K7 true if the
pin moves.

`agent/test/coverage/census.spec.ts` covers the census builder, not the game. Negative controls:
a card removed from a synthetic manifest is reported missing; a duplicate `cardNumber` is reported
(there is a real one — `SA2` — so assert the known duplicate explicitly rather than asserting
"no duplicates" and having the suite fail on a real, benign fact); a card whose source file cannot
be resolved from its `Factory` import is an error, not a silent omission; and a card excluded from
play in a short synthetic sweep is reported unplayed.

---

## Phase I — what the Engine's test suite actually exercises (K3)

Runs independently of M, and starts at the same time. The point of this phase is to produce a number
that means something. Read H4 before writing any code; the obvious approach produces a confident
wrong answer.

### 1. Decide the instrument first, and justify it in writing

Two candidate instruments, and the choice is the substance of this phase:

- **File-level coverage** (`npx c8 --reporter=json npm run test:server`, then attribute per card
  file). Correct for the ~70 imperative cards. **Meaningless-to-misleading for the 247 declarative
  and metadata-only cards** — their files have almost no executable statements, so they report near
  100% whether or not their effect ever ran.
- **Instantiate-and-execute instrumentation.** Wrap card construction and/or the `Behavior`
  executor so the suite records, per `CardName`, whether the card was instantiated and whether its
  behaviour or its imperative override actually ran. This is the only instrument that separates
  `direct` from `behavioural` from `uncovered` for a declarative card.

The likely right answer is **both**, with file coverage reported *only* for cards carrying
imperative overrides and instrumentation reported for everything. State the choice and the reason in
the artifact; do not silently pick one.

Constraint from H7: **do not add a coverage dependency to the root `package.json`.** Use `npx`,
pin the version explicitly on the command line, and record the exact invocation and version in the
artifact header. If `tsx` source-map attribution puts coverage on transpiled output rather than the
card files, say so and drop file coverage rather than reporting numbers you cannot defend.

For the instrumentation path: the technique is the one bullets 5 and 6 both used — **wrap from the
outside**. `newCard`/`createCard` (`src/server/createCard.ts`) and the `BehaviorExecutor`
(`src/server/behavior/Executor.ts`) are the two chokepoints. Wrap them from a mocha root hook or a
required setup module under `agent/`, never by editing `src/`.

### 2. Classify, then emit

Every in-scope entry lands in exactly one of `direct` / `behavioural` / `uncovered`, per K3:

- `direct` — a spec whose stem matches the card's source file, **and** the card was instantiated
  during that spec. Do not accept name matching alone; a spec that imports a card and never uses it
  is not coverage.
- `behavioural` — no dedicated spec, but the card was instantiated and its behaviour or override
  executed at some point in the suite. `CITY_STANDARD_PROJECT` and `SELL_PATENTS_STANDARD_PROJECT`
  are the expected members (H6) — confirm.
- `uncovered` — never instantiated, or instantiated but never executed. `SF_MEMORIAL` is the
  expected member. If it is the only one, say so plainly: it is a much better result than the
  spec-file count implies, and the audit should report the better number when the better number is
  the true one.

Emit `agent/docs/data/card_test_coverage.json` keyed by `CardName`, joinable to the census.

Report the K3 percentage against the pre-committed ≥95%, and **list every `uncovered` entry
regardless of the percentage.**

### 3. Negative control

Pick a card with a dedicated spec, exclude that spec from the run, and confirm the card moves out of
`direct`. Without this the classification is decorative: an instrument that reports everything as
covered is indistinguishable from a suite that covers everything.

## Phase R — reading the implementations against the printed cards (K5)

This is the only phase that touches question 3, correctness, and therefore the only one that
actually audits SRS §2.6. Everything else measures proxies. It is also the bulk of the bullet, and
the only place a fan-out earns its keep.

**Ranking happens once; reading fans out.** Do §1 as a single pass over M's and I's output — a
ranked, batched queue committed to the review artifact — then hand each batch to its own session
with §2–§4 and its own card list. A fan-out that starts before the ranking exists reads 277 cards
shallowly instead of 70 properly, which is the failure this phase is structured to avoid.

### 1. Rank before reading (once, before any batch starts)

You have ~70 cards' worth of imperative surface and a finite budget. Rank by, in order:

1. **Imperative surface** — `bespokeCanPlay` and `canPlay` first (they decide *legality*, which is
   what CON-2 and AC-1 rest on), then `bespokePlay`, then `canAct`/`action`, then the event hooks
   (`onCardPlayed`, `onTilePlaced`, `onNonCardTagAdded`, `onScienceTagAdded`, `onStandardProject`),
   then `canPayWith`/`getCardDiscount`/`getAvailableSpaces`, then `getVictoryPoints`.
2. **Coverage class from I** — an `uncovered` or `behavioural` card with an imperative override is
   the highest-risk cell in the whole matrix.
3. **Play frequency from M** — a rarely-played card with a bespoke override has had the least
   incidental validation from 1,500 games.
4. **The located markers** — `Virus.ts:36` and `EccentricSponsor.ts:24` (see *What is already
   known*). Start with these two; they are pre-located and one of them is legality-relevant.

Read the top of that ranking properly. Do not skim 277 cards; a shallow pass over everything is
worth less than a real read of forty.

**Then batch it.** Batch 1 is every `bespokeCanPlay`/`canPlay` card — read it *before* the remaining
batches fan out, because a legality divergence found there changes what the other batches look for
(and, per K5, escalates immediately). Split the remainder into batches of ~12 by descending rank.
Commit the batched queue to the review artifact before any batch session starts, so what was read
and what was not is a fact on disk rather than a recollection.

### 2. What "read against the printed card" means (per batch)

For each card in your batch, compare three things and record the comparison:

- the **printed card text** (the card's own `metadata.renderData` description is the Engine's claim
  about the text — useful, but it is the *same source* as the implementation, so a card whose
  renderer and behaviour are consistently wrong reads as correct; anchor on the printed card where
  the two could plausibly diverge);
- the **implementation** — `behavior` block plus every override;
- the **requirement/cost/tag metadata**, which is where transcription errors hide and where nothing
  else in this audit is looking.

Record for each: `matches` / `cosmetic-divergence` / `behavioural-divergence` / `undecided`, with a
one-line justification and, for anything other than `matches`, the exact lines.

`undecided` is a legitimate and important verdict — a card whose correct behaviour depends on a rules
interpretation you cannot settle from the printed text belongs in the register as an open question,
not silently in `matches`. The `EccentricSponsor` fizzle case is likely to land here.

### 3. Escalation, per K5

A `behavioural-divergence` that changes which moves are legal, or that changes scoring, is an Engine
defect. Per H10 and `agent/CLAUDE.md` §9: record it, hand it to W for the risk register with a named
downstream impact, and recommend an upstream report. **Do not patch `src/`. Do not add a test under
`tests/`.** Write the reproduction as prose so W can decide where it lives.

If batch 1 finds a legality divergence, say so at once rather than at the end of the batch — it
changes the brief for every batch still to run.

### 4. Emit

`agent/docs/data/card_bespoke_review.json`, keyed by `CardName`, joinable to the census: the
verdict, the ranking inputs that put it in the shortlist, and the justification. **Write only your
own batch's keys** (or your own `card_bespoke_review.<batch>.json` if batches run concurrently — see
the ownership table). Cards not reviewed must appear with verdict `not-reviewed` and their ranking
score, so the deliverable states exactly how much of the set was read — an audit that does not say
what it did not look at is not an audit.

---

## Phase W — analysis, the limitations register, and the document updates

Consumes M, I and every R batch. Judgment, not code.

### 1. Adjudicate K1–K7

Each as met / not met / met-with-residue, with the evidence and the sample size. Where a threshold
was missed, say so with the number; do not round a 92% up into "substantially complete". Where a
criterion escalated (K1 or K5), say plainly that SRS §2.6's ground-truth assumption is not sound as
written, and specify the amendment.

### 2. Build the one register (K6)

A single table, in the deliverable, with a row per gap:

| Gap | Question (presence / reachability / correctness / test coverage) | Severity | First bites at | What would close it |

Severity should be argued, not asserted. `SF_MEMORIAL` having no Engine test is a real gap and
almost certainly a low-severity one — it is a simple prelude, and if M's sweep shows it was played
hundreds of times across 1,500 games without incident, that is meaningful independent evidence. Say
that. The
register's value is that a reader can tell a genuine hazard from a bookkeeping note; a register that
grades everything "medium" has no value.

For each row, name **which milestone it first bites**. A missing Engine test for a card the Agent
plays constantly bites at M3 (evaluation weights fit against a wrong effect). A reachability
misclassification bites at M2 (a wrong denominator in the expert-comparison report). A legality
divergence bites immediately and retroactively — it would mean the AC-1 result measured a different
game than the one the printed rules describe.

### 3. Deliverables

- **`agent/docs/Card_Coverage_Audit.md`** — the bullet's deliverable, mirroring
  `Simulator_Speed_Spike.md`, `Determinism_Verification.md` and `AC1_Legality_Run.md`: what was
  audited, at what scale, the K1–K7 adjudication, the four-question breakdown, the limitations
  register, and how to re-run everything (`npm run coverage -- --verify …`).
- **Committed artifacts** — `card_census.json`, `card_test_coverage.json`, `card_play_coverage.json`,
  `card_bespoke_review.json`, all under `agent/docs/data/` with environment headers, all joinable on
  `CardName`. If phase R ran as concurrent batches with per-batch files, merge them here into the one
  `card_bespoke_review.json` and check that every in-scope card appears exactly once — a card missing
  from the merge is a lost finding, and it will look identical to a card nobody ranked. Note in the
  doc that the census is intended to feed **M2's FR-DATA-1 BGA reconciliation** and to be the
  skeleton of **M3's card-feature schema**, so neither milestone rebuilds it.
- **Running Notes entry** (dated, appended) — the findings that will otherwise be rediscovered.
  Highest-value candidates: whatever phase I learned about measuring coverage on declarative cards
  (that trap will be walked into again at M3), and any card whose behaviour surprised phase R.
- **Plan §7.2 risk register** — add rows for what was actually found. NFR-5's discipline applies by
  analogy: for each row, name the **isolation mechanism**, not just the risk. "Card X is untested"
  is not a risk-register row; "Card X is untested and the M3 evaluator will fit a weight to its
  effect, isolated by adding it to the M2 regression seed set" is.
- **Plan Milestone 1 bullet 7** — mark done with a one-line result and a pointer to the doc, in the
  same style as bullets 5 and 6.
- **SRS §2.6** — annotate the ground-truth assumption with the audit's result and pointer, the same
  way CON-5 was annotated after bullet 6. This is the requirement the bullet exists to service; if
  it does not end up annotated, the audit did not land.
- **`agent/CLAUDE.md` §6** — update current status. Bullet 7 is the last Milestone-1 item, so this
  edit also **closes Milestone 1**: say so, and set the "next up" line to Milestone 2.

### 4. One thing to resist

Do not let this become "all 277 cards implemented and tested ✅". Three reasons that headline would
be false even if every number lands green:

- **Test coverage is not correctness.** A card can be covered by a test that asserts the same wrong
  behaviour the implementation has. Only phase R's reading speaks to correctness, and it will
  have read a shortlist, not all 277.
- **Play coverage is not correctness either.** 1,500 games without a crash proves the interface
  works; it does not prove the rules are right. A card that quietly grants one plant too many
  produces no error anywhere in this audit.
- **The denominator is contested.** 277 manifest entries, 208 printed project cards, ~275 reachable
  in Nadia's configuration, ~70 carrying real logic. Any single percentage hides which denominator
  it used.

The honest headline is a scope statement: *what was audited, by which of the four methods, at what
depth, and what was not looked at.* Bullet 5's write-up is the model — it reported the numbers that
overturned four documented assumptions, not just the pass.

---

## Appendix — a scope question for the milestones and awards (raise before starting)

Bullet 7 says "card and corporation". Milestones and awards are neither, so they are outside its
literal wording. They are squarely inside its purpose: they are Engine-implemented scoring rules
covered by the same SRS §2.6 assumption, and the prior-art study the SRS cites (§1.5) found
**milestones and awards to be among the dominant win drivers**, alongside Terraform Rating.

The Tharsis set is ten items — milestones `Terraformer, Mayor, Gardener, Builder, Planner`
(`src/server/milestones/Milestones.ts:149`) and awards `Landlord, Scientist, Banker, Thermalist,
Miner` (`src/server/awards/Awards.ts:122`). Their test situation, measured at the pin:

| | Dedicated spec | Any test reference |
| --- | --- | --- |
| Terraformer | no | **none** |
| Mayor | no | 2 files |
| Gardener | no | **none** |
| Builder | `tests/milestones/Builder.spec.ts` | 1 file |
| Planner | no | **none** |
| Landlord | `tests/awards/Landlord.spec.ts` | 1 file |
| Scientist | no | 1 file |
| Banker | no | 2 files |
| Thermalist | no | 1 file |
| Miner | no | **none** |

**Two of ten have a dedicated spec; four have no test contact at all.** That is a materially worse
coverage picture than the 274-of-277 the card set shows, on ten items that matter more per item than
any single project card, and which M3's evaluation function will need to reason about explicitly.

**Recommendation: fold these ten into the audit** as a small appendix to phases M, I and R —
roughly a day's marginal work on top of a bullet that is already reading Engine scoring code. If the
scope is to stay strictly on the bullet's wording, then record the table above as a known limitation
with "M3 evaluation" named as where it first bites, so the finding is not lost.
