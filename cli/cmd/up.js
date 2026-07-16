// `blackbox up` — start whatever isn't running: Supermemory Local, then the
// ingest daemon. Idempotent; the command to reach for after a reboot.
import { initConfig } from '../../lib/config.js';
import { alive } from '../../lib/supermemory.js';
import { startSupermemory } from '../../lib/services.js';
import { run as ingestDaemon, daemonPid } from './ingest-daemon.js';

export async function run() {
  const cfg = initConfig();

  if (await alive(cfg)) {
    console.log(`supermemory local: already up on ${cfg.baseURL}`);
  } else {
    const res = await startSupermemory(cfg); // throws with log path on failure
    console.log(`supermemory local: up on ${cfg.baseURL} (pid ${res.pid})`);
  }

  const pid = daemonPid();
  if (pid) console.log(`ingest daemon: already running (pid ${pid})`);
  else await ingestDaemon(['--daemonize']);

  console.log("blackbox is up — 'blackbox status' for details.");
}
