// Config + paths. Everything blackbox writes lives under BLACKBOX_HOME
// (default ~/.blackbox) so tests can point it at a temp dir.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULTS = {
  baseURL: 'http://localhost:6767',
  apiKey: '', // Supermemory Local auto-authenticates localhost requests (see docs/api-notes.md)
  containerTag: 'blackbox',
  sources: { terminal: true, agent: true, git: true },
  // exact command words (first token) never recorded
  ignore: ['cd', 'ls', 'll', 'la', 'pwd', 'clear', 'exit', 'history', 'bg', 'fg', 'jobs', 'which'],
  maxOutputBytes: 8192,
  ollama: { baseURL: 'http://localhost:11434', model: 'llama3.2:3b' },
  // proactive hint on failed commands; threshold calibrated in DECISIONS.md D9
  flashback: { enabled: true, similarity_threshold: 0.72 },
  // guard: inject past-failure context into Claude Code before a Bash command
  // runs (PreToolUse hook). Advise-only, fail-open; timeout is the hard cap on
  // the whole hook run in ms. Threshold is lower than flashback's because guard
  // sees near-miss variants, not verbatim repeats, and its binary/subcommand
  // gate adds a second filter (calibration in DECISIONS.md D7).
  guard: { enabled: true, threshold: 0.65, timeout_ms: 800 },
  ticketRegex: '[A-Z][A-Z0-9]+-\\d+',
  jiraBaseURL: '',
  agents: {
    'claude-code': { dir: '~/.claude/projects', enabled: true },
    codex: { dir: '~/.codex/sessions', enabled: true },
  },
};

export function home() {
  return process.env.BLACKBOX_HOME || path.join(os.homedir(), '.blackbox');
}

export function paths() {
  const h = home();
  return {
    home: h,
    config: path.join(h, 'config.json'),
    spool: path.join(h, 'spool'),
    spoolTmp: path.join(h, 'spool', 'tmp'),
    spoolNew: path.join(h, 'spool', 'new'),
    spoolFailed: path.join(h, 'spool', 'failed'),
    checkpoints: path.join(h, 'checkpoints.json'),
    daemonPid: path.join(h, 'daemon.pid'),
    daemonLog: path.join(h, 'daemon.log'),
    smPid: path.join(h, 'supermemory.pid'),
    smLog: path.join(h, 'supermemory.log'),
    ollamaPid: path.join(h, 'ollama.pid'),
    ollamaLog: path.join(h, 'ollama.log'),
  };
}

export function expandTilde(p) {
  if (p && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k])
        ? merge(base[k], v)
        : v;
  }
  return out;
}

export function ensureDirs() {
  const p = paths();
  for (const dir of [p.home, p.spool, p.spoolTmp, p.spoolNew, p.spoolFailed]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

export function loadConfig() {
  const p = paths();
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`blackbox: config unreadable (${err.message}), using defaults`);
    }
  }
  return merge(DEFAULTS, user);
}

// Write config.json with defaults if missing; returns config either way.
export function initConfig() {
  const p = ensureDirs();
  if (!fs.existsSync(p.config)) {
    fs.writeFileSync(p.config, JSON.stringify(DEFAULTS, null, 2) + '\n');
  }
  return loadConfig();
}
