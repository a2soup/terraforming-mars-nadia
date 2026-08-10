import {expect} from 'chai';
import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {CardName} from '@/common/cards/CardName';
import {
  buildCorporationPrior,
  CHANCE_WIN_RATE,
  corporationPriorRows,
  corporationWap,
  loadCorporationPrior,
  loadUpstreamTable,
  parseUpstreamTable,
  UPSTREAM_TABLE_PATH,
} from '../../src/prior/corporationPrior';

/**
 * The standing check on the corporation opening prior (Milestone 2 bullet 4).
 *
 * There is no CLI for this bullet and deliberately so - it is one static upstream table, not a
 * pipeline (Plan v1.8). This spec *is* the re-runnable check: it re-derives the committed artifact
 * from the vendored source and compares, so a hand edit to the JSON fails here rather than silently
 * becoming the prior Milestone 3 reads.
 */
describe('corporation opening prior (FR-DATA-1)', () => {
  const agentRoot = path.resolve(__dirname, '..', '..');
  const inScopeCorporations = readInScopeCorporations(agentRoot);
  const committed = loadCorporationPrior(agentRoot);

  describe('provenance', () => {
    it('the vendored table hashes to the upstream blob SHA it claims', () => {
      // `git hash-object` is the same function GitHub reports as a blob `sha`, so this is a direct
      // comparison against the upstream file rather than against a hash we invented. If it fails,
      // the vendored copy has been edited - which would make every number below unattributable.
      const hash = execFileSync('git', ['hash-object', UPSTREAM_TABLE_PATH], {cwd: agentRoot, encoding: 'utf8'}).trim();
      expect(hash).to.equal(committed.source.blobSha);
    });

    it('records where the table came from and under what licence', () => {
      expect(committed.source.repository).to.contain('RuneDK93/terraforming-mars-dataset');
      expect(committed.source.path).to.equal('prelude/corps.txt');
      expect(committed.source.license).to.contain('MIT');
    });
  });

  describe('the committed artifact is re-derivable from the vendored table', () => {
    it('rebuilds entry-for-entry from the source, so a hand edit to the JSON fails here', () => {
      const rebuilt = buildCorporationPrior(loadUpstreamTable(agentRoot), inScopeCorporations, committed.header);
      expect(rebuilt.entries).to.deep.equal(committed.entries);
      expect(rebuilt.checks).to.deep.equal(committed.checks);
      expect(rebuilt.unmatched).to.deep.equal(committed.unmatched);
    });
  });

  describe('the two arithmetic identities', () => {
    // These are the checks worth having. They know nothing about this project or about the name
    // matching, and they would catch a truncated download, a duplicated row, or a table regenerated
    // upstream against a different corpus - which is what a hand transcription is actually exposed to.
    it('participations / 3 equals the corpus game count', () => {
      expect(committed.checks.impliedGames).to.equal(committed.checks.statedGames);
      expect(committed.checks.impliedGames).to.equal(1616);
    });

    it('wins sum to the game count - one winner per game, so "Win Rate" is a first-place rate', () => {
      expect(committed.checks.totalWins).to.equal(committed.checks.statedGames);
    });

    it('every published win rate agrees with wins / participations', () => {
      // buildCorporationPrior throws on disagreement, so this asserts the check ran over all 17
      // rather than re-deriving it: a build that silently produced zero entries would pass a
      // recomputation loop over an empty list.
      expect(committed.entries).to.have.length(17);
      for (const entry of committed.entries) {
        const recomputed = Math.round((entry.wins / entry.participations) * 10000) / 100;
        expect(recomputed, String(entry.cardName)).to.be.closeTo(entry.winRatePct, 0.005);
      }
    });
  });

  describe('the engine reconciliation (FR-DATA-1)', () => {
    it('covers all 17 in-scope corporations with nothing unmatched in either direction', () => {
      expect(inScopeCorporations).to.have.length(17);
      expect(committed.unmatched.inDatasetOnly).to.deep.equal([]);
      expect(committed.unmatched.inEngineOnly).to.deep.equal([]);
      expect(committed.entries.map((entry) => entry.cardName).sort())
        .to.deep.equal([...inScopeCorporations].sort());
    });

    it('maps to real CardName values, not to strings that merely look like them', () => {
      const known = new Set<string>(Object.values(CardName));
      for (const entry of committed.entries) {
        expect(known.has(entry.cardName), `${entry.cardName} is not a CardName`).to.be.true;
      }
    });

    it('leaves an unmatched dataset row without a prior rather than coercing it', () => {
      // The requirement is only observable on a table that has an unmatched row, and the real one
      // has none - so this drives it with a synthetic row. Coercion onto a near-match is exactly
      // what FR-DATA-1 forbids, and "we checked and there were none" is not evidence the branch works.
      const withStranger = loadUpstreamTable(agentRoot).replace('| Ecoline  ', '| Ecoloine ');
      const rebuilt = buildCorporationPrior(withStranger, inScopeCorporations);
      expect(rebuilt.unmatched.inDatasetOnly).to.deep.equal(['Ecoloine']);
      expect(rebuilt.unmatched.inEngineOnly).to.deep.equal([CardName.ECOLINE]);
      expect(rebuilt.entries.map((entry) => entry.cardName)).to.not.contain(CardName.ECOLINE);
    });
  });

  describe('parsing', () => {
    it('reads 17 data rows and skips every rule and header line', () => {
      expect(parseUpstreamTable(loadUpstreamTable(agentRoot))).to.have.length(17);
    });

    it('throws on a malformed row rather than dropping it', () => {
      // A dropped row leaves a plausible 16-row prior. Failing loudly here is the difference between
      // a caught transcription error and a quietly wrong opening book.
      const broken = loadUpstreamTable(agentRoot).replace('|      1 | CrediCor', '|      x | CrediCor');
      expect(() => parseUpstreamTable(broken)).to.throw(/non-numeric/);
    });
  });

  describe('the derived rows a consumer reads', () => {
    const rows = corporationPriorRows(committed);

    it('measures advantage against the 3-player chance baseline, not 50%', () => {
      // The corpus is 3-player. Reading 40.88% as a losing rate would inevert the whole prior, which
      // is the single easiest way to misuse this file.
      expect(CHANCE_WIN_RATE).to.be.closeTo(1 / 3, 1e-12);
      const credicor = rows.find((row) => row.cardName === CardName.CREDICOR);
      expect(credicor?.advantagePp).to.be.closeTo(7.5, 0.1);
    });

    it('recomputes the rate at full precision rather than reading the rounded column', () => {
      for (const row of rows) {
        const entry = committed.entries.find((candidate) => candidate.cardName === row.cardName);
        expect(row.winRate).to.equal(entry!.wins / entry!.participations);
      }
    });

    it('reports most of the table as not separated from chance', () => {
      // The point of shipping an interval. 8 of 17 clear it; the middle nine span -5.0 to +3.9 pp
      // with intervals that all contain 1/3, so ranking them against each other is reading noise.
      const separated = rows.filter((row) => row.separatedFromChance);
      expect(separated).to.have.length(8);
      expect(rows.find((row) => row.cardName === CardName.MINING_GUILD)?.separatedFromChance).to.be.false;
      expect(rows.find((row) => row.cardName === CardName.HELION)?.separatedFromChance).to.be.true;
    });

    it('brackets every point estimate with its interval', () => {
      for (const row of rows) {
        expect(row.interval.low, String(row.cardName)).to.be.at.most(row.winRate);
        expect(row.interval.high, String(row.cardName)).to.be.at.least(row.winRate);
      }
    });
  });

  describe('WAP', () => {
    it('is returned unchanged, on its own scale, and is not a rate', () => {
      // SRS §1.5 and Plan Appendix A.1 both call WAP "a skill-adjusted win rate". It is a mean
      // Elo-performance residual on ~[-2, +2]. Anything that clamps or rescales it to [0, 1] has
      // believed the documents over the upstream source.
      expect(corporationWap(CardName.THARSIS_REPUBLIC, committed)).to.equal(0.148);
      expect(corporationWap(CardName.HELION, committed)).to.equal(-0.174);
      const waps = committed.entries.map((entry) => entry.wap);
      expect(Math.min(...waps)).to.be.lessThan(0);
      expect(Math.max(...waps)).to.be.lessThan(1);
    });

    it('disagrees with the raw rate most on the corporation the raw rate ranks first', () => {
      // The skill adjustment is doing real work rather than reproducing the win-rate order: overall
      // Spearman is 0.92, but CrediCor is 1st by rate and 6th by WAP. That is the confounding
      // FR-DATA-3 warns about, visible in the data - strong players pick CrediCor - and it is why
      // the guardrails say prefer WAP.
      const byRate = [...committed.entries].sort((a, b) => b.wins / b.participations - a.wins / a.participations);
      const byWap = [...committed.entries].sort((a, b) => b.wap - a.wap);
      expect(byRate[0].cardName).to.equal(CardName.CREDICOR);
      expect(byWap.findIndex((entry) => entry.cardName === CardName.CREDICOR)).to.equal(5);
      expect(byWap[0].cardName).to.equal(CardName.THARSIS_REPUBLIC);
    });

    it('has no corporation with a prior missing, and reports undefined for one without', () => {
      for (const name of inScopeCorporations) {
        expect(corporationWap(name as CardName, committed), name).to.not.be.undefined;
      }
      expect(corporationWap(CardName.BEGINNER_CORPORATION, committed)).to.be.undefined;
    });
  });
});

/**
 * The in-scope corporation list, read from Milestone 1's census rather than re-derived. Beginner
 * Corporation is `unreachable-in-config` there and is correctly excluded.
 */
function readInScopeCorporations(agentRoot: string): ReadonlyArray<string> {
  const census = JSON.parse(fs.readFileSync(path.join(agentRoot, 'docs/data/card_census.json'), 'utf8')) as
    {entries: ReadonlyArray<{name: string; type: string; scope: string}>};
  return census.entries
    .filter((entry) => entry.type === 'corporation' && entry.scope === 'reachable')
    .map((entry) => entry.name);
}
