import {replay} from '../determinism/replay';
import {ReplayConfig} from '../determinism/types';
import {runLegalityBatch} from './run';

/**
 * Proves the run's instrumentation does not change the run (agent/docs/AC1_Legality_Run.md, "Run
 * design": *"Instrumentation must not change the result"*).
 *
 * The legality runner adds two wrappers to the drive path: {@link SubmissionMonitor} wraps
 * `Player.prototype.process`, and `observeResponder` wraps the agent. Both are written to be
 * pass-through, but "written to be" is not evidence, and an instrumented number describing a
 * *different* game than the uninstrumented one would be wrong in a way nothing else in the run
 * could detect.
 *
 * So the check is end-to-end rather than per-wrapper: play each config through the **uninstrumented**
 * determinism harness (`replay()`, which bullet 6 established reproduces exactly for a fixed
 * config) and through the **fully instrumented** legality runner, and compare what both observe
 * about the same game - decisions resolved, FR-9 fallbacks fired, generation reached. Those three
 * are exactly the observables the two paths share; a wrapper that perturbed the game would have to
 * leave all three intact to slip through, at every config.
 *
 * (`replay()`'s hashes cannot be compared directly - it computes them from its own responder
 * wrapper, which the legality runner does not use. Comparing what both paths *count* is the
 * version of this check that actually exercises both wrappers.)
 *
 * **The two paths do not count "a decision" the same way, and finding that out is what this check
 * is for.** `replay()`'s wrapper records its trace step *after* `inner(decision)` returns
 * (replay.ts, `withMoveTrace`), so a decision where the responder **throws** - the class-B case,
 * roughly 5-6 per game - never reaches `trace.record` and is absent from its `decisions` count.
 * The legality runner counts the responder call itself, so it includes them. The first run of this
 * check reported ten "mismatches" that were entirely this: e.g. 3p engine seed 500,977, clean 326
 * vs instrumented 337, with exactly 11 responder throws in that game. So the comparison subtracts
 * the throws, and compares like with like.
 *
 * That is also a small, genuine finding about the determinism corpus, worth knowing before anyone
 * relies on `moveTraceHash` for something it doesn't cover: **the move trace has no step for a
 * decision the responder threw on**, and therefore none for what the FR-9 fallback submitted in its
 * place. A divergence confined to fallback-resolved decisions would not move `moveTraceHash`. It
 * would still move `stableStateHash` and the corpus's separately-compared `fallbacks` count, so the
 * corpus as a whole still catches it - but not by the field one would assume.
 */

export type NeutralityMismatch = {
  config: ReplayConfig;
  field: 'decisions' | 'fallbacks' | 'generation';
  clean: number;
  instrumented: number;
};

export type NeutralityReport = {
  configsChecked: number;
  mismatches: ReadonlyArray<NeutralityMismatch>;
};

export async function checkInstrumentationNeutrality(configs: ReadonlyArray<ReplayConfig>): Promise<NeutralityReport> {
  const mismatches: Array<NeutralityMismatch> = [];

  for (const config of configs) {
    const clean = replay(config);
    const report = await runLegalityBatch([{players: config.players, engineSeed: config.engineSeed, agentSeed: config.agentSeed}]);
    const [game] = report.games;

    const observed = {
      // Like-for-like with replay()'s own definition - see the module doc.
      decisions: game.decisions - game.responderThrows,
      fallbacks: game.fallbacksAfterRejection + game.fallbacksAfterThrow,
      generation: game.generation,
    };
    for (const field of ['decisions', 'fallbacks', 'generation'] as const) {
      if (clean[field] !== observed[field]) {
        mismatches.push({config, field, clean: clean[field], instrumented: observed[field]});
      }
    }
  }

  return {configsChecked: configs.length, mismatches};
}
