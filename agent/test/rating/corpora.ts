import * as fs from 'fs';
import * as path from 'path';
import {LoadedArtifact, loadRatingInput} from '../../src/rating/observations';

/**
 * The committed corpora the rating specs run against, and the rule for what happens when one is
 * missing.
 *
 * Two populations, and the distinction matters:
 *
 * - **`match_runner_validation.json`** was committed by Milestone 2 bullet 1 and is always present.
 *   Criteria P1 and P4a are stated on it directly - P4a reproduces §2.3's pre-registered design
 *   effects to three significant figures - so a spec that silently skipped it would remove the only
 *   check that this pipeline reads the runner's records correctly. It is therefore **required**: if
 *   it is absent the spec fails rather than skipping.
 * - **`rating_corpus_{2,3,4}p.json`** are this bullet's own greedy-vs-random corpora, produced by a
 *   compiled-build match run of roughly an hour (Unit A §5). They are **optional** here: a checkout
 *   made before that run finished should still have a green suite, and the specs that need them say
 *   so by skipping with a message rather than by passing vacuously.
 *
 * `docs/data/baselines_validation.json` is deliberately absent from this list. It carries summaries
 * only, with no per-game rows (§2.2), so its 99.2% headline cannot be re-analysed - which is the
 * whole reason this bullet generates a corpus of its own.
 */
export type CommittedCorpus = {
  label: string;
  file: string;
  /** When false, a spec skips rather than fails if the file has not been generated yet. */
  required: boolean;
};

export const COMMITTED_CORPORA: ReadonlyArray<CommittedCorpus> = [
  {label: 'match_runner_validation.json (bullet 1, random-legal self-play)', file: 'match_runner_validation.json', required: true},
  {label: 'rating_corpus_2p.json (greedy-1ply vs random-legal)', file: 'rating_corpus_2p.json', required: false},
  {label: 'rating_corpus_3p.json (greedy x2 vs random)', file: 'rating_corpus_3p.json', required: false},
  {label: 'rating_corpus_4p.json (greedy x2 vs random x2)', file: 'rating_corpus_4p.json', required: false},
];

export function corpusPath(corpus: CommittedCorpus): string {
  return path.join(__dirname, '..', '..', 'docs', 'data', corpus.file);
}

/** Mocha's `this` inside a `function()` test - typed loosely so this helper needs no mocha types. */
type Skippable = {skip: () => void};

/**
 * Loads a corpus, skipping the calling test when an optional one has not been generated. Returns
 * an empty array only in the skip case, which never returns.
 */
export function loadCommittedReports(corpus: CommittedCorpus, context: Skippable): ReadonlyArray<LoadedArtifact> {
  const filePath = corpusPath(corpus);
  if (!fs.existsSync(filePath)) {
    if (corpus.required) {
      throw new Error(`${filePath} is missing, and criteria P1/P4a are stated on it (§2.2)`);
    }
    context.skip();
    return [];
  }
  return loadRatingInput(filePath);
}

/** Every corpus that exists right now, flattened. */
export function loadAvailableReports(): ReadonlyArray<LoadedArtifact> {
  return COMMITTED_CORPORA
    .filter((corpus) => fs.existsSync(corpusPath(corpus)))
    .flatMap((corpus) => loadRatingInput(corpusPath(corpus)));
}
