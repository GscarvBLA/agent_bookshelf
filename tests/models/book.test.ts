import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb } from '../../src/db/index.js';
import * as Book from '../../src/models/book.js';

beforeEach(async () => {
  await initDb('/tmp/test-book-model.db');
});

afterEach(() => {
  closeDb();
  const fs = require('fs');
  try {
    fs.unlinkSync('/tmp/test-book-model.db');
  } catch (e) {
    // ignore
  }
});

describe('Book Model', () => {
  describe('getAllBooks', () => {
    it('returns all books ordered by title', () => {
      const books = Book.getAllBooks();
      expect(books).toHaveLength(50);
      expect(books[0].title).toBe('1984');
    });
  });

  describe('getBookById', () => {
    it('returns a book by id', () => {
      const book = Book.getBookById(1);
      expect(book).toBeDefined();
      expect(book?.title).toBe('The Pragmatic Programmer');
      expect(book?.author).toBe('Andrew Hunt and David Thomas');
    });

    it('returns undefined for non-existent id', () => {
      const book = Book.getBookById(999);
      expect(book).toBeUndefined();
    });
  });

  describe('createBook', () => {
    it('creates a new book', () => {
      const book = Book.createBook({
        title: 'Test Book',
        author: 'Test Author',
        isbn: '978-1234567890',
        cover_url: null,
        description: 'A test book',
        published_year: 2024
      });

      expect(book.id).toBeDefined();
      expect(book.title).toBe('Test Book');
      expect(book.author).toBe('Test Author');
    });
  });

  describe('searchBooks', () => {
    const titles = (q: string): string[] => Book.searchBooks(q).map((b) => b.title);

    it('AC1: matches a title ignoring case', () => {
      expect(titles('hobbit')).toEqual(['The Hobbit']);
      expect(titles('HOBBIT')).toEqual(['The Hobbit']);
    });

    it('AC1: matches part of an author, ordered by title', () => {
      expect(titles('tolk')).toEqual(['The Hobbit', 'The Lord of the Rings']);
    });

    it('AC1: folds case for non-ASCII letters', () => {
      expect(titles('MIÉVILLE')).toEqual(['The City & the City']);
      expect(titles('miéville')).toEqual(['The City & the City']);
    });

    it('AC2: empty and whitespace-only queries return all books ordered by title', () => {
      for (const q of ['', '   ']) {
        const books = Book.searchBooks(q);
        expect(books).toHaveLength(50);
        expect(books[0].title).toBe('1984');
        const sorted = books.map((b) => b.title);
        expect(sorted).toEqual(Book.getAllBooks().map((b) => b.title));
      }
    });

    it('AC3: trims the query', () => {
      expect(titles('  hobbit  ')).toEqual(titles('hobbit'));
      expect(titles('  hobbit  ')).toEqual(['The Hobbit']);
    });

    it('AC4: accepts exactly 100 characters and a 101-character query that trims to 100', () => {
      const hundred = 'a'.repeat(100);
      expect(Book.searchBooks(hundred)).toEqual([]);
      expect(Book.searchBooks(' ' + hundred + ' ')).toEqual([]);
    });

    it('AC6: treats % as a literal', () => {
      expect(Book.searchBooks('%')).toEqual([]);
    });

    it('AC6: treats _ as a literal', () => {
      expect(Book.searchBooks('_')).toEqual([]);
    });

    it('AC6: treats backslash as a literal', () => {
      expect(Book.searchBooks('\\')).toEqual([]);
    });

    it('AC6: wildcards do not act as wildcards inside a term', () => {
      expect(Book.searchBooks('h%bbit')).toEqual([]);
      expect(Book.searchBooks('h_bbit')).toEqual([]);
    });

    it('AC6: literal wildcard characters match books that contain them', () => {
      const a = Book.createBook({ title: '100% Pure_Fun', author: 'X', isbn: null, cover_url: null, description: null, published_year: null });
      expect(Book.searchBooks('%').map((b) => b.id)).toEqual([a.id]);
      expect(Book.searchBooks('_').map((b) => b.id)).toEqual([a.id]);
      expect(Book.searchBooks('0% p').map((b) => b.id)).toEqual([a.id]);
    });

    it("AC7: SQL injection input returns no books and does not error", () => {
      expect(Book.searchBooks("' OR 1=1 --")).toEqual([]);
      expect(Book.searchBooks("'; DROP TABLE books; --")).toEqual([]);
      expect(Book.getAllBooks()).toHaveLength(50);
    });

    it('AC13: throws for a trimmed query of 101 characters', () => {
      expect(() => Book.searchBooks('a'.repeat(101))).toThrow(
        new Error('Search query must be 100 characters or fewer')
      );
    });

    it('AC13: returns normally for exactly 100 characters', () => {
      expect(() => Book.searchBooks('a'.repeat(100))).not.toThrow();
    });

    it('AC13: throws for a control character', () => {
      expect(() => Book.searchBooks('a\u0000b')).toThrow(
        new Error('Search query contains invalid characters')
      );
    });

    it('AC15: throws the control-character error before the length error', () => {
      expect(() => Book.searchBooks('\u0007' + 'a'.repeat(200))).toThrow(
        new Error('Search query contains invalid characters')
      );
    });

    it('AC15: digits are an ordinary search', () => {
      expect(titles('1984')).toEqual(['1984']);
    });

    it('AC15: rejects a tab and DEL inside the text', () => {
      expect(() => Book.searchBooks('a\tb')).toThrow('Search query contains invalid characters');
      expect(() => Book.searchBooks('a\u007Fb')).toThrow('Search query contains invalid characters');
    });
  });

  describe('parseSearchQuery', () => {
    it('AC2: undefined becomes an empty query', () => {
      expect(Book.parseSearchQuery(undefined)).toEqual({ ok: true, query: '' });
    });

    it('AC3: trims strings', () => {
      expect(Book.parseSearchQuery('  hobbit  ')).toEqual({ ok: true, query: 'hobbit' });
    });

    it('AC4: enforces the 100 character limit after trimming', () => {
      expect(Book.parseSearchQuery('a'.repeat(100))).toEqual({ ok: true, query: 'a'.repeat(100) });
      expect(Book.parseSearchQuery(' ' + 'a'.repeat(100) + ' ')).toEqual({ ok: true, query: 'a'.repeat(100) });
      expect(Book.parseSearchQuery('a'.repeat(101))).toEqual({
        ok: false,
        error: 'Search query must be 100 characters or fewer'
      });
    });

    it('AC5: rejects arrays, objects and other non-strings', () => {
      const error = 'Search query must be a single value';
      expect(Book.parseSearchQuery(['a', 'b'])).toEqual({ ok: false, error });
      expect(Book.parseSearchQuery({ x: '1' })).toEqual({ ok: false, error });
      expect(Book.parseSearchQuery(5)).toEqual({ ok: false, error });
    });

    it('AC15: rejects control characters, which win over the length check', () => {
      const error = 'Search query contains invalid characters';
      expect(Book.parseSearchQuery('a\u0000b')).toEqual({ ok: false, error });
      expect(Book.parseSearchQuery('a\tb')).toEqual({ ok: false, error });
      expect(Book.parseSearchQuery('a\u007Fb')).toEqual({ ok: false, error });
      expect(Book.parseSearchQuery('\u0001' + 'a'.repeat(200))).toEqual({ ok: false, error });
    });

    it('AC15: an empty string is valid', () => {
      expect(Book.parseSearchQuery('')).toEqual({ ok: true, query: '' });
    });
  });

  // TODO: Add tests for updateBook
  // TODO: Add tests for deleteBook
  // TODO: Add edge cases (duplicate ISBN, missing required fields, etc.)
});
