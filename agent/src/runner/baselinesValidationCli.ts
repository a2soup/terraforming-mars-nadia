/**
 * **The Milestone 2 bullet 2 validation run** (Unit D of agent/docs/Milestone2_Bullet2_Prompts.md).
 *
 * Produces the evidence for criteria G1-G9, which were pre-committed in §5 of that plan *before any
 * measurement code existed*. This file measures; it does not decide. The adjudication lives in
 * `agent/docs/Baselines.md`, and the numbers it adjudicates come from
 * `agent/docs/data/baselines_validation.json`, which `--phase assemble` writes.
 *
 *   Everything, into the default scratch directory, then assembled:
 *     node build/agent/agent/src/runner/baselinesValidationCli.js --phase all
 *
 *   One phase at a time (the safer way - see "why phases are separate processes" below):
 *     node build/agent/agent/src/runner/baselinesValidationCli.js --phase main --out-dir /tmp/v
 *     node build/agent/agent/src/runner/baselinesValidationCli.js --phase assemble --out-dir /tmp/v --final
 *
 * **Why phases are separate processes, and not merely separate functions.** Three of the mechanisms
 * this run drives are process-global by deliberate design, and none of them nests:
 * `withGreedyDiagnostics` (greedyOnePlyAgent.ts - the registry builds an agent from a seed alone, so
 * a run has no other handle on the agents it created), `runWithSpeculationCounted`
 * (search/speculation.ts), and the legality/history instruments' `Player.prototype.process` wrappers.
 * Running two phases concurrently would interleave their accounting silently. One phase per process
 * is the cheap way to make that structurally impossible rather than merely documented.
 *
 * **Every throughput figure here is suspect on this host, and says so.** `agent/CLAUDE.md` §6 records
 * that the measurement machine was swapping when bullet 1's R7 was attempted and that its
 * single-process baseline swung 4.3x within one session on an identical spec. So each phase records
 * {@link machineState} - free memory and `vm.swapusage` - beside its own timings, and the write-up
 * reports correctness numbers (win rates, legality counters, fork fidelity) as measurements and
 * wall-clock numbers as observations about this host. Hazard H10: `tsx` understates the simulator
 * ~3.5x, so run the compiled `node` form for anything with a clock in it.
 */
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {GreedyStats, summarize, tieBreakFraction, withGreedyDiagnostics} from '../core/greedyOnePlyAgent';
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {defaultOutputDir, loadMatchArtifact, reportsMatch, stripTimingFields} from '../match/artifact';
import {checkMatchNeutrality, compareLegalityAccounting} from '../match/legality';
import {buildMatchConfigs, resolveMatchSpec} from '../match/pairing';
import {runMatch} from '../match/runner';
import {MatchRunReport, MatchSpec} from '../match/types';
import {measureSpeculationGuard} from '../search/forkProbe';

// ---------------------------------------------------------------------------------------------
// The specifications, all pre-committed by §5 and all clear of bullet 1's seed ranges
// ---------------------------------------------------------------------------------------------

/**
 * `startGroup` offsets keep every run below clear of bullet 1's, which used 0, 5_000, 6_000, 7_000
 * and 8_000 (`matchValidationCli.ts`). Sharing a group index would mean sharing an Engine seed, and
 * two criteria adjudicated on overlapping games are less independent than they look.
 */
const MAIN_START = 20_000;
const G4_START = 30_000;
const G6_START = 40_000;
const G2B_START = 50_000;

/** G5 (2p, the headline) and G8 (3p/4p placement). Greedy is always lineup slot 0. */
const MAIN_RUNS: ReadonlyArray<MatchSpec> = [
  {players: 2, lineup: ['greedy-1ply', 'random-legal'], groups: 500, startGroup: MAIN_START},
  {players: 3, lineup: ['greedy-1ply', 'random-legal', 'random-legal'], groups: 100, startGroup: MAIN_START},
  {players: 4, lineup: ['greedy-1ply', 'random-legal', 'random-legal', 'random-legal'], groups: 25, startGroup: MAIN_START},
];

/**
 * G4 - AC-1 for `greedy-1ply@1`: ">= 1,000 consecutive embedded games with `greedy-1ply` in **every
 * seat**, under `--legality`". Greedy in both seats is the point: AC-1 is a claim about this agent's
 * submissions, and a mirror match doubles the greedy decisions per game.
 */
const G4_RUN: MatchSpec = {players: 2, lineup: ['greedy-1ply', 'greedy-1ply'], groups: 500, startGroup: G4_START};

/** G6: ">= 20 groups at 2p and >= 10 at 3p", in-process twice and once in a fresh process. */
const G6_RUNS: ReadonlyArray<MatchSpec> = [
  {players: 2, lineup: ['greedy-1ply', 'random-legal'], groups: 20, startGroup: G6_START},
  {players: 3, lineup: ['greedy-1ply', 'random-legal', 'random-legal'], groups: 10, startGroup: G6_START},
];

/**
 * G2a: "a shared set of >= 50 configs".
 *
 * **The seed schedule is copied verbatim from bullet 1's R8** (`matchValidationCli.ts` `phaseR8`) so
 * this is a genuine before/after on the *same 50 games*, comparable against the committed totals in
 * `docs/data/match_runner_validation.json`. A fresh schedule would produce a self-consistent number
 * that could not detect the thing G2a exists to detect: the §3.2 guard having changed what the
 * instruments count for a non-forking agent.
 */
const G2A_CONFIG_COUNT = 50;
const G2A_NEUTRALITY_GROUPS = 10;
const G2A_ENGINE_SEED_BASE = 31_000_019;
const G2A_ENGINE_SEED_STRIDE = 1_301;
const G2A_AGENT_SEED_BASE = 37_000_003;
const G2A_AGENT_SEED_STRIDE = 2_711;
/** Bullet 1's committed artifact, whose R8 totals are this criterion's regression target. */
const MATCH_RUNNER_ARTIFACT = 'docs/data/match_runner_validation.json';

/** G2b: the negative control. Small on purpose - it plays every specification three times. */
const G2B_RUN: MatchSpec = {players: 2, lineup: ['greedy-1ply', 'greedy-1ply'], groups: 15, startGroup: G2B_START};

/**
 * G3 asks for ">= 5%" of forks compared by the expensive `stableStateOf` half. Set on the agent the
 * runner constructs on our behalf, via `withGreedyDiagnostics`.
 */
const G3_VALIDATE_RATE = 0.05;

/** Unit B's committed G1a/G1c evidence. Read rather than re-run: 200 games took 75 minutes. */
const CANDIDATE_ARTIFACT = 'docs/data/candidate_validation.json';
const DETERMINISM_CORPUS = 'docs/data/determinism_corpus.json';

/**
 * The Appendix's falsifiable predictions, checked on their own sample.
 *
 * A separate run rather than an aggregation folded into `main` because the two answer different
 * questions and `main`'s 1,000 games are not needed here: these are *rate* comparisons between two
 * agents playing the same games, and 200 games settles them. Its own `startGroup` keeps it from
 * re-using `main`'s Engine seeds, so a prediction is not confirmed by the very games that produced
 * the win rate it is supposed to explain.
 */
const PREDICTIONS_RUN: MatchSpec = {players: 2, lineup: ['greedy-1ply', 'random-legal'], groups: 100, startGroup: 60_000};

type PhaseName = 'g1' | 'main' | 'g4' | 'g6' | 'g2a' | 'g2b' | 'predictions';

const PHASES: ReadonlyArray<PhaseName> = ['g1', 'main', 'g4', 'g6', 'g2a', 'g2b', 'predictions'];

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

/**
 * G1. Two halves with different provenance, and the difference matters:
 *
 * - **G1a/G1c** were measured by Unit B and committed as `docs/data/candidate_validation.json`
 *   (200 games, 843,871 candidates submitted). That artifact is *read*, not regenerated - it cost 75
 *   minutes, and re-running it would produce a second number to reconcile rather than more evidence.
 * - **G1b** is re-verified here, every time, because it is the criterion most likely to be broken by
 *   work that happened *after* Unit B finished. It shells out to the ordinary `determinism --verify`
 *   entry point rather than calling the corpus API directly, so the check an operator would run and
 *   the check this artifact records are the same check.
 */
function phaseG1(): unknown {
  const artifactPath = path.join(process.cwd(), CANDIDATE_ARTIFACT);
  const candidates = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

  console.log('[validate] G1b: re-verifying the committed determinism corpus (300 configs)');
  const started = Date.now();
  let determinism: Record<string, unknown>;
  try {
    const output = execFileSync(
      process.execPath,
      [determinismCliPath(), '--verify', DETERMINISM_CORPUS],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024},
    );
    const verdict = output.split('\n').filter((line) => line.startsWith('[determinism]'));
    determinism = {exitCode: 0, corpusUnchanged: true, verdict};
  } catch (error) {
    const failure = error as {status?: number; stdout?: string};
    determinism = {
      exitCode: failure.status ?? -1,
      corpusUnchanged: false,
      verdict: (failure.stdout ?? '').split('\n').filter((line) => line.startsWith('[determinism]')),
    };
  }

  return {
    g1a: {
      source: CANDIDATE_ARTIFACT,
      gamesRun: candidates.gamesRun,
      gamesCompleted: candidates.gamesCompleted,
      decisionPoints: candidates.decisionPoints,
      decisionsValidated: candidates.decisionsValidated,
      candidatesGenerated: candidates.candidatesGenerated,
      candidatesSubmitted: candidates.candidatesSubmitted,
      candidatesAccepted: candidates.candidatesAccepted,
      candidatesRejected: candidates.candidatesRejected,
      cappedDecisions: candidates.cappedDecisions,
      emptySets: candidates.emptySets,
      rejections: candidates.rejections,
      forkGaps: candidates.forkGaps,
    },
    g1b: {...determinism, elapsedMs: Date.now() - started},
    g1c: {
      typesWithCandidates: Object.keys(candidates.byType ?? {}),
      unreachedTypes: candidates.unreachedTypes,
      unvalidatedTypes: candidates.unvalidatedTypes,
    },
    machine: machineState(),
  };
}

/**
 * The headline runs: G5 (2p win rate), G8 (3p/4p placement), and - because they ride along on the
 * same games rather than needing their own - G7's diagnostics and G3's fork fidelity.
 *
 * Each run is wrapped in `withGreedyDiagnostics`, which is how the greedy agents the *runner*
 * constructs (from a seed alone, through the registry) hand their counters back.
 */
async function phaseMain(): Promise<unknown> {
  const runs: Array<unknown> = [];
  for (const spec of MAIN_RUNS) {
    const resolved = resolveMatchSpec(spec);
    console.log(`[validate] main: ${resolved.players}p, ${resolved.groups} groups = ${resolved.games} games`);
    const before = machineState();
    const started = Date.now();
    const {value: report, stats, agents} = await withGreedyDiagnostics(
      {validateRate: G3_VALIDATE_RATE},
      () => runMatch(spec, {silenceRoutineLogs: true, onProgress: progress(resolved.games)}),
    );
    runs.push({
      players: resolved.players,
      groups: resolved.groups,
      games: resolved.games,
      wallClockMs: Date.now() - started,
      greedyAgentsConstructed: agents,
      summary: report.summary,
      greedy: describeGreedyStats(stats),
      machineBefore: before,
      machineAfter: machineState(),
    });
  }
  return {runs};
}

/**
 * G4 - the AC-1 legality battery against `greedy-1ply@1`, which `agent/CLAUDE.md` §6's standing
 * caveat makes mandatory for every promoted agent version.
 *
 * Adjudicated on the **strict** counters (`rejectedResponder`, `rejectedFallbackProbe`,
 * `responderThrows`, `submissions`), not on the driver's `onFallback` counts - those cannot see the
 * FR-9 fallback's own rejected `'or'`-branch probes, so a promotion gate reading them is reading the
 * wrong number. `runWithSpeculationCounted` is deliberately **not** used: the whole point is that
 * speculative submissions stay out of this accounting.
 */
async function phaseG4(): Promise<unknown> {
  const resolved = resolveMatchSpec(G4_RUN);
  console.log(`[validate] G4: ${resolved.games} games, greedy in every seat, --legality`);
  const before = machineState();
  const started = Date.now();
  const {value: report, stats} = await withGreedyDiagnostics(
    {validateRate: G3_VALIDATE_RATE},
    () => runMatch(G4_RUN, {
      capture: {historyTier: 'summary', legality: true},
      silenceRoutineLogs: true,
      onProgress: progress(resolved.games),
    }),
  );

  const failed = report.games.filter((game) => game.failure !== undefined);
  return {
    games: resolved.games,
    wallClockMs: Date.now() - started,
    completed: report.games.length - failed.length,
    failures: failed.map((game) => ({
      groupIndex: game.groupIndex,
      permutationIndex: game.permutationIndex,
      engineSeed: game.engineSeed,
      failure: game.failure,
    })),
    legality: report.summary.legality,
    causeTallies: report.instrumentation?.causes ?? [],
    greedy: describeGreedyStats(stats),
    machineBefore: before,
    machineAfter: machineState(),
  };
}

/**
 * G6. Two legs, because "reproducible" means two things and only one is cheap: a second run in the
 * *same* process, and one in a genuinely fresh process. This is R2 restated for an agent that makes
 * random tie-breaks, so it is really a check that the common-random-numbers seeding (§3.4) and the
 * per-seat streams are deterministic rather than merely seeded.
 */
async function phaseG6(): Promise<unknown> {
  const legs: Array<unknown> = [];
  for (const spec of G6_RUNS) {
    const resolved = resolveMatchSpec(spec);
    console.log(`[validate] G6: ${resolved.players}p x ${resolved.groups} groups, in-process and fresh-process`);
    const first = await runMatch(spec, {silenceRoutineLogs: true});
    const second = await runMatch(spec, {silenceRoutineLogs: true});
    const fresh = runInFreshProcess(spec);

    legs.push({
      players: resolved.players,
      groups: resolved.groups,
      games: resolved.games,
      inProcessMatches: reportsMatch(first, second),
      freshProcessMatches: reportsMatch(first, fresh),
      firstDifferingGame: firstRecordDifference(first, fresh),
    });
  }
  return {legs};
}

/**
 * G2a - the fork-safety guard did not change what the legality instruments count.
 *
 * This re-runs bullet 1's **R8** equivalence check, unchanged, with `random-legal@1` and with the
 * §3.2 guard now installed in `submissionMonitor.ts` and `history.ts`. Identical values on all nine
 * adjudicated counters is the criterion; anything else means the guard altered the accounting for a
 * *non-forking* agent, which is the one outcome §3.2 exists to prevent. `checkMatchNeutrality` rides
 * along because it asks the different question of whether instrumenting a game changes the game.
 */
async function phaseG2a(): Promise<unknown> {
  console.log(`[validate] G2a: R8 equivalence over ${G2A_CONFIG_COUNT} shared configs, guard installed`);
  const configs = Array.from({length: G2A_CONFIG_COUNT}, (_unused, index) => ({
    players: 2 as const,
    engineSeed: G2A_ENGINE_SEED_BASE + index * G2A_ENGINE_SEED_STRIDE,
    agentSeed: G2A_AGENT_SEED_BASE + index * G2A_AGENT_SEED_STRIDE,
  }));
  const equivalence = await compareLegalityAccounting(configs);

  // The before/after: bullet 1 adjudicated R8 on these very games, and committed the totals.
  const priorPath = path.join(process.cwd(), MATCH_RUNNER_ARTIFACT);
  const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'))?.r8?.equivalence;
  const priorTotals = prior?.totals as Record<string, number> | undefined;
  const nowTotals = equivalence.totals as unknown as Record<string, number>;
  const drift = priorTotals === undefined ? undefined : Object.fromEntries(
    Object.keys(priorTotals)
      .filter((field) => priorTotals[field] !== nowTotals[field])
      .map((field) => [field, {bullet1: priorTotals[field], now: nowTotals[field]}]),
  );

  console.log('[validate] G2a: instrumentation neutrality on real match games');
  const neutralitySpec = resolveMatchSpec({
    players: 2,
    lineup: ['random-legal', 'random-legal'],
    groups: G2A_NEUTRALITY_GROUPS,
    startGroup: G2B_START + 1_000,
  });
  const neutrality = await checkMatchNeutrality(buildMatchConfigs(neutralitySpec), neutralitySpec);

  return {
    equivalence,
    againstBullet1: {
      source: MATCH_RUNNER_ARTIFACT,
      priorTotals,
      driftedFields: drift,
      unchanged: drift !== undefined && Object.keys(drift).length === 0,
    },
    neutrality,
    machine: machineState(),
  };
}

/**
 * G2b - the negative control, at validation scale.
 *
 * `measureSpeculationGuard` (search/forkProbe.ts) plays one specification three times: guarded, with
 * the guard disarmed, and with `random-legal@1` in the probe's place. A test that cannot show the
 * guard *doing* something has not tested it, which is why this exists as a measurement rather than
 * an assertion that speculative submissions are absent.
 */
async function phaseG2b(): Promise<unknown> {
  const resolved = resolveMatchSpec(G2B_RUN);
  console.log(`[validate] G2b: ${resolved.games} games x 3 accountings (guarded / counted / reference)`);
  const started = Date.now();
  const evidence = await measureSpeculationGuard(G2B_RUN);
  return {...evidence, wallClockMs: Date.now() - started, machine: machineState()};
}

/**
 * The Appendix's seven predictions, recorded before measurement so the plan's own understanding is
 * falsifiable and not merely the code's.
 *
 * Everything here is read from the **match record**, which already carries `claimedMilestones`,
 * `fundedAwards` and a per-seat `vpBreakdown` (bullet 1 designed the schema against exactly this
 * kind of downstream consumer). Nothing is re-derived from the Engine, and no game is replayed.
 *
 * Predictions 1-3 are about *decisions* and are answered by G7's per-type tie-break rates in the
 * `main` block, not here. This phase answers 4-7, which are about *outcomes*.
 */
async function phasePredictions(): Promise<unknown> {
  const resolved = resolveMatchSpec(PREDICTIONS_RUN);
  console.log(`[validate] predictions: ${resolved.games} games, 2p greedy vs random`);
  const {value: report, stats} = await withGreedyDiagnostics(
    {validateRate: 0},
    () => runMatch(PREDICTIONS_RUN, {silenceRoutineLogs: true, onProgress: progress(resolved.games)}),
  );

  // Per *agent*, not per seat: the pairing plays both seatings, so aggregating by seat would mix
  // the two agents together and every rate below would come out at the average of the pair.
  const tally: Record<string, {
    games: number; milestones: number; awards: number;
    greeneryVp: number; cityVp: number; cardVp: number; trTotal: number; vpTotal: number;
    gamesWithAnyCardVp: number; gamesWithAnyMilestone: number;
  }> = {};
  const seen = (agent: string) => (tally[agent] ??= {
    games: 0, milestones: 0, awards: 0,
    greeneryVp: 0, cityVp: 0, cardVp: 0, trTotal: 0, vpTotal: 0,
    gamesWithAnyCardVp: 0, gamesWithAnyMilestone: 0,
  });

  for (const game of report.games) {
    if (!game.completed) {
      continue;
    }
    const agentAtSeat = new Map(game.seats.map((seat) => [seat.seat, seat.agent]));
    for (const seat of game.seats) {
      const row = seen(seat.agent);
      row.games++;
      const outcome = seat.outcome;
      if (outcome === undefined) {
        continue;
      }
      row.greeneryVp += outcome.vpBreakdown.greenery;
      row.cityVp += outcome.vpBreakdown.city;
      row.cardVp += outcome.vpBreakdown.cards;
      row.trTotal += outcome.terraformRating;
      row.vpTotal += outcome.victoryPoints;
      if (outcome.vpBreakdown.cards !== 0) {
        row.gamesWithAnyCardVp++;
      }
    }
    for (const claim of game.claimedMilestones) {
      const agent = agentAtSeat.get(claim.seat);
      if (agent !== undefined) {
        seen(agent).milestones++;
      }
    }
    for (const award of game.fundedAwards) {
      const agent = agentAtSeat.get(award.seat);
      if (agent !== undefined) {
        seen(agent).awards++;
      }
    }
  }

  const perGame = Object.fromEntries(Object.entries(tally).map(([agent, row]) => [agent, {
    games: row.games,
    milestonesPerGame: row.milestones / row.games,
    awardsFundedPerGame: row.awards / row.games,
    greeneryVpPerGame: row.greeneryVp / row.games,
    cityVpPerGame: row.cityVp / row.games,
    cardVpPerGame: row.cardVp / row.games,
    terraformRatingPerGame: row.trTotal / row.games,
    victoryPointsPerGame: row.vpTotal / row.games,
    /** Prediction 7's falsifier: a megacredit tiebreak would have pinned this at 0. */
    fractionOfGamesWithAnyCardVp: row.gamesWithAnyCardVp / row.games,
  }]));

  return {
    games: resolved.games,
    perAgent: perGame,
    summary: report.summary,
    greedy: describeGreedyStats(stats),
    machine: machineState(),
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * The reportable form of {@link GreedyStats}: histograms collapsed to the three-number summaries the
 * write-up carries, and the derived numbers computed once here rather than in prose.
 *
 * `tieBreakFraction` is lifted to the top of the block on purpose - §5's G7 calls it "the single most
 * informative number in the bullet", and a figure buried in a histogram map does not get read.
 */
function describeGreedyStats(stats: GreedyStats): Record<string, unknown> {
  return {
    tieBreakFraction: tieBreakFraction(stats),
    decisions: stats.decisions,
    scored: stats.scored,
    tieBroken: stats.tieBroken,
    singleCandidate: stats.singleCandidate,
    fallbacks: stats.fallbacks,
    fallbacksByReason: stats.fallbacksByReason,
    forkUnavailableByReason: stats.forkUnavailableByReason,
    cappedDecisions: stats.cappedDecisions,
    candidatesScored: stats.candidatesScored,
    candidatesRejected: stats.candidatesRejected,
    drainOverruns: stats.drainOverruns,
    drainFallbacks: stats.drainFallbacks,
    drainBudget: stats.drainBudget,
    candidateCounts: summarize(stats.candidateCounts),
    drainSteps: summarize(stats.drainSteps),
    scoreSpread: summarize(stats.scoreSpread),
    tieSize: summarize(stats.tieSize),
    byType: stats.byType,
    fork: stats.fork,
    /** G3's headline: the fraction of fork attempts that produced a usable fork. */
    forkAvailability: stats.fork.attempts === 0 ?
      undefined :
      (stats.fork.direct + stats.fork.replayed) / stats.fork.attempts,
  };
}

function progress(total: number): (completed: number) => void {
  return (completed: number) => {
    if (completed % 100 === 0) {
      process.stdout.write(`[validate]   ${completed}/${total} games\n`);
    }
  };
}

/** Locates the first game record two reports disagree on, so a G6 failure is diagnosable. */
function firstRecordDifference(a: MatchRunReport, b: MatchRunReport): unknown {
  const strippedA = stripTimingFields(a) as {games: ReadonlyArray<unknown>};
  const strippedB = stripTimingFields(b) as {games: ReadonlyArray<unknown>};
  const length = Math.max(strippedA.games.length, strippedB.games.length);
  for (let i = 0; i < length; i++) {
    const left = JSON.stringify(strippedA.games[i]);
    const right = JSON.stringify(strippedB.games[i]);
    if (left !== right) {
      return {index: i, a: truncate(left), b: truncate(right)};
    }
  }
  return undefined;
}

function truncate(value: string | undefined): string {
  const text = value ?? '<missing>';
  return text.length <= 400 ? text : `${text.slice(0, 400)}...`;
}

function siblingCli(name: string): string {
  return path.join(__dirname, __filename.endsWith('.ts') ? `${name}.ts` : `${name}.js`);
}

function determinismCliPath(): string {
  return siblingCli('determinismCli');
}

/**
 * Plays `spec` in a genuinely fresh process via the ordinary CLI, and loads the artifact it wrote -
 * the same entry point an operator would use, so a CLI-level default that differed would be caught.
 */
function runInFreshProcess(spec: MatchSpec): MatchRunReport {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-baselines-g6-'));
  const outPath = path.join(dir, 'fresh.json');
  try {
    const args = [
      '--players', String(spec.players),
      '--lineup', spec.lineup.join(','),
      '--groups', String(spec.groups),
      '--start-group', String(spec.startGroup ?? 0),
      '--out', outPath,
    ];
    execFileSync(process.execPath, [siblingCli('matchCli'), ...args], {stdio: ['ignore', 'ignore', 'inherit']});
    return loadMatchArtifact(outPath);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

/**
 * A wall-clock figure is only interpretable next to what the host was doing. On this machine that is
 * not a formality: `agent/CLAUDE.md` §6 records a 4.3x single-process swing within one session,
 * caused by swap.
 */
function machineState(): Record<string, unknown> {
  return {
    loadAverage: os.loadavg(),
    freeMemoryBytes: os.freemem(),
    swap: readSwapUsage(),
  };
}

/** macOS-only, and best-effort: a missing swap figure must never fail a validation run. */
function readSwapUsage(): string | undefined {
  try {
    return execFileSync('sysctl', ['-n', 'vm.swapusage'], {encoding: 'utf8'}).trim();
  } catch {
    return undefined;
  }
}

function describeMachine(): Record<string, unknown> {
  return {
    cpuModel: os.cpus()[0]?.model,
    cores: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runtime: __filename.endsWith('.ts') ? 'tsx' : 'compiled',
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function runPhase(phase: PhaseName, outDir: string): Promise<void> {
  const started = Date.now();
  const block = phase === 'g1' ? phaseG1() :
    phase === 'main' ? await phaseMain() :
      phase === 'g4' ? await phaseG4() :
        phase === 'g6' ? await phaseG6() :
          phase === 'g2a' ? await phaseG2a() :
            phase === 'g2b' ? await phaseG2b() :
              await phasePredictions();

  fs.mkdirSync(outDir, {recursive: true});
  fs.writeFileSync(path.join(outDir, `${phase}.json`), JSON.stringify(block, null, 1));
  console.log(`[validate] ${phase} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** Merges the phase blocks into the one committed artifact the plan names. */
function assemble(outDir: string, finalPath: string | undefined): void {
  const blocks: Record<string, unknown> = {};
  for (const phase of PHASES) {
    const file = path.join(outDir, `${phase}.json`);
    if (fs.existsSync(file)) {
      blocks[phase] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      console.warn(`[validate] assemble: ${phase}.json is missing - the artifact will not carry it.`);
    }
  }

  const artifact = {
    bullet: 'Milestone 2, bullet 2 - fixed baselines',
    criteria: 'agent/docs/Milestone2_Bullet2_Prompts.md §5 (G1-G9), pre-committed before any measurement',
    generatedAt: new Date().toISOString(),
    machine: describeMachine(),
    ...blocks,
  };

  const target = finalPath ?? path.join(outDir, 'baselines_validation.json');
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, JSON.stringify(artifact, null, 1));
  console.log(`[validate] assembled -> ${target}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let phase = 'all';
  // `'moves'` is `artifact.ts`'s *scratch* tier (`agent/runs/`, gitignored); the committed tier is
  // `agent/docs/data/`, which only `--final` writes to. Phase blocks are intermediates, not evidence.
  let outDir = path.join(defaultOutputDir('moves'), 'baselines-validation');
  let finalPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--phase':
      phase = argv[++i];
      break;
    case '--out-dir':
      outDir = path.resolve(argv[++i]);
      break;
    case '--final':
      finalPath = path.resolve(argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'agent/docs/data/baselines_validation.json');
      break;
    default:
      throw new Error(`unknown flag '${argv[i]}'. Use --phase <${[...PHASES, 'all', 'assemble'].join('|')}> [--out-dir <dir>] [--final <path>]`);
    }
  }

  ensureHeadlessEngine();

  if (phase === 'assemble') {
    assemble(outDir, finalPath);
    return;
  }
  if (phase === 'all') {
    for (const name of PHASES) {
      await runPhase(name, outDir);
    }
    assemble(outDir, finalPath);
    return;
  }
  if (!PHASES.includes(phase as PhaseName)) {
    throw new Error(`--phase must be one of ${[...PHASES, 'all', 'assemble'].join(', ')}; got '${phase}'`);
  }
  await runPhase(phase as PhaseName, outDir);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
