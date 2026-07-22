import {Color, PLAYER_COLORS} from '@/common/Color';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

// Fixed, deterministic color assignment so the same config always produces the same players.
export const PLAYER_ORDER_COLORS: ReadonlyArray<Color> = PLAYER_COLORS.slice(0, MAX_PLAYERS);

export type NadiaGameConfig = {
  players: number;
  /** Engine RNG seed. Non-negative integer. Controls board setup and all deck shuffles (SRS CON-5). */
  seed: number;
  firstPlayerIndex?: number;
  playerNames?: ReadonlyArray<string>;
  beginner?: boolean;
};

export type ResolvedNadiaGameConfig = {
  players: number;
  seed: number;
  firstPlayerIndex: number;
  playerNames: ReadonlyArray<string>;
  beginner: boolean;
};

export function resolveGameConfig(config: NadiaGameConfig): ResolvedNadiaGameConfig {
  const {players, seed} = config;

  if (!Number.isInteger(players) || players < MIN_PLAYERS || players > MAX_PLAYERS) {
    throw new Error(`players must be an integer between ${MIN_PLAYERS} and ${MAX_PLAYERS}, got ${players}`);
  }
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`seed must be a non-negative integer, got ${seed}`);
  }

  const firstPlayerIndex = config.firstPlayerIndex ?? 0;
  if (!Number.isInteger(firstPlayerIndex) || firstPlayerIndex < 0 || firstPlayerIndex >= players) {
    throw new Error(`firstPlayerIndex must be an integer between 0 and ${players - 1}, got ${firstPlayerIndex}`);
  }

  const playerNames = config.playerNames ?? Array.from({length: players}, (_, i) => `player${i + 1}`);
  if (playerNames.length !== players) {
    throw new Error(`playerNames must have exactly ${players} entries, got ${playerNames.length}`);
  }

  return {
    players,
    seed,
    firstPlayerIndex,
    playerNames,
    beginner: config.beginner ?? false,
  };
}
