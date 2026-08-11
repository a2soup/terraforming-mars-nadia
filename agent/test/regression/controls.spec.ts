import {expect} from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CONTROLS_FILE,
  ControlChannel,
  MUTATIONS,
  Mutation,
  MutationClass,
  SuiteObservation,
  applyMutation,
  channelsFired,
  loadControlsRecord,
  mutationById,
  revertMutation,
} from '../../src/regression/mutations';
import {dataPath, repoRoot} from '../../src/regression/runner';

/**
 * The negative-control register, and the one thing about it that has to be checked continuously
 * (Milestone 2, bullet 5, Unit D; agent/docs/Milestone2_Bullet5_Prompts.md §5, criterion S1).
 *
 * **This spec deliberately does not run any mutation.** A control run applies an edit inside a
 * throwaway `git worktree`, plays ~310 games and reverts; that is a few minutes per row and it
 * belongs in `mutations.ts run`, not in `npm test`. What belongs here is the property that decays
 * silently between those runs:
 *
 * > **A mutation whose anchor no longer matches its file is not a null result. It is the appearance
 * > of one.**
 *
 * The committed record says row M3 fired nothing. Two milestones from now, after somebody has
 * renamed `MAX_INTERIOR_AMOUNTS` or reflowed the line, that row still says M3 fired nothing - and it
 * now means "we did not run it" while reading as "the suite has a gap there". Every other check in
 * this file is arithmetic; the anchor check is the one with a job.
 *
 * That is the same failure `rating/seedBlocks.ts` records against its own allocation guard, one
 * level up: a check that has stopped being able to refuse anything still reports success.
 */
describe('the negative-control register (criterion S1)', () => {
  /** Criterion S1's eight classes, in its order. Not derived from the register - stated against it. */
  const S1_CLASSES: ReadonlyArray<MutationClass> = [
    'card-effect-amount',
    'bespoke-play',
    'candidate-set-reduction',
    'enumerator-ordering',
    'ranking-tiebreak',
    'vp-breakdown-component',
    'seed-schedule-stride',
    'no-op-control',
  ];

  it('pre-registers all eight of S1\'s classes, and marks anything beyond them as this unit\'s own', () => {
    const preRegistered = MUTATIONS.filter((mutation) => mutation.preRegistered);
    expect(preRegistered.map((mutation) => mutation.class)).to.deep.equal(S1_CLASSES);
    // The rows past the eight are where §7 says the value is. They must never be able to pass
    // themselves off as predictions made before the eight ran.
    expect(MUTATIONS.filter((mutation) => !mutation.preRegistered).length).to.be.greaterThan(0);
  });

  it('carries exactly one no-op control, and it is genuinely a comment', () => {
    const noOps = MUTATIONS.filter((mutation) => mutation.class === 'no-op-control');
    expect(noOps).to.have.length(1);
    // The whole value of the control is that the *only* difference is a comment. Asserting the
    // replacement is the anchor with a comment prepended is what makes that a fact rather than an
    // intention - a no-op that quietly changed something would void every other row (prediction 3).
    expect(noOps[0].replacement.endsWith(noOps[0].anchor)).to.equal(true);
    const prefix = noOps[0].replacement.slice(0, -noOps[0].anchor.length).trim();
    expect(prefix.startsWith('/*')).to.equal(true);
    expect(prefix.endsWith('*/')).to.equal(true);
  });

  it('has unique ids and no mutation that would be a no-op by accident', () => {
    expect(new Set(MUTATIONS.map((mutation) => mutation.id)).size).to.equal(MUTATIONS.length);
    for (const mutation of MUTATIONS) {
      expect(mutation.anchor, `${mutation.id} anchor`).to.not.equal(mutation.replacement);
      expect(mutation.prediction.note.length, `${mutation.id} prediction note`).to.be.greaterThan(80);
    }
  });

  /**
   * The anchor check - see this file's header for why it is the only one that matters.
   *
   * Exactly once, not at least once: a mutation that matched twice would be a wider edit than the
   * row describes, and the row would be attributing whatever fired to the wrong change.
   */
  it('every anchor still occurs exactly once in its target file', () => {
    const root = repoRoot();
    for (const mutation of MUTATIONS) {
      const target = path.join(root, mutation.file);
      expect(fs.existsSync(target), `${mutation.id}: ${mutation.file} does not exist`).to.equal(true);
      const content = fs.readFileSync(target, 'utf8');
      const occurrences = content.split(mutation.anchor).length - 1;
      expect(occurrences, `${mutation.id}: anchor in ${mutation.file}`).to.equal(1);
    }
  });

  it('applies and reverts byte-for-byte, and refuses an anchor that does not match exactly once', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nadia-controls-'));
    try {
      const mutation: Mutation = {
        ...mutationById('M1'),
        file: path.join('src', 'fake', 'Card.ts'),
      };
      const target = path.join(scratch, mutation.file);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      const before = `class Fake {\n  behavior = {\n    ${mutation.anchor}\n  };\n}\n`;
      fs.writeFileSync(target, before);

      const original = applyMutation(scratch, mutation);
      expect(original).to.equal(before);
      expect(fs.readFileSync(target, 'utf8')).to.contain(mutation.replacement);
      revertMutation(scratch, mutation, original);
      expect(fs.readFileSync(target, 'utf8')).to.equal(before);

      // Zero occurrences: the register has rotted, and the run must refuse rather than report a
      // null result for a change it never made.
      fs.writeFileSync(target, 'class Fake {}\n');
      expect(() => applyMutation(scratch, mutation)).to.throw(/occurs 0 time\(s\)/);
      // Two occurrences: the edit is wider than the row claims.
      fs.writeFileSync(target, `${before}${before}`);
      expect(() => applyMutation(scratch, mutation)).to.throw(/occurs 2 time\(s\)/);
    } finally {
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  });

  it('reads a channel as fired from a failed layer, never from a slow or skipped one', () => {
    const clean: SuiteObservation = {
      l1: {status: 'ok', fixtures: 27, failures: []},
      determinism: {status: 'ok', configsChecked: 300, mismatches: 0},
      sections: [
        {key: 'random-legal@1', frozen: true, entriesChecked: 6, entriesMoved: 0, fieldsMoved: {}},
        {key: 'greedy-1ply@1', frozen: true, entriesChecked: 4, entriesMoved: 0, fieldsMoved: {}},
      ],
      movedEntries: [],
      durationMs: 1,
    };
    expect(channelsFired(clean)).to.deep.equal([]);

    // A skipped determinism line is not a fired one. This is the distinction §3.9's
    // `DeterminismCorpusResult.status` exists for, and reading `!== 'ok'` here would score every
    // `--no-determinism` run as a catch.
    expect(channelsFired({...clean, determinism: {status: 'skipped', configsChecked: 0, mismatches: 0}}))
      .to.deep.equal([]);

    const moved: SuiteObservation = {
      ...clean,
      l1: {status: 'failed', fixtures: 27, failures: ['Hackers steals 2 M€ production']},
      sections: [clean.sections[0], {...clean.sections[1], entriesMoved: 3}],
    };
    const expected: ReadonlyArray<ControlChannel> = ['l1', 'l2:greedy-1ply@1'];
    expect(channelsFired(moved)).to.deep.equal(expected);
  });

  /**
   * The committed record, checked against the register rather than against itself.
   *
   * Skipped when the record is absent so a fresh checkout is not red before the controls have been
   * run; present, it must cover every registered row - a register that has grown a mutation nobody
   * ran is a deliverable claiming coverage it does not have.
   */
  it('the committed controls record covers every registered mutation, and the no-op fired nothing', function() {
    const recordPath = dataPath(CONTROLS_FILE);
    if (!fs.existsSync(recordPath)) {
      this.skip();
    }
    const record = loadControlsRecord(recordPath);
    expect(record.results.map((result) => result.id)).to.deep.equal(MUTATIONS.map((mutation) => mutation.id));
    for (const result of record.results) {
      const mutation = mutationById(result.id);
      expect(result.class, `${result.id} class`).to.equal(mutation.class);
      expect(result.predictedChannels, `${result.id} prediction`).to.deep.equal(mutation.prediction.channels);
    }
    // Prediction 3, as a standing assertion rather than a sentence in a document: if the comment-only
    // change ever fires anything, the suite is non-deterministic and every other row here is void.
    const noOp = record.results.find((result) => result.class === 'no-op-control');
    expect(noOp?.firedChannels, 'the no-op control fired a channel - every result in this bullet is void')
      .to.deep.equal([]);
    // The baseline is the row that makes the others legible: an unmutated scratch worktree that does
    // not reproduce its own artifacts would make every "caught" row unattributable.
    expect(channelsFired(record.baseline), 'the unmutated baseline moved something').to.deep.equal([]);
  });
});
