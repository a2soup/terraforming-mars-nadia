import {CardName} from '@/common/cards/CardName';
import {CardType} from '@/common/cards/CardType';
import {Tag} from '@/common/cards/Tag';
import {GameOptions} from '@/server/game/GameOptions';
import {CorpusHeader} from '../determinism/corpus';

/**
 * Phase M types (Milestone1_Bullet7_Prompts.md, "Phase M", section 1). K1-K4 are computed from
 * these shapes; K5-K7 belong to phases I/R/W and are not modelled here.
 */

/**
 * K2's classification. `reachable-by-other-route` means the manifest entry is real and playable
 * but not through the route its own section implies (SELL_PATENTS_STANDARD_PROJECT, routed through
 * a `projectCard` decision rather than the standard-project list - Game.ts:1637).
 * `unreachable-in-config` means the entry cannot appear in any Nadia game at all under the fixed
 * {boardName: THARSIS, corporateEra: true, preludeExtension: true} options (BEGINNER_CORPORATION,
 * BUFFER_GAS_STANDARD_PROJECT).
 */
export type CardScope = 'reachable' | 'reachable-by-other-route' | 'unreachable-in-config';

export type CensusSection = 'projectCards' | 'corporationCards' | 'preludeCards' | 'standardProjects' | 'standardActions';

export type CensusModule = 'base' | 'corpera' | 'prelude';

export type CensusEntry = {
  name: CardName;
  module: CensusModule;
  section: CensusSection;
  /** `metadata.cardNumber` off the instantiated card - the printed number (K1's internal anchor, H1). */
  cardNumber: string;
  type: CardType;
  tags: ReadonlyArray<Tag>;
  cost?: number;
  /** Repo-relative path, resolved from the manifest's own import statement (H1's sourceFile note). */
  sourceFile: string;
  scope: CardScope;
  /** The Engine code reference that decides `scope`, e.g. 'Game.ts:1640 solo+soloTR only'. */
  scopeReason: string;
  /** Method names from the ranked override list (Milestone1_Bullet7_Prompts.md "implementation surface") defined on the card's own class, not inherited from a framework base class. */
  imperativeOverrides: ReadonlyArray<string>;
  /** Whether the card's own class sets a `behavior` (or, for standardActions/corporations, `action`/`firstAction`) property. */
  declarative: boolean;
};

/** Same provenance discipline as the determinism corpus / AC-1 artifact (CorpusHeader) plus the exact GameOptions the census was built under - a census without them is not interpretable (Phase M section 1). */
export type CensusHeader = CorpusHeader & {
  gameOptions: GameOptions;
};

export type CardNumberIssue = {
  section: 'projectCards' | 'preludeCards';
  kind: 'gap' | 'duplicate';
  cardNumber: string;
  names: ReadonlyArray<CardName>;
};

export type CorporationNameCheck = {
  /** The literal, hand-authored printed-corporation-name list (H1's one non-Engine-derived anchor). */
  expectedNames: ReadonlyArray<string>;
  /** Names found in the manifest (BEGINNER_CORPORATION included), from `metadata.renderData`-independent card identity - see census.ts for exactly which field is compared. */
  foundNames: ReadonlyArray<string>;
  missing: ReadonlyArray<string>;
  unexpected: ReadonlyArray<string>;
};

/** K1's presence check: the sorted cardNumber sequence with gaps/duplicates, plus the by-name corporation cross-check. */
export type PresenceCheck = {
  cardNumberIssues: ReadonlyArray<CardNumberIssue>;
  corporations: CorporationNameCheck;
};

export type Census = {
  header: CensusHeader;
  entries: ReadonlyArray<CensusEntry>;
  presence: PresenceCheck;
};

/** One field that differs between a committed census and a freshly re-run one (K7's `--verify`). */
export type CensusMismatch = {
  name: CardName;
  field: keyof CensusEntry;
  expected: unknown;
  actual: unknown;
};

export type CensusDiff = {
  entriesChecked: number;
  /** Entries present in the committed census but missing from the fresh one - a card removed from the manifest. */
  missing: ReadonlyArray<CardName>;
  /** Entries present in the fresh census but not the committed one - a card added to the manifest. */
  added: ReadonlyArray<CardName>;
  mismatches: ReadonlyArray<CensusMismatch>;
};

/** K4: one entry's observed play/use frequency across the sweep. */
export type PlayCoverageEntry = {
  name: CardName;
  section: CensusSection;
  scope: CardScope;
  timesObserved: number;
  gamesObserved: number;
};

export type PlayCoverageHeader = CorpusHeader & {
  gameOptions: GameOptions;
  composition: ReadonlyArray<{players: 2 | 3 | 4; games: number}>;
  gamesRun: number;
  gamesCompleted: number;
};

export type PlayCoverage = {
  header: PlayCoverageHeader;
  entries: ReadonlyArray<PlayCoverageEntry>;
  /** Entries whose `scope` was `unreachable-in-config` in the census but were nevertheless observed - a finding about the census, not the card (Phase M section 5). */
  unexpectedlyPlayed: ReadonlyArray<CardName>;
};
