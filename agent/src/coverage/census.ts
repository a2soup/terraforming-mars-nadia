import * as fs from 'fs';
import * as path from 'path';
import {BoardName} from '@/common/boards/BoardName';
import {CardName} from '@/common/cards/CardName';
import {DEFAULT_GAME_OPTIONS, GameOptions} from '@/server/game/GameOptions';
import {CardManifest, ModuleManifest} from '@/server/cards/ModuleManifest';
import {isCompatibleWith} from '@/server/cards/CardFactorySpec';
import {ICard} from '@/server/cards/ICard';
import {BASE_CARD_MANIFEST, CORP_ERA_CARD_MANIFEST} from '@/server/cards/StandardCardManifests';
import {PRELUDE_CARD_MANIFEST} from '@/server/cards/prelude/PreludeCardManifest';
import {Card} from '@/server/cards/Card';
import {ActionCard} from '@/server/cards/ActionCard';
import {StandardProjectCard} from '@/server/cards/StandardProjectCard';
import {StandardActionCard} from '@/server/cards/StandardActionCard';
import {CorporationCard, ActiveCorporationCard} from '@/server/cards/corporation/CorporationCard';
import {PreludeCard} from '@/server/cards/prelude/PreludeCard';
import {assertHeaderCompatible, buildHeader} from '../determinism/corpus';
import {classifyReachability} from './reachability';
import {Census, CensusDiff, CensusEntry, CensusHeader, CensusMismatch, CensusModule, CensusSection, CardNumberIssue, CorporationNameCheck, PresenceCheck} from './types';

/**
 * Nadia's exact game configuration (agent/src/engine/gameFactory.ts BASE_GAME_OPTIONS, not
 * exported from there) merged onto the Engine's own defaults, so every field GameCards/Game.ts
 * reads is a real GameOptions value rather than `undefined`. This is the fixed denominator every
 * check in this module (and reachability.ts, playSweep.ts) is computed against.
 */
export const NADIA_GAME_OPTIONS: GameOptions = {
  ...DEFAULT_GAME_OPTIONS,
  boardName: BoardName.THARSIS,
  corporateEra: true,
  preludeExtension: true,
};

/** The three in-scope manifests, with their section→module attribution (GameCards discards this - Phase M section 2). */
const IN_SCOPE_MANIFESTS: ReadonlyArray<{module: CensusModule; manifest: ModuleManifest; sourceFile: string}> = [
  {module: 'base', manifest: BASE_CARD_MANIFEST, sourceFile: 'src/server/cards/StandardCardManifests.ts'},
  {module: 'corpera', manifest: CORP_ERA_CARD_MANIFEST, sourceFile: 'src/server/cards/StandardCardManifests.ts'},
  {module: 'prelude', manifest: PRELUDE_CARD_MANIFEST, sourceFile: 'src/server/cards/prelude/PreludeCardManifest.ts'},
];

const SECTIONS: ReadonlyArray<CensusSection> = [
  'projectCards', 'corporationCards', 'preludeCards', 'standardProjects', 'standardActions',
];

/**
 * The candidate imperative-override method names (Milestone1_Bullet7_Prompts.md, "The
 * implementation surface, classified"). A card's own class defining one of these - not inherited
 * from a framework base class below - counts as carrying that override.
 */
const OVERRIDE_CANDIDATES: ReadonlyArray<string> = [
  'bespokePlay', 'bespokeCanPlay', 'canAct', 'action', 'onCardPlayed', 'onTilePlaced',
  'actionEssence', 'onNonCardTagAdded', 'canPayWith', 'getAvailableSpaces', 'canPlay',
  'onStandardProject', 'getCardDiscount', 'onScienceTagAdded', 'initialAction', 'play',
  'getVictoryPoints',
];

/**
 * Framework base classes whose own methods are declarative-dispatch plumbing (e.g.
 * `ActionCard.action` calls `getBehaviorExecutor().execute(...)` then `this.bespokeAction`), not a
 * per-card override. Walking the prototype chain stops at (and excludes) these, so only names
 * defined on a card's own leaf class count. See census.ts's imperativeOverridesOf doc.
 */
const FRAMEWORK_PROTOTYPES: ReadonlySet<unknown> = new Set([
  Card.prototype,
  ActionCard.prototype,
  StandardProjectCard.prototype,
  StandardActionCard.prototype,
  CorporationCard.prototype,
  ActiveCorporationCard.prototype,
  PreludeCard.prototype,
  Object.prototype,
]);

/**
 * Walks `card`'s prototype chain from its own (leaf) class up to, but not including, the first
 * framework base class it hits, collecting own-defined method names that match
 * {@link OVERRIDE_CANDIDATES}. This deliberately does NOT just check `Object.getOwnPropertyNames`
 * on the leaf prototype alone: a small number of in-scope cards subclass another concrete card
 * (e.g. base/MiningCard.ts's subclasses), so more than one non-framework prototype can carry
 * genuine overrides.
 */
function imperativeOverridesOf(card: ICard): ReadonlyArray<string> {
  const found = new Set<string>();
  let proto: unknown = Object.getPrototypeOf(card);
  while (proto !== null && proto !== undefined && !FRAMEWORK_PROTOTYPES.has(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (OVERRIDE_CANDIDATES.includes(name)) {
        found.add(name);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...found].sort();
}

/**
 * The printed base + Corporate Era + Prelude corporation names, hand-typed from the physical game
 * (rulebook / card list) - deliberately NOT derived from `src/server/cards/**`, per hazard H1: a
 * census that only compares the manifest against itself cannot detect a card that was never coded
 * at all. This is the one non-Engine-derived fact in the whole audit; if it is ever wrong, it is
 * wrong because whoever hand-typed it made a transcription error, not because the Engine changed -
 * review it against the physical card list as part of Phase W, don't regenerate it from source.
 */
const PRINTED_CORPORATION_NAMES: ReadonlyArray<string> = [
  'Beginner Corporation',
  'CrediCor',
  'Ecoline',
  'Helion',
  'Interplanetary Cinematics',
  'Inventrix',
  'Mining Guild',
  'PhoboLog',
  'Saturn Systems',
  'Teractor',
  'Tharsis Republic',
  'ThorGate',
  'United Nations Mars Initiative',
  'Cheung Shing MARS',
  'Point Luna',
  'Robinson Industries',
  'Valley Trust',
  'Vitor',
];

export type SourceMapEntry = {className: string; sourceFile: string};

/**
 * Parses a manifest file's own text to map `CardName` -> {className, sourceFile}, per hazard H1's
 * "don't guess the source file from the card name" instruction (several class names differ from
 * their card names, e.g. `PhoboLog`/`CrediCor`/`EcoLine`). Two passes over the same file text:
 * import statements give `className -> relative import path`; the manifest object literal gives
 * `CardName.<X>]: {Factory: <className>` per section. Both are simple, stable patterns in this
 * codebase (verified against StandardCardManifests.ts and PreludeCardManifest.ts) - no compiler
 * API needed for a codebase this regular.
 */
export function parseManifestSourceMap(manifestSourceFile: string): Map<CardName, SourceMapEntry> {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const absPath = path.join(repoRoot, manifestSourceFile);
  const text = fs.readFileSync(absPath, 'utf8');
  const manifestDir = path.dirname(absPath);

  const importMap = new Map<string, string>(); // className -> repo-relative source file
  const importRe = /import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text)) !== null) {
    const names = m[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const importPath = m[2];
    if (!importPath.startsWith('.')) {
      continue; // skip non-relative imports (CardName, ModuleManifest, common types, ...)
    }
    const resolved = path.relative(repoRoot, path.resolve(manifestDir, importPath)) + '.ts';
    for (const name of names) {
      // `import {X as Y}` - Factory references use the local (post-`as`) name.
      const local = name.includes(' as ') ? name.split(' as ')[1].trim() : name;
      importMap.set(local, resolved.split(path.sep).join('/'));
    }
  }

  const entryMap = new Map<CardName, SourceMapEntry>();
  const entryRe = /\[CardName\.(\w+)\]:\s*\{[^}]*Factory:\s*(\w+)/g;
  while ((m = entryRe.exec(text)) !== null) {
    const enumKey = m[1];
    // The manifest text spells the enum *key* (`ADAPTATION_TECHNOLOGY`); `CardName`'s runtime
    // values are the printed display strings (`'Adaptation Technology'`) - resolve through the
    // enum object itself rather than treating the regex capture as the value.
    const cardName = (CardName as unknown as Record<string, CardName>)[enumKey];
    if (cardName === undefined) {
      throw new Error(`census.ts: '${enumKey}' in ${manifestSourceFile} is not a CardName enum key.`);
    }
    const className = m[2];
    const sourceFile = importMap.get(className);
    if (sourceFile === undefined) {
      throw new Error(
        `census.ts: manifest entry CardName.${enumKey} references class '${className}' in ` +
        `${manifestSourceFile}, but no import statement for it was found - source-file resolution ` +
        'is broken for this entry (H1 requires resolving via the import, never by guessing from the name).',
      );
    }
    entryMap.set(cardName, {className, sourceFile});
  }
  return entryMap;
}

export function buildEntries(): Array<CensusEntry> {
  const entries: Array<CensusEntry> = [];

  for (const {module, manifest, sourceFile: manifestSourceFile} of IN_SCOPE_MANIFESTS) {
    const sourceMap = parseManifestSourceMap(manifestSourceFile);

    for (const section of SECTIONS) {
      const cardManifest = (manifest as unknown as Record<CensusSection, CardManifest<ICard>>)[section];
      for (const [cardName, factory] of CardManifest.entries(cardManifest)) {
        if (factory.instantiate === false) {
          continue; // reserved for fake/proxy cards - none in-scope per the pre-measurement, but respect it if one appears
        }
        if (!isCompatibleWith(factory, NADIA_GAME_OPTIONS)) {
          continue; // none in-scope carry `compatibility` today (pre-measured); still honor it if that changes
        }
        const card = new factory.Factory();
        const resolved = sourceMap.get(cardName);
        if (resolved === undefined) {
          throw new Error(`census.ts: no source-file resolution found for manifest entry CardName.${cardName} (${module}/${section}).`);
        }

        const {scope, scopeReason} = classifyReachability(cardName, section);

        entries.push({
          name: cardName,
          module,
          section,
          cardNumber: card.metadata.cardNumber ?? '',
          type: card.type,
          tags: card.tags,
          cost: card.cost,
          sourceFile: resolved.sourceFile,
          scope,
          scopeReason,
          imperativeOverrides: imperativeOverridesOf(card),
          declarative: card.behavior !== undefined,
        });
      }
    }
  }

  return entries;
}

/** K1's presence check: `cardNumber` gaps/duplicates for project cards + preludes, and the corporation by-name cross-check. */
export function buildPresenceCheck(entries: ReadonlyArray<CensusEntry>): PresenceCheck {
  const cardNumberIssues: Array<CardNumberIssue> = [];

  for (const section of ['projectCards', 'preludeCards'] as const) {
    const byNumber = new Map<string, Array<CardName>>();
    for (const entry of entries) {
      if (entry.section !== section) continue;
      const list = byNumber.get(entry.cardNumber) ?? [];
      list.push(entry.name);
      byNumber.set(entry.cardNumber, list);
    }
    for (const [cardNumber, names] of byNumber) {
      if (names.length > 1) {
        cardNumberIssues.push({section, kind: 'duplicate', cardNumber, names});
      }
    }
    // Gap detection only makes sense for the contiguous numeric ranges (001-208, P01-P42); see
    // Phase M section 2 - it does not apply to the sparse, global R-series corporation numbers.
    const numeric = [...byNumber.keys()]
      .map((n) => ({raw: n, value: Number(n.replace(/^P/, ''))}))
      .filter((n) => Number.isFinite(n.value))
      .sort((a, b) => a.value - b.value);
    for (let i = 1; i < numeric.length; i++) {
      const prev = numeric[i - 1].value;
      const curr = numeric[i].value;
      if (curr > prev + 1) {
        for (let missing = prev + 1; missing < curr; missing++) {
          const prefix = section === 'preludeCards' ? 'P' : '';
          const width = section === 'preludeCards' ? 2 : 3;
          cardNumberIssues.push({
            section, kind: 'gap',
            cardNumber: `${prefix}${String(missing).padStart(width, '0')}`,
            names: [],
          });
        }
      }
    }
  }

  // `CardName`'s runtime values ARE the printed display strings (verified against
  // src/common/cards/CardName.ts, e.g. `CREDICOR = 'CrediCor'`), so `entry.name` needs no further
  // translation to compare against the hand-typed {@link PRINTED_CORPORATION_NAMES} list - the
  // by-name check (H2) compares these two flat string lists directly.
  const foundNames = entries
    .filter((e) => e.section === 'corporationCards')
    .map((e) => e.name as string)
    .sort();
  const expected = [...PRINTED_CORPORATION_NAMES].sort();
  const corporations: CorporationNameCheck = {
    expectedNames: expected,
    foundNames,
    missing: expected.filter((n) => !foundNames.includes(n)),
    unexpected: foundNames.filter((n) => !expected.includes(n)),
  };

  return {cardNumberIssues, corporations};
}

export function buildCensusHeader(): CensusHeader {
  return {...buildHeader(), gameOptions: NADIA_GAME_OPTIONS};
}

export function buildCensus(): Census {
  const entries = buildEntries();
  return {
    header: buildCensusHeader(),
    entries,
    presence: buildPresenceCheck(entries),
  };
}

export function saveCensus(filePath: string, census: Census): void {
  fs.writeFileSync(filePath, JSON.stringify(census, null, 2) + '\n');
}

export function loadCensus(filePath: string): Census {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Census;
}

/** The `CensusEntry` fields compared field-by-field by {@link verifyCensus} - every field except `sourceFile`, which is a resolution detail rather than a fact about the game (a file move shouldn't fail `--verify`). */
const COMPARABLE_ENTRY_FIELDS: ReadonlyArray<keyof CensusEntry> = [
  'module', 'section', 'cardNumber', 'type', 'tags', 'cost', 'scope', 'scopeReason', 'imperativeOverrides', 'declarative',
];

/**
 * K7's `--verify` payoff: rebuilds the census right now and diffs it against a committed one,
 * field by field, keyed by `CardName`. Rejects on a header mismatch first (same discipline as
 * `determinism/corpus.ts`'s `assertHeaderCompatible`) - a census built under a different Engine pin
 * isn't a meaningful comparison, it's a different question.
 */
export function verifyCensus(committed: Census, freshEntries: ReadonlyArray<CensusEntry> = buildEntries()): CensusDiff {
  assertHeaderCompatible(committed.header, buildCensusHeader());

  const committedByName = new Map(committed.entries.map((e) => [e.name, e]));
  const freshByName = new Map(freshEntries.map((e) => [e.name, e]));

  const missing = [...committedByName.keys()].filter((name) => !freshByName.has(name));
  const added = [...freshByName.keys()].filter((name) => !committedByName.has(name));

  const mismatches: Array<CensusMismatch> = [];
  for (const [name, committedEntry] of committedByName) {
    const freshEntry = freshByName.get(name);
    if (freshEntry === undefined) continue;
    for (const field of COMPARABLE_ENTRY_FIELDS) {
      const expected = committedEntry[field];
      const actual = freshEntry[field];
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push({name, field, expected, actual});
      }
    }
  }

  return {entriesChecked: committed.entries.length, missing, added, mismatches};
}
