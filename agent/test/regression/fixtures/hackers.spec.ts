import {expect} from 'chai';
import {Hackers} from '../../../../src/server/cards/base/Hackers';
import {Resource} from '../../../../src/common/Resource';
import {SelectPlayer} from '../../../../src/server/inputs/SelectPlayer';
import {cast} from '../../../../src/common/utils/utils';
import {runAllActions} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';

/**
 * L1 reference position - **Hackers**. Not a divergence: an **untested effect**. The Engine's own
 * `tests/cards/base/Hackers.spec.ts` asserts `canPlay` and nothing else, so the card's whole
 * payload - the 2-step M€ production attack in `bespokePlay` - has no assertion anywhere in the
 * Engine suite. It is exercised hundreds of times in play, which catches a *crash* and nothing
 * else; a value regression here would be silent.
 *
 * ENGINE: -1 energy production and +2 M€ production to the acting player (the declarative
 *         `behavior` block), and **-2 M€ production** to the chosen target
 *         (`DecreaseAnyProduction(player, MEGACREDITS, {count: 2, stealing: true})`).
 * PRINT:  "Decrease your energy production 1 step and any M€ production 2 steps. Increase your M€
 *         production 2 steps." Engine and print **agree**, on all three numbers. That agreement is
 *         the thing being pinned - there is no divergence here to defend, only an assertion that
 *         did not exist.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §5, known-limitations register row 9 ("Hackers
 *         dedicated spec tests `canPlay` only, never the `bespokePlay` effect"); Implementation
 *         Plan §7.2 (the untested-effects row, whose mitigation names this suite).
 *
 * This fixture pins the **Engine's** behaviour by CON-1. Because Engine and print agree, a future
 * failure here is a real regression in one of them and should be read as such - unlike the
 * divergence fixtures in this directory, there is no printed number to be tempted toward.
 *
 * One thing worth knowing before reading `stealing: true` as a transfer: it is **not** one.
 * `Production.add`'s `stealing` flag only selects the log phrasing; the acting player's +2 comes
 * from the `behavior` block and is paid whether or not any target is found. The two halves are
 * independent, which is why they are asserted separately below.
 */
describe('L1 / Hackers - the bespokePlay M€ production attack, which no Engine test asserts', () => {
  it('takes 2 M€ production from the chosen target while paying the card cost to the actor', () => {
    const [game, player, player2] = testGame(2);
    const card = new Hackers();
    player.production.add(Resource.ENERGY, 1);
    player2.production.add(Resource.MEGACREDITS, 3);

    expect(card.canPlay(player)).is.true;
    card.play(player);

    // The `behavior` half. ENGINE -1 energy / +2 M€ production; PRINT the same.
    expect(player.production.energy).to.eq(0);
    expect(player.production.megacredits).to.eq(2);

    runAllActions(game);
    const selectPlayer = cast(player.popWaitingFor(), SelectPlayer);
    // Both seats qualify - the acting player's own M€ production is a legal target too, since it
    // sits above the -5 floor. Pinned because it is a *legal move set* fact the Agent enumerates.
    expect(selectPlayer.players).to.have.length(2);
    selectPlayer.cb(player2);
    runAllActions(game);

    // The `bespokePlay` half - ENGINE -2 M€ production on the target, PRINT the same, and **no
    // Engine test asserts it**. This assertion is the reason the fixture exists.
    expect(player2.production.megacredits).to.eq(1);
    // Unchanged by the attack: the actor's +2 came from the behavior block, not from the target.
    expect(player.production.megacredits).to.eq(2);
    expect(card.getVictoryPoints(player)).to.eq(-1);
  });

  it('always has a legal target - the actor themselves - so it can never fizzle', () => {
    const [game, player, player2] = testGame(2);
    const card = new Hackers();
    player.production.add(Resource.ENERGY, 1);
    // Both seats pinned to the -5 M€ production floor, so the opponent cannot lose 2 more steps.
    player.production.override({megacredits: -5});
    player2.production.override({megacredits: -5});

    card.play(player);
    // The behavior block resolves first and lifts the actor to -3.
    expect(player.production.megacredits).to.eq(-3);

    runAllActions(game);
    const selectPlayer = cast(player.popWaitingFor(), SelectPlayer);
    // ENGINE: the actor is the **only** offered target and the choice is mandatory. -3 is exactly
    // two steps above the -5 floor, and the actor's post-behavior production is never lower than
    // that, so `DecreaseAnyProduction` here can never return an empty target list: **Hackers has
    // no fizzle branch.** PRINT: "decrease any M€ production 2 steps" is silent on whether a
    // target must exist. Pinned because "the attack found no target" and "the attack was forced
    // onto its own caster" are different events, and only one of them is reachable.
    expect(selectPlayer.players).deep.eq([player]);
    selectPlayer.cb(player);
    runAllActions(game);

    // Net for the actor against a floored table: 0 M€ production, -1 energy production, -1 VP,
    // 3 M€ spent. The Engine offers no way to decline.
    expect(player.production.megacredits).to.eq(-5);
    expect(player.production.energy).to.eq(0);
    expect(player2.production.megacredits).to.eq(-5);
  });
});
