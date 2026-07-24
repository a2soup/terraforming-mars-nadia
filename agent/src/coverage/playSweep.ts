import * as fs from 'fs';
import {CardName} from '@/common/cards/CardName';
import {CardType} from '@/common/cards/CardType';
import {Phase} from '@/common/Phase';
import {Player} from '@/server/Player';
import {StandardProjectCard} from '@/server/cards/StandardProjectCard';
import {StandardActionCard} from '@/server/cards/StandardActionCard';
import {IPlayer} from '@/server/IPlayer';
import {Payment} from '@/common/inputs/Payment';
import {ICorporationCard} from '@/server/cards/corporation/ICorporationCard';
import {createGame} from '../engine/gameFactory';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {createAgentRandom} from '../core/rng';
import {runGame} from '../driver/embeddedDriver';
import {errorClassName} from '../legality/causes';
import {Census, PlayCoverage, PlayCoverageEntry} from './types';

/**
 * K4, the play sweep (Milestone1_Bullet7_Prompts.md, Phase M section 4). What Nadia's own stack -
 * enumerator, driver, Engine together - actually exercised end to end, as opposed to what the
 * Engine's own test suite exercises (Phase I).
 *
 * **"Played" is the definitional word (mirrors AC-1's "an illegal move is a move submitted and
 * rejected").** A card is played when the Engine *executes* the play, i.e. the exact moment
 * `Player.playCard`/`Player.playCorporationCard` run, or a standard project/action's own execution
 * chokepoint runs. A card that was drawn, bought, discarded unplayed, or offered and declined is
 * never observed here.
 *
 * **Why four chokepoints instead of one state read.** The spec's suggested simpler alternative -
 * read `player.playedCards`/`player.corporations` at game end - has two gaps, one real for this
 * bullet's in-scope set and one not: (1) `Player.playCard` explicitly excludes `CardName.LAW_SUIT`
 * and `CardName.PRIVATE_INVESTIGATOR` from ever entering `playedCards` even when legitimately
 * played (`Player.ts`, the `cardAction === 'add'` branch's name check) - checked and **neither
 * card is in-scope** (`LAW_SUIT` is Promo-only, `PRIVATE_INVESTIGATOR` is Underworld-only, both off
 * in `NADIA_GAME_OPTIONS`), so this particular gap doesn't bite today, but a state read would have
 * silently undercounted them if it ever did; (2) standard projects and standard actions are never
 * added to `playedCards` at all (`StandardProjectCard.actionEssence`/`StandardActionCard.action`
 * only mutate production/resources and place tiles - they never call `playCard`), which **is** a
 * real, in-scope gap: K4 could not cover `standardProjects`/`standardActions` through a state read
 * no matter how carefully discarded cards were accounted for. Wrapping the Engine's own execution
 * chokepoints - the same "observe from the outside" technique bullets 5/6 used for the Executor and
 * the driver - covers all five census sections uniformly and sidesteps both gaps regardless. The
 * corollary hazard this trades away (a card entering `playedCards` and later leaving it, e.g.
 * discarded) does not apply here, since the count is taken at the moment of play, not by reading
 * final state.
 *
 * `payAndExecute`/`actionUsed` are the two chokepoints {@link resolveStandardProjectAndAction}
 * verified are unique per Card System module (`grep payAndExecute`/`actionUsed` usage,
 * `src/server/inputs/SelectStandardProjectToPlay.ts` and
 * `src/server/cards/base/standardActions/{ConvertPlants,ConvertHeat}.ts`).
 */

export type PlaySweepConfig = {
  players: 2 | 3 | 4;
  engineSeed: number;
  agentSeed: number;
};

/** Fresh seed space, distinct from determinism (base 500,000/stride 977) and legality (700,000/1,009 engine, 3,100,007/2,311 agent) - see seeds.ts docs in those modules for why independence matters. */
export const SWEEP_ENGINE_SEED_BASE = 9_000_011;
export const SWEEP_ENGINE_SEED_STRIDE = 1_301;
export const SWEEP_AGENT_SEED_BASE = 13_000_003;
export const SWEEP_AGENT_SEED_STRIDE = 2_663;

/** ≥1,000 games at the AC-1 composition (K4's pre-committed sample), documented and reproducible. */
export const DEFAULT_SWEEP_COMPOSITION: ReadonlyArray<{players: 2 | 3 | 4; games: number}> = [
  {players: 2, games: 1000},
  {players: 3, games: 250},
  {players: 4, games: 250},
];

export function buildSweepConfigs(
  composition: ReadonlyArray<{players: 2 | 3 | 4; games: number}> = DEFAULT_SWEEP_COMPOSITION,
): ReadonlyArray<PlaySweepConfig> {
  const configs: Array<PlaySweepConfig> = [];
  let index = 0;
  for (const {players, games} of composition) {
    for (let i = 0; i < games; i++) {
      configs.push({
        players,
        engineSeed: SWEEP_ENGINE_SEED_BASE + index * SWEEP_ENGINE_SEED_STRIDE,
        agentSeed: SWEEP_AGENT_SEED_BASE + index * SWEEP_AGENT_SEED_STRIDE,
      });
      index++;
    }
  }
  return configs;
}

export type PlayObservation = {timesObserved: number; gamesObserved: number};

/** Wraps the four Engine chokepoints described in this module's doc comment, from the outside. Never edits `src/`. */
class PlayObserver {
  private originalPlayCard?: typeof Player.prototype.playCard;
  private originalPlayCorporationCard?: (this: Player, card: ICorporationCard) => void;
  private originalPayAndExecute?: (this: StandardProjectCard, player: IPlayer, payment: Payment) => void;
  private originalActionUsed?: (this: StandardActionCard, player: IPlayer) => void;

  private readonly counts = new Map<CardName, PlayObservation>();
  private seenThisGame = new Set<CardName>();

  public install(): void {
    if (this.originalPlayCard !== undefined) return;

    const observer = this;

    this.originalPlayCard = Player.prototype.playCard;
    Player.prototype.playCard = function(this: Player, card, payment, cardAction) {
      if (card.type !== CardType.PROXY) {
        observer.record(card.name);
      }
      return observer.originalPlayCard!.call(this, card, payment, cardAction);
    };

    this.originalPlayCorporationCard = Player.prototype.playCorporationCard;
    Player.prototype.playCorporationCard = function(this: Player, card: ICorporationCard) {
      observer.record(card.name);
      return observer.originalPlayCorporationCard!.call(this, card);
    } as typeof Player.prototype.playCorporationCard;

    this.originalPayAndExecute = StandardProjectCard.prototype.payAndExecute;
    StandardProjectCard.prototype.payAndExecute = function(this: StandardProjectCard, player: IPlayer, payment: Payment) {
      observer.record(this.name);
      return observer.originalPayAndExecute!.call(this, player, payment);
    };

    this.originalActionUsed = (StandardActionCard.prototype as unknown as {actionUsed: (player: IPlayer) => void}).actionUsed;
    (StandardActionCard.prototype as unknown as {actionUsed: (player: IPlayer) => void}).actionUsed = function(this: StandardActionCard, player: IPlayer) {
      observer.record(this.name);
      return observer.originalActionUsed!.call(this, player);
    };
  }

  public uninstall(): void {
    if (this.originalPlayCard !== undefined) {
      Player.prototype.playCard = this.originalPlayCard;
      this.originalPlayCard = undefined;
    }
    if (this.originalPlayCorporationCard !== undefined) {
      Player.prototype.playCorporationCard = this.originalPlayCorporationCard;
      this.originalPlayCorporationCard = undefined;
    }
    if (this.originalPayAndExecute !== undefined) {
      StandardProjectCard.prototype.payAndExecute = this.originalPayAndExecute;
      this.originalPayAndExecute = undefined;
    }
    if (this.originalActionUsed !== undefined) {
      (StandardActionCard.prototype as unknown as {actionUsed: (player: IPlayer) => void}).actionUsed = this.originalActionUsed;
      this.originalActionUsed = undefined;
    }
  }

  public startGame(): void {
    this.seenThisGame = new Set();
  }

  private record(name: CardName): void {
    const entry = this.counts.get(name) ?? {timesObserved: 0, gamesObserved: 0};
    entry.timesObserved++;
    if (!this.seenThisGame.has(name)) {
      entry.gamesObserved++;
      this.seenThisGame.add(name);
    }
    this.counts.set(name, entry);
  }

  public get observations(): ReadonlyMap<CardName, PlayObservation> {
    return this.counts;
  }
}

export type PlaySweepGameFailure = {config: PlaySweepConfig; errorClass: string; message: string};

export type PlaySweepResult = {
  gamesRun: number;
  gamesCompleted: number;
  failures: ReadonlyArray<PlaySweepGameFailure>;
  observations: ReadonlyMap<CardName, PlayObservation>;
};

export type PlaySweepOptions = {
  onProgress?: (completed: number, total: number) => void;
  yieldEvery?: number;
};

/**
 * Runs `configs` end to end with the random-legal agent (the same driver/enumerator stack every
 * other Milestone-1 bullet verified), recording every project card, corporation, prelude, standard
 * project and standard action actually played/used. A failing game is recorded and does not abort
 * the sweep - same rationale as `legality/run.ts`: the diagnostic value of the remaining games is
 * worth more than stopping at the first crash, and K4 is a recorded (non-blocking) criterion.
 */
export async function runPlaySweep(
  configs: ReadonlyArray<PlaySweepConfig>,
  options: PlaySweepOptions = {},
): Promise<PlaySweepResult> {
  ensureHeadlessEngine();
  const yieldEvery = options.yieldEvery ?? 1;

  const observer = new PlayObserver();
  observer.install();

  const failures: Array<PlaySweepGameFailure> = [];
  let gamesCompleted = 0;

  try {
    for (const [index, config] of configs.entries()) {
      observer.startGame();
      try {
        const game = createGame({players: config.players, seed: config.engineSeed});
        const agent = randomLegalAgent(createAgentRandom(config.agentSeed));
        const result = runGame(game, agent);
        if (game.phase === Phase.END && result !== undefined) {
          gamesCompleted++;
        } else {
          failures.push({config, errorClass: 'IncompleteGame', message: `Game ended in phase ${game.phase}, not Phase.END.`});
        }
      } catch (error) {
        failures.push({config, errorClass: errorClassName(error), message: error instanceof Error ? error.message : String(error)});
      }

      options.onProgress?.(index + 1, configs.length);
      if ((index + 1) % yieldEvery === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    observer.uninstall();
  }

  return {
    gamesRun: configs.length,
    gamesCompleted,
    failures,
    observations: observer.observations,
  };
}

/**
 * Phase M section 5: joins the sweep's raw observations onto the census by `CardName`, producing
 * one {@link PlayCoverageEntry} per in-scope entry (0 observations included - K4 needs to see the
 * unplayed tail, not just the played set) plus the list of `unreachable-in-config` entries that
 * were nevertheless observed, which is a finding about the census (fix it and say so), not the
 * card - see this module's own doc comment and Phase M section 5.
 */
export function reconcilePlayCoverage(
  census: Census,
  sweep: PlaySweepResult,
  composition: ReadonlyArray<{players: 2 | 3 | 4; games: number}>,
): PlayCoverage {
  const entries: Array<PlayCoverageEntry> = census.entries.map((censusEntry) => {
    const observed = sweep.observations.get(censusEntry.name);
    return {
      name: censusEntry.name,
      section: censusEntry.section,
      scope: censusEntry.scope,
      timesObserved: observed?.timesObserved ?? 0,
      gamesObserved: observed?.gamesObserved ?? 0,
    };
  });

  const unexpectedlyPlayed = entries
    .filter((e) => e.scope === 'unreachable-in-config' && e.timesObserved > 0)
    .map((e) => e.name);

  return {
    header: {
      ...census.header,
      composition,
      gamesRun: sweep.gamesRun,
      gamesCompleted: sweep.gamesCompleted,
    },
    entries,
    unexpectedlyPlayed,
  };
}

export function savePlayCoverage(filePath: string, coverage: PlayCoverage): void {
  fs.writeFileSync(filePath, JSON.stringify(coverage, null, 2) + '\n');
}

export function loadPlayCoverage(filePath: string): PlayCoverage {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as PlayCoverage;
}
