import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertMarkedBlock, BEGIN_MARK, END_MARK } from '../../lib/zshrc-block.js';

const BODY = ['export PATH="/home/u/.blackbox/bin:$PATH"', 'source "/repo/shell/blackbox.zsh"'];

test('appends block to a fresh zshrc', () => {
  const out = upsertMarkedBlock('alias ll="ls -l"\n', BODY);
  assert.ok(out.startsWith('alias ll="ls -l"\n\n' + BEGIN_MARK));
  assert.ok(out.endsWith(`${BODY[1]}\n${END_MARK}\n`));
});

test('empty zshrc gets just the block', () => {
  const out = upsertMarkedBlock('', BODY);
  assert.equal(out, `${BEGIN_MARK}\n${BODY.join('\n')}\n${END_MARK}\n`);
});

test('idempotent: re-running replaces the block, never duplicates', () => {
  const once = upsertMarkedBlock('alias x=1\n', BODY);
  const twice = upsertMarkedBlock(once, BODY);
  assert.equal(twice, once);
});

test('replaces blocks written by the old install.sh marker text', () => {
  const legacy = [
    'alias x=1',
    '# BEGIN BLACKBOX (managed by install.sh — do not edit inside this block)',
    'export PATH="/old/path:$PATH"',
    'source "/old/repo/shell/blackbox.zsh"',
    '# END BLACKBOX',
    '',
  ].join('\n');
  const out = upsertMarkedBlock(legacy, BODY);
  assert.ok(!out.includes('/old/repo'));
  assert.equal(out.match(/# BEGIN BLACKBOX/g).length, 1);
  assert.ok(out.includes(BODY[1]));
  assert.ok(out.startsWith('alias x=1\n'));
});

test('user content after the block is preserved', () => {
  const content = [BEGIN_MARK, 'source "/old.zsh"', END_MARK, 'eval "$(starship init zsh)"', ''].join('\n');
  const out = upsertMarkedBlock(content, BODY);
  assert.ok(out.includes('eval "$(starship init zsh)"'));
  assert.ok(!out.includes('/old.zsh'));
  // block re-appended at the end
  assert.ok(out.trimEnd().endsWith(END_MARK));
});
