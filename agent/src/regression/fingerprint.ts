import {CardName} from '@/common/cards/CardName';
import {InputResponse} from '@/common/inputs/InputResponse';
import {IPlayer} from '@/server/IPlayer';
import {GameCards} from '@/server/GameCards';
import {Player} from '@/server/Player';
import {PlayerInput} from '@/server/PlayerInput';
import {StandardActionCard} from '@/server/cards/StandardActionCard';
import {StandardProjectCard} from '@/server/cards/StandardProjectCard';
import {ICard, isIActionCard} from '@/server/cards/ICard';
import {CardManifest, ModuleManifest} from '@/server/cards/ModuleManifest';
import {isCompatibleWith} from '@/server/cards/CardFactorySpec';
import {BASE_CARD_MANIFEST, CORP_ERA_CARD_MANIFEST} from '@/server/cards/StandardCardManifests';
import {PRELUDE_CARD_MANIFEST} from '@/server/cards/prelude/PreludeCardManifest';
import {lookupAgent} from '../agents/registry';
import {NADIA_GAME_OPTIONS} from '../coverage/census';
import {CensusSection} from '../coverage/types';
import {RecordedDecision} from '../match/history';
import {permutationsFor} from '../match/pairing';
import {isSpeculative} from '../search/speculation';
import {entryKey, playRegressionEntry} from './corpus';
import {L2GameEntry, RegressionEntryCoverage, RegressionEntryIdentity} from './types';

/**
 * **What a game exercises, and how a surveyed game becomes a pinned entry** (Milestone 2, bullet 5,
 * Unit C §2/§4; agent/docs/Milestone2_Bullet5_Prompts.md §3.3, §3.7).
 *
 * Two lists per game - the standard projects it used and the card actions it took - and the whole of
 * this module is about getting them right, because they are the two facts `MatchGameRecord` does not
 * already carry (`regression/types.ts`'s {@link RegressionEntryCoverage} says so: cards played are in
 * each seat's `projectCards`, milestones and awards are in the game semantics, and *what is left is
 * exactly the two things recoverable from nowhere else*).
 *
 * ---
 *
 * ## Why the lists are read off the Engine's own chokepoints and not off the move list
 *
 * §3.7 specifies a `moves`-tier survey, and this module runs one - the survey plays at `moves` tier
 * and {@link standardProjectsFromMoves} derives from the recorded responses. But the move list turns
 * out to be a sufficient instrument for only one of the two lists, and the reason is worth stating
 * once so it is not rediscovered:
 *
 * - **Standard projects: derivable, for five of six.** `SelectStandardProjectToPlay` extends
 *   `SelectCardToPlay`, so its response is `{type: 'projectCard', card, payment}` and the card name
 *   is a closed set. That covers Aquifer, City, Power Plant, Greenery and Asteroid. **Sell Patents is
 *   not among them**: `Game.getStandardProjects()` filters it out of the standard-project menu
 *   (`Game.ts:1637`, *"sell patents is not displayed as a card"*) and `Player.getActions()` offers
 *   `sellPatents.action(this)` instead - a bare `SelectCard` over the hand, indistinguishable in a
 *   response from every other `{type: 'card'}` decision in the game.
 * - **Card actions: not derivable.** A blue card's action is taken through `Player.playActionCard()`,
 *   whose input is also a bare `SelectCard`. A `{type: 'card', cards: ['Search For Life']}` response
 *   is a card action, a discard, a sale or a selection depending only on which decision was open, and
 *   the recorded `decisionType` is the *top-level* `'or'` in every one of those cases. Guessing from
 *   the name would make prediction 5 - *card actions will be worse covered than card plays* - an
 *   artefact of the guess.
 *
 * So both lists come from {@link CoverageObserver}, which wraps the Engine's own execution
 * chokepoints from the outside, and the move-list derivation is kept as an **independent cross-check**
 * on the five it can see (§3.7's survey is throwaway compute; a second derivation over it is close to
 * free and is the only thing that would catch this module wrapping the wrong method). That is
 * `coverage/playSweep.ts`'s technique, for its reason - *"a card is played when the Engine executes
 * the play"* - with two corrections it earned:
 *
 * 1. **The chokepoint is `projectPlayed`, not `payAndExecute`.** K4 wrapped `payAndExecute` and
 *    reported **Sell Patents as played 0 times in 1,500 games**, filed under
 *    `reachable-by-other-route`. Sell Patents never calls `payAndExecute` - it calls `projectPlayed`
 *    directly from inside its own `action()`'s callback. `projectPlayed` is the unique chokepoint for
 *    all six (`payAndExecute` calls it too), so wrapping it counts each standard project exactly
 *    once and counts Sell Patents at all.
 * 2. **A fork is not a game.** K4 ran only `random-legal@1`, which never forks. This survey runs
 *    `greedy-1ply@1`, which clones the game at every scored decision and plays candidate moves into
 *    the clone - and a prototype patch is process-global, so every speculative play would land in the
 *    coverage lists. `isSpeculative(game)` is the guard `search/speculation.ts` exists to provide
 *    (bullet 2 §3.2, hazard H1/H2: **object identity, never `game.id`**, because a fork and its
 *    original share an id). Without it the lists would not be wrong-looking; they would be plausible
 *    and enormous, which is the failure mode this whole bullet is about.
 *
 * ---
 *
 * ## Where standard *actions* go, and why that is not a shrug
 *
 * The Engine models Convert Plants and Convert Heat as `StandardActionCard`s - a third census
 * section, and {@link RegressionEntryCoverage} has two lists. They are recorded in `cardActions`,
 * because that field's documented meaning is *cards whose `action()` was taken at least once* and
 * `ConvertHeat.action()` is literally that, whereas they are not standard **projects** by any
 * reading. The cost is that they would flatter prediction 5 if left folded in (both are used in
 * ~100% of games), so the coverage record in `select.ts` splits card actions by census section and
 * the prediction is adjudicated on the blue-card subset alone. Nothing is hidden and nothing is
 * mislabelled; the split lives in the report rather than in the entry.
 */

// ---------------------------------------------------------------------------------------------
// Observing what a game exercised
// ---------------------------------------------------------------------------------------------

/** The two lists, per game. Sorted, so two runs of one game produce identical entries. */
export type GameCoverage = {
  standardProjects: ReadonlyArray<CardName>;
  cardActions: ReadonlyArray<CardName>;
};

export const EMPTY_COVERAGE: GameCoverage = {standardProjects: [], cardActions: []};

type ProjectPlayedFn = (this: StandardProjectCard, player: IPlayer) => void;
type ActionUsedFn = (this: StandardActionCard, player: IPlayer) => void;
type PlayActionCardFn = (this: Player) => PlayerInput;

/**
 * Wraps three Engine chokepoints, from the outside, and never edits `src/` (CON-1):
 *
 * | List | Chokepoint | Covers |
 * | --- | --- | --- |
 * | `standardProjects` | `StandardProjectCard.prototype.projectPlayed` | all six, Sell Patents included |
 * | `cardActions` | `StandardActionCard.prototype.actionUsed` | Convert Plants, Convert Heat |
 * | `cardActions` | `Player.prototype.playActionCard`'s callback | every blue card and corporation action |
 *
 * **The third one wraps a callback rather than a method**, because there is no per-card prototype to
 * wrap: `playActionCard()` builds a fresh `SelectCard` whose `andThen` closure is what runs
 * `card.action(player)`. So the wrapper takes the input the Engine just built and replaces its `cb`
 * with one that records and delegates. `cb` is a public field on `BasePlayerInput` and replacing it
 * directly (rather than calling `andThen` again) is deliberate - `andThen` refuses a second
 * registration and would log `andThen called twice` on every action decision in the run.
 *
 * Process-global, like every prototype patch in this codebase, so it is installed once around a batch
 * and uninstalled in a `finally`. {@link startGame} brackets a game; {@link finishGame} returns its
 * lists and resets.
 */
export class CoverageObserver {
  private originalProjectPlayed: ProjectPlayedFn | undefined;
  private originalActionUsed: ActionUsedFn | undefined;
  private originalPlayActionCard: PlayActionCardFn | undefined;

  private standardProjects = new Set<CardName>();
  private cardActions = new Set<CardName>();
  /** Plays observed while no game was open. Counted rather than assumed away - see {@link strayObservations}. */
  private stray = 0;
  private open = false;

  /**
   * **The negative control, and nothing else.** With this set, plays inside a search fork are counted
   * exactly as they would be had the `isSpeculative` guard never been written.
   *
   * `search/speculation.ts` argues the case and this unit takes it literally: *"a guard whose absence
   * produces the same numbers as its presence is either unnecessary or - far more likely - not
   * actually wired in"*. `test/regression/select.spec.ts` runs one `greedy-1ply@1` game both ways and
   * asserts the counted-forks run reports strictly more, which is the only evidence that the guard on
   * the default path is doing anything at all. Never set it in a survey.
   */
  constructor(private readonly countSpeculative = false) {}

  public install(): void {
    if (this.originalProjectPlayed !== undefined) {
      return;
    }
    const observer = this;

    const projectPrototype = StandardProjectCard.prototype as unknown as {projectPlayed: ProjectPlayedFn};
    this.originalProjectPlayed = projectPrototype.projectPlayed;
    projectPrototype.projectPlayed = function(this: StandardProjectCard, player: IPlayer) {
      observer.record(observer.standardProjects, this.name, player);
      return observer.originalProjectPlayed!.call(this, player);
    };

    const actionPrototype = StandardActionCard.prototype as unknown as {actionUsed: ActionUsedFn};
    this.originalActionUsed = actionPrototype.actionUsed;
    actionPrototype.actionUsed = function(this: StandardActionCard, player: IPlayer) {
      observer.record(observer.cardActions, this.name, player);
      return observer.originalActionUsed!.call(this, player);
    };

    this.originalPlayActionCard = Player.prototype.playActionCard;
    Player.prototype.playActionCard = function(this: Player) {
      const player = this;
      const input = observer.originalPlayActionCard!.call(this);
      const inner = input.cb.bind(input);
      input.cb = (cards: ReadonlyArray<ICard>) => {
        // One card, by the input's own `max: 1`; the loop is cheaper than an assertion about it.
        for (const card of cards) {
          observer.record(observer.cardActions, card.name, player);
        }
        return inner(cards);
      };
      return input;
    };
  }

  /** LIFO restore of all three prototypes. A leaked wrapper would instrument every later game in the process. */
  public uninstall(): void {
    if (this.originalPlayActionCard !== undefined) {
      Player.prototype.playActionCard = this.originalPlayActionCard;
      this.originalPlayActionCard = undefined;
    }
    if (this.originalActionUsed !== undefined) {
      (StandardActionCard.prototype as unknown as {actionUsed: ActionUsedFn}).actionUsed = this.originalActionUsed;
      this.originalActionUsed = undefined;
    }
    if (this.originalProjectPlayed !== undefined) {
      (StandardProjectCard.prototype as unknown as {projectPlayed: ProjectPlayedFn}).projectPlayed = this.originalProjectPlayed;
      this.originalProjectPlayed = undefined;
    }
  }

  public get installed(): boolean {
    return this.originalProjectPlayed !== undefined;
  }

  public startGame(): void {
    this.standardProjects = new Set();
    this.cardActions = new Set();
    this.open = true;
  }

  public finishGame(): GameCoverage {
    this.open = false;
    return {
      standardProjects: [...this.standardProjects].sort(),
      cardActions: [...this.cardActions].sort(),
    };
  }

  /**
   * Observations that arrived while no game was bracketed. Should be zero; reported rather than
   * asserted away, because a non-zero value means the batch loop and this observer disagree about
   * where a game starts and that would silently under-attribute coverage.
   */
  public get strayObservations(): number {
    return this.stray;
  }

  private record(into: Set<CardName>, name: CardName, player: IPlayer): void {
    // A play inside a search fork never happened. Object identity, never `game.id` (hazard H2 of
    // bullet 2: a fork and its original share one).
    if (isSpeculative(player.game) && !this.countSpeculative) {
      return;
    }
    if (!this.open) {
      this.stray++;
      return;
    }
    into.add(name);
  }
}

/** Runs `fn` with a freshly installed observer, and uninstalls it however `fn` ends. */
export function withCoverageObserver<T>(fn: (observer: CoverageObserver) => T, countSpeculative = false): T {
  const observer = new CoverageObserver(countSpeculative);
  observer.install();
  try {
    return fn(observer);
  } finally {
    observer.uninstall();
  }
}

// ---------------------------------------------------------------------------------------------
// The independent derivation, from the moves tier
// ---------------------------------------------------------------------------------------------

/**
 * Every in-scope card that **has an action**, i.e. every card for which `action:<name>` is a target a
 * pinned corpus could reach.
 *
 * Needed because *playing* a blue card and *taking its action* are two different events, and a
 * coverage record that scored them in one keyspace would report a card as covered because it was
 * played once and never used - which is precisely what prediction 5 (*card actions will be worse
 * covered than card plays, because `greedy-1ply@1` maximizes points-now and delayed-value actions are
 * what that objective discounts*) is a claim about. The two lists have to be separable or the
 * prediction cannot be adjudicated at all.
 *
 * `isIActionCard` is the Engine's own structural test (`canAct` and `action` both present), applied
 * to a real instance of every in-scope manifest entry - the same walk `coverage/census.ts` does, and
 * for its reason: the manifest is the only list that cannot silently disagree with what the game
 * deals. Standard action cards (Convert Plants, Convert Heat) are included; they are `IActionCard`s
 * by the same test.
 */
export function actionCardNames(): ReadonlySet<CardName> {
  const names = new Set<CardName>();
  for (const manifest of IN_SCOPE_MANIFESTS) {
    for (const section of CENSUS_SECTIONS) {
      const cardManifest = (manifest as unknown as Record<CensusSection, CardManifest<ICard>>)[section];
      if (cardManifest === undefined) {
        continue;
      }
      for (const [cardName, factory] of CardManifest.entries(cardManifest)) {
        if (factory.instantiate === false || !isCompatibleWith(factory, NADIA_GAME_OPTIONS)) {
          continue;
        }
        if (isIActionCard(new factory.Factory())) {
          names.add(cardName);
        }
      }
    }
  }
  return names;
}

const IN_SCOPE_MANIFESTS: ReadonlyArray<ModuleManifest> = [
  BASE_CARD_MANIFEST, CORP_ERA_CARD_MANIFEST, PRELUDE_CARD_MANIFEST,
];

const CENSUS_SECTIONS: ReadonlyArray<CensusSection> = [
  'projectCards', 'corporationCards', 'preludeCards', 'standardProjects', 'standardActions',
];

/**
 * The standard projects the Engine offers through the standard-project **menu**, i.e. the ones a
 * `{type: 'projectCard'}` response can name. Read from the Engine's own `GameCards` under Nadia's
 * fixed options rather than from a committed list, so it cannot drift from what the games play.
 *
 * Sell Patents is excluded here even though `GameCards` returns it, because `Game.getStandardProjects`
 * filters it out of the menu - see the module doc. That exclusion is the cross-check's known blind
 * spot and is stated in the returned comparison rather than left implicit.
 */
export function menuStandardProjectNames(): ReadonlySet<CardName> {
  const names = new GameCards(NADIA_GAME_OPTIONS).getStandardProjects()
    .map((card) => card.name)
    .filter((name) => name !== CardName.SELL_PATENTS_STANDARD_PROJECT);
  return new Set(names);
}

/**
 * Every standard project named by a `projectCard` response in this game's recorded decisions -
 * the {@link CoverageObserver}-independent derivation §3.7's `moves` tier makes possible.
 *
 * Walks responses structurally rather than switching on `decisionType`, because the decision a
 * standard project is chosen at is a top-level `'or'` and the `projectCard` response is nested
 * inside it (an `'and'`, in the payment case, nests further). A structural walk needs to know
 * nothing about the decision tree's shape, which is the property that makes this a *cross-check*
 * rather than a second copy of the same assumption.
 */
export function standardProjectsFromMoves(
  decisions: ReadonlyArray<RecordedDecision>,
  menu: ReadonlySet<CardName> = menuStandardProjectNames(),
): ReadonlyArray<CardName> {
  const found = new Set<CardName>();
  for (const decision of decisions) {
    if (decision.accepted !== undefined) {
      collectProjectCardNames(decision.accepted, menu, found);
    }
  }
  return [...found].sort();
}

function collectProjectCardNames(value: unknown, menu: ReadonlySet<CardName>, into: Set<CardName>): void {
  if (Array.isArray(value)) {
    for (const element of value) {
      collectProjectCardNames(element, menu, into);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'projectCard' && typeof record.card === 'string' && menu.has(record.card as CardName)) {
    into.add(record.card as CardName);
  }
  for (const nested of Object.values(record)) {
    collectProjectCardNames(nested, menu, into);
  }
}

/**
 * The cross-check itself: what the observer saw against what the move list says, over the five
 * standard projects the move list can see.
 *
 * **A disagreement is a finding about the instrument, not about the game**, and it is reported per
 * game rather than aggregated, because "which game" is the first question about it.
 */
export type CoverageCrossCheck = {
  /** Menu standard projects the observer recorded and the move list does not name. */
  observerOnly: ReadonlyArray<CardName>;
  /** Menu standard projects the move list names and the observer did not record. */
  movesOnly: ReadonlyArray<CardName>;
};

export function crossCheckStandardProjects(
  observed: ReadonlyArray<CardName>,
  fromMoves: ReadonlyArray<CardName>,
  menu: ReadonlySet<CardName> = menuStandardProjectNames(),
): CoverageCrossCheck {
  const observedMenu = new Set(observed.filter((name) => menu.has(name)));
  const movesSet = new Set(fromMoves);
  return {
    observerOnly: [...observedMenu].filter((name) => !movesSet.has(name)).sort(),
    movesOnly: [...movesSet].filter((name) => !observedMenu.has(name)).sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// Building a pinned entry
// ---------------------------------------------------------------------------------------------

/**
 * The identity of a game in the survey, before anything is decided about pinning it. The five-tuple
 * of hazard H4 plus who sat where - `seating` is derived from the pairing schedule rather than
 * carried, so a surveyed game and its pinned entry cannot disagree about it.
 */
export function identityFor(spec: {
  agent: string;
  players: 2 | 3 | 4;
  groupIndex: number;
  permutationIndex: number;
  lineup: ReadonlyArray<string>;
}): RegressionEntryIdentity {
  const seating = permutationsFor(spec.players)[spec.permutationIndex];
  if (seating === undefined) {
    throw new Error(
      `permutation ${spec.permutationIndex} does not exist at ${spec.players}p ` +
      `(${permutationsFor(spec.players).length} per group) - see match/pairing.ts §4.1.`);
  }
  return {
    agent: spec.agent,
    agentVersion: lookupAgent(spec.agent).version,
    players: spec.players,
    groupIndex: spec.groupIndex,
    permutationIndex: spec.permutationIndex,
    lineup: spec.lineup,
    seating,
  };
}

/**
 * Plays a selected game once more, **with diagnostics on**, and returns the committed entry.
 *
 * The second play is not waste. A survey game is played to find out what it covers, over hundreds of
 * games, and holding a full trace for every one of them would cost ~296 steps per game for games that
 * will never be pinned (`ReplayOptions.diagnostics`' own reason for defaulting off). The trace
 * checkpoints an entry carries are what make `--explain`'s first-divergence localization possible at
 * all (`regression/types.ts`'s `traceCheckpoints`), so they have to be captured for the selected set
 * - and only for it.
 *
 * The survey plays through `playMatchGame` and this plays through `playRegressionEntry`. Those are
 * the same game, which is not an assumption: `test/regression/corpus.spec.ts` plays one config both
 * ways for each frozen baseline and asserts the semantics are identical, the fork service included.
 */
export function buildPinnedEntry(
  identity: RegressionEntryIdentity,
  coverage: RegressionEntryCoverage,
  why: string,
): L2GameEntry {
  if (why.trim() === '') {
    throw new Error(
      `${entryKey(identity)}: a pinned entry needs a 'why' - one sentence naming what it covers (§3.3). ` +
      'It is what stops a future session deleting a game it does not understand.');
  }
  const played = playRegressionEntry(identity, {diagnostics: true});
  return {
    layer: 'l2',
    identity,
    fingerprints: played.fingerprints,
    semantics: played.semantics,
    coverage,
    why,
  };
}

/** Every response in a recorded decision list, for callers that want the raw moves before they go. */
export function acceptedResponses(decisions: ReadonlyArray<RecordedDecision>): ReadonlyArray<InputResponse> {
  return decisions
    .map((decision) => decision.accepted)
    .filter((response): response is InputResponse => response !== undefined);
}
