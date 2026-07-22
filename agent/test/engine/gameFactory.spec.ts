import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {BoardName} from '../../../src/common/boards/BoardName';
import {CardName} from '../../../src/common/cards/CardName';
import {stableState} from '../testUtils/stableState';

describe('createGame', () => {
  it('creates games for 2, 3, and 4 players', () => {
    for (const players of [2, 3, 4]) {
      const game = createGame({players, seed: 1});
      expect(game.players).has.length(players);
    }
  });

  it('rejects player counts outside 2-4', () => {
    expect(() => createGame({players: 1, seed: 1})).to.throw();
    expect(() => createGame({players: 5, seed: 1})).to.throw();
  });

  it('includes base + Corporate Era + Prelude only, on the Tharsis board', () => {
    const game = createGame({players: 2, seed: 1});

    expect(game.gameOptions.boardName).to.eq(BoardName.THARSIS);
    expect(game.gameOptions.expansions).to.deep.eq({
      corpera: true,
      prelude: true,
      promo: false,
      venus: false,
      colonies: false,
      prelude2: false,
      turmoil: false,
      community: false,
      ares: false,
      moon: false,
      pathfinders: false,
      ceo: false,
      starwars: false,
      underworld: false,
      deltaProject: false,
    });
  });

  it('deals prelude cards to every player, and never a Venus-only card', () => {
    const game = createGame({players: 4, seed: 7});

    for (const player of game.players) {
      expect(player.dealtPreludeCards.length).is.greaterThan(0);
      expect(player.dealtProjectCards.map((c) => c.name)).does.not.include(CardName.VENUS_GOVERNOR);
    }
  });

  it('honors firstPlayerIndex', () => {
    const game = createGame({players: 3, seed: 1, firstPlayerIndex: 2});
    expect(game.first.id).to.eq(game.players[2].id);
  });

  it('is reproducible under a fixed seed, and differs across seeds', () => {
    const gameA = createGame({players: 3, seed: 42});
    const gameB = createGame({players: 3, seed: 42});
    const gameC = createGame({players: 3, seed: 43});

    expect(stableState(gameA)).to.eq(stableState(gameB));
    expect(stableState(gameA)).to.not.eq(stableState(gameC));
  });
});
