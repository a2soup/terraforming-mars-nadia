# Watching Nadia play — `agent/demo`

A small, informal side quest: sit Nadia down opposite herself and watch the whole game play out
in the engine's own web UI, one move every two seconds, from one Nadia's own seat at the table.

It is **not** part of the SRS or the Implementation Plan, and nothing outside this directory was
added or changed to support it. Deleting `agent/demo/` removes it without a trace.

---

## 1. One-time setup

The demo serves the engine's real web client, so that client has to have been built at least
once. From the **repo root**:

```bash
npm run make:static
```

```bash
npm run make:cards
```

```bash
npx webpack --config agent/demo/webpack.config.js
```

Together those take well under a minute. You only need to repeat them if you change the engine's
UI code, styles, or cards.

> **Why not just `npm run build`?** In this repo that command currently produces no bundle at
> all. Webpack type-checks everything the root `tsconfig.json` includes, which sweeps in
> `agent/test/**`; those specs use Mocha's `describe`/`it`, which the root tsconfig doesn't
> declare, so the check fails with a few hundred errors and webpack refuses to emit. That is a
> pre-existing main-project issue, unrelated to this side quest and outside its remit to fix, so
> the demo carries its own config that inherits everything from the root one and just drops the
> type-checker. `agent/demo/webpack.config.js` says the same thing at more length.

## 2. Run it

From the repo root:

```bash
npx tsx agent/demo/spectate.ts
```

That's the whole thing. It will:

1. deal a fresh 2-player game (base game + Corporate Era + Prelude, Tharsis board),
2. start a local game server on port 8080,
3. open your browser on **Nadia-1's own view of the game**, and
4. start playing, one decision every two seconds, until somebody wins.

If a browser doesn't open by itself, the URL is printed in the terminal — it looks like
`http://localhost:8080/player?id=p-red`.

## 3. What you're looking at

It's the ordinary player screen, so everything works the way it does when you play: the board,
the log, milestones and awards, your production and resources, your cards. You are seeing it
**from Nadia-1's seat** — her hand is face up to you, Nadia-2's is not, and you see Nadia-2's
moves as they land in the log, exactly as you would against a human opponent.

Two things differ from a game you're playing yourself:

- **There are no buttons to press.** The action panel always reads *"Not your turn to take any
  actions"*, even during Nadia-1's turn. That's on purpose: the browser normally stops asking the
  server for updates the moment it's your turn (it's waiting for *you* to click), which would
  freeze the page forever here, since the move is going to be made by the agent instead. Handing
  the page a permanently read-only view keeps it refreshing all the way to the end — and means a
  stray click can't shove a move into the game you're watching.
- **Nothing is saved.** The game lives in memory only; no database, no files on disk. When you
  quit, it's gone. Re-run with the same two seeds to get it back (see §6).

Meanwhile the terminal prints a running move list, one line per decision:

```
  #  21  gen  3  Nadia-1 (red)         or            {"type":"or","index":1,"response":{"type":"projectCard","card":"Gre...
```

## 4. Controls (in the terminal, while it runs)

| Key | What it does |
| --- | --- |
| `p` or `space` | Pause / resume |
| `s` | While paused, play exactly one more decision |
| `q` or `Ctrl-C` | Quit and shut the server down |

Pausing is the useful one: the browser keeps showing the frozen position for as long as you like,
so you can scroll around the board and read the log without the game running away from you.

When the game ends the final scores are printed in the terminal and the browser flips to the
end-of-game screen. The server stays up so you can keep looking; press `q` when you're done.

## 5. Options

```bash
npx tsx agent/demo/spectate.ts --help
```

| Option | Default | |
| --- | --- | --- |
| `--players=N` | `2` | 2–4 Nadias at the table |
| `--agents=a,b` | all `random-legal` | which agent plays which seat (see `--list-agents`) |
| `--names=a,b` | `Nadia-1,Nadia-2` | what they're called on screen |
| `--seat=N` | `1` | whose view you watch |
| `--seed=N` | random | engine seed: the board and every shuffle |
| `--agent-seed=N` | random | the agents' own move choices |
| `--delay=MS` | `2000` | milliseconds per decision |
| `--port=N` | `8080` | if 8080 is busy |
| `--no-open` | | don't launch a browser, just print the URL |

A few worth knowing:

- **`--delay`** paces *decisions*, not turns. A single turn can be several decisions (pick the
  card, then pick how to pay for it, then pick where the tile goes), so a full game runs a few
  hundred decisions — a 2-player game came in at 328, about 11 minutes at the default.
  `--delay=500` makes it brisk; `--delay=0` runs it as fast as the engine can go, which is a
  good way to skip to the end and look at the final board.
- **`--seat=2`** watches the same game from the other Nadia's chair.

## 6. Replaying the same game

The seeds are printed in the banner at startup. Feed both back in and you get the identical
game — same board, same shuffles, same moves:

```bash
npx tsx agent/demo/spectate.ts --seed=4242 --agent-seed=99
```

The two seeds are deliberately independent (SRS CON-5): `--seed` is the engine's, controlling the
deal; `--agent-seed` is the agents', controlling what they do with it. Change one and hold the
other, and you can watch the same hand played differently, or different hands played by the same
Nadia.

## 7. Seating a smarter Nadia

The demo doesn't know anything about *how* an agent thinks — it only knows the project's one
decision seam, `decide(observation) -> action` (`EmbeddedResponder`). To make a new agent
available, add a line to `AGENTS` in [`agents.ts`](agents.ts):

```ts
'heuristic': {
  description: 'Milestone 2 heuristic evaluator.',
  create: (seed) => heuristicAgent(createAgentRandom(seed)),
},
```

and then seat it:

```bash
npx tsx agent/demo/spectate.ts --agents=heuristic,random-legal
```

Nothing else in the demo needs to change, and the seats are independent — heuristic vs. random,
heuristic vs. heuristic with different seeds, four-way mixtures, whatever.

## 8. How it works

The engine's web server and the agent's headless driver run in the **same Node process**, over
the **same in-memory `IGame` object**. `GameLoader`'s cache is the meeting point: the game is
added to it at startup, the engine's HTTP routes read it from there, and the driver mutates it in
place every couple of seconds. The server never learns that a bot is playing — it just serves
whatever the game currently says — and the driver never learns that anyone is watching.

That co-location is the point, not an accident. Nadia's legal-move enumerator needs the real
server-side `IPlayer` to work out what she can afford, which a purely HTTP-driven bot could not
see; running in-process gives her the true game object while the browser gets the true UI.

| File | |
| --- | --- |
| [`spectate.ts`](spectate.ts) | the entry point: parse, deal, serve, play |
| [`match.ts`](match.ts) | the paced loop — one `applyDecision` per tick, on a timer |
| [`webServer.ts`](webServer.ts) | the engine's own request handler, plus the read-only view |
| [`agents.ts`](agents.ts) | who's available to play |
| [`options.ts`](options.ts) | command line |
| [`controls.ts`](controls.ts) | pause / step / quit |
| [`assets.ts`](assets.ts) | "you haven't built the client yet" check |
| [`bootstrap.ts`](bootstrap.ts) | chdir + headless engine setup, imported before anything else |
| [`webpack.config.js`](webpack.config.js) | builds the UI (see §1) |

Pacing reuses `applyDecision` from `agent/src/driver/embeddedDriver.ts` rather than its `runGame`
loop, which would play the entire game in one synchronous burst and never let the server answer
the browser. Everything else about how a decision is resolved — the FR-9 fallback, deferred-action
draining, generation order — is the driver's, unchanged.

## 9. Caveats

- **Local only.** The server binds to `127.0.0.1`. It's a toy, not something to expose.
- **Random-legal Nadia plays badly.** She is a uniform sampler over legal moves, so expect a long,
  strange game and a low final score. That's the baseline behaving correctly, not a bug.
- **The occasional `[embeddedDriver] FR-9 fallback` warning** in the terminal is the driver's
  known, deliberate safety net firing (see its doc comment); the game carries on.
