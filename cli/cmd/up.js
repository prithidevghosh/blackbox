// `blackbox up` — start whatever isn't running: Ollama (optional, so its
// failures only warn), then Supermemory Local, then the ingest daemon.
// Idempotent; the command to reach for after a reboot.
import { initConfig } from '../../lib/config.js';
import { alive } from '../../lib/supermemory.js';
import { startSupermemory, startOllama } from '../../lib/services.js';
import { run as ingestDaemon, daemonPid } from './ingest-daemon.js';

export async function run() {
  const cfg = initConfig();

  const o = await startOllama(cfg);
  if (o.alreadyUp) console.log(`ollama: already up on ${cfg.ollama.baseURL}`);
  else if (o.pid) console.log(`ollama: up on ${cfg.ollama.baseURL} (pid ${o.pid})`);
  else if (o.skipped === 'not-installed') console.log('ollama: not installed — skipping (ask --explain/standup/rca fall back to no-LLM output)');
  else if (o.skipped === 'remote') console.log(`ollama: ${cfg.ollama.baseURL} is not local — not starting it here`);
  else if (o.failed) console.error(`ollama: did not come up — check ${o.log} (LLM features fall back; continuing)`);

  if (await alive(cfg)) {
    console.log(`supermemory local: already up on ${cfg.baseURL}`);
  } else {
    try {
      const res = await startSupermemory(cfg); // throws with log path on failure
      console.log(`supermemory local: up on ${cfg.baseURL} (pid ${res.pid})`);
    } catch (err) {
      console.error(`blackbox up: ${err.message}`);
      console.error('(capture still works — spooled events drain once the server is up)');
      process.exit(1);
    }
  }

  const pid = daemonPid();
  if (pid) console.log(`ingest daemon: already running (pid ${pid})`);
  else await ingestDaemon(['--daemonize']);

  console.log("blackbox is up — 'blackbox status' for details.");
}
