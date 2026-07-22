import {expect} from 'chai';
import {computeResult} from '../../src/driver/gameResult';
import {Phase} from '../../../src/common/Phase';
import {IGame} from '../../../src/server/IGame';
import {IPlayer} from '../../../src/server/IPlayer';

function fakePlayer(id: string, totalVictoryPoints: number): IPlayer {
  return {
    id,
    getVictoryPoints: () => ({total: totalVictoryPoints}),
  } as unknown as IPlayer;
}

function fakeGame(phase: Phase, players: ReadonlyArray<IPlayer>, generation = 7): IGame {
  return {id: 'g-fake', phase, generation, players} as unknown as IGame;
}

describe('computeResult', () => {
  it('throws if the game has not reached Phase.END', () => {
    const game = fakeGame(Phase.ACTION, [fakePlayer('p-red', 10)]);
    expect(() => computeResult(game)).to.throw(/Phase.END/);
  });

  it('reports each player\'s final VP and the single winner, with the generation the game ended in', () => {
    const red = fakePlayer('p-red', 42);
    const green = fakePlayer('p-green', 35);
    const game = fakeGame(Phase.END, [red, green], 9);

    const result = computeResult(game);

    expect(result.generation).to.eq(9);
    expect(result.players).to.deep.eq([
      {playerId: 'p-red', victoryPoints: 42},
      {playerId: 'p-green', victoryPoints: 35},
    ]);
    expect(result.winners).to.deep.eq(['p-red']);
  });

  it('reports every player tied for the max VP as a winner', () => {
    const red = fakePlayer('p-red', 40);
    const green = fakePlayer('p-green', 40);
    const yellow = fakePlayer('p-yellow', 30);
    const game = fakeGame(Phase.END, [red, green, yellow]);

    const result = computeResult(game);

    expect(result.winners).to.have.members(['p-red', 'p-green']);
  });
});
