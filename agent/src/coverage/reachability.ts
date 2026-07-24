import {CardName} from '@/common/cards/CardName';
import {CardScope, CensusSection} from './types';

/**
 * K2: classifies every in-scope manifest entry by whether it can actually appear in a Nadia
 * 2-4p Tharsis game, and cites the Engine code that decides it (Milestone1_Bullet7_Prompts.md,
 * Phase M section 3 / hazard H3).
 *
 * This function encodes `Game.getStandardProjects()` (`src/server/Game.ts:1630-1662`) in full for
 * the switch cases that can fire on an in-scope entry, plus the one runtime filter
 * (`GameCards.getCorporationCards()`, `src/server/GameCards.ts:88`) that removes
 * `BEGINNER_CORPORATION` after the manifest is built. Every other in-scope entry is `reachable`:
 *
 * - No in-scope factory carries `compatibility` (verified in census.ts by respecting it anyway,
 *   should that ever change) - `CardFactorySpec.isCompatibleWith` never excludes an in-scope card.
 * - `GameCards.filterBannedCards` can only remove a card via `gameOptions.bannedCards`, which
 *   Nadia's config never sets (`DEFAULT_GAME_OPTIONS.bannedCards === []`, `NADIA_GAME_OPTIONS`
 *   in census.ts doesn't override it) - never fires.
 * - `GameCards.filterReplacedCards` can only remove a card present in another *active* module's
 *   `cardsToRemove`. Base, Corporate Era and Prelude declare no `cardsToRemove` at all (only
 *   `PROMO_CARD_MANIFEST` does, and Promo is off in Nadia's config) - never fires. This is the H9
 *   rename-resolution rule for this bullet: `CARD_RENAMES` and `cardsToRemove` both exist and are
 *   both currently inert for Nadia's in-scope set; a census that ignored them would still be
 *   correct today but would need this same check re-run (not re-derived) at Milestone 2, when
 *   FR-DATA-1's BGA reconciliation may activate a module that does use one or the other.
 * - Whether a project card or prelude's own `canPlay` can *never* be satisfied on 2-4p Tharsis is
 *   not something this mechanical pass can decide by inspection; that distinction (genuinely
 *   unreachable vs. merely hard to play) belongs to the play sweep's diagnosis (Phase M section 5)
 *   and Phase R's reading, not to a static classifier here.
 */
export function classifyReachability(cardName: CardName, section: CensusSection): {scope: CardScope; scopeReason: string} {
  if (section === 'corporationCards' && cardName === CardName.BEGINNER_CORPORATION) {
    return {
      scope: 'unreachable-in-config',
      scopeReason: 'GameCards.ts:88 - GameCards.getCorporationCards() filters out BEGINNER_CORPORATION unconditionally.',
    };
  }

  if (section === 'standardProjects') {
    switch (cardName) {
    case CardName.SELL_PATENTS_STANDARD_PROJECT:
      return {
        scope: 'reachable-by-other-route',
        scopeReason: "Game.ts:1637 - Game.getStandardProjects() excludes it ('sell patents is not displayed as a card'); it is offered through a different decision route instead.",
      };
    case CardName.BUFFER_GAS_STANDARD_PROJECT:
      return {
        scope: 'unreachable-in-config',
        scopeReason: 'Game.ts:1640 - shown only when `this.isSoloMode() && gameOptions.soloTR`; Nadia is always 2-4p, so this is never true.',
      };
    default:
      return {
        scope: 'reachable',
        scopeReason: 'Game.ts:1630-1662 - no case in the switch excludes this card under Nadia\'s options; falls through to `return true`.',
      };
    }
  }

  return {
    scope: 'reachable',
    scopeReason: 'No in-scope compatibility gate, banned-card entry, or cardsToRemove entry applies (GameCards.ts, CardFactorySpec.ts) - see classifyReachability\'s doc comment.',
  };
}
