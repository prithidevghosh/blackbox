// Time-window fetch: list all blackbox docs, filter by metadata.ts_epoch,
// hydrate content for the ones in range. Used by standup and rca.
import { listDocuments, getDocument } from './supermemory.js';

export async function fetchWindow(cfg, { sinceEpoch = 0, untilEpoch = Infinity, ticket = null, maxDocs = 300 } = {}) {
  const docs = [];
  let page = 1;
  for (;;) {
    const res = await listDocuments(cfg, { containerTags: [cfg.containerTag], limit: 100, page });
    docs.push(...(res.memories || []));
    const p = res.pagination || {};
    if (!p.totalPages || page >= p.totalPages || docs.length >= maxDocs * 2) break;
    page++;
  }

  const inRange = docs.filter((d) => {
    const md = d.metadata || {};
    const t = md.ts_epoch ?? Math.floor(new Date(d.createdAt).getTime() / 1000);
    if (t < sinceEpoch || t > untilEpoch) return false;
    if (ticket && md.ticket !== ticket) return false;
    return true;
  });

  // hydrate full content (list omits it); local server, cheap GETs
  const events = [];
  const queue = inRange.slice(0, maxDocs);
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const d = queue.shift();
      let content = d.title || '';
      try {
        const full = await getDocument(cfg, d.id);
        content = full.content || content;
      } catch {}
      events.push({ id: d.id, content, metadata: d.metadata || {}, createdAt: d.createdAt });
    }
  });
  await Promise.all(workers);

  events.sort((a, b) => (a.metadata.ts_epoch ?? 0) - (b.metadata.ts_epoch ?? 0));
  return events;
}

// group events by repo, then ticket, with per-source stats
export function groupForStandup(events) {
  const groups = new Map();
  for (const ev of events) {
    const md = ev.metadata;
    const key = `${md.repo || '(no repo)'}::${md.ticket || ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        repo: md.repo || '(no repo)',
        ticket: md.ticket || null,
        terminal: 0,
        failures: [],
        agent: 0,
        commits: [],
        events: [],
      });
    }
    const g = groups.get(key);
    g.events.push(ev);
    if (md.source === 'terminal') {
      g.terminal++;
      if (md.exit_code !== 0 && md.exit_code !== undefined && md.exit_code !== null) g.failures.push(ev);
    } else if (md.source === 'agent') g.agent++;
    else if (md.source === 'git') g.commits.push(ev);
  }
  return [...groups.values()].sort((a, b) => b.events.length - a.events.length);
}
