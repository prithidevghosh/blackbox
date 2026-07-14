// `blackbox status` — one-glance health of every component.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, paths, expandTilde } from '../../lib/config.js';
import { alive, listDocuments } from '../../lib/supermemory.js';
import { ollamaAlive } from '../../lib/ollama.js';
import { green, red, yellow, dim, bold } from '../../lib/format.js';
import { daemonPid } from './ingest-daemon.js';

const ok = (s) => `${green('●')} ${s}`;
const bad = (s) => `${red('●')} ${s}`;
const warn = (s) => `${yellow('●')} ${s}`;

export async function run() {
  const cfg = loadConfig();
  const p = paths();
  console.log(bold('blackbox status\n'));

  // supermemory
  if (await alive(cfg)) {
    let docCount = '?';
    try {
      const list = await listDocuments(cfg, { containerTags: [cfg.containerTag], limit: 1 });
      docCount = list.pagination?.totalItems ?? '?';
    } catch {}
    console.log(ok(`supermemory local     ${cfg.baseURL} — up, ${docCount} documents in '${cfg.containerTag}'`));
  } else {
    console.log(bad(`supermemory local     ${cfg.baseURL} — unreachable (capture still works; events wait in the spool)`));
  }

  // daemon
  const pid = daemonPid();
  let pending = 0;
  try {
    pending = fs.readdirSync(p.spoolNew).length;
  } catch {}
  console.log(pid ? ok(`ingest daemon         running (pid ${pid}), ${pending} events pending`) : bad(`ingest daemon         not running — start: blackbox ingest-daemon --daemonize${pending ? ` (${pending} events waiting)` : ''}`));

  // shell hooks
  let zshrc = '';
  try {
    zshrc = fs.readFileSync(path.join(os.homedir(), '.zshrc'), 'utf8');
  } catch {}
  console.log(
    zshrc.includes('BEGIN BLACKBOX')
      ? ok('zsh hooks             installed in ~/.zshrc (new shells record commands)')
      : warn('zsh hooks             not installed — run install.sh')
  );

  // agent transcript dirs
  for (const [name, a] of Object.entries(cfg.agents || {})) {
    if (a.enabled === false) continue;
    const dir = expandTilde(a.dir || '');
    console.log(fs.existsSync(dir) ? ok(`agent: ${name.padEnd(12)} watching ${dir}`) : warn(`agent: ${name.padEnd(12)} ${dir} not found (skipped)`));
  }

  // ollama
  if (await ollamaAlive(cfg)) {
    let hasModel = false;
    try {
      const res = await fetch(`${cfg.ollama.baseURL}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const tags = await res.json();
      hasModel = (tags.models || []).some((m) => m.name === cfg.ollama.model || m.name.startsWith(cfg.ollama.model));
    } catch {}
    console.log(
      hasModel
        ? ok(`ollama                ${cfg.ollama.baseURL} — up, model ${cfg.ollama.model} available`)
        : warn(`ollama                up, but model ${cfg.ollama.model} missing — ollama pull ${cfg.ollama.model} (ask/standup/rca fall back to no-LLM output)`)
    );
  } else {
    console.log(warn(`ollama                ${cfg.ollama.baseURL} — unreachable (ask/standup/rca fall back to no-LLM output)`));
  }

  // git hook in current repo
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let hook = '';
    try {
      hook = fs.readFileSync(path.resolve(gitDir, 'hooks', 'post-commit'), 'utf8');
    } catch {}
    console.log(hook.includes('BEGIN BLACKBOX') ? ok('git hook (this repo)  installed') : warn('git hook (this repo)  not installed — run: blackbox init'));
  } catch {
    console.log(dim('git hook (this repo)  n/a — not inside a git repository'));
  }

  console.log(dim(`\nhome ${p.home} · config ${p.config}`));
}
