/**
 * Headless game-creation runner.
 *
 *   npx tsx agent/src/runner/createGameCli.ts --players 3 --seed 42
 *   npx tsx agent/src/runner/createGameCli.ts --players 2 --seed 42 --json
 */
import {createGame} from '../engine/gameFactory';
import {NadiaGameConfig} from '../engine/gameConfig';

function parseArgs(argv: ReadonlyArray<string>): NadiaGameConfig & {json: boolean} {
  let players: number | undefined;
  let seed: number | undefined;
  let firstPlayerIndex: number | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--players':
      players = Number(argv[++i]);
      break;
    case '--seed':
      seed = Number(argv[++i]);
      break;
    case '--first-player':
      firstPlayerIndex = Number(argv[++i]);
      break;
    case '--json':
      json = true;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  if (players === undefined) throw new Error('--players is required');
  if (seed === undefined) throw new Error('--seed is required');

  return {players, seed, firstPlayerIndex, json};
}

function main() {
  const {json, ...config} = parseArgs(process.argv.slice(2));
  const game = createGame(config);

  if (json) {
    console.log(JSON.stringify(game.serialize(), null, 2));
    return;
  }

  console.log(`Game ID:       ${game.id}`);
  console.log(`Board:         ${game.gameOptions.boardName}`);
  console.log(`Modules:       ${Object.entries(game.gameOptions.expansions).filter(([, on]) => on).map(([name]) => name).join(', ')}`);
  console.log(`Seed:          ${config.seed}`);
  console.log(`First player:  ${game.first.id}`);
  console.log('Players:');
  for (const player of game.players) {
    console.log(`  ${player.id}  ${player.name}  (${player.color})`);
  }
}

main();
