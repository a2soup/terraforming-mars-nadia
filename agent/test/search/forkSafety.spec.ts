import {expect} from 'chai';
import {LEGALITY_COUNTER_NAMES} from '../../src/match/legality';
import {GuardEvidence, measureSpeculationGuard} from '../../src/search/forkProbe';

/**
 * **Criterion G2b: the negative control** (Milestone 2 bullet 2, Unit A; §5).
 *
 * G2's other two parts live elsewhere, because they belong to what they test: G2a (the guard did
 * not change what the instrument counts) is the R8 equivalence in `test/match/legality.spec.ts`,
 * re-run with the guard installed, and G2c (a submission to the live game mid-speculation throws)
 * is in `test/search/speculation.spec.ts`, including one end-to-end case through a real installed
 * `SubmissionMonitor`.
 *
 * This file is the one that could not be written without building something new. §5 states it
 * bluntly - *a test that cannot show the guard doing anything has not tested it* - so
 * `search/forkProbe.ts` provides both halves: an agent that speculates, and a way to run it with
 * the guard deliberately disarmed.
 *
 * **Scale.** Two pairing groups here, which is enough for the difference to be unmistakable and
 * fast enough for the suite. Unit D re-runs {@link measureSpeculationGuard} at validation scale
 * through the same function, so the spec and the evidence cannot disagree about what was measured.
 */
describe('speculation guard: the negative control (G2b)', function() {
  this.timeout(600_000);

  let evidence: GuardEvidence;

  before(async () => {
    evidence = await measureSpeculationGuard(
      {players: 2, lineup: ['fork-probe', 'fork-probe'], groups: 2, startGroup: 4_100},
      {candidates: 4},
    );
  });

  it('hides every speculative submission from the legality accounting', () => {
    // The denominator first: a comparison of two equal numbers proves nothing unless the thing
    // being hidden was real and large.
    expect(evidence.speculativeSubmissions, 'the probe really did speculate').to.be.greaterThan(1_000);
    expect(evidence.speculativeRejections, 'including submissions the Engine rejected').to.be.greaterThan(0);
    // Everything hidden is accounted for, and nothing else is: the probe's own candidates plus the
    // submissions replay itself makes walking an ancestor forward. An unexplained remainder would
    // mean the guard was swallowing real moves.
    expect(evidence.submissionsHidden).to.equal(evidence.speculativeSubmissions + evidence.fork.replaySubmissions);
    // "Large" made concrete: unguarded, the run's submission count is inflated several-fold.
    expect(evidence.counted.submissions).to.be.greaterThan(evidence.guarded.submissions * 2);
  });

  it('reports, guarded, exactly what a non-speculating agent playing the same games reports', () => {
    // G2b's second clause. The probe's live moves come from the same stream `random-legal@1` draws
    // from at the same seed, so it plays those very games - which turns "the guarded figure matches
    // the count of decisions actually played" into an equality on every counter rather than an
    // approximation nobody can check.
    for (const name of LEGALITY_COUNTER_NAMES) {
      expect(evidence.guarded[name], `guarded ${name}`).to.equal(evidence.reference[name]);
    }
    expect(evidence.guardedMatchesReference).to.be.true;
    expect(evidence.reference.submissions, 'and the reference is a real run').to.be.greaterThan(100);
  });

  it('leaves the deliberately-illegal probes out of the rejection counters', () => {
    // The population `onFallback` cannot see and the AC-1 adjudication is stated on. Unguarded these
    // land in `rejectedFallbackProbe`/`rejectedResponder`; guarded they are nowhere, which is the
    // whole point - a promoted agent's search probes are not illegal moves in real games.
    expect(evidence.illegalProbesAccepted, 'the illegal probe really is illegal').to.equal(0);
    const guardedRejections = evidence.guarded.rejectedResponder + evidence.guarded.rejectedFallbackProbe;
    const countedRejections = evidence.counted.rejectedResponder + evidence.counted.rejectedFallbackProbe;
    expect(countedRejections - guardedRejections).to.equal(evidence.speculativeRejections);
    expect(evidence.guarded.rejectedResponder, 'and AC-1\'s own counter stays clean').to.equal(0);
  });

  it('forked for real, and every fork it validated reproduced the live position (G3\'s shape)', () => {
    expect(evidence.fork.direct + evidence.fork.replayed, 'forks obtained').to.be.greaterThan(100);
    expect(evidence.fork.validationFailures, JSON.stringify(evidence.fork.validationFailures)).to.deep.equal({});
    // Game setup has no forkable ancestor at all (see `fork.ts`'s module doc), so unavailable forks
    // are expected and are part of what G3 asks to be *reported* rather than eliminated.
    expect(evidence.fork.noAncestor).to.be.greaterThan(0);
  });
});
