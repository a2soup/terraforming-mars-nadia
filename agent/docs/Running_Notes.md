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
