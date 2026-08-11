import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {RegressionLayer} from './types';

/**
 * The rebaseline ledger (Milestone 2, bullet 5, Unit A §6;
 * agent/docs/Milestone2_Bullet5_Prompts.md §3.5).
 *
 * ---
 *
 * ## What this is defending against
 *
 * This bullet has two stated failure modes, and this file is the whole of the answer to the first:
 *
 * > **A suite that goes red on every intentional change gets regenerated instead of read.**
 *
 * That is not hypothetical. The determinism corpus already demonstrated it at small scale - the
 * `initialCards` cap moved 43 of its 300 configs, which was that corpus working exactly as designed,
 * and the correct response was a deliberate regeneration. Do that four more times and regeneration
 * becomes reflex. §3.1's layering is what keeps the red surface small; **this ledger is what makes
 * the reflex expensive** (hazard H7).
 *
 * So: `npm run regression -- --rebaseline` **alone fails**. It requires `--claim "<what changed and
 * why>"`, and it appends an entry that the operator cannot shade:
 *
 * - **`entriesMoved` and `fieldsMoved` are computed by the tool, never typed.** A rebaseline that
 *   moved 43 of 300 entries and one that moved 300 of 300 are different events, and the ledger has
 *   to say which happened *without being asked*. An operator who has just decided a change is
 *   intentional is the last person who should be summarizing its blast radius.
 * - **`previousDigest` chains the entries**, so a removed or edited row is detectable rather than
 *   merely discouraged. {@link verifyLedgerChain} is the check, and it is run on every append.
 * - **`corpusDigestBefore` / `corpusDigestAfter`** pin the artifact on each side of the event, so
 *   "is the file I am looking at the one this ledger entry describes?" is answerable. §3.5 lists
 *   `previousDigest` alone; these two are added because a chain over ledger rows says nothing about
 *   the corpus the rows are *about*, and that is the question a reader actually arrives with.
 *
 * ---
 *
 * ## Modelled on `rating/seedBlocks.ts`, including its scar
 *
 * That module's allocation ledger is the house precedent and is deliberately reread here, because
 * it carries the failure this one is most likely to repeat. Its guard **had specs, passed them, and
 * had never once refused a real run**: the loader was written against a bare `{allocations}` shape
 * while the ladder that shipped nested it, so the guard read every real ladder as "no ledger",
 * warned about a missing file, and let everything through. Two lessons, both acted on here:
 *
 * 1. **A spec against an in-memory ledger exercises every path except the one that reads the file
 *    that exists.** So criterion S7 is adjudicated *through the CLI*, on a real file
 *    (`test/regression/ledger.spec.ts` spawns `regressionCli.ts`), not against a value.
 * 2. **Absence must not be indistinguishable from emptiness.** {@link loadRebaselineLedger} returns
 *    `undefined` for a missing file and an empty ledger for a present-but-empty one, and the two
 *    are reported differently.
 *
 * The convention lives in code rather than in a plan document for the reason §3.8 of bullet 3 gives:
 * *a convention that lives only in a plan document is a convention that expires with the session
 * that wrote it.*
 */

/** Bumped when a change to this schema would make an old ledger misread. */
export const REBASELINE_LEDGER_VERSION = '1';

/**
 * The first entry's `previousDigest`. A literal rather than an empty string so a truncated chain -
 * someone deleting row 0 and leaving row 1 - is distinguishable from a genuine first entry.
 */
export const LEDGER_GENESIS_DIGEST = createHash('sha256').update('nadia-regression-rebaseline-genesis').digest('hex');

export type RebaselineEntry = {
  recordedAt: string;
  /** Which layer was regenerated. L1 has no committed entries, so in practice this is `l2`. */
  layer: RegressionLayer;
  /** The operator's written claim: what changed and why this is not a regression. Required. */
  claim: string;
  /** Repo HEAD at the time of the rebaseline. Provenance - this is the thing that changed. */
  agentCommit: string;
  /** The Engine pin. If *this* moved, the rebaseline is a pin move and every layer is affected. */
  enginePin: string;
  /** Tool-computed. Entries whose replay no longer reproduced the committed record. */
  entriesMoved: number;
  entriesTotal: number;
  /** Tool-computed. `{normalized field path: entries that moved it}` - see `corpus.ts`'s `tallyFieldsMoved`. */
  fieldsMoved: Readonly<Record<string, number>>;
  /** Digest of the previous entry, or {@link LEDGER_GENESIS_DIGEST}. */
  previousDigest: string;
  /** The corpus's content digest before and after this rebaseline (`corpus.ts`'s `digestCorpus`). */
  corpusDigestBefore: string;
  corpusDigestAfter: string;
};

export type RebaselineLedger = {
  ledgerVersion: string;
  /** Append-only, oldest first. */
  entries: ReadonlyArray<RebaselineEntry>;
  /**
   * `digestEntry` of the **last** entry, or {@link LEDGER_GENESIS_DIGEST} when there are none.
   *
   * **Without this the chain does not cover its own head** (found by Unit D, criterion S7, by
   * editing a ledger as an operator would). Each entry's `previousDigest` pins the entry *before*
   * it, so with `n` entries the chain constrains the first `n-1` and nothing pins the last. On a
   * two-entry ledger, editing entry 0 is caught and editing entry 1 is not; on the one-entry ledger
   * this project has, **nothing** is caught. Worse than a missed tamper: the next legitimate
   * rebaseline chains onto the edited row's digest, and the edit becomes permanently self-consistent.
   *
   * Recomputed on every write by {@link saveRebaselineLedger} so it cannot drift from `entries`,
   * and compared on every load by {@link verifyLedgerChain}.
   */
  headDigest: string;
};

/**
 * A ledger read from a file that carried no `headDigest` at all. Deliberately not a valid sha256
 * hex string, so it can never coincide with a real head, and deliberately not silently filled in
 * with the computed value - a missing head digest means the file predates the check or was
 * hand-written, and {@link verifyLedgerChain} must say so rather than manufacture agreement.
 */
export const LEDGER_HEAD_ABSENT = 'absent';

/** The digest the ledger's `headDigest` must equal: its last entry's, or genesis when empty. */
export function headDigestOf(ledger: Pick<RebaselineLedger, 'entries'>): string {
  const last = ledger.entries[ledger.entries.length - 1];
  return last === undefined ? LEDGER_GENESIS_DIGEST : digestEntry(last);
}

/** Thrown by every refusal in this module. */
export class RebaselineError extends Error {}

/**
 * **The refusal S7 is adjudicated on.** A bare `--rebaseline` fails here, before anything is
 * replayed and long before anything is written.
 *
 * The minimum length is not bureaucracy: a claim of `"fix"` or `"."` satisfies "there is a string"
 * while satisfying nothing the ledger exists for, and the whole mechanism is that regenerating
 * costs a sentence somebody has to stand behind.
 */
export function assertRebaselineClaim(claim: string | undefined): asserts claim is string {
  if (claim === undefined || claim.trim() === '') {
    throw new RebaselineError(
      'a rebaseline needs --claim "<what changed and why>" (§3.5). Regenerating a pinned layer is an ' +
      'event, not a flag: the suite going red is the suite working, and the first question is always ' +
      'whether the change was intended. If a frozen baseline moved because shared infrastructure ' +
      'changed, that is a regression, not a rebaseline - adjudicate it and either revert or cut a new ' +
      'agent version (§3.1).');
  }
  if (claim.trim().length < 12) {
    throw new RebaselineError(
      `--claim "${claim}" is too short to be a claim (§3.5). Say what changed and why the movement is ` +
      'intended; this line is what a session two milestones from now reads to decide whether to trust ' +
      'the corpus it is standing on.');
  }
}

/** A stable digest of one entry, for the chain. Field order is fixed by the literal below. */
export function digestEntry(entry: RebaselineEntry): string {
  return createHash('sha256').update(JSON.stringify([
    entry.recordedAt, entry.layer, entry.claim, entry.agentCommit, entry.enginePin,
    entry.entriesMoved, entry.entriesTotal, sortedFields(entry.fieldsMoved),
    entry.previousDigest, entry.corpusDigestBefore, entry.corpusDigestAfter,
  ])).digest('hex');
}

/** Key order in a JSON object is insertion order, which a hash must not depend on. */
function sortedFields(fields: Readonly<Record<string, number>>): ReadonlyArray<[string, number]> {
  return Object.keys(fields).sort().map((key) => [key, fields[key]]);
}

export function emptyLedger(): RebaselineLedger {
  return {ledgerVersion: REBASELINE_LEDGER_VERSION, entries: [], headDigest: LEDGER_GENESIS_DIGEST};
}

/**
 * Reads the ledger, or `undefined` if the file does not exist.
 *
 * **`undefined` and an empty ledger are different answers**, and conflating them is exactly how
 * `rating/seedBlocks.ts`'s guard spent a milestone switched off (see the module doc). A missing
 * file means "this has never been checked"; an empty one means "checked, nothing has been
 * rebaselined". Callers report them differently.
 */
export function loadRebaselineLedger(filePath: string): RebaselineLedger | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<RebaselineLedger>;
  if (parsed.entries === undefined) {
    throw new RebaselineError(
      `${filePath} exists but carries no 'entries' array, so it is not a rebaseline ledger. Refusing to ` +
      'treat it as an empty one - a ledger that silently reads as empty is a ledger that refuses ' +
      'nothing (the defect recorded in rating/seedBlocks.ts).');
  }
  return {
    ledgerVersion: parsed.ledgerVersion ?? REBASELINE_LEDGER_VERSION,
    entries: parsed.entries,
    // Never defaulted to the computed value: see LEDGER_HEAD_ABSENT.
    headDigest: parsed.headDigest ?? LEDGER_HEAD_ABSENT,
  };
}

/**
 * Writes the ledger with its `headDigest` **recomputed from `entries`**, never copied from the
 * object handed in. A caller that assembled a ledger by hand cannot write a head that disagrees
 * with its own rows, so the only way to produce a mismatch is to edit the file afterwards - which
 * is exactly the event {@link verifyLedgerChain} exists to catch.
 */
export function saveRebaselineLedger(filePath: string, ledger: RebaselineLedger): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const written: RebaselineLedger = {...ledger, headDigest: headDigestOf(ledger)};
  fs.writeFileSync(filePath, JSON.stringify(written, null, 2) + '\n');
}

/**
 * Walks the chain and reports every break. **Run on load, before an append**, so a ledger that has
 * been hand-edited is refused at the moment somebody tries to add to it rather than discovered by a
 * reader long afterwards - which is the whole difference between an audit trail and a log.
 */
export function verifyLedgerChain(ledger: RebaselineLedger): ReadonlyArray<string> {
  const problems: Array<string> = [];
  let expected = LEDGER_GENESIS_DIGEST;
  ledger.entries.forEach((entry, index) => {
    if (entry.previousDigest !== expected) {
      problems.push(
        `entry ${index} (${entry.recordedAt}, '${entry.claim}') chains to ${entry.previousDigest.slice(0, 12)} ` +
        `but the entry before it digests to ${expected.slice(0, 12)} - a row has been edited or removed`);
    }
    expected = digestEntry(entry);
  });

  // The head. The loop above pins every entry to the one before it, which leaves the *last* entry
  // pinned by nothing - see RebaselineLedger.headDigest for why that is the whole ledger on a
  // one-row file. `expected` is now digestEntry(last entry), or genesis if there were none.
  if (ledger.headDigest === LEDGER_HEAD_ABSENT) {
    problems.push(
      'the ledger carries no headDigest, so its most recent entry is pinned by nothing and an edit ' +
      'to that entry would be undetectable. Written before the head check existed, or hand-written.');
  } else if (ledger.headDigest !== expected) {
    problems.push(
      `the ledger's headDigest is ${ledger.headDigest.slice(0, 12)} but its last entry digests to ` +
      `${expected.slice(0, 12)} - the most recent row has been edited`);
  }
  return problems;
}

export type RebaselineRequest = {
  layer: RegressionLayer;
  claim: string | undefined;
  agentCommit: string;
  enginePin: string;
  entriesMoved: number;
  entriesTotal: number;
  fieldsMoved: Readonly<Record<string, number>>;
  corpusDigestBefore: string;
  corpusDigestAfter: string;
  /** Overridable so a spec can assert on a fixed value. Defaults to now. */
  recordedAt?: string;
};

/**
 * Builds the entry and appends it, refusing a missing claim and a broken chain. Returns the updated
 * ledger; **writing it is the caller's step**, so the CLI can print the entry before committing it
 * to disk and so a dry run costs nothing.
 */
export function appendRebaseline(
  ledger: RebaselineLedger | undefined,
  request: RebaselineRequest,
): {ledger: RebaselineLedger; entry: RebaselineEntry} {
  assertRebaselineClaim(request.claim);

  const existing = ledger ?? emptyLedger();
  const problems = verifyLedgerChain(existing);
  if (problems.length > 0) {
    throw new RebaselineError(
      `refusing to append to a rebaseline ledger whose chain is broken:\n  ${problems.join('\n  ')}`);
  }

  const previous = existing.entries[existing.entries.length - 1];
  const entry: RebaselineEntry = {
    recordedAt: request.recordedAt ?? new Date().toISOString(),
    layer: request.layer,
    claim: request.claim.trim(),
    agentCommit: request.agentCommit,
    enginePin: request.enginePin,
    entriesMoved: request.entriesMoved,
    entriesTotal: request.entriesTotal,
    fieldsMoved: request.fieldsMoved,
    previousDigest: previous === undefined ? LEDGER_GENESIS_DIGEST : digestEntry(previous),
    corpusDigestBefore: request.corpusDigestBefore,
    corpusDigestAfter: request.corpusDigestAfter,
  };

  const entries = [...existing.entries, entry];
  return {ledger: {ledgerVersion: existing.ledgerVersion, entries, headDigest: digestEntry(entry)}, entry};
}

/** One line per entry, for the CLI. The two computed numbers lead, because they are the finding. */
export function describeRebaseline(entry: RebaselineEntry): string {
  const fields = Object.entries(entry.fieldsMoved).sort((a, b) => b[1] - a[1]);
  return `${entry.recordedAt} ${entry.layer}: ${entry.entriesMoved}/${entry.entriesTotal} entries moved ` +
    `[${fields.length === 0 ? 'no fields' : fields.map(([field, count]) => `${field} x${count}`).join(', ')}] ` +
    `'${entry.claim}' (${entry.agentCommit.slice(0, 9)})`;
}
