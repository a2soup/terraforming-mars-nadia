import {expect} from 'chai';
import {CityStandardProject} from '../../../../src/server/cards/base/standardProjects/CityStandardProject';
import {Payment} from '../../../../src/common/inputs/Payment';
import {TileType} from '../../../../src/common/TileType';
import {assertPlaceCity} from '../../../../tests/assertions';
import {runAllActions} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';

/**
 * L1 reference position - **the City standard project**. Not a divergence: an **untested effect**.
 * `actionEssence` never executes anywhere in the Engine's own suite - the other four standard
 * projects have specs, this one does not - so a regression in either half of its payload would be
 * silent to the Engine and visible only in play.
 *
 * ENGINE: 25 M€ paid, a **city tile** placed, and **+1 M€ production** to the acting player.
 * PRINT:  "Spend 25 M€ to place a city tile and increase your M€ production 1 step." Engine and
 *         print **agree**, on all three. As with `hackers.spec.ts`, the agreement is what is being
 *         pinned; there is no divergence here to defend.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §5, known-limitations register row 10 ("City
 *         (standard project) effect never executes in the Engine suite"); Implementation Plan
 *         §7.2 (the untested-effects row, whose mitigation names this suite).
 *
 * This fixture pins the **Engine's** behaviour by CON-1. A future failure here is a real
 * regression, not a printed-rules disagreement.
 *
 * The second assertion pins `canAct`'s **board** clause, which is this card's own override and the
 * one part of it that can refuse: with no city-legal space the project is unavailable even to a
 * player who can afford it. That is a legal-move-set fact the Agent's enumerator depends on.
 */
describe('L1 / City standard project - the effect the Engine suite never executes', () => {
  it('places a city and raises M€ production by 1 for 25 M€', () => {
    const [game, player] = testGame(2);
    const card = new CityStandardProject();
    player.megaCredits = card.cost;

    expect(card.canAct(player)).is.true;
    card.payAndExecute(player, Payment.of({megacredits: card.cost}));
    runAllActions(game);

    // ENGINE: a city tile is offered for placement. PRINT: the same. No Engine test asserts it.
    const space = assertPlaceCity(player, player.popWaitingFor());
    expect(space.tile?.tileType).to.eq(TileType.CITY);

    // ENGINE +1 M€ production and 25 M€ spent / PRINT the same. This pair is the whole payload,
    // and it is the reason the fixture exists.
    expect(player.production.megacredits).to.eq(1);
    expect(player.megaCredits).to.eq(0);
    expect(player.terraformRating).to.eq(20);
  });

  it('refuses when no space on the board can take a city', () => {
    const [game, player] = testGame(2);
    const card = new CityStandardProject();
    player.megaCredits = card.cost;

    // Fill every city-legal space, so only the board clause can be doing the refusing.
    for (const space of game.board.getAvailableSpacesForCity(player)) {
      game.addGreenery(player, space);
    }

    // ENGINE: `canAct` false on an affordable project. PRINT: the same - you cannot place a tile
    // with nowhere to place it. Pinned because it is the card's own `canAct` override, and
    // because a change here changes the Agent's legal move set rather than a value.
    expect(card.canAct(player)).is.false;
  });
});
