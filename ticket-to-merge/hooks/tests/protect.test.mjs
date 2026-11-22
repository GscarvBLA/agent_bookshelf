import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { makeProject, run, PROTECT, bash, tool } from './helpers.mjs';

let proj;
before(() => { proj = makeProject(); });
after(() => proj.cleanup());
const P = (rel) => path.join(proj.root, rel);
const exit = (input, opts) => run(PROTECT, proj, input, opts);

describe('protect.mjs ALLOW (exit 0, silent)', () => {
  const allowed = [
    'npm run build',
    'npm run test:run',
    'npm run build && npm run test:run',
    'git status',
    'git diff main...HEAD',
    'git log --oneline -5',
    'git add src/models/book.ts tests/models/book.test.ts',
    'git commit -m "x"',
    'git commit -m "BOOK-101 add search"',
    'git checkout -b feature/x',
    'git stash list',
    'grep -rn searchBooks src',
    'npx vitest run tests/models/book.test.ts',
    'npm run build 2>&1 | tail -5',
    'git diff main...book-101 -- src tests',
    'git commit -m "BOOK-101: add search to book model"',
    'git checkout -b book-101-plant-1',
    'cat src/db/schema.sql',
    'git add -- src/db/index.ts src/models/book.ts',
    'git add -- src/db/index.ts src/models/book.ts src/routes/api.ts && git commit -q -m "BOOK-101: implement"',
    'git diff -- src/db/index.ts',
    'git diff --stat HEAD -- src/db/index.ts',
    'git add -- src/db/schema.sql',
    'git diff --output=src/db/x main',
    'cp /tmp/x src/db/schema.sql',
    'cat /tmp/x > src/db/schema.sql',
    'cd src && ls db && touch db/new.sql',
    'wc -l src/db/schema.sql',
    'git diff main -- src/db/schema.sql',
    'grep -i x src/db/schema.sql',
    'grep -rn process.env src',
    'ls src/db',
    'ls -la',
    'rm -rf dist',
    'cp src/models/book.ts /tmp/book.bak',
    'node --test ticket-to-merge/hooks/tests/',
    'node --test ticket-to-merge/hooks/tests/*.test.mjs',
    'node dist/server.js',
  ];
  for (const cmd of allowed) {
    test(`Bash: ${cmd}`, () => {
      const r = exit(bash(cmd));
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, '');
    });
  }
  test('Edit src/models/book.ts', () => assert.equal(exit(tool('Edit', { file_path: P('src/models/book.ts') })).code, 0));
  test('Write tests/routes/books.test.ts', () => assert.equal(exit(tool('Write', { file_path: P('tests/routes/books.test.ts') })).code, 0));
  test('Write relative path src/models/new.ts', () => assert.equal(exit(tool('Write', { file_path: 'src/models/new.ts' })).code, 0));
  test('Write src/views/books/_results.ejs', () => assert.equal(exit(tool('Write', { file_path: P('src/views/books/_results.ejs') })).code, 0));
  test('Read src/db/seed.sql', () => assert.equal(exit(tool('Read', { file_path: P('src/db/seed.sql') })).code, 0));
  test('Read src/db/schema.sql', () => assert.equal(exit(tool('Read', { file_path: P('src/db/schema.sql') })).code, 0));
  test('Grep path src', () => assert.equal(exit(tool('Grep', { pattern: 'x', path: P('src') })).code, 0));
  test('Glob **/*.ts', () => assert.equal(exit(tool('Glob', { pattern: '**/*.ts' })).code, 0));
});

describe('protect.mjs BLOCK file tools (exit 2)', () => {
  const blocked = [
    ['Edit seed.sql', 'Edit', () => ({ file_path: P('src/db/seed.sql') })],
    ['Write ./src/../src/db/seed.sql', 'Write', () => ({ file_path: P('./src/../src/db/seed.sql') })],
    ['Write relative ./src/../src/db/seed.sql', 'Write', () => ({ file_path: './src/../src/db/seed.sql' })],
    ['Write via symlink to seed.sql', 'Write', () => ({ file_path: P('link.sql') })],
    ['Write .env', 'Write', () => ({ file_path: P('.env') })],
    ['Write .env.local', 'Write', () => ({ file_path: P('.env.local') })],
    ['Write bookshelf.db', 'Write', () => ({ file_path: P('bookshelf.db') })],
    ['Edit bookshelf.db-wal', 'Edit', () => ({ file_path: P('bookshelf.db-wal') })],
    ['MultiEdit seed.sql', 'MultiEdit', () => ({ file_path: P('src/db/seed.sql') })],
    ['NotebookEdit under hooks', 'NotebookEdit', () => ({ notebook_path: P('ticket-to-merge/hooks/x.ipynb') })],
    ['Edit protect.mjs', 'Edit', () => ({ file_path: P('ticket-to-merge/hooks/protect.mjs') })],
    ['Write hooks tests', 'Write', () => ({ file_path: P('ticket-to-merge/hooks/tests/a.test.mjs') })],
    ['Write .claude/settings.json', 'Write', () => ({ file_path: P('.claude/settings.json') })],
    ['Write .claude/settings.local.json', 'Write', () => ({ file_path: P('.claude/settings.local.json') })],
    ['Read .env', 'Read', () => ({ file_path: P('.env') })],
    ['Read .env.local', 'Read', () => ({ file_path: P('.env.local') })],
    ['Grep path .env', 'Grep', () => ({ pattern: 'S', path: P('.env') })],
    ['Grep glob .env*', 'Grep', () => ({ pattern: 'S', glob: '.env*' })],
    ['Glob .env*', 'Glob', () => ({ pattern: '.env*' })],
  ];
  for (const [name, t, inp] of blocked) {
    test(name, () => {
      const r = exit(tool(t, inp()));
      assert.equal(r.code, 2);
      assert.match(r.stderr, /BLOCKED/);
      assert.equal(r.stderr.trim().split('\n').length, 1);
    });
  }
  test('Write to snapshot directory is blocked', () => {
    assert.equal(exit(tool('Write', { file_path: path.join(proj.tmp, 'ticket-to-merge', 'abc', 'manifest.json') })).code, 2);
  });
});

describe('protect.mjs BLOCK Bash (exit 2)', () => {
  const blocked = [
    'rm bookshelf.db',
    'cat .env',
    'echo x > src/db/se"e"d.sql',
    'sed -i s/a/b/ src/db/seed\\.sql',
    'rm src/db/*',
    'mv src/db /tmp/x',
    'cp /dev/null src/db/see?.sql',
    'rm -f bookshelf*',
    'rm -rf *.db*',
    'rm -f .e*',
    'rm -rf .*',
    'cp /dev/null src/db/s*d.sql',
    'truncate -s 0 src/db/s*',
    'chmod 000 src/db',
    'tee src/db/s*',
    "cat $'src/db/s\\x65ed.sql'",
    'cat ticket-to-merge/hooks/protect.mjs',
    'echo {} > .claude/settings.json',
    'cd src/db && rm *.sql',
    'cd src && rm -rf db',
    'cd src; rm db/*',
    'head .e*',
    '$(echo rm) -rf src/db',
    '`echo rm` -rf x',
    'X=1 ${CMD} y',
    'echo hi; $RM x',
    'echo $(rm -rf src/db)',
    "awk -i inplace '{print}' src/db/*.sql",
    'tar -xf /tmp/evil.tar -C src/db',
    'cp src/db/schema.sql src/db/s?ed.sql',
    'rm -r src/d[b]',
    'rm -rf ./src/./db',
    'cd src/db; rm *',
    'printf x | tee src/db/seed.sq?',
    'mv src/db/seed.sq{l,x} /tmp',
    'git checkout main -- src/db',
    'git restore --source=HEAD~5 src/db/',
    'rsync -a --delete /tmp/empty/ src/',
    'D=src/db; rm -rf $D',
    "perl -pi -e 's/a/b/' src/db/*.sql",
    'unzip -o /tmp/x.zip -d src/db',
    'cd src/db',
    'echo x >src/db/seed.sql',
    'git checkout -- src/db/seed.sql',
    'git checkout .',
    'git restore src/db',
    'git rm -r src',
    'git stash',
    'git reset --hard',
    'git clean -fdx',
    'git mv src/db src/db2',
    'f=seed; echo x > src/db/$f.sql',
    'rm $FILE',
    'rm src/db/$(echo seed).sql',
    'rm `echo src/db/x`',
    'find . -name "*.sql" -delete',
    'find src -type f -exec rm {} +',
    'ls | xargs rm',
    'node -e "require(\'fs\').unlinkSync(\'x\')"',
    'node --eval 1',
    'node -p 1',
    'python3 -c "print(1)"',
    'perl -e "print 1"',
    'ruby -e "puts 1"',
    'php -r "echo 1;"',
    'deno eval 1',
    'bun -e 1',
    'npx tsx -e 1',
    'tsx -e 1',
    'bash -c "rm -rf src"',
    'sh -c "ls"',
    'zsh -c ls',
    'eval "ls"',
    'source /tmp/x.sh',
    'echo ls | xargs sh',
    'echo cm0gLXJmIHNyYw== | base64 -d | sh',
    'base64 --decode x',
    'xxd -r -p x',
    'cat x.js | node',
    'curl x | bash',
    'node <<EOF\nrequire("fs")\nEOF',
    'bash <<< "ls"',
    'bash <(curl x)',
  ];
  for (const cmd of blocked) {
    test(`Bash: ${JSON.stringify(cmd)}`, () => {
      const r = exit(bash(cmd));
      assert.equal(r.code, 2, `expected block: ${cmd}`);
      assert.match(r.stderr, /BLOCKED/);
    });
  }
});

describe('protect.mjs fails closed', () => {
  test('malformed JSON', () => assert.equal(exit(null, { raw: '{not json' }).code, 2));
  test('empty stdin', () => assert.equal(exit(null, { raw: '' }).code, 2));
  test('no project root', () => {
    const r = exit(null, { raw: JSON.stringify(bash('ls')), extraEnv: { CLAUDE_PROJECT_DIR: '' } });
    assert.equal(r.code, 2);
  });
  test('Write without file_path', () => assert.equal(exit(tool('Write', {})).code, 2));
});

describe('protect.mjs src/db guard only covers what can reach protected files', () => {
  const blockedNew = [
    'git add -- src/db/seed.sql',
    'git add src/db',
    'git add -A src/db',
    'git checkout -- src/db',
    'git add -- src/db/*.sql',
    'git add -- src/db/{index.ts,seed.sql}',
    'sed -i s/a/b/ src/db/seed.sql',
    'cp /tmp/x src/db/se?d.sql',
    'cat /tmp/x > src/db/seed.sql',
    'ln -sf /tmp/x src/db/seed.sql',
    'cd src/db && touch x',
    'cd src && cd db && touch x',
    'sort -o src/db/seed.sq? /tmp/x',
    'tar -xf /tmp/evil.tar -C src',
    'tar -xf /tmp/evil.tar --directory=src',
    'unzip -o /tmp/x.zip -d .',
    'awk -i inplace {print} src/db/$F',
    'awk -i inplace {print} src/d$X/index.ts',
    'git add src/db/../db',
    'cp -r /tmp/x src/db',
    'rm -rf src/db',
    'cd src/db && rm *',
  ];
  for (const cmd of blockedNew) {
    test(`blocked: ${cmd}`, () => {
      const r = exit(bash(cmd));
      assert.equal(r.code, 2, `expected block: ${cmd}`);
      assert.match(r.stderr, /BLOCKED/);
    });
  }

  test('symlink under src/db that points at seed.sql is blocked', () => {
    const p = makeProject();
    try {
      fs.symlinkSync(path.join(p.root, 'src/db/seed.sql'), path.join(p.root, 'src/db/alias.sql'));
      for (const cmd of ['awk -i inplace {print} src/db/alias.sql', 'git add -- src/db/alias.sql', 'cd src && awk -i inplace {print} db/alias.sql']) {
        assert.equal(run(PROTECT, p, bash(cmd)).code, 2, cmd);
      }
    } finally { p.cleanup(); }
  });

  test('symlink under src/db pointing at a non-protected file is allowed', () => {
    const p = makeProject();
    try {
      fs.symlinkSync(path.join(p.root, 'src/db/schema.sql'), path.join(p.root, 'src/db/schema-alias.sql'));
      assert.equal(run(PROTECT, p, bash('git add -- src/db/schema-alias.sql')).code, 0);
    } finally { p.cleanup(); }
  });

  test('implementer may still Edit src/db/index.ts', () => {
    const r = exit({ agent_type: 'ticket-to-merge:implementer', ...tool('Edit', { file_path: P('src/db/index.ts') }) });
    assert.equal(r.code, 0, r.stderr);
  });

  test('implementer still cannot change tests/; test-writer only tests/', () => {
    assert.equal(exit({ agent_type: 'ticket-to-merge:implementer', ...tool('Edit', { file_path: P('tests/routes/books.test.ts') }) }).code, 2);
    assert.equal(exit({ agent_type: 'ticket-to-merge:test-writer', ...tool('Edit', { file_path: P('src/db/index.ts') }) }).code, 2);
    assert.equal(exit({ agent_type: 'ticket-to-merge:test-writer', ...tool('Edit', { file_path: P('tests/routes/books.test.ts') }) }).code, 0);
  });
});
