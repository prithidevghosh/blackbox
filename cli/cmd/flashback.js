// `blackbox _flashback` — fired by the zsh hook after a failed command (also
// runnable by hand as `blackbox flashback "<cmd>"` to preview the hint).
// Contract with the hook: print a hint ONLY on a confident match; on any other
// outcome — flashback disabled, Supermemory down, low similarity, bad args —
// exit 0 with zero output. The hook runs us in the background, so nothing here
// can delay the prompt; staying silent is what keeps failure modes invisible.
import { loadConfig } from '../../lib/config.js';
import { search } from '../../lib/supermemory.js';
import { selectMatches, formatHint, hitContent, pickFixFromResults } from '../../lib/flashback.js';
import { rootCauseLine } from '../../lib/guard.js';

export function parseArgs(args) {
  const out = { command: [], exit: 1, cwd: '' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--exit') out.exit = parseInt(args[++i], 10);
    else if (a === '--cwd') out.cwd = args[++i];
    else if (a === '--') out.command.push(...args.slice(i + 1)), (i = args.length);
    else out.command.push(a);
  }
  out.command = out.command.join(' ').trim();
  return out;
}

export async function run(args) {
  try {
    const { command, exit } = parseArgs(args);
    const cfg = loadConfig();
    const fb = cfg.flashback || {};
    if (fb.enabled === false || !command || exit === 0 || exit === 130) return;
    const threshold = fb.similarity_threshold ?? 0.72;
    const res = await search(cfg, command, { limit: 8, containerTags: [cfg.containerTag] }, 2500);
    const matches = selectMatches(res.results, threshold);
    // D8: the command text alone often misses the fix commit — retry with the
    // failure's own error line before giving up on the fix line
    if (!matches.gitFix && matches.hits.length) {
      const err = rootCauseLine(hitContent(matches.hits[0]));
      if (err) {
        // wider limit: the error text also matches many terminal/agent docs,
        // which would crowd every git result out of a top-8
        const res2 = await search(cfg, `fix ${err}`, { limit: 16, containerTags: [cfg.containerTag] }, 2500);
        const { fix, supersedes } = pickFixFromResults(res2.results, threshold, matches.hits[0]?.metadata?.repo || null);
        if (fix) Object.assign(matches, { gitFix: fix, supersedes });
      }
    }
    // Feature B: check the fix against reality before showing it (≤150ms; any
    // problem just omits the annotation — formatting never depends on it)
    let fixNote = null;
    if (matches.gitFix) {
      const { stalenessNote } = await import('../../lib/staleness.js');
      fixNote = stalenessNote(matches.gitFix);
    }
    const hint = formatHint(matches, command, { fixNote });
    if (hint) console.log(hint);
  } catch {
    // silence is the contract
  }
}
