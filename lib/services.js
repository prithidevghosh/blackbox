// Start/stop the external services blackbox depends on: Supermemory Local
// (required) and Ollama (optional, LLM features). Shared by `blackbox
// setup`, `up`, and `down`. (The ingest daemon has its own lifecycle in
// cli/cmd/ingest-daemon.js.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { paths } from './config.js';
import { alive } from './supermemory.js';
import { ollamaAlive } from './ollama.js';

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

// A server that isn't answering while something holds its port is doomed to
// crash on bind ("Is port in use?"). Returns the squatting pid, or null.
function portHolder(baseURL) {
  let port;
  try {
    const u = new URL(baseURL);
    port = u.port || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    return null;
  }
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = parseInt(out.trim().split('\n')[0], 10);
    return pid > 0 ? pid : null;
  } catch {
    return null; // port free, or no lsof — either way, let the spawn tell us
  }
}

// Spawn the server detached, pointed at local Ollama so nothing needs a cloud
// key, and wait for :6767 to answer. Throws with the log path on failure.
export async function startSupermemory(cfg, { log = console.log } = {}) {
  const p = paths();
  if (await alive(cfg)) return { alreadyUp: true };

  const squatter = portHolder(cfg.baseURL);
  if (squatter) {
    throw new Error(
      `port for ${cfg.baseURL} is held by pid ${squatter}, which isn't answering — a new server would crash on bind.\n` +
        `  kill it:  kill -9 ${squatter}\n` +
        `  if it survives kill -9 (stuck in the kernel, STAT 'UE' in ps), only a reboot frees the port.`
    );
  }

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

function findOllamaBinary() {
  try {
    const found = execFileSync('which', ['ollama'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch {}
  for (const c of ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return null;
}

export function ollamaPidOwned() {
  try {
    const pid = parseInt(fs.readFileSync(paths().ollamaPid, 'utf8'), 10);
    if (pid > 0) {
      process.kill(pid, 0);
      return pid;
    }
  } catch {}
  return null;
}

// Start `ollama serve` if it isn't running. Fail-soft by design — everything
// except ask --explain / standup / rca works without it — so this returns a
// status object instead of throwing:
//   { alreadyUp } | { pid } | { skipped: 'remote'|'not-installed' } | { failed }
export async function startOllama(cfg, { log = console.log } = {}) {
  const p = paths();
  if (await ollamaAlive(cfg)) return { alreadyUp: true };

  let url;
  try {
    url = new URL(cfg.ollama.baseURL);
  } catch {
    return { skipped: 'remote' };
  }
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return { skipped: 'remote' };

  const bin = findOllamaBinary();
  if (!bin) return { skipped: 'not-installed' };

  const out = fs.openSync(p.ollamaLog, 'a');
  const child = spawn(bin, ['serve'], {
    detached: true,
    stdio: ['ignore', out, out],
    // honor a non-default port in config.json (ollama defaults to 11434)
    env: { ...process.env, OLLAMA_HOST: `${url.hostname}:${url.port || 11434}` },
  });
  child.unref();
  fs.writeFileSync(p.ollamaPid, String(child.pid));
  fs.closeSync(out);

  log(`starting ollama (pid ${child.pid}, log ${p.ollamaLog})…`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ollamaAlive(cfg)) return { pid: child.pid };
  }
  return { failed: true, log: p.ollamaLog };
}

// Stop an ollama we started (pid file). Returns the pid, or null — an ollama
// started some other way (the desktop app, launchd) is left alone.
export function stopOllama() {
  const pid = ollamaPidOwned();
  if (!pid) return null;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
  try {
    fs.unlinkSync(paths().ollamaPid);
  } catch {}
  return pid;
}
