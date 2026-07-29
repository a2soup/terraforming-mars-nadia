/**
 * Watch Nadia play Terraforming Mars against herself, in the Engine's own UI.
 *
 *   npx tsx agent/demo/spectate.ts --help
 *
 * A side quest, not part of the SRS or the Implementation Plan: everything it needs lives in
 * `agent/demo/`, and it neither modifies nor requires a modification to a single file outside
 * this directory. See README.md next door for how to drive it.
 *
 * How it works, in one paragraph: the Engine's web server and the agent's headless driver run
 * in the *same* Node process, over the *same* in-memory `IGame` object. The server never knows
 * a bot is playing - it just serves whatever the game currently says - and the driver never
 * knows anyone is watching. `GameLoader` is the meeting point: the game is added to its cache,
 * the HTTP routes read it from there, and the driver mutates it in place every couple of
 * seconds. Nothing is written to disk (the headless bootstrap installs a no-op Database), so
 * the game evaporates when you quit.
 */
import './bootstrap'; // must be first - see webServer.ts

import {spawn} from 'child_process';
import {PlayerId} from '@/common/Types';
import {GameLoader} from '@/server/database/GameLoader';
import {IGame} from '@/server/IGame';
import {createGame} from '../src/engine/gameFactory';
import {EmbeddedResponder} from '../src/driver/responder';
import {GameResult} from '../src/driver/gameResult';
import {createAgent} from './agents';
import {assertClientBuilt, ClientNotBuiltError} from './assets';
import {installKeyboardControls} from './controls';
import {DecisionInfo, PacedMatch} from './match';
import {agentListing, parseOptions, SpectateOptions, USAGE} from './options';

const RULE = '─'.repeat(72);

function seatResponders(game: IGame, options: SpectateOptions): Map<PlayerId, EmbeddedResponder> {
  const responders = new Map<PlayerId, EmbeddedResponder>();
  game.players.forEach((player, seat) => {
    // Each seat gets its own agent-RNG stream, so two random-legal Nadias don't play the same
    // moves as each other. Still fully reproducible from --agent-seed.
    const seated = createAgent(options.agents[seat], options.agentSeed + seat);
    // `PacedMatch` drives with `applyDecision` per seat rather than through one router, so it has
    // nowhere to hang the whole-game observer and the driver options a searching agent contributes
    // (hazard H4, `src/agents/registry.ts`). Such an agent still plays legally - its fork service
    // simply never sees a decision and it falls back - but it is not playing its real game, and
    // that is worth saying out loud rather than letting the demo quietly misrepresent it.
    if (seated.driverOptions !== undefined || seated.observeDecisions !== undefined) {
      console.warn(
        `[spectate] '${options.agents[seat]}' needs whole-game observation, which this paced demo driver ` +
        `does not provide - it will play its fallback moves here. Use 'npm run match' for a faithful game.`);
    }
    responders.set(player.id, seated.respond);
  });
  return responders;
}

function banner(game: IGame, options: SpectateOptions, url: string): string {
  const seats = game.players.map((player, i) => {
    const watched = i + 1 === options.seat ? '  <- you are watching this one' : '';
    return `   seat ${i + 1}  ${player.name.padEnd(12)}${player.color.padEnd(8)}${options.agents[i]}${watched}`;
  });

  return [
    RULE,
    ' Nadia self-play - base game + Corporate Era + Prelude, Tharsis',
    '',
    ...seats,
    '',
    `   engine seed ${options.seed} · agent seed ${options.agentSeed} · ${options.delayMs}ms per decision`,
    `   (same two seeds replay this exact game)`,
    '',
    ` Watch here:  ${url}`,
    '',
    ' p / space  pause or resume     s  step one decision (while paused)     q  quit',
    RULE,
  ].join('\n');
}

function describe(info: DecisionInfo): string {
  const who = `${info.playerName} (${info.color})`;
  const move = info.response === undefined ? '(driver fallback)' : summarize(info.response);
  return `  #${String(info.index).padStart(4)}  gen ${String(info.generation).padStart(2)}  ` +
    `${who.padEnd(22)}${info.decisionType.padEnd(14)}${move}`;
}

/** Move JSON is occasionally enormous (a full payment breakdown); keep the log to one line. */
function summarize(response: unknown): string {
  const json = JSON.stringify(response);
  return json.length <= 70 ? json : json.slice(0, 67) + '...';
}

function reportResult(game: IGame, result: GameResult, decisions: number): string {
  const nameOf = new Map<PlayerId, string>(game.players.map((player) => [player.id, player.name]));
  const winners = new Set(result.winners);
  const scores = [...result.players]
    .sort((a, b) => b.victoryPoints - a.victoryPoints)
    .map((player) => {
      const mark = winners.has(player.playerId) ? '  <- winner' : '';
      return `   ${(nameOf.get(player.playerId) ?? player.playerId).padEnd(12)}${String(player.victoryPoints).padStart(3)} VP${mark}`;
    });

  return [
    '',
    RULE,
    ` Game over: generation ${result.generation}, ${decisions} decisions.`,
    '',
    ...scores,
    RULE,
  ].join('\n');
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], {stdio: 'ignore', detached: true, shell: process.platform === 'win32'}).unref();
  } catch {
    // Not worth failing the run over - the URL is printed either way.
  }
}

async function main(): Promise<void> {
  const parsed = parseOptions(process.argv.slice(2));
  if (parsed.kind === 'help') {
    console.log(USAGE);
    return;
  }
  if (parsed.kind === 'list-agents') {
    console.log('Available agents:\n' + agentListing());
    return;
  }
  const options = parsed.options;

  assertClientBuilt();

  const game = createGame({
    players: options.players,
    seed: options.seed,
    playerNames: options.names,
  });
  // Put the game where the Engine's HTTP routes look for it. They then serve this exact
  // object - the same one the driver below is mutating - so the browser sees every move.
  await GameLoader.getInstance().add(game);

  const watched = game.players[options.seat - 1];
  // Loaded here rather than at the top of the file so `--help` and the missing-build error
  // don't have to boot the Engine's whole HTTP stack (which chatters on stdout as it loads).
  const {startWebServer} = await import('./webServer');
  const server = await startWebServer(options.port, watched.id);
  const url = `http://localhost:${options.port}/player?id=${watched.id}`;

  console.log(banner(game, options, url));
  if (options.open) {
    openBrowser(url);
  }

  let uninstallControls = () => {};
  const shutdown = (code: number) => {
    uninstallControls();
    server.close();
    process.exit(code);
  };

  const match = new PacedMatch(game, seatResponders(game, options), options.delayMs, {
    onDecision: (info) => console.log(describe(info)),
    onFinish: (result) => {
      console.log(reportResult(game, result, match.decisionCount));
      console.log(` The final board is still up at ${url} - press q or Ctrl-C to shut down.\n`);
    },
    onError: (error) => {
      console.error('\nThe game stopped early:', error);
      console.error(` The board is still up at ${url} for a post-mortem - press q or Ctrl-C to shut down.\n`);
    },
  });

  uninstallControls = installKeyboardControls({
    togglePause: () => {
      if (!match.isRunning) {
        return;
      }
      match.togglePause();
      console.log(match.isPaused ? '  -- paused (p to resume, s to step) --' : '  -- resumed --');
    },
    step: () => match.step(),
    quit: () => {
      match.stop();
      console.log('\nShutting down. The game is gone - nothing was saved.');
      shutdown(0);
    },
  });

  // Nothing else holds the process open once the match ends - the listening server does,
  // which is what leaves the final board viewable until you quit.
  match.start();
}

main().catch((error) => {
  if (error instanceof ClientNotBuiltError) {
    console.error('\n' + error.message);
  } else {
    console.error(error instanceof Error ? `\n${error.message}\n` : error);
  }
  process.exit(1);
});
