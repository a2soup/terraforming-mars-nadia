import {expect} from 'chai';
import {Vitor} from '../../../../src/server/cards/prelude/Vitor';
import {testGame} from '../../../../tests/TestGame';

/**
 * L1 reference position - **Vitor**. Audit verdict **`undecided`**, not a divergence: the audit
 * could not settle from the printed text whether the Engine's number or the card's own text is
 * intended, and this fixture does not settle it either. It pins the number so a pin move cannot
 * change it silently.
 *
 * ENGINE: `startingMegaCredits: 48`, with the source comment "It's 45 + 3 when this corp is
 *         played" - i.e. the Engine pre-pays Vitor's own "gain 3 M€ when you play a card with a
 *         non-negative VP icon" effect for the corporation card itself.
 * PRINT:  the card's `description` and its renderer both say **45**. A silent **3 M€** discrepancy
 *         on 1 of the 17 dealable corporations, on the opening turn, where 3 M€ is roughly a
 *         seventh of a starting hand's purchase budget.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Undecided (9)", known-limitations register
 *         row 8; and the X9 pin-fragility note, which is why this one is worth a fixture at all:
 *         the "including this" idiom depends on a `playCard` ordering the Engine authors document
 *         as wrong, so an upstream fix would change every such card at once - and Vitor's 48 is
 *         the cheapest place to see it move.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and it takes no
 * position on which of 48 and 45 is correct. Changing it to 45 is a change to the fixture's
 * meaning, not a fix. If the pin moves and this fails, that is the fixture working: re-read the
 * register row before touching anything.
 */
describe('L1 / Vitor - starts on 48 M€ against a description and renderer that say 45', () => {
  it('declares 48 starting M€ while its own description says 45', () => {
    const card = new Vitor();

    // ENGINE 48 / PRINT 45 (undecided - see the header; the audit did not resolve which is right).
    expect(card.startingMegaCredits).to.eq(48);
    // The printed number, read off the card's own metadata rather than transcribed here, so the
    // two halves of the discrepancy cannot drift apart in this file.
    expect(card.metadata.description).to.contain('You start with 45 M€');
  });

  it('actually deals 48 M€ to the seat that plays it', () => {
    const [, player] = testGame(2);
    const card = new Vitor();

    player.playCorporationCard(card);

    // ENGINE 48 / PRINT 45 (undecided). Asserted through the Engine's real corporation path, not
    // just off the constant, because the constant and what a player receives are separable.
    expect(player.megaCredits).to.eq(48);
  });
});
