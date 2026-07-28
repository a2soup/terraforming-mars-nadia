/**
 * The Engine's own web UI, served from this process.
 *
 * This is a trimmed-down `src/server/server.ts`: it hands every request to the Engine's real
 * `processRequest`, so the routes, the Vue client and the card art are all exactly what you'd
 * get from `npm run start`. The only difference is that the game being served is the one this
 * process is driving in memory (see `spectate.ts`), and that the watched seat's view is made
 * read-only on the way out (see {@link makeSeatReadOnly}).
 *
 * NOTE: `./bootstrap` is imported first on purpose - it chdirs to the repo root, which the
 * Engine's asset routes depend on at *import* time (`ServeAsset.INSTANCE` is a static field
 * that reads build/styles.css as soon as the module loads).
 */
import './bootstrap';

import * as http from 'http';
import {PlayerId} from '@/common/Types';
import {Request} from '@/server/Request';
import {Response} from '@/server/Response';
import {processRequest} from '@/server/server/requestProcessor';

/**
 * Rewrites the JSON body a handler is about to send. `writeJson` (src/server/server/responses.ts)
 * ends the response with a single uncompressed JSON string, so a per-request patch of `end` is
 * enough - no streaming or content-encoding to worry about.
 */
function interceptJson(res: http.ServerResponse, transform: (json: any) => any): void {
  const originalEnd = res.end.bind(res);
  (res as any).end = (data?: unknown, ...rest: Array<unknown>) => {
    if (typeof data === 'string' && String(res.getHeader('Content-Type') ?? '').includes('application/json')) {
      try {
        data = JSON.stringify(transform(JSON.parse(data)));
      } catch {
        // Not the JSON we expected - send it through untouched.
      }
    }
    return (originalEnd as any)(data, ...rest);
  };
}

/**
 * Turns the watched seat's first-person view into a *spectator* view of that seat, by lying
 * about two responses - and only for that one player id.
 *
 * Why this is needed at all: the client only polls for updates while it is **not** its turn
 * (`WaitingFor.vue`'s `mounted()` re-arms the poll only when `waitingFor` is undefined, and its
 * `GO` branch hands control to the human). In a normal game that's right - the browser stops
 * asking "anything new?" because it's now the human's move. Here the move is made by the agent
 * inside this process a couple of seconds later, so a browser parked on `GO` would sit frozen
 * on a stale prompt forever and never see the rest of the game.
 *
 * So: strip `waitingFor` from the watched seat's player model, and downgrade its `GO` to
 * `REFRESH`. The browser then behaves exactly as it does for a player who is waiting on
 * everyone else - it keeps polling, and it re-renders every time the game moves. Everything
 * else about the view is untouched: it is still that player's own first-person view, with
 * their hand, their cards and their private information visible, and the opponents' hands
 * hidden, because it is still the Engine's real `api/player` response for that player id.
 *
 * A welcome side effect: with no `waitingFor`, the page renders no input controls, so a stray
 * click can't inject a move into the game you're watching.
 */
function makeSeatReadOnly(req: Request, res: http.ServerResponse, watchedSeat: PlayerId): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.searchParams.get('id') !== watchedSeat) {
    return;
  }
  switch (url.pathname) {
  case '/api/player':
    interceptJson(res, (json) => ({...json, waitingFor: undefined}));
    break;
  case '/api/waitingfor':
    interceptJson(res, (json) => (json?.result === 'GO' ? {...json, result: 'REFRESH'} : json));
    break;
  default:
    break;
  }
}

/**
 * Starts the Engine's web server on `port`, bound to loopback only - this is a local
 * spectating toy, not something to put on a network.
 */
export function startWebServer(port: number, watchedSeat: PlayerId): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    makeSeatReadOnly(req as Request, res, watchedSeat);
    processRequest(req as Request, res as Response);
  });

  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE' ?
        new Error(`port ${port} is already in use - is another game server running? Try --port=<other>.`) :
        error);
    });
    server.listen({port, host: '127.0.0.1'}, () => resolve(server));
  });
}
