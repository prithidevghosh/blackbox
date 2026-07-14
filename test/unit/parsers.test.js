import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claudeCode from '../../watchers/parsers/claude-code.js';
import * as codex from '../../watchers/parsers/codex.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function parseFixture(file, parser, state) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) events.push(...parser(line, state));
  return events;
}

test('claude-code fixture parses to expected events', () => {
  const events = parseFixture(
    path.join(fixtures, 'claude-code', 'session.jsonl'),
    claudeCode.parseLine
  );
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['user_prompt', 'tool_use', 'tool_result', 'assistant_text']);

  const prompt = events[0];
  assert.equal(prompt.source, 'agent');
  assert.equal(prompt.agent, 'claude-code');
  assert.match(prompt.content, /PROJ-123/);
  assert.doesNotMatch(prompt.content, /ide_opened_file/); // synthetic block filtered
  assert.equal(prompt.branch, 'fix/PROJ-123-redis-auth');
  assert.equal(prompt.session, 'e2e00000-1111-2222-3333-444444444444');
  assert.ok(prompt.ts);

  assert.match(events[1].content, /redis-cli -h localhost PING/);
  assert.equal(events[1].tool, 'Bash');
  assert.match(events[2].content, /NOAUTH Authentication required/);
  assert.equal(events[2].is_error, true);
  assert.match(events[3].content, /REDIS_PASSWORD/);
});

test('claude-code parser never throws on garbage', () => {
  for (const line of ['', 'not json', '{"type":"user"}', '{"type":"assistant","message":{}}', '{"unrelated":1}', '[]', 'null']) {
    assert.deepEqual(claudeCode.parseLine(line), []);
  }
});

test('claude-code string-content user message parses', () => {
  const events = claudeCode.parseLine(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'plain string prompt' },
      sessionId: 's1',
      timestamp: '2026-07-15T00:00:00Z',
      cwd: '/x',
      gitBranch: 'main',
    })
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].content, 'plain string prompt');
});

test('codex fixture parses with session state carried across lines', () => {
  const state = codex.newSessionState();
  const events = parseFixture(
    path.join(fixtures, 'codex', 'rollout-2026-07-15T10-00-00-fixture.jsonl'),
    codex.parseLine,
    state
  );
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ['user_prompt', 'assistant_text', 'tool_use', 'tool_result', 'assistant_text']);
  assert.equal(events[0].session, 'codex-fixture-session-1');
  assert.equal(events[0].cwd, '{{CWD}}'); // session_meta cwd propagated
  assert.match(events[2].content, /redis-cli PING/);
  assert.match(events[3].content, /NOAUTH/);
});

test('codex parser never throws on garbage', () => {
  const state = codex.newSessionState();
  for (const line of ['', 'nope', '{"type":"response_item"}', '{"type":"response_item","payload":{"type":"message"}}']) {
    assert.deepEqual(codex.parseLine(line, state), []);
  }
});

test('oversized content is clipped', () => {
  const big = 'x'.repeat(40000);
  const events = claudeCode.parseLine(
    JSON.stringify({ type: 'user', message: { role: 'user', content: big }, sessionId: 's', timestamp: 't' })
  );
  assert.ok(events[0].content.length < 17000);
  assert.match(events[0].content, /truncated/);
});
