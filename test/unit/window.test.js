import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupForStandup } from '../../lib/window.js';
import { parseWindow } from '../../lib/format.js';

const ev = (source, extra = {}, content = 'x') => ({
  id: Math.random().toString(36),
  content,
  metadata: { source, ts_epoch: 1000, ...extra },
});

test('groupForStandup groups by repo+ticket with per-source stats', () => {
  const events = [
    ev('terminal', { repo: 'payments', ticket: 'PROJ-123', exit_code: 0 }),
    ev('terminal', { repo: 'payments', ticket: 'PROJ-123', exit_code: 12 }),
    ev('agent', { repo: 'payments', ticket: 'PROJ-123', agent: 'claude-code' }),
    ev('git', { repo: 'payments', ticket: 'PROJ-123' }, 'Git commit abc:\nfix: PROJ-123 auth'),
    ev('terminal', { repo: 'otherrepo', exit_code: 0 }),
  ];
  const groups = groupForStandup(events);
  assert.equal(groups.length, 2);
  const g = groups[0]; // most events first
  assert.equal(g.repo, 'payments');
  assert.equal(g.ticket, 'PROJ-123');
  assert.equal(g.terminal, 2);
  assert.equal(g.failures.length, 1);
  assert.equal(g.agent, 1);
  assert.equal(g.commits.length, 1);
  assert.equal(groups[1].repo, 'otherrepo');
  assert.equal(groups[1].ticket, null);
});

test('parseWindow parses h/d/m and falls back to 24h', () => {
  assert.equal(parseWindow('24h'), 24 * 3600 * 1000);
  assert.equal(parseWindow('7d'), 7 * 86400 * 1000);
  assert.equal(parseWindow('90m'), 90 * 60 * 1000);
  assert.equal(parseWindow('garbage'), 24 * 3600 * 1000);
  assert.equal(parseWindow(undefined), 24 * 3600 * 1000);
});
