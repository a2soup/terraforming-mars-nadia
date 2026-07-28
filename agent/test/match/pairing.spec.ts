import {expect} from 'chai';
import {
  AGENT_SEED_BASE,
  AGENT_SEED_SLOT_STRIDE,
  AGENT_SEED_STRIDE,
  ENGINE_SEED_BASE,
  ENGINE_SEED_STRIDE,
  buildMatchConfigs,
  defaultRunId,
  groupsForGames,
  permutationsFor,
  resolveMatchSpec,
} from '../../src/match/pairing';

/**
 * The pairing design (Milestone2_Bullet1_Prompts.md §4.1) is what makes a win rate mean something,
 * so what is asserted here is the *properties* the design claims - every slot sits in every seat,
 * the engine seed is shared within a group and unique across groups, the two seed spaces stay
 * independent, and the config list is a pure function of the specification - rather than the
 * literal numbers a re-implementation would also produce.
 */
describe('match pairing (§4.1)', () => {
  describe('permutations', () => {
    it('plays every seat permutation at 2p and 3p', () => {
      expect(permutationsFor(2)).to.deep.equal([[0, 1], [1, 0]]);
      expect(permutationsFor(3)).to.have.length(6);
      expect(new Set(permutationsFor(3).map((p) => p.join(''))).size).to.equal(6);
    });

    it('uses the 4 cyclic rotations at 4p, not all 24 permutations', () => {
      expect(permutationsFor(4)).to.deep.equal([
        [0, 1, 2, 3],
        [1, 2, 3, 0],
        [2, 3, 0, 1],
        [3, 0, 1, 2],
      ]);
    });

    it('gives every slot every seat equally often - the balance property, at every player count', () => {
      for (const players of [2, 3, 4] as const) {
        const permutations = permutationsFor(players);
        const expectedPerSlot = permutations.length / players;
        for (const seat of [...Array(players).keys()]) {
          const timesInThisSeat = [...Array(players).keys()].map((slot) =>
            permutations.filter((seating) => seating[seat] === slot).length);
          expect(timesInThisSeat, `${players}p seat ${seat}`)
            .to.deep.equal(new Array(players).fill(expectedPerSlot));
        }
      }
    });
  });

  describe('the config list', () => {
    const spec = {players: 2 as const, lineup: ['random-legal', 'random-legal'], groups: 3};

    it('is groups x permutations games, group-major', () => {
      const configs = buildMatchConfigs(spec);
      expect(configs).to.have.length(6);
      expect(configs.map((c) => c.groupIndex)).to.deep.equal([0, 0, 1, 1, 2, 2]);
      expect(configs.map((c) => c.permutationIndex)).to.deep.equal([0, 1, 0, 1, 0, 1]);
    });

    it('shares one engine seed across a group and never reuses it across groups', () => {
      const configs = buildMatchConfigs({...spec, groups: 50});
      const byGroup = new Map<number, Set<number>>();
      for (const config of configs) {
        byGroup.set(config.groupIndex, (byGroup.get(config.groupIndex) ?? new Set()).add(config.engineSeed));
      }
      expect([...byGroup.values()].every((seeds) => seeds.size === 1), 'one seed per group').to.be.true;
      expect(new Set(configs.map((c) => c.engineSeed)).size, 'and one group per seed').to.equal(50);
    });

    it('travels the agent seed with the lineup slot, not the seat (§4.1)', () => {
      const [first, second] = buildMatchConfigs(spec);
      // Same group, mirrored seating: slot 0 leads in one game and follows in the other, with the
      // same seed both times. That is what "the seed travels with the slot" means, and it is what
      // removes "the agent got a different seed" as an explanation for a within-group difference.
      expect(second.seating).to.deep.equal([...first.seating].reverse());
      expect(second.agentSeeds).to.deep.equal(first.agentSeeds);
      expect(first.agentSeeds[0]).to.not.equal(first.agentSeeds[1]);
    });

    it('keeps the engine and agent seed spaces independent (SRS CON-5)', () => {
      const configs = buildMatchConfigs({...spec, groups: 100});
      // Not "different numbers" - not a *function* of each other. If agentSeed were engineSeed plus
      // a constant, every difference below would be the same number.
      const differences = new Set(configs.map((c) => c.agentSeeds[0] - c.engineSeed));
      expect(differences.size).to.be.greaterThan(1);
      expect(configs[0].engineSeed).to.equal(ENGINE_SEED_BASE);
      expect(configs[0].agentSeeds[0]).to.equal(AGENT_SEED_BASE);
      expect(configs[0].agentSeeds[1]).to.equal(AGENT_SEED_BASE + AGENT_SEED_SLOT_STRIDE);
    });

    it('never collides a slot seed from one group with a slot seed from another', () => {
      // 4 slots x 149 must stay inside one group's stride, or two different games would share an
      // agent seed by accident rather than by design.
      expect(4 * AGENT_SEED_SLOT_STRIDE).to.be.lessThan(AGENT_SEED_STRIDE);
      const configs = buildMatchConfigs({players: 4, lineup: new Array(4).fill('random-legal'), groups: 200});
      const seeds = configs.flatMap((c) => c.agentSeeds);
      expect(new Set(seeds).size).to.equal(200 * 4);
    });

    it('stays clear of the seed spaces Milestone 1 already played, so match games are new games', () => {
      // determinism/sweep.ts: 500,000 + 977k. legality/seeds.ts: 700,000 + 1,009k (k < 1,500).
      // coverage/playSweep.ts: 9,000,011 + 1,301k. All well below this run's base.
      expect(ENGINE_SEED_BASE).to.be.greaterThan(9_000_011 + 1_500 * 1_301);
      expect(AGENT_SEED_BASE).to.be.greaterThan(13_000_003 + 1_500 * 2_663);
      expect(ENGINE_SEED_STRIDE).to.not.equal(AGENT_SEED_STRIDE);
    });

    it('is a pure function of the specification - same spec in, same list out', () => {
      expect(buildMatchConfigs(spec)).to.deep.equal(buildMatchConfigs(spec));
    });

    it('is serializable, because Unit C ships these to child processes', () => {
      const configs = buildMatchConfigs(spec);
      expect(JSON.parse(JSON.stringify(configs))).to.deep.equal(configs);
    });

    it('continues an earlier run rather than replaying it when startGroup is set', () => {
      const continued = buildMatchConfigs({...spec, startGroup: 3});
      const original = buildMatchConfigs(spec);
      expect(continued[0].groupIndex).to.equal(3);
      expect(original.map((c) => c.engineSeed)).to.not.include(continued[0].engineSeed);
      expect(continued[0].engineSeed).to.equal(ENGINE_SEED_BASE + 3 * ENGINE_SEED_STRIDE);
    });
  });

  describe('resolveMatchSpec', () => {
    it('records the registry version per slot, which is what AC-7 keys on', () => {
      const resolved = resolveMatchSpec({players: 2, lineup: ['random-legal', 'random-legal'], groups: 1});
      expect(resolved.lineup).to.deep.equal([
        {name: 'random-legal', version: '1'},
        {name: 'random-legal', version: '1'},
      ]);
      expect(resolved.permutationsPerGroup).to.equal(2);
      expect(resolved.games).to.equal(2);
    });

    it('rejects a lineup that does not fill the table, rather than playing something else', () => {
      expect(() => resolveMatchSpec({players: 3, lineup: ['random-legal'], groups: 1}))
        .to.throw('expected 3 entries');
    });

    it('rejects an unknown agent before any game is played', () => {
      expect(() => resolveMatchSpec({players: 2, lineup: ['random-legal', 'nope'], groups: 1}))
        .to.throw('unknown agent');
    });
  });

  describe('groupsForGames', () => {
    it('rounds up, never down - a partly-played group is an unbalanced sample', () => {
      expect(groupsForGames(1000, 2)).to.equal(500);
      expect(groupsForGames(999, 2)).to.equal(500);
      expect(groupsForGames(601, 3)).to.equal(101);
    });
  });

  describe('defaultRunId', () => {
    it('is deterministic and names both versions, so R2 is not defeated by the id', () => {
      const spec = resolveMatchSpec({players: 2, lineup: ['random-legal', 'random-legal'], groups: 500});
      expect(defaultRunId(spec)).to.equal(defaultRunId(spec));
      expect(defaultRunId(spec)).to.equal('2p_random-legal@1_vs_random-legal@1_g0-499');
    });
  });
});
