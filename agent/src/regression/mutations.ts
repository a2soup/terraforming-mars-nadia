import {execFileSync, spawnSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {loadRegressionCorpus} from './corpus';
import {
  DEFAULT_CORPUS_FILE,
  SMOKE_CORPUS_FILE,
  dataPath,
  explainEntry,
  repoRoot,
  runSuite,
  silencingRoutineLogs,
} from './runner';

/**
 * **Negative controls: making the regression suite fail on purpose** (Milestone 2, bullet 5,
 * Unit D; agent/docs/Milestone2_Bullet5_Prompts.md §5 criterion S1).
 *
 * ---
 *
 * ## Why this unit exists at all
 *
 * This bullet has two stated failure modes. `ledger.ts` is the whole answer to the first. This file
 * is the whole answer to the second:
 *
 * > **A suite that has never refused anything is indistinguishable from a suite that works.**
 *
 * That is not a hypothetical either. Bullet 3 shipped two guards that had specs, passed them, and
 * had **never once refused a real run** - the seed-block ledger read every real ladder as "no
 * ledger" because its loader was written against a shape that never shipped, and a gate's own
 * reservation blocked the gate. Both were found by *using* the CLI, and neither was found by a spec.
 * So the product of this unit is not the eight green rows saying the suite caught what it was built
 * to catch. **The product is the rows where it did not** - each one is a gap in the deliverable's
 * gap table, and a gap softened into a caveat is this unit failing.
 *
 * ## The register is pre-registered, and that is structural rather than a promise
 *
 * The eight mutation classes of criterion S1 were written down, with their predicted outcomes, in
 * their own commit, **before any of them was run**. {@link MUTATIONS} is that commit's content. The
 * `prediction` field on each row is therefore a falsifiable claim made in advance, not a
 * rationalization of an observed result, and `test/regression/controls.spec.ts` is what stops the
 * register rotting: it asserts every {@link Mutation.anchor} still occurs exactly once in its target
 * file, so a mutation that has quietly stopped applying fails at `npm test` rather than reporting a
 * silent "caught nothing" months later. **A mutation that no longer applies is the most dangerous
 * row this file can carry**: it looks like evidence and is the absence of evidence.
 *
 * Rows past the eight are the ones this unit thought of on its own, and §7 of the plan is explicit
 * that they are where the value is: *"a run that confirms the eight mutations are caught and stops
 * has produced nothing"*. They are marked {@link Mutation.preRegistered} `false` so the record never
 * claims they were predicted before the eight were run - which some of them were not.
 *
 * ## Mutations are applied in a scratch worktree and are never committed
 *
 * Two of the eleven mutate files under `src/`, which SRS CON-1 freezes. That is not a violation and
 * it is worth being precise about why: CON-1 forbids the Agent from *depending on* a modified
 * Engine, and every mutation here exists for the length of one child process inside a throwaway
 * `git worktree`, is reverted byte-for-byte, and is verified reverted by `git status --porcelain`
 * before the next one is applied ({@link runControl}). Nothing under `src/` is modified in the
 * repository, and the file-ownership table (§8) says so in the same words: *mutations are applied in
 * a scratch worktree and reverted, never committed*.
 *
 * The scratch worktree is not fastidiousness. The alternative - mutate in place, revert in a
 * `finally` - loses the race with a crashed process, an interrupted session or a mistaken `git add
 * -A`, and the failure mode is a committed Engine mutation that every subsequent fingerprint in this
 * project is measured against. The worktree makes that outcome unreachable rather than unlikely.
 *
 * ## What "fired" means, and why it is four channels rather than three layers
 *
 * A control run reports which **channels** moved, not which layers, because "L2" is three
 * independently informative things and collapsing them would lose the finding in half the rows:
 *
 * | Channel | What it is | What it can see |
 * | --- | --- | --- |
 * | `l1` | Unit B's reference positions | the Engine at the pin, no agent involved |
 * | `determinism` | the committed 300 fingerprints, invoked not absorbed (§3.9) | `random-legal@1` only, and only through hashes |
 * | `l2:random-legal@1` | the pinned games' section | that agent's games, hashes **and** semantics |
 * | `l2:greedy-1ply@1` | the pinned games' section | the frozen yardstick nothing else in this project covers (§2.1) |
 *
 * The last row is the bullet's whole reason for existing, and two mutations here - M3's
 * candidate-set reduction and M10's candidate reordering - are chosen precisely because
 * `l2:greedy-1ply@1` is the **only** channel of the four that can move on them. Before this bullet
 * there was no such channel, so both would have been silent everywhere.
 */

// ---------------------------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------------------------

/**
 * The class of real change each mutation stands in for. The first eight are criterion S1's list,
 * verbatim and in its order; the rest are this unit's own.
 *
 * **The class is the point, not the edit.** Nobody will ever change `Mine`'s steel production from
 * 1 to 2. The row exists because "somebody changed a `behavior` value on a card" is a thing that
 * happens - an Engine pin move, a merge, a well-meaning fix to a card that reads wrong - and the
 * question the row answers is whether *any* channel would notice.
 */
export type MutationClass =
  | 'card-effect-amount'
  | 'bespoke-play'
  | 'candidate-set-reduction'
  | 'enumerator-ordering'
  | 'ranking-tiebreak'
  | 'vp-breakdown-component'
  | 'seed-schedule-stride'
  | 'no-op-control'
  | 'unreached-card-effect'
  | 'candidate-ordering'
  | 'fallback-branch-order';

/** The four independently informative things a control run can move. See the module doc's table. */
export type ControlChannel = 'l1' | 'determinism' | 'l2:random-legal@1' | 'l2:greedy-1ply@1';

export const CONTROL_CHANNELS: ReadonlyArray<ControlChannel> =
  ['l1', 'determinism', 'l2:random-legal@1', 'l2:greedy-1ply@1'];

export type MutationPrediction = {
  /** Channels predicted to move. Written before the mutation was run; never edited afterwards. */
  channels: ReadonlyArray<ControlChannel>;
  /** Why those and not the others - the reasoning that makes a missed prediction informative. */
  note: string;
};

export type Mutation = {
  /** `M1`..`M11`. Stable: the deliverable's gap table cites these. */
  id: string;
  class: MutationClass;
  /**
   * True for the eight of criterion S1, which were committed with their predictions before any was
   * run. False for the rows this unit added afterwards - so the record cannot later be read as
   * claiming more foresight than it had.
   */
  preRegistered: boolean;
  /** Repo-relative path of the file to edit. */
  file: string;
  /**
   * The exact text to replace. Must occur **exactly once** in {@link file} - enforced by
   * {@link applyMutation} at run time and by `controls.spec.ts` at `npm test` time, because an
   * anchor that has stopped matching turns this row from evidence into the appearance of evidence.
   */
  anchor: string;
  replacement: string;
  /** One line: what the edit does. */
  what: string;
  /** One line: the class of real-world change this stands in for. */
  standsFor: string;
  prediction: MutationPrediction;
  /**
   * A string that must appear in L3's first-divergence window for the localization to have named
   * the right decision. Only meaningful where the mutation has a name a move trace can carry (a
   * card the mutation changes); `undefined` where it does not, and the record says `n/a` rather
   * than scoring it as a miss.
   */
  l3Marker?: string;
};

/**
 * The eleven mutations. **Rows M1-M8 are criterion S1's eight classes and were committed, with
 * their predictions, before any of them ran.** M9-M11 are this unit's own, added while looking
 * deliberately for the thing S1's list cannot produce: a mutation nothing catches.
 */
export const MUTATIONS: ReadonlyArray<Mutation> = [
  {
    id: 'M1',
    class: 'card-effect-amount',
    preRegistered: true,
    file: 'src/server/cards/base/Mine.ts',
    anchor: 'production: {steel: 1},',
    replacement: 'production: {steel: 2},',
    what: 'Mine grants 2 steel production instead of 1.',
    standsFor: 'A declarative `behavior` value on a card changing - the single most likely silent effect of a pin move, and the 204-card declarative tail lost its independent cross-check when AC-8 was withdrawn (`agent/CLAUDE.md` §6).',
    prediction: {
      channels: ['determinism', 'l2:random-legal@1', 'l2:greedy-1ply@1'],
      note: 'Mine is a 4 M€ building card with no requirement, so it is played across the 300 determinism configs and across a 10-game corpus. No L1 fixture asserts Mine - it is not a divergent card - so L1 should stay silent, which is the correct behaviour and not a gap.',
    },
    l3Marker: 'Mine',
  },
  {
    id: 'M2',
    class: 'bespoke-play',
    preRegistered: true,
    file: 'src/server/cards/base/Hackers.ts',
    anchor: '{count: 2, stealing: true}',
    replacement: '{count: 1, stealing: true}',
    what: "Hackers' bespokePlay steals 1 M€ production instead of 2.",
    standsFor: "Imperative card logic changing - the exact effect the Engine's own `Hackers.spec.ts` never asserts, and one of the two §2.3 names whose stated need is to catch a *silent* value regression.",
    prediction: {
      channels: ['l1', 'determinism', 'l2:random-legal@1'],
      note: "L1 must fire: `fixtures/hackers.spec.ts` asserts the steal of 2 directly, and it is the only instrument in the project that does. `greedy-1ply@1` should stay silent - Hackers is -1 VP, and a points-now chooser never plays it - which if observed is the sharpest available demonstration that a seed cannot assert a card (§3.2).",
    },
    l3Marker: 'Hackers',
  },
  {
    id: 'M3',
    class: 'candidate-set-reduction',
    preRegistered: true,
    file: 'agent/src/core/candidates/simple.ts',
    anchor: 'const MAX_INTERIOR_AMOUNTS = 6;',
    replacement: 'const MAX_INTERIOR_AMOUNTS = 3;',
    what: "An `amount` candidate set carries 3 interior values instead of 6.",
    standsFor: 'A candidate-set reduction - named in bullet 2 as one of the changes that makes `greedy-1ply@1` a **new version rather than an improvement**, and exactly the kind of edit that reads as harmless tuning in a diff.',
    prediction: {
      channels: ['l2:greedy-1ply@1'],
      note: 'Only `greedy-1ply@1` reads `core/candidates/`; the random-legal agent samples through `core/enumerator/` and cannot see this. Fires only if some `amount` decision in the four greedy games has a span above 4, which is not guaranteed at 10 games - a miss here is a coverage gap, not a suite defect.',
    },
  },
  {
    id: 'M4',
    class: 'enumerator-ordering',
    preRegistered: true,
    file: 'agent/src/core/enumerator/simple.ts',
    anchor: 'return {type: \'space\', spaceId: rng.pick(model.spaces)};',
    replacement: 'return {type: \'space\', spaceId: rng.pick([...model.spaces].reverse())};',
    what: 'The space enumerator samples from the offered list reversed - the same legal set, a different element.',
    standsFor: 'An ordering change that preserves the legal set. The loudest class in the list, and the control that proves the quiet rows below are quiet for a reason rather than because nothing is wired up.',
    prediction: {
      channels: ['determinism', 'l2:random-legal@1', 'l2:greedy-1ply@1'],
      note: 'Every random-legal game places tiles, so all 300 determinism configs and both random-legal pinned groups should move. `greedy-1ply@1` should move too, but through a narrower path: its unforkable opening and its ~2% fallback both route through the random-legal agent (bullet 2).',
    },
  },
  {
    id: 'M5',
    class: 'ranking-tiebreak',
    preRegistered: true,
    file: 'agent/src/match/ranking.ts',
    anchor: 'b.victoryPoints - a.victoryPoints || b.megaCredits - a.megaCredits',
    replacement: 'b.victoryPoints - a.victoryPoints',
    what: "The winner rule drops its megacredit tiebreak, so seats tied on VP tie outright.",
    standsFor: "`match/ranking.ts` is the only implementation of the game's real winner rule in this repository (`GameEnd.vue` is the other, and it is client-side). A change here silently restates who won.",
    prediction: {
      channels: [],
      note: 'Predicted **uncaught**. No fingerprint reads `rankGame` - `resultHash` hashes `computeResult`, which ranks on VP alone - so this can only surface as a `placement`/`isWinner` diff in an entry whose game actually has a VP tie between two seats. At 10 pinned games that is unlikely. This row is expected to be a gap, and the honest statement of it is that the suite covers the ranking only where a tie happens to occur.',
    },
  },
  {
    id: 'M6',
    class: 'vp-breakdown-component',
    preRegistered: true,
    file: 'src/server/game/calculateVictoryPoints.ts',
    anchor: 'builder.setVictoryPoints(\'city\', 1);',
    replacement: 'builder.setVictoryPoints(\'greenery\', 1);',
    what: 'City-adjacency victory points are attributed to the greenery component instead of the city component. **Every total is unchanged.**',
    standsFor: 'A VP-breakdown component moving without the total moving - the case §3.3 committed the semantic fields for, and the one a corpus of hashes cannot see by construction.',
    prediction: {
      channels: ['l2:random-legal@1', 'l2:greedy-1ply@1'],
      note: 'The determinism corpus must stay silent, and that is the finding rather than a shortcoming: `stableState` is the *serialized* game and the breakdown is computed, `resultHash` carries VP totals only, and every total here is identical. So the four hashes cannot move and only `semantics.seats[].vpBreakdown.{city,greenery}` can. If this row comes back with semantic fields moved and zero fingerprint fields moved, §3.3 has paid for itself in one line.',
    },
  },
  {
    id: 'M7',
    class: 'seed-schedule-stride',
    preRegistered: true,
    file: 'agent/src/match/pairing.ts',
    anchor: 'export const AGENT_SEED_SLOT_STRIDE = 149;',
    replacement: 'export const AGENT_SEED_SLOT_STRIDE = 151;',
    what: 'Lineup slots are spaced 151 apart in the agent-seed schedule instead of 149, so every slot above 0 gets a different seed.',
    standsFor: 'The seed schedule changing under a committed corpus - which would silently redefine what every pinned identity means while leaving the identities themselves looking correct.',
    prediction: {
      channels: ['l2:random-legal@1', 'l2:greedy-1ply@1'],
      note: 'The determinism corpus derives its own seeds (`500,000 + 977k`) and never touches `match/pairing.ts`, so it cannot see this - which is precisely why L2 pins group indices and derives seeds rather than writing them down (§2.6, hazard H5). Slot 0 is unmoved (`149 x 0 === 151 x 0`), so any entry whose game is decided by seat 0 alone could in principle survive; none is expected to.',
    },
  },
  {
    id: 'M8',
    class: 'no-op-control',
    preRegistered: true,
    file: 'src/server/cards/base/Mine.ts',
    anchor: 'export class Mine extends Card implements IProjectCard {',
    replacement: '/* Unit D no-op control (M8): a comment-only change, applied in a scratch worktree and reverted. */\nexport class Mine extends Card implements IProjectCard {',
    what: 'A comment is added to the same file M1 mutates. Nothing else changes.',
    standsFor: 'Nothing. This is the control on the controls, and it is deliberately in M1\'s file so that "M1 fired" and "editing that file fires" are distinguishable.',
    prediction: {
      channels: [],
      note: '**Nothing may fire. A single moved channel here is a blocking failure and voids every other result in this bullet** (criterion S1, falsifiable prediction 3): it would mean the suite is non-deterministic, and a non-deterministic suite cannot distinguish a real regression from itself.',
    },
  },
  {
    id: 'M9',
    class: 'unreached-card-effect',
    preRegistered: false,
    file: 'src/server/cards/base/AntiGravityTechnology.ts',
    anchor: 'cardDiscount: {amount: 2},',
    replacement: 'cardDiscount: {amount: 3},',
    what: 'Anti-Gravity Technology discounts cards by 3 M€ instead of 2.',
    standsFor: 'A card-effect change on a line the corpus does not reach. Chosen on measured evidence rather than guessed: `card_play_coverage.json` records Anti-Gravity Technology played **0 times in 1,500 games** (§2.4), because it requires 7 science tags.',
    prediction: {
      channels: [],
      note: 'Predicted **uncaught by every channel**, and deliberately so - this is falsifiable prediction 2 ("at least one will be a card-effect change on a line the corpus does not reach") built as an experiment rather than waited for. A suite cannot catch a change to code it never executes, and the honest response is the hole list (S3), not a hand-built game that reaches it (hazard H11).',
    },
  },
  {
    id: 'M10',
    class: 'candidate-ordering',
    preRegistered: false,
    file: 'agent/src/core/candidates/simple.ts',
    anchor: 'return {candidates: model.spaces.map((spaceId) => ({type: \'space\', spaceId}))};',
    replacement: 'return {candidates: [...model.spaces].reverse().map((spaceId) => ({type: \'space\', spaceId}))};',
    what: "The space candidate set is generated in reverse order. The set is identical; only its order changes.",
    standsFor: "§2.1's gap, made concrete. `greedy-1ply@1` tie-breaks 75.9% of its scored decisions at a median spread of 0 VP (bullet 2), so a pure reordering of a candidate list changes which move it plays. Nothing but a pinned `greedy-1ply@1` game can see it.",
    prediction: {
      channels: ['l2:greedy-1ply@1'],
      note: 'Exactly one channel, and it is the one that did not exist before this bullet. The determinism corpus is `random-legal@1`-only by construction (`replay.ts:140` hard-coded it), L1 is agent-independent, and the random-legal agent never reads `core/candidates/`. If this row comes back caught by one channel, that channel is the whole answer to "what did bullet 5 add that bullets 1-4 did not have".',
    },
  },
  {
    id: 'M11',
    class: 'fallback-branch-order',
    preRegistered: false,
    file: 'agent/src/driver/embeddedDriver.ts',
    anchor: '  for (const {option, index} of eligible) {',
    replacement: '  for (const {option, index} of [...eligible].reverse()) {',
    what: "The FR-9 conservative fallback tries an 'or' decision's eligible branches last-first instead of first-first, so a fallback-resolved decision resolves differently.",
    standsFor: "The one blind spot the record documents rather than hides: *`moveTraceHash` has no step for a decision the responder threw on* (`agent/CLAUDE.md` §6, and `RegressionFingerprints`' own doc), because `replay()` records **after** the responder returns. A divergence confined to fallback-resolved decisions is invisible to the trace hash.",
    prediction: {
      channels: ['determinism', 'l2:random-legal@1', 'l2:greedy-1ply@1'],
      note: 'The interesting question is not *whether* this is caught but *which field* catches it. The blind spot is real but narrower than the sentence suggests: a fallback that changes the game state changes the `pendingSignature` folded into every **later** recorded step, so the trace hash moves anyway - just not at the decision that caused it. The prediction is that `moveTraceHash` moves and L3 localizes to the wrong place, i.e. to the first *recorded* decision after the fallback rather than to the fallback. The pinned entries carry 0-6 fallbacks each, so there are live targets.',
    },
  },
];

export function mutationById(id: string): Mutation {
  const mutation = MUTATIONS.find((candidate) => candidate.id === id);
  if (mutation === undefined) {
    throw new Error(`no mutation '${id}' is registered. The register carries ${MUTATIONS.map((m) => m.id).join(', ')}.`);
  }
  return mutation;
}

// ---------------------------------------------------------------------------------------------
// Applying and reverting
// ---------------------------------------------------------------------------------------------

/**
 * Replaces {@link Mutation.anchor} with {@link Mutation.replacement} in `root`'s copy of the target
 * file, and returns the original content so the caller can restore it byte-for-byte.
 *
 * **Refuses anything but exactly one occurrence.** Zero means the register has rotted and the row is
 * about to report "caught nothing" for a mutation that was never applied - the most dangerous
 * outcome available to this unit, because it is indistinguishable in the record from a real gap.
 * Two or more means the edit is not the edit the row describes.
 */
export function applyMutation(root: string, mutation: Mutation): string {
  const target = path.join(root, mutation.file);
  const original = fs.readFileSync(target, 'utf8');
  const occurrences = original.split(mutation.anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${mutation.id}: its anchor occurs ${occurrences} time(s) in ${mutation.file}, and a mutation is only ` +
      'evidence if it applied exactly once. Zero occurrences means the register has rotted against the code ' +
      'and this row would have reported "caught nothing" for a change that was never made; more than one ' +
      `means the edit is wider than the row claims. Anchor: ${JSON.stringify(mutation.anchor)}`);
  }
  fs.writeFileSync(target, original.replace(mutation.anchor, mutation.replacement));
  return original;
}

/** Restores the file byte-for-byte. Paired with {@link assertTreeClean}, which is the real check. */
export function revertMutation(root: string, mutation: Mutation, original: string): void {
  fs.writeFileSync(path.join(root, mutation.file), original);
}

/**
 * Fails unless `root`'s working tree is identical to its HEAD.
 *
 * Run **before** applying and **after** reverting, every time. Restoring a string the harness itself
 * captured proves only that the harness did what it meant to; asking git proves the tree is what the
 * repository says it is, which is the property that actually matters for a unit whose edits must
 * never reach a commit.
 */
export function assertTreeClean(root: string, context: string): void {
  const status = execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim();
  if (status !== '') {
    throw new Error(
      `${context}: the mutation worktree at ${root} is not clean, so a mutation may still be applied. ` +
      `Refusing to continue - every result taken from here on would be attributed to the wrong change.\n${status}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The scratch worktree
// ---------------------------------------------------------------------------------------------

/**
 * Creates the throwaway `git worktree` every mutation is applied in, at `HEAD`, and links the
 * repository's `node_modules` into it.
 *
 * The symlink is the only non-obvious part. A fresh worktree has no `node_modules`, `npm install`
 * costs minutes and 242 MB, and nothing this unit runs cares whether the directory is real or a
 * link - `tsx` resolves through it identically. It is also why the scratch tree can be created and
 * destroyed per session without anybody thinking twice about the cost, which is what keeps the
 * "never mutate in place" rule cheap enough to actually follow.
 */
export function createScratchWorktree(root: string, target: string, ref: string = 'HEAD'): void {
  removeScratchWorktree(root, target);
  execFileSync('git', ['worktree', 'add', '--detach', target, ref], {cwd: root, stdio: 'pipe'});
  const modules = path.join(root, 'node_modules');
  const linked = fs.existsSync(modules) ? fs.realpathSync(modules) : path.join(root, 'node_modules');
  fs.symlinkSync(linked, path.join(target, 'node_modules'));
}

export function removeScratchWorktree(root: string, target: string): void {
  spawnSync('git', ['worktree', 'remove', '--force', target], {cwd: root, stdio: 'ignore'});
  fs.rmSync(target, {recursive: true, force: true});
  spawnSync('git', ['worktree', 'prune'], {cwd: root, stdio: 'ignore'});
}

// ---------------------------------------------------------------------------------------------
// Observing one suite run
// ---------------------------------------------------------------------------------------------

/**
 * What one run of the suite reports, reduced to the things a control row is scored on.
 *
 * **Produced by this module running as a child process inside the scratch worktree**
 * ({@link observe}, invoked as `tsx src/regression/mutations.ts observe`), and emitted as JSON on a
 * marked line. A child process is not optional: the mutated code has to be *loaded*, and the parent
 * process has the unmutated modules already resolved. Emitting JSON rather than scraping the CLI's
 * prose is not optional either - a control table built by regex over a report is a table that
 * changes meaning when somebody rewords a log line.
 */
export type SuiteObservation = {
  l1: {status: string; fixtures: number; failures: ReadonlyArray<string>};
  determinism: {status: string; configsChecked: number; mismatches: number};
  sections: ReadonlyArray<{
    key: string;
    frozen: boolean;
    entriesChecked: number;
    entriesMoved: number;
    fieldsMoved: Readonly<Record<string, number>>;
  }>;
  /** Every entry that moved, with its moved field paths split the way §3.3 splits them. */
  movedEntries: ReadonlyArray<{
    key: string;
    why: string;
    fingerprintFields: ReadonlyArray<string>;
    semanticFields: ReadonlyArray<string>;
    failure?: string;
  }>;
  /** L3 run over the first moved entry - the localization claim this unit scores (S1). */
  explain?: L3Observation;
  durationMs: number;
};

export type L3Observation = {
  key: string;
  traceMoved: boolean;
  lastAgreedDecision?: number;
  firstDisagreedDecision?: number;
  windowSize?: number;
  /**
   * Did the bracketed window contain the mutation's {@link Mutation.l3Marker}? Absent when the
   * mutation has no name a move trace can carry - which is every agent-side row, and scoring those
   * as misses would manufacture a gap that does not exist.
   */
  markerInWindow?: boolean;
  /** The first few decisions in the bracketed window, truncated - what a reader is handed. */
  windowHead: ReadonlyArray<string>;
  note?: string;
};

const OBSERVATION_MARKER = '##CONTROL-OBSERVATION##';

/**
 * Runs the whole suite in this process and reduces it to a {@link SuiteObservation}.
 *
 * `l3Marker` is passed through so the localization window can be searched for it here, where the
 * trace is in memory, rather than being carried back to the parent as a few hundred kilobytes of
 * step strings.
 */
export async function observe(corpusFile: string, marker?: string): Promise<SuiteObservation> {
  const corpusPath = dataPath(corpusFile);
  const corpus = loadRegressionCorpus(corpusPath);
  const result = await runSuite({layers: ['l1', 'l2'], corpus});

  const l2 = result.l2;
  const movedEntries = (l2?.sections ?? []).flatMap((section) => section.diffs.map((diff) => ({
    key: `${diff.identity.agent}@${diff.identity.agentVersion}/${diff.identity.players}p/g${diff.identity.groupIndex}/p${diff.identity.permutationIndex}`,
    why: diff.why,
    fingerprintFields: diff.diffs.filter((field) => field.group === 'fingerprint').map((field) => field.path),
    semanticFields: diff.diffs.filter((field) => field.group === 'semantics').map((field) => field.path),
    ...(diff.failure === undefined ? {} : {failure: `${diff.failure.errorClass}: ${diff.failure.message.split('\n')[0]}`}),
  })));

  /**
   * The entry L3 is asked to localize, and it is deliberately **not** simply the first moved one.
   *
   * L3's localization brackets a divergence in the *move trace*, so an entry that moved without its
   * trace moving has nothing to localize - and the first control run found that this is not a corner
   * case: M1 changed a card's steel production, and the first moved random-legal entry diverged on
   * `stableStateHash` alone, its 295 decisions byte-identical. Scoring L3 against that entry would
   * have recorded "no trace move" for a mutation whose *other* entries the trace caught perfectly
   * well, i.e. would have manufactured a gap out of an entry-selection accident.
   *
   * So: the first entry whose trace moved, falling back to the first moved entry when none did -
   * because "nothing here can be localized" is a real answer and must not be silently skipped.
   */
  const localizable = movedEntries.find((entry) => entry.fingerprintFields.includes('fingerprints.moveTraceHash')) ??
    movedEntries[0];

  const observation: SuiteObservation = {
    l1: {
      status: result.l1?.status ?? 'not-run',
      fixtures: result.l1?.fixtures ?? 0,
      failures: (result.l1?.failures ?? []).map((failure) => failure.title),
    },
    determinism: {
      status: l2?.determinismCorpus.status ?? 'not-run',
      configsChecked: l2?.determinismCorpus.configsChecked ?? 0,
      mismatches: l2?.determinismCorpus.mismatches ?? 0,
    },
    sections: (l2?.sections ?? []).map((section) => ({
      key: `${section.agent}@${section.agentVersion}`,
      frozen: section.frozen,
      entriesChecked: section.entriesChecked,
      entriesMoved: section.entriesMoved,
      fieldsMoved: section.fieldsMoved,
    })),
    movedEntries,
    durationMs: result.durationMs,
    ...(localizable === undefined ? {} : {explain: explainFirstMoved(corpus, localizable.key, marker)}),
  };
  return observation;
}

function explainFirstMoved(corpus: Parameters<typeof explainEntry>[0], key: string, marker?: string): L3Observation {
  const explanation = silencingRoutineLogs(() => explainEntry(corpus, key));
  const located = explanation.firstDivergence;
  const window = located?.window ?? [];
  return {
    key,
    traceMoved: explanation.diffs.some((diff) => diff.path === 'fingerprints.moveTraceHash'),
    ...(located === undefined ? {} : {
      lastAgreedDecision: located.lastAgreedDecision,
      ...(located.firstDisagreedDecision === undefined ? {} : {firstDisagreedDecision: located.firstDisagreedDecision}),
      windowSize: window.length,
    }),
    // Searched over the **whole** window, not over the truncated head recorded beside it: a
    // `pendingSignature` prefix is long enough to push a card name past any sane display cut, and
    // scoring the localization against what happens to fit on screen would be scoring the formatter.
    ...(marker === undefined ? {} : {markerInWindow: window.some((step) => step.stepInput.includes(marker))}),
    windowHead: window.slice(0, 6).map((step) => `#${step.index} ${step.stepInput.slice(0, 300)}`),
    ...(explanation.localizationNote === undefined ? {} : {note: explanation.localizationNote}),
  };
}

// ---------------------------------------------------------------------------------------------
// Running one control
// ---------------------------------------------------------------------------------------------

/** One mutation's row in the record. */
export type ControlResult = {
  id: string;
  class: MutationClass;
  preRegistered: boolean;
  file: string;
  what: string;
  standsFor: string;
  predictedChannels: ReadonlyArray<ControlChannel>;
  predictionNote: string;
  /** Measured. The channels that actually moved. */
  firedChannels: ReadonlyArray<ControlChannel>;
  /** `caught` iff at least one channel moved. The no-op control inverts this - see `verdict`. */
  caught: boolean;
  /** `as-predicted` | `caught-more` | `caught-less` | `blocking-failure` (the no-op control firing). */
  verdict: 'as-predicted' | 'caught-more' | 'caught-less' | 'blocking-failure';
  observation: SuiteObservation;
  /**
   * Did L3's first-divergence bracket contain a decision naming the mutated card? `n/a` where the
   * mutation has no name a move trace can carry, which is every agent-side row - scoring those as
   * misses would manufacture a gap that does not exist.
   */
  l3: 'named-it' | 'missed-it' | 'n/a' | 'no-trace-move';
  wallClockMs: number;
};

export type RunControlOptions = {
  /** The scratch worktree. **Never the repository's own root** - see the module doc. */
  scratch: string;
  corpusFile: string;
};

/**
 * Applies one mutation in the scratch worktree, runs the whole suite there in a child process,
 * reverts, and scores the row.
 *
 * The order is: assert clean, apply, run, **revert in a `finally`**, assert clean again. The second
 * assertion is not redundant with the first - it is what turns "the harness intended to revert" into
 * "the tree is what HEAD says it is", and it runs before the next mutation is applied so a leak is
 * attributed to the mutation that leaked rather than to the next one's results.
 */
export function runControl(mutation: Mutation, options: RunControlOptions): ControlResult {
  const {scratch, corpusFile} = options;
  assertTreeClean(scratch, `${mutation.id}: before applying`);

  const started = Date.now();
  const original = applyMutation(scratch, mutation);
  let observation: SuiteObservation;
  try {
    observation = observeInScratch(scratch, corpusFile, mutation.l3Marker);
  } finally {
    revertMutation(scratch, mutation, original);
  }
  assertTreeClean(scratch, `${mutation.id}: after reverting`);

  const firedChannels = channelsFired(observation);
  const predicted = [...mutation.prediction.channels].sort();
  const fired = [...firedChannels].sort();
  const missed = predicted.filter((channel) => !fired.includes(channel));
  const extra = fired.filter((channel) => !predicted.includes(channel));

  return {
    id: mutation.id,
    class: mutation.class,
    preRegistered: mutation.preRegistered,
    file: mutation.file,
    what: mutation.what,
    standsFor: mutation.standsFor,
    predictedChannels: mutation.prediction.channels,
    predictionNote: mutation.prediction.note,
    firedChannels,
    caught: firedChannels.length > 0,
    verdict: mutation.class === 'no-op-control' && firedChannels.length > 0 ? 'blocking-failure' :
      missed.length === 0 && extra.length === 0 ? 'as-predicted' :
        missed.length > 0 ? 'caught-less' : 'caught-more',
    observation,
    l3: scoreL3(mutation, observation),
    wallClockMs: Date.now() - started,
  };
}

/** Which of the four channels moved. A failing L1 fixture and a moved L2 section both count. */
export function channelsFired(observation: SuiteObservation): ReadonlyArray<ControlChannel> {
  const fired: Array<ControlChannel> = [];
  if (observation.l1.status === 'failed') {
    fired.push('l1');
  }
  if (observation.determinism.status === 'failed') {
    fired.push('determinism');
  }
  for (const section of observation.sections) {
    if (section.entriesMoved > 0 && CONTROL_CHANNELS.includes(`l2:${section.key}` as ControlChannel)) {
      fired.push(`l2:${section.key}` as ControlChannel);
    }
  }
  return fired;
}

function scoreL3(mutation: Mutation, observation: SuiteObservation): ControlResult['l3'] {
  if (mutation.l3Marker === undefined) {
    return 'n/a';
  }
  const explain = observation.explain;
  if (explain === undefined || !explain.traceMoved) {
    return 'no-trace-move';
  }
  return explain.markerInWindow === true ? 'named-it' : 'missed-it';
}

/**
 * Spawns this module's `observe` mode in the scratch worktree and reads the JSON back off the
 * marked line.
 *
 * The suite prints the Engine's per-game eviction notice and its own report to stdout, so the
 * observation is found by its marker rather than by parsing the stream - the same technique
 * `runner.ts` uses to find mocha's JSON report among the specs' own output, and for the same reason.
 */
function observeInScratch(scratch: string, corpusFile: string, marker?: string): SuiteObservation {
  const result = spawnSync(process.execPath, [
    path.join(scratch, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(scratch, 'agent', 'src', 'regression', 'mutations.ts'),
    'observe', '--corpus-file', corpusFile,
    ...(marker === undefined ? [] : ['--marker', marker]),
  ], {cwd: path.join(scratch, 'agent'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});

  const line = (result.stdout ?? '').split('\n').find((candidate) => candidate.startsWith(OBSERVATION_MARKER));
  if (line === undefined) {
    throw new Error(
      `the observation run in ${scratch} produced no ${OBSERVATION_MARKER} line (exit ${result.status}). ` +
      'A control whose suite run did not complete is not a "caught nothing" row - it is no row at all.\n' +
      `${(result.stderr ?? '').slice(-4_000)}`);
  }
  return JSON.parse(line.slice(OBSERVATION_MARKER.length)) as SuiteObservation;
}

// ---------------------------------------------------------------------------------------------
// The committed record
// ---------------------------------------------------------------------------------------------

/**
 * One full pass of the register against one corpus.
 *
 * **The record carries a run per corpus rather than one run, and the reason is the finding.** The
 * same eleven mutations were put through Unit A's 10-game smoke corpus (selected to exercise the
 * *format*) and Unit C's 33-game corpus (selected to exercise *coverage*), and the difference
 * between the two `firedChannels` columns is the only direct measurement anywhere in this bullet of
 * **what selection buys**. A gap that closes between the two rows closed because the corpus reached
 * further; a gap that survives both is a gap in the instrument rather than in the sample, and those
 * are different rows in the deliverable's gap table with different responses.
 *
 * Collapsing the two into "the controls were run" would delete exactly that distinction, which is
 * the same mistake §3.3 refuses when it commits the fields instead of a hash of the fields.
 */
export type ControlRun = {
  /** `regression_smoke.json` (Unit A) or `regression_suite.json` (Unit C). */
  corpusFile: string;
  /** What the corpus was selected for - the thing that makes the two runs comparable at all. */
  corpusRole: string;
  corpusEntries: number;
  /** The unmutated run. If this is not clean, no row taken from it is attributable. */
  baseline: SuiteObservation;
  results: ReadonlyArray<ControlResult>;
};

export type ControlsRecord = {
  recordedAt: string;
  enginePin: string;
  agentCommit: string;
  /** The `sysctl vm.swapusage` reading, because no timing here is a performance figure (hazard H6). */
  hostNote: string;
  runs: ReadonlyArray<ControlRun>;
};

export const CONTROLS_FILE = 'regression_controls.json';

/**
 * Writes the record, replacing any run already present for the same corpus rather than appending a
 * second one - so re-running a corpus updates its row instead of quietly leaving two answers to the
 * same question in the file, which is the shape of artifact nobody can act on.
 */
export function saveControlsRecord(filePath: string, record: ControlsRecord): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n');
}

/**
 * Folds a run into the record: a run for a corpus not yet present is appended, and one for a corpus
 * already present has its **rows merged by mutation id**, newest winning, then re-sorted into
 * {@link MUTATIONS} order.
 *
 * Row-level rather than run-level merging exists because `--only` is how a single row gets re-run,
 * and the naive "replace the run" would silently drop the ten rows that were not re-run - leaving a
 * record that reads as a complete pass and is not one. That is the same class of error as a mutation
 * whose anchor stopped matching: the artifact looks like evidence.
 */
export function mergeRun(existing: ControlsRecord | undefined, base: Omit<ControlsRecord, 'runs'>, run: ControlRun): ControlsRecord {
  const previous = (existing?.runs ?? []).find((candidate) => candidate.corpusFile === run.corpusFile);
  const others = (existing?.runs ?? []).filter((candidate) => candidate.corpusFile !== run.corpusFile);

  const byId = new Map((previous?.results ?? []).map((result) => [result.id, result]));
  for (const result of run.results) {
    byId.set(result.id, result);
  }
  const order = MUTATIONS.map((mutation) => mutation.id);
  const results = [...byId.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return {...base, runs: [...others, {...run, results}]};
}

export function loadControlsRecord(filePath: string): ControlsRecord {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ControlsRecord;
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

/**
 *   List the register, with each row's pre-registered prediction:
 *     npx tsx src/regression/mutations.ts list
 *
 *   Run every control (or a named subset), against Unit A's smoke corpus by default:
 *     npx tsx src/regression/mutations.ts run
 *     npx tsx src/regression/mutations.ts run --only M6,M10 --corpus-file regression_suite.json
 *
 *   The child-process mode, not invoked by hand:
 *     npx tsx src/regression/mutations.ts observe
 *
 * There is no `npm run` script for this. `agent/package.json` is Unit A's alone (§8), and a
 * negative-control harness that is run once per bullet does not need to be one command away from
 * somebody's muscle memory.
 */
async function main(argv: ReadonlyArray<string>): Promise<void> {
  const mode = argv[0] ?? 'list';
  let only: ReadonlyArray<string> | undefined;
  let corpusFile = SMOKE_CORPUS_FILE;
  let corpusRole = 'Unit A\'s smoke corpus - selected to exercise the record format, not coverage';
  let out = dataPath(CONTROLS_FILE);
  let worktreeRef = 'HEAD';
  let marker: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
    case '--only':
      only = (argv[++i] ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '');
      break;
    case '--corpus-file':
      corpusFile = argv[++i] ?? SMOKE_CORPUS_FILE;
      break;
    case '--corpus-role':
      corpusRole = argv[++i] ?? corpusRole;
      break;
    case '--worktree-ref':
      // The scratch worktree is checked out at this ref instead of HEAD. Unit D's final controls run
      // against **Unit C's** committed corpus (§ Unit D preamble), which lives on C's branch: this
      // lets the run reach it without merging another unit's work into D's, which §8 does not give
      // D the standing to do.
      worktreeRef = argv[++i] ?? worktreeRef;
      break;
    case '--marker':
      marker = argv[++i];
      break;
    case '--out':
      out = argv[++i] ?? out;
      break;
    default:
      throw new Error(`Unrecognized argument: ${argv[i]}`);
    }
  }

  if (mode === 'observe') {
    const observation = await observe(corpusFile, marker);
    console.log(`${OBSERVATION_MARKER}${JSON.stringify(observation)}`);
    return;
  }

  if (mode === 'list') {
    for (const mutation of MUTATIONS) {
      const predicted = mutation.prediction.channels.length === 0 ? 'nothing' : mutation.prediction.channels.join(', ');
      console.log(`${mutation.id} ${mutation.class}${mutation.preRegistered ? '' : ' (added by Unit D)'}`);
      console.log(`   ${mutation.file}: ${mutation.what}`);
      console.log(`   predicts: ${predicted}`);
    }
    return;
  }

  if (mode !== 'run') {
    throw new Error(`unknown mode '${mode}'. Use list, run, or observe.`);
  }

  const root = repoRoot();
  const scratch = path.join(path.dirname(root), `${path.basename(root)}-mutation-scratch`);
  const selected = only === undefined ? MUTATIONS : only.map(mutationById);

  console.log(`[controls] scratch worktree: ${scratch} (at ${worktreeRef}, corpus ${corpusFile})`);
  createScratchWorktree(root, scratch, worktreeRef);
  try {
    assertTreeClean(scratch, 'before the baseline');
    console.log('[controls] baseline (no mutation applied) ...');
    const baseline = observeInScratch(scratch, corpusFile);
    if (channelsFired(baseline).length > 0) {
      throw new Error(
        'the unmutated scratch worktree does not reproduce its own committed artifacts, so no control run ' +
        `from it would mean anything. Fired: ${channelsFired(baseline).join(', ')}`);
    }
    console.log(`[controls] baseline clean in ${(baseline.durationMs / 1_000).toFixed(1)}s`);

    const results: Array<ControlResult> = [];
    for (const mutation of selected) {
      process.stdout.write(`[controls] ${mutation.id} ${mutation.class} ... `);
      const result = runControl(mutation, {scratch, corpusFile});
      results.push(result);
      console.log(`${result.verdict}: fired [${result.firedChannels.join(', ') || 'nothing'}] ` +
        `(predicted [${result.predictedChannels.join(', ') || 'nothing'}], l3 ${result.l3}, ` +
        `${(result.wallClockMs / 1_000).toFixed(1)}s)`);
    }

    const record = mergeRun(
      fs.existsSync(out) ? loadControlsRecord(out) : undefined,
      {
        recordedAt: new Date().toISOString(),
        enginePin: '868714d72a434ab68fe08e5570ebc6863859ae15',
        agentCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
        // Recorded on every run because Unit A measured the same call at 11 s and at 124 s in one
        // session on this host, and criterion S6 is not adjudicable from a machine in that state
        // (hazard H6). No duration in this file is a performance figure.
        hostNote: execFileSync('sysctl', ['vm.swapusage'], {encoding: 'utf8'}).trim(),
      },
      {
        corpusFile,
        corpusRole,
        corpusEntries: baseline.sections.reduce((count, section) => count + section.entriesChecked, 0),
        baseline,
        results,
      });
    saveControlsRecord(out, record);
    console.log(`[controls] wrote ${results.length} row(s) for ${corpusFile} to ${out} ` +
      `(${record.runs.length} run(s) in the record)`);
  } finally {
    removeScratchWorktree(root, scratch);
  }
}

/* c8 ignore start - the module-as-script guard; the register and the apply/revert path are specced. */
if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[controls] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
/* c8 ignore stop */

export {DEFAULT_CORPUS_FILE, SMOKE_CORPUS_FILE};
