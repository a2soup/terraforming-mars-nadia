import {expect} from 'chai';
import {Resource} from '@/common/Resource';
import {testGame} from '../../../tests/TestGame';

/**
 * **Hazard H12, settled** (Milestone 2, bullet 5, Unit A §1; agent/docs/Milestone2_Bullet5_Prompts.md
 * §2.8). No agent spec had ever imported the Engine's own `testGame()` helper, so the import path
 * and the `tsconfig` interaction were unproven - and Unit B is about to build thirteen L1 fixtures
 * on top of them.
 *
 * **The working import, for Unit B:** `import {Resource} from '@/common/Resource';
import {testGame} from '../../../tests/TestGame';` from a
 * spec at `agent/test/regression/*.spec.ts` (one more `..` from `fixtures/`). No `tsconfig` change
 * and no path alias is needed: `agent/package.json`'s test script already runs mocha with
 * `--import=tsx --require ../tests/testing/setup.ts`, so the Engine's test bootstrap is loaded and
 * `tsx` resolves the relative path out of `agent/` without consulting `agent/tsconfig.json`'s
 * `include` (which covers only `agent/**`). `TestPlayer` comes from `../../../tests/TestPlayer` the
 * same way.
 *
 * This spec is kept - it is thirty lines, and it is the thing that fails first and legibly if a
 * future toolchain change breaks that import for all thirteen fixtures at once.
 */
describe('Engine testGame() is importable from an agent spec (H12)', () => {
  it('builds a 2p game with the in-scope modules and reaches a live state', () => {
    const [game, player, opponent] = testGame(2, {corporateEra: true, preludeExtension: true});

    expect(game.players).has.length(2);
    expect(game.players.map((seat) => seat.id)).to.deep.equal([player.id, opponent.id]);
    // The helper's own contract: initial card selection is skipped by default, so the game is in an
    // intermediate but testable state - which is exactly the state an L1 fixture wants to start from
    // (§3.1: the smallest state that reaches the assertion).
    expect(player.getWaitingFor()).is.undefined;
    expect(game.gameOptions.preludeExtension).is.true;
  });

  it('a fixture can grant a card and a precondition and read the Engine back', () => {
    // The shape every Unit B fixture takes, proven end to end once here: mutate the smallest amount
    // of state, call the Engine, assert the number the Engine produced.
    const [/* game */, player] = testGame(2, {corporateEra: true});
    player.production.add(Resource.MEGACREDITS, 3);
    expect(player.production.megacredits).to.equal(3);
  });
});
