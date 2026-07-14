// Parser for Codex CLI rollout transcripts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
// NOTE: Codex CLI is not installed on the dev machine, so unlike claude-code.js this
// is written against the open-source rollout format + a hand-built fixture, not
// live-verified files (see DECISIONS.md D4). Same contract: line in, events out,
// never throw.

const MAX_CONTENT = 16 * 1024;
const TOOL_RESULT_CAP = 1024;

function clip(s, n = MAX_CONTENT) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

// Session-level context (cwd, session id) arrives once in session_meta, so the
// watcher keeps a per-file state object and passes it back in.
export function newSessionState() {
  return { session: null, cwd: null };
}

export function parseLine(line, state = newSessionState()) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!o || typeof o !== 'object') return [];

  const base = () => ({
    source: 'agent',
    agent: 'codex',
    session: state.session,
    ts: o.timestamp || new Date().toISOString(),
    cwd: state.cwd,
    branch: null,
  });

  if (o.type === 'session_meta' && o.payload) {
    state.session = o.payload.id || null;
    state.cwd = o.payload.cwd || null;
    return [];
  }

  if (o.type !== 'response_item' || !o.payload) return [];
  const p = o.payload;

  if (p.type === 'message' && Array.isArray(p.content)) {
    const text = p.content
      .filter((c) => (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') && c.text)
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (!text || text.startsWith('<')) return []; // codex wraps env/system context in tags too
    return [{ ...base(), kind: p.role === 'user' ? 'user_prompt' : 'assistant_text', content: clip(text) }];
  }

  if (p.type === 'function_call') {
    let detail = p.arguments || '';
    try {
      const a = JSON.parse(p.arguments);
      detail = a.command ? (Array.isArray(a.command) ? a.command.join(' ') : a.command) : p.arguments;
    } catch {}
    return [{ ...base(), kind: 'tool_use', tool: p.name || 'unknown', content: clip(`[tool:${p.name}] ${detail}`, 500) }];
  }

  if (p.type === 'function_call_output' && p.output) {
    const text = typeof p.output === 'string' ? p.output : p.output.content || '';
    if (!String(text).trim()) return [];
    return [{ ...base(), kind: 'tool_result', content: clip(String(text), TOOL_RESULT_CAP) }];
  }

  if (p.type === 'reasoning' && Array.isArray(p.summary)) {
    const text = p.summary.map((s) => s.text || '').join('\n').trim();
    if (!text) return [];
    return [{ ...base(), kind: 'assistant_text', content: clip(text) }];
  }

  return [];
}
