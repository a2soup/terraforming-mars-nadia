import {expect} from 'chai';
import {AGENTS, agentIdentity, agentNames, createAgent, DEFAULT_AGENT, formatIdentity, lookupAgent} from '../../src/agents/registry';
import * as demoAgents from '../../demo/agents';

/**
 * The registry is what makes "agent version" a recordable identity rather than an anonymous
 * closure (§3 question 1). Two things here are worth a standing check: that every entry's declared
 * `name` matches the key it is filed under (a mismatch would put the wrong identity in every
 * artifact that agent ever appears in), and that the demo roster is the same roster (hazard H10 -
 * two rosters that drift is the failure mode).
 */
describe('agent registry', () => {
  it('files every entry under its own declared name', () => {
    for (const name of agentNames()) {
      expect(AGENTS[name].name, `entry '${name}'`).to.equal(name);
    }
  });

  it('declares a version for every agent - AC-7 and the per-version AC-1 re-run key on it', () => {
    for (const name of agentNames()) {
      expect(AGENTS[name].version, `entry '${name}'`).to.be.a('string').and.not.equal('');
    }
  });

  it('carries the Milestone 1 baseline at version 1', () => {
    expect(agentIdentity('random-legal')).to.deep.equal({name: 'random-legal', version: '1'});
    expect(formatIdentity(lookupAgent('random-legal'))).to.equal('random-legal@1');
    expect(DEFAULT_AGENT).to.equal('random-legal');
  });

  it('names what is available when asked for an agent that is not', () => {
    expect(() => lookupAgent('heuristic')).to.throw('unknown agent \'heuristic\'');
    expect(() => lookupAgent('heuristic'), 'and lists what is').to.throw('random-legal');
  });

  it('creates a fresh responder per seat, seeded independently', () => {
    // Two seats at the same table must not share a responder object - a stateful agent would then
    // see both seats' decisions as one stream.
    expect(createAgent('random-legal', 1)).to.not.equal(createAgent('random-legal', 1));
  });

  it('is the same roster the demo uses (hazard H10)', () => {
    expect(demoAgents.AGENTS).to.equal(AGENTS);
    expect(demoAgents.DEFAULT_AGENT).to.equal(DEFAULT_AGENT);
  });
});
