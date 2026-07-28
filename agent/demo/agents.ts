/**
 * The roster of Nadias this demo can seat at the table.
 *
 * **This is now a re-export of the real registry** (`agent/src/agents/registry.ts`), not a roster
 * of its own. It used to be one: a `{description, create(seed)}` record that predated the match
 * harness. Milestone 2 bullet 1 needs a *versioned* agent identity - "agent version" has to be a
 * first-class, recordable thing, because AC-7's promotion gate and the per-version AC-1 re-run
 * both key on it - so the registry moved into `src/` where the runner can reach it, and this file
 * became a shim. Two rosters drifting apart is the failure mode the move exists to prevent
 * (Milestone2_Bullet1_Prompts.md, hazard H10).
 *
 * Adding a new agent is still a one-line entry - in `src/agents/registry.ts` now - and `--agents=`
 * still picks who plays which seat. Nothing else in the demo knows or cares which brain is in
 * which chair.
 */
export {AGENTS, DEFAULT_AGENT, agentNames, createAgent} from '../src/agents/registry';
export type {AgentEntry, AgentIdentity} from '../src/agents/registry';
