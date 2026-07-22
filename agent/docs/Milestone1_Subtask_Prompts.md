# Milestone 1, bullet 3 — sub-task prompts (legal-action enumerator + random-legal agent)

Prompt A (contract + dispatch + RNG + agent shell) is **done and merged into this branch**. These are
the remaining sub-tasks B/C/D/E, written to be pasted into a fresh Claude Code session (Sonnet 5),
each starting cold. Order: **A → (B, D in parallel) → C → E**. B and D are safe hand-offs; C (payment)
is the design-sensitive one — run it on Opus or review closely.

Each sub-task owns **one** module file and registers its enumerators in the existing dispatch table
(`agent/src/core/enumerator/index.ts`), which A left stable — so parallel work never edits the same
file. Do not modify `index.ts`'s dispatch logic, the `SCOPE` record, `types.ts`, or `rng.ts`; just add
your module and one line to the `ENUMERATORS` map (that one line is the only shared edit, and it's
conflict-trivial).

---

## Shared preamble (prepend to every sub-task below)

> You are working on the **Nadia** Terraforming Mars agent, in the `agent/` module of a
> terraforming-mars fork. Read `agent/CLAUDE.md` §5 (action model, FR-ACT-4) and the root
> `CLAUDE.md` card/engine notes. Skim `agent/docs/Running_Notes.md` — in particular the 2026-07-22
> entries on the deferred payment reduction, the Reds/out-of-scope rule, and the SeededRandom
> degeneracy.
>
> **The one hard rule:** never re-implement game rules. A response is "legal" **iff the Engine's own
> `PlayerInput.process(response, player)` accepts it on the first submission** — that, not your own
> reading of the rules, is the definition. Every test asserts legality by calling the real Engine
> input's `process()` (or by driving a real game), never by re-checking your own logic.
>
> **The contract you implement** is `DecisionEnumerator` in
> `agent/src/core/enumerator/types.ts` — read its doc comment in full. Signature:
> `(decision: EmbeddedDecisionPoint, rng: AgentRandom, recurse: EnumerateFn) => InputResponse`.
> It returns **one uniformly-random legal move**. For combinatorial decision types, generate the move
> **through the FR-ACT-4 factorization** — sample each factor in turn; never materialize the full
> cross-product.
>
> - `EmbeddedDecisionPoint` (`agent/src/driver/decisionPoint.ts`) = `{player: IPlayer, model:
>   PlayerInputModel, game: IGame, raw: PlayerInput}`. `raw` is the **live Engine input object** (e.g.
>   `OrOptions`, `SelectCard`, `SelectPayment`, `SelectProjectCardToPlay`) — you may read it, because
>   the enumerator runs embedded (design decision D1: the core always searches a local Engine state,
>   SRS FR-INT-3/6). The dispatch guarantees `decision.model.type` matches your enumerator, so you may
>   narrow on it.
> - `AgentRandom` (`agent/src/core/rng.ts`): `next()`, `nextInt(range)` → [0,range),
>   `intInRange(min,max)` → inclusive, `pick(items)` → uniform element. Use it for **all** randomness;
>   the agent's determinism (Milestone 1 exit criterion) depends on it being the only entropy source.
> - Register each enumerator in `ENUMERATORS` in `agent/src/core/enumerator/index.ts`.
>
> **Style:** match the surrounding agent files (see `agent/src/driver/*.ts`, `agent/src/core/*.ts`) —
> thorough doc comments that explain *why*, `expect`-style Chai tests with descriptive names.
>
> **Definition of done:** your new spec(s) pass, the full agent suite stays green, and the agent
> type-checks. Run from the `agent/` dir:
> ```
> npx mocha --import=tsx --require ../tests/testing/setup.ts "test/core/<your-spec>.spec.ts"
> ```
> and from the repo root: `npx tsc -p agent/tsconfig.json --noEmit`. Tests use `createGame(...)` from
> `agent/src/engine/gameFactory.ts` for a real player, and `toDecisionPoint(player, rawInput)` from
> `agent/src/driver/decisionPoint.ts` to build a decision point. (The agent module is not wired into
> the repo's root ESLint, so there is no lint step to run.)

---

## Sub-task B — simple decision types

**Owns:** `agent/src/core/enumerator/simple.ts` (A created it with `enumerateOption`; extend it) and
`agent/test/core/simple.spec.ts` (new).

Implement enumerators for the directly-enumerable types and register each in `ENUMERATORS`. For each,
the model type, the Engine input class to validate against, and the legality rule:

| type | model fields | response | Engine rule (`process`) | enumeration |
| --- | --- | --- | --- | --- |
| `space` | `spaces: SpaceId[]` | `{type:'space', spaceId}` | `SelectSpace`: spaceId ∈ spaces | `rng.pick(model.spaces)` |
| `player` | `players: Color[]` | `{type:'player', player}` | `SelectPlayer`: player ∈ players | `rng.pick(model.players)` |
| `resource` | `include: (keyof Units)[]` | `{type:'resource', resource}` | `SelectResource`: resource ∈ include | `rng.pick(model.include)` |
| `amount` | `min, max` | `{type:'amount', amount}` | `SelectAmount`: min ≤ amount ≤ max | `rng.intInRange(model.min, model.max)` |
| `card` | `cards: CardModel[], min, max` | `{type:'card', cards: CardName[]}` | `SelectCard`: min ≤ len ≤ max, names ∈ offered, distinct | **factor:** sample count `k = rng.intInRange(min,max)`, then choose `k` distinct cards from `model.cards` without replacement |

Notes:
- `card` is the only combinatorial one here — do **not** enumerate all subsets; sample a count then a
  `k`-subset. A clean way to pick `k` distinct: index-shuffle `model.cards` with `rng` and take the
  first `k`, mapping to `.name`.
- **`card` affordability caveat (verified):** `SelectCard.process` checks only min/max/membership, not
  affordability — so any `k`-subset is legal *at this input*. But some `card` decisions (buying
  research/starting cards) trigger a downstream payment; over-selecting can make that later payment
  unaffordable and surface as an illegal move in E's integration batch. For M1, sampling `k` uniformly
  in `[min,max]` is acceptable; add a test that the real **initial research `card`** decision (reachable
  via `createGame` + the driver) accepts your response, and leave any over-selection fallout for E to
  observe. Do not add affordability logic here.

Tests (`simple.spec.ts`): for each type, build the real Engine input (e.g. `new SelectSpace(title,
spaces)`, `new SelectAmount(t, min, max)`), `toDecisionPoint`, `enumerate`, assert the response shape,
and assert `input.process(response, player)` does not throw. For `amount`, use a `ConstRandom`-backed
`AgentRandom` (`agentRandomFrom` from `rng.ts`) to force both `min` and `max` ends and confirm both are
accepted. For `card`, cover `min===0`, `min<max`, and `min===max`, and validate against a **real**
initial-research `card` decision from a driven `createGame`.

---

## Sub-task C — payment & project-card (the FR-ACT-4 core; design-sensitive)

**Owns:** `agent/src/core/enumerator/payment.ts` (new) and `agent/test/core/payment.spec.ts` (new).

Implement `payment` and `projectCard`. **Read the 2026-07-22 "deferred payment reduction" note in
`Running_Notes.md` first** — M1 returns a **single canonical cheapest-legal payment**; the strategic
variants are explicitly deferred to M3, so do not build them, but keep the reduction in one place so
M3 can extend it.

### `payment`
- Model `SelectPaymentModel`: `amount`, `paymentOptions: Partial<PaymentOptions>`, spendable counts
  (`seeds`, `auroraiData`, `kuiperAsteroids`, `spireScience`), `reserveUnits`. Response
  `{type:'payment', payment: Payment}`.
- Engine `SelectPayment.process`: accepts iff `player.canSpend(payment, reserveUnits)` **and**
  `player.payingAmount(payment, paymentOptions) >= amount`.
- **Reduction:** build the cheapest-legal `Payment` covering `amount`. Use the Player helpers
  (`player.payingAmount`, `player.canSpend`, `player.maxSpendable(reserveUnits)`,
  `player.getSteelValue()`, `player.getTitaniumValue()`, `player.getSpendable(...)`,
  `player.canUseHeatAsMegaCredits`, `player.canUseTitaniumAsMegacredits`) — do **not** hardcode
  exchange rates. Mirror the client's proven algorithm in
  `src/client/components/PaymentDefaults.ts` (`computeDefaultPayment`) + `PaymentLedger.ts`: fill the
  cheapest alternate resources first (respecting `reserveUnits` and each resource's spendable
  ceiling), top up with megacredits, then trim any overspend. **Verify before returning**:
  `player.canSpend(payment, reserveUnits) && player.payingAmount(payment, paymentOptions) >= amount`;
  if it fails, fall back to an all-megacredits payment, then to a clear thrown diagnostic.
- Out-of-scope note: the Reds tax (Turmoil) is out of scope — do not model it (Running_Notes
  2026-07-22).

### `projectCard`
- Model `SelectProjectCardToPlayModel`: `cards: CardModel[]` (with calculated cost / `isDisabled`),
  `paymentOptions`, plus microbe/floater/etc. counts. Response
  `{type:'projectCard', card: CardName, payment: Payment}`.
- `raw` is `SelectProjectCardToPlay` (extends `SelectCardToPlay`): `raw.cards: IProjectCard[]`,
  `raw.config?.enabled?: boolean[]`, `raw.extras: Map<CardName, {reserveUnits}>`. Engine
  `SelectCardToPlay.process` → `player.checkPaymentAndPlayCard`: card must be in the list (and enabled),
  reserve units respected, payment covers the card's cost.
- **Factor:** (1) choose a card — filter `raw.cards` to those enabled (`raw.config?.enabled` at the
  same index, when present) and affordable (`player.canAfford(player.affordOptionsForCard(card))`), then
  `rng.pick`; (2) compute its payment via the **same reduction** as `payment`, using
  `player.affordOptionsForCard(card)` for the cost and reserve units and
  `player.paymentOptionsForCard(card)` for the allowed methods. Reuse a shared internal
  `cheapestLegalPayment(player, {cost, paymentOptions, reserveUnits})` helper for both enumerators.

Tests (`payment.spec.ts`): **property-style**, over several stock/rate states set up on a real
`createGame` player (vary megacredits, steel, titanium, heat, and `canUseHeatAsMegaCredits`):
- Every produced `payment` satisfies `canSpend ∧ payingAmount >= amount` (validate via the real input's
  `process`).
- Never overpays: `payingAmount(payment) - amount` is less than the value of the cheapest single unit
  used (no strictly-cheaper legal payment exists by removing a unit).
- `projectCard`: chosen card is enabled & affordable, and `raw.process(response, player)` is accepted.
- Drive a real game with `createGame` far enough to reach an actual `projectCard` decision (an
  affordable card in hand) and confirm the enumerator's move is accepted end-to-end.

---

## Sub-task D — composite & distribution decision types

**Owns:** `agent/src/core/enumerator/composite.ts` (new) and `agent/test/core/composite.spec.ts` (new).

Implement `or`, `and`, `initialCards`, `resources`, `productionToLose`. The first three recurse via
the `recurse: EnumerateFn` argument; build each child decision point with
`toDecisionPoint(decision.player, childRawInput)` (from `agent/src/driver/decisionPoint.ts`) and call
`recurse(childDecision, rng)`.

| type | `raw` class | response | rule & enumeration |
| --- | --- | --- | --- |
| `or` | `OrOptions` (`raw.options: PlayerInput[]`) | `{type:'or', index, response}` | pick a branch index, **skipping any `raw.options[i] instanceof UndoActionOption`** (import from `src/server/inputs/UndoActionOption`; the driver rejects Undo, `agent/src/driver/embeddedDriver.ts`), then `recurse` into `raw.options[index]` |
| `and` | `AndOptions` (`raw.options: PlayerInput[]`) | `{type:'and', responses}` | `recurse` each child in order; `responses` array must line up 1:1 with `options` |
| `initialCards` | `SelectInitialCards` (`raw.options: PlayerInput[]`) | `{type:'initialCards', responses}` | same shape as `and` — `recurse` each sub-option (corp / preludes / starting cards) |
| `resources` | `SelectResources` | `{type:'resources', units: Units}` | `SelectResources.process`: units ≥ 0 and `sum(units) === model.count`. **The model does not restrict which keys** — any distribution over `Units` keys (`megacredits, steel, titanium, plants, energy, heat`) summing to `count` is legal. Sample a random composition (or, as a canonical default, put all `count` in one `rng.pick`ed key) |
| `productionToLose` | `SelectProductionToLose` | `{type:'productionToLose', units: Units}` | `process`: units ≥ 0, `player.production.canAdjust(Units.negative(units))` (you must actually have that production; **megacredit production floors at −5**), and `sum(units) === unitsToLose`. Distribute `unitsToLose` steps across production types the player has, respecting availability and the MC floor. Read available production from `raw.player.production` or `model.payProduction.units` |

Notes:
- `resources` / `productionToLose` are combinatorial — sample a legal distribution factor-by-factor;
  never enumerate all compositions.
- For `productionToLose`, the MC-production floor of −5 means "available MC production steps" =
  `production.megacredits + 5`, not `production.megacredits`. Confirm your distribution is accepted by
  the real `process` rather than reasoning about the floor yourself.

Tests (`composite.spec.ts`): unit-test `or`/`and`/`initialCards` with a **fake `recurse`** (inject a
stub that returns a marker response per child) to prove composition/ordering and Undo-skipping without
depending on other enumerators; then an integration test that drives a real `createGame` through an
actual composite decision (the initial `initialCards` flow is reachable immediately) using the real
`enumerate` as `recurse`, asserting the Engine accepts it. For `resources`/`productionToLose`, build
the real inputs on a `createGame` player and validate against `process`, covering the MC-floor edge.

---

## Sub-task E — finish the random-legal agent + Tier-1 integration

**Depends on B, C, D (all merged).** **Owns:** `agent/src/core/randomLegalAgent.ts` (A left a shell),
a new integration spec (e.g. `agent/test/core/randomLegalAgent.integration.spec.ts`); may modify the
drive path (`agent/src/driver/embeddedDriver.ts`) for the FR-9 fallback below, retire `stubResponder`,
and clean up the vestigial test noted in item 5.

1. **Finish the agent.** Add per-decision logging (SRS FR-11 / NFR-6) at configurable verbosity — log
   the decision type and the chosen move; **off by default**. Add FR-9 handling of an `OutOfScopeDecisionError`
   from `enumerate`: log loudly (these should not arise in base + Corporate Era + Prelude) and surface a
   clear diagnostic with the decision context.

2. **The affordability coupling — the crux of E; get this right.** There is exactly one in-scope
   decision whose legal set the pure enumerator *cannot* see from its model: the initial **project-card
   buy**. `SelectCard.process` checks only count/membership, but `SelectInitialCards.completed()` rejects
   the whole composite if the selected project cards' research cost exceeds the chosen corporation's
   starting M€. So the random `card` enumerator (sub-task B) can over-select and produce a move the
   Engine rejects — which would crash the integration batch. Handle it with a **general FR-9 safety net**,
   not by putting budget logic into the enumerator (keep B/C/D untouched):
   - Implement a **conservative fallback** that yields a guaranteed-legal move for any decision: for
     `card`, select exactly `min`; for `or`/`and`/`initialCards`, recurse producing the conservative
     response per child; other types' random move is already always legal. Make it **deterministic**
     (no rng) so it doesn't reintroduce nondeterminism.
   - Wire the drive path so that when a submitted move is rejected, the agent **falls back to the
     conservative move and resubmits**, logging the fallback loudly (and ideally counting them, so we
     learn how often the coupling fires). The Engine leaves `waitingFor` intact on rejection (bullet-2
     Running_Notes / `IllegalMoveError` comment), so a corrected resubmit is supported.
   - Why the conservative move is always legal here: within `initialCards`, the corp/prelude/CEO
     sub-inputs have `min === max` (forced counts), so the only free choice is the project-card count —
     and selecting `min` (0) project cards is affordable under any corporation. Selecting `min` for
     every `card` sub-input therefore makes the whole composite legal by construction.
   - **Test it:** add a case that reproduces the coupling (e.g. force the initial `card` selections
     toward `max` under a low-starting-M€ corporation, or otherwise construct an over-budget selection)
     and assert the agent recovers and the game proceeds — the fallback path must be genuinely exercised,
     not just present.

3. **Retire `stubResponder` from the drive path.** `runGame` is now driven by `randomLegalAgent`.
   Delete `agent/src/driver/stubResponder.ts` (and its spec) or keep it only if a driver unit test still
   needs it — keep all driver tests green either way.

4. **Tier-1 integration batch.** A seed-pinned batch: ~15–20 full games across 2p/3p/4p over a fixed
   seed list, each driven by `randomLegalAgent` via `runGame` **to `Phase.END`**, asserting zero
   *unrecovered* illegal moves and zero crashes (fallbacks per item 2 are allowed and should be logged,
   not failures). Use distinct seeds (the seed fix now makes them distinct games). Keep it under ~1
   minute. This is the **first time a real game is driven all the way to `Phase.END`**, so it finally
   exercises `computeResult` on a genuinely finished game — resolve and document the async-tail /
   game-over-timing open question bullet-2 left (does reaching `Phase.END` need an awaited tick?).

5. **Determinism + test cleanup.** Same Engine seed + same agent seed ⇒ identical `GameResult` and
   identical `stableState`; verify the two seeds are independent (vary one, hold the other). Also fix the
   now-**vestigial** test in `agent/test/core/randomLegalAgent.spec.ts` (the "delegates … not-yet-built
   type" case that sub-task D hollowed out): repoint it to exercise real error *propagation* through the
   still-reachable `party` → `OutOfScopeDecisionError` path, so it tests the agent surfacing the
   enumerator's error rather than asserting a stub doesn't throw.

**Definition of done:** the integration spec + full suite green (`npx mocha … "test/**/*.spec.ts"`),
`tsc -p agent/tsconfig.json --noEmit` clean. Append a `Running_Notes.md` entry (fallback frequency
observed, async-tail resolution, any engine quirks) and update `agent/CLAUDE.md` §6 status to mark
Milestone 1 bullet 3 complete and note bullet 4 (snapshot/restore) + the simulator-speed spike as next.
The full 1,000-game AC-1 run and the spike are **separate** Milestone-1 items, not part of E.
