import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-test-'));
  process.env.BLACKBOX_HOME = tmpHome;
});
afterEach(() => {
  delete process.env.BLACKBOX_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('initConfig writes defaults and loadConfig reads them back', async () => {
  const { initConfig, loadConfig, paths } = await import('../../lib/config.js');
  const cfg = initConfig();
  assert.equal(cfg.baseURL, 'http://localhost:6767');
  assert.equal(cfg.maxOutputBytes, 8192);
  assert.ok(fs.existsSync(paths().config));
  assert.deepEqual(loadConfig().sources, { terminal: true, agent: true, git: true });
});

test('user config deep-merges over defaults', async () => {
  const { initConfig, loadConfig, paths } = await import('../../lib/config.js');
  initConfig();
  fs.writeFileSync(
    paths().config,
    JSON.stringify({ maxOutputBytes: 4096, ollama: { model: 'gemma4:e2b' } })
  );
  const cfg = loadConfig();
  assert.equal(cfg.maxOutputBytes, 4096);
  assert.equal(cfg.ollama.model, 'gemma4:e2b');
  assert.equal(cfg.ollama.baseURL, 'http://localhost:11434'); // preserved from defaults
  assert.equal(cfg.baseURL, 'http://localhost:6767');
});

test('corrupt config falls back to defaults instead of throwing', async () => {
  const { initConfig, loadConfig, paths } = await import('../../lib/config.js');
  initConfig();
  fs.writeFileSync(paths().config, '{not json');
  assert.equal(loadConfig().baseURL, 'http://localhost:6767');
});

test('spool round-trip: event lands in new/, parses, removes', async () => {
  const { spoolEvent, pendingEvents, readEvent, removeEvent } = await import('../../lib/spool.js');
  spoolEvent({ source: 'terminal', command: 'echo hi', exit_code: 0 });
  const files = pendingEvents();
  assert.equal(files.length, 1);
  const ev = readEvent(files[0]);
  assert.equal(ev.source, 'terminal');
  assert.equal(ev.v, 1);
  assert.ok(ev.ts);
  removeEvent(files[0]);
  assert.equal(pendingEvents().length, 0);
});

test('unparseable spool file is quarantined, not fatal', async () => {
  const { pendingEvents, readEvent } = await import('../../lib/spool.js');
  const { paths, ensureDirs } = await import('../../lib/config.js');
  const p = ensureDirs();
  fs.writeFileSync(path.join(p.spoolNew, '0-bad.json'), '{truncated');
  const files = pendingEvents();
  assert.equal(readEvent(files[0]), null);
  assert.equal(pendingEvents().length, 0);
  assert.equal(fs.readdirSync(p.spoolFailed).length, 1);
});
