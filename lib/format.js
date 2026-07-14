// Terminal output helpers for ask/standup/rca.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = (s) => c('1', s);
export const dim = (s) => c('2', s);
export const red = (s) => c('31', s);
export const green = (s) => c('32', s);
export const yellow = (s) => c('33', s);
export const cyan = (s) => c('36', s);
export const magenta = (s) => c('35', s);

export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown time';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function sourceBadge(metadata = {}) {
  const src = metadata.source;
  if (src === 'terminal') return cyan('[terminal]');
  if (src === 'agent') return magenta(`[agent:${metadata.agent || '?'}]`);
  if (src === 'git') return yellow('[git]');
  return dim(`[${src || '?'}]`);
}

export function exitBadge(metadata = {}) {
  const code = metadata.exit_code;
  if (code === null || code === undefined) return '';
  return code === 0 ? green('✓ exit 0') : red(`✗ exit ${code}`);
}

// first few informative lines of a chunk; long lines are wrapped, not cut
// (Supermemory Local collapses newlines inside chunks, so a "line" can be the
// whole document)
export function keyLines(text, n = 4, width = 100) {
  const wrapped = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    for (let i = 0; i < t.length && wrapped.length <= n; i += width) {
      wrapped.push(t.slice(i, i + width));
    }
    if (wrapped.length > n) break;
  }
  const more = wrapped.length > n;
  return wrapped.slice(0, n).join('\n') + (more ? ' …' : '');
}

// parse "24h" / "7d" / "90m" into ms
export function parseWindow(s, dflt = 24 * 3600 * 1000) {
  const m = String(s || '').match(/^(\d+)([hdm])$/);
  if (!m) return dflt;
  const n = parseInt(m[1], 10);
  return n * { h: 3600_000, d: 86_400_000, m: 60_000 }[m[2]];
}
