// `blackbox ingest-daemon` — runs the spool->Supermemory pipeline + agent watcher.
//   --once        drain current spool and exit (no watcher)
//   --daemonize   detach into the background (pid + log under ~/.blackbox)
//   --stop        stop a daemonized instance
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, initConfig, paths } from '../../lib/config.js';
import { startIngestDaemon } from '../../daemon/ingestd.js';

export function daemonPid() {
  try {
    const pid = parseInt(fs.readFileSync(paths().daemonPid, 'utf8'), 10);
    if (pid > 0) {
      process.kill(pid, 0); // signal 0 = existence check
      return pid;
    }
  } catch {}
  return null;
}

export async function run(args) {
  const p = paths();

  if (args.includes('--stop')) {
    const pid = daemonPid();
    if (!pid) {
      console.log('blackbox daemon: not running.');
      return;
    }
    process.kill(pid, 'SIGTERM');
    console.log(`blackbox daemon: stopped (pid ${pid}).`);
    try { fs.unlinkSync(p.daemonPid); } catch {}
    return;
  }

  const cfg = initConfig();

  if (args.includes('--once')) {
    const d = startIngestDaemon(cfg, { withAgentWatcher: false });
    await d.drain();
    const s = d.stats();
    await d.close();
    console.log(`blackbox: drained spool — ${s.ingested} ingested, ${s.failed} quarantined, ${s.pending} still pending.`);
    if (s.lastError) console.error(`last error: ${s.lastError}`);
    return;
  }

  if (args.includes('--daemonize')) {
    const existing = daemonPid();
    if (existing) {
      console.log(`blackbox daemon: already running (pid ${existing}).`);
      return;
    }
    const self = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'blackbox.js');
    const out = fs.openSync(p.daemonLog, 'a');
    const child = spawn(process.execPath, [self, 'ingest-daemon'], {
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    child.unref();
    console.log(`blackbox daemon: started (pid ${child.pid}, log ${p.daemonLog}).`);
    return;
  }

  // foreground
  fs.writeFileSync(p.daemonPid, String(process.pid));
  const log = (msg) => console.error(`[${new Date().toISOString()}] ${msg}`);
  log(`blackbox ingest daemon starting (spool: ${p.spoolNew}, target: ${cfg.baseURL})`);
  const d = startIngestDaemon(cfg, { log });
  const shutdown = async () => {
    log('shutting down');
    await d.close();
    try { fs.unlinkSync(p.daemonPid); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // keep the process alive; chokidar watchers hold the loop, but be explicit
  setInterval(() => {}, 1 << 30);
}
