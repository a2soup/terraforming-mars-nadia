import {expect} from 'chai';
import {firstDivergence, replay, stableStringify} from '../../src/determinism/replay';
import {TraceStep} from '../../src/determinism/types';
import {
  assertHeaderCompatible,
  buildHeader,
  CorpusHeaderMismatchError,
  fingerprintsMatch,
  verifyCorpus,
} from '../../src/determinism/corpus';

/**
 * Milestone 1, bullet 6, sub-task A: correctness of the determinism harness *itself*, not a
 * determinism sweep (that's sub-task B). Per the bullet's shared preamble, "a green result is
 * the suspicious one" - every check below has a negative control that must actually flag
 * something, per Milestone1_Bullet6_Prompts.md sub-task A section 4's explicit list:
 * - a trace that *does* diverge is detected and its first-divergence index is right;
 * - key-order differences in an InputResponse do *not* produce a divergence;
 * - a corpus with a mismatched header is rejected rather than silently compared.
 */
describe('determinism harness (Milestone 1, bullet 6, sub-task A)', () => {
  describe('replay()', function() {
    this.timeout(30_000);

    it('produces identical fingerprints for two in-process replays of the same config', () => {
      const config = {players: 2 as const, engineSeed: 42001, agentSeed: 7001};

      const a = replay(config);
      const b = replay(config);

      expect(fingerprintsMatch(a, b), 'two replays of the same config should agree on every comparable field').to.be.true;
      expect(a.moveTraceHash).to.equal(b.moveTraceHash);
      expect(a.stableStateHash).to.equal(b.stableStateHash);
      expect(a.resultHash).to.equal(b.resultHash);
      expect(a.decisions).to.be.greaterThan(0);
    });

    it('the check actually distinguishes games: a different agent seed produces a different fingerprint', () => {
      // Negative control for replay() itself: a harness that reports "identical" no matter what
      // it's given has not been shown to test anything. Same engine seed, different agent seed -
      // the two seeds are independent (SRS CON-5), so the move sequence (and therefore every
      // hash) is expected to diverge.
      const configA = {players: 2 as const, engineSeed: 42002, agentSeed: 1};
      const configB = {players: 2 as const, engineSeed: 42002, agentSeed: 2};

      const a = replay(configA);
      const b = replay(configB);

      expect(fingerprintsMatch(a, b), 'different agent seeds should not coincidentally produce identical fingerprints for this config').to.be.false;
    });

    it('captures diagnostics only when requested', () => {
      const config = {players: 2 as const, engineSeed: 42003, agentSeed: 7003};

      const plain = replay(config);
      expect(plain.diagnostics).to.be.undefined;

      const withDiagnostics = replay(config, {diagnostics: true});
      expect(withDiagnostics.diagnostics).to.not.be.undefined;
      expect(withDiagnostics.diagnostics!.trace).to.have.length(withDiagnostics.decisions);
      expect(withDiagnostics.diagnostics!.stableState).to.be.a('string').and.not.empty;

      // Requesting diagnostics must not change the actual outcome being measured.
      expect(fingerprintsMatch(plain, withDiagnostics)).to.be.true;
    });

    it('counts FR-9 conservative-fallback firings into `fallbacks`', () => {
      // Not asserting a specific count (fallback frequency is seed-dependent, per the Tier-1
      // batch findings in Running_Notes) - just that the field reflects reality: a `driverOptions`
      // callback and the fingerprint's own count must agree, not just both exist.
      const config = {players: 2 as const, engineSeed: 42004, agentSeed: 7004};
      let observed = 0;

      const fingerprint = replay(config, {driverOptions: {onFallback: () => {
        observed++;
      }}});

      expect(fingerprint.fallbacks).to.equal(observed);
    });
  });

  describe('stableStringify() - key-order independence (negative control)', () => {
    it('produces the same string regardless of key insertion order', () => {
      const a = {type: 'projectCard', card: 'X', payment: {megaCredits: 3, steel: 0}};
      const b = {payment: {steel: 0, megaCredits: 3}, card: 'X', type: 'projectCard'};

      expect(stableStringify(a)).to.equal(stableStringify(b));
    });

    it('preserves array order (order is meaningful, unlike object key order)', () => {
      const a = {type: 'and', responses: [{type: 'option'}, {type: 'card', cards: ['A', 'B']}]};
      const b = {type: 'and', responses: [{type: 'card', cards: ['B', 'A']}, {type: 'option'}]};

      expect(stableStringify(a)).to.not.equal(stableStringify(b));
    });

    it('the check actually distinguishes structurally different responses (negative control on the negative control)', () => {
      const a = {type: 'option'};
      const b = {type: 'card', cards: ['A']};

      expect(stableStringify(a)).to.not.equal(stableStringify(b));
    });
  });

  describe('firstDivergence() - localizing a diverging trace (negative control)', () => {
    function step(index: number, hash: string): TraceStep {
      return {index, previousHash: `prev-${index}`, stepInput: `step-${index}`, hash};
    }

    it('reports undefined when two traces are identical', () => {
      const trace = [step(0, 'h0'), step(1, 'h1'), step(2, 'h2')];
      expect(firstDivergence(trace, [...trace])).to.be.undefined;
    });

    it('reports the correct index when two traces diverge partway through', () => {
      const a = [step(0, 'h0'), step(1, 'h1'), step(2, 'h2-a'), step(3, 'h3-a')];
      const b = [step(0, 'h0'), step(1, 'h1'), step(2, 'h2-b'), step(3, 'h3-b')];

      const divergence = firstDivergence(a, b);

      expect(divergence, 'expected a divergence to be detected').to.not.be.undefined;
      expect(divergence!.index).to.equal(2);
      expect(divergence!.a?.hash).to.equal('h2-a');
      expect(divergence!.b?.hash).to.equal('h2-b');
    });

    it('reports a length mismatch at the first index beyond the shorter trace', () => {
      const shorter = [step(0, 'h0'), step(1, 'h1')];
      const longer = [step(0, 'h0'), step(1, 'h1'), step(2, 'h2')];

      const divergence = firstDivergence(shorter, longer);

      expect(divergence).to.not.be.undefined;
      expect(divergence!.index).to.equal(2);
      expect(divergence!.a).to.be.undefined;
      expect(divergence!.b?.hash).to.equal('h2');
    });

    it('a real diverging pair of replays is detected and localized (end-to-end negative control)', () => {
      // Real games, not synthetic steps: two runs that share an engine seed but differ in agent
      // seed diverge somewhere in their move sequence (the two seeds are independent by
      // construction, SRS CON-5) - confirming firstDivergence works on genuine trace data, not
      // just hand-built TraceStep fixtures.
      const a = replay({players: 2, engineSeed: 42005, agentSeed: 1}, {diagnostics: true});
      const b = replay({players: 2, engineSeed: 42005, agentSeed: 2}, {diagnostics: true});

      const divergence = firstDivergence(a.diagnostics!.trace, b.diagnostics!.trace);

      expect(divergence, 'expected the two runs to diverge somewhere').to.not.be.undefined;
      expect(divergence!.index).to.be.at.least(0);
      // Whatever diverged first, both sides must have actually recorded a step there (unless
      // it's a length mismatch, which is its own valid divergence) - not an out-of-bounds report.
      expect(divergence!.a !== undefined || divergence!.b !== undefined).to.be.true;
    });
  });

  describe('corpus header compatibility (negative control)', () => {
    it('accepts a header identical to the current environment', () => {
      const header = buildHeader();
      expect(() => assertHeaderCompatible(header, header)).to.not.throw();
    });

    it('rejects a header with a different engine commit', () => {
      const current = buildHeader();
      const mismatched = {...current, engineCommit: `${current.engineCommit}-different`};

      expect(() => assertHeaderCompatible(mismatched, current)).to.throw(CorpusHeaderMismatchError);
    });

    /*
     * The regression that motivated these two tests (sub-task E, adjudication): `engineCommit`
     * originally held `git rev-parse HEAD`, so a corpus stopped verifying on the *next* commit -
     * `--verify` threw CorpusHeaderMismatchError before comparing a single fingerprint, and the
     * committed 300-fingerprint corpus was already unverifiable by the time it was merged. The
     * field must hold the pinned Engine commit, which is what actually determines Engine
     * behaviour and does not move; agent churn belongs in `agentCommit`, which is provenance and
     * must never be a rejection reason (see CorpusHeader's doc comment).
     */
    it('records the pinned Engine commit, not the repo HEAD, as engineCommit', () => {
      const header = buildHeader();

      expect(header.engineCommit, 'engineCommit must be the Engine pin from agent/CLAUDE.md section 2').to.equal('868714d72a434ab68fe08e5570ebc6863859ae15');
      expect(header.agentCommit, 'the repo HEAD belongs in agentCommit, separately').to.not.equal(header.engineCommit);
    });

    it('accepts a header whose agentCommit, nodeVersion and agentVersion differ', () => {
      // A changed agent or Node version must surface as a *fingerprint mismatch* (informative:
      // it names the configs that moved), never as a header rejection (silence). Rejecting here
      // would make the corpus useless as a regression check the moment anything was committed.
      const current = buildHeader();
      const older = {
        ...current,
        agentCommit: 'a'.repeat(40),
        nodeVersion: 'v20.0.0',
        agentVersion: '0.0.0',
      };

      expect(() => assertHeaderCompatible(older, current)).to.not.throw();
    });

    it('rejects a header with a different GAME_CACHE environment', () => {
      const current = buildHeader();
      const mismatched = {...current, env: {...current.env, GAME_CACHE: 'auto'}};

      expect(() => assertHeaderCompatible(mismatched, current)).to.throw(CorpusHeaderMismatchError);
    });

    it('rejects a header with a different seedDerivationVersion', () => {
      const current = buildHeader();
      const mismatched = {...current, seedDerivationVersion: current.seedDerivationVersion + 1};

      expect(() => assertHeaderCompatible(mismatched, current)).to.throw(CorpusHeaderMismatchError);
    });

    it('verifyCorpus rejects a mismatched-header corpus rather than silently comparing fingerprints', () => {
      const current = buildHeader();
      const mismatched = {...current, engineCommit: `${current.engineCommit}-different`};

      // A replayFn that would trivially "pass" any comparison, to prove the rejection happens
      // before any fingerprint comparison is even attempted - if verifyCorpus silently compared
      // instead of rejecting, this stub would make every mismatch look like a pass.
      const alwaysMatchingReplay = (config: {players: 2 | 3 | 4; engineSeed: number; agentSeed: number}) => ({
        config,
        moveTraceHash: 'x',
        stableStateHash: 'x',
        resultHash: 'x',
        decisions: 1,
        fallbacks: 0,
        generation: 1,
      });

      expect(() => verifyCorpus({header: mismatched, fingerprints: []}, alwaysMatchingReplay)).to.throw(CorpusHeaderMismatchError);
    });
  });
});
