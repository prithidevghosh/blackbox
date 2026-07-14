// Splits a `script(1)` typescript stream into per-command events using the
// RS-delimited sentinels emitted by shell/blackbox.zsh in record mode:
//   \x1eBB1;S;<b64 command>;<b64 cwd>;<epoch>\x1e   (preexec)
//   \x1eBB1;E;<exit code>;<epoch>\x1e               (precmd)
// Bytes between an S and its E are the command's output. Feed chunks in any
// split (sentinels may straddle chunks); getEvents() drains completed commands.

const RS = '\x1e';
// CSI + OSC + other escapes, then bare CR; typescript output is full of both.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function cleanOutput(raw) {
  return raw
    .replace(ANSI_RE, '')
    .replace(/\r/g, '')
    .replace(/[^\S\n]+\n/g, '\n')
    .trim()
    .replace(/\n%$/, ''); // zsh's inverse-video partial-line marker drawn before the prompt
}

export function headTail(s, maxBytes) {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const half = Math.floor(maxBytes / 2);
  const head = Buffer.from(s, 'utf8').subarray(0, half).toString('utf8');
  const tailBuf = Buffer.from(s, 'utf8');
  const tail = tailBuf.subarray(tailBuf.length - half).toString('utf8');
  const omitted = Buffer.byteLength(s, 'utf8') - maxBytes;
  return `${head}\n…[${omitted} bytes omitted]…\n${tail}`;
}

export class RecordParser {
  constructor({ sessionId, maxOutputBytes = 8192 } = {}) {
    this.sessionId = sessionId || `record-${process.pid}-${Date.now()}`;
    this.maxOutputBytes = maxOutputBytes;
    this.buf = '';
    this.current = null; // { command, cwd, ts_epoch, outputStart }
    this.events = [];
  }

  push(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf(RS)) !== -1) {
      const end = this.buf.indexOf(RS, idx + 1);
      if (end === -1) {
        // sentinel may be split across chunks — wait for more, but guard
        // against a stray lone RS by capping how much we hold back
        if (this.buf.length - idx > 4096) this.buf = this.buf.slice(idx + 1);
        break;
      }
      const marker = this.buf.slice(idx + 1, end);
      const before = this.buf.slice(0, idx);
      this.buf = this.buf.slice(end + 1);
      this._marker(marker, before);
    }
    return this.drain();
  }

  _marker(marker, precedingBytes) {
    const parts = marker.split(';');
    if (parts[0] !== 'BB1') {
      // not ours (lone RS in program output) — keep bytes as output
      if (this.current) this.current.output += precedingBytes + RS + marker + RS;
      return;
    }
    if (this.current) this.current.output += precedingBytes;

    if (parts[1] === 'S' && parts.length >= 5) {
      let command = '',
        cwd = '';
      try {
        command = Buffer.from(parts[2], 'base64').toString('utf8');
        cwd = Buffer.from(parts[3], 'base64').toString('utf8');
      } catch {}
      this.current = { command, cwd, ts_epoch: parseFloat(parts[4]) || Date.now() / 1000, output: '' };
    } else if (parts[1] === 'E' && parts.length >= 4 && this.current) {
      const endEpoch = parseFloat(parts[3]) || this.current.ts_epoch;
      this.events.push({
        source: 'terminal',
        recorded: true,
        session_id: this.sessionId,
        command: this.current.command,
        cwd: this.current.cwd,
        ts_epoch: this.current.ts_epoch,
        exit_code: parseInt(parts[2], 10) || 0,
        duration_ms: Math.max(0, Math.round((endEpoch - this.current.ts_epoch) * 1000)),
        output: headTail(cleanOutput(this.current.output), this.maxOutputBytes),
      });
      this.current = null;
    }
  }

  drain() {
    const out = this.events;
    this.events = [];
    return out;
  }

  // call at stream end — an unterminated command (shell killed mid-run) still yields an event
  flush() {
    if (this.current) {
      this.events.push({
        source: 'terminal',
        recorded: true,
        session_id: this.sessionId,
        command: this.current.command,
        cwd: this.current.cwd,
        ts_epoch: this.current.ts_epoch,
        exit_code: null,
        duration_ms: null,
        output: headTail(cleanOutput(this.current.output + this.buf), this.maxOutputBytes),
        interrupted: true,
      });
      this.current = null;
      this.buf = '';
    }
    return this.drain();
  }
}
