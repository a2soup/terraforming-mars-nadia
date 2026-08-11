import * as fs from 'fs';
import * as path from 'path';
import {L2GameEntry, RegressionCorpus} from '../../src/regression/types';
import {PlayedEntry} from '../../src/regression/corpus';
import {SMOKE_CORPUS_FILE, dataPath} from '../../src/regression/runner';

/**
 * Shared scaffolding for the Unit A specs (Milestone 2, bullet 5).
 *
 * **Everything here works off the *committed* smoke corpus rather than a hand-built value.** That
 * is not incidental: `rating/seedBlocks.ts` records a guard that had specs, passed them, and had
 * never once refused a real run, because every one of those specs was written against an in-memory
 * ledger and the real file had a different shape. Specs that only ever see values they constructed
 * themselves test the constructor.
 */

export function smokeCorpusPath(): string {
  return dataPath(SMOKE_CORPUS_FILE);
}

export function loadSmoke(): RegressionCorpus {
  return JSON.parse(fs.readFileSync(smokeCorpusPath(), 'utf8')) as RegressionCorpus;
}

/**
 * The committed smoke corpus with only the fast entries kept: `random-legal@1` at 2p, which plays
 * in ~100 ms a game against `greedy-1ply@1`'s tens of seconds under `tsx`.
 *
 * Used by the specs that need the CLI to *replay* games (the rebaseline path), where the point
 * being tested is the refusal and the ledger arithmetic, not the games. The specs that test the
 * comparison itself use the whole corpus, because there the greedy entries are the interesting ones.
 */
export function writeFastCorpus(directory: string, name = 'corpus.json'): string {
  const corpus = loadSmoke();
  const sections = corpus.sections
    .filter((section) => section.agent === 'random-legal')
    .map((section) => ({...section, entries: section.entries.filter((entry) => entry.identity.players === 2)}));
  const target = path.join(directory, name);
  fs.writeFileSync(target, JSON.stringify({...corpus, sections}, null, 2));
  return target;
}

/**
 * A `PlayedEntry` that reproduces `entry` exactly - the "nothing moved" side of a comparison,
 * built without playing a game so a diff spec costs milliseconds. `mutate` is applied to a deep
 * copy, which is how each spec introduces exactly one change and asserts exactly one row.
 */
export function playedFrom(entry: L2GameEntry, mutate: (played: PlayedEntry) => void = () => {}): PlayedEntry {
  const played = JSON.parse(JSON.stringify({
    fingerprints: entry.fingerprints,
    semantics: entry.semantics,
  })) as PlayedEntry;
  mutate(played);
  return played;
}
