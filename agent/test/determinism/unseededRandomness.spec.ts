import {expect} from 'chai';
import * as fs from 'fs';
import * as path from 'path';
// gameFactory first, deliberately: it pulls in src/server/Game.ts, which is what breaks the
// Engine's Board <-> MoonBoard module-initialization cycle. Importing MilestoneAwardSelector
// ahead of it in a standalone run throws "Cannot access 'Board' before initialization" before a
// single assertion executes. Harmless under mocha (the shared setup loads the Engine first), but
// this file is also the kind of thing someone runs on its own with tsx.
import {createGame} from '../../src/engine/gameFactory';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom} from '../../src/core/rng';
import {runGame} from '../../src/driver/embeddedDriver';
import {BoardName} from '../../../src/common/boards/BoardName';
import {RandomMAOptionType} from '../../../src/common/ma/RandomMAOptionType';
import {UnseededRandom} from '../../../src/common/utils/Random';
import {DEFAULT_GAME_OPTIONS, GameOptions} from '../../../src/server/game/GameOptions';
import {chooseMilestonesAndAwards} from '../../../src/server/ma/MilestoneAwardSelector';

/**
 * Milestone 1, bullet 6, sub-task D — **P6: unseeded-randomness reachability** (SRS CON-5/NFR-5).
 *
 * The Engine calls `Math.random()` in several places. Bullet 1b found one of them
 * (`generateGameName`). P6 asks a sharper question than "does a game replay?": *which* unseeded
 * call sites can an in-scope game (base + Corporate Era + Prelude, Tharsis, 2-4p) actually
 * reach, and what does each one touch? A site that is unreachable **today** is one game option
 * away from being reachable tomorrow, and nothing in the sweep (sub-task B) would notice: flip
 * `randomMA` and every replay still agrees with every other replay *in that process*, while the
 * milestone/award set silently stops being a function of the seed at all.
 *
 * So this spec does three separable things:
 *
 * 1. **Pins the options** that keep the out-of-scope sites unreachable, with failure messages
 *    that name the consequence rather than restating the assertion.
 * 2. **Measures** unseeded consumption instead of reasoning about it - `Math.random` is replaced
 *    with a counting wrapper around real game creation and real full games, and the call stacks
 *    are checked, so the claim is "three draws, all of them in GameName.ts", not "we read the
 *    code and think it's fine". `UnseededRandom.next()` *is* `Math.random()`
 *    (src/common/utils/Random.ts:41), so one instrument covers both.
 * 3. **Inventories** every unseeded call site under `src/server` and `src/common` at the pin and
 *    records a reachability verdict per site, enforced as data. If the Engine pin ever moves, or
 *    a site appears or shifts, this fails and asks for the analysis to be re-run rather than
 *    letting a stale table sit in a document.
 *
 * Per the bullet's preamble, every check has a negative control: the counter is shown to *count*
 * (by running configurations that do reach the unseeded paths, and finding non-zero), and the
 * inventory scanner is shown to find sites in a fixture.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/** Options `createGame()` uses, for reasoning about the selector in isolation. */
const IN_SCOPE_OPTIONS: GameOptions = {
  ...DEFAULT_GAME_OPTIONS,
  boardName: BoardName.THARSIS,
  corporateEra: true,
  preludeExtension: true,
};

type UnseededSample = {calls: number; stacks: ReadonlyArray<string>};

/**
 * Runs `body` with `Math.random` replaced by a counting wrapper, and restores it no matter what.
 * The wrapper still returns real randomness - the point is to observe consumption, not to change
 * behaviour, because a stub that returned a constant could mask a site whose *effect* only shows
 * up for particular values.
 */
function withUnseededCounter<T>(body: () => T): {result: T; sample: UnseededSample} {
  const real = Math.random;
  const stacks: Array<string> = [];
  let calls = 0;

  Math.random = () => {
    calls++;
    if (stacks.length < 25) {
      stacks.push(new Error().stack ?? '<no stack>');
    }
    return real();
  };

  try {
    const result = body();
    return {result, sample: {calls, stacks}};
  } finally {
    Math.random = real;
  }
}

/** Compresses a captured stack to the Engine frames that identify the call site. */
function callSites(sample: UnseededSample): Array<string> {
  return sample.stacks.map((stack) => {
    const frames = stack.split('\n').slice(1).map((frame) => frame.trim());
    const site = frames.find((frame) => frame.includes('/src/') && !frame.includes('/common/utils/Random.ts'));
    return site ?? frames[0] ?? '<unknown>';
  });
}

describe('unseeded randomness (Milestone 1, bullet 6, sub-task D — P6)', () => {
  describe('the option guard — what keeps the out-of-scope sites unreachable', () => {
    /*
     * MilestoneAwardSelector.chooseMilestonesAndAwards (src/server/ma/MilestoneAwardSelector.ts:55)
     * is the only unseeded site an in-scope game comes anywhere near, and it is guarded by
     * options rather than by expansions being absent from the card manifests. Two independent
     * conditions keep it on the seeded path:
     *
     *   randomMA === NONE   - LIMITED/UNLIMITED route straight to getRandomMilestonesAndAwards,
     *                         which shuffles the candidates with UnseededRandom (:188-189) and
     *                         flips unseeded coins (:196).
     *   boardName cased     - inside the NONE branch, the board switch (:68-84) enumerates ten
     *                         BoardNames explicitly and its `default:` **returns the random
     *                         selection**. This is not a hypothetical branch: BoardName.HOLLANDIA
     *                         exists in the enum and is *not* in the switch, so it falls through
     *                         (verified below, not assumed).
     *
     * plus moonExpansion (:95, one unseeded coin flip choosing which pair of Moon MAs to add).
     */
    for (const players of [2, 3, 4] as const) {
      it(`createGame(${players}p) pins every option that would route milestone/award selection into Math.random`, () => {
        const options = createGame({players, seed: 606}).gameOptions;

        expect(options.randomMA,
          'randomMA must stay NONE. LIMITED or UNLIMITED selects milestones and awards with UnseededRandom ' +
          '(MilestoneAwardSelector.ts:188-189,196), so the milestone/award set stops being a function of the Engine seed ' +
          'and games cease to be reproducible from their seed (SRS CON-5/NFR-5) - silently, since every replay in a single ' +
          'process still agrees with every other.',
        ).to.equal(RandomMAOptionType.NONE);

        expect(options.boardName,
          'boardName must stay THARSIS. MilestoneAwardSelector.ts:68-84 cases ten boards explicitly and its `default:` ' +
          'branch returns the unseeded random selection - an unrecognised board (BoardName.HOLLANDIA today) reintroduces ' +
          'Math.random() into setup. Tharsis is also the in-scope board (SRS scope, agent/CLAUDE.md section 1).',
        ).to.equal(BoardName.THARSIS);

        expect(options.moonExpansion,
          'moonExpansion must stay false: MilestoneAwardSelector.ts:95 flips an unseeded coin to pick which pair of Moon ' +
          'milestones/awards to add, so the same seed would produce different milestones run to run.',
        ).to.be.false;

        expect(options.turmoilExtension,
          'turmoilExtension must stay false: PoliticalAgendas.defaultRandomElement (PoliticalAgendas.ts:108) picks agendas ' +
          'with Math.random(), which affects live rules state, not just setup.',
        ).to.be.false;

        expect(options.ceoExtension,
          'ceoExtension must stay false: the CEO card Asimov (cards/ceos/Asimov.ts:53) shuffles awards with UnseededRandom ' +
          'during play - the one unseeded site that would fire mid-game rather than at setup.',
        ).to.be.false;

        expect(options.venusNextExtension,
          'venusNextExtension must stay false: it changes the required milestone/award count (requiredQty, ' +
          'MilestoneAwardSelector.ts:65) and adds Venus MAs, both of which change how the selector is exercised.',
        ).to.be.false;
      });
    }

    it('selects the fixed Tharsis milestones and awards, drawing nothing unseeded', () => {
      const {result, sample} = withUnseededCounter(() => chooseMilestonesAndAwards(IN_SCOPE_OPTIONS));

      expect(sample.calls, 'the in-scope configuration must not consume any unseeded randomness during MA selection').to.equal(0);
      expect(result.milestones).to.deep.equal(['Terraformer', 'Mayor', 'Gardener', 'Builder', 'Planner']);
      expect(result.awards).to.deep.equal(['Landlord', 'Scientist', 'Banker', 'Thermalist', 'Miner']);
    });

    it('negative control: each guarded option really does route into Math.random when flipped', () => {
      // Without this, the guard above proves nothing: a selector that never touched Math.random
      // under *any* option would produce the same green result, and the test would be pinning
      // options for no reason. Each flip below is one edit away from a real configuration.
      const limited = withUnseededCounter(() => chooseMilestonesAndAwards({...IN_SCOPE_OPTIONS, randomMA: RandomMAOptionType.LIMITED}));
      expect(limited.sample.calls, 'randomMA=LIMITED should consume unseeded randomness').to.be.greaterThan(0);

      const unlimited = withUnseededCounter(() => chooseMilestonesAndAwards({...IN_SCOPE_OPTIONS, randomMA: RandomMAOptionType.UNLIMITED}));
      expect(unlimited.sample.calls, 'randomMA=UNLIMITED should consume unseeded randomness').to.be.greaterThan(0);

      const moon = withUnseededCounter(() => chooseMilestonesAndAwards({...IN_SCOPE_OPTIONS, moonExpansion: true}));
      expect(moon.sample.calls, 'moonExpansion adds exactly one unseeded coin flip (MilestoneAwardSelector.ts:95)').to.equal(1);
    });

    it('negative control: an uncased board (HOLLANDIA) falls into the unseeded `default:` branch', () => {
      // The claim in the H5 table that the `default:` branch is reachable was made by reading.
      // This executes it. HOLLANDIA is in BoardName but absent from the switch, so it takes the
      // random path even with randomMA=NONE - i.e. "unreachable" here rests on the board option,
      // not on the selector being safe by construction.
      const {sample} = withUnseededCounter(() => chooseMilestonesAndAwards({...IN_SCOPE_OPTIONS, boardName: BoardName.HOLLANDIA}));

      expect(sample.calls,
        'BoardName.HOLLANDIA is not one of the ten cased boards, so chooseMilestonesAndAwards should fall through to ' +
        'getRandomMilestonesAndAwards and consume unseeded randomness',
      ).to.be.greaterThan(0);
    });
  });

  describe('measured consumption — what an in-scope game actually draws', () => {
    /*
     * The whole P6 claim in one measurement: creating and playing a full in-scope game consumes
     * exactly three unseeded draws, all three inside generateGameName (Game.ts:328 ->
     * GameName.ts:28-30, one nextInt per word), and none at all after setup. `name` is one of the
     * four field families stableState.ts strips, so those three draws cannot reach any comparison
     * this project makes - which is what makes generateGameName "reachable and harmless" rather
     * than residual non-determinism.
     */
    for (const players of [2, 3, 4] as const) {
      it(`a full ${players}p game draws exactly 3 unseeded values, all in generateGameName, none during play`, function() {
        this.timeout(30_000);

        const created = withUnseededCounter(() => createGame({players, seed: 60600 + players}));
        const played = withUnseededCounter(() => runGame(created.result, randomLegalAgent(createAgentRandom(9090))));

        expect(created.sample.calls,
          'game creation should consume exactly the three draws generateGameName makes (one per name word). Sites seen:\n  ' +
          callSites(created.sample).join('\n  '),
        ).to.equal(3);

        for (const site of callSites(created.sample)) {
          expect(site, 'every unseeded draw during creation must come from GameName.ts - anything else is a new site to analyse').to.include('GameName.ts');
        }

        expect(played.sample.calls,
          'no unseeded randomness may be consumed *during play*: a mid-game draw would make the same seeds produce ' +
          'different games, breaking NFR-5 move-for-move reproducibility. Sites seen:\n  ' + callSites(played.sample).join('\n  '),
        ).to.equal(0);

        expect(played.result.generation, 'sanity: the game really was played to completion, not stopped at setup').to.be.greaterThan(1);
      });
    }

    it('the counter observes UnseededRandom too, not just direct Math.random calls', () => {
      // UnseededRandom.next() is `return Math.random()` (src/common/utils/Random.ts:41), so one
      // instrument covers both spellings. Stated as a test because the measurement above would
      // read as a much weaker result if UnseededRandom had its own generator.
      const {sample} = withUnseededCounter(() => UnseededRandom.INSTANCE.nextInt(10));

      expect(sample.calls, 'UnseededRandom must delegate to Math.random, or the measurements above miss every UnseededRandom site').to.equal(1);
    });
  });

  describe('the H5 site inventory at the pinned Engine commit', () => {
    /*
     * Every unseeded-randomness site under src/server and src/common at the pin, with the
     * reachability verdict this sub-task established. Asserted as data so the table cannot rot:
     * if the Engine pin moves, or a site is added, removed, or shifts line, this fails and asks
     * for the analysis to be redone rather than leaving a confidently-wrong table in a document.
     *
     * src/client is deliberately out of the scan: it never loads in a headless Node process.
     * (For the record, at the pin it holds three sites - oauth.ts:41,45 and
     * defaultCreateGameModel.ts:42 - plus two in CreateGameForm.vue, all UI-only.)
     */
    const H5_INVENTORY: ReadonlyArray<{site: string; rule: string; verdict: string; note: string}> = [
      {
        site: 'src/common/utils/Random.ts:41',
        rule: 'math-random',
        verdict: 'not-applicable',
        note: 'UnseededRandom.next()\'s own implementation - the single line every UnseededRandom site below actually ' +
          'calls, and the reason a Math.random counter observes them all. Not a site an in-scope game reaches on its own.',
      },
      {
        site: 'src/server/Game.ts:328',
        rule: 'unseeded-random-instance',
        verdict: 'reachable-and-harmless',
        note: 'generateGameName. Always reached, three draws per game (measured above). Affects `name` only, which ' +
          'stableState.ts strips, so it cannot influence rules state or any comparison this project makes.',
      },
      {
        site: 'src/server/cards/ceos/Asimov.ts:53',
        rule: 'unseeded-random-instance',
        verdict: 'verified-unreachable',
        note: 'CEO module. Guarded by ceoExtension=false (asserted above). Would be the only site to fire *during play*.',
      },
      {
        site: 'src/server/ma/MilestoneAwardSelector.ts:95',
        rule: 'math-random',
        verdict: 'verified-unreachable',
        note: 'Moon MA coin flip. Guarded by moonExpansion=false (asserted above; flipping it costs exactly one draw).',
      },
      {
        site: 'src/server/ma/MilestoneAwardSelector.ts:188',
        rule: 'unseeded-random-instance',
        verdict: 'verified-unreachable',
        note: 'Candidate-milestone shuffle inside getRandomMilestonesAndAwards. Guarded by randomMA=NONE *and* by ' +
          'THARSIS being an explicit case in the board switch - two independent options, either of which reopens it.',
      },
      {
        site: 'src/server/ma/MilestoneAwardSelector.ts:189',
        rule: 'unseeded-random-instance',
        verdict: 'verified-unreachable',
        note: 'Candidate-award shuffle - same guard as :188.',
      },
      {
        site: 'src/server/ma/MilestoneAwardSelector.ts:196',
        rule: 'math-random',
        verdict: 'verified-unreachable',
        note: 'Milestone-vs-award coin flip - same guard as :188.',
      },
      {
        site: 'src/server/routes/ApiCreateGame.ts:114',
        rule: 'math-random',
        verdict: 'verified-unreachable',
        note: 'HTTP create-game route: picks a random board when the request asks for one. Never loaded by embedded play. ' +
          'Milestone-5 note, alongside :176.',
      },
      {
        site: 'src/server/routes/ApiCreateGame.ts:176',
        rule: 'math-random',
        verdict: 'verified-unreachable',
        note: 'HTTP create-game route: `const seed = Math.random()`. Not an embedded-play defect, but it means a live ' +
          'game (Milestone 5) is created under a seed the Agent never sees and therefore cannot replay. Carried forward ' +
          'as an M5 finding, not a bullet-6 blocker.',
      },
      {
        site: 'src/server/turmoil/PoliticalAgendas.ts:108',
        rule: 'math-random',
        verdict: 'verified-unreachable',
        note: 'Turmoil agenda selection. Guarded by turmoilExtension=false (asserted above).',
      },
      {
        site: 'src/server/utils/server-ids.ts:3',
        rule: 'math-random',
        verdict: 'verified-unreachable',
        note: 'Module-load-time SERVER_ID/STATS_ID generation, not gameplay - and only when the env vars are unset. It ' +
          'does make module-load state differ per process, which is why sub-task C (process independence) cares about it ' +
          'even though no game state depends on it.',
      },
    ];

    const SCANNED_ROOTS: ReadonlyArray<string> = ['src/server', 'src/common'];

    const SITE_RULES: ReadonlyArray<{id: string; source: string}> = [
      {id: 'math-random', source: String.raw`\bMath\s*\.\s*random\b`},
      // `UnseededRandom.INSTANCE` rather than the bare class name, so imports don't pad the
      // inventory with lines that draw nothing. This also (deliberately) skips the singleton's
      // own declaration at Random.ts:38, which is `= new UnseededRandom()` and consumes nothing;
      // the implementation it fronts, Random.ts:41, is inventoried below under math-random.
      {id: 'unseeded-random-instance', source: String.raw`\bUnseededRandom\s*\.\s*INSTANCE\b`},
    ];

    function scanForSites(text: string, filePath: string): Array<{site: string; rule: string}> {
      const found: Array<{site: string; rule: string}> = [];
      text.split('\n').forEach((line, index) => {
        for (const rule of SITE_RULES) {
          if (new RegExp(rule.source).test(line)) {
            found.push({site: `${filePath}:${index + 1}`, rule: rule.id});
          }
        }
      });
      return found;
    }

    function listTypeScriptFiles(directory: string): Array<string> {
      const found: Array<string> = [];
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          found.push(...listTypeScriptFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          found.push(full);
        }
      }
      return found;
    }

    function scanEngine(): Array<{site: string; rule: string}> {
      const sites: Array<{site: string; rule: string}> = [];
      for (const root of SCANNED_ROOTS) {
        for (const absolute of listTypeScriptFiles(path.join(REPO_ROOT, root))) {
          const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
          sites.push(...scanForSites(fs.readFileSync(absolute, 'utf8'), relative));
        }
      }
      return sites.sort((a, b) => a.site.localeCompare(b.site));
    }

    it('finds exactly the inventoried sites, and no others', () => {
      const scanned = scanEngine();
      const inventoried = [...H5_INVENTORY].map(({site, rule}) => ({site, rule})).sort((a, b) => a.site.localeCompare(b.site));

      expect(scanned,
        'The unseeded-randomness sites under src/server and src/common no longer match the inventory this sub-task ' +
        'analysed. That happens when the Engine pin moves (agent/CLAUDE.md section 2 - currently 868714d72) or when a ' +
        'site is added or shifts line. Re-run the P6 reachability analysis for the changed sites and update H5_INVENTORY ' +
        'plus agent/docs/Determinism_Verification.md; do not just re-sort the list.',
      ).to.deep.equal(inventoried);
    });

    it('records a verdict and a reason for every inventoried site', () => {
      const allowedVerdicts = ['verified-unreachable', 'reachable-and-harmless', 'reachable-and-material', 'not-applicable'];

      for (const entry of H5_INVENTORY) {
        expect(allowedVerdicts, `unknown verdict for ${entry.site}: ${entry.verdict}`).to.include(entry.verdict);
        expect(entry.note.length, `${entry.site} needs a written reason, not just a verdict`).to.be.greaterThan(40);
      }

      // P6 as pre-committed: "the Engine call sites reachable under the in-scope configuration are
      // exactly {generateGameName}". Anything else marked reachable must be a deliberate, argued
      // change to that finding - and must be recorded as a risk in Determinism_Verification.md.
      const reachable = H5_INVENTORY.filter((entry) => entry.verdict.startsWith('reachable')).map((entry) => entry.site);
      expect(reachable, 'P6 expects generateGameName (Game.ts:328) to be the only reachable unseeded site').to.deep.equal(['src/server/Game.ts:328']);
      expect(H5_INVENTORY.filter((entry) => entry.verdict === 'reachable-and-material'),
        'a reachable-and-material site is residual non-determinism in gameplay and cannot be left as a passing test',
      ).to.be.empty;
    });

    it('negative control: the site scanner finds sites in a fixture', () => {
      // A scanner that matched nothing would make the inventory check pass against an empty
      // scan of a mistyped directory. Two guards: the fixture must be matched, and the real
      // scan must be non-trivial.
      const fixture = [
        'const roll = Math.random();',
        'inplaceShuffle(cards, UnseededRandom.INSTANCE);',
        'import {UnseededRandom} from \'../../common/utils/Random\';', // an import is not a site
        'const seeded = new SeededRandom(seed, seed);',
      ].join('\n');

      expect(scanForSites(fixture, 'fixture.ts')).to.deep.equal([
        {site: 'fixture.ts:1', rule: 'math-random'},
        {site: 'fixture.ts:2', rule: 'unseeded-random-instance'},
      ]);
      expect(scanEngine().length, 'the engine scan should have found the inventoried sites').to.be.greaterThan(5);
    });
  });
});
