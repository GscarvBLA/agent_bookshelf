# Ledger: combined

Labels: TP:<bug> | duplicate:<bug> | needs-judgement. Edit the Label column by hand, then recompute precision (see README).

| Run | Location | Severity | Issue | Label |
|---|---|---|---|---|
| 1 | src/models/book.ts:45 | critical | The search text is interpolated into the SQL string instead of being passed as a ? placeholder, which allows SQL injection. A query containing ' returns a 500. | TP:B3 |
| 1 | src/views/partials/book-grid.ejs:4 | critical | The book title is rendered unescaped with <%- %>, which allows XSS. | TP:B4 |
| 1 | src/models/book.ts:33 | major | The length check uses >=, so a trimmed query of exactly 100 characters is rejected. The spec says 100 is accepted. | TP:B1 |
| 1 | src/models/book.ts:45 | major | Search matches only title, not author. | TP:B2 |
| 1 | tests/routes/api.test.ts:25 | major | The pre-existing assertion `toHaveLength(50)` in 'returns all books' was loosened to `length > 0`. | TP:B5 |
| 1 | tests/routes/books.test.ts:19 | major | AC8 has no test for the positive HTML search fragment (class="book-grid" containing only the matching books). | needs-judgement |
| 2 | src/models/book.ts:45 | critical | The search pattern is interpolated into the SQL string instead of bound with a `?` placeholder, so a single quote in `q` changes the query or causes a 500. | TP:B3 |
| 2 | src/views/partials/book-grid.ejs:4 | critical | The book title is output unescaped with `<%- book.title %>`. | TP:B4 |
| 2 | tests/routes/api.test.ts:25 | critical | A pre-existing assertion was weakened: `toHaveLength(50)` was replaced with `length > 0` in 'returns all books'. | TP:B5 |
| 2 | src/models/book.ts:33 | major | The length check uses `>=`, so a trimmed query of exactly 100 characters is rejected, but AC4 and AC13 accept it. | TP:B1 |
| 2 | src/models/book.ts:45 | major | Search matches only the title. Author is never searched, so AC1 fails for `tolk` and `miéville`. | TP:B2 |
| 2 | tests/routes/books.test.ts:22 | major | No HTML route test covers AC8: a success response with a `book-grid` fragment, matching books only, and no `<html>`. | needs-judgement |
| 3 | src/models/book.ts:45 | critical | The search pattern is interpolated into the SQL string inside single quotes, so a quote in `q` breaks the query (SQL injection or a 500). It is not parameterised. | TP:B3 |
| 3 | src/views/partials/book-grid.ejs:4 | critical | The book title is rendered with unescaped `<%- book.title %>`, which allows stored XSS. | TP:B4 |
| 3 | tests/routes/api.test.ts:25 | critical | The existing assertion `toHaveLength(50)` for `GET /api/books` was weakened to `length > 0`. | TP:B5 |
| 3 | src/models/book.ts:45 | major | `searchBooks` matches the title only, not the author, so criterion 1 is not met. | TP:B2 |
| 3 | src/models/book.ts:33 | major | The length check uses `>=`, so a trimmed query of exactly 100 characters is wrongly rejected. | TP:B1 |
| 3 | tests/routes/books.test.ts:33 | major | No test checks criterion 8 for a successful HTML search: a book-grid fragment with no `<html>` or nav. | needs-judgement |
