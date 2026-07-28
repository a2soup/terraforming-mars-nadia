import {Phase} from '@/common/Phase';
import {IGame} from '@/server/IGame';

/**
 * The Engine's real winner rule, implemented for the match harness (Milestone 2 bullet 1, §4.2).
 *
 * **Where the rule lives.** `src/client/components/GameEnd.vue:292-320` (`playersInPlace` /
 * `winners`) is the *only* place the game's tiebreak exists in this codebase: sort by
 * `victoryPointsBreakdown.total`, then by `megacredits`, both descending; the winners are everyone
 * matching the leader on **both**. There is no server-side equivalent - `Game.gotoEndGame()`
 * (`src/server/Game.ts:1116-1122`) only writes `{corporation, playerScore}` rows to the database
 * and never ranks. Do not go looking for one.
 *
 * This module reads the same two quantities off the server-side objects the client's model is
 * built from: `player.getVictoryPoints().total` and `player.megaCredits`.
 *
 * **Why this is a new file and `driver/gameResult.ts` is not touched** (hazard H1). `computeResult`
 * ranks by max VP alone and says so in its own doc comment - "Real tiebreaking belongs to the match
 * harness/ratings pipeline (Milestone 2), not this driver." This is that harness. But
 * `determinism/replay.ts:158-162` hashes `JSON.stringify(GameResult)` into a
 * `ReplayFingerprint.resultHash`, and 300 of those hashes are committed in
 * `docs/data/determinism_corpus.json` as a standing regression check. Adding a field to
 * `GameResult`, or changing `computeResult`'s winner rule, would invalidate all 300 fingerprints
 * and would look exactly like a determinism regression. So the correct rule lives here, and the
 * driver keeps its deliberately simpler one.
 *
 * **Placement, not a boolean win.** AC-5 is stated in placement terms ("finishes first at a rate
 * significantly above the 1/N chance baseline"), and a 3p record that says only `won: false`
 * cannot distinguish second from third. Ties share the lower placement number (1, 1, 3), which is
 * the same convention the Engine's `winners` uses when it returns more than one player.
 */

/** The two quantities the rule sorts on, plus which seat they belong to. */
export type RankableSeat = {
  /** 0-based seat index (position in `game.players`). */
  seat: number;
  victoryPoints: number;
  megaCredits: number;
};

export type SeatRanking = RankableSeat & {
  /** 1-based; seats tied on *both* keys share the lower number. */
  placement: number;
  /** True for every seat at placement 1 - matching `GameEnd.vue`'s `winners`. */
  isWinner: boolean;
  /**
   * VP gap down to the best seat in the next placement group; `undefined` at the last placement.
   * Note this is a **VP** margin even when the placement was decided on megacredits, in which case
   * it is 0 - which is the honest answer, and is why the megacredit values are kept on the record.
   */
  marginToNext: number | undefined;
};

/**
 * Ranks seats by the `GameEnd.vue` rule. Returns one entry per input seat, **in ascending seat
 * order** regardless of the input's order, so a caller can index the result by seat.
 */
export function rankSeats(seats: ReadonlyArray<RankableSeat>): ReadonlyArray<SeatRanking> {
  if (seats.length === 0) {
    return [];
  }

  // Descending on victoryPoints, then on megaCredits. `GameEnd.vue` expresses this as an ascending
  // comparator followed by `.reverse()`; the two are the same ordering, and the seat-order sort at
  // the end of this function makes any residual instability in equal-key runs unobservable.
  const sorted = [...seats].sort((a, b) => b.victoryPoints - a.victoryPoints || b.megaCredits - a.megaCredits);

  const placements: Array<number> = [];
  for (const [index, seat] of sorted.entries()) {
    const previous = sorted[index - 1];
    const tied = previous !== undefined &&
      previous.victoryPoints === seat.victoryPoints &&
      previous.megaCredits === seat.megaCredits;
    placements.push(tied ? placements[index - 1] : index + 1);
  }

  const ranked = sorted.map((seat, index) => {
    // The first seat below this one on a strictly worse placement - i.e. the head of the next
    // placement group, which is the best score this seat actually beat.
    const next = sorted.find((_, other) => placements[other] > placements[index]);
    return {
      ...seat,
      placement: placements[index],
      isWinner: placements[index] === 1,
      marginToNext: next === undefined ? undefined : seat.victoryPoints - next.victoryPoints,
    };
  });

  return ranked.sort((a, b) => a.seat - b.seat);
}

/**
 * Ranks a game that has reached `Phase.END`, reading the same two quantities the client's model
 * exposes. Throws before `Phase.END` - a mid-game "ranking" would be a snapshot of an unfinished
 * game presented as a result.
 */
export function rankGame(game: IGame): ReadonlyArray<SeatRanking> {
  if (game.phase !== Phase.END) {
    throw new Error(`rankGame called on game ${game.id} before it reached Phase.END (phase is '${game.phase}').`);
  }
  return rankSeats(game.players.map((player, seat) => ({
    seat,
    victoryPoints: player.getVictoryPoints().total,
    megaCredits: player.megaCredits,
  })));
}
