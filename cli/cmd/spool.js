// Internal: `blackbox _spool '<json>'` or `... | blackbox _spool -`
// Used by the git post-commit hook and the e2e harness.
import { spoolEvent } from '../../lib/spool.js';

export async function run(args) {
  let raw = args[0];
  if (!raw || raw === '-') {
    raw = await new Promise((resolve) => {
      let buf = '';
      process.stdin.on('data', (d) => (buf += d));
      process.stdin.on('end', () => resolve(buf));
    });
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch (err) {
    console.error(`blackbox _spool: invalid JSON: ${err.message}`);
    process.exit(1);
  }
  spoolEvent(event);
}
