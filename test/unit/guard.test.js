import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commandKey,
  extractBashCommand,
  commandFromContent,
  selectGuardMatch,
  formatGuardContext,
  alreadyInjected,
  markInjected,
} from '../../lib/guard.js';

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function result({ score, source = 'terminal', ts = iso(3600_000), content, exit_code, kind, session }) {
  return {
    score,
    createdAt: ts,
    metadata: { source, ts, exit_code, kind, session, repo: 'payments-worker' },
    chunks: [{ content, isRelevant: true }],
    title: content,
  };
}

const npmFail = (over = {}) =>
  result({
    score: 0.82,
    content:
      'Terminal command (repo payments-worker):\n$ npm run dev\n(error) NOAUTH Authentication required.\nFAILED with exit code 12',
    exit_code: 12,
    session: 'record-42',
    ...over,
  });

// ── commandKey ────────────────────────────────────────────────────────────
test('commandKey: runner binaries keep their subcommand', () => {
  assert.deepEqual(commandKey('npm run dev'), { bin: 'npm', sub: 'run' });
  assert.deepEqual(commandKey('git push origin main'), { bin: 'git', sub: 'push' });
});

test('commandKey: env prefixes, wrappers, paths, and flags are normalized away', () => {
  assert.deepEqual(commandKey('FOO=1 sudo /usr/local/bin/npm --silent install'), { bin: 'npm', sub: 'install' });
  assert.deepEqual(commandKey('node server.js'), { bin: 'node', sub: null });
  assert.equal(commandKey('   '), null);
});

// ── extractBashCommand ────────────────────────────────────────────────────
test('extractBashCommand: Bash only, null for other tools or empty input', () => {
  assert.equal(extractBashCommand({ tool_name: 'Bash', tool_input: { command: 'npm run dev' } }), 'npm run dev');
  assert.equal(extractBashCommand({ tool_name: 'Edit', tool_input: { file_path: 'x' } }), null);
  assert.equal(extractBashCommand({ tool_name: 'Bash', tool_input: {} }), null);
  assert.equal(extractBashCommand(null), null);
});

// ── commandFromContent ────────────────────────────────────────────────────
test('commandFromContent reads terminal "$ cmd" and agent "[tool:Bash] cmd" forms', () => {
  assert.equal(commandFromContent('Terminal command:\n$ npm run dev\noutput'), 'npm run dev');
  assert.equal(commandFromContent('AI coding session — the agent ran:\n[tool:Bash] npm run dev'), 'npm run dev');
  assert.equal(commandFromContent('no command here'), null);
});

// ── selectGuardMatch ──────────────────────────────────────────────────────
test('selectGuardMatch: confident same-binary failure matches', () => {
  const m = selectGuardMatch([npmFail()], 'npm run dev --turbo', 0.72);
  assert.ok(m);
  assert.equal(m.hit.metadata.exit_code, 12);
});

test('selectGuardMatch: below threshold → null', () => {
  assert.equal(selectGuardMatch([npmFail({ score: 0.5 })], 'npm run dev', 0.72), null);
});

test('selectGuardMatch: different binary is gated out even when semantically close', () => {
  assert.equal(selectGuardMatch([npmFail()], 'terraform apply', 0.72), null);
});

test('selectGuardMatch: successes are never warned about', () => {
  const ok = npmFail({ exit_code: 0, content: 'Terminal command:\n$ npm run dev\nexited 0 (success)' });
  assert.equal(selectGuardMatch([ok], 'npm run dev', 0.72), null);
});

test('selectGuardMatch: agent tool_result failures count; git rides along as the fix', () => {
  const agentFail = result({
    score: 0.8,
    source: 'agent',
    kind: 'tool_result',
    content: 'AI coding session (claude-code) — tool output was:\n(error) NOAUTH Authentication required.',
  });
  const gitFix = result({ score: 0.76, source: 'git', content: 'Git commit abc123:\nfix: PROJ-123 pass redis password to cache client' });
  const m = selectGuardMatch([agentFail, gitFix], 'npm run dev', 0.72);
  assert.ok(m);
  assert.equal(m.hit.metadata.source, 'agent');
  assert.equal(m.gitFix.metadata.source, 'git');
});

// ── formatGuardContext ────────────────────────────────────────────────────
test('formatGuardContext: ≤3 plain lines with date, root cause, fix, session', () => {
  const gitFix = result({ score: 0.76, source: 'git', ts: iso(7200_000), content: 'Git commit abc123:\nfix: PROJ-123 pass redis password to cache client' });
  const ctx = formatGuardContext({ hit: npmFail(), gitFix }, 'npm run dev');
  const lines = ctx.split('\n');
  assert.ok(lines.length <= 3, `expected ≤3 lines, got ${lines.length}`);
  assert.match(lines[0], /failed before on \d{4}-\d{2}-\d{2}/);
  assert.match(lines[0], /NOAUTH Authentication required/);
  assert.match(ctx, /fix at the time/);
  assert.match(ctx, /pass redis password/);
  assert.match(ctx, /session record-42/);
  assert.ok(!/\x1b\[/.test(ctx), 'no ANSI codes in model-facing text');
});

test('formatGuardContext works without a git fix', () => {
  const ctx = formatGuardContext({ hit: npmFail(), gitFix: null }, 'npm run dev');
  assert.ok(!/fix at the time/.test(ctx));
  assert.match(ctx, /NOAUTH/);
});

// ── dedupe state ──────────────────────────────────────────────────────────
beforeEach(() => {
  process.env.BLACKBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bbguard-'));
});

test('dedupe: second identical command in the same session is suppressed', () => {
  assert.equal(alreadyInjected('sess-1', 'npm run dev'), false);
  markInjected('sess-1', 'npm run dev');
  assert.equal(alreadyInjected('sess-1', 'npm  run   dev'), true, 'whitespace-normalized');
  assert.equal(alreadyInjected('sess-2', 'npm run dev'), false, 'other sessions unaffected');
  assert.equal(alreadyInjected('sess-1', 'npm test'), false, 'other commands unaffected');
});

test('dedupe: corrupt state file degrades to not-seen, and markInjected recovers it', () => {
  const home = process.env.BLACKBOX_HOME;
  fs.writeFileSync(path.join(home, 'guard-state.json'), '{corrupt');
  assert.equal(alreadyInjected('sess-1', 'npm run dev'), false);
  markInjected('sess-1', 'npm run dev');
  assert.equal(alreadyInjected('sess-1', 'npm run dev'), true);
});

test('formatGuardContext (Feature B): fix line carries staleness + supersede annotations', () => {
  const oldFix = result({ score: 0.8, source: 'git', ts: iso(30 * 86_400_000), content: 'Git commit old1:\nfix: old redis patch' });
  const newFix = result({ score: 0.75, source: 'git', ts: iso(86_400_000), content: 'Git commit new1:\nfix: rotate redis password' });
  const m = selectGuardMatch([npmFail(), oldFix, newFix], 'npm run dev', 0.72);
  assert.equal(m.gitFix, newFix, 'newest fix wins');
  const ctx = formatGuardContext(m, 'npm run dev', { fixNote: '⚠ possibly stale — ops/redis.conf changed 1 commit(s) after this fix (abc1234)' });
  assert.match(ctx, /rotate redis password/);
  assert.match(ctx, /possibly stale — ops\/redis\.conf/);
  assert.match(ctx, /supersedes fix from/);
  assert.ok(ctx.split('\n').length <= 3, 'still ≤3 lines');
});
