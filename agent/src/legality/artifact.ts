import * as fs from 'fs';
import {buildHeader, CorpusHeader} from '../determinism/corpus';
import {CauseTally, LegalityGameRecord, LegalityRunReport, StabilitySample} from './types';

/**
 * The committed run artifact. Reuses the determinism corpus's {@link CorpusHeader} verbatim -
 * same provenance question (which Engine pin, which Node, which gameplay-reaching env vars), and
 * the same trap already paid for once: `engineCommit` is the **Engine pin**, not repo HEAD, or the
 * artifact stops being meaningful on the next docs-only commit (Determinism_Verification.md,
 * "Defects this write-up fixed").
 *
 * Unlike the determinism corpus this is evidence, not a regression check: nothing re-runs it and
 * compares. A 1,500-game run is not a per-commit check, and pretending otherwise would produce a
 * `--verify` nobody runs. The standing check that *does* exist is the small legality spec in
 * `agent/test/legality/`, plus the determinism corpus, which re-plays 300 games on demand.
 */
export type LegalityArtifact = {
  header: CorpusHeader;
  summary: LegalityRunReport['summary'];
  /** Cause tallies including the verbatim `representative` message the signature was derived from. */
  causes: ReadonlyArray<CauseTally>;
  stability: ReadonlyArray<StabilitySample>;
  games: ReadonlyArray<LegalityGameRecord>;
};

export function buildArtifact(report: LegalityRunReport): LegalityArtifact {
  return {
    header: buildHeader(),
    summary: report.summary,
    causes: report.causes,
    stability: report.stability,
    games: report.games,
  };
}

/**
 * Writes the artifact with the header/summary/causes/stability pretty-printed and the 1,500 game
 * rows one per line. Fully pretty-printing the rows would triple the file for no gain: a per-game
 * row is read as a record, not navigated as a tree, and one-per-line keeps both the diff and a
 * `grep` for a failing seed usable.
 */
export function saveArtifact(filePath: string, artifact: LegalityArtifact): void {
  const {games, ...rest} = artifact;
  const head = JSON.stringify(rest, null, 2);
  const rows = games.map((game) => `    ${JSON.stringify(game)}`).join(',\n');
  const body = `${head.slice(0, head.length - 2)},\n  "games": [\n${rows}\n  ]\n}\n`;
  fs.writeFileSync(filePath, body);
}

export function loadArtifact(filePath: string): LegalityArtifact {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as LegalityArtifact;
}
