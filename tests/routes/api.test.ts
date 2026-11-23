import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../src/server.js';
import { initDb, closeDb } from '../../src/db/index.js';

beforeEach(async () => {
  await initDb('/tmp/test-api.db');
});

afterEach(() => {
  closeDb();
  const fs = require('fs');
  try {
    fs.unlinkSync('/tmp/test-api.db');
  } catch (e) {
    // ignore
  }
});

describe('API Routes', () => {
  describe('GET /api/books', () => {
    it('returns all books', async () => {
      const res = await request(app).get('/api/books');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(50);
      expect(res.body[0]).toHaveProperty('title');
      expect(res.body[0]).toHaveProperty('author');
    });
  });

  describe.each(['/api/books', '/api/books/search'])('search on GET %s', (path) => {
    const titlesOf = (body: Array<{ title: string }>): string[] => body.map((b) => b.title);

    it('AC1/AC14: matches title, author, case and non-ASCII', async () => {
      const hobbit = await request(app).get(path).query({ q: 'HOBBIT' });
      expect(hobbit.status).toBe(200);
      expect(titlesOf(hobbit.body)).toEqual(['The Hobbit']);

      const tolk = await request(app).get(path).query({ q: 'tolk' });
      expect(titlesOf(tolk.body)).toEqual(['The Hobbit', 'The Lord of the Rings']);

      const mie = await request(app).get(path).query({ q: 'MIÉVILLE' });
      expect(mie.status).toBe(200);
      expect(titlesOf(mie.body)).toEqual(['The City & the City']);
    });

    it('AC2/AC14/AC15: missing, empty and whitespace-only q return all 50 books', async () => {
      const none = await request(app).get(path);
      expect(none.status).toBe(200);
      expect(none.body).toHaveLength(50);
      expect(none.body[0].title).toBe('1984');

      const empty = await request(app).get(`${path}?q=`);
      expect(empty.status).toBe(200);
      expect(empty.body).toHaveLength(50);

      const blank = await request(app).get(`${path}?q=%20%20`);
      expect(blank.status).toBe(200);
      expect(blank.body).toHaveLength(50);
    });

    it('AC3/AC14: trims q', async () => {
      const res = await request(app).get(path).query({ q: '  hobbit  ' });
      expect(titlesOf(res.body)).toEqual(['The Hobbit']);
    });

    it('AC4/AC14: accepts 100 characters, rejects 101 with 400', async () => {
      const ok = await request(app).get(path).query({ q: 'a'.repeat(100) });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual([]);

      const padded = await request(app).get(path).query({ q: ' ' + 'a'.repeat(100) + ' ' });
      expect(padded.status).toBe(200);

      const bad = await request(app).get(path).query({ q: 'a'.repeat(101) });
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'Search query must be 100 characters or fewer' });
    });

    it('AC5/AC14: repeated parameter returns 400', async () => {
      const res = await request(app).get(`${path}?q=a&q=b`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Search query must be a single value' });
    });

    it('AC5/AC14: object parameter returns 400', async () => {
      const res = await request(app).get(`${path}?q%5Bx%5D=1`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Search query must be a single value' });
    });

    it('AC6/AC14: % , _ and backslash are literal', async () => {
      for (const q of ['%', '_', '\\']) {
        const res = await request(app).get(path).query({ q });
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      }
    });

    it('AC7/AC14: SQL injection input returns no books', async () => {
      const res = await request(app).get(path).query({ q: "' OR 1=1 --" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('AC12/AC14: items have the full book shape', async () => {
      const res = await request(app).get(path).query({ q: 'hobbit' });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(Object.keys(res.body[0]).sort()).toEqual(
        ['author', 'cover_url', 'created_at', 'description', 'id', 'isbn', 'published_year', 'title'].sort()
      );
    });

    it('AC15: 10,000 characters returns 400 with the length message', async () => {
      const res = await request(app).get(path).query({ q: 'a'.repeat(10000) });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Search query must be 100 characters or fewer' });
    });

    it('AC15: digits are an ordinary search', async () => {
      const res = await request(app).get(path).query({ q: '1984' });
      expect(res.status).toBe(200);
      expect(titlesOf(res.body)).toEqual(['1984']);
    });

    it('AC15: null byte and inner tab return 400', async () => {
      for (const raw of ['%00', 'a%09b']) {
        const res = await request(app).get(`${path}?q=${raw}`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Search query contains invalid characters' });
      }
    });
  });

  describe('GET /api/books/:id', () => {
    it('AC14: still returns book 1 after the search alias is added', async () => {
      const res = await request(app).get('/api/books/1');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(1);
    });

    it('returns a book by id', async () => {
      const res = await request(app).get('/api/books/1');
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('The Pragmatic Programmer');
    });

    it('returns 404 for non-existent book', async () => {
      const res = await request(app).get('/api/books/999');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/reviews', () => {
    it('creates a new review', async () => {
      const res = await request(app)
        .post('/api/reviews')
        .send({
          userId: 1,
          bookId: 5,
          rating: 5,
          reviewText: 'Amazing book!'
        });

      expect(res.status).toBe(201);
      expect(res.body.rating).toBe(5);
      expect(res.body.review_text).toBe('Amazing book!');
    });

    it('prevents duplicate reviews', async () => {
      // Alice already reviewed book 1 in seed data
      const res = await request(app)
        .post('/api/reviews')
        .send({
          userId: 1,
          bookId: 1,
          rating: 4,
          reviewText: 'Trying to review again'
        });

      expect(res.status).toBe(409);
    });

    it('validates rating range', async () => {
      const res = await request(app)
        .post('/api/reviews')
        .send({
          userId: 1,
          bookId: 5,
          rating: 6,
          reviewText: 'Invalid rating'
        });

      expect(res.status).toBe(400);
    });
  });

  // TODO: Add tests for other API endpoints
  // TODO: Add tests for error handling
  // TODO: Add tests for edge cases
});
