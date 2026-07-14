// Ollama client (raw fetch to localhost:11434). Every caller must survive
// Ollama being absent — generate() returns null on any failure and the
// commands fall back to non-LLM output.

export async function ollamaAlive(cfg, timeoutMs = 2000) {
  try {
    const res = await fetch(`${cfg.ollama.baseURL}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function generate(cfg, prompt, { system, timeoutMs = 180_000 } = {}) {
  try {
    const res = await fetch(`${cfg.ollama.baseURL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.ollama.model,
        prompt,
        system,
        stream: false,
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.response?.trim() || null;
  } catch {
    return null;
  }
}

function resultToContext(r, i) {
  const md = r.metadata || {};
  const what = [
    `source=${md.source}${md.agent ? `/${md.agent}` : ''}`,
    md.ts ? `time=${md.ts}` : '',
    md.repo ? `repo=${md.repo}` : '',
    md.ticket ? `ticket=${md.ticket}` : '',
    md.session ? `session=${String(md.session).slice(0, 8)}` : '',
    md.exit_code !== undefined ? `exit_code=${md.exit_code}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const body = r.chunks?.map((ch) => ch.content).join('\n') || r.title || '';
  return `[${i + 1}] ${what}\n${body}`;
}

export async function explainResults(cfg, query, results) {
  const context = results.map(resultToContext).join('\n\n');
  const answer = await generate(
    cfg,
    `Context — events recorded on this developer's machine (terminal commands, AI agent sessions, git commits):\n\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
    {
      system:
        'You answer questions about a developer\'s past work. Answer ONLY from the provided context events. Cite evidence inline like [1] or [2] referring to the numbered events, and mention session ids or commits when relevant. If the context does not contain the answer, say exactly that. Be concise: a short paragraph, then bullet points if needed.',
    }
  );
  if (answer) {
    console.log('─'.repeat(60));
    console.log(answer);
    console.log('─'.repeat(60));
    console.log(`(generated locally by ${cfg.ollama.model} — grounded in the results above)`);
  } else {
    console.log(`(--explain unavailable: Ollama not reachable at ${cfg.ollama.baseURL} or model ${cfg.ollama.model} missing — showing raw results only)`);
  }
}
