import {expect} from 'chai';
import {assertSweepIsManual} from '../../src/engine/headlessEngine';

/**
 * Milestone 1, bullet 6 (sub-task E): the isolation NFR-5 requires for hazard H2.
 *
 * Sub-task C established the mechanism with a positive control: under
 * `GAME_CACHE='sweep=auto;sweep_freq=1s;idle_age=1s'` plus one `GameLoader.add()`, a live game's
 * `gameLog` is emptied mid-play on a wall-clock schedule, `restoreGameLog` then sets it to
 * `undefined` against the headless no-op Database, and the next decision dies on
 * `Cannot read properties of undefined (reading 'push')`. Embedded play never calls `add()`
 * today, so the hazard is unreachable - but only because of a call nobody makes *yet*, and the
 * Milestone 5 live-play adapter is exactly the code that will start making it.
 *
 * `ensureHeadlessEngine` itself can't be exercised for this here: it is idempotent behind a
 * module-level `initialized` flag that the mocha harness has already tripped by the time any
 * spec runs, so a second call returns before reaching any guard. Testing the assertion directly
 * is what's actually available, and it covers the whole decision - the parse, the verdict, and
 * the message a developer will have to act on.
 */
describe('headlessEngine.ts - the GAME_CACHE sweep guard (bullet 6, hazard H2)', () => {
  const original = process.env.GAME_CACHE;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.GAME_CACHE;
    } else {
      process.env.GAME_CACHE = original;
    }
  });

  function withGameCache(value: string | undefined): void {
    if (value === undefined) {
      delete process.env.GAME_CACHE;
    } else {
      process.env.GAME_CACHE = value;
    }
  }

  it('permits an unset GAME_CACHE - the default, which parses to sweep: manual', () => {
    withGameCache(undefined);
    expect(() => assertSweepIsManual()).to.not.throw();
  });

  it('permits an explicit sweep=manual, and other GAME_CACHE settings that leave sweep alone', () => {
    withGameCache('sweep=manual;idle_age=1s');
    expect(() => assertSweepIsManual()).to.not.throw();

    // Tuning eviction ages without touching `sweep` is harmless: with sweep manual, nothing
    // ever calls Cache.sweep(), so no timer exists to act on those durations.
    withGameCache('eviction_age=30s;sweep_freq=10s');
    expect(() => assertSweepIsManual()).to.not.throw();
  });

  it('refuses sweep=auto, naming the hazard and the fix', () => {
    withGameCache('sweep=auto;sweep_freq=1s;idle_age=1s');

    expect(() => assertSweepIsManual()).to.throw(/sweep=auto/);
    expect(() => assertSweepIsManual()).to.throw(/CON-5\/NFR-5/);
    expect(() => assertSweepIsManual(), 'the message must tell the reader what to do about it').to.throw(/Unset GAME_CACHE or use sweep=manual/);
  });

  it('refuses sweep=auto wherever it appears in the `;`-separated list, not just first', () => {
    // parseConfigString (src/server/database/GameLoader.ts) splits on ';' and takes each
    // `key=value` in any order; a guard that only looked at a prefix would miss this and would
    // be worse than no guard - it would read as protection that isn't there.
    withGameCache('idle_age=1s;sweep_freq=1s;sweep=auto');
    expect(() => assertSweepIsManual()).to.throw(/sweep=auto/);
  });
});
