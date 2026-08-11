import {IGame} from '../../../../src/server/IGame';
import {OrOptions} from '../../../../src/server/inputs/OrOptions';
import {Phase} from '../../../../src/common/Phase';
import {formatMessage} from '../../../../tests/TestingUtils';

/**
 * Shared helpers for the **L1 reference positions** - Milestone 2, bullet 5, Unit B
 * (`agent/docs/Milestone2_Bullet5_Prompts.md` §3.1, §3.4, Unit B).
 *
 * ## What an L1 fixture is, and what it is not
 *
 * L1 is the *agent-independent* layer of the regression suite. A fixture here asserts what the
 * **Engine at the pin** does on a card that carries known risk - one of the eight Engine-vs-print
 * divergences, one of the two effects the Engine's own suite never asserts, or one of the three
 * `undecided` items. It is invalidated by a pin move and by nothing else: no agent, no seed, no
 * corpus, no CLI. Every fixture written here survives every agent change from M3 to M7, which is
 * the entire reason the layer exists (plan §3.1).
 *
 * The corollary is the size rule. **A fixture is the smallest state that reaches the assertion** -
 * grant the card, grant the precondition, call the effect, assert the number. A fixture that plays
 * fifteen moves to set a card up is a reference *game* wearing a fixture's clothes and will break
 * for reasons that have nothing to do with the card (plan §3.1). If a card cannot be reached
 * minimally, that is a finding about the card's reachability and it goes to Unit C as a seed to
 * pin - it is not a licence to grow the fixture.
 *
 * ## The comment every fixture carries (plan §3.4 - read this before editing any assertion)
 *
 * A fixture that asserts "Immigrant City is playable at M€ production -4" looks, to a reader who
 * has not read the audit, exactly like a test encoding a bug. Someone will "fix" it toward the
 * printed card; then the suite asserts the print, the Engine asserts the Engine, and the fixture
 * fails forever on correct code. So every fixture in this directory states, in the file:
 *
 *   1. the **Engine** behaviour being asserted, as a number;
 *   2. the **printed** behaviour, as a number, and the fact that they differ;
 *   3. the audit entry it pins (`agent/docs/Card_Coverage_Audit.md` §3 and its known-limitations
 *      register row), and the sentence that this fixture pins the Engine's behaviour **by CON-1**,
 *      that it is not an endorsement, and that changing it to match the print is a change to the
 *      fixture's meaning rather than a fix.
 *
 * For the three `undecided` items the header says `undecided` and links the register row rather
 * than claiming a divergence - the audit could not settle those from the printed text, and a
 * fixture must not settle them by assertion either.
 *
 * ## Why these are plain mocha specs
 *
 * They run under `cd agent && npm test` with no CLI and no corpus, as well as under
 * `npm run regression -- --layer l1`. The redundancy is deliberate (plan §3.8): L1 is the layer
 * most likely to catch something and the cheapest to run, so it should be impossible to skip.
 */

/**
 * The titles of an `OrOptions`' options, rendered to plain strings.
 *
 * Three fixtures (Virus, Hired Raiders, Sabotage) assert an **option set** rather than a value,
 * because the divergence in each is which options the Engine offers - a granularity the print
 * grants and the Engine does not, or an option the Engine drops. Titles are `Message` objects with
 * embedded player/number data, so they are compared through the Engine's own formatter rather than
 * by reaching into the message structure.
 */
export function optionTitles(orOptions: OrOptions): Array<string> {
  return orOptions.options.map((option) => formatMessage(option.title));
}

/**
 * Put a game in the prelude phase.
 *
 * Two fixtures (Decomposers, Ecological Zone) pin a divergence whose trigger is
 * `game.phase === Phase.PRELUDES` *and* `player.playedCards.last()` being Ecology Experts, so the
 * phase is part of the reference position, not incidental setup.
 */
export function enterPreludePhase(game: IGame): void {
  game.phase = Phase.PRELUDES;
}
