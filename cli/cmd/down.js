// `blackbox down` — stop the ingest daemon and any Supermemory Local server
// that `blackbox up`/`setup` started (a server started elsewhere is left
// alone). Shell hooks keep spooling; everything drains on the next `up`.
import { loadConfig } from '../../lib/config.js';
import { alive } from '../../lib/supermemory.js';
import { stopSupermemory } from '../../lib/services.js';
import { run as ingestDaemon } from './ingest-daemon.js';

export async function run() {
  await ingestDaemon(['--stop']);

  const pid = stopSupermemory();
  if (pid) console.log(`supermemory local: stopped (pid ${pid}).`);
  else if (await alive(loadConfig())) console.log('supermemory local: running, but not started by blackbox — leaving it alone.');
  else console.log('supermemory local: not running.');

  console.log('blackbox is down — events keep spooling; they drain on the next `blackbox up`.');
}
