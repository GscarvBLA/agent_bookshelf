#!/usr/bin/env node
// Capstone cost report: per stage cost, cache hit % and models, from Claude Code's local transcripts.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGES = ['Build', 'Review', 'Fix loop', 'Orchestration', 'Other'];

export function encodeProjectDir(p) {
  return resolve(p).replace(/[^a-zA-Z0-9]/g, '-');
}

export function loadPrices(file = join(HERE, 'prices.json')) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function priceFor(prices, model) {
  const table = prices?.models ?? {};
  if (table[model]) return table[model];
  const key = Object.keys(table)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

function readJsonl(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

// One API request spans several lines with the same usage: keep one per request id.
export function parseTranscript(file) {
  const byId = new Map();
  let start = Infinity;
  for (const e of readJsonl(file)) {
    const t = Date.parse(e.timestamp);
    if (!Number.isNaN(t) && t < start) start = t;
    const u = e.message?.usage;
    if (e.type !== 'assistant' || !u || e.message.model === '<synthetic>') continue;
    const id = e.requestId ?? e.message.id ?? e.uuid;
    const prev = byId.get(id);
    if (prev && prev.output >= (u.output_tokens ?? 0)) continue;
    const cc = u.cache_creation_input_tokens ?? 0;
    const w1h = Math.min(u.cache_creation?.ephemeral_1h_input_tokens ?? 0, cc);
    byId.set(id, {
      model: e.message.model ?? 'unknown',
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: cc,
      cacheWrite1h: w1h,
      cacheWrite5m: cc - w1h,
      cacheRead: u.cache_read_input_tokens ?? 0,
    });
  }
  return { start: Number.isFinite(start) ? start : 0, requests: [...byId.values()] };
}

export function requestCost(prices, r) {
  let p = priceFor(prices, r.model);
  if (!p) return null;
  if (p.long_context && r.input + r.cacheWrite + r.cacheRead > p.long_context.over_tokens) p = p.long_context;
  return (r.input * p.input + r.output * p.output + r.cacheWrite5m * p.cache_write_5m
    + r.cacheWrite1h * p.cache_write_1h + r.cacheRead * p.cache_read) / 1e6;
}

function emptyTotals() {
  return { runs: 0, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, unpriced: 0, models: new Set() };
}

function addRun(t, prices, run) {
  t.runs += 1;
  for (const r of run.requests) {
    t.requests += 1;
    t.input += r.input; t.cacheWrite += r.cacheWrite; t.cacheRead += r.cacheRead; t.output += r.output;
    t.models.add(r.model);
    const c = requestCost(prices, r);
    if (c === null) t.unpriced += 1; else t.cost += c;
  }
}

function finish(t) {
  const denom = t.input + t.cacheWrite + t.cacheRead;
  return {
    runs: t.runs, requests: t.requests, input: t.input, cacheWrite: t.cacheWrite,
    cacheRead: t.cacheRead, output: t.output,
    cost: t.unpriced > 0 ? null : t.cost,
    unpricedRequests: t.unpriced,
    cacheHit: denom > 0 ? t.cacheRead / denom : null,
    models: [...t.models].sort(),
  };
}

export const agentSuffix = (type) => String(type ?? 'unknown').split(':').pop();
const isReviewer = (s) => s.startsWith('review-') || s === 'verifier';

export function assignStages(runs) {
  const reviewStarts = runs.filter((r) => isReviewer(r.suffix)).map((r) => r.start);
  const firstReview = reviewStarts.length ? Math.min(...reviewStarts) : Infinity;
  const fixStarts = runs.filter((r) => r.suffix === 'implementer' && r.start > firstReview).map((r) => r.start);
  const firstFix = fixStarts.length ? Math.min(...fixStarts) : Infinity;
  for (const r of runs) {
    if (r.suffix === 'test-writer') r.stage = 'Build';
    else if (r.suffix === 'implementer') r.stage = r.start < firstReview ? 'Build' : 'Fix loop';
    else if (isReviewer(r.suffix)) r.stage = r.start < firstFix ? 'Review' : 'Fix loop';
    else r.stage = 'Other';
  }
  return runs;
}

export function buildReport({ sessionFile, prices }) {
  const sessionDir = sessionFile.replace(/\.jsonl$/, '');
  const subDir = join(sessionDir, 'subagents');
  const runs = [];
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((n) => n.endsWith('.jsonl')).sort()) {
      let meta = {};
      try { meta = JSON.parse(readFileSync(join(subDir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')); } catch { /* no meta */ }
      const parsed = parseTranscript(join(subDir, f));
      const type = meta.agentType ?? 'unknown';
      runs.push({ type, suffix: agentSuffix(type), ...parsed });
    }
  }
  assignStages(runs);
  const main = parseTranscript(sessionFile);

  const stageTotals = Object.fromEntries(STAGES.map((s) => [s, emptyTotals()]));
  const agentTotals = new Map();
  for (const r of runs) {
    addRun(stageTotals[r.stage], prices, r);
    const key = `${r.stage}\u0000${r.type}`;
    if (!agentTotals.has(key)) agentTotals.set(key, { stage: r.stage, type: r.type, t: emptyTotals() });
    addRun(agentTotals.get(key).t, prices, r);
  }
  addRun(stageTotals.Orchestration, prices, main);

  const total = emptyTotals();
  for (const t of Object.values(stageTotals)) {
    for (const k of ['runs', 'requests', 'input', 'cacheWrite', 'cacheRead', 'output', 'cost', 'unpriced']) total[k] += t[k];
    t.models.forEach((m) => total.models.add(m));
  }
  return {
    session: sessionFile,
    stages: Object.fromEntries(STAGES.map((s) => [s, finish(stageTotals[s])])),
    agents: [...agentTotals.values()].map((a) => ({ stage: a.stage, agent: a.type, ...finish(a.t) })),
    total: finish(total),
  };
}

const money = (c) => (c === null ? 'n/a' : `$${c.toFixed(2)}`);
const pct = (h) => (h === null ? 'n/a' : `${Math.round(h * 100)}%`);
const num = (n) => n.toLocaleString('en-US');

export function renderMarkdown(rep) {
  const L = ['| Stage | Cost | Cache hit | Models |', '|---|---|---|---|'];
  for (const s of STAGES) {
    const t = rep.stages[s];
    if (s === 'Other' && t.requests === 0) continue;
    L.push(`| ${s} | ${money(t.cost)} | ${pct(t.cacheHit)} | ${t.models.join(', ')} |`);
  }
  L.push(`| Total, one ticket | ${money(rep.total.cost)} | ${pct(rep.total.cacheHit)} | |`, '');
  L.push('| Stage | Agent | Runs | Requests | Input | Cache write | Cache read | Output | Cost |', '|---|---|---|---|---|---|---|---|---|');
  const rows = [...rep.agents, { stage: 'Orchestration', agent: 'main session', ...rep.stages.Orchestration, runs: 1 }];
  rows.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
  for (const a of rows) {
    if (a.requests === 0 && a.agent === 'main session') continue;
    L.push(`| ${a.stage} | ${a.agent} | ${a.runs} | ${a.requests} | ${num(a.input)} | ${num(a.cacheWrite)} | ${num(a.cacheRead)} | ${num(a.output)} | ${money(a.cost)} |`);
  }
  const t = rep.total;
  L.push('', `Totals: ${t.requests} unique requests, input ${num(t.input)}, cache write ${num(t.cacheWrite)}, cache read ${num(t.cacheRead)}, output ${num(t.output)}, cost ${money(t.cost)}, cache hit ${pct(t.cacheHit)}.`);
  if (t.unpricedRequests) L.push(`Cost is n/a: ${t.unpricedRequests} request(s) used a model missing from prices.json.`);
  return L.join('\n');
}

function parseArgs(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (['--session', '--project', '--transcripts', '--prices'].includes(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function latestSession(dir) {
  const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
    .map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.m - a.m);
  if (!files.length) throw new Error(`no session transcripts in ${dir}`);
  return files[0].n.replace(/\.jsonl$/, '');
}

export function main(argv) {
  const o = parseArgs(argv);
  const dir = o.transcripts
    ? resolve(o.transcripts)
    : join(homedir(), '.claude', 'projects', encodeProjectDir(o.project ?? process.cwd()));
  if (!existsSync(dir)) throw new Error(`transcript dir not found: ${dir} (pass --transcripts <dir>)`);
  const session = o.session ?? latestSession(dir);
  const sessionFile = join(dir, `${session}.jsonl`);
  if (!existsSync(sessionFile)) throw new Error(`session transcript not found: ${sessionFile}`);
  const pricesFile = o.prices ?? join(HERE, 'prices.json');
  const prices = existsSync(pricesFile) ? loadPrices(pricesFile) : { models: {} };
  const rep = buildReport({ sessionFile, prices });
  if (o.json) return JSON.stringify(rep, null, 2);
  return `Session: ${session}${o.session ? '' : ' (most recent)'}\n\n${renderMarkdown(rep)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`usage-report: ${e.message}`);
    process.exit(1);
  }
}
