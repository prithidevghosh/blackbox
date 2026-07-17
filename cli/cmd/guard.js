// `blackbox guard install|uninstall|status` — manage the Claude Code
// PreToolUse hook that lets guard warn the agent about past failures.
// Settings edits are merge-only: we parse ~/.claude/settings.json, add or
// remove exactly our own entry (recognized by the `guard-hook` token in its
// command), and never touch anything else. Unparseable settings abort the
// install rather than risk clobbering the user's file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../lib/config.js';
import { green, red, yellow, dim, bold } from '../../lib/format.js';

const HOOK_TOKEN = 'guard-hook';

export function settingsPath() {
  return process.env.BLACKBOX_CLAUDE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
}

// Absolute node + absolute cli path: Claude Code GUI sessions don't inherit
// the shell PATH, so a bare `blackbox` could silently never fire.
function hookCommand() {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'blackbox.js');
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve(cli))} guard-hook`;
}

function isOurs(h) {
  return h?.type === 'command' && String(h.command || '').includes(HOOK_TOKEN);
}

export function guardInstalled(settings) {
  return (settings?.hooks?.PreToolUse || []).some((m) => (m.hooks || []).some(isOurs));
}

// Pure transforms (unit-tested): return a new settings object, never mutate.
export function addGuardHook(settings, command) {
  const out = structuredClone(settings ?? {});
  out.hooks = out.hooks || {};
  out.hooks.PreToolUse = out.hooks.PreToolUse || [];
  if (guardInstalled(out)) return out; // idempotent
  out.hooks.PreToolUse.push({
    matcher: 'Bash',
    hooks: [{ type: 'command', command, timeout: 5 }],
  });
  return out;
}

export function removeGuardHook(settings) {
  const out = structuredClone(settings ?? {});
  if (!out.hooks?.PreToolUse) return out;
  out.hooks.PreToolUse = out.hooks.PreToolUse
    .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((m) => m.hooks.length > 0);
  if (out.hooks.PreToolUse.length === 0) delete out.hooks.PreToolUse;
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

function readSettings(file) {
  try {
    return { settings: JSON.parse(fs.readFileSync(file, 'utf8')), missing: false };
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: {}, missing: true };
    throw new Error(`${file} exists but is not valid JSON (${err.message}) — fix it first; refusing to overwrite.`);
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.blackbox-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export async function run(args) {
  const sub = args[0];
  const file = settingsPath();

  if (sub === 'install') {
    let settings;
    try {
      ({ settings } = readSettings(file));
    } catch (err) {
      console.error(`guard: ${err.message}`);
      process.exit(1);
    }
    if (guardInstalled(settings)) {
      console.log(`guard: already installed in ${file}`);
      return;
    }
    writeSettings(file, addGuardHook(settings, hookCommand()));
    console.log(`${green('●')} guard installed — PreToolUse hook added to ${file}`);
    console.log(dim('  new Claude Code sessions get past-failure warnings before Bash commands run.'));
    console.log(dim('  remove any time: blackbox guard uninstall'));
    return;
  }

  if (sub === 'uninstall') {
    let settings, missing;
    try {
      ({ settings, missing } = readSettings(file));
    } catch (err) {
      console.error(`guard: ${err.message}`);
      process.exit(1);
    }
    if (missing || !guardInstalled(settings)) {
      console.log('guard: not installed, nothing to remove');
      return;
    }
    writeSettings(file, removeGuardHook(settings));
    console.log(`${green('●')} guard uninstalled — hook entry removed from ${file} (everything else untouched)`);
    return;
  }

  if (!sub || sub === 'status') {
    const cfg = loadConfig();
    let installed = false;
    try {
      installed = guardInstalled(readSettings(file).settings);
    } catch {}
    const enabled = cfg.guard?.enabled !== false;
    console.log(bold('blackbox guard\n'));
    console.log(installed ? `${green('●')} hook installed in ${file}` : `${yellow('●')} hook not installed — run: blackbox guard install`);
    console.log(
      enabled
        ? `${green('●')} enabled — threshold ${cfg.guard?.threshold ?? 0.65}, hard cap ${cfg.guard?.timeout_ms ?? 800}ms, advise-only (never blocks)`
        : `${red('●')} disabled in config.json (guard.enabled)`
    );
    return;
  }

  console.error('usage: blackbox guard install|uninstall|status');
  process.exit(1);
}
