import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROTECT = path.join(here, '..', 'protect.mjs');
export const INTEGRITY = path.join(here, '..', 'integrity.mjs');

export function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ttm-proj-')));
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ttm-tmp-')));
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  w('src/db/seed.sql', 'INSERT INTO books VALUES (1);\n');
  w('src/db/schema.sql', 'CREATE TABLE books (id INT);\n');
  w('src/models/book.ts', 'export {};\n');
  w('tests/routes/books.test.ts', '// t\n');
  w('bookshelf.db-shm', 'shm-content');
  w('bookshelf.db-wal', 'wal-content');
  w('ticket-to-merge/hooks/hooks.json', '{"hooks":{}}\n');
  w('ticket-to-merge/hooks/protect.mjs', '// protect\n');
  w('.claude/settings.json', '{"permissions":{}}\n');
  w('.gitignore', 'bookshelf.db\n.env\n.env.*\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  w('bookshelf.db', 'db-content');
  w('.env', 'SECRET=1\n');
  fs.symlinkSync(path.join(root, 'src/db/seed.sql'), path.join(root, 'link.sql'));
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const cleanup = () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); };
  return { root, tmp, w, read, cleanup };
}

export function run(script, proj, input, { raw, extraEnv } = {}) {
  const payload = raw ?? JSON.stringify({ cwd: proj.root, ...input });
  const r = spawnSync('node', [script], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj.root, TMPDIR: proj.tmp, ...extraEnv },
  });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout };
}

export const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
export const tool = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
