// `blackbox init` — opt-in git capture for the current repo: installs a
// post-commit hook inside marked BEGIN/END lines. Idempotent; preserves any
// existing hook content.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BEGIN = '# BEGIN BLACKBOX (managed — do not edit inside this block)';
const END = '# END BLACKBOX';
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'blackbox.js');

export function hookBlock() {
  return `${BEGIN}
command -v node >/dev/null 2>&1 && node ${JSON.stringify(cliPath)} _git-commit >/dev/null 2>&1 || true
${END}`;
}

export async function run() {
  let gitDir;
  try {
    gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.error('blackbox init: not inside a git repository.');
    process.exit(1);
  }
  const hooksDir = path.resolve(gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookFile = path.join(hooksDir, 'post-commit');

  let existing = '';
  try {
    existing = fs.readFileSync(hookFile, 'utf8');
  } catch {}

  if (existing.includes(BEGIN)) {
    // refresh block in place (cli path may have moved)
    const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    fs.writeFileSync(hookFile, existing.replace(re, hookBlock()));
    console.log('blackbox init: post-commit hook already installed — refreshed.');
  } else if (existing.trim()) {
    fs.writeFileSync(hookFile, existing.replace(/\n*$/, '\n\n') + hookBlock() + '\n');
    console.log('blackbox init: appended to existing post-commit hook.');
  } else {
    fs.writeFileSync(hookFile, `#!/bin/sh\n${hookBlock()}\n`);
    console.log('blackbox init: post-commit hook installed.');
  }
  fs.chmodSync(hookFile, 0o755);
  console.log('Commits in this repo will now be recorded (locally, ~/.blackbox spool).');
}
