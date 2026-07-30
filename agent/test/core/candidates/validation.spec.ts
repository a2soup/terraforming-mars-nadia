import {expect} from 'chai';
import {IN_SCOPE_TYPES} from '../../../src/core/candidates';
import {buildCandidateValidationConfigs, runCandidateValidation} from '../../../src/core/candidates/validation';

/**
 * A miniature of the G1a/G1c corpus run, so the criterion is a standing check and not only a
 * one-off CLI invocation somebody has to remember to re-run. The full pre-committed corpus is
 * >= 200 games (`npm run candidates`); this is two, with the per-decision probing subsampled, so
 * it stays inside a normal `npm test`.
 *
 * What it asserts is exactly what G1a asserts, at 1% of the scale: every candidate generated at
 * every decision of a real game is accepted by the Engine's own `process()` on first submission.
 * A regression that makes any generator produce an illegal move fails here in seconds rather
 * than in a Unit D run hours later.
 */
describe('candidate enumeration: the G1a corpus (miniature)', function() {
  // Two full games, forking at every decision point - seconds, not milliseconds.
  this.timeout(120_000);

  it('every candidate is accepted by the Engine on first submission', async () => {
    const configs = buildCandidateValidationConfigs([{players: 2, games: 1}, {players: 3, games: 1}]);
    const report = await runCandidateValidation(configs, {maxCandidatesPerDecision: 6});

    expect(report.failedGames, JSON.stringify(report.failedGames)).to.be.empty;
    expect(report.gamesCompleted).to.equal(2);
    expect(report.candidatesSubmitted, 'the corpus should actually have probed something').to.be.greaterThan(1000);
    expect(report.rejections, JSON.stringify(report.rejections.slice(0, 5))).to.be.empty;
    expect(report.candidatesRejected).to.equal(0);
  });

  it('probes almost every decision point, and names the ones it could not', async () => {
    const configs = buildCandidateValidationConfigs([{players: 2, games: 1}]);
    const report = await runCandidateValidation(configs, {maxCandidatesPerDecision: 2});

    // Fork gaps are counted and named, never silently folded into the legality result. The
    // pending-model mismatches are the finding recorded in validation.ts's own doc comment: forks
    // that pass hazard H7's two-way check and still present a different decision.
    const gaps = report.forkGaps.forkUnavailable + report.forkGaps.forkUnfaithful + report.forkGaps.forkPendingModelMismatch;
    expect(report.decisionsValidated + gaps).to.be.at.least(report.decisionPoints - report.emptySets);
    expect(report.decisionsValidated / report.decisionPoints, 'coverage').to.be.greaterThan(0.9);
  });

  it('reaches most in-scope decision types in a single game, and reports the rest by name', async () => {
    const configs = buildCandidateValidationConfigs([{players: 2, games: 1}]);
    const report = await runCandidateValidation(configs, {maxCandidatesPerDecision: 1});

    // G1c is adjudicated on the full corpus, not here; what this checks is that the accounting
    // that will adjudicate it works - every type is either exercised or named as unreached.
    const exercised = IN_SCOPE_TYPES.filter((type) => !report.unreachedTypes.includes(type));
    expect(exercised.length + report.unreachedTypes.length).to.equal(IN_SCOPE_TYPES.length);
    expect(exercised, 'a single 2p game should reach most of the action model').to.include.members(
      ['or', 'option', 'card', 'space', 'projectCard', 'initialCards']);
  });
});
