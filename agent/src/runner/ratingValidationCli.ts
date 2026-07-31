/**
 * The rating pipeline's calibration study (Milestone 2, bullet 3, Unit C): the runs that produce
 * evidence for criteria P2, P3 and P9, pre-committed in
 * agent/docs/Milestone2_Bullet3_Prompts.md §5.
 *
 *   Everything, writing the committed artifact:
 *     node build/agent/agent/src/runner/ratingValidationCli.js --phase all
 *
 *   One criterion at a time, into a scratch directory, then assembled:
 *     node build/agent/agent/src/runner/ratingValidationCli.js --phase p2 --out-dir /tmp/v
 *     node build/agent/agent/src/runner/ratingValidationCli.js --phase assemble --out-dir /tmp/v
 *
 *   A fast smoke of the whole shape (200 replications - **not** evidence for anything):
 *     npm run rate:validate -- --phase all --replications 200 --final /tmp/smoke.json
 *
 * **This is the unit whose output every other claim in the bullet rests on.** Nothing else here can
 * be checked by running games: a win rate is adjudicated by counting, but there is no game you can
 * play to find out whether a 95% interval is a 95% interval. So the only shortcuts available are
 * dishonest ones, and both are structurally refused rather than resisted:
 *
 * - **The tolerance band cannot be widened.** It is computed from the replication count in
 *   `rating/calibration.ts` (`0.95 ± 1.96·√(0.95·0.05/R)`), and `--replications` *narrows* it. The
 *   pre-committed [94.0%, 96.0%] is that band at R = 2,000, and a cell between the two is reported
 *   as `marginal` rather than passed.
 * - **The generator is not the only witness.** `--phase p2` includes an analytic anchor computed by
 *   enumerating the binomial pmf, with no RNG at all, so at least one row of the study is checked
 *   against mathematics rather than against Unit A's generator (hazard H12).
 *
 * Pure arithmetic - no Engine, no games, no `ensureHeadlessEngine`. **Nothing here is a performance
 * measurement** (hazard H10): the wall clocks printed below are progress reporting, and the artifact
 * carries them only so a later reader knows what a re-run costs.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CriterionVerdict,
  PRECOMMITTED_BAND,
  REQUIRED_REPLICATIONS,
  adjudicateP2,
  adjudicateP3,
  adjudicateP9,
  analyticAnchorGrid,
  bootstrapCoverageGrid,
  coverageBand,
  marginCoverageGrid,
  optionalStoppingStudy,
  permutationSizeGrid,
  powerGrid,
  proportionCoverageGrid,
  seedReuseStudy,
  sizeGrid,
} from '../rating/calibration';
import {defaultRatingOutputDir} from '../rating/report';
import {DEFAULT_ANALYSIS_SEED} from '../rating/types';

type PhaseName = 'p2' | 'p3' | 'p9';

const PHASES: ReadonlyArray<PhaseName> = ['p2', 'p3', 'p9'];

/**
 * Variant x seed interaction standard deviations, in logits, for P9's seed-reuse sweep. Index 1 is
 * the headline. `0` is the pure selection-noise baseline; `1.0` is a deliberately extreme "seeds
 * have strong personalities" world, included so the reader can see where the conclusion would have
 * to change rather than being asked to accept one value of an unmeasurable parameter.
 */
const INTERACTION_SWEEP: ReadonlyArray<number> = [0, 0.15, 0.5, 1.0];

type PhaseOptions = {
  replications: number;
  analysisSeed: number;
  /** P9's simulations are cheap per replication and noisy, so they run deeper than the grids. */
  stoppingReplications: number;
  reuseReplications: number;
  bootstrapReplicates: number;
};

// ---------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------

/**
 * P2 - every interval is calibrated. Four blocks, and the fourth is the one that makes the other
 * three worth believing:
 *
 * 1. the effective-n Wilson interval over the full pre-committed grid, both cluster mechanisms;
 * 2. the percentile cluster bootstrap's own coverage (a cross-check that miscovers is not a
 *    cross-check), on the reduced grid its cost forces;
 * 3. the group-mean t interval for the VP margin, sized against the measured 2p/3p margin scales;
 * 4. the **analytic anchor** - exact coverage by enumeration, no RNG anywhere.
 */
function phaseP2(options: PhaseOptions): unknown {
  const proportion = proportionCoverageGrid({
    replications: options.replications,
    analysisSeed: options.analysisSeed,
    onCell: progress('P2 proportion'),
  });
  const bootstrap = bootstrapCoverageGrid({
    replications: options.replications,
    analysisSeed: options.analysisSeed,
    bootstrapReplicates: options.bootstrapReplicates,
    onCell: progress('P2 bootstrap'),
  });
  const margin = marginCoverageGrid({
    replications: options.replications,
    analysisSeed: options.analysisSeed,
    onCell: progress('P2 margin'),
  });
  const anchor = analyticAnchorGrid({
    replications: options.replications,
    analysisSeed: options.analysisSeed,
    onCell: progress('P2 anchor'),
  });

  const verdict = adjudicateP2([proportion, bootstrap, margin]);
  reportVerdict(verdict);
  return {proportion, bootstrap, margin, anchor, verdict};
}

/**
 * P3 - every test's size and power are measured, **and the negative control is measured too**.
 *
 * The negative control is not decoration. The cluster correction is small (a design effect of 1.03
 * at 2p), and a correction whose absence cannot be shown to matter has not been justified. The
 * unclustered columns in the size grid are that demonstration, with a number.
 */
function phaseP3(options: PhaseOptions): unknown {
  const size = sizeGrid({
    replications: options.replications,
    analysisSeed: options.analysisSeed,
    onCell: progress('P3 size'),
  });
  const permutation = permutationSizeGrid({
    replications: options.replications,
    analysisSeed: options.analysisSeed,
    onCell: progress('P3 permutation'),
  });
  const power = powerGrid({
    replications: options.replications,
    analysisSeed: options.analysisSeed,
    onCell: progress('P3 power'),
  });

  const verdict = adjudicateP3(size, permutation, power);
  reportVerdict(verdict);
  return {size, permutation, power, verdict};
}

/**
 * P9 - the two methodology hazards Milestone 3 is about to walk into, turned from advice into a
 * cost with a number on it.
 *
 * Pure simulation: no games, no Engine. These are the most durable things this unit produces,
 * because "don't peek" and "don't tune on your certification seeds" are arguments that lose to a
 * deadline and measurements that do not.
 */
function phaseP9(options: PhaseOptions): unknown {
  const stopping = optionalStoppingStudy({
    replications: options.stoppingReplications,
    analysisSeed: options.analysisSeed,
    onCell: progress('P9 optional stopping'),
  });
  // A sweep over the variant x seed interaction, not one arbitrary value of it.
  //
  // The magnitude of that interaction - how much of a variant's edge is a property of *these* deals
  // rather than of the variant - is the one parameter of P9's second simulation that cannot be
  // measured from anything this project has run, so quoting a single choice of it would be quoting
  // an assumption as a result. The sweep says instead where the answer changes: `0` is the pure
  // winner's-curse baseline, and the headline (`INTERACTION_SWEEP[1]`) is the modest value the
  // predicted range was written against.
  const reuseBySpread = INTERACTION_SWEEP.map((interactionSd) => seedReuseStudy({
    replications: options.reuseReplications,
    analysisSeed: options.analysisSeed,
    interactionSd,
    onCell: progress(`P9 seed reuse (interaction ${interactionSd})`),
  }));
  const reuse = reuseBySpread[1];

  const verdict = adjudicateP9(stopping, reuse);
  reportVerdict(verdict);
  return {stopping, reuse, reuseBySpread, verdict};
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function progress(prefix: string): (label: string, index: number, total: number) => void {
  return (label, index, total) => {
    process.stdout.write(`[rate:validate] ${prefix} ${index + 1}/${total}: ${label}\n`);
  };
}

function reportVerdict(verdict: CriterionVerdict): void {
  console.log(`[rate:validate] ${verdict.criterion}: ${verdict.met ? 'MET' : 'NOT MET'} - ${verdict.statement}`);
}

/**
 * The host, recorded for the same reason `matchValidationCli.ts` records it - and for a different
 * one too. This study makes **no** performance claim (H10); the machine block is here so that a
 * re-run on another host can be compared for *agreement*, which is a correctness check, rather than
 * for speed, which is not a claim this project makes from this machine.
 */
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

function runPhase(phase: PhaseName, outDir: string, options: PhaseOptions): void {
  const started = Date.now();
  const block = phase === 'p2' ? phaseP2(options) : phase === 'p3' ? phaseP3(options) : phaseP9(options);
  fs.mkdirSync(outDir, {recursive: true});
  fs.writeFileSync(path.join(outDir, `${phase}.json`), JSON.stringify({
    ...(block as Record<string, unknown>),
    wallClockMs: Date.now() - started,
  }, null, 1));
  console.log(`[rate:validate] ${phase} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * Merges the phase blocks into the one committed artifact.
 *
 * Follows `match_runner_validation.json`'s shape - a provenance header then one section per phase -
 * and carries **the per-cell numbers, not just pass/fail**, because §4 of this unit's prompt asks
 * for an artifact a later reader can re-run one cell from. Every cell records its own derived seed,
 * so re-running exactly one of them reproduces the number without running the 95 before it.
 */
function assemble(outDir: string, finalPath: string, options: PhaseOptions): void {
  const blocks: Record<string, unknown> = {};
  const verdicts: Array<CriterionVerdict> = [];
  for (const phase of PHASES) {
    const file = path.join(outDir, `${phase}.json`);
    if (!fs.existsSync(file)) {
      console.warn(`[rate:validate] assemble: ${phase}.json is missing - the artifact will not carry it.`);
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    blocks[phase] = parsed;
    if (parsed.verdict !== undefined) {
      verdicts.push(parsed.verdict as CriterionVerdict);
    }
  }

  const artifact = {
    what: 'Milestone 2 bullet 3 (the rating pipeline) calibration study: evidence for criteria P2, P3 ' +
      'and P9, pre-committed in agent/docs/Milestone2_Bullet3_Prompts.md §5. Adjudicated in ' +
      'agent/docs/Rating_Pipeline.md.',
    howToReadIt: 'Coverage is empirical: generate from known parameters, run the shipped estimator, count ' +
      'how often the interval contains the truth. A cell passes inside the ±1.96 Monte-Carlo band computed ' +
      'from its replication count, is `marginal` inside the pre-committed [94.0%, 96.0%], and fails outside ' +
      'it. About 5% of cells are expected outside the band by chance, so read the pattern, not one cell.',
    generatedAt: new Date().toISOString(),
    machine: describeMachine(),
    settings: {
      analysisSeed: options.analysisSeed,
      replications: options.replications,
      requiredReplications: REQUIRED_REPLICATIONS,
      stoppingReplications: options.stoppingReplications,
      reuseReplications: options.reuseReplications,
      bootstrapReplicates: options.bootstrapReplicates,
      band: coverageBand(options.replications),
      precommittedBand: PRECOMMITTED_BAND,
      meetsReplicationFloor: options.replications >= REQUIRED_REPLICATIONS,
    },
    verdicts,
    ...blocks,
  };

  fs.mkdirSync(path.dirname(finalPath), {recursive: true});
  fs.writeFileSync(finalPath, `${JSON.stringify(artifact, null, 1)}\n`);
  const sizeMb = fs.statSync(finalPath).size / 1024 / 1024;
  console.log(`[rate:validate] wrote ${finalPath} (${sizeMb.toFixed(2)} MB)`);
  for (const verdict of verdicts) {
    reportVerdict(verdict);
  }
  if (options.replications < REQUIRED_REPLICATIONS) {
    console.warn(`[rate:validate] WARNING: ${options.replications} replications is below criterion P2's ` +
      `floor of ${REQUIRED_REPLICATIONS}. This artifact is a smoke run, not evidence.`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let phase = 'all';
  let outDir = path.join(os.tmpdir(), 'nadia-rating-validation');
  let finalPath: string | undefined;
  let replications = REQUIRED_REPLICATIONS;
  let stoppingReplications: number | undefined;
  let reuseReplications: number | undefined;
  let bootstrapReplicates = 200;
  let analysisSeed = DEFAULT_ANALYSIS_SEED;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--phase':
      phase = argv[++i];
      break;
    case '--out-dir':
      outDir = argv[++i];
      break;
    case '--final':
      finalPath = argv[++i];
      break;
    case '--replications':
      replications = Number(argv[++i]);
      break;
    case '--stopping-replications':
      stoppingReplications = Number(argv[++i]);
      break;
    case '--reuse-replications':
      reuseReplications = Number(argv[++i]);
      break;
    case '--bootstrap-replicates':
      bootstrapReplicates = Number(argv[++i]);
      break;
    case '--analysis-seed':
      analysisSeed = Number(argv[++i]);
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  const options: PhaseOptions = {
    replications,
    analysisSeed,
    // P9's numbers are single scalars rather than a grid, so they carry the whole criterion on their
    // own precision: 10,000 replications puts the Monte-Carlo error on a ~20% rate at ±0.8 pp.
    stoppingReplications: stoppingReplications ?? Math.max(replications, 10_000),
    reuseReplications: reuseReplications ?? Math.max(replications, 5_000),
    bootstrapReplicates,
  };
  const resolvedFinal = finalPath ?? path.join(defaultRatingOutputDir(), 'rating_validation.json');

  console.log(`[rate:validate] analysis seed ${analysisSeed}, ${replications} replications per cell, ` +
    `band [${(coverageBand(replications).low * 100).toFixed(2)}%, ${(coverageBand(replications).high * 100).toFixed(2)}%]`);

  if (phase === 'assemble') {
    assemble(outDir, resolvedFinal, options);
    return;
  }
  if (phase === 'all') {
    for (const name of PHASES) {
      runPhase(name, outDir, options);
    }
    assemble(outDir, resolvedFinal, options);
    return;
  }
  if (!PHASES.includes(phase as PhaseName)) {
    throw new Error(`--phase must be one of ${[...PHASES, 'all', 'assemble'].join(', ')}; got '${phase}'`);
  }
  runPhase(phase as PhaseName, outDir, options);
}

if (require.main === module) {
  main();
}
