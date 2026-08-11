import * as fs from 'fs';
import * as path from 'path';
import {CardName} from '@/common/cards/CardName';
import {IGame} from '@/server/IGame';
import {loadPlayCoverage} from '../coverage/playSweep';
import {CardScope, CensusSection} from '../coverage/types';
import {CorpusHeader, buildHeader} from '../determinism/corpus';
import {createGame} from '../engine/gameFactory';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {MatchHistoryInstrument, MovesSink, RecordedGameHistory} from '../match/history';
import {buildMatchConfigs} from '../match/pairing';
import {playMatchGame} from '../match/runner';
import {MatchGameConfig, MatchGameRecord} from '../match/types';
import {SEED_BLOCKS} from '../rating/types';
import {assertBlockAvailable, loadLedger} from '../rating/seedBlocks';
import {
  buildRegressionCorpus,
  entryKey,
  saveRegressionCorpus,
} from './corpus';
import {
  CoverageCrossCheck,
  CoverageObserver,
  GameCoverage,
  actionCardNames,
  buildPinnedEntry,
  crossCheckStandardProjects,
  identityFor,
  menuStandardProjectNames,
  standardProjectsFromMoves,
} from './fingerprint';
import {agentRoot, dataPath} from './runner';
import {
  L2GameEntry,
  REGRESSION_SUITE_VERSION,
  RegressionCorpus,
  RegressionEntryIdentity,
  RegressionSection,
} from './types';

/**
 * **Seed selection and the reference-game corpus** (Milestone 2, bullet 5, Unit C;
 * agent/docs/Milestone2_Bullet5_Prompts.md §3.7, §3.8).
 *
 * Three steps, and the third is the one a cheaper run would have skipped:
 *
 * 1. **Survey** - play the allocated R-block range with both frozen baselines at 2p/3p and a 4p
 *    smoke, at `moves` tier, recording per game what it exercised. Throwaway compute: this is the
 *    search space, not the corpus, and the move lists are derived from and discarded (§2.7 - 69.7 KB
 *    per game, measured, so a few hundred games is tens of MB and the wrong thing to keep).
 * 2. **Cover** - a weighted greedy set cover over that survey, tie-broken toward cheap and short
 *    games (hazard H13), then trimmed to §3.8's wall-clock budget.
 * 3. **Record the holes** - what the pinned corpus does not reach, and for the cards the baselines
 *    systematically underuse, *why that is a statement about the baselines rather than about the card
 *    pool*. **The hole list is criterion S3**, and no aggregate percentage is reported without it.
 *
 * ---
 *
 * ## The corpus is selected, which is the opposite of representative
 *
 * Worth stating at the top because it is the first thing a reader will get wrong. A rating corpus is
 * sampled so its win rate estimates a population; this corpus is *chosen* so that a small number of
 * games touch as many distinct code paths as possible. It says nothing about how often anything
 * happens in play, and it is not evidence about strength, legality or throughput (hazard H14, §3.6).
 *
 * ## What the covering search maximizes, and what it cannot
 *
 * Targets are the 274 reachable cards (`docs/data/card_play_coverage.json`, K4's census joined to its
 * 1,500-game sweep), every standard project, every standard action, every Tharsis milestone and every
 * Tharsis award. Weights follow §3.7: the §2.4 tail is worth more than the median card, and the ten
 * cards §2.3 names - the eight Engine-vs-print divergences plus the two effects the Engine's own
 * suite never asserts - are worth much more again, because they are the reason three source documents
 * route work into this bullet at all.
 *
 * **A covering search over a survey can only select what the survey played.** `greedy-1ply@1`
 * maximizes current victory points, so it discounts every card whose value is delayed - and it
 * *finishes games sooner*, which compounds into fewer cards played per game than random play manages
 * (measured, not assumed: see the coverage record's `perStratum` block). So the corpus's holes are a
 * property of the two frozen baselines, and this module's output says so per hole rather than
 * reporting one percentage. A future agent that plays deeper will cover more; that is a reason to
 * re-run the selection at M3's promotion, not a defect in this one.
 */

// ---------------------------------------------------------------------------------------------
// The allocated range and the survey composition
// ---------------------------------------------------------------------------------------------

/** §3.7's reservation. Recorded in `docs/data/ladder.json` **before** any game was played (S9). */
export const L2_GROUP_RANGE = {from: 6_100, to: 6_499} as const;

/** The `--spent-by` the allocation was recorded under; `assertBlockAvailable` matches on it exactly. */
export const L2_ALLOCATION_CLAIM = 'M2b5 L2 reference games';

/**
 * One slice of the survey: a lineup, a player count and a disjoint sub-range of the allocation.
 *
 * **Both baselines appear in self-play and in a mixed lineup, deliberately.** Self-play is what a
 * pinned section is *for* (a frozen version regressing against itself), and the mixed lineups are
 * where the two baselines' different card reach can be compared inside one game, which is the
 * measurement the coverage record's stratum table rests on.
 *
 * `agent` is the section the stratum's games are filed under - one agent, not the whole table
 * (`RegressionEntryIdentity.agent`). Sub-ranges are written out rather than computed so that the
 * range each stratum spent is auditable against `ladder.json` by reading this list.
 */
export type SurveyStratum = {
  label: string;
  agent: string;
  players: 2 | 3 | 4;
  lineup: ReadonlyArray<string>;
  startGroup: number;
  groups: number;
};

/**
 * The default survey. Sized by two facts and one constraint:
 *
 * - `random-legal@1` is roughly two orders of magnitude cheaper per game than `greedy-1ply@1`
 *   (§2.5), so its share of the survey is nearly free and greedy's is the budget.
 * - `random-legal@1` plays two to three times as many cards per game (measured in the pilot, then
 *   confirmed across the whole survey - see the coverage record), so it is also the better *covering*
 *   instrument. §2.4 predicted the opposite ("greedy play reaches further"); that prediction is
 *   wrong, and the composition below follows the measurement rather than the prediction.
 * - Criterion S5 needs both frozen baselines pinned at 2p **and** 3p, plus a 4p smoke, so every one
 *   of those six cells has to be surveyed whether or not the covering search would have chosen it.
 *
 * 950 games over 300 of the 400 allocated groups, 6,100-6,399. **6,400-6,499 is deliberately left
 * unspent** so that a re-selection at M3's promotion gate has fresh seeds inside the same reservation
 * rather than having to allocate a second one.
 */
export const DEFAULT_SURVEY: ReadonlyArray<SurveyStratum> = [
  {label: '2p random-legal self-play', agent: 'random-legal', players: 2, lineup: ['random-legal', 'random-legal'], startGroup: 6_100, groups: 120},
  {label: '2p greedy-1ply self-play', agent: 'greedy-1ply', players: 2, lineup: ['greedy-1ply', 'greedy-1ply'], startGroup: 6_220, groups: 40},
  {label: '2p greedy-1ply vs random-legal', agent: 'greedy-1ply', players: 2, lineup: ['greedy-1ply', 'random-legal'], startGroup: 6_260, groups: 30},
  {label: '3p random-legal self-play', agent: 'random-legal', players: 3, lineup: ['random-legal', 'random-legal', 'random-legal'], startGroup: 6_290, groups: 40},
  {label: '3p greedy-1ply self-play', agent: 'greedy-1ply', players: 3, lineup: ['greedy-1ply', 'greedy-1ply', 'greedy-1ply'], startGroup: 6_330, groups: 15},
  {label: '3p greedy-1ply x2 vs random-legal', agent: 'greedy-1ply', players: 3, lineup: ['greedy-1ply', 'greedy-1ply', 'random-legal'], startGroup: 6_345, groups: 10},
  {label: '4p random-legal smoke', agent: 'random-legal', players: 4, lineup: ['random-legal', 'random-legal', 'random-legal', 'random-legal'], startGroup: 6_355, groups: 25},
  {label: '4p greedy-1ply x2 vs random-legal x2 smoke', agent: 'greedy-1ply', players: 4, lineup: ['greedy-1ply', 'greedy-1ply', 'random-legal', 'random-legal'], startGroup: 6_380, groups: 20},
];

/** Refuses a survey whose strata leave the allocation or overlap each other, before anything is played. */
export function assertSurveyWithinAllocation(strata: ReadonlyArray<SurveyStratum> = DEFAULT_SURVEY): void {
  const problems: Array<string> = [];
  const spans = strata.map((stratum) => ({
    stratum,
    from: stratum.startGroup,
    to: stratum.startGroup + stratum.groups - 1,
  }));

  for (const span of spans) {
    if (span.from < L2_GROUP_RANGE.from || span.to > L2_GROUP_RANGE.to) {
      problems.push(
        `'${span.stratum.label}' spends groups ${span.from}-${span.to}, outside the allocated ` +
        `${L2_GROUP_RANGE.from}-${L2_GROUP_RANGE.to} (§3.7, criterion S9)`);
    }
    if (span.stratum.lineup.length !== span.stratum.players) {
      problems.push(`'${span.stratum.label}' names ${span.stratum.lineup.length} agent(s) for ${span.stratum.players} players`);
    }
  }
  for (const [index, span] of spans.entries()) {
    for (const other of spans.slice(index + 1)) {
      if (span.from <= other.to && other.from <= span.to) {
        problems.push(
          `'${span.stratum.label}' (${span.from}-${span.to}) overlaps '${other.stratum.label}' ` +
          `(${other.from}-${other.to}) - two strata on one engine seed are the same game twice`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`this survey composition was refused and nothing was played:\n  ${problems.join('\n  ')}`);
  }
}

/**
 * The R-block check, run before the survey rather than after it (§3.7: *"Nothing is played before
 * this lands"*). Passes only because `ladder.json` already records the allocation under
 * {@link L2_ALLOCATION_CLAIM} - a run whose reservation is missing is refused here, which is the
 * discipline bullet 3 found was never once refusing anything.
 */
export function assertAllocationRecorded(strata: ReadonlyArray<SurveyStratum> = DEFAULT_SURVEY): void {
  assertSurveyWithinAllocation(strata);
  const ledger = loadLedger(dataPath('ladder.json'));
  const block = SEED_BLOCKS.regression;
  if (L2_GROUP_RANGE.from < block.from || L2_GROUP_RANGE.to > block.to) {
    throw new Error(`the L2 range ${L2_GROUP_RANGE.from}-${L2_GROUP_RANGE.to} is not inside the R block`);
  }
  assertBlockAvailable('regression', L2_GROUP_RANGE.from, L2_GROUP_RANGE.to, ledger, console.warn, L2_ALLOCATION_CLAIM);
}

// ---------------------------------------------------------------------------------------------
// The survey
// ---------------------------------------------------------------------------------------------

/** One surveyed game: what it cost, and what it touched. Never committed - this is the search space. */
export type SurveyGameRow = {
  identity: RegressionEntryIdentity;
  stratum: string;
  completed: boolean;
  failure?: {errorClass: string; message: string};
  /** Wall clock for this game. The covering search's cost, and host-noisy - see {@link coverGames}. */
  durationMs: number;
  decisions: number;
  generation: number;
  /** Every card any seat played: corporations, preludes and project cards, unioned. */
  cards: ReadonlyArray<CardName>;
  standardProjects: ReadonlyArray<CardName>;
  cardActions: ReadonlyArray<CardName>;
  milestones: ReadonlyArray<string>;
  awards: ReadonlyArray<string>;
  /** The moves-tier derivation against the chokepoint observer's - see `fingerprint.ts`. */
  crossCheck: CoverageCrossCheck;
};

export type Survey = {
  header: CorpusHeader;
  suiteVersion: string;
  strata: ReadonlyArray<SurveyStratum>;
  rows: ReadonlyArray<SurveyGameRow>;
  /** §2.7's measurement, re-taken here: what the discarded move lists would have cost to commit. */
  movesTier: {gamesRecorded: number; bytes: number; bytesPerGame: number};
  /** Games where the two derivations of the standard-project list disagreed. Expected: zero. */
  crossCheckDisagreements: number;
  /** Coverage observations that arrived outside a bracketed game. Expected: zero. */
  strayObservations: number;
  durationMs: number;
};

/**
 * A sink that measures a `moves`-tier history and throws it away.
 *
 * §2.7 in code: *"Generate it, derive the coverage record from it, commit the derived record, discard
 * the move lists."* The alternative - `FileMovesSink` into `agent/runs/` - writes tens of MB that
 * nothing ever reads, and the alternative to *that* (`MemoryMovesSink`) holds the same bytes live for
 * the length of the run. The byte count is kept because it is the only part of a move list worth
 * retaining: it is what makes §2.7's retention argument checkable rather than quoted.
 */
export class MeasuringDiscardSink implements MovesSink {
  private written = 0;
  private count = 0;

  public write(history: RecordedGameHistory): {file: string; index: number} {
    this.written += Buffer.byteLength(`${JSON.stringify(history)}\n`);
    this.count += 1;
    return {file: '<discarded>', index: this.count - 1};
  }

  public get bytesWritten(): number {
    return this.written;
  }

  public get gamesRecorded(): number {
    return this.count;
  }

  public get files(): ReadonlyArray<string> {
    return [];
  }

  public close(): void {
    // Nothing to release: nothing was opened, which is the point.
  }
}

export type SurveyOptions = {
  strata?: ReadonlyArray<SurveyStratum>;
  onProgress?: (played: number, total: number, row: SurveyGameRow) => void;
  /** Let the driver's per-fallback warnings and the Engine's eviction lines through. Off by default. */
  verbose?: boolean;
};

/**
 * Plays the whole survey. Yields between games (hazard H8: `Game.gotoEndGame()` is unawaited async,
 * so a synchronous batch holds every finished game alive at ~0.27 MB each).
 *
 * The history instrument and the coverage observer are installed **once around the batch**, not per
 * game, because both are prototype patches and installing them per game would be hundreds of
 * install/uninstall pairs on process-global state for no benefit.
 */
export async function runSurvey(options: SurveyOptions = {}): Promise<Survey> {
  const strata = options.strata ?? DEFAULT_SURVEY;
  assertAllocationRecorded(strata);
  ensureHeadlessEngine();

  const started = Date.now();
  const menu = menuStandardProjectNames();
  const sink = new MeasuringDiscardSink();
  const history = new MatchHistoryInstrument({historyTier: 'moves', legality: false}, {sink});
  const observer = new CoverageObserver();

  const plan: Array<{stratum: SurveyStratum; config: MatchGameConfig}> = [];
  for (const stratum of strata) {
    for (const config of buildMatchConfigs({
      players: stratum.players,
      lineup: stratum.lineup,
      groups: stratum.groups,
      startGroup: stratum.startGroup,
    })) {
      plan.push({stratum, config});
    }
  }

  const rows: Array<SurveyGameRow> = [];
  let disagreements = 0;
  const originalWarn = console.warn;
  const originalLog = console.log;
  if (options.verbose !== true) {
    console.warn = () => {};
    console.log = () => {};
  }

  history.install();
  observer.install();
  try {
    for (const {stratum, config} of plan) {
      observer.startGame();
      const record = playMatchGame(config, history);
      const coverage = observer.finishGame();
      const fromMoves = standardProjectsFromMoves(history.recordedDecisions, menu);
      const crossCheck = crossCheckStandardProjects(coverage.standardProjects, fromMoves, menu);
      if (crossCheck.observerOnly.length > 0 || crossCheck.movesOnly.length > 0) {
        disagreements++;
      }
      const row = surveyRow(stratum, config, record, coverage, crossCheck);
      rows.push(row);
      options.onProgress?.(rows.length, plan.length, row);
      await yieldToEventLoop();
    }
  } finally {
    observer.uninstall();
    history.uninstall();
    console.warn = originalWarn;
    console.log = originalLog;
  }

  return {
    header: buildHeader(),
    suiteVersion: REGRESSION_SUITE_VERSION,
    strata,
    rows,
    movesTier: {
      gamesRecorded: sink.gamesRecorded,
      bytes: sink.bytesWritten,
      bytesPerGame: sink.gamesRecorded === 0 ? 0 : Math.round(sink.bytesWritten / sink.gamesRecorded),
    },
    crossCheckDisagreements: disagreements,
    strayObservations: observer.strayObservations,
    durationMs: Date.now() - started,
  };
}

function surveyRow(
  stratum: SurveyStratum,
  config: MatchGameConfig,
  record: MatchGameRecord,
  coverage: GameCoverage,
  crossCheck: CoverageCrossCheck,
): SurveyGameRow {
  const cards = new Set<CardName>();
  for (const seat of record.seats) {
    for (const name of [...(seat.outcome?.corporations ?? []), ...(seat.outcome?.preludes ?? []), ...(seat.outcome?.projectCards ?? [])]) {
      cards.add(name);
    }
  }
  return {
    identity: identityFor({
      agent: stratum.agent,
      players: stratum.players,
      groupIndex: config.groupIndex,
      permutationIndex: config.permutationIndex,
      lineup: stratum.lineup,
    }),
    stratum: stratum.label,
    completed: record.completed,
    ...(record.failure === undefined ? {} : {failure: record.failure}),
    durationMs: record.durationMs,
    decisions: record.decisions,
    generation: record.generation,
    cards: [...cards].sort(),
    standardProjects: coverage.standardProjects,
    cardActions: coverage.cardActions,
    milestones: record.claimedMilestones.map((claimed) => claimed.milestone).sort(),
    awards: record.fundedAwards.map((funded) => funded.award).sort(),
    crossCheck,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function saveSurvey(filePath: string, survey: Survey): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, `${JSON.stringify(survey, null, 1)}\n`);
}

export function loadSurvey(filePath: string): Survey {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Survey;
}

// ---------------------------------------------------------------------------------------------
// Targets and weights
// ---------------------------------------------------------------------------------------------

/**
 * The ten cards §2.3 names as this bullet's inherited obligations: the eight Engine-vs-print
 * divergences from `Card_Coverage_Audit.md` §3, plus the two effects the Engine's own suite exercises
 * but never asserts.
 *
 * **They are the reason a seed corpus is asked for at all**, and §3.2 settles what a seed can and
 * cannot do about them: a pinned game proves the line is *reachable*; only Unit B's L1 fixture
 * asserts the card's value. Both, not either - so a name here that the survey never reaches is
 * recorded as a hole with its reason (criterion S3) and its L1 fixture stands regardless.
 */
export const NAMED_CARDS: ReadonlyArray<CardName> = [
  // The five escalating divergences.
  CardName.IMMIGRANT_CITY,
  CardName.ENERGY_TAPPING,
  CardName.POWER_SUPPLY_CONSORTIUM,
  CardName.DECOMPOSERS,
  CardName.ECOLOGICAL_ZONE,
  // The three non-escalating.
  CardName.VIRUS,
  CardName.HIRED_RAIDERS,
  CardName.SABOTAGE,
  // The two effects exercised in play but asserted by no Engine unit test.
  CardName.HACKERS,
  // The **standard project**, not a project card. Its `CardName` is the bare string 'City', which is
  // exactly the collision `Card_Coverage_Audit.md` warns about; the census section on the target
  // (`standardProjects`) is what disambiguates it in the coverage record.
  CardName.CITY_STANDARD_PROJECT,
];

/**
 * **`card` and `action` are separate kinds and that is the point.** Playing Search For Life and
 * *taking* its action are two different events, and a record that scored them in one keyspace would
 * report a card as covered because it was played once and never used. Prediction 5 - *card actions
 * will be worse covered than card plays* - is a claim about the gap between these two numbers, so
 * merging them would make it unadjudicable.
 */
export type CoverageTargetKind = 'card' | 'action' | 'milestone' | 'award';

/** One thing the pinned corpus is meant to exercise. */
export type CoverageTarget = {
  /** `card:Ants`, `action:Search For Life`, `milestone:Mayor`, `award:Banker` - unique across kinds. */
  key: string;
  kind: CoverageTargetKind;
  name: string;
  /** Census section, for cards. Lets the report split card *actions* from standard actions. */
  section?: CensusSection;
  scope?: CardScope;
  /** Games of K4's 1,500-game sweep that played this card (§2.4). The rarity weight's input. */
  sweepGamesObserved?: number;
  /** One of {@link NAMED_CARDS}. */
  named: boolean;
  weight: number;
};

/**
 * How much a target is worth to the covering search.
 *
 * Three tiers, and the shape rather than the constants is what matters:
 *
 * - **Rarity**, from K4's 1,500-game sweep: `1500 / (gamesObserved + 15)`. A card played in every
 *   game is worth ~1; Anti-Gravity Technology, played **zero** times in 1,500 games, is worth 100.
 *   The `+ 15` keeps the tail's weights finite and comparable rather than letting a single
 *   never-observed card dominate the whole search. §3.7 asks for "weighted toward the §2.4 tail" and
 *   this is that, quantified.
 * - **The ten named cards**, multiplied by {@link NAMED_CARD_WEIGHT}. They are named in three source
 *   documents and this bullet is their only remaining downstream consumer.
 * - **Milestones and awards** at a flat {@link MILESTONE_AWARD_WEIGHT}. There are ten of them, K4
 *   measured no frequency for them, and criterion S3 asks for every one - a flat weight comparable to
 *   a moderately rare card is the honest encoding of "we want these and we have no prior".
 * - **Card actions** at the card's own rarity times {@link ACTION_MULTIPLIER}. An action is strictly
 *   harder to reach than the play that precedes it - the card must be played, survive to a later
 *   generation, and be chosen over every other action - so it is worth more per unit of rarity, and
 *   K4 measured no separate frequency for it.
 */
export const NAMED_CARD_WEIGHT = 25;
export const MILESTONE_AWARD_WEIGHT = 30;
export const ACTION_MULTIPLIER = 3;
export const RARITY_NUMERATOR = 1_500;
export const RARITY_SMOOTHING = 15;

export function rarityWeight(sweepGamesObserved: number): number {
  return RARITY_NUMERATOR / (sweepGamesObserved + RARITY_SMOOTHING);
}

/** Sections where playing a card and taking its action are separate events - see {@link buildTargets}. */
const ACTIONABLE_SECTIONS: ReadonlySet<CensusSection> = new Set<CensusSection>([
  'projectCards', 'corporationCards', 'preludeCards',
]);

/**
 * Every target, from the committed K4 artifact plus a throwaway game's own milestone and award lists.
 *
 * The milestones and awards are read off a real `IGame` rather than from `Milestones.ts`'s board
 * table, so the list is what Nadia's games actually offer at the pin and cannot drift from it.
 *
 * `unreachable-in-config` census entries are excluded - they cannot appear in a Nadia game, so a
 * corpus that failed to cover them would be reporting a fact about the game options, not a hole.
 * `reachable-by-other-route` (Sell Patents, and only Sell Patents) **is** included: it is genuinely
 * playable, and K4's own sweep scored it 0/1,500 for an instrument reason this unit found and fixed
 * (`fingerprint.ts`), which makes it exactly the kind of entry a coverage record should carry.
 */
export function buildTargets(playCoveragePath: string = dataPath('card_play_coverage.json')): ReadonlyArray<CoverageTarget> {
  const coverage = loadPlayCoverage(playCoveragePath);
  const withActions = actionCardNames();
  const targets: Array<CoverageTarget> = [];

  for (const entry of coverage.entries) {
    if (entry.scope === 'unreachable-in-config') {
      continue;
    }
    const named = NAMED_CARDS.includes(entry.name);
    const rarity = rarityWeight(entry.gamesObserved);
    targets.push({
      key: `card:${entry.name}`,
      kind: 'card',
      name: entry.name,
      section: entry.section,
      scope: entry.scope,
      sweepGamesObserved: entry.gamesObserved,
      named,
      weight: rarity * (named ? NAMED_CARD_WEIGHT : 1),
    });
    // **Only where playing and acting are different events.** `isIActionCard` is structurally true
    // of Sell Patents, Convert Plants and Convert Heat too, but for those the action *is* the use -
    // there is no separate "played it" event to have covered first - so an `action:` target for them
    // would be a second name for a row that already exists, and `action/standardProjects 0/1` would
    // read as a hole that is really an artefact of the target list.
    if (withActions.has(entry.name) && ACTIONABLE_SECTIONS.has(entry.section)) {
      targets.push({
        key: `action:${entry.name}`,
        kind: 'action',
        name: entry.name,
        section: entry.section,
        scope: entry.scope,
        sweepGamesObserved: entry.gamesObserved,
        named,
        weight: rarity * ACTION_MULTIPLIER * (named ? NAMED_CARD_WEIGHT : 1),
      });
    }
  }

  const {milestones, awards} = boardMilestonesAndAwards();
  for (const name of milestones) {
    targets.push({key: `milestone:${name}`, kind: 'milestone', name, named: false, weight: MILESTONE_AWARD_WEIGHT});
  }
  for (const name of awards) {
    targets.push({key: `award:${name}`, kind: 'award', name, named: false, weight: MILESTONE_AWARD_WEIGHT});
  }
  return targets;
}

/** The Tharsis milestone and award names, read off a real game at the pin. */
export function boardMilestonesAndAwards(): {milestones: ReadonlyArray<string>; awards: ReadonlyArray<string>} {
  ensureHeadlessEngine();
  const game: IGame = createGame({players: 2, seed: 1});
  return {
    milestones: game.milestones.map((milestone) => milestone.name).sort(),
    awards: game.awards.map((award) => award.name).sort(),
  };
}

/** The target keys one surveyed game covers. */
export function targetsCoveredBy(row: SurveyGameRow): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const name of row.cards) {
    keys.add(`card:${name}`);
  }
  for (const name of row.standardProjects) {
    keys.add(`card:${name}`);
  }
  for (const name of row.cardActions) {
    // Both keys. A blue card's `card:` is already covered by `row.cards` (it had to be played), but
    // Convert Plants and Convert Heat are never *played* at all - a standard action card's only
    // observable event is its action - so without the `card:` key here they would read as permanent
    // holes in the census's `standardActions` section.
    keys.add(`card:${name}`);
    keys.add(`action:${name}`);
  }
  for (const name of row.milestones) {
    keys.add(`milestone:${name}`);
  }
  for (const name of row.awards) {
    keys.add(`award:${name}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// The covering search
// ---------------------------------------------------------------------------------------------

/**
 * Criterion S5's floor: both frozen baselines, at both counts that matter, plus a 4p smoke. Seeded
 * into the selection **before** the covering search runs, and never trimmed.
 *
 * **The minimums are not 1, and the reason is what the layer is for.** A covering search maximizes
 * coverage per second, and `random-legal@1` is ~75x cheaper per game than `greedy-1ply@1` while
 * covering *more* cards per game (measured; see the coverage record's `perStratum`). Left to itself
 * the search pins almost nothing but cheap random-legal games - a corpus that covers the card pool
 * beautifully and would not notice `greedy-1ply@1` changing at all.
 *
 * That is exactly the failure §2.1 describes: `greedy-1ply@1` is one of the two frozen yardsticks
 * every AC-3 claim is stated against and has **no fixed-seed standing check of any kind**, and M3 is
 * about to change candidate enumeration underneath it. Detecting that needs enough of its games that
 * a change touching one code path moves several entries, not a single game that might not reach the
 * path at all. The floor below costs about 40 s of the survey's measured time, against a budget with
 * room to spare, and it is the part of the corpus that closes the gap the bullet exists for.
 */
export const REQUIRED_CELLS: ReadonlyArray<{agent: string; players: 2 | 3 | 4; minimum: number}> = [
  {agent: 'random-legal', players: 2, minimum: 6},
  {agent: 'random-legal', players: 3, minimum: 4},
  {agent: 'random-legal', players: 4, minimum: 2},
  {agent: 'greedy-1ply', players: 2, minimum: 8},
  {agent: 'greedy-1ply', players: 3, minimum: 6},
  {agent: 'greedy-1ply', players: 4, minimum: 4},
];

export type SelectedGame = {
  row: SurveyGameRow;
  /** Why it was picked: `required` (an S5 cell) or `cover` (the greedy step). */
  reason: 'required' | 'cover';
  /** Targets this game was the first selected game to reach. The sentence in `why` is built from these. */
  newTargets: ReadonlyArray<string>;
  /** Weight of {@link newTargets}. */
  gain: number;
  /** Cumulative predicted replay cost after this pick, in ms. */
  cumulativeMs: number;
};

export type CoverResult = {
  selected: ReadonlyArray<SelectedGame>;
  /** Selected by the search but dropped by the budget trim, in the order they were dropped. */
  trimmed: ReadonlyArray<SelectedGame>;
  /** Target keys no *surveyed* game reached - the baselines never did these at all. */
  unreachedBySurvey: ReadonlyArray<string>;
  /** Target keys the survey reached but the selected set does not - the trim's cost, itemized. */
  lostToTrim: ReadonlyArray<string>;
  budgetMs: number;
  predictedMs: number;
};

export type CoverOptions = {
  targets?: ReadonlyArray<CoverageTarget>;
  /** Wall-clock budget for replaying the pinned corpus once, in ms (§3.8). */
  budgetMs: number;
  requiredCells?: ReadonlyArray<{agent: string; players: 2 | 3 | 4; minimum: number}>;
};

/**
 * Weighted greedy set cover with a cost, then a budget trim.
 *
 * **The rule is `gain / cost`, not `gain`.** §3.7: *"a 20-second game buys the same coverage as a
 * 1.4-second one"*, and at §2.5's measured spread (2p mean 3.95 s against a median of 1.41 s and a
 * p95 of 11.35 s) ignoring cost would spend most of a five-minute budget on a handful of long games.
 * Ties break toward fewer `decisions`, which is the deterministic half of "short" - `durationMs` is
 * wall clock on whatever host the survey ran on, and this one was swapping (hazard H6).
 *
 * **`cost` is the surveyed `durationMs`, and it is a *prediction* of the replay cost, not a
 * measurement of it.** A survey game runs with the `moves`-tier instrument installed and a replay
 * does not, so the prediction is conservative in the safe direction. The corpus's real cost is
 * measured against the committed artifact afterwards (H13: *"verify against the real corpus, not the
 * median"*), and if it misses, the corpus is cut - the budget is not revised (S6).
 */
export function coverGames(rows: ReadonlyArray<SurveyGameRow>, options: CoverOptions): CoverResult {
  const targets = options.targets ?? buildTargets();
  const weightOf = new Map(targets.map((target) => [target.key, target.weight]));
  const universe = new Set(targets.map((target) => target.key));

  const candidates = rows.filter((row) => row.completed);
  const coveredBy = new Map(candidates.map((row) => [entryKey(row.identity), targetsCoveredBy(row)]));

  const reachable = new Set<string>();
  for (const keys of coveredBy.values()) {
    for (const key of keys) {
      if (universe.has(key)) {
        reachable.add(key);
      }
    }
  }

  const remaining = new Set(candidates.map((row) => entryKey(row.identity)));
  const byKey = new Map(candidates.map((row) => [entryKey(row.identity), row]));
  const covered = new Set<string>();
  const picks: Array<SelectedGame> = [];

  const take = (key: string, reason: 'required' | 'cover'): void => {
    const row = byKey.get(key);
    if (row === undefined) {
      return;
    }
    remaining.delete(key);
    const fresh = [...(coveredBy.get(key) ?? [])].filter((target) => universe.has(target) && !covered.has(target)).sort();
    for (const target of fresh) {
      covered.add(target);
    }
    picks.push({
      row,
      reason,
      newTargets: fresh,
      gain: fresh.reduce((total, target) => total + (weightOf.get(target) ?? 0), 0),
      cumulativeMs: 0,
    });
  };

  const gainOf = (key: string): number => {
    let gain = 0;
    for (const target of coveredBy.get(key) ?? []) {
      if (universe.has(target) && !covered.has(target)) {
        gain += weightOf.get(target) ?? 0;
      }
    }
    return gain;
  };

  /**
   * The best remaining game among `keys` by gain per millisecond, or `undefined` if none adds
   * anything. `requireGain: false` falls back to the cheapest game when nothing adds coverage - which
   * is what an S5 cell needs once its own coverage is exhausted, because the cell has to be filled
   * whether or not the next game in it is informative about the card pool.
   */
  const pickBest = (keys: Iterable<string>, requireGain: boolean): string | undefined => {
    let best: {key: string; ratio: number; decisions: number} | undefined;
    for (const key of keys) {
      const row = byKey.get(key);
      if (row === undefined) {
        continue;
      }
      const gain = gainOf(key);
      if (gain <= 0 && requireGain) {
        continue;
      }
      const ratio = (gain <= 0 ? 0 : gain) / Math.max(row.durationMs, 1);
      if (best === undefined || ratio > best.ratio || (ratio === best.ratio && row.decisions < best.decisions)) {
        best = {key, ratio, decisions: row.decisions};
      }
    }
    return best?.key;
  };

  // 1. The S5 floor. Filled by the *same* gain-per-millisecond rule restricted to the cell, not by
  //    taking the cheapest games in it: the floor is a constraint on which agents and player counts
  //    appear, and there is no reason to spend it on games that cover nothing.
  for (const cell of options.requiredCells ?? REQUIRED_CELLS) {
    const inCell = () => [...remaining].filter((key) => {
      const row = byKey.get(key);
      return row !== undefined && row.identity.agent === cell.agent && row.identity.players === cell.players;
    });
    for (let filled = 0; filled < cell.minimum; filled++) {
      const key = pickBest(inCell(), false);
      if (key === undefined) {
        break; // The survey has no more games in this cell; the coverage record reports the shortfall.
      }
      take(key, 'required');
    }
  }

  // 2. Greedy cover by gain per millisecond, until nothing new is reachable.
  for (;;) {
    const key = pickBest(remaining, true);
    if (key === undefined) {
      break;
    }
    take(key, 'cover');
  }

  // 3. Trim to budget. The picks are already in descending value order, so the trim drops the tail -
  //    except that the S5 floor is never trimmable, whatever it costs.
  const kept: Array<SelectedGame> = [];
  const trimmed: Array<SelectedGame> = [];
  let spent = 0;
  for (const pick of picks) {
    const cost = Math.max(pick.row.durationMs, 1);
    if (pick.reason === 'required' || spent + cost <= options.budgetMs) {
      spent += cost;
      kept.push({...pick, cumulativeMs: spent});
    } else {
      trimmed.push(pick);
    }
  }

  // 4. Recompute what each kept game is the *first* to reach, over the kept set alone.
  //
  //    Without this, a `why` describes the search rather than the corpus: game Y's `newTargets` were
  //    computed while a game X that was later trimmed already held some target, so Y's sentence would
  //    omit a target Y is in fact the only committed game to reach. `why` is the field a human reads
  //    first when the suite goes red (§3.3), so it has to be true of the artifact, not of the process
  //    that produced it.
  const selectedKeys = new Set<string>();
  const selected = kept.map((pick) => {
    const fresh = [...(coveredBy.get(entryKey(pick.row.identity)) ?? [])]
      .filter((target) => universe.has(target) && !selectedKeys.has(target))
      .sort();
    for (const target of fresh) {
      selectedKeys.add(target);
    }
    return {
      ...pick,
      newTargets: fresh,
      gain: fresh.reduce((total, target) => total + (weightOf.get(target) ?? 0), 0),
    };
  });

  return {
    selected,
    trimmed,
    unreachedBySurvey: [...universe].filter((key) => !reachable.has(key)).sort(),
    lostToTrim: [...reachable].filter((key) => !selectedKeys.has(key)).sort(),
    budgetMs: options.budgetMs,
    predictedMs: spent,
  };
}

// ---------------------------------------------------------------------------------------------
// The `why` on every pinned entry
// ---------------------------------------------------------------------------------------------

/**
 * One sentence naming what this game is pinned for (§3.3: *`why` is not decoration*).
 *
 * Written from the covering search's own reason for the pick rather than by hand, which is what
 * keeps it true: a hand-written sentence describes what somebody believed the game covered, and this
 * one names the targets it was in fact the first selected game to reach. The ten §2.3 names are
 * called out separately because they are the reason a reader will be looking.
 */
export function whyFor(pick: SelectedGame, targets: ReadonlyArray<CoverageTarget>): string {
  const byKey = new Map(targets.map((target) => [target.key, target]));
  const fresh = pick.newTargets.map((key) => byKey.get(key)).filter((target): target is CoverageTarget => target !== undefined);
  const named = fresh.filter((target) => target.named).map((target) => target.name);
  const rare = fresh
    .filter((target) => !target.named && target.kind === 'card' && (target.sweepGamesObserved ?? Number.MAX_SAFE_INTEGER) < 100)
    .sort((a, b) => (a.sweepGamesObserved ?? 0) - (b.sweepGamesObserved ?? 0))
    .slice(0, 4)
    .map((target) => `${target.name} (${target.sweepGamesObserved}/1,500)`);
  const structural = fresh.filter((target) => target.kind !== 'card').map((target) => `${target.kind} ${target.name}`).slice(0, 4);

  const lineup = pick.row.identity.lineup.join(' vs ');
  const head = pick.reason === 'required' ?
    `Criterion S5 floor: ${pick.row.identity.agent}@${pick.row.identity.agentVersion} at ${pick.row.identity.players}p (${lineup})` :
    `Selected by the covering search at ${pick.row.identity.players}p (${lineup})`;

  const clauses: Array<string> = [];
  if (named.length > 0) {
    clauses.push(`the §2.3 named card${named.length === 1 ? '' : 's'} ${named.join(', ')}`);
  }
  if (rare.length > 0) {
    clauses.push(`${rare.length} low-frequency card${rare.length === 1 ? '' : 's'} - ${rare.join(', ')}`);
  }
  if (structural.length > 0) {
    clauses.push(structural.join(', '));
  }
  // A required game that adds no new coverage still says what it is for. **Not a defect and not a
  // candidate for deletion**: an S5 cell is pinned so that a change to that agent at that player
  // count moves several entries rather than one, and a game whose card set is wholly covered
  // elsewhere is still an independent fingerprint of the agent's behaviour. Saying so in the entry is
  // the difference between a future session understanding that and deleting it as redundant.
  if (pick.newTargets.length === 0) {
    return `${head}; pinned for the agent-version floor rather than for coverage - every card, ` +
      'milestone and award it touches is reached by an earlier-pinned game, and it is here so that a ' +
      "change in this agent's behaviour at this player count moves several entries rather than one.";
  }
  const total = `${pick.newTargets.length} target${pick.newTargets.length === 1 ? '' : 's'} no earlier-pinned game reaches`;
  return clauses.length === 0 ?
    `${head}; it is the first pinned game to reach ${total}.` :
    `${head}; first to reach ${clauses.join('; ')} - ${total} in all.`;
}

// ---------------------------------------------------------------------------------------------
// Building the committed corpus
// ---------------------------------------------------------------------------------------------

/**
 * The two **frozen** baselines (`agent/CLAUDE.md` §6, and bullet 2's pre-commitment: *"any change to
 * its move distribution ... is a new version, not an improvement"*).
 *
 * A literal list, not `lookupAgent(agent).version === agentVersion`. That test asks "is this the
 * registry's current version", which is a different question and answers `true` for every agent M3
 * through M6 will add. `frozen` is what makes §3.1's rule enforceable - *a shared-infrastructure
 * change that moves a frozen baseline is a regression, not a rebaseline* - so a new agent's section
 * must be born `false` and be added here deliberately, at the moment it is frozen.
 */
export const FROZEN_BASELINES: ReadonlySet<string> = new Set(['random-legal@1', 'greedy-1ply@1']);

export type BuildCorpusOptions = {
  targets?: ReadonlyArray<CoverageTarget>;
  onProgress?: (built: number, total: number, key: string) => void;
};

/**
 * Replays every selected game with diagnostics on and files it under its agent's section.
 *
 * Sections are ordered with the frozen baselines in registry order and entries inside a section in
 * `(players, groupIndex, permutationIndex)` order rather than in selection order, so the committed
 * file reads as a corpus rather than as a log of a search. The selection order survives in each
 * entry's `why`.
 */
export async function buildCorpusFromSelection(
  selection: ReadonlyArray<SelectedGame>,
  options: BuildCorpusOptions = {},
): Promise<RegressionCorpus> {
  // The driver's per-fallback warning fires ~5.7 times per game, so pinning a corpus prints several
  // thousand lines around one summary. `runner.ts` silences it on the same precondition and it holds
  // here too: `fallbacks` is a compared fingerprint field, so a change in how often the FR-9 fallback
  // fires is a diff row whether or not it was printed.
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await buildCorpusFromSelectionInner(selection, options);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
}

async function buildCorpusFromSelectionInner(
  selection: ReadonlyArray<SelectedGame>,
  options: BuildCorpusOptions,
): Promise<RegressionCorpus> {
  ensureHeadlessEngine();
  const targets = options.targets ?? buildTargets();
  const recordedAt = new Date().toISOString().slice(0, 10);

  const bySection = new Map<string, Array<{pick: SelectedGame; entry: L2GameEntry}>>();
  let built = 0;
  for (const pick of [...selection].sort(comparePicks)) {
    const entry = buildPinnedEntry(pick.row.identity, {
      // Derived at generation time from the `moves`-tier survey run this selection came out of, and
      // never recomputed on a verify (§2.7, and the field's own doc): recomputing it would mean
      // recording a move list on every entry of every run, against a five-minute budget.
      source: 'moves-tier',
      standardProjects: pick.row.standardProjects,
      cardActions: pick.row.cardActions,
    }, whyFor(pick, targets));
    const key = `${pick.row.identity.agent}@${pick.row.identity.agentVersion}`;
    const list = bySection.get(key) ?? [];
    list.push({pick, entry});
    bySection.set(key, list);
    built++;
    options.onProgress?.(built, selection.length, entryKey(pick.row.identity));
    await yieldToEventLoop();
  }

  const sections: Array<RegressionSection> = [];
  for (const [key, entries] of bySection) {
    const [agent, agentVersion] = key.split('@');
    const groups = entries.map(({entry}) => entry.identity.groupIndex);
    sections.push({
      agent,
      agentVersion,
      frozen: FROZEN_BASELINES.has(`${agent}@${agentVersion}`),
      recordedAt,
      groupRange: {from: Math.min(...groups), to: Math.max(...groups)},
      entries: entries.map(({entry}) => entry),
    });
  }
  sections.sort((a, b) => a.agent.localeCompare(b.agent));
  return buildRegressionCorpus(sections);
}

function comparePicks(a: SelectedGame, b: SelectedGame): number {
  return a.row.identity.agent.localeCompare(b.row.identity.agent) ||
    a.row.identity.players - b.row.identity.players ||
    a.row.identity.groupIndex - b.row.identity.groupIndex ||
    a.row.identity.permutationIndex - b.row.identity.permutationIndex;
}

// ---------------------------------------------------------------------------------------------
// The coverage record - criterion S3
// ---------------------------------------------------------------------------------------------

/**
 * One target's coverage, at three depths. All three columns are reported together, always, because
 * each one answers a different question and only the three of them side by side distinguish *"the
 * baselines cannot reach this"* from *"the trim dropped it"*.
 */
export type CoverageRecordRow = {
  kind: CoverageTargetKind;
  name: string;
  section?: CensusSection;
  scope?: CardScope;
  named: boolean;
  /** K4's 1,500-game random-legal sweep (§2.4). Cards only. */
  sweepGamesObserved?: number;
  /** Games of the survey that exercised it. */
  surveyGames: number;
  /** Games of the **pinned corpus** that exercise it. This is the S3 column. */
  pinnedGames: number;
  /**
   * Why it is not covered, when `pinnedGames` is 0:
   * - `not-reached-by-baselines` - no surveyed game touched it. A fact about `random-legal@1` and
   *   `greedy-1ply@1`, not about the card.
   * - `lost-to-budget-trim` - the survey reached it and §3.8's budget cut the game that did.
   */
  hole?: 'not-reached-by-baselines' | 'lost-to-budget-trim';
};

/** Per-stratum card reach, which is what makes the hole list interpretable rather than embarrassing. */
export type StratumReach = {
  stratum: string;
  games: number;
  distinctCards: number;
  meanCardsPerGame: number;
  meanCardActionsPerGame: number;
  meanDecisions: number;
  meanGenerations: number;
  meanDurationMs: number;
};

export type RegressionCoverageRecord = {
  header: CorpusHeader;
  suiteVersion: string;
  survey: {
    strata: ReadonlyArray<SurveyStratum>;
    games: number;
    completed: number;
    groupRange: {from: number; to: number};
    movesTier: Survey['movesTier'];
    crossCheckDisagreements: number;
    durationMs: number;
  };
  pinned: {
    games: number;
    sections: ReadonlyArray<{agent: string; agentVersion: string; entries: number}>;
    budgetMs: number;
    predictedMs: number;
    trimmedGames: number;
  };
  /** Headline counts per kind and section. **Never read without {@link holes}** - criterion S3. */
  totals: ReadonlyArray<{group: string; targets: number; pinned: number; survey: number}>;
  rows: ReadonlyArray<CoverageRecordRow>;
  holes: ReadonlyArray<CoverageRecordRow>;
  perStratum: ReadonlyArray<StratumReach>;
};

export function buildCoverageRecord(
  survey: Survey,
  cover: CoverResult,
  targets: ReadonlyArray<CoverageTarget> = buildTargets(),
): RegressionCoverageRecord {
  const surveyCounts = tally(survey.rows.map(targetsCoveredBy));
  const pinnedCounts = tally(cover.selected.map((pick) => targetsCoveredBy(pick.row)));

  const rows: Array<CoverageRecordRow> = targets.map((target) => {
    const surveyGames = surveyCounts.get(target.key) ?? 0;
    const pinnedGames = pinnedCounts.get(target.key) ?? 0;
    return {
      kind: target.kind,
      name: target.name,
      ...(target.section === undefined ? {} : {section: target.section}),
      ...(target.scope === undefined ? {} : {scope: target.scope}),
      named: target.named,
      ...(target.sweepGamesObserved === undefined ? {} : {sweepGamesObserved: target.sweepGamesObserved}),
      surveyGames,
      pinnedGames,
      ...(pinnedGames > 0 ?
        {} :
        {hole: surveyGames === 0 ? 'not-reached-by-baselines' as const : 'lost-to-budget-trim' as const}),
    };
  });

  const groups = new Map<string, {targets: number; pinned: number; survey: number}>();
  for (const row of rows) {
    const group = row.kind === 'card' || row.kind === 'action' ? `${row.kind}/${row.section}` : row.kind;
    const tallyRow = groups.get(group) ?? {targets: 0, pinned: 0, survey: 0};
    groups.set(group, {
      targets: tallyRow.targets + 1,
      pinned: tallyRow.pinned + (row.pinnedGames > 0 ? 1 : 0),
      survey: tallyRow.survey + (row.surveyGames > 0 ? 1 : 0),
    });
  }

  const sections = new Map<string, number>();
  for (const pick of cover.selected) {
    const key = `${pick.row.identity.agent}@${pick.row.identity.agentVersion}`;
    sections.set(key, (sections.get(key) ?? 0) + 1);
  }

  const groupIndices = survey.rows.map((row) => row.identity.groupIndex);
  return {
    header: buildHeader(),
    suiteVersion: REGRESSION_SUITE_VERSION,
    survey: {
      strata: survey.strata,
      games: survey.rows.length,
      completed: survey.rows.filter((row) => row.completed).length,
      groupRange: {from: Math.min(...groupIndices), to: Math.max(...groupIndices)},
      movesTier: survey.movesTier,
      crossCheckDisagreements: survey.crossCheckDisagreements,
      durationMs: survey.durationMs,
    },
    pinned: {
      games: cover.selected.length,
      sections: [...sections.entries()].map(([key, entries]) => {
        const [agent, agentVersion] = key.split('@');
        return {agent, agentVersion, entries};
      }),
      budgetMs: cover.budgetMs,
      predictedMs: cover.predictedMs,
      trimmedGames: cover.trimmed.length,
    },
    totals: [...groups.entries()].map(([group, tallyRow]) => ({group, ...tallyRow})),
    rows,
    holes: rows.filter((row) => row.pinnedGames === 0),
    perStratum: stratumReach(survey),
  };
}

function tally(sets: ReadonlyArray<ReadonlySet<string>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const set of sets) {
    for (const key of set) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Card reach per stratum. **This is the table that decides how the hole list reads**: a hole is only
 * interpretable next to a measurement of how far each baseline reaches, and §2.4's expectation
 * ("greedy play reaches further") is a claim this table either supports or refutes.
 */
export function stratumReach(survey: Survey): ReadonlyArray<StratumReach> {
  const byStratum = new Map<string, Array<SurveyGameRow>>();
  for (const row of survey.rows) {
    byStratum.set(row.stratum, [...(byStratum.get(row.stratum) ?? []), row]);
  }
  return [...byStratum.entries()].map(([stratum, rows]) => {
    const distinct = new Set<CardName>();
    for (const row of rows) {
      for (const name of row.cards) {
        distinct.add(name);
      }
    }
    const mean = (of: (row: SurveyGameRow) => number) =>
      Math.round((rows.reduce((total, row) => total + of(row), 0) / rows.length) * 100) / 100;
    return {
      stratum,
      games: rows.length,
      distinctCards: distinct.size,
      meanCardsPerGame: mean((row) => row.cards.length),
      meanCardActionsPerGame: mean((row) => row.cardActions.length),
      meanDecisions: mean((row) => row.decisions),
      meanGenerations: mean((row) => row.generation),
      meanDurationMs: mean((row) => row.durationMs),
    };
  });
}

export function saveCoverageRecord(filePath: string, record: RegressionCoverageRecord): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const {rows, holes, ...rest} = record;
  const head = JSON.stringify(rest, null, 2);
  const list = (name: string, values: ReadonlyArray<CoverageRecordRow>) =>
    `  "${name}": [\n${values.map((row) => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]`;
  fs.writeFileSync(filePath, `${head.slice(0, head.length - 2)},\n${list('rows', rows)},\n${list('holes', holes)}\n}\n`);
}

export function loadCoverageRecord(filePath: string): RegressionCoverageRecord {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RegressionCoverageRecord;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

/**
 * **The selection CLI lives in this module rather than in `src/runner/`, and that is an ownership
 * decision rather than a style one.** §8 gives `agent/package.json` to Unit A and says a unit that
 * needs a script asks for one; Unit A had already landed and merged when this was written, so the
 * options were to edit a file this unit does not own or to make the module runnable. It is runnable,
 * following `match/pool.ts` and `determinism/sweep.ts`, which are invoked the same way. Adding
 * `"regression:select": "tsx src/regression/select.ts"` to `package.json` is a one-line change
 * whenever an owner is available.
 *
 * ```bash
 * npx tsx src/regression/select.ts survey                     # step 1, hours; writes agent/runs/
 * npx tsx src/regression/select.ts cover --budget-ms 120000   # step 2, seconds; prints the selection
 * npx tsx src/regression/select.ts build --budget-ms 120000   # steps 2+3; writes both artifacts
 * npx tsx src/regression/select.ts report                     # re-print the committed coverage record
 * ```
 */
export const SURVEY_FILE = path.join(agentRoot(), 'runs', 'regression_survey.json');

/**
 * Default L2 replay budget. §3.8 gives the **whole suite** 5 minutes compiled and 20 under `tsx`,
 * and L2's own line shares that with the 300-config determinism corpus it invokes (§3.9), which on
 * this host is the single biggest line in the suite. Two minutes of measured survey time is the share
 * that leaves room for the rest; it is a starting point for `--budget-ms`, not a finding, and the
 * real cost is measured against the committed corpus afterwards (H13).
 */
export const DEFAULT_BUDGET_MS = 120_000;

function parseArgs(argv: ReadonlyArray<string>): {command: string; flags: Map<string, string>} {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new Error(`unexpected argument '${token}'`);
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(token, 'true');
    } else {
      flags.set(token, next);
      index++;
    }
  }
  return {command, flags};
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const {command, flags} = parseArgs(argv);
  const budgetMs = Number(flags.get('--budget-ms') ?? DEFAULT_BUDGET_MS);
  const surveyPath = flags.get('--survey') ?? SURVEY_FILE;

  switch (command) {
  case 'survey': {
    console.error(`[select] surveying the allocated range ${L2_GROUP_RANGE.from}-${L2_GROUP_RANGE.to} at moves tier`);
    const survey = await runSurvey({
      onProgress: (played, total, row) => {
        if (played % 10 === 0 || played === total) {
          process.stderr.write(`[select] ${played}/${total} ${row.stratum} ${entryKey(row.identity)} ${row.durationMs} ms\n`);
        }
      },
    });
    saveSurvey(surveyPath, survey);
    console.error(
      `[select] ${survey.rows.length} games, ${survey.rows.filter((row) => row.completed).length} completed, ` +
      `${Math.round(survey.durationMs / 1000)} s; moves tier would have been ` +
      `${(survey.movesTier.bytes / 1024 / 1024).toFixed(1)} MB (${survey.movesTier.bytesPerGame} B/game), discarded. ` +
      `Cross-check disagreements: ${survey.crossCheckDisagreements}. Stray observations: ${survey.strayObservations}.`);
    console.error(`[select] wrote ${surveyPath}`);
    return;
  }
  case 'cover': {
    const survey = loadSurvey(surveyPath);
    const targets = buildTargets();
    const cover = coverGames(survey.rows, {targets, budgetMs});
    printCover(survey, cover, targets);
    return;
  }
  case 'build': {
    const survey = loadSurvey(surveyPath);
    const targets = buildTargets();
    const cover = coverGames(survey.rows, {targets, budgetMs});
    printCover(survey, cover, targets);

    const corpus = await buildCorpusFromSelection(cover.selected, {
      targets,
      onProgress: (done, total, key) => process.stderr.write(`[select] pinning ${done}/${total} ${key}\n`),
    });
    const corpusPath = dataPath('regression_suite.json');
    saveRegressionCorpus(corpusPath, corpus);
    console.error(`[select] wrote ${corpusPath}`);

    const record = buildCoverageRecord(survey, cover, targets);
    const recordPath = dataPath('regression_coverage.json');
    saveCoverageRecord(recordPath, record);
    console.error(`[select] wrote ${recordPath}`);
    return;
  }
  case 'report': {
    const record = loadCoverageRecord(dataPath('regression_coverage.json'));
    for (const total of record.totals) {
      console.log(`${total.group.padEnd(24)} pinned ${String(total.pinned).padStart(4)}/${total.targets} (survey reached ${total.survey})`);
    }
    console.log(`\n${record.holes.length} hole(s):`);
    for (const hole of record.holes) {
      console.log(`  ${hole.kind}/${hole.name} - ${hole.hole}${hole.sweepGamesObserved === undefined ? '' : ` (K4 sweep: ${hole.sweepGamesObserved}/1,500)`}`);
    }
    return;
  }
  default:
    console.log([
      'Unit C, the seed selection and reference-game corpus. Commands:',
      '  survey [--survey <path>]                 play the allocated R-block range at moves tier (hours)',
      '  cover  [--budget-ms N] [--survey <path>] run the covering search and print the selection',
      '  build  [--budget-ms N] [--survey <path>] cover, then pin and write both committed artifacts',
      '  report                                   re-print the committed coverage record and its holes',
    ].join('\n'));
  }
}

function printCover(survey: Survey, cover: CoverResult, targets: ReadonlyArray<CoverageTarget>): void {
  const record = buildCoverageRecord(survey, cover, targets);
  console.error(
    `[select] ${cover.selected.length} games selected (${cover.trimmed.length} trimmed), ` +
    `predicted ${Math.round(cover.predictedMs / 1000)} s against a ${Math.round(cover.budgetMs / 1000)} s budget`);
  for (const total of record.totals) {
    console.error(`[select]   ${total.group.padEnd(24)} ${total.pinned}/${total.targets} pinned, ${total.survey}/${total.targets} reached by the survey`);
  }
  console.error(`[select] holes: ${record.holes.length} (${record.holes.filter((hole) => hole.hole === 'not-reached-by-baselines').length} never reached by the baselines)`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
