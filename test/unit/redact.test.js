import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactEvent } from '../../lib/redact.js';

test('AWS access keys', () => {
  const out = redactText('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  assert.match(out, /\[REDACTED:aws-key\]/);
});

test('sk- and sm_ API keys', () => {
  const out = redactText('curl -H "x-api-key: sk-ant-abc123def456ghi789jkl" and sm_yPyTam6QYtCgV8j43pYBG2_EefALJ1onHj');
  assert.doesNotMatch(out, /sk-ant-abc/);
  assert.doesNotMatch(out, /sm_yPyTam/);
  assert.equal((out.match(/\[REDACTED:api-key\]/g) || []).length, 2);
});

test('Authorization: Bearer headers', () => {
  const out = redactText('curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret.payload"');
  assert.doesNotMatch(out, /eyJhbGci/);
  assert.match(out, /Authorization: Bearer \[REDACTED:bearer-token\]/);
});

test('password=/PASSWD= assignments, case-insensitive', () => {
  assert.doesNotMatch(redactText('mysql -u root password=hunter2'), /hunter2/);
  assert.doesNotMatch(redactText('export PASSWD=Sup3rS3cret!'), /Sup3rS3cret/);
  assert.doesNotMatch(redactText('PGPASSWORD="with spaces? no"'), /with spaces/);
  assert.doesNotMatch(redactText('redis-cli --pass secret123 PING'.replace('--pass', '--password')), /secret123/);
});

test('PEM blocks collapse entirely', () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA7bq0h8Zn
xJ9v2mP3qL5t
-----END RSA PRIVATE KEY-----`;
  const out = redactText(`cat <<EOF\n${pem}\nEOF`);
  assert.doesNotMatch(out, /MIIEpAIBAAK/);
  assert.equal(out.includes('[REDACTED:pem]'), true);
});

test('connection-string credentials', () => {
  const out = redactText('psql postgres://admin:s3cr3tpw@db.internal:5432/prod');
  assert.doesNotMatch(out, /s3cr3tpw/);
  assert.match(out, /postgres:\/\/admin:\[REDACTED:password\]@db.internal/);
});

test('github / slack tokens', () => {
  assert.doesNotMatch(redactText('git clone https://ghp_abcdefghijklmnopqrstu12345@github.com/x/y'), /ghp_abcdefghijklmnopqrstu12345/);
  assert.doesNotMatch(redactText('SLACK_TOKEN=xoxb-1234567890-abcdefg'), /xoxb-1234567890/);
});

test('innocent text passes through untouched', () => {
  const s = 'git commit -m "fix: PROJ-123 pass redis password to client" && npm test';
  assert.equal(redactText(s), s); // the word "password" alone is not a secret
  assert.equal(redactText('NOAUTH Authentication required.'), 'NOAUTH Authentication required.');
});

test('redactEvent scrubs all text fields, leaves structure alone', () => {
  const ev = redactEvent({
    source: 'terminal',
    command: 'curl -H "Authorization: Bearer tok123abc" api.internal',
    output: 'AKIAIOSFODNN7EXAMPLE leaked',
    exit_code: 1,
    ticket: 'PROJ-123',
  });
  assert.doesNotMatch(ev.command, /tok123abc/);
  assert.doesNotMatch(ev.output, /AKIA/);
  assert.equal(ev.exit_code, 1);
  assert.equal(ev.ticket, 'PROJ-123');
});
