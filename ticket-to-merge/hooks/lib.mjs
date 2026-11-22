// Shared helpers for the ticket-to-merge guardrail hooks. Plain Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const DATA_FILES = ['bookshelf.db', 'bookshelf.db-shm', 'bookshelf.db-wal', 'src/db/seed.sql', '.env'];
export const PROTECTED_EXACT = ['.claude/settings.json', '.claude/settings.local.json'];
// Representative names a glob is tested against, plus every directory that contains one.
const GLOB_FILES = [
  'bookshelf.db', 'bookshelf.db-shm', 'bookshelf.db-wal', 'src/db/seed.sql', '.env', '.env.local', '.env.production',
  '.claude/settings.json', '.claude/settings.local.json',
  'ticket-to-merge/hooks/protect.mjs', 'ticket-to-merge/hooks/integrity.mjs', 'ticket-to-merge/hooks/lib.mjs',
  'ticket-to-merge/hooks/hooks.json',
];
const GLOB_DIRS = ['', 'src', 'src/db', '.claude', 'ticket-to-merge', 'ticket-to-merge/hooks', 'ticket-to-merge/hooks/tests'];

export function realpathBestEffort(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function projectRoot(input) {
  const raw = process.env.CLAUDE_PROJECT_DIR || input?.cwd;
  if (!raw) throw new Error('no project root: CLAUDE_PROJECT_DIR unset and no cwd in input');
  return realpathBestEffort(raw);
}

export function baseDir(input, root) {
  return input?.cwd ? realpathBestEffort(input.cwd) : root;
}

export function tmpRoot() {
  return path.join(process.env.TMPDIR || '/tmp', 'ticket-to-merge');
}

export function snapshotDir(root) {
  const h = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(tmpRoot(), h);
}

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function underDir(abs, dir) {
  return abs === dir || abs.startsWith(dir + path.sep);
}

const isEnvName = (b) => b === '.env' || b.startsWith('.env.');

/** Reason string when abs (already realpath'd) is a protected write target, else null. */
export function protectedReason(abs, root) {
  const tmp = realpathBestEffort(tmpRoot());
  if (underDir(abs, tmp)) return 'snapshot directory';
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT && realpathBestEffort(process.env.CLAUDE_PLUGIN_ROOT);
  if (pluginRoot && underDir(abs, path.join(pluginRoot, 'hooks'))) return 'guardrail hooks';
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const base = path.basename(rel);
  if (rel === 'bookshelf.db' || rel.startsWith('bookshelf.db-')) return 'database file';
  if (rel === 'src/db/seed.sql') return 'seed data';
  if (isEnvName(base)) return 'secrets file (.env)';
  if (underDir(rel, 'ticket-to-merge/hooks')) return 'guardrail hooks';
  if (PROTECTED_EXACT.includes(rel)) return 'guardrail settings';
  return null;
}

export function isEnvPath(p) {
  return isEnvName(path.basename(realpathBestEffort(p)));
}

// ---- glob support (bash semantics: * and ? never match a leading dot unless the pattern has one)
function expandBraces(s) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(s);
  if (!m) return [s];
  return m[1].split(',').flatMap((alt) => expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)));
}

function segmentRegex(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end === -1) re += '\\[';
      else {
        re += '[' + seg.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp('^' + (seg.startsWith('.') ? '' : '(?!\\.)') + re + '$');
}

function globMatches(pattern, target) {
  const ps = pattern.split('/').filter((s) => s !== '');
  const ts = target.split('/').filter((s) => s !== '');
  const go = (i, j) => {
    if (i === ps.length) return j === ts.length;
    if (ps[i] === '**') return go(i + 1, j) || (j < ts.length && !ts[j].startsWith('.') && go(i, j + 1));
    return j < ts.length && segmentRegex(ps[i]).test(ts[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

export const hasGlob = (s) => /[*?[{]/.test(s);

/** Could this glob (path relative to root) match a protected file or a directory holding one? */
export function globCouldHitProtected(relPattern) {
  const targets = [...GLOB_FILES, ...GLOB_DIRS.filter(Boolean)];
  const pats = expandBraces(relPattern.replace(/^\.\//, ''));
  return pats.some((p) => {
    if (p === '' || p === '.') return true;
    return targets.some((t) => globMatches(p, t));
  });
}

export function globMatchesEnv(pattern) {
  return expandBraces(pattern).some((p) => ['.env', '.env.local', '.env.production'].some((t) => globMatches(p.split('/').pop(), t)));
}

/**
 * Could a destructive command aimed at token (a path word from Bash) hit a protected
 * target or a directory containing one? Returns a reason string or null.
 */
export function destructivePathReason(token, root, base) {
  let t = token.replace(/^of=/, '');
  if (!t) return null;
  if (t.includes('`') || t.includes('$(')) return 'command substitution inside a path argument';
  if (t.includes('$')) {
    const prefix = t.slice(0, t.indexOf('$'));
    const dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
    const abs = realpathBestEffort(path.resolve(base, dir || '.'));
    const rel = path.relative(root, abs);
    if (rel === '' || rel.split(path.sep)[0] === 'src' || rel.startsWith('.claude') || rel.startsWith('ticket-to-merge')) {
      return 'variable expansion in a path aimed at the repo root or a protected directory';
    }
    return null;
  }
  if (t.startsWith('~')) t = path.join(os.homedir(), t.slice(1));
  if (hasGlob(t)) {
    const abs = path.resolve(base, t);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return globCouldHitProtected(rel) ? 'glob that can match a protected file or directory' : null;
  }
  const abs = realpathBestEffort(path.resolve(base, t));
  const pr = protectedReason(abs, root);
  if (pr) return pr;
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (GLOB_DIRS.includes(rel)) return 'directory that contains protected files';
  return null;
}

const SRC_DB_TARGETS = ['src/db', 'src/db/seed.sql', 'src/db/schema.sql', 'src/db/index.ts'];

/** Does this path word (Bash argument) point at src/db or something inside it? */
export function referencesSrcDb(word, root, base) {
  let t = word.replace(/^[\w-]+=/, '');
  if (!t || t.startsWith('-') && !t.includes('/')) return false;
  if (t.startsWith('~')) t = path.join(os.homedir(), t.slice(1));
  const abs = path.resolve(base, t);
  if (hasGlob(t)) {
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return expandBraces(rel).some((p) => SRC_DB_TARGETS.some((x) => globMatches(p, x)));
  }
  const rel = path.relative(root, realpathBestEffort(abs));
  return rel === 'src/db' || rel.startsWith('src/db/');
}

// ---- role split (test-writer / implementer): the tests/ directory
const TESTS_SAMPLES = [
  'tests', 'tests/models', 'tests/routes', 'tests/a.test.ts', 'tests/models/book.test.ts', 'tests/models/api.test.ts',
  'tests/routes/books.test.ts', 'tests/routes/api.test.ts', 'tests/x/y/z.ts',
];

/** Is abs (already resolved) tests/ itself or inside <root>/tests? */
export function underTests(abs, root) {
  return underDir(abs, path.join(root, 'tests'));
}

/**
 * Could a Bash path word (literal, glob or $var) point at tests/, something inside it,
 * or a directory that contains it (repo root, a parent)? Best effort, errs towards true.
 */
export function touchesTests(token, root, base) {
  let t = token.replace(/^(?:of|--output|--target-directory)=/, '');
  if (!t) return false;
  if (t.includes('`') || t.includes('$(')) return true;
  if (t.startsWith('~')) t = path.join(os.homedir(), t.slice(1));
  const testsDir = path.join(root, 'tests');
  if (t.includes('$')) {
    const prefix = t.slice(0, t.indexOf('$'));
    const dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';
    const abs = realpathBestEffort(path.resolve(base, dir || '.'));
    return abs === root || underDir(abs, testsDir) || underDir(testsDir, abs);
  }
  if (hasGlob(t)) {
    const rel = path.relative(root, path.resolve(base, t));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return expandBraces(rel).some((p) => p === 'tests' || p.startsWith('tests/') || TESTS_SAMPLES.some((x) => globMatches(p, x)));
  }
  const abs = realpathBestEffort(path.resolve(base, t));
  return underTests(abs, root) || underDir(testsDir, abs);
}
