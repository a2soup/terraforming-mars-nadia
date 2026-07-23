import {expect} from 'chai';
import {createGame} from '../../src/engine/gameFactory';
import {toDecisionPoint, EmbeddedDecisionPoint} from '../../src/driver/decisionPoint';
import {randomLegalAgent} from '../../src/core/randomLegalAgent';
import {OutOfScopeDecisionError} from '../../src/core/enumerator';
import {createAgentRandom} from '../../src/core/rng';
import {SelectOption} from '../../../src/server/inputs/SelectOption';
import {PlayerInputModel} from '../../../src/common/models/PlayerInputModel';
import {IPlayer} from '../../../src/server/IPlayer';
import {IGame} from '../../../src/server/IGame';
import {PlayerInput} from '../../../src/server/PlayerInput';

function fakeDecision(type: PlayerInputModel['type']): EmbeddedDecisionPoint {
  return {
    player: {id: 'p-test'} as unknown as IPlayer,
    model: {type} as PlayerInputModel,
    game: {} as IGame,
    raw: {} as PlayerInput,
  };
}

describe('randomLegalAgent', () => {
  it('produces an Engine-accepted response for an option decision', () => {
    const game = createGame({players: 2, seed: 1});
    const [player] = game.playersInGenerationOrder;
    const input = new SelectOption('Confirm');
    const decision = toDecisionPoint(player, input);

    const agent = randomLegalAgent(createAgentRandom(0));
    const response = agent(decision);

    expect(response).to.deep.equal({type: 'option'});
    expect(() => input.process(response)).to.not.throw();
  });

  it('propagates OutOfScopeDecisionError unmodified for an out-of-scope expansion type, logging it loudly rather than swallowing it (SRS FR-9)', () => {
    // Vestigial-test cleanup (sub-task E, item 5): before sub-task D (composite.ts) registered
    // the composite/distribution enumerators, 'or' was an in-scope type with no enumerator yet,
    // so this test used to exercise NotYetImplementedDecisionError propagation through
    // `agent(fakeDecision('or'))`. That path no longer exists - every in-scope §3.3 type is
    // registered (enumerator/index.ts's dispatch-table doc comment; enumerator.spec.ts's coverage
    // test) - so what's left to protect here is a real, still-reachable path: `party` (Turmoil)
    // is a genuinely out-of-scope expansion type (CLAUDE.md §1) that `enumerate` classifies via
    // `SCOPE` and throws `OutOfScopeDecisionError` for, regardless of engine-pin changes. This
    // exercises the agent's actual FR-9 handling (randomLegalAgent.ts) end to end: the error must
    // surface unmodified to the caller (never silently swallowed or downgraded to a "best-effort"
    // move - there is no legal move for an expansion the enumerator has no model of), *and* it
    // must be logged loudly regardless of the (default-off) FR-11 trace-logging setting, since an
    // out-of-scope decision arising in base + Corporate Era + Prelude play is itself a
    // scope/coverage finding worth flagging (Running_Notes, 2026-07-22 "Reds policy").
    const agent = randomLegalAgent(createAgentRandom(0));
    const decision = fakeDecision('party');

    const originalConsoleError = console.error;
    const errorLogs: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorLogs.push(args);
    };
    try {
      expect(() => agent(decision)).to.throw(OutOfScopeDecisionError);
    } finally {
      console.error = originalConsoleError;
    }
    expect(errorLogs, 'an out-of-scope decision must be logged loudly, not silently swallowed').to.have.length(1);
  });

  describe('per-decision trace logging (SRS FR-11 / NFR-6)', () => {
    it('is off by default - no console output for a normal decision', () => {
      const game = createGame({players: 2, seed: 1});
      const [player] = game.playersInGenerationOrder;
      const decision = toDecisionPoint(player, new SelectOption('Confirm'));

      const originalConsoleLog = console.log;
      const logs: unknown[][] = [];
      console.log = (...args: unknown[]) => {
        logs.push(args);
      };
      try {
        randomLegalAgent(createAgentRandom(0))(decision);
      } finally {
        console.log = originalConsoleLog;
      }
      expect(logs, 'FR-11 trace logging must be off by default').to.have.length(0);
    });

    it('logs the player, decision type, and chosen move when logDecisions is enabled', () => {
      const game = createGame({players: 2, seed: 1});
      const [player] = game.playersInGenerationOrder;
      const decision = toDecisionPoint(player, new SelectOption('Confirm'));

      const originalConsoleLog = console.log;
      const logs: unknown[][] = [];
      console.log = (...args: unknown[]) => {
        logs.push(args);
      };
      try {
        randomLegalAgent(createAgentRandom(0), {logDecisions: true})(decision);
      } finally {
        console.log = originalConsoleLog;
      }
      expect(logs).to.have.length(1);
      const [message] = logs[0] as [string];
      expect(message).to.include(player.id);
      expect(message).to.include('option');
    });
  });

  it('is a pure function of its rng seed - same seed yields the same choice', () => {
    const decision = (() => {
      const game = createGame({players: 2, seed: 1});
      const [player] = game.playersInGenerationOrder;
      return toDecisionPoint(player, new SelectOption('Confirm'));
    })();

    const first = randomLegalAgent(createAgentRandom(42))(decision);
    const second = randomLegalAgent(createAgentRandom(42))(decision);
    expect(first).to.deep.equal(second);
  });
});
