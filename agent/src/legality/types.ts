/**
 * Types for the AC-1 legality run (Milestone 1 exit criterion, legality half). The criteria
 * these serve - L1-L7, and the definition of "an illegal move" they encode - were pre-committed
 * in agent/docs/AC1_Legality_Run.md before this code existed.
 */

/** One game's configuration. Mirrors `ReplayConfig` (determinism/types.ts) deliberately: same shape, same meaning. */
export type LegalityGameConfig = {
  players: 2 | 3 | 4;
  engineSeed: number;
  agentSeed: number;
};

/**
 * Which population a `player.process()` call belongs to. The distinction is the whole point of
 * the strict accounting (criterion L5): a rejection of a move the *responder* chose is an
 * Agent-attributable illegal move under NFR-4; a rejection of one of the FR-9 fallback's
 * deliberate `'or'`-branch probes (`resubmitConservatively`, embeddedDriver.ts) is a recovery
 * mechanism working as designed. Both are submissions, so both are counted; conflating them
 * would be the easy way to get a flattering number.
 */
export type SubmissionSource = 'responder' | 'fallback-probe';

/**
 * One distinct (source, decision type, error class, normalized cause) group and how often it
 * occurred - the unit criterion L6 is stated in. `representative` keeps one incident's verbatim
 * message so the normalization that produced `signature` stays auditable.
 */
export type CauseTally = {
  source: SubmissionSource | 'responder-throw';
  decisionType: string;
  /** Error class name (`InputError`, `Error`, ...) - a coarse but genuinely informative axis. */
  errorClass: string;
  /** The cause message with ids and numbers normalized away - see `causeSignature`. */
  signature: string;
  count: number;
  representative: string;
};

/**
 * Per-game record. Deliberately small and flat: 1,500 of these are written to the committed
 * artifact, and a row that costs a kilobyte is a row nobody will ever diff.
 */
export type LegalityGameRecord = {
  players: 2 | 3 | 4;
  engineSeed: number;
  agentSeed: number;
  /** `true` iff the game reached `Phase.END` with no error escaping `runGame` (criteria L1-L3). */
  completed: boolean;
  /** Present only when `completed` is false: the error's class and message (criterion L3). */
  failure?: {errorClass: string; message: string};
  decisions: number;
  generation: number;
  /** FR-9 fallbacks where the responder *submitted* a move the Engine rejected (class A - an illegal move). */
  fallbacksAfterRejection: number;
  /** FR-9 fallbacks where the responder threw before producing a move (class B - nothing submitted). */
  fallbacksAfterThrow: number;
  /**
   * Every responder throw, not only those the driver recovered from. Identical to
   * `fallbacksAfterThrow` unless a throw was one the driver deliberately does *not* retry
   * (`OutOfScopeDecisionError` / `NotYetImplementedDecisionError`, which propagate as crashes) -
   * so a gap between the two fields is itself a finding.
   */
  responderThrows: number;
  /** Every `player.process()` call made during this game, whoever made it. The strict denominator. */
  submissions: number;
  /** Rejected submissions, split by source (criterion L5). */
  rejectedResponder: number;
  rejectedFallbackProbe: number;
  /** Sanity signals - a run of 1,500 games that all complete in three decisions is not a passing run. */
  victoryPoints: ReadonlyArray<number>;
  winners: number;
  durationMs: number;
};

/** A heap/wall-clock sample taken mid-run, after an event-loop yield (criterion L7). */
export type StabilitySample = {
  gamesCompleted: number;
  heapUsedMb: number;
  rssMb: number;
  elapsedMs: number;
};

export type LegalitySummary = {
  gamesRun: number;
  gamesCompleted: number;
  gamesFailed: number;
  byPlayerCount: ReadonlyArray<{players: 2 | 3 | 4; gamesRun: number; gamesCompleted: number}>;
  totalDecisions: number;
  totalSubmissions: number;
  /** Criterion L4: any of these means the run fails outright. */
  unrecoverableIllegalMoves: number;
  /** Criterion L5, class A: responder-submitted, Engine-rejected. NFR-4 is adjudicated on this number. */
  rejectedResponder: number;
  /** Criterion L5, third population: the FR-9 fallback's own rejected `'or'`-branch probes. */
  rejectedFallbackProbe: number;
  /** Class B: the responder threw before producing a move. Not an illegal move; reported anyway. */
  responderThrows: number;
  decisionsPerGame: Percentiles;
  generationsPerGame: Percentiles;
  durationMsPerGame: Percentiles;
  wallClockMs: number;
};

export type Percentiles = {min: number; p50: number; p95: number; max: number; mean: number};

export type LegalityRunReport = {
  summary: LegalitySummary;
  /** Every distinct cause observed across the whole run (criterion L6), most frequent first. */
  causes: ReadonlyArray<CauseTally>;
  games: ReadonlyArray<LegalityGameRecord>;
  stability: ReadonlyArray<StabilitySample>;
};
