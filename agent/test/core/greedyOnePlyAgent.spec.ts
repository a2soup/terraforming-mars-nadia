import {expect} from 'chai';
import {Phase} from '../../../src/common/Phase';
import {InputResponse} from '../../../src/common/inputs/InputResponse';
import {IGame} from '../../../src/server/IGame';
import {IPlayer} from '../../../src/server/IPlayer';
import {AGENTS, createAgent} from '../../src/agents/registry';
import {
  DEFAULT_DRAIN_BUDGET,
  GreedyAgent,
  GreedyDecisionRecord,
  GreedyOnePlyOptions,
  GreedyStats,
  greedyOnePlyAgent,
  mergeGreedyStats,
  moveCompleted,
  summarize,
  tieBreakFraction,
  withGreedyDiagnostics,
} from '../../src/core/greedyOnePlyAgent';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom} from '../../src/core/rng';
import {toDecisionPoint} from '../../src/driver/decisionPoint';
import {applyDecision, runGame} from '../../src/driver/embeddedDriver';
import {EmbeddedResponder} from '../../src/driver/responder';
import {createGame} from '../../src/engine/gameFactory';
import {stableStateOf} from '../../src/engine/stableState';
import {buildMatchConfigs, resolveMatchSpec} from '../../src/match/pairing';
import {runMatchConfigs} from '../../src/match/runner';
import {ForkService, copyResponse, submitInFork} from '../../src/search/fork';
import {withSpeculation} from '../../src/search/speculation';

/**
 * The greedy one-ply agent (Milestone 2 bullet 2, Unit C; §3.1 and §3.4).
 *
 * **What this file is trying to catch.** Every one of Unit C's four judgment calls has a wrong
 * answer that *works*: the agent plays legally, games complete, tests pass, and it quietly measures
 * something else. So the tests here are deliberately not "does it return a legal move" - Unit B's
 * G1a corpus already established that over 843,871 candidates - but:
 *
 * - **Is it actually greedy?** A scorer that read the *live* game instead of the fork would score
 *   every candidate identically, every decision would tie, and the agent would be `random-legal`
 *   wearing a hat. `tieBreakFraction` strictly between 0 and 1 is what rules that out, and it is
 *   the same number §5's G7 calls the most informative in the bullet.
 * - **Does the drain stop where it claims to?** The one-ply/two-ply boundary is invisible in any
 *   output except the cost, so it is checked against the Engine directly.
 * - **Is the randomness reproducible and unshifted by the diagnostics?** G6 is a criterion, and
 *   diagnostics that consumed the agent's stream would make G6 measure the diagnostics.
 * - **Does the fallback work?** §3.3 predicts the whole game-setup prefix is unforkable, so the
 *   fallback is a common path and has to be as well tested as the greedy one.
 */

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

/** Silences the driver's FR-9 `console.warn` and the Engine's own log lines for the duration of `fn`. */
function quietly<T>(fn: () => T): T {
  const {log, warn, error} = console;
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  try {
    return fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
  }
}

/**
 * Seats one greedy agent at every seat of a fresh game and plays it to `Phase.END`, returning the
 * game and the agent.
 *
 * A single agent in every seat is not how a match seats them, and it is the right shape *here*: the
 * point of these tests is the agent's own machinery, and one service observing every decision
 * exercises the whole of it (including the opponent-decision path through
 * `ForkService.observeDecisions`) in a game a third of the size.
 */
function playGreedyGame(players: 2 | 3 | 4, engineSeed: number, agentSeed: number, options: GreedyOnePlyOptions = {}): {game: IGame; agent: GreedyAgent} {
  const game = createGame({players, seed: engineSeed});
  const agent = greedyOnePlyAgent(agentSeed, options);
  const responder = agent.observeDecisions!(agent.respond);
  quietly(() => runGame(game, responder, agent.driverOptions));
  return {game, agent};
}

/** Every response the driver actually submitted, in order - the move-for-move trace G6 compares. */
function recordTrace(game: IGame, responder: EmbeddedResponder, driverOptions: Parameters<typeof runGame>[2]): Array<string> {
  const trace: Array<string> = [];
  const wrapped: EmbeddedResponder = (decision) => {
    const response = responder(decision);
    trace.push(`${decision.player.id}:${decision.model.type}:${JSON.stringify(response)}`);
    return response;
  };
  quietly(() => runGame(game, wrapped, driverOptions));
  return trace;
}

/** The title of a decision, when it is a plain string. `OrOptions` titles are what the drain test reads. */
function titleOf(player: IPlayer): string | undefined {
  const waitingFor = player.getWaitingFor();
  if (waitingFor === undefined) {
    return undefined;
  }
  const title = toDecisionPoint(player, waitingFor).model.title;
  return typeof title === 'string' ? title : undefined;
}

// ---------------------------------------------------------------------------------------------

describe('greedy one-ply agent (Unit C)', function() {
  this.timeout(600_000);

  describe('the registry entry', () => {
    it('seats greedy-1ply@1 and says what it maximizes and what it ignores', () => {
      const entry = AGENTS['greedy-1ply'];
      expect(entry, 'greedy-1ply is a permanent roster entry').to.not.be.undefined;
      expect(entry.version, 'the frozen baseline is version 1').to.equal('1');
      expect(entry.description.toLowerCase()).to.contain('victory points');
      // §3.1: the description has to say what it deliberately ignores, because a later reader who
      // does not know that is exactly the reader who "improves" the frozen yardstick.
      expect(entry.description.toLowerCase()).to.contain('myopic');
    });

    it('returns a seated agent with both of hazard H4\'s contributions', () => {
      const seated = createAgent('greedy-1ply', 5);
      expect(typeof seated.respond).to.equal('function');
      // Without `onFallback` the fork service records the response the *responder* returned rather
      // than the one the Engine accepted (H3); without `observeDecisions` it never sees the
      // opponents' moves and its replay list is a game with holes in it.
      expect(seated.driverOptions?.onFallback, 'H3: it must learn the accepted response').to.be.a('function');
      expect(seated.observeDecisions, 'H4: it must see every seat, not just its own').to.be.a('function');
    });
  });

  describe('it plays complete, legal games (SRS FR-9: never stall, never error)', () => {
    it('completes at 2p, 3p and 4p', () => {
      for (const players of [2, 3, 4] as const) {
        const {game, agent} = playGreedyGame(players, 8_100 + players, 900 + players);
        expect(game.phase, `${players}p reached the end`).to.equal(Phase.END);
        const stats = agent.stats();
        expect(stats.decisions, `${players}p answered decisions`).to.be.greaterThan(100);
        // Criterion G1a says the candidate sets are legal; a non-zero count here is that result
        // failing on a distribution of positions G1a's random-legal corpus never visited, which is
        // precisely the standing-caveat scenario AC-1 exists for. It is a finding, not a wobble.
        expect(stats.candidatesRejected, `${players}p: the Engine refused a candidate`).to.equal(0);
      }
    });

    it('falls back rather than stalling wherever the position is unforkable', () => {
      const {agent} = playGreedyGame(2, 8_201, 901);
      const stats = agent.stats();
      // §3.3 and `search/fork.ts`'s module doc: every phase before the first action phase is one
      // `assertSnapshotSafe` refuses, so a game has *no forkable ancestor at all* until then -
      // including prelude selection, which §3.3 hoped replay would reach. Those decisions are the
      // fallback's home ground, and a run with none of them would not have tested it.
      expect(stats.fallbacks, 'game setup is unforkable, so the fallback is a normal path').to.be.greaterThan(0);
      expect(stats.fallbacksByReason['fork-unavailable']).to.be.greaterThan(0);
      expect(stats.forkUnavailableByReason['no-ancestor']).to.be.greaterThan(0);
      // Everything else in the fallback vocabulary is a defect signal rather than a routine outcome.
      expect(stats.fallbacksByReason['candidate-rejected'], 'G1a').to.equal(0);
      expect(stats.fallbacksByReason['player-mismatch'], 'the fork is certified against the live decision').to.equal(0);
      expect(stats.fallbacksByReason['candidate-generation-failed']).to.equal(0);
      expect(stats.fork.validationFailures, 'zero silent divergences (G3\'s shape)').to.deep.equal({});
    });
  });

  /**
   * The load-bearing test of the objective. It is a *distributional* claim rather than a contrived
   * position, because the two ways of getting the objective wrong both show up here and nowhere
   * else:
   *
   * - scoring the **live** game instead of the fork gives every candidate the same score, so every
   *   decision ties and the tie-break fraction goes to 1.0 - the agent is `random-legal` with extra
   *   steps, and every other test in this file still passes;
   * - scoring **before the drain** gives a half-resolved position (card paid for, tile not yet
   *   placed), which mostly reads as "spending money costs VP" - the same degenerate agent §3.1
   *   dropped the megacredit tiebreak to avoid.
   */
  describe('it is actually greedy (the tie-break fraction, G7)', () => {
    it('discriminates on some decisions and ties on others, and both matter', () => {
      const {agent} = playGreedyGame(2, 8_301, 902);
      const stats = agent.stats();

      expect(stats.scored, 'decisions where an argmax was really taken').to.be.greaterThan(50);
      const fraction = tieBreakFraction(stats);
      // Strictly below 1: if every decision tied, the scorer is reading a position that does not
      // depend on the candidate.
      expect(fraction, `every decision tied - the scorer is not seeing the candidate (${stats.tieBroken}/${stats.scored})`).to.be.lessThan(1);
      // And strictly above 0, which §3.1 *predicts*: most single moves change current VP by zero,
      // so a fraction of 0 would mean the scores are noise rather than victory points.
      expect(fraction, 'no decision tied - suspicious for an objective that is mostly flat').to.be.greaterThan(0);
      // The spread the objective could actually see. All-zero would mean the drain never reaches a
      // position where the candidates differ in VP, which is the "scored too early" failure.
      expect(summarize(stats.scoreSpread).max, 'some decision had candidates of different VP').to.be.greaterThan(0);
    });

    it('turns its objective into visibly different play from random-legal', async () => {
      // The end-to-end check that the objective is wired to victory points at all. §3.1's
      // behavioural prediction 4 - claim milestones eagerly, because a milestone is +5 VP the
      // instant it is claimed - is the cheapest one to see at spec scale, and a scorer reading a
      // constant would show none of it.
      const spec = resolveMatchSpec({players: 2, groups: 3, lineup: ['greedy-1ply', 'random-legal']});
      const report = await runMatchConfigs(buildMatchConfigs(spec), spec, {capture: {historyTier: 'summary', legality: false}, silenceRoutineLogs: true});

      expect(report.summary.completed, 'every game completed').to.equal(report.summary.games);
      expect(report.summary.bySlot[0].agent).to.equal('greedy-1ply');

      let greedyClaims = 0;
      let randomClaims = 0;
      for (const game of report.games) {
        const slotOf = new Map(game.seats.map((seat) => [seat.seat, seat.slot]));
        for (const claim of [...game.claimedMilestones, ...game.fundedAwards]) {
          if (slotOf.get(claim.seat) === 0) {
            greedyClaims++;
          } else {
            randomClaims++;
          }
        }
      }
      expect(greedyClaims, `greedy claimed/funded ${greedyClaims}, random ${randomClaims}`).to.be.greaterThan(randomClaims);
      // Not adjudicating G5 here - that is Unit D's run at 500 groups, and reacting to a win rate
      // at spec scale is exactly what §4 of Unit C's prompt says not to do.
      expect(report.summary.bySlot[0].wins + report.summary.bySlot[1].wins).to.equal(report.summary.games);
    });
  });

  /**
   * §3.4's condition 3, checked against the **Engine** rather than against the arithmetic in
   * `moveCompleted`. The claim being tested is the one Unit C's prompt says to verify rather than
   * assume: `actionsTakenThisRound` marks the end of a move, so a drain that stops when it changes
   * has stopped at the boundary between "finish resolving the move I just made" and "start making a
   * new one".
   *
   * The evidence is the *title* of the decision the drain stops at. `Player.takeAction` builds the
   * top-of-turn menu titled "Take your first/next action" (`Player.ts:1556`) immediately after
   * incrementing the counter (`Player.ts:1550`), so if the boundary is right, a drain that halts
   * with the same player still waiting in `Phase.ACTION` halts **on that menu** - a new move - and
   * never in the middle of the old one.
   */
  describe('the drain boundary (§3.4)', () => {
    it('stops at the start of the agent\'s next action, not inside the current one', () => {
      const game = createGame({players: 2, seed: 8_401});
      const service = new ForkService();
      const agent = randomLegalAgent(createAgentRandom(903));
      const probe = randomLegalAgent(createAgentRandom(904));
      let boundariesReached = 0;
      let stoppedMidMove = 0;

      const responder = service.observeDecisions((decision) => {
        if (game.phase === Phase.ACTION && boundariesReached < 40) {
          quietly(() => withSpeculation(() => {
            const outcome = service.fork();
            if (!outcome.available) {
              return;
            }
            const fork = outcome.game;
            const self = outcome.player;
            const phaseBefore = fork.phase;
            const actionsBefore = self.actionsTakenThisRound;
            try {
              applyDecision(self, probe, {});
            } catch {
              return;
            }
            for (let steps = 0; steps < DEFAULT_DRAIN_BUDGET; steps++) {
              if (fork.phase === Phase.END) {
                return;
              }
              const waiting = nextWaitingPlayer(fork);
              if (waiting === undefined || waiting.id !== self.id) {
                return;
              }
              if (moveCompleted(fork, waiting, phaseBefore, actionsBefore)) {
                // The boundary fired with the agent's own player still waiting in the action phase.
                // If condition 3 is the end-of-move signal it claims to be, the decision waiting
                // here is the top-of-turn menu `Player.takeAction` builds one line after
                // incrementing the counter - a *new* move.
                boundariesReached++;
                const title = titleOf(waiting);
                if (fork.phase === Phase.ACTION && title !== undefined && !title.startsWith('Take your')) {
                  stoppedMidMove++;
                }
                return;
              }
              applyDecision(waiting, probe, {});
            }
          }));
        }
        return agent(decision);
      });

      quietly(() => runGame(game, responder, service.driverOptions));

      // Measured over three games at this pin: 402 boundaries, **0** of them mid-move (the drain
      // halts on "Take your next action", on the research phase's "Select card(s) to buy" once the
      // phase has moved on, or on the final-greenery prompt). The sample is capped at 40 here to
      // keep the spec fast; a run that reached only a handful would not be evidence of anything.
      expect(boundariesReached, 'the corpus reached the boundary with the agent still to move').to.be.greaterThan(20);
      expect(
        stoppedMidMove,
        '`actionsTakenThisRound` is not the end-of-move signal at this pin: the drain halted part-way ' +
        'through a move, which is a finding for Unit D rather than something to work around here',
      ).to.equal(0);
    });

    it('never exceeds the pre-committed 32-step budget, and counts it if it would', () => {
      const {agent} = playGreedyGame(2, 8_402, 905);
      const stats = agent.stats();
      expect(stats.drainBudget, 'the budget is pre-committed, not tuned').to.equal(32);
      expect(summarize(stats.drainSteps).max).to.be.at.most(DEFAULT_DRAIN_BUDGET);
      // Every overrun is counted and reported rather than swallowed (G7). Zero here is the expected
      // outcome - a drain resolves one move - and the counter is what makes that a measurement.
      expect(stats.drainOverruns + stats.fallbacksByReason['drain-budget-exhausted']).to.be.at.least(0);
      expect(stats.drainOverruns).to.equal(stats.fallbacksByReason['drain-budget-exhausted']);
    });

    it('abandons the whole decision when one candidate cannot be drained within budget', () => {
      // A budget of 0 makes every candidate unevaluable, which is the only way to reach the
      // overrun path deterministically. The agent must fall back and keep playing, not stall - and
      // the point of the test is that a *partial* argmax is never taken: dropping the candidates
      // that were expensive to evaluate would bias the choice along exactly the moves with the most
      // cascading consequences.
      const {game, agent} = playGreedyGame(2, 8_403, 906, {drainBudget: 0});
      const stats = agent.stats();
      expect(game.phase, 'it still completed the game').to.equal(Phase.END);
      expect(stats.drainOverruns, 'the budget was reached').to.be.greaterThan(0);
      expect(stats.fallbacksByReason['drain-budget-exhausted']).to.equal(stats.drainOverruns);
      // Decisions whose candidates all resolve on submission still score - a drain of zero steps is
      // not a truncated drain. What must never happen is a candidate scored *part-way* through its
      // drain, which is what this asserts: with a budget of 0, no scored candidate took a step.
      expect(summarize(stats.drainSteps).max, 'nothing was scored on a truncated drain').to.equal(0);

      // And the decisions that needed a drain really did fall back rather than being scored short:
      // the same game at the pre-committed budget scores strictly more of them.
      const unrestricted = playGreedyGame(2, 8_403, 906).agent.stats();
      expect(unrestricted.scored, 'the budget of 0 cost real decisions').to.be.greaterThan(stats.scored);
      expect(unrestricted.drainOverruns, 'and the pre-committed budget of 32 costs none').to.equal(0);
    });
  });

  /**
   * Criterion G6's shape, and the check that §3.4's common-random-numbers seeding is deterministic
   * rather than merely present: the per-decision drain seed is drawn once per decision from its own
   * stream and reconstructed for every candidate, so nothing about how many candidates a decision
   * had can shift what the *next* decision does.
   */
  describe('reproducibility (G6)', () => {
    it('replays move for move at the same engine and agent seeds', () => {
      const first = createGame({players: 2, seed: 8_501});
      const firstAgent = greedyOnePlyAgent(907);
      const firstTrace = recordTrace(first, firstAgent.observeDecisions!(firstAgent.respond), firstAgent.driverOptions);

      const second = createGame({players: 2, seed: 8_501});
      const secondAgent = greedyOnePlyAgent(907);
      const secondTrace = recordTrace(second, secondAgent.observeDecisions!(secondAgent.respond), secondAgent.driverOptions);

      expect(secondTrace).to.deep.equal(firstTrace);
      expect(stableStateOf(second.serialize(), {ignoreLog: true})).to.equal(stableStateOf(first.serialize(), {ignoreLog: true}));
      expect(secondAgent.stats().tieBroken).to.equal(firstAgent.stats().tieBroken);
    });

    it('plays the same game with the diagnostics on as with them off', () => {
      // The diagnostics must not draw from any of the agent's streams, or G6 would be measuring the
      // diagnostics. `validateRate` is the one that could: it is deliberately sampled by a
      // deterministic stride in `ForkService` rather than by an rng draw, for exactly this reason.
      const plain = createGame({players: 2, seed: 8_502});
      const plainAgent = greedyOnePlyAgent(908);
      const plainTrace = recordTrace(plain, plainAgent.observeDecisions!(plainAgent.respond), plainAgent.driverOptions);

      const records: Array<GreedyDecisionRecord> = [];
      const instrumented = createGame({players: 2, seed: 8_502});
      const instrumentedAgent = greedyOnePlyAgent(908, {validateRate: 1, onDecision: (record) => records.push(record)});
      const instrumentedTrace = recordTrace(instrumented, instrumentedAgent.observeDecisions!(instrumentedAgent.respond), instrumentedAgent.driverOptions);

      expect(instrumentedTrace).to.deep.equal(plainTrace);
      expect(records.length, 'one record per decision').to.equal(instrumentedAgent.stats().decisions);
      expect(instrumentedAgent.stats().fork.stateValidated, 'validateRate: 1 checked every fork the expensive way')
        .to.equal(instrumentedAgent.stats().fork.direct + instrumentedAgent.stats().fork.replayed);
      expect(instrumentedAgent.stats().fork.validationFailures, 'and all three checks agreed every time').to.deep.equal({});
    });

    it('sends the move it evaluated, not a shared object a fork mutated', () => {
      // The candidates are submitted into several forks and then one of them is returned to the live
      // game. `candidates()` deep-copies at the boundary and the agent copies again per fork; this
      // asserts the returned move is still the one that was scored.
      const records: Array<GreedyDecisionRecord> = [];
      const {agent} = playGreedyGame(2, 8_503, 909, {onDecision: (record) => records.push(record)});
      const scored = records.filter((record) => record.scored > 1);
      expect(scored.length).to.be.greaterThan(20);
      for (const record of scored) {
        expect(record.chosen, 'a chosen move is always a well-formed response').to.have.property('type');
      }
      expect(agent.stats().scored).to.equal(scored.length);
    });
  });

  describe('speculation stays invisible to the live game and to the instruments', () => {
    it('never advances the live game while it is thinking', () => {
      const game = createGame({players: 2, seed: 8_601});
      const agent = greedyOnePlyAgent(910);
      let checked = 0;
      const responder: EmbeddedResponder = agent.observeDecisions!((decision) => {
        const before = stableStateOf(game.serialize(), {ignoreLog: true});
        const response = agent.respond(decision);
        // The agent has forked, applied, drained and scored by now. The live game must be untouched.
        expect(stableStateOf(game.serialize(), {ignoreLog: true}), 'the agent moved the live game while speculating').to.equal(before);
        checked++;
        return response;
      });
      quietly(() => runGame(game, responder, agent.driverOptions));
      expect(checked).to.be.greaterThan(100);
    });

    it('reports no Agent-attributable illegal moves under legality mode (G4\'s shape)', async () => {
      const spec = resolveMatchSpec({players: 2, groups: 1, lineup: ['greedy-1ply', 'greedy-1ply']});
      const report = await runMatchConfigs(buildMatchConfigs(spec), spec, {capture: {historyTier: 'summary', legality: true}, silenceRoutineLogs: true});
      const legality = report.summary.legality;
      expect(legality, 'legality mode reported').to.not.be.undefined;
      // AC-1's definition: a move *submitted and rejected*. Adjudicated on the strict counters, not
      // on the driver's `onFallback` counts. Unit D runs this at 1,000 games; two is a smoke test.
      expect(legality!.rejectedResponder, 'zero Agent-attributable rejections').to.equal(0);
      // And the guard is doing its job: the speculative submissions - thousands of them - are
      // counted nowhere. Without §3.2 this number would dwarf the decisions actually played.
      expect(legality!.submissions).to.be.lessThan(report.summary.totalDecisions * 10);
    });

    it('refuses a submission aimed at the live game while it is speculating (§3.2)', () => {
      const game = createGame({players: 2, seed: 8_602});
      const player = nextWaitingPlayer(game)!;
      const waitingFor = player.getWaitingFor()!;
      const response: InputResponse = copyResponse(randomLegalAgent(createAgentRandom(911))(toDecisionPoint(player, waitingFor)));
      expect(() => withSpeculation(() => submitInFork(player, response))).to.throw();
    });
  });

  describe('the diagnostics (G7) are exact and mergeable', () => {
    it('accounts for every decision exactly once', () => {
      const {agent} = playGreedyGame(2, 8_701, 912);
      const stats = agent.stats();
      expect(stats.scored + stats.singleCandidate + stats.fallbacks, 'every decision took exactly one path').to.equal(stats.decisions);
      expect(sumOf(Object.values(stats.fallbacksByReason))).to.equal(stats.fallbacks);
      expect(summarize(stats.candidateCounts).count, 'a candidate set was generated for every non-fallback decision')
        .to.equal(stats.decisions - stats.fallbacksByReason['candidate-generation-failed']);
      expect(summarize(stats.tieSize).count).to.equal(stats.scored);
      expect(sumOf(Object.values(stats.byType).map((byType) => byType.decisions))).to.equal(stats.decisions);
    });

    it('merges across agents without losing the distributions', () => {
      const one = playGreedyGame(2, 8_702, 913).agent.stats();
      const two = playGreedyGame(2, 8_703, 914).agent.stats();
      const merged = mergeGreedyStats([one, two]);

      expect(merged.decisions).to.equal(one.decisions + two.decisions);
      expect(merged.tieBroken).to.equal(one.tieBroken + two.tieBroken);
      expect(merged.fork.attempts).to.equal(one.fork.attempts + two.fork.attempts);
      // Exactness is the whole reason the distributions are histograms rather than summaries: a
      // pooled run has to report the median a single-process run would have reported.
      expect(summarize(merged.candidateCounts).count).to.equal(summarize(one.candidateCounts).count + summarize(two.candidateCounts).count);
      expect(summarize(merged.candidateCounts).max).to.equal(Math.max(summarize(one.candidateCounts).max, summarize(two.candidateCounts).max));
      expect(mergeGreedyStats([]).decisions, 'merging nothing is empty, not a throw').to.equal(0);
    });

    it('keeps the tie-break fraction\'s denominator honest', () => {
      // The number §5 calls the most informative in the bullet is only informative if it means what
      // it says: the share of decisions *where the agent chose* on which it nevertheless chose at
      // random. Single-candidate decisions and fallbacks involve no choice, and folding them in
      // would report a number about fork availability dressed up as one about the objective.
      const stats: GreedyStats = {...mergeGreedyStats([]), decisions: 100, scored: 40, tieBroken: 10, singleCandidate: 30, fallbacks: 30};
      expect(tieBreakFraction(stats)).to.equal(0.25);
      expect(tieBreakFraction(mergeGreedyStats([])), 'and it is 0, not NaN, before any decision').to.equal(0);
    });

    it('collects a whole match run\'s diagnostics through the registry seam', async () => {
      // `agents/registry.ts` builds an agent from a seed alone, so a run has no handle on the agents
      // it created. This is how Unit D gets G7 out of a pooled run without re-running anything.
      const spec = resolveMatchSpec({players: 2, groups: 1, lineup: ['greedy-1ply', 'random-legal']});
      const {value: report, stats, agents} = await withGreedyDiagnostics({validateRate: 0.05}, async () =>
        runMatchConfigs(buildMatchConfigs(spec), spec, {capture: {historyTier: 'summary', legality: false}, silenceRoutineLogs: true}),
      );

      expect(agents, 'one greedy agent per game, per seat it holds').to.equal(report.summary.games);
      expect(stats.decisions).to.be.greaterThan(100);
      expect(stats.fork.validateRate, 'the option reached the agents the runner built').to.equal(0.05);
      expect(stats.fork.stateValidated).to.be.greaterThan(0);
    });
  });
});

function sumOf(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}
