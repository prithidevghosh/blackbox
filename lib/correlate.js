// Correlation: tag every event with {repo, branch, ticket} where derivable.
// Ticket IDs (default [A-Z][A-Z0-9]+-\d+) are pulled from, in priority order:
// branch name, then commit message / command / content text.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function extractTicket(text, regexSource = '[A-Z][A-Z0-9]+-\\d+') {
  if (!text) return null;
  const m = String(text).match(new RegExp(regexSource));
  return m ? m[0] : null;
}

// cwd -> {repo, repoPath, branch} with a small TTL cache; the daemon calls this
// for every terminal event and git subprocesses are ~10ms each.
const gitCache = new Map();
const GIT_CACHE_TTL_MS = 15_000;

export function gitInfo(cwd) {
  if (!cwd) return { repo: null, repoPath: null, branch: null };
  const hit = gitCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_CACHE_TTL_MS) return hit.info;
  let info = { repo: null, repoPath: null, branch: null };
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [top, branch] = out.trim().split('\n');
    if (top) info = { repo: path.basename(top), repoPath: top, branch: branch || null };
  } catch {
    // not a repo / git missing — event still flows, just untagged
  }
  gitCache.set(cwd, { at: Date.now(), info });
  return info;
}

export function correlate(event, cfg = {}) {
  const regex = cfg.ticketRegex || '[A-Z][A-Z0-9]+-\\d+';
  const out = { ...event };

  if (!out.repo || !out.branch) {
    const g = gitInfo(out.cwd);
    out.repo = out.repo || g.repo;
    out.repoPath = out.repoPath || g.repoPath;
    out.branch = out.branch || g.branch;
  }

  if (!out.ticket) {
    out.ticket =
      extractTicket(out.branch, regex) ||
      extractTicket(out.message, regex) || // git commit message
      extractTicket(out.command, regex) ||
      extractTicket(out.content, regex) ||
      null;
  }
  return out;
}
