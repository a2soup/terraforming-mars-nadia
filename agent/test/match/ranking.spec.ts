import {expect} from 'chai';
import {rankSeats} from '../../src/match/ranking';

/**
 * Criterion R4: `match/ranking.ts` agrees with the Engine's own rule
 * (`src/client/components/GameEnd.vue:292-320` - VP descending, then megacredits descending, with
 * the winners being everyone matching the leader on both).
 *
 * These are the constructed cases R4 pre-commits to: strict VP order, a VP tie broken by
 * megacredits, a full tie on both, and the 3-way cases. Whether a *real* tie ever occurred is a
 * separate question, and one Unit D has to answer honestly in the write-up - if the validation run
 * produces no real ties, the tie path is covered by construction only.
 */
describe('match ranking (§4.2, criterion R4)', () => {
  const seat = (index: number, victoryPoints: number, megaCredits: number) => ({seat: index, victoryPoints, megaCredits});

  it('ranks by victory points, descending', () => {
    const ranked = rankSeats([seat(0, 42, 5), seat(1, 57, 0)]);
    expect(ranked.map((r) => r.placement)).to.deep.equal([2, 1]);
    expect(ranked.map((r) => r.isWinner)).to.deep.equal([false, true]);
  });

  it('returns rankings in seat order regardless of the input order', () => {
    const ranked = rankSeats([seat(2, 10, 0), seat(0, 30, 0), seat(1, 20, 0)]);
    expect(ranked.map((r) => r.seat)).to.deep.equal([0, 1, 2]);
    expect(ranked.map((r) => r.placement)).to.deep.equal([1, 2, 3]);
  });

  it('breaks a victory-point tie on megacredits - the Engine rule, not max-VP', () => {
    const ranked = rankSeats([seat(0, 57, 3), seat(1, 57, 14)]);
    expect(ranked.map((r) => r.placement)).to.deep.equal([2, 1]);
    expect(ranked[0].isWinner, 'the driver\'s simpler max-VP rule would call this a shared win').to.be.false;
    expect(ranked[1].isWinner).to.be.true;
    // The placement was decided on megacredits, so the VP margin between them really is 0.
    expect(ranked[1].marginToNext).to.equal(0);
  });

  it('shares a placement, and the win, on a full tie of both keys', () => {
    const ranked = rankSeats([seat(0, 57, 14), seat(1, 57, 14)]);
    expect(ranked.map((r) => r.placement)).to.deep.equal([1, 1]);
    expect(ranked.every((r) => r.isWinner)).to.be.true;
    expect(ranked.every((r) => r.marginToNext === undefined), 'nothing below a full 2p tie').to.be.true;
  });

  it('shares the lower number and skips the one below it (1, 1, 3) at 3p', () => {
    const ranked = rankSeats([seat(0, 60, 5), seat(1, 60, 5), seat(2, 40, 20)]);
    expect(ranked.map((r) => r.placement)).to.deep.equal([1, 1, 3]);
    expect(ranked.map((r) => r.isWinner)).to.deep.equal([true, true, false]);
  });

  it('distinguishes second from third at 3p - what AC-5 is stated on', () => {
    const ranked = rankSeats([seat(0, 71, 2), seat(1, 55, 9), seat(2, 63, 0)]);
    expect(ranked.map((r) => r.placement)).to.deep.equal([1, 3, 2]);
    // A boolean "won" would collapse seats 1 and 2 into the same record.
    expect(ranked.filter((r) => r.isWinner)).to.have.length(1);
  });

  it('ties for second, leaving first alone', () => {
    const ranked = rankSeats([seat(0, 80, 0), seat(1, 50, 7), seat(2, 50, 7)]);
    expect(ranked.map((r) => r.placement)).to.deep.equal([1, 2, 2]);
    expect(ranked[0].marginToNext).to.equal(30);
    expect(ranked[1].marginToNext, 'nothing below the shared second place').to.be.undefined;
  });

  it('measures marginToNext to the head of the next placement group', () => {
    const ranked = rankSeats([seat(0, 90, 0), seat(1, 70, 0), seat(2, 40, 0), seat(3, 10, 0)]);
    expect(ranked.map((r) => r.marginToNext)).to.deep.equal([20, 30, 30, undefined]);
  });

  it('handles a four-way tie', () => {
    const ranked = rankSeats([0, 1, 2, 3].map((index) => seat(index, 44, 6)));
    expect(ranked.map((r) => r.placement)).to.deep.equal([1, 1, 1, 1]);
    expect(ranked.every((r) => r.isWinner)).to.be.true;
  });
});
