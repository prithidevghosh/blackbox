// Start/stop Supermemory Local — the one external service blackbox depends
// on. Shared by `blackbox setup`, `up`, and `down`. (The ingest daemon has
// its own lifecycle in cli/cmd/ingest-daemon.js.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { paths } from './config.js';
import { alive } from './supermemory.js';

const SM_START_TIMEOUT_S = 60; // first boot downloads the embedding model

export function findSupermemoryBinary() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'supermemory-server'),
    path.join(os.homedir(), '.supermemory', 'bin', 'supermemory-server'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  try {
    const found = execFileSync('which', ['supermemory-server'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {}
  return null;
}

export function supermemoryPid() {
  try {
    const pid = parseInt(fs.readFileSync(paths().smPid, 'utf8'), 10);
    if (pid > 0) {
      process.kill(pid, 0); // signal 0 = existence check
      return pid;
    }
  } catch {}
  return null;
}

// Spawn the server detached, pointed at local Ollama so nothing needs a cloud
// key, and wait for :6767 to answer. Throws with the log path on failure.
export async function startSupermemory(cfg, { log = console.log } = {}) {
  const p = paths();
  if (await alive(cfg)) return { alreadyUp: true };

  const bin = findSupermemoryBinary();
  if (!bin) {
    throw new Error('supermemory-server binary not found — run: blackbox setup');
  }

  fs.mkdirSync(path.join(os.homedir(), '.supermemory', 'data'), { recursive: true });
  const out = fs.openSync(p.smLog, 'a');
  const child = spawn(bin, [], {
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      SUPERMEMORY_DATA_DIR: path.join(os.homedir(), '.supermemory', 'data'),
      OPENAI_BASE_URL: `${cfg.ollama.baseURL}/v1`,
      OPENAI_API_KEY: 'ollama',
      OPENAI_MODEL: cfg.ollama.model,
    },
  });
  child.unref();
  fs.writeFileSync(p.smPid, String(child.pid));
  fs.closeSync(out);

  log(`starting supermemory local (pid ${child.pid}, log ${p.smLog})…`);
  for (let i = 0; i < SM_START_TIMEOUT_S; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await alive(cfg)) return { pid: child.pid };
  }
  throw new Error(`supermemory did not come up on ${cfg.baseURL} — check ${p.smLog}`);
}

// Stop a server we started (pid file). Returns the pid, or null if we don't
// own one — a server started some other way is left alone.
export function stopSupermemory() {
  const pid = supermemoryPid();
  if (!pid) return null;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  try {
    fs.unlinkSync(paths().smPid);
  } catch {}
  return pid;
}
