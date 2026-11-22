// PreToolUse guard. Exit 2 = block (stderr goes to Claude), exit 0 = allow. Fails closed.
import fs from 'node:fs';
import path from 'node:path';
import {
  projectRoot, baseDir, protectedReason, realpathBestEffort, isEnvPath, hasGlob, globMatchesEnv,
  destructivePathReason, referencesSrcDb, underDir, snapshotDir, underTests, touchesTests,
} from './lib.mjs';

class Block extends Error {}
const block = (msg) => { throw new Block(msg); };

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const DESTRUCTIVE = new Set(['rm', 'mv', 'cp', 'ln', 'tee', 'truncate', 'dd', 'chmod', 'chown', 'unlink', 'shred', 'touch', 'install', 'rsync']);
const INTERP = 'node|nodejs|bun|deno|tsx|ts-node|python[\\d.]*|perl|ruby|php';
const SHELLS = 'sh|bash|zsh|dash|ksh|fish';
const B = '(?:^|[\\s;&|(){}`/])'; // command-word boundary

function checkWriteTool(input, root, base) {
  const ti = input.tool_input || {};
  const p = ti.file_path ?? ti.notebook_path;
  if (typeof p !== 'string' || p === '') block(`${input.tool_name}: no file path given. Provide an explicit file_path.`);
  const abs = realpathBestEffort(path.resolve(base, p));
  const why = protectedReason(abs, root) || protectedReason(path.resolve(base, p), root);
  if (why) block(`BLOCKED ${input.tool_name} on ${p}: ${why} is protected by ticket-to-merge. Do not edit it; change application code under src/ and add a Vitest test instead.`);
}

// ---------- role split: ticket-to-merge:test-writer / ticket-to-merge:implementer ----------
const IMPLEMENTER_MSG = 'BLOCKED: implementer cannot change tests/. If a test looks wrong, return STATUS: blocked with your reason instead.';
const TEST_WRITER_MSG = 'BLOCKED: test-writer may only change files under tests/ and run read-only or test commands.';

// agent_type is "<plugin>:<agent>" for plugin agents; the suffix after the last ':' also covers a bare name
function agentRole(input) {
  if (typeof input.agent_type !== 'string') return null;
  const name = input.agent_type.split(':').pop();
  return name === 'test-writer' || name === 'implementer' ? name : null;
}

function roleWriteTool(role, input, root, base) {
  const ti = input.tool_input || {};
  const p = ti.file_path ?? ti.notebook_path;
  const resolved = path.resolve(base, p);
  const real = realpathBestEffort(resolved);
  if (role === 'implementer' && (underTests(real, root) || underTests(resolved, root))) block(IMPLEMENTER_MSG);
  if (role === 'test-writer' && !(underTests(real, root) && underTests(resolved, root))) block(TEST_WRITER_MSG);
}

const EXTRA_WRITERS = new Set(['patch', 'unzip', 'tar']);
const TARGET_LAST = new Set(['cp', 'ln', 'install', 'rsync']);
const GIT_TREE_VERBS = new Set(['checkout', 'restore', 'rm', 'mv', 'reset', 'clean', 'stash', 'apply', 'am']);

function implementerBash(segments, root, baseDir0) {
  const bases = segmentBases(segments, baseDir0);
  for (const [si, words] of segments.entries()) {
    const base = bases[si];
    const hit = (w) => { if (touchesTests(w, root, base)) block(IMPLEMENTER_MSG); };
    words.forEach((w, i) => { if (w === '>' && words[i + 1]) hit(words[i + 1]); });
    const cw = commandWord(words);
    const verb = words[cw] ? basename(words[cw]) : '';
    const rest = words.slice(cw + 1).filter((w) => w !== '>');
    const args = rest.filter((w) => !w.startsWith('-'));
    const targetFlags = rest.filter((w) => /^--target-directory=/.test(w));
    if (DESTRUCTIVE.has(verb) || EXTRA_WRITERS.has(verb)) {
      const viaFlag = targetFlags.length || rest.includes('-t');
      (TARGET_LAST.has(verb) && !viaFlag ? args.slice(-1) : [...args, ...targetFlags]).forEach(hit);
    }
    if ((verb === 'sed' || verb === 'perl') && rest.some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w))) args.forEach(hit);
    if (verb === 'awk' && rest.includes('inplace')) args.forEach(hit);
    if (verb === 'find' && rest.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fls)$/.test(w))) {
      const paths = [];
      for (const w of rest) { if (/^[-!(]/.test(w)) break; paths.push(w); }
      (paths.length ? paths : ['.']).forEach(hit);
    }
    if (verb === 'git') {
      let i = cw + 1;
      while (i < words.length && words[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(words[i]) ? 2 : 1;
      if (GIT_TREE_VERBS.has(words[i])) words.slice(i + 1).filter((w) => !w.startsWith('-')).forEach(hit);
    }
  }
}

const TW_SIMPLE = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'find', 'pwd']);
const TW_GIT = new Set(['status', 'diff', 'log', 'show']);

function testWriterSegmentOk(words) {
  const [a, b, c] = words;
  if (a === 'npm') return b === 'run' && (c === 'test:run' || c === 'build');
  if (a === 'npx') return (b === 'vitest' && c === 'run') || (b === 'tsc' && c === '--noEmit');
  if (a === 'git') return TW_GIT.has(b) && !words.some((w) => /^--output/.test(w));
  if (!TW_SIMPLE.has(a)) return false;
  if (a === 'find') return !words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fls|fprintf)$/.test(w));
  if (a === 'rg') return !words.some((w) => /^--pre/.test(w));
  return true;
}

function testWriterBash(n, segments) {
  const deny = () => block(TEST_WRITER_MSG);
  if (/`|\$\(|[<>]\(/.test(n)) deny();
  if (/\d*>&(?![\d-]+(?:\s|$|[;&|)]))/.test(n)) deny(); // >&file writes a file; only 2>&1 style dups are fine
  for (const words of segments) {
    words.forEach((w, i) => { if (w === '>' && words[i + 1] !== '/dev/null') deny(); });
    if (!testWriterSegmentOk(words.filter((w) => w !== '>' && w !== '/dev/null'))) deny();
  }
}

function checkReadTool(input, root, base) {
  const ti = input.tool_input || {};
  const hit = (what) => block(`BLOCKED ${input.tool_name} of ${what}: .env files hold secrets. Ask the operator for the specific value you need instead.`);
  for (const key of ['file_path', 'path']) {
    if (typeof ti[key] === 'string' && ti[key] !== '' && isEnvPath(path.resolve(base, ti[key]))) hit(ti[key]);
  }
  for (const key of ['glob', 'pattern']) {
    if (input.tool_name === 'Read' || typeof ti[key] !== 'string') continue;
    if (key === 'pattern' && input.tool_name === 'Grep') continue; // regex, not a path
    if (globMatchesEnv(ti[key]) || /(^|\/)\.env(\.|$)/.test(ti[key])) hit(ti[key]);
  }
}

// ---------- Bash ----------
// bash $'...' quoting: decode \xHH, \NNN octal, \uHHHH and simple escapes so hidden names become visible
function decodeAnsiC(body) {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (_, e) => {
    if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'u' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', t: '\t' }[e] ?? e;
  });
}

function normalise(cmd) {
  return cmd
    .replace(/\$'((?:[^'\\]|\\.)*)'/g, (_, body) => decodeAnsiC(body))
    .replace(/\$'/g, "'")
    .replace(/['"\\]/g, '')
    .replace(/[\r\n]+/g, ' ; ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function layer1(n, root) {
  const tmp = path.join(process.env.TMPDIR || '/tmp', 'ticket-to-merge');
  const names = [
    [/bookshelf\.db/, 'bookshelf.db (database)'],
    [/seed\.sql/, 'seed.sql (seed data)'],
    [/(?<![\w])\.env(?!\w)/, '.env (secrets)'],
    [/ticket-to-merge\/hooks/, 'the guardrail hooks directory'],
    [/\.claude\/settings/, '.claude/settings (guardrail settings)'],
    [/(?:protect|integrity)\.mjs/, 'the guardrail hook scripts'],
  ];
  for (const [re, label] of names) {
    if (re.test(n)) block(`BLOCKED Bash: command mentions ${label}, which is protected by ticket-to-merge (rule: names). To read a file use the Read tool; to change behaviour edit src/ code and add a Vitest test.`);
  }
  if (n.includes(tmp) || n.includes(snapshotDir(root))) block('BLOCKED Bash: command mentions the ticket-to-merge snapshot directory (rule: names). Do not touch it.');
}

function splitSegments(n) {
  // detach redirections: drop fd dups like 2>&1, turn &> into >, space out > and >>
  const s = n.replace(/\d*>&\d*/g, ' ').replace(/&>/g, ' > ').replace(/\d*>>?\|?/g, ' > ');
  return s.split(/[;&|]+/)
    .map((x) => x.trim().split(' ').filter(Boolean).map((w) => w.replace(/^[({]+(?=.)/, '').replace(/\)+$/, '')))
    .filter((w) => w.length);
}

// commands nested in $(...) or `...` are analysed as extra segments of their own
function innerSegments(n) {
  const out = [];
  let cur = n;
  for (let i = 0; i < 4; i++) {
    const found = [];
    const next = cur.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_, a, b) => { found.push(a ?? b); return ' SUBST '; });
    if (!found.length) break;
    found.forEach((f) => out.push(...splitSegments(f)));
    cur = next;
  }
  return out;
}

const basename = (w) => w.split('/').pop();
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'then', 'do', 'else', '!', '{', '(']);

// index of the word that is actually being executed (skips VAR=x, sudo, then, ...)
function commandWord(words) {
  let i = 0;
  while (i < words.length && (/^\w+=/.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  return i;
}

// best-effort working directory per segment, following static `cd`/`pushd` targets
function segmentBases(segments, base) {
  let cur = base;
  return segments.map((words) => {
    const here = cur;
    const cw = commandWord(words);
    if (['cd', 'pushd'].includes(words[cw]) && words[cw + 1] && !/[$`*?[{~]/.test(words[cw + 1]) && words[cw + 1] !== '-') {
      cur = realpathBestEffort(path.resolve(cur, words[cw + 1]));
    }
    return here;
  });
}

function layer2(segments, root, baseDir0) {
  const bases = segmentBases(segments, baseDir0);
  for (const [si, words] of segments.entries()) {
    const base = bases[si];
    const check = (tok, why) => {
      const r = destructivePathReason(tok, root, base);
      if (r) block(`BLOCKED Bash: ${why} aimed at ${tok}: ${r} (rule: destructive verbs on globs/directories). Use Edit/Write on specific, non-protected files.`);
    };
    for (let i = 0; i < words.length; i++) if (words[i] === '>' && words[i + 1]) check(words[i + 1], 'redirection');
    for (const w of words) {
      if (hasGlob(w) && !w.startsWith('-') && globMatchesEnv(w) && path.resolve(base, path.dirname(w)) === root) {
        block(`BLOCKED Bash: glob ${w} can match .env, which holds secrets (rule: globs). Name the file you need explicitly (not .env*).`);
      }
    }
    const cw = commandWord(words);
    const verb = words[cw] ? basename(words[cw]) : '';
    const rest = words.slice(cw + 1).filter((w) => w !== '>');
    if (DESTRUCTIVE.has(verb)) rest.filter((w) => !w.startsWith('-')).forEach((w) => check(w, `'${verb}'`));
    if (verb === 'sed' && rest.some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w))) {
      rest.filter((w) => !w.startsWith('-')).forEach((w) => check(w, "'sed -i'"));
    }
    if (verb === 'find' && rest.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fls)$/.test(w))) {
      const paths = [];
      for (const w of rest) { if (/^[-!(]/.test(w)) break; paths.push(w); }
      (paths.length ? paths : ['.']).forEach((w) => check(w, "'find -delete/-exec'"));
    }
    if ((verb === 'cd' || verb === 'pushd') && rest[0]) {
      const rel = path.relative(root, realpathBestEffort(path.resolve(base, rest[0])));
      if (/^(src\/db|ticket-to-merge|\.claude)(\/|$)/.test(rel)) block(`BLOCKED Bash: cd into ${rest[0]}, a protected directory (rule: destructive verbs on globs/directories). Use paths from the repo root instead.`);
    }
    if (verb === 'xargs' && rest.some((w) => DESTRUCTIVE.has(basename(w)) || w === 'sed')) {
      block("BLOCKED Bash: 'xargs' feeding a destructive verb (rule: indirect execution). Name each file explicitly with Edit/Write.");
    }
  }
}

function layer3(segments, root, baseDir0) {
  const bases = segmentBases(segments, baseDir0);
  for (const [si, words] of segments.entries()) {
    const base = bases[si];
    const gi = commandWord(words);
    if (!words[gi] || basename(words[gi]) !== 'git') continue;
    let i = gi + 1;
    while (i < words.length && words[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(words[i]) ? 2 : 1;
    const sub = words[i];
    if (!['checkout', 'restore', 'rm', 'clean', 'stash', 'reset', 'mv'].includes(sub)) continue;
    const args = words.slice(i + 1);
    const deny = (why) => block(`BLOCKED Bash: 'git ${sub}' ${why} (rule: git). Use 'git status/diff/log', 'git add <specific files>' and 'git commit'; never rewrite the working tree.`);
    if (sub === 'stash' && !['list', 'show'].includes(args[0])) deny('would stash protected tracked files');
    if (sub === 'clean' && !args.some((a) => a === '--dry-run' || /^-[a-z]*n[a-z]*$/.test(a) && !a.includes('f'))) deny('deletes untracked files');
    if (sub === 'reset' && args.some((a) => ['--hard', '--merge', '--keep'].includes(a))) deny('with --hard discards working-tree changes');
    if (['checkout', 'restore', 'rm', 'mv', 'reset'].includes(sub)) {
      for (const a of args) {
        if (a === '.' || a === ':/' || a === '--force' || /^-[a-zA-Z]*[fx]/.test(a)) deny(`with '${a}' touches the whole tree or forces`);
        if (a.startsWith('-')) continue;
        if (hasGlob(a) || a.includes('$') || a.includes('`')) deny(`with wildcard/variable '${a}'`);
        if (destructivePathReason(a, root, base)) deny(`touching protected path ${a}`);
      }
    }
  }
}

function layer4(n, segments, root, base) {
  const deny = (what) => block(`BLOCKED Bash: ${what} (rule: indirect execution is not allowed). Put code in a file under src/ or tests/ via Write/Edit and run it with 'npm run build' / 'npm run test:run', or write a Vitest test instead of an inline script.`);
  const rules = [
    [new RegExp(`${B}(?:node|nodejs|bun)\\s+(?:-\\S+\\s+)*?(?:-e|-p|-pe|-ep|--eval|--print)\\b`), 'inline eval via node/bun'],
    [new RegExp(`${B}(?:tsx|ts-node)\\s+(?:-\\S+\\s+)*?(?:-e|-p|--eval|--print)\\b`), 'inline eval via tsx'],
    [new RegExp(`${B}python[\\d.]*\\s+(?:-\\S+\\s+)*?-\\w*c\\b`), 'python -c'],
    [new RegExp(`${B}perl\\s+(?:-\\S+\\s+)*?-\\w*[eE]\\b`), 'perl -e'],
    [new RegExp(`${B}ruby\\s+(?:-\\S+\\s+)*?-\\w*e\\b`), 'ruby -e'],
    [new RegExp(`${B}php\\s+(?:-\\S+\\s+)*?-r\\b`), 'php -r'],
    [new RegExp(`${B}deno\\s+eval\\b`), 'deno eval'],
    [new RegExp(`${B}(?:${SHELLS})\\s+(?:-\\S+\\s+)*?-\\w*c\\b`), 'shell -c wrapper'],
    [new RegExp(`${B}xargs\\s+(?:-\\S+\\s+)*?(?:${SHELLS})\\b`), 'xargs into a shell'],
    [new RegExp(`\\|\\s*(?:sudo\\s+)?(?:/\\S*/)?(?:${SHELLS}|${INTERP})\\b`), 'piping into an interpreter or shell'],
    [new RegExp(`${B}(?:${SHELLS}|${INTERP})\\b[^;&|]*?(?:<<|<\\()`), 'heredoc or process substitution into an interpreter or shell'],
    [new RegExp(`${B}(?:${SHELLS}|${INTERP})\\s+(?:-\\S+\\s+)*<\\s`), 'redirecting code into an interpreter or shell'],
    [new RegExp(`${B}base64\\s+(?:-\\S+\\s+)*?(?:-\\w*d\\w*|--decode|-D)\\b`), 'base64 decoding'],
    [new RegExp(`${B}xxd\\s+(?:-\\S+\\s+)*?-\\w*r\\w*\\b`), 'xxd -r decoding'],
    [new RegExp(`${B}(?:uudecode|openssl\\s+enc\\s+[^;&|]*-d)\\b`), 'decoding pipeline'],
  ];
  for (const [re, what] of rules) if (re.test(n)) deny(what);
  for (const words of segments) {
    const cw = commandWord(words);
    const w = words[cw] ? basename(words[cw]) : '';
    if (w === 'eval') deny('eval');
    if ((w === 'source' || w === '.') && words[cw + 1]) {
      const target = words[cw + 1];
      const rel = path.relative(root, realpathBestEffort(path.resolve(base, target)));
      if (rel.startsWith('..') || path.isAbsolute(rel) || target.includes('$')) deny(`'source' of a file outside the repo (${target})`);
    }
  }
}

const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'less', 'grep', 'rg', 'wc', 'diff', 'file', 'stat', 'sha256sum', 'md5sum']);
const READ_ONLY_GIT = new Set(['diff', 'log', 'show', 'status', 'blame']);

function layerDynamic(segments) {
  for (const words of segments) {
    const w = words[commandWord(words)];
    if (w && /[$`]/.test(w)) block(`BLOCKED Bash: dynamically built commands are not allowed (command word ${w}) (rule: indirect execution). Write the command out literally.`);
  }
}

// A segment that can reach a protected file under src/db (the directory, a glob matching seed.sql,
// a path resolving to it, or a cwd inside src/db) must use a read-only verb. Other src/db files are not guarded here.
const EXTRACTORS = new Set(['tar', 'bsdtar', 'unzip']);
const isSrcOrRoot = (w, root, base) => {
  if (!w || /[$`*?[{]/.test(w)) return false;
  const abs = realpathBestEffort(path.resolve(base, w));
  return abs === root || abs === path.join(root, 'src');
};

function layerSrcDb(segments, root, baseDir0) {
  const bases = segmentBases(segments, baseDir0);
  for (const [si, words] of segments.entries()) {
    const base = bases[si];
    const refs = words.filter((w) => w !== '>' && referencesSrcDb(w, root, base));
    const extractTo = words.findIndex((w, i) => /^(?:-C|-d|--directory)$/.test(w) && isSrcOrRoot(words[i + 1], root, base)) !== -1
      || words.some((w) => /^(?:--directory=|-C)(.+)$/.test(w) && isSrcOrRoot(w.replace(/^(?:--directory=|-C)/, ''), root, base));
    if (extractTo && EXTRACTORS.has(basename(words[commandWord(words)] ?? ''))) refs.push('the src/ extraction directory');
    if (underDir(base, path.join(root, 'src/db'))) refs.push('the current directory (src/db)');
    if (!refs.length) continue;
    const cw = commandWord(words);
    const verb = words[cw] ? basename(words[cw]) : '';
    let ok = READ_ONLY.has(verb);
    if (verb === 'git') {
      let i = cw + 1;
      while (i < words.length && words[i].startsWith('-')) i += ['-C', '-c'].includes(words[i]) ? 2 : 1;
      ok = READ_ONLY_GIT.has(words[i]);
    }
    const redirected = words.some((w, i) => words[i - 1] === '>' && referencesSrcDb(w, root, base));
    const writesViaFlag = words.some((w) => /^--output/.test(w));
    if (!ok || redirected || writesViaFlag) {
      block(`BLOCKED Bash: '${verb || words[0]}' references ${refs[0]} but it can reach a protected file under src/db, so only read-only verbs are allowed (rule: src/db allow-list: ls cat head tail less grep rg wc diff file stat sha256sum md5sum git diff/log/show/status/blame). Name the specific non-protected file (for example src/db/index.ts) instead of the directory or a glob.`);
    }
  }
}

function checkBash(input, root, base, role) {
  const cmd = input.tool_input?.command;
  if (typeof cmd !== 'string') block('Bash: no command string given.');
  const n = normalise(cmd);
  const segments = [...splitSegments(n), ...innerSegments(n)];
  if (!/^node --test ticket-to-merge\/hooks\/tests(?:\/(?:\*\.test\.mjs)?)?$/.test(n)) { // the guardrails' own test run skips these
    layer1(n, root);
    layerDynamic(segments);
    layer2(segments, root, base);
    layer3(segments, root, base);
    layerSrcDb(segments, root, base);
    layer4(n, segments, root, base);
  }
  if (role === 'implementer') implementerBash(segments, root, base);
  if (role === 'test-writer') testWriterBash(n, segments);
}

function main(raw) {
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object') throw new Error('hook input is not an object');
  const root = projectRoot(input);
  const base = baseDir(input, root);
  const tool = input.tool_name;
  const role = agentRole(input);
  if (WRITE_TOOLS.has(tool)) {
    checkWriteTool(input, root, base);
    if (role) roleWriteTool(role, input, root, base);
  } else if (READ_TOOLS.has(tool)) checkReadTool(input, root, base);
  else if (tool === 'Bash') checkBash(input, root, base, role);
}

try {
  main(fs.readFileSync(0, 'utf8'));
  process.exit(0);
} catch (e) {
  const msg = e instanceof Block ? e.message : `BLOCKED (fail closed): guard error: ${e?.message ?? e}`;
  process.stderr.write(msg.replace(/\n/g, ' ') + '\n');
  process.exit(2);
}
