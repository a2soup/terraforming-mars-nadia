import {expect} from 'chai';
import {checkProcessIndependence, runConfigsInFreshProcess} from '../../src/determinism/childReplay';
import {replay} from '../../src/determinism/replay';
import {ReplayConfig, ReplayFingerprint} from '../../src/determinism/types';

/**
 * Milestone 1, bullet 6, sub-task B: process independence (P2). Spawns real `tsx` child
 * processes, so these are slower than the rest of the suite (child startup dominates - see
 * childReplay.ts's doc comment) but are the only thing in this bullet that actually tests a
 * fresh process, which nothing before this bullet ever did
 * (agent/docs/Milestone1_Bullet6_Prompts.md, "What is already known").
 */
describe('childReplay.ts (Milestone 1, bullet 6, sub-task B, P2)', function() {
  this.timeout(60_000);

  function key(config: ReplayConfig): string {
    return `${config.players}|${config.engineSeed}|${config.agentSeed}`;
  }

  it('a config replayed in a fresh process produces the same fingerprint as an in-process replay', () => {
    const config: ReplayConfig = {players: 2, engineSeed: 700000, agentSeed: 8000001};
    const inProcess = replay(config);
    const inProcessMap = new Map<string, ReplayFingerprint>([[key(config), inProcess]]);

    const report = checkProcessIndependence([config], inProcessMap);

    expect(report.configsChecked).to.equal(1);
    expect(report.mismatches, JSON.stringify(report.mismatches)).to.be.empty;
  });

  it('negative control: perturbing the agent seed by 1 before the child replay is flagged as a mismatch', () => {
    const config: ReplayConfig = {players: 2, engineSeed: 700977, agentSeed: 8000002};
    const inProcess = replay(config);

    // Perturb: the "cross-process" side actually replays a different agent seed, and the
    // in-process fingerprint is (deliberately, incorrectly) keyed as if it were the *original*
    // config. This proves checkProcessIndependence's comparison is live, not vacuously passing
    // regardless of input - exactly the negative control Milestone1_Bullet6_Prompts.md's
    // sub-task B calls for.
    const perturbed: ReplayConfig = {...config, agentSeed: config.agentSeed + 1};
    const inProcessMap = new Map<string, ReplayFingerprint>([[key(perturbed), inProcess]]);

    const report = checkProcessIndependence([perturbed], inProcessMap);

    expect(report.configsChecked).to.equal(1);
    expect(report.mismatches, 'perturbing the agent seed should be detected as a mismatch').to.not.be.empty;
    expect(report.mismatches[0].field).to.equal('moveTraceHash');
  });

  it('runConfigsInFreshProcess replays multiple configs in one child, in order', () => {
    const configs: ReadonlyArray<ReplayConfig> = [
      {players: 2, engineSeed: 701954, agentSeed: 8000003},
      {players: 3, engineSeed: 702931, agentSeed: 8000004},
    ];

    const fingerprints = runConfigsInFreshProcess(configs);

    expect(fingerprints).to.have.length(2);
    expect(fingerprints[0].config).to.deep.equal(configs[0]);
    expect(fingerprints[1].config).to.deep.equal(configs[1]);
    // Cross-check against in-process replays of the same two configs.
    expect(fingerprints[0].moveTraceHash).to.equal(replay(configs[0]).moveTraceHash);
    expect(fingerprints[1].moveTraceHash).to.equal(replay(configs[1]).moveTraceHash);
  });
});
