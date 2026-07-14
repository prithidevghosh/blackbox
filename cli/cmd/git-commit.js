// Internal: called by the post-commit hook (`blackbox _git-commit`). Gathers
// commit facts with git itself and spools a git event. Must never fail the
// commit — the hook invokes us with `|| true`, and we also exit 0 on error.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { spoolEvent } from '../../lib/spool.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export async function run() {
  try {
    const cwd = process.cwd();
    const repoPath = git(['rev-parse', '--show-toplevel'], cwd);
    const event = {
      source: 'git',
      event: 'commit',
      cwd: repoPath,
      repo: path.basename(repoPath),
      repoPath,
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      hash: git(['rev-parse', 'HEAD'], cwd),
      message: git(['log', '-1', '--pretty=%B'], cwd),
      author: git(['log', '-1', '--pretty=%an <%ae>'], cwd),
      files: git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], cwd)
        .split('\n')
        .filter(Boolean)
        .slice(0, 100),
      stats: git(['diff-tree', '--no-commit-id', '--shortstat', '-r', 'HEAD'], cwd),
    };
    spoolEvent(event);
  } catch {
    // never break a commit
  }
  process.exit(0);
}
