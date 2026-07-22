import {Phase} from '@/common/Phase';
import {PlayerId} from '@/common/Types';
import {IGame} from '@/server/IGame';

export type PlayerResult = {
  playerId: PlayerId;
  victoryPoints: number;
};

/**
 * Final outcome of a completed game. `winners` is every player tied for the highest
 * victoryPoints total - simple max-VP ranking, not the game's full tiebreak rules
 * (terraform rating, then generation, ...). Real tiebreaking belongs to the match
 * harness/ratings pipeline (Milestone 2), not this driver.
 */
export type GameResult = {
  generation: number;
  players: ReadonlyArray<PlayerResult>;
  winners: ReadonlyArray<PlayerId>;
};

/** Reads the final outcome of a game that has reached Phase.END. */
export function computeResult(game: IGame): GameResult {
  if (game.phase !== Phase.END) {
    throw new Error(`computeResult called on game ${game.id} before it reached Phase.END (phase is '${game.phase}').`);
  }

  const players = game.players.map((player) => ({
    playerId: player.id,
    victoryPoints: player.getVictoryPoints().total,
  }));
  const maxVictoryPoints = Math.max(...players.map((p) => p.victoryPoints));
  const winners = players.filter((p) => p.victoryPoints === maxVictoryPoints).map((p) => p.playerId);

  return {generation: game.generation, players, winners};
}
