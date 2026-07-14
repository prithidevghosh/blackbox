#!/usr/bin/env node
// Autonomous e2e harness (GROUND RULE 3 — definition of done for the core):
//   (a) terminal: script-driven zsh via `blackbox record`, canned commands incl.
//       a failure with distinctive output
//   (b) agent: replay the claude-code fixture into the watched dir with live
//       appends while the daemon runs
//   (c) git: scripted repo, branch fix/PROJ-123-redis-auth, hooked commit
// Then: daemon ingests -> `ask` retrieves the failure via a SEMANTIC query using
// different words -> `rca PROJ-123` timeline contains all three sources.
// Runs against the real Supermemory Local on :6767 with an isolated
// containerTag + BLACKBOX_HOME. No human input anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(root, 'cli', 'blackbox.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN_TAG = `blackbox-e2e-${Date.now()}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-e2e-'));
const bbHome = path.join(work, 'bbhome');
const agentDir = path.join(work, 'agent-projects');
const repoDir = path.join(work, 'payments-worker');
const env = { ...process.env, BLACKBOX_HOME: bbHome, BLACKBOX_DISABLE: '' };

let failures = 0;
let daemon = null;
function check(name, ok, detail = '') {
  const mark = ok ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', env, ...opts });
}

async function waitFor(cond, { timeoutMs = 120_000, stepMs = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await cond()) return true;
    } catch {}
    await sleep(stepMs);
  }
  console.error(`   timed out waiting for ${label}`);
  return false;
}

async function api(pathname, body) {
  const res = await fetch(`http://localhost:6767${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`\nblackbox e2e — tag ${RUN_TAG}\n${'─'.repeat(60)}`);

  // ── preflight ────────────────────────────────────────────────
  const smUp = await fetch('http://localhost:6767/', { signal: AbortSignal.timeout(2000) })
    .then((r) => r.status < 500)
    .catch(() => false);
  if (!smUp) {
    console.error('Supermemory Local is not running on :6767 — start it first (see README quickstart).');
    process.exit(2);
  }

  // isolated blackbox home + config pointing the agent watcher at our replay dir
  fs.mkdirSync(bbHome, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(bbHome, 'config.json'),
    JSON.stringify(
      {
        containerTag: RUN_TAG,
        agents: { 'claude-code': { dir: agentDir, enabled: true }, codex: { enabled: false } },
      },
      null,
      2
    )
  );

  // ── (c) git: scripted repo with ticket branch and hooked commit ──
  console.log('\n[stage git]');
  fs.mkdirSync(repoDir);
  const git = (...a) => sh('git', a, { cwd: repoDir });
  git('init', '-b', 'main');
  git('config', 'user.email', 'e2e@blackbox.local');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(repoDir, 'cache.js'), 'export const client = connect();\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('checkout', '-b', 'fix/PROJ-123-redis-auth');
  sh('node', [cli, 'init'], { cwd: repoDir });
  fs.writeFileSync(
    path.join(repoDir, 'cache.js'),
    'export const client = connect({ password: process.env.REDIS_PASSWORD });\n'
  );
  git('add', '.');
  git('commit', '-m', 'fix: PROJ-123 pass redis password to cache client');
  const spoolNew = path.join(bbHome, 'spool', 'new');
  const gitSpooled = fs.readdirSync(spoolNew).length;
  check('git commit spooled via post-commit hook', gitSpooled >= 1, `${gitSpooled} event(s)`);

  // ── (a) terminal: script-driven recorded shell with a distinctive failure ──
  console.log('\n[stage terminal]');
  // NB: must be a real shell pipe (FIFO) — macOS script(1) rejects the
  // socketpairs Node uses for stdio:'pipe'. The sleeps pace input like a human:
  // zsh must finish sourcing rc files (hooks install last) before the first command.
  const driver = [
    'sleep 4',
    `printf '%s\\n' 'echo deploying payments worker'`,
    'sleep 1.2',
    // distinctive failure with output on stderr AND stdout, exit 12
    `printf '%s\\n' 'sh -c "echo \\"(error) NOAUTH Authentication required.\\" >&2; echo \\"redis connection refused for worker\\"; exit 12"'`,
    'sleep 1.2',
    `printf 'exit\\n'`,
    'sleep 0.5',
  ].join('; ');
  await new Promise((resolve) => {
    const rec = spawn('sh', ['-c', `{ ${driver}; } | node ${JSON.stringify(cli)} record`], {
      cwd: repoDir,
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    rec.on('exit', resolve);
    setTimeout(() => rec.kill('SIGKILL'), 40_000).unref();
  });
  const termEvents = fs
    .readdirSync(spoolNew)
    .map((f) => JSON.parse(fs.readFileSync(path.join(spoolNew, f), 'utf8')))
    .filter((e) => e.source === 'terminal');
  const failEv = termEvents.find((e) => e.exit_code === 12);
  check('terminal commands recorded with output', termEvents.length >= 2, `${termEvents.length} events`);
  check('failure event captured (exit 12 + NOAUTH output)', !!failEv && /NOAUTH Authentication required/.test(failEv.output || ''));

  // ── daemon up (agent watcher + ingest) ───────────────────────
  console.log('\n[stage daemon + agent replay]');
  daemon = spawn('node', [cli, 'ingest-daemon'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  await sleep(1500); // watcher initial scan

  // ── (b) agent: replay fixture with live appends ──────────────
  const fixture = fs
    .readFileSync(path.join(root, 'test', 'fixtures', 'claude-code', 'session.jsonl'), 'utf8')
    .replaceAll('{{CWD}}', repoDir);
  const sessDir = path.join(agentDir, 'payments-worker-project');
  fs.mkdirSync(sessDir, { recursive: true });
  const sessFile = path.join(sessDir, 'e2e-session.jsonl');
  // simulate live writing: append line-groups with pauses, split one line mid-way
  const flines = fixture.split('\n').filter(Boolean);
  const mid = flines[4];
  fs.appendFileSync(sessFile, flines.slice(0, 4).join('\n') + '\n' + mid.slice(0, 50));
  await sleep(700);
  fs.appendFileSync(sessFile, mid.slice(50) + '\n');
  await sleep(700);
  fs.appendFileSync(sessFile, flines.slice(5).join('\n') + '\n');

  // ── ingestion: spool drains, docs reach status done ──────────
  console.log('\n[stage ingest]');
  const drained = await waitFor(() => fs.readdirSync(spoolNew).length === 0, {
    timeoutMs: 90_000,
    label: 'spool to drain',
  });
  check('daemon drained the spool', drained, drained ? '' : `${fs.readdirSync(spoolNew).length} left`);

  const EXPECTED_MIN = 7; // 1 git + 2 terminal + 4 agent
  const allDone = await waitFor(
    async () => {
      const list = await api('/v3/documents/list', { containerTags: [RUN_TAG], limit: 50 });
      const docs = list.memories || [];
      return docs.length >= EXPECTED_MIN && docs.every((d) => d.status === 'done' || d.status === 'failed');
    },
    { timeoutMs: 300_000, stepMs: 3000, label: 'documents processed' }
  );
  const list = await api('/v3/documents/list', { containerTags: [RUN_TAG], limit: 50 });
  const docs = list.memories || [];
  check('all documents processed by supermemory', allDone, `${docs.length} docs (expected ≥${EXPECTED_MIN})`);
  const bySource = { terminal: 0, agent: 0, git: 0 };
  for (const d of docs) bySource[d.metadata?.source] = (bySource[d.metadata?.source] || 0) + 1;
  check(
    'all three sources present in the store',
    bySource.terminal >= 2 && bySource.agent >= 3 && bySource.git >= 1,
    JSON.stringify(bySource)
  );
  check(
    'correlation: docs tagged with repo + ticket',
    docs.some((d) => d.metadata?.ticket === 'PROJ-123' && d.metadata?.repo === 'payments-worker')
  );

  // ── THE ask assertion: semantic query, different words ────────
  console.log('\n[stage ask]');
  const searchRes = await api('/v3/search', {
    q: 'authentication problem with redis',
    containerTags: [RUN_TAG],
    limit: 5,
  });
  const hits = searchRes.results || [];
  const failureHit = hits.find(
    (r) =>
      /NOAUTH Authentication required/.test(r.chunks?.map((c) => c.content).join('\n') || '') ||
      /NOAUTH Authentication required/.test(r.title || '')
  );
  check(
    "semantic ask: 'authentication problem with redis' retrieves the NOAUTH failure",
    !!failureHit,
    failureHit ? `score ${failureHit.score?.toFixed(3)}` : `top titles: ${hits.map((h) => h.title?.slice(0, 40)).join(' | ')}`
  );

  // CLI-level check too (rendered output)
  const askOut = sh('node', [cli, 'ask', 'authentication problem with redis', '--limit', '5']);
  check('blackbox ask CLI renders the failure with source badge', /NOAUTH/.test(askOut) && /\[terminal\]/.test(askOut));

  // ── rca assertion (full rule-3) ───────────────────────────────
  if (process.env.E2E_THROUGH === 'ask') {
    console.log('\n[stage rca] skipped (E2E_THROUGH=ask)');
    return;
  }
  console.log('\n[stage rca]');
  let rcaOut = '';
  try {
    rcaOut = sh('node', [cli, 'rca', 'PROJ-123', '--no-llm'], { cwd: repoDir });
  } catch (err) {
    rcaOut = String(err.stdout || '') + String(err.stderr || '');
  }
  const hasTerminal = /\[terminal\]/.test(rcaOut) && /NOAUTH/.test(rcaOut);
  const hasAgent = /\[agent/.test(rcaOut);
  const hasGit = /\[git\]/.test(rcaOut) && /pass redis password/.test(rcaOut);
  check('rca timeline contains terminal source', hasTerminal);
  check('rca timeline contains agent source', hasAgent);
  check('rca timeline contains git source', hasGit);

  console.log(`\n${'─'.repeat(60)}`);
  if (failures === 0) console.log('E2E: ALL ASSERTIONS PASSED');
  else console.log(`E2E: ${failures} assertion(s) FAILED`);
}

main()
  .catch((err) => {
    console.error('e2e crashed:', err);
    failures++;
  })
  .finally(async () => {
    if (daemon) daemon.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  });
