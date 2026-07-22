import {InputResponse} from '@/common/inputs/InputResponse';
import {DecisionPoint, EmbeddedDecisionPoint} from './decisionPoint';

/**
 * The portable decision-making seam (SRS FR-INT-3): `decide(observation) -> action`,
 * implementable identically for embedded and live-play transports.
 */
export type Responder = (decision: DecisionPoint) => InputResponse;

/**
 * Embedded-only seam for search/self-play code that needs the raw Engine PlayerInput
 * (decisionPoint.ts). Not assignable where a live-play Responder is expected.
 */
export type EmbeddedResponder = (decision: EmbeddedDecisionPoint) => InputResponse;
