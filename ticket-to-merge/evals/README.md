# Evals: planted-bug harness for `/ticket-to-merge:review-pr`

Each case takes a known-correct BOOK-101 implementation (`base.patch`), plants one defect (or none) with a case patch, and checks whether the reviewer reports it. Scoring is recall (planted bugs found) and precision (reported findings that are real).

## Cases

| Id | Kind | Concern | What is planted | Why |
|---|---|---|---|---|
| B1 | bug | C2 | `query.length > MAX_QUERY_LENGTH` became `>=`, so 100-character queries are rejected (max 99). Enforced once, in `parseSearchQuery`, which the routes and `searchBooks` all call. | Boundary error against the spec's 100-char rule. |
| B2 | bug | C1 | `searchBooks` matches title only; the author clause is gone. | Spec requires title or author. |
| B3 | bug | S1 | `searchBooks` interpolates the user query into the SQL string instead of `?` placeholders. Works for normal input; a single quote breaks out. | SQL injection. |
| B4 | bug | S3 | `partials/book-grid.ejs` prints `book.title` with `<%- %>`. | Stored XSS. |
| B5 | bug | T4 | Pre-existing test `GET /api/books returns all books`: `expect(res.body).toHaveLength(50)` became `expect(res.body.length).toBeGreaterThan(0)`. No code change. | Weakened assertion (a `-` line against `main`). `.length` is needed because `toBeGreaterThan` on an array throws. |
| K1 | clean | none | Rename local `escaped` to `escapedQuery`; extract the `'%'` literal into `LIKE_WILDCARD`. | Behaviour identical; any finding is a false positive. |
| K2 | clean | none | `const SORT_COLUMN = 'title'` interpolated into the `ORDER BY` of the search SQL. | Looks like SQL injection but is a constant. Any finding is a false positive. |
| combined | bug | all | B1..B5, K1, K2 together (`cases/combined.patch`). | One realistic review with several bugs and decoys. |

`combined.patch` is a composed patch, not a stack of the single patches: B2, B3 and K2 edit the same SQL statement, so they conflict when applied one after another, and B2 already deletes the test that B4 edits. Its expected locations are computed on the combined tree (B2 and B3 point at the same line; K2 shares that line but is not a bug).

`manifest.json` lists, per case, `expected` entries `{bug, file, lines, anchor, keywords}`. `anchor` is a literal string that must appear on those lines; the dry run checks it, so the manifest cannot drift from the patches.

## Silent-bug rule

For B1 to B4 only the tests that fail because of the bug are edited or deleted, the way a sloppy developer would make the suite green (B1: `repeat(100)` to `repeat(99)` in the boundary tests; B2: author tests deleted; B3: injection tests deleted; B4: the `&amp;` assertion changed to `&`). The reviewer cannot find the bug by watching a red suite. B5, K1 and K2 keep the suite green with no test edits. Every case must pass `npm run build && npm run test:run`; the dry run enforces it.

## Leak protection

Each run builds a throwaway clone under `/tmp/t2m-eval/<case>-<timestamp>-run<k>/` (never `/tmp/ticket-to-merge`, which the guardrail protects):

1. `git clone -b book-101` of this repo; local `main` is created from `origin/main` if missing.
2. The `origin` remote is removed and `ticket-to-merge/evals` is stripped from the branch history (`filter-branch` on `main..book-101`, then reflog expire and gc). The clone cannot reach the manifest or patches through git.
3. The plugin is copied, without `evals/`, to `<run>/plugin/`.
4. `ticket-to-merge/` is removed from the clone in a commit "eval: remove plugin from tree", so it is not in the reviewed diff.
5. `base.patch` plus the case patch are applied as one commit "BOOK-101: implement search", then `npm ci` runs.

The review runs with cwd in the clone and `--plugin-dir` pointing at the copy. Residual risk: the reviewer has Read and Bash and could in principle open this repo by absolute path. The skill does not, but it is not sandboxed.

## Running

```
node ticket-to-merge/evals/run.mjs --case <B1..B5|K1|K2|combined> --runs 3 --model sonnet
node ticket-to-merge/evals/run.mjs --case combined --dry-run     # no review, no cost
```

Options:

- `--evals-dir <path>`: read `manifest.json` and the case patches from `<path>` instead of `ticket-to-merge/evals/` (for example a held-out set kept outside the fork). `base.patch` still comes from `ticket-to-merge/evals/base.patch`. Results go to `<path>/results/<timestamp>/`. A case may omit `concern` and may carry `includes` and a `clean` array of `{id, file, description}`; `clean` entries are listed in `summary.md` (and `summary.json`) and never matched against findings. Anchors are verified in `--dry-run` exactly as for the built-in set.
- `--no-spec`: remove `SPEC.md` in the same commit that removes the plugin, so it is neither in the reviewed diff nor on disk (simulates a branch with no spec). `summary.md` and `summary.json` record `spec: none` (otherwise `present`).

Always pass `--model sonnet`. `--keep` keeps the temp clone. `--dry-run` builds the sandbox, prints the reviewed diff stat, verifies the anchors and runs `npm run build && npm run test:run`; it never calls `claude`.

Output goes to `ticket-to-merge/evals/results/<timestamp>/` (git-ignored; `<evals-dir>/results/<timestamp>/` with `--evals-dir`): `<case>-run<k>.json` (raw), `ledger.md` (every finding with its label), `summary.md`, `summary.json`.

Matching: a finding matches an expected bug when its file path ends with the expected file AND (its line is within the expected range +-3 OR a keyword appears in `issue` + `evidence`, case-insensitive). A keyword hit outranks a line-only hit. A bug matches one finding; further findings for it are `duplicate:<id>`; everything else is `needs-judgement`. Matcher tests: `node --test ticket-to-merge/evals/tests/match.test.mjs`.

## Finishing the labelling by hand

Provisional precision counts `needs-judgement` as not yet judged. To finish:

1. Open `ledger.md`. For each `needs-judgement` row, read the code at `file:line` (case patch applied on base) and decide: a real defect (label `TP:other`) or not real (label `FP`). On clean cases (K1, K2) every finding is a false positive unless it points at something genuinely wrong in the base.
2. Check that `duplicate` rows are the same bug as labelled; relabel if not.
3. Final precision = count of `TP:*` rows / all findings (duplicates count as findings). Recall stays bugs found / (bugs x runs) from `summary.md`.
4. Report the runs together, with the hand-labelled counts next to the auto numbers.
