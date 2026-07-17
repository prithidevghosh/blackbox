import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGuardHook, removeGuardHook, guardInstalled } from '../../cli/cmd/guard.js';

const CMD = '"/usr/local/bin/node" "/x/cli/blackbox.js" guard-hook';

test('addGuardHook merges into existing settings without touching other keys', () => {
  const before = {
    model: 'claude-fable-5',
    hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint.sh' }] }], Stop: [{ hooks: [] }] },
  };
  const after = addGuardHook(before, CMD);
  assert.equal(after.model, 'claude-fable-5');
  assert.equal(after.hooks.PreToolUse.length, 2, 'existing PreToolUse entry preserved');
  assert.deepEqual(after.hooks.Stop, before.hooks.Stop);
  assert.ok(guardInstalled(after));
  assert.ok(!guardInstalled(before), 'input not mutated');
});

test('addGuardHook is idempotent', () => {
  const once = addGuardHook({}, CMD);
  const twice = addGuardHook(once, CMD);
  assert.equal(twice.hooks.PreToolUse.length, 1);
});

test('removeGuardHook removes only our entry and prunes empty containers', () => {
  const other = { matcher: 'Edit', hooks: [{ type: 'command', command: 'lint.sh' }] };
  const mixed = removeGuardHook(addGuardHook({ hooks: { PreToolUse: [other] } }, CMD));
  assert.deepEqual(mixed.hooks.PreToolUse, [other]);

  const emptied = removeGuardHook(addGuardHook({ model: 'x' }, CMD));
  assert.equal(emptied.hooks, undefined, 'empty hooks object pruned');
  assert.equal(emptied.model, 'x');
});

test('removeGuardHook on settings without our hook is a no-op', () => {
  const s = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other.sh' }] }] } };
  assert.deepEqual(removeGuardHook(s), s);
});
