// Redaction — runs in the daemon on every event BEFORE anything is sent to
// Supermemory, so secrets never reach the memory store. Order matters: PEM
// blocks first (multi-line), then specific token shapes, then key=value.

const RULES = [
  // PEM blocks (private keys, certs) — whole block collapses
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, '[REDACTED:pem]'],
  // AWS access key id
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  // AWS secret in assignments like aws_secret_access_key = ...
  [/(aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{30,}/gi, '$1[REDACTED:aws-secret]'],
  // OpenAI/Anthropic/Stripe-style sk- tokens and Supermemory sm_ keys
  [/\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bsm_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  // GitHub + Slack tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:api-key]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:api-key]'],
  // Authorization headers
  [/(authorization:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED:bearer-token]'],
  [/(authorization:\s*basic\s+)[^\s"']+/gi, '$1[REDACTED:basic-auth]'],
  // password-ish key=value / key: value (PASSWORD, PASSWD, PGPASSWORD, redis --pass etc.)
  [/((?:password|passwd|pgpassword|redis_password|db_pass(?:word)?)\s*[=:]\s*)(?:(["'])[^"']*\2|[^\s"'&;]+)/gi, '$1[REDACTED:password]'],
  [/((?:--password|--passwd|-p(?:ass)?word)[= ])[^\s"']+/gi, '$1[REDACTED:password]'],
  // connection-string credentials: scheme://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@"']+(@)/gi, '$1[REDACTED:password]$2'],
];

export function redactText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out;
}

const TEXT_FIELDS = ['command', 'content', 'output', 'message', 'stats'];

export function redactEvent(event) {
  const out = { ...event };
  for (const f of TEXT_FIELDS) {
    if (typeof out[f] === 'string') out[f] = redactText(out[f]);
  }
  return out;
}
