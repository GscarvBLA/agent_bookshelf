---
name: review-pr
description: Review a branch diff with read-only specialists and a verifier. Use when the user wants an evidence-backed review of the current branch or a git range, with findings as JSON.
argument-hint: "[git-range, e.g. main...HEAD]"
---

# review-pr

While this skill is a skeleton, invoking it must reply exactly `ticket-to-merge review-pr skeleton loaded` and do nothing else.

TODO (phase 3/4): full instructions. Intended flow:

1. Compute the diff (the git range argument, default `main...HEAD`).
2. Run `npm run build && npm run test:run` once and capture the output as evidence.
3. Run 3 read-only specialists in parallel: security, correctness, tests.
4. The verifier tries to refute each finding.
5. Print JSON findings: `{file, line, severity, issue, evidence}`.
