import {expect} from 'chai';
import {ImmigrantCity} from '../../../../src/server/cards/base/ImmigrantCity';
import {TharsisRepublic} from '../../../../src/server/cards/corporation/TharsisRepublic';
import {Resource} from '../../../../src/common/Resource';
import {SelectSpace} from '../../../../src/server/inputs/SelectSpace';
import {cast} from '../../../../src/common/utils/utils';
import {churn, runAllActions} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';

/**
 * L1 reference position - **Immigrant City**. Engine-vs-print divergence, *escalating* (legality).
 *
 * ENGINE: playable at M€ production **-4**, and at **any** M€ production (down to the -5 floor)
 *         with Tharsis Republic. `bespokeCanPlay` tests `production.megacredits >= -4`, and
 *         `bespokePlay` defers the -1 energy / -2 M€ production losses inside the city tile's
 *         `.andThen`, so the card's own "+1 M€ production when a city is placed" trigger resolves
 *         *before* the cost is paid.
 * PRINT:  the production cost is paid on play, before the card's own city trigger can refund any
 *         of it, so the card is playable only at M€ production **>= -3**. The two differ by one
 *         step, and by two steps with Tharsis Republic. The Engine is the more permissive of the
 *         two, so this is a difference in the *legal move set*, not only in value.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Escalating", known-limitations register row 1;
 *         Implementation Plan §7.2 (the divergence-catalogue row). The Engine's own
 *         `tests/cards/base/ImmigrantCity.spec.ts` asserts the same thing deliberately
 *         ("Can play at -4 M€ production", "Tharsis can play at -5").
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and changing it
 * to match the print is a change to the fixture's meaning, not a fix. The Agent plays the Engine's
 * game (`agent/CLAUDE.md` §1), so the permissive reading is the correct one *for this project*;
 * the divergence is an upstream report, never a `src/` patch.
 */
describe('L1 / Immigrant City - playable one production step below the printed floor', () => {
  it('is legal at M€ production -4, and settles at -5 because the city trigger resolves first', () => {
    const [game, player] = testGame(2);
    const card = new ImmigrantCity();
    player.production.add(Resource.ENERGY, 1);
    player.production.add(Resource.MEGACREDITS, -4);

    // ENGINE -4 / PRINT -3. See the header: the print pays -2 M€ production on play, which from
    // -4 would breach the -5 production floor, so the printed card is unplayable here.
    expect(card.canPlay(player)).is.true;

    const selectSpace = cast(churn(card.play(player), player), SelectSpace);
    selectSpace.cb(selectSpace.spaces[0]);
    runAllActions(game);

    // ENGINE -5 / PRINT n/a (unplayable). The net is -1 rather than -2 because the city placement
    // granted +1 M€ production before the -2 loss was deferred onto the queue.
    expect(player.production.megacredits).to.eq(-5);
    expect(player.production.energy).to.eq(0);
  });

  it('is legal at M€ production -5 with Tharsis Republic, where the print is two steps short', () => {
    const [game, player] = testGame(2);
    const card = new ImmigrantCity();
    player.playedCards.push(new TharsisRepublic());
    player.production.add(Resource.ENERGY, 1);
    player.production.add(Resource.MEGACREDITS, -5);

    // ENGINE: any M€ production with Tharsis Republic / PRINT: >= -3. The `|| tableau.has(...)`
    // branch of `bespokeCanPlay` drops the production check entirely. Do not "fix" toward -3.
    expect(card.canPlay(player)).is.true;

    const selectSpace = cast(churn(card.play(player), player), SelectSpace);
    selectSpace.cb(selectSpace.spaces[0]);
    runAllActions(game);

    // At the -5 floor the two +1 triggers (Tharsis Republic and the card) and the -2 loss clamp
    // out to no net change. The Engine number is -5; there is no printed number to compare.
    expect(player.production.megacredits).to.eq(-5);
  });

  it('is refused without energy production on Tharsis, where the print and the Engine agree', () => {
    const [, player] = testGame(2);
    const card = new ImmigrantCity();

    // Not a divergence - recorded so a future change to the energy clause is not mistaken for the
    // M€-production divergence above. The Engine's clause is `hasEnergyCoverage`, which is broader
    // than "the player produces energy" (an energy-production space bonus also satisfies it), but
    // Tharsis has no such space and Tharsis is the project's only board (`agent/CLAUDE.md` §1).
    expect(card.canPlay(player)).is.not.true;
  });
});
