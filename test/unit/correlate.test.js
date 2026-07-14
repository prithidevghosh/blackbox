import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractTicket, correlate, gitInfo } from '../../lib/correlate.js';

test('extractTicket matches PROJ-123 style ids', () => {
  assert.equal(extractTicket('fix/PROJ-123-redis-auth'), 'PROJ-123');
  assert.equal(extractTicket('JIRA2-9 something'), 'JIRA2-9');
  assert.equal(extractTicket('feat: ABC-42 handle timeouts'), 'ABC-42');
  assert.equal(extractTicket('no ticket here'), null);
  assert.equal(extractTicket('lowercase proj-123'), null);
  assert.equal(extractTicket(''), null);
  assert.equal(extractTicket(null), null);
});

test('extractTicket honors custom regex from config', () => {
  assert.equal(extractTicket('bug #4521 fixed', '#\\d+'), '#4521');
});

test('correlate: branch ticket wins over content ticket', () => {
  const ev = correlate({ branch: 'fix/PROJ-123-x', content: 'mentions OTHER-9', cwd: null });
  assert.equal(ev.ticket, 'PROJ-123');
});

test('correlate: falls back to command/content/message text', () => {
  assert.equal(correlate({ command: 'git checkout PROJ-77', cwd: null }).ticket, 'PROJ-77');
  assert.equal(correlate({ content: 'working on ABC-1', cwd: null }).ticket, 'ABC-1');
  assert.equal(correlate({ message: 'fix: DEF-2 crash', cwd: null }).ticket, 'DEF-2');
  assert.equal(correlate({ command: 'echo hi', cwd: null }).ticket, null);
});

// --- git-backed tests use a real scripted repo ---
let repoDir;
beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello');
  git('add', '.');
  git('commit', '-m', 'initial');
  git('checkout', '-b', 'fix/PROJ-123-redis-auth');
});
afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test('gitInfo resolves repo name and branch from cwd', () => {
  const info = gitInfo(repoDir);
  assert.equal(info.repo, path.basename(repoDir));
  assert.equal(info.branch, 'fix/PROJ-123-redis-auth');
  assert.equal(gitInfo('/').repo, null); // non-repo cwd fails soft
});

test('correlate fills repo/branch/ticket for a terminal event by cwd', () => {
  const ev = correlate({ source: 'terminal', command: 'redis-cli PING', cwd: repoDir });
  assert.equal(ev.repo, path.basename(repoDir));
  assert.equal(ev.branch, 'fix/PROJ-123-redis-auth');
  assert.equal(ev.ticket, 'PROJ-123');
});

test('post-commit hook spools a git event with hash, message, files', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-home-'));
  process.env.BLACKBOX_HOME = tmpHome;
  try {
    const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'cli', 'blackbox.js');
    execFileSync('node', [cli, 'init'], { cwd: repoDir, encoding: 'utf8' });
    // idempotency: run again, hook must contain exactly one managed block
    execFileSync('node', [cli, 'init'], { cwd: repoDir, encoding: 'utf8' });
    const hook = fs.readFileSync(path.join(repoDir, '.git', 'hooks', 'post-commit'), 'utf8');
    assert.equal(hook.split('BEGIN BLACKBOX').length, 2, 'exactly one managed block');

    fs.writeFileSync(path.join(repoDir, 'cache.js'), 'client.auth(process.env.REDIS_PASSWORD)');
    const git = (...args) =>
      execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', env: { ...process.env, BLACKBOX_HOME: tmpHome } });
    git('add', '.');
    git('commit', '-m', 'fix: PROJ-123 pass redis password to client');

    const { pendingEvents, readEvent } = await import('../../lib/spool.js');
    const files = pendingEvents();
    assert.equal(files.length, 1);
    const ev = readEvent(files[0]);
    assert.equal(ev.source, 'git');
    assert.equal(ev.event, 'commit');
    assert.equal(ev.branch, 'fix/PROJ-123-redis-auth');
    assert.match(ev.message, /PROJ-123 pass redis password/);
    assert.deepEqual(ev.files, ['cache.js']);
    assert.match(ev.hash, /^[0-9a-f]{40}$/);
  } finally {
    delete process.env.BLACKBOX_HOME;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
