**Implementation Plan**

An Expert-Level AI Agent for Terraforming Mars

**Project:** Terraforming Mars AI **Document:** Implementation Plan **Version:** 1.6 (Draft) **Date:** 24 July 2026 **Prepared for:** Austin Campbell **Companion:** Software Requirements Specification (SRS) v1.4 **Chosen approach:** Hybrid - heuristics + search first, then reinforcement learning

**Revision history**

  - **v1.6 (24 Jul 2026):** Records a standing caveat on the just-completed AC-1 legality run (agent/docs/AC1_Legality_Run.md, v1.5 below): **AC-1 is agent-specific and expires silently on every promoted agent version.** The Milestone-1 run proves the *random-legal* agent's legality; it says nothing about M3's heuristic agent, M4's search agent, M5's hardened agent, or any M6 promoted network. This is not a theoretical concern - the M1 run itself found and fixed a real illegal-move-producing defect that a 20-game batch never surfaced. Added as a new Section 7.2 risk row and as an explicit re-run reminder in each of M3, M4, M5, and M6's own exit criteria, so a planning agent scoping any individual milestone encounters it without needing to read the risk register separately. No milestone, acceptance-criteria, or scope changes.
  - **v1.5 (24 Jul 2026):** Milestone 1's **exit criterion is met in full**. The 1,000-game AC-1 legality run is complete and all seven pre-committed criteria pass (agent/docs/AC1_Legality_Run.md): 1,500 consecutive embedded games in one process - 1,000 at 2p plus 250 each at 3p/4p - with 1,500 completions, zero crashes, zero unrecovered illegal moves, and **zero Agent-attributable illegal-move rejections across 444,680 submissions**, so AC-1's legality clause and NFR-4 are both satisfied under the strict reading rather than a lenient one. The run defined "an illegal move" explicitly (a move submitted to the Engine and rejected by it), counted all three populations of `player.process()` rejection separately, and **found and fixed a genuine enumerator defect that the earlier ~20-game batch could not have surfaced** (59 rejected `initialCards` submissions from a budget constraint held in a sibling sub-response). Long-run heap stability across 1,500 games is now evidenced, closing a gap the determinism write-up recorded as unverified, and cross-runner determinism (compiled build vs `tsx`) is established alongside bullet 6's cross-process result. The card-coverage audit is the one remaining Milestone-1 work item and does not gate the exit criterion. No milestone, acceptance-criteria, or scope changes.
  - **v1.4 (24 Jul 2026):** Milestone 1's Engine-determinism verification (bullet 6) is complete and **all six pre-committed criteria are met** (agent/docs/Determinism_Verification.md). Embedded games are reproducible move-for-move under fixed seeds - 300 configs in-process, 24 cross-process, 12 after 100 games of interference and under interleaving - and the Engine/Agent seed separation required by CON-5 is now enforced structurally rather than by convention. The risk-register entry for Engine non-determinism is downgraded from **Medium** to **Low** with the measurement cited; three new rows record the residual non-determinism NFR-5 requires to be isolated (the env-gated wall-clock cache sweep, now guarded at bootstrap; the process-wide `GameLoader` cache and its id collision, unreachable today but reopened by Milestone 5; and unseeded live-play seed selection, an M5 design constraint). The Milestone-4 seed contract is settled and recorded: independent per-consumer RNG streams addressed by name, derived by hashing `(runSeed, label)` from a single run seed, with per-component override as the Milestone-2 match harness's primary path. Milestone 1's exit criterion now has its reproducibility clause evidenced; the 1,000-game AC-1 legality run and the card-coverage audit remain outstanding. No milestone, acceptance-criteria, or scope changes.
  - **v1.3 (24 Jul 2026):** Milestone 1's gating simulator-speed spike is complete and **passed** (agent/docs/Simulator_Speed_Spike.md): measured state-clone cost is 0.979 ms per fork against a pre-committed >= 1,000-simulations-per-decision gate, met at ~5,248 (depth-10 truncated rollouts, free leaf eval) to ~3,442 (1 ms leaf eval) - no rescope triggered. Milestone 4's exit criterion `N` is set to **1,000** simulations per decision (reference hardware: Apple M2, 8 cores, compiled Node build); NFR-2's hard target `X` is set to **<= 2 ms per fork** in the companion SRS v1.3. The risk-register entry for state-clone cost is downgraded from **High** to **Low**, with the measurement cited as evidence. The plan’s suggested incremental apply/undo copy path is recorded as investigated and rejected (no undo journal exists in the Engine; building one would require mutation tracking that violates CON-1; unnecessary given the margin by which the gate was met). A new sub-risk is added: self-play throughput and the NFR-1 live-play budget are different operating points, and Milestone 6 must budget self-play at roughly 250-500 simulations per decision, not the live-play figure. No other milestone, acceptance-criteria, or scope changes.
  - **v1.2 (21 Jul 2026):** Integrated per adversarial review. Milestone 1 gains a **gating simulator-speed spike**, Engine-determinism verification, and a card-coverage audit; M3 a card-feature schema; M4 a first-class belief model and a search-depth exit criterion; M5 live-state reconstruction and a protocol spike; M6 a hierarchical policy head and 2p-scoped RL. Acceptance references updated (primary bar AC-1 / AC-4 / AC-6; distribution demoted to AC-8 calibration). Data guardrails consolidated (full statement in Appendix A). Risk register expanded (clone cost, action space, determinism, human availability). “Expert-competitive M5” claims softened to “measured at the post-M5 gate.” Engine commit to be pinned (`<TBD-PIN>`).
  - **v1.1:** Added expert-dataset material and the M2 expert-comparison report (retained; role narrowed to calibration in v1.2).
  - **v1.0:** Initial draft.

**Contents**

# 1. Strategy and Guiding Principles

This plan builds the Agent specified in the SRS in deliberately ordered stages, each producing something playable and measurable. The order is chosen so that value appears early and the riskiest, most expensive work (reinforcement learning) is attempted only on a foundation that already works.

## 1.1 Five principles

  - **Reuse the Engine as ground truth.** The terraforming-mars codebase already implements and tests hundreds of cards and every rule in scope. Re-implementing that would be an enormous, bug-prone effort. Instead the Agent drives the existing Engine both for live play and - headless - as the simulator for search and self-play. This single decision removes most of the project’s rules risk.

  - **Always have a working player.** From the first milestone there is an agent that finishes legal games. Every later stage strengthens a working system rather than integrating toward a first result at the end.

  - **Measure everything.** A match harness and rating pipeline are built early (Milestone 2) and every subsequent change is judged by win rate against fixed baselines, not by intuition.

  - **Separate strategy from plumbing.** The decision core is isolated behind one interface so it runs identically embedded or over HTTP, and so the RL brain can replace the heuristic brain without touching the game plumbing.

  - **Earn the right to do RL.** Reinforcement learning is powerful but costly and finicky. It is attempted only after the search-plus-heuristics agent is strong, because that agent provides the simulator, the baselines, the features, and a warm-start policy that make RL tractable.

  - **Let data serve, never steer.** The expert dataset and prior-art paper measure the Agent and seed weak priors; they never define correct play. The Agent is expected to exceed expert tendencies and is never penalised for divergence the match harness shows is stronger. Full guardrails: Section 7.1 and Appendix A.

## 1.2 A note on scope and your background

You have hobby-level coding experience, not professional software training, and this is an ambitious project. The plan is structured so that the early milestones are achievable with careful, incremental work and produce a genuinely good bot on their own. The reinforcement-learning milestone is where specialist help, a collaborator, or off-the-shelf libraries will matter most; the plan flags exactly where that is and offers a reduced-scope path (stop after Milestone 5) that still yields a strong player. Nothing before Milestone 6 requires machine-learning expertise.

# 2. System Architecture

The system has four layers. Data flows up (observations) and down (actions) through a single decision-core interface, so the two “brains” (heuristic/search and, later, learned) and the two transports (embedded and HTTP) are interchangeable.

| Layer                     | Responsibility                                                                       | Key components                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 1. Engine (reused)       | Authoritative game state, rules, card logic, serialization.                          | terraforming-mars at a pinned commit; headless game runner; seed control.              |
| 2. Transport / adapter   | Deliver decision points to the core and return responses; abstract embedded vs HTTP. | Embedded driver (in-process); live-play HTTP client; state-serializer bridge.          |
| 3. Decision core         | Turn an observation into a legal, strong move.                                       | Observation encoder; legal-action enumerator; evaluator; search; move selector.        |
| 4. Training & evaluation | Produce and measure strength.                                                        | Match harness; rating pipeline; self-play generator; model trainer & checkpoint store. |

## 2.1 The key interface

Everything hinges on one function the core exposes, conceptually: decide(observation, legalActions) -> action. The transport layer guarantees that the same observation and legal-action structures reach this function whether the game is running in-process or on a remote server. The heuristic brain and the learned brain are two implementations of this one function.

## 2.2 Language choice

Two viable arrangements, decided at Milestone 1:

  - **All-TypeScript core** (runs in the Engine’s own process). Simplest integration, fastest embedded play, no cross-language bridge. Best if the strongest approach stays search-plus-heuristics.

  - **Python core + Node bridge** (Engine stays in Node; the core is Python). Adds a serialization bridge but unlocks the mature Python ML ecosystem (PyTorch, RL libraries) for Milestone 6. Recommended if RL is firmly intended.

**Recommendation:** build the Milestone 1-5 core in TypeScript for speed and simplicity, and stand up the Python bridge only when entering the RL phase, reusing the same match harness on both sides.

# 3. Why This Game Is Hard (and What Follows for Method)

Three properties of Terraforming Mars shape every methodological choice:

  - **Imperfect information.** Opponents’ hands and deck order are hidden. A method that assumes perfect information will misvalue positions. This pushes toward determinized or information-set search (ISMCTS) and toward learned value functions trained over realistic hidden states.

  - **Stochasticity.** Card draws are random. The Agent must reason about expectations, not a single future, so evaluation and search must average over sampled continuations.

  - **Enormous, structured, variable action space with a long horizon.** Each turn offers a different, sometimes large set of legal moves (which card, paid how, placed where), over ~8-12 generations and hundreds of decisions. This makes a strong static evaluation function and action masking essential, and makes credit assignment (which early move caused the win?) the central RL difficulty.

The hybrid approach answers all three: a hand-built evaluation function gives immediate, inspectable strength; determinized/ISMCTS search adds look-ahead under uncertainty; and reinforcement learning later replaces the hand-built evaluation with a stronger learned one, guided by that same search.

**Prior art corroborates this.** The TAG study (Section 1.5 of the SRS) independently found MCTS with determinized hidden information to be the strongest of its baselines, found its myopic “points now” heuristic beatable, and identified Terraform Rating and milestones/awards as the dominant win drivers - all consistent with the design here. It also shows how far a default MCTS falls short of expert play (its agents cannot even beat the solo mode), which is precisely why this plan invests in a strong evaluation, information-set search, and an RL phase rather than stopping at off-the-shelf MCTS.

# 4. Phased Roadmap

Seven milestones. Each lists its goal, the main work, and an exit criterion that must be met before moving on. Indicative effort assumes one part-time developer with occasional specialist help; treat the ranges as planning aids, not commitments.

## Milestone 1. Engine harness and a legal random player

**Goal.** Drive the Engine headless and play complete, legal games with a trivial agent - proving the interface end to end.

**Main work.**

  - Pin an Engine commit and **record its hash** in both documents (replacing the `<TBD-PIN>` placeholder); stand up a headless runner that creates a base + Corporate Era + Prelude game for 2-4 players with seed control.

  - Implement the embedded driver that surfaces each decision point (the “waitingFor” model) and applies the Agent’s response.

  - Implement the legal-action enumerator for every decision type in SRS section 3.3, built on the canonical move factorization of SRS FR-ACT-4 (payment and composite and/or/projectCard-with-payment decisions are combinatorial and need explicit reductions, not naive enumeration), and a random-legal agent on top of it.

  - Add snapshot/restore using the Engine’s serialization, so a state can be copied for search later.

  - **Simulator-speed spike (gating) - DONE, PASSED (24 Jul 2026).** Measured full-game headless runtime, serialize/deserialize (clone) round-trip time, and achievable clones/second at the pinned commit; computed how many search simulations the NFR-1 time budget actually buys. Result: ~5,248 simulations/decision at depth-10 truncated rollouts against a pre-committed >= 1,000 gate - met with 3-5x headroom, no rescope. Full results, the validated replay-from-quiescent-ancestor fork strategy, and the incremental-apply/undo-path rejection are in agent/docs/Simulator_Speed_Spike.md.

  - **Verify Engine determinism - DONE, ALL CRITERIA MET (24 Jul 2026).** Verified under fixed seeds (SRS CON-5/NFR-5) against six pre-committed criteria: 300 configs replay identically in-process, 24 in a fresh process, 12 after 100 unrelated games and under decision-by-decision interleaving; the Agent's RNG is seeded separately from the Engine's, now enforced structurally rather than by convention. Residual non-determinism is confined to four wall-clock fields that `stableState()` strips. Full adjudication, the residual-risk register, and the Milestone-4 seed contract (independent per-consumer streams, addressed by name, derived from one run seed) are in agent/docs/Determinism_Verification.md; a committed 300-fingerprint corpus makes it a standing regression check. Two hazards are unreachable *only* because embedded play never calls `GameLoader.add()`, and are flagged for re-adjudication at Milestone 5.

  - **1,000-game AC-1 legality run - DONE, ALL CRITERIA MET (24 Jul 2026).** 1,500 consecutive embedded games in a single process (1,000 at 2p, the primary setting, plus 250 each at 3p/4p): **1,500 completed, 0 crashes, 0 unrecovered illegal moves, 0 Agent-attributable illegal-move rejections across 444,680 submissions to the Engine.** Adjudicated against seven criteria (L1-L7) pre-committed in their own commit before any measurement code existed. The run settled the definitional question AC-1 leaves open - an illegal move is a move *submitted to the Engine and rejected by it* - and instrumented every `player.process()` call rather than trusting the driver's own fallback reporting, which cannot see the FR-9 fallback's own rejected branch probes. It also **found and fixed a real defect invisible at 20-game scale**: 59 rejected `initialCards` submissions (~1 per 25 games) from a budget constraint that lives in a sibling sub-response, now capped in `enumerateInitialCards`. Long-run heap is flat across 1,500 games, closing the gap the determinism write-up left open. Full results in agent/docs/AC1_Legality_Run.md; the runner is `agent/src/legality/` behind `agent/src/runner/legalityCli.ts` and exits non-zero on any incomplete game.

  - **Card-coverage audit.** Confirm that every in-scope base + Corporate Era + Prelude card and corporation is implemented and test-covered at the pinned commit (the rules-ground-truth assumption); record any gaps as known limitations.

**Exit criterion - MET (24 Jul 2026).** The random-legal agent plays >= 1,000 full games start-to-finish with zero illegal moves and zero crashes (AC-1 mechanics); embedded games are reproducible move-for-move under fixed seeds; and the simulator-speed spike has produced clone-cost and simulations-per-move numbers that make the Milestone 4/6 plan realistic (or has triggered an explicit rescope). **All three clauses are now met and evidenced: the simulator-speed spike passed (agent/docs/Simulator_Speed_Spike.md), move-for-move reproducibility is verified (agent/docs/Determinism_Verification.md), and the legality run completed 1,500 consecutive games - 1,000 at 2p plus 250 each at 3p/4p - with zero crashes, zero unrecovered illegal moves and zero Agent-attributable illegal-move rejections across 444,680 submissions (agent/docs/AC1_Legality_Run.md). The card-coverage audit is the one remaining Milestone-1 work item; it records known limitations and does not gate the exit criterion above.**

**Indicative effort.** 4-7 weeks (the legal-action enumerator for payment/nested moves and the simulator spike are each substantial; this range is optimistic for a solo hobbyist new to the codebase).

## Milestone 2. Match harness, baselines, ratings, and expert benchmark

**Goal.** Be able to measure strength - against baselines and against real experts - before trying to improve it.

**Main work.**

  - Build the match runner that plays N games between any two agent versions under controlled seeds and records full histories. Two players is the primary setting; support three players so the AC-5 competence check and the AC-8 calibration report can be produced.

  - Implement fixed baselines: random-legal and a greedy one-ply agent (the OSLA equivalent from the prior-art paper). Record the paper’s published reference numbers (default MCTS beats OSLA ~75%, random ~98%; OSLA beats random ~91%) as external sanity checks.

  - Build the rating pipeline: win rate, average VP margin, and Elo/TrueSkill with confidence intervals.

  - Build the expert-distribution report (SRS FR-DATA-1): compute, from the Agent’s own games, the same statistics the RuneDK93 dataset reports - winning score, TR at game end, generations-to-finish, and per-card/per-corporation win rates - after reconciling the BGA card set and rules version against the engine. This supports the AC-8 calibration sanity check (a smell test only, per FR-DATA-2); it is not the skill bar, which is the external AC-4 human benchmark.

  - Establish a regression suite of fixed seeds and reference games.

**Exit criterion.** The harness reports statistically sound win rates and ratings for any two agents and produces an expert-comparison report; baselines are reproducible.

**Indicative effort.** 2-4 weeks (slightly longer than v1.0 to add the expert-comparison report and BGA reconciliation).

## Milestone 3. Heuristic evaluation function

**Goal.** A single, well-tuned scoring function that estimates how good a game position is for the Agent.

**Main work.**

  - **Build the card-feature schema (prerequisite work item).** Represent every in-scope card and corporation by cost, tags, requirements, and a structured encoding of its effect, so the evaluator - and later the Milestone 6 embeddings - can value a card before it is played. The Engine enforces rules but does not hand you an evaluation-ready feature representation; building and maintaining this for the full card pool is a substantial task in its own right.

  - Define position features: TR; production weighted by remaining generations; megacredit value of resources; cards in hand; VP already secured and latent VP on the board; milestone/award standing; board adjacency and city/greenery placement; tempo.

  - Combine features into a value estimate; tune the weights against the match harness (start hand-set, then optimise). Weights are tuned to win games in the harness - not fitted to expert win-rate statistics.

  - Wrap it in a one-ply greedy-plus agent (evaluate the position after each candidate move, including expected value over sampled draws where relevant).

  - Encode expert principles as features/guards: engine-building early, efficient MC-per-VP, terraform timing near game end, milestone/award racing and denial.

  - Seed the opening book (corporation and prelude selection) with weak priors from the expert corp/card win rates, and sanity-check that the tuned agent’s own card/corp win-rate profile is not wildly inconsistent with expert play (SRS FR-DATA-2). Treat these purely as a starting bias and a smell test.

  - Respect the confounding guardrail (SRS FR-DATA-3/4): observed win rates conflate player skill, draw luck, and game length with card strength, so they are never copied into evaluation weights, and search or tuning is always allowed to override them. A card the experts win less with may still be correctly valued higher here.

**Exit criterion.** The heuristic agent beats both baselines decisively (>= 80% vs greedy, >= 90% vs random) - progress toward AC-3 - with weights justified by harness win rate, not by conformity to the dataset. **Before promoting this agent, re-run the AC-1 legality battery against it (see the risk register, Section 7.2) - AC-1 was only ever established for the Milestone-1 random-legal agent, and a one-ply evaluator can reach enumerator paths random play never did.**

**Indicative effort.** 4-8 weeks (the strategic heart of the non-RL work).

## Milestone 4. Look-ahead search under uncertainty

**Goal.** Add planning: search several moves ahead while handling hidden and random information.

**Main work.**

  - **Build the belief model (SRS FR-OBS-2), first-class component.** Track the exact undrawn-deck composition and a distribution over opponents’ hands from all observable card-flow events (draws, buys in Research, plays, discards, reveals), so determinizations are consistent with what has actually been seen - not merely with hand sizes. This bookkeeping is the hard part of imperfect-information handling and its correctness is an explicit exit condition below.

  - Implement determinized search: sample plausible completions of hidden information from the belief model, search each with the Milestone 3 evaluation, and aggregate.

  - Upgrade to Information-Set Monte Carlo Tree Search (ISMCTS) for the action phase, using the heuristic evaluation for rollouts/leaf values.

  - Add action-space pruning (drop dominated or clearly weak moves) to keep search tractable given the large branching factor.

  - Expose the strength/time budget from SRS FR-12/NFR-1 so search depth scales with the time available.

**Exit criterion.** The search agent beats the pure-heuristic agent by a statistically significant margin in the harness, **and** the search reaches a target of **>= N = 1,000** simulations per decision within the NFR-1 budget on reference hardware, with search depth/width reported. `N` is set from the Milestone 1 simulator-speed spike (agent/docs/Simulator_Speed_Spike.md): measured capability at the pinned Engine commit, depth-10 truncated rollouts, and a 1 ms leaf-evaluation allowance is ~3,442-5,248 simulations/decision on the spike’s reference hardware (Apple M2, 8 cores); 1,000 is set deliberately below that, so the criterion stays met if Milestone 3’s actual leaf evaluation costs more than modeled, if the search adds tree-management overhead the spike did not model, or on slower hardware, while remaining 10x above the spike’s own rescope floor. Determinizations are verified consistent with all observable card-flow events. The point of the depth target is that “beats the heuristic” reflects genuine look-ahead, not a trivial one-ply edge that any lookahead would win. **Before promoting this agent, re-run the AC-1 legality battery (Section 7.2) - action-space pruning and determinized search both introduce new candidate-move code paths the Milestone-1 random-legal enumeration never exercised.**

**Indicative effort.** 4-8 weeks.

## Milestone 5. Strong non-RL agent, hardened and live

**Goal.** A genuinely strong, robust player that also works in real online games.

**Main work.**

  - Tune evaluation and search jointly; add opening-book handling for corporation/prelude/initial-card selection (high-variance, high-impact decisions).

  - Build the live-play HTTP adapter (SRS FR-INT-2/4): read the server’s waitingFor model, post responses, handle out-of-turn prompts, retry on transient errors. Spike the actual server protocol early - it is an internal client-server contract (private player IDs, possibly websocket/long-poll), more fragile than a documented API.

  - **Implement live-state reconstruction (SRS FR-INT-6).** Build a simulable local Engine state from the live observation plus a determinization, so the same search used embedded can run live without touching the server’s hidden state. This is what makes the “identical core, both modes” claim (FR-INT-3) actually true; it is a required component, not a free by-product.

  - Harden: safe-fallback moves, full logging with per-decision rationale (FR-11), reproducibility checks (NFR-5).

  - Run a first human benchmark (AC-4) to locate the agent’s strength honestly.

**Exit criterion.** Completes unattended games online; establishes the reference strength that RL must beat. For a reduced-scope project this is a valid stopping point with a strong classical deliverable - but whether it clears the AC-4 skill bar is an open question resolved by measurement at the post-Milestone-5 decision gate, not assumed. If the classical agent falls short of AC-4, Milestone 6 is required, not optional. **Before declaring this milestone's exit criterion met, re-run the AC-1 legality battery in embedded mode against the hardened M5 agent (Section 7.2) - live-play hardening (safe fallbacks, retries) changes decision code paths, and AC-1's own embedded scope must be re-confirmed even though live-play reproducibility is a separate, already-flagged M5 design constraint (`ApiCreateGame.ts:176`).**

**Indicative effort.** 3-6 weeks.

## Milestone 6. Reinforcement learning via self-play (with optional expert warm-start)

**Goal.** Replace the hand-built evaluation with a stronger learned one, lifting play toward and beyond the top of human skill.

**Main work.**

  - Stand up the Python + Node bridge; expose the headless Engine as a high-throughput self-play environment with action masking.

  - Design the network: a shared state encoder feeding a value head (who is winning) and a policy head, consuming the FR-OBS feature representation plus card/tag embeddings. The policy head is **structured/hierarchical over the FR-ACT-4 action factorization** (which card, then payment, then targets/placement); a flat softmax over all legal moves does not exist for this action space, so an autoregressive/hierarchical head is required. **RL self-play is scoped to 2-player** (the AlphaZero template assumes two-player zero-sum); 3-4-player strength comes from the classical agent and transfer, not from multiplayer self-play, unless a later, explicitly-scoped effort tackles multiplayer credit assignment and kingmaking.

  - Train AlphaZero-style: self-play games use ISMCTS guided by the network; the network is trained on the outcomes and visit counts; handle imperfect information via determinization and/or observation-history input.

  - Warm-start the policy. Default: imitate the Milestone 3-5 agent’s decisions to avoid learning from scratch, then improve by self-play.

  - Optional expert warm-start (AlphaStar-style), gated on the data sub-task below: if move-level expert games are obtained and mapped onto the engine’s action space, pretrain the policy by behavioural cloning on expert moves, then fine-tune by self-play. With ~1,600 in-scope expert games this can meaningfully shorten and de-risk the RL phase. Imitation is only ever a warm-start; per SRS FR-DATA-5 the final objective remains winning by self-play, and the agent is free to unlearn expert habits that self-play shows to be suboptimal.

  - Promote a new network only when it beats the incumbent with statistical significance (FR-15/AC-7). Budget compute realistically; a fallback is a learned value function that simply replaces the heuristic inside the existing ISMCTS (cheaper, still strong).

**Exit criterion.** The learned agent beats the Milestone 5 agent with significance and shows monotonic improvement across promotions (AC-7); if warm-started from expert data, it is nonetheless evaluated on its own merits and permitted to exceed expert play. **Re-run the AC-1 legality battery (Section 7.2) at every promoted checkpoint, not only the final one** - a hierarchical policy head decoding through the FR-ACT-4 factorization is the largest change to the Agent's decision-making of any milestone, and a policy that has learned to prefer certain move shapes can find enumerator/driver edge cases no prior milestone's move distribution reached.

**Indicative effort.** 2-6 months, compute-dependent; the highest-risk milestone.

### Milestone 6 data sub-task (gate for the expert warm-start)

The RuneDK93 dataset provides aggregate statistics only, not move logs, so the optional expert warm-start above depends on a separate, clearly bounded data-engineering effort - to be undertaken only if the team chooses the imitation path:

  - Build a Board Game Arena log scraping/parsing pipeline that turns expert games into (observation, action) pairs, and map those actions onto the engine’s InputResponse action space.

  - Reconcile card-set and rules-version differences between the BGA source and the primary engine so cloned moves are legal and meaningful.

  - **Legal gate:** confirm the scraping and use comply with the platform’s Terms of Service before any collection (SRS NFR-9). If this cannot be satisfied, skip the expert warm-start entirely and use the default self-play warm-start - the plan does not depend on it.

## Milestone 7. Evaluation, tuning, and acceptance

**Goal.** Prove the Agent meets the SRS acceptance criteria and package it for use.

**Main work.**

  - Run the full acceptance battery (AC-1 through AC-8): legality, baseline dominance, head-to-head vs the tuned heuristic, the AC-4 expert human benchmark, multiplayer placement, expert review of logged games, and the AC-8 distributional calibration sanity check.

  - Fix systematic weaknesses surfaced by review; re-tune; re-measure.

  - Package operability: simple commands to start the Agent in embedded or live mode, configure strength/time budget, and read logs.

  - Write a short operator guide and record known limitations.

**Exit criterion.** All primary acceptance criteria (AC-1, AC-4, AC-6) are met and documented; supporting criteria and guardrails are met or explained.

**Indicative effort.** 3-6 weeks.

# 5. Methodology Detail

## 5.1 Heuristic evaluation (Milestone 3)

The evaluation function is a weighted sum (later possibly a small learned model) over interpretable features. Interpretability is deliberate: it lets a human sanity-check the Agent and it gives the RL phase a warm start. Feature families and the expert intuition behind them:

  - **Scoring position:** current VP plus latent VP (greeneries, city adjacencies, card VP), and TR - the single most reliable predictor of the win.

  - **Engine strength:** production tracks weighted by generations remaining (early production is worth far more than late), and megacredit-equivalent value of stored resources.

  - **Card economy:** cards in hand, and the option value of held cards versus the cost of holding them.

  - **Board and races:** tile placement and adjacency bonuses; distance to, and contention for, each milestone and award.

  - **Tempo and timing:** who is ahead on the parameter clock, and how close the game is to ending - which flips the value of terraforming versus engine-building.

## 5.2 Search under uncertainty (Milestone 4)

Because opponents’ hands are hidden and draws are random, single-line look-ahead is unsound. The Agent samples several “determinizations” - concrete guesses of the hidden information consistent with what it has seen - and searches each, then combines the results (Information-Set MCTS). Leaf positions are scored with the Milestone 3 evaluation rather than random rollouts, which is both faster and stronger. Aggressive but safe pruning of clearly dominated moves keeps the large branching factor manageable.

## 5.3 Reinforcement learning (Milestone 6)

The learned system follows the AlphaZero template adapted for imperfect information: a neural network with a value head and a policy head guides ISMCTS during self-play, and is trained on the games it generates. Two design choices de-risk it. First, warm-starting from the heuristic/search agent means the network never learns from random play. Second, a cheaper fallback is always available - keep the ISMCTS structure but replace only the hand-built leaf evaluation with a trained value network - which captures much of the benefit at a fraction of the compute. Card and tag embeddings let the network generalise across the large card pool rather than memorising each card.

**Honest caveat.** Reaching the very top of human skill via self-play can require substantial compute and ML engineering. The plan is designed so that even if Milestone 6 underdelivers, Milestone 5 already provides a strong classical player - whose standing against the AC-4 skill bar is measured at the post-Milestone-5 gate, not assumed - and the fallback learned-value approach offers a middle path. Classical evaluation functions often plateau below expert level in games this deep, so RL may prove necessary rather than optional; the plan is honest that this is decided by measurement.

# 6. Tooling, Compute, and Data

| Concern                      | Plan                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Languages                    | TypeScript/Node for Engine + Milestone 1-5 core; Python (PyTorch) for Milestone 6, via a Node bridge.                                                                                                                                                                                                                                                                                                     |
| Simulator                    | The reused Engine, run headless with seed control and snapshot/restore - no separate rules re-implementation.                                                                                                                                                                                                                                                                                             |
| Compute                      | A multi-core workstation for Milestones 1-5. One GPU (local or rented cloud) for Milestone 6; budget and scope RL to the compute actually available.                                                                                                                                                                                                                                                      |
| Data                         | Primary: self-generated match and self-play histories - no external dataset is required to succeed. Supporting: the RuneDK93 top-25 expert statistics for calibration and the AC-8 sanity check (weak priors and comparison only). The skill bar is the external AC-4 human benchmark, not the dataset. Optional: scraped BGA move logs for an imitation warm-start, gated on ToS (Milestone 6 sub-task). |
| Versioning & reproducibility | Pinned Engine commit, pinned dependencies, fixed seeds, checkpointed models, and a promotion gate that requires significant improvement.                                                                                                                                                                                                                                                                  |
| Evaluation                   | The Milestone 2 harness and rating pipeline are the single source of truth for strength throughout.                                                                                                                                                                                                                                                                                                       |

# 7. Data Guardrails and Risk Register

## 7.1 Guardrails on the expert data and prior art

The expert dataset and prior-art paper are useful but must not steer the project. In brief: the data measures the Agent and seeds weak priors, but never defines correct play; all observed win rates are treated as confounded (skill, luck, and game length mixed with card strength) and remain overridable by search and learning; divergence the match harness shows is stronger is always preferred over conformity; any imitation is only ever a warm-start that self-play may unlearn; and the plan does not depend on the data - if it were unusable, only the optional expert warm-start and the AC-8 calibration check would change. These restate SRS FR-DATA-1 through FR-DATA-5; the full operational statement (permitted uses, forbidden uses, and how to read a comparison) is Appendix A.

## 7.2 Risk register

| Risk                                                                                       | Impact   | Mitigation                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Simulator too slow to clone for useful search / self-play (state-clone cost)** - **RESOLVED, downgraded from High (was the single biggest feasibility risk).** Milestone 1 spike (agent/docs/Simulator_Speed_Spike.md, 24 Jul 2026) measured a fork (restore + replay) at 0.979 ms, against the NFR-2 hard target of <= 2 ms and a Milestone 4 gate of >= 1,000 sims/decision (met at ~3,442-5,248). The incremental apply/undo copy path was investigated and rejected: the Engine has no undo journal (its own "undo" restores from save history via the same serialization path) and building one would require mutation tracking across ~1,000 card implementations, violating CON-1; unnecessary given the margin by which the gate was met. | **Low** | Re-measure if the Milestone 3 leaf evaluation or the Milestone 4 search adds meaningfully more per-decision overhead than the spike modeled; log-stripped snapshots and the snapshot-once/restore-many pattern remain available levers if so. |
| Self-play throughput (NFR-2) and the NFR-1 live-play budget are different operating points of the same engine - a search agent spending the full 10-second live budget completes only ~30 games/day/core, far below self-play targets, so self-play must run at a much lower simulation count than live play. | Medium | Budget Milestone 6 self-play explicitly at the measured ~250-500 simulations/decision (not the NFR-1 figure); log-stripped snapshots buy ~35% more simulations at fixed self-play throughput; verify assumed near-linear multi-core scaling when the Milestone 2 harness is built (not yet measured). |
| RL is too costly / does not converge to expert level; throughput far below AlphaZero scale | High     | Treat Milestone 5 as an independently valuable deliverable (its skill measured, not assumed); use the cheaper learned-value fallback; warm-start from the heuristic agent (or optional expert data); scope RL to measured compute/throughput (NFR-2), not to an assumed figure.                                  |
| Classical (M5) agent falls short of the AC-4 expert bar                                    | Medium   | Do not assume M5 is expert; the post-M5 decision gate decides whether RL is required to meet AC-4; the learned-value hybrid is the middle path.                                                                                                                                                                  |
| Hidden information / stochasticity mishandled                                              | High     | Use the belief model + determinized/information-set search from Milestone 4; verify determinizations against observed card-flow; never assume perfect information; validate against baselines that do.                                                                                                           |
| Combinatorial action space (payment/nested); no flat policy representation                 | Medium   | Canonical move factorization with reductions (SRS FR-ACT-4); hierarchical/autoregressive policy head for RL; action masking and dominated-move pruning.                                                                                                                                                          |
| **Engine non-determinism breaks reproducibility / self-play** - **VERIFIED, downgraded from Medium.** Milestone 1 bullet 6 (agent/docs/Determinism_Verification.md, 24 Jul 2026) met all six pre-committed criteria: 300 configs (50 engine seeds x {2,3,4}p x 2 agent seeds) replay identically in-process, 24 reproduce in a fresh process, and 12 survive 100 unrelated games plus decision-by-decision interleaving. Engine and Agent seeds are separately seeded, now enforced structurally (a CI-enforceable spec) rather than by convention. Residual non-determinism is confined to four wall-clock fields that `stableState()` strips, re-confirmed across 8,193 observations. | **Low** | Standing check: `npm run determinism -- --verify docs/data/determinism_corpus.json` re-runs the 300-fingerprint corpus. Re-adjudicate at Milestone 5 - see the two rows below, both of which the live-play adapter reopens. |
| **Wall-clock cache sweep can mutate live game state** (`GAME_CACHE=sweep=auto` installs a `setTimeout` that trims `gameLog` off resident games; `restoreGameLog` then sets it to `undefined` against the headless no-op Database and play crashes). Mechanism confirmed with a positive control; unreachable today only because embedded play never calls `GameLoader.add()`. | Low | **Isolated:** `ensureHeadlessEngine()` refuses to bootstrap under `sweep=auto`, naming the hazard and the fix (spec-covered). Milestone 5's live adapter calls `add()`/`getGame()` and must re-verify. |
| **`GameLoader` is a process-wide singleton keyed by an id that omits player count** (`g-nadia-${seed}`, so 2p seed 5 and 3p seed 5 collide). Not reachable under embedded play - `Game.save()` goes straight to the Database and never populates the cache - but nothing enforces that. A related accounting leak (`Cache.mark`) grows one entry per distinct game id and is never released. | Low | Bounded negative result, not a clean bill of health: recorded in the Determinism_Verification.md register (R3/R4) so Milestone 5 re-adjudicates rather than assuming it stayed closed. Include the player count in the game id if the cache is ever populated. |
| **Live-play games are created under an unseeded seed** (`ApiCreateGame.ts:176` does `const seed = Math.random()`), so a live game cannot be replayed from a seed the Agent knows. | Medium | Milestone 5 design constraint, recorded at Milestone 1: live-play reproducibility needs recorded move logs or an adapter-supplied seed, not seed replay. Does not affect embedded reproducibility, which is what M4/M6 depend on. |
| Strong human reviewer/opponent unavailable for AC-4/AC-6                                   | Medium   | Secure a reviewer/opponent early; AC-4 falls back to head-to-head vs an agreed strong bot so the skill bar never rests solely on organising human games.                                                                                                                                                         |
| Over-fitting to the expert data (project led astray)                                       | Medium   | Guardrails of Section 7.1; tune weights to harness win rate, not to win-rate statistics; keep expert priors weak and overridable; reward beating, not matching, the expert distribution.                                                                                                                         |
| Confounded observational statistics misread as card strength                               | Medium   | Treat win rates as noisy, skill-and-luck-confounded hints only; prefer the skill-adjusted column; let search/learning measure true causal value.                                                                                                                                                                 |
| BGA-vs-engine platform / version drift                                                     | Medium   | Reconcile card set and rules version before any quantitative comparison; scope comparisons to matching content; flag unmatched cards.                                                                                                                                                                            |
| Move-log availability / ToS for scraping                                                   | Medium   | Make the imitation warm-start strictly optional and gated on a ToS review; fall back to self-play warm-start with no loss to the core plan.                                                                                                                                                                      |
| Large / variable action space slows search                                                 | Medium   | Action masking and dominated-move pruning; strength/time budget to scale depth; strong static evaluation to limit needed depth.                                                                                                                                                                                  |
| Engine coupling / upstream changes                                                         | Medium   | Pin a commit; isolate all Engine contact behind the transport layer; keep any Engine additions tiny and rules-neutral.                                                                                                                                                                                           |
| Live adapter fragility / ToS exposure                                                      | Medium   | Target only the self-hosted Engine for v1; robust retries and safe fallbacks; explicit ToS review before any third-party platform.                                                                                                                                                                               |
| Evaluation self-deception (looks strong vs itself, weak vs experts)                        | Medium   | The primary skill bar is external: the AC-4 expert human benchmark (fallback: an agreed strong bot) plus AC-6 expert review, backed by fixed external baselines and the AC-8 distributional calibration; confidence intervals on every claim.                                                                    |
| Solo-developer bandwidth / ML skill gap                                                    | Medium   | Front-load achievable non-ML milestones; flag Milestone 6 as the point to bring in help or a library; allow stopping at Milestone 5.                                                                                                                                                                             |
| Card-implementation edge cases in the Engine                                               | Low      | Treat the Engine as ground truth; add regression games; report genuine Engine bugs upstream rather than working around them silently.                                                                                                                                                                            |
| **AC-1 legality is agent-specific and expires silently on every new agent version.** Milestone 1's AC-1 run (agent/docs/AC1_Legality_Run.md, 24 Jul 2026) proves the *random-legal* agent plays 1,500 games with zero Agent-attributable illegal-move rejections - it says nothing about the M3 heuristic agent, the M4 search agent, the M5 hardened agent, or any M6 promoted network, each of which submits genuinely different moves through the same enumerator/driver stack. The M1 run itself is proof this isn't hypothetical: it found and fixed a real illegal-move-producing defect (the `initialCards` budget coupling) that had been hiding behind the FR-9 fallback since bullet 3, invisible to a 20-game batch and only surfaced at 1,500-game scale. A new evaluation function, search layer, or policy head can trigger enumerator paths (payment variants, action-space pruning, hierarchical policy decoding) that random play never reached. | Medium | **Re-run the AC-1 legality battery (`agent/src/legality/`, `npm run legality`) for every agent version promoted at the end of M3, M4, M5, and M6**, before claiming AC-1 continues to hold for that version - not once at M1 and assumed forever after. Budget it as a promotion-gate step alongside the FR-15/AC-7 significance test, not as a one-off Milestone-1 artifact. Re-use the same strict definition of "an illegal move" (agent/docs/AC1_Legality_Run.md) and the same instrumentation-neutrality check so the numbers stay comparable across versions. |

# 8. Indicative Timeline

For one part-time developer with occasional specialist help. The non-RL track (Milestones 1-5) yields a strong player in roughly four to seven months of part-time work; the RL track adds several months and is compute-bound. A team, or full-time effort, compresses this considerably.

| Phase                  | Milestones | Indicative window | Deliverable                                                                                                                   |
| ---------------------- | ---------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Foundation             | M1-M2      | Months 1-2        | Headless harness, baselines, rating pipeline.                                                                                 |
| Strong classical agent | M3-M5      | Months 2-7        | Strong classical search+heuristic agent, live-play capable (skill vs the AC-4 bar measured at the post-M5 gate, not assumed). |
| Learning               | M6         | Months 6-12+      | Self-play RL agent (or learned-value hybrid).                                                                                 |
| Acceptance             | M7         | Final 1-2 months  | Verified against all acceptance criteria; packaged.                                                                           |

**Decision gate after Milestone 5:** review the classical agent’s measured strength and the available compute, then decide whether to commit to the RL milestone or ship Milestone 5 as the final deliverable.

# 9. Immediate Next Steps

  - **Pin the Engine commit and record its hash** (replacing the `<TBD-PIN>` placeholder in both documents), confirm a headless base + Corporate Era + Prelude game can be created and stepped through programmatically for 2-4 players, and **run the simulator-speed spike** (clone cost and simulations-per-move). This gates whether the search and RL plan is realistic and is done before any strategy work. **Status: the Engine commit is pinned (recorded in agent/CLAUDE.md; the `<TBD-PIN>` placeholders in this section header's cross-reference are a pre-existing gap, not introduced here) and the simulator-speed spike is complete and passed (agent/docs/Simulator_Speed_Spike.md, 24 Jul 2026).**

  - Implement the legal-action enumerator for all decision types and a random-legal agent (Milestone 1).

  - Stand up the match harness, the two baselines, and the expert-distribution report so strength is measurable against both baselines and real experts from the outset (Milestone 2).

  - Ingest the RuneDK93 expert statistics and reconcile the BGA card set/version against the engine, so the AC-8 calibration check is ready - used strictly as a yardstick and weak prior, per the Section 7.1 guardrails.

  - Begin the heuristic evaluation function - the strategic heart of the project - tuning to harness win rate, not to expert win-rate statistics (Milestone 3).

These steps carry no machine-learning risk, are achievable at hobby-plus skill level with careful incremental work, and by their end you already have a bot that plays legal, sensible games and a rig that proves how strong it is - and, from the spike, an early, honest read on whether the search/RL ambition fits the compute you have.

# Appendix A. Expert-Data Calibration Procedure

This appendix is the operational companion to the guardrails of Section 7.1. It states exactly how the RuneDK93 expert dataset is consumed, and - just as importantly - what it is never used for. **One rule governs everything below: the data measures the Agent and seeds weak priors; it never defines correct play, and the Agent is always free to beat it.**

## A.1 What the dataset provides

The repository distributes aggregate statistics from top-25 Board Game Arena players, not move logs: a per-card table (plays, wins, raw win rate, and WAP - a skill-adjusted win rate that partially controls for player strength), per-corporation win rates, and score, Terraform Rating, and generation-count summaries. The base + Prelude 3-player corpus matches this project’s scope and anchors the AC-8 calibration check (a supporting sanity check; the skill bar is the external AC-4 human benchmark).

## A.2 Step 0 - Reconciliation (do this before any number is compared)

  - Map the BGA card and corporation names to the engine’s identifiers; flag any card present in one but not the other.

  - Confirm the rules version and content set (base + Corporate Era + Prelude) align; scope every comparison to matching content only. Unmatched cards are excluded from calibration, not silently coerced.

## A.3 Permitted uses

| Signal from data                      | How it is used                                                                                             | Guardrail applied                                                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-corporation win rates             | Seed a weak opening prior for corporation and prelude selection (a starting bias only).                    | Prior weight kept low; overridden as soon as the harness or search shows a better choice.                                                                               |
| Per-card win rates + WAP              | Sanity-check that the tuned Agent’s own card win-rate profile is not wildly inconsistent with expert play. | Never copied into evaluation weights; WAP preferred over raw rate; treated as confounded.                                                                               |
| Score / TR / generation distributions | The AC-8 calibration check: compute the same statistics from the Agent’s 3-player games and compare.       | A smell test only, not the skill bar; the skill bar is the external AC-4 human benchmark. Distributional, not head-to-head; neither necessary nor sufficient for skill. |

## A.4 Forbidden uses (the anti-constraint boundary)

  - Do not set evaluation-function weights equal to observed win rates. Win rates conflate player skill, draw luck, and game length with card strength.

  - Do not treat the data as a correctness oracle, a hard constraint, or a regularisation target the Agent is penalised for leaving.

  - Do not let imitation be the final objective. Any behavioural cloning is a warm-start that self-play is free to unlearn.

  - Do not narrow the strategy space to the expert metagame. The dataset reflects how one player pool played one platform’s meta; discovering stronger, unseen play is the goal.

## A.5 How to read a comparison

When the Agent’s statistics differ from the experts’, the difference is a question, not a verdict. If the Agent wins more while diverging, the divergence is validated by the match harness and kept. If it wins less, investigate whether a genuine weakness exists - not whether the Agent simply failed to copy the experts. Beating the expert distribution, with play the data does not exhibit, is the intended outcome.

Terraforming Mars AI - Implementation Plan v1.2 | Page
