import {expect} from 'chai';
import {Virus} from '../../../../src/server/cards/base/Virus';
import {OrOptions} from '../../../../src/server/inputs/OrOptions';
import {SelectOption} from '../../../../src/server/inputs/SelectOption';
import {RemoveAnyPlants} from '../../../../src/server/deferredActions/RemoveAnyPlants';
import {cast} from '../../../../src/common/utils/utils';
import {testGame} from '../../../../tests/TestGame';
import {optionTitles} from './helpers';

/**
 * L1 reference position - **Virus**. Engine-vs-print divergence, *non-escalating* (legal move set).
 *
 * ENGINE: when the Virus player holds plants themselves, the offered option list is **3** options
 *         - one "remove 5 plants from <opponent>", and **two** skip options - and it contains
 *         **no** option to remove the player's own plants. `bespokePlay` does
 *         `options.slice(0, -1)` on `RemoveAnyPlants`' result, assuming the last entry is the skip
 *         option; but `RemoveAnyPlants` pushes skip *and then* appends the acting player's own
 *         option, so the slice discards the own-plants option and Virus then appends a second skip
 *         of its own.
 * PRINT:  "Remove up to 2 animals or 5 plants from any player" - "any player" includes yourself
 *         (the Engine's own `RemoveAnyPlants` offers it everywhere else, with a warning), and one
 *         skip. The printed option list here is **3** options too, but they are a different three:
 *         opponent / self / skip, against the Engine's opponent / skip / skip.
 * SOURCE: `agent/docs/Card_Coverage_Audit.md` §3 "Non-escalating", known-limitations register
 *         row 4; Implementation Plan §7.2. Severity is negligible **because both of the affected
 *         options are dominated** - nobody removes their own plants, and a duplicated skip
 *         resolves the same either way - not because the option list matches.
 *
 * This fixture pins the **Engine's** behaviour by CON-1; it is not an endorsement, and changing it
 * to match the print is a change to the fixture's meaning, not a fix. It is worth pinning despite
 * being benign for exactly one reason: it is an *option-set* divergence, and the Agent enumerates
 * over the option set (`agent/CLAUDE.md` §5), so a change here changes what the Agent may submit.
 */
describe('L1 / Virus - the own-plants option is sliced away and the skip is duplicated', () => {
  it('offers opponent / skip / skip, with no own-plants option, when the caster holds plants', () => {
    const [, player, player2] = testGame(2);
    const card = new Virus();
    player.plants = 3;
    player2.plants = 6;

    // The un-sliced list, to make the mechanism visible: the acting player's own option is
    // appended *after* the skip, so it - not a skip - is what `slice(0, -1)` removes.
    const unsliced = cast(new RemoveAnyPlants(player, 5).execute(), OrOptions);
    expect(optionTitles(unsliced)).to.have.length(3);
    expect(unsliced.options[1].title).to.eq('Skip removing plants');
    expect(cast(unsliced.options[2], SelectOption).warnings).to.deep.eq(['removeOwnPlants']);

    const offered = cast(card.play(player), OrOptions);

    // ENGINE: 3 options, two of them skips, none of them self. PRINT: 3 options - opponent, self,
    // skip. See the header: do not "fix" the slice, and do not "fix" this assertion toward the
    // printed set. Both are changes to what the Agent's enumerator sees.
    const titles = optionTitles(offered);
    expect(titles).to.have.length(3);
    expect(titles[0]).to.match(/^Remove 5 plants from /);
    expect(titles.slice(1)).to.deep.eq(['Skip removing plants', 'Skip removal']);
    expect(offered.options.some((option) => cast(option, SelectOption).warnings?.includes('removeOwnPlants'))).is.false;
  });

  it('offers opponent / skip when the caster holds no plants, where Engine and print agree', () => {
    const [, player, player2] = testGame(2);
    const card = new Virus();
    player2.plants = 6;

    const offered = cast(card.play(player), OrOptions);

    // The control: with no own plants there is no own option for the slice to eat, so the slice
    // removes the skip instead and Virus's own skip replaces it. Engine and print agree at 2
    // options, which confines the divergence above to the caster-holds-plants case.
    const titles = optionTitles(offered);
    expect(titles).to.have.length(2);
    expect(titles[0]).to.match(/^Remove 5 plants from /);
    expect(titles[1]).to.eq('Skip removal');
  });
});
