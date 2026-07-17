// Guard (Feature A): push-based memory for the agent. Pure selection,
// formatting, and dedupe-state logic for `blackbox guard-hook` — everything
// here is synchronous and side-effect-free except the small state file, so it
// unit-tests without a Claude Code session. The fail-open/timeout guarantees
// live in cli/cmd/guard-hook.js.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { newestFix, supersedeNote } from './staleness.js';

// command prefixes that wrap the real binary
const WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'exec', 'stdbuf']);
// binaries whose first argument is the meaningful subcommand
const RUNNERS = new Set([
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'git', 'docker', 'docker-compose', 'kubectl',
  'cargo', 'go', 'make', 'pip', 'pip3', 'uv', 'poetry', 'terraform', 'bundle', 'rails',
  'mvn', 'gradle', 'brew', 'systemctl',
]);

// "npm run dev" -> { bin: "npm", sub: "run" }; env prefixes and wrappers skipped.
export function commandKey(cmd) {
  const toks = String(cmd || '')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  while (toks.length && WRAPPERS.has(toks[0])) toks.shift();
  if (!toks.length) return null;
  const bin = toks[0].split('/').pop();
  let sub = null;
  if (RUNNERS.has(bin)) sub = toks.slice(1).find((t) => !t.startsWith('-')) || null;
  return { bin, sub };
}

// Hook stdin JSON -> the Bash command string, or null for anything else
// (non-Bash tools, missing fields — caller allows silently).
export function extractBashCommand(input) {
  if (!input || input.tool_name !== 'Bash') return null;
  const cmd = String(input.tool_input?.command || '').trim();
  return cmd || null;
}

function contentOf(r) {
  return (
    r.chunks?.filter((c) => c.isRelevant !== false).map((c) => c.content).join('\n') ||
    r.title ||
    ''
  );
}

// The command a stored event was about: terminal docs carry "$ <cmd>",
// agent tool_use docs carry "[tool:Bash] <cmd>". null when not extractable.
export function commandFromContent(text) {
  const m = String(text || '').match(/^\$ (.+)$/m) || String(text || '').match(/\[tool:Bash\] (.+)/);
  return m ? m[1].trim() : null;
}

const FAILURE_RE = /\bfail|error|exception|denied|refused|NOAUTH|traceback|fatal|panic/i;

function isFailure(r) {
  const md = r.metadata || {};
  if (md.source === 'terminal') return typeof md.exit_code === 'number' && md.exit_code !== 0;
  if (md.source === 'agent') return md.kind === 'tool_result' && FAILURE_RE.test(contentOf(r));
  return false;
}

// Pick the past failure to warn about: above threshold, terminal/agent failure,
// and — when the stored event's own command is extractable — same binary
// (+ subcommand when both sides have one). Events without an extractable
// command pass on semantic score alone. The NEWEST git commit above threshold
// rides along as the fix (V7 — older competing fixes are superseded, not
// deleted). null = nothing confident to say.
export function selectGuardMatch(results, command, threshold) {
  const key = commandKey(command);
  const above = (results || []).filter((r) => (r.score ?? 0) >= threshold);
  const hit =
    above.filter(isFailure).find((r) => {
      const past = commandKey(commandFromContent(contentOf(r)));
      if (!past || !key) return true;
      return past.bin === key.bin && (!key.sub || !past.sub || past.sub === key.sub);
    }) || null;
  const { fix, supersedes } = newestFix(above.filter((r) => r.metadata?.source === 'git'));
  return hit ? { hit, gitFix: fix, supersedes } : null;
}

function dateOf(r) {
  const iso = r.metadata?.ts || r.createdAt || '';
  return iso ? iso.slice(0, 10) : 'unknown date';
}

// First line of the failure output that names the error (skips the "$ cmd" line).
function rootCauseLine(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('$ ') && !l.startsWith('[tool:') && !/^Terminal command|^AI coding session/.test(l));
  return (lines.find((l) => FAILURE_RE.test(l)) || lines[0] || '').slice(0, 160);
}

// ≤3 plain-text lines injected into the agent's context: when it failed, root
// cause, the fix (with staleness/supersede annotations when known), and the
// session/date. No ANSI — this goes to a model, not a TTY.
export function formatGuardContext({ hit, gitFix, supersedes }, command = '', { fixNote = null } = {}) {
  const md = hit.metadata || {};
  const where = [md.repo ? `repo ${md.repo}` : '', typeof md.exit_code === 'number' ? `exit ${md.exit_code}` : '']
    .filter(Boolean)
    .join(', ');
  const lines = [
    `blackbox guard: this command failed before on ${dateOf(hit)}${where ? ` (${where})` : ''}: ${rootCauseLine(contentOf(hit))}`,
  ];
  if (gitFix) {
    const fix = String(contentOf(gitFix)).split('\n').map((l) => l.trim()).filter((l) => l && !/^Git commit/.test(l) && !/^files changed:/.test(l))[0] || '';
    const extras = [fixNote, supersedeNote(supersedes)].filter(Boolean);
    if (fix) lines.push(`fix at the time (git, ${dateOf(gitFix)}): ${fix.slice(0, 160)}${extras.length ? ` [${extras.join('; ')}]` : ''}`);
  }
  const q = command.length > 48 ? command.slice(0, 48).trimEnd() + '…' : command;
  lines.push(`recorded in session ${md.session || 'unknown'} — advisory only; details: blackbox ask ${JSON.stringify(q)}`);
  return lines.join('\n');
}

// ── dedupe state: one injection per (agent session, command) ──────────────
// Tiny JSON file under BLACKBOX_HOME; any read/write error degrades to "not
// seen yet" — worst case a repeated hint, never a crash.
const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 7 * 86_400_000;

function statePath() {
  return path.join(paths().home, 'guard-state.json');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

const norm = (cmd) => String(cmd || '').trim().replace(/\s+/g, ' ');

export function alreadyInjected(sessionId, command) {
  try {
    return loadState().sessions[sessionId]?.cmds?.includes(norm(command)) || false;
  } catch {
    return false;
  }
}

export function markInjected(sessionId, command) {
  try {
    const state = loadState();
    const now = Date.now();
    const entry = state.sessions[sessionId] || { at: now, cmds: [] };
    entry.at = now;
    if (!entry.cmds.includes(norm(command))) entry.cmds.push(norm(command));
    state.sessions[sessionId] = entry;
    const ids = Object.entries(state.sessions)
      .filter(([, s]) => now - (s.at || 0) < SESSION_TTL_MS)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, MAX_SESSIONS);
    state.sessions = Object.fromEntries(ids);
    fs.mkdirSync(paths().home, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    // dedupe is best-effort; losing it never breaks the hook
  }
}
