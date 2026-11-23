import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import app from '../../src/server.js';
import { initDb, closeDb } from '../../src/db/index.js';

const DB = '/tmp/test-books-html.db';

beforeEach(async () => {
  await initDb(DB);
});

afterEach(() => {
  closeDb();
  try {
    fs.unlinkSync(DB);
  } catch (e) {
    // ignore
  }
});

const XSS = '<script>alert(1)</script>';

describe('HTML search route GET /books/search', () => {
  it('AC8: returns a layout-free fragment with only the matching books', async () => {
    const res = await request(app).get('/books/search').query({ q: 'tolk' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="book-grid"');
    expect(res.text).not.toContain('<html');
    expect(res.text).not.toContain('<nav');
    expect(res.text).toContain('The Hobbit');
    expect(res.text).toContain('The Lord of the Rings');
    expect(res.text).not.toContain('Dune');
    expect(res.text.match(/class="book-card"/g)).toHaveLength(2);
  });

  it('AC8: matching ignores case', async () => {
    const res = await request(app).get('/books/search').query({ q: 'MIÉVILLE' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('The City &amp; the City');
    expect(res.text.match(/class="book-card"/g)).toHaveLength(1);
  });

  it('AC9: no matches returns 200 with a message and no grid', async () => {
    const res = await request(app).get('/books/search').query({ q: 'zzzz' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('No books found');
    expect(res.text).toContain('class="search-message"');
    expect(res.text).not.toContain('book-grid');
    expect(res.text).not.toContain('<html');
  });

  it('AC2: missing, empty and blank q return all books', async () => {
    for (const url of ['/books/search', '/books/search?q=', '/books/search?q=%20%20']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.text.match(/class="book-card"/g)).toHaveLength(50);
    }
  });

  it('AC6/AC7: wildcards and injection return no books', async () => {
    for (const q of ['%', '_', '\\', "' OR 1=1 --"]) {
      const res = await request(app).get('/books/search').query({ q });
      expect(res.status).toBe(200);
      expect(res.text).toContain('No books found');
    }
  });

  describe('AC10: invalid queries return 400 with an error fragment', () => {
    const cases: Array<[string, string, string]> = [
      ['too long', '/books/search?q=' + 'a'.repeat(101), 'Search query must be 100 characters or fewer'],
      ['repeated', '/books/search?q=a&q=b', 'Search query must be a single value'],
      ['object', '/books/search?q%5Bx%5D=1', 'Search query must be a single value'],
      ['null byte', '/books/search?q=%00', 'Search query contains invalid characters'],
      ['inner tab', '/books/search?q=a%09b', 'Search query contains invalid characters']
    ];

    it.each(cases)('AC10/AC15: %s', async (_name, url, message) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(400);
      expect(res.text).toContain('<p class="error">');
      expect(res.text).toContain(message);
      expect(res.text).not.toContain('<html');
    });
  });

  it('AC15: 10,000 characters returns 400 with the length message', async () => {
    const res = await request(app).get('/books/search').query({ q: 'a'.repeat(10000) });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Search query must be 100 characters or fewer');
  });

  it('AC15: digits are an ordinary search', async () => {
    const res = await request(app).get('/books/search').query({ q: '1984' });
    expect(res.status).toBe(200);
    expect(res.text.match(/class="book-card"/g)).toHaveLength(1);
  });

  it('AC4: accepts 100 characters', async () => {
    const res = await request(app).get('/books/search').query({ q: 'a'.repeat(100) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('No books found');
  });

  it('AC11: a script tag in q is escaped in the no-results message', async () => {
    const res = await request(app).get('/books/search').query({ q: XSS });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(XSS);
    expect(res.text).not.toContain('<script>');
  });

  it('AC11: a script tag in q is escaped in the error fragment', async () => {
    const res = await request(app).get('/books/search').query({ q: XSS + 'a\tb' });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(XSS);
    expect(res.text).not.toContain('<script>');
  });

  it('AC11: book text containing a script tag is escaped in results', async () => {
    const { createBook } = await import('../../src/models/book.js');
    createBook({ title: XSS, author: 'Evil', isbn: null, cover_url: null, description: XSS, published_year: 2000 });
    const res = await request(app).get('/books/search').query({ q: 'evil' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="book-grid"');
    expect(res.text).not.toContain(XSS);
    expect(res.text).toContain('&lt;script&gt;');
  });
});
