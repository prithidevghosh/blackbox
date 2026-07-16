import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMatches, formatHint, lastSeen } from '../../lib/flashback.js';
import { parseArgs } from '../../cli/cmd/flashback.js';

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function result({ score, source = 'terminal', ts, content, exit_code }) {
  return {
    score,
    createdAt: ts,
    metadata: { source, ts, exit_code },
    chunks: [{ content, isRelevant: true }],
    title: content,
  };
}

const noauth = (over = {}) =>
  result({
    score: 0.81,
    ts: iso(2 * 3600_000),
    content: '$ redis-cli PING (error) NOAUTH Authentication required.',
    exit_code: 12,
    ...over,
  });

test('selectMatches keeps only results at/above the threshold', () => {
  const { hits } = selectMatches([noauth(), noauth({ score: 0.55 })], 0.72);
  assert.equal(hits.length, 1);
});

test('selectMatches surfaces a git result as the fix, not as a repeat', () => {
  const git = noauth({ source: 'git', score: 0.75, content: 'fix: PROJ-123 pass redis password' });
  const { hits, gitFix } = selectMatches([noauth(), git], 0.72);
  assert.equal(hits.length, 1);
  assert.equal(gitFix.metadata.source, 'git');
});

test('formatHint is null with no confident hits (caller stays silent)', () => {
  assert.equal(formatHint(selectMatches([noauth({ score: 0.4 })], 0.72), 'redis-cli PING'), null);
  assert.equal(formatHint(selectMatches([], 0.72), 'x'), null);
});

test('formatHint cites real count and recency, not placeholders', () => {
  const hits = [noauth(), noauth({ ts: iso(26 * 3600_000), score: 0.74 })];
  const hint = formatHint(selectMatches(hits, 0.72), 'redis-cli PING');
  assert.match(hint, /seen 2× before/);
  assert.match(hint, /last 2h ago/); // most recent of the two, from metadata.ts
  assert.match(hint, /NOAUTH Authentication required/);
  assert.match(hint, /exit 12/);
  assert.match(hint, /blackbox ask --explain "redis-cli PING"/);
});

test('formatHint includes the correlated git fix with its own recency', () => {
  const git = noauth({ source: 'git', score: 0.75, ts: iso(3600_000), content: 'fix: PROJ-123 pass redis password to cache client' });
  const hint = formatHint(selectMatches([noauth(), git], 0.72), 'redis-cli PING');
  assert.match(hint, /fix \(git, 1h ago\): fix: PROJ-123 pass redis password/);
});

test('lastSeen picks the most recent timestamp', () => {
  const a = noauth({ ts: '2026-07-01T00:00:00Z' });
  const b = noauth({ ts: '2026-07-10T00:00:00Z' });
  assert.equal(lastSeen([a, b]), '2026-07-10T00:00:00Z');
});

test('parseArgs: hook invocation shape', () => {
  const p = parseArgs(['--exit', '12', '--cwd', '/w', '--', 'redis-cli', 'PING']);
  assert.deepEqual(p, { command: 'redis-cli PING', exit: 12, cwd: '/w' });
});
