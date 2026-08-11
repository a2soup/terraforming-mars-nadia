import {expect} from 'chai';
import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LEDGER_GENESIS_DIGEST,
  RebaselineError,
  RebaselineLedger,
  appendRebaseline,
  assertRebaselineClaim,
  digestEntry,
  loadRebaselineLedger,
  verifyLedgerChain,
} from '../../src/regression/ledger';
import {agentRoot} from '../../src/regression/runner';
import {writeFastCorpus} from './helpers';

/**
 * The rebaseline ledger, and **criterion S7** (Milestone 2, bullet 5, Unit A §6/§7; §3.5).
 *
 * S7 is stated as *"demonstrated by attempting it"*, and the demonstration has to go **through the
 * CLI, on a real committed-shape artifact** - which is not a stylistic preference but the direct
 * lesson of bullet 3:
 *
 * > Two guards had specs, passed them, and had never once refused a real run ... Both found by
 * > *using* the CLI.
 *
 * `rating/seedBlocks.ts` spells out the mechanism: its specs asserted the refusal against a
 * `LadderLedger` built in memory, so they exercised every path except the one that reads the file
 * that actually exists - and the guard was off for a milestone while printing a warning that looked
 * like a missing file. So the four refusals below are spawned subprocesses, and only the arithmetic
 * that has no file in it is tested in process.
 */
describe('the rebaseline ledger (§3.5, criterion S7)', function() {
  this.timeout(600_000);

  let scratch: string;
  let corpusPath: string;
  let ledgerPath: string;

  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-rebaseline-'));
    // A trimmed copy of the committed smoke corpus: real shape, real entries, fast to replay. The
    // committed artifacts are never touched by these specs.
    corpusPath = writeFastCorpus(scratch);
    ledgerPath = path.join(scratch, 'regression_rebaselines.json');
  });

  after(() => {
    fs.rmSync(scratch, {recursive: true, force: true});
  });

  /**
   * Runs the real CLI in a child process, exactly as an operator would.
   *
   * `tsx` is resolved through Node's own resolution rather than by a relative path, because the
   * agent has no `node_modules` of its own - a git worktree resolves up to the main checkout's, and
   * a fixed `../node_modules` would work in one layout and not the other.
   */
  function cli(...args: ReadonlyArray<string>): {status: number | null; stdout: string; stderr: string} {
    const tsx = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    const result = spawnSync(process.execPath, [
      tsx,
      path.join(agentRoot(), 'src', 'runner', 'regressionCli.ts'),
      ...args,
    ], {cwd: agentRoot(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
  }

  // -------------------------------------------------------------------------------------------
  // S7: the refusal, through the CLI
  // -------------------------------------------------------------------------------------------

  it('refuses a bare --rebaseline, and says why regenerating is an event', () => {
    const result = cli('--rebaseline', '--corpus', corpusPath, '--ledger', ledgerPath);

    expect(result.status, 'a bare --rebaseline must exit non-zero').to.not.equal(0);
    expect(result.stderr).to.match(/--claim/);
    expect(result.stderr, 'the refusal has to name the frozen-baseline case, which is the one that matters')
      .to.match(/regression, not a rebaseline/);
    expect(fs.existsSync(ledgerPath), 'nothing may be written by a refused rebaseline').is.false;
  });

  it('refuses a claim too short to be a claim', () => {
    const result = cli('--rebaseline', '--corpus', corpusPath, '--ledger', ledgerPath, '--claim', 'fix');
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/too short to be a claim/);
    expect(fs.existsSync(ledgerPath)).is.false;
  });

  it('refuses before playing a single game, not after', () => {
    // The refusal is knowable from the arguments alone, and reaching it after minutes of replay
    // would train an operator to pass --claim "x" up front just to avoid the wait.
    const started = Date.now();
    cli('--rebaseline', '--corpus', corpusPath, '--ledger', ledgerPath);
    expect(Date.now() - started, 'the refusal should be argument-time, well under one game').is.lessThan(30_000);
  });

  it('succeeds with a claim, and the ledger carries what the *tool* measured', () => {
    const claim = 'Unit A: recording the smoke corpus for the first time, to exercise this path end to end.';
    const result = cli('--rebaseline', '--corpus', corpusPath, '--ledger', ledgerPath, '--claim', claim);

    expect(result.status, result.stderr).to.equal(0);
    const ledger = loadRebaselineLedger(ledgerPath) as RebaselineLedger;
    expect(ledger.entries).has.length(1);

    const entry = ledger.entries[0];
    expect(entry.claim).to.equal(claim);
    expect(entry.enginePin).to.equal('868714d72a434ab68fe08e5570ebc6863859ae15');
    expect(entry.previousDigest).to.equal(LEDGER_GENESIS_DIGEST);
    // Nothing had moved, so the tool says so - which is the point of computing it rather than
    // asking: a 0-of-4 rebaseline and a 4-of-4 rebaseline are different events.
    expect(entry.entriesMoved).to.equal(0);
    expect(entry.entriesTotal).to.equal(4);
    expect(entry.fieldsMoved).to.deep.equal({});
    expect(entry.corpusDigestBefore).to.equal(entry.corpusDigestAfter);
  });

  it('computes entriesMoved and fieldsMoved from the replay, not from the operator', () => {
    // Doctor two entries so the tool has something real to measure. This is also the negative
    // control for the whole rebaseline path: an implementation that recorded whatever it was told
    // would pass every assertion above and fail here.
    const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as {
      sections: Array<{entries: Array<{fingerprints: {moveTraceHash: string}; semantics: {seats: Array<{victoryPoints: number}>}}>}>;
    };
    corpus.sections[0].entries[0].fingerprints.moveTraceHash = '0'.repeat(64);
    corpus.sections[0].entries[1].semantics.seats[0].victoryPoints += 7;
    fs.writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));

    const result = cli('--rebaseline', '--corpus', corpusPath, '--ledger', ledgerPath,
      '--claim', 'Unit A: two entries doctored on purpose, to prove the ledger measures rather than transcribes.');

    expect(result.status, result.stderr).to.equal(0);
    const ledger = loadRebaselineLedger(ledgerPath) as RebaselineLedger;
    expect(ledger.entries).has.length(2);

    const entry = ledger.entries[1];
    expect(entry.entriesMoved).to.equal(2);
    expect(entry.entriesTotal).to.equal(4);
    expect(entry.fieldsMoved).to.deep.equal({
      'fingerprints.moveTraceHash': 1,
      'semantics.seats[].victoryPoints': 1,
    });
    expect(entry.corpusDigestBefore).to.not.equal(entry.corpusDigestAfter);
    // Chained, so a removed row is detectable.
    expect(entry.previousDigest).to.equal(digestEntry(ledger.entries[0]));
    expect(verifyLedgerChain(ledger)).to.deep.equal([]);
  });

  it('the rebaselined corpus now verifies clean - the regeneration actually wrote the new numbers', () => {
    const result = cli('--layer', 'l2', '--corpus', corpusPath, '--no-determinism');
    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.match(/L2 random-legal@1 \(frozen\): OK/);
  });

  it('--ledger prints the chain, and refuses one that has been edited', () => {
    const shown = cli('--ledger', ledgerPath, '--show-ledger');
    expect(shown.status).to.equal(0);
    expect(shown.stdout).to.match(/2 rebaseline\(s\)/);
    expect(shown.stdout, 'the two computed numbers lead, because they are the finding').to.match(/2\/4 entries moved/);

    const tampered = path.join(scratch, 'tampered.json');
    const ledger = loadRebaselineLedger(ledgerPath) as RebaselineLedger;
    fs.writeFileSync(tampered, JSON.stringify({
      ...ledger,
      entries: [{...ledger.entries[0], claim: 'a claim nobody ever made'}, ledger.entries[1]],
    }, null, 2));

    const broken = cli('--ledger', tampered, '--show-ledger');
    expect(broken.status, 'an edited row must be refused, not merely printed').to.not.equal(0);
    expect(broken.stderr).to.match(/CHAIN BROKEN/);
  });

  // Found by Unit D (criterion S7) by editing a ledger as an operator would, and the test above is
  // the reason it survived review: it edits entry 0 of two, which the per-entry chain does catch.
  // Nothing chained to the *last* entry, so on this project's one-entry ledger nothing was pinned
  // at all - and the next legitimate rebaseline would have chained onto the edited digest, making
  // the edit permanently self-consistent.
  it('refuses an edit to its own last entry - the row nothing chains to', () => {
    const tampered = path.join(scratch, 'tampered-head.json');
    const ledger = loadRebaselineLedger(ledgerPath) as RebaselineLedger;
    fs.writeFileSync(tampered, JSON.stringify({
      ...ledger,
      entries: [ledger.entries[0], {...ledger.entries[1], claim: 'a claim nobody ever made'}],
    }, null, 2));

    const broken = cli('--ledger', tampered, '--show-ledger');
    expect(broken.status, 'an edited last row must be refused too').to.not.equal(0);
    expect(broken.stderr).to.match(/CHAIN BROKEN/);
    expect(broken.stderr, 'and the message must name the head, not blame an earlier row').to.match(/most recent row/);
  });

  it('refuses a ledger carrying no headDigest at all, rather than computing one', () => {
    const headless = path.join(scratch, 'headless.json');
    const {headDigest: _headDigest, ...withoutHead} = loadRebaselineLedger(ledgerPath) as RebaselineLedger;
    fs.writeFileSync(headless, JSON.stringify(withoutHead, null, 2));

    const result = cli('--ledger', headless, '--show-ledger');
    expect(result.status, 'filling in the head from the rows would manufacture the agreement it checks').to.not.equal(0);
    expect(result.stderr).to.match(/no headDigest/);
  });

  it('refuses to append to a ledger whose chain is already broken', () => {
    const tampered = path.join(scratch, 'tampered.json');
    const result = cli('--rebaseline', '--corpus', corpusPath, '--ledger', tampered,
      '--claim', 'Unit A: appending to a tampered ledger, which must be refused.');
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.match(/chain is broken/);
  });

  // -------------------------------------------------------------------------------------------
  // The arithmetic, in process - no file, so no risk of testing the wrong shape
  // -------------------------------------------------------------------------------------------

  describe('the module', () => {
    it('distinguishes an absent ledger from an empty one', () => {
      // Conflating them is precisely how `rating/seedBlocks.ts`'s guard spent a milestone off: a
      // missing file means "never checked", an empty one means "checked, nothing rebaselined".
      expect(loadRebaselineLedger(path.join(scratch, 'nope.json'))).is.undefined;
      const empty = path.join(scratch, 'empty.json');
      fs.writeFileSync(empty, JSON.stringify({ledgerVersion: '1', entries: []}));
      expect(loadRebaselineLedger(empty)?.entries).to.deep.equal([]);
    });

    it('refuses a file that is present but is not a ledger, rather than reading it as empty', () => {
      const notALedger = path.join(scratch, 'not-a-ledger.json');
      fs.writeFileSync(notALedger, JSON.stringify({allocations: []}));
      expect(() => loadRebaselineLedger(notALedger)).to.throw(RebaselineError, /not a rebaseline ledger/);
    });

    it('digests independently of key order in fieldsMoved', () => {
      const base = {
        recordedAt: '2026-08-11T00:00:00.000Z', layer: 'l2' as const, claim: 'a claim long enough',
        agentCommit: 'abc', enginePin: 'def', entriesMoved: 2, entriesTotal: 4,
        previousDigest: LEDGER_GENESIS_DIGEST, corpusDigestBefore: '1', corpusDigestAfter: '2',
      };
      expect(digestEntry({...base, fieldsMoved: {a: 1, b: 2}}))
        .to.equal(digestEntry({...base, fieldsMoved: {b: 2, a: 1}}));
    });

    it('assertRebaselineClaim refuses undefined and whitespace', () => {
      expect(() => assertRebaselineClaim(undefined)).to.throw(RebaselineError);
      expect(() => assertRebaselineClaim('   ')).to.throw(RebaselineError);
      expect(() => assertRebaselineClaim('a properly written claim')).to.not.throw();
    });

    it('appendRebaseline chains onto whatever it is given', () => {
      const first = appendRebaseline(undefined, {
        layer: 'l2', claim: 'the first rebaseline of this ledger', agentCommit: 'a', enginePin: 'p',
        entriesMoved: 1, entriesTotal: 3, fieldsMoved: {'fingerprints.moveTraceHash': 1},
        corpusDigestBefore: 'x', corpusDigestAfter: 'y', recordedAt: '2026-08-11T00:00:00.000Z',
      });
      const second = appendRebaseline(first.ledger, {
        layer: 'l2', claim: 'the second rebaseline of this ledger', agentCommit: 'b', enginePin: 'p',
        entriesMoved: 0, entriesTotal: 3, fieldsMoved: {},
        corpusDigestBefore: 'y', corpusDigestAfter: 'y', recordedAt: '2026-08-11T01:00:00.000Z',
      });
      expect(second.entry.previousDigest).to.equal(digestEntry(first.entry));
      expect(verifyLedgerChain(second.ledger)).to.deep.equal([]);
    });
  });
});
