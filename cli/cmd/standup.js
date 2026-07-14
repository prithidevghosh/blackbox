// `blackbox standup [--since 24h]` — draft a standup from everything recorded.
// With Ollama: Worked on / Fixed / Blocked markdown. Without: grouped summary.
import { loadConfig } from '../../lib/config.js';
import { alive } from '../../lib/supermemory.js';
import { fetchWindow, groupForStandup } from '../../lib/window.js';
import { generate } from '../../lib/ollama.js';
import { parseWindow, bold, dim } from '../../lib/format.js';

function fallbackStandup(groups, sinceLabel) {
  const lines = [bold(`Standup — last ${sinceLabel}`), ''];
  if (!groups.length) return lines.concat(['Nothing recorded in this window.']).join('\n');
  for (const g of groups) {
    lines.push(bold(`${g.repo}${g.ticket ? ` (${g.ticket})` : ''}`));
    const bits = [];
    if (g.terminal) bits.push(`${g.terminal} terminal command${g.terminal > 1 ? 's' : ''}${g.failures.length ? ` (${g.failures.length} failed)` : ''}`);
    if (g.agent) bits.push(`${g.agent} AI-agent exchange${g.agent > 1 ? 's' : ''}`);
    if (g.commits.length) bits.push(`${g.commits.length} commit${g.commits.length > 1 ? 's' : ''}`);
    lines.push(`  • ${bits.join(', ')}`);
    for (const c of g.commits) {
      const firstLine = (c.content.split('\n').find((l) => /^(fix|feat|chore|docs|refactor|test|perf)/i.test(l.trim())) || c.content.split('\n')[1] || '').trim();
      if (firstLine) lines.push(`  • committed: ${firstLine}`);
    }
    for (const f of g.failures.slice(0, 3)) {
      const cmd = (c => c ? c.trim() : '')(f.content.split('\n').find((l) => l.trim().startsWith('$')));
      lines.push(`  • ${dim('failure:')} ${cmd || f.content.slice(0, 80)} (exit ${f.metadata.exit_code})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function eventLine(ev) {
  const md = ev.metadata;
  const oneLine = ev.content.replace(/\s+/g, ' ').slice(0, 220);
  return `- [${md.source}${md.agent ? ':' + md.agent : ''}] ${md.ts || ''} ${md.repo || ''} ${md.ticket || ''} ${
    md.exit_code !== undefined ? `exit=${md.exit_code}` : ''
  } :: ${oneLine}`;
}

export async function run(args) {
  const cfg = loadConfig();
  let sinceLabel = '24h';
  let noLlm = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since') sinceLabel = args[++i] || '24h';
    else if (args[i] === '--no-llm') noLlm = true;
  }
  if (!(await alive(cfg))) {
    console.error(`blackbox: Supermemory Local is not reachable at ${cfg.baseURL}. Try \`blackbox status\`.`);
    process.exit(2);
  }
  const windowMs = parseWindow(sinceLabel);
  const events = await fetchWindow(cfg, { sinceEpoch: Math.floor((Date.now() - windowMs) / 1000) });
  const groups = groupForStandup(events);

  if (!noLlm && events.length) {
    const context = events.map(eventLine).join('\n');
    const md = await generate(
      cfg,
      `Activity recorded on this developer's machine in the last ${sinceLabel} (terminal, AI agent sessions, git commits), chronological:\n\n${context}\n\nWrite the standup now.`,
      {
        system:
          'You write a developer standup from recorded activity. Output markdown with exactly three sections: "## Worked on", "## Fixed", "## Blocked". Group items by repo and ticket id (e.g. PROJ-123). Base every item ONLY on the provided events; never invent work. Under "Fixed", include failures that were later resolved (a failing command or bug followed by a fix commit). Under "Blocked", list unresolved failures. Keep items short, past tense. If a section is empty, write "- nothing".',
      }
    );
    if (md) {
      console.log(md);
      console.log(dim(`\n(generated locally by ${cfg.ollama.model} from ${events.length} events — verify before posting)`));
      return;
    }
    console.error(dim('(Ollama unavailable — falling back to grouped summary)'));
  }
  console.log(fallbackStandup(groups, sinceLabel));
}
