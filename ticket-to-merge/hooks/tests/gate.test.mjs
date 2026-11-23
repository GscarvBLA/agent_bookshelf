import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate.mjs');
const IMPL = 'ticket-to-merge:implementer';

let root;
let n = 0;
const sid = () => `s-${process.pid}-${Date.now()}-${n++}`;
const marker = (name) => path.join(root, name);

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-proj-')));
  const script = (m, f) => `node -e "const fs=require('fs');fs.appendFileSync('${m}','x');if(fs.existsSync('${f}')){console.log('FAILLINE');process.exit(1)}"`;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fake', version: '1.0.0',
    scripts: {
      build: script('ran-build', 'red-build'),
      'test:run': `node -e "const fs=require('fs');fs.appendFileSync('ran-tests','x');if(fs.existsSync('red-tests')){for(let i=1;i<=60;i++)console.log('line'+i);process.exit(1)}"`,
    },
  }));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of ['red-build', 'red-tests', 'ran-build', 'ran-tests']) fs.rmSync(marker(f), { force: true });
});

function gate(input, { raw } = {}) {
  const r = spawnSync('node', [GATE], {
    input: raw ?? JSON.stringify({ cwd: root, ...input }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { code: r.status, stderr: r.stderr };
}
const impl = (session_id, agent_id = 'a1') => ({ agent_type: IMPL, session_id, agent_id });

describe('done-gate', () => {
  test('implementer + green: exit 0 and both commands ran', () => {
    const r = gate(impl(sid()));
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(marker('ran-build')) && fs.existsSync(marker('ran-tests')));
  });

  test('implementer + red build: exit 2 with message, tests not run', () => {
    fs.writeFileSync(marker('red-build'), '');
    const r = gate(impl(sid()));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^Done-gate \(ticket-to-merge\): the build or tests are red\. Keep fixing application code; tests\/ is read-only\. If a test is wrong, stop with STATUS: blocked and say why\./);
    assert.match(r.stderr, /FAILLINE/);
    assert.ok(!fs.existsSync(marker('ran-tests')));
  });

  test('implementer + red tests: exit 2 with last 40 lines only', () => {
    fs.writeFileSync(marker('red-tests'), '');
    const r = gate(impl(sid()));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Done-gate \(ticket-to-merge\)/);
    assert.match(r.stderr, /line60/);
    assert.doesNotMatch(r.stderr, /line1\n/);
    assert.doesNotMatch(r.stderr, /line10\n/);
  });

  test('4th consecutive red for the same agent: exit 0 with give-up note', () => {
    fs.writeFileSync(marker('red-tests'), '');
    const s = sid();
    for (let i = 0; i < 3; i++) assert.equal(gate(impl(s)).code, 2, `attempt ${i + 1}`);
    fs.rmSync(marker('ran-build'), { force: true });
    const r = gate(impl(s));
    assert.equal(r.code, 0);
    assert.match(r.stderr, /Done-gate gave up after 3 attempts; the recipe's own done-gate will report the red suite\./);
    assert.ok(!fs.existsSync(marker('ran-build')), 'gave up without running npm');
  });

  test('a different agent_id resets the count', () => {
    fs.writeFileSync(marker('red-tests'), '');
    const s = sid();
    for (let i = 0; i < 3; i++) gate(impl(s, 'a1'));
    assert.equal(gate(impl(s, 'a1')).code, 0);
    assert.equal(gate(impl(s, 'a2')).code, 2);
  });

  for (const agent_type of ['ticket-to-merge:test-writer', 'ticket-to-merge:verifier', 'test-writer', 'verifier', undefined, '']) {
    test(`non-implementer (${agent_type}) exits 0 without running npm`, () => {
      fs.writeFileSync(marker('red-build'), '');
      const r = gate({ agent_type, session_id: sid(), agent_id: 'a1' });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
      assert.ok(!fs.existsSync(marker('ran-build')) && !fs.existsSync(marker('ran-tests')));
    });
  }

  test('malformed stdin fails open with a warning', () => {
    const r = gate(null, { raw: '{not json' });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /Done-gate warning/);
  });

  test('namespaced and bare implementer are both gated', () => {
    fs.writeFileSync(marker('red-build'), '');
    assert.equal(gate({ agent_type: 'ticket-to-merge:implementer', session_id: sid(), agent_id: 'x' }).code, 2);
    assert.equal(gate({ agent_type: 'implementer', session_id: sid(), agent_id: 'x' }).code, 2);
  });

  test('never writes into the project', () => {
    fs.writeFileSync(marker('red-tests'), '');
    const list = () => fs.readdirSync(root).filter((f) => !f.startsWith('ran-')).sort();
    const before = list();
    gate(impl(sid()));
    assert.deepEqual(list(), before);
  });
});
