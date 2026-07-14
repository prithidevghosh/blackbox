// Maildir-style spool: writers create a file in spool/tmp and rename() it into
// spool/new — atomic on the same filesystem, so the daemon never sees a partial
// event and concurrent writers (zsh hook, watchers, git hook) never contend.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDirs } from './config.js';

export function spoolEvent(event) {
  const p = ensureDirs();
  const name = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`;
  const tmp = path.join(p.spoolTmp, name);
  const dst = path.join(p.spoolNew, name);
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, ts: new Date().toISOString(), ...event }) + '\n');
  fs.renameSync(tmp, dst);
  return dst;
}

// List pending event files oldest-first (names sort chronologically by design).
export function pendingEvents() {
  const p = ensureDirs();
  return fs
    .readdirSync(p.spoolNew)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(p.spoolNew, f));
}

// Read one spooled event; returns null (and quarantines the file) if unparseable.
export function readEvent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    quarantine(file);
    return null;
  }
}

export function removeEvent(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

export function quarantine(file) {
  const p = ensureDirs();
  try {
    fs.renameSync(file, path.join(p.spoolFailed, path.basename(file)));
  } catch {}
}
