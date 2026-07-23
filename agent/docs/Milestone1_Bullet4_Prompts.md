# Milestone 1, bullet 4 — sub-task prompts (snapshot/restore via the Engine's serialization)

Bullet 4 of Milestone 1: *"Add snapshot/restore using the Engine's serialization, so a state can be
copied for search later"* (SRS CON-3). This is the load-bearing input to the **gating
simulator-speed spike**, which is a separate Milestone 1 item and is **not** part of these
sub-tasks — bullet 4 builds the API the spike measures, not the measurements.

These are written to be pasted into a fresh Claude Code session, each starting cold. Order:
**A → (B, C in parallel) → D**. Routing, in rough order of how much can go quietly wrong:

- **C is the clean hand-off.** Test-only, every assertion independently checkable, and its central
  claim has already been observed passing in the planning probe.
- **A is design-sensitive but fully specified** — the thinking is done and written down below as
  concrete signatures. Safe to hand off, but review it: its two traps (§2, §4) are the kind a fast
  read glides past.
- **B is the smallest in lines and the largest in conceptual load per line.** Run it on Opus, or
  read its trap note (§"How to classify") very carefully first. It is bullet 4's analogue of
  bullet 3's sub-task E — the "drive real games and see what falls out" task — and carries the same
  risk of turning out bigger than it looks.
- **D is an optional stretch** with the highest unknown-Engine-behavior per line — see its own note.

The whole planning basis for this bullet is the **2026-07-22 Running Notes entry "Snapshot/restore
fidelity is *not* universal"**. Read it before starting any sub-task; it contains the measured
numbers every sub-task below is written against, and the Engine facts that make the naive
implementation wrong.

File ownership, so parallel work never edits the same file:

| sub-task | owns |
| --- | --- |
| A | `agent/src/engine/snapshot.ts` (new), `agent/src/engine/stableState.ts` (new — moved), `agent/test/testUtils/stableState.ts` (becomes a re-export), `agent/test/engine/snapshot.spec.ts` (new) |
| B | `agent/test/engine/snapshotFidelity.spec.ts` (new) |
| C | `agent/test/engine/snapshotRoundTrip.spec.ts` (new) |
| D | `agent/src/engine/headlessEngine.ts` (modify), `agent/test/engine/saveHistory.spec.ts` (new) |

---

## Shared preamble (prepend to every sub-task below)

> You are working on the **Nadia** Terraforming Mars agent, in the `agent/` module of a
> terraforming-mars fork. Read `agent/CLAUDE.md` (especially §2 on the Engine pin and §5 on the
> Engine interfaces) and the root `CLAUDE.md`. Then read, in full, the **2026-07-22 Running Notes
> entry "Snapshot/restore fidelity is *not* universal, and 25% of the failures are silent"** — it is
> the design basis for this whole bullet and it will save you from rediscovering the hard parts.
>
> **The one hard rule:** the Engine is **immutable ground truth** (SRS CON-1). Everything here is
> agent-side. In particular you may be tempted to "just serialize `waitingFor`" by patching
> `src/server/SerializedPlayer.ts` / `src/server/Game.ts` — **do not**. The Engine's decision to
> regenerate the pending decision from the phase is a design choice we work *with*; bullet 4's job
> is to detect where that choice loses information, not to change it.
>
> **The three Engine facts everything below follows from** (all verified by running code, not by
> reading it — see the Running Notes entry):
> 1. The pending decision is **not serialized**. `Player.waitingFor` / `waitingForCb` are absent
>    from `SerializedPlayer`, and `Game.serialize()` hardcodes `deferredActions: []`
>    (`src/server/Game.ts:480`). `Game.deserialize` instead *regenerates* a decision from the phase
>    (the `if/else` chain at the end of the function, ending in
>    `game.activePlayer.takeAction(/* saveBeforeTakingAction */ false)`).
> 2. Regeneration is faithful for a **top-of-turn** decision and lossy for a **mid-action
>    sub-decision** — and the lossy case leaves the serialized state **byte-identical**, so a
>    state-only round-trip check silently passes. 29 of 241 action-phase decision points in a
>    measured 2p game are this case.
> 3. `serialize()` **aliases live objects** (`gameLog: this.gameLog`, `gameOptions: this.gameOptions`,
>    `src/server/Game.ts:490-491`) and `Game.deserialize` both **mutates** its argument
>    (`gameOptions.boardName = …`) and **re-aliases** it (`game.gameLog = d.gameLog`). Deep-copy at
>    capture **and again on every restore** — `deserialize` consumes the object it is handed.
>
> **Do not use the Engine's own `Cloner`** (`src/server/database/Cloner.ts`). It is built for
> cross-*game* cloning: it rewrites every player id (a full recursive walk of the serialized graph),
> sets `clonedGamedId`, and resets `createdTimeMs`. All three are wrong for a search fork, which
> wants the same player ids and the same state.
>
> **Style:** match the surrounding agent files (`agent/src/engine/*.ts`, `agent/src/driver/*.ts`) —
> thorough doc comments that explain *why*, `expect`-style Chai tests with descriptive names.
>
> **Definition of done:** your new spec(s) pass, the full agent suite stays green, and the agent
> type-checks. Run from the `agent/` dir:
> ```
> npx mocha --import=tsx --require ../tests/testing/setup.ts "test/**/*.spec.ts"
> ```
> and from the repo root: `npx tsc -p agent/tsconfig.json --noEmit`. (The agent module is not wired
> into the repo's root ESLint, so there is no lint step.) Note that `node_modules` may not be
> installed in a fresh worktree — `npm ci` at the repo root if so.

---

## Sub-task A — the snapshot/restore module (design-sensitive; do this first)

**Owns:** `agent/src/engine/snapshot.ts` (new), `agent/src/engine/stableState.ts` (new),
`agent/test/testUtils/stableState.ts` (rewritten as a re-export), `agent/test/engine/snapshot.spec.ts`
(new).

### 1. Move `stableState` into `src/`, and split it

`stableState()` currently lives in `agent/test/testUtils/stableState.ts` and takes an `IGame`.
Snapshot verification needs it in production code, and needs to run it against a `SerializedGame`
that is **already in hand** (the snapshot's own deep copy) without re-serializing a live game.
Split it accordingly, in the new `agent/src/engine/stableState.ts`:

```ts
export function stableStateOf(serialized: SerializedGame, options?: {ignoreLog?: boolean}): string;
export function stableState(game: IGame): string;  // = stableStateOf(game.serialize())
```

Keep the existing field-exclusion set **exactly as it is** (`id`, `name`, `createdTimeMs`, per-log
`timestamp`, per-player `timer`) and keep its doc comment — a probe confirmed that set is already
precisely right for clone comparison, with no additional stripping needed. `ignoreLog` drops
`gameLog` entirely from both sides; it exists only so state verification composes with log-stripped
snapshots (below).

`agent/test/testUtils/stableState.ts` becomes a one-line re-export so the three existing specs that
import it (`gameFactory.spec.ts`, `embeddedDriver.spec.ts`, `randomLegalAgent.integration.spec.ts`)
need **no** edits. Do not change those specs.

### 2. The module

```ts
export type GameSnapshot = {
  readonly state: SerializedGame;  // already deep-copied; never handed out by reference
  readonly pending: string;        // pending-decision signature captured from the live game
  readonly phase: Phase;
  readonly logStripped: boolean;
};

export function pendingSignature(game: IGame): string;
export function assertSnapshotSafe(game: IGame): void;      // throws UnsafeSnapshotError
export function snapshot(game: IGame, options?: SnapshotOptions): GameSnapshot;
export function restore(snap: GameSnapshot, options?: RestoreOptions): IGame;
export function cloneGame(game: IGame, options?): IGame;    // snapshot + restore, one shot

export class UnsafeSnapshotError extends Error {}
export class SnapshotFidelityError extends Error {}
```

- **`pendingSignature(game)`** — the players with a pending input, in
  `game.playersInGenerationOrder` (the driver's own resolution order, so the signature is stable and
  matches how the driver will actually consume it), each rendered as `` `${player.id}:${type}` ``,
  joined. Cheap: it walks players and reads `getWaitingFor()`. **This is the highest-value function
  in the bullet** — capturing it costs nothing and it is the only thing that detects Engine fact 2.
- **`snapshot(game, {stripLog?, unsafe?})`** — calls `assertSnapshotSafe` unless `unsafe: true`,
  captures `pendingSignature(game)`, then deep-copies `game.serialize()`. `stripLog` replaces
  `gameLog` with `[]` in the copy (74% of the serialized bytes, ~40% of restore cost; see the
  Running Notes cost table). **`stripLog` must not be the default** — it is an optimization whose
  rules-neutrality sub-task B proves, not something to assume.
- **`restore(snap, {verify?})`** — deep-copies `snap.state` *again* (Engine fact 3: `deserialize`
  consumes it, so one snapshot restored N times needs N copies), calls `Game.deserialize`, then
  verifies. `verify` is `'pending'` (**default, always on**) | `'state'` | `'none'`:
  - `'pending'` — compare `pendingSignature(restored)` to `snap.pending`; throw
    `SnapshotFidelityError` on mismatch. This is what turns Engine fact 2 from a silent corruption
    into a loud failure, so it is on by default and the cost (a player walk) is negligible.
  - `'state'` — additionally compare `stableStateOf(restored.serialize(), {ignoreLog: snap.logStripped})`
    to `stableStateOf(snap.state, {ignoreLog: snap.logStripped})`. Costs a serialize + two
    stringifies; for tests, audits, and paranoid modes, not the search hot path.
  - `'none'` — for the speed spike, so it can measure the raw restore cost.
- **`assertSnapshotSafe(game)`** — throws `UnsafeSnapshotError` if `game.phase` is `RESEARCH`,
  `DRAFTING`, or `INITIALDRAFTING`, or if `game.deferredActions.length > 0`.

### 3. Why *both* guards exist — get this right, it is the crux

Neither mechanism alone is sufficient, and it is worth writing this into the module's doc comment
because it is not obvious and it was measured, not reasoned:

- The **phase guard** catches the research failures (all 46 measured bad points), where restore
  re-draws cards and the serialized state genuinely diverges. It does **not** catch the action-phase
  ones: 27 of those 29 have an **empty deferred queue** and sit in `Phase.ACTION`, so the guard
  happily accepts them.
- The **pending-signature verification** catches all 29 action-phase failures (and 23 of the
  research ones). It does **not** catch the other 23 research points, where the *signature* matches
  but the underlying deck and dealt cards have changed.
- **Union: every one of the 75 measured bad decision points is caught by at least one of the two.**
  That is the invariant sub-task B asserts. Do not drop either mechanism as redundant.

### 4. Tests (`snapshot.spec.ts`)

Unit-level, against a real `createGame` driven a few decisions deep with `randomLegalAgent`:

- `pendingSignature` is stable across two same-seed games and reflects simultaneous pending inputs
  (the initial-research phase sets `waitingFor` on every player at once — an easy, real multi-player
  signature to assert against).
- `assertSnapshotSafe` throws for a game driven into `Phase.RESEARCH`, and does not throw at a
  top-of-turn action decision.
- `snapshot` does **not** mutate the source game: `stableState(game)` is unchanged across a
  `snapshot()` call, and — the specific aliasing hazard from Engine fact 3 — appending to the
  **restored** game's `gameLog` leaves the original's `gameLog` untouched, and `gameOptions` is not
  shared between original and clone (assert on object identity, not just equality).
- One snapshot restored 3 times yields 3 independent games, and `snap.state` is byte-identical
  before and after those restores.
- `restore` with a deliberately corrupted `snap.pending` throws `SnapshotFidelityError` — the
  verification path must be exercised, not merely present.
- `stripLog: true` produces a game whose `gameLog` is empty but whose
  `stableStateOf(…, {ignoreLog: true})` matches the unstripped snapshot's.

---

## Sub-task B — fidelity audit (proves the guard, produces the numbers)

**Depends on A.** **Owns:** `agent/test/engine/snapshotFidelity.spec.ts` (new).

This is what makes sub-task A's guard trustworthy rather than a plausible guess. Drive full games
with `randomLegalAgent` via `applyDecision`, and at **every** decision point classify the snapshot:
does `assertSnapshotSafe` accept it, does a restore reproduce the pending signature, and does it
reproduce `stableStateOf`. Then assert the characterization.

### How to classify — read this before writing a line, it is the trap

**You must take the measurement with sub-task A's safety machinery switched off.** An audit is a
*measurement* of where snapshotting is unfaithful; A's API is built to *refuse* to snapshot exactly
there. Use the defaults and the tool will throw on precisely the points you are trying to count, and
the audit degrades — silently, still green — into "assert that the safe points are safe," which
proves nothing and is exactly the regression the whole sub-task exists to prevent. At every decision
point, classify like this:

```ts
const safe = didNotThrow(() => assertSnapshotSafe(game));       // record the verdict, don't act on it
const snap = snapshot(game, {unsafe: true});                    // bypass the guard
const restored = restore(snap, {verify: 'none'});               // bypass the verification
const pendingOk = pendingSignature(restored) === snap.pending;  // compare by hand
const stateOk = stableStateOf(restored.serialize()) === stableStateOf(snap.state);
```

Four booleans per point (`safe`, `pendingOk`, `stateOk`, plus the phase), tabulated. The assertions
below are then statements about that table — **never** about whether `snapshot`/`restore` threw.

**The assertions that matter:**

1. **No bad point survives both guards** — in table terms, `safe && pendingOk ⇒ stateOk`, over every
   row. This is the union invariant from A§3 and it is the one that would actually catch a
   regression in either guard.
2. Every `Phase.RESEARCH` row has `safe === false`.
3. **The corpus still contains the silent case:** at least one `action`-phase row with
   `stateOk === true && pendingOk === false`. This is a *meta*-assertion about the audit itself — it
   fails when the corpus drifts to somewhere the silent case no longer arises, at which point
   assertion 1 has quietly become vacuous and the spec is green while testing nothing. Write it
   against the table, and beware the vacuous forms: asserting merely that *some* row is bad, or that
   the counts are non-zero, or wrapping a `restore` in `expect(...).to.throw` — none of those
   distinguish the silent case from the loud research one, which is the entire point.
4. Log-stripped snapshots are **rules-neutral**: a game driven to completion from a `stripLog: true`
   restore produces the same `GameResult` as one driven from an unstripped restore of the same
   point. This is what earns `stripLog` its place as a spike/search option.

**Report the aggregate** (a `console.log` table by phase, in the shape of the Running Notes table) so
the numbers can be refreshed into the notes. For reference, the planning probe on one 2p game (engine
seed 4242, agent seed 5, 294 decision points) measured: research 46/48 bad, action 29/241 bad,
preludes 0/4, production 0/1 — 75 total, 25.5%. Your corpus will differ; the *shape* should not.

**Where that reference is thin, and why your corpus matters more than it looks.** It is *one 2p
game*. Action and research are ~98% of its points and are well evidenced; `preludes` was sampled 4
times and `production` once; 3p/4p were not covered at all, and `INITIALDRAFTING`, `CEOS`, `SOLAR`
and `INTERGENERATION` never produced a decision point. So a **fourth** failure mode — one A's two
guards do not catch — is entirely possible in the phases you will be first to sample properly. If
assertion 1 fails somewhere the probe never reached, that is the audit doing its job: report it,
add the missing condition to `assertSnapshotSafe`, and write it up in the Running Notes. Do not
weaken the assertion to make it pass.

**Budget:** a full-clone round trip is ~1.5 ms, so ~300 clones/game ≈ 0.5 s of clone cost per game on
top of the drive. Cover 2p/3p/4p over a small fixed seed list and keep the whole spec well under a
minute — this runs in the normal suite, it is not the spike.

---

## Sub-task C — round-trip & independence (the strongest single test)

**Depends on A.** **Owns:** `agent/test/engine/snapshotRoundTrip.spec.ts` (new).

The test the bullet exists to make possible, and only available now that sub-task E landed a
responder that can actually finish games: **clone a mid-game state and prove the clone is the same
game.**

- **Identical playout.** Drive a real game to a quiescent mid-game decision, `cloneGame` it, then
  drive original and clone to `Phase.END` with two **separately constructed** agents on the **same**
  seed. Assert identical `GameResult` *and* identical final `stableState`. (Separately constructed
  matters: sharing one agent instance would have the two runs consuming a single RNG stream and the
  test would prove nothing.) The planning probe did exactly this from decision 90 of a 2p game and
  got a byte-identical outcome, so this should pass on the first try — if it does not, something in
  A is wrong.
- **Negative controls**, each of which fails if the clone is secretly shared state or secretly
  fresh:
  - Two clones of the same snapshot, driven with **different** agent seeds, produce **different**
    results.
  - Driving the clone to completion leaves the *snapshot object* unchanged (`snap.state` byte-equal
    before and after), so one snapshot really is reusable for N simulations.
  - Driving the clone does not advance the **original** game at all — assert the original's
    `stableState` is unchanged while the clone runs to `Phase.END`. This is the search-correctness
    property in one line.
- **Restore at an unsafe point is loud, not silent.** Find a mid-action sub-decision (a pending
  `space` from a tile placement is the reliable one — the probe hit one at decision 54 of a 2p game)
  and assert that `snapshot(game, {unsafe: true})` + `restore` throws `SnapshotFidelityError`
  rather than returning a plausible-looking wrong game. Locating one generically: drive with
  `applyDecision` and stop at the first point where `pendingSignature` of a `{unsafe: true}` restore
  differs from the live game's.

---

## Sub-task D — in-memory save history (optional stretch; the research-phase unlock)

**Depends on A.** **Owns:** `agent/src/engine/headlessEngine.ts` (modify), `agent/test/engine/saveHistory.spec.ts`
(new). **Scope call:** this is genuinely useful but it is *not* required for the speed spike. Skip it
and file it as its own item if bullet 4 is running long — say so explicitly rather than half-doing it.

CON-3 has two halves. Sub-tasks A–C deliver "the embedded simulator must be able to snapshot and
restore state for search and self-play." The other half — "**a game must be resumable from the
Engine's saved state**" — is currently *untestable*, because `headlessEngine.ts` installs a no-op
`Database` whose `saveGame` discards everything.

Replace that one method with a bounded in-memory ring of deep-copied `SerializedGame`s (the rest of
`NOOP_DATABASE` stays as-is), and expose `restoreLastSave(game)`. Keep the ring small and
configurable, defaulting to something like 2 — self-play must not accumulate save history per game.

Two reasons this is worth doing beyond ticking CON-3:

1. It gives snapshots at exactly the **Engine's own blessed save points**, which is a different and
   in places *better* set than ours. Specifically: `Game.gotoResearchPhase()` calls `this.save()`
   **before** the draw loop, so the save history contains a *pre-draw* research state — the only
   snapshot from which a research-phase fork can ever be faithful. Our decision-point snapshots
   cannot reach it. Record this explicitly; it is the path M4 will need.
2. It exercises `Game.save()`'s real path headlessly instead of routing it to `/dev/null`, which is
   how the bullet-1 `Database.getInstance()` crash was found in the first place.

Tests: a save is captured at the points the Engine actually saves (assert the ring is non-empty
after driving a few decisions); `restoreLastSave` returns a game that drives to completion; the ring
is bounded (drive a long game, assert the ring never exceeds its cap); and the research-phase claim
above holds — the last save taken before a research decision restores to a **pre-draw** state whose
project deck still contains the cards that were about to be dealt.

---

## Definition of done (whole bullet)

- New specs plus the **full** agent suite green (`npx mocha --import=tsx --require
  ../tests/testing/setup.ts "test/**/*.spec.ts"` from `agent/`), and `npx tsc -p agent/tsconfig.json
  --noEmit` clean from the repo root.
- The three existing `stableState` importers are **unmodified** (A§1).
- A dated `Running_Notes.md` entry recording the audit's actual numbers (sub-task B), whether
  log-stripping was proven rules-neutral, and anything the Engine did that the 2026-07-22 planning
  entry did not anticipate.
- `agent/CLAUDE.md` §6 status updated: Milestone 1 bullet 4 complete, **simulator-speed spike** next,
  with the full 1,000-game AC-1 run still a separate item after it.

**Explicitly not in this bullet**, so it does not sprawl:

- **The simulator-speed spike itself.** Bullet 4 ships the API; the spike measures it. For scale, the
  planning probe measured serialize 0.03 ms / JSON deep copy ~0.5 ms / `Game.deserialize` ~1.5 ms →
  ~1.5 ms per full clone, ~660–690 clones/s single-threaded, with `structuredClone` measuring
  *slower* than a JSON round trip. Deserialize dominates by ~3×, so the pattern to optimize is
  snapshot-once/restore-many — which is exactly what search does forking N simulations from one node.
- **Forking at non-quiescent decision points.** The 29 silent action-phase points are not fixable by
  being careful with `serialize()`; the information was never captured. The M4 strategy is to fork at
  the nearest quiescent ancestor and deterministically replay the intervening sub-decisions. Bullet 4
  builds the primitive and the guard that makes an unsafe fork loud — not the replay.
- **Engine changes of any kind** (CON-1). If something genuinely cannot be done agent-side, stop and
  write it up rather than patching `src/`.
