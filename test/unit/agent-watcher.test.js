import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

let tmpHome, agentDir;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-watch-'));
  agentDir = path.join(tmpHome, 'agent-transcripts', 'proj');
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.BLACKBOX_HOME = path.join(tmpHome, 'bb');
});
afterEach(() => {
  delete process.env.BLACKBOX_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, ms = 8000, step = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

test('watcher captures a new file appended live, split mid-line', async () => {
  const { startAgentWatcher } = await import('../../watchers/agent-watcher.js');
  const events = [];
  const cfg = {
    agents: {
      'claude-code': { dir: path.dirname(agentDir), enabled: true },
      codex: { enabled: false },
    },
  };
  const watcher = startAgentWatcher(cfg, { onEvent: (e) => events.push(e) });
  try {
    await sleep(300); // let initial scan finish

    const raw = fs.readFileSync(path.join(fixtures, 'claude-code', 'session.jsonl'), 'utf8');
    const target = path.join(agentDir, 'live-session.jsonl');
    // append in three chunks, cutting the second chunk mid-JSON-line
    const third = Math.floor(raw.length / 3);
    const cut = raw.indexOf('"', third * 2) + 3; // guaranteed mid-line position
    fs.appendFileSync(target, raw.slice(0, third));
    await sleep(150);
    fs.appendFileSync(target, raw.slice(third, cut));
    await sleep(150);
    fs.appendFileSync(target, raw.slice(cut));

    await waitFor(() => events.length >= 4);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['user_prompt', 'tool_use', 'tool_result', 'assistant_text']);
    assert.match(events[2].content, /NOAUTH/);
    assert.equal(events[0].transcript, target);
  } finally {
    await watcher.close();
  }
});

test('watcher skips history of preexisting files but sees new appends', async () => {
  const { startAgentWatcher } = await import('../../watchers/agent-watcher.js');
  const raw = fs.readFileSync(path.join(fixtures, 'claude-code', 'session.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const target = path.join(agentDir, 'old-session.jsonl');
  // history: everything except the final assistant_text line
  fs.writeFileSync(target, lines.slice(0, -2).join('\n') + '\n');

  const events = [];
  const cfg = { agents: { 'claude-code': { dir: path.dirname(agentDir), enabled: true }, codex: { enabled: false } } };
  const watcher = startAgentWatcher(cfg, { onEvent: (e) => events.push(e) });
  try {
    await sleep(400);
    assert.equal(events.length, 0, 'history must not be re-ingested');
    fs.appendFileSync(target, lines[lines.length - 2] + '\n');
    await waitFor(() => events.length >= 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'assistant_text');
  } finally {
    await watcher.close();
  }
});

test('watcher fails soft when transcript dirs are missing', async () => {
  const { startAgentWatcher } = await import('../../watchers/agent-watcher.js');
  const cfg = {
    agents: {
      'claude-code': { dir: path.join(tmpHome, 'does-not-exist'), enabled: true },
      codex: { dir: path.join(tmpHome, 'also-missing'), enabled: true },
    },
  };
  const watcher = startAgentWatcher(cfg, { onEvent: () => {} });
  assert.deepEqual(watcher.agents, []);
  await watcher.close();
});
