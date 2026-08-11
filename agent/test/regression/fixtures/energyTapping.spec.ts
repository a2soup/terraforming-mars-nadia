import {expect} from 'chai';
import {EnergyTapping} from '../../../../src/server/cards/base/EnergyTapping';
import {PowerPlant} from '../../../../src/server/cards/base/PowerPlant';
import {Resource} from '../../../../src/common/Resource';
import {SelectPlayer} from '../../../../src/server/inputs/SelectPlayer';
import {cast} from '../../../../src/common/utils/utils';
import {runAllActions} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';

/**
 * L1 reference position - **Energy Tapping**. Engine-vs-print divergence, *escalating* (value).
 *
 * ENGINE: when **no player has energy production**, the card is a net-zero no-op - the acting
 *         player's energy production ends at **+0**, having gained 1 step and immediately handed
 *         it back as the only legal target of its own "decrease any energy production". The card
 *         still costs 3 M€ and still scores **-1 VP**. `bespokePlay` defers the gain *first* in
 *         exactly this case, and the Engine's own comment says why: *"This Player must gain their
 *         energy production in order to lose it."*
 * PRINT:  "Decrease any energy production 1 step and increase your own 1 step" - with no opponent
 *         to decrease, the printed card still increases your own, for a net **+1** energy
 *         production. Engine +0 against print +1: a one-step value difference on a card whose
 *         whole payload is that one step.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Escalating", known-limitations register row 2
 *         (one finding, two cards - see `powerSupplyConsortium.spec.ts`, whose `bespokePlay` is
 *         byte-for-byte identical); Implementation Plan §7.2.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and changing it
 * to match the print is a change to the fixture's meaning, not a fix. It matters to M3: the
 * evaluator fits to Engine value, which is +0 here, and a "correction" to +1 would teach it a
 * value the Engine does not pay out.
 */
describe('L1 / Energy Tapping - net-zero no-op when nobody has energy production', () => {
  it('gains and immediately loses the step, ending at +0 energy production for -1 VP', () => {
    const [game, player, player2] = testGame(2);
    const card = new EnergyTapping();
    // The card is in the tableau only so the tag count is realistic; no production is granted.
    player.playedCards.push(card, new PowerPlant());
    expect(player.production.energy).to.eq(0);
    expect(player2.production.energy).to.eq(0);

    card.play(player);
    runAllActions(game);

    // The gain resolves first, which is what makes the acting player the only legal target.
    expect(player.production.energy).to.eq(1);

    const selectPlayer = cast(player.popWaitingFor(), SelectPlayer);
    // ENGINE: the acting player is the *only* offered target. PRINT: no target exists, and the
    // "increase your own" half stands alone. Do not "fix" this toward an empty target list.
    expect(selectPlayer.players).deep.eq([player]);
    selectPlayer.cb(player);
    runAllActions(game);

    // ENGINE +0 / PRINT +1 - see the header. The 3 M€ and the -1 VP are paid either way.
    expect(player.production.energy).to.eq(0);
    expect(player2.production.energy).to.eq(0);
    expect(card.getVictoryPoints(player)).to.eq(-1);
  });

  it('matches the print exactly as soon as any player has energy production', () => {
    const [game, player, player2] = testGame(2);
    const card = new EnergyTapping();
    player2.production.add(Resource.ENERGY, 1);

    card.play(player);
    runAllActions(game);

    // Not a divergence, and pinned for that reason: the divergence is confined to the
    // zero-target branch, so a change that moved *this* line would be a different regression.
    expect(player.production.energy).to.eq(1);
    expect(player2.production.energy).to.eq(0);
  });
});
