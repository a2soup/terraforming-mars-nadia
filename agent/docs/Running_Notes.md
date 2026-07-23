# Nadia — Running Notes

Informal, dated engineering log for work on the Nadia agent. Not a source of truth — the SRS and
Implementation Plan are ([Terraforming_Mars_AI_SRS_v1.2.md](Terraforming_Mars_AI_SRS_v1.2.md),
[Terraforming_Mars_AI_Implementation_Plan_v1.2.md](Terraforming_Mars_AI_Implementation_Plan_v1.2.md))
— this is where findings, decisions, and gotchas get recorded as they happen so they aren't
rediscovered later.

## 2026-07-21 — Headless game-factory runner (Milestone 1, bullet 1b)

Built `agent/src/engine/gameFactory.ts::createGame()` — creates a headless base + Corporate Era +
Prelude game for 2-4 players with seed control, via `Game.newInstance()`. See
`agent/src/runner/createGameCli.ts` for a CLI wrapper (`npm run create-game -- --players N --seed N`
from `agent/`).

Two engine-integration issues surfaced only by actually running this outside the test harness, not
from reading the code:

- `Game.save()` is called unconditionally during initial setup and goes through
  `GameLoader.getInstance()` → `Database.getInstance()`. Outside a running server (or the test
  harness's `tests/testing/setup.ts`, which fakes both), this crashes with "attempt to get db
  before initialize". `agent/src/engine/headlessEngine.ts` installs a no-op `Database` before any
  game is created, mirroring the test suite's own pattern — this is exactly what an embedded/headless
  driver needs anyway (no persistence during self-play).
- `globalInitialize()` (which registers the card behavior executor) throws if called twice in the
  same process. This bit us when `createGame()` was exercised inside the mocha test harness, which
  already calls it via `--require tests/testing/setup.ts`. `ensureHeadlessEngine()` is idempotent
  and tolerates "already registered" so the same `createGame()` call works standalone (CLI) and
  inside a host process that already initialized the engine.

**Determinism finding** (relevant to the Milestone 1 "verify Engine determinism" bullet, SRS
CON-5/NFR-5): two `createGame()` calls with the same seed produce **byte-identical** serialized
state for everything RNG-driven — board layout, all deck orders (project/corporation/prelude/CEO),
dealt cards, milestone/award selection. Confirmed by diffing full `game.serialize()` output between
two same-seed runs.

The *only* fields that differ between same-seed runs are wall-clock-derived, not RNG-driven, and
live entirely outside `Game`'s `SeededRandom`:
- `name` (the game's display name — generated via `UnseededRandom`, i.e. `Math.random()`, not the
  seeded RNG at all)
- `createdTimeMs` (`new Date()` at creation)
- `gameLog[].timestamp` (per log entry)
- each player's `timer.startedAt` / `timer.lastStoppedAt`

None of these affect game *rules* state — they're bookkeeping/display fields. For any determinism
check (including a future large-scale Milestone 1 determinism verification, or match-harness replay
comparison), strip these four before comparing serialized state; see the `stableState()` helper in
`agent/test/engine/gameFactory.spec.ts` for the exact fields to exclude.

Seed contract: `createGame({seed})` takes a non-negative integer and passes it straight through as
`Game.newInstance`'s `seed` param, which the Engine multiplies internally
(`Math.floor(seed * 4294967296)`) to seed its PRNG. No normalization needed on our side — any
distinct integer seed reliably produces a distinct, reproducible game.

## 2026-07-21/22 — Embedded driver for decision points (Milestone 1, bullet 2)

Built `agent/src/driver/{decisionPoint,responder,embeddedDriver,stubResponder}.ts` — the transport
layer (CLAUDE.md §4 Layer 2) that surfaces each pending Engine decision as a `PlayerInputModel` and
applies the Agent's `InputResponse` back into the game. See `agent/test/driver/embeddedDriver.spec.ts`.

**The drive contract**, confirmed against the real Engine (not just by reading it):

- After `Game.newInstance()`, decision points exist immediately — the initial research phase sets
  `waitingFor` on **every** player at once (`gotoInitialResearchPhase`, `Game.ts`), so the driver must
  scan all players, not just `activePlayer`. We resolve simultaneous pending inputs one at a time in
  `game.playersInGenerationOrder`, for reproducibility.
- The proven drive step is exactly the pattern the Engine's own test suite uses (`tests/Game.spec.ts`):
  `player.process(input)` then `game.deferredActions.runAll(() => {})` before re-checking for the next
  pending input. This is fully synchronous in practice — driving a real game through several
  generations of decisions (see below) never needed an awaited tick between steps.
- `player.process()` throwing (illegal input) leaves `waitingFor` untouched on the player (verified by
  inspection of `Player.ts`, not yet exercised end-to-end — that needs a responder capable of
  constructing genuinely illegal input, which is Prompt 2/bullet 3 territory).
- Game-over is `game.phase === Phase.END`. Not yet empirically driven to (see scope note below); the
  check is implemented and unit-tested against a fake `IGame`, but real end-of-game timing (whether
  reaching `Phase.END` ever needs an async tail) is an open finding, deliberately deferred.

**Scope finding that reshaped this bullet's test plan.** The original plan was to prove the driver by
running a full 2p game start-to-finish with a trivial stub responder. That turned out to require far
more than "trivial": Prelude cards are **mandatory** to play (no pass option, unlike the main action-phase
`OrOptions`, which always includes one), and playing a prelude can trigger arbitrary card-specific
sub-decisions (space placement, payment, resource choice, ...) depending on which preludes were dealt.
Constructing legal responses for that generically is exactly the legal-action enumerator's job (SRS
FR-ACT-4, Milestone 1's *next* bullet), not this one's. Building it here would have either duplicated
that work early or produced a fragile, seed-dependent stub disguised as driver-plumbing code.

Rescoped accordingly: `stubResponder.ts` is intentionally content-agnostic — it understands only the
structural shape of `'initialCards'` and `'card'` decisions (always selects the first `min` offered
options) and throws `UnsupportedDecisionError` on anything else. Driven against `createGame({players:
2, seed: 1})`, this reaches through both players' simultaneous initial setup, into `Phase.PRELUDES`, and
**three more real decisions deep** (two `'card'` picks, then a `'space'` pick for an ocean tile from a
prelude effect) before hitting something it can't answer — real multi-step, mixed
simultaneous-then-sequential progression, which is what actually exercises the loop's mechanics. Full
end-to-end completion to `Phase.END` (and the async-tail / game-over-detection question above) is left
for Prompt 2, once a capable responder exists to actually finish games — which is also literally AC-1's
job, so there's no value in faking it twice.

**Type-level enforcement of the embedded/live-play boundary** (CON-1/NFR-7, requested explicitly):
`DecisionPoint` (model + player + game) is the cross-mode contract; `EmbeddedDecisionPoint` adds `raw`
(the live Engine `PlayerInput`) and is embedded-only. `Responder` takes a `DecisionPoint`;
`EmbeddedResponder` takes an `EmbeddedDecisionPoint`. An `EmbeddedResponder` is not assignable where a
portable `Responder` is expected — reaching for `raw` mechanically excludes strategy code from
live-play, rather than relying on a comment to enforce it.

**Hardening pass (Prompt 2):** `embeddedDriver.ts` now also guards two failure modes and extracts the
final result:

- **Undo guard.** Real Undo (`src/server/routes/PlayerInput.ts`'s `performUndo`) restores a prior save
  via `GameLoader`/`Database`; embedded play runs on the no-op `Database` (`headlessEngine.ts`), so
  there's no save history to restore. `applyDecision` detects an `'or'` response selecting an
  `UndoActionOption` (same check as the HTTP route's `isWaitingForUndo`) and throws
  `UndoNotSupportedError` *before* calling `player.process()`, rather than letting a responder trigger
  undefined behavior. Verified with a hand-built `OrOptions`/`UndoActionOption` (undo is normally gated
  behind `gameOptions.undoOption` and `actionsTakenThisRound > 0`, which isn't worth driving a real game
  into just for this check).
- **Illegal-move wrapping.** `player.process()` throwing is now caught and rewrapped as
  `IllegalMoveError` (carrying the decision point, the attempted input, and the original cause).
  Confirmed end-to-end with a real Engine rejection (an `'initialCards'` response with the wrong number
  of sub-responses, per `SelectInitialCards.process()`): the player's `waitingFor` is still there,
  unchanged, afterward — matches the `Player.process()` reading from Prompt 1 (it restores `waitingFor`
  before rethrowing), now exercised rather than just inferred from the source.
- **`GameResult` extraction** (`gameResult.ts`): `computeResult(game)` reads final per-player VP
  (`player.getVictoryPoints().total`), the generation the game ended in, and `winners` (every player
  tied for max VP — not the game's full tiebreak rules; real tiebreaking is Milestone 2's job).
  `runGame` now returns this once `Phase.END` is reached. Tested in isolation against a duck-typed fake
  `IGame`/`IPlayer` (same pattern as the `StuckGameError` test), since driving a *real* game all the way
  to `Phase.END` still isn't possible without the legal-action enumerator — no change to the scope note
  above; this doesn't require completion; it only requires being handed a game already in `Phase.END`.
- **Determinism**, re-verified through the driver (not just `createGame` alone, as in the first Running
  Notes entry): two same-seed games driven by the same `stubResponder` to the same
  `UnsupportedDecisionError` stopping point produce byte-identical `stableState()` output. This confirms
  the driver loop itself adds no nondeterminism (no `Date.now()`, no unseeded iteration order, etc.) —
  `playersInGenerationOrder.find()` is a stable array scan, not a source of drift. The `stableState()`
  helper moved to `agent/test/testUtils/stableState.ts`, shared with `gameFactory.spec.ts`, so the two
  determinism checks can't silently drift apart on which fields are "wall-clock, not RNG-driven."

Full end-to-end completion to `Phase.END` via the driver remains blocked on the legal-action enumerator
(Milestone 1's next bullet) — see the scope note above. Once that responder exists, it's worth adding a
true full-game determinism/completion test exercising `computeResult` against a real finished game
rather than a fake one.

## 2026-07-22 — DEFERRED: payment reduction returns a single canonical move (revisit in M3)

**Deliberate M1 simplification, flagged for M3 — do not lose this.** The legal-action enumerator
(Milestone 1, bullet 3) reduces every `payment` / `projectCard`-with-payment decision to a **single**
canonical cheapest-legal payment (spend the fewest / cheapest resources that still satisfy the engine's
`canSpend ∧ payingAmount ≥ amount` predicate, MC last). This satisfies FR-ACT-3's "never overpay" for
M1's random-legal agent, which only needs *one* legal payment per decision, and keeps FR-ACT-4
enumeration finite.

**Why this is not good enough for strong play, and must be revisited (M3, heuristic evaluation).** The
cheapest-legal payment is frequently *not* the strategically correct one. The reduction needs to expose
a small set of strategically-meaningful payment variants (e.g. "spend all steel" vs. "hold back one
steel" vs. "pay MC") for the evaluator to choose among, not collapse to one. Concrete cases the single
canonical move gets wrong:

- **Holding back a resource for a conversion action.** Electro Catapult can be *paid for* with steel,
  but its own action converts 1 steel → 7 M€. Once it's in play it is usually correct to pay for a card
  with all steel *except one*, keeping that steel for the far more valuable conversion. A pure
  cheapest-legal allocator will happily spend the last steel and destroy that value.
- **Placement bonuses interacting with payment timing.** Steel and titanium gained from tile-placement
  bonuses change what's optimal to spend *now* vs. *keep*: the value of holding a unit of steel/titanium
  depends on what the player expects to place and play next generation, not just this card's cost. This
  requires look-ahead / evaluation the M1 reduction deliberately does not have.

The same factored payment representation is also the **structured/hierarchical action head** for a
learned policy (SRS FR-ACT-4, Implementation Plan Milestone 6), so getting the variant set right pays
off twice. Action item for M3: replace "single canonical payment" with "canonical payment + a bounded
set of strategic deviations," scored by the evaluator.

## 2026-07-22 — GOTCHA: `SeededRandom(integerSeed)` is degenerate — all integer seeds share one stream

Found while building the Agent's RNG (`agent/src/core/rng.ts`, Milestone 1 bullet 3). The Engine's
`SeededRandom` (src/common/utils/Random.ts) is a mulberry32 whose one-arg constructor sets
`currentSeed = Math.floor(seed * 2**32)`. For **any integer seed** that value is a multiple of 2^32,
which is `0` in the low 32 bits the generator's `Math.imul`/`>>>` core actually uses — so
`new SeededRandom(1)`, `new SeededRandom(42)`, `new SeededRandom(99)` all emit the **identical**
stream. Empirically confirmed: the first three draws are byte-identical across those seeds. The
constructor's implicit contract is that `seed` is a **fraction in [0, 1)** (hence the `* 2**32`);
integer seeds violate it silently.

**Agent fix (done):** `createAgentRandom(seed)` seeds the state directly, `new SeededRandom(seed, seed)`,
bypassing the `* 2**32`. The `rng.spec.ts` "different seeds → different streams" test guards it.

**Latent Engine-harness bug this exposed (NOW FIXED).**
`agent/src/engine/gameFactory.ts::createGame({seed})` took an **integer** seed and passed it straight
to `Game.newInstance(..., seed)`, which does `new SeededRandom(seed)`. By the above, **every integer
seed produced the same board, the same deck orders, and the same dealt cards.** Confirmed directly:
serialized RNG-driven content (board, dealer/decks, dealt corp/project/prelude cards) was identical for
seeds 42, 43, and 99. This undermined the Milestone-1 premise that the random-legal agent plays
*varied* games across seeds — only the Agent's own move RNG would have varied; every game would have
started from one fixed shuffle.

Why the existing `gameFactory.spec.ts` "is reproducible under a fixed seed, and differs across seeds"
test passed anyway (i.e. why this wasn't caught): `stableState()` (agent/test/testUtils/stableState.ts)
stripped wall-clock fields but **not** `id`, and `createGame` builds `gameId = g-nadia-${seed}`. So the
"differs across seeds" assertion passed on the differing id *string* alone, not on any RNG-driven
content — a false positive.

**The fix (applied):**
- `createGame` now passes `resolved.seed / 2**32` to `Game.newInstance` instead of the raw integer.
  Division by 2**32 is exact (power of two), so the Engine's `Math.floor(seed * 2**32)` recovers a PRNG
  state of exactly `resolved.seed` — a distinct, well-mixed stream per seed. `SEED_SCALE` constant +
  comment at the change site. The gameId still shows the human-readable integer seed.
- `stableState` now also strips `id`, so cross-seed comparison exercises RNG-driven content rather than
  the seed-derived id string. Re-verified: seeds 42/43/99 now produce **different** board+deck content,
  and same-seed runs remain byte-identical. Full agent suite green (35 passing).

## 2026-07-22 — Reds policy (Turmoil) is out of scope — graceful-fallback only, no special handling

Noted during planning of the payment reduction: the Reds ruling policy adds a terraform-rating **tax**
to the affordability math (`Player.canAffordInternal` computes a `redsCost` via `TurmoilHandler`). Reds
is part of **Turmoil**, which is out of scope for v1 (base + Corporate Era + Prelude only; CLAUDE.md §1).
It therefore should never be active in an in-scope game, so the enumerator does **no** extra work to
model the Reds tax in its payment reduction. If a Reds-taxed decision somehow arises, it is handled by
the generic out-of-scope path: graceful legal fallback + a loud log (per the FR-9 safety net), same as
any other out-of-scope decision type — not a silent workaround, so it surfaces as a coverage finding.

## 2026-07-22 — Random-legal agent finished + Tier-1 batch: two real driver bugs, both fixed (Milestone 1, bullet 3 / sub-task E)

Finished `agent/src/core/randomLegalAgent.ts` (per-decision logging, FR-11/NFR-6, off by default;
loud logging + unmodified propagation of `OutOfScopeDecisionError`), retired `stubResponder`
(deleted; `agent/test/driver/embeddedDriver.spec.ts` now drives real decisions with
`randomLegalAgent` instead), and — the actual substance of this entry — drove real games all the
way to `Phase.END` for the first time (`agent/test/core/randomLegalAgent.integration.spec.ts`,
new). That last step is what surfaced two genuine bugs neither of which was visible from reading
the code or from any test shallower than a full game; both are now fixed in `embeddedDriver.ts`
(driver-layer, not the Engine, and not the B/C/D enumerator files, which remain untouched per this
sub-task's own constraint).

**Bug 1 (found first, more fundamental): the driver's own unconditional
`deferredActions.runAll()` double-drains the queue and silently loses a decision.** The existing
drive step (Prompt 2, confirmed by testing back then) was `player.process(input)` then
unconditionally `game.deferredActions.runAll(() => {})`. That pattern turns out to be *unsafe*:
`Player.process()`'s own callback chain (`waitingForCb`, wired up via `Player.takeAction()` /
`Player.runWhenEmpty()` — see `src/server/Player.ts`) already drains `game.deferredActions` itself
whenever the decision it just resolved routes back into that machinery, which is most of them (the
main action-phase loop, prelude selection, …). When it does, `player.getWaitingFor()` is already
set to the *next* real decision by the time `process()` returns — and `DeferredActionsQueue.run()`
does **not** check whether its target player already has a pending `waitingFor` before running an
action for them (verified by reading `src/server/deferredActions/DeferredActionsQueue.ts`), so the
driver's own *second*, redundant `runAll()` call can pop and execute an unrelated action still
queued for the same player (e.g. a second prelude's own tile placement, queued moments earlier but
not yet reached by the internal chain) — silently overwriting the fresh decision the internal chain
just set (`Player.setWaitingFor`'s own "Overwriting waitingFor X with Y" warning — that log line,
previously assumed to only matter for a hypothetical Philares/Final-Greenery edge case, was the
actual smoking gun here) and permanently losing whatever continuation the overwritten decision was
guarding. Confirmed by monkey-patching `DeferredActionsQueue.prototype.run` to log every popped
action: two `PlaceOceanTile` deferred actions for the same player, both queued from processing one
`'card'` prelude-selection decision, both got `run()` within the *same* `applyDecision` call — the
internal chain correctly paused on the first (setting `waitingFor` to `'space'`), then the driver's
own redundant `runAll()` popped and ran the second, overwriting it. Left uncaught this manifests
several decisions later as `StuckGameError` (`Game g-nadia-N has no player with a pending input, but
phase is 'preludes'/'action', not 'end'`) — a genuine hang, not something the FR-9 fallback (which
only fires on a rejected/thrown decision, not a lost continuation) could ever have caught.

**The fix:** only call the driver's own `runAll()` when the player has **no** pending input after
`process()` returns (`applyDecision`, `embeddedDriver.ts`) — i.e. only when the decision just
resolved did *not* route through the Engine's own self-draining machinery (e.g. the simultaneous
`initialCards` setup at game start, whose completion callback doesn't set `waitingFor` on the
just-processed player at all, and something still needs to kick off the first real decision).
Verified directly: with the guard, the same seed that previously hung at decision 6 (3-player,
seed 107) instead drives cleanly for 15+ decisions before hitting the *other* bug below (item 2),
and the whole Tier-1 batch (20 games) completes with zero hangs.

**Bug 2 (the crux prompt anticipated one form of this; the batch found a second, related form):
the `'projectCard'` decision-model type is genuinely ambiguous between two different Engine input
classes.** `SelectProjectCardToPlay` (play a card from hand) and `SelectStandardProjectToPlay`
(play a standard project — Power Plant, Asteroid, Aquifer, Greenery, City, …) both report `type:
'projectCard'` in their model (`SelectCardToPlay`, their shared base class,
`src/server/inputs/SelectCardToPlay.ts`) and expose the identical `cards`/`enabled` shape, but use
*different* cost/eligibility logic (`card.canAct(player)` / `card.getAdjustedCost(player)` /
`card.canPayWith(player)` for standard projects, vs. `player.affordOptionsForCard(card)` /
`player.canAfford(...)` / `player.paymentOptionsForCard(card)` for hand cards). Sub-task C's
`enumerateProjectCard` (`agent/src/core/enumerator/payment.ts`, deliberately left untouched by
this sub-task) does an unchecked `raw as SelectProjectCardToPlay` cast and was built/tested only
against real `SelectProjectCardToPlay` decisions — fed a `SelectStandardProjectToPlay` instead, it
fails two different ways depending on state, both actually observed in the Tier-1 batch:
- **No candidate at all**: if every standard project happens to be currently unaffordable, its
  `canAfford` filter finds nothing and it throws (`enumerateProjectCard: no enabled, affordable
  card among N offered`) — the responder never produces a move.
- **A candidate that "looks" affordable but isn't, once payment is computed correctly**: if one
  project happens to pass the (wrong) `canAfford` check, `enumerateProjectCard` still computes its
  payment using the project-*card* payment-options model, which `SelectStandardProjectToPlay`'s
  own `validate()` override then rejects at submission (`InputError: Did not spend enough to pay
  for standard project`) — a *rejected* `player.process()` call, not a thrown enumerator.

Both are the same root cause (the model-type overlap), but they surface at different points in the
pipeline (before vs. after a response is produced), and — this is the part worth recording — a
fallback that only retries *within* the broken `SelectStandardProjectToPlay` branch cannot recover
from either: it's the branch itself that's broken, regardless of which standard project or payment
is tried. **The general FR-9 fallback (`embeddedDriver.ts`) had to be widened accordingly**, beyond
what the sub-task E prompt's single anticipated coupling (the `initialCards` project-card budget
check) called for:
- `applyDecision` now catches a thrown *or* a rejected response from the responder alike (the
  `try` wraps both `responder(decisionPoint)` and `player.process(input)`), excluding
  `OutOfScopeDecisionError`/`NotYetImplementedDecisionError`, which are dispatch-level and would
  fail identically on retry.
- The fallback itself (`buildConservativeResponse` + `resubmitConservatively`) had to become
  submit-and-verify, not just construct-and-hope: for an `'or'` decision it now tries every
  eligible (non-`Undo`) branch **in order**, actually calling `player.process()` for each one, and
  stops at the first that's *accepted* — not just the first that *constructs* without throwing.
  This is what lets it route around a `SelectStandardProjectToPlay` branch regardless of which of
  the two failure shapes above it hits: every real action-phase `OrOptions` includes a "pass"
  branch, which is always both constructible and accepted, so the retry always terminates
  successfully once it reaches that branch (`or`/`and`/`initialCards`' own children, elsewhere in
  the tree, still get the simpler "first eligible" / recurse-into-every-child treatment via
  `buildConservativeResponse` — a bounded gap: no in-scope `and`/`initialCards` composite nests an
  `'or'` today, so this hasn't needed to go further).
- `UnrecoverableIllegalMoveError` (both attempts genuinely failed) is thrown only if *every*
  eligible branch of the top-level `'or'` fails, or if a non-`'or'` decision's single conservative
  attempt itself gets rejected — neither observed in the Tier-1 batch.

**Deliberately not fixed here:** `enumerateProjectCard` itself, in `payment.ts`, still only
handles `SelectProjectCardToPlay` correctly — sub-task C's file is out of this sub-task's scope
("keep the B/C/D enumerators untouched"), and the driver-level fallback above fully absorbs the
fallout for Milestone 1's purposes (zero crashes, fallbacks logged and counted). Properly fixing
this — routing on `raw instanceof SelectStandardProjectToPlay` vs `SelectProjectCardToPlay` and
using the standard-project cost/payment model for the former — is real follow-up work,
flagged separately.

**Fallback frequency observed** (Tier-1 batch, 20 games, seeds 9001–9207, 2p/3p/4p): 203 total
fallbacks, roughly 10 per game (range 1–27), across both couplings combined (the batch doesn't
distinguish which coupling fired per event, only that the driver recovered) — clearly non-trivial
at random-legal skill, not a rare edge case. This is expected to fall sharply once M3's heuristic
stops the agent from blindly maximizing project-card counts / wandering into unaffordable branches,
but for now it's a real, measured cost of "legal-but-not-smart" play worth keeping an eye on if the
fallback rate ever climbs enough to distort self-play statistics.

**The async-tail / game-over-timing question (open since Prompt 2) is resolved: no, nothing async
is needed.** The entire drive — `runGame` looping `applyDecision` — is synchronous throughout, for
every one of the 20 Tier-1 games and the two dedicated determinism games (all driven to a genuine
`Phase.END`). `computeResult(game)` was called immediately after `runGame` returned in every case,
with no intervening tick, `setTimeout`, promise resolution, or event-loop yield of any kind, and it
read correct, complete final state every time (VP totals, winners, generation). Nothing in the
Engine's own `takeAction`/`runWhenEmpty`/`deferredActions` chain, nor in game-end detection
(`playerIsDoneWithGame` → `Phase.END`), turned out to require an awaited step. Milestone 1's open
question from the embedded-driver sub-task is closed: the driver contract is (and can remain)
fully synchronous.

**Determinism, verified with the real agent+driver combined for the first time on completed
games** (not just up to an `UnsupportedDecisionError` stopping point, as in Prompt 2): same engine
seed + same agent seed ⇒ byte-identical `GameResult` and `stableState()` output, confirmed across
two independently-constructed same-seed games driven fully to `Phase.END`. The two seeds are
independent of each other in both directions (varying only the agent seed changes the game;
varying only the engine seed changes the game; see `randomLegalAgent.integration.spec.ts`).

## 2026-07-22 — Standard-project `projectCard` gap fixed (bullet-3 completion)

Fixes the follow-up flagged in the sub-task E entry above. `enumerateProjectCard` (`payment.ts`) now
routes on the concrete input: `raw instanceof SelectStandardProjectToPlay` → a new
`enumerateStandardProject` branch; otherwise the original `enumerateHandCard` path. The
standard-project branch mirrors `SelectStandardProjectToPlay.validate()` (the source of truth) —
eligibility is `card.canAct(player)` (skipped when a discount `overriddenCost` applies), cost is
`overriddenCost ?? card.getAdjustedCost(player)`, and the payable resources come from
`card.canPayWith(player)` combined with the player's heat/Luna-titanium flags and Aurorai/Spire/Kuiper
tableau — all read from Engine methods, none hardcoded — then paid via the same `cheapestLegalPayment`
reduction C already had. An empty candidate set still throws (the standard-projects menu is offered as
an `OrOptions` branch even when nothing in it is actable/affordable; the driver's FR-9 fallback then
tries another branch — correct, not a bug).

**Effect, measured** (same 36-game batch, 2p/3p/4p, seeds 500–511): the agent now actually enumerates
and plays standard projects (verified end-to-end: e.g. `Greenery` paid with exactly 23 M€), and the
fallback rate dropped from ~9.0/game to ~6.2/game. Categorizing the *residual* fallbacks confirmed no
other hidden enumerator gap: 221 were `or :: no actable, affordable standard project` (a broke agent
picking the standard-projects branch — legitimate; the FR-9 fallback retries another branch) and 2
were the anticipated `initialCards :: Too many cards selected` affordability coupling. The
driver-level FR-9 fallback from sub-task E is kept — it remains the safety net for the initialCards
coupling and for a broke agent wandering into an unaffordable action branch.

Note for later (not a bug): a uniform-random `enumerateOr` still picks the standard-projects (or
play-a-card) branch even when nothing in it is doable, then falls back. That biases the action
distribution toward whatever the first eligible branch is. Fine for a random-legal baseline / the
speed spike; a smarter branch filter (skip branches with no legal completion) is a natural M3+
refinement, noted here so it isn't rediscovered.
