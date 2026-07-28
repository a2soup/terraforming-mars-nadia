/**
 * The roster of Nadias this demo can seat at the table.
 *
 * Every agent is just an {@link EmbeddedResponder} - the one `decide(observation) -> action`
 * seam the whole project is built around (agent/CLAUDE.md §4) - so adding a smarter Nadia
 * later is a one-line entry here, and `--agents=` picks who plays which seat. Nothing else
 * in the demo knows or cares which brain is in which chair.
 */
import {randomLegalAgent} from '../src/core/randomLegalAgent';
import {createAgentRandom} from '../src/core/rng';
import {EmbeddedResponder} from '../src/driver/responder';

export type AgentEntry = {
  description: string;
  /**
   * `seed` is this seat's own agent-RNG seed, kept separate from the Engine seed (SRS CON-5).
   * A deterministic agent is free to ignore it.
   */
  create: (seed: number) => EmbeddedResponder;
};

export const AGENTS: Readonly<Record<string, AgentEntry>> = {
  'random-legal': {
    description: 'Uniformly random legal move at every decision (the Milestone 1 baseline).',
    create: (seed) => randomLegalAgent(createAgentRandom(seed)),
  },
  // Add smarter Nadias here as they arrive, e.g.
  //   'heuristic': {description: '...', create: (seed) => heuristicAgent(createAgentRandom(seed))},
};

export const DEFAULT_AGENT = 'random-legal';

export function agentNames(): Array<string> {
  return Object.keys(AGENTS);
}

export function createAgent(name: string, seed: number): EmbeddedResponder {
  const entry = AGENTS[name];
  if (entry === undefined) {
    throw new Error(`unknown agent '${name}'. Known agents: ${agentNames().join(', ')}`);
  }
  return entry.create(seed);
}
