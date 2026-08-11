import {expect} from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import {IGame} from '@/server/IGame';
import {createAgentRandom} from '../../src/core/rng';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {loadCorpus, verifyCorpus} from '../../src/determinism/corpus';
import {defaultReplayAgent, replay} from '../../src/determinism/replay';
import {ReplayConfig} from '../../src/determinism/types';
import {ensureHeadlessEngine} from '../../src/engine/headlessEngine';

/**
 * **The guard on §3.9's one structural change** (Milestone 2, bullet 5, Unit A §4;
 * agent/docs/Milestone2_Bullet5_Prompts.md, hazard H2).
 *
 * `determinism/replay.ts` hard-coded `randomLegalAgent(createAgentRandom(...))`, which is why
 * `greedy-1ply@1` - one of the two frozen yardsticks every AC-3 claim is stated against - has no
 * fixed-seed standing check of any kind (§2.1). The regression suite's L2 layer needs the same
 * fingerprint over a *named* agent, so `replay()` now takes an optional agent factory.
 *
 * The change is required to be **additive**, and "additive" here has a checkable meaning rather
 * than a stylistic one: **the 300 fingerprints committed in `docs/data/determinism_corpus.json`
 * must still verify, byte for byte.** That corpus is the artifact-of-record for Milestone 1 bullet
 * 6 and the oracle every future comparison is made against; if parameterizing this function moved
 * even one of its configs, the parameterization changed behaviour and the right response is to stop
 * and report, not to regenerate (falsifiable prediction 7, and §3.5's whole reason for existing).
 *
 * The 300-config re-verification is the slow half and is marked so it can be selected on its own:
 *
 * ```bash
 * cd agent && npx mocha --import=tsx --require ../tests/testing/setup.ts "test/regression/replayAgent.spec.ts" --grep "300 committed"
 * ```
 */
describe('replay() takes an agent (Milestone 2 bullet 5, §3.9)', function() {
  this.timeout(120_000);

  before(() => {
    ensureHeadlessEngine();
  });

  const config: ReplayConfig = {players: 2, engineSeed: 500_000, agentSeed: 1_000_003};

  it('the default is the random-legal agent, and naming it explicitly changes nothing', () => {
    const implicit = replay(config);
    const explicit = replay(config, {agent: defaultReplayAgent});

    expect(explicit.moveTraceHash).to.equal(implicit.moveTraceHash);
    expect(explicit.stableStateHash).to.equal(implicit.stableStateHash);
    expect(explicit.resultHash).to.equal(implicit.resultHash);
    expect(explicit.decisions).to.equal(implicit.decisions);
    expect(explicit.fallbacks).to.equal(implicit.fallbacks);
  });

  it('the seam is real: a factory that seeds differently produces a different fingerprint', () => {
    // The negative control this whole file needs. A parameterization that quietly ignored its
    // factory would pass every assertion above *and* the 300-config check below, and would then
    // silently fingerprint L2's named agents as random-legal - the single worst outcome available
    // here, because the suite would look green while pinning the wrong agent.
    const different = replay(config, {
      agent: ({config: replayed}) => randomLegalAgent(createAgentRandom(replayed.agentSeed + 1)),
    });

    expect(different.moveTraceHash).to.not.equal(replay(config).moveTraceHash);
  });

  it('onGameEnd sees the finished game, before the fingerprint is built', () => {
    let seen: IGame | undefined;
    let generationAtCallback: number | undefined;

    const fingerprint = replay(config, {
      onGameEnd: (game, result) => {
        seen = game;
        generationAtCallback = result.generation;
      },
    });

    expect(seen, 'onGameEnd should have fired exactly once, with the game').is.not.undefined;
    // Read off the live game, which is the point: L2 commits semantic fields (§3.3) that exist
    // nowhere in a `ReplayFingerprint` and cannot be recovered from one.
    expect((seen as IGame).players).has.length(2);
    expect(generationAtCallback).to.equal(fingerprint.generation);
  });

  it('is a no-op for callers that pass neither option', () => {
    // `replay()`'s pre-bullet-5 signature, called exactly as `determinismCli.ts` and
    // `determinism/sweep.ts` still call it.
    const fingerprint = replay(config);
    expect(fingerprint.decisions).to.be.greaterThan(0);
    expect(fingerprint.config).to.deep.equal(config);
  });

  /**
   * The one that matters. Slow by construction - 300 full games - and deliberately not reduced to a
   * sample: the corpus is 300 configs because Milestone 1 bullet 6 chose 300, and a guard that
   * checked 30 of them would leave 270 configs' worth of the claim unmade.
   */
  it('re-verifies the 300 committed determinism fingerprints with zero mismatches', function() {
    this.timeout(3_600_000);
    const corpusFile = path.join(__dirname, '..', '..', 'docs', 'data', 'determinism_corpus.json');
    if (!fs.existsSync(corpusFile)) {
      throw new Error(`${corpusFile} is missing, and it is the oracle this parameterization is checked against (§3.9)`);
    }

    const report = verifyCorpus(loadCorpus(corpusFile));

    expect(report.configsChecked).to.equal(300);
    expect(
      report.mismatches.map((mismatch) =>
        `${mismatch.config.players}p/${mismatch.config.engineSeed}/${mismatch.config.agentSeed} ${mismatch.field}: ` +
        `${JSON.stringify(mismatch.expected)} -> ${JSON.stringify(mismatch.actual)}`),
      'parameterizing replay() moved a committed fingerprint, so the change was not additive (H2). ' +
      'Do not regenerate the corpus - report it (§3.5).',
    ).to.deep.equal([]);
  });
});
