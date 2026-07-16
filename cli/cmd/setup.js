// `blackbox setup` — one-time environment setup, idempotent. This is the
// npm-installable replacement for install.sh:
//   npm install -g blackbox && blackbox setup
// Steps: config, Supermemory Local binary, Ollama model, zsh hooks, then
// starts everything through the same path as `blackbox up`.
//   --no-start   skip starting supermemory + daemon (used by tests)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initConfig, paths, home } from '../../lib/config.js';
import { findSupermemoryBinary } from '../../lib/services.js';
import { ollamaAlive } from '../../lib/ollama.js';
import { upsertMarkedBlock } from '../../lib/zshrc-block.js';
import { bold, yellow } from '../../lib/format.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const say = (msg) => console.log(`${bold('[blackbox]')} ${msg}`);

export async function run(args) {
  const noStart = args.includes('--no-start');

  // 1. node + config
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    console.error(`blackbox: node >= 20 required (found ${process.version})`);
    process.exit(1);
  }
  say(`node ${process.version} ok`);
  const cfg = initConfig();
  say(`config ready at ${paths().config}`);

  // 2. supermemory local binary (install if missing, ~30s one-time)
  if (!findSupermemoryBinary()) {
    say('installing supermemory local (one binary, ~30s)…');
    execSync('curl -fsSL https://supermemory.ai/install | bash', { stdio: 'inherit' });
    if (!findSupermemoryBinary()) {
      console.error('blackbox: supermemory install did not produce a binary — see https://supermemory.ai/docs/self-hosting/overview');
      process.exit(1);
    }
  }
  say('supermemory local binary ok');

  // 3. ollama (optional but recommended)
  if (await ollamaAlive(cfg)) {
    let hasModel = false;
    try {
      const res = await fetch(`${cfg.ollama.baseURL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const tags = await res.json();
      hasModel = (tags.models || []).some((m) => m.name === cfg.ollama.model || m.name.startsWith(cfg.ollama.model));
    } catch {}
    if (!hasModel) {
      say(`pulling ${cfg.ollama.model} for local generation (~2 GB, one-time)…`);
      try {
        execFileSync('ollama', ['pull', cfg.ollama.model], { stdio: 'inherit' });
      } catch {
        say(yellow('WARN: pull failed — ask/standup/rca will use no-LLM fallbacks'));
      }
    }
    say(`ollama ok (${cfg.ollama.model})`);
  } else {
    say(yellow('WARN: Ollama not running — ask --explain / standup / rca fall back to non-LLM output (capture + search fully work)'));
  }

  // 4. `blackbox` wrapper + zsh hooks in a marked ~/.zshrc block
  const binDir = path.join(home(), 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, 'blackbox');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec node "${path.join(pkgRoot, 'cli', 'blackbox.js')}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);

  const zshrc = path.join(os.homedir(), '.zshrc');
  let content = '';
  try {
    content = fs.readFileSync(zshrc, 'utf8');
  } catch {}
  fs.writeFileSync(
    zshrc,
    upsertMarkedBlock(content, [
      `export PATH="${binDir}:$PATH"`,
      `source "${path.join(pkgRoot, 'shell', 'blackbox.zsh')}"`,
    ])
  );
  say('zsh hooks installed in ~/.zshrc (terminal commands recorded from the next shell)');

  // 5. start supermemory + daemon (same path as `blackbox up`)
  if (!noStart) {
    const { run: up } = await import('./up.js');
    await up([]);
  }

  console.log(`
──────────────────────────────────────────────────────────────
 blackbox is set up. Quickstart:

   exec zsh                      # reload your shell (hooks active)
   blackbox status               # every component at a glance
   blackbox init                 # inside a repo: record its commits (opt-in)
   blackbox record               # subshell that also captures command OUTPUT

 then, after you've done some work:

   blackbox ask "why did the deploy fail" --explain
   blackbox standup --since 24h
   blackbox rca PROJ-123 --out rca.md

 After a reboot: blackbox up
 Everything stays on this machine: ~/.blackbox → localhost:6767.
──────────────────────────────────────────────────────────────`);
}
