import {InputResponse} from '@/common/inputs/InputResponse';
import {AgentEntry, SeatedAgent, withTemporaryAgent} from '../agents/registry';
import {randomLegalAgent} from '../core/randomLegalAgent';
import {AgentRandom, createAgentRandom} from '../core/rng';
import {EmbeddedDecisionPoint, toDecisionPoint} from '../driver/decisionPoint';
import {EmbeddedResponder} from '../driver/responder';
import {buildMatchConfigs, resolveMatchSpec} from '../match/pairing';
import {runMatchConfigs} from '../match/runner';
import {MatchLegalityCounters, MatchSpec} from '../match/types';
import {ForkService, ForkStats, mergeForkStats, submitInFork} from './fork';
import {runWithSpeculationCounted, withSpeculation} from './speculation';

/**
 * **The fork probe: an agent that speculates but does not think, and the evidence for criterion
 * G2b** (Milestone 2 bullet 2, Unit A; §5 of agent/docs/Milestone2_Bullet2_Prompts.md).
 *
 * ---
 *
 * ## Why this exists
 *
 * G2 has three parts, and only the third is a unit test. G2a (the R8 equivalence still holds) and
 * G2c (the cross-check fires) can both be discharged against machinery that already exists. **G2b
 * cannot**, and it is the one that matters:
 *
 * > a run with a forking agent seated, executed twice - once with the guard and once with
 * > speculative submissions deliberately counted - shows a **large** difference in `submissions`,
 * > and the guarded figure matches the count of decisions actually played. *A test that cannot show
 * > the guard doing anything has not tested it.*
 *
 * A guard whose presence and absence produce the same numbers is either unnecessary or - far more
 * likely - not wired in at all, and that is a failure mode no amount of green tests around it would
 * reveal. So the negative control is a first-class capability
 * (`speculation.ts`'s `runWithSpeculationCounted`) and this file is the agent that exercises it.
 *
 * **Unit A ships before `greedy-1ply` exists** (Unit C), so the probe stands in for it. That is not
 * a compromise: the probe is a *better* instrument for this particular claim than the real agent
 * would be, because its live moves are **stream-identical to `random-legal@1`'s at the same seed**.
 * It plays exactly the games `random-legal` plays and speculates on top of them, so "the guarded
 * figure matches the count of decisions actually played" becomes a comparison against a
 * `random-legal` run of the same specification - counter for counter, not approximately.
 *
 * ## Why it is not, and must never become, a registry entry
 *
 * It is seated through `withTemporaryAgent` and never appears in `AGENTS`. It is not an agent: it
 * makes no use of what it speculates about, its "candidates" are uniform random moves, and one in
 * every {@link ILLEGAL_PROBE_STRIDE} submissions is **deliberately illegal** - because the
 * population the guard has to hide includes the FR-9-style rejected probes a real search makes, and
 * a negative control built only from accepted submissions would not exercise the rejection counters
 * at all.
 */

/** Every Nth speculative submission is a deliberately-rejected probe - see the module doc. */
export const ILLEGAL_PROBE_STRIDE = 4;

/**
 * A response the Engine rejects at essentially every decision: the type is wrong for all but
 * `amount` decisions, and `-1` is below the minimum of every `amount` decision in scope. Used to
 * manufacture the rejected-probe population the guard has to hide. If some decision ever accepts
 * it, {@link ForkProbeStats.illegalProbesAccepted} says so rather than the run quietly losing the
 * population.
 */
const ILLEGAL_PROBE: InputResponse = {type: 'amount', amount: -1};

/** The name the probe is registered under. Chosen so a stray occurrence is obviously not an agent. */
export const FORK_PROBE_AGENT = 'fork-probe';

export type ForkProbeOptions = {
  /** Fork attempts per decision. Default 4 - enough to be visibly not one, cheap enough to run in a spec. */
  candidates?: number;
  /** Passed to the {@link ForkService}; G3's sampling rate. Default 0. */
  validateRate?: number;
};

/** What the probe itself observed, beside what the instruments observed. */
export type ForkProbeStats = {
  /** Submissions the probe made **into forks** - the population the guard must hide. */
  speculativeSubmissions: number;
  /** Of those, the ones the Engine rejected. Non-zero is the point (see the module doc). */
  speculativeRejections: number;
  /** Deliberately-illegal probes the Engine unexpectedly accepted. Should be 0; counted, not assumed. */
  illegalProbesAccepted: number;
  /** Live decisions this seat answered. */
  decisions: number;
  fork: ForkStats;
};

function emptyProbeStats(fork: ForkStats): ForkProbeStats {
  return {speculativeSubmissions: 0, speculativeRejections: 0, illegalProbesAccepted: 0, decisions: 0, fork};
}

/**
 * A {@link SeatedAgent} that forks at every one of its decisions, submits candidates into the
 * forks, and then plays the `random-legal@1` move.
 *
 * **Two independent RNG streams, and the reason is the whole design.** The live move comes from
 * `createAgentRandom(seed)` driving `randomLegalAgent` - the same construction
 * `agents/registry.ts` uses for `random-legal@1` - so this agent's *game* is that agent's game at
 * the same seed. The speculative candidates come from a second stream derived from the same seed by
 * a fixed offset, so no amount of probing can shift the live stream by a single draw. Both go
 * through {@link createAgentRandom}; `SeededRandom` is never constructed directly (hazard H8).
 */
export function forkProbeAgent(seed: number, options: ForkProbeOptions = {}): SeatedAgent & {stats: () => ForkProbeStats} {
  const candidates = options.candidates ?? 4;
  const service = new ForkService({validateRate: options.validateRate});
  const live: EmbeddedResponder = randomLegalAgent(createAgentRandom(seed));
  const probeRandom: AgentRandom = createAgentRandom(seed + 1_000_003);
  const probe: EmbeddedResponder = randomLegalAgent(probeRandom);
  const counters = emptyProbeStats(service.stats);

  const respond: EmbeddedResponder = (decision: EmbeddedDecisionPoint): InputResponse => {
    counters.decisions++;
    // The whole candidate loop runs inside a speculation scope, so a submission that escaped to the
    // live game anywhere in here would throw rather than corrupt the match (§3.2's cross-check).
    withSpeculation(() => {
      for (let i = 0; i < candidates; i++) {
        const outcome = service.fork();
        if (!outcome.available) {
          // Unforkable points are ordinary - most of game setup is one - and a search takes its
          // fallback there. Nothing further to probe at this decision.
          return;
        }
        const waitingFor = outcome.player.getWaitingFor();
        if (waitingFor === undefined) {
          return;
        }
        const illegal = counters.speculativeSubmissions % ILLEGAL_PROBE_STRIDE === ILLEGAL_PROBE_STRIDE - 1;
        let candidate: InputResponse;
        if (illegal) {
          candidate = ILLEGAL_PROBE;
        } else {
          try {
            candidate = probe(toDecisionPoint(outcome.player, waitingFor));
          } catch {
            // The known `projectCard`/standard-project coupling, among others. A real search would
            // fall back here; the probe simply moves on.
            continue;
          }
        }
        counters.speculativeSubmissions++;
        try {
          submitInFork(outcome.player, candidate);
          if (illegal) {
            counters.illegalProbesAccepted++;
          }
        } catch {
          counters.speculativeRejections++;
        }
      }
    });
    return live(decision);
  };

  return {
    respond,
    driverOptions: service.driverOptions,
    observeDecisions: (inner) => service.observeDecisions(inner),
    stats: () => ({...counters, fork: service.stats}),
  };
}

// ---------------------------------------------------------------------------------------------
// Criterion G2b: the negative control
// ---------------------------------------------------------------------------------------------

export type GuardEvidence = {
  players: number;
  groups: number;
  games: number;
  candidatesPerDecision: number;
  /** The probe's own count of submissions made into forks - what the guard has to hide. */
  speculativeSubmissions: number;
  speculativeRejections: number;
  illegalProbesAccepted: number;
  /** Legality counters with the guard armed - the real configuration. */
  guarded: MatchLegalityCounters;
  /** The same run with the guard disarmed: what `--legality` would report without §3.2. */
  counted: MatchLegalityCounters;
  /** `random-legal@1` over the same specification. The probe plays these very games (module doc). */
  reference: MatchLegalityCounters;
  /**
   * The guarded run reports exactly what a non-speculating agent playing the same games reports, on
   * every counter. **This is G2b's second clause** ("the guarded figure matches the count of
   * decisions actually played"), stated as an equality rather than an approximation.
   */
  guardedMatchesReference: boolean;
  /**
   * `counted.submissions - guarded.submissions`. G2b's "large difference", and it must equal
   * {@link speculativeSubmissions} plus `fork.replaySubmissions` - the two populations that live
   * inside a fork. Anything else means the guard is hiding something it should not, or missing
   * something it should.
   */
  submissionsHidden: number;
  fork: ForkStats;
};

/**
 * **Criterion G2b.** Plays one specification three times - guarded, with the guard disarmed, and
 * with `random-legal@1` in the probe's place - and reports all three accountings.
 *
 * Exported rather than written inline in a spec because Unit D re-runs it at validation scale; the
 * spec runs it small. Same function, same numbers, one definition.
 *
 * The three runs are **sequential on purpose**: the guard flag and the instruments' prototype
 * wrappers are both process-global, so overlapping runs would interleave into each other's
 * accounting.
 */
export async function measureSpeculationGuard(
  spec: MatchSpec,
  options: ForkProbeOptions = {},
): Promise<GuardEvidence> {
  const probes: Array<ReturnType<typeof forkProbeAgent>> = [];
  const entry: AgentEntry = {
    name: FORK_PROBE_AGENT,
    version: '0-probe',
    description: 'G2b negative control: forks at every decision and submits candidates into the forks (not a real agent).',
    create: (seed) => {
      const agent = forkProbeAgent(seed, options);
      probes.push(agent);
      return agent;
    },
  };

  const probeSpec = {...spec, lineup: new Array(spec.players).fill(FORK_PROBE_AGENT)};
  const capture = {historyTier: 'summary', legality: true} as const;

  const play = async (target: MatchSpec): Promise<MatchLegalityCounters> => {
    const resolved = resolveMatchSpec(target);
    const report = await runMatchConfigs(buildMatchConfigs(resolved), resolved, {capture, silenceRoutineLogs: true});
    return report.summary.legality ?? {submissions: 0, rejectedResponder: 0, rejectedFallbackProbe: 0, responderThrows: 0};
  };

  // Resolved *inside* the registration: `resolveMatchSpec` looks every lineup name up in the
  // registry to record its version, so hoisting it out throws before the probe agent exists.
  const {guarded, counted, resolved} = await withTemporaryAgent(entry, async () => ({
    resolved: resolveMatchSpec(probeSpec),
    guarded: await play(probeSpec),
    counted: await runWithSpeculationCounted(() => play(probeSpec)),
  }));

  const reference = await play({...spec, lineup: new Array(spec.players).fill('random-legal')});
  const stats = probes.map((agent) => agent.stats());
  // The guarded half of the pair only - the counted half plays the same games again, so folding
  // both in would double every probe count and make the evidence look twice as strong as it is.
  const guardedStats = stats.slice(0, stats.length / 2);

  return {
    players: resolved.players,
    groups: resolved.groups,
    games: resolved.games,
    candidatesPerDecision: options.candidates ?? 4,
    speculativeSubmissions: sum(guardedStats.map((s) => s.speculativeSubmissions)),
    speculativeRejections: sum(guardedStats.map((s) => s.speculativeRejections)),
    illegalProbesAccepted: sum(guardedStats.map((s) => s.illegalProbesAccepted)),
    guarded,
    counted,
    reference,
    guardedMatchesReference: JSON.stringify(guarded) === JSON.stringify(reference),
    submissionsHidden: counted.submissions - guarded.submissions,
    fork: mergeForkStats(guardedStats.map((s) => s.fork)),
  };
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}
