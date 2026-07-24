import {expect} from 'chai';
import {benchEnvironment, measure, silenceConsole, summarize} from '../../src/bench/harness';

/**
 * Correctness of the bench harness itself (Milestone 1, bullet 5, sub-task A). This spec
 * covers the instrument's own statistics and console handling - no timing assertions, per the
 * spike's "benchmarks are not tests" rule (Milestone1_Bullet5_Prompts.md shared preamble).
 */
describe('bench harness', () => {
  describe('summarize', () => {
    it('computes min/median/p95/max/mean on an odd-length sample', () => {
      const stats = summarize('odd', [5, 1, 3, 2, 4]);
      expect(stats.label).to.equal('odd');
      expect(stats.n).to.equal(5);
      expect(stats.min).to.equal(1);
      expect(stats.median).to.equal(3);
      expect(stats.max).to.equal(5);
      expect(stats.mean).to.equal(3);
      expect(stats.totalMs).to.equal(15);
    });

    it('computes the median as the mean of the two middle values on an even-length sample', () => {
      const stats = summarize('even', [10, 20, 30, 40]);
      expect(stats.n).to.equal(4);
      expect(stats.median).to.equal(25); // mean of the sorted middle pair (20, 30)
    });

    it('handles a single-element sample', () => {
      const stats = summarize('single', [7]);
      expect(stats.n).to.equal(1);
      expect(stats.min).to.equal(7);
      expect(stats.median).to.equal(7);
      expect(stats.p95).to.equal(7);
      expect(stats.max).to.equal(7);
      expect(stats.mean).to.equal(7);
    });

    it('computes p95 by the nearest-rank method (sorted[ceil(0.95 * n) - 1])', () => {
      const samples = Array.from({length: 20}, (_, i) => i + 1); // 1..20
      const stats = summarize('p95', samples);
      // ceil(0.95 * 20) - 1 = 18, 0-indexed -> value 19
      expect(stats.p95).to.equal(19);
    });

    it('does not mutate the input sample', () => {
      const samples = [5, 1, 3, 2, 4];
      summarize('unmutated', samples);
      expect(samples).to.deep.equal([5, 1, 3, 2, 4]);
    });
  });

  describe('measure', () => {
    it('calls its function exactly warmup + iterations times, and excludes warm-up from the sample', () => {
      let calls = 0;
      const stats = measure('calls', 10, () => {
        calls++;
      }, {warmup: 3});
      expect(calls).to.equal(13);
      expect(stats.n).to.equal(10);
    });

    it('uses the default warm-up count when none is given', () => {
      let calls = 0;
      const stats = measure('default-warmup', 5, () => {
        calls++;
      });
      // defaultWarmup(5) = min(3, ceil(5/10)) = 1
      expect(calls).to.equal(6);
      expect(stats.n).to.equal(5);
    });
  });

  describe('silenceConsole', () => {
    it('suppresses console.log/warn/error and counts by stream', () => {
      const {counts} = silenceConsole(() => {
        console.log('one');
        console.log('two');
        console.warn('three');
        console.error('four');
      });
      expect(counts.log).to.equal(2);
      expect(counts.warn).to.equal(1);
      expect(counts.error).to.equal(1);
    });

    it('increments the matched count for a known noise pattern', () => {
      const {counts} = silenceConsole(() => {
        console.log('Marking g-nadia-1 to be evicted');
      });
      expect(counts.matched.cacheMark).to.equal(1);
    });

    it('restores console.log to the original function identity when the wrapped function throws', () => {
      const original = console.log;
      expect(() => {
        silenceConsole(() => {
          console.log('this gets swallowed');
          throw new Error('boom');
        });
      }).to.throw('boom');
      expect(console.log).to.equal(original);
    });

    it('restores console.warn and console.error identity on the success path too', () => {
      const originalWarn = console.warn;
      const originalError = console.error;
      silenceConsole(() => {
        console.warn('x');
        console.error('y');
      });
      expect(console.warn).to.equal(originalWarn);
      expect(console.error).to.equal(originalError);
    });
  });

  describe('benchEnvironment', () => {
    it('returns a populated object with a plausible runtime', () => {
      const env = benchEnvironment();
      expect(env.nodeVersion).to.be.a('string').and.not.empty;
      expect(env.platform).to.be.a('string').and.not.empty;
      expect(env.cores).to.be.a('number').and.greaterThan(0);
      expect(['tsx', 'compiled']).to.include(env.runtime);
      expect(env.enginePin).to.be.a('string').and.not.empty;
      expect(env.timestamp).to.be.a('string').and.not.empty;
    });

    it('does not throw when invoked (including in an environment without a usable git binary)', () => {
      expect(() => benchEnvironment()).to.not.throw();
    });
  });
});
