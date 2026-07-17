// Flashback (M8b): when a command fails, look up similar past events and — only
// if confident — print a one-glance hint citing how often and how recently this
// was seen, plus a correlated git fix when one scores above the threshold.
// Everything here is pure selection/formatting; the async/silence guarantees
// live in cli/cmd/flashback.js and the zsh hook.
import { sourceBadge, exitBadge, relativeTime, keyLines, bold, dim, yellow } from './format.js';
import { newestFix, supersedeNote } from './staleness.js';

// Split search results into past-event hits and the best correlated git fix.
// Only results at/above the similarity threshold count; git commits are shown
// as the "fix" line rather than counted as a repeat of the failure. Among
// several competing fixes the NEWEST wins (V7) — older ones stay in the store,
// ranking does the invalidation.
export function selectMatches(results, threshold) {
  const above = (results || []).filter((r) => (r.score ?? 0) >= threshold);
  const hits = above.filter((r) => r.metadata?.source !== 'git');
  const { fix, supersedes } = newestFix(above.filter((r) => r.metadata?.source === 'git'));
  return { hits, gitFix: fix, supersedes };
}

// full text of one search result (relevant chunks, else title)
export function hitContent(r) {
  return r.chunks?.filter((c) => c.isRelevant !== false).map((c) => c.content).join('\n') || r.title || '';
}

// Fallback fix lookup (D8): a bare failing command ("npm run dev") is often
// semantically far from its fix commit's message, while the failure's ERROR
// TEXT is not. Callers that found hits but no gitFix re-search with the error
// line and take the newest git result above the same threshold.
export function pickFixFromResults(results, threshold) {
  const gits = (results || []).filter((r) => r.metadata?.source === 'git' && (r.score ?? 0) >= threshold);
  if (!gits.length) return { fix: null, supersedes: [] };
  return newestFix(gits);
}

function ts(r) {
  return r.metadata?.ts || r.createdAt || '';
}

// Most recent timestamp among hits — recency must come from real metadata.
export function lastSeen(hits) {
  return hits.map(ts).sort().at(-1) || '';
}

// null when there is nothing confident to say (caller stays silent).
// fixNote is the staleness annotation ("✓ still current" / "⚠ possibly stale…")
// computed by the caller — this stays a pure formatter.
export function formatHint({ hits, gitFix, supersedes }, query = '', { fixNote = null } = {}) {
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
    const extras = [fixNote, supersedeNote(supersedes)].filter(Boolean);
    lines.push(`   ${yellow('fix')} ${dim(`(git, ${relativeTime(ts(gitFix))})`)}: ${fixLine}${extras.length ? ` ${dim(extras.join(' · '))}` : ''}`);
  }
  if (query) {
    // long failing commands make an unreadable suggestion — a truncated query
    // still retrieves the same events (search is semantic, not exact)
    const q = query.length > 48 ? query.slice(0, 48).trimEnd() + '…' : query;
    lines.push(dim(`   ↳ blackbox ask --explain ${JSON.stringify(q)}`));
  }
  return lines.join('\n');
}
