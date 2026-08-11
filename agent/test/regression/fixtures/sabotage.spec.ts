import {expect} from 'chai';
import {Sabotage} from '../../../../src/server/cards/base/Sabotage';
import {OrOptions} from '../../../../src/server/inputs/OrOptions';
import {cast} from '../../../../src/common/utils/utils';
import {testGame} from '../../../../tests/TestGame';
import {optionTitles} from './helpers';

/**
 * L1 reference position - **Sabotage**. Engine-vs-print divergence, *non-escalating* ("up to N"
 * granularity). Same class-level finding as `hiredRaiders.spec.ts`; the two share one register row.
 *
 * ENGINE: against one opponent holding all three resources the offered set is **4** options -
 *         remove **3** titanium, remove **4** steel, remove **7** M€, and "Do not remove
 *         resource". Maxima only.
 * PRINT:  "Remove up to 3 titanium, or 4 steel, or 7 M€ from any player" - any amount in 0..3,
 *         0..4 or 0..7, i.e. **15** distinct outcomes against one opponent. The Engine offers
 *         **{maximum, none}**.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Non-escalating", known-limitations register
 *         row 5; Implementation Plan §7.2. **Flooding is the contrast that shows the distinction
 *         is real**: it prints "remove 4 M€" with no "up to", removes exactly 4, and the audit
 *         verdicts it `matches` - so the divergence is specifically about the *"up to"* wording,
 *         not about attack cards generally.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and changing it
 * to match the print is a change to the fixture's meaning, not a fix. The one non-dominated case
 * (the 3-4p Miner award counting steel + titanium) is a reference *game* and belongs to Unit C's
 * pinned corpus, not to a fixture.
 */
describe('L1 / Sabotage - "up to N" is offered as {maximum, none}', () => {
  it('offers 3 titanium, 4 steel, 7 M€ and none - no partial amounts - against one opponent', () => {
    const [, player, player2] = testGame(2);
    const card = new Sabotage();
    player2.titanium = 5;
    player2.steel = 6;
    player2.megaCredits = 10;

    const offered = cast(card.play(player), OrOptions);

    // ENGINE 4 options {3 Ti, 4 steel, 7 M€, none} / PRINT 15 outcomes across 0..3 / 0..4 / 0..7.
    // See the header: do not add the intermediate amounts to match the print.
    const titles = optionTitles(offered);
    expect(titles).to.have.length(4);
    expect(titles[0]).to.match(/^Remove 3 titanium from /);
    expect(titles[1]).to.match(/^Remove 4 steel from /);
    expect(titles[2]).to.match(/^Remove 7 M€ from /);
    expect(titles[3]).to.eq('Do not remove resource');
  });

  it('offers nothing but returns undefined when the opponent holds none of the three', () => {
    const [, player] = testGame(2);
    const card = new Sabotage();

    // Not a divergence. Pinned because the "no options at all" path is the branch that returns
    // `undefined` rather than an empty `OrOptions`, and the Agent's enumerator distinguishes them.
    expect(card.play(player)).is.undefined;
  });
});
