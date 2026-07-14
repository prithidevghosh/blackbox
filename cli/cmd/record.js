// `blackbox record` — output-recorded subshell. Wraps an interactive zsh in
// script(1); the blackbox.zsh hooks (in BLACKBOX_RECORD mode) emit sentinels
// that RecordParser splits into per-command events with captured output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDirs } from '../../lib/config.js';
import { spoolEvent } from '../../lib/spool.js';
import { RecordParser } from '../../lib/record-parser.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function run() {
  const cfg = loadConfig();
  ensureDirs();

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-record-'));
  const tsFile = path.join(work, 'typescript');
  fs.writeFileSync(tsFile, '');

  // ZDOTDIR shim: user's zshrc first, then our hooks in record mode.
  const zdot = path.join(work, 'zdot');
  fs.mkdirSync(zdot);
  const userZshenv = path.join(os.homedir(), '.zshenv');
  const userZshrc = path.join(os.homedir(), '.zshrc');
  fs.writeFileSync(
    path.join(zdot, '.zshenv'),
    `export BLACKBOX_RECORD=1\n[[ -f ${JSON.stringify(userZshenv)} ]] && source ${JSON.stringify(userZshenv)}\n`
  );
  fs.writeFileSync(
    path.join(zdot, '.zshrc'),
    `ZDOTDIR=$HOME\n[[ -f ${JSON.stringify(userZshrc)} ]] && source ${JSON.stringify(userZshrc)}\nexport BLACKBOX_RECORD=1\nsource ${JSON.stringify(path.join(repoRoot, 'shell', 'blackbox.zsh'))}\n`
  );

  const parser = new RecordParser({
    sessionId: `record-${process.pid}-${Date.now()}`,
    maxOutputBytes: cfg.maxOutputBytes,
  });
  const ignore = new Set(cfg.ignore || []);
  let recorded = 0;

  const handle = (events) => {
    for (const ev of events) {
      if (!ev.command?.trim()) continue;
      if (ignore.has(ev.command.trim().split(/\s+/)[0])) continue;
      spoolEvent(ev);
      recorded++;
    }
  };

  // tail the typescript file as script(1) writes it
  let offset = 0;
  const poll = setInterval(() => {
    try {
      const size = fs.statSync(tsFile).size;
      if (size > offset) {
        const fd = fs.openSync(tsFile, 'r');
        const buf = Buffer.alloc(size - offset);
        const read = fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset += read;
        handle(parser.push(buf.subarray(0, read)));
      }
    } catch {}
  }, 200);

  console.log('blackbox: recording session (commands + output). Type `exit` to stop.');
  const child = spawn('script', ['-q', tsFile, 'zsh', '-i'], {
    stdio: 'inherit',
    env: { ...process.env, ZDOTDIR: zdot, BLACKBOX_RECORD: '1' },
  });

  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearInterval(poll);
  // final drain
  try {
    const size = fs.statSync(tsFile).size;
    if (size > offset) {
      const fd = fs.openSync(tsFile, 'r');
      const buf = Buffer.alloc(size - offset);
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      handle(parser.push(buf.subarray(0, read)));
    }
  } catch {}
  handle(parser.flush());
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`blackbox: session ended — ${recorded} command${recorded === 1 ? '' : 's'} recorded with output.`);
  process.exit(code ?? 0);
}
