import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {TRACE_CHECKPOINT_INTERVAL, L2GameEntry, L2LayerResult, RegressionCorpus} from '../../src/regression/types';
import {entryKey} from '../../src/regression/corpus';
import {explainEntry, fixturesDir, runL1, runL2, stratify} from '../../src/regression/runner';
import {ensureHeadlessEngine} from '../../src/engine/headlessEngine';
import {loadSmoke} from './helpers';

/**
 * The runner and L3 triage (Milestone 2, bullet 5, Unit A §5).
 *
 * The three behaviours here that a reader will otherwise assume rather than check:
 *
 * 1. **L1 with no fixtures reports `empty`, never `ok`.** This is the bullet's second failure mode
 *    in its purest form - a layer that has never asserted anything, reporting green.
 * 2. **L2 refuses on a moved field and says which one**, rather than counting failures (§3.3).
 * 3. **L3 brackets the first divergence** from the committed trace checkpoints. Without them there
 *    is nothing to localize against, because the committed side of the window is code that no
 *    longer exists - so the check is that the bracket lands on the decision that actually moved.
 */
describe('the regression runner (§3.8) and L3 triage (§3.1)', function() {
  this.timeout(600_000);

  const corpus: RegressionCorpus = loadSmoke();
  let scratch: string;

  before(() => {
    ensureHeadlessEngine();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-regression-runner-'));
  });

  after(() => {
    fs.rmSync(scratch, {recursive: true, force: true});
  });

  /** The committed corpus reduced to the fast random-legal 2p entries, optionally doctored. */
  function fastCorpus(mutate: (entry: L2GameEntry) => void = () => {}): RegressionCorpus {
    const copy = JSON.parse(JSON.stringify(corpus)) as RegressionCorpus;
    const sections = copy.sections
      .filter((section) => section.agent === 'random-legal')
      .map((section) => ({...section, entries: section.entries.filter((entry) => entry.identity.players === 2)}));
    mutate(sections[0].entries[0] as L2GameEntry);
    return {...copy, sections};
  }

  // -------------------------------------------------------------------------------------------
  // L1
  // -------------------------------------------------------------------------------------------

  describe('L1', () => {
    it('reports "empty", not "ok", when Unit B has not landed its fixtures', function() {
      if (fs.existsSync(fixturesDir()) && fs.readdirSync(fixturesDir()).some((file) => file.endsWith('.spec.ts'))) {
        // Unit B has landed. The state this test is about no longer exists, and asserting the
        // opposite here would just re-test mocha.
        this.skip();
      }
      const result = runL1();
      expect(result.status, 'zero fixtures reporting "ok" is a suite that has never refused anything')
        .to.equal('empty');
      expect(result.fixtures).to.equal(0);
    });

    it('does not fail the suite on "empty"', function() {
      if (fs.existsSync(fixturesDir()) && fs.readdirSync(fixturesDir()).some((file) => file.endsWith('.spec.ts'))) {
        this.skip();
      }
      // Deliberate, and argued in runner.ts: a layer that is red for the three sessions between
      // Unit A and Unit B is a layer people learn to skip.
      expect(runL1().status).to.not.equal('failed');
    });

    it('runs real fixtures, parses mocha\'s report, and attributes the failure', () => {
      // **The path Unit B hits first, exercised before Unit B exists.** If the JSON parsing in
      // `parseMochaJson` were wrong, the symptom would be L1 reporting "mocha did not produce a
      // JSON report" on the day thirteen correct fixtures land - which reads as "the fixtures are
      // broken". Two scratch specs, one passing and one failing on purpose, settle it now.
      // `node:assert` rather than chai: these live in a scratch directory outside the repo, where
      // `chai` is not resolvable. (Finding: that produced a *correct* "mocha did not produce a JSON
      // report" the first time this spec ran, which is the other branch below.)
      const directory = fs.mkdtempSync(path.join(scratch, 'fixtures-'));
      fs.writeFileSync(path.join(directory, 'passing.spec.ts'),
        "import * as assert from 'node:assert';\n" +
        "describe('a reference position', () => {\n" +
        "  it('asserts the Engine number', () => { assert.strictEqual(48, 48); });\n" +
        '});\n');
      fs.writeFileSync(path.join(directory, 'failing.spec.ts'),
        "import * as assert from 'node:assert';\n" +
        "describe('a reference position', () => {\n" +
        "  it('asserts the printed number by mistake', () => { assert.strictEqual(48, 45); });\n" +
        '});\n');

      const result = runL1(directory);

      expect(result.status).to.equal('failed');
      expect(result.fixtures, 'both scratch specs should have been collected').to.equal(2);
      expect(result.failures).has.length(1);
      expect(result.failures[0].title).to.match(/asserts the printed number by mistake/);
      expect(result.failures[0].message).to.match(/48|45/);
      expect(result.failures[0].file).to.match(/failing\.spec\.ts$/);
    });

    it('reports "failed" with the stderr when mocha cannot run at all', () => {
      // The other half: a spec that does not compile produces no JSON report, and that has to be a
      // legible failure rather than a crash inside the parser.
      const directory = fs.mkdtempSync(path.join(scratch, 'broken-'));
      fs.writeFileSync(path.join(directory, 'broken.spec.ts'), 'this is not typescript(((\n');

      const result = runL1(directory);

      expect(result.status).to.equal('failed');
      expect(result.failures[0].message).to.have.length.greaterThan(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  // L2
  // -------------------------------------------------------------------------------------------

  describe('L2', () => {
    it('reproduces the committed entries', async () => {
      const result = await runL2(fastCorpus(), {skipDeterminism: true});
      expect(result.status).to.equal('ok');
      expect(result.sections[0].entriesChecked).to.equal(4);
      expect(result.sections[0].entriesMoved).to.equal(0);
      expect(result.determinismCorpus.status).to.equal('skipped');
    });

    it('refuses a doctored entry and names the field, not a count', async () => {
      // The negative control for the layer as a whole. A verifier that always said "ok" would pass
      // every other test in this file.
      const result = await runL2(fastCorpus((entry) => {
        (entry.semantics.seats[0] as {terraformRating: number}).terraformRating += 1;
      }), {skipDeterminism: true});

      expect(result.status).to.equal('failed');
      expect(result.sections[0].entriesMoved).to.equal(1);
      expect(result.sections[0].fieldsMoved).to.deep.equal({'semantics.seats[].terraformRating': 1});
      expect(result.sections[0].diffs[0].why, 'a red line carries the entry\'s why so it explains itself in place')
        .to.have.length.greaterThan(20);
    });

    it('selects one section by name, and refuses a name the corpus does not carry', async () => {
      const result = await runL2(corpus, {agent: 'random-legal@1', skipDeterminism: true});
      expect(result.sections.map((section) => section.agent)).to.deep.equal(['random-legal']);

      await runL2(corpus, {agent: 'nadia@7', skipDeterminism: true})
        .then(() => expect.fail('an unknown section should be refused'))
        .catch((error: Error) => expect(error.message).to.match(/no section 'nadia@7'/));
    });
  });

  // -------------------------------------------------------------------------------------------
  // L3
  // -------------------------------------------------------------------------------------------

  describe('L3 triage', () => {
    it('says so plainly when an entry currently reproduces', () => {
      const target = fastCorpus().sections[0].entries[0];
      expect(explainEntry(fastCorpus(), entryKey(target.identity)).diffs).to.deep.equal([]);
    });

    it('distinguishes "only the trace moved" from a semantic change', () => {
      const target = fastCorpus().sections[0].entries[0];
      const explanation = explainEntry(fastCorpus((entry) => {
        (entry.fingerprints as {moveTraceHash: string}).moveTraceHash = '0'.repeat(64);
      }), entryKey(target.identity));

      expect(explanation.diffs.filter((diff) => diff.group === 'semantics')).to.deep.equal([]);
      expect(explanation.diffs.map((diff) => diff.path)).to.deep.equal(['fingerprints.moveTraceHash']);
    });

    it('brackets the first divergence to the checkpoint window that contains it', () => {
      // Doctor the checkpoint at a known decision index. The bracket must be the window *ending* at
      // that checkpoint - i.e. it must name the interval the divergence is in, not the whole game.
      const source = fastCorpus();
      const target = source.sections[0].entries[0];
      const checkpoints = target.fingerprints.traceCheckpoints;
      expect(checkpoints.length, 'this entry needs at least three checkpoints to bracket anything')
        .to.be.greaterThan(2);
      const broken = checkpoints[1];

      const explanation = explainEntry(fastCorpus((entry) => {
        (entry.fingerprints as {moveTraceHash: string}).moveTraceHash = '0'.repeat(64);
        (entry.fingerprints.traceCheckpoints as unknown as Array<{hash: string}>)[1].hash = 'e'.repeat(64);
      }), entryKey(target.identity));

      const located = explanation.firstDivergence;
      expect(located, 'the trace moved and the entry has checkpoints, so it must localize').is.not.undefined;
      expect((located as NonNullable<typeof located>).lastAgreedDecision).to.equal(checkpoints[0].decisionIndex);
      expect((located as NonNullable<typeof located>).firstDisagreedDecision).to.equal(broken.decisionIndex);
      const window = (located as NonNullable<typeof located>).window;
      expect(window.length).to.equal(TRACE_CHECKPOINT_INTERVAL);
      expect(window[window.length - 1].index).to.equal(broken.decisionIndex);
      // The window carries the decisions themselves, so the report names moves rather than indices.
      expect(window[0].stepInput).to.be.a('string').with.length.greaterThan(0);
    });

    it('says it cannot localize, rather than silently not localizing, when there are no checkpoints', () => {
      const target = fastCorpus().sections[0].entries[0];
      const explanation = explainEntry(fastCorpus((entry) => {
        (entry.fingerprints as {moveTraceHash: string}).moveTraceHash = '0'.repeat(64);
        (entry.fingerprints as unknown as {traceCheckpoints: Array<unknown>}).traceCheckpoints = [];
      }), entryKey(target.identity));

      expect(explanation.firstDivergence).is.undefined;
      expect(explanation.localizationNote).to.match(/no trace checkpoints/);
    });

    it('refuses an entry key the corpus does not carry, and says what it does carry', () => {
      expect(() => explainEntry(corpus, 'nadia@7/2p/g6100/p0')).to.throw(/no entry 'nadia@7\/2p\/g6100\/p0'/);
    });
  });

  describe('is the delta confined to a stratum? (§3.1)', () => {
    it('reports a moved/checked ratio per agent version and per player count', async () => {
      const doctored = fastCorpus((entry) => {
        (entry.fingerprints as {resultHash: string}).resultHash = '0'.repeat(64);
      });
      const result: L2LayerResult = await runL2(doctored, {skipDeterminism: true});
      const rows = stratify(doctored, result);

      // The distinction the count alone cannot make: "1 of 4" is scattered, "4 of 4" is systematic.
      expect(rows.find((row) => row.stratum === 'random-legal@1')).to.deep.equal(
        {stratum: 'random-legal@1', moved: 1, checked: 4});
      expect(rows.find((row) => row.stratum === '2p')).to.deep.equal({stratum: '2p', moved: 1, checked: 4});
    });
  });
});
