# CLAUDE.md

Agent Bookshelf: a Goodreads-lite teaching app (Express + TypeScript, SQLite via sql.js, EJS + HTMX, Vitest).

## Rules

### 1. Use these exact commands

| Task | Command |
|---|---|
| Dev server (auto-reload) | `npm run dev` |
| Build | `npm run build` |
| Start built app | `npm start` (http://localhost:3000) |
| Run tests once | `npm run test:run` |

- Verify changes with `npm run build && npm run test:run` before saying work is done.
- Never run bare `npm test`. It starts watch mode and never exits.
- Do not run the app, tests or other commands in a way that creates `bookshelf.db-*` files in the repo root.

### 2. Never edit `dist/` by hand

- `dist/` is build output from `tsc` plus `copy-assets`. Manual edits are overwritten.
- Change the source in `src/` instead.
- To regenerate `dist/`, run `npm run build`.
- If only static assets changed (views, public), `npm run copy-assets` is enough.

### 3. Ask before adding a dependency

- Do not run `npm install <pkg>` or edit `dependencies` / `devDependencies` without asking first.
- For small tasks, write the code instead of installing a package. Examples: a validation check, a string helper, a date format.
- When asking, say what the package does, why it's needed, and what the in-house alternative would cost.
- `sql.js` is a deliberate choice (zero native dependencies). Do not swap it for a native SQLite package.

### 4. Protected files

- Never modify, move or delete `bookshelf.db*`, `src/db/seed.sql` or `.env`. A hook blocks it.
- No schema changes unless the spec explicitly asks for one.

## Conventions

- **ESM only.** Relative imports end in `.js`, even from `.ts` files (`import * as Book from '../models/book.js'`).
- **TypeScript strict.** Type function signatures and exported interfaces. Avoid `any`.
- **Parameterized SQL.** Pass values as `?` placeholders (`get('... WHERE id = ?', [id])`). Never interpolate user input into a query string.
- **Data access lives in `src/models/`.** Routes call model functions and never run SQL directly.
- **Model style.** Plain exported functions plus an exported interface per table (`getBookById`, `createBook`). No classes.
- **Route style.** Import models as namespaces (`import * as Book`). Return JSON errors as `{ error: '...' }` with the right status (400, 404).
- **Config.** Read `PORT` from `process.env`. Do not add other required env vars (the app must run with zero config).

## Testing

- Each test file calls `initDb('/tmp/<unique-name>.db')` in `beforeEach` and deletes it in `afterEach`.
- Route tests use `supertest` against `app` from `src/server.ts`.

## Views

- Output text with `<%= %>` (escaped). Use `<%- %>` (unescaped) only for `include` and the layout's `body`, never for user or database text.

## Layout

- `src/server.ts`: Express app
- `src/db/`: `schema.sql`, `seed.sql`, `index.ts`
- `src/models/`: data access
- `src/routes/`: HTML routes (`books.ts`, `shelves.ts`, `reviews.ts`) and JSON API (`api.ts`)
- `src/views/`: EJS templates
- `tests/`: Vitest
- `docs/adr/`: architecture decisions
