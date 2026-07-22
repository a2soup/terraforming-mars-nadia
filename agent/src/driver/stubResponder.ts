import {InputResponse} from '@/common/inputs/InputResponse';
import {DecisionPoint} from './decisionPoint';

/**
 * Thrown by `stubResponder` for any decision type it doesn't structurally understand.
 * Carries the decision point so a caller (typically a test) can inspect exactly where
 * the game got to.
 */
export class UnsupportedDecisionError extends Error {
  constructor(public readonly decision: DecisionPoint) {
    super(`stubResponder cannot handle decision type '${decision.model.type}' for player ${decision.player.id}.`);
  }
}

/**
 * A minimal, content-agnostic responder: no knowledge of any specific card, corp, or
 * strategy, only the generic shape of a decision. It exists to prove out the driver's
 * mechanics (agent/src/driver/embeddedDriver.ts) in tests, not to play a full game -
 * that's the legal-action enumerator and random-legal agent (Milestone 1, next
 * bullet). It handles exactly the two decision types the Engine's initial
 * corporation/card-selection flow uses ('initialCards' and 'card'), always picking
 * the first `min` offered options - never more, since not every card is affordable
 * for every dealt corporation. Any other decision type throws
 * `UnsupportedDecisionError`.
 */
export function stubResponder(decision: DecisionPoint): InputResponse {
  const {model} = decision;

  switch (model.type) {
  case 'initialCards':
    return {
      type: 'initialCards',
      responses: model.options.map((option) => stubResponder({...decision, model: option})),
    };
  case 'card':
    return {
      type: 'card',
      cards: model.cards.slice(0, model.min).map((card) => card.name),
    };
  default:
    throw new UnsupportedDecisionError(decision);
  }
}
