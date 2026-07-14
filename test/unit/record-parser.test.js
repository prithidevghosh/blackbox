import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecordParser, cleanOutput, headTail } from '../../lib/record-parser.js';

const RS = '\x1e';
const b64 = (s) => Buffer.from(s).toString('base64');
const S = (cmd, cwd, t) => `${RS}BB1;S;${b64(cmd)};${b64(cwd)};${t}${RS}\n\x1b[1A\x1b[2K`;
const E = (exit, t) => `${RS}BB1;E;${exit};${t}${RS}\n\x1b[1A\x1b[2K`;

function fakeSession() {
  return (
    'prompt$ redis-cli PING\r\n' +
    S('redis-cli PING', '/work/payments', 100.5) +
    '\r\n\x1b[31m(error) NOAUTH Authentication required.\x1b[0m\r\n' +
    E(1, 100.75) +
    'prompt$ echo ok\r\n' +
    S('echo ok', '/work/payments', 101.0) +
    '\r\nok\r\n' +
    E(0, 101.02) +
    'prompt$ exit\r\n'
  );
}

test('parses commands with output, exit codes, duration', () => {
  const p = new RecordParser({ sessionId: 's1' });
  const events = p.push(fakeSession());
  assert.equal(events.length, 2);
  assert.equal(events[0].command, 'redis-cli PING');
  assert.equal(events[0].cwd, '/work/payments');
  assert.equal(events[0].exit_code, 1);
  assert.equal(events[0].duration_ms, 250);
  assert.equal(events[0].output, '(error) NOAUTH Authentication required.'); // ANSI + CR stripped
  assert.equal(events[1].command, 'echo ok');
  assert.equal(events[1].output, 'ok');
  assert.equal(events[1].exit_code, 0);
});

test('handles sentinels split across arbitrary chunk boundaries', () => {
  const raw = fakeSession();
  for (const chunkSize of [1, 3, 7, 17]) {
    const p = new RecordParser({ sessionId: 's1' });
    const events = [];
    for (let i = 0; i < raw.length; i += chunkSize) {
      events.push(...p.push(raw.slice(i, i + chunkSize)));
    }
    events.push(...p.flush());
    assert.equal(events.length, 2, `chunkSize=${chunkSize}`);
    assert.match(events[0].output, /NOAUTH/);
  }
});

test('stray RS byte in program output does not desync the parser', () => {
  const p = new RecordParser({ sessionId: 's1' });
  const raw =
    S('cat weird.bin', '/w', 1.0) + `some${RS}binary${RS}ish output\r\n` + E(0, 1.5) + S('echo after', '/w', 2.0) + 'after\r\n' + E(0, 2.1);
  const events = p.push(raw);
  assert.equal(events.length, 2);
  assert.match(events[0].output, /binary/);
  assert.equal(events[1].output, 'after');
});

test('unterminated command is flushed as interrupted', () => {
  const p = new RecordParser({ sessionId: 's1' });
  p.push(S('sleep 999', '/w', 5.0) + 'partial out\r\n');
  const events = p.flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].interrupted, true);
  assert.equal(events[0].exit_code, null);
  assert.match(events[0].output, /partial out/);
});

test('headTail keeps head and tail under budget with omission marker', () => {
  const s = 'A'.repeat(6000) + 'MIDDLE' + 'B'.repeat(6000);
  const out = headTail(s, 8192);
  assert.ok(Buffer.byteLength(out) < 8192 + 64);
  assert.match(out, /^A+/);
  assert.match(out, /B+$/);
  assert.match(out, /bytes omitted/);
  assert.doesNotMatch(out, /MIDDLE/);
  assert.equal(headTail('short', 8192), 'short');
});

test('cleanOutput strips CSI, OSC and CR', () => {
  const raw = '\x1b]7;file://host/path\x07line1\r\n\x1b[1m\x1b[7mbold\x1b[0m\r\n';
  assert.equal(cleanOutput(raw), 'line1\nbold');
});
