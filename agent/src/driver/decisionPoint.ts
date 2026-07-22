import {IGame} from '@/server/IGame';
import {IPlayer} from '@/server/IPlayer';
import {PlayerInput} from '@/server/PlayerInput';
import {PlayerInputModel} from '@/common/models/PlayerInputModel';

/**
 * A decision point surfaced to the decision core: the cross-mode contract (CLAUDE.md
 * Sec 4). This is deliberately everything the live-play HTTP transport can also
 * produce - the model the UI/agent reasons about, and nothing engine-internal.
 */
export type DecisionPoint = {
  player: IPlayer;
  model: PlayerInputModel;
  game: IGame;
};

/**
 * Embedded-only decision point. `raw` is the live Engine `PlayerInput` behind the
 * model - richer (object references, not just serializable data) and useful for
 * embedded search, but it has no live-play equivalent. Never read `raw` from
 * portable core/strategy code; it exists only for EmbeddedResponder (responder.ts).
 */
export type EmbeddedDecisionPoint = DecisionPoint & {
  raw: PlayerInput;
};

/**
 * Builds the decision point for a player's pending input. Mirrors
 * `Server.getWaitingFor` (src/server/models/ServerModel.ts), which is what the HTTP
 * transport sends to the client - keeping model construction identical across modes.
 */
export function toDecisionPoint(player: IPlayer, waitingFor: PlayerInput): EmbeddedDecisionPoint {
  const model = waitingFor.toModel(player);
  model.warning = waitingFor.warning;
  return {
    player,
    model,
    game: player.game,
    raw: waitingFor,
  };
}
