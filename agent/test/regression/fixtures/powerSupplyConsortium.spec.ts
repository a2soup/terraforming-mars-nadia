import {expect} from 'chai';
import {EnergyTapping} from '../../../../src/server/cards/base/EnergyTapping';
import {PowerPlant} from '../../../../src/server/cards/base/PowerPlant';
import {PowerSupplyConsortium} from '../../../../src/server/cards/base/PowerSupplyConsortium';
import {SelectPlayer} from '../../../../src/server/inputs/SelectPlayer';
import {cast} from '../../../../src/common/utils/utils';
import {runAllActions} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';

/**
 * L1 reference position - **Power Supply Consortium**. Engine-vs-print divergence, *escalating*
 * (value). One mechanism, two cards: `bespokePlay` here is **byte-for-byte identical** to
 * `EnergyTapping`'s (verified with `diff` by the audit), so the two are two fixtures rather than
 * one only because they are two cards and either could be changed alone.
 *
 * ENGINE: when no player has energy production, the acting player's energy production ends at
 *         **+0** - gained, then handed straight back as the only legal target of the card's own
 *         "decrease any energy production".
 * PRINT:  "Requires 2 power tags. Decrease any energy production 1 step and increase your own 1
 *          step" - with no target, the printed card still increases your own, for a net **+1**.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Escalating", known-limitations register row 2;
 *         Implementation Plan §7.2.
 *
 * The reachability point is this card's, not Energy Tapping's, and it is what makes the register
 * row escalating rather than theoretical: **the requirement is 2 power *tags*, not energy
 * production**, so a player can satisfy it while nobody at the table produces energy. The first
 * assertion below pins the requirement and the zero-target state together for that reason.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and changing it
 * to match the print is a change to the fixture's meaning, not a fix.
 */
describe('L1 / Power Supply Consortium - the zero-target branch is reachable, and is a no-op', () => {
  it('is playable on 2 power tags with nobody producing energy, then nets +0', () => {
    const [game, player, player2] = testGame(2);
    const card = new PowerSupplyConsortium();
    // Two power tags, no energy production: the tableau cards are pushed rather than played, so
    // no `behavior` block runs and the zero-target precondition holds.
    player.playedCards.push(new PowerPlant(), new EnergyTapping());

    // ENGINE and PRINT agree here - the requirement is 2 power tags. Pinned because it is what
    // makes the divergence below reachable rather than contrived.
    expect(card.canPlay(player)).is.true;
    expect(player.production.energy).to.eq(0);
    expect(player2.production.energy).to.eq(0);

    card.play(player);
    runAllActions(game);
    expect(player.production.energy).to.eq(1);

    const selectPlayer = cast(player.popWaitingFor(), SelectPlayer);
    expect(selectPlayer.players).deep.eq([player]);
    selectPlayer.cb(player);
    runAllActions(game);

    // ENGINE +0 / PRINT +1 - see the header. 5 M€ for nothing. Do not "fix" toward +1.
    expect(player.production.energy).to.eq(0);
    expect(player2.production.energy).to.eq(0);
  });
});
