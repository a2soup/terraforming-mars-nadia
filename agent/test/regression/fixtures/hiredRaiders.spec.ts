import {expect} from 'chai';
import {HiredRaiders} from '../../../../src/server/cards/base/HiredRaiders';
import {OrOptions} from '../../../../src/server/inputs/OrOptions';
import {cast} from '../../../../src/common/utils/utils';
import {testGame} from '../../../../tests/TestGame';
import {optionTitles} from './helpers';

/**
 * L1 reference position - **Hired Raiders**. Engine-vs-print divergence, *non-escalating*
 * ("up to N" granularity). One class-level finding, two cards - see `sabotage.spec.ts`.
 *
 * ENGINE: against one opponent holding both resources the offered set is **3** options - steal
 *         **2** steel, steal **3** M€, and "Do not steal". The amounts are the maxima only.
 * PRINT:  "Steal up to 2 steel, or 3 M€ from any player" - which grants any amount 0..2 steel or
 *         0..3 M€, i.e. **6** distinct outcomes against one opponent (1 or 2 steel, 1, 2 or 3 M€,
 *         or nothing). The Engine offers **{maximum, none}** and omits every intermediate amount.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Non-escalating", known-limitations register
 *         row 5; Implementation Plan §7.2. This is a **universal Engine convention for the whole
 *         attack class**, not a slip on one card, and the omitted amounts are dominated - with one
 *         non-contrived exception at 3-4p, where the **Miner award** counts steel + titanium
 *         together, so taking the maximum from one opponent can hand the award to another. That
 *         exception first bites at AC-5 and is a *reference game*, not a reference position: it
 *         needs a scored 3-4p board, so it belongs to Unit C's pinned corpus, not here.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and changing it
 * to match the print is a change to the fixture's meaning, not a fix. The Agent enumerates over
 * the offered set (`agent/CLAUDE.md` §5), so widening it upstream would widen the Agent's legal
 * move set - which is why this is pinned even though every omitted amount is dominated today.
 */
describe('L1 / Hired Raiders - "up to N" is offered as {maximum, none}', () => {
  it('offers 2 steel, 3 M€ and none - no partial amounts - against one opponent', () => {
    const [, player, player2] = testGame(2);
    const card = new HiredRaiders();
    player2.steel = 5;
    player2.megaCredits = 10;

    const offered = cast(card.play(player), OrOptions);

    // ENGINE 3 options {2 steel, 3 M€, none} / PRINT 6 outcomes {0,1,2 steel; 1,2,3 M€}.
    // See the header: do not add the intermediate amounts to match the print.
    const titles = optionTitles(offered);
    expect(titles).to.have.length(3);
    expect(titles[0]).to.match(/^Steal 2 steel from /);
    expect(titles[1]).to.match(/^Steal 3 M€ from /);
    expect(titles[2]).to.eq('Do not steal');
  });

  it('caps the offered amount at what the target holds, still with no smaller amount', () => {
    const [, player, player2] = testGame(2);
    const card = new HiredRaiders();
    player2.steel = 1;

    const offered = cast(card.play(player), OrOptions);

    // ENGINE {1 steel, none} / PRINT {0, 1 steel}. The label narrows to `min(2, target.steel)`,
    // which is the only place the Engine acknowledges a partial amount - and it is forced, not
    // offered. Pinned so a change to that `Math.min` is visible.
    const titles = optionTitles(offered);
    expect(titles).to.have.length(2);
    expect(titles[0]).to.match(/^Steal 1 steel from /);
    expect(titles[1]).to.eq('Do not steal');
  });
});
