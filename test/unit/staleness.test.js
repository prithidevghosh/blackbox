import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  evidencePaths,
  parseNameOnlyLog,
  classifyStaleness,
  formatStalenessNote,
  stalenessNote,
  newestFix,
  supersedeNote,
} from '../../lib/staleness.js';

// ── V5: evidence paths ────────────────────────────────────────────────────
test('evidencePaths: "files changed:" line + path tokens, existing files only', () => {
  const content =
    'Git commit abc123 (repo payments-worker):\nfix: PROJ-123 pass redis password, see ops/redis.conf\nfiles changed: cache.js, ops/redis.conf, deleted.js';
  const exists = (p) => !p.endsWith('deleted.js');
  const ev = evidencePaths(content, '/repo', exists);
  assert.deepEqual(ev.sort(), ['cache.js', 'ops/redis.conf']);
});

test('evidencePaths: no repo root or traversal tokens → empty/skipped', () => {
  assert.deepEqual(evidencePaths('files changed: a.js', null), []);
  const ev = evidencePaths('files changed: ../../etc/passwd, ok.js', '/repo', () => true);
  assert.deepEqual(ev, ['ok.js']);
});

test('evidencePaths: URLs and absolute paths are not evidence', () => {
  const ev = evidencePaths('see https://x.com/a/b.js and /etc/hosts and src/app.ts', '/repo', () => true);
  assert.deepEqual(ev, ['src/app.ts']);
});

// ── V6: log parsing + classification + formatting ─────────────────────────
test('parseNameOnlyLog groups files under their commit, newest first', () => {
  const commits = parseNameOnlyLog('abc1234\n\nops/redis.conf\ndef5678\n\nops/redis.conf\npackage-lock.json\n');
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], { hash: 'abc1234', files: ['ops/redis.conf'] });
  assert.deepEqual(commits[1].files, ['ops/redis.conf', 'package-lock.json']);
});

test('classify + format: untouched → "✓ still current"', () => {
  assert.equal(formatStalenessNote(classifyStaleness([], ['a.js'], [])), '✓ still current');
});

test('classify + format: touched evidence names file, count, latest hash', () => {
  const commits = parseNameOnlyLog('abc1234\nops/redis.conf\ndef5678\nops/redis.conf\n');
  const note = formatStalenessNote(classifyStaleness(commits, ['ops/redis.conf'], []));
  assert.equal(note, '⚠ possibly stale — ops/redis.conf changed 2 commit(s) after this fix (abc1234)');
});

test('classify + format: lockfile-only drift is reported as dependency drift', () => {
  const commits = parseNameOnlyLog('abc1234\npackage-lock.json\n');
  const note = formatStalenessNote(classifyStaleness(commits, ['cache.js'], ['package-lock.json']));
  assert.match(note, /⚠ possibly stale — dependency drift: package-lock.json changed since \(abc1234\)/);
});

// ── V6 end-to-end against a real throwaway repo ───────────────────────────
function mkRepo({ fixAgeMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbstale-'));
  const fixDate = new Date(Date.now() - fixAgeMs).toISOString();
  const git = (...a) =>
    execFileSync('git', ['-C', dir, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_AUTHOR_DATE: fixDate, GIT_COMMITTER_DATE: fixDate },
    });
  git('init', '-qb', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'ops'));
  fs.writeFileSync(path.join(dir, 'ops', 'redis.conf'), 'requirepass x\n');
  fs.writeFileSync(path.join(dir, 'cache.js'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'fix: redis auth');
  return { dir, git };
}

const fixResult = (dir, ts) => ({
  metadata: { source: 'git', ts, cwd: dir, repo: path.basename(dir) },
  chunks: [{ content: 'Git commit abc:\nfix: redis auth\nfiles changed: cache.js, ops/redis.conf', isRelevant: true }],
});

test('stalenessNote: untouched repo → still current', () => {
  const { dir } = mkRepo();
  assert.equal(stalenessNote(fixResult(dir, new Date().toISOString())), '✓ still current');
});

test('stalenessNote: evidence file changed after memory ts → possibly stale naming it', async () => {
  // fix commit (and its memory) a minute ago; a fresh commit touches the config after it
  const { dir } = mkRepo({ fixAgeMs: 60_000 });
  const memTs = new Date(Date.now() - 60_000).toISOString();
  fs.appendFileSync(path.join(dir, 'ops', 'redis.conf'), 'requirepass y\n');
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('add', '.');
  git('commit', '-qm', 'rotate redis password');
  const note = stalenessNote(fixResult(dir, memTs));
  assert.match(note, /⚠ possibly stale — ops\/redis\.conf changed 1 commit\(s\) after this fix \([0-9a-f]{7,}\)/);
});

test('stalenessNote: corrupt/missing repo → null (no claim)', () => {
  const { dir } = mkRepo();
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  assert.equal(stalenessNote(fixResult(dir, new Date().toISOString())), null);
  assert.equal(stalenessNote(fixResult('/nonexistent-xyz', new Date().toISOString())), null);
});

test('stalenessNote: non-git results and results without ts are ignored', () => {
  assert.equal(stalenessNote({ metadata: { source: 'terminal', ts: 'x' } }), null);
  assert.equal(stalenessNote({ metadata: { source: 'git' } }), null);
});

test('stalenessNote: stays within budget', () => {
  const { dir } = mkRepo();
  const t0 = Date.now();
  stalenessNote(fixResult(dir, new Date().toISOString()));
  assert.ok(Date.now() - t0 < 400, `took ${Date.now() - t0}ms`); // 150ms budget + subprocess slack on CI
});

// ── V7: newest fix wins ───────────────────────────────────────────────────
const gfix = (ts, repo = 'payments-worker') => ({ metadata: { source: 'git', ts, repo } });

test('newestFix: newest same-repo fix is the answer, older dates listed', () => {
  const older = gfix('2026-07-01T10:00:00Z');
  const newer = gfix('2026-07-15T10:00:00Z');
  const { fix, supersedes } = newestFix([older, newer]);
  assert.equal(fix, newer);
  assert.deepEqual(supersedes, ['2026-07-01']);
  assert.equal(supersedeNote(supersedes), 'supersedes fix from 2026-07-01');
});

test('newestFix: single fix → no supersede note', () => {
  const { fix, supersedes } = newestFix([gfix('2026-07-01T10:00:00Z')]);
  assert.ok(fix);
  assert.equal(supersedeNote(supersedes), null);
});

test('newestFix: fixes from different repos are not chained', () => {
  const a = gfix('2026-07-01T10:00:00Z', 'repo-a');
  const b = gfix('2026-07-15T10:00:00Z', 'repo-b');
  const { supersedes } = newestFix([a, b]);
  assert.deepEqual(supersedes, []);
});

test('newestFix: ticket is the grouping key — unrelated same-repo commits cannot supersede', () => {
  const fix1 = { metadata: { source: 'git', ts: '2026-07-01T10:00:00Z', repo: 'r', ticket: 'PROJ-123' } };
  const fix2 = { metadata: { source: 'git', ts: '2026-07-15T10:00:00Z', repo: 'r', ticket: 'PROJ-123' } };
  const chore = { metadata: { source: 'git', ts: '2026-07-17T10:00:00Z', repo: 'r' } }; // newest but no ticket
  const { fix, supersedes } = newestFix([fix1, chore, fix2]);
  assert.equal(fix, fix2, 'ticketed chain beats the loose newest commit');
  assert.deepEqual(supersedes, ['2026-07-01']);
});
