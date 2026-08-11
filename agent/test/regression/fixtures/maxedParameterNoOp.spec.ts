import {expect} from 'chai';
import {AquiferPumping, OCEAN_COST} from '../../../../src/server/cards/base/AquiferPumping';
import {SelectSpace} from '../../../../src/server/inputs/SelectSpace';
import {cast} from '../../../../src/common/utils/utils';
import {maxOutOceans, runAllActions} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';

/**
 * L1 reference position - **maxed-parameter no-op actions (X5)**, pinned on **Aquifer Pumping**.
 * Audit verdict **`undecided`**, and *systemic*: the same shape appears on the Aquifer and
 * Asteroid standard projects, Convert Heat, Aquifer Pumping and Water Import From Europa.
 *
 * ENGINE: with the ocean count already at its maximum, `canAct` returns **true** - with a
 *         `maxoceans` warning attached, not a refusal - so paying 8 M€ for a 10th ocean is an
 *         enabled, server-validated legal move that places **no tile**, grants **no TR**, and
 *         returns **nothing**. Net: **-8 M€ for 0 effect**.
 * PRINT:  the printed card is silent on what happens when the parameter is already maxed - the
 *         rulebook governs it, not the card - so there is **no printed number to compare**. That
 *         is what makes this `undecided` rather than a divergence, and the fixture takes no
 *         position on whether the move should be offered.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Undecided (9)", known-limitations register
 *         row 6. The behaviour is deliberate and internally consistent - the Engine is scrupulous
 *         about not granting TR on the maxed step - and its impact is confined to random-legal
 *         baselines burning resources, because no evaluating agent picks a dominated move.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and turning the
 * `canAct` below into a refusal would be a change to the fixture's meaning, not a fix. It is a
 * *legal move set* fact: the Agent enumerates over what `canAct` allows (`agent/CLAUDE.md` §5),
 * so a change here changes what the Agent may submit, not just what it scores.
 *
 * **Aquifer Pumping is the pinned member of the five for a reason.** Four of the five are in scope
 * (Water Import From Europa is Venus), and three of those four - the Aquifer and Asteroid standard
 * projects and Convert Heat - each have an Engine spec that *acts* at the maximum and asserts the
 * no-op end to end ("Paying when the global parameter is at its goal is a valid stall action").
 * Aquifer Pumping's own spec asserts only that `canAct` stays true at maxed oceans ("Can act if can
 * pay even after oceans are maxed") - it never acts, so **what the 8 M€ buys at that point is
 * asserted nowhere in the Engine suite**. It is the one of the four where a regression is silent.
 */
describe('L1 / maxed-parameter no-op (X5) - Aquifer Pumping at maxed oceans', () => {
  it('is legal, spends 8 M€, and places nothing', () => {
    const [game, player] = testGame(2);
    const card = new AquiferPumping();
    maxOutOceans(player);
    // `maxOutOceans` hands the player the nine oceans' placement bonuses. The steel is cleared so
    // the 8 M€ resolves without a payment choice - the fixture is about the effect, not the
    // payment - and the plants are left alone because nothing here reads them.
    player.steel = 0;
    player.megaCredits = OCEAN_COST;
    const oceansBefore = game.board.getOceanSpaces().length;
    const trBefore = player.terraformRating;

    // ENGINE: true, with a warning rather than a refusal / PRINT: no printed number (undecided -
    // see the header). Do not turn this into `is.false` to make the move go away.
    expect(card.canAct(player)).is.true;
    expect(card.warnings.has('maxoceans')).is.true;

    card.action(player);
    runAllActions(game);

    // ENGINE -8 M€ for nothing: no tile, no TR, and nothing left pending. This is the half the
    // Engine suite never executes.
    expect(player.megaCredits).to.eq(0);
    expect(game.board.getOceanSpaces()).to.have.length(oceansBefore);
    expect(player.terraformRating).to.eq(trBefore);
    expect(player.popWaitingFor()).is.undefined;
  });

  it('spends the same 8 M€ for an ocean and a TR step below the maximum', () => {
    const [game, player] = testGame(2);
    const card = new AquiferPumping();
    player.megaCredits = OCEAN_COST;
    const oceansBefore = game.board.getOceanSpaces().length;
    const trBefore = player.terraformRating;

    expect(card.canAct(player)).is.true;
    expect(card.warnings.has('maxoceans')).is.false;

    card.action(player);
    runAllActions(game);
    const selectSpace = cast(player.popWaitingFor(), SelectSpace);
    selectSpace.cb(selectSpace.spaces[0]);

    // The control: the identical 8 M€ buys a tile and a TR step when the parameter is not maxed,
    // which is what makes the first test a *no-op* rather than a card that was never worth playing.
    expect(player.megaCredits).to.eq(0);
    expect(game.board.getOceanSpaces()).to.have.length(oceansBefore + 1);
    expect(player.terraformRating).to.eq(trBefore + 1);
  });
});
