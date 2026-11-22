#!/usr/bin/env node
// Planted-bug eval harness for /ticket-to-merge:review-pr.
// Usage: node ticket-to-merge/evals/run.mjs --case <id|combined> [--runs N] [--model sonnet] [--dry-run] [--keep] [--evals-dir <path>] [--no-spec]
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_EVALS_DIR = dirname(fileURLToPath(import.meta.url));
const FORK_DIR = resolve(PLUGIN_EVALS_DIR, '..', '..');
const TMP_ROOT = '/tmp/t2m-eval';
const LINE_TOLERANCE = 3;

// ---------- matcher (pure, unit-tested) ----------

export function extractFindings(text) {
  const blocks = [...String(text ?? '').matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return { findings: [], error: 'no json block in result' };
  try {
    const parsed = JSON.parse(blocks[blocks.length - 1][1]);
    if (!Array.isArray(parsed)) return { findings: [], error: 'last json block is not an array' };
    return { findings: parsed, error: null };
  } catch (e) {
    return { findings: [], error: `json parse failed: ${e.message}` };
  }
}

function fileMatches(findingFile, expectedFile) {
  const f = String(findingFile ?? '').replace(/^\.\//, '');
  return f !== '' && (f === expectedFile || f.endsWith('/' + expectedFile) || expectedFile.endsWith('/' + f));
}

function scoreAgainst(finding, exp) {
  if (!fileMatches(finding.file, exp.file)) return 0;
  const line = Number(finding.line);
  const [start, end] = exp.lines;
  const lineHit = Number.isFinite(line) && line >= start - LINE_TOLERANCE && line <= end + LINE_TOLERANCE;
  const text = `${finding.issue ?? ''} ${finding.evidence ?? ''}`.toLowerCase();
  const keywordHit = (exp.keywords ?? []).some((k) => text.includes(k.toLowerCase()));
  return (lineHit ? 1 : 0) + (keywordHit ? 2 : 0);
}

// Returns one label per finding: { label: 'TP'|'duplicate'|'needs-judgement', bug? }.
// Highest score wins (keyword hit outranks line hit); ties go to a bug not yet matched.
export function matchFindings(findings, expected) {
  const matched = new Set();
  return findings.map((finding) => {
    let best = null;
    for (const exp of expected) {
      const score = scoreAgainst(finding, exp);
      if (score === 0) continue;
      const free = !matched.has(exp.bug);
      if (!best || score > best.score || (score === best.score && free && !best.free)) {
        best = { exp, score, free };
      }
    }
    if (!best) return { label: 'needs-judgement' };
    if (!best.free) return { label: 'duplicate', bug: best.exp.bug };
    matched.add(best.exp.bug);
    return { label: 'TP', bug: best.exp.bug };
  });
}

export function labelText(l) {
  return l.label === 'needs-judgement' ? 'needs-judgement' : l.label === 'TP' ? `TP:${l.bug}` : `duplicate:${l.bug}`;
}

// ---------- helpers ----------

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  }
  return r;
}

const git = (repo, ...args) => sh('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', ...args], { cwd: repo });

function parseArgs(argv) {
  const o = { runs: 1, model: 'sonnet', dryRun: false, keep: false, case: null, evalsDir: PLUGIN_EVALS_DIR, noSpec: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--case') o.case = argv[++i];
    else if (a === '--runs') o.runs = Number(argv[++i]);
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--no-spec') o.noSpec = true;
    else if (a === '--evals-dir') {
      const v = argv[++i];
      if (!v) throw new Error('--evals-dir requires a path');
      o.evalsDir = resolve(v);
    }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.case) throw new Error('--case <id|combined> is required');
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error('--runs must be a positive integer');
  return o;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ---------- per-run sandbox ----------

// Reads manifest.json from evalsDir; case patch paths are resolved against it. `concern`, `includes` and `clean` are optional.
export function loadManifest(evalsDir) {
  const manifest = JSON.parse(readFileSync(join(evalsDir, 'manifest.json'), 'utf8'));
  const cases = (manifest.cases ?? []).map((c) => ({
    ...c,
    patchPath: join(evalsDir, c.patch),
    expected: c.expected ?? [],
    clean: c.clean ?? [],
  }));
  return { ...manifest, cases };
}

function prepareRun(runDir, testCase, noSpec) {
  const repo = join(runDir, 'repo');
  mkdirSync(runDir, { recursive: true });
  sh('git', ['clone', '-q', '-b', 'book-101', FORK_DIR, repo]);
  // Ensure local main (clone only has origin/main), then cut every link back to the fork.
  if (sh('git', ['rev-parse', '--verify', '-q', 'main'], { cwd: repo, allowFail: true }).status !== 0) {
    git(repo, 'branch', 'main', 'origin/main');
  }
  git(repo, 'remote', 'remove', 'origin');
  // Scrub the eval answers (manifest, patches) from history so `git log -p` cannot reveal them.
  sh('git', ['filter-branch', '-f', '--prune-empty', '--index-filter',
    'git rm -r -q --cached --ignore-unmatch ticket-to-merge/evals', '--', 'main..book-101'],
  { cwd: repo, env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.invalid' } });
  rmSync(join(repo, '.git', 'refs', 'original'), { recursive: true, force: true });
  git(repo, 'reflog', 'expire', '--expire=now', '--all');
  git(repo, 'gc', '-q', '--prune=now');

  // Plugin copy (committed content, evals already scrubbed) taken before the plugin is removed from the tree.
  const plugin = join(runDir, 'plugin');
  cpSync(join(repo, 'ticket-to-merge'), plugin, { recursive: true });

  git(repo, 'rm', '-r', '-q', 'ticket-to-merge');
  if (noSpec) git(repo, 'rm', '-q', 'SPEC.md');
  git(repo, 'commit', '-q', '-m', noSpec ? 'eval: remove plugin and spec from tree' : 'eval: remove plugin from tree');

  for (const p of [join(PLUGIN_EVALS_DIR, 'base.patch'), testCase.patchPath]) git(repo, 'apply', p);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'BOOK-101: implement search');

  sh('npm', ['ci'], { cwd: repo });

  return { repo, plugin };
}

function checkSandbox(repo, testCase, noSpec) {
  const problems = [];
  if (existsSync(join(repo, 'ticket-to-merge'))) problems.push('ticket-to-merge/ exists in the clone');
  const names = git(repo, 'diff', '--name-only', 'main...HEAD').stdout.split('\n').filter(Boolean);
  if (names.length === 0) problems.push('reviewed range main...HEAD is empty');
  if (names.some((n) => n.startsWith('ticket-to-merge/'))) problems.push('reviewed range includes plugin files');
  if (noSpec && existsSync(join(repo, 'SPEC.md'))) problems.push('SPEC.md exists in the clone');
  if (noSpec && names.includes('SPEC.md')) problems.push('reviewed range includes SPEC.md');
  if (git(repo, 'status', '--porcelain').stdout.trim() !== '') problems.push('working tree is not clean');
  if (git(repo, 'log', '--all', '--format=%H', '--', 'ticket-to-merge/evals').stdout.trim() !== '') {
    problems.push('evals/ still reachable in history');
  }
  const stat = git(repo, 'diff', '--stat', 'main...HEAD').stdout;
  // Verify every manifest location really contains its anchor.
  const anchors = [];
  for (const e of testCase.expected ?? []) {
    const lines = readFileSync(join(repo, e.file), 'utf8').split('\n');
    const text = lines.slice(e.lines[0] - 1, e.lines[1]).join('\n');
    const ok = text.includes(e.anchor);
    anchors.push({ bug: e.bug, file: e.file, lines: e.lines, anchor: e.anchor, ok, text: text.trim() });
    if (!ok) problems.push(`${e.bug}: anchor not found at ${e.file}:${e.lines.join('-')}`);
  }
  return { problems, stat, names, anchors };
}

function runTests(repo) {
  const r = sh('sh', ['-c', 'npm run build && npm run test:run'], { cwd: repo, allowFail: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const m = out.match(/Tests\s+(.*)/);
  return { ok: r.status === 0, summary: m ? m[1].trim() : 'no test summary', output: out };
}

function parseResult(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (e) {
    return { sessionId: null, cost: null, models: [], findings: [], error: `stdout is not JSON: ${e.message}` };
  }
  const { findings, error } = extractFindings(envelope.result);
  return {
    sessionId: envelope.session_id ?? null,
    cost: envelope.total_cost_usd ?? null,
    models: Object.keys(envelope.modelUsage ?? {}),
    findings,
    error,
  };
}

// ---------- reports ----------

function buildReports(testCase, runs, noSpec) {
  const bugs = [...new Set((testCase.expected ?? []).map((e) => e.bug))];
  const rows = [];
  for (const r of runs) {
    r.labels.forEach((l, i) => rows.push({ run: r.run, finding: r.findings[i], label: l }));
  }
  const tp = rows.filter((r) => r.label.label === 'TP').length;
  const dup = rows.filter((r) => r.label.label === 'duplicate').length;
  const nj = rows.filter((r) => r.label.label === 'needs-judgement').length;
  const found = (bug, run) => run.labels.some((l) => l.label === 'TP' && l.bug === bug);
  const hits = runs.reduce((n, r) => n + bugs.filter((b) => found(b, r)).length, 0);
  const total = bugs.length * runs.length;
  const summary = {
    case: testCase.id,
    kind: testCase.kind,
    spec: noSpec ? 'none' : 'present',
    clean: testCase.clean ?? [],
    runs: runs.length,
    bugs,
    matrix: Object.fromEntries(bugs.map((b) => [b, runs.map((r) => found(b, r))])),
    recall: total ? hits / total : null,
    findings: rows.length,
    tp,
    duplicate: dup,
    needsJudgement: nj,
    provisionalPrecision: rows.length ? tp / rows.length : null,
    perRun: runs.map((r) => ({ run: r.run, sessionId: r.sessionId, cost: r.cost, models: r.models, findings: r.findings.length, error: r.error })),
    totalCost: runs.reduce((n, r) => n + (r.cost ?? 0), 0),
  };

  const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const ledger = [
    `# Ledger: ${testCase.id}`,
    '',
    'Labels: TP:<bug> | duplicate:<bug> | needs-judgement. Edit the Label column by hand, then recompute precision (see README).',
    '',
    '| Run | Location | Severity | Issue | Label |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.run} | ${esc(r.finding.file)}:${esc(r.finding.line)} | ${esc(r.finding.severity)} | ${esc(r.finding.issue)} | ${labelText(r.label)} |`),
    '',
  ].join('\n');

  const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const md = [
    `# Summary: ${testCase.id} (${testCase.kind}), ${runs.length} run(s)`,
    `Spec: ${noSpec ? 'none' : 'present'}`,
    '',
    ...(testCase.clean?.length
      ? ['## Clean regions (not matched)', '', ...testCase.clean.map((c) => `- ${c.id} (${c.file}): ${c.description}`), '']
      : []),
    '## Bug x run',
    '',
    bugs.length
      ? ['| Bug | ' + runs.map((r) => `run${r.run}`).join(' | ') + ' |', '|---|' + runs.map(() => '---').join('|') + '|',
        ...bugs.map((b) => `| ${b} | ` + runs.map((r) => (found(b, r) ? 'found' : 'missed')).join(' | ') + ' |')].join('\n')
      : 'No planted bugs in this case (clean case): every finding is a false-positive candidate.',
    '',
    `Auto recall: ${total ? `${hits}/${total} = ${pct(summary.recall)}` : 'n/a'}`,
    '',
    '## Precision (provisional)',
    '',
    `- Findings: ${rows.length}`,
    `- TP (auto-matched): ${tp}`,
    `- duplicate (same bug again): ${dup}`,
    `- needs-judgement (not yet judged): ${nj}`,
    `- Provisional precision = TP / all findings = ${pct(summary.provisionalPrecision)}. Final precision needs the needs-judgement rows labelled by hand.`,
    '',
    '## Cost and models',
    '',
    '| Run | Session | Cost (USD) | Models | Findings | Parse error |',
    '|---|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.run} | ${r.sessionId ?? ''} | ${r.cost ?? ''} | ${r.models.join(', ')} | ${r.findings.length} | ${r.error ?? ''} |`),
    '',
    `Total cost: ${summary.totalCost.toFixed(4)} USD`,
    '',
  ].join('\n');
  return { ledger, md, summary };
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(opts.evalsDir);
  const testCase = manifest.cases.find((c) => c.id === opts.case);
  if (!testCase) throw new Error(`unknown case "${opts.case}". Known: ${manifest.cases.map((c) => c.id).join(', ')}`);

  const ts = stamp();
  const outDir = join(opts.evalsDir, 'results', ts);
  const runs = [];
  let failed = false;

  for (let k = 1; k <= opts.runs; k++) {
    const runDir = join(TMP_ROOT, `${testCase.id}-${ts}-run${k}`);
    try {
      console.log(`== ${testCase.id} run ${k}: preparing ${runDir}`);
      const { repo, plugin } = prepareRun(runDir, testCase, opts.noSpec);
      const check = checkSandbox(repo, testCase, opts.noSpec);
      if (opts.dryRun) {
        const t = runTests(repo);
        console.log(`reviewed range main...HEAD:\n${check.stat}`);
        for (const a of check.anchors) console.log(`  ${a.ok ? 'ok' : 'MISSING'} ${a.bug} ${a.file}:${a.lines.join('-')}  ${a.text}`);
        console.log(`plugin absent from clone: ${!existsSync(join(repo, 'ticket-to-merge'))}`);
        console.log(`spec: ${opts.noSpec ? 'none' : 'present'}; SPEC.md on disk: ${existsSync(join(repo, 'SPEC.md'))}; in reviewed range: ${check.names.includes('SPEC.md')}`);
        console.log(`tests: ${t.ok ? 'GREEN' : 'RED'} (${t.summary})`);
        if (check.problems.length || !t.ok) {
          failed = true;
          console.error(`PROBLEMS: ${[...check.problems, ...(t.ok ? [] : ['build/tests failed'])].join('; ')}`);
        }
        continue;
      }
      if (check.problems.length) throw new Error(`sandbox invalid: ${check.problems.join('; ')}`);

      console.log(`== run ${k}: reviewing with claude (model ${opts.model})`);
      const r = sh('claude', ['-p', '/ticket-to-merge:review-pr', '--plugin-dir', plugin, '--model', opts.model,
        '--allowedTools', 'Bash Read Grep Glob Agent', '--output-format', 'json'],
      { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], allowFail: true });
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `${testCase.id}-run${k}.json`), r.stdout ?? '');
      const parsed = parseResult(r.stdout ?? '');
      if (r.status !== 0 && !parsed.error) parsed.error = `claude exited ${r.status}`;
      const labels = matchFindings(parsed.findings, testCase.expected ?? []);
      runs.push({ run: k, ...parsed, labels });
    } catch (e) {
      failed = true;
      console.error(`run ${k} failed: ${e.message}`);
    } finally {
      if (!opts.keep) rmSync(runDir, { recursive: true, force: true });
      else console.log(`kept ${runDir}`);
    }
  }

  if (!opts.dryRun && runs.length) {
    const { ledger, md, summary } = buildReports(testCase, runs, opts.noSpec);
    writeFileSync(join(outDir, 'ledger.md'), ledger);
    writeFileSync(join(outDir, 'summary.md'), md);
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`results: ${outDir}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
