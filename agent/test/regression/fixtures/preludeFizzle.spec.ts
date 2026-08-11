import {expect} from 'chai';
import {EccentricSponsor} from '../../../../src/server/cards/prelude/EccentricSponsor';
import {EcologyExperts} from '../../../../src/server/cards/prelude/EcologyExperts';
import {PreludesExpansion} from '../../../../src/server/preludes/PreludesExpansion';
import {runAllActions} from '../../../../tests/TestingUtils';
import {testGame} from '../../../../tests/TestGame';
import {enterPreludePhase} from './helpers';

/**
 * L1 reference position - **the prelude-fizzle 15 M€ (X3)**. Audit verdict **`undecided`**, and
 * *systemic*: it touches Ecology Experts, Eccentric Sponsor, Valley Trust and four paid preludes
 * through one shared code path, `PreludesExpansion.fizzle`.
 *
 * ENGINE: an unplayable prelude is discarded and its owner is granted **15 M€**.
 * PRINT:  no printed basis for the 15 was found by any of the audit's three review batches - the
 *         rules text does not say what happens, so there is **no printed number to compare**. That
 *         is what makes this `undecided` rather than a divergence, and the fixture takes no
 *         position on whether 15 is right.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Undecided (9)", known-limitations register
 *         row 7. Reachable in ordinary play: Ecoline at 36 M€ buying 10 initial cards is left with
 *         6, and a prelude that needs a card it cannot afford fizzles.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement. Changing the 15
 * to some other number is a change to the fixture's meaning, not a fix.
 *
 * **The second test is why this is one fixture and not two.** The audit's finding is not "15 M€"
 * on its own - it is that two preludes reach the same 15 M€ by *different paths*: Ecology Experts
 * is refused at the selection gate by its own `canPlay`, while Eccentric Sponsor passes that gate,
 * is genuinely played, and fizzles from inside `bespokePlay` after its deferred "play a card"
 * finds nothing. For Eccentric Sponsor the two paths converge (no other on-play effect, no tags,
 * no VP), which is the audit's basis for "no legality difference for Nadia and no exploit". The
 * pair is what pins that convergence; either assertion alone would not.
 */
describe('L1 / prelude fizzle - 15 M€, by two different paths, with no printed basis', () => {
  it('grants 15 M€ from inside Eccentric Sponsor\'s bespokePlay when the hand has nothing playable', () => {
    const [game, player] = testGame(2);
    const card = new EccentricSponsor();
    enterPreludePhase(game);
    player.megaCredits = 0;
    expect(player.cardsInHand).is.empty;

    // Eccentric Sponsor passes the selection gate - it has no `canPlay` of its own - and is
    // genuinely played. The fizzle happens afterwards, inside the deferred `PlayProjectCard`.
    expect(card.canPlay(player)).is.true;
    player.playCard(card);
    runAllActions(game);

    // ENGINE 15 M€ / PRINT: no printed number (undecided - see the header).
    expect(player.megaCredits).to.eq(15);
    // The discount is withdrawn along with the fizzle, so the next card played is not cheapened.
    expect(player.lastCardPlayed).is.undefined;
  });

  it('grants the same 15 M€ to Ecology Experts, which is refused at the selection gate instead', () => {
    const [game, player] = testGame(2);
    const card = new EcologyExperts();
    enterPreludePhase(game);
    player.megaCredits = 0;

    // Ecology Experts *does* have a `canPlay`, and with an empty hand it refuses - so this card
    // never reaches `bespokePlay` at all. The two preludes take different routes to one outcome.
    expect(card.canPlay(player)).is.false;

    const selectPrelude = PreludesExpansion.selectPreludeToPlay(player, [card]);
    selectPrelude.cb([card]);
    runAllActions(game);

    // ENGINE 15 M€ / PRINT: no printed number (undecided). Same grant, different path, and the
    // card's plant-production behavior never runs.
    expect(player.megaCredits).to.eq(15);
    expect(player.production.plants).to.eq(0);
  });
});
