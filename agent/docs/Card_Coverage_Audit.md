# Card-coverage audit (Milestone 1, bullet 7)

**Status: DONE (27 Jul 2026). The ground-truth assumption is substantially validated but *not*
unconditionally true.** All four pre-committed measurement criteria met their thresholds (K1–K4),
the entire logic-bearing card surface was read against the printed cards (K5), and the audit is
re-runnable (K7). It also did the thing an audit is for: it found **eight cards whose Engine
behaviour diverges from the printed card**, five of them scoring- or legality-relevant, plus two
Engine test-coverage gaps and one Engine-test that never exercises its card's effect. None of these
falsify the *usability* of the Engine as ground truth — the Agent plays the Engine's game correctly
by construction (CON-1) — but they mean SRS §2.6's "correctly implements the rules" is now a claim
with a **catalogued list of exceptions**, not a blanket guarantee. This document is the deliverable;
the four JSON artifacts under `agent/docs/data/` are the evidence.

This bullet does **not** gate the Milestone 1 exit criterion (which was already met, 24 Jul 2026).
It audits an assumption. The honest one-line headline is a scope statement, not a checkmark:

> Every printed in-scope card, prelude and corporation is present and reachable; 99%+ is exercised
> by both the Engine's own tests and 1,500 games of real play; every one of the 73 cards carrying
> imperative logic was read against its printed text; eight of those 73 diverge from the print, and
> the 204 purely-declarative cards were **not** individually read against the print — their
> correctness rests on the Engine suite plus play coverage, not on a line-by-line reading.

---

## 1. What was audited, and the four questions

"Implemented and test-covered" is four questions with four methods and four consequences (the plan's
framing, retained because it is what keeps this audit honest):

| # | Question | Method | Criterion | Result |
| --- | --- | --- | --- | --- |
| 1 | **Presence** — does every printed in-scope card exist? | External enumeration vs a hand-written printed-name list | K1 | **Met.** 277 entries, card numbers 001–208 + P01–P42 contiguous, 18 corporations match by name |
| 2 | **Reachability** — which can appear in a Nadia 2–4p Tharsis game? | Read the Engine's runtime filters | K2 | **Met.** 274 reachable, 2 unreachable-in-config, 1 reachable-by-other-route |
| 3 | **Correctness** — does the implementation match the printed card? | Human reading, ranked by imperative surface | K5 | **Met with residue.** All 73 logic-bearing cards read; 56 match, 8 diverge, 9 undecided |
| 4 | **Test coverage** — does a test exercise the effect? | Instantiate-and-execute instrumentation over the Engine suite + a 1,500-game play sweep | K3, K4 | **Met.** Engine tests 275/277; play sweep 273/274 reachable |

The scope is fixed by `agent/src/engine/gameFactory.ts`: base + Corporate Era + Prelude, Tharsis,
2–4 players. Every artifact header records the exact `GameOptions` and the Engine pin
(`868714d72a434ab68fe08e5570ebc6863859ae15`); all four agree on the pin.

The denominator is deliberately reported four ways, because a single percentage hides which one it
used: **277** manifest entries; **208** printed base+CorpEra project cards (+ 42 P-numbered prelude
module cards + corporations + standard projects/actions); **274** reachable in Nadia's config;
**73** carrying any imperative logic. Every figure below names its denominator.

---

## 2. K1–K7 adjudication

### K1 (presence) — MET

277 manifest entries instantiated through `new GameCards(options)`. The presence check runs against
a **hand-written list of printed corporation names** (`agent/src/coverage/census.ts`), the one piece
of non-Engine-derived truth in the audit: `expectedNames` and `foundNames` are identical, `missing`
and `unexpected` both empty. Card numbers: 001–208 contiguous with no gaps and no duplicates, P01–P42
contiguous, corporations sparse-and-global as expected (checked by name, not number). The one known
benign duplicate (`SA2` on both Convert Plants and Convert Heat) is asserted explicitly by the spec
rather than tripping a "no duplicates" check. **No card is missing. K1 did not escalate.**

### K2 (reachability) — MET

Classification with an Engine code citation per entry (`agent/src/coverage/reachability.ts`):

| Scope | Count | Entries |
| --- | --- | --- |
| `reachable` | 274 | everything not listed below |
| `unreachable-in-config` | 2 | **Beginner Corporation** (`GameCards.ts:88`, filtered unconditionally); **Buffer Gas** (`Game.ts:1640`, solo + `soloTR` only) |
| `reachable-by-other-route` | 1 | **Sell Patents** (`Game.ts:1637`, hidden as a standard project, offered through a different decision) |

`filterBannedCards`/`filterReplacedCards` confirmed inert under Nadia's options (no banned cards, no
in-scope `cardsToRemove`). Matches the plan's predictions exactly.

### K3 (Engine test coverage) — MET (275/277 = 99.28%, threshold ≥95%)

Measured by **instantiate-and-execute instrumentation**, not file-level line coverage — the plan's
H4 trap is real: a declarative card's file is a constructor and a metadata literal, so c8 would
report ~100% for a card whose effect never ran. The instrument wraps card construction and the
behaviour executor and records, per `CardName`, whether the card was instantiated and whether its
effect or override actually executed during `npm run test:server` (`agent/src/coverage/engineTestCoverage.ts`).

- **273 `direct`** — a matching spec that instantiates and executes the card.
- **2 `behavioural`** — executed via another path, no dedicated spec: **Sell Patents** (25×) and
  **SF Memorial** (2×). *SF Memorial is a better result than the plan predicted* — the plan flagged
  it as the one entry with zero test references, and it turns out to be exercised incidentally.
- **2 `uncovered`** — instantiated but the effect never ran: **City** (the standard project) and
  **Hackers**.

**The Hackers finding is new and worth its own line.** Hackers *has* a dedicated spec
(`tests/cards/base/Hackers.spec.ts`), but that spec only calls `canPlay()` — it never calls `play()`,
so the card's actual effect (`bespokePlay`: steal 2 M€ production via `DecreaseAnyProduction`) is
untested at the unit level. This is a concrete instance of the abstract H5 warning that a spec's
existence is not coverage of its effect. The effect is not un-exercised in practice — the play sweep
shows Hackers *was* played — but the Engine's own suite does not assert on it.

### K4 (Agent play coverage) — MET (273/274 reachable = 99.6%, threshold ≥95%)

1,500 games at the AC-1 composition (1,000×2p + 250×3p + 250×4p), all completed. A card counts as
**played** only when the Engine accepts the play and it enters `playedCards` — drawn/held/declined
does not count (`agent/src/coverage/playSweep.ts`). Every one of the **17 dealable corporations** and
**35 preludes** was chosen many times over. The reachable cards not played:

- **Anti-Gravity Technology** (the one reachable project card at 0 plays) — requires **7 science
  tags**. Random-legal play essentially never builds a 7-science engine, so 0/1,500 is the expected
  H8 result (requirement never satisfied), **not** a defect. A directed agent (M3+) will reach it.

The other two zero-play reachable-set entries are not genuine gaps: **Buffer Gas** and **Beginner
Corporation** are `unreachable-in-config` (correctly excluded from the 274 denominator), and **Sell
Patents** reads 0 only because the sweep instrument is structurally blind to it — see the register
row X6 below. No `unreachable-in-config` card was unexpectedly played, so K2's classification held
under 1,500 games of stress.

### K5 (bespoke review) — MET, with residue — the whole logic-bearing surface read

All **73 imperative-surface cards** (every card carrying `bespokePlay`, `bespokeCanPlay`, `canAct`,
`action`, an event hook, a payment/discount hook, or `getVictoryPoints`) were read against their
printed text, ranked so the legality-deciding cards were read first
(`agent/docs/data/card_bespoke_review.json`). Verdicts, **after phase-W cross-batch adjudication**:

| Verdict | Count | |
| --- | --- | --- |
| `matches` | 56 | implementation faithful to the printed card |
| `behavioural-divergence` | 8 | differs from the print in a way that changes legality, scoring, or the legal move set |
| `undecided` | 9 | correctness depends on a rules interpretation not settleable from the printed text |
| `not-reviewed` | 204 | purely declarative / metadata cards, no imperative logic — **see the honest-limitation note in §4** |

**5 of the 8 divergences escalate** (change legality or scoring): Immigrant City, Energy Tapping,
Power Supply Consortium, Decomposers, Ecological Zone. Detailed in §3.

### K6 (one register) — see §5.

### K7 (repeatability) — MET

Every artifact carries an environment header (Engine commit, agent commit, Node version,
`GameOptions`). The census and play sweep rebuild via `npm run coverage` (`--census`, `--sweep`,
`--verify <census.json>`); the Engine-coverage instrument re-runs over `npm run test:server`; the
census `--verify` path (`verifyCensus`, `agent/src/coverage/census.ts`) is what produced the
committed artifact. `agent/CLAUDE.md` §2 requires this audit to be re-run if the pin moves, and §3.X9
below names the one behaviour most likely to change if it does. *(Note: `--verify` could not be
executed in the phase-W worktree because its `node_modules` lacks `prom-client`, a transitive Engine
dependency; the mechanism is implemented and was used to generate the artifacts.)*

---

## 3. The divergences (K5 detail)

The reframing that governs all of these: **because the Agent treats the Engine as ground truth
(CON-1), an Engine-vs-print divergence does not make the Agent play illegally or mis-score inside its
own world.** It matters in exactly two ways — (a) it partially falsifies SRS §2.6's "correctly
implements the rules", and (b) it creates a reconciliation gap against external references (the BGA
expert dataset at M2, FR-DATA-1), which may use the printed reading. Each divergence is an **upstream
report**, per `agent/CLAUDE.md` §9 — not a `src/` patch.

### Escalating (change legality or scoring)

**Immigrant City** *(legality)* — `bespokeCanPlay` permits play at M€ production ≥ −4 (or **any** M€
production with Tharsis Republic), because `bespokePlay` defers the −1 energy / −2 M€ production
losses until *after* the city tile is placed (`.andThen`), so the +1 M€ production trigger resolves
first. The printed card pays the production cost on play, before its own city-placement trigger can
refund any, making it unplayable at M€ production −4/−5. Deliberate and asserted in the Engine's spec
(`ImmigrantCity.spec.ts`: "Can play at −4 M€ production", "Tharsis can play at −5"). Verified in
source. More permissive than the print. **First bites: M2** (a legal-move-set difference vs a
printed-rules reference).

**Energy Tapping + Power Supply Consortium** *(value; one finding, two cards)* — the two cards'
`bespokePlay` is **byte-for-byte identical** (verified with `diff`). When no player has energy
production, both defer the +1-gain *first*, which makes the acting player the only legal target for
the subsequent "decrease any energy production", forcing them to hand the gain straight back — a
net-zero no-op (−1 VP, 3 M€) where the printed card gives +1 energy production. The Engine's own
comment says so: *"This Player must gain their energy production in order to lose it."* When somebody
does have energy production, both match the print exactly. Power Supply Consortium's zero-target
branch is reachable (its printed requirement is 2 *power tags*, not energy production), and Energy
Tapping landing in its own zero-target branch is one way to reach it, so on a generation-1 line the
two compound. **First bites: M3** (the evaluator learns the true in-Engine value — correct for this
project — which diverges from the printed value a human would expect). One register row, one upstream
report. *(Great Escarpment Consortium and Asteroid Mining Consortium carry the same code but their
steel/titanium-production requirements make the branch unreachable — verified.)*

**Decomposers + Ecological Zone** *(scoring; one mechanism, two cards — phase-W adjudicated)* — when
either card is played *via Ecology Experts* during the prelude phase, the Engine retroactively
credits Ecology Experts' own already-played tags to the card: Ecological Zone silently gains a **3rd
animal** (`EcologicalZone.ts:66-76`), Decomposers gains **+2 microbes** (`Decomposers.ts:48-53`). An
ongoing "when you play a tag, including this" effect should only see plays that happen while it is in
play; Ecology Experts' tags were placed before either card entered the tableau, so the strict reading
grants no retroactive credit. The three review batches disagreed (undecided / escalating / matches on
the three cards). **Phase W resolves the mechanism as a genuine divergence**, on the evidence that
settles the tie: **Viral Enhancers** responds to plant *and* microbe tags, Ecology Experts carries
both, yet Viral Enhancers has no such retroactive-credit code — so the Engine applies the reading to
two cards and not a third. That internal inconsistency is not a coherent "simultaneous play"
interpretation; it is a defect. Ecological Zone and Decomposers therefore share one verdict
(behavioural-divergence, escalating — scoring-relevant at 1 VP per 2 animals / 1 VP per 3 microbes);
Viral Enhancers is correct (`matches`) and is the card that reveals the inconsistency. Whether the
upstream fix is "remove the credit from the two" or "add it to Viral Enhancers" is the maintainers'
call. **First bites: M3** (mis-scored resources on a narrow but reachable prelude line). Severity is
low — the trigger requires Ecology Experts plus the specific card in hand.

### Non-escalating divergences

**Virus** — the plant-removal branch mishandles its option list: `bespokePlay` does
`options.slice(0, -1)` assuming the last entry is the skip option, but `RemoveAnyPlants` pushes skip
*then* appends the acting player's own-plants option, so when the Virus player holds plants their own
option is discarded and the skip is duplicated. Both resulting options are dominated/benign, so no
printed outcome changes materially. Upstream report; non-escalating.

**Hired Raiders + Sabotage** *("up to N" granularity, X4)* — both print "up to N" and both offer only
`{maximum, none}`, where the print grants any amount 0..N. A universal Engine convention for the
whole attack class, and the omitted amounts are dominated — with one non-contrived exception at 3–4p,
where the **Miner award** counts steel + titanium, so removing more from one opponent can hand the
award to another. **First bites: AC-5** (3–4p placement). One class-level report; non-escalating.
(Flooding, which prints "remove 4 M€" with no "up to" and removes exactly 4, is the contrast that
shows the distinction is real — it verdicts `matches`.)

### Undecided (9) — the honest "cannot settle from printed text" bucket

The two that carry weight, both systemic:

**X5 — maxed-parameter no-op actions** (Aquifer, Asteroid standard project, Convert Heat, Aquifer
Pumping, Water Import From Europa). When a global parameter is already maxed, `canAct` returns
`true`-with-a-warning, so paying for a 10th ocean or heat at +8 °C is an enabled, server-validated
legal move with no effect. Deliberate and internally consistent (the Engine is scrupulous about *not*
granting TR on the maxed step). Impact confined to random-legal baselines burning resources; no
evaluating agent picks a dominated move, so **M3+ is unaffected**. One register row.

**X3 — prelude-fizzle 15 M€** (systemic; touches Ecology Experts, Eccentric Sponsor, Valley Trust,
and four paid preludes). When a prelude cannot be played the Engine discards it and grants 15 M€, and
no batch could find a printed basis for the 15. It is also the mechanism behind an Engine
inconsistency: Ecology Experts is refused at the selection gate by its own `canPlay`, whereas
Eccentric Sponsor (the pre-located `EccentricSponsor.ts:24` marker) is genuinely played and fizzles
from inside `bespokePlay`. For Eccentric Sponsor the two paths converge (no other on-play effect, no
tags, no VP), so there is **no legality difference for Nadia and no exploit** — verified. Reachable
(Ecoline at 36 M€ buying 10 initial cards leaves 6). One systemic register entry, not seven card
entries; upstream question.

The other 7 undecided (Ecology Experts, Hackers, Eccentric Sponsor, Vitor, and the four X5 cards
above) are individually low-consequence; see the artifact for per-card justifications. **Vitor** is
worth flagging: it hard-codes `startingMegaCredits: 48` ("45 + 3 when this corp is played") while its
own description and renderer say 45 — a silent 3 M€ discrepancy on 1 of 17 dealable corporations,
`undecided` on its own merits and tied to the X9 pin-fragility note.

---

## 4. What this audit did *not* establish

Three limits, stated plainly so no later milestone mistakes this for "all 277 cards verified correct":

1. **The 204 purely-declarative cards were not read against the printed cards.** Phase R read the 73
   logic-bearing cards — the entire imperative surface, 100% of it. The remaining 204 are pure
   `behavior` blocks and metadata-only cards; a transcription error in one (a production value of 2
   where the card prints 1) would **not** be caught by K5. It is bounded indirectly: such a card is
   instantiated-and-executed in the Engine suite (K3) and played in the sweep (K4), so a *crashing*
   or *structurally invalid* error would surface — but a silently-wrong resource amount would not. A
   line-by-line read of the declarative tail is the natural extension and was out of scope for a
   bullet whose budget was spent on the logic-bearing cards.
2. **Test coverage is not correctness, and play coverage is not correctness.** A card can be covered
   by a test that asserts the same wrong behaviour it implements; 1,500 crash-free games prove the
   *interface* works, not that the *rules* are right. Only K5's reading speaks to correctness, and it
   read 73 of 277.
3. **Milestones and awards were not audited.** The plan's appendix flagged the 10 Tharsis
   milestones/awards as in-purpose-but-out-of-wording, with materially worse Engine test coverage (2
   of 10 have a dedicated spec, 4 have no test contact) on items the prior-art study found to be
   dominant win drivers. This audit stayed on the bullet's literal wording ("card and corporation").
   **Recorded as a known limitation** (register row below), M3 named as where it first bites.

---

## 5. Known-limitations register (K6)

One row per gap. Severity is argued, not defaulted. "First bites" names the milestone that first
depends on the gap being closed. Every correctness row is an **upstream report**, never a `src/`
patch (CON-1, `agent/CLAUDE.md` §9).

| # | Gap | Question | Severity | First bites | What would close it |
| --- | --- | --- | --- | --- | --- |
| 1 | **Immigrant City** permits play at M€ prod −4/−5 (defers losses past the city trigger) | correctness (legality) | Low | M2 | Upstream report; record as a known Engine interpretation for the FR-DATA-1 reconciliation |
| 2 | **Energy Tapping + Power Supply Consortium** become net-zero no-ops when no player has energy production (identical code) | correctness (value) | Low | M3 | One upstream report; M3 fits the evaluator to Engine value (correct here) and flags the print gap |
| 3 | **Decomposers + Ecological Zone** over-grant resources when played via Ecology Experts; Engine internally inconsistent (Viral Enhancers does not) | correctness (scoring) | Low | M3 | One upstream report to resolve the inconsistency; add the prelude line to the M2 regression seeds |
| 4 | **Virus** plant-removal branch offers the wrong option set when the caster holds plants | correctness | Negligible | — | Upstream report; both options are dominated |
| 5 | **Hired Raiders + Sabotage** offer `{max, 0}` for "up to N", not `{0..N}` | correctness | Low | AC-5 | Upstream report; the only non-dominated case is the 3–4p Miner-award edge |
| 6 | **Maxed-parameter actions** (5 cards) are legal no-op moves | correctness (undecided) | Negligible | — | None required; no evaluating agent picks a dominated move |
| 7 | **Prelude-fizzle grants 15 M€** with no printed basis (systemic) | correctness (undecided) | Low | M2 | Upstream question; verified no Nadia exploit |
| 8 | **Vitor** starts 48 M€ vs printed/rendered 45 | correctness (undecided) | Low | M2 | Upstream question; re-check on any pin move (X9) |
| 9 | **Hackers** dedicated spec tests `canPlay` only, never the `bespokePlay` effect | test coverage | Low | M3 | Add effect assertion upstream; card is in the M2 regression seed set regardless |
| 10 | **City** (standard project) effect never executes in the Engine suite | test coverage | Low | M3 | Upstream test; exercised in play but not asserted |
| 11 | **SF Memorial** has no dedicated Engine spec | test coverage | Negligible | — | Optional upstream test; behaviourally executed (2×) and played hundreds of times in the sweep without incident |
| 12 | **Anti-Gravity Technology** unplayed in 1,500 random games (requires 7 science tags) | play coverage | Negligible | — | Nothing; a directed M3+ agent reaches it. Not a defect |
| 13 | **Sell Patents** is invisible to the play sweep (routed via `getActions`, not `payAndExecute`) | reachability / instrument | Low (method) | — | Note the instrument blind spot; do not discharge K2's `reachable-by-other-route` row via play coverage |
| 14 | **204 declarative cards not read against printed text** | correctness (audit depth) | Medium (scope) | anywhere a wrong `behavior` value hides | A line-by-line read of the declarative tail; today bounded only indirectly by K3+K4 |
| 15 | **Milestones and awards not audited** (10 Tharsis items; 2/10 have a dedicated spec) | test coverage / correctness | Medium | M3 | Fold the 10 into a follow-up pass; M3's evaluator must reason about them explicitly |

Two findings are recorded to Running Notes rather than the register, because they are Agent-side notes
or re-verification triggers, not Engine gaps: **X7** (a mid-play snapshot can transiently hold a
negative resource count through an unclamped setter that also bypasses the Engine's illegal-state
logging — a note for `snapshot.ts` and M4 search) and **X9** (the "including this" idiom depends on a
`playCard` ordering the Engine authors document as wrong; an upstream fix would change every such card
at once — the named thing to re-check if the pin moves).

---

## 6. How to re-run

```bash
# Census (K1/K2) + play sweep (K4), one denominator, ~3 min under tsx:
cd agent && npm run coverage -- --census --sweep \
  --out docs/data/card_census.json --sweep-out docs/data/card_play_coverage.json

# Verify a committed census still matches the Engine at the current pin (K7):
npm run coverage -- --verify docs/data/card_census.json

# Engine test-coverage instrument (K3) runs over the Engine suite:
#   see agent/src/coverage/engineTestCoverage.ts (wraps npm run test:server)
```

The census is built to feed **M2's FR-DATA-1 BGA↔engine reconciliation** and to be the skeleton of
**M3's card-feature schema** (name, module, type, tags, cost, imperative surface, reachability) — so
neither milestone rebuilds it. The play-coverage artifact feeds M2's regression-seed selection: the
low-frequency tail of reachable cards, and the divergent cards in §3, are the seeds worth pinning.

---

## 7. Bottom line

The rules-ground-truth assumption that makes CON-1 safe is **substantially validated**: nothing is
missing, nothing in scope is unreachable-by-accident, the whole logic-bearing surface was read, and
99%+ is exercised two independent ways. It is **not unconditionally true**: there are eight
enumerated Engine-vs-print divergences (five scoring/legality-relevant), a declarative tail that was
not read line-by-line, and milestones/awards that were not audited at all. The correct posture going
forward is the one this document takes — treat the Engine as ground truth *with a catalogued list of
known exceptions*, carry those exceptions into the M2 reconciliation and the M3 evaluator rather than
assuming them away, and re-run the audit if the pin moves.
