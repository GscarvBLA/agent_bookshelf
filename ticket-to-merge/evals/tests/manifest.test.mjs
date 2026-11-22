import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest } from '../run.mjs';

test('loadManifest reads an external dir: patch paths, clean array, missing concern', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evals-manifest-'));
  try {
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'cases', 'X1.patch'), 'diff --git a/a b/a\n');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      cases: [
        { id: 'X1', kind: 'bug', patch: 'cases/X1.patch', includes: ['X0'],
          expected: [{ bug: 'X1', file: 'src/a.ts', lines: [1, 2], anchor: 'a', keywords: ['k'] }],
          clean: [{ id: 'C1', file: 'src/b.ts', description: 'looks odd but fine' }] },
        { id: 'X2', kind: 'clean', patch: 'cases/X2.patch' },
      ],
    }));
    const m = loadManifest(dir);
    const [x1, x2] = m.cases;
    assert.equal(x1.patchPath, join(dir, 'cases', 'X1.patch'));
    assert.equal(x1.concern, undefined);
    assert.deepEqual(x1.includes, ['X0']);
    assert.deepEqual(x1.clean, [{ id: 'C1', file: 'src/b.ts', description: 'looks odd but fine' }]);
    assert.equal(x1.expected.length, 1);
    assert.deepEqual(x2.clean, []);
    assert.deepEqual(x2.expected, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadManifest works on the built-in set (concern present, no clean arrays)', async () => {
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const m = loadManifest(join(dirname(fileURLToPath(import.meta.url)), '..'));
  assert.ok(m.cases.find((c) => c.id === 'B1').concern);
  assert.deepEqual(m.cases.find((c) => c.id === 'B1').clean, []);
});
