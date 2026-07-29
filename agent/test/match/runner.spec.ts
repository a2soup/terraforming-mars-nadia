import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {Player} from '../../../src/server/Player';
import {createGame} from '../../src/engine/gameFactory';
import {
  defaultOutputDir,
  loadMatchArtifact,
  reportsMatch,
  resolveOutputPath,
  saveMatchArtifact,
  stripTimingFields,
} from '../../src/match/artifact';
import {buildMatchConfigs} from '../../src/match/pairing';
import {mergeDriverOptions, playMatchGame, runMatch, seatPlayerId, wilson95} from '../../src/match/runner';
import {MatchRunReport, MatchSpec} from '../../src/match/types';
import {AgentEntry, withTemporaryAgent} from '../../src/agents/registry';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom} from '../../src/core/rng';

/**
 * The runner end to end, at a scale that keeps the suite fast. The large validation runs (R1's
 * >=500 pairing groups, R5's 3p and 4p samples) belong to Unit D; what is checked here is that the
 * machinery those runs depend on works: per-seat routing, the record schema being populated from a
 * real finished game, reproducibility (R2 at small scale), and the H8 failure policy.
 */
describe('match runner', function() {
  this.timeout(180_000);

  const twoPlayer: MatchSpec = {players: 2, lineup: ['random-legal', 'random-legal'], groups: 2};

  describe('seat identity', () => {
    it('derives the same player ids gameFactory assigns', () => {
      // `seatIdentities` needs the ids before the game exists (so a game that fails to *build*
      // still records who was seated). That duplicates gameFactory's `p-${color}` convention, and
      // this is the check that keeps the two in step.
      const game = createGame({players: 4, seed: 21_000_017});
      expect(game.players.map((player, seat) => player.id === seatPlayerId(seat))).to.deep.equal([true, true, true, true]);
    });
  });

  describe('a single game', () => {
    it('seats each lineup slot where the permutation says, and records both identities', () => {
      const configs = buildMatchConfigs({players: 2, lineup: ['random-legal', 'random-legal'], groups: 1});
      const mirrored = playMatchGame(configs[1]);

      expect(mirrored.completed).to.be.true;
      expect(mirrored.seats.map((seat) => seat.slot), 'permutation 1 is the mirror').to.deep.equal([1, 0]);
      expect(mirrored.seats.map((seat) => seat.agentVersion)).to.deep.equal(['1', '1']);
      expect(mirrored.seats[0].agentSeed, 'slot 1 keeps its own seed in seat 0')
        .to.equal(configs[1].agentSeeds[1]);
    });

    it('populates every field the §4.3 consumer table lists', () => {
      const [config] = buildMatchConfigs(twoPlayer);
      const record = playMatchGame(config);

      expect(record.completed).to.be.true;
      expect(record.generation, 'a "completed" game that ended in generation 1 is not a real game').to.be.greaterThan(3);
      expect(record.decisions).to.be.greaterThan(50);

      for (const seat of record.seats) {
        const outcome = seat.outcome;
        expect(outcome, `seat ${seat.seat}`).to.not.be.undefined;
        if (outcome === undefined) {
          continue;
        }
        expect(outcome.placement).to.be.within(1, 2);
        expect(outcome.terraformRating).to.be.at.least(20);
        expect(outcome.vpBreakdown.total).to.equal(outcome.victoryPoints);
        expect(outcome.corporations, 'bullet 4 needs the corporation per seat').to.have.length(1);
        expect(outcome.projectCards.length, 'and the cards played').to.be.greaterThan(0);
        expect(outcome.victoryPointsByGeneration.length, 'the per-generation VP curve M3 and AC-8 want')
          .to.be.greaterThan(1);
      }
      expect(record.seats.filter((seat) => seat.outcome?.isWinner === true).length).to.be.at.least(1);
      // Milestones and awards are optional in any one game, but they must be attributed to a real
      // seat when they do occur - a -1 here would mean the player-id lookup broke.
      expect([...record.claimedMilestones, ...record.fundedAwards].every((entry) => entry.seat >= 0)).to.be.true;
    });
  });

  describe('a small match', () => {
    it('plays every group and permutation, and summarizes by slot and by seat', async () => {
      const report = await runMatch(twoPlayer, {silenceRoutineLogs: true});

      expect(report.summary.games).to.equal(4);
      expect(report.summary.completed).to.equal(4);
      expect(report.summary.balancedGroups).to.equal(2);
      expect(report.header.spec.lineup.map((identity) => identity.version)).to.deep.equal(['1', '1']);
      expect(report.header.incompleteGroupPolicy).to.equal('excluded-from-balanced-statistics');
      expect(report.header.provenance.engineCommit).to.equal('868714d72a434ab68fe08e5570ebc6863859ae15');

      // Each slot played every game; each seat was occupied in every game. With ties possible, the
      // two slots' wins sum to at least the number of games.
      expect(report.summary.bySlot.map((slot) => slot.games)).to.deep.equal([4, 4]);
      expect(report.summary.bySeat.map((seat) => seat.games)).to.deep.equal([4, 4]);
      expect(report.summary.bySlot[0].wins + report.summary.bySlot[1].wins).to.be.at.least(4);
      expect(report.summary.bySlot[0].placementCounts.reduce((a, b) => a + b, 0)).to.equal(4);
    });

    it('supports 3p with placement recorded per seat (AC-5)', async () => {
      const report = await runMatch({players: 3, lineup: new Array(3).fill('random-legal'), groups: 1}, {silenceRoutineLogs: true});

      expect(report.summary.games).to.equal(6);
      expect(report.summary.completed).to.equal(6);
      expect(report.summary.permutationsPerGroup).to.equal(6);
      for (const game of report.games) {
        const placements = game.seats.map((seat) => seat.outcome?.placement);
        expect(placements).to.have.length(3);
        expect(Math.min(...placements.map((p) => p ?? 0))).to.equal(1);
      }
      expect(report.summary.bySlot.every((slot) => slot.placementCounts.length === 3)).to.be.true;
    });

    it('reproduces its records exactly on a second run (criterion R2, at small scale)', async () => {
      const first = await runMatch(twoPlayer, {silenceRoutineLogs: true});
      const second = await runMatch(twoPlayer, {silenceRoutineLogs: true});

      expect(reportsMatch(first, second), 'identical modulo the declared timing fields').to.be.true;
      // And the timing fields really are the only difference - a check that would fail if the
      // strip list quietly grew to cover a genuine divergence.
      expect(JSON.stringify(first)).to.not.equal(JSON.stringify(second));
      expect(first.games[0].durationMs).to.be.a('number');
    });
  });

  describe('a failing game (hazard H8)', () => {
    it('records the failure, keeps going, and drops the group from the balanced statistics', async () => {
      const original = Player.prototype.process;
      // Force every submission to fail, which the FR-9 fallback cannot route around either.
      Player.prototype.process = function() {
        throw new Error('forced failure');
      };
      let report;
      try {
        report = await runMatch(twoPlayer, {silenceRoutineLogs: true});
      } finally {
        Player.prototype.process = original;
      }

      expect(report.summary.games, 'the run did not abort at the first failure').to.equal(4);
      expect(report.summary.completed).to.equal(0);
      expect(report.summary.failed).to.equal(4);
      expect(report.summary.balancedGroups, 'an incomplete group is not a balanced group').to.equal(0);
      expect(report.summary.bySlot.every((slot) => slot.games === 0)).to.be.true;
      expect(report.games[0].failure?.message).to.contain('forced failure');
      // Identity survives a failure: a failure nobody can attribute to a version is unactionable.
      expect(report.games[0].seats.map((seat) => seat.agent)).to.deep.equal(['random-legal', 'random-legal']);
      expect(report.games[0].seats.every((seat) => seat.outcome === undefined)).to.be.true;
    });
  });

  describe('the artifact', () => {
    it('round-trips through save/load and strips exactly the declared timing fields', async () => {
      const report = await runMatch(twoPlayer, {silenceRoutineLogs: true});
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-match-')), 'run.json');
      saveMatchArtifact(file, report);

      const loaded = loadMatchArtifact(file);
      expect(loaded.header.runId).to.equal(report.header.runId);
      expect(loaded.games).to.have.length(4);
      expect(JSON.stringify(stripTimingFields(loaded))).to.equal(JSON.stringify(stripTimingFields(report)));

      const stripped = stripTimingFields(report) as {summary: Record<string, unknown>; games: ReadonlyArray<Record<string, unknown>>};
      expect(stripped.summary.timing).to.be.undefined;
      expect(stripped.games[0].durationMs).to.be.undefined;
      expect(stripped.games[0].engineSeed, 'and nothing else went with them').to.be.a('number');
    });

    it('refuses to write a moves-tier artifact into the committed data directory (§4.7)', () => {
      // Absolute, because the guard is on the *resolved* path and a relative one would resolve
      // against whatever the caller's working directory happens to be.
      const committed = path.join(defaultOutputDir('summary'), 'huge.json');
      expect(() => resolveOutputPath(committed, 'moves')).to.throw('refusing to write');
      expect(() => resolveOutputPath(committed, 'summary'), 'summary-tier output belongs there').to.not.throw();
    });

    it('resolves a bare filename against the tier\'s default directory', () => {
      expect(resolveOutputPath('run.json', 'summary')).to.match(/agent[/\\]docs[/\\]data[/\\]run\.json$/);
      expect(resolveOutputPath('run.json', 'moves')).to.match(/agent[/\\]runs[/\\]run\.json$/);
    });
  });

  /**
   * The seam a searching agent needs (Milestone 2 bullet 2, Unit A; hazard H4). Two separate
   * claims, and the second is the one Unit A's prompt calls out: **no behaviour change when an
   * agent supplies nothing.**
   */
  describe('agent contributions (hazard H4)', () => {
    it('calls a contributed observer for every seat\'s decisions, and its driver options too', async () => {
      const seen: Array<string> = [];
      let fallbacks = 0;
      const entry: AgentEntry = {
        name: 'contribution-probe',
        version: '0-probe',
        description: 'registered only for the duration of one test.',
        create: (seed) => {
          const inner = randomLegalAgent(createAgentRandom(seed));
          return {
            respond: inner,
            // Wraps the *router*, so it must see the other seat's decisions as well as its own -
            // which is the entire reason this seam exists (the ancestor walk replays opponents'
            // moves).
            observeDecisions: (router) => (decision) => {
              seen.push(decision.player.id);
              return router(decision);
            },
            driverOptions: {onFallback: () => {
              fallbacks++;
            }},
          };
        },
      };

      await withTemporaryAgent(entry, async () => {
        const report = await runMatch(
          {players: 2, lineup: ['contribution-probe', 'random-legal'], groups: 1},
          {silenceRoutineLogs: true});
        expect(report.summary.completed).to.equal(report.summary.games);
        // One seat contributes, and it sees every decision of every game, not only its own.
        expect(seen.length).to.equal(report.summary.totalDecisions);
        expect(new Set(seen).size, 'including the opponent\'s').to.equal(2);
        // The runner's own counters still ran: composition, not replacement.
        expect(fallbacks).to.equal(report.summary.fallbacksAfterRejection + report.summary.fallbacksAfterThrow);
        expect(fallbacks, 'and there were fallbacks to observe').to.be.greaterThan(0);
      });
    });

    it('leaves a run byte-identical when the agent contributes nothing', async () => {
      // `random-legal@1` returns a bare responder; a seat-shaped entry that contributes only
      // `respond` must be indistinguishable from it, or normalizing the two shapes has changed
      // what a run is - and every Milestone 1 number, including AC-1, describes the other one.
      const entry: AgentEntry = {
        name: 'seat-shaped-random-legal',
        version: '0-probe',
        description: 'registered only for the duration of one test.',
        create: (seed) => ({respond: randomLegalAgent(createAgentRandom(seed))}),
      };

      const baseline = await runMatch(twoPlayer, {silenceRoutineLogs: true});
      await withTemporaryAgent(entry, async () => {
        const seatShaped = await runMatch(
          {...twoPlayer, lineup: ['seat-shaped-random-legal', 'seat-shaped-random-legal']},
          {silenceRoutineLogs: true});
        // The agent names differ by construction, so compare the game rows - which is where every
        // number a strength claim rests on lives.
        const rows = (report: MatchRunReport) => JSON.stringify((stripTimingFields(report) as {games: unknown}).games)
          .split('seat-shaped-random-legal').join('random-legal')
          .split('"agentVersion":"0-probe"').join('"agentVersion":"1"');
        expect(rows(seatShaped)).to.equal(rows(baseline));
      });
    });

    it('merges driver options without letting an agent silence the runner', () => {
      const calls: Array<string> = [];
      const merged = mergeDriverOptions([
        {maxDecisions: 500, onFallback: () => calls.push('runner')},
        {maxDecisions: 100, onFallback: () => calls.push('agent')},
        {},
      ]);
      merged.onFallback?.({} as never);
      expect(calls, 'both hooks run, the runner\'s first').to.deep.equal(['runner', 'agent']);
      expect(merged.maxDecisions, 'the strictest cap wins').to.equal(100);

      // The no-contribution path has to be *the same object*, not an equivalent one: criteria R2
      // and R6 compare artifacts byte for byte.
      const only = {maxDecisions: 7};
      expect(mergeDriverOptions([only])).to.equal(only);
    });
  });

  describe('wilson95 (criterion R1a is stated on this interval)', () => {
    it('brackets the observed rate and stays inside [0, 1]', () => {
      const even = wilson95(500, 1000);
      expect(even.low).to.be.lessThan(0.5).and.greaterThan(0.45);
      expect(even.high).to.be.greaterThan(0.5).and.lessThan(0.55);

      // Where the normal approximation misbehaves: an extreme proportion at small n.
      const extreme = wilson95(0, 10);
      expect(extreme.low).to.equal(0);
      expect(extreme.high).to.be.greaterThan(0).and.lessThan(1);
    });

    it('narrows as the sample grows - what makes R1a a claim about this sample size', () => {
      const small = wilson95(50, 100);
      const large = wilson95(5000, 10_000);
      expect(large.high - large.low).to.be.lessThan(small.high - small.low);
    });
  });
});
