import {createGame} from '../../src/engine/gameFactory';

/**
 * A JSON snapshot of a game's serialized state with wall-clock-derived fields
 * stripped, so two same-seed runs can be compared for exact reproducibility
 * (SRS CON-5/NFR-5). See agent/docs/Running_Notes.md, "Determinism finding", for how
 * these specific fields were identified as the only non-RNG-driven ones.
 *
 * `id` is also stripped: `createGame` embeds the seed in the game id (`g-nadia-${seed}`),
 * so leaving it in would make any cross-seed comparison differ on the id string alone,
 * regardless of whether the RNG-driven content (board, decks, dealt cards) actually
 * differs - masking exactly the kind of seed bug documented in the Running Notes
 * (2026-07-22, SeededRandom degeneracy). Stripping it makes "differs across seeds"
 * a genuine test of the shuffle.
 */
export function stableState(game: ReturnType<typeof createGame>): string {
  const serialized = game.serialize() as unknown as Record<string, unknown>;
  const {id: _id, name: _name, createdTimeMs: _createdTimeMs, gameLog, players, ...rest} = serialized;
  const stableGameLog = (gameLog as Array<Record<string, unknown>>).map(({timestamp: _timestamp, ...entry}) => entry);
  const stablePlayers = (players as Array<Record<string, unknown>>).map(({timer: _timer, ...player}) => player);
  return JSON.stringify({...rest, gameLog: stableGameLog, players: stablePlayers});
}
