// SessionStart: snapshot protected files outside the repo.
// PostToolUse: re-hash them; restore anything that changed, appeared or vanished, then exit 2.
// SELF-CONTAINED ON PURPOSE: this file imports nothing from the hooks directory, because it
// verifies that directory and must not execute a tampered helper before doing so.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DATA_FILES = ['bookshelf.db', 'bookshelf.db-shm', 'bookshelf.db-wal', 'src/db/seed.sql', '.env'];
const GUARD_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const HOOKS_DIR = 'ticket-to-merge/hooks';
const TRACKED_DATA = new Set(['src/db/seed.sql', 'bookshelf.db-shm', 'bookshelf.db-wal']);

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function listTree(abs, rel, out) {
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) listTree(path.join(abs, e.name), r, out);
    else out.push(r);
  }
}

function currentFiles(root) {
  const found = new Set();
  for (const name of fs.readdirSync(root)) {
    if ((name === 'bookshelf.db' || name.startsWith('bookshelf.db-') || name === '.env' || name.startsWith('.env.')) && fs.lstatSync(path.join(root, name)).isFile()) found.add(name);
  }
  const extra = [];
  listTree(path.join(root, HOOKS_DIR), HOOKS_DIR, extra);
  for (const rel of ['src/db/seed.sql', ...GUARD_FILES, ...extra]) {
    try {
      const isData = !isGuard(rel);
      if (!isData || fs.lstatSync(path.join(root, rel)).isFile()) { fs.lstatSync(path.join(root, rel)); found.add(rel); }
    } catch { /* absent */ }
  }
  return [...found];
}

function isGuard(rel) { return rel.startsWith(`${HOOKS_DIR}/`) || GUARD_FILES.includes(rel); }

function isTracked(root, rel) {
  try { execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, stdio: 'pipe' }); return true; } catch { return false; }
}

function takeSnapshot(root, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
  const files = {};
  for (const rel of currentFiles(root)) {
    const src = path.join(root, rel);
    if (!fs.lstatSync(src).isFile()) continue;
    const dest = path.join(dir, 'files', rel.replace(/\//g, '__'));
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o600);
    files[rel] = { sha256: sha256File(src), copy: path.basename(dest) };
  }
  const missing = [...DATA_FILES, ...GUARD_FILES].filter((f) => !(f in files));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ created: new Date().toISOString(), root, files, missing }, null, 2), { mode: 0o600 });
}

function restoreOne(root, dir, rel, entry) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  const fromGit = () => fs.writeFileSync(target, execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }));
  const fromSnapshot = () => fs.copyFileSync(path.join(dir, 'files', entry.copy), target);
  const gitFirst = isGuard(rel) && isTracked(root, rel);
  const order = gitFirst ? [fromGit, fromSnapshot] : [fromSnapshot, ...(TRACKED_DATA.has(rel) ? [fromGit] : [])];
  let lastErr;
  for (const attempt of order) {
    try { attempt(); return; } catch (e) { lastErr = e; }
  }
  throw new Error(`cannot restore ${rel}: ${lastErr?.message}`);
}

function check(root, dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const messages = [];
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const target = path.join(root, rel);
    let state = 'ok';
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile() || sha256File(target) !== entry.sha256) state = 'modified';
    } catch {
      state = 'deleted';
    }
    if (state !== 'ok') {
      restoreOne(root, dir, rel, entry);
      messages.push(`${rel} was ${state} and has been restored`);
    }
  }
  for (const rel of currentFiles(root)) {
    if (!(rel in manifest.files)) {
      fs.rmSync(path.join(root, rel), { force: true, recursive: true });
      messages.push(`${rel} did not exist at session start and has been deleted`);
    }
  }
  return messages;
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const raw = process.env.CLAUDE_PROJECT_DIR || input?.cwd;
  if (!raw) throw new Error('no project root: CLAUDE_PROJECT_DIR unset and no cwd in input');
  const root = fs.realpathSync(raw);
  const h = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  const dir = path.join(process.env.TMPDIR || '/tmp', 'ticket-to-merge', h);
  const manifestPath = path.join(dir, 'manifest.json');
  if (input.hook_event_name === 'SessionStart' || !fs.existsSync(manifestPath)) {
    takeSnapshot(root, dir);
    process.exit(0);
  }
  const messages = check(root, dir);
  if (messages.length) {
    process.stderr.write(`INTEGRITY VIOLATION (ticket-to-merge): ${messages.join('; ')}. Protected files must not change; undo your approach and use Vitest tests/src changes instead.\n`);
    process.exit(2);
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`INTEGRITY CHECK FAILED (fail closed): ${e?.message ?? e}\n`);
  process.exit(2);
}
