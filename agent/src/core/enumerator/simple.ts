import {DecisionEnumerator} from './types';

/**
 * Enumerators for the "simple" decision types - those whose legal set is a short, directly
 * enumerable list (no payment math, no nested sub-decisions).
 *
 * Milestone 1 sub-task B fills in the rest of this file: `space`, `player`, `resource` (pick
 * one from the offered set), `amount` (an integer in [min, max]), and `card` (a subset of
 * size [min, max]). `option` lives here as the first, trivial member - it also proves out the
 * dispatch wiring (enumerator/index.ts) end to end.
 */

/**
 * `option` (SelectOption, src/server/inputs/SelectOption.ts): a single confirm/take. The
 * Engine accepts exactly one response shape and ignores everything else about the model, so
 * there is precisely one legal move regardless of the rng.
 */
export const enumerateOption: DecisionEnumerator = () => {
  return {type: 'option'};
};
