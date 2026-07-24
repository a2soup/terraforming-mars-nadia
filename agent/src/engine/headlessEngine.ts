import {Database} from '@/server/database/Database';
import {IDatabase} from '@/server/database/IDatabase';
import {SerializedGame} from '@/server/SerializedGame';
import {globalInitialize} from '@/server/globalInitialize';

// A no-op Database so the headless runner never touches disk or a real DB connection.
// Mirrors the FAKE_DATABASE the Engine's own test suite installs (tests/testing/setup.ts):
// Game.save() unconditionally goes through GameLoader -> Database, so something has to
// stand in for persistence when running the Engine embedded, outside a real server.
const NOOP_DATABASE: IDatabase = {
  markFinished: () => Promise.resolve(),
  deleteGameNbrSaves: () => Promise.resolve(),
  getPlayerCount: () => Promise.resolve(0),
  getGame: () => Promise.resolve({} as SerializedGame),
  getGameId: () => Promise.resolve('g'),
  getSaveIds: () => Promise.resolve([]),
  getGameVersion: () => Promise.resolve({} as SerializedGame),
  getGameIds: () => Promise.resolve([]),
  initialize: () => Promise.resolve(),
  saveGameResults: () => {},
  saveGame: () => Promise.resolve(),
  purgeUnfinishedGames: () => Promise.resolve([]),
  compressCompletedGames: () => Promise.resolve(),
  stats: () => Promise.resolve({}),
  storeParticipants: () => Promise.resolve(),
  getParticipants: () => Promise.resolve([]),
  createSession: () => Promise.resolve(),
  deleteSession: () => Promise.resolve(),
  getSessions: () => Promise.resolve([]),
};

let initialized = false;

/**
 * Fails fast if `GAME_CACHE` would put `GameLoader`'s cache into `sweep: 'auto'` (hazard H2,
 * Milestone 1 bullet 6). Under `auto`, `Cache.sweep` installs a recurring `setTimeout` that
 * trims `gameLog` off resident games on a **wall-clock schedule**, and `GameLoader.restoreGameLog`
 * then reloads that log from the Database - which here is {@link NOOP_DATABASE}, so the live
 * game's `gameLog` becomes `undefined` and the next decision crashes on it.
 *
 * Sub-task C measured exactly that, with a positive control: under
 * `GAME_CACHE='sweep=auto;sweep_freq=1s;idle_age=1s'` plus a single `GameLoader.add()`, a live
 * game's log was emptied mid-play and play then died on `Cannot read properties of undefined
 * (reading 'push')`. Embedded play never calls `add()` today, so the hazard is currently
 * unreachable - but "unreachable" rests on a call nobody makes *yet*, and the M5 live-play
 * adapter is precisely the code that will start making it.
 *
 * NFR-5 requires residual non-determinism to be recorded **and isolated**. This is the
 * isolation: a wall-clock-driven mutation of live game state fails loudly at bootstrap instead
 * of quietly at generation 12. The check mirrors `parseConfigString`'s own semantics
 * (`src/server/database/GameLoader.ts`) - `;`-separated `key=value` pairs - rather than reaching
 * into `GameLoader`'s private cache, so it stays readable and needs no Engine change.
 */
export function assertSweepIsManual(): void {
  const gameCache = process.env.GAME_CACHE;
  if (gameCache === undefined) {
    return;
  }
  const sweep = Object.fromEntries(gameCache.split(';').map((pair) => pair.split('=', 2))).sweep;
  if (sweep === 'auto') {
    throw new Error(
      `GAME_CACHE requests sweep=auto (GAME_CACHE=${JSON.stringify(gameCache)}), which installs a wall-clock ` +
      `sweep that can empty a live game's gameLog mid-play and then set it to undefined against the headless ` +
      `no-op Database. That is non-deterministic and unrecoverable (SRS CON-5/NFR-5, hazard H2 - see ` +
      `agent/docs/Determinism_Verification.md). Unset GAME_CACHE or use sweep=manual for embedded play.`,
    );
  }
}

/**
 * Prepares the Engine to run embedded/headless: installs the no-op Database (so
 * GameLoader's lazily-constructed singleton never hits a real store) and runs the
 * Engine's own global setup (behavior executor, global event dealer). Idempotent -
 * safe to call before every game creation, and safe to call alongside a test harness
 * (e.g. tests/testing/setup.ts) that already ran globalInitialize() itself: that
 * function throws on a second registration, which we treat as "already done".
 *
 * Also refuses to bootstrap under a `GAME_CACHE` that would enable the wall-clock cache sweep -
 * see {@link assertSweepIsManual}.
 */
export type HeadlessEngineOptions = {
  /**
   * Skips {@link assertSweepIsManual}. Exists for exactly one caller: the H2 probe in
   * `agent/src/determinism/contamination.ts`, whose whole purpose is to run under `sweep=auto`
   * and demonstrate the damage the guard prevents. Nothing that plays a game for real may set
   * this - a determinism probe deliberately entering the unsafe configuration is the only
   * legitimate use, and it never compares fingerprints from that process.
   */
  allowAutoSweep?: boolean;
};

export function ensureHeadlessEngine(options: HeadlessEngineOptions = {}): void {
  if (initialized) {
    return;
  }
  if (options.allowAutoSweep !== true) {
    assertSweepIsManual();
  }
  initialized = true;
  Database.getInstance = () => NOOP_DATABASE;
  try {
    globalInitialize();
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('Cannot re-register the behavior executor')) {
      throw e;
    }
  }
}
