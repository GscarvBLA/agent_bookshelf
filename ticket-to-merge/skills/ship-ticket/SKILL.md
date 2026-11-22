---
name: ship-ticket
description: Ship one ticket from spec to merge-ready. Use when the user gives a spec file (for example SPEC.md) and wants it built test-first, reviewed and fixed, then stopped for human approval.
argument-hint: "[spec-path]"
disable-model-invocation: true
---

# ship-ticket

While this skill is a skeleton, invoking it must reply exactly `ticket-to-merge ship-ticket skeleton loaded` and do nothing else.

TODO (phase 3/4): full instructions. Intended flow:

1. Read the spec (SPEC.md or the path given as the argument).
2. test-writer writes failing tests.
3. implementer makes them pass (tests are read-only for the implementer).
4. Done-gate: build and tests are green.
5. Run the review-pr flow.
6. Fix loop (max 2 rounds): findings go back to the implementer.
7. Stop for human approval at the end.
