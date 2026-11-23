# Cost report: the one lever

Source for the README cost section. Numbers come from `ticket-to-merge/scripts/usage-report.mjs` on the session transcript.

## The lever

**Orchestrator model: opus to sonnet.** Start the session with `claude --model sonnet --plugin-dir ./ticket-to-merge`.

Why this lever: every agent already pins `model: sonnet`, and both skills set `model: sonnet`. But a skill's model applies only to the current turn. When an agent runs in the background, the turn ends, and the rest of the recipe runs on the session's default model (opus here). Asking for foreground agents in the recipe did not prevent it (the model still passed `run_in_background` as the string `"false"`). Setting the session model is the reliable fix.

## Before: orchestrator on opus (run e2e2, session e7776edf)

| Stage | Cost | Cache hit | Models |
|---|---|---|---|
| Build | $0.34 | 87% | sonnet |
| Review | $0.24 | 60% | sonnet |
| Fix loop | $0.00 | n/a | (no critical/major findings) |
| Orchestration | $0.95 | 95% | opus + sonnet |
| **Total, one ticket** | **$1.53** | 90% | |

Quality before: 76/76 own tests · 93/93 held-out acceptance simulation · review 0 findings · spec criteria 1 to 16 all mapped to tests.

## After: orchestrator on sonnet (the shipped run in the fork, session c44a8dab)

| Stage | Cost | Cache hit | Models |
|---|---|---|---|
| Build | $0.37 | 89% | sonnet |
| Review | $0.25 | 48% | sonnet |
| Fix loop | $0.00 | n/a | (no critical/major findings) |
| Orchestration | $0.48 | 94% | sonnet |
| **Total, one ticket** | **$1.11** | 89% | |

**Result: $1.53 to $1.11 per ticket (-27%).** An earlier full run with the same setting cost $0.99 (-35%), so the saving is 27 to 35%. Orchestration went from $0.95 to $0.40-$0.48. Build and review were already on sonnet and barely moved.

## Quality re-check after the lever

| Check | Before (opus orchestrator) | After (sonnet orchestrator) |
|---|---|---|
| Own tests | 76/76 | 79/79 (every criterion 1 to 16 mapped) |
| Held-out acceptance simulation (`capstone-evals/hidden-sim`) | 93/93 | 93/93 |
| Review on the built branch | 0 findings | 0 findings |
| Guardrail blocks during the run | 2 (one legitimate commit wrongly blocked, since fixed) | 0 |
| Planted bugs, dev set, 3 runs (re-run after the lever) | 15/15 in earlier dev runs | **15/15 found, 18/18 findings true defects, 0 clean changes flagged** ([results](../ticket-to-merge/evals/reported/final-dev-x3/summary.md)) |

The planted-bug eval runs `/review-pr` headless on sonnet, so it re-checks review quality on the exact plugin that shipped.

Totals were cross-checked against Claude Code itself: on the same session, `usage-report.mjs` gave $0.77 and the CLI's reported total was $0.771.

Same quality on every measure. The test count is a different but complete test-writer output each run (76 before, 79 after), and the held-out simulation, which the build never saw, is 93/93 in both.
