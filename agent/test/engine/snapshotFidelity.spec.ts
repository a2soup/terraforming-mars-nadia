import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {createAgentRandom} from '../../src/core/rng';
import {applyDecision, runGame} from '../../src/driver/embeddedDriver';
import {EmbeddedResponder} from '../../src/driver/responder';
import {
  UnsafeSnapshotError,
  assertSnapshotSafe,
  pendingSignature,
  restore,
  snapshot,
} from '../../src/engine/snapshot';
import {stableStateOf} from '../../src/engine/stableState';
import {Phase} from '../../../src/common/Phase';
import {IGame} from '../../../src/server/IGame';

/**
 * Milestone 1, sub-task B: the snapshot/restore **fidelity audit** (see
 * agent/docs/Milestone1_Bullet4_Prompts.md, sub-task B, and the 2026-07-22 Running Notes entry
 * "Snapshot/restore fidelity is *not* universal" for the design basis and the planning probe's
 * numbers).
 *
 * **What this file is for.** Sub-task A's `assertSnapshotSafe` + pending-signature verification
 * are a *claim* about where the Engine's snapshot/restore round trip loses information. This
 * file is the measurement that makes that claim trustworthy rather than a plausible guess: it
 * drives full games and classifies **every** decision point, then asserts the characterization
 * over the resulting table. If either guard regresses - or if a *fourth* failure mode exists in
 * a phase or player count the planning probe never sampled - assertion 1 below is what catches
 * it.
 *
 * **The trap this file is written around, and why the code below looks like it does.** An audit
 * is a measurement of exactly the points sub-task A's API is built to *refuse*. Classifying with
 * A's defaults would make it throw on precisely the rows being counted, and the audit would
 * degrade - silently, still green - into "assert that the safe points are safe", which proves
 * nothing. So every classification below deliberately runs with the safety machinery switched
 * off (`snapshot(game, {unsafe: true})`, `restore(snap, {verify: 'none'})`) and compares by
 * hand. **Every assertion here is a statement about the resulting table, never about whether
 * `snapshot`/`restore` threw.**
 */

/** One decision point's classification. The audit's assertions are statements about a table of these. */
type FidelityRow = {
  /** Which game the row came from, so a failure message can name the exact reproducer. */
  readonly config: string;
  /** 1-based decision index within its game - the coordinate the Running Notes probe reports (e.g. "#54"). */
  readonly decision: number;
  readonly phase: Phase;
  /** Whether `assertSnapshotSafe` accepts this point. Recorded as a verdict; never acted on. */
  readonly safe: boolean;
  /** Whether a restore reproduces the live game's pending-decision signature. */
  readonly pendingOk: boolean;
  /** Whether a restore reproduces the serialized state (`stableStateOf`). */
  readonly stateOk: boolean;
};

/** A row that does not round-trip, by either measure - "bad" in the Running Notes' sense. */
function isBad(row: FidelityRow): boolean {
  return !row.pendingOk || !row.stateOk;
}

/**
 * The **silent** failure: the serialized state matches byte for byte while the pending decision
 * was replaced (Engine fact: the pending decision is not serialized, so a mid-action
 * sub-decision is regenerated as a fresh top-of-turn one and *nothing in the state changes*).
 * A state-only round-trip check reports success on every one of these - which is the entire
 * reason `pendingSignature` exists.
 */
function isSilent(row: FidelityRow): boolean {
  return row.stateOk && !row.pendingOk;
}

/**
 * `assertSnapshotSafe`'s verdict as a boolean. Catches only {@link UnsafeSnapshotError} - any
 * other throw is a genuine bug in the guard and must not be silently recorded as "unsafe".
 */
function isSnapshotSafe(game: IGame): boolean {
  try {
    assertSnapshotSafe(game);
    return true;
  } catch (error) {
    if (error instanceof UnsafeSnapshotError) {
      return false;
    }
    throw error;
  }
}

/**
 * Classifies the game's *current* decision point with all of sub-task A's safety machinery
 * bypassed (see this file's doc comment). Four facts per point: the guard's verdict, whether a
 * restore reproduces the pending decision, whether it reproduces the state, and the phase.
 */
function classify(game: IGame, config: string, decision: number): FidelityRow {
  const safe = isSnapshotSafe(game);
  const snap = snapshot(game, {unsafe: true});
  const restored = restore(snap, {verify: 'none'});
  return {
    config,
    decision,
    phase: game.phase,
    safe,
    pendingOk: pendingSignature(restored) === snap.pending,
    stateOk: stableStateOf(restored.serialize()) === stableStateOf(snap.state),
  };
}

function nextWaitingPlayer(game: IGame) {
  return game.playersInGenerationOrder.find((p) => p.getWaitingFor() !== undefined);
}

/**
 * Drives one full game to `Phase.END` with `randomLegalAgent`, classifying every decision point
 * along the way (before the decision is applied, so the classification is of the state a search
 * would actually fork from).
 */
function auditGame(players: number, seed: number, agentSeed: number): Array<FidelityRow> {
  const config = `${players}p/seed=${seed}/agentSeed=${agentSeed}`;
  const game = createGame({players, seed});
  const agent: EmbeddedResponder = randomLegalAgent(createAgentRandom(agentSeed));

  const rows: Array<FidelityRow> = [];
  while (game.phase !== Phase.END) {
    const player = nextWaitingPlayer(game);
    if (player === undefined) {
      throw new Error(`${config}: no player has a pending input, but phase is '${game.phase}', not '${Phase.END}'`);
    }
    rows.push(classify(game, config, rows.length + 1));
    applyDecision(player, agent);
  }
  return rows;
}

/** Aggregates the table by phase, in the shape of the Running Notes' own table, for reporting. */
function summarizeByPhase(rows: ReadonlyArray<FidelityRow>) {
  const phases = [...new Set(rows.map((row) => row.phase))].sort();
  return phases.map((phase) => {
    const forPhase = rows.filter((row) => row.phase === phase);
    return {
      phase,
      total: forPhase.length,
      bad: forPhase.filter(isBad).length,
      silent: forPhase.filter(isSilent).length,
      stateDiverged: forPhase.filter((row) => !row.stateOk).length,
      rejectedByGuard: forPhase.filter((row) => !row.safe).length,
      // The bad rows the *phase guard alone* would have let through - i.e. the rows that
      // exist only because the pending-signature check is also there. Together with
      // `rejectedByGuard` this is A section 3's "neither mechanism alone is sufficient"
      // argument, restated as measured counts per phase.
      caughtByPendingOnly: forPhase.filter((row) => isBad(row) && row.safe && !row.pendingOk).length,
    };
  });
}

function describeRow(row: FidelityRow): string {
  return `[${row.config} #${row.decision} phase=${row.phase} safe=${row.safe} pendingOk=${row.pendingOk} stateOk=${row.stateOk}]`;
}

/**
 * The audit corpus. Distinct engine seeds (the SeededRandom-degeneracy fix, Running_Notes
 * 2026-07-22, is what makes distinct integer seeds produce genuinely distinct games) and an
 * agent seed derived from each by a fixed transform so the two stay independent (SRS CON-5)
 * while the whole corpus is reproducible from this list alone.
 *
 * 2p/3p/4p, two games each. The planning probe was a *single* 2p game: action and research are
 * ~98% of its points and are well evidenced, but `preludes` was sampled 4 times, `production`
 * once, and 3p/4p not at all - so this corpus is the first proper sample of those, and a fourth
 * failure mode showing up here (assertion 1 failing where the probe never reached) would be the
 * audit doing its job, not a reason to weaken the assertion.
 */
const AUDIT_CONFIGS: ReadonlyArray<{players: number; seed: number}> = [
  {players: 2, seed: 4242},
  {players: 2, seed: 9001},
  {players: 3, seed: 9101},
  {players: 3, seed: 9102},
  {players: 4, seed: 9201},
  {players: 4, seed: 9202},
];

describe('snapshot/restore fidelity audit (Milestone 1, sub-task B)', function() {
  // A full clone round trip is ~1.5 ms and the state comparison adds two stringifies of a
  // ~65KB object, over a few hundred decision points per game - a couple of seconds of clone
  // cost for the whole corpus in practice. Generous but bounded: this runs in the normal suite,
  // it is not the (separate) simulator-speed spike.
  this.timeout(120_000);

  const rows: Array<FidelityRow> = [];

  before(() => {
    for (const {players, seed} of AUDIT_CONFIGS) {
      rows.push(...auditGame(players, seed, seed * 13 + 97));
    }

    // Reported, not just asserted, so the numbers can be refreshed into the Running Notes'
    // fidelity table by reading a test run (the prompt's "report the aggregate" ask).
    const bad = rows.filter(isBad).length;
    console.log(
      `[snapshot fidelity audit] ${AUDIT_CONFIGS.length} games ` +
      `(${AUDIT_CONFIGS.map((c) => `${c.players}p/${c.seed}`).join(', ')}), ` +
      `${rows.length} decision points, ${bad} bad (${(100 * bad / rows.length).toFixed(1)}%):`,
    );
    console.table(summarizeByPhase(rows));
  });

  // -----------------------------------------------------------------------------------------
  // Assertion 1: the union invariant (snapshot.ts's doc comment, sub-task A section 3).
  // -----------------------------------------------------------------------------------------

  describe('the union invariant: no bad decision point survives both guards', () => {
    it('has no row where the phase guard accepts the point AND the restore reproduces the pending signature AND the state still diverges', () => {
      // `safe && pendingOk => stateOk`. This is the property that makes the two mechanisms
      // *together* sufficient even though neither is alone: the phase guard catches the
      // research failures it cannot detect by signature, and the signature check catches the
      // action-phase ones the phase guard happily accepts. A row surviving both would be a
      // fourth failure mode - a state divergence with no observable symptom at snapshot time -
      // and the correct response is to add a condition to `assertSnapshotSafe`, never to
      // weaken this assertion.
      const survivors = rows.filter((row) => row.safe && row.pendingOk && !row.stateOk);
      expect(
        survivors.map(describeRow),
        'a decision point passed both of snapshot.ts\'s guards yet still failed to round-trip: an unguarded (fourth) failure mode',
      ).to.deep.equal([]);
    });
  });

  // -----------------------------------------------------------------------------------------
  // Assertion 2: research is caught by the phase guard, everywhere it occurs.
  // -----------------------------------------------------------------------------------------

  describe('the phase guard covers research', () => {
    it('rejects every Phase.RESEARCH decision point in the corpus', () => {
      const researchRows = rows.filter((row) => row.phase === Phase.RESEARCH);
      expect(researchRows, 'the corpus must actually contain research decision points for this to mean anything').to.not.be.empty;
      expect(
        researchRows.filter((row) => row.safe).map(describeRow),
        'assertSnapshotSafe accepted a research-phase point, where restore re-draws cards',
      ).to.deep.equal([]);
    });
  });

  // -----------------------------------------------------------------------------------------
  // Assertion 3: the meta-assertion - the corpus still contains the silent case.
  // -----------------------------------------------------------------------------------------

  describe('the corpus still contains the silent failure case', () => {
    it('contains at least one action-phase row whose state round-trips byte for byte while the pending decision does not', () => {
      // This is a statement about the *audit*, not about the Engine: assertion 1 is only
      // meaningful while the corpus actually reaches points where `stateOk` is true and
      // `pendingOk` is false. If the corpus ever drifts somewhere the silent case no longer
      // arises, assertion 1 has quietly become vacuous - green while testing nothing - and this
      // is what says so.
      //
      // Deliberately specific: "some row is bad", "the bad count is non-zero", or an
      // `expect(...).to.throw` around a restore would all pass on the loud *research* failures
      // alone, which is exactly the distinction this assertion exists to make.
      const silentActionRows = rows.filter((row) => row.phase === Phase.ACTION && isSilent(row));
      expect(
        silentActionRows.length,
        'no action-phase decision point in the corpus reproduced its state byte-for-byte while losing its pending decision - the corpus has drifted away from the silent case, so the union invariant above is now vacuous',
      ).to.be.greaterThan(0);
    });
  });

  // -----------------------------------------------------------------------------------------
  // Assertion 4: log-stripping is rules-neutral (what earns `stripLog` its place as an option).
  // -----------------------------------------------------------------------------------------

  describe('log-stripped snapshots are rules-neutral', () => {
    /** Drives to a quiescent mid-game action decision - safe to snapshot, and past the opening generation. */
    function driveToQuiescentMidGameAction(game: IGame, agent: EmbeddedResponder): void {
      let decisions = 0;
      while (!(game.phase === Phase.ACTION && game.generation > 1 && game.deferredActions.length === 0)) {
        const player = nextWaitingPlayer(game);
        if (player === undefined) {
          throw new Error(`no player has a pending input (phase=${game.phase})`);
        }
        if (decisions++ >= 400) {
          throw new Error('no quiescent mid-game action decision found within 400 decisions');
        }
        applyDecision(player, agent);
      }
    }

    for (const players of [2, 3, 4]) {
      it(`(${players}p) a game driven to completion from a stripLog restore produces the same GameResult as one from an unstripped restore of the same point`, () => {
        const seed = 7300 + players;
        const game = createGame({players, seed});
        driveToQuiescentMidGameAction(game, randomLegalAgent(createAgentRandom(seed * 13 + 97)));

        const stripped = restore(snapshot(game, {stripLog: true}));
        const unstripped = restore(snapshot(game));

        // The option did what it says, so the comparison below is actually between a
        // history-bearing game and a history-less one.
        expect(stripped.gameLog, 'stripLog: true must produce an empty game log').to.be.empty;
        expect(unstripped.gameLog, 'the unstripped control must carry the real history').to.not.be.empty;

        // Separately-constructed agents on the same seed, one per game: sharing one instance
        // would have both drives consuming a single interleaved RNG stream and prove nothing.
        const agentSeed = seed * 7 + 11;
        const strippedResult = runGame(stripped, randomLegalAgent(createAgentRandom(agentSeed)));
        const unstrippedResult = runGame(unstripped, randomLegalAgent(createAgentRandom(agentSeed)));

        expect(strippedResult, 'dropping the game log changed the outcome, so stripLog is not rules-neutral').to.deep.equal(unstrippedResult);

        // Stronger than the GameResult check and the reason `stableStateOf`'s `ignoreLog`
        // option exists: with the log excluded from both sides, the two finished games must be
        // identical in *every* other respect, not merely tied on victory points.
        expect(
          stableStateOf(stripped.serialize(), {ignoreLog: true}),
          'the two drives diverged somewhere other than the game log',
        ).to.equal(stableStateOf(unstripped.serialize(), {ignoreLog: true}));
      });
    }
  });
});
