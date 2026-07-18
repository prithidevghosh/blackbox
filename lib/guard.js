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
// "$ " is matched mid-line too: Supermemory Local collapses newlines inside
// chunks, so the marker usually follows the collapsed header on one line
// (commandKey only needs the leading tokens, so trailing output is harmless).
export function commandFromContent(text) {
  const m = String(text || '').match(/\$ (.+)$/m) || String(text || '').match(/\[tool:Bash\] (.+)/);
  return m ? m[1].trim() : null;
}

const FAILURE_RE = /\bfail|error|exception|denied|refused|NOAUTH|traceback|fatal|panic/i;

function isFailure(r) {
  const md = r.metadata || {};
  if (md.source === 'terminal') return typeof md.exit_code === 'number' && md.exit_code !== 0;
  if (md.source === 'agent') return md.kind === 'tool_result' && FAILURE_RE.test(contentOf(r));
  return false;
}

// A passive zsh capture of a failure has no output, so its whole story is
// "FAILED with exit code N". When a recorded twin of the same failure exists
// (with the actual error text), the informative one should lead — otherwise a
// fresh bare re-run of an old failure hides its own history (D9).
const BARE_FAILURE_RE = /^FAILED with exit code \d+/;
export function informative(r) {
  const line = rootCauseLine(contentOf(r));
  return !!line && !BARE_FAILURE_RE.test(line);
}

// Pick the past failure to warn about: above threshold, terminal/agent failure,
// and — when the stored event's own command is extractable — same binary
// (+ subcommand when both sides have one). Events without an extractable
// command pass on semantic score alone; informative failures outrank bare
// ones (D9). The NEWEST git commit above threshold in the hit's repo rides
// along as the fix (V7/D9 — older competing fixes are superseded, not
// deleted). null = nothing confident to say.
export function selectGuardMatch(results, command, threshold) {
  const key = commandKey(command);
  const above = (results || []).filter((r) => (r.score ?? 0) >= threshold);
  const candidates = above.filter(isFailure).filter((r) => {
    const past = commandKey(commandFromContent(contentOf(r)));
    if (!past || !key) return true;
    return past.bin === key.bin && (!key.sub || !past.sub || past.sub === key.sub);
  });
  const hit = candidates.find(informative) || candidates[0] || null;
  if (!hit) return null;
  const repo = hit.metadata?.repo || null;
  const { fix, supersedes } = newestFix(
    above.filter((r) => r.metadata?.source === 'git' && (!repo || r.metadata?.repo === repo))
  );
  return { hit, gitFix: fix, supersedes };
}

function dateOf(r) {
  const iso = r.metadata?.ts || r.createdAt || '';
  return iso ? iso.slice(0, 10) : 'unknown date';
}

// The segment of the failure output that names the error. Line-based when real
// newlines survive; Supermemory Local collapses newlines inside chunks, so the
// fallback recovers the error segment from the single collapsed line.
export function rootCauseLine(text) {
  const raw = String(text || '');
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('$ ') && !l.startsWith('[tool:') && !/^Terminal command|^AI coding session|^Git commit/.test(l));
  const line = lines.find((l) => FAILURE_RE.test(l));
  if (line) return line.slice(0, 160);
  const m = /[(\[]?\b(?:fail(?:ed)?|error|exception|denied|refused|NOAUTH|traceback|fatal|panic)\b/i.exec(raw);
  if (m) return raw.slice(m.index, m.index + 160).split('\n')[0];
  return (lines[0] || '').slice(0, 160);
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
    const raw = String(contentOf(gitFix)).split('\n').map((l) => l.trim()).filter(Boolean);
    let fix = raw.filter((l) => !/^Git commit/.test(l) && !/^files changed:/.test(l))[0] || '';
    if (!fix && raw[0]) {
      // Supermemory Local collapses newlines inside chunks — recover the
      // commit message from the single collapsed "Git commit …: <msg> …" line
      fix = raw[0].replace(/^Git commit [0-9a-f]{7,40}[^:]*:\s*/, '').split(/\s+files changed:/)[0].trim();
    }
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
