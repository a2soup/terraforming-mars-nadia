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
