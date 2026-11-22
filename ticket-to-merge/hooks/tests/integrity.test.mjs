import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, run, INTEGRITY } from './helpers.mjs';

let proj;
beforeEach(() => { proj = makeProject(); });
afterEach(() => proj.cleanup());

const start = () => run(INTEGRITY, proj, { hook_event_name: 'SessionStart', source: 'startup' });
const post = (tool_name = 'Bash') => run(INTEGRITY, proj, { hook_event_name: 'PostToolUse', tool_name, tool_input: {} });

describe('integrity.mjs', () => {
  test('SessionStart snapshots outside the repo and exits 0', () => {
    const r = start();
    assert.equal(r.code, 0, r.stderr);
    const base = path.join(proj.tmp, 'ticket-to-merge');
    const [dir] = fs.readdirSync(base);
    assert.match(dir, /^[0-9a-f]{16}$/);
    const manifest = JSON.parse(fs.readFileSync(path.join(base, dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.files).filter((f) => !f.startsWith('ticket-to-merge/') && !f.startsWith('.claude/')).sort(), ['.env', 'bookshelf.db', 'bookshelf.db-shm', 'bookshelf.db-wal', 'src/db/seed.sql']);
    assert.match(manifest.files['.env'].sha256, /^[0-9a-f]{64}$/);
  });

  test('no change -> exit 0', () => {
    start();
    const r = post();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
  });

  test('modified seed.sql is restored, exit 2, file named', () => {
    start();
    const original = proj.read('src/db/seed.sql');
    proj.w('src/db/seed.sql', 'DROP TABLE books;');
    const r = post();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /src\/db\/seed\.sql.*restored/);
    assert.equal(proj.read('src/db/seed.sql'), original);
    assert.equal(post().code, 0);
  });

  test('deleted seed.sql is restored', () => {
    start();
    const original = proj.read('src/db/seed.sql');
    fs.rmSync(path.join(proj.root, 'src/db/seed.sql'));
    assert.equal(post('Edit').code, 2);
    assert.equal(proj.read('src/db/seed.sql'), original);
  });

  test('modified untracked .env is restored from the snapshot', () => {
    start();
    proj.w('.env', 'SECRET=leaked');
    const r = post();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\.env.*restored/);
    assert.equal(proj.read('.env'), 'SECRET=1\n');
  });

  test('modified untracked bookshelf.db is restored', () => {
    start();
    proj.w('bookshelf.db', 'tampered');
    assert.equal(post().code, 2);
    assert.equal(proj.read('bookshelf.db'), 'db-content');
  });

  test('modified tracked bookshelf.db-wal is restored', () => {
    start();
    proj.w('bookshelf.db-wal', 'tampered');
    assert.equal(post('Write').code, 2);
    assert.equal(proj.read('bookshelf.db-wal'), 'wal-content');
  });

  test('newly created .env.local (absent at snapshot) is deleted', () => {
    start();
    proj.w('.env.local', 'NEW=1');
    const r = post();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\.env\.local.*deleted/);
    assert.equal(fs.existsSync(path.join(proj.root, '.env.local')), false);
  });

  test('a file missing at snapshot time (.env) and created later is deleted', () => {
    fs.rmSync(path.join(proj.root, '.env'));
    start();
    proj.w('.env', 'NEW=1');
    assert.equal(post().code, 2);
    assert.equal(fs.existsSync(path.join(proj.root, '.env')), false);
  });

  test('no snapshot yet: first PostToolUse creates it and exits 0, later change is caught', () => {
    assert.equal(post().code, 0);
    proj.w('src/db/seed.sql', 'x');
    assert.equal(post().code, 2);
  });

  test('modified tracked hooks.json is restored from git HEAD', () => {
    start();
    proj.w('ticket-to-merge/hooks/hooks.json', '{"hooks":{"PreToolUse":[]}}');
    const r = post();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /ticket-to-merge\/hooks\/hooks\.json.*restored/);
    assert.equal(proj.read('ticket-to-merge/hooks/hooks.json'), '{"hooks":{}}\n');
  });

  test('modified .claude/settings.json is restored', () => {
    start();
    proj.w('.claude/settings.json', '{}');
    const r = post('Write');
    assert.equal(r.code, 2);
    assert.match(r.stderr, /\.claude\/settings\.json.*restored/);
    assert.equal(proj.read('.claude/settings.json'), '{"permissions":{}}\n');
  });

  test('deleted protect.mjs is restored', () => {
    start();
    fs.rmSync(path.join(proj.root, 'ticket-to-merge/hooks/protect.mjs'));
    const r = post();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /protect\.mjs.*restored/);
    assert.equal(proj.read('ticket-to-merge/hooks/protect.mjs'), '// protect\n');
  });

  test('new .claude/settings.local.json (absent at snapshot) is deleted', () => {
    start();
    proj.w('.claude/settings.local.json', '{"permissions":{"allow":["Bash"]}}');
    const r = post();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /settings\.local\.json.*deleted/);
    assert.equal(fs.existsSync(path.join(proj.root, '.claude/settings.local.json')), false);
  });

  test('new file added inside the hooks dir is deleted', () => {
    start();
    proj.w('ticket-to-merge/hooks/evil.mjs', 'x');
    assert.equal(post().code, 2);
    assert.equal(fs.existsSync(path.join(proj.root, 'ticket-to-merge/hooks/evil.mjs')), false);
  });

  test('integrity.mjs imports nothing from the hooks directory', () => {
    const src = fs.readFileSync(INTEGRITY, 'utf8');
    assert.equal(/from '\.{1,2}\//.test(src), false);
  });

  test('malformed JSON fails closed', () => {
    assert.equal(run(INTEGRITY, proj, null, { raw: 'nope' }).code, 2);
  });

  test('ordinary source edits are not touched', () => {
    start();
    proj.w('src/models/book.ts', 'export const x = 1;\n');
    assert.equal(post('Edit').code, 0);
    assert.equal(proj.read('src/models/book.ts'), 'export const x = 1;\n');
  });
});
