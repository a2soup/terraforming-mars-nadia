import {expect} from 'chai';
import * as path from 'path';
import {CardName} from '@/common/cards/CardName';
import {Census, CensusEntry} from '../../src/coverage/types';
import {
  classifyTestCoverage,
  measureEngineTestCoverage,
  sourceStemOf,
  summarize,
} from '../../src/coverage/engineTestCoverage';

/**
 * Phase I of Milestone 1, bullet 7. Two kinds of test here:
 *  - fast, pure unit tests over the classification (direct/behavioural/uncovered), which is where
 *    the K3 judgement lives; and
 *  - the phase's required **negative control** (Phase I section 3): a card with a dedicated spec is
 *    `direct` when that spec runs, and must fall *out* of `direct` when the spec is excluded.
 *    Without that control the classifier is decorative - an instrument that reports everything as
 *    covered is indistinguishable from a suite that covers everything.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMMITTED_CENSUS = path.join(REPO_ROOT, 'agent/docs/data/card_census.json');

/** A minimal CensusEntry - only the fields classifyTestCoverage reads need to be realistic. */
function entry(name: CardName, sourceFile: string, overrides: Array<string> = []): CensusEntry {
  return {
    name,
    module: 'base',
    section: 'projectCards',
    cardNumber: '000',
    type: 'automated' as CensusEntry['type'],
    tags: [],
    cost: 0,
    sourceFile,
    scope: 'reachable',
    scopeReason: 'test fixture',
    imperativeOverrides: overrides,
    declarative: overrides.length === 0,
  };
}

function census(entries: Array<CensusEntry>): Census {
  return {
    header: {} as Census['header'],
    entries,
    presence: {cardNumberIssues: [], corporations: {expectedNames: [], foundNames: [], missing: [], unexpected: []}},
  };
}

describe('engineTestCoverage', () => {
  describe('sourceStemOf()', () => {
    it('strips directory and final extension', () => {
      expect(sourceStemOf('src/server/cards/base/Algae.ts')).to.eq('Algae');
      expect(sourceStemOf('/abs/path/AdaptationTechnology.ts')).to.eq('AdaptationTechnology');
      expect(sourceStemOf('CityStandardProject.spec.ts')).to.eq('CityStandardProject.spec');
    });
  });

  describe('classifyTestCoverage() - the K3 three-way class', () => {
    const c = census([
      entry(CardName.ALGAE, 'src/server/cards/base/Algae.ts'),
      entry(CardName.VIRUS, 'src/server/cards/base/Virus.ts', ['bespokePlay']),
      entry(CardName.SF_MEMORIAL, 'src/server/cards/prelude/SFMemorial.ts'),
      entry(CardName.PETS, 'src/server/cards/base/Pets.ts', ['canAct', 'action']),
    ]);
    const specBasenames = new Set(['Algae.spec.ts', 'Virus.spec.ts', 'Pets.spec.ts']); // SFMemorial deliberately absent

    it('a card executed under its own matching spec is `direct`', () => {
      const raw = {observations: {
        [CardName.ALGAE]: {instantiated: true, executed: true, executionCount: 3, selfSpecExecuted: true},
      }};
      const byName = new Map(classifyTestCoverage(c, raw, specBasenames).map((e) => [e.name, e]));
      expect(byName.get(CardName.ALGAE)!.coverage).to.eq('direct');
    });

    it('a card executed only via other specs is `behavioural`, not `direct`', () => {
      const raw = {observations: {
        [CardName.VIRUS]: {instantiated: true, executed: true, executionCount: 9, selfSpecExecuted: false},
      }};
      const byName = new Map(classifyTestCoverage(c, raw, specBasenames).map((e) => [e.name, e]));
      const virus = byName.get(CardName.VIRUS)!;
      expect(virus.coverage).to.eq('behavioural');
      // The scrutiny signal: a matching spec file exists but it did not exercise the card.
      expect(virus.hasMatchingSpecFile).to.be.true;
    });

    it('a card instantiated but whose effect never ran is `uncovered` / instantiated-but-inert (the SF_MEMORIAL shape)', () => {
      const raw = {observations: {
        [CardName.SF_MEMORIAL]: {instantiated: true, executed: false, executionCount: 0, selfSpecExecuted: false},
      }};
      const byName = new Map(classifyTestCoverage(c, raw, specBasenames).map((e) => [e.name, e]));
      const sf = byName.get(CardName.SF_MEMORIAL)!;
      expect(sf.coverage).to.eq('uncovered');
      expect(sf.uncoveredReason).to.eq('instantiated-but-inert');
      expect(sf.hasMatchingSpecFile).to.be.false;
    });

    it('a card never seen at all is `uncovered` / never-instantiated (present in the output, never dropped)', () => {
      const byName = new Map(classifyTestCoverage(c, {observations: {}}, specBasenames).map((e) => [e.name, e]));
      const pets = byName.get(CardName.PETS)!;
      expect(pets.coverage).to.eq('uncovered');
      expect(pets.uncoveredReason).to.eq('never-instantiated');
      // Every in-scope census entry appears exactly once, regardless of observation.
      expect(classifyTestCoverage(c, {observations: {}}, specBasenames)).to.have.length(c.entries.length);
    });
  });

  describe('summarize()', () => {
    it('counts classes, computes the covered fraction, and surfaces the risk/scrutiny lists', () => {
      const c = census([
        entry(CardName.ALGAE, 'src/server/cards/base/Algae.ts'),
        entry(CardName.VIRUS, 'src/server/cards/base/Virus.ts', ['bespokePlay']),
        entry(CardName.SF_MEMORIAL, 'src/server/cards/prelude/SFMemorial.ts'),
      ]);
      const specBasenames = new Set(['Algae.spec.ts', 'Virus.spec.ts']);
      const raw = {observations: {
        [CardName.ALGAE]: {instantiated: true, executed: true, executionCount: 1, selfSpecExecuted: true},
        [CardName.VIRUS]: {instantiated: true, executed: true, executionCount: 1, selfSpecExecuted: false},
      }};
      const s = summarize(classifyTestCoverage(c, raw, specBasenames));
      expect(s).to.include({total: 3, direct: 1, behavioural: 1, uncovered: 1});
      expect(s.coveredFraction).to.be.closeTo(2 / 3, 1e-9);
      expect(s.uncoveredNames).to.deep.eq([CardName.SF_MEMORIAL]);
      // Virus carries an override and is not `direct` -> highest-risk cell.
      expect(s.coveredWeaklyDespiteOverride).to.deep.eq([CardName.VIRUS]);
      // Virus has a matching spec that didn't exercise it -> scrutiny list.
      expect(s.matchingSpecButNotDirect).to.deep.eq([CardName.VIRUS]);
    });
  });

  // The negative control is an integration test: it spawns a child mocha over a couple of real
  // Engine specs. It is slower than the unit tests above but far cheaper than the full suite, and
  // it is the one test that proves the `direct` signal actually depends on the dedicated spec.
  describe('NEGATIVE CONTROL: excluding a card\'s dedicated spec moves it out of `direct`', function() {
    this.timeout(120_000);

    it('Algae is `direct` when Algae.spec.ts runs, and not `direct` when it is excluded', () => {
      const withSpec = measureEngineTestCoverage({
        censusPath: COMMITTED_CENSUS,
        specs: ['tests/cards/base/Algae.spec.ts'],
      });
      const algaeWith = withSpec.entries.find((e) => e.name === CardName.ALGAE)!;
      expect(algaeWith.coverage, 'Algae should be direct when its own spec runs').to.eq('direct');
      expect(algaeWith.selfSpecExecuted).to.be.true;

      // Exclude Algae.spec.ts; run a different card's spec instead so the suite is non-empty and
      // Algae is genuinely never exercised by its own spec.
      const withoutSpec = measureEngineTestCoverage({
        censusPath: COMMITTED_CENSUS,
        specs: ['tests/cards/base/AdvancedAlloys.spec.ts'],
      });
      const algaeWithout = withoutSpec.entries.find((e) => e.name === CardName.ALGAE)!;
      expect(algaeWithout.coverage, 'Algae must fall out of direct once its spec is excluded').to.not.eq('direct');
      expect(algaeWithout.selfSpecExecuted).to.be.false;
    });
  });
});
