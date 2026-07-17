#!/usr/bin/env node
// blackbox — local flight recorder for dev work.
// Subcommands are lazy-imported so `blackbox record`'s shell path stays light.

const [, , cmd, ...args] = process.argv;

const commands = {
  ask: () => import('./cmd/ask.js'),
  standup: () => import('./cmd/standup.js'),
  rca: () => import('./cmd/rca.js'),
  status: () => import('./cmd/status.js'),
  record: () => import('./cmd/record.js'),
  init: () => import('./cmd/init.js'),
  setup: () => import('./cmd/setup.js'),
  up: () => import('./cmd/up.js'),
  down: () => import('./cmd/down.js'),
  'ingest-daemon': () => import('./cmd/ingest-daemon.js'),
  flashback: () => import('./cmd/flashback.js'),
  guard: () => import('./cmd/guard.js'),
  'guard-hook': () => import('./cmd/guard-hook.js'), // internal: invoked by Claude Code's PreToolUse hook
  _flashback: () => import('./cmd/flashback.js'), // internal: fired by the zsh hook on failed commands
  _spool: () => import('./cmd/spool.js'), // internal: tests write events through this
  '_git-commit': () => import('./cmd/git-commit.js'), // internal: called by post-commit hook
};

function usage(code = 0) {
  console.log(`blackbox — local flight recorder for dev work

Usage:
  blackbox ask "<question>" [--explain] [--limit N]   search everything you did
  blackbox standup [--since 24h]                      draft a standup
  blackbox rca <TICKET-ID> [--out file.md]            draft a root-cause analysis
  blackbox status                                     component health check
  blackbox record                                     start an output-recorded subshell
  blackbox flashback "<command>" [--exit N]           preview the failed-command hint
  blackbox guard install|uninstall|status             warn Claude Code about past failures pre-command
  blackbox init                                       install git hook in current repo
  blackbox setup                                      one-time setup (config, supermemory, zsh hooks)
  blackbox up                                         start ollama + supermemory + ingest daemon (e.g. after reboot)
  blackbox down [--all]                               stop the daemon (--all: also supermemory)
  blackbox ingest-daemon [--once]                     run the spool->supermemory daemon

Data stays on this machine: ~/.blackbox spool -> localhost:6767 (Supermemory Local).`);
  process.exit(code);
}

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') usage();
if (!commands[cmd]) {
  console.error(`blackbox: unknown command '${cmd}'\n`);
  usage(1);
}

const mod = await commands[cmd]();
await mod.run(args);
