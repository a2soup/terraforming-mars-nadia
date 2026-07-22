import {expect} from 'chai';
import {agentRandomFrom, createAgentRandom} from '../../src/core/rng';
import {ConstRandom} from '../../../src/common/utils/Random';

describe('AgentRandom', () => {
  it('is a pure function of its seed - same seed replays the same stream (Milestone 1 reproducibility, CON-5)', () => {
    const a = createAgentRandom(7);
    const b = createAgentRandom(7);
    const seqA = Array.from({length: 8}, () => a.next());
    const seqB = Array.from({length: 8}, () => b.next());
    expect(seqA).to.deep.equal(seqB);
  });

  it('produces different streams for different seeds', () => {
    const a = createAgentRandom(1);
    const b = createAgentRandom(2);
    expect(a.next()).to.not.equal(b.next());
  });

  it('rejects a non-integer or negative seed', () => {
    expect(() => createAgentRandom(-1)).to.throw();
    expect(() => createAgentRandom(1.5)).to.throw();
  });

  describe('nextInt', () => {
    it('stays within [0, range) across many draws', () => {
      const rng = createAgentRandom(3);
      for (let i = 0; i < 1000; i++) {
        const n = rng.nextInt(5);
        expect(n).to.be.at.least(0);
        expect(n).to.be.below(5);
        expect(Number.isInteger(n)).to.be.true;
      }
    });

    it('rejects a non-positive or non-integer range', () => {
      const rng = createAgentRandom(0);
      expect(() => rng.nextInt(0)).to.throw();
      expect(() => rng.nextInt(-2)).to.throw();
      expect(() => rng.nextInt(2.5)).to.throw();
    });
  });

  describe('intInRange', () => {
    it('is inclusive of both bounds', () => {
      // ConstRandom(0) forces the low end; ConstRandom just under 1 forces the high end.
      expect(agentRandomFrom(new ConstRandom(0)).intInRange(3, 9)).to.equal(3);
      expect(agentRandomFrom(new ConstRandom(0.999999)).intInRange(3, 9)).to.equal(9);
    });

    it('returns the sole value when min === max', () => {
      expect(createAgentRandom(1).intInRange(4, 4)).to.equal(4);
    });

    it('stays within [min, max] across many draws', () => {
      const rng = createAgentRandom(11);
      for (let i = 0; i < 1000; i++) {
        const n = rng.intInRange(-2, 2);
        expect(n).to.be.within(-2, 2);
      }
    });

    it('rejects inverted or non-integer bounds', () => {
      const rng = createAgentRandom(0);
      expect(() => rng.intInRange(5, 4)).to.throw();
      expect(() => rng.intInRange(0.5, 4)).to.throw();
    });
  });

  describe('pick', () => {
    it('returns an element of the array', () => {
      const items = ['a', 'b', 'c', 'd'] as const;
      const rng = createAgentRandom(5);
      for (let i = 0; i < 100; i++) {
        expect(items).to.include(rng.pick(items));
      }
    });

    it('can reach both the first and last element', () => {
      const items = ['first', 'mid', 'last'] as const;
      expect(agentRandomFrom(new ConstRandom(0)).pick(items)).to.equal('first');
      expect(agentRandomFrom(new ConstRandom(0.999999)).pick(items)).to.equal('last');
    });

    it('throws on an empty array', () => {
      expect(() => createAgentRandom(0).pick([])).to.throw();
    });
  });
});
