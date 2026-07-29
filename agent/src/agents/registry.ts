import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
import {EmbeddedDriverOptions} from '../driver/embeddedDriver';
import {EmbeddedResponder} from '../driver/responder';

/**
 * The named, versioned roster of agents the match runner can seat (Milestone 2, bullet 1, Unit A;
 * see agent/docs/Milestone2_Bullet1_Prompts.md §3 question 1).
 *
 * **Why a registry at all.** Before this file an agent was an anonymous closure: `demo/agents.ts`
 * had a small roster keyed by name, and everything else (`legality/run.ts`, `determinism/replay.ts`,
 * the benches) constructed `randomLegalAgent(createAgentRandom(seed))` inline. That is fine while
 * there is exactly one agent, and it stops being fine the moment two measurements have to be
 * *comparable*: "Nadia won 62% of 1,000 games" means nothing unless the record says which Nadia,
 * and a closure has no identity to record.
 *
 * **`version` is the load-bearing field, not `name`.** It is declared here, by hand, and written
 * into every match artifact. Two things key on it:
 *
 * - **AC-7 / FR-15's promotion gate** - "each promoted version beats the previous with
 *   significance" is a statement about two versions, so both have to be named in the evidence.
 * - **The AC-1 legality re-run** (agent/CLAUDE.md §6, standing caveat). AC-1 is agent-specific and
 *   expires on every new agent version: the Milestone 1 run found a real illegal-move defect that
 *   had hidden behind the FR-9 fallback since bullet 3, invisible at 20-game scale. A match record
 *   that says only `random-legal` cannot tell you whether the battery has been run against *this*
 *   `random-legal`.
 *
 * So: **bump `version` whenever the agent's move distribution can change** - a new evaluation
 * weight, a changed enumerator path, a different search budget - even if the name stays. A version
 * that silently covers two behaviours is worse than no version at all, because it makes two
 * incomparable runs look comparable. The registry cannot enforce this; it is a discipline, and
 * this paragraph is where it is written down.
 *
 * **Where the next entries go.** The greedy one-ply baseline (OSLA) is Milestone 2 bullet 2 and
 * belongs here as `'greedy-1ply'`; the M3 heuristic agent, the M4 search agent and every promoted
 * M6 network follow the same shape. Adding one is a single entry - nothing else in the runner
 * knows or cares which brain is in which seat, which is the whole point of the
 * `decide(observation) -> action` seam (agent/CLAUDE.md §4).
 */

/** The recordable identity of an agent: what a match artifact carries per seat. */
export type AgentIdentity = {
  name: string;
  version: string;
};

/**
 * **An agent as the runner seats it** (Milestone 2 bullet 2, Unit A; hazard H4 of
 * agent/docs/Milestone2_Bullet2_Prompts.md).
 *
 * Until this bullet an agent was exactly an {@link EmbeddedResponder}: a function from *its own*
 * decision to a move. A searching agent needs two things that shape cannot express, and both are
 * about the *game*, not about the seat:
 *
 * - **Driver options.** `search/fork.ts` records the response the Engine **accepted**, which is not
 *   always the one the responder returned - when the FR-9 fallback fires the driver submits
 *   something else entirely, and when the responder *throws* (~5.7 times per game, measured over
 *   1,500 games) it returns nothing at all. `EmbeddedDriverOptions.onFallback` is the only hook that
 *   reports the accepted response, and a responder has nowhere to hang one.
 * - **Every seat's decisions, not just its own.** The replay-from-quiescent-ancestor mechanism
 *   replays opponents' moves too, so the recorder has to observe the whole game.
 *   {@link observeDecisions} wraps the runner's *router* - the single responder the driver sees,
 *   dispatching on player id - so one wrapper covers every seat.
 *
 * **`agent/src/driver/` is not modified** to make this work (this bullet's §8: read and import
 * freely, wrap freely, modify nothing). The extension is here and in `match/runner.ts`, and both are
 * no-ops for an agent that supplies neither field - which is the whole of `random-legal@1`, so its
 * artifacts are byte-identical before and after.
 */
export type SeatedAgent = {
  /** Answers this seat's decisions. The old `create` return value, unchanged. */
  respond: EmbeddedResponder;
  /**
   * Merged into the options `playMatchGame` passes to `runGame`. `onFallback` composes - the
   * runner's own counters run first, then each agent's, in seat order.
   */
  driverOptions?: EmbeddedDriverOptions;
  /**
   * Wraps the driver's responder (in a match, the seat router) so this agent observes **every**
   * decision in the game, including other seats'. Must forward the response unchanged and rethrow
   * unchanged - the driver cannot be allowed to tell the difference.
   */
  observeDecisions?: (inner: EmbeddedResponder) => EmbeddedResponder;
};

export type AgentEntry = AgentIdentity & {
  description: string;
  /**
   * `seed` is this seat's own agent-RNG seed, kept separate from the Engine seed (SRS CON-5).
   * A deterministic agent is free to ignore it. Must not construct `SeededRandom` directly
   * (hazard H6) - go through {@link createAgentRandom}, as `random-legal` does below.
   *
   * Returning a bare {@link EmbeddedResponder} is the ordinary case and stays the whole contract
   * for a non-searching agent. An agent that needs to observe the game returns a
   * {@link SeatedAgent} instead; the two are told apart by `typeof`, so no existing entry changes.
   *
   * **Called once per game** (`playMatchGame`), so an agent may keep per-game state - a fork
   * service, a recorded move list, a belief model - in the closure it returns.
   */
  create: (seed: number) => EmbeddedResponder | SeatedAgent;
};

/** Normalizes either `create` return shape to a {@link SeatedAgent}. */
export function asSeatedAgent(created: EmbeddedResponder | SeatedAgent): SeatedAgent {
  return typeof created === 'function' ? {respond: created} : created;
}

const REGISTRY: Record<string, AgentEntry> = {
  'random-legal': {
    name: 'random-legal',
    // Version 1 is the agent the Milestone 1 AC-1 run (docs/AC1_Legality_Run.md) adjudicated,
    // *including* the initial project-card budget cap that run produced. Anything that changes
    // which move the enumerator samples changes this number.
    version: '1',
    description: 'Uniformly random legal move at every decision (the Milestone 1 baseline).',
    create: (seed) => randomLegalAgent(createAgentRandom(seed)),
  },
  // Milestone 2 bullet 2 adds the greedy one-ply baseline here:
  //   'greedy-1ply': {name: 'greedy-1ply', version: '1', description: '...', create: (seed) => ...},
};

/** The roster. A read-only view of {@link REGISTRY}, which {@link withTemporaryAgent} can add to. */
export const AGENTS: Readonly<Record<string, AgentEntry>> = REGISTRY;

/**
 * Registers `entry` for the duration of `fn`, then removes it. Returns whatever `fn` returns.
 *
 * **This exists for verification code that must seat an agent the roster does not permanently
 * carry, and it has exactly one production caller: criterion R8's equivalence check**
 * (`match/legality.ts`). That check has to make the match runner and the Milestone-1
 * `runLegalityBatch` play the *same* game, and the two construct agents differently - the oracle
 * builds one `randomLegalAgent` and lets every player draw from its single RNG stream, while the
 * match runner builds one agent per seat from that seat's own seed. The bridge is a fact about
 * `randomLegalAgent`: it holds no state but its `AgentRandom`, so **n per-seat agents sharing one
 * `AgentRandom` are behaviourally identical to one shared agent**. An entry whose `create` hands
 * every seat an agent bound to the same stream therefore reproduces the oracle's game exactly -
 * while leaving the runner's real per-seat construction and seat router fully in place, which is
 * the whole point (the earlier version of that check replaced the router and so could not test it).
 *
 * Deliberately narrow: it mutates process-global state, so it is not a general extension point.
 * A permanent agent belongs in {@link REGISTRY} above, where `--list-agents` will show it and a
 * version number pins its behaviour. Registering over an existing name throws rather than
 * shadowing it - a silent shadow would make two runs of the same lineup name incomparable, which
 * is precisely what the `version` discipline above exists to prevent.
 */
export async function withTemporaryAgent<T>(entry: AgentEntry, fn: () => Promise<T>): Promise<T> {
  if (REGISTRY[entry.name] !== undefined) {
    throw new Error(`withTemporaryAgent: '${entry.name}' is already registered; pick a name that cannot shadow a real agent.`);
  }
  REGISTRY[entry.name] = entry;
  try {
    return await fn();
  } finally {
    delete REGISTRY[entry.name];
  }
}

export const DEFAULT_AGENT = 'random-legal';

export function agentNames(): Array<string> {
  return Object.keys(AGENTS);
}

/** The registry entry for `name`, or a throw naming what is actually available. */
export function lookupAgent(name: string): AgentEntry {
  const entry = AGENTS[name];
  if (entry === undefined) {
    throw new Error(`unknown agent '${name}'. Known agents: ${agentNames().join(', ')}`);
  }
  return entry;
}

/** The `{name, version}` pair recorded per seat in a match artifact. */
export function agentIdentity(name: string): AgentIdentity {
  const {name: agentName, version} = lookupAgent(name);
  return {name: agentName, version};
}

/**
 * Builds the agent registered as `name` for one seat of one game, normalized to a
 * {@link SeatedAgent}.
 *
 * **Returns the seated shape rather than a bare responder deliberately.** A caller that took only
 * the responder would silently discard a searching agent's driver options and its whole-game
 * observer, and the symptom would be a fork service with an empty replay list - i.e. an agent that
 * quietly stops being able to fork, not one that fails.
 */
export function createAgent(name: string, seed: number): SeatedAgent {
  return asSeatedAgent(lookupAgent(name).create(seed));
}

/** `random-legal@1` - the form used in run ids, CLI output and log lines. */
export function formatIdentity(identity: AgentIdentity): string {
  return `${identity.name}@${identity.version}`;
}
