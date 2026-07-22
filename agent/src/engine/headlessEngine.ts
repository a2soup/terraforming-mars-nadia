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
 * Prepares the Engine to run embedded/headless: installs the no-op Database (so
 * GameLoader's lazily-constructed singleton never hits a real store) and runs the
 * Engine's own global setup (behavior executor, global event dealer). Idempotent -
 * safe to call before every game creation, and safe to call alongside a test harness
 * (e.g. tests/testing/setup.ts) that already ran globalInitialize() itself: that
 * function throws on a second registration, which we treat as "already done".
 */
export function ensureHeadlessEngine(): void {
  if (initialized) {
    return;
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
