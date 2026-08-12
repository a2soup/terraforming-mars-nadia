# Widening the move set — a design for the three decisions Nadia currently cannot express

**Date:** 11 Aug 2026 · **Status:** design proposal, not a source of truth · Companion to
[Milestone3_Readiness_Review.md](Milestone3_Readiness_Review.md) §2

The readiness review named three limitations: payments collapse to one cheapest-legal allocation;
research-phase buying can only take none, one, or all; and the opening's card and prelude selection
is a random draw. Each is a *move-generation* limit, so no evaluation function fixes it — the good
move is not in the list being scored. This document is how to fix them.

---

## 1. They are one limitation, not three

Today the agent has exactly one way to find out what a move is worth: **fork the game, play the move
into the clone, and look at where it lands.** Call it *fork-and-score*. It is a good mechanism — it
costs about 1 ms, it is validated over 26,026 experiments, and it is right about every rule because
the Engine resolves the move.

All three failures are places where fork-and-score is unavailable or combinatorially blocked:

| Decision | What fork-and-score does | Why it isn't enough |
| --- | --- | --- |
| **Payment** | Works fine | `cards × payments` blows past the 64-candidate cap, for a factor that changes only leftover resources |
| **Research buy** | Works fine | 2ⁿ subsets; and at one ply a bought card scores **zero**, so the agent computes that buying is a pure loss |
| **Opening** | **Impossible** — no forkable ancestor exists before the first action phase | All 1,000 measured `initialCards` decisions fell back to random |

So the root fix is not three reductions. It is the thing Milestone 3 was going to build anyway:

> **A static evaluator that can price a position, a card, and a resource *without playing them*.**

With that in hand, the pattern for all three is the same and it is the pattern strong humans use:

> **Static evaluation proposes; fork-and-score disposes.**

Rank the options cheaply and analytically, then spend the ~1 ms forks only on the short list.

Concretely, the evaluator needs to expose three prices rather than one score:

| Price | Signature (shape, not final API) | Used by |
| --- | --- | --- |
| **Position value** | `value(observation) → number` | Everything; the main M3 deliverable |
| **Card value** | `cardValue(card, context) → M€-equivalent` | Research buying, the opening, hand valuation |
| **Hold value** | `holdValue(resource, k, context) → M€-equivalent of keeping the k-th unit` | Payments |

---

## 2. Payments — change the assumption, not the machinery

**The insight that makes this small.** The current cheapest-legal rule is already a shadow-price
rule. It spends resources in increasing order of megacredit value: steel (2) before titanium (3),
megacredits last. That is exactly optimal **under the assumption that a resource is worth to you
precisely what it pays for** — that a steel in hand is worth 2 M€ because it pays 2 M€.

That assumption is what's wrong, and it is wrong in a small number of identifiable situations. So
the fix is to let the evaluator supply the *holding* value separately from the *paying* value, and
leave everything else alone.

### The mechanism

1. **Legality stays exactly where it is.** A payment is legal iff
   `player.canSpend(payment, reserve) ∧ player.payingAmount(payment, options) ≥ cost` — the Engine's
   own predicate, verbatim, applied to the final answer as `cheapestLegalPayment` already does.
2. **Exchange rates stay with the Engine.** `player.payingAmount({steel: 1}, options)` returns 2, or
   3 with Advanced Alloys, or 0 when steel isn't payable here. Nothing is hardcoded — the existing
   code already probes one unit at a time and that must not change (CON-1).
3. **New: the evaluator supplies `holdValue(resource, k)`** — what keeping the k-th unit is worth.
4. **Choose the payment minimising total hold-value spent, subject to covering the cost.** Because
   `payingAmount` is linear per resource (an existing, documented assumption the M1 allocator already
   rests on), this is a tiny exact dynamic program over "megacredit value covered" — at most ~40
   states and four resource types in scope. Microseconds, no forks.

When `holdValue(r, k) == payingAmount({r: 1})` for every resource, this returns exactly today's
cheapest-legal payment. **Profile 1 is the degenerate case of profile 2**, which makes the change
easy to verify and easy to reason about.

### The worked example you named

You have **Electro Catapult** in play (action: spend 1 steel → 7 M€, once per generation), 4 steel,
20 M€, and you want to play a 16 M€ building card.

*Today:* steel pays 2, so the allocator spends all 4 steel (8 M€ of value) plus 8 M€. You end with 0
steel. Electro Catapult does not fire this generation. **The mistake costs 7 M€** and the agent
cannot see it, because from the objective's point of view nothing happened.

*With hold values:* `holdValue(steel, 1) ≈ 6` (7 M€ next action, lightly discounted for timing);
`holdValue(steel, 2..4) = 2` (ordinary). Ranked by hold-value-per-M€-of-payment: ordinary steel 1.0,
megacredits 1.0, the last steel 3.0. So the DP spends 3 steel (6 M€) + 10 M€ and **keeps one steel**.
Same card, same turn, 7 M€ better.

**Space Elevator is the sharper version of the same trap**, because it is dealt from both sides: it
costs 27, carries *both* the space and building tags — so steel and titanium can both pay for it —
and its own action is *spend 1 steel → 5 M€*. Paying for it with every steel you own destroys the
resource the card exists to consume. A cheapest-legal allocator does exactly that, every time.

### What else falls out of the same change, for free

- **End-game dumping.** In the final generation `holdValue` for steel and titanium collapses toward
  0 (nothing left to play), so the agent spends them freely instead of hoarding — the correct
  behaviour, with no special case.
- **Titanium held for a known space card.** If the hand contains a 26 M€ space card you intend to
  play next generation, `holdValue(titanium, k)` stays high and the agent pays this turn's building
  card in steel and megacredits instead.
- **Helion heat.** Heat pays 1 M€ under Helion but is also 8-heat-to-a-temperature-step. When a
  temperature raise is reachable and valuable, `holdValue(heat, k)` exceeds 1 and the agent stops
  burning heat as currency.

All four behaviours come from one function. That is the argument for doing it this way rather than
hand-listing payment variants.

### Optional second stage

If you want fork-verification of payment choices rather than trusting the analytic price: take the
top *k* cards by canonical payment (k = 3), expand each with its best 2 payment variants, and
fork-score those 6. That is +6 forks on a decision that already costs 6–19 — affordable, and it
keeps the search honest about the analytic model.

---

## 3. Research buying — enumerate the set, then price the hand

There are two problems here and only one of them is the candidate set.

### The easy half: enumerate

Four cards are dealt (five in the Mars Maths / Luna Project Office edge cases). All subsets of four
is **sixteen**. Just enumerate them — exhaustively, whenever `2ⁿ ≤ 64` (i.e. n ≤ 6), and fall back to
the ranking reduction below beyond that. Sixteen forks at ~1 ms, roughly eleven times a game per
seat, is nothing.

For the general case (the ten-card opening hand, or any large `SelectCard`): **rank by `cardValue`,
then take prefixes** — buy the best 0, best 1, best 2, … up to the budget. This is what a strong
player actually does at the research phase: rank the four, then decide how deep to buy. It produces
at most `max + 1` candidates instead of 2ⁿ, and it is exact whenever card values are additive. Add
two or three single swaps (exchange the marginal bought card for the next-ranked one) to catch the
combos where they are not.

### The hard half: a bought card is worth nothing at one ply

This is the part that will actually decide whether the agent buys well, and it is worth being blunt
about it: **enumerating the sixteen subsets on its own will make the agent buy nothing.**

At the moment of the research decision, spending 3 M€ on a card produces a position with 3 M€ less
and one more card in hand. Card VP is zero until it's played. So under any objective that doesn't
price cards in hand, "buy nothing" strictly dominates and the agent will correctly choose it, every
generation, forever. This is precisely the failure the greedy baseline's own documentation warns
about in a different guise — an agent that "never buys a card and never plays one."

So `cardValue(card, context)` must exist before the enumeration is worth anything. Roughly:

```
cardValue(card) ≈ P(playable before the game ends)
                × discount(expected generation of play)
                × (contribution of playing it − its cost)
                − the 3 M€ purchase price
```

with `contribution` coming from the card-feature schema: production gained × generations remaining,
VP, tile and TR effects, tag synergies with what's already in the tableau. Cards you will never
afford or never want score zero and correctly get left in the pile.

This is the same function the opening needs, and it is the reason the card-feature schema is the
keystone of Milestone 3 rather than a supporting task.

---

## 4. The opening — staged static evaluation

**There is no fork here and there never will be.** The snapshot guard refuses the pre-action phases
as unfaithful, and every one of them precedes the first action phase, so no ancestor exists to replay
from. This is structural, not a tuning parameter. The opening is scored statically or it is scored
not at all.

### The space

Per player: **2 corporations dealt, 4 preludes dealt (choose 2), 10 project cards offered at 3 M€
each**, with the total card spend capped by the chosen corporation's starting megacredits — a
constraint the Engine enforces on the composite, which the existing code already handles correctly by
driving `enumerateInitialCards` rather than restating the rule. Keep that.

Naively that's 2 × C(4,2) × 2¹⁰ = 12,288 combinations. Staged, it is about 130.

### The staging

```
for each corporation (2):
  for each prelude pair (C(4,2) = 6):
    budget  ← corporation's starting M€
    ranking ← the 10 project cards sorted by cardValue(card | this corporation, these preludes)
    for k in 0 .. min(10, floor(budget / 3)):
      candidate ← (corporation, prelude pair, top-k cards of the ranking)
```

≈ 12 × 11 = **132 candidates, each scored by a static opening evaluator, no forking, milliseconds.**

Three things make this work rather than merely look tidy:

- **The ranking must be recomputed per (corporation, prelude) pair.** This is the whole reason the
  current sampled-once approach is wrong. Helion wants heat cards; a titanium corporation wants space
  cards; Tharsis Republic wants cities; a card-draw prelude changes what's worth holding. A single
  global ranking would reproduce the existing bug in a more expensive form.
- **A refinement pass.** From the best (corp, preludes, k), try swapping the marginal bought card for
  the next two or three in the ranking, and re-score. Prefix selection assumes additivity; this
  catches the pairs that need each other.
- **Preludes are the easiest cards in the game to value statically.** Their effect is immediate,
  numeric, and almost entirely "resources now plus production" — which is exactly what a
  production-weighted-by-remaining-generations feature set handles well. Do not be put off by the
  opening being unforkable; this particular sub-problem is friendly.

### The corporation prior

Bullet 4's table enters here and only here: a **weak additive term on the corporation component**,
with the weight chosen by Milestone 3 (the data layer deliberately applies none). Use the
`separatedFromChance` flag — only 8 of 17 rows are distinguishable from chance, and the middle nine
must not be ranked against each other. Remember the two recorded biases: it is 3-player data priming
a 2-player-primary agent, and WAP is an Elo residual on roughly [−2, +2], not a win rate. The harness
overrules it the moment it has an opinion.

---

## 5. Guardrails while doing this

1. **Candidate profiles first.** `greedy-1ply@1` must keep generating exactly the moves it generated
   when it was adjudicated. Pin it to profile 1; build all of the above as profile 2. See the
   readiness review §1 — this is the one-way door.
2. **`npm run candidates` is the safety net, and it is already built.** It plays real games and
   submits *every* generated candidate into a throwaway fork, recording what the Engine did with it.
   Run it at ≥ 200 games for any new profile before the profile is used for a strength claim. An
   expanded move set is exactly the change class that produces illegal moves, and this is the
   instrument that catches them cheaply — well before the AC-1 battery at promotion time.
3. **The 64-cap's uniform subsample becomes wrong and must change.** Today candidates are
   homogeneous, so sampling 64 of them uniformly is unbiased. Once the set contains ranked payment
   variants and ranked subsets, a uniform subsample can throw away the best move at random. Either
   guarantee the reductions never exceed the cap, or make the cap a **ranked truncation** — keep the
   top 64 by static score. Do not leave a uniform sample sitting under a ranked generator.
4. **Re-run the AC-1 legality battery before promoting the M3 agent.** Unchanged, and this milestone
   is exactly why it exists: new candidate paths are new opportunities for an illegal move, and the
   M1 run found one at ~1 per 25 games that a 20-game batch could never have seen.

---

## 6. Sequencing

The order matters, because it determines how early you get a real strength signal.

| # | Work | Why here |
| --- | --- | --- |
| 1 | **Card-feature schema + `cardValue` + `holdValue`** | The keystone. Every one of the three fixes consumes it, and it is Milestone 3's main deliverable regardless. |
| 2 | **Payments** | Smallest change, self-contained, highest strength-per-hour. Measurable on its own against the frozen baseline. |
| 3 | **Research subsets** | Needs `cardValue` for the hand term; useless without it. |
| 4 | **The opening** | Needs everything above, and has no fallback mechanism if the static evaluator is weak. |
| 5 | **Tune** | Against harness win rate, with the seed and sample-size discipline from the rating pipeline. |

Note that payments can be built, validated with `npm run candidates`, and measured against
`greedy-1ply@1` **before** the rest of the evaluator is finished — it only needs `holdValue`, which is
a much smaller piece of the schema than full position evaluation. That makes it the natural first
increment and the earliest honest read on whether the approach is working.

**Effort.** None of this adds a milestone. The plan already budgets 4–8 weeks for Milestone 3 and
already calls the card-feature schema "a substantial task in its own right." What this document
changes is the *ordering* — the schema moves from a supporting work item to the first thing built,
because three separate deliverables are blocked on it.
