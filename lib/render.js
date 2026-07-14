// Turns a spool event (already redacted + correlated) into a Supermemory
// document: natural-language content for good embeddings, structured metadata
// for filtering and display.

function tsOf(event) {
  if (event.ts) return event.ts;
  if (event.ts_epoch) return new Date(event.ts_epoch * 1000).toISOString();
  return new Date().toISOString();
}

function contextLine(event) {
  const parts = [];
  if (event.repo) parts.push(`repo ${event.repo}`);
  if (event.branch) parts.push(`branch ${event.branch}`);
  if (event.ticket) parts.push(`ticket ${event.ticket}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

const AGENT_KIND_LABEL = {
  user_prompt: 'the developer asked',
  assistant_text: 'the agent explained',
  tool_use: 'the agent ran',
  tool_result: 'tool output was',
};

export function eventToDocument(event, cfg) {
  const ts = tsOf(event);
  let content;

  if (event.source === 'terminal') {
    const lines = [`Terminal command${contextLine(event)}:`, `$ ${event.command}`];
    if (event.output) lines.push(event.output);
    if (event.exit_code !== null && event.exit_code !== undefined) {
      lines.push(event.exit_code === 0 ? 'exited 0 (success)' : `FAILED with exit code ${event.exit_code}`);
    }
    content = lines.join('\n');
  } else if (event.source === 'agent') {
    const label = AGENT_KIND_LABEL[event.kind] || 'the agent noted';
    content = `AI coding session (${event.agent})${contextLine(event)} — ${label}:\n${event.content}`;
  } else if (event.source === 'git') {
    const lines = [
      `Git commit ${String(event.hash || '').slice(0, 10)}${contextLine(event)}:`,
      event.message || '',
    ];
    if (event.files?.length) lines.push(`files changed: ${event.files.join(', ')}`);
    if (event.stats) lines.push(event.stats);
    content = lines.filter(Boolean).join('\n');
  } else {
    content = event.content || JSON.stringify(event);
  }

  const metadata = {
    source: event.source,
    ts,
    ts_epoch: event.ts_epoch ?? Math.floor(new Date(ts).getTime() / 1000),
  };
  // Supermemory metadata is flat; only set keys that have values
  for (const [k, v] of Object.entries({
    kind: event.kind,
    agent: event.agent,
    session: event.session || event.session_id,
    repo: event.repo,
    branch: event.branch,
    ticket: event.ticket,
    cwd: event.cwd,
    exit_code: event.exit_code,
    duration_ms: event.duration_ms,
    hash: event.hash,
    tool: event.tool,
    recorded: event.recorded,
  })) {
    if (v !== null && v !== undefined) metadata[k] = v;
  }

  return { content, containerTag: cfg.containerTag || 'blackbox', metadata };
}
