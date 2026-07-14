// `blackbox ask "<question>"` — semantic search over everything you did.
//   --limit N    (default 5)
//   --explain    ground an Ollama answer in the results (falls back gracefully)
//   --json       raw results
import { loadConfig } from '../../lib/config.js';
import { search, alive } from '../../lib/supermemory.js';
import { sourceBadge, exitBadge, relativeTime, keyLines, bold, dim } from '../../lib/format.js';

export function parseArgs(args) {
  const out = { query: [], limit: 5, explain: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit') out.limit = parseInt(args[++i], 10) || 5;
    else if (a === '--explain') out.explain = true;
    else if (a === '--json') out.json = true;
    else out.query.push(a);
  }
  out.query = out.query.join(' ').trim();
  return out;
}

export function renderResult(r, i) {
  const md = r.metadata || {};
  const head = [
    `${i + 1}.`,
    sourceBadge(md),
    dim(relativeTime(md.ts || r.createdAt)),
    md.repo ? bold(md.repo) : '',
    md.ticket ? `⧉ ${md.ticket}` : '',
    exitBadge(md),
  ]
    .filter(Boolean)
    .join(' ');
  const body = keyLines(r.chunks?.filter((ch) => ch.isRelevant !== false).map((ch) => ch.content).join('\n') || r.title, 5);
  return `${head}\n${body.replace(/^/gm, '   ')}`;
}

export async function run(args) {
  const { query, limit, explain, json } = parseArgs(args);
  if (!query) {
    console.error('usage: blackbox ask "<question>" [--explain] [--limit N] [--json]');
    process.exit(1);
  }
  const cfg = loadConfig();
  if (!(await alive(cfg))) {
    console.error(`blackbox: Supermemory Local is not reachable at ${cfg.baseURL}.`);
    console.error('Start it with:  blackbox status  for diagnosis, or see README quickstart.');
    process.exit(2);
  }

  const res = await search(cfg, query, { limit, containerTags: [cfg.containerTag] });
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.results?.length) {
    console.log('No matches. (Is the ingest daemon running? Try `blackbox status`.)');
    return;
  }

  console.log(dim(`${res.total} result${res.total === 1 ? '' : 's'} · ${res.timing}ms\n`));
  res.results.forEach((r, i) => console.log(renderResult(r, i) + '\n'));

  if (explain) {
    const { explainResults } = await import('../../lib/ollama.js');
    await explainResults(cfg, query, res.results);
  }
}
