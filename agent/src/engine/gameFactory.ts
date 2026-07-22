import {Game} from '@/server/Game';
import {IGame} from '@/server/IGame';
import {Player} from '@/server/Player';
import {BoardName} from '@/common/boards/BoardName';
import {GameOptions} from '@/server/game/GameOptions';
import {GameId, PlayerId, SpectatorId} from '@/common/Types';
import {NadiaGameConfig, PLAYER_ORDER_COLORS, resolveGameConfig} from './gameConfig';
import {ensureHeadlessEngine} from './headlessEngine';

// Base game + Corporate Era + Prelude, standard Tharsis board. GameCards reads these
// two deprecated booleans (not the `expansions` record) to pick module manifests, so
// they're the actual switches; newInstance() derives `expansions` from them for us.
const BASE_GAME_OPTIONS: Partial<GameOptions> = {
  boardName: BoardName.THARSIS,
  corporateEra: true,
  preludeExtension: true,
};

/**
 * Creates a headless base + Corporate Era + Prelude game for 2-4 players.
 * Same seed + same config always produces the same game (SRS CON-5): this is the
 * Engine's own RNG seed only, separate from any future agent search/determinization RNG.
 */
export function createGame(config: NadiaGameConfig): IGame {
  ensureHeadlessEngine();
  const resolved = resolveGameConfig(config);

  const players = resolved.playerNames.map((name, i) => {
    const color = PLAYER_ORDER_COLORS[i];
    return new Player(name, color, resolved.beginner, 0, `p-${color}` as PlayerId);
  });

  const gameId = `g-nadia-${resolved.seed}` as GameId;
  const spectatorId = 's-nadia-spectator' as SpectatorId;

  return Game.newInstance(
    gameId,
    players,
    players[resolved.firstPlayerIndex],
    spectatorId,
    BASE_GAME_OPTIONS,
    resolved.seed,
  );
}
