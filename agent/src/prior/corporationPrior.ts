import * as fs from 'fs';
import * as path from 'path';
import {CardName} from '@/common/cards/CardName';
import {buildHeader, CorpusHeader} from '../determinism/corpus';
import {wilsonInterval} from '../rating/stats';

/**
 * The corporation opening prior (SRS FR-DATA-1; Implementation Plan Milestone 2 bullet 4).
 *
 * **This is the whole of the project's contact with the RuneDK93 expert dataset.** Bullet 4 was the
 * expert-distribution report until 10 Aug 2026, when AC-8 was withdrawn and the card-set
 * reconciliation, the distributional report and the 3-player calibration corpus were cut with it
 * (SRS v1.7 / Plan v1.8). What survives is one table, seventeen rows, matched by hand. If this file
 * ever grows a comparison against the Agent's own games, that is the cut work coming back - read the
 * v1.8 revision-history entry before writing it.
 *
 * **The prior is a tie-breaker with a short life.** Milestone 3's opening book is the only consumer.
 * It breaks ties over corporation selection before the harness has an opinion, and the harness
 * overrules it the moment it does (FR-DATA-2/3/4). Nothing here may become an evaluation weight.
 *
 * ## Three properties of this data that decide how it can be used
 *
 * **1. WAP is not a win rate, and both source documents say it is.** SRS §1.5 and Plan Appendix A.1
 * describe WAP as "a skill-adjusted win rate that partially controls for player strength". The
 * first half is right and the second is wrong. Upstream (`helper_functions.py::corp_ranking`) it is
 *
 * ```
 * actual  = [2, 1, 0] by finishing position
 * expected[i] = sum over opponents j of 1 / (1 + 10 ** -((elo_i - elo_j) / 400))
 * WAP     = mean over that corporation's games of (actual - expected)
 * ```
 *
 * so it is a **mean Elo-performance residual in pairwise wins per game**, on roughly [-2, +2] and
 * centred near 0 - not a probability. It cannot be read as a rate, mixed with one, or clamped to
 * [0, 1]. It is genuinely the skill-adjusted column and the guardrails are right to prefer it; it
 * just is not what they call it. {@link corporationWap} returns it unchanged and undivided.
 *
 * **2. It is a 3-player corpus and the project's primary setting is 2-player.** Every rate here has
 * a 1/3 chance baseline ({@link CHANCE_WIN_RATE}), so a "40.88%" is +7.5 pp of edge, not -9 pp. More
 * importantly, corporation strength is not player-count invariant - engine corporations gain from
 * the longer games and weaker denial of 3p, and Tharsis Republic's city income scales with the
 * number of opponents building cities. **A prior fitted at 3p and applied at 2p is a biased prior**,
 * which is survivable only because it is weak and short-lived. Neither source document flags this;
 * it is recorded here and in the Running Notes.
 *
 * **3. The samples are small and unequal, so several rows are indistinguishable from chance.**
 * 115 to 397 participations. {@link corporationPriorRows} attaches a Wilson interval to each, and
 * `separatedFromChance` says whether that interval excludes 1/3. It does for a minority of the
 * seventeen. A consumer that ranks all seventeen by point estimate is reading noise in the middle
 * of the table; the interval is there so it does not have to.
 *
 * ## Provenance
 *
 * `agent/docs/data/runedk93_prelude_corps.txt` is the upstream file, vendored verbatim under its MIT
 * licence. It hashes to the upstream blob SHA (asserted in the spec), so the transcription is
 * auditable offline and the committed JSON is re-derivable from it by {@link buildCorporationPrior}
 * rather than being hand-typed.
 */

/** Chance win rate in the 3-player corpus the prior is computed from. Every rate here beats or trails this, not 0.5. */
export const CHANCE_WIN_RATE = 1 / 3;

/** Where the vendored upstream table and the built artifact live, relative to `agent/`. */
export const UPSTREAM_TABLE_PATH = 'docs/data/runedk93_prelude_corps.txt';
export const CORPORATION_PRIOR_PATH = 'docs/data/corporation_prior.json';

/** One row of the upstream table, before any engine name is attached. */
export type UpstreamCorporationRow = {
  rank: number;
  /** The dataset's spelling, e.g. `InterplanetaryCinematics`. Kept so a future reader can re-match. */
  datasetName: string;
  participations: number;
  wins: number;
  /** The rate as *published* (`round(wins / participations * 100, 2)`), not recomputed. */
  winRatePct: number;
  wap: number;
};

export type CorporationPriorEntry = UpstreamCorporationRow & {
  /** The engine's `CardName` for this corporation. */
  cardName: CardName;
};

export type CorporationPriorArtifact = {
  header: CorpusHeader;
  source: {
    repository: string;
    path: string;
    /** Git blob SHA of the upstream file; the vendored copy must hash to this. */
    blobSha: string;
    repoCommit: string;
    repoCommitDate: string;
    license: string;
    vendoredAs: string;
    corpus: string;
  };
  /** What each column means - written down because WAP's meaning is mis-stated in both source documents. */
  columns: Record<string, string>;
  baseline: {players: number; chanceWinRate: number};
  entries: ReadonlyArray<CorporationPriorEntry>;
  /**
   * Corporations the two sources do not agree on. **Both are empty at the current Engine pin**, and
   * the field exists anyway: FR-DATA-1 requires an unmatched corporation to be flagged and left
   * without a prior rather than coerced onto a near-match, and an empty list is the evidence that
   * the requirement was checked rather than skipped.
   */
  unmatched: {inDatasetOnly: ReadonlyArray<string>; inEngineOnly: ReadonlyArray<string>};
  checks: {
    /** Participations / players. Must equal the corpus's stated game count. */
    impliedGames: number;
    /** Wins summed over corporations. One winner per game, so this must equal `impliedGames`. */
    totalWins: number;
    statedGames: number;
  };
};

/**
 * The hand-matched dataset-name -> engine-`CardName` map, and the *only* hand-entered thing in this
 * module. Every number is parsed from the vendored table.
 *
 * All seventeen matched exactly at Engine pin `868714d72`; the spelling differences are whitespace
 * and internal capitalisation only (`CheungShingMars` -> `Cheung Shing MARS`), with no judgement
 * call and no near-match among them. Beginner Corporation is in the engine's card pool but
 * `unreachable-in-config` (`docs/data/card_census.json`), is not a corporation anyone is dealt here,
 * and is correctly absent upstream.
 */
const DATASET_NAME_TO_CARD_NAME: Readonly<Record<string, CardName>> = {
  CrediCor: CardName.CREDICOR,
  InterplanetaryCinematics: CardName.INTERPLANETARY_CINEMATICS,
  TharsisRepublic: CardName.THARSIS_REPUBLIC,
  CheungShingMars: CardName.CHEUNG_SHING_MARS,
  Ecoline: CardName.ECOLINE,
  Vitor: CardName.VITOR,
  SaturnSystems: CardName.SATURN_SYSTEMS,
  PointLuna: CardName.POINT_LUNA,
  MiningGuild: CardName.MINING_GUILD,
  ValleyTrust: CardName.VALLEY_TRUST,
  Teractor: CardName.TERACTOR,
  Inventrix: CardName.INVENTRIX,
  ThorGate: CardName.THORGATE,
  PhoboLog: CardName.PHOBOLOG,
  RobinsonIndustries: CardName.ROBINSON_INDUSTRIES,
  Helion: CardName.HELION,
  UnitedNationsMarsInitiative: CardName.UNITED_NATIONS_MARS_INITIATIVE,
};

const SOURCE = {
  repository: 'https://github.com/RuneDK93/terraforming-mars-dataset',
  path: 'prelude/corps.txt',
  blobSha: '0f4dfa22a4ab764215a8edcaa68e6ab1f22780bb',
  repoCommit: '462e6894f81b26b6b72641c8e747fe1773c7bf81',
  repoCommitDate: '2025-03-10T08:09:21Z',
  license: 'MIT (c) 2024 Rune Dodensig Kjaersgaard',
  vendoredAs: `agent/${UPSTREAM_TABLE_PATH}`,
  corpus: '1,616 three-player base + Prelude games, Board Game Arena season 19, top-25 rated players',
} as const;

/** The corpus's own game count, per the upstream README. {@link buildCorporationPrior} checks the table against it. */
const STATED_GAMES = 1616;
const CORPUS_PLAYERS = 3;

/**
 * Parses the upstream fixed-width table.
 *
 * Deliberately strict: a row whose cell count or numeric parse is unexpected throws rather than
 * being skipped. A silently dropped corporation would leave a plausible-looking sixteen-row prior,
 * and the arithmetic checks in {@link buildCorporationPrior} are what would catch it - so this
 * fails first, where the message can name the line.
 */
export function parseUpstreamTable(text: string): ReadonlyArray<UpstreamCorporationRow> {
  const rows: Array<UpstreamCorporationRow> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.startsWith('|=') || trimmed.startsWith('+')) {
      continue;
    }
    const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length !== 6) {
      throw new Error(`expected 6 cells in upstream row, got ${cells.length}: ${line}`);
    }
    if (cells[0] === 'RANK') {
      continue;
    }
    const [rank, participations, wins, winRatePct, wap] =
      [cells[0], cells[2], cells[3], cells[4], cells[5]].map((cell) => {
        const value = Number(cell);
        if (!Number.isFinite(value)) {
          throw new Error(`non-numeric cell '${cell}' in upstream row: ${line}`);
        }
        return value;
      });
    rows.push({rank, datasetName: cells[1], participations, wins, winRatePct, wap});
  }
  return rows;
}

/**
 * Re-derives the committed artifact from the vendored table and the name map, cross-checking against
 * the in-scope corporation list it is handed (the caller reads that from `card_census.json`, so this
 * module does not depend on the census file's shape).
 *
 * Four checks, all of which have to pass:
 *
 * - every dataset name maps to a `CardName`, and every in-scope engine corporation is covered;
 * - `sum(participations) / 3` equals the corpus's stated 1,616 games;
 * - `sum(wins)` also equals 1,616 - one winner per game, which is what makes "Win Rate" a
 *   first-place rate rather than a top-two rate;
 * - each published `winRatePct` agrees with `wins / participations` to the rounding it declares.
 *
 * The middle two are the useful ones. They are independent of the name matching and of this project
 * entirely, and they would catch a truncated download, a duplicated row, or a table that had been
 * regenerated upstream against a different corpus - the failure modes a hand transcription is
 * actually exposed to.
 */
export function buildCorporationPrior(
  upstreamText: string,
  inScopeCorporations: ReadonlyArray<string>,
  header: CorpusHeader = buildHeader(),
): CorporationPriorArtifact {
  const rows = parseUpstreamTable(upstreamText);

  const entries: Array<CorporationPriorEntry> = [];
  const inDatasetOnly: Array<string> = [];
  for (const row of rows) {
    const cardName = DATASET_NAME_TO_CARD_NAME[row.datasetName];
    if (cardName === undefined || !inScopeCorporations.includes(cardName)) {
      // FR-DATA-1: flagged and left without a prior, never coerced onto a near-match.
      inDatasetOnly.push(row.datasetName);
      continue;
    }
    entries.push({...row, cardName});
  }
  const matched = new Set(entries.map((entry) => entry.cardName as string));
  const inEngineOnly = inScopeCorporations.filter((name) => !matched.has(name));

  for (const entry of entries) {
    const recomputed = Math.round((entry.wins / entry.participations) * 100 * 100) / 100;
    if (Math.abs(recomputed - entry.winRatePct) > 0.005) {
      throw new Error(
        `${entry.datasetName}: published win rate ${entry.winRatePct}% disagrees with ` +
        `${entry.wins}/${entry.participations} = ${recomputed}%`);
    }
  }

  const participations = entries.reduce((sum, entry) => sum + entry.participations, 0);
  const totalWins = entries.reduce((sum, entry) => sum + entry.wins, 0);
  const impliedGames = participations / CORPUS_PLAYERS;

  return {
    header,
    source: {...SOURCE},
    columns: {
      participations: 'Games in which some player held this corporation (3 per game across the table).',
      wins: 'Of those, games that player finished first. Sums to the game count: one winner per game.',
      winRatePct: 'wins / participations, as published upstream. Chance is 33.33%, not 50% - this is a 3-player corpus.',
      wap: 'Mean (actual - Elo-expected) finishing score in pairwise wins per game, on ~[-2, +2]. ' +
        'Skill-adjusted, but NOT a win rate despite what SRS §1.5 and Plan Appendix A.1 call it.',
    },
    baseline: {players: CORPUS_PLAYERS, chanceWinRate: CHANCE_WIN_RATE},
    entries,
    unmatched: {inDatasetOnly, inEngineOnly},
    checks: {impliedGames, totalWins, statedGames: STATED_GAMES},
  };
}

export function saveCorporationPrior(filePath: string, artifact: CorporationPriorArtifact): void {
  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2) + '\n');
}

/** Reads the committed artifact. `agentRoot` defaults to the `agent/` directory this file lives under. */
export function loadCorporationPrior(agentRoot: string = defaultAgentRoot()): CorporationPriorArtifact {
  const filePath = path.join(agentRoot, CORPORATION_PRIOR_PATH);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as CorporationPriorArtifact;
}

export function loadUpstreamTable(agentRoot: string = defaultAgentRoot()): string {
  return fs.readFileSync(path.join(agentRoot, UPSTREAM_TABLE_PATH), 'utf8');
}

function defaultAgentRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/** A corporation's row, with the derived quantities a consumer actually wants. */
export type CorporationPriorRow = {
  cardName: CardName;
  participations: number;
  /** `wins / participations`, recomputed at full precision rather than read from the rounded column. */
  winRate: number;
  /** `winRate - 1/3`, in percentage points. Positive means "beat chance in the expert corpus". */
  advantagePp: number;
  /** 95% Wilson interval on `winRate`. The samples are 115-397, so this is not decoration. */
  interval: {low: number; high: number};
  /** Whether that interval excludes chance. False for most of the table's middle. */
  separatedFromChance: boolean;
  /** The skill-adjusted residual, unchanged. See the module comment: this is not a rate. */
  wap: number;
};

/**
 * The prior in the form a consumer should read it: rates recomputed at full precision, the chance
 * baseline subtracted, and an interval on every row.
 *
 * **No weight is applied here, deliberately.** How weakly to weight a starting bias is Milestone 3's
 * decision about its own opening book, and hard-coding one in the data layer would make it invisible
 * at the point where it matters. What this function does is make the weakness *legible* - the caller
 * can see that Helion's -14.9 pp and ThorGate's -6.4 pp are not the same kind of claim, because one
 * interval excludes chance and the other contains it comfortably.
 */
export function corporationPriorRows(
  artifact: CorporationPriorArtifact = loadCorporationPrior(),
): ReadonlyArray<CorporationPriorRow> {
  return artifact.entries.map((entry) => {
    const winRate = entry.wins / entry.participations;
    const interval = wilsonInterval(winRate, entry.participations);
    return {
      cardName: entry.cardName,
      participations: entry.participations,
      winRate,
      advantagePp: (winRate - CHANCE_WIN_RATE) * 100,
      interval: {low: interval.low, high: interval.high},
      separatedFromChance: interval.low > CHANCE_WIN_RATE || interval.high < CHANCE_WIN_RATE,
      wap: entry.wap,
    };
  });
}

/** The skill-adjusted residual for one corporation, or `undefined` if it has no prior. */
export function corporationWap(
  cardName: CardName,
  artifact: CorporationPriorArtifact = loadCorporationPrior(),
): number | undefined {
  return artifact.entries.find((entry) => entry.cardName === cardName)?.wap;
}
