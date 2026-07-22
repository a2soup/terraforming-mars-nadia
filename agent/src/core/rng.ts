import {Random, SeededRandom} from '@/common/utils/Random';

/**
 * The Agent's own source of randomness, used by the legal-action enumerator and the
 * random-legal agent to sample moves.
 *
 * **This is deliberately separate from the Engine's RNG (SRS CON-5/NFR-5).** The Engine
 * seed (see `NadiaGameConfig.seed`, agent/src/engine/gameConfig.ts) controls board setup
 * and every deck shuffle; this seed controls only the Agent's move choices. Keeping the
 * two independent is what lets us answer "was that the same game?" separately from "did
 * the Agent make the same decisions?" - and later, during search/self-play, vary the
 * Agent's determinization RNG without perturbing the game itself. Callers must supply an
 * agent seed chosen independently of the Engine seed.
 *
 * The underlying algorithm is the Engine's own `SeededRandom` (reused so we get a single,
 * well-exercised PRNG), but wrapped behind this interface so strategy code never depends
 * on an Engine class directly (NFR-7) and so we can add the sampling helpers a move
 * enumerator actually needs.
 */
export interface AgentRandom {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, range). `range` must be a positive integer. */
  nextInt(range: number): number;
  /** An integer in [min, max], inclusive. Requires `min <= max`. */
  intInRange(min: number, max: number): number;
  /** A uniformly-chosen element of a non-empty array. */
  pick<T>(items: ReadonlyArray<T>): T;
}

class SeededAgentRandom implements AgentRandom {
  constructor(private readonly source: Random) {}

  public next(): number {
    return this.source.next();
  }

  public nextInt(range: number): number {
    if (!Number.isInteger(range) || range <= 0) {
      throw new Error(`nextInt range must be a positive integer, got ${range}`);
    }
    return this.source.nextInt(range);
  }

  public intInRange(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error(`intInRange bounds must be integers, got [${min}, ${max}]`);
    }
    if (max < min) {
      throw new Error(`intInRange requires min <= max, got [${min}, ${max}]`);
    }
    return min + this.source.nextInt(max - min + 1);
  }

  public pick<T>(items: ReadonlyArray<T>): T {
    if (items.length === 0) {
      throw new Error('pick called on an empty array');
    }
    return items[this.source.nextInt(items.length)];
  }
}

/**
 * Creates an {@link AgentRandom} seeded by a non-negative integer. Same seed always yields
 * the same stream, which is what makes the random-legal agent's games reproducible under
 * fixed seeds (Milestone 1 exit criterion). The seed must be chosen independently of the
 * Engine seed (see the interface doc, SRS CON-5).
 */
export function createAgentRandom(seed: number): AgentRandom {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`agent seed must be a non-negative integer, got ${seed}`);
  }
  // Seed the PRNG *state* (currentSeed) directly rather than via SeededRandom's one-arg
  // form. That constructor sets currentSeed = Math.floor(seed * 2**32), which is a multiple
  // of 2**32 and therefore 0 in the low 32 bits the mulberry32 core actually uses - so every
  // integer seed would collapse to the *same* stream. SeededRandom's fractional-seed contract
  // ([0, 1)) hides this; passing currentSeed = seed sidesteps it and gives each integer seed a
  // distinct stream. See agent/docs/Running_Notes.md (2026-07-22, SeededRandom degeneracy).
  return new SeededAgentRandom(new SeededRandom(seed, seed));
}

/**
 * Wraps an arbitrary Engine {@link Random} as an {@link AgentRandom}. Useful in tests to
 * force specific choices (e.g. with `ConstRandom`); production code should use
 * {@link createAgentRandom}.
 */
export function agentRandomFrom(source: Random): AgentRandom {
  return new SeededAgentRandom(source);
}
