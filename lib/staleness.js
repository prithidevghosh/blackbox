// Staleness (Feature B): lazy invalidation of fix memories at retrieval time.
// A remembered fix is checked against the repo's git history before being
// presented: evidence paths derived from the memory itself (V5), one bounded
// `git log --since` to see if reality moved after the fix (V6), and
// newest-wins selection among competing fixes (V7). Hard rules: the whole
// check fits a small time budget, and on ANY error/timeout the annotation is
// simply omitted — never a wrong claim, never a crash.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const STALENESS_BUDGET_MS = 150;

// dependency-drift sentinels checked alongside evidence paths (only ones that
// exist in the repo are consulted, so this stays one git invocation)
const LOCKFILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'go.sum',
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
];

const contentOf = (r) =>
  r.chunks?.filter((c) => c.isRelevant !== false).map((c) => c.content).join('\n') || r.title || '';

// path-like tokens: something/with/slashes.ext or bare file.ext with a known-ish extension
const PATH_TOKEN_RE = /(?:[\w@.-]+\/)+[\w@.-]+|[\w-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|conf|cfg|ini|yml|yaml|json|toml|env|sh|zsh|bash|sql|proto|tf|md)\b/g;

// V5: evidence paths of a fix memory — files named by its correlated commit
// ("files changed: …" line, written by the git hook) plus path-like tokens in
// the content, kept only when they exist in the repo right now.
export function evidencePaths(content, repoRoot, existsFn = (p) => fs.existsSync(p)) {
  if (!repoRoot) return [];
  const found = new Set();
  const text = String(content || '');
  const filesLine = text.match(/^files changed: (.+)$/m);
  for (const f of filesLine ? filesLine[1].split(',').map((s) => s.trim()) : []) found.add(f);
  // URLs and absolute paths are never repo-relative evidence — remove them
  // before token scanning so their tails can't masquerade as paths
  const scannable = text.replace(/https?:\/\/\S+/g, ' ').replace(/(^|\s)\/\S+/g, ' ');
  for (const tok of scannable.match(PATH_TOKEN_RE) || []) {
    found.add(tok.replace(/[.,;:)\]]+$/, ''));
  }
  return [...found]
    .filter((f) => f && !f.includes('..'))
    .filter((f) => {
      try { return existsFn(path.join(repoRoot, f)); } catch { return false; }
    })
    .slice(0, 8);
}

// `git log --since=<ts> --format=%h --name-only` → [{hash, files:[…]}], newest first
export function parseNameOnlyLog(out) {
  const commits = [];
  let cur = null;
  for (const line of String(out || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^[0-9a-f]{7,12}$/.test(t)) commits.push((cur = { hash: t, files: [] }));
    else if (cur) cur.files.push(t);
  }
  return commits;
}

// Pure classification: which evidence files (and lockfiles) later commits touched.
export function classifyStaleness(commits, evidence, locks) {
  const touched = (want) => {
    for (const c of commits) {
      const f = c.files.find((x) => want.includes(x));
      if (f) return { file: f, hash: c.hash, count: commits.filter((k) => k.files.includes(f)).length };
    }
    return null;
  };
  if (!commits.length) return { fresh: true };
  const ev = touched(evidence);
  const lock = touched(locks);
  // pathspec-limited --name-only lists only matching files (verified), so a
  // returned commit always names an evidence or lock file; this is pure safety
  if (!ev && !lock) return { fresh: true };
  return { fresh: false, evidence: ev, lock };
}

export function formatStalenessNote(verdict) {
  if (!verdict) return null;
  if (verdict.fresh) return '✓ still current';
  const parts = [];
  if (verdict.evidence) {
    const { file, count, hash } = verdict.evidence;
    parts.push(`${file} changed ${count} commit(s) after this fix (${hash})`);
  }
  if (verdict.lock) parts.push(`dependency drift: ${verdict.lock.file} changed since (${verdict.lock.hash})`);
  return `⚠ possibly stale — ${parts.join('; ')}`;
}

function repoRootOf(cwd, timeoutMs) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

// V6 entry point: annotate one retrieved fix memory (git-source result).
// Returns "✓ still current" / "⚠ possibly stale — …" / null (= say nothing:
// not a fix memory, no evidence, repo gone, git error, over budget).
export function stalenessNote(result, { budgetMs = STALENESS_BUDGET_MS } = {}) {
  const t0 = Date.now();
  try {
    const md = result?.metadata || {};
    if (md.source !== 'git' || !md.ts) return null;
    const left = () => budgetMs - (Date.now() - t0);
    const repoRoot = repoRootOf(md.cwd, Math.max(left() - 30, 20));
    if (!repoRoot) return null;
    const evidence = evidencePaths(contentOf(result), repoRoot);
    if (!evidence.length) return null;
    const locks = LOCKFILES.filter((f) => fs.existsSync(path.join(repoRoot, f)));
    if (left() < 20) return null;
    // git's --since compares at second granularity and includes the boundary,
    // so the fix commit itself shows up when memory ts ≈ commit time (observed
    // live) — shift by 1s and also drop the memory's own hash if we know it
    const since = new Date(new Date(md.ts).getTime() + 1000).toISOString();
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'log', `--since=${since}`, '--format=%h', '--name-only', '--', ...evidence, ...locks],
      { encoding: 'utf8', timeout: Math.max(left(), 20), stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const commits = parseNameOnlyLog(out).filter((c) => !md.hash || !String(md.hash).startsWith(c.hash));
    return formatStalenessNote(classifyStaleness(commits, evidence, locks));
  } catch {
    return null; // omission over wrong claims, always
  }
}

// V7: among several retrieved fix memories for the same error, the newest one
// is the answer; older ones are superseded (append-only store — ranking, not
// deletion, does the invalidation). "Same error" proxy: same ticket when both
// carry one (strongest signal), else same repo — candidates already matched
// the same query above the caller's threshold, so this only has to separate
// coincidental same-repo commits from actual fix chains.
export function newestFix(gitResults) {
  const dated = (gitResults || []).filter((r) => r.metadata?.ts);
  if (!dated.length) return { fix: (gitResults || [])[0] || null, supersedes: [] };
  const byRepo = new Map();
  for (const r of dated) {
    const k = r.metadata.ticket || r.metadata.repo || r.metadata.cwd || '?';
    if (!byRepo.has(k)) byRepo.set(k, []);
    byRepo.get(k).push(r);
  }
  // largest same-repo group wins ties by newest member
  const groups = [...byRepo.values()].sort(
    (a, b) => b.length - a.length || (b[0].metadata.ts > a[0].metadata.ts ? 1 : -1)
  );
  const group = groups[0].sort((a, b) => (a.metadata.ts < b.metadata.ts ? 1 : -1));
  return { fix: group[0], supersedes: group.slice(1).map((r) => r.metadata.ts.slice(0, 10)) };
}

export function supersedeNote(supersedes) {
  if (!supersedes?.length) return null;
  return `supersedes fix from ${supersedes.join(', ')}`;
}
