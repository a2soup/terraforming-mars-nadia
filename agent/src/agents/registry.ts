import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
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

export type AgentEntry = AgentIdentity & {
  description: string;
  /**
   * `seed` is this seat's own agent-RNG seed, kept separate from the Engine seed (SRS CON-5).
   * A deterministic agent is free to ignore it. Must not construct `SeededRandom` directly
   * (hazard H6) - go through {@link createAgentRandom}, as `random-legal` does below.
   */
  create: (seed: number) => EmbeddedResponder;
};

export const AGENTS: Readonly<Record<string, AgentEntry>> = {
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

export function createAgent(name: string, seed: number): EmbeddedResponder {
  return lookupAgent(name).create(seed);
}

/** `random-legal@1` - the form used in run ids, CLI output and log lines. */
export function formatIdentity(identity: AgentIdentity): string {
  return `${identity.name}@${identity.version}`;
}
