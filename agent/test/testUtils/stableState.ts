import {createGame} from '../../src/engine/gameFactory';

/**
 * A JSON snapshot of a game's serialized state with wall-clock-derived fields
 * stripped, so two same-seed runs can be compared for exact reproducibility
 * (SRS CON-5/NFR-5). See agent/docs/Running_Notes.md, "Determinism finding", for how
 * these specific fields were identified as the only non-RNG-driven ones.
 */
export function stableState(game: ReturnType<typeof createGame>): string {
  const serialized = game.serialize() as unknown as Record<string, unknown>;
  const {name: _name, createdTimeMs: _createdTimeMs, gameLog, players, ...rest} = serialized;
  const stableGameLog = (gameLog as Array<Record<string, unknown>>).map(({timestamp: _timestamp, ...entry}) => entry);
  const stablePlayers = (players as Array<Record<string, unknown>>).map(({timer: _timer, ...player}) => player);
  return JSON.stringify({...rest, gameLog: stableGameLog, players: stablePlayers});
}
