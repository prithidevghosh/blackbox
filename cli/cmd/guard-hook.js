// `blackbox guard-hook` — Claude Code PreToolUse hook (Feature A).
// Contract (verified live, docs/api-notes.md "PreToolUse hooks"): hook input
// JSON on stdin; on a confident past-failure match print
// {hookSpecificOutput:{hookEventName,additionalContext}} — deliberately NO
// permissionDecision, so the normal permission flow is untouched (D5) — and on
// every other outcome (non-Bash tool, no match, low confidence, disabled,
// supermemory down, parse error, timeout) exit 0 with zero output. A
// non-unref'd timer hard-caps the whole run (default 800ms): fail-open is the
// contract, nothing here may block or break the agent.
import { loadConfig } from '../../lib/config.js';
import { search } from '../../lib/supermemory.js';
import {
  extractBashCommand,
  selectGuardMatch,
  formatGuardContext,
  alreadyInjected,
  markInjected,
} from '../../lib/guard.js';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

export async function run() {
  const t0 = Date.now();
  let cap = 800;
  try {
    const cfg = loadConfig();
    cap = cfg.guard?.timeout_ms ?? 800;
    setTimeout(() => process.exit(0), cap); // hard cap: forces silent allow even if something hangs
    if (cfg.guard?.enabled === false) process.exit(0);

    const input = JSON.parse(await readStdin());
    const command = extractBashCommand(input);
    if (!command) process.exit(0);

    const sessionId = String(input.session_id || '');
    if (sessionId && alreadyInjected(sessionId, command)) process.exit(0);

    const budget = Math.max(cap - (Date.now() - t0) - 60, 50); // leave margin to format + print
    const res = await search(cfg, command, { limit: 8, containerTags: [cfg.containerTag] }, budget);
    const match = selectGuardMatch(res.results, command, cfg.guard?.threshold ?? 0.65);
    if (!match) process.exit(0);

    // Feature B: staleness check on the fix within whatever budget remains
    // (the hard-cap timer still guarantees the overall deadline)
    let fixNote = null;
    if (match.gitFix) {
      const { stalenessNote, STALENESS_BUDGET_MS } = await import('../../lib/staleness.js');
      const left = cap - (Date.now() - t0) - 40;
      if (left > 30) fixNote = stalenessNote(match.gitFix, { budgetMs: Math.min(left, STALENESS_BUDGET_MS) });
    }

    if (sessionId) markInjected(sessionId, command);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: formatGuardContext(match, command, { fixNote }),
        },
      }) + '\n'
    );
  } catch {
    // silence is the contract
  }
  process.exit(0);
}
