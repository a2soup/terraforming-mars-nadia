import {IGame} from '@/server/IGame';
import {SerializedGame} from '@/server/SerializedGame';

export type StableStateOptions = {
  /**
   * Drops `gameLog` entirely from the compared string, rather than only stripping its
   * per-entry `timestamp`. Exists so state verification composes with a log-stripped
   * snapshot (snapshot.ts's `stripLog` option): comparing a log-stripped restore against
   * its log-bearing source with the default (timestamp-only) stripping would otherwise
   * always report a spurious diff on `gameLog`'s length alone.
   */
  ignoreLog?: boolean;
};

/**
 * A JSON snapshot of an already-serialized game with wall-clock-derived fields stripped,
 * so two serializations can be compared for exact reproducibility (SRS CON-5/NFR-5) or
 * for clone fidelity (snapshot.ts). See agent/docs/Running_Notes.md, "Determinism
 * finding", for how these specific fields were identified as the only non-RNG-driven
 * ones - a later probe (2026-07-22, "Snapshot/restore fidelity is not universal")
 * confirmed the same exclusion set is *also* exactly right for clone comparison, with no
 * additional stripping needed.
 *
 * `id` is also stripped: `createGame` embeds the seed in the game id (`g-nadia-${seed}`),
 * so leaving it in would make any cross-seed comparison differ on the id string alone,
 * regardless of whether the RNG-driven content (board, decks, dealt cards) actually
 * differs - masking exactly the kind of seed bug documented in the Running Notes
 * (2026-07-22, SeededRandom degeneracy). Stripping it makes "differs across seeds"
 * a genuine test of the shuffle.
 */
export function stableStateOf(serialized: SerializedGame, options: StableStateOptions = {}): string {
  const record = serialized as unknown as Record<string, unknown>;
  const {id: _id, name: _name, createdTimeMs: _createdTimeMs, gameLog, players, ...rest} = record;
  const stablePlayers = (players as Array<Record<string, unknown>>).map(({timer: _timer, ...player}) => player);

  if (options.ignoreLog === true) {
    return JSON.stringify({...rest, players: stablePlayers});
  }

  const stableGameLog = (gameLog as Array<Record<string, unknown>>).map(({timestamp: _timestamp, ...entry}) => entry);
  return JSON.stringify({...rest, gameLog: stableGameLog, players: stablePlayers});
}

/** Convenience wrapper: `stableStateOf(game.serialize())`. */
export function stableState(game: IGame): string {
  return stableStateOf(game.serialize());
}
