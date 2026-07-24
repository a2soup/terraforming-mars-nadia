**Software Requirements Specification**

An Expert-Level AI Agent for Terraforming Mars

**Project:** Terraforming Mars AI **Document:** Software Requirements Specification (SRS) **Version:** 1.4 (Draft) **Date:** 24 July 2026 **Prepared for:** Austin Campbell **Target scope:** Base game + Corporate Era + Prelude; 2-4 players (2p primary; 3-4p competence per AC-5) **Primary interface:** terraforming-mars open-source engine (self-hosted “Heroku app”)

**Revision history**

  - **v1.4 (24 Jul 2026):** The Milestone-1 Engine-determinism verification that **CON-5** and **NFR-5** both require has been performed and all six pre-committed criteria met (agent/docs/Determinism_Verification.md); both requirements are annotated with the evidence, the residual non-determinism found, and how each residual is isolated. CON-5's “search/determinization RNG seed” is given a concrete form for Milestone 4 onwards: independent per-consumer streams addressed by name, derived by hashing `(runSeed, label)` from one documented run seed, versioned in every corpus header. No requirement text changed; both annotations are additive.
  - **v1.3 (24 Jul 2026):** Milestone 1's gating simulator-speed spike (agent/docs/Simulator_Speed_Spike.md) measured state-clone cost and **passed** against the pre-committed gate. NFR-2's `X` placeholder is set from that measurement (state-clone cost <= 2 ms per fork on the spike's reference hardware, ~2x headroom over the measured 0.979 ms); the throughput assumption in Section 2.6 is updated from "not yet validated" to "validated, with figures." No other requirement changes.
  - **v1.2 (21 Jul 2026):** Integration of v1.0 and v1.1 following adversarial review. AC-4 restored to an external expert-human benchmark (v1.0 intent); the dataset distribution comparison demoted to a supporting sanity check (new **AC-8**), resolving the FR-DATA-2 / AC-4 conflict. AC-2 reframed as an improvement guardrail; AC-3’s prior-art-MCTS clause removed. Primary bar = AC-1 + AC-4 + AC-6. Player count unified to 2p-primary (3-4p competence/calibration). NFR-4 reconciled with AC-1. Added: belief model (FR-OBS-2), canonical action factorization (FR-ACT-4), live-state reconstruction (FR-INT-6), separated Engine/search seeds (CON-5/NFR-5), and a state-clone-cost requirement + validation (NFR-2). Engine commit to be pinned (`<TBD-PIN>`).
  - **v1.1:** Added the RuneDK93 expert dataset and data guardrails (retained in v1.2, but demoted from the skill definition to a calibration role).
  - **v1.0:** Initial draft (external human benchmark; 2p-primary).

**Contents**

# 1. Introduction

## 1.1 Purpose

This document specifies the requirements for an artificial-intelligence agent (hereafter “the Agent”) that plays the board game Terraforming Mars at the level of a highly skilled human player. The Agent does not implement the game itself. Instead it observes game state, decides on moves, and submits those moves to an existing digital implementation of the game. This SRS defines what the Agent must do and the qualities it must have; the companion Implementation Plan describes how it will be built.

## 1.2 Scope

**In scope.** An autonomous agent that plays complete games of Terraforming Mars using the **base game, the Corporate Era expansion, and the Prelude expansion**, for **2 to 4 players**, on the standard Tharsis board. The Agent must be capable of taking every legal decision the game can present within that rule set, playing to win, and reaching a standard of play competitive with strong, experienced human players.

**Out of scope.** Building or modifying the game implementation itself; the Venus Next, Colonies, Turmoil, and other expansions; alternate boards (Hellas, Elysium) beyond optional stretch support; real-time human-facing chat or negotiation; and any form of collusion or account abuse on third-party services.

**Primary target platform.** The open-source terraforming-mars/terraforming-mars engine (the codebase behind the community “Heroku app”), run locally under the developer’s control. This platform is chosen because it exposes the complete game state and a well-defined, typed decision interface, and because it can be run headless for large-scale self-play and testing. Interfacing with Board Game Arena or Asmodee Digital is explicitly deferred (see FR-INT-5 and the Assumptions).

## 1.3 Definitions, Acronyms, and Abbreviations

| Term              | Meaning                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Agent             | The AI system specified by this document.                                                             |
| Engine            | The terraforming-mars game implementation that holds authoritative game state and enforces the rules. |
| Generation        | One full round of the game (Research, Action, and Production phases).                                 |
| TR                | Terraform Rating - a player’s core score/income track, raised by terraforming.                        |
| Global parameters | Temperature, oxygen, and ocean count; the game ends when all three are maximised.                     |
| VP                | Victory Points - the final score total that determines the winner.                                    |
| Decision point    | A moment when the Engine pauses and waits for a player to choose (a “waitingFor” state).              |
| Observation       | The information visible to the Agent at a decision point (its own state plus public state).           |
| Action / Move     | A single response the Agent submits at a decision point.                                              |
| Legal action set  | The set of moves the Engine will accept at a given decision point.                                    |
| ISMCTS            | Information Set Monte Carlo Tree Search - a search method for imperfect-information games.            |
| RL                | Reinforcement Learning.                                                                               |
| Elo / TrueSkill   | Rating systems used to quantify relative playing strength.                                            |
| Self-play         | Training by having copies of the Agent play against each other.                                       |

## 1.4 References

  - **Game engine:** github.com/terraforming-mars/terraforming-mars (TypeScript). Key interfaces reviewed for this SRS: src/common/inputs/InputResponse.ts, src/common/models/PlayerInputModel.ts, src/server/Game.ts. The pinned commit is **`<TBD-PIN>`** (fixed as the first immediate next step in the Implementation Plan); the interface names above and the Section 3.3 action model shall be re-verified against that commit, since these interfaces can drift between commits.

  - Terraforming Mars official rulebook (base game), Corporate Era rules insert, and Prelude expansion rules (FryxGames / Stronghold Games).

  - **Prior art (AI):** R. D. Gaina, J. Goodman, D. Perez-Liebana, “TAG: Terraforming Mars,” AIIDE 2021 - a re-implementation of the game (base + Corporate Era only, no Prelude) in the Tabletop Games Framework, with baseline Random, One-Step-Look-Ahead (OSLA), and MCTS agents.

  - **Expert data:** github.com/RuneDK93/terraforming-mars-dataset - aggregate statistics from ~1,556 base + Corporate Era 3-player games (BGA season 18) and ~1,616 base + Prelude 3-player games (BGA season 19), all played by the top 25 rated players.

  - Companion document: “Terraforming Mars AI - Implementation Plan,” v1.2.

## 1.5 Prior Art and Available Resources

**The TAG environment (Gaina et al., 2021).** An academic re-implementation of Terraforming Mars in a Java framework, covering base + Corporate Era only. It confirms several design choices adopted here - search (MCTS) is the appropriate family, hidden information is handled by determinization, and Terraform Rating together with milestones and awards are the dominant drivers of winning - and it supplies baseline agents with published reference results (its default MCTS beats OSLA ~75% and random ~98%; OSLA beats random ~91%). Two limitations bound its usefulness: it is a different, simplified engine (no Prelude; a few cards unimplemented; acknowledged rule simplifications), so it is not a candidate to replace the primary engine of Section 1.2; and its headline “on par with humans” result rests on a very small, unrated human sample compared mirror-versus-mirror, so it must not be used to define this project’s skill bar. TAG is therefore treated as related work, an optional secondary source of baseline opponents, and a set of sanity-check numbers - nothing more.

**The RuneDK93 expert dataset.** Aggregate win-rate statistics computed from ~1,500-1,600 games per configuration played by the top 25 rated Board Game Arena players, including a base + Prelude 3-player corpus that matches this project’s scope. It provides a statistically meaningful reference for expert play (score, Terraform Rating, generation counts, and per-card and per-corporation win rates), and is used to calibrate and benchmark the Agent (Sections 3.5 and 6). Critically, the repository distributes aggregate statistics, not move-by-move game logs; obtaining move-level data for supervised learning would require a separate scraping pipeline subject to the platform’s Terms of Service. The cautions in Section 3.5 govern how this data may and may not be used.

## 1.6 Document Overview

Section 1.5 summarises the prior art and available data resources and the limits on their use. Section 2 describes the Agent in context and the constraints it operates under. Section 3 defines the external interfaces, including the exact observation and action model exposed by the Engine and, in Section 3.5, the expert-data interface and the guardrails on it. Section 4 lists functional requirements. Section 5 lists non-functional (quality) requirements. Section 6 defines the acceptance criteria, including a concrete, externally grounded definition of “highly skilled” (an expert-human benchmark and expert review, with the dataset used only as a supporting calibration check). Appendices provide the game-scope detail and a glossary of the decision types.

# 2. Overall Description

## 2.1 Product Perspective

The Agent is a self-contained decision-making component that sits outside the game. The Engine is the source of truth: it deals cards, enforces rules, tracks resources and the board, and drives the phase structure. At each decision point the Engine presents one player with a structured menu of choices; the Agent, acting as that player, selects a response. The Agent therefore never needs to re-implement the rules - a major simplification - but it must correctly interpret every kind of choice the game can present and reason about hidden and random information (opponents’ hands, deck order) to play well.

Two operating modes are required, sharing one decision core:

  - **Embedded (headless) mode:** the Agent calls the Engine directly in-process. Used for training, self-play, and automated evaluation, where speed and full state access matter.

  - **Live-play (adapter) mode:** the Agent connects to a running game server over its HTTP interface, reading the “waitingFor” model and posting responses, exactly as the web client does. Used to play real games against humans or other bots on a hosted instance.

## 2.2 Product Functions (Summary)

  - Connect to a game (embedded or over HTTP) and play as a designated player from setup to final scoring.

  - At every decision point, parse the presented options, enumerate the legal action set, evaluate candidate moves, and submit a legal response.

  - Reason under uncertainty about concealed cards and future draws, and across the full ~8-12 generation horizon of a game.

  - Pursue a coherent winning strategy: build a resource/card engine, terraform efficiently, and contest milestones and awards.

  - Play a complete game unattended, robustly recovering from unexpected states, and log its reasoning for later review.

  - Be measurable: expose enough instrumentation to rate its strength and compare versions.

## 2.3 User Classes and Characteristics

| User class                         | Description and needs                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Developer / operator (primary)     | Runs training and evaluation, starts the Agent in a game, inspects logs. Has hobby-level coding experience; needs clear operability, sensible defaults, and readable diagnostics rather than deep internals. |
| Human opponent                     | Plays against the Agent in live-play mode; needs the Agent to move within a reasonable time and to never stall or corrupt a game.                                                                            |
| Evaluator (may be the same person) | Runs match harnesses and reads strength reports to judge whether the Agent meets the skill bar.                                                                                                              |

## 2.4 Operating Environment

The Engine is a Node.js / TypeScript application. The Agent’s decision core may be written in TypeScript (running in the same Node process as the Engine) or in Python (communicating with a thin Node bridge). Training and self-play run on a Linux workstation or server; a GPU is required only for the reinforcement-learning phases. Live-play mode requires network access to a running game server. No component depends on cloud services; everything can run on a single machine.

## 2.5 Design and Implementation Constraints

**CON-1** The Agent must treat the Engine as authoritative and immutable. It must not depend on modifications to the Engine’s rules. (Small, optional, clearly isolated additions - e.g., a headless match runner or a seed hook - are permitted but must not change game logic.)

**CON-2** The Agent must only ever submit actions that are members of the legal action set the Engine presents. It must never attempt to read another player’s hidden information from the Engine’s internals when in live-play mode.

**CON-3** The Agent must interoperate with the Engine’s existing serialization: a game must be resumable from the Engine’s saved state, and the embedded simulator must be able to snapshot and restore state for search and self-play.

**CON-4** Any interaction with third-party platforms (Board Game Arena, Asmodee) must respect those platforms’ Terms of Service. Automated play on such services is out of scope for v1 and must not be enabled without an explicit legal/ToS review.

**CON-5** The build must be reproducible: fixed dependency versions, a pinned Engine commit, and deterministic behaviour under fixed seeds. The Engine’s RNG seed and the Agent’s own search/determinization RNG seed shall be controlled separately, and Engine determinism under a fixed seed shall be verified (not assumed) at Milestone 1.

> **Satisfied at Milestone 1 (24 Jul 2026)** — agent/docs/Determinism_Verification.md. The required verification was performed against six pre-committed criteria and all were met; seed separation is enforced by a CI-enforceable structural check rather than by convention. From Milestone 4 the “search/determinization RNG seed” is realised as **independent per-consumer streams addressed by name** (`"engine"`, `"agent.decision"`, `"agent.determinization"`, …), each derived by hashing `(runSeed, label)` from a single documented run seed so callers still pass one number, with any individual stream pinnable or varyable independently. That derivation is frozen once a corpus exists and is versioned in every corpus header (`seedDerivationVersion`).

## 2.6 Assumptions and Dependencies

  - The chosen Engine commit correctly implements the base game, Corporate Era, and Prelude rules; its card implementations are treated as the rules ground truth.

  - The Engine can be run headless and driven programmatically at high throughput (thousands of games), which the RL phases depend on. This throughput assumption - and in particular the cost of snapshotting/cloning state for search - has been **validated** by the Milestone 1 performance spike (agent/docs/Simulator_Speed_Spike.md, 24 Jul 2026): a state-clone fork (restore plus replay-from-quiescent-ancestor) costs a measured **0.979 ms** on the spike's reference hardware (0.481 ms with log-stripped snapshots), against the NFR-2 hard target of <= 2 ms established below. Full-game headless throughput measured 34-47 games/second single-threaded across 2-4 players. The assumption is no longer treated as an open risk; residual uncertainty is limited to untested multi-core scaling (assumed, not measured) and to Milestone 3's not-yet-built leaf evaluation cost, both called out in the spike document.

  - The Engine’s HTTP interface exposes, for the current player, the “waitingFor” decision model and accepts the corresponding response - the same contract the official web client uses.

  - Adequate local compute (multi-core CPU; one GPU for the RL phase) is available. If not, scope falls back to the search-plus-heuristics agent (see the Implementation Plan).

  - The expert dataset (Section 1.5) is treated as a calibration and benchmarking resource, not as a specification of correct play. It is aggregate statistics, not move logs; it originates from the Board Game Arena implementation rather than the primary engine, so a card-set and rules-version reconciliation is assumed before any quantitative comparison. Any use of move-level data depends on a separate, ToS-compliant data pipeline that is not assumed to exist at project start.

# 3. External Interface Requirements

## 3.1 Game Interface - Overview

Play proceeds as a loop. The Engine advances until it needs a decision from the Agent’s player, then exposes a decision model. The Agent reads it, chooses, and submits a matching response. The Engine validates the response, applies it, and continues. This is the entire control surface the Agent needs; the Agent never manipulates the board directly.

## 3.2 Observation Model

In embedded mode the Agent can read the full player-view model and, for its own decision-making and training, the complete serialized game state (Game.serialize() produces a SerializedGame snapshot). In live-play mode the Agent sees exactly what a human client sees: its own player view (hand, resources, production, tags, played cards), the full public state (board tiles, global parameters, generation, TR of all players, milestones/awards, visible played cards and their effects), and the game log.

**FR-OBS-1** The Agent shall construct, at every decision point, a feature representation of the observable state sufficient for evaluation, covering: the three global parameters and remaining distance to game end; each player’s TR, resources, and production; the Agent’s hand; played cards and active effects (its own and opponents’, as visible); board tiles and adjacency; milestone/award status; generation number and player order.

**FR-OBS-2** The Agent shall maintain a belief model of hidden information - the composition of the undrawn deck and a distribution over opponents’ hands - kept consistent with every observable card-flow event (draws, buys in Research, plays, discards, and card-driven reveals), not merely opponents’ hand sizes. This belief model is the basis for determinized search (see the Implementation Plan) and shall not assume knowledge the Agent could not legally have in live-play mode.

## 3.3 Action Model

The Engine presents each decision as a typed PlayerInputModel and accepts a matching InputResponse. The Agent must handle every variant. The table below enumerates the decision types drawn directly from the Engine’s interface definitions.

| Decision type                                    | What the Agent must decide                                   | Response payload          |
| ------------------------------------------------ | ------------------------------------------------------------ | ------------------------- |
| option                                           | Confirm/take a single offered option.                        | type: “option”            |
| and                                              | Provide responses to several sub-inputs together.            | ordered list of responses |
| or                                               | Pick one branch, then answer it.                             | index + nested response   |
| initialCards                                     | Opening choice of corporation, preludes, and starting cards. | nested responses          |
| projectCard                                      | Which project card to play and how to pay for it.            | card + payment            |
| card                                             | Select N cards (buy/keep/discard/act), within min/max.       | list of card names        |
| payment                                          | Allocate megacredits, steel, titanium, heat, etc. to a cost. | payment breakdown         |
| space                                            | Choose a board space for a tile.                             | space id                  |
| player                                           | Target a player.                                             | player color              |
| amount                                           | Choose a quantity within a range.                            | amount                    |
| productionToLose / resource(s)                   | Choose production or resources to lose/gain.                 | units                     |
| colony / delegate / party / policy / globalEvent | Expansion-specific choices (mostly inactive in scope).       | respective id             |

**FR-ACT-1** For each decision type above, the Agent shall enumerate the legal action set from the presented model (respecting min/max counts, affordability, requirements, and optional flags) and shall submit only a member of that set.

**FR-ACT-2** The Agent shall correctly compose nested decisions (and / or / initialCards / projectCard-with-payment) so that the top-level response the Engine receives is internally consistent and accepted on the first submission.

**FR-ACT-3** For payment decisions the Agent shall choose a legal and strategically sound allocation of megacredits and alternate resources (steel for building tags, titanium for space tags, heat where allowed), never overpaying when a cheaper legal allocation exists unless doing so is strategically intended.

**FR-ACT-4** The action model shall be defined by a canonical move factorization with explicit reductions that keep enumeration finite, because for some decision types - notably payment, and composite and / or / projectCard-with-payment decisions - the naive legal set is combinatorial rather than a short list. The Agent shall generate moves through this factorization (e.g., a canonical cheapest-legal payment unless a reason to deviate exists, per FR-ACT-3) rather than materialising the full cross-product. For any learned policy (Implementation Plan, Milestone 6) this same factorization defines the structured/hierarchical action representation; a flat enumeration over all moves is not assumed to exist.

## 3.4 Communication Interfaces

**FR-INT-1** Embedded mode: the Agent shall drive the Engine in-process, receiving each decision model and returning a response via a direct function/callback interface, with no network round-trip.

**FR-INT-2** Live-play mode: the Agent shall poll or subscribe to the game server for its player’s “waitingFor” state over HTTP, submit responses to the server’s input endpoint, and detect turn/phase transitions and game end.

**FR-INT-3** The Agent shall use a single decision-core interface behind both modes, so that identical strategy code runs whether embedded or live. Because live-play search cannot fork the remote server’s hidden state, in both modes the core shall search over a locally instantiated Engine state (in live-play mode, reconstructed per FR-INT-6); “identical” refers to this local-search core, not to forking the authoritative game.

**FR-INT-4** The Agent shall tolerate and correctly handle asynchronous, out-of-turn prompts (e.g., reacting to another player’s card that forces a choice on the Agent).

**FR-INT-5** Adapters for other platforms (Board Game Arena, Asmodee) are out of scope for v1; the live-play interface shall nonetheless be defined abstractly enough that such an adapter could be added later without changing the decision core.

**FR-INT-6** In live-play mode the Agent shall reconstruct a simulable local Engine state from the current observation (all public state plus a sampled determinization of hidden information), so that the same search used in embedded mode can run without access to the server’s hidden state. This reconstruction is a required component, not an incidental step, and is scheduled with the live adapter (Milestone 5).

## 3.5 Expert-Data Interface and Guardrails

The expert dataset of Section 1.5 is a supporting resource, not part of the game interface. This section defines how the system may consume it and - equally important - the limits that prevent it from distorting the Agent’s development. The governing principle is that the data informs and measures the Agent; it never defines correct play.

**FR-DATA-1** The system shall be able to ingest the dataset’s aggregate statistics (per-card and per-corporation win rates, score, Terraform Rating, and generation-count distributions) and, after reconciling the Board Game Arena card set and rules version against the primary engine, compute the same statistics from the Agent’s own games for like-for-like comparison.

**FR-DATA-2** The system shall use expert statistics only as weak priors and as benchmarks - for example, to seed an opening-selection prior or to sanity-check that the Agent’s card and corporation win-rate profile is not wildly inconsistent with expert play. It shall not set evaluation-function weights directly equal to observed win rates.

**FR-DATA-3** The system shall treat observational win rates as confounded. Card and corporation win rates reflect player skill, draw availability, and game length as much as intrinsic card strength; the dataset’s skill-adjusted column (WAP) partially but not fully corrects this. Any statistic used as a prior shall be flagged as confounded, weighted weakly, and overridable by search or learning that measures a move’s actual causal contribution.

**FR-DATA-4** The Agent shall be permitted to diverge from expert tendencies. The dataset records how a particular pool of players played a particular metagame on one platform; it shall never be used as a correctness oracle, a hard constraint, or a target the Agent is penalised for deviating from. Novel but demonstrably stronger play (validated by the match harness of Section 6) shall always take precedence over conformity to the data.

**FR-DATA-5** If move-level expert data is later obtained for imitation learning, it shall be used only to warm-start a policy that is subsequently improved by self-play and evaluated on its own merits; the imitation objective shall not be the final training objective, and any such data acquisition shall comply with the source platform’s Terms of Service (per NFR-9).

# 4. Functional Requirements

## 4.1 Game Setup and Lifecycle

**FR-1** The Agent shall join or start a game configured for base + Corporate Era + Prelude at 2-4 players and play it to completion as a specified player color.

**FR-2** The Agent shall make the opening decisions correctly: evaluate and choose among offered corporations, keep/decline the initial project cards, and select preludes, treating these as high-impact strategic choices rather than defaults.

**FR-3** The Agent shall correctly follow the phase structure across all generations - Research (draw/buy), Action (alternating actions until it passes), Production - until the game-end condition is met and final greenery/city scoring resolves.

## 4.2 Decision Making

**FR-4** At each Action-phase turn the Agent shall choose among: playing a project card, using a standard project, using a blue-card or corporation action, claiming a milestone, funding an award, converting plants to greenery or heat to temperature, trading (where applicable), or passing - selecting the option that best serves its evaluated position.

**FR-5** The Agent shall value cards and actions by their contribution to winning - victory points, terraform rating, production/engine growth, card advantage, tempo, and board position - rather than by any single myopic metric.

**FR-6** The Agent shall reason about timing: when to hold versus spend cards, when to accelerate terraforming toward game end, and when to deny opponents milestones, awards, or key board spaces.

**FR-7** The Agent shall reason under uncertainty, accounting for unseen opponent cards and random draws, and shall not make decisions that are only correct under perfect information.

**FR-8** The Agent shall respect all card requirements, tag interactions, discounts, and effect triggers exactly as the Engine enforces them, and shall exploit synergies (tag-based discounts, resource cards, action engines) where advantageous.

## 4.3 Robustness and Operation

**FR-9** The Agent shall handle every decision type in Section 3.3 without ever failing to produce a legal response; if uncertain, it shall fall back to a safe legal move rather than stalling or erroring.

**FR-10** The Agent shall complete a full game unattended, and in live-play mode shall recover from transient network or server errors (retry, re-read state) without corrupting the game.

**FR-11** The Agent shall log, per decision, the options considered, the chosen move, and a brief rationale or score, at a configurable verbosity, to support debugging and strength analysis.

**FR-12** The Agent shall support a configurable “strength/time budget” so the same core can run as a fast heuristic player or a slower, stronger searching player.

## 4.4 Training and Evaluation Support

**FR-13** The system shall provide a headless match runner that plays large numbers of games between specified agent versions (and baselines) under controlled seeds, recording outcomes and full move histories.

**FR-14** The system shall compute strength metrics (win rate, average VP margin, Elo/TrueSkill) from match results with confidence intervals.

**FR-15** The system shall support self-play data generation and model checkpointing for the reinforcement-learning phases, with the ability to promote a new version only if it beats the incumbent by a statistically significant margin.

# 5. Non-Functional Requirements

## 5.1 Performance and Timing

**NFR-1** In live-play mode the Agent shall return a move within a configurable budget (default target: <= 10 seconds for routine decisions, <= 60 seconds for the most complex, such as opening selection or a heavily branched turn).

**NFR-2** In embedded mode the decision core plus Engine shall sustain throughput sufficient for self-play at scale (target: on the order of thousands of complete games per day on a single multi-core workstation for the heuristic/search agent; RL throughput as budgeted in the plan). The cost of snapshotting/restoring (cloning) Engine state is the binding constraint on both search depth and self-play scale and was **measured by the Milestone 1 spike** (agent/docs/Simulator_Speed_Spike.md, 24 Jul 2026) before Milestones 4 and 6 were committed. **Hard target: state-clone cost <= 2 ms per fork** (restore plus replay-from-quiescent-ancestor) on the spike's reference hardware (Apple M2, 8 cores, Node v22, compiled build) - derived from the measured 0.979 ms with ~2x headroom, itself justified against a Milestone 4 exit-criterion target of >= 1,000 simulations per decision within the NFR-1 10-second budget (measured: ~5,248 at depth-10 truncated rollouts with a free leaf evaluation, ~3,442 at a 1 ms leaf evaluation - see the spike document for the full sweep). The target was met with substantial headroom; search depth and RL scale are **not** rescoped. (Note: self-play throughput and the NFR-1 live-play budget are different operating points of the same measured engine - self-play at thousands of games/day is estimated at roughly 250-500 simulations per decision, not the NFR-1 figure above; this must be budgeted explicitly for Milestone 6, per the spike document’s Section 5.)

## 5.2 Playing Strength (the defining quality)

**NFR-3** Playing strength is the primary quality attribute of this system. The Agent shall meet the acceptance thresholds in Section 6. All other qualities are subordinate to, but must not be sacrificed in a way that undermines, achieving expert-level play.

## 5.3 Reliability

**NFR-4** In embedded mode the Agent shall produce **zero** Agent-attributable illegal-move rejections, and its unhandled-error rate shall be low enough that the probability of any failure across a 1,000-game run is under 5% (i.e., per-game failure probability <= ~5x10^-5) - consistent with AC-1’s zero-failure requirement over 1,000 games. In live-play mode the Agent shall recover from transient network/server errors and shall never leave a game in a stalled state attributable to the Agent.

## 5.4 Reproducibility and Testability

**NFR-5** Given fixed seeds (Engine and Agent, controlled separately per CON-5), Engine commit, and Agent version, embedded games shall be reproducible move-for-move. This depends on Engine determinism being verified at Milestone 1, not assumed; any residual Engine non-determinism (e.g., iteration order, timing) is a project risk and shall be recorded and, if found, isolated.

> **Verified at Milestone 1 (24 Jul 2026)** — agent/docs/Determinism_Verification.md. “Move-for-move” is checked literally, not as end-state equality: every replay carries a rolling hash over the decision sequence (decision signature, player, input type, and canonically-serialized response), so a divergence localizes to a decision index. 300 configs (50 engine seeds × 2/3/4 players × 2 agent seeds) reproduce in-process, 24 in a fresh process, and 12 after 100 unrelated games in the same process and under decision-by-decision interleaving. Residual non-determinism found: four wall-clock-derived fields (`name`, `createdTimeMs`, `gameLog[].timestamp`, `players[].timer`), isolated by `stableState()` and re-confirmed complete across 8,193 observations; and an environment-gated wall-clock cache sweep, isolated by a bootstrap guard. Two further hazards are unreachable under embedded play only because it never calls `GameLoader.add()`, and are recorded for re-adjudication at Milestone 5. A committed 300-fingerprint corpus makes the whole check re-runnable.

**NFR-6** The Agent’s decisions shall be inspectable: for any move, a developer shall be able to see the alternatives considered and why the chosen move scored highest.

## 5.5 Maintainability and Portability

**NFR-7** The strategy/decision core shall be decoupled from both the Engine and the transport (embedded vs HTTP) so that either can change with minimal impact, and so a future third-party adapter can be added without touching strategy code.

**NFR-8** The system shall run on a single commodity Linux workstation; GPU acceleration shall be optional and required only for RL training, not for play.

## 5.6 Legal, Ethical, and Fair-Play

**NFR-9** The Agent shall not be deployed on any online service in violation of that service’s Terms of Service, and shall not use hidden information it could not legally obtain in a real game. Its purpose is strong fair play and research, not deception of opponents about its nature where disclosure is required.

# 6. Acceptance Criteria - Defining “Highly Skilled”

Because “highly skilled” is the crux of this project, it is pinned to concrete, measurable thresholds. Strength is always measured on the target scope (base + Corporate Era + Prelude), with two-player play as the primary configuration, over statistically adequate sample sizes. The skill bar itself is defined by external, skill-sensitive play - a quantitative expert-human benchmark (AC-4) and a qualitative expert review (AC-6) - not by resemblance to any dataset. The top-25 Board Game Arena expert dataset of Section 1.5 is used only as a supporting calibration and sanity check (AC-8), consistent with FR-DATA-2; it never defines correct play and is never a primary threshold. A distributional match to a dataset is neither necessary nor sufficient for skill: a self-play sample can resemble expert statistics without the Agent being expert-strength, which is precisely why the primary bar rests on external opposition rather than on distributional resemblance.

| ID   | Criterion                                            | Threshold                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | Legality and completion                              | Plays >= 1,000 consecutive embedded games with zero illegal moves and zero unhandled errors.                                                                                                                                                                                                                                                                                |
| AC-2 | Improvement over the classical baseline (guardrail)  | Wins >= 65% head-to-head (2p) against the project’s own tuned heuristic bot, at 95% confidence. This measures improvement over the project’s own reference, not absolute skill, and is a guardrail - not a definition of success.                                                                                                                                           |
| AC-3 | Dominates weak baselines                             | Wins >= 90% against a random-legal player and >= 80% against a greedy one-ply (OSLA-equivalent) player.                                                                                                                                                                                                                                                                    |
| AC-4 | Expert human benchmark (primary skill bar)           | Achieves a winning or better-than-even record against experienced human players on the self-hosted engine: target >= 50% win rate (or better-than-even placement) across >= 30 games versus self-identified strong players, at adequate confidence. Where a rated platform and its ToS permit, an equivalent rating may substitute or supplement (subject to CON-4/NFR-9). |
| AC-5 | Multiplayer competence                               | In 3-4 player games, finishes first at a rate significantly above the 1/N chance baseline (e.g., >= 2x expected placement).                                                                                                                                                                                                                                                 |
| AC-6 | Strategic soundness (qualitative, primary)           | Review of logged games by a strong player finds no systematic blunders and evidence of coherent engine-building, timing, and milestone/award play.                                                                                                                                                                                                                           |
| AC-7 | Monotonic improvement (guardrail)                    | Each promoted version beats the previous version with statistical significance in the match harness.                                                                                                                                                                                                                                                                         |
| AC-8 | Distributional calibration (supporting sanity check) | After BGA-vs-engine reconciliation, the Agent’s own game statistics (winning score, Terraform Rating at game end, generations-to-finish, and card/corporation win-rate profile) are not wildly inconsistent with the top-25 expert distributions of Section 1.5. Per FR-DATA-2 this is a smell test only - never a skill threshold, a target to imitate, or a constraint.    |

**Primary bar:** AC-1, AC-4, and AC-6 together constitute the definition of success: the Agent must play legally to completion (AC-1) and demonstrate expert-level strength both quantitatively against strong external opposition (AC-4) and qualitatively under expert review (AC-6). AC-2 and AC-7 are improvement guardrails. AC-3, AC-5, and AC-8 are supporting evidence.

**Note on the dataset (AC-8).** The expert distributions are a reference, not a target. Matching them is neither necessary nor sufficient for skill - a self-play sample can resemble expert statistics without expert strength - so they are used only to flag gross inconsistencies, per FR-DATA-2/3/4. The Agent is expected and encouraged to exceed expert tendencies and to discover play the dataset does not exhibit, and shall never be scored against, penalised for, or constrained toward conformity with them.

**Dependency note (AC-4/AC-6).** Both primary skill criteria depend on access to at least one strong human reviewer/opponent. This human-availability dependency is a project risk (see the Implementation Plan risk register) and must be secured early.

# Appendix A. Game Scope Detail

**Objective.** Score the most victory points by game end. VP come from Terraform Rating, greenery and city tiles and their placement, awards, milestones, and victory points printed on played cards.

**Game end.** The game ends when all three global parameters are maximised - temperature +8°C, oxygen 14%, and 9 ocean tiles placed - after which the current generation is completed and final greenery placement and scoring occur.

**Included content.** The base project cards and standard projects; the Corporate Era cards and corporations (the full economic/engine game); and the Prelude expansion (each player begins with two prelude cards that accelerate their start). Milestones and awards are in play.

**Excluded content.** Venus Next, Colonies, Turmoil, Ares, CEOs, Underworld, Pathfinders, and other expansions; alternate boards beyond optional stretch support. The corresponding decision types (colony, delegate, party, policy, globalEvent, aresGlobalParameters, claimedUndergroundToken) will generally not arise, but the Agent should degrade gracefully if configured otherwise.

**Player counts.** 2 to 4 players. Two-player games are the primary training and evaluation setting (simplest to train and evaluate head-to-head, and the setting in which the AC-4 human benchmark is run). Three- and four-player competence is required (AC-5); the top-25 three-player expert dataset of Section 1.5 is used as loose calibration only (AC-8), not as a primary benchmark. The solo variant is not a target but is a useful smoke test.

# Appendix B. Traceability Note

Each functional requirement in Section 4 and interface requirement in Section 3 maps to one or more acceptance criteria in Section 6 and to a milestone in the companion Implementation Plan. FR-OBS/FR-ACT/FR-INT establish the interface the Agent must master (Milestones 1-2); FR-4 through FR-8 establish decision quality (Milestones 3-5); FR-DATA-1 through FR-DATA-5 govern calibration and benchmarking against the expert data and the guardrails on it (Milestones 2-3 and 6, verifying the AC-8 calibration check); FR-13 through FR-15 and NFR-3 establish the evaluation and training machinery that verifies AC-1 through AC-8.

Terraforming Mars AI - SRS v1.2 | Page
