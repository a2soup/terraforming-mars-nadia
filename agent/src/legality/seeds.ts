import {LegalityGameConfig} from './types';

/**
 * The AC-1 legality run's seed schedule (agent/docs/AC1_Legality_Run.md, "Run design").
 *
 * Two independent arithmetic progressions, not one derived from the other. SRS CON-5 requires the
 * Engine seed and the Agent seed to be controlled separately; a schedule like `agentSeed =
 * engineSeed * 13 + 97` (used by the much smaller Tier-1 batch) satisfies "different numbers" but
 * makes one a function of the other, which is exactly what CON-5 is about. Here each progression
 * has its own base and its own stride, sharing only the game index.
 *
 * Both bases sit well clear of the determinism corpus's seed space (base 500,000, stride 977;
 * determinism/sweep.ts), so this run plays 1,500 games bullet 6 never replayed - new evidence,
 * not a re-measurement.
 *
 * Strides are primes and differ from each other, so `engineSeed` and `agentSeed` never fall into
 * step: over the whole run no two games share an engine seed, no two share an agent seed, and the
 * two sequences have no common period shorter than the run.
 */

export const ENGINE_SEED_BASE = 700_000;
export const ENGINE_SEED_STRIDE = 1_009;

export const AGENT_SEED_BASE = 3_100_007;
export const AGENT_SEED_STRIDE = 2_311;

/** The pre-committed composition: 1,000 at 2p (the headline AC-1 claim) plus 250 each at 3p/4p. */
export const DEFAULT_COMPOSITION: ReadonlyArray<{players: 2 | 3 | 4; games: number}> = [
  {players: 2, games: 1000},
  {players: 3, games: 250},
  {players: 4, games: 250},
];

/**
 * Builds the run's configs in a fixed order. The game index runs continuously across player
 * counts (it is not restarted per shard), so every game in the run gets its own engine seed and
 * its own agent seed - 2p game 999 and 3p game 0 are genuinely different games, not the same
 * seeds replayed at a different player count.
 */
export function buildLegalityConfigs(
  composition: ReadonlyArray<{players: 2 | 3 | 4; games: number}> = DEFAULT_COMPOSITION,
): ReadonlyArray<LegalityGameConfig> {
  const configs: Array<LegalityGameConfig> = [];
  let index = 0;
  for (const {players, games} of composition) {
    for (let i = 0; i < games; i++) {
      configs.push({
        players,
        engineSeed: ENGINE_SEED_BASE + index * ENGINE_SEED_STRIDE,
        agentSeed: AGENT_SEED_BASE + index * AGENT_SEED_STRIDE,
      });
      index++;
    }
  }
  return configs;
}
