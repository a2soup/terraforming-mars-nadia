import {expect} from 'chai';
import {Phase} from '../../../src/common/Phase';
import {IGame} from '../../../src/server/IGame';
import {IPlayer} from '../../../src/server/IPlayer';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom} from '../../src/core/rng';
import {toDecisionPoint} from '../../src/driver/decisionPoint';
import {EmbeddedDriverOptions, applyDecision, runGame} from '../../src/driver/embeddedDriver';
import {EmbeddedResponder} from '../../src/driver/responder';
import {createGame} from '../../src/engine/gameFactory';
import {pendingSignature} from '../../src/engine/snapshot';
import {stableStateOf} from '../../src/engine/stableState';
import {ForkOutcome, ForkService, submitInFork} from '../../src/search/fork';
import {LiveSubmissionDuringSpeculationError, isSpeculative, withSpeculation} from '../../src/search/speculation';

/**
 * The fork service (Milestone 2 bullet 2, Unit A; §2.3, §3.3).
 *
 * **The load-bearing test in this file is the fidelity one**, and it is written the way
 * `bench/forkCost.ts` wrote its own: drive real games to completion, fork at *every* decision, and
 * compare each fork against the live game by **both** `pendingSignature` and `stableStateOf` (H7).
 * That single check subsumes most of what could be asserted piecemeal - in particular it is the only
 * way to test hazard H3 (record the response the Engine *accepted*, not the one the responder
 * returned) without contriving a rejection, because a recorder that stored the responder's move
 * would replay a move that was never played and the state comparison would catch it within a few
 * games. So the fidelity test also asserts that the corpus actually contained fallback-resolved
 * decisions; without them it would be testing the easy half.
 */

/**
 * The comparable position of a game. `ignoreLog` because the fork service strips `gameLog` from
 * ancestor snapshots by default (it is ~74% of the serialized bytes and a speculative game's
 * history is never read), so a log-bearing comparison would report a difference on the log's length
 * alone - the exact spurious diff `stableStateOf`'s own option exists to avoid.
 */
function positionOf(game: IGame): string {
  return stableStateOf(game.serialize(), {ignoreLog: true});
}

function nextWaitingPlayer(game: IGame): IPlayer | undefined {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

/**
 * A printable form of a {@link ForkOutcome}. Not named `describe`, which mocha owns. `JSON.stringify` cannot be used on the available case:
 * it carries live Engine objects, and `Player` -> `waitingFor` -> options -> `player` is a cycle.
 */
function describeOutcome(outcome: ForkOutcome): string {
  return outcome.available ?
    `available (replayDistance ${outcome.replayDistance})` :
    `unavailable: ${outcome.reason}${outcome.detail === undefined ? '' : ` (${outcome.detail})`}`;
}

/** Drives `game` with `responder`, stopping when `predicate` holds or the game ends. */
function driveUntil(game: IGame, responder: EmbeddedResponder, options: EmbeddedDriverOptions, predicate: (game: IGame) => boolean, maxDecisions = 400): void {
  let decisions = 0;
  while (!predicate(game) && game.phase !== Phase.END && decisions++ < maxDecisions) {
    const player = nextWaitingPlayer(game);
    if (player === undefined) {
      return;
    }
    applyDecision(player, responder, options);
  }
}

describe('fork service (Unit A)', function() {
  this.timeout(300_000);

  describe('a fork is an independent, speculative copy of the live position', () => {
    it('offers the same decision to the same player, and is registered as speculative', () => {
      const game = createGame({players: 2, seed: 7_001});
      const service = new ForkService();
      const responder = service.observeDecisions(randomLegalAgent(createAgentRandom(11)));
      driveUntil(game, responder, {}, (g) => g.phase === Phase.ACTION && g.deferredActions.length === 0);

      const outcome = service.fork();
      expect(outcome.available, describeOutcome(outcome)).to.be.true;
      if (!outcome.available) {
        return;
      }
      expect(isSpeculative(outcome.game), 'so the instruments will not count it').to.be.true;
      expect(outcome.game, 'a different object from the live game').to.not.equal(game);
      expect(outcome.player.id).to.equal(nextWaitingPlayer(game)?.id);
      expect(pendingSignature(outcome.game)).to.equal(pendingSignature(game));
      expect(positionOf(outcome.game), 'and the same position').to.equal(positionOf(game));
    });

    it('does not leak a speculative move back into the live game', () => {
      const game = createGame({players: 2, seed: 7_002});
      const service = new ForkService();
      const responder = service.observeDecisions(randomLegalAgent(createAgentRandom(12)));
      driveUntil(game, responder, {}, (g) => g.phase === Phase.ACTION && g.deferredActions.length === 0);

      const before = positionOf(game);
      const probe = randomLegalAgent(createAgentRandom(13));
      const outcome = service.fork();
      expect(outcome.available).to.be.true;
      if (!outcome.available) {
        return;
      }
      const waitingFor = outcome.player.getWaitingFor();
      expect(waitingFor).to.not.be.undefined;
      withSpeculation(() => submitInFork(outcome.player, probe(toDecisionPoint(outcome.player, waitingFor!))));

      expect(positionOf(game), 'the live game is untouched').to.equal(before);
      expect(positionOf(outcome.game), 'and the fork moved on').to.not.equal(before);
    });

    it('hands out an independent game per call - snapshot once, restore many', () => {
      const game = createGame({players: 2, seed: 7_003});
      const service = new ForkService();
      const responder = service.observeDecisions(randomLegalAgent(createAgentRandom(14)));
      driveUntil(game, responder, {}, (g) => g.phase === Phase.ACTION && g.deferredActions.length === 0);

      const first = service.fork();
      const second = service.fork();
      expect(first.available && second.available).to.be.true;
      if (!first.available || !second.available) {
        return;
      }
      expect(first.game).to.not.equal(second.game);
      expect(positionOf(first.game)).to.equal(positionOf(second.game));
    });

    it('refuses a submission aimed at the live game (§3.2 cross-check)', () => {
      const game = createGame({players: 2, seed: 7_004});
      const player = nextWaitingPlayer(game);
      expect(player).to.not.be.undefined;
      expect(() => submitInFork(player!, {type: 'option'})).to.throw(LiveSubmissionDuringSpeculationError);
    });
  });

  describe('the ancestor and the replay', () => {
    it('reports no ancestor during game setup rather than throwing', () => {
      // Every phase before the first action phase is one `assertSnapshotSafe` refuses, so a game has
      // no forkable ancestor at all until then - including prelude selection. §3.3 hoped replay
      // would reach preludes; it cannot, and this is that finding written as a test rather than
      // discovered again later.
      const game = createGame({players: 2, seed: 7_005});
      const service = new ForkService();
      const responder = service.observeDecisions(randomLegalAgent(createAgentRandom(15)));
      driveUntil(game, responder, {}, () => false, 1);

      const outcome = service.fork();
      expect(outcome.available).to.be.false;
      if (outcome.available) {
        return;
      }
      expect(outcome.reason).to.equal('no-ancestor');
      expect(service.stats.noAncestor).to.equal(1);
    });

    it('reaches an unforkable point by replaying the recorded responses', () => {
      // Milestone 1 bullet 4 measured that 28.0% of decision points do not round-trip and that the
      // action-phase failures are **100% silent** - `stableState` matches byte for byte while the
      // pending decision is quietly replaced. Those are the points that need replay, and they
      // cannot be found by a phase or queue predicate, precisely because they look fine. So this
      // walks the game and stops at the first point the service could only reach by replaying.
      const game = createGame({players: 2, seed: 7_006});
      const service = new ForkService({validateRate: 1});
      const agent = randomLegalAgent(createAgentRandom(16));
      let replayedOutcome: ForkOutcome | undefined;

      // Forked from **inside** the responder, which is the service's contract: `fork()` reproduces
      // the decision currently being answered, and between decisions the previous one has not been
      // folded into the replay list yet.
      const responder = service.observeDecisions((decision) => {
        if (replayedOutcome === undefined) {
          const outcome = withSpeculation(() => service.fork());
          if (outcome.available && outcome.replayDistance > 0) {
            replayedOutcome = outcome;
            expect(positionOf(outcome.game), 'the replayed fork is the live position').to.equal(positionOf(game));
          }
        }
        return agent(decision);
      });

      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        while (game.phase !== Phase.END && replayedOutcome === undefined) {
          const player = nextWaitingPlayer(game);
          if (player === undefined) {
            break;
          }
          applyDecision(player, responder);
        }
      } finally {
        console.warn = originalWarn;
      }

      // A game with no such point would leave this test green while testing nothing, so the absence
      // is a failure rather than a pass.
      expect(replayedOutcome, 'seed 7006 reached a point only replay could fork').to.not.be.undefined;
      expect(service.stats.replayed).to.be.greaterThan(0);
      expect(service.stats.validationFailures, 'and it reproduced exactly').to.deep.equal({});
    });
  });

  /**
   * The corpus check. `validateRate: 1` turns on the expensive half of H7 for every fork, so a
   * recorder that stored the wrong response, a drain that behaved differently from the driver's, or
   * a restore that regenerated a different pending decision would all surface here as a
   * `validation-failed` outcome rather than as a plausible-looking agent later.
   */
  describe('fidelity over real games (the G3 shape, at spec scale)', () => {
    it('reproduces the live position exactly at every decision it can fork at', () => {
      let forks = 0;
      let unavailable = 0;
      let replayed = 0;
      let validationFailures = 0;
      let fallbacks = 0;
      let decisions = 0;

      for (const seed of [7_101, 7_102, 7_103]) {
        const game = createGame({players: 2, seed});
        const service = new ForkService({validateRate: 1});
        const agent = randomLegalAgent(createAgentRandom(seed + 7));
        const responder = service.observeDecisions((decision) => {
          decisions++;
          // Fork at every decision, whoever's it is - the densest possible fidelity corpus, and the
          // same design `bench/forkCost.ts` used for the same reason.
          withSpeculation(() => {
            const outcome = service.fork();
            if (outcome.available) {
              forks++;
              if (outcome.replayDistance > 0) {
                replayed++;
              }
            } else {
              unavailable++;
              if (outcome.reason === 'validation-failed') {
                validationFailures++;
              }
            }
          });
          return agent(decision);
        });

        const options: EmbeddedDriverOptions = {
          ...service.driverOptions,
          onFallback: (event) => {
            fallbacks++;
            service.driverOptions.onFallback?.(event);
          },
        };
        const originalWarn = console.warn;
        console.warn = () => {};
        try {
          runGame(game, responder, options);
        } finally {
          console.warn = originalWarn;
        }

        const stats = service.stats;
        expect(stats.validationFailures, `seed ${seed}: ${JSON.stringify(stats.validationFailures)}`).to.deep.equal({});
        expect(stats.stateValidated, 'every fork was compared both ways').to.equal(stats.direct + stats.replayed);
      }

      expect(decisions, 'the corpus is real').to.be.greaterThan(500);
      expect(forks, 'and most decisions were forkable').to.be.greaterThan(decisions / 2);
      expect(replayed, 'including some reached only by replay').to.be.greaterThan(0);
      expect(validationFailures, 'zero silent divergences (G3)').to.equal(0);
      // Hazard H3's population. Without it this test would only prove the recorder right on the
      // decisions where the responder's move and the accepted move are the same thing.
      expect(fallbacks, 'the FR-9 fallback fired, so accepted != returned really happened').to.be.greaterThan(0);
      expect(unavailable, 'game setup is unforkable, and that is expected').to.be.greaterThan(0);
    });
  });
});
