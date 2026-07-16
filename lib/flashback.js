// Flashback (M8b): when a command fails, look up similar past events and — only
// if confident — print a one-glance hint citing how often and how recently this
// was seen, plus a correlated git fix when one scores above the threshold.
// Everything here is pure selection/formatting; the async/silence guarantees
// live in cli/cmd/flashback.js and the zsh hook.
import { sourceBadge, exitBadge, relativeTime, keyLines, bold, dim, yellow } from './format.js';

// Split search results into past-event hits and the best correlated git fix.
// Only results at/above the similarity threshold count; git commits are shown
// as the "fix" line rather than counted as a repeat of the failure.
export function selectMatches(results, threshold) {
  const above = (results || []).filter((r) => (r.score ?? 0) >= threshold);
  const hits = above.filter((r) => r.metadata?.source !== 'git');
  const gitFix = above.find((r) => r.metadata?.source === 'git') || null;
  return { hits, gitFix };
}

function ts(r) {
  return r.metadata?.ts || r.createdAt || '';
}

// Most recent timestamp among hits — recency must come from real metadata.
export function lastSeen(hits) {
  return hits.map(ts).sort().at(-1) || '';
}

// null when there is nothing confident to say (caller stays silent).
export function formatHint({ hits, gitFix }, query = '') {
  if (!hits.length) return null;
  const top = hits[0];
  const md = top.metadata || {};
  const head = [
    yellow('⚡ flashback:'),
    bold(`seen ${hits.length}× before`),
    dim(`— last ${relativeTime(lastSeen(hits))}`),
    sourceBadge(md),
    exitBadge(md),
  ]
    .filter(Boolean)
    .join(' ');
  const body = keyLines(top.chunks?.filter((c) => c.isRelevant !== false).map((c) => c.content).join('\n') || top.title, 2);
  const lines = [head, body.replace(/^/gm, '   ')];
  if (gitFix) {
    const fixLine = keyLines(gitFix.chunks?.map((c) => c.content).join('\n') || gitFix.title, 1);
    lines.push(`   ${yellow('fix')} ${dim(`(git, ${relativeTime(ts(gitFix))})`)}: ${fixLine}`);
  }
  if (query) {
    // long failing commands make an unreadable suggestion — a truncated query
    // still retrieves the same events (search is semantic, not exact)
    const q = query.length > 48 ? query.slice(0, 48).trimEnd() + '…' : query;
    lines.push(dim(`   ↳ blackbox ask --explain ${JSON.stringify(q)}`));
  }
  return lines.join('\n');
}
