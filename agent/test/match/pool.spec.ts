import {expect} from 'chai';
import {reportsMatch, stripTimingFields} from '../../src/match/artifact';
import {buildMatchConfigs, resolveMatchSpec} from '../../src/match/pairing';
import {mergeInstrumentation, runMatchPool, shardConfigs, syntheticFailureRecord} from '../../src/match/pool';
import {runMatch} from '../../src/match/runner';
import {MatchGameConfig, MatchInstrumentationReport, MatchSpec} from '../../src/match/types';

/**
 * The process pool (Milestone 2 bullet 1, Unit C, §4.5). What matters here, in order:
 *
 * - **R6 first, per §4.5's own instruction**: a pooled run must be byte-identical to the
 *   single-process run of the same specification, modulo the declared timing fields. That is
 *   checked end to end below by actually spawning child processes and comparing against
 *   `runMatch`'s own output via `artifact.ts`'s `reportsMatch` - the same equality R2 is stated on.
 * - The pure sharding and merge logic (`shardConfigs`, `mergeInstrumentation`) is checked in
 *   isolation, without spawning anything, so those properties are fast to verify and easy to see
 *   fail for the right reason.
 * - **H8 at the shard level**: a child that dies mid-shard must not lose the shard's games or
 *   abort the run. `syntheticFailureRecord`'s shape is checked directly; the end-to-end version
 *   (an actually-killed child) is checked once, via a deliberately hostile `env`
 *   (`GAME_CACHE=sweep=auto`, which `headlessEngine.ts`'s own guard refuses to bootstrap under -
 *   see hazard H2), because that is a real, cheap way to make a child die before writing a result
 *   without adding a test-only crash hook to `poolChild.ts`.
 *
 * The R7 throughput measurement (games/s at 1/2/4/8 workers against the pre-committed 5x-at-8
 * threshold) is not a unit-test concern - it needs the compiled build (hazard H5) and is reported
 * in the bullet's write-up, not asserted here.
 */
describe('match pool (§4.5)', function() {
  // Spawns real (tsx) child processes; slower than the rest of the suite by construction.
  this.timeout(180_000);

  describe('shardConfigs', () => {
    const configsFor = (groups: number, players: 2 | 3 | 4 = 2): {configs: ReadonlyArray<MatchGameConfig>; permutationsPerGroup: number} => {
      const resolved = resolveMatchSpec({players, lineup: new Array(players).fill('random-legal'), groups});
      return {configs: buildMatchConfigs(resolved), permutationsPerGroup: resolved.permutationsPerGroup};
    };

    it('splits into contiguous, whole-group shards that reassemble to the original order', () => {
      const {configs, permutationsPerGroup} = configsFor(10);
      const shards = shardConfigs(configs, 10, permutationsPerGroup, 3);

      expect(shards.flat()).to.deep.equal(configs, 'concatenating the shards in order reproduces buildMatchConfigs\' own order');

      const seen = new Set<number>();
      for (const shard of shards) {
        expect(shard.length % permutationsPerGroup).to.equal(0, 'a shard is never a partial group');
        const groupIndexesInShard = new Set(shard.map((config) => config.groupIndex));
        expect(groupIndexesInShard.size).to.equal(shard.length / permutationsPerGroup, 'each group in a shard appears fully');
        for (const groupIndex of groupIndexesInShard) {
          expect(seen.has(groupIndex), `group ${groupIndex} appears in more than one shard`).to.be.false;
          seen.add(groupIndex);
        }
      }
      expect(seen.size).to.equal(10, 'every group in the run is covered exactly once');
    });

    it('never produces more shards than groups, and never an empty shard', () => {
      const {configs, permutationsPerGroup} = configsFor(3);
      const shards = shardConfigs(configs, 3, permutationsPerGroup, 8);
      expect(shards).to.have.length(3);
      expect(shards.every((shard) => shard.length > 0)).to.be.true;
    });

    it('divides as evenly as possible when groups do not divide workers exactly', () => {
      const {configs, permutationsPerGroup} = configsFor(10);
      const shards = shardConfigs(configs, 10, permutationsPerGroup, 3);
      const groupCounts = shards.map((shard) => shard.length / permutationsPerGroup);
      expect(groupCounts.sort((a, b) => b - a)).to.deep.equal([4, 3, 3]);
    });

    it('one worker gives back the whole config list as a single shard', () => {
      const {configs, permutationsPerGroup} = configsFor(5);
      const shards = shardConfigs(configs, 5, permutationsPerGroup, 1);
      expect(shards).to.have.length(1);
      expect(shards[0]).to.deep.equal(configs);
    });
  });

  describe('mergeInstrumentation (§4.6\'s merge semantics)', () => {
    it('sums cause counts by signature and keeps one representative', () => {
      const a: MatchInstrumentationReport = {
        causes: [
          {source: 'fallback-probe', decisionType: 'payment', errorClass: 'InputError', signature: 'x', count: 3, representative: 'first seen'},
        ],
      };
      const b: MatchInstrumentationReport = {
        causes: [
          {source: 'fallback-probe', decisionType: 'payment', errorClass: 'InputError', signature: 'x', count: 5, representative: 'second seen'},
          {source: 'responder', decisionType: 'space', errorClass: 'Error', signature: 'y', count: 1, representative: 'only one'},
        ],
      };
      const merged = mergeInstrumentation([a, b]);
      expect(merged).to.not.be.undefined;
      const xTally = merged!.causes!.find((c) => c.signature === 'x');
      expect(xTally?.count).to.equal(8, 'counts sum across children');
      expect(xTally?.representative).to.equal('first seen', 'the representative is kept, not overwritten');
      expect(merged!.causes!.find((c) => c.signature === 'y')?.count).to.equal(1);
      // Most-frequent-first, same ordering rule `submissionMonitor.ts` uses.
      expect(merged!.causes!.map((c) => c.signature)).to.deep.equal(['x', 'y']);
    });

    it('preserves every child\'s detail rather than guessing how to combine it', () => {
      const merged = mergeInstrumentation([{detail: {bytesPerGame: 42}}, {detail: {bytesPerGame: 51}}]);
      expect(merged?.detail).to.deep.equal({perWorker: [{bytesPerGame: 42}, {bytesPerGame: 51}]});
    });

    it('is undefined when no child produced anything (the plain summary-tier, non-legality case)', () => {
      expect(mergeInstrumentation([undefined, undefined])).to.be.undefined;
    });

    it('drops nothing when only some children produced a report', () => {
      const merged = mergeInstrumentation([undefined, {causes: [{source: 'responder', decisionType: 'space', errorClass: 'Error', signature: 'z', count: 2, representative: 'r'}]}]);
      expect(merged?.causes).to.have.length(1);
    });
  });

  describe('syntheticFailureRecord (H8 at the shard level)', () => {
    it('carries full seat identity so a dead child\'s games are still attributable', () => {
      const spec: MatchSpec = {players: 2, lineup: ['random-legal', 'random-legal'], groups: 1};
      const [config] = buildMatchConfigs(spec);
      const record = syntheticFailureRecord(config, 'child process died');

      expect(record.completed).to.be.false;
      expect(record.failure).to.deep.equal({errorClass: 'ChildProcessFailure', message: 'child process died'});
      expect(record.seats).to.have.length(2);
      expect(record.seats.every((seat) => seat.agent === 'random-legal' && seat.agentVersion === '1')).to.be.true;
      expect(record.seats.every((seat) => seat.outcome === undefined)).to.be.true;
      expect(record.groupIndex).to.equal(config.groupIndex);
      expect(record.seating).to.deep.equal(config.seating);
    });
  });

  describe('runMatchPool end to end', () => {
    const spec: MatchSpec = {players: 2, lineup: ['random-legal', 'random-legal'], groups: 4};

    it('produces the exact same report the single-process runner does (criterion R6)', async () => {
      // Both need the same runId for the comparison to be meaningful - `runId` defaults
      // deterministically from the spec (`defaultRunId`), so pinning it explicitly here just
      // fixes what would already match between two default runs.
      const [single, pooled] = await Promise.all([
        runMatch(spec, {runId: 'pool-spec-r6', silenceRoutineLogs: true}),
        runMatchPool(spec, {workers: 2, runId: 'pool-spec-r6', silenceRoutineLogs: true}),
      ]);

      expect(pooled.games).to.have.length(8);
      expect(pooled.summary.completed).to.equal(8);
      expect(reportsMatch(single, pooled), 'identical modulo the declared timing fields').to.be.true;
      expect(JSON.stringify(stripTimingFields(single))).to.equal(JSON.stringify(stripTimingFields(pooled)));
    });

    it('preserves group-major order in the output regardless of shard boundaries', async () => {
      const pooled = await runMatchPool(spec, {workers: 3, silenceRoutineLogs: true});
      const order = pooled.games.map((game) => [game.groupIndex, game.permutationIndex]);
      const sorted = [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      expect(order).to.deep.equal(sorted);
    });

    it('a child that cannot bootstrap does not abort the run - its games are recorded as failures, not lost (H8)', async () => {
      const report = await runMatchPool(spec, {
        workers: 2,
        silenceRoutineLogs: true,
        // headlessEngine.ts's own guard (hazard H2) refuses to bootstrap under sweep=auto, so
        // every game in every child dies before it starts - a cheap, real way to exercise "the
        // child process never wrote a result" without a test-only hook in poolChild.ts.
        env: {...process.env, GAME_CACHE: 'sweep=auto'},
      });

      expect(report.games).to.have.length(8);
      expect(report.summary.completed).to.equal(0);
      expect(report.summary.failed).to.equal(8);
      expect(report.games.every((game) => game.failure?.errorClass === 'ChildProcessFailure')).to.be.true;
      expect(report.games.every((game) => game.seats.length === 2)).to.be.true;
    });
  });
});
