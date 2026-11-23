// SubagentStop done-gate: the implementer may not stop while the build or the suite is red.
// Fails OPEN on any internal error. Never writes into the project.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_BLOCKS = 3;
const STATE_DIR = '/tmp/t2m-gate';
const BLOCK_MSG = "Done-gate (ticket-to-merge): the build or tests are red. Keep fixing application code; tests/ is read-only. If a test is wrong, stop with STATUS: blocked and say why.";
const GIVE_UP_MSG = "Done-gate gave up after 3 attempts; the recipe's own done-gate will report the red suite.";

const safe = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_');

function counterFile(input) {
  return path.join(STATE_DIR, `${safe(input.session_id)}__${safe(input.agent_id)}.count`);
}
function readCount(file) {
  try { return parseInt(fs.readFileSync(file, 'utf8'), 10) || 0; } catch { return 0; }
}
function writeCount(file, n) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, String(n));
}

function npmRun(script, cwd) {
  const r = spawnSync('npm', ['run', script], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) {
    process.stderr.write(`Done-gate warning: unreadable input (${e.message}); failing open.\n`);
    return 0;
  }
  const agent = typeof input?.agent_type === 'string' ? input.agent_type : '';
  if (agent.split(':').pop() !== 'implementer') return 0;

  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!root) {
    process.stderr.write('Done-gate warning: no project root; failing open.\n');
    return 0;
  }

  const file = counterFile(input);
  const blocks = readCount(file);
  if (blocks >= MAX_BLOCKS) {
    process.stderr.write(`${GIVE_UP_MSG}\n`);
    return 0;
  }

  for (const script of ['build', 'test:run']) {
    const { ok, output } = npmRun(script, root);
    if (!ok) {
      writeCount(file, blocks + 1);
      const tail = output.split('\n').slice(-40).join('\n');
      process.stderr.write(`${BLOCK_MSG}\n${tail}\n`);
      return 2;
    }
  }
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  process.stderr.write(`Done-gate warning: internal error (${e.message}); failing open.\n`);
  process.exit(0);
}
