// Tails agent transcript directories and spools normalized events.
// Handles live appends (per-file byte offset + partial-line remainder buffer),
// daemon restarts (offsets persisted to checkpoints.json), truncation, and
// malformed lines (parser contract: never throw).
import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { spoolEvent } from '../lib/spool.js';
import { paths, expandTilde } from '../lib/config.js';
import * as claudeCode from './parsers/claude-code.js';
import * as codex from './parsers/codex.js';

const CHECKPOINT_DEBOUNCE_MS = 2000;

function loadCheckpoints() {
  try {
    return JSON.parse(fs.readFileSync(paths().checkpoints, 'utf8'));
  } catch {
    return {};
  }
}

export function startAgentWatcher(cfg, { onEvent = spoolEvent, log = () => {} } = {}) {
  const agents = [
    { name: 'claude-code', dir: expandTilde(cfg.agents?.['claude-code']?.dir || '~/.claude/projects'), enabled: cfg.agents?.['claude-code']?.enabled !== false },
    { name: 'codex', dir: expandTilde(cfg.agents?.codex?.dir || '~/.codex/sessions'), enabled: cfg.agents?.codex?.enabled !== false },
  ].filter((a) => a.enabled && a.dir && fs.existsSync(a.dir));

  const fileState = new Map(); // file -> { offset, remainder, agent, codexState }
  const checkpoints = loadCheckpoints();
  let checkpointTimer = null;
  const watchers = [];

  function saveCheckpointsSoon() {
    if (checkpointTimer) return;
    checkpointTimer = setTimeout(() => {
      checkpointTimer = null;
      const out = {};
      for (const [file, st] of fileState) out[file] = st.offset;
      try {
        fs.writeFileSync(paths().checkpoints, JSON.stringify(out, null, 1));
      } catch (err) {
        log(`checkpoint write failed: ${err.message}`);
      }
    }, CHECKPOINT_DEBOUNCE_MS);
    checkpointTimer.unref?.();
  }

  function consume(file, agent) {
    let st = fileState.get(file);
    if (!st) {
      st = { offset: 0, remainder: '', agent, codexState: codex.newSessionState() };
      fileState.set(file, st);
    }
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // deleted between event and stat
    }
    if (size < st.offset) {
      st.offset = 0; // truncated/rewritten — start over
      st.remainder = '';
    }
    if (size === st.offset) return;

    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - st.offset);
      const read = fs.readSync(fd, buf, 0, buf.length, st.offset);
      st.offset += read;
      const text = st.remainder + buf.toString('utf8', 0, read);
      const lines = text.split('\n');
      st.remainder = lines.pop() ?? ''; // last piece may be a partial line mid-append
      for (const line of lines) {
        if (!line.trim()) continue;
        let events = [];
        try {
          events = agent === 'codex' ? codex.parseLine(line, st.codexState) : claudeCode.parseLine(line);
        } catch (err) {
          log(`parser error (${agent}): ${err.message}`); // contract says never throw, but stay alive anyway
        }
        for (const ev of events) {
          ev.transcript = file;
          try {
            onEvent(ev);
          } catch (err) {
            log(`spool failed: ${err.message}`);
          }
        }
      }
    } catch (err) {
      log(`read failed ${file}: ${err.message}`);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
    saveCheckpointsSoon();
  }

  for (const { name, dir } of agents) {
    let ready = false;
    const watcher = chokidar.watch(dir, { persistent: true, depth: 5, alwaysStat: true });
    watcher.on('add', (file, stats) => {
      if (!file.endsWith('.jsonl')) return;
      if (!ready) {
        // preexisting file: resume from checkpoint if we have one, else skip history
        const offset = checkpoints[file] !== undefined ? Math.min(checkpoints[file], stats?.size ?? 0) : stats?.size ?? 0;
        fileState.set(file, { offset, remainder: '', agent: name, codexState: codex.newSessionState() });
        if (checkpoints[file] !== undefined) consume(file, name);
      } else {
        consume(file, name); // new session file: capture from byte 0
      }
    });
    watcher.on('change', (file) => {
      if (file.endsWith('.jsonl')) consume(file, name);
    });
    watcher.on('ready', () => {
      ready = true;
      log(`watching ${name}: ${dir}`);
    });
    watcher.on('error', (err) => log(`watcher error (${name}): ${err.message}`));
    watchers.push(watcher);
  }

  if (agents.length === 0) log('agent watcher: no transcript directories found (fail-soft, terminal/git still work)');

  return {
    agents: agents.map((a) => a.name),
    async close() {
      if (checkpointTimer) clearTimeout(checkpointTimer);
      await Promise.all(watchers.map((w) => w.close()));
    },
  };
}
