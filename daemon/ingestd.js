// Ingest daemon core: spool/new -> redact -> correlate -> render -> POST to
// Supermemory Local. Batches (default ≤20 events or 5s). Exponential backoff
// while :6767 is down — events simply accumulate in the spool (capture keeps
// working) and drain when it returns.
import fs from 'node:fs';
import chokidar from 'chokidar';
import { paths } from '../lib/config.js';
import { pendingEvents, readEvent, removeEvent, quarantine } from '../lib/spool.js';
import { redactEvent } from '../lib/redact.js';
import { correlate } from '../lib/correlate.js';
import { eventToDocument } from '../lib/render.js';
import { ingestDocument, alive } from '../lib/supermemory.js';
import { startAgentWatcher } from '../watchers/agent-watcher.js';

const BATCH_MAX = 20;
const BATCH_WINDOW_MS = 5000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const INGEST_CONCURRENCY = 4;

export function startIngestDaemon(cfg, { log = console.error, withAgentWatcher = true } = {}) {
  let closed = false;
  let backoffMs = 0;
  let timer = null;
  let processing = false;
  let stats = { ingested: 0, failed: 0, lastError: null, lastIngestAt: null };

  const watcher = withAgentWatcher && cfg.sources?.agent !== false ? startAgentWatcher(cfg, { log }) : null;

  const ignore = new Set(cfg.ignore || []);

  function shouldSkip(event) {
    if (event.source === 'terminal') {
      if (cfg.sources?.terminal === false) return true;
      const first = (event.command || '').trim().split(/\s+/)[0];
      if (ignore.has(first)) return true;
    }
    if (event.source === 'agent' && cfg.sources?.agent === false) return true;
    if (event.source === 'git' && cfg.sources?.git === false) return true;
    return false;
  }

  async function processBatch() {
    if (processing || closed) return;
    processing = true;
    try {
      const files = pendingEvents().slice(0, BATCH_MAX);
      if (files.length === 0) return;

      if (!(await alive(cfg))) {
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : BACKOFF_BASE_MS, BACKOFF_MAX_MS);
        stats.lastError = `supermemory unreachable at ${cfg.baseURL}, retrying in ${backoffMs / 1000}s (${files.length} events spooled)`;
        log(stats.lastError);
        return;
      }

      // simple concurrency pool over the batch
      const queue = [...files];
      const workers = Array.from({ length: Math.min(INGEST_CONCURRENCY, queue.length) }, async () => {
        while (queue.length && !closed) {
          const file = queue.shift();
          const raw = readEvent(file); // quarantines unparseable files itself
          if (!raw) continue;
          try {
            if (shouldSkip(raw)) {
              removeEvent(file);
              continue;
            }
            const event = correlate(redactEvent(raw), cfg);
            const doc = eventToDocument(event, cfg);
            if (!doc.content?.trim()) {
              removeEvent(file);
              continue;
            }
            await ingestDocument(cfg, doc);
            removeEvent(file);
            stats.ingested++;
            stats.lastIngestAt = new Date().toISOString();
          } catch (err) {
            if (/HTTP 4\d\d/.test(err.message)) {
              stats.failed++;
              stats.lastError = `${err.message} — quarantined ${file}`;
              log(stats.lastError);
              quarantine(file); // server rejected the doc; retrying won't help
            } else {
              throw err; // network/5xx: leave file in spool, trigger backoff
            }
          }
        }
      });
      try {
        await Promise.all(workers);
        backoffMs = 0;
      } catch (err) {
        backoffMs = Math.min(backoffMs ? backoffMs * 2 : BACKOFF_BASE_MS, BACKOFF_MAX_MS);
        stats.lastError = `${err.message}, retrying in ${backoffMs / 1000}s`;
        log(stats.lastError);
      }
    } finally {
      processing = false;
      if (!closed) schedule();
    }
  }

  function schedule(delay) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(processBatch, delay ?? (backoffMs || BATCH_WINDOW_MS));
    timer.unref?.();
  }

  // react quickly to fresh events instead of waiting out the window
  const spoolWatcher = chokidar.watch(paths().spoolNew, { ignoreInitial: true, depth: 0 });
  spoolWatcher.on('add', () => {
    if (!processing && !backoffMs && pendingEvents().length >= BATCH_MAX) schedule(50);
  });

  schedule(200); // initial drain

  return {
    stats: () => ({ ...stats, pending: pendingEvents().length }),
    // drain everything currently spooled (used by --once and tests)
    async drain() {
      while (pendingEvents().length > 0) {
        const before = pendingEvents().length;
        await processBatch();
        if (pendingEvents().length >= before && backoffMs) break; // stuck: server down or all quarantined
      }
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await spoolWatcher.close();
      if (watcher) await watcher.close();
    },
  };
}
