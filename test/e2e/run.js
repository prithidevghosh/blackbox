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

// Supermemory Local to test against — override when :6767 is occupied
const SM_URL = process.env.BLACKBOX_E2E_BASEURL || 'http://localhost:6767';
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
  const res = await fetch(`${SM_URL}${pathname}`, {
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
  const smUp = await fetch(`${SM_URL}/`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.status < 500)
    .catch(() => false);
  if (!smUp) {
    console.error(`Supermemory Local is not running at ${SM_URL} — start it first (see README quickstart).`);
    process.exit(2);
  }

  // A busy shared instance starves this run's documents: each document costs
  // ~40-60s of local-LLM "memory agent" time with 2 workers, so a backlog of N
  // docs delays ours by ~N/2 minutes — far past our timeouts. Fail fast with a
  // real message instead of three cryptic assertion timeouts (DECISIONS.md D8).
  const backlog = await api('/v3/documents/list', { limit: 200 });
  const busy = (backlog.memories || []).filter((d) => d.status !== 'done' && d.status !== 'failed').length;
  if (busy > 6) {
    console.error(`Supermemory Local is still processing ${busy} documents — this run's documents would queue behind them (~${Math.ceil(busy / 2)} min).`);
    console.error('Pause your capture while it drains (blackbox ingest-daemon --stop; events wait in the spool), then re-run. Progress: tail -f ~/.blackbox/supermemory.log');
    process.exit(2);
  }

  // isolated blackbox home + config pointing the agent watcher at our replay dir
  fs.mkdirSync(bbHome, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(bbHome, 'config.json'),
    JSON.stringify(
      {
        baseURL: SM_URL,
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

  // guard seed: the failure the agent will be warned about (npm binary so the
  // guard's binary/subcommand gate has something real to match)
  const guardSeedTs = new Date(Date.now() - 2 * 86_400_000); // "Tuesday's failure"
  sh('node', [cli, '_spool', JSON.stringify({
    source: 'terminal',
    command: 'npm run dev',
    output: '(error) NOAUTH Authentication required.\nredis connection refused for worker',
    exit_code: 12,
    cwd: repoDir,
    session: 'record-e2e-guard-seed',
    ts: guardSeedTs.toISOString(),
    ts_epoch: Math.floor(guardSeedTs.getTime() / 1000),
  })]);

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

  const EXPECTED_MIN = 8; // 1 git + 2 terminal + 1 guard seed + 4 agent
  const allDone = await waitFor(
    async () => {
      const list = await api('/v3/documents/list', { containerTags: [RUN_TAG], limit: 50 });
      const docs = list.memories || [];
      return docs.length >= EXPECTED_MIN && docs.every((d) => d.status === 'done' || d.status === 'failed');
    },
    { timeoutMs: 900_000, stepMs: 3000, label: 'documents processed' } // 8 docs × ~60s+ of local-LLM memory-agent time, measured; later stages need a quiet machine
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

  // ── flashback (M8b): proactive hint on a repeated failure ─────
  // Trials drive the real zsh hook functions (preexec + simulated exit status +
  // precmd) in isolated BLACKBOX_HOMEs whose spools no daemon watches, so the
  // trials add nothing to the shared ingest queue. The hint lands via the
  // hook's background spawn into BLACKBOX_FLASHBACK_OUT.
  console.log('\n[stage flashback]');
  // the planted failure exactly as _bb_preexec saw it typed in the record stage
  const PLANTED_FAIL = 'sh -c "echo \\"(error) NOAUTH Authentication required.\\" >&2; echo \\"redis connection refused for worker\\"; exit 12"';
  const hookZsh = path.join(root, 'shell', 'blackbox.zsh');
  const mkHome = (name, baseURL) => {
    const h = path.join(work, name);
    fs.mkdirSync(h, { recursive: true });
    fs.writeFileSync(path.join(h, 'config.json'), JSON.stringify({ baseURL, containerTag: RUN_TAG }, null, 2));
    return h;
  };
  const fbHome = mkHome('bbflash', SM_URL);
  const deadHome = mkHome('bbdead', 'http://localhost:59999'); // nothing listens: same code path as a killed :6767

  // one simulated prompt cycle through the real hook; returns precmd wall-time (ms)
  function hookTrial({ home, cmd, exitCode, outFile, disable = false }) {
    const script = [
      `source ${JSON.stringify(hookZsh)}`,
      't0=$EPOCHREALTIME',
      '_bb_preexec "$BB_TRIAL_CMD"',
      '(exit "$BB_TRIAL_EXIT")',
      '_bb_precmd',
      't1=$EPOCHREALTIME',
      'print -r -- $(( (t1 - t0) * 1000 ))',
    ].join('\n');
    const out = execFileSync('zsh', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...env,
        BLACKBOX_HOME: home,
        BLACKBOX_FLASHBACK_OUT: outFile,
        BB_TRIAL_CMD: cmd,
        BB_TRIAL_EXIT: String(exitCode),
        ...(disable ? { BLACKBOX_NO_FLASHBACK: '1' } : {}),
      },
    });
    return parseFloat(out.trim());
  }

  // (1) repeat failure → ⚡ hint, accurate count + recency, within ~1s
  const hintFile = path.join(work, 'hint.out');
  fs.writeFileSync(hintFile, '');
  hookTrial({ home: fbHome, cmd: PLANTED_FAIL, exitCode: 12, outFile: hintFile });
  const tHint = Date.now();
  await waitFor(() => /⚡/.test(fs.readFileSync(hintFile, 'utf8')), { timeoutMs: 5000, stepMs: 100, label: 'flashback hint' });
  const hint = fs.readFileSync(hintFile, 'utf8');
  const hintMs = Date.now() - tHint;
  check(
    'flashback: repeated failure gets a hint (count + recency from metadata)',
    /⚡ flashback: seen \d+× before — last .+ ago/.test(hint) && /NOAUTH/.test(hint),
    hint ? `${hintMs}ms: ${hint.split('\n')[0]}` : 'no hint'
  );
  check('flashback: hint arrives fast enough for the prompt (<3s)', hint.includes('⚡') && hintMs < 3000, `${hintMs}ms`);

  // (2) unrelated failure → total silence (low similarity)
  const quietFile = path.join(work, 'quiet.out');
  fs.writeFileSync(quietFile, '');
  hookTrial({ home: fbHome, cmd: 'terraform apply -auto-approve', exitCode: 1, outFile: quietFile });
  await sleep(3000);
  check('flashback: unrelated failure stays silent', fs.readFileSync(quietFile, 'utf8') === '');

  // (3) supermemory down → total silence, no error text
  const deadFile = path.join(work, 'dead.out');
  fs.writeFileSync(deadFile, '');
  hookTrial({ home: deadHome, cmd: PLANTED_FAIL, exitCode: 12, outFile: deadFile });
  await sleep(3000);
  check('flashback: supermemory down stays totally silent', fs.readFileSync(deadFile, 'utf8') === '');

  // (4) prompt latency: hook must stay async — enabled vs disabled within noise
  const latFile = path.join(work, 'lat.out');
  const avg = (disable) => {
    const times = [];
    for (let i = 0; i < 15; i++) times.push(hookTrial({ home: fbHome, cmd: `flaky-latency-probe --run ${i}`, exitCode: 1, outFile: latFile, disable }));
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)]; // median: robust to a stray slow fork
  };
  const msOn = avg(false);
  const msOff = avg(true);
  check('flashback: prompt latency imperceptible (enabled ≈ disabled)', msOn - msOff < 30, `median ${msOn.toFixed(1)}ms on vs ${msOff.toFixed(1)}ms off`);

  // ── guard (Feature A): PreToolUse hook, crafted stdin ─────────
  // Simulates exactly what Claude Code sends (schema verified live in
  // docs/api-notes.md); asserts the advise-only + fail-open contract.
  console.log('\n[stage guard]');
  const hookStdin = (cmd, session) =>
    JSON.stringify({
      session_id: session,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: cmd },
      cwd: repoDir,
    });
  function guardHook(home, cmd, session) {
    const t0 = Date.now();
    const out = sh('node', [cli, 'guard-hook'], {
      input: hookStdin(cmd, session),
      env: { ...env, BLACKBOX_HOME: home },
    });
    return { out, ms: Date.now() - t0 };
  }

  // (1) semantically matching command → injected redis-auth context
  const g1 = guardHook(fbHome, 'npm run dev -- --port 3000', 'e2e-guard-sess');
  let g1json = null;
  try { g1json = JSON.parse(g1.out); } catch {}
  const g1ctx = g1json?.hookSpecificOutput?.additionalContext || '';
  check(
    'guard: matching command gets injected past-failure context',
    /NOAUTH/.test(g1ctx) && /blackbox guard/.test(g1ctx) && g1json?.hookSpecificOutput?.hookEventName === 'PreToolUse',
    g1ctx ? g1ctx.split('\n')[0] : `raw: ${g1.out.slice(0, 120) || '(empty)'}`
  );
  check(
    'guard: advise-only — no permissionDecision, ≤3 lines',
    g1json && !('permissionDecision' in (g1json.hookSpecificOutput || {})) && g1ctx.split('\n').length <= 3
  );

  // (2) same command, same session → deduped (silent)
  const g2 = guardHook(fbHome, 'npm run dev -- --port 3000', 'e2e-guard-sess');
  check('guard: repeat in same session is deduped to silence', g2.out === '');

  // (3) unrelated command → silent allow
  const g3 = guardHook(fbHome, 'terraform apply -auto-approve', 'e2e-guard-sess2');
  check('guard: unrelated command allowed silently', g3.out === '');

  // (4) supermemory down → silent allow within the hard cap
  const g4 = guardHook(deadHome, 'npm run dev', 'e2e-guard-dead');
  check('guard: supermemory down → silent allow within timeout', g4.out === '' && g4.ms < 2500, `${g4.ms}ms`);

  // (5) live Claude Code session in the planted repo (only when claude exists)
  const haveClaude = (() => {
    try { sh('claude', ['--version']); return true; } catch { return false; }
  })();
  if (haveClaude && !process.env.BLACKBOX_E2E_SKIP_LIVE) {
    const q = JSON.stringify;
    fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `BLACKBOX_HOME=${q(fbHome)} ${q(process.execPath)} ${q(cli)} guard-hook` }],
          }],
        },
      }, null, 2)
    );
    const liveEnv = { ...env };
    delete liveEnv.CLAUDECODE;
    delete liveEnv.CLAUDE_CODE_ENTRYPOINT;
    let liveOut = '';
    try {
      liveOut = execFileSync('claude', [
        '-p', 'Run exactly this bash command: npm run dev — afterwards, report verbatim any hook-injected additional context you received during the session.',
        '--allowedTools', 'Bash',
        '--model', 'claude-haiku-4-5-20251001',
      ], { encoding: 'utf8', cwd: repoDir, env: liveEnv, input: '', timeout: 180_000 });
    } catch (err) {
      liveOut = String(err.stdout || '') + String(err.stderr || '');
    }
    check(
      'guard (live): Claude Code session received and referenced the injected context',
      /blackbox guard/.test(liveOut) && /NOAUTH/.test(liveOut),
      liveOut.slice(0, 160).replace(/\n/g, ' ')
    );
  } else {
    console.log(`   guard live test skipped (${haveClaude ? 'BLACKBOX_E2E_SKIP_LIVE set' : 'claude not on PATH'})`);
  }

  // ── staleness (Feature B): fix memories checked against reality ──
  console.log('\n[stage staleness]');
  // Annotations have a hard 150ms budget and legitimately degrade to silence
  // on a saturated machine (fail-open) — retry a few times so a transient
  // budget miss doesn't fail the assertion.
  const askAnnotated = async (q, wantRe, tries = 4) => {
    let out = '';
    for (let i = 0; i < tries; i++) {
      out = sh('node', [cli, 'ask', q, '--limit', '8'], { cwd: repoDir });
      if (wantRe.test(out)) return out;
      await sleep(2000);
    }
    return out;
  };

  // (a) nothing touched since the fix commit → "✓ still current"
  const freshOut = await askAnnotated('authentication problem with redis', /✓ still current/);
  check(
    'staleness: untouched fix is annotated "✓ still current"',
    /\[git\]/.test(freshOut) && /✓ still current/.test(freshOut),
    /✓ still current/.test(freshOut) ? '' : `git result present: ${/\[git\]/.test(freshOut)}`
  );

  // (b) a later commit touches the fix's evidence file → "⚠ possibly stale"
  fs.appendFileSync(path.join(repoDir, 'cache.js'), '// tune timeouts\n');
  git('add', '.');
  git('commit', '-m', 'chore: bump cache timeout'); // deliberately un-ticketed: must NOT supersede
  const staleRe = /⚠ possibly stale — cache\.js changed \d+ commit\(s\) after this fix \([0-9a-f]{7,}\)/;
  const staleOut = await askAnnotated('authentication problem with redis', staleRe);
  check('staleness: evidence file changed after the fix → "⚠ possibly stale" naming it', staleRe.test(staleOut));
  check('staleness: unrelated same-repo commit does not create a supersede note', !/supersedes fix from/.test(staleOut));

  // (c) a second, newer fix for the same ticket → newest wins with supersede note
  fs.appendFileSync(path.join(repoDir, 'cache.js'), '// rotate credentials on reconnect\n');
  git('add', '.');
  git('commit', '-m', 'fix: PROJ-123 rotate redis auth credentials after NOAUTH errors');
  const gitDocsDone = await waitFor(
    async () => {
      const list = await api('/v3/documents/list', { containerTags: [RUN_TAG], limit: 50 });
      const gits = (list.memories || []).filter((d) => d.metadata?.source === 'git');
      return gits.length >= 3 && gits.every((d) => d.status === 'done' || d.status === 'failed');
    },
    { timeoutMs: 600_000, stepMs: 3000, label: 'new git commits processed' }
  );
  const supOut = gitDocsDone
    ? await askAnnotated('authentication problem with redis', /supersedes fix from \d{4}-\d{2}-\d{2}/)
    : '';
  check(
    'staleness: newer fix for the same ticket supersedes the older one',
    /rotate redis auth/.test(supOut) && /supersedes fix from \d{4}-\d{2}-\d{2}/.test(supOut),
    gitDocsDone ? '' : 'timed out waiting for git docs'
  );

  // (d) staleness path erroring (repo's git gone) → clean output, no annotation
  // (no retries here — this asserts the ABSENCE of annotations)
  fs.rmSync(path.join(repoDir, '.git'), { recursive: true, force: true });
  const brokenOut = sh('node', [cli, 'ask', 'authentication problem with redis', '--limit', '8'], { cwd: repoDir });
  check(
    'staleness: corrupt repo → clean output with no staleness claim',
    /NOAUTH/.test(brokenOut) && !/✓ still current/.test(brokenOut) && !/possibly stale/.test(brokenOut)
  );

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
