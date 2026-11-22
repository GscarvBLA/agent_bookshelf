import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFindings, extractFindings, labelText } from '../run.mjs';

const expected = [
  { bug: 'B1', file: 'src/models/book.ts', lines: [31, 31], keywords: ['off-by-one'] },
  { bug: 'B4', file: 'src/views/partials/book-grid.ejs', lines: [4, 4], keywords: ['xss', 'unescaped'] },
];
const f = (over) => ({ file: 'src/models/book.ts', line: 31, severity: 'high', issue: 'something', evidence: 'x', ...over });
const labels = (findings) => matchFindings(findings, expected).map(labelText);

test('exact line match is a TP', () => {
  assert.deepEqual(labels([f({ line: 31 })]), ['TP:B1']);
});

test('line within +-3 matches, +-4 does not', () => {
  assert.deepEqual(labels([f({ line: 34 })]), ['TP:B1']);
  assert.deepEqual(labels([f({ line: 28 })]), ['TP:B1']);
  assert.deepEqual(labels([f({ line: 35 })]), ['needs-judgement']);
  assert.deepEqual(labels([f({ line: 27 })]), ['needs-judgement']);
});

test('keyword match works with a far-away line, case-insensitively, in issue or evidence', () => {
  assert.deepEqual(labels([f({ line: 90, issue: 'Classic OFF-BY-ONE here' })]), ['TP:B1']);
  assert.deepEqual(labels([f({ file: 'views/x/src/views/partials/book-grid.ejs', line: 99, evidence: 'Unescaped output' })]), ['TP:B4']);
});

test('file must match by path suffix', () => {
  assert.deepEqual(labels([f({ file: 'other/book.ts', line: 31 })]), ['needs-judgement']);
  assert.deepEqual(labels([f({ file: '/repo/src/models/book.ts', line: 31 })]), ['TP:B1']);
});

test('second finding for an already matched bug is a duplicate', () => {
  assert.deepEqual(labels([f({ line: 31 }), f({ line: 32, issue: 'again' })]), ['TP:B1', 'duplicate:B1']);
});

test('unmatched finding needs judgement', () => {
  assert.deepEqual(labels([f({ line: 10, issue: 'naming' })]), ['needs-judgement']);
});

test('keyword hit outranks a line-only hit on another bug at the same location', () => {
  const exp = [
    { bug: 'B2', file: 'a.ts', lines: [5, 5], keywords: ['author'] },
    { bug: 'B3', file: 'a.ts', lines: [5, 5], keywords: ['injection'] },
  ];
  const r = matchFindings([{ file: 'a.ts', line: 5, issue: 'SQL injection', evidence: '' }], exp);
  assert.equal(labelText(r[0]), 'TP:B3');
});

test('extractFindings takes the last json block and tolerates bad input', () => {
  const text = 'summary\n```json\n[{"file":"a"}]\n```\nmore\n```json\n[{"file":"b","line":1}]\n```\n';
  assert.deepEqual(extractFindings(text).findings, [{ file: 'b', line: 1 }]);
  assert.match(extractFindings('no block').error, /no json block/);
  assert.match(extractFindings('```json\n{oops\n```').error, /parse failed/);
});
