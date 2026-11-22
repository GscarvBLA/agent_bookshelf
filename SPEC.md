# BOOK-101: Search books by title or author

## Goal
Readers can find a book by typing part of its title or author. Matching is partial and ignores case. This replaces the "coming soon" stub on the home page search box and adds the same search to the JSON API.

The hidden tests will probe edge cases we have not been told about. Every edge case below is therefore pinned down on purpose. Do not leave any of them to chance.

## Context
- **Partial match:** `tolk` finds the two books by "J.R.R. Tolkien" in the seed data (*The Hobbit* and *The Lord of the Rings*).
- **Parameterised SQL:** values go in as `?` placeholders. Query text is never built by joining strings.
- **HTMX:** a small browser library. The home page search box calls `GET /books/search` and swaps the response into `#search-results`.
- **Validation error:** a 400 response. The API sends `{ "error": "<message>" }`. The HTML route sends a `<p class="error">` fragment.
- **Trimmed:** leading and trailing whitespace removed.

## How it works today
- `src/routes/books.ts:7`: `GET /` renders `books/index` with all books.
- `src/views/books/index.ejs:5-17`: search input named `q`. HTMX calls `GET /books/search` on input, 300 ms delay, and swaps into `#search-results`.
- `src/views/books/index.ejs:19-31`: `#search-results` holds `div.book-grid` with one `div.book-card` per book. EJS `<%= %>` escapes output.
- `src/routes/books.ts:12-22`: `GET /books/search` is a stub. It ignores `q` and returns a "coming soon" message.
- `src/models/book.ts:22-28`: `searchBooks(query: string)` runs `title LIKE ? OR author LIKE ? ORDER BY title`, parameterised. It does not trim, does not escape `%` or `_`, and has no length check. Nothing calls it.
- `src/routes/api.ts:10-13`: `GET /api/books` returns `getAllBooks()` and ignores `q`.
- `src/views/error.ejs`: a full-page error view (includes header and footer). It must NOT be used for search errors (see Chosen approach).
- `tests/models/book.test.ts:61`: `// TODO: Add tests for searchBooks`. `tests/routes/api.test.ts` covers the API. There is no HTML route test file.
- `req.query.q` can be a string, an array (`?q=a&q=b`) or an object (`?q[x]=1`). The stub casts it to `string` without checking.

## Chosen approach
Validate in one shared model function. Escape wildcards in the model. Keep error output as a plain fragment.

1. **Shared validation, in `src/models/book.ts`.** Add and export `parseSearchQuery(raw: unknown)`. It returns `{ ok: true; query: string } | { ok: false; error: string }`.
   - `undefined` becomes `''`.
   - A string is trimmed.
   - An array, object, or any non-string is an error: `"Search query must be a single value"`.
   - A trimmed string that still contains a control character (U+0000 to U+001F, or U+007F) is an error: `"Search query contains invalid characters"`. SQLite cuts a pattern at a null byte, so `q=%00` would otherwise match every book.
   - A trimmed string longer than 100 characters is an error: `"Search query must be 100 characters or fewer"`.
   - Order of checks: type, then trim, then control characters, then length. The first failing check decides the message.
   - Both routes call it, so the rules live in one place.
2. **Escaping, in the model.** `searchBooks(query: string)` escapes `\`, `%` and `_` in the query (escape `\` first). It then uses `... LIKE ? ESCAPE '\'` on both title and author, with the escaped value wrapped in `%...%`.
   - An empty query returns all books.
   - Order is `ORDER BY title`.
   - SQL stays parameterised. The function trims its own input too, so it is safe when called directly.
   - It enforces the same rules itself, so it is safe when called directly, and runs no query when one fails: a trimmed query containing a control character throws `new Error('Search query contains invalid characters')`; a trimmed query longer than 100 characters throws `new Error('Search query must be 100 characters or fewer')`. Same order as `parseSearchQuery`.
   - Case-insensitive matching must work for non-ASCII letters too (SQLite `LIKE` only folds ASCII). Fold both sides with JavaScript `toLowerCase()`, for example by registering a SQL function with sql.js `create_function` when the database is opened in `src/db/index.ts`, or by an equivalent approach inside the data layer. No new dependency, no schema change, and the query stays parameterised.
3. **JSON API.** `GET /api/books` reads `q`. If `q` is invalid, return `400 { error }`. Otherwise return a JSON array of books, the same shape as today. No `q`, or an empty or whitespace-only `q`, returns all 50 books ordered by title, exactly as today.
   - `GET /api/books/search?q=` is an alias with exactly the same behaviour (same handler). It must be registered before `GET /api/books/:id`, or Express sends `search` to the `:id` handler.
4. **HTML route.** `GET /books/search` runs the same validation.
   - Invalid: status `400`, body is a layout-free fragment `<p class="error">MESSAGE</p>` with the message HTML-escaped. Do NOT render `error.ejs`. It is a full page, and HTMX would either skip the swap or nest a whole page inside `#search-results`.
   - Valid with results: a layout-free fragment containing `<div class="book-grid">` with the same card markup as the home page. Reuse that markup (for example a shared partial) so the two do not drift.
   - Valid with no results: a layout-free fragment with a `No books found` message and no empty grid. Wrap it in `<div class="search-message">`.
   - All book text is escaped on output.
5. **Tests (Vitest).** Cover each criterion, including the edge cases listed below.

## Acceptance criteria
1. Matching works on title and on author, ignores case, and accepts part of a word. These terms come from `src/db/seed.sql`:
   - `searchBooks('hobbit')` and `searchBooks('HOBBIT')` both return exactly *The Hobbit* (a title match).
   - `searchBooks('tolk')` returns exactly *The Hobbit* and *The Lord of the Rings*, ordered by title (a partial author match on "J.R.R. Tolkien").
   - `searchBooks('MIÉVILLE')` and `searchBooks('miéville')` both return exactly *The City & the City* (non-ASCII case folding on "China Miéville").
2. An empty query, a missing query, and a whitespace-only query (`'   '`) all return all books, ordered by title. `GET /api/books` with no `q` returns 50 books.
3. Input is trimmed: `'  hobbit  '` matches the same books as `'hobbit'`.
4. A trimmed query of exactly 100 characters is accepted. A trimmed query of 101 characters returns `400` with `{ "error": "Search query must be 100 characters or fewer" }` on the API. A query of 101 characters that becomes 100 after trimming whitespace is accepted.
5. A repeated parameter (`?q=a&q=b`) and an object parameter (`?q[x]=1`) return `400` with `{ "error": "Search query must be a single value" }` on the API. They never cause a 500 or a crash.
6. `%` and `_` are literal. `searchBooks('%')` and `searchBooks('_')` return only books whose title or author contains that literal character (no seeded title or author does), not all books. `\` is also treated as a literal.
7. SQL is parameterised. The query string contains only `?` placeholders. Inputs such as `' OR 1=1 --` return no books and do not alter results or error.
8. `GET /books/search?q=<term>` returns `200` with an HTML fragment (no `<html>`, no nav) containing `class="book-grid"` and the matching books only.
9. `GET /books/search` with no matches returns `200` with `No books found` and no `book-grid`.
10. `GET /books/search` with an invalid query (too long, repeated, object, control characters) returns `400` and a body containing `<p class="error">`, with no `<html>` in it.
11. A `q` of `<script>alert(1)</script>` never appears unescaped in any HTML response, including the error fragment and the no-results message.
12. `GET /api/books?q=<term>` returns a JSON array of matching books. Each item has the same fields as today (`id`, `title`, `author`, `isbn`, `cover_url`, `description`, `published_year`, `created_at`).
13. Called directly, `searchBooks` with a trimmed query of 101 characters throws an `Error` with the message `Search query must be 100 characters or fewer`. With exactly 100 characters it returns normally. `searchBooks('a\u0000b')` throws an `Error` with the message `Search query contains invalid characters`.
14. `GET /api/books/search?q=<term>` behaves exactly like `GET /api/books?q=<term>`: same status codes, same bodies, same errors, for every case in criteria 1 to 7 and 12. `GET /api/books/1` still returns book 1.
15. No input ever causes a 500 or a crash, on `GET /api/books`, `GET /api/books/search` or `GET /books/search`:
   - A `q` of 10,000 characters returns `400` with the length message.
   - Digits are an ordinary search: `q=1984` returns exactly *1984*.
   - A control character left after trimming, including a null byte (`q=%00`) or a tab inside the text (`q=a%09b`), returns `400` with `{ "error": "Search query contains invalid characters" }` on the API and a `<p class="error">` fragment on the HTML route.
   - An empty value (`?q=`) returns all books, like a missing `q`.
16. Existing tests keep passing. New Vitest tests cover each criterion above, for the model, the API routes and the HTML route. `npm run build && npm run test:run` passes.

## Constraints
- Follow `CLAUDE.md` in full.
- No schema changes. No new dependencies.
- Never touch `bookshelf.db`, `src/db/seed.sql` or `.env`. Never edit `dist/`.
- Keep the interface exactly as written above: paths, status codes, error messages, function names.
- ESM only: relative imports end in `.js`. TypeScript strict, no `any`.
- Data access stays in `src/models/`. Routes never run SQL.
- Do not create `bookshelf.db-*` files in the repo root. Tests use the temp DB paths already set in `tests/`.
- Use `npm run test:run`, never bare `npm test`.

## Out of scope
- Filtering by year or rating, sorting options, pagination (that is `docs/task.md`, a separate task).
- Searching description or ISBN. For example, the word "hobbit" also appears in the description of *The Hobbit*, but only the title match counts.
- Changing the home page layout or the HTMX debounce.
- Reusing `error.ejs` for search errors.
- Accent-insensitive matching (`miville` does not need to match "Miéville"). Only case is folded.

## Assumptions and open questions
- ASSUMPTION: the ticket's `[100]` is confirmed. Over 100 after trimming is an error, and exactly 100 is allowed. Confirmed by the user.
- ASSUMPTION: length is measured with JavaScript string length (UTF-16 code units), not bytes or grapheme clusters.
- ASSUMPTION: the ticket's interface placeholder (`[endpoint and response shape]`) is filled in by this spec: `searchBooks(query)`, `GET /api/books?q=` (with the alias `GET /api/books/search?q=`) and `GET /books/search?q=`. The alias exists because the ticket does not name the endpoint and both paths are plausible.
- DECISION: case-insensitive means for all letters, not only ASCII. SQLite `LIKE` alone is not enough (criterion 1, `MIÉVILLE`).
- ASSUMPTION: the exact error messages and the `No books found` wording are not in the ticket. The wording in this spec is the contract and tests should use it.
- VERIFIED: `title` and `author` are `TEXT NOT NULL` in `src/db/schema.sql`, so matching on them is safe.
- KNOWN LIMITATION: HTMX ignores 4xx responses by default. A 400 from `/books/search` returns the correct status and body, but the user may see no change in the search box. Fixing the display (for example an HTMX `beforeSwap` setting) is out of scope for this ticket. The user to decide later.
- OPEN: should the length check happen client-side too, for example `maxlength` on the input? Not required here.
