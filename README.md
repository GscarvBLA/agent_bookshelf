# Capstone: Ticket to Merge (BOOK-101)

**Repo:** https://github.com/GscarvBLA/agent_bookshelf, branch `book-101` (fork of `abarriosBLA/agent_bookshelf`).

BOOK-101 (search books by title or author) was built and reviewed by the `ticket-to-merge` plugin in this repo. The original course README follows below this section.

| Checklist item | Where |
|---|---|
| Repo link | above |
| How to run `/ship-ticket` and `/review-pr` | [How to run](#how-to-run) |
| How to use the feature that was built | [Using the search](#using-the-search-book-101) |
| `SPEC.md` and `CLAUDE.md` | [`SPEC.md`](SPEC.md), [`CLAUDE.md`](CLAUDE.md) |
| Plugin passes `claude plugin validate` | [Plugin](#plugin) |
| Test run, green | [Build results](#build-results) |
| Planted bugs: recall and precision over 3 runs | [Review evals](#review-evals) |
| Cost report with one lever | [Cost](#cost) |
| Design: why this split, which models, what I'd cut | [Design](#design) |

## How to run

Run on a feature branch (the recipe refuses `main` and a dirty tree). Always start the session on sonnet: the skills pin sonnet, but a skill's model only lasts for the current turn, and agents that finish in the background start a new turn on the session's model.

```bash
claude --model sonnet --plugin-dir ./ticket-to-merge --allowedTools "Bash Edit Write Read Grep Glob Agent Skill"
```

- `/ticket-to-merge:ship-ticket SPEC.md`: pre-flight, failing tests (test-writer), code (implementer), done-gate, review, fix loop (max 2 rounds, critical/major only), then a report with the cost table. It stops for human approval and never pushes.
- `/ticket-to-merge:ship-ticket SPEC.md --from-review <base>`: skips building and starts at the review on code already committed after `<base>`, then runs the fix loop as usual.
- `/ticket-to-merge:review-pr [range] [--spec path]`: reviews `merge-base(main)...HEAD` by default (falls back to `origin/main...HEAD`, then the last commit, if empty), excluding the plugin's own folder. Prints one summary line and a JSON array of `{file, line, severity, issue, evidence}`. Uses `SPEC.md` if present, else says `no spec found`.
- Add these deny rules to your project's `.claude/settings.json` (a plugin cannot ship permission rules; they block `@.env`, which skips hooks): `{"permissions": {"deny": ["Read(./.env)", "Read(./.env.*)"]}}`. This repo already has them.

## Using the search (BOOK-101)

```bash
npm install                            # also builds
npm run build && npm run test:run      # 79 tests, green
npm start                              # http://localhost:3000
```

**In the browser:** open http://localhost:3000 and type in the search box. Results update as you type, matching part of a title or author, ignoring case.

**JSON API:**

| Request | Returns |
|---|---|
| `GET /api/books?q=tolk` | `200`, a JSON array of matching books, ordered by title (here *The Hobbit*, *The Lord of the Rings*) |
| `GET /api/books/search?q=tolk` | The same, through an alias |
| `GET /api/books` or `?q=` or `?q=%20%20` | All 50 books |
| `GET /api/books?q=MI%C3%89VILLE` | `200`, *The City & the City* (case folding works for non-ASCII letters too) |
| `q` longer than 100 characters after trimming | `400`, `{ "error": "Search query must be 100 characters or fewer" }` |
| `?q=a&q=b` or `?q[x]=1` | `400`, `{ "error": "Search query must be a single value" }` |
| A control character in `q` (for example `%00`) | `400`, `{ "error": "Search query contains invalid characters" }` |

**HTML fragment** (used by the search box through HTMX): `GET /books/search?q=<term>` returns the matching book cards, `No books found`, or a `<p class="error">` fragment with status `400`.

### Interface (fills the ticket's `[endpoint and response shape]`)

The ticket left the interface open. I chose it from what the repo already had: `searchBooks` existed in the model, the home page search box already called `GET /books/search?q=` through HTMX, and the JSON API already served `GET /api/books`. Everything below is fixed in `SPEC.md` and covered by tests.

| Surface | Signature | Success | Validation error |
|---|---|---|---|
| Model | `searchBooks(query: string): Book[]` and `parseSearchQuery(raw: unknown)` | `Book[]` ordered by title; empty or blank query returns all books | `searchBooks` throws `Error(<message>)`; `parseSearchQuery` returns `{ ok: false, error: <message> }` |
| JSON | `GET /api/books?q=<query>`, alias `GET /api/books/search?q=<query>` | `200`, JSON array of books | `400`, `{ "error": "<message>" }` |
| HTML | `GET /books/search?q=<query>` | `200`, a fragment of `book-grid` / `book-card` markup, or `No books found` | `400`, `<p class="error"><message></p>` |

**Response shape.** Each book has the same fields as `GET /api/books` returned before the change: `id`, `title`, `author`, `isbn`, `cover_url`, `description`, `published_year`, `created_at`.

**Error messages**, in the order they are checked:
1. `Search query must be a single value` for a repeated or object `q`.
2. `Search query contains invalid characters` for a control character left after trimming.
3. `Search query must be 100 characters or fewer` for more than 100 characters after trimming.

The full contract and an end-to-end checklist are in [`SPEC.md`](SPEC.md), under Acceptance criteria and Verification.

## Plugin

`claude plugin validate ./ticket-to-merge` passes.

```
ticket-to-merge/
├── .claude-plugin/plugin.json
├── skills/ship-ticket, skills/review-pr      # the two recipes (main session)
├── agents/                                    # test-writer, implementer, review-security, review-correctness, review-tests, verifier
├── hooks/                                     # guardrail: protect.mjs (PreToolUse), integrity.mjs (SessionStart + PostToolUse), 277 tests
├── scripts/usage-report.mjs                   # cost per stage from the session transcripts
└── evals/                                     # planted-bug eval: base, 7 cases, runner, matcher
```

**Guardrails.** Protected: `bookshelf.db*`, `src/db/seed.sql`, `.env*`, and the hook's own files. Edit/Write/Read/Grep are checked by resolved path (handles `../` and symlinks). Bash is checked in layers: protected names after normalising quotes and escapes, destructive verbs aimed at globs or directories that could reach a protected file, git escapes, dynamically built command words, and inline interpreters (`node -e`, `bash -c`, `base64 -d | sh`, heredocs) blocked outright. Anything that still gets through (for example writing `scratch.js` and running it) is caught by the integrity backstop, which restores the file and tells the agent. Seen live: an Edit, a Bash `rm` and a Grep on `.env` were blocked, and a script that appended to `seed.sql` was restored right after it ran. Role split, enforced by the same hook through `agent_type`: the implementer cannot change `tests/`; the test-writer can only change `tests/`. Reviewers and the verifier only have Read, Grep and Glob.

## Build results

Final run in this fork (`/ship-ticket`, sonnet): commits `819d696` (failing tests) and `6fd1170` (implementation).

- `npm run build && npm run test:run`: green, **79 tests** (14 existing + 65 new). Every acceptance criterion 1 to 16 in `SPEC.md` maps to named `AC<n>:` tests.
- **Held-out acceptance simulation: 93/93.** A separate agent that saw only the ticket text and the original app (never `SPEC.md`, the plugin or any implementation) wrote 93 tests across four plausible interfaces (`searchBooks`, `GET /books/search`, `GET /api/books?q=`, `GET /api/books/search?q=`), tagged likely or adversarial. It is kept outside the repo so the build agents cannot see it. A build from an earlier, less precise spec scored 61/93. The 32 failures pointed to the edge cases that were then written into `SPEC.md`: non-ASCII case (`MIÉVILLE`), the `/api/books/search` path, model-level validation, and the null byte (SQLite cuts a `LIKE` pattern at `\0`, so `q=%00` matched every book).
- The interface was left open in the ticket (`[endpoint and response shape]`). `SPEC.md` fills it in and lists that as an assumption.

## Review evals

Precision rule used here: a finding is real if it is a true defect, checked by hand against the code. Every finding is listed in the ledgers.

**Dev set** (`ticket-to-merge/evals`, written by me, one bug per reviewer concern; final plugin, combined branch, 3 runs):

| Bug | run1 | run2 | run3 |
|---|---|---|---|
| B1 boundary `>= 100` | found | found | found |
| B2 author dropped from query | found | found | found |
| B3 SQL built by interpolation | found | found | found |
| B4 `<%- book.title %>` (XSS) | found | found | found |
| B5 pre-existing assertion weakened | found | found | found |

- **Recall 15/15 (100%).**
- **Precision 18/18 (100%) true defects.** That is 15 planted bugs plus the same real gap in each run: my bug patches deleted the AC8 test for a successful HTML fragment, and the code behind it is correct. If only planted bugs count, precision is 15/18 (83%).
- **Clean cases flagged: 0.** K1 is a refactor. K2 interpolates a fixed `ORDER BY` constant, which looks like string-built SQL but is safe.
- **Cost: about $0.52 per review on sonnet ($1.57 for the 3 runs).**

Each finding's test gap is folded into its code bug, for example "the boundary tests use 99 characters, so no test catches it". So one defect is one finding.

Evidence: [`ticket-to-merge/evals/reported/final-dev-x3/`](ticket-to-merge/evals/reported/final-dev-x3/summary.md) (bug x run matrix, every finding with its label, cost and model per run).

**Held-out set** (planted blind by a separate agent that never saw the reviewer prompts or my bugs, and measured before any tuning on it): 7 subtler bugs across five files and four layers, plus 3 changes that look suspicious but are correct.

| | With `SPEC.md` (3 runs) | Without `SPEC.md` (1 run) |
|---|---|---|
| Recall | **21/21** | **6/7** (missed: U+007F accepted, a spec-only rule) |
| Precision (true defects / findings) | 26/26 | 7/7 |
| Clean changes flagged | 0 | 0 |

Three prompt changes came after these held-out runs, all prompted by the dev set or by format issues, never by a held-out bug: reviewers report source-file line numbers (two held-out runs had used diff-line numbers); the verifier folds a test gap into the code bug it shadows (so one defect is one finding); and review-tests always reports a weakened pre-existing assertion.

## Cost

Full write-up: [`docs/capstone-cost-lever.md`](docs/capstone-cost-lever.md).

| Stage | Before: orchestrator on opus | After: orchestrator on sonnet |
|---|---|---|
| Build | $0.34 | $0.37 |
| Review | $0.24 | $0.25 |
| Fix loop | $0.00 | $0.00 |
| Orchestration | $0.95 | $0.48 |
| **Total, one ticket** | **$1.53** | **$1.11 (-27%)** |

The "after" column is the run that shipped. An earlier full run with the same sonnet setting cost $0.99, so the saving is 27 to 35%. Cache hit 89 to 91% in all runs. Costs come from `ticket-to-merge/scripts/usage-report.mjs`, which reads the session transcripts per stage. Its total matched Claude Code's own figure on the same session ($0.77 vs $0.771). **The lever** is the orchestrator's model. All agents were already on sonnet, but the background-agent issue (see How to run) kept moving the main session onto opus. **Quality re-check:** held-out simulation 93/93 before and after, review 0 findings before and after, every criterion covered by tests in both. Planted bugs re-run after the lever: 15/15 found, 18/18 true defects (dev set, 3 runs). One review run costs about $0.52 on sonnet.

## Design

**The split.**
- **Two build agents (test-writer, implementer)**, not one. This is the course's "red first, tests read-only" workflow, and a hook enforces it by agent type rather than just asking.
- **A gate on done, two layers.** A `SubagentStop` hook (`hooks/gate.mjs`) stops the implementer from finishing while the build or tests are red, and gives up after 3 attempts so it can never trap an agent. The recipe then runs the suite again itself before committing. In both shipped runs the implementer finished green, so the hook never had to block. Its blocking path is covered by 14 unit tests, not yet by a live run.
- **A fix loop, exercised in a drill.** No real run had critical or major findings, so I triggered it on purpose. `/ship-ticket SPEC.md --from-review <base>` was run on a branch carrying planted bug B1. The review found B1, the test-writer fixed the boundary tests (`fix round 1 tests`), the implementer changed `>=` back to `>` (`fix round 1`), and the re-review came back clean. That run cost $0.95 on sonnet.
- **Three review specialists**, each owning a fixed list of concerns with **no overlap** (security S1 to S6, correctness C1 to C6, tests T1 to T5), so no check is paid for twice. Each returns a coverage list.
- **A verifier** that drops what it can disprove, merges duplicates, and checks only the concerns marked `not checked`. It is skipped when there is nothing to verify.
- **The recipes run in the main session**, which collects evidence once (the diff and test output go to files, never into prompts) and commits only the files each agent reported, by name.

**Models.** Sonnet everywhere. Tests and boilerplate don't need the biggest model. The verifier started on sonnet as the cheaper option, and the held-out precision (26/26) gave no reason to move it.

**What I'd cut, and what I'd add next.**
- **Cut:** the integrity backstop's self-protection is heavy for a small team. On a real repo I'd keep the PreToolUse guard and the restore of protected data files only.
- **Cut:** the 1-run diagnosis per planted case was useful once; I wouldn't keep it.
- **Add:** foreground agents that really stay in the foreground (the main cost risk). Until then, `--model sonnet` is required.
- **Add:** HTMX showing 400 responses (out of scope in `SPEC.md`).

Spec writing is not in the plugin. I wrote `SPEC.md` myself, with Claude's help, then hardened it with data from the held-out simulation: the builders are faithful, so the spec is where the edge cases belong. For the next ticket, that thinking moves upstream into my separate `discovery` agent (interview, edge-case sweep, second-opinion subagent), not into the builders.

---

```
╔═════════════════════════════════════════════╗
║│▓│▒│░│█│▓│░│▒│█│▓│▒│░│█│▓│░│▒│█│▓│▒│░│█│▓│░│║
╠═════════════════════════════════════════════╣
║                                             ║
║     ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀                    ║
║     █▀█ █▄█ █▄▄ █░▀█ ░█░                    ║
║                                             ║
║     █▄▄ █▀█ █▀█ █▄▀ █▀ █░█ █▀▀ █░░ █▀▀      ║
║     █▄█ █▄█ █▄█ █░█ ▄█ █▀█ █▄▄ █▄▄ █▀░      ║
║                                             ║
║  a goodreads-lite playground for AI agents  ║
║                                             ║
╠═════════════════════════════════════════════╣
║│█│▓│░│▒│█│▓│▒│░│█│▓│░│▒│█│▓│▒│░│█│▓│░│▒│█│▓│║
╚═════════════════════════════════════════════╝
```

# Agent Bookshelf

A Goodreads-lite application designed as a teaching playground for AI agents courses. Students install it locally and use AI agents (Claude Code, etc.) to complete homework assignments.

## Prerequisites

**Node.js 24 LTS** is required.

| OS | Install |
|---|---|
| **macOS** | Download `.pkg` from [nodejs.org](https://nodejs.org) — Universal binary (Intel + Apple Silicon) |
| **Windows** | Download `.msi` from [nodejs.org](https://nodejs.org) — tick "Tools for Native Modules" during install |
| **Linux** | `curl -fsSL https://deb.nodesource.com/setup_24.x \| sudo -E bash - && sudo apt-get install -y nodejs` |

Verify:

```bash
node -v   # should print v24.x.x
npm -v    # should print 11.x.x
```

## Quick Start

### Using npx

```bash
corepack enable
npm install
npm run build
npx agent-bookshelf
```

That's it! The app will start at http://localhost:3000 with pre-seeded data.

## What is this?

Agent Bookshelf is a deliberately structured teaching codebase where:

- **Students** get an easy-to-install app that works immediately
- **AI agents** get a familiar, well-structured codebase to work with
- **Homework gaps** are built in for agents to fill

### Features

- Browse 50 pre-seeded books (tech and sci-fi)
- View book details with reviews and ratings
- Manage user shelves (want-to-read, currently-reading, read)
- Add reviews and ratings
- REST API for agent interaction
- HTMX-powered dynamic UI

### Pre-seeded Data

The app comes with:
- 50 books across tech and sci-fi genres
- 3 users: Alice Chen, Bob Martinez, Carol Okafor
- Sample shelves and reviews
- SQLite database (zero configuration)

## For Students

### Installation

**Prerequisites:** Node.js 20 or higher

**macOS / Linux:**
```bash
npx agent-bookshelf
```

**Windows:**
```bash
npx agent-bookshelf
```

The app will start automatically at http://localhost:3000

### Using the App

1. Browse books at http://localhost:3000
2. Click a book to see details and reviews
3. Visit /shelves to see user bookshelves
4. Add reviews and manage shelves through the UI

### For AI Agents

The app provides a REST API at `/api/*`:

```bash
# Get all books
curl http://localhost:3000/api/books

# Get a specific book
curl http://localhost:3000/api/books/1

# Add a review
curl -X POST http://localhost:3000/api/reviews \
  -H "Content-Type: application/json" \
  -d '{"userId": 1, "bookId": 5, "rating": 5, "reviewText": "Excellent!"}'

# Get user shelves
curl http://localhost:3000/api/shelves/user/1
```

See the API routes in `src/routes/api.ts` for full documentation.

## For Instructors

### Homework Gaps

The codebase includes deliberate gaps for homework assignments:

1. **Search functionality** - UI exists but backend is a TODO
   - Location: `src/routes/books.ts` line 14
   - Students can implement the search backend

2. **Missing tests** - Models have no test coverage
   - Location: `tests/` directory
   - QA homework: write test suites for models

3. **Input validation** - API endpoints lack validation
   - Location: `src/routes/api.ts`
   - Students can add validation middleware

4. **UI improvements** - Functional but minimal design
   - Location: `src/public/css/style.css`
   - PM homework: redesign specific components

### Architecture

- **Backend:** Express + TypeScript
- **Database:** SQLite via sql.js (WebAssembly, zero native dependencies)
- **Frontend:** EJS templates + HTMX
- **Testing:** Vitest (setup included, tests are homework)

### Project Structure

```
agent_bookshelf/
├── src/
│   ├── server.ts          # Express app + server
│   ├── db/
│   │   ├── schema.sql     # Database schema
│   │   ├── seed.sql       # Pre-seeded data
│   │   └── index.ts       # DB connection
│   ├── models/            # Data models (no tests - homework gap)
│   ├── routes/
│   │   ├── books.ts       # HTML routes
│   │   ├── shelves.ts
│   │   ├── reviews.ts
│   │   └── api.ts         # JSON API
│   ├── views/             # EJS templates
│   └── public/            # Static assets
├── tests/                 # Vitest setup (tests are homework)
├── bin/                   # CLI entry point
└── docs/adr/              # Architecture decisions
```

### Running Tests

```bash
npm test          # Run tests in watch mode
npm run test:run  # Run tests once
```

Note: The test setup is included, but actual tests are intentionally missing (homework gap).

## License

GPL-3.0

## Contributing

This is a teaching project. Contributions should maintain the deliberate gaps that make homework assignments possible.
