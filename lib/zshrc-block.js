// The marked BLACKBOX block in ~/.zshrc. Pure string transform so it's
// unit-testable; `blackbox setup` does the actual file I/O.
export const BEGIN_MARK = '# BEGIN BLACKBOX (managed by `blackbox setup` — do not edit inside this block)';
export const END_MARK = '# END BLACKBOX';

// Prefix-match the markers so blocks written by older versions of the
// installer (different parenthetical) are still replaced, never duplicated.
export function upsertMarkedBlock(content, blockBody) {
  const out = [];
  let inBlock = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('# BEGIN BLACKBOX')) { inBlock = true; continue; }
    if (line.startsWith('# END BLACKBOX')) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const head = out.length ? out.join('\n') + '\n\n' : '';
  return `${head}${BEGIN_MARK}\n${blockBody.join('\n')}\n${END_MARK}\n`;
}
