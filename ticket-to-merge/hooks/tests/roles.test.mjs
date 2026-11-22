import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeProject, run, PROTECT, bash, tool } from './helpers.mjs';

let proj;
before(() => { proj = makeProject(); });
after(() => proj.cleanup());
const P = (rel) => path.join(proj.root, rel);
const as = (agent_type, input) => run(PROTECT, proj, { agent_type, agent_id: 'a1', ...input });
const IMPL = 'ticket-to-merge:implementer';
const TW = 'ticket-to-merge:test-writer';
const IMPL_MSG = 'BLOCKED: implementer cannot change tests/. If a test looks wrong, return STATUS: blocked with your reason instead.';
const TW_MSG = 'BLOCKED: test-writer may only change files under tests/ and run read-only or test commands.';

function expectBlock(agent, input, msg) {
  const r = as(agent, input);
  assert.equal(r.code, 2, `expected block: ${JSON.stringify(input.tool_input)}`);
  assert.equal(r.stderr.trim(), msg);
}
function expectAllow(agent, input) {
  const r = as(agent, input);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
}

describe('role split: implementer BLOCK', () => {
  const cases = [
    ['Edit tests/models/book.test.ts', tool('Edit', { file_path: P('tests/models/book.test.ts') })],
    ['Write tests/routes/books.test.ts', tool('Write', { file_path: P('tests/routes/books.test.ts') })],
    ['Write ./src/../tests/x.test.ts', tool('Write', { file_path: P('./src/../tests/x.test.ts') })],
    ['Write relative tests/y.test.ts', tool('Write', { file_path: 'tests/y.test.ts' })],
    ['MultiEdit tests/a.test.ts', tool('MultiEdit', { file_path: P('tests/a.test.ts') })],
    ['NotebookEdit under tests', tool('NotebookEdit', { notebook_path: P('tests/n.ipynb') })],
    ['Bash sed -i', bash('sed -i s/a/b/ tests/models/book.test.ts')],
    ['Bash redirect', bash('echo x > tests/a.test.ts')],
    ['Bash append', bash('echo x >> tests/a.test.ts')],
    ['Bash rm', bash('rm tests/routes/api.test.ts')],
    ['Bash rm glob', bash('rm tests/routes/*.test.ts')],
    ['Bash rm -rf te*', bash('rm -rf te*')],
    ['Bash git checkout -- tests', bash('git checkout -- tests')],
    ['Bash git restore tests/x', bash('git restore tests/models/book.test.ts')],
    ['Bash cd tests && rm -rf', bash('cd tests && rm -rf models')],
    ['Bash cp into tests', bash('cp /tmp/x tests/models/book.test.ts')],
    ['Bash mv from tests', bash('mv tests/a.test.ts /tmp/a')],
    ['Bash tee tests', bash('echo x | tee tests/a.test.ts')],
    ['Bash touch tests', bash('touch tests/new.test.ts')],
    ['Bash find -delete', bash('find tests -name "*.ts" -delete')],
  ];
  for (const [name, input] of cases) test(name, () => expectBlock(IMPL, input, IMPL_MSG));
  test('bare agent_type implementer', () => expectBlock('implementer', tool('Edit', { file_path: P('tests/a.test.ts') }), IMPL_MSG));
  test('Write via symlink pointing into tests', () => {
    proj.w('tests/real.ts', '// r\n');
    fs.symlinkSync(P('tests/real.ts'), P('src/alias.ts'));
    expectBlock(IMPL, tool('Write', { file_path: P('src/alias.ts') }), IMPL_MSG);
  });
});

describe('role split: implementer ALLOW', () => {
  const cases = [
    ['Edit src/models/book.ts', tool('Edit', { file_path: P('src/models/book.ts') })],
    ['Write src/views/books/_results.ejs', tool('Write', { file_path: P('src/views/books/_results.ejs') })],
    ['Read tests/models/book.test.ts', tool('Read', { file_path: P('tests/models/book.test.ts') })],
    ['Grep tests', tool('Grep', { pattern: 'x', path: P('tests') })],
    ['Glob tests/**', tool('Glob', { pattern: 'tests/**/*.ts' })],
    ['Bash npm run test:run', bash('npm run test:run')],
    ['Bash npm run test:run -- file', bash('npm run test:run -- tests/models/book.test.ts')],
    ['Bash npx vitest run', bash('npx vitest run tests/routes/books.test.ts')],
    ['Bash cat tests', bash('cat tests/models/book.test.ts')],
    ['Bash grep -rn tests', bash('grep -rn x tests')],
    ['Bash git diff -- tests', bash('git diff -- tests')],
    ['Bash sed -i src', bash('sed -i s/a/b/ src/models/book.ts')],
    ['Bash copy tests out', bash('cp tests/routes/books.test.ts /tmp/b.ts')],
    ['Bash rm -rf dist', bash('rm -rf dist')],
  ];
  for (const [name, input] of cases) test(name, () => expectAllow(IMPL, input));
});

describe('role split: test-writer BLOCK', () => {
  const cases = [
    ['Edit src/models/book.ts', tool('Edit', { file_path: P('src/models/book.ts') })],
    ['Write src/routes/books.ts', tool('Write', { file_path: P('src/routes/books.ts') })],
    ['Write CLAUDE.md', tool('Write', { file_path: P('CLAUDE.md') })],
    ['Write tests/../src/x.ts', tool('Write', { file_path: P('tests/../src/x.ts') })],
    ['Write relative src/x.ts', tool('Write', { file_path: 'src/x.ts' })],
    ['NotebookEdit outside tests', tool('NotebookEdit', { notebook_path: P('n.ipynb') })],
    ['Bash node script', bash('node scripts/x.js')],
    ['Bash redirect to src', bash('echo x > src/a.ts')],
    ['Bash npm install', bash('npm install vitest')],
    ['Bash git commit', bash('git commit -m x')],
    ['Bash touch', bash('touch src/x.ts')],
    ['Bash redirect even under tests', bash('cat tests/a.ts > tests/b.ts')],
    ['Bash >&file', bash('npm run build >&out.txt')],
    ['Bash chained forbidden', bash('npm run test:run && rm -rf dist')],
    ['Bash find -delete', bash('find tests -delete')],
    ['Bash find -exec', bash('find tests -exec rm {} +')],
    ['Bash command substitution', bash('cat $(rm x)')],
    ['Bash sed -i', bash('sed -i s/a/b/ tests/a.ts')],
    ['Bash git diff --output', bash('git diff --output=tests/x main')],
  ];
  for (const [name, input] of cases) test(name, () => expectBlock(TW, input, TW_MSG));
  test('bare agent_type test-writer', () => expectBlock('test-writer', tool('Edit', { file_path: P('src/a.ts') }), TW_MSG));
  test('existing rule still wins: seed.sql keeps its own message', () => {
    const r = as(TW, tool('Write', { file_path: P('src/db/seed.sql') }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /protected by ticket-to-merge/);
  });
});

describe('role split: test-writer ALLOW', () => {
  const cases = [
    ['Write tests/routes/books.test.ts', tool('Write', { file_path: P('tests/routes/books.test.ts') })],
    ['Edit tests/models/book.test.ts', tool('Edit', { file_path: P('tests/models/book.test.ts') })],
    ['Write new relative tests/new.test.ts', tool('Write', { file_path: 'tests/new.test.ts' })],
    ['Read src/models/book.ts', tool('Read', { file_path: P('src/models/book.ts') })],
    ['Bash test run piped', bash('npm run test:run -- tests/models/book.test.ts 2>&1 | tail -40')],
    ['Bash npx vitest run', bash('npx vitest run tests/routes/books.test.ts')],
    ['Bash git status', bash('git status --porcelain')],
    ['Bash grep describe', bash('grep -n "describe" tests/routes/api.test.ts')],
    ['Bash build and tsc', bash('npm run build && npx tsc --noEmit')],
    ['Bash ls | head', bash('ls tests | head -5')],
    ['Bash git log', bash('git log --oneline -5')],
    ['Bash >/dev/null', bash('npm run build >/dev/null 2>&1')],
    ['Bash find plain', bash('find tests -name "*.test.ts"')],
    ['Bash rg | wc', bash('rg describe tests | wc -l')],
  ];
  for (const [name, input] of cases) test(name, () => expectAllow(TW, input));
});

describe('role split: scope of the rule', () => {
  test('main session (no agent_type) can Edit tests/x.test.ts', () => expectAllow(undefined, tool('Edit', { file_path: P('tests/x.test.ts') })));
  test('main session can Edit src/x.ts', () => expectAllow(undefined, tool('Edit', { file_path: P('src/x.ts') })));
  test('main session can touch tests via Bash', () => expectAllow(undefined, bash('touch tests/x.test.ts')));
  for (const other of ['ticket-to-merge:verifier', 'Explore', 'general-purpose', 'ticket-to-merge:test-writer-helper']) {
    test(`${other}: Edit tests and src both allowed`, () => {
      expectAllow(other, tool('Edit', { file_path: P('tests/x.test.ts') }));
      expectAllow(other, tool('Edit', { file_path: P('src/x.ts') }));
    });
  }
  test('non-string agent_type is ignored', () => expectAllow(42, tool('Edit', { file_path: P('tests/x.test.ts') })));
  test('existing rules still apply to implementer (seed.sql)', () => {
    assert.equal(as(IMPL, tool('Edit', { file_path: P('src/db/seed.sql') })).code, 2);
  });
});
