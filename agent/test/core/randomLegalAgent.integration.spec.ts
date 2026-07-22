import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom, agentRandomFrom} from '../../src/core/rng';
import {applyDecision, runGame, FallbackEvent} from '../../src/driver/embeddedDriver';
import {computeResult, GameResult} from '../../src/driver/gameResult';
import {stableState} from '../testUtils/stableState';
import {Phase} from '../../../src/common/Phase';
import {ConstRandom} from '../../../src/common/utils/Random';
import {CardName} from '../../../src/common/cards/CardName';
import {PhoboLog} from '../../../src/server/cards/corporation/PhoboLog';

/**
 * Milestone 1, sub-task E: the first real, end-to-end proof of the random-legal agent - full
 * games, driven by the embedded driver, all the way to `Phase.END` (Milestone1_Subtask_Prompts.md,
 * items 2/4/5). Everything up to this sub-task exercised the enumerator/driver against real games
 * only partially (a handful of decisions deep, or a single decision in isolation); this file is
 * the first place a real game is driven to completion.
 */
describe('randomLegalAgent integration (Milestone 1, sub-task E)', () => {
  // ---------------------------------------------------------------------------------------------
  // Item 2 (the crux): reproduce the affordability coupling and prove the FR-9 fallback recovers.
  // ---------------------------------------------------------------------------------------------

  describe('the FR-9 affordability coupling (initial project-card over-selection)', () => {
    it('recovers when a low-starting-M€ corporation is dealt and the agent is forced toward selecting every offered project card', () => {
      const game = createGame({players: 2, seed: 8001});
      const [red] = game.playersInGenerationOrder;

      // Force a known low-starting-M€ corporation into the corp sub-decision's offered set,
      // rather than relying on the shuffle to deal one - reproducible regardless of seed
      // (Milestone1_Subtask_Prompts.md, sub-task E item 2: "force ... under a low-starting-M€
      // corporation, or otherwise construct an over-budget selection"). `Game.ts`'s initial setup
      // does `player.dealtCorporationCards.push(...)` (never reassigns the array), so mutating it
      // here is visible to the `SelectCard` sub-input already built into the pending
      // `initialCards` decision, which holds the very same array reference.
      // PhoboLog: startingMegaCredits 23, no cardCost override (stays the default 3 M€/card,
      // constants.CARD_COST) - 8 project cards alone (24 M€) already exceeds it, and the dealt
      // project-card count is always exactly 10 (Game.ts's `projectDeck.drawN(game, 10)`).
      red.dealtCorporationCards.length = 0;
      red.dealtCorporationCards.push(new PhoboLog());

      // A rng that always returns just-under-1 forces every `intInRange`/`nextInt` draw to its
      // *upper* bound - the opposite of the fallback's own ConstRandom(0) trick - so
      // `enumerateCard`'s project-card count lands on `max` (10) instead of a uniformly random
      // value, deterministically reproducing the coupling instead of hoping a random seed hits
      // it. This is the *real* `randomLegalAgent` and the *real* B/C/D enumerators (untouched) -
      // only the rng driving them is rigged, exactly as the recovery mechanism (embeddedDriver.ts)
      // is meant to handle.
      const forcedTowardMax = randomLegalAgent(agentRandomFrom(new ConstRandom(0.999999)));

      const events: FallbackEvent[] = [];
      // Resolve exactly red's one pending decision (the simultaneous `initialCards` setup) -
      // this is the decision the coupling is about, so there is no need to drive the rest of the
      // game to prove it fires and recovers.
      expect(() => applyDecision(red, forcedTowardMax, {onFallback: (e) => events.push(e)})).to.not.throw();

      // The coupling actually fired (genuinely exercised, not just "present"): the forced
      // toward-max rng selected all 10 offered project cards (10 * 3 M€ = 30 > PhoboLog's 23),
      // which `SelectInitialCards.completed()` rejects, so the responder's first attempt must
      // have been rejected and recovered via the fallback.
      expect(events, 'expected the over-budget initialCards selection to trigger the FR-9 fallback').to.have.length(1);
      expect(events[0].decision.model.type).to.equal('initialCards');
      expect(events[0].decision.player.id).to.equal(red.id);

      // The fallback actually recovered: red ended up with PhoboLog as its corporation (the only
      // one offered) and zero project cards in hand (the conservative `card` fallback selects
      // `min` - see embeddedDriver.ts's `buildConservativeResponse`), not stuck or crashed.
      expect(red.pickedCorporationCard?.name).to.equal(CardName.PHOBOLOG);
      expect(red.cardsInHand, 'the fallback should have selected zero (min) project cards, affordable under any corporation').to.have.length(0);
      expect(red.preludeCardsInHand).to.have.length(2);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Item 4: the Tier-1 integration batch - ~15-20 full games across 2p/3p/4p, seed-pinned, driven
  // to Phase.END.
  // ---------------------------------------------------------------------------------------------

  describe('Tier-1 batch: full games to Phase.END across 2p/3p/4p', function() {
    // Generous but bounded - a batch this size finishes in well under a second in practice
    // (Running_Notes), but CI machines vary; 60s leaves comfortable headroom without masking a
    // genuine hang (StuckGameError/DriverDecisionLimitError still fire well before that).
    this.timeout(60_000);

    // Distinct engine seeds per game (the SeededRandom-degeneracy fix, Running_Notes 2026-07-22,
    // is what makes distinct integer seeds actually produce distinct games) and a distinct agent
    // seed per game too, each derived from the engine seed by a different fixed transform so the
    // two stay independent of one another (SRS CON-5) while remaining reproducible from this list
    // alone.
    const configs: ReadonlyArray<{players: number; seed: number}> = [
      ...[9001, 9002, 9003, 9004, 9005, 9006].map((seed) => ({players: 2, seed})),
      ...[9101, 9102, 9103, 9104, 9105, 9106, 9107].map((seed) => ({players: 3, seed})),
      ...[9201, 9202, 9203, 9204, 9205, 9206, 9207].map((seed) => ({players: 4, seed})),
    ];

    it(`drives ${configs.length} full games (2p/3p/4p) to Phase.END with zero unrecovered illegal moves and zero crashes`, () => {
      let totalFallbacks = 0;
      const perGameFallbacks: Array<{players: number; seed: number; fallbacks: number; generation: number}> = [];

      for (const {players, seed} of configs) {
        const agentSeed = seed * 13 + 97; // independent of the engine seed (SRS CON-5), not equal or a trivial multiple of it.
        const game = createGame({players, seed});
        const agent = randomLegalAgent(createAgentRandom(agentSeed));

        let gameFallbacks = 0;
        let result: GameResult;
        try {
          result = runGame(game, agent, {onFallback: () => {
            gameFallbacks++;
          }});
        } catch (error) {
          expect.fail(
            `players=${players} seed=${seed} agentSeed=${agentSeed}: expected the game to reach ` +
            `Phase.END without crashing, but it threw: ${error instanceof Error ? error.stack : String(error)}`,
          );
        }

        // Fallbacks (recovered couplings) are expected and fine; an unrecovered illegal move or a
        // crash is not - and would already have failed the `expect.fail` above, since
        // `IllegalMoveError`/`UnrecoverableIllegalMoveError` propagate out of `runGame` on genuine
        // failure. This just re-confirms the game actually finished, not merely "didn't throw".
        expect(game.phase, `players=${players} seed=${seed}: expected the game to finish`).to.equal(Phase.END);
        expect(result.players, `players=${players} seed=${seed}: expected one result row per player`).to.have.length(players);

        // computeResult is exercised for real here (not a duck-typed fake IGame, as in
        // gameResult.spec.ts) - the first time a genuinely finished game reaches it.
        expect(computeResult(game)).to.deep.equal(result);

        totalFallbacks += gameFallbacks;
        perGameFallbacks.push({players, seed, fallbacks: gameFallbacks, generation: result.generation});
      }

      // Not a strength assertion (AC-1's full 1,000-game run is a separate Milestone-1 item) -
      // just a sanity check that the fallback mechanism is doing *something* observable across a
      // batch this size, per the "count them" ask in Milestone1_Subtask_Prompts.md item 2. Logged
      // (not just asserted) so a human reading the test run sees the per-game breakdown - this is
      // the data point Running_Notes' fallback-frequency entry is drawn from.
      console.log(`[Tier-1 batch] ${configs.length} games, ${totalFallbacks} total fallbacks:`, perGameFallbacks);
      expect(totalFallbacks, 'expected at least one fallback across the whole batch (a zero count here would be a red flag, not a clean pass - the coupling should fire *somewhere* in 20 real games)').to.be.greaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Item 5: determinism - same engine seed + same agent seed -> identical GameResult and
  // stableState; the two seeds vary independently of each other.
  // ---------------------------------------------------------------------------------------------

  describe('determinism (SRS CON-5/NFR-5): same engine seed + same agent seed replay identically', function() {
    this.timeout(30_000);

    it('produces identical GameResult and stableState for two independent runs of the same engine seed + agent seed', () => {
      const gameA = createGame({players: 2, seed: 8501});
      const gameB = createGame({players: 2, seed: 8501});

      const resultA = runGame(gameA, randomLegalAgent(createAgentRandom(4242)));
      const resultB = runGame(gameB, randomLegalAgent(createAgentRandom(4242)));

      expect(resultA).to.deep.equal(resultB);
      expect(stableState(gameA)).to.equal(stableState(gameB));
    });

    it('varying only the agent seed (same engine seed) changes the agent\'s move sequence, proving the two seeds are independent', () => {
      const gameA = createGame({players: 2, seed: 8502});
      const gameB = createGame({players: 2, seed: 8502});

      const resultA = runGame(gameA, randomLegalAgent(createAgentRandom(1)));
      const resultB = runGame(gameB, randomLegalAgent(createAgentRandom(2)));

      // Same engine seed alone does not force the same outcome - the agent's own seed
      // independently drives which of the (generally many) legal moves get chosen at each
      // decision, so a different agent seed is expected to diverge somewhere.
      expect(stableState(gameA)).to.not.equal(stableState(gameB));
      void resultA;
      void resultB;
    });

    it('varying only the engine seed (same agent seed) changes the game, proving the two seeds are independent the other way', () => {
      const gameA = createGame({players: 2, seed: 8503});
      const gameB = createGame({players: 2, seed: 8504});

      const resultA = runGame(gameA, randomLegalAgent(createAgentRandom(4242)));
      const resultB = runGame(gameB, randomLegalAgent(createAgentRandom(4242)));

      expect(stableState(gameA)).to.not.equal(stableState(gameB));
      void resultA;
      void resultB;
    });
  });
});
