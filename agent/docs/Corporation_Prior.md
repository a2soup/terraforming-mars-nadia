# The corporation opening prior — Milestone 2, bullet 4

**Status: DONE (10 Aug 2026).** SRS FR-DATA-1. Deliberately short: bullet 4 was cut from the
expert-distribution report to a single table on the same day it was built (SRS v1.7 / Plan v1.8,
AC-8 withdrawn), and a 600-line write-up would be the cut work growing back in prose. The three
findings below are the reason this file exists at all rather than only a Running Notes entry.

**Artifacts**

| File | What it is |
| --- | --- |
| `docs/data/runedk93_prelude_corps.txt` | The upstream table, vendored verbatim under its MIT licence |
| `docs/data/corporation_prior.json` | The built artifact: 17 rows, engine-matched, with provenance |
| `src/prior/corporationPrior.ts` | Parse / build / load, and the derived rows a consumer reads |
| `test/prior/corporationPrior.spec.ts` | The standing check — 18 specs, re-derives the artifact from the source |

There is no CLI. The spec is the re-runnable check: it rebuilds the artifact from the vendored table
and compares, so a hand edit to the JSON fails there rather than silently becoming the prior
Milestone 3 reads.

## What was ingested

`prelude/corps.txt` from github.com/RuneDK93/terraforming-mars-dataset — per-corporation results over
**1,616 three-player base + Prelude games**, Board Game Arena season 19, top-25 rated players. Blob
SHA `0f4dfa22a4ab764215a8edcaa68e6ab1f22780bb` at repo commit `462e6894f` (10 Mar 2025). The vendored
copy hashes to that SHA, asserted in the spec, so the transcription is auditable offline.

**Reconciliation: 17 of 17, nothing unmatched in either direction.** Every dataset name maps to an
engine `CardName` at pin `868714d72`; every corporation the census marks `reachable` has a row. The
spelling differences are whitespace and capitalisation only (`CheungShingMars` → `Cheung Shing MARS`)
— no judgement calls and no near-matches. Beginner Corporation is `unreachable-in-config` in the
census and correctly absent upstream. FR-DATA-1's "flag, don't coerce" branch therefore never fires
on the real table, so the spec drives it with a synthetic unmatched row; a requirement checked only
by "there weren't any" is not checked.

**Two arithmetic identities hold exactly**, and they are the checks worth having because they know
nothing about this project: participations sum to 4,848 = 3 × 1,616, and wins sum to 1,616 — one
winner per game, which also establishes that "Win Rate" is a first-place rate and not a top-two rate.
Either would have caught a truncated download, a duplicated row, or a table regenerated upstream
against a different corpus.

## The prior

Chance is **33.3%**, not 50%. `sep` marks a 95% Wilson interval that excludes chance.

| Corporation | n | win % | adv pp | 95% CI | sep | WAP |
| --- | ---: | ---: | ---: | :---: | :---: | ---: |
| CrediCor | 340 | 40.88 | +7.5 | [35.8, 46.2] | ✔ | +0.034 |
| Interplanetary Cinematics | 239 | 40.17 | +6.8 | [34.2, 46.5] | ✔ | +0.097 |
| Tharsis Republic | 395 | 40.00 | +6.7 | [35.3, 44.9] | ✔ | +0.148 |
| Cheung Shing MARS | 322 | 38.51 | +5.2 | [33.4, 43.9] | ✔ | +0.071 |
| Ecoline | 290 | 37.24 | +3.9 | [31.9, 42.9] | | +0.022 |
| Vitor | 325 | 36.92 | +3.6 | [31.9, 42.3] | | +0.071 |
| Saturn Systems | 347 | 36.60 | +3.3 | [31.7, 41.8] | | +0.085 |
| Point Luna | 397 | 36.27 | +2.9 | [31.7, 41.1] | | +0.005 |
| Mining Guild | 301 | 32.56 | −0.8 | [27.5, 38.0] | | +0.022 |
| Valley Trust | 365 | 32.05 | −1.3 | [27.5, 37.0] | | −0.023 |
| Teractor | 308 | 31.82 | −1.5 | [26.9, 37.2] | | −0.017 |
| Inventrix | 247 | 28.34 | −5.0 | [23.1, 34.3] | | −0.104 |
| ThorGate | 115 | 26.96 | −6.4 | [19.7, 35.7] | | −0.087 |
| PhoboLog | 287 | 26.13 | −7.2 | [21.4, 31.5] | ✔ | −0.137 |
| Robinson Industries | 199 | 22.61 | −10.7 | [17.4, 28.9] | ✔ | −0.180 |
| Helion | 211 | 18.48 | −14.8 | [13.8, 24.3] | ✔ | −0.174 |
| United Nations Mars Initiative | 160 | 16.88 | −16.5 | [11.9, 23.4] | ✔ | −0.137 |

## Three findings

**1. WAP is not a win rate, and both source documents say it is.** SRS §1.5 and Plan Appendix A.1
described it as "a skill-adjusted win rate that partially controls for player strength." The first
half is right; the second is wrong. Upstream (`helper_functions.py::corp_ranking`) it is

```
actual      = [2, 1, 0] by finishing position
expected[i] = Σ over opponents j of 1 / (1 + 10 ** -((elo_i − elo_j) / 400))
WAP         = mean over that corporation's games of (actual − expected)
```

— a **mean Elo-performance residual in pairwise wins per game**, on roughly [−2, +2] and centred near
zero. It is not a probability and cannot be mixed with one, rescaled to [0, 1], or clamped. Both
documents are corrected in place. This matters because the guardrails say to *prefer* WAP: an
instruction to prefer a column is worth little while the column's meaning is mis-stated.

**2. The skill adjustment does real work, and it disagrees most where it matters.** Spearman ρ
between the raw rate and WAP is 0.92 — but **CrediCor is 1st by rate and 6th by WAP**, the largest
shift in the table, and Tharsis Republic takes the top WAP spot. That is FR-DATA-3's confounding made
visible in the data: strong players pick CrediCor, and the Elo residual takes the credit back. An
opening book built on the raw rate would be partly fitting the BGA player pool's preferences rather
than the corporations.

**3. A 3-player prior applied at 2 players is a biased prior, and neither source document flagged
it.** This is the only corpus in scope, and the project's primary setting is 2p. Corporation strength
is not player-count invariant — engine corporations gain from 3p's longer games and weaker denial,
and Tharsis Republic's city income scales directly with the number of opponents building cities, so
its top-WAP position is partly an artefact of the count it was measured at. Survivable only because
the prior is weak and short-lived. Recorded here, in the module comment, and in the Running Notes.

## How Milestone 3 should read it

**Most of this table is noise.** Eight of seventeen rows have an interval excluding chance; the nine
in the middle span −5.0 to +3.9 pp with intervals that all contain 1/3. Ranking those nine against
each other is reading sampling error. `corporationPriorRows()` attaches the interval and a
`separatedFromChance` flag precisely so a consumer does not have to rediscover this.

`corporationPriorRows()` deliberately applies **no weight**. How weakly to weight a starting bias is
M3's decision about its own opening book, and hard-coding one in the data layer would hide it at the
point where it matters. The prior is a tie-breaker for a decision the harness has no opinion about
yet, and it expires the moment the harness does (FR-DATA-2/3/4). Prelude and initial-card selection
get no dataset prior at all — the per-card table that would have supplied one was cut with AC-8.
