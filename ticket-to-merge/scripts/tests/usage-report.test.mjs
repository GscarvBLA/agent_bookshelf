import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, requestCost, encodeProjectDir, main } from '../usage-report.mjs';

const PRICES = {
  models: {
    'claude-sonnet-5-5': { input: 2, output: 10, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.1 },
  },
};
const T0 = Date.parse('2026-01-01T00:00:00Z');
const ts = (min) => new Date(T0 + min * 60000).toISOString();

function line(reqId, min, usage, model = 'claude-sonnet-5-5') {
  return JSON.stringify({ type: 'assistant', requestId: reqId, uuid: `u-${reqId}-${Math.random()}`, timestamp: ts(min),
    message: { id: `msg-${reqId}`, model, usage } });
}
const U = (input, cc, cr, output, cc1h = 0) => ({
  input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: output,
  cache_creation: { ephemeral_5m_input_tokens: cc - cc1h, ephemeral_1h_input_tokens: cc1h },
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'usage-report-'));
  const session = 'sess-1';
  mkdirSync(join(dir, session, 'subagents'), { recursive: true });
  const write = (name, type, lines) => {
    writeFileSync(join(dir, session, 'subagents', `${name}.jsonl`), lines.join('\n') + '\n');
    writeFileSync(join(dir, session, 'subagents', `${name}.meta.json`), JSON.stringify({ agentType: type }));
  };
  writeFileSync(join(dir, `${session}.jsonl`), [line('m1', 0, U(10, 0, 0, 10))].join('\n') + '\n');
  return { dir, session, write, file: join(dir, `${session}.jsonl`) };
}

test('de-duplicates lines by requestId', () => {
  const f = fixture();
  const u = U(100, 0, 900, 50);
  f.write('agent-a', 'test-writer', [line('r1', 1, u), line('r1', 1, u), line('r2', 2, u)]);
  const rep = buildReport({ sessionFile: f.file, prices: PRICES });
  assert.equal(rep.stages.Build.requests, 2);
  assert.equal(rep.stages.Build.input, 200);
  rmSync(f.dir, { recursive: true });
});

test('stage attribution with a fix loop and namespaced agent types', () => {
  const f = fixture();
  const u = U(10, 0, 90, 10);
  f.write('agent-1', 'ticket-to-merge:test-writer', [line('a', 1, u)]);
  f.write('agent-2', 'ticket-to-merge:implementer', [line('b', 2, u)]);
  f.write('agent-3', 'ticket-to-merge:review-security', [line('c', 3, u)]);
  f.write('agent-4', 'ticket-to-merge:verifier', [line('d', 4, u)]);
  f.write('agent-5', 'ticket-to-merge:implementer', [line('e', 5, u)]);
  f.write('agent-6', 'ticket-to-merge:review-tests', [line('f', 6, u)]);
  f.write('agent-7', 'Explore', [line('g', 7, u)]);
  const rep = buildReport({ sessionFile: f.file, prices: PRICES });
  assert.equal(rep.stages.Build.requests, 2);
  assert.equal(rep.stages.Review.requests, 2);
  assert.equal(rep.stages['Fix loop'].requests, 2);
  assert.equal(rep.stages.Other.requests, 1);
  assert.equal(rep.stages.Orchestration.requests, 1);
  assert.ok(rep.agents.some((a) => a.agent === 'ticket-to-merge:implementer' && a.stage === 'Fix loop'));
  rmSync(f.dir, { recursive: true });
});

test('without any review all implementer runs are Build', () => {
  const f = fixture();
  f.write('agent-1', 'implementer', [line('a', 1, U(1, 0, 0, 1))]);
  f.write('agent-2', 'implementer', [line('b', 2, U(1, 0, 0, 1))]);
  const rep = buildReport({ sessionFile: f.file, prices: PRICES });
  assert.equal(rep.stages.Build.runs, 2);
  assert.equal(rep.stages['Fix loop'].runs, 0);
  rmSync(f.dir, { recursive: true });
});

test('unknown model: cost n/a but tokens counted', () => {
  const f = fixture();
  f.write('agent-1', 'implementer', [line('a', 1, U(5, 0, 5, 7), 'claude-mystery-9')]);
  const rep = buildReport({ sessionFile: f.file, prices: PRICES });
  assert.equal(rep.stages.Build.cost, null);
  assert.equal(rep.stages.Build.input, 5);
  assert.equal(rep.stages.Build.output, 7);
  assert.equal(rep.total.cost, null);
  assert.match(main(['--transcripts', f.dir, '--session', f.session, '--prices', join(f.dir, 'none.json')]), /n\/a/);
  rmSync(f.dir, { recursive: true });
});

test('cache hit = read / (input + cache write + read)', () => {
  const f = fixture();
  f.write('agent-1', 'implementer', [line('a', 1, U(100, 100, 800, 5))]);
  const rep = buildReport({ sessionFile: f.file, prices: PRICES });
  assert.equal(rep.stages.Build.cacheHit, 0.8);
  rmSync(f.dir, { recursive: true });
});

test('cache write priced by 5m and 1h split', () => {
  const r = { model: 'claude-sonnet-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 2e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
  assert.equal(requestCost(PRICES, r), 2.5 + 4);
});

test('prefix price lookup picks the longest matching key', () => {
  const prices = { models: { 'claude-sonnet': { input: 1, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 },
    'claude-sonnet-5': { input: 3, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0 } } };
  assert.equal(requestCost(prices, { model: 'claude-sonnet-5-5-x', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0 }), 3);
});

test('defaults to the most recently modified session', () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'older.jsonl'), line('o1', 0, U(1, 0, 0, 1)) + '\n');
  writeFileSync(join(f.dir, 'newer.jsonl'), line('n1', 0, U(1, 0, 0, 1)) + '\n');
  utimesSync(join(f.dir, 'older.jsonl'), new Date(1000), new Date(1000));
  utimesSync(join(f.dir, f.session + '.jsonl'), new Date(2000), new Date(2000));
  utimesSync(join(f.dir, 'newer.jsonl'), new Date(3000), new Date(3000));
  const out = main(['--transcripts', f.dir]);
  assert.match(out, /Session: newer \(most recent\)/);
  rmSync(f.dir, { recursive: true });
});

test('encodes the project dir like Claude Code', () => {
  assert.equal(encodeProjectDir('/home/gscarv13/Code/BLA/agent_bookshelf-main'), '-home-gscarv13-Code-BLA-agent-bookshelf-main');
});
