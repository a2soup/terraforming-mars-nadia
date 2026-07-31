import * as fs from 'fs';
import {LadderLedger, SEED_BLOCKS, SeedBlockAllocation, SeedBlockName} from './types';

/**
 * Seed-block discipline (Milestone 2, bullet 3, Unit A;
 * agent/docs/Milestone2_Bullet3_Prompts.md §3.8).
 *
 * **Why this exists at all, and why now.** Milestone 3 tunes evaluation weights *against harness
 * win rate*. If the seeds used to tune are the seeds used to certify, the certification measures
 * the tuning - the estimate is inflated, nothing in the output says so, and the effect is
 * quantified rather than hypothetical (criterion P9 predicts 1.5-3 pp at 500 groups from
 * best-of-8 selection on a reused block). This is the single largest methodological risk in the
 * milestones ahead, it costs nothing to prevent today, and it is **unfixable after the fact**. So
 * the allocation is decided here, before any Milestone 3 code exists, and it is a checked function
 * rather than a paragraph, because a convention that lives only in a plan document is a convention
 * that expires with the session that wrote it.
 *
 * | Block | Group indices | Use |
 * | --- | --- | --- |
 * | **D - development** | 0 - 1,999 | Tuning, debugging, smoke runs, anything iterated on |
 * | **G - gate** | 2,000 - 5,999 | Promotion gates only, one fresh disjoint sub-range each |
 * | **R - regression** | 6,000 - 6,999 | Bullet 5's fixed reference games; never a strength estimate |
 * | **H - harness** | 7,000 - 9,999 | The harness's own self-tests; added by Unit D, see below |
 *
 * **A finding, recorded here because it is where someone will look for it.** The allocation was
 * introduced retroactively, and Milestone 2 bullet 1's own validation battery already spent group
 * ranges that do not fit it: `matchValidationCli.ts` uses 5,000-5,019 (R2) inside G, 6,000-6,029
 * (R3) inside R, and 7,000-7,039 (R6), 8,000-8,999 (R7) and 9,000-9,009 (R8) **past the end of the
 * three-block allocation entirely**. Those were `random-legal` self-play development runs, so
 * nothing was certified on them - but the ranges are used, a future gate allocated over 5,000-5,019
 * would have been reusing seeds without knowing it, and three of the five could not be recorded as
 * spent at all. Unit D added the `harness` block for the last three and seeded the ledger with all
 * five; {@link assertBlockAvailable} now refuses them, which is what §3.8 asks for.
 *
 * **The workflow, in the order it has to happen** (and the second step is the one that was broken
 * until it was run end to end - see {@link assertBlockAvailable}):
 *
 * 1. `npm run rate -- ladder allocate --block gate --groups N --spent-by "<claim>"
 *    --preregistered-games N` — reserve the range **before** playing anything.
 * 2. Play the games into that range (`npm run match -- --start-group <from> --groups N`).
 * 3. `npm run rate -- gate ... --claim "<claim>"` — the claim string must match the `--spent-by`
 *    exactly, which is what lets a gate run on its own reservation and on nobody else's.
 */

/** The block a group index falls in, or `undefined` past the end of the allocation. */
export function blockFor(groupIndex: number): SeedBlockName | undefined {
  for (const [name, range] of Object.entries(SEED_BLOCKS) as ReadonlyArray<[SeedBlockName, {from: number; to: number}]>) {
    if (groupIndex >= range.from && groupIndex <= range.to) {
      return name;
    }
  }
  return undefined;
}

/** `[startGroup, startGroup + groups - 1]`, the inclusive range a run will occupy. */
export function rangeOf(startGroup: number, groups: number): {from: number; to: number} {
  return {from: startGroup, to: startGroup + groups - 1};
}

/**
 * Refuses a range that leaves the named block. A gate that quietly runs half in G and half past its
 * end is a gate whose second half has no discipline at all.
 */
export function assertWithinBlock(block: SeedBlockName, from: number, to: number): void {
  const range = SEED_BLOCKS[block];
  if (from < range.from || to > range.to) {
    throw new Error(
      `group range ${from}-${to} does not fit inside the '${block}' block (${range.from}-${range.to}, ` +
      `for ${range.use}). Pick a sub-range inside it, or a different block (§3.8).`);
  }
}

/**
 * Refuses a range the ledger already records as spent - **the whole point of the ledger** (§3.8,
 * hazard H7). "A gate re-run on its own sub-range after a change is not a gate": the second run's
 * seeds are the seeds the change was made in response to.
 *
 * With no ledger (`allocations` absent or empty) this cannot check anything, so it says so loudly
 * and lets the caller proceed - Unit A must not be blocked on Unit B's `ladder.ts`, and a gate that
 * refused to run at all before the ladder existed would just be bypassed.
 */
export function assertBlockAvailable(
  block: SeedBlockName,
  from: number,
  to: number,
  ledger: LadderLedger | undefined,
  warn: (message: string) => void = console.warn,
  claim?: string,
): void {
  assertWithinBlock(block, from, to);

  if (ledger === undefined || ledger.allocations.length === 0) {
    warn(
      `[rate] WARNING: no seed-block ledger found, so group range ${from}-${to} could not be checked ` +
      'against ranges already spent (§3.8, hazard H7). A gate run on seeds a previous gate or a ' +
      'tuning pass already used is not a gate. Record this allocation in agent/docs/data/ladder.json ' +
      'before treating the result as evidence.');
    return;
  }

  const overlapping = ledger.allocations.filter((allocation) =>
    allocation.block === block && allocation.from <= to && allocation.to >= from);
  if (overlapping.length === 0) {
    return;
  }

  // A gate's own pre-registration is not a collision - it is the thing §3.8 asks for.
  //
  // **Found by running the workflow end to end** (Unit D, 31 Jul 2026), and it made the discipline
  // unusable rather than merely awkward. §3.8 says each gate is allocated a sub-range "recorded in
  // the ladder *before* the run"; that allocation then sat in the ledger, and the gate that the
  // range had been reserved *for* was refused by its own reservation. Every possible gate was
  // blocked, so the only way to run one would have been to skip the allocation - i.e. to bypass the
  // discipline entirely, which is worse than not having it.
  //
  // `claim` is what closes it: an overlap is allowed exactly when every overlapping allocation was
  // recorded by this same claim, so a gate may run on the range it reserved and on no other. The
  // string has to match the `--spent-by` used at allocation time, which is deliberate - a typo
  // fails closed, and the operator sees the two strings side by side in the message below.
  if (claim !== undefined && overlapping.every((allocation) => allocation.spentBy === claim)) {
    return;
  }

  const own = claim === undefined ?
    ' (no --claim was given, so no allocation can be recognized as this run\'s own)' :
    ` (this run claims '${claim}', which matches none of them)`;
  throw new Error(
    `group range ${from}-${to} overlaps ${overlapping.length} range(s) the ladder already records ` +
    `as spent: ${overlapping.map(describeAllocation).join('; ')}${own}. ` +
    'Allocate a fresh, disjoint sub-range (§3.8) - re-running a gate on its own seeds is not a gate.');
}

function describeAllocation(allocation: SeedBlockAllocation): string {
  return `${allocation.from}-${allocation.to} spent by '${allocation.spentBy}' on ${allocation.recordedAt}`;
}

/** The first range of `groups` groups in `block` that the ledger does not already record as spent. */
export function nextFreeRange(
  block: SeedBlockName,
  groups: number,
  ledger: LadderLedger | undefined,
): {from: number; to: number} | undefined {
  const range = SEED_BLOCKS[block];
  const spent = (ledger?.allocations ?? [])
    .filter((allocation) => allocation.block === block)
    .sort((a, b) => a.from - b.from);

  let from = range.from;
  for (const allocation of spent) {
    if (from + groups - 1 < allocation.from) {
      break;
    }
    from = Math.max(from, allocation.to + 1);
  }
  const to = from + groups - 1;
  return to <= range.to ? {from, to} : undefined;
}

/**
 * Reads Unit B's ladder if it exists. **Unit A never writes it** - `rating/ladder.ts` owns the
 * persistence and `docs/data/ladder.json` is Unit D's to seed (§8). This reads the one field the
 * gate needs and tolerates the file being absent, which it was until Unit B landed.
 *
 * **Both shapes are accepted, and that is a bug fix rather than generosity** (Unit D, 31 Jul 2026).
 * This function was written against a bare `{allocations}` file because Unit B's `ladder.ts` did not
 * exist yet, and the ladder Unit B then shipped nests it: `{header, strata, ledger, timing}`. So
 * `parsed.allocations` was `undefined` on every real ladder, this returned an empty list, and
 * {@link assertBlockAvailable} read that as "no ledger" - which it handles by warning and letting
 * the run proceed. The net effect was that **the seed-block discipline of §3.8 never once refused
 * anything**, while printing a warning that looked like a missing file rather than a defect.
 *
 * Two things worth taking from it. The first is that the specs did not catch it: P7 and P8 assert
 * the refusal against a `LadderLedger` built in memory, so they exercised every path except the one
 * that reads the file that actually exists. The second is that this is the failure mode the whole
 * bullet is about - nothing crashed, the output stayed plausible, and the guard was off.
 */
export function loadLedger(filePath: string): LadderLedger | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as
    Partial<LadderLedger> & {ledger?: Partial<LadderLedger>};
  const allocations = parsed.ledger?.allocations ?? parsed.allocations;
  if (allocations === undefined) {
    // Present but carrying no ledger at all: report absence rather than an empty ledger, so the
    // caller's warning says the true thing.
    return undefined;
  }
  return {allocations};
}
