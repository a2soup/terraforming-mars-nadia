import {expect} from 'chai';
import {PlayerInputModel} from '../../../../src/common/models/PlayerInputModel';
import {IGame} from '../../../../src/server/IGame';
import {IPlayer} from '../../../../src/server/IPlayer';
import {PlayerInput} from '../../../../src/server/PlayerInput';
import {OrOptions} from '../../../../src/server/inputs/OrOptions';
import {SelectAmount} from '../../../../src/server/inputs/SelectAmount';
import {SelectOption} from '../../../../src/server/inputs/SelectOption';
import {SelectSpace} from '../../../../src/server/inputs/SelectSpace';
import {
  CANDIDATE_CAP,
  IN_SCOPE_TYPES,
  NotYetImplementedCandidateError,
  OutOfScopeCandidateError,
  candidates,
} from '../../../src/core/candidates';
import {NotYetImplementedDecisionError, OutOfScopeDecisionError} from '../../../src/core/enumerator';
import {createAgentRandom} from '../../../src/core/rng';
import {EmbeddedDecisionPoint, toDecisionPoint} from '../../../src/driver/decisionPoint';
import {createGame} from '../../../src/engine/gameFactory';

/**
 * Unit B, the dispatch itself (`candidates/index.ts`): scope classification, the global cap, the
 * copy boundary, and determinism under a fixed agent seed.
 *
 * The per-type behaviour lives in the sibling specs; this file is responsible for the properties
 * that hold across every type.
 */
describe('candidates (candidate-set dispatch)', () => {
  /** Stripped to what the dispatch reads before delegating - the same device enumerator.spec.ts uses. */
  function fakeDecision(type: PlayerInputModel['type']): EmbeddedDecisionPoint {
    return {
      player: {id: 'p-test'} as unknown as IPlayer,
      model: {type} as PlayerInputModel,
      game: {} as IGame,
      raw: {} as PlayerInput,
    };
  }

  function testPlayer(seed: number) {
    return createGame({players: 2, seed}).playersInGenerationOrder[0];
  }

  const rng = createAgentRandom(11);

  it('covers exactly the thirteen in-scope decision types (§3.3), the structural half of G1c', () => {
    expect([...IN_SCOPE_TYPES].sort()).to.deep.equal([
      'amount', 'and', 'card', 'initialCards', 'option', 'or', 'payment',
      'player', 'productionToLose', 'projectCard', 'resource', 'resources', 'space',
    ]);
  });

  it('routes every in-scope type to a generator (never NotYetImplemented)', () => {
    // The stub `raw`/`player` prove routing but are not enough for every generator to run to
    // completion - several build real objects from `raw`. That is fine: the only claim here is
    // that the dispatch found a generator.
    for (const type of IN_SCOPE_TYPES) {
      expect(() => candidates(fakeDecision(type), rng), type).to.not.throw(NotYetImplementedCandidateError);
    }
  });

  it('throws OutOfScopeCandidateError for every out-of-scope expansion type', () => {
    const outOfScope: ReadonlyArray<PlayerInputModel['type']> = [
      'colony', 'delegate', 'party', 'globalEvent',
      'aresGlobalParameters', 'claimedUndergroundToken', 'deltaProject',
    ];
    for (const type of outOfScope) {
      expect(() => candidates(fakeDecision(type), rng), type).to.throw(OutOfScopeCandidateError);
    }
  });

  it('the scope errors extend the enumerator\'s, so the driver and agent treat them identically', () => {
    // `embeddedDriver.applyDecision` deliberately does *not* apply the FR-9 fallback to these two
    // classes - a dispatch-level miss must stay loud. Subclassing is what keeps that true for the
    // candidate path without the driver knowing this module exists.
    expect(new OutOfScopeCandidateError(fakeDecision('party'))).to.be.instanceOf(OutOfScopeDecisionError);
    expect(new NotYetImplementedCandidateError(fakeDecision('or'))).to.be.instanceOf(NotYetImplementedDecisionError);
    expect(new OutOfScopeCandidateError(fakeDecision('party')).message).to.include('party');
  });

  describe('the global cap', () => {
    it('never returns more than the cap, and reports both the pre-cap count and the fact it bit', () => {
      const player = testPlayer(1);
      // The whole Tharsis board is 63 spaces - just under the cap - so the offered list is
      // doubled to get over it. `SelectSpace.process` only checks membership, so a repeated
      // space is still a legal offer, and this keeps the test independent of the board's size.
      const spaces = [...player.game.board.spaces, ...player.game.board.spaces];
      expect(spaces.length).to.be.greaterThan(CANDIDATE_CAP);

      const set = candidates(toDecisionPoint(player, new SelectSpace('place', spaces)), rng);
      expect(set.candidates).to.have.length(CANDIDATE_CAP);
      expect(set.generated).to.equal(spaces.length);
      expect(set.capped).to.be.true;
      expect(set.cappedNodes).to.equal(1);
      expect(set.candidates.every((c) => c.type === 'space' && spaces.some((s) => s.id === c.spaceId))).to.be.true;
    });

    it('leaves an under-cap set untouched and reports it as uncapped', () => {
      const player = testPlayer(2);
      const set = candidates(toDecisionPoint(player, new SelectAmount('how much', 'Save', 0, 3)), rng);
      expect(set.capped).to.be.false;
      expect(set.cappedNodes).to.equal(0);
      expect(set.generated).to.equal(set.candidates.length);
    });

    it('counts a cap that bit inside a branch, so a nested subsample is not invisible', () => {
      const player = testPlayer(3);
      const spaces = [...player.game.board.spaces, ...player.game.board.spaces];
      const set = candidates(toDecisionPoint(player, new OrOptions(new SelectOption('pass'), new SelectSpace('place', spaces))), rng);

      expect(set.capped, 'the `or` itself is 1 + 64 = 65, one over the cap').to.be.true;
      expect(set.cappedNodes, 'the branch subsample plus the `or`\'s own').to.equal(2);
    });
  });

  describe('the copy boundary', () => {
    it('hands out candidates that share no structure with each other', () => {
      const player = testPlayer(4);
      const spaces = player.game.board.spaces.slice(0, 3);
      const set = candidates(toDecisionPoint(player, new OrOptions(new SelectSpace('place', spaces))), rng);

      // Within one set, `or` candidates wrap child responses that the generator legitimately
      // aliases; the copy at the boundary is what makes it safe for the consumer to submit them
      // into many independently restored forks (`bench/forkCost.ts`'s copyResponse rule).
      const first = set.candidates[0];
      const second = set.candidates[1];
      if (first.type !== 'or' || second.type !== 'or') {
        throw new Error('expected `or` candidates');
      }
      expect(first.response).to.not.equal(second.response);
      expect(first).to.not.equal(second);
    });
  });

  describe('determinism', () => {
    it('is a pure function of the decision and the agent rng stream', () => {
      const build = () => {
        const player = testPlayer(5);
        return toDecisionPoint(player, player.getWaitingFor()!);
      };
      const a = candidates(build(), createAgentRandom(777));
      const b = candidates(build(), createAgentRandom(777));
      const c = candidates(build(), createAgentRandom(778));

      expect(JSON.stringify(a.candidates)).to.equal(JSON.stringify(b.candidates));
      // Different stream, different sampled project-card ordering - the reproducibility check
      // (G6) is about the first equality; this one just proves the rng is actually consulted.
      expect(JSON.stringify(c.candidates)).to.not.equal(JSON.stringify(a.candidates));
    });
  });
});
