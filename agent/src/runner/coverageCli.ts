/**
 * CLI for Milestone 1, bullet 7's Phase M (agent/docs/Milestone1_Bullet7_Prompts.md): the census
 * (K1/K2) and the play sweep (K4).
 *
 *   Build & save the census:
 *     npx tsx agent/src/runner/coverageCli.ts --census --out agent/docs/data/card_census.json
 *
 *   Run the full pre-committed play sweep (1,000x2p + 250x3p + 250x4p), reconciled against a
 *   freshly-built census in the same process (one denominator - Phase M section 5), and save both:
 *     npx tsx agent/src/runner/coverageCli.ts --census --sweep \
 *       --out agent/docs/data/card_census.json --sweep-out agent/docs/data/card_play_coverage.json
 *
 *   A smaller shard:
 *     npx tsx agent/src/runner/coverageCli.ts --sweep --composition 2:20 --sweep-out /tmp/shard.json
 *
 *   Preview the resolved sweep configs without playing anything:
 *     npx tsx agent/src/runner/coverageCli.ts --sweep --composition 2:5,3:5 --list
 *
 *   K7's durable payoff - re-run the census right now and diff it against a committed one:
 *     npx tsx agent/src/runner/coverageCli.ts --verify agent/docs/data/card_census.json
 *
 * `--sweep-out` is the one addition beyond the four flags Phase M's prompt names
 * (`--census`/`--sweep`/`--out`/`--verify`/`--list`): the census and the play-coverage artifact
 * are two different committed files (file-ownership table, Milestone1_Bullet7_Prompts.md), and
 * `--out` alone can't address both when `--census --sweep` run together in one process.
 *
 * Follows the arg-parsing style of legalityCli.ts/determinismCli.ts: a switch over process.argv,
 * explicit errors on unknown flags, no parsing dependency.
 *
 * Exit code is 1 if `--verify` finds a mismatch, or if any sweep game failed to complete.
 */
import {ensureHeadlessEngine} from '../engine/headlessEngine';
import {buildCensus, loadCensus, saveCensus, verifyCensus} from '../coverage/census';
import {
  buildSweepConfigs,
  DEFAULT_SWEEP_COMPOSITION,
  reconcilePlayCoverage,
  runPlaySweep,
  savePlayCoverage,
} from '../coverage/playSweep';
import {Census} from '../coverage/types';

type ParsedArgs = {
  census: boolean;
  sweep: boolean;
  out?: string;
  sweepOut?: string;
  verify?: string;
  list: boolean;
  composition: ReadonlyArray<{players: 2 | 3 | 4; games: number}>;
  progressEvery: number;
};

function parseComposition(raw: string): ReadonlyArray<{players: 2 | 3 | 4; games: number}> {
  return raw.split(',').map((entry) => {
    const [playersRaw, gamesRaw] = entry.split(':');
    const players = Number(playersRaw);
    const games = Number(gamesRaw);
    if (players !== 2 && players !== 3 && players !== 4) {
      throw new Error(`--composition player counts must each be 2, 3, or 4, got ${playersRaw}`);
    }
    if (!Number.isInteger(games) || games < 1) {
      throw new Error(`--composition game counts must be positive integers, got ${gamesRaw}`);
    }
    return {players: players as 2 | 3 | 4, games};
  });
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let census = false;
  let sweep = false;
  let out: string | undefined;
  let sweepOut: string | undefined;
  let verify: string | undefined;
  let list = false;
  let composition = DEFAULT_SWEEP_COMPOSITION;
  let progressEvery = 100;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
    case '--census':
      census = true;
      break;
    case '--sweep':
      sweep = true;
      break;
    case '--out':
      out = argv[++i];
      break;
    case '--sweep-out':
      sweepOut = argv[++i];
      break;
    case '--verify':
      verify = argv[++i];
      break;
    case '--list':
      list = true;
      break;
    case '--composition':
      composition = parseComposition(argv[++i]);
      break;
    case '--progress-every':
      progressEvery = Number(argv[++i]);
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  if (verify === undefined && !census && !sweep && !list) {
    throw new Error('Nothing to do: pass --census, --sweep, --verify <file>, or --list.');
  }

  return {census, sweep, out, sweepOut, verify, list, composition, progressEvery};
}

function runVerify(verifyPath: string): void {
  ensureHeadlessEngine();
  const committed = loadCensus(verifyPath);
  const diff = verifyCensus(committed);

  console.log(`[coverage] verified ${diff.entriesChecked} census entries against ${verifyPath}`);
  if (diff.missing.length === 0 && diff.added.length === 0 && diff.mismatches.length === 0) {
    console.log('[coverage] OK - 0 differences.');
    return;
  }
  for (const name of diff.missing) {
    console.error(`[coverage] MISSING: ${name} is in the committed census but not in a fresh build - it left the manifest.`);
  }
  for (const name of diff.added) {
    console.error(`[coverage] ADDED: ${name} is in a fresh build but not the committed census - it entered the manifest.`);
  }
  for (const mismatch of diff.mismatches) {
    console.error(`[coverage] MISMATCH ${mismatch.name}.${mismatch.field}: committed=${JSON.stringify(mismatch.expected)} fresh=${JSON.stringify(mismatch.actual)}`);
  }
  console.error(`[coverage] ${diff.missing.length + diff.added.length + diff.mismatches.length} difference(s).`);
  process.exitCode = 1;
}

function runCensus(args: ParsedArgs): Census {
  ensureHeadlessEngine();
  const census = buildCensus();
  console.log(`[coverage] census: ${census.entries.length} in-scope entries.`);
  const bySection = new Map<string, number>();
  for (const entry of census.entries) {
    bySection.set(entry.section, (bySection.get(entry.section) ?? 0) + 1);
  }
  for (const [section, count] of bySection) {
    console.log(`[coverage]   ${section}: ${count}`);
  }
  if (census.presence.cardNumberIssues.length > 0) {
    console.log(`[coverage] presence: ${census.presence.cardNumberIssues.length} cardNumber issue(s):`);
    for (const issue of census.presence.cardNumberIssues) {
      console.log(`[coverage]   ${issue.kind} ${issue.section} ${issue.cardNumber} ${issue.names.join(', ')}`);
    }
  } else {
    console.log('[coverage] presence: no cardNumber gaps or duplicates in projectCards/preludeCards.');
  }
  const {missing, unexpected} = census.presence.corporations;
  if (missing.length > 0 || unexpected.length > 0) {
    console.error(`[coverage] presence: corporation name mismatch - missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`);
  } else {
    console.log(`[coverage] presence: all ${census.presence.corporations.expectedNames.length} printed corporation names accounted for.`);
  }

  if (args.out !== undefined) {
    saveCensus(args.out, census);
    console.log(`[coverage] wrote the census to ${args.out}`);
  }
  return census;
}

async function runSweep(args: ParsedArgs, census: Census | undefined): Promise<void> {
  const configs = buildSweepConfigs(args.composition);

  if (args.list) {
    for (const config of configs) {
      console.log(JSON.stringify(config));
    }
    return;
  }

  ensureHeadlessEngine();
  console.log(`[coverage] play sweep: ${configs.length} games ` +
    `(${args.composition.map((c) => `${c.games}x${c.players}p`).join(' + ')}), single process.`);

  const started = Date.now();
  const result = await runPlaySweep(configs, {
    onProgress: (completed, total) => {
      if (completed % args.progressEvery === 0) {
        const rate = completed / ((Date.now() - started) / 1000);
        process.stdout.write(`[coverage] ${completed}/${total} games (${rate.toFixed(1)} games/s)\n`);
      }
    },
  });

  console.log(`[coverage] sweep: ${result.gamesCompleted}/${result.gamesRun} games completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const failure of result.failures) {
    console.error(`[coverage] FAILED players=${failure.config.players} engineSeed=${failure.config.engineSeed} agentSeed=${failure.config.agentSeed}: ${failure.errorClass}: ${failure.message}`);
  }

  const censusForReconcile = census ?? runCensus(args);
  const coverage = reconcilePlayCoverage(censusForReconcile, result, args.composition);

  const reachableEntries = coverage.entries.filter((e) => e.scope === 'reachable');
  const observedReachable = reachableEntries.filter((e) => e.timesObserved > 0);
  const pct = reachableEntries.length === 0 ? 0 : (100 * observedReachable.length / reachableEntries.length);
  console.log(`[coverage] K4: ${observedReachable.length}/${reachableEntries.length} reachable entries observed at least once (${pct.toFixed(1)}%, threshold >=95%).`);

  const corporations = coverage.entries.filter((e) => e.section === 'corporationCards' && e.scope !== 'unreachable-in-config');
  const preludes = coverage.entries.filter((e) => e.section === 'preludeCards');
  const unplayedCorps = corporations.filter((e) => e.timesObserved === 0);
  const unplayedPreludes = preludes.filter((e) => e.timesObserved === 0);
  if (unplayedCorps.length > 0 || unplayedPreludes.length > 0) {
    console.error(`[coverage] K4: unplayed dealable corporations=${JSON.stringify(unplayedCorps.map((e) => e.name))} unplayed preludes=${JSON.stringify(unplayedPreludes.map((e) => e.name))}`);
  } else {
    console.log(`[coverage] K4: all ${corporations.length} dealable corporations and all ${preludes.length} preludes observed at least once.`);
  }

  if (coverage.unexpectedlyPlayed.length > 0) {
    console.error(`[coverage] K2 finding: unreachable-in-config entries were nevertheless observed: ${JSON.stringify(coverage.unexpectedlyPlayed)} - the reachability classification is wrong for these, fix reachability.ts.`);
  }

  if (args.sweepOut !== undefined) {
    savePlayCoverage(args.sweepOut, coverage);
    console.log(`[coverage] wrote the play-coverage artifact to ${args.sweepOut}`);
  }

  if (result.gamesRun - result.gamesCompleted > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.verify !== undefined) {
    runVerify(args.verify);
    return;
  }

  let census: Census | undefined;
  if (args.census) {
    census = runCensus(args);
  }
  if (args.sweep) {
    await runSweep(args, census);
  }
}

void main();
