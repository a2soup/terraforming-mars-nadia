import {expect} from 'chai';
import {AGENTS, AgentEntry, agentIdentity, agentNames, createAgent, DEFAULT_AGENT, formatIdentity, lookupAgent, withTemporaryAgent} from '../../src/agents/registry';
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

  // The seam criterion R8's equivalence check needs: it seats an agent whose seats share one RNG
  // stream, so the match runner and the Milestone-1 oracle play the same game with the runner's
  // real per-seat router still in place (`match/legality.ts`).
  describe('withTemporaryAgent', () => {
    const probe: AgentEntry = {
      name: 'test-temporary-probe',
      version: '0-probe',
      description: 'registered only for the duration of one test.',
      create: () => () => { throw new Error('never invoked'); },
    };

    it('registers for the duration of the call and removes it afterwards', async () => {
      expect(agentNames()).to.not.include(probe.name);

      const seenInside = await withTemporaryAgent(probe, async () => agentNames().includes(probe.name));

      expect(seenInside, 'visible while registered').to.be.true;
      expect(agentNames(), 'removed afterwards').to.not.include(probe.name);
      expect(() => lookupAgent(probe.name)).to.throw(/unknown agent/);
    });

    it('removes the entry even when the body throws', async () => {
      await withTemporaryAgent(probe, () => Promise.reject(new Error('boom'))).then(
        () => expect.fail('expected the rejection to propagate'),
        (error: Error) => expect(error.message).to.equal('boom'));

      expect(agentNames()).to.not.include(probe.name);
    });

    it('refuses to shadow a real agent rather than silently replacing it', async () => {
      // A silent shadow would make two runs of the same lineup name incomparable - exactly what the
      // `version` discipline exists to prevent.
      const shadow: AgentEntry = {...probe, name: DEFAULT_AGENT};

      await withTemporaryAgent(shadow, () => Promise.resolve()).then(
        () => expect.fail('expected a throw'),
        (error: Error) => expect(error.message).to.match(/already registered/));

      expect(AGENTS[DEFAULT_AGENT].version, 'the real entry is untouched').to.equal(agentIdentity(DEFAULT_AGENT).version);
    });
  });
});
