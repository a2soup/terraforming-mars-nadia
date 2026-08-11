import {expect} from 'chai';
import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {RegressionCorpus} from '../../src/regression/types';
import {agentRoot} from '../../src/regression/runner';
import {entryKey} from '../../src/regression/corpus';
import {writeFastCorpus} from './helpers';

/**
 * **What `--explain` says when no semantic field moved** (Milestone 2, bullet 5; §3.1's L3 triage).
 *
 * `runner.spec.ts` covers `explainEntry` - the *data* L3 produces. This file covers the sentence
 * the CLI prints from it, which is a different thing and is where the defect was: the branch
 * announcing *"the trace moved and no semantic field did"* was gated on `semantics.length === 0`
 * alone, so it also fired when `moveTraceHash` was untouched and `stableStateHash` moved by itself.
 * It then told the operator the game *"took a different route to an identical outcome"* about the
 * one case that is its exact opposite - the same route, to a different state.
 *
 * Found by Unit D, and not by accident: its M1 mutation (a card's `behavior` production value)
 * moves `stableStateHash` **and nothing else**, which is the only mutation of the eleven that lands
 * on that branch. A triage layer whose headline sentence is inverted on the one class of change it
 * is most likely to see is worse than one that prints nothing, because it sends the reader looking
 * for an ordering change that is not there.
 *
 * So both branches are pinned here, through the CLI, on a real corpus file - the two doctored
 * fields differing only in *which* fingerprint field moves.
 */
describe('--explain, when no semantic field moved', function() {
  this.timeout(600_000);

  let scratch: string;

  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-explain-'));
  });

  after(() => {
    fs.rmSync(scratch, {recursive: true, force: true});
  });

  function cli(...args: ReadonlyArray<string>): {status: number | null; stdout: string; stderr: string} {
    const tsx = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
    const result = spawnSync(process.execPath, [
      tsx,
      path.join(agentRoot(), 'src', 'runner', 'regressionCli.ts'),
      ...args,
    ], {cwd: agentRoot(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
  }

  /**
   * A fast corpus with exactly one fingerprint field of its first entry doctored, so replaying it
   * moves that field and no other. Returns the path and the key to explain.
   */
  function corpusWithDoctoredField(name: string, field: 'moveTraceHash' | 'stableStateHash'): {path: string; key: string} {
    const corpusPath = writeFastCorpus(scratch, name);
    const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as RegressionCorpus;
    const entry = corpus.sections[0].entries[0];
    (entry.fingerprints as unknown as Record<string, string>)[field] = '0'.repeat(64);
    fs.writeFileSync(corpusPath, JSON.stringify(corpus, null, 2));
    return {path: corpusPath, key: entryKey(entry.identity)};
  }

  it('says the game took a different route when the trace is what moved', () => {
    const {path: corpusPath, key} = corpusWithDoctoredField('trace-moved.json', 'moveTraceHash');
    const result = cli('--explain', key, '--corpus', corpusPath);

    expect(result.status, result.stderr).to.equal(0);
    expect(result.stdout).to.match(/different route to an identical outcome/);
  });

  it('says the *route* was unchanged when the trace did not move and the end state did', () => {
    const {path: corpusPath, key} = corpusWithDoctoredField('state-moved.json', 'stableStateHash');
    const result = cli('--explain', key, '--corpus', corpusPath);

    expect(result.status, result.stderr).to.equal(0);
    // The defect: this is the branch that used to claim a different route was taken.
    expect(result.stdout, 'the trace did not move, so nothing may claim it did')
      .to.not.match(/different route/);
    expect(result.stdout).to.match(/decision sequence is unchanged and the end state is not/);
    // And it must point away from the agent, which is the actionable half - the same moves
    // producing different values is a card/cost/parameter change, not an ordering one.
    expect(result.stdout).to.match(/card, a cost or a parameter/);
  });
});
