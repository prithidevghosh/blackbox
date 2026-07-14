// `blackbox rca <TICKET-ID>` — draft a root-cause analysis for a ticket from
// every recorded source: terminal commands, agent sessions, git commits.
//   --out file.md   write the RCA markdown to a file
//   --no-llm        timeline only (also the automatic Ollama-down fallback)
import fs from 'node:fs';
import { loadConfig } from '../../lib/config.js';
import { alive } from '../../lib/supermemory.js';
import { fetchWindow } from '../../lib/window.js';
import { generate } from '../../lib/ollama.js';
import { sourceBadge, exitBadge, relativeTime, keyLines, bold, dim } from '../../lib/format.js';

export function renderTimeline(events) {
  const lines = [bold(`Timeline — ${events.length} events across ${new Set(events.map((e) => e.metadata.source)).size} sources`), ''];
  for (const ev of events) {
    const md = ev.metadata;
    const head = [
      dim(md.ts || ev.createdAt || ''),
      sourceBadge(md),
      md.session ? dim(`session ${String(md.session).slice(0, 8)}`) : '',
      exitBadge(md),
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(head);
    lines.push(keyLines(ev.content, 3, 100).replace(/^/gm, '   '));
    lines.push('');
  }
  return lines.join('\n');
}

function eventForLlm(ev, i) {
  const md = ev.metadata;
  const oneLine = ev.content.replace(/\s+/g, ' ').slice(0, 300);
  const sess = md.session ? ` session=${String(md.session).slice(0, 8)}` : '';
  const hash = md.hash ? ` commit=${String(md.hash).slice(0, 10)}` : '';
  return `[${i + 1}] ${md.ts || ''} source=${md.source}${md.agent ? '/' + md.agent : ''}${sess}${hash}${
    md.exit_code !== undefined ? ` exit=${md.exit_code}` : ''
  } :: ${oneLine}`;
}

export async function run(args) {
  const ticket = args.find((a) => !a.startsWith('--'));
  const noLlm = args.includes('--no-llm');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

  if (!ticket) {
    console.error('usage: blackbox rca <TICKET-ID> [--out rca.md] [--no-llm]');
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!(await alive(cfg))) {
    console.error(`blackbox: Supermemory Local is not reachable at ${cfg.baseURL}. Try \`blackbox status\`.`);
    process.exit(2);
  }

  const events = await fetchWindow(cfg, { ticket });
  if (!events.length) {
    console.log(`No recorded events for ${ticket}. (Ticket ids are picked up from branch names, commit messages, commands and agent sessions.)`);
    return;
  }

  console.log(renderTimeline(events));

  let rca = null;
  if (!noLlm) {
    const context = events.map(eventForLlm).join('\n');
    rca = await generate(
      cfg,
      `Recorded events for ticket ${ticket}, chronological:\n\n${context}\n\nWrite the RCA for ${ticket} now.`,
      {
        system:
          'You draft a root-cause analysis (RCA) for a ticket from events recorded on a developer machine. Output markdown with exactly these sections: "# RCA: <ticket>", "## Summary" (2-3 sentences), "## Timeline" (bulleted, timestamped, chronological), "## Root Cause", "## Fix", "## Evidence" (cite event numbers like [3], including agent session ids and commit hashes when present). Use ONLY the provided events; if something is unknown, say "not captured". Be specific and terse.',
      }
    );
    if (!rca) console.log(dim('(Ollama unavailable — timeline only. Retry with Ollama running for a drafted RCA.)'));
  }

  if (rca) {
    if (outFile) {
      fs.writeFileSync(outFile, rca + `\n\n---\nDrafted locally by ${cfg.ollama.model} from ${events.length} recorded events. Verify before publishing.\n`);
      console.log(`RCA written to ${outFile}`);
    } else {
      console.log(rca);
      console.log(dim(`\n(drafted locally by ${cfg.ollama.model} from ${events.length} events — verify before publishing)`));
    }
  }
}
