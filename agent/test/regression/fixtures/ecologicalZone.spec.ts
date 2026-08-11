import {expect} from 'chai';
import {EcologicalZone} from '../../../../src/server/cards/base/EcologicalZone';
import {EcologyExperts} from '../../../../src/server/cards/prelude/EcologyExperts';
import {ViralEnhancers} from '../../../../src/server/cards/base/ViralEnhancers';
import {addGreenery} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';
import {enterPreludePhase} from './helpers';

/**
 * L1 reference position - **Ecological Zone**, plus the **Viral Enhancers** control. Engine-vs-print
 * divergence, *escalating* (scoring). Same mechanism as `decomposers.spec.ts`; the two cards share
 * one register row.
 *
 * ENGINE: played *via Ecology Experts* during the prelude phase, Ecological Zone ends with **3**
 *         animals - 2 for its own animal and plant tags, plus a hard-coded **+1** from
 *         `bespokePlay` for Ecology Experts' already-played tags.
 * PRINT:  "When you play an animal or plant tag INCLUDING THESE, add an animal to this card" - the
 *         "these" is the card's own two tags, and Ecology Experts' tags were placed before the
 *         card entered the tableau. The printed reading gives **2** animals. Engine 3 against
 *         print 2, worth a victory point as soon as the count crosses an even boundary (1 VP per
 *         2 animals).
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Escalating", known-limitations register row 3;
 *         Implementation Plan §7.2.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and changing it
 * to match the print is a change to the fixture's meaning, not a fix.
 *
 * **The second test is the finding, not decoration.** Viral Enhancers responds to plant *and*
 * microbe tags and Ecology Experts carries both, yet Viral Enhancers has no retroactive-credit
 * code - so on the identical line it pays out for its own tag only. That inconsistency is what
 * settled the audit's three-way disagreement (undecided / escalating / matches) in favour of
 * "defect" rather than "an interpretation the Engine applies consistently", and it is the reason
 * the two assertions live in one file: **a change that made all three cards agree would move one
 * of them, and the pair is what says which direction the Engine moved.**
 */
describe('L1 / Ecological Zone - retroactive +1 animal when played via Ecology Experts', () => {
  it('ends on 3 animals when Ecology Experts played it', () => {
    const [game, player] = testGame(2);
    const card = new EcologicalZone();
    addGreenery(player);
    enterPreludePhase(game);
    player.playCard(new EcologyExperts());

    expect(card.canPlay(player)).is.true;
    player.playCard(card);

    // ENGINE 3 animals / PRINT 2 animals. 2 (own animal + plant tags) + 1 (retroactive credit for
    // Ecology Experts' tags). See the header: do not "fix" this to 2.
    expect(card.resourceCount).to.eq(3);
  });

  it('ends on 2 animals when played normally, which is the printed number', () => {
    const [, player] = testGame(2);
    const card = new EcologicalZone();
    addGreenery(player);

    expect(card.canPlay(player)).is.true;
    player.playCard(card);

    // The control. Engine and print agree off the Ecology Experts line, so the delta is exactly +1.
    expect(card.resourceCount).to.eq(2);
  });

  it('Viral Enhancers gets no retroactive credit on the same line - the inconsistency', () => {
    const [game, player] = testGame(2);
    const card = new ViralEnhancers();
    enterPreludePhase(game);
    player.playCard(new EcologyExperts());
    expect(player.plants).to.eq(0);

    player.playCard(card);

    // ENGINE 1 plant / PRINT 1 plant - Viral Enhancers is `matches`, and that is the point. It
    // pays for its own microbe tag only, while Ecological Zone and Decomposers on this exact line
    // also collect Ecology Experts' plant and microbe tags. A retroactive-credit reading applied
    // consistently would give 3 here. Changing *this* assertion to 3 does not fix the pair above;
    // it deletes the evidence that they are wrong.
    expect(player.plants).to.eq(1);
  });
});
