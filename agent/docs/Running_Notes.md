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

## 2026-07-22 — Snapshot/restore fidelity is *not* universal, and 25% of the failures are silent (bullet-4 planning spike)

Findings from a throwaway probe run while planning Milestone 1 bullet 4 (snapshot/restore, SRS
CON-3), *before* any of it was implemented — recorded here because the numbers reshape the bullet's
design and the underlying Engine facts are exactly the kind that reading the code alone gets wrong.
The probe drove one 2p game (engine seed 4242, agent seed 5, `randomLegalAgent` via `applyDecision`)
all the way to `Phase.END` — **294 decision points** — and at each one deep-copied
`game.serialize()`, `Game.deserialize()`d it, then compared the clone to the original two ways:
`stableState()` (the serialized-state comparison we already had) **and** a *pending-decision
signature* (which players have a `waitingFor`, in `playersInGenerationOrder`, and of what type).
Both probes were run twice, end to end, with byte-identical results.

**The headline: 75 of 294 decision points (25.5%) do not round-trip, and all 29 of the action-phase
failures are invisible to a state-only check.**

| phase | bad / total | how it fails |
| --- | --- | --- |
| research | 46 / 48 | serialized state diverges — restore **re-draws** cards |
| action | 29 / 241 | `stableState` matches **byte for byte**; the pending decision is silently replaced |
| preludes | 0 / 4 | — |
| production | 0 / 1 | — |

**Root cause: the Engine deliberately does not serialize the pending decision, and regenerates one
from the phase instead.** `Player.waitingFor` / `waitingForCb` (`src/server/Player.ts`) are not in
`SerializedPlayer` at all, and `Game.serialize()` hardcodes `deferredActions: []`
(`src/server/Game.ts:480` — the field exists in `SerializedGame`, it is simply always written
empty). `Game.deserialize` compensates with a phase dispatch at the end of the function
(`src/server/Game.ts`, the `if (game.generation === 1 && …) … else if (phase === DRAFTING) …` chain
ending in `game.activePlayer.takeAction(/* saveBeforeTakingAction */ false)`), which *re-derives* a
decision rather than restoring the one that was pending. That re-derivation is correct for a
**top-of-turn** decision — `Player.takeAction()` regenerates prelude selection, pending initial
corporation actions, and the main `getActions()` `OrOptions` faithfully — and that is why 212 of 241
action-phase points and all 4 prelude points round-trip perfectly.

It is *not* correct for a **mid-action sub-decision**. When the pending input is something queued
behind an action already in flight (probe example: `#54 phase=action pending=[p-red:space]` — an
ocean-tile placement), restore throws that decision away, along with any continuation it was
guarding, and hands the player a fresh top-of-turn action instead. **Nothing in the serialized state
changes**, because the discarded decision was never in the serialized state to begin with. A
round-trip check that compares only `stableState()` reports success on every one of these. This is
the same class of bug as the driver's double-drain from the sub-task E entry above (a silently lost
continuation), reached by a different route, and it is the reason bullet 4's snapshot API captures
and verifies the pending signature rather than trusting state equality.

**Research fails differently and more loudly.** `Player.runResearchPhase()` calls
`newStandardDraft(this.game).draw(this)` unconditionally whenever the draft variant is off (which is
our config), so a restore into `Phase.RESEARCH` pops *fresh* cards off the project deck — different
cards, a mutated deck, `draftedCards` overwritten. Worth recording the Engine's own intent here,
because it points at the fix: `Game.gotoResearchPhase()` calls `this.save()` **before** the draw
loop, so the Engine's blessed snapshot point for research is *pre-draw*, not at the decision. A
research-phase fork is therefore reachable via the save history, never via a snapshot taken at the
decision point itself.

**`serialize()` aliases live objects — a deep copy is required on *both* sides.** `serialize()`
returns `gameLog: this.gameLog` and `gameOptions: this.gameOptions` (`src/server/Game.ts:490-491`) —
the actual live arrays/objects, not copies. `Game.deserialize` then both *mutates* its argument
(`gameOptions.boardName = normalizeBoardName(gameOptions.boardName)`, first line of the function)
and *re-aliases* it (`game.gameLog = d.gameLog`). So `Game.deserialize(game.serialize())` with no
copy in between produces a "clone" that shares the original's game log — appending to one appends to
the other — and mutates the original's `gameOptions` on the way. The `Game` constructor's
`this.gameOptions = {...gameOptions}` (`src/server/Game.ts:206`) is only a shallow copy and does not
save you (nested `expansions` stays shared). Copy at capture **and** again per restore: `deserialize`
consumes the object it is handed, so one snapshot restored N times needs N copies. Verified: with
copies on both sides, one snapshot restored 3 times gave 3 independent games and the snapshot object
itself was unchanged afterward.

**What *does* work, confirmed end-to-end.** From a quiescent mid-game fork (decision 90, action
phase, empty deferred queue), `Game.deserialize(deepCopy(game.serialize()))` produced a clone that
drove to a **byte-identical outcome**: same `GameResult` (gen 26, p-red 99 / p-green 45, same
winner) and same final `stableState()` when original and clone were driven by separately-constructed
agents on the same seed. Negative controls also pass: different agent seeds from the same snapshot
diverge, and the original is untouched by anything done to the clone. Note that `stableState()`
needed **no new field stripping** for this — the existing exclusion set (`id`, `name`,
`createdTimeMs`, log timestamps, player timers) is already exactly right for clone comparison, which
is a small piece of luck worth knowing rather than re-deriving.

**Cost preview** (this workstation, ~decision 200 of a 2p game, two runs; the gating simulator-speed
spike owns the real numbers, this is only the shape):

| op | ms |
| --- | --- |
| `serialize()` | 0.03 |
| JSON round-trip deep copy | 0.47–0.51 |
| `structuredClone` | 0.60–0.66 — **slower than JSON**, don't reach for it reflexively |
| `Game.deserialize` (full log) | 1.44–1.63 |
| `Game.deserialize` (log stripped) | 0.88–0.97 |
| **full clone** (serialize + copy + deserialize) | **~1.5** → ~660–690 clones/s, single-threaded |

Two things the spike should carry forward: **deserialize dominates** (~3× the copy, ~50× the
serialize), so the access pattern that matters is snapshot-once/restore-many — which is exactly what
search does when it forks N simulations from one node; and **`gameLog` is 74% of the serialized
bytes** (47.7KB of 64.8KB, 354 entries at that point, and it only grows), so dropping it from
search-only snapshots cuts restore cost ~40% for free. Log-stripping is an option, not the default,
and needs a batch run proving rules-neutrality before it's trusted.

**Implication for Milestone 4, recorded now so it isn't rediscovered:** search cannot fork at an
arbitrary decision node. The 29 silent action-phase points are not fixable by being careful with
`serialize()` — the information was never captured. The natural strategy is **fork at the nearest
quiescent ancestor and replay the intervening sub-decisions**, which the driver can already do
deterministically. Bullet 4 does not build that; it builds the snapshot primitive plus the guard
that makes an unsafe fork loud instead of silent.

**Smaller items, all recorded rather than fixed:**
- **`Cache.mark()` leak + log noise on END-phase restore.** `Game.deserialize` ends with
  `if (game.phase === Phase.END) GameLoader.getInstance().mark(game.id)`, and `Cache.mark`
  (`src/server/database/Cache.ts`) does a `console.log('Marking …')` and adds a Map entry keyed by
  game id. Harmless at M1 volumes; a genuine unbounded map plus stdout spam at self-play scale,
  where clones share one game id and terminal states get restored constantly.
- **Clones share the original's `game.id`.** Fine mechanically (nothing registers the clone with
  `GameLoader`), but it makes logs ambiguous. `stableState()` already strips `id`, so overriding it
  per clone is free if we ever want to.
- **We deliberately do not use the Engine's own `Cloner`** (`src/server/database/Cloner.ts`). It is
  built for cross-*game* cloning: it rewrites every player id, sets `clonedGamedId`, and resets
  `createdTimeMs`. All three are wrong for a search fork (which wants the same ids) and the id
  rewrite is a full recursive walk of the serialized graph — pure added cost.
- **Fields that are not serialized at all** and would silently vanish from a clone:
  `monsInsuranceOwner` (Mons Insurance, promo), `inDoubleDown` / `doubleDownPrelude` (Double Down,
  prelude2), `discardedColonies` (colonies). All out of scope for v1 (base + Corporate Era +
  Prelude), so none can arise today — but they are a real hazard the moment scope widens, which is
  the only reason they're listed.

## 2026-07-23 — Fidelity audit: the guard holds across 2p/3p/4p, but `preludes` is not the clean phase the probe suggested (bullet 4, sub-task B)

`agent/test/engine/snapshotFidelity.spec.ts` — the audit that turns sub-task A's guard from a
plausible claim into a measured one. Drives 6 full games (2p seeds 4242/9001, 3p 9101/9102, 4p
9201/9202, agent seed `engineSeed * 13 + 97`) to `Phase.END` and classifies **every** decision point
with A's safety machinery deliberately switched off (`snapshot(game, {unsafe: true})` +
`restore(snap, {verify: 'none'})`, compared by hand) — because classifying with the defaults would
make the tool throw on precisely the rows being counted, degrading the audit into "assert that the
safe points are safe" while staying green. **1,809 decision points, 485 bad (26.8%)** — the planning
probe's 25.5% on one 2p game, held up across player counts:

| phase | bad / total | silent | state diverged | rejected by phase guard | bad rows caught *only* by the pending check |
| --- | --- | --- | --- | --- | --- |
| action | 170 / 1434 | 170 | 0 | 5 | 165 |
| preludes | 7 / 43 | 4 | 3 | 2 | 5 |
| production | 0 / 6 | 0 | 0 | 0 | 0 |
| research | 308 / 326 | 0 | 308 | 326 | 0 |

**The union invariant holds** (`safe && pendingOk ⇒ stateOk`, zero exceptions over all 1,809 rows), so
no fourth failure mode surfaced in the phases the probe under-sampled. The two guards remain
non-redundant in the strongest possible way: the phase guard catches 100% of research and 0% of
action; the pending-signature check catches 165 of the 170 action failures the phase guard waves
through. Action failures are still **100% silent** — every one round-trips `stableState` byte for
byte — which is the whole case for capturing `pendingSignature` at all.

**The new finding: `preludes` is a mixed phase, and the probe's `0/4` was a small-sample artifact.**
7 of 43 prelude points fail, and — the part that matters — **3 of them diverge in serialized state
while `assertSnapshotSafe` happily accepts them** (`safe=true`, empty deferred queue, `Phase.PRELUDES`
is not in the unsafe-phase list). All 7 are live `space` decisions: a tile placement queued behind a
prelude already in flight. Restore discards the continuation and regenerates something else —
`p-red:space` → `p-red:card` (back to prelude selection; state unchanged, the silent case) or
`p-yellow:space` → `p-yellow:or` (a top-of-turn action; state *does* diverge). So preludes is the
mirror image of research: a state-divergent failure that only the **pending** check catches, where
research is a state-divergent failure that only the **phase guard** catches. A§3's "do not drop
either mechanism as redundant" is now load-bearing in both directions, measured, not argued.

Deliberately *not* fixed by widening `assertSnapshotSafe` to reject `Phase.PRELUDES` wholesale: 36 of
43 prelude points round-trip fine, the pending check already catches all 7 that don't, and the guard
is meant to be a cheap phase-level filter, not a second implementation of the fidelity check.

> **Superseded — see the 2026-07-23 "branch review" entry below.** "The pending check already
> catches all 7 that don't" was true on *this* corpus but not in general: a wider, independently
> seeded sweep found a prelude point where the pending check also passed (by signature
> coincidence) while the state still diverged — a survivor of both guards. `Phase.PRELUDES` (and
> `Phase.CEOS`) are now in the unsafe-phase list after all. Left in place rather than rewritten,
> per this file's own convention of recording findings and decisions as they happened; the
> correction is the entry that follows.

**Log-stripping is rules-neutral — proven, so `stripLog` has earned its place as a spike/search
option.** At a quiescent mid-game point in 2p, 3p and 4p games, a `stripLog: true` restore and an
unstripped restore of the *same* point, driven to `Phase.END` by separately-constructed same-seed
agents, produce identical `GameResult` **and** identical `stableStateOf(…, {ignoreLog: true})` — i.e.
the two finished games are identical in every respect other than the log itself, not merely tied on
victory points. (`gameAge` is an independent counter, not `gameLog.length`, so it survives stripping
— worth knowing before assuming the comparison is trivially true.)

Runtime: the whole audit is ~4 s (~1,809 clone round trips plus 6 full drives), so it runs in the
normal suite rather than being spike-only, as intended. Numbers above are reproducible from the seed
list in the spec alone; two consecutive runs gave an identical table.

## 2026-07-23 — Sub-task D scheduling: deferred to M4, not M1 (bullet 4 wrap-up)

Discussed while wrapping up bullet 4: given the fidelity audit's numbers (26.8% of decision points
don't round-trip, all action-phase failures silent), should sub-task D (in-memory save history,
`headlessEngine.ts`) be pulled into M1 immediately after the simulator-speed spike, rather than left
as M4's problem? Recorded here because the reasoning — and one imprecision in how the finding was
first described — is worth having on hand before D is actually built.

**Clarification worth stating plainly: none of this affects real play.** The audit's failures only
occur when a game is serialized and `Game.deserialize`d into a *new* game object — an operation that
happens nowhere in normal play (`runGame`/`applyDecision`/`player.process` never serialize anything;
`Game.save()` fires during play but goes to the no-op database and never touches the live game
object). Every game the driver plays — the bullet-3 Tier-1 batch, the audit's own 6 games, any future
1,000-game AC-1 run — is authentic: legal, complete, and untouched by any of this. The defect is
specific to *cloning* a state, which nothing exercises today except the search/self-play primitives
bullet 4 itself builds. It becomes real the day something forks a state, which is M4, not M1.

**Recommendation: defer D itself to M4; do one small verification now.** Two reasons, not one cost
argument:

1. **D has no consumer yet, so its design questions have no answer yet.** Ring size, whether to key
   the ring per game object or per game id (clones share the original's `game.id` — noted above,
   2026-07-22 entry — so an id-keyed ring would corrupt across clones at self-play scale), what
   `restoreLastSave` should return, and how to handle `Game.deserialize`'s own re-entrant `save()`
   call when restoring a research-phase save — all depend on how M4's replay-from-quiescent-ancestor
   mechanism actually forks. Building D now means guessing at all four against requirements that
   don't exist yet; the standard failure mode for infrastructure built ahead of its consumer.
2. **The spike itself can still change D's shape.** If clone cost comes back far higher than the
   ~1.5ms/clone planning estimate, M4's search design — and therefore how heavily it leans on Engine
   save points vs our own decision-point snapshots — could look quite different. Building D before
   that number is in means building it twice if the number surprises us.

**What *is* worth doing now, cheaply, while the context is fresh:** verify the one factual claim M4's
research-fork strategy depends on — that `Game.gotoResearchPhase()`'s `save()` call really does land
*before* the draw, so restoring from it deals the same cards rather than re-drawing. This was reasoned
through (`src/server/Game.ts`, `gotoResearchPhase` calls `this.save()` then `this.players.forEach(p =>
p.runResearchPhase())`) but not empirically tested — the distinction matters, since everything else in
this bullet was learned by running code, not by reading it. A small throwaway probe (measure
`Game.save()` call density on live games) confirmed saves happen at a useful cadence for M4's
replay-from-ancestor strategy generally — about 1 per 2.4 decision points across 2p/3p/4p (102/258,
172/375, 129/308) — which is worth recording independent of D's own scheduling: whatever M4's replay
mechanism turns out to be, quiescent Engine-blessed fork points are not sparse.

**What would pull D forward:** if M6 self-play wants save-history resume for a reason unrelated to
search, or if the spike shows clone cost high enough that Engine save points become the *primary*
fork mechanism rather than a research-phase special case — either would give D a real consumer inside
M1/M2's timeframe rather than M4's, and it should move up then.

**Bullet 4 status:** A, B, C done (this repo's commits); D deferred to M4 per the above, to be
designed alongside the replay-from-quiescent-ancestor mechanism it feeds, not before.

## 2026-07-23 — `assertSnapshotSafe` gap: `Phase.PRELUDES` could survive both guards (branch review, fixed)

Found during a code review of the merged A/B/C branch, before it was relied on. The sub-task B
entry immediately above measured `preludes` at 7/43 bad and made a *deliberate, documented*
decision **not** to widen the phase guard to cover `Phase.PRELUDES`, reasoning that "the pending
check already catches all 7 that don't [round-trip]." That reasoning was corpus-specific and
turned out not to generalize — recorded here because the failure mode it missed is exactly the
class this whole bullet exists to prevent: a **silent** corruption reachable through the
*public, default* API, not merely through `{unsafe: true}` probing.

**The gap, found by a 120-game sweep** (2p/3p/4p, seeds 20000–20039, independent of both the
planning probe and B's audit corpus) that classified every decision point looking specifically
for a survivor of *both* guards (`safe && pendingOk && !stateOk`). One turned up:
`{3p, seed: 20027}`, at a mid-prelude sub-decision (`p-yellow` holding a pending `space` from an
in-flight prelude's tile placement). At that point:

- `assertSnapshotSafe(game)` **did not throw** — `Phase.PRELUDES` was not in the unsafe-phase
  list, and the deferred-actions queue was empty.
- `restore(snap)` with the **default** `verify: 'pending'` **did not throw** — the restored
  game's pending signature was `p-yellow:or` (a freshly-regenerated top-of-turn action menu),
  which happens to be the same shape (`player:type`) as a live prelude `OrOptions` sub-choice
  would have produced had one been pending instead of the `space` decision that actually was.
- The serialized state **did** diverge: `phase: 'preludes'` (live) vs `'action'` (restored) —
  confirmed by diffing the two `stableStateOf` outputs top-level-key by key, which showed
  exactly one differing field, `phase` itself. Nothing else differed; the coincidental
  signature match was the entire reason both guards passed while handing back a different game.

So through the module's own public API, with every default in place, `snapshot()` +
`restore()` at that point returns normally and silently hands back a game one full phase away
from the one that was captured — precisely the "loud, not silent" guarantee this module exists
to provide, defeated at the one phase B's corpus happened to undersample (0/4 bad on the
original 6-game corpus vs 7/43 on it, so the state-diverging cases were there but this
particular *both-guards-pass* combination wasn't hit until a wider, differently-seeded sweep).

**Fix:** `assertSnapshotSafe` (`snapshot.ts`) now also rejects `Phase.PRELUDES` and
`Phase.CEOS` (the latter defensively — CEOs are out of scope for v1 and never occur in any
corpus here, but it shares the identical structural risk: a mid-phase sub-decision that can be
silently replaced by a fresh top-of-turn decision on restore, same as research and preludes).
This is the same treatment `RESEARCH` already gets, for the same underlying reason, applied to
the one phase it was missing from.

**Verification, not just reasoning:**
- The original 120-game sweep, re-run against the fixed guard: **0 survivors** (down from 1),
  across all three player counts.
- `agent/test/engine/snapshot.spec.ts` gained a unit test driving a real game into
  `Phase.PRELUDES` and asserting `assertSnapshotSafe` throws — the same shape as the existing
  `Phase.RESEARCH` test, now covering the phase that was missing.
- `agent/test/engine/snapshotFidelity.spec.ts`'s audit corpus widened from 6 games (2 per
  player count) to 12 (4 per player count), specifically adding `{3p, seed: 20027}` as a
  **pinned regression case** — the exact config the sweep found — plus three more seeds per
  player count for general corpus breadth. Two new assertions mirror the existing "the phase
  guard covers research" check for preludes and CEOs. Re-run numbers, 3,869 decision points
  across the widened corpus: **preludes now 17/89 bad, 89/89 rejected by the guard** (100% —
  confirming the fix structurally rather than by the coincidence that let the original survivor
  through), 10 of those 17 a genuine state divergence (up from B's 3, now on a corpus more than
  twice the size). Research and action numbers are consistent with B's own findings (research
  672/708 rejected-by-guard = bad; action 393 silent, still 100% of its bad rows, still only
  caught by the pending check, still 0 caught by the phase guard). Full suite: **107 passing**
  (104 + 1 new unit test + 2 new audit assertions), `tsc --noEmit` clean.

**The general lesson, worth stating plainly since it's the second time this bullet has hit it:**
a small, targeted audit corpus can validate a design decision on the data it happened to sample
and still be wrong in general — B's own doc comment said as much about the *planning probe*
relative to *B's* corpus ("a fourth failure mode showing up here would be the audit doing its
job, not a reason to weaken the assertion"), and that is exactly what happened one level up, on
review, against B's own corpus. The corpus is now wider, the specific gap is pinned as a
regression case, and the two new phase-coverage assertions mean either guard's phase list
regressing would be caught directly rather than requiring another sweep to notice.
