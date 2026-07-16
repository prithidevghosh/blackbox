// `blackbox down` — stop the ingest daemon. Supermemory Local is left
// running by default: current server builds (Bun 1.3.4) can wedge in
// uninterruptible kernel exit on macOS when terminated — the process
// survives kill -9 and holds the port until reboot — so stopping it is
// opt-in via --all. Shell hooks keep spooling; everything drains on `up`.
import { loadConfig } from '../../lib/config.js';
import { alive } from '../../lib/supermemory.js';
import { stopSupermemory, stopOllama } from '../../lib/services.js';
import { run as ingestDaemon } from './ingest-daemon.js';

export async function run(args) {
  await ingestDaemon(['--stop']);

  const cfg = loadConfig();
  if (args.includes('--all')) {
    const pid = stopSupermemory();
    if (pid) console.log(`supermemory local: stopped (pid ${pid}) — if the port stays busy, the server wedged on exit and only a reboot frees it.`);
    else if (await alive(cfg)) console.log('supermemory local: running, but not started by blackbox — leaving it alone.');
    else console.log('supermemory local: not running.');
    const oPid = stopOllama();
    if (oPid) console.log(`ollama: stopped (pid ${oPid}).`);
  } else if (await alive(cfg)) {
    console.log('supermemory local: left running — stopping it can wedge the port until reboot (--all stops it anyway).');
  }

  console.log('blackbox is down — events keep spooling; they drain on the next `blackbox up`.');
}
