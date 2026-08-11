import {expect} from 'chai';
import {Decomposers} from '../../../../src/server/cards/base/Decomposers';
import {EcologyExperts} from '../../../../src/server/cards/prelude/EcologyExperts';
import {setOxygenLevel} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';
import {enterPreludePhase} from './helpers';

/**
 * L1 reference position - **Decomposers**. Engine-vs-print divergence, *escalating* (scoring).
 * One mechanism, two cards - see `ecologicalZone.spec.ts` for the other half and for the
 * Viral Enhancers control that is the evidence the mechanism is a defect rather than a reading.
 *
 * ENGINE: played *via Ecology Experts* during the prelude phase, Decomposers ends with **3**
 *         microbes - 1 for its own microbe tag, plus a hard-coded **+2** from `bespokePlay` for
 *         Ecology Experts' already-played plant and microbe tags. That is **1 VP** at 1 VP per 3
 *         microbes, immediately.
 * PRINT:  "When you play an animal, plant, or microbe tag, including this, add a microbe to this
 *         card" - an ongoing effect sees only plays that happen while it is in play, and Ecology
 *         Experts' tags were placed before Decomposers entered the tableau. The printed reading
 *         gives **1** microbe and **0 VP**. Engine 3 against print 1, and the two differ by a
 *         whole victory point on the turn it is played.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Escalating", known-limitations register row 3;
 *         Implementation Plan §7.2. Phase W of the audit resolved the mechanism as a genuine
 *         divergence on the evidence that **Viral Enhancers has no such retroactive-credit code**
 *         while responding to the same tags - so the Engine applies the reading to two cards and
 *         not to a third, which is an internal inconsistency rather than a coherent
 *         "simultaneous play" interpretation.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and changing it
 * to match the print is a change to the fixture's meaning, not a fix.
 */
describe('L1 / Decomposers - retroactive +2 microbes when played via Ecology Experts', () => {
  it('ends on 3 microbes and 1 VP when Ecology Experts played it', () => {
    const [game, player] = testGame(2);
    const card = new Decomposers();
    enterPreludePhase(game);
    player.playCard(new EcologyExperts());

    // Ecology Experts' +50 global-parameter bonus is what makes the 3% oxygen requirement moot;
    // pinned so a change to that bonus does not surface here as a scoring change.
    expect(card.canPlay(player)).is.true;
    player.playCard(card);

    // ENGINE 3 microbes / PRINT 1 microbe. 1 (own microbe tag) + 2 (retroactive credit for Ecology
    // Experts' plant and microbe tags). See the header: do not "fix" this to 1.
    expect(card.resourceCount).to.eq(3);
    // ENGINE 1 VP / PRINT 0 VP, at 1 VP per 3 microbes. This is the scoring half of the finding.
    expect(card.getVictoryPoints(player)).to.eq(1);
  });

  it('ends on 1 microbe when played normally, which is the printed number', () => {
    const [game, player] = testGame(2);
    const card = new Decomposers();
    setOxygenLevel(game, 3);

    expect(card.canPlay(player)).is.true;
    player.playCard(card);

    // The control. Engine and print agree at 1 microbe / 0 VP off the Ecology Experts line, which
    // is what confines the divergence above to that line and makes the delta exactly +2.
    expect(card.resourceCount).to.eq(1);
    expect(card.getVictoryPoints(player)).to.eq(0);
  });
});
