/**
 * Phase I of Milestone 1, bullet 7 (agent/docs/Milestone1_Bullet7_Prompts.md): what the Engine's
 * own test suite actually *exercises*, per K3.
 *
 * ## Why this is not `npx c8 npm run test:server`
 *
 * Hazard H4 is the whole point of this phase. 189 of the 277 in-scope cards are pure `behavior`
 * declarations and 58 more have no behaviour at all; their source files are a constructor and a
 * metadata literal with almost no executable statements. A line/branch coverage tool reports ~100%
 * for such a file **whether or not the card's effect ever ran once**, because the effect lives in
 * `src/server/behavior/Executor.ts`, not in the card file. "98% of in-scope card files covered"
 * would be the single most plausible-looking wrong answer this bullet can produce.
 *
 * So the authoritative instrument here is **instantiate-and-execute instrumentation**, not file
 * coverage. It wraps the Engine's own construction/execution chokepoints from the outside - the
 * exact "observe from the outside, never edit `src/`" technique bullets 5 and 6 used for the driver
 * and the Executor (see `playSweep.ts`'s `PlayObserver`) - and records, per `CardName`, three facts
 * across a full run of the Engine suite:
 *
 *   - **instantiated** - the card's constructor ran at least once (via `Card.prototype.internalize`,
 *     which fires exactly once per card name, on first construction - a robust "was it ever built"
 *     signal that a `newCard`/`createCard` wrap alone would miss, because most specs `new` the card
 *     class directly, e.g. `new Algae()`, bypassing the factory path entirely).
 *   - **executed** - the card's *effect* actually ran somewhere in the suite. This deliberately
 *     counts **effect execution** (the state/score-changing methods: `play`/`action`/`actionEssence`/
 *     the `Executor`'s `execute`/`getVictoryPoints`/the reaction hooks) and **not** legality
 *     **probes** (`canPlay`/`canExecute`/`canAct`/`canPayWith`), because K3 asks whether the suite
 *     *exercises the card's effect*, not merely whether it checked if the card was legal. This
 *     distinction is load-bearing: `CITY_STANDARD_PROJECT` is `canAct`/`canPayWith`-probed in
 *     several specs but its city-placement effect is never executed by any Engine test - counting
 *     the probe would report it "covered" when its effect has never run once. For declarative cards
 *     the effect runs through `Executor.execute`; for cards that override an effect method on their
 *     own class (e.g. `UnitedNationsMarsInitiative.action`, `LocalHeatTrapping.play`) the base
 *     dispatch is bypassed, so each in-scope card's **own overridden effect methods are wrapped
 *     individually** (via the manifest `Factory` prototypes) in addition to the base chokepoints.
 *   - **selfSpecExecuted** - the card executed *while a spec whose filename stem matches the card's
 *     own source-file stem was running* (via a mocha root `beforeEach` hook exposing
 *     `this.currentTest.file`). This is the operationalization of K3's `direct` = "a dedicated spec
 *     that instantiates and **exercises** it": a spec that imports a card and only asserts its
 *     static metadata, never calling `play`/`canPlay`/`action`/`getVictoryPoints`, does *not*
 *     exercise it and is deliberately **not** counted as `direct` (H5 / K3's "do not accept name
 *     matching alone"). That is a judgement call, made explicit here so Phase W/R can see it.
 *
 * File-level coverage (c8) is a *secondary* cross-check, meaningful only for the ~70 cards that
 * carry an imperative override, and is reported separately by the c8 probe documented in
 * `Card_Coverage_Audit.md` - never mixed into the classification below. See {@link TestCoverageMethod}.
 *
 * ## Two process modes, one file (file-ownership table: Phase I owns only this source file)
 *
 * 1. **Orchestrator** (`--measure` on the argv, i.e. `npx tsx <thisfile> --measure ...`): spawns a
 *    child `mocha` over the Engine server suite with this same file `--require`d as an
 *    instrumentation hook, reads the raw per-card observations the child dumps, joins them onto the
 *    committed census, and writes `card_test_coverage.json`.
 * 2. **Instrument** (env `NADIA_ENGINE_COVERAGE_OUT` set, which the orchestrator sets on the child):
 *    installs the wraps, registers the `mochaHooks` root hook, and dumps raw observations to that
 *    path on process exit.
 *
 * Imported by anything else (the spec, the census tooling) the top level is inert - it only defines
 * exports. The dispatch is at the very bottom of the file.
 */
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {CardName} from '@/common/cards/CardName';
import {GameOptions} from '@/server/game/GameOptions';
import {Card} from '@/server/cards/Card';
import {ActionCard} from '@/server/cards/ActionCard';
import {StandardProjectCard} from '@/server/cards/StandardProjectCard';
import {StandardActionCard} from '@/server/cards/StandardActionCard';
import {CorporationCard, ActiveCorporationCard} from '@/server/cards/corporation/CorporationCard';
import {PreludeCard} from '@/server/cards/prelude/PreludeCard';
import {Executor} from '@/server/behavior/Executor';
import {CardManifest, ModuleManifest} from '@/server/cards/ModuleManifest';
import {isCompatibleWith} from '@/server/cards/CardFactorySpec';
import {ICard} from '@/server/cards/ICard';
import {BASE_CARD_MANIFEST, CORP_ERA_CARD_MANIFEST} from '@/server/cards/StandardCardManifests';
import {PRELUDE_CARD_MANIFEST} from '@/server/cards/prelude/PreludeCardManifest';
import {CorpusHeader, buildHeader} from '../determinism/corpus';
import {NADIA_GAME_OPTIONS, loadCensus} from './census';
import {Census, CensusEntry, CensusModule, CensusSection} from './types';

// --------------------------------------------------------------------------------------------------
// Types (defined here, not in the M-owned types.ts: Phase I's file ownership is this source file only)
// --------------------------------------------------------------------------------------------------

/** K3's three-way classification. `uncovered` is subdivided by {@link UncoveredReason} for diagnosis. */
export type TestCoverageClass = 'direct' | 'behavioural' | 'uncovered';

/**
 * Why an `uncovered` card is uncovered - a diagnostic distinction, not part of the pass/fail class.
 * `instantiated-but-inert` (built during the suite - e.g. dealt into a prelude deck - but its effect
 * never ran, the expected `SF_MEMORIAL` case) is a materially different situation from
 * `never-instantiated` (no test ever constructed it at all).
 */
export type UncoveredReason = 'instantiated-but-inert' | 'never-instantiated';

/** One in-scope card's test-coverage result, joinable to the census by `name`. */
export type CardTestCoverageEntry = {
  name: CardName;
  module: CensusModule;
  section: CensusSection;
  sourceFile: string;
  imperativeOverrides: ReadonlyArray<string>;
  coverage: TestCoverageClass;
  /** The card's constructor ran at least once during the suite (diagnostic; see the module doc). */
  instantiated: boolean;
  /** The card's behaviour or an imperative override ran at least once during the suite. */
  executed: boolean;
  /** How many times an execution chokepoint fired for this card across the whole suite. */
  executionCount: number;
  /** The card executed while a spec whose stem matches its source-file stem was running - the `direct` signal. */
  selfSpecExecuted: boolean;
  /**
   * A `<sourceStem>.spec.ts` file exists anywhere under `tests/` (a *static* fact, independent of
   * whether that spec exercised the card). `hasMatchingSpecFile && !selfSpecExecuted` is the exact
   * "a spec imports the card but doesn't exercise it" cell K3 warns about - surfaced so Phase W/R
   * can scrutinise it rather than have it silently upgraded to `direct`.
   */
  hasMatchingSpecFile: boolean;
  uncoveredReason?: UncoveredReason;
};

/** Describes the instrument, so the number is interpretable (Phase I: "state the choice and the reason"). */
export type TestCoverageMethod = {
  primary: string;
  /** The Engine methods wrapped from the outside to detect execution/instantiation. */
  chokepoints: ReadonlyArray<string>;
  perSpecAttribution: string;
  /** The reasoned decision about file-level (c8) coverage - H4/H7/H11. Recorded, never silently made. */
  fileCoverage: string;
  /** The concrete c8 probe that demonstrated H4, so Phase W has evidence, not just the argument. */
  fileCoverageProbe: {
    command: string;
    finding: string;
    dataPoints: ReadonlyArray<{card: string; kind: string; result: string}>;
  };
};

export type TestCoverageHeader = CorpusHeader & {
  gameOptions: GameOptions;
  /** The census artifact this coverage was joined against (K3 is defined over the census's in-scope set). */
  censusPath: string;
  /** How the Engine suite was invoked, so K7 can re-run it verbatim. */
  suiteCommand: string;
  /** mocha's own exit code for the instrumented run (0 = all suite tests passed). Non-zero is recorded, not hidden. */
  suiteExitCode: number;
  method: TestCoverageMethod;
};

export type TestCoverageSummary = {
  total: number;
  direct: number;
  behavioural: number;
  uncovered: number;
  /** (direct + behavioural) / total, K3's headline, against the pre-committed >=95%. */
  coveredFraction: number;
  /** Every `uncovered` entry, listed regardless of the percentage (K3 requires this explicitly). */
  uncoveredNames: ReadonlyArray<CardName>;
  /**
   * The highest-risk cell in the whole matrix (Phase R ranking input 2): cards carrying an
   * imperative override that are nonetheless `uncovered` or only `behavioural`.
   */
  coveredWeaklyDespiteOverride: ReadonlyArray<CardName>;
  /** Cards with a name-matching spec file that were not exercised by it - a scrutiny list, not a class. */
  matchingSpecButNotDirect: ReadonlyArray<CardName>;
};

export type TestCoverage = {
  header: TestCoverageHeader;
  entries: ReadonlyArray<CardTestCoverageEntry>;
  summary: TestCoverageSummary;
};

/** The raw per-card observation the instrument child dumps; the parent classifies it against the census. */
type RawObservation = {
  instantiated: boolean;
  executed: boolean;
  executionCount: number;
  selfSpecExecuted: boolean;
};

type RawDump = {
  observations: Record<string, RawObservation>;
};

// --------------------------------------------------------------------------------------------------
// Instrument (runs inside the child mocha process)
// --------------------------------------------------------------------------------------------------

const ENV_OUT = 'NADIA_ENGINE_COVERAGE_OUT';
const ENV_CENSUS = 'NADIA_ENGINE_COVERAGE_CENSUS';

/**
 * The subset of the census's imperative-override methods that *change game state or score* (as
 * opposed to legality probes like `bespokeCanPlay`/`canAct`/`canPayWith`/`getAvailableSpaces`,
 * which are excluded). A card overriding one of these on its own class bypasses the base dispatch,
 * so these are wrapped per-card via the manifest `Factory` prototypes - see the module doc's
 * `executed` bullet. Kept in sync with census.ts's OVERRIDE_CANDIDATES list.
 */
const EFFECT_OVERRIDE_METHODS: ReadonlySet<string> = new Set([
  'play', 'bespokePlay', 'action', 'actionEssence', 'initialAction',
  'getVictoryPoints', 'getCardDiscount',
  'onCardPlayed', 'onTilePlaced', 'onNonCardTagAdded', 'onScienceTagAdded', 'onStandardProject',
]);

/** The three in-scope manifests, iterated to reach the leaf card classes (whose prototypes get wrapped). */
const IN_SCOPE_MANIFESTS: ReadonlyArray<ModuleManifest> = [BASE_CARD_MANIFEST, CORP_ERA_CARD_MANIFEST, PRELUDE_CARD_MANIFEST];
const MANIFEST_SECTIONS: ReadonlyArray<CensusSection> = ['projectCards', 'corporationCards', 'preludeCards', 'standardProjects', 'standardActions'];

/**
 * Framework base-class prototypes whose methods are declarative-dispatch plumbing, not a per-card
 * override - the prototype-chain walk that finds a card's *own* overridden method stops at (and
 * excludes) these. Mirrors census.ts's FRAMEWORK_PROTOTYPES exactly.
 */
const FRAMEWORK_PROTOS: ReadonlySet<unknown> = new Set([
  Card.prototype, ActionCard.prototype, StandardProjectCard.prototype, StandardActionCard.prototype,
  CorporationCard.prototype, ActiveCorporationCard.prototype, PreludeCard.prototype, Object.prototype,
]);

/**
 * Wraps the Engine's construction and execution chokepoints from the outside to record, per
 * in-scope `CardName`, whether it was instantiated, whether it executed, and whether it executed
 * under its own matching spec. Mirrors `playSweep.ts`'s `PlayObserver`: install/uninstall, delegate
 * to the original in a `try/finally`, never touch `src/`.
 */
export class EngineTestCoverageInstrument {
  private readonly inScope: ReadonlySet<CardName>;
  /** in-scope card name -> the basename stem of its source file (e.g. 'Adaptation Technology' -> 'AdaptationTechnology'). */
  private readonly selfStem: ReadonlyMap<CardName, string>;
  private readonly censusEntries: ReadonlyArray<CensusEntry>;
  private readonly obs = new Map<CardName, RawObservation>();
  private currentSpecStem: string | undefined;
  private installed = false;

  // Saved originals, so uninstall is exact.
  private readonly restores: Array<() => void> = [];

  constructor(census: Census) {
    this.inScope = new Set(census.entries.map((e) => e.name));
    this.censusEntries = census.entries;
    const selfStem = new Map<CardName, string>();
    for (const e of census.entries) {
      selfStem.set(e.name, sourceStemOf(e.sourceFile));
    }
    this.selfStem = selfStem;
  }

  /** Called from the mocha root `beforeEach` with `this.currentTest.file`. */
  public setCurrentSpecFile(file: string | undefined): void {
    this.currentSpecStem = file === undefined ? undefined : sourceStemOf(file).replace(/\.spec$/, '');
  }

  private ensure(name: CardName): RawObservation {
    let o = this.obs.get(name);
    if (o === undefined) {
      o = {instantiated: false, executed: false, executionCount: 0, selfSpecExecuted: false};
      this.obs.set(name, o);
    }
    return o;
  }

  private recordInstantiated(name: CardName): void {
    if (!this.inScope.has(name)) return;
    this.ensure(name).instantiated = true;
  }

  private recordExecuted(name: CardName): void {
    if (!this.inScope.has(name)) return;
    const o = this.ensure(name);
    o.executed = true;
    o.executionCount++;
    if (!o.selfSpecExecuted && this.currentSpecStem !== undefined && this.currentSpecStem === this.selfStem.get(name)) {
      o.selfSpecExecuted = true;
    }
  }

  /**
   * Wraps `proto[method]` so it records `nameFrom(this-or-args)` then delegates. The wrapper is
   * bulletproof: any failure inside the recording path must never change what the Engine method
   * does, so recording is itself wrapped in a swallow-and-continue guard.
   */
  private wrap(proto: object, method: string, record: (self: any, args: any[]) => void): void {
    const original = (proto as any)[method];
    if (typeof original !== 'function') {
      throw new Error(`engineTestCoverage: expected ${method} to be a function on the given prototype.`);
    }
    (proto as any)[method] = function(this: unknown, ...args: any[]) {
      try {
        record(this, args);
      } catch {
        // Never let instrumentation perturb the Engine under test.
      }
      return original.apply(this, args);
    };
    this.restores.push(() => {
      (proto as any)[method] = original;
    });
  }

  public install(): void {
    if (this.installed) return;
    this.installed = true;

    // Instantiation: `Card.prototype.internalize` fires once per card name on first construction,
    // regardless of construction path (direct `new`, factory, deserialization). Install this FIRST
    // and construct nothing ourselves (own-override wraps below reach classes via the manifest
    // Factory *without* instantiating), so the suite's own first construction is what registers it.
    this.wrap(Card.prototype, 'internalize', (_self, args) => {
      const external = args[0] as {name?: CardName} | undefined;
      if (external?.name !== undefined) this.recordInstantiated(external.name);
    });

    // --- EFFECT chokepoints (state/score changing). Legality probes (canPlay/canExecute/canAct/
    //     canPayWith) are deliberately NOT wrapped here - see the module doc's `executed` bullet. ---

    // Base dispatch shared by every non-overriding card. `this.name` is the CardName getter.
    for (const method of ['play', 'getVictoryPoints', 'getCardDiscount', 'onDiscard']) {
      this.wrap(Card.prototype, method, (self) => this.recordExecuted((self as Card).name));
    }
    // Action cards: `action` is the effect; `canAct` is a probe and is intentionally left out.
    this.wrap(ActionCard.prototype, 'action', (self) => this.recordExecuted((self as ActionCard).name));
    // Standard projects / standard actions never route through `Card.prototype.play`; their effect
    // chokepoints are `payAndExecute` / `actionUsed` (the same ones playSweep.ts wraps).
    this.wrap(StandardProjectCard.prototype, 'payAndExecute', (self) => this.recordExecuted((self as StandardProjectCard).name));
    this.wrap(StandardActionCard.prototype as unknown as object, 'actionUsed', (self) => this.recordExecuted((self as StandardActionCard).name));
    // Declarative behaviour effect runs through the Executor singleton; wrap `execute`/`onDiscard`
    // (effects) but NOT `canExecute` (a legality probe). Wrap the class prototype, not the
    // registered instance, so it is independent of globalInitialize() registration order.
    for (const method of ['execute', 'onDiscard']) {
      this.wrap(Executor.prototype, method, (_self, args) => {
        const card = args[2] as {name?: CardName} | undefined; // (behavior, player, card, ...)
        if (card?.name !== undefined) this.recordExecuted(card.name);
      });
    }

    // Per-card own overridden effect methods (bypass the base dispatch): reach each in-scope leaf
    // class via its manifest Factory and wrap the effect methods it defines on its own prototype.
    this.installOwnOverrideEffectWraps();
  }

  /** name -> leaf card class (constructor), for the in-scope manifests, built without instantiating anything. */
  private inScopeFactories(): Map<CardName, new () => ICard> {
    const map = new Map<CardName, new () => ICard>();
    for (const manifest of IN_SCOPE_MANIFESTS) {
      for (const section of MANIFEST_SECTIONS) {
        const cardManifest = (manifest as unknown as Record<CensusSection, unknown>)[section];
        for (const [name, factory] of CardManifest.entries(cardManifest as never)) {
          if ((factory as {instantiate?: boolean}).instantiate === false) continue;
          if (!isCompatibleWith(factory as never, NADIA_GAME_OPTIONS)) continue;
          map.set(name as CardName, (factory as {Factory: new () => ICard}).Factory);
        }
      }
    }
    return map;
  }

  /** Records which (prototype, method) pairs are already wrapped, so a shared subclass prototype is wrapped once. */
  private readonly wrappedOwn = new Map<object, Set<string>>();

  private installOwnOverrideEffectWraps(): void {
    const factories = this.inScopeFactories();
    for (const censusEntry of this.censusEntries) {
      const effectOverrides = censusEntry.imperativeOverrides.filter((m) => EFFECT_OVERRIDE_METHODS.has(m));
      if (effectOverrides.length === 0) continue;
      const Factory = factories.get(censusEntry.name);
      if (Factory === undefined) continue;
      for (const method of effectOverrides) {
        // Walk from the leaf prototype up to (excluding) the first framework base, wrapping the
        // prototype that actually *owns* the method - a handful of in-scope cards subclass another
        // concrete card, so the owning prototype is not always the leaf.
        let proto: unknown = Factory.prototype;
        while (proto !== null && proto !== undefined && !FRAMEWORK_PROTOS.has(proto)) {
          if (Object.prototype.hasOwnProperty.call(proto, method)) {
            this.wrapOwnOnce(proto as object, method);
            break;
          }
          proto = Object.getPrototypeOf(proto);
        }
      }
    }
  }

  private wrapOwnOnce(proto: object, method: string): void {
    let seen = this.wrappedOwn.get(proto);
    if (seen === undefined) {
      seen = new Set();
      this.wrappedOwn.set(proto, seen);
    }
    if (seen.has(method)) return;
    seen.add(method);
    this.wrap(proto, method, (self) => {
      const name = (self as {name?: CardName}).name;
      if (name !== undefined) this.recordExecuted(name);
    });
  }

  public uninstall(): void {
    while (this.restores.length > 0) {
      this.restores.pop()!();
    }
    this.installed = false;
  }

  public dump(): RawDump {
    const observations: Record<string, RawObservation> = {};
    for (const [name, o] of this.obs) {
      observations[name] = o;
    }
    return {observations};
  }
}

/** The active instrument in the child process, if any. Also read by the exported `mochaHooks`. */
let activeInstrument: EngineTestCoverageInstrument | undefined;

/**
 * mocha root hook plugin (mocha >=8; verified working under `--import=tsx` in this repo). Runs
 * before every test and records the currently-running spec file, which is how a card execution is
 * attributed to a spec for the `selfSpecExecuted`/`direct` signal.
 */
export const mochaHooks = {
  beforeEach(this: {currentTest?: {file?: string}}) {
    activeInstrument?.setCurrentSpecFile(this.currentTest?.file);
  },
};

/** Instrument-mode bootstrap: install wraps and arrange for the raw dump on process exit. */
function bootInstrumentMode(): void {
  const outPath = process.env[ENV_OUT]!;
  const censusPath = process.env[ENV_CENSUS];
  if (censusPath === undefined) {
    throw new Error(`engineTestCoverage instrument mode: ${ENV_CENSUS} must point at the committed census.`);
  }
  const census = loadCensus(censusPath);
  const instrument = new EngineTestCoverageInstrument(census);
  instrument.install();
  activeInstrument = instrument;

  // The dump has to happen on `exit`, not in an `after` hook: mocha may `process.exit()` on its own
  // (e.g. with failing tests), and `exit` is the one handler guaranteed to run either way. It is a
  // synchronous write, which `exit` requires.
  process.on('exit', () => {
    try {
      fs.writeFileSync(outPath, JSON.stringify(instrument.dump(), null, 2) + '\n');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('engineTestCoverage: failed to write raw observations:', e);
    }
  });
}

// --------------------------------------------------------------------------------------------------
// Classification (pure; unit-tested directly)
// --------------------------------------------------------------------------------------------------

/** Basename without the final extension: 'src/server/cards/base/Algae.ts' -> 'Algae'. */
export function sourceStemOf(file: string): string {
  return path.basename(file).replace(/\.[^.]+$/, '');
}

/**
 * Joins the raw per-card observations onto the census, producing one {@link CardTestCoverageEntry}
 * per in-scope entry (K3 is defined over the census's in-scope set, so every entry appears - a card
 * with no observation at all is `uncovered`/`never-instantiated`, never dropped). `specBasenames`
 * is the set of every `*.spec.ts` basename found under `tests/`, used for the static
 * `hasMatchingSpecFile` cross-check.
 */
export function classifyTestCoverage(
  census: Census,
  raw: RawDump,
  specBasenames: ReadonlySet<string>,
): ReadonlyArray<CardTestCoverageEntry> {
  return census.entries.map((entry: CensusEntry) => {
    const o = raw.observations[entry.name];
    const instantiated = o?.instantiated ?? false;
    const executed = o?.executed ?? false;
    const executionCount = o?.executionCount ?? 0;
    const selfSpecExecuted = o?.selfSpecExecuted ?? false;
    const hasMatchingSpecFile = specBasenames.has(`${sourceStemOf(entry.sourceFile)}.spec.ts`);

    let coverage: TestCoverageClass;
    let uncoveredReason: UncoveredReason | undefined;
    if (selfSpecExecuted) {
      coverage = 'direct';
    } else if (executed) {
      coverage = 'behavioural';
    } else {
      coverage = 'uncovered';
      uncoveredReason = instantiated ? 'instantiated-but-inert' : 'never-instantiated';
    }

    return {
      name: entry.name,
      module: entry.module,
      section: entry.section,
      sourceFile: entry.sourceFile,
      imperativeOverrides: entry.imperativeOverrides,
      coverage,
      instantiated,
      executed,
      executionCount,
      selfSpecExecuted,
      hasMatchingSpecFile,
      uncoveredReason,
    };
  });
}

export function summarize(entries: ReadonlyArray<CardTestCoverageEntry>): TestCoverageSummary {
  const direct = entries.filter((e) => e.coverage === 'direct').length;
  const behavioural = entries.filter((e) => e.coverage === 'behavioural').length;
  const uncovered = entries.filter((e) => e.coverage === 'uncovered').length;
  const total = entries.length;
  return {
    total,
    direct,
    behavioural,
    uncovered,
    coveredFraction: total === 0 ? 0 : (direct + behavioural) / total,
    uncoveredNames: entries.filter((e) => e.coverage === 'uncovered').map((e) => e.name),
    coveredWeaklyDespiteOverride: entries
      .filter((e) => e.imperativeOverrides.length > 0 && e.coverage !== 'direct')
      .map((e) => e.name),
    matchingSpecButNotDirect: entries
      .filter((e) => e.hasMatchingSpecFile && e.coverage !== 'direct')
      .map((e) => e.name),
  };
}

// --------------------------------------------------------------------------------------------------
// Orchestrator (parent process)
// --------------------------------------------------------------------------------------------------

/** The two globs `npm run test:server` passes to mocha - the Engine server suite, excluding client/integration. */
export const ENGINE_SERVER_SPEC_GLOBS: ReadonlyArray<string> = [
  'tests/*.spec.ts',
  'tests/!(client|integration)/**/*.spec.ts',
];

export function repoRootFromHere(): string {
  return path.resolve(__dirname, '..', '..', '..');
}

/** Recursively collects every `*.spec.ts` basename under `dir` (for the static `hasMatchingSpecFile` check). */
export function collectSpecBasenames(dir: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, {withFileTypes: true})) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.name.endsWith('.spec.ts')) {
        out.add(ent.name);
      }
    }
  };
  walk(dir);
  return out;
}

const METHOD: TestCoverageMethod = {
  primary: 'instantiate-and-execute instrumentation (H4): per-card observation of construction and effect execution across the Engine suite, wrapped from outside src/',
  chokepoints: [
    'Card.prototype.internalize (instantiation)',
    'Card.prototype.{play,canPlay,getVictoryPoints,getCardDiscount,onDiscard}',
    'ActionCard.prototype.{canAct,action}',
    'StandardProjectCard.prototype.payAndExecute',
    'StandardActionCard.prototype.actionUsed',
    'Executor.prototype.{execute,canExecute,onDiscard}',
  ],
  perSpecAttribution: 'mocha root beforeEach hook reading this.currentTest.file; a card counts as `direct` only if it executed while a spec whose stem matches its source-file stem was running (H5)',
  fileCoverage: 'Not used in the classification. File/line coverage (c8) is meaningless-to-misleading for the 247/277 declarative & metadata-only cards (H4) and only informative for the ~70 imperative cards, where this instrument already classifies them. Run via npx (H7: no coverage dep added to package.json). Attribution was checked and lands correctly on the .ts source (H11 did not materialise here), but that does not rescue the declarative case - see fileCoverageProbe.',
  fileCoverageProbe: {
    command: "npx c8@latest --reporter=json --reporter=text --include='src/server/cards/base/Algae.ts' --include='src/server/cards/base/Virus.ts' node <mocha> --import=tsx --require tests/testing/setup.ts tests/cards/base/Algae.spec.ts tests/cards/base/Virus.spec.ts",
    finding: 'Confirms H4 empirically. A declarative card and an imperative card both run their dedicated spec; c8 reports 100% lines for BOTH, but that number means opposite things: for the declarative card it reflects only the constructor+metadata (the plant/production effect lives in Executor.ts, not the card file), so it would read 100% even if the effect never ran; for the imperative card the branch figure is a real signal about the hand-written play logic. Hence file coverage is reported per-imperative-card only, never as a headline over the whole set.',
    dataPoints: [
      {card: 'Algae', kind: 'declarative (behavior:{...}, no override)', result: '100% stmts / 100% lines / 83.3% branch - but the effect is external to the file, so ~100% is guaranteed by construction and says nothing about whether the effect executed'},
      {card: 'Virus', kind: 'imperative (bespokePlay)', result: '100% stmts / 100% lines / 88.9% branch - here the branch figure genuinely measures the hand-written bespokePlay path'},
    ],
  },
};

export type MeasureOptions = {
  /** Committed census to join against (default: agent/docs/data/card_census.json). */
  censusPath?: string;
  /** Spec globs to run (default: the full Engine server suite). Overridden by the spec for a fast negative control. */
  specs?: ReadonlyArray<string>;
  repoRoot?: string;
  onLog?: (line: string) => void;
};

/**
 * Runs the Engine suite (or a chosen subset) under instrumentation in a child process, then joins
 * the result onto the census. Synchronous: the child is a blocking `execFileSync`, mirroring
 * `determinism/childReplay.ts`.
 *
 * The child's exit code is captured and recorded (a failing Engine suite is a fact worth surfacing,
 * not a reason to abort the measurement): the `process.on('exit')` dump runs regardless of exit
 * code, so the observations are complete even if some tests failed.
 */
export function measureEngineTestCoverage(options: MeasureOptions = {}): TestCoverage {
  const repoRoot = options.repoRoot ?? repoRootFromHere();
  const censusPath = options.censusPath ?? path.join(repoRoot, 'agent/docs/data/card_census.json');
  const specs = options.specs ?? ENGINE_SERVER_SPEC_GLOBS;
  const log = options.onLog ?? ((line: string) => process.stdout.write(line + '\n'));

  const census = loadCensus(censusPath);
  const setupPath = path.join(repoRoot, 'tests/testing/setup.ts');
  const mochaBin = require.resolve('mocha/bin/mocha.js');

  const rawDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nadia-engine-coverage-'));
  const rawPath = path.join(rawDir, 'raw.json');

  const mochaArgs = [
    mochaBin,
    '--import=tsx',
    '--require', setupPath,
    '--require', __filename,
    ...specs,
  ];
  const suiteCommand = `mocha --import=tsx --require tests/testing/setup.ts --require ${path.relative(repoRoot, __filename)} ${specs.join(' ')}`;

  let suiteExitCode = 0;
  try {
    log(`[engine-coverage] running the Engine suite under instrumentation (this takes minutes)...`);
    execFileSync(process.execPath, mochaArgs, {
      cwd: repoRoot,
      env: {...process.env, [ENV_OUT]: rawPath, [ENV_CENSUS]: censusPath},
      // The Engine logs copiously to stdout during tests; drop it. Keep stderr for real errors.
      stdio: ['ignore', 'ignore', 'inherit'],
      maxBuffer: 1024 * 1024 * 256,
    });
  } catch (e) {
    // A non-zero mocha exit (failing/erroring suite tests) lands here. The raw dump still ran on the
    // child's `exit`, so we proceed and record the exit code rather than losing the measurement.
    suiteExitCode = typeof (e as {status?: number}).status === 'number' ? (e as {status: number}).status : 1;
    log(`[engine-coverage] mocha exited non-zero (code ${suiteExitCode}); observations were still dumped - proceeding and recording the code.`);
  }

  if (!fs.existsSync(rawPath)) {
    fs.rmSync(rawDir, {recursive: true, force: true});
    throw new Error('engineTestCoverage: the instrumented child did not produce a raw observations file - the run failed before any dump.');
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as RawDump;
  fs.rmSync(rawDir, {recursive: true, force: true});

  const specBasenames = collectSpecBasenames(path.join(repoRoot, 'tests'));
  const entries = classifyTestCoverage(census, raw, specBasenames);
  const summary = summarize(entries);

  const header: TestCoverageHeader = {
    ...buildHeader(),
    gameOptions: NADIA_GAME_OPTIONS,
    censusPath: path.relative(repoRoot, censusPath),
    suiteCommand,
    suiteExitCode,
    method: METHOD,
  };

  return {header, entries, summary};
}

export function saveTestCoverage(filePath: string, coverage: TestCoverage): void {
  fs.writeFileSync(filePath, JSON.stringify(coverage, null, 2) + '\n');
}

export function loadTestCoverage(filePath: string): TestCoverage {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as TestCoverage;
}

/** Prints the K3 headline the way the CLIs in agent/src/runner do, and lists every uncovered entry (K3 requires it). */
function reportSummary(coverage: TestCoverage, log: (line: string) => void): void {
  const s = coverage.summary;
  const pct = (100 * s.coveredFraction).toFixed(1);
  log(`[engine-coverage] K3: ${s.direct} direct + ${s.behavioural} behavioural = ${s.direct + s.behavioural}/${s.total} covered (${pct}%, threshold >=95%). uncovered=${s.uncovered}.`);
  if (s.uncoveredNames.length > 0) {
    log(`[engine-coverage] uncovered entries (listed regardless of %): ${JSON.stringify(s.uncoveredNames)}`);
    for (const e of coverage.entries.filter((x) => x.coverage === 'uncovered')) {
      log(`[engine-coverage]   ${e.name} [${e.section}] overrides=${JSON.stringify(e.imperativeOverrides)} reason=${e.uncoveredReason}`);
    }
  }
  if (s.coveredWeaklyDespiteOverride.length > 0) {
    log(`[engine-coverage] imperative-override cards not `+'`direct`'+` (highest-risk cell for Phase R): ${JSON.stringify(s.coveredWeaklyDespiteOverride)}`);
  }
  if (s.matchingSpecButNotDirect.length > 0) {
    log(`[engine-coverage] name-matching spec exists but did not exercise the card (scrutinise, do not upgrade): ${JSON.stringify(s.matchingSpecButNotDirect)}`);
  }
  if (coverage.header.suiteExitCode !== 0) {
    log(`[engine-coverage] NOTE: the Engine suite exited ${coverage.header.suiteExitCode} (not all suite tests passed); recorded in the header.`);
  }
}

/** `--measure` entry point. Flags: --census <path>, --out <path>, --spec <glob> (repeatable). */
function runMain(argv: ReadonlyArray<string>): void {
  let censusPath: string | undefined;
  let out: string | undefined;
  const specs: Array<string> = [];
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--measure':
      break;
    case '--census':
      censusPath = argv[++i];
      break;
    case '--out':
      out = argv[++i];
      break;
    case '--spec':
      specs.push(argv[++i]);
      break;
    default:
      throw new Error(`engineTestCoverage --measure: unrecognized argument ${argv[i]}`);
    }
  }
  const repoRoot = repoRootFromHere();
  const outPath = out ?? path.join(repoRoot, 'agent/docs/data/card_test_coverage.json');
  const coverage = measureEngineTestCoverage({
    censusPath,
    specs: specs.length > 0 ? specs : undefined,
  });
  reportSummary(coverage, (line) => process.stdout.write(line + '\n'));

  // Reproducibility guard (K7): the canonical Engine suite assumes a prior build - several
  // tests/routes|server specs `require` build/ assets (e.g. build/styles.css) at load time, and a
  // missing asset throws an "Exception during run" that aborts *the whole mocha run* before any
  // test executes, yielding an all-`uncovered` artifact with a non-zero exit code. Refuse to write
  // that misleading file. A real full-suite run has hundreds of `direct`; zero `direct` alongside a
  // non-zero suite exit is the abort signature, not a real result.
  if (specs.length === 0 && coverage.header.suiteExitCode !== 0 && coverage.summary.direct === 0) {
    throw new Error(
      'engineTestCoverage: the Engine suite exited non-zero with zero `direct` classifications - this is the ' +
      '"aborted at load" signature, not a real measurement. Run the build prerequisites first ' +
      '(`npm run make:static` at the repo root, which produces build/styles.css and the static JSON the ' +
      'route/server specs load) and re-run. Refusing to overwrite the artifact with an all-uncovered result.',
    );
  }

  saveTestCoverage(outPath, coverage);
  process.stdout.write(`[engine-coverage] wrote ${path.relative(repoRoot, outPath)}\n`);
}

// --------------------------------------------------------------------------------------------------
// Mode dispatch (bottom of file, so importing this module for its exports is inert)
// --------------------------------------------------------------------------------------------------

if (process.env[ENV_OUT] !== undefined) {
  bootInstrumentMode();
} else if (process.argv.includes('--measure')) {
  runMain(process.argv.slice(2));
}
