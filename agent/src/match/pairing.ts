import {agentIdentity, formatIdentity, lookupAgent} from '../agents/registry';
import {MatchGameConfig, MatchPairingDescription, MatchSpec, PairingPolicy, ResolvedMatchSpec} from './types';

/**
 * Seat balancing: the design that makes a win rate mean something (Milestone 2 bullet 1, §4.1).
 *
 * **The problem.** In 2p Terraforming Mars the first player and the specific opening deal are
 * both advantages. `createGame` fixes `firstPlayerIndex = 0` and a fixed colour order
 * (`engine/gameConfig.ts`), so seat 0 always leads. If agent A is always seated at 0, A's measured
 * win rate is (A's strength) + (the seat-0 advantage) and nothing in the output says which is
 * which. That is not a bug someone later notices; it is a plausible number that steers the tuning.
 *
 * **The decision: the unit of measurement is a pairing group, not a game.**
 *
 * - A group fixes **one engine seed**, so every game in it starts from the identical board, the
 *   identical deal and the identical corporations offered to each seat. This is the variance
 *   reduction, and it is the main reason to do this at all.
 * - A group plays the lineup in **every seat permutation**: `n!` games for `n ≤ 3` (2p → 2,
 *   3p → 6). At 4p it plays the **4 cyclic rotations**, not all 24 - full `S_4` is a 6× cost for
 *   balance a Latin square already gives, and 4p is not a criterion setting for any AC (§4.7).
 * - `N` is therefore a number of **groups**; `games = groups × permutationsPerGroup`. A caller
 *   that wants to think in games must round to a whole group and say so
 *   ({@link groupsForGames}) - silently truncating a group is exactly the unbalanced sample this
 *   whole module exists to prevent.
 *
 * **Agent seeds travel with the lineup slot, not the seat.** Within a group, the agent in slot *k*
 * uses the same agent seed in all permutations. State honestly what that buys: it is **not** common
 * random numbers in any strong sense - the games diverge at the first decision and the streams are
 * consumed differently thereafter. It buys full specification of the group from its index alone,
 * and it removes "the agent got a different seed" as a candidate explanation for a within-group
 * difference. The variance reduction comes from the shared *engine* seed.
 *
 * **The mirror claim, stated correctly.** Sharing the engine seed makes the *initial position*
 * identical across the group. It does **not** make the games mirror images of each other; they
 * diverge at the first decision. Nothing downstream may describe these as "paired games" in a way
 * that implies more than this.
 *
 * **The seed schedule.** Two independent arithmetic progressions with distinct prime strides, in
 * the style of `legality/seeds.ts` and for the same reason (SRS CON-5: the Engine seed and the
 * Agent seed are controlled separately, so neither may be a function of the other). Bases are
 * clear of every seed space the project has already played, so match games are new games rather
 * than replays of an earlier run's:
 *
 * | Run | Engine seeds | Agent seeds |
 * | --- | --- | --- |
 * | Determinism corpus (`determinism/sweep.ts`) | 500,000 + 977k, k < 50 | 1,000,003 / 2,000,133 |
 * | AC-1 legality (`legality/seeds.ts`) | 700,000 + 1,009k, k < 1,500 | 3,100,007 + 2,311k |
 * | Card-coverage sweep (`coverage/playSweep.ts`) | 9,000,011 + 1,301k | 13,000,003 + 2,663k |
 * | **This module** | **21,000,017 + 1,409·group** | **27,000,023 + 3,251·group + 149·slot** |
 *
 * Seeds are consumed by `createGame` and `createAgentRandom` only - this module never constructs a
 * `SeededRandom` itself (hazard H6: constructing one directly from an integer seed collapses every
 * integer seed to a single stream, and both of those functions already work around it; the
 * structural guard in `test/determinism/rngSeparation.spec.ts` enforces that they stay the only
 * two entry points).
 */

/** Engine seed = base + stride × groupIndex. One seed per group, shared by all its permutations. */
export const ENGINE_SEED_BASE = 21_000_017;
export const ENGINE_SEED_STRIDE = 1_409;

/** Agent seed = base + groupStride × groupIndex + slotStride × slot. */
export const AGENT_SEED_BASE = 27_000_023;
export const AGENT_SEED_STRIDE = 3_251;
/**
 * Spacing between lineup slots inside one group. Smaller than {@link AGENT_SEED_STRIDE} and prime,
 * so with at most 4 slots (4 × 149 = 596 < 3,251) no two games anywhere in a run share an agent
 * seed unless they are the same slot in the same group - which is precisely when they should.
 */
export const AGENT_SEED_SLOT_STRIDE = 149;

/**
 * Every seat permutation for `players`, as `seating[seat] = lineup slot`.
 *
 * `n ≤ 3`: all `n!` permutations, in lexicographic order, so the list is stable and the identity
 * permutation is always index 0. `n = 4`: the 4 cyclic rotations (§4.1) - each slot occupies each
 * seat exactly once, which is the Latin-square property the balance actually needs, at a sixth of
 * the cost of full `S_4`.
 */
export function permutationsFor(players: 2 | 3 | 4): ReadonlyArray<ReadonlyArray<number>> {
  if (players === 4) {
    return [0, 1, 2, 3].map((rotation) => [0, 1, 2, 3].map((seat) => (seat + rotation) % 4));
  }
  return lexicographicPermutations([...Array(players).keys()]);
}

function lexicographicPermutations(items: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> {
  if (items.length <= 1) {
    return [items];
  }
  const permutations: Array<ReadonlyArray<number>> = [];
  for (const [index, item] of items.entries()) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of lexicographicPermutations(rest)) {
      permutations.push([item, ...tail]);
    }
  }
  return permutations;
}

export function pairingPolicyFor(players: 2 | 3 | 4): PairingPolicy {
  return players === 4 ? 'cyclic-rotation' : 'full-permutation';
}

/**
 * Validates a specification against the registry and computes its derived counts. Throws rather
 * than coercing: a lineup of the wrong length or an unknown agent name is a specification error,
 * and a runner that quietly played something else would produce an artifact that lies about what
 * it measured.
 */
export function resolveMatchSpec(spec: MatchSpec): ResolvedMatchSpec {
  const {players, lineup, groups} = spec;
  const startGroup = spec.startGroup ?? 0;

  if (players !== 2 && players !== 3 && players !== 4) {
    throw new Error(`players must be 2, 3, or 4, got ${players}`);
  }
  if (lineup.length !== players) {
    throw new Error(`lineup must name one agent per seat: expected ${players} entries, got ${lineup.length} (${lineup.join(', ')})`);
  }
  if (!Number.isInteger(groups) || groups < 1) {
    throw new Error(`groups must be a positive integer, got ${groups}`);
  }
  if (!Number.isInteger(startGroup) || startGroup < 0) {
    throw new Error(`startGroup must be a non-negative integer, got ${startGroup}`);
  }
  // Resolve every name up front, so an unknown agent fails before any game is played rather than
  // 400 games in.
  lineup.forEach((name) => lookupAgent(name));

  const permutationsPerGroup = permutationsFor(players).length;
  return {
    players,
    lineup: lineup.map(agentIdentity),
    groups,
    startGroup,
    permutationsPerGroup,
    games: groups * permutationsPerGroup,
  };
}

export function describePairing(spec: ResolvedMatchSpec): MatchPairingDescription {
  return {
    policy: pairingPolicyFor(spec.players),
    permutationsPerGroup: spec.permutationsPerGroup,
    engineSeedBase: ENGINE_SEED_BASE,
    engineSeedStride: ENGINE_SEED_STRIDE,
    agentSeedBase: AGENT_SEED_BASE,
    agentSeedStride: AGENT_SEED_STRIDE,
    agentSeedSlotStride: AGENT_SEED_SLOT_STRIDE,
  };
}

export function engineSeedForGroup(groupIndex: number): number {
  return ENGINE_SEED_BASE + groupIndex * ENGINE_SEED_STRIDE;
}

export function agentSeedForSlot(groupIndex: number, slot: number): number {
  return AGENT_SEED_BASE + groupIndex * AGENT_SEED_STRIDE + slot * AGENT_SEED_SLOT_STRIDE;
}

/**
 * The run's games, in order: group-major, then permutation. **Pure, deterministic and
 * serializable** - the same specification always yields the same list, in the same order, with no
 * reference to any live state. That is what lets Unit C's pool ship a shard of this list to a
 * child process and lets criterion R2 (reproducibility) be stated on the artifact at all.
 *
 * Group-major order is also why Unit C shards by *group* and never by game: a group's games are
 * adjacent in the output, which is what makes the artifact readable next to the seed that
 * produced them.
 */
export function buildMatchConfigs(spec: MatchSpec | ResolvedMatchSpec): ReadonlyArray<MatchGameConfig> {
  const resolved = isResolved(spec) ? spec : resolveMatchSpec(spec);
  const permutations = permutationsFor(resolved.players);
  const lineup = resolved.lineup.map((identity) => identity.name);

  const configs: Array<MatchGameConfig> = [];
  for (let group = 0; group < resolved.groups; group++) {
    const groupIndex = resolved.startGroup + group;
    const engineSeed = engineSeedForGroup(groupIndex);
    const agentSeeds = lineup.map((_, slot) => agentSeedForSlot(groupIndex, slot));
    for (const [permutationIndex, seating] of permutations.entries()) {
      configs.push({groupIndex, permutationIndex, players: resolved.players, engineSeed, seating, agentSeeds, lineup});
    }
  }
  return configs;
}

function isResolved(spec: MatchSpec | ResolvedMatchSpec): spec is ResolvedMatchSpec {
  return typeof (spec as ResolvedMatchSpec).permutationsPerGroup === 'number';
}

/**
 * Rounds a raw game count up to a whole number of pairing groups. **Up**, never down, and the
 * caller is expected to report the result: rounding down would silently drop the last, partly
 * played group, and a partly played group is an unbalanced sample (§4.1).
 */
export function groupsForGames(games: number, players: 2 | 3 | 4): number {
  if (!Number.isInteger(games) || games < 1) {
    throw new Error(`games must be a positive integer, got ${games}`);
  }
  return Math.ceil(games / permutationsFor(players).length);
}

/**
 * A deterministic identifier for a specification: same spec, same id, in any process. Used as the
 * artifact's `runId` and as its default filename, so re-running a named run overwrites it rather
 * than accumulating near-duplicates - and so criterion R2's "identical records" comparison is not
 * defeated by an id that embeds a timestamp.
 */
export function defaultRunId(spec: ResolvedMatchSpec): string {
  const lineup = spec.lineup.map(formatIdentity).join('_vs_');
  const range = `g${spec.startGroup}-${spec.startGroup + spec.groups - 1}`;
  return sanitize(`${spec.players}p_${lineup}_${range}`);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._@-]+/g, '-');
}
