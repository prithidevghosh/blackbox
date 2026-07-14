// Parser for Claude Code session transcripts (~/.claude/projects/**/<uuid>.jsonl).
// Format documented from real files in docs/api-notes.md. One JSONL line in,
// zero or more normalized events out. Unknown/malformed lines -> [] (never throw).

const SYNTHETIC_RE =
  /^\s*<(ide_opened_file|ide_selection|system-reminder|command-name|command-message|command-args|local-command-stdout|task-notification)[\s>]/;

const MAX_CONTENT = 16 * 1024; // spool-side cap; daemon applies config maxOutputBytes later
const TOOL_RESULT_CAP = 1024;

function clip(s, n = MAX_CONTENT) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s;
}

function envelope(o) {
  return {
    source: 'agent',
    agent: 'claude-code',
    session: o.sessionId || null,
    ts: o.timestamp || new Date().toISOString(),
    cwd: o.cwd || null,
    branch: o.gitBranch || null,
  };
}

// Compact one-line rendering of a tool invocation.
export function renderToolUse(block) {
  const input = block.input || {};
  const detail =
    input.command || input.file_path || input.path || input.pattern || input.url || input.query ||
    input.prompt || input.description || '';
  return `[tool:${block.name}] ${clip(String(detail), 500)}`.trim();
}

export function parseLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!o || typeof o !== 'object') return [];

  if (o.type === 'user' && o.message?.role === 'user') {
    const content = o.message.content;
    const events = [];
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text && !SYNTHETIC_RE.test(b.text)) {
        events.push({ ...envelope(o), kind: 'user_prompt', content: clip(b.text) });
      } else if (b.type === 'tool_result') {
        const out = o.toolUseResult?.stdout ?? (typeof b.content === 'string' ? b.content : '');
        const err = o.toolUseResult?.stderr || '';
        const text = [out, err].filter(Boolean).join('\n');
        if (text.trim()) {
          events.push({ ...envelope(o), kind: 'tool_result', is_error: b.is_error === true, content: clip(text, TOOL_RESULT_CAP) });
        }
      }
    }
    return events;
  }

  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    const events = [];
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text?.trim()) {
        events.push({ ...envelope(o), kind: 'assistant_text', model: o.message.model, content: clip(b.text) });
      } else if (b.type === 'tool_use') {
        events.push({ ...envelope(o), kind: 'tool_use', model: o.message.model, tool: b.name, content: renderToolUse(b) });
      }
      // thinking blocks skipped: signature-encrypted, often empty
    }
    return events;
  }

  // queue-operation / file-history-snapshot / ai-title / attachment / mode / …
  return [];
}

// Claude Code munges the project path into the directory name; keep it as a
// project hint (cwd on each line is the authoritative repo signal).
export function projectFromDir(dirName) {
  return dirName || null;
}
