import {expect} from 'chai';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Milestone 1, bullet 6, sub-task D — **P5: structural RNG separation** (SRS CON-5/NFR-5).
 *
 * Bullet 6's second clause is "confirm the Agent's search/determinization RNG is seeded
 * separately from the Engine's". The evidence that existed before this spec was *behavioural*:
 * vary one seed, the outcome changes (`randomLegalAgent.integration.spec.ts:149-189`). That
 * demonstrates the two seeds are not the same seed; it does **not** establish that no agent code
 * path reaches around both of them into `Math.random()`, the wall clock, `UnseededRandom`, or
 * the Engine's own `game.rng`. A behavioural check also only covers the code paths the test
 * happened to execute, and the decision core is going to grow through M3-M6.
 *
 * So this is a **source-level** guard: every `.ts` under `agent/src` is read and matched against
 * {@link RULES}. It is deliberately blunt - it matches text, including text inside comments, and
 * it does not parse TypeScript. A guard that needed to be right about scoping to be useful would
 * be a guard nobody trusts; this one is trivially auditable and its failure mode is a false
 * positive that a human resolves in one line of {@link ALLOWLIST}, never a silent false negative.
 *
 * **Allowlisting is by explicit file + rule + occurrence count, with a written reason, never by
 * pattern** (Milestone1_Bullet6_Prompts.md, sub-task D section 1). A pattern-based allowlist
 * grows silently; an occurrence-counted one fails the moment a second, unreviewed use appears in
 * an already-allowlisted file. Stale entries fail too - see 'the allowlist is exact'.
 *
 * **If this spec fails on a file you just added** (sub-tasks B and C both add modules under
 * `agent/src/determinism/`, and a cross-process or contamination harness plausibly wants to time
 * or timestamp something): the fix is to decide which side of the line the code is on. Timing
 * belongs in `agent/src/bench`; a timestamp that only ever lands in a report header belongs in
 * {@link ALLOWLIST} with a reason like corpus.ts's; anything that a decision or a game's state
 * can depend on belongs in neither, and is the failure this spec exists to catch.
 *
 * Per the bullet's preamble ("a green result is the suspicious one"), the scanner is itself
 * checked two ways: fixture strings that must be flagged (a broken regex would otherwise make
 * this file decorative), and an assertion that the walk actually reached the real source tree (a
 * broken walker reports zero violations and looks exactly like a pass).
 */

/** `agent/`, resolved from this file so the scan is independent of the cwd mocha was started in. */
const AGENT_ROOT = path.join(__dirname, '..', '..');
const SRC_ROOT = path.join(AGENT_ROOT, 'src');

/**
 * The one directory exempt from the rules below. `agent/src/bench/` is the bullet-5 speed-spike
 * harness: measuring wall-clock time is its entire job (`harness.ts:33` uses
 * `process.hrtime.bigint()`, `harness.ts:175` stamps a report with `new Date()`), and it
 * contains no decision logic. It is excluded wholesale, by directory, because that exemption is
 * about *what the directory is for* rather than about individual lines - and because a bench
 * file that started making decisions would be the wrong file in the wrong place regardless of
 * what this spec said.
 */
const EXCLUDED_DIRECTORIES: ReadonlyArray<string> = ['src/bench'];

type Rule = {
  id: string;
  /** Regex source, compiled fresh per scan so no `lastIndex` state is ever shared. */
  source: string;
  /** Shown verbatim in the failure message - the reader needs to know *why*, not just *what*. */
  why: string;
};

const RULES: ReadonlyArray<Rule> = [
  {
    id: 'math-random',
    source: String.raw`\bMath\s*\.\s*random\b`,
    why: 'unseeded randomness: a decision drawn from Math.random() is reproducible under no seed at all, ' +
      'so the game it appears in can never be replayed (NFR-5). Use createAgentRandom() (agent/src/core/rng.ts).',
  },
  {
    id: 'date-now',
    source: String.raw`\bDate\s*\.\s*now\b`,
    why: 'wall-clock read: any state derived from the clock differs between two replays of the same seeds. ' +
      'The four wall-clock field families the Engine already produces are stripped by stableState.ts; the Agent must add none.',
  },
  {
    id: 'new-date',
    source: String.raw`\bnew\s+Date\b`,
    why: 'wall-clock read - see date-now.',
  },
  {
    id: 'process-hrtime',
    source: String.raw`\bprocess\s*\.\s*hrtime\b`,
    why: 'high-resolution wall clock. Timing belongs in agent/src/bench (the one allowlisted directory), not in code that plays.',
  },
  {
    id: 'performance-now',
    source: String.raw`\bperformance\s*\.\s*now\b`,
    why: 'high-resolution wall clock - see process-hrtime. (Not in P5\'s literal list, which predates nobody using it; ' +
      'it is the same hazard by another name, and adding it now costs nothing.)',
  },
  {
    id: 'unseeded-random',
    source: String.raw`\bUnseededRandom\b`,
    why: 'the Engine\'s Math.random() wrapper (src/common/utils/Random.ts:37). SeededRandom and ConstRandom are ' +
      'deterministic and permitted; UnseededRandom is exactly the thing this bullet exists to keep out of agent code.',
  },
  {
    id: 'game-rng',
    source: String.raw`\.\s*rng\b`,
    why: 'a read of the Engine\'s own RNG (game.rng). Drawing from it makes the Agent\'s choices a function of the ' +
      'Engine seed and *advances the Engine\'s stream*, so the game itself changes depending on how much the Agent thought - ' +
      'which is precisely the coupling CON-5 forbids (see the M4 seed contract in Determinism_Verification.md).',
  },
];

type AllowlistEntry = {
  /** Path relative to `agent/`, e.g. `src/determinism/corpus.ts`. */
  file: string;
  rule: string;
  /** Exact number of matches expected. A second, unreviewed use in the same file fails the spec. */
  occurrences: number;
  reason: string;
};

const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  {
    file: 'src/determinism/corpus.ts',
    rule: 'new-date',
    occurrences: 1,
    reason:
      'CorpusHeader.createdAt: a provenance timestamp stamped once when a corpus file is written, so a committed ' +
      'corpus records when it was produced. It is not compared by assertHeaderCompatible() (which checks engineCommit, ' +
      'seedDerivationVersion and the two gameplay-reaching env vars), never reaches a decision, and never enters a ' +
      'fingerprint - saveCorpus writes it into the header alone. Removing it would lose provenance and gain no determinism.',
  },
];

type Violation = {file: string; line: number; rule: string; text: string};

/** Matches one rule against a blob of source, returning 1-based line numbers. Pure - used by both the tree scan and the fixtures. */
function scanText(text: string, rule: Rule): Array<{line: number; text: string}> {
  const pattern = new RegExp(rule.source, 'g');
  const hits: Array<{line: number; text: string}> = [];
  text.split('\n').forEach((line, index) => {
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      hits.push({line: index + 1, text: line.trim()});
    }
  });
  return hits;
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

/** Path relative to `agent/`, with forward slashes, so entries read the same on any platform. */
function agentRelative(absolute: string): string {
  return path.relative(AGENT_ROOT, absolute).split(path.sep).join('/');
}

/** Every scanned file, as `agent/`-relative paths, sorted - the excluded directories already removed. */
function scannedFiles(): Array<string> {
  return listTypeScriptFiles(SRC_ROOT)
    .map(agentRelative)
    .filter((file) => !EXCLUDED_DIRECTORIES.some((directory) => file === directory || file.startsWith(directory + '/')))
    .sort();
}

/** Every rule hit in the scanned tree, allowlist *not* applied. */
function rawViolations(): Array<Violation> {
  const violations: Array<Violation> = [];
  for (const file of scannedFiles()) {
    const text = fs.readFileSync(path.join(AGENT_ROOT, file), 'utf8');
    for (const rule of RULES) {
      for (const hit of scanText(text, rule)) {
        violations.push({file, line: hit.line, rule: rule.id, text: hit.text});
      }
    }
  }
  return violations;
}

function isAllowlisted(violation: Violation): boolean {
  return ALLOWLIST.some((entry) => entry.file === violation.file && entry.rule === violation.rule);
}

function describeViolation(violation: Violation): string {
  const rule = RULES.find((candidate) => candidate.id === violation.rule);
  return `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.text}\n      -> ${rule?.why}`;
}

/** Files under `agent/src` (bench included) whose text imports the Engine's Random module. */
function filesImportingEngineRandom(): Array<{file: string; symbols: Array<string>}> {
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*'@\/common\/utils\/Random'/;
  const results: Array<{file: string; symbols: Array<string>}> = [];
  for (const file of listTypeScriptFiles(SRC_ROOT).map(agentRelative).sort()) {
    const match = importPattern.exec(fs.readFileSync(path.join(AGENT_ROOT, file), 'utf8'));
    if (match !== null) {
      results.push({file, symbols: match[1].split(',').map((symbol) => symbol.trim()).filter((symbol) => symbol.length > 0).sort()});
    }
  }
  return results;
}

describe('RNG separation (Milestone 1, bullet 6, sub-task D — P5)', () => {
  describe('the guard itself', () => {
    it('flags a fixture containing each forbidden construct', () => {
      // Negative control. Without this, a typo in any rule's regex turns that rule off silently
      // and the whole spec becomes decorative - it would still pass, on a tree it never matched.
      const fixtures: Record<string, string> = {
        'math-random': 'const roll = Math.random();',
        'date-now': 'const t = Date.now();',
        'new-date': 'const stamped = new Date().toISOString();',
        'process-hrtime': 'const start = process.hrtime.bigint();',
        'performance-now': 'const start = performance.now();',
        'unseeded-random': 'inplaceShuffle(cards, UnseededRandom.INSTANCE);',
        'game-rng': 'const pick = game.rng.nextInt(cards.length);',
      };

      for (const rule of RULES) {
        const fixture = fixtures[rule.id];
        expect(fixture, `every rule needs a fixture that must be flagged; ${rule.id} has none`).to.be.a('string');
        expect(scanText(fixture, rule), `rule '${rule.id}' failed to flag its own fixture: ${fixture}`).to.have.length(1);
      }
    });

    it('does not flag near-misses that are not the hazard', () => {
      // The other half of the control: a rule that flags everything is as useless as one that
      // flags nothing, and would push real code into the allowlist until the allowlist *is* the
      // codebase. Each of these is something agent code may legitimately contain.
      const clean = [
        'const seed = config.rngSeed;', // `rngSeed`, not a `.rng` read - \b stops the match
        'const source = myMath.randomize();', // not `Math.random` - \b stops the match at the `y`
        'const random = createAgentRandom(agentSeed);',
        'const updated = updateDateless(record);',
        'const rng = new SeededRandom(seed, seed);',
        'const conservative = new ConstRandom(0);',
      ].join('\n');

      for (const rule of RULES) {
        expect(scanText(clean, rule), `rule '${rule.id}' flagged a benign line`).to.have.length(0);
      }
    });

    it('actually walks the real source tree', () => {
      // A broken walker (wrong root, wrong extension filter, a readdir that silently returns
      // nothing) produces zero violations, which is indistinguishable from a pass. Pin down that
      // the scan reached files that certainly exist and that the one exclusion really excludes.
      const files = scannedFiles();

      expect(files.length, 'the agent source tree should be substantially larger than this').to.be.greaterThan(15);
      expect(files).to.include('src/core/rng.ts');
      expect(files).to.include('src/engine/gameFactory.ts');
      expect(files).to.include('src/determinism/replay.ts');
      expect(files.filter((file) => file.startsWith('src/bench/')), 'src/bench must be excluded, and it is not empty').to.be.empty;
      expect(listTypeScriptFiles(SRC_ROOT).map(agentRelative).filter((file) => file.startsWith('src/bench/')).length).to.be.greaterThan(0);
    });

    it('has an exact allowlist: every entry matches, matches the stated number of times, and none is stale', () => {
      const violations = rawViolations();

      for (const entry of ALLOWLIST) {
        expect(fs.existsSync(path.join(AGENT_ROOT, entry.file)), `allowlist entry names a file that no longer exists: ${entry.file}`).to.be.true;
        expect(RULES.map((rule) => rule.id), `allowlist entry names an unknown rule: ${entry.rule}`).to.include(entry.rule);
        expect(entry.reason.length, `allowlist entry ${entry.file} [${entry.rule}] must carry a written reason`).to.be.greaterThan(40);

        const matched = violations.filter((violation) => violation.file === entry.file && violation.rule === entry.rule);
        expect(matched.length,
          `allowlist entry ${entry.file} [${entry.rule}] expects ${entry.occurrences} occurrence(s) but found ${matched.length}. ` +
          'Either the allowlisted line moved out (delete the entry) or a new, unreviewed use appeared (review it, then update the count).',
        ).to.equal(entry.occurrences);
      }
    });
  });

  describe('P5 — no agent source outside agent/src/bench touches unseeded randomness or the clock', () => {
    it('finds no unallowlisted violation anywhere under agent/src', () => {
      const violations = rawViolations().filter((violation) => !isAllowlisted(violation));

      expect(violations.length,
        'P5 (blocking, Milestone1_Bullet6_Prompts.md): agent code outside agent/src/bench must draw randomness only from ' +
        'createAgentRandom() and must never read the wall clock. Each line below breaks the reproducibility contract in ' +
        'SRS CON-5/NFR-5 - fix it, or add an explicit ALLOWLIST entry in this file with a written reason:\n' +
        violations.map(describeViolation).join('\n'),
      ).to.equal(0);
    });
  });

  describe('the positive half of the contract — where randomness is *allowed* to come from', () => {
    /*
     * The rules above say what may not happen. Stated alone they would leave the next person to
     * add a search module (M4 determinization, M6 self-play) guessing at what may. The contract
     * is:
     *
     *   Agent decisions  <- AgentRandom, and only ever from createAgentRandom(agentSeed)
     *                       (agent/src/core/rng.ts) or agentRandomFrom(<a deterministic Random>).
     *   Engine state     <- the single `seed` argument createGame() hands Game.newInstance()
     *                       (agent/src/engine/gameFactory.ts), and nothing else.
     *
     * Two separate integers, neither derived from the other, each owning one side of "was that
     * the same game?" vs. "did the Agent make the same decisions?". M4 adds a third consumer
     * (determinization) as a third *named stream*, not as a borrowed draw from either of these -
     * see the seed contract in Determinism_Verification.md.
     */
    it('imports the Engine Random module in exactly two places, and never imports UnseededRandom', () => {
      const importers = filesImportingEngineRandom();

      expect(importers.map((importer) => importer.file)).to.deep.equal([
        // The Agent's own PRNG. Wraps SeededRandom so strategy code never holds an Engine class
        // (NFR-7) and so the seed-degeneracy workaround lives in exactly one place.
        'src/core/rng.ts',
        // ConstRandom(0) - the FR-9 conservative fallback's rng (embeddedDriver.ts:31). Constant
        // by construction: it returns the low end of every range, so it is a *deterministic*
        // Random, not a source of randomness at all.
        'src/driver/embeddedDriver.ts',
      ]);

      const symbols = new Set(importers.flatMap((importer) => importer.symbols));
      expect([...symbols].sort(), 'only deterministic Random implementations may be imported').to.deep.equal(['ConstRandom', 'Random', 'SeededRandom']);
      expect(symbols.has('UnseededRandom'), 'UnseededRandom is Math.random() with a class around it (src/common/utils/Random.ts:41)').to.be.false;
    });

    it('constructs Engine games in exactly one place, passing exactly one seed', () => {
      // The Engine's entire randomness surface for an in-scope game is the `seed` argument to
      // Game.newInstance (everything RNG-driven - board, all four deck shuffles, dealt cards -
      // is drawn from the SeededRandom built from it). Keeping the call in one file is what
      // makes "the Engine seed" a single, auditable thing rather than a convention.
      const callers = listTypeScriptFiles(SRC_ROOT)
        .map(agentRelative)
        .filter((file) => /\bGame\s*\.\s*newInstance\b/.test(fs.readFileSync(path.join(AGENT_ROOT, file), 'utf8')))
        .sort();

      expect(callers).to.deep.equal(['src/engine/gameFactory.ts']);

      const factory = fs.readFileSync(path.join(AGENT_ROOT, 'src/engine/gameFactory.ts'), 'utf8');
      expect(factory, 'the Engine seed must come from the caller-supplied config seed, not from anything ambient')
        .to.match(/resolved\.seed\s*\/\s*SEED_SCALE/);
    });

    it('routes every agent-side draw through createAgentRandom or an explicitly deterministic Random', () => {
      // `new SeededAgentRandom(...)` is private to rng.ts; every other file must go through one
      // of its two exported entry points. This is the assertion that fails when a future search
      // module quietly builds its own PRNG instead of taking an AgentRandom as a parameter.
      const constructors = listTypeScriptFiles(SRC_ROOT)
        .map(agentRelative)
        .filter((file) => /\bnew\s+SeededRandom\b/.test(fs.readFileSync(path.join(AGENT_ROOT, file), 'utf8')))
        .sort();

      expect(constructors, 'SeededRandom may only be constructed inside the Agent\'s own RNG module').to.deep.equal(['src/core/rng.ts']);

      const rng = fs.readFileSync(path.join(AGENT_ROOT, 'src/core/rng.ts'), 'utf8');
      expect(rng, 'createAgentRandom must remain the seeded entry point').to.match(/export function createAgentRandom\(seed: number\)/);
      expect(rng, 'agentRandomFrom must remain the (test/fallback) wrapper for an already-deterministic Random').to.match(/export function agentRandomFrom\(source: Random\)/);
    });
  });
});
