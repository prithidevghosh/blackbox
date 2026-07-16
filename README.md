<div align="center">

<img src="docs/assets/logo.svg" width="130" alt="blackbox logo — an orange flight recorder with a signal trace">

# blackbox

**A fully local flight recorder for modern dev work.**

Terminal commands · AI-agent sessions · git commits — recorded, correlated, searchable by meaning.

<img alt="tests: 45 unit + e2e" src="https://img.shields.io/badge/tests-45_unit_+_e2e-2ea44f">
<img alt="privacy: 100% local" src="https://img.shields.io/badge/privacy-100%25_local-F04E00">
<img alt="node ≥ 20" src="https://img.shields.io/badge/node-%E2%89%A5_20-339933?logo=nodedotjs&logoColor=white">
<img alt="platform: macOS | Linux" src="https://img.shields.io/badge/platform-macOS_·_Linux-555">
<a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>

[Quickstart](#quickstart) ·
[Why](#why-blackbox) ·
[Commands](#commands) ·
[How it works](#how-it-works) ·
[Privacy](#privacy--what-never-leaves-your-machine) ·
[Comparison](#how-it-compares)

</div>

---

Your day leaves three trails that evaporate: terminal commands (with the output
that actually mattered), AI coding-agent sessions (the reasoning that found the
bug), and git commits (the only trail that survives — with the least context).
Close the terminal, hit `/clear`, and by Friday standup you're reverse-engineering
your own week.

blackbox records all three streams into **Supermemory Local** on your machine,
correlates them by repo / branch / ticket-ID, and answers questions about your
past work — semantically, not by grepping history:

```console
$ blackbox ask "authentication problem with redis"

1. [terminal] 2h ago payments-worker ⧉ PROJ-123 ✗ exit 12
   $ redis-cli PING
   (error) NOAUTH Authentication required.

2. [agent:claude-code] 2h ago payments-worker ⧉ PROJ-123
   the agent explained: redis now requires authentication — the worker's client
   connects without a password…

3. [git] 1h ago payments-worker ⧉ PROJ-123
   fix: PROJ-123 pass redis password to cache client
```

Note the query said *"authentication problem"* — the recorded event says
*"NOAUTH"*. **That's the point.**

## Why blackbox?

- **⚡ Flashback — recall before you ask.** When a failure repeats, a hint lands
  right under the failed command: how often you've hit it, and the commit that
  fixed it. Any terminal, no editor required.

  ```console
  $ redis-cli PING
  (error) NOAUTH Authentication required.
  ⚡ flashback: seen 2× before — last 2h ago [terminal] ✗ exit 12
     $ redis-cli PING → (error) NOAUTH Authentication required.
     fix (git, 1h ago): fix: PROJ-123 pass redis password to cache client
  ```

- **🧠 Semantic recall.** "auth problem" finds `NOAUTH`. Search by what you
  mean, not what you typed.

- **📝 Synthesis, not just search.** `blackbox standup` drafts your
  Worked on / Fixed / Blocked; `blackbox rca PROJ-123` drafts a root-cause
  analysis with a cross-source timeline and cited evidence — all on a local LLM.

- **🤖 Your AI agent's work is part of your work.** Claude Code and Codex
  transcripts are captured live and correlated with the commands and commits
  around them.

- **🔒 Nothing leaves your machine.** Local embeddings, local generation
  (Ollama), secrets redacted *before* ingestion. No cloud APIs, no telemetry.
  Details in [Privacy](#privacy--what-never-leaves-your-machine).

- **🪶 Invisible until you need it.** <3 ms per command on the shell hot path,
  and every component fails soft — a broken pipeline can never break your prompt.

```console
$ blackbox rca PROJ-123 --out rca.md      # drafted RCA: summary, timeline,
                                          # root cause, fix, cited evidence
$ blackbox standup --since 24h            # Worked on / Fixed / Blocked
$ blackbox ask "..." --explain            # grounded answer, local LLM, cited
```

## Quickstart

> **Prereqs:** macOS (or Linux) with zsh, Node ≥ 20, git.
> [Ollama](https://ollama.com) recommended for the LLM features
> (everything else works without it).

```bash
git clone https://github.com/prithidevghosh/blackbox.git && cd blackbox
./install.sh          # installs deps, starts Supermemory Local + daemon,
                      # adds hooks to ~/.zshrc (marked block, easy to remove)
exec zsh              # reload your shell
blackbox status       # all green?
blackbox init         # inside any repo whose commits you want recorded
```

Work normally. Then ask:

```bash
blackbox ask "what did I deploy yesterday"
```

Verify the whole pipeline without doing any work:

```bash
npm run test:all      # 45 unit tests + autonomous end-to-end harness
```

## Commands

| Command | What it does |
|---|---|
| `blackbox ask "<q>" [--explain] [--limit N]` | Semantic search over everything; `--explain` = grounded local-LLM answer with citations |
| `blackbox standup [--since 24h] [--no-llm]` | Worked on / Fixed / Blocked draft |
| `blackbox rca <TICKET> [--out rca.md] [--no-llm]` | Cross-source timeline + drafted root-cause analysis |
| `blackbox record` | Subshell where command **output** is captured (≤8 KB head+tail per command) |
| `blackbox flashback "<command>" [--exit N]` | Preview the ⚡ hint a failing command would get (the zsh hook fires this automatically) |
| `blackbox init` | Record commits of the current repo (opt-in) |
| `blackbox status` | Health of every component |
| `blackbox ingest-daemon [--daemonize\|--stop\|--once]` | The spool → Supermemory pipeline |

## How it works

```
  ┌────────────────┐   ┌──────────────────────┐   ┌─────────────────┐
  │ zsh hooks      │   │ agent watcher        │   │ git post-commit │
  │ preexec/precmd │   │ tails ~/.claude/…    │   │ hook (opt-in    │
  │ (<3ms/cmd)     │   │ and ~/.codex/…       │   │ via blackbox    │
  │ `blackbox      │   │ transcripts live     │   │ init)           │
  │  record` adds  │   │ (JSONL, partial-line │   │                 │
  │  output capture│   │  safe)               │   │                 │
  └───────┬────────┘   └──────────┬───────────┘   └────────┬────────┘
          │      atomic event files (maildir-style)        │
          └────────────────┬──────────────────────────────-┘
                           ▼
                 ~/.blackbox/spool/new/
                           │
                           ▼
              ┌─────────────────────────┐
              │ ingest daemon           │
              │ 1. REDACT (always)      │  secrets → [REDACTED:type]
              │ 2. correlate            │  cwd → {repo, branch, ticket}
              │ 3. batch ≤20 / 5s       │  backoff if :6767 down
              └────────────┬────────────┘
                           ▼  POST /v3/documents
              ┌─────────────────────────┐      ┌─────────────────┐
              │ Supermemory Local :6767 │      │ Ollama :11434   │
              │ local embeddings        │◄─────│ llama3.2:3b     │
              │ (bge-base-en-v1.5)      │      │ (generation)    │
              └────────────┬────────────┘      └────────┬────────┘
                           │ /v3/search                 │
                           ▼                            ▼
   blackbox ask · standup · rca · ⚡ flashback ── --explain / drafts
```

Every component fails soft: hooks work without the daemon (events wait in the
spool), the daemon retries with backoff without Supermemory, `ask` works without
Ollama, unknown transcript lines are skipped, flashback is silent unless it has
a confident match (Supermemory down → silence, not an error), and a broken
capture path can never break your prompt (`|| true` everywhere on the hot path).

## Privacy — what never leaves your machine

- **Everything.** All storage is local: spool files in `~/.blackbox`, encrypted
  Supermemory storage in `~/.supermemory/data`.
- **Embeddings** are computed by Supermemory Local's built-in model
  (Xenova/bge-base-en-v1.5) — on your CPU.
- **Generation** (`--explain`, `standup`, `rca`) calls Ollama on
  `localhost:11434`. Supermemory Local's own LLM backend is also pointed at
  Ollama by `install.sh`, so no component holds a cloud key.
- **Secrets are redacted before ingestion, always**: AWS `AKIA…` keys,
  `sk-*`/`sm_*`/`ghp_*`/`xox*` tokens, `Authorization:` headers,
  `password=`/`PASSWD=` values (quoted too), PEM blocks, and
  `scheme://user:pass@host` credentials become `[REDACTED:<type>]`. Unit tests
  prove redaction runs pre-ingestion.
- **Opt-outs**: git capture is opt-in per repo (`blackbox init`). Kill capture
  in any shell with `export BLACKBOX_DISABLE=1`. Ignore-list for noise commands
  in `~/.blackbox/config.json`. Uninstall = delete the marked block in
  `~/.zshrc` and `rm -rf ~/.blackbox`.

## How it compares

> Tools that ask you to write down what you learned capture what you remembered
> to write. blackbox was there when it happened.

Compared with the usual ways devs try to remember work — shell history,
[Atuin](https://atuin.sh), resuming an old AI session, hand-written decision
journals, or editor-bound bug recall:

|                                    | blackbox | zsh history | Atuin | `claude --resume` | manual journal | in-editor bug recall |
|------------------------------------|:--:|:--:|:--:|:--:|:--:|:--:|
| Automatic capture (nothing typed in by hand) | ✅ | ✅ | ✅ | ⚠️ transcripts only | ❌ you write it | ✅ errors, one editor |
| Captures command **output**        | ✅ (`record` mode) | ❌ | ❌ | ❌ | ❌ | ⚠️ editor terminal only |
| Captures AI-agent sessions (Claude, Codex) | ✅ | ❌ | ❌ | ⚠️ one session, resume-only | ❌ | ❌ |
| Git commits                        | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Cross-stream correlation (repo/branch/ticket) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Semantic search ("auth problem" finds NOAUTH) | ✅ everything | ❌ Ctrl-R | ❌ substring/fuzzy | ❌ | ✅ what you wrote | ✅ bugs |
| Proactive recall on failure        | ✅ ⚡ flashback, any terminal | ❌ | ❌ | ❌ | ❌ | ✅ in-editor |
| Synthesis (standup / RCA drafts)   | ✅ local LLM | ❌ | ❌ | ❌ | ❌ | ❌ |
| Fully local generation (no cloud LLM) | ✅ Ollama | — | — | ❌ cloud model | — | ❌ cloud LLM API |
| Editor-agnostic                    | ✅ any terminal, any editor | ✅ | ✅ | ✅ | ✅ | ❌ one editor |
| Secret redaction before storage    | ✅ always | ❌ plaintext file | ⚠️ filters | ❌ | — | — |

Scope is the difference: bug trackers remember bugs, journals remember what you
wrote down; blackbox records the whole workday — commands with output, AI-agent
sessions, commits — and synthesizes answers from it.

## Configuration

<details>
<summary><code>~/.blackbox/config.json</code> — every knob, with defaults</summary>

```jsonc
{
  "baseURL": "http://localhost:6767",   // Supermemory Local
  "containerTag": "blackbox",           // memory namespace
  "sources": { "terminal": true, "agent": true, "git": true },
  "ignore": ["cd", "ls", "pwd", "clear", "..."],  // never recorded
  "maxOutputBytes": 8192,               // per-command output budget (head+tail)
  "ollama": { "baseURL": "http://localhost:11434", "model": "llama3.2:3b" },
  "flashback": { "enabled": true, "similarity_threshold": 0.72 },  // ⚡ hints on
                                        // failed commands; threshold calibrated
                                        // empirically (DECISIONS.md D9)
  "ticketRegex": "[A-Z][A-Z0-9]+-\\d+", // PROJ-123 style; customize per tracker
  "jiraBaseURL": "",                    // optional, for future ticket enrichment
  "agents": {
    "claude-code": { "dir": "~/.claude/projects", "enabled": true },
    "codex":       { "dir": "~/.codex/sessions",  "enabled": true }
  }
}
```

</details>

## Testing

```bash
npm test          # 45 unit tests: parsers, redaction, correlation, record
                  # splitting, spool, config, flashback
npm run test:e2e  # autonomous rule-3 harness: scripted zsh session with a
                  # planted failure + live agent-transcript replay + hooked
                  # git commit → daemon → semantic ask → flashback → rca timeline
npm run test:all
```

The e2e harness runs against the real Supermemory Local with an isolated
container tag and an isolated `BLACKBOX_HOME` — no human input, no mocks in the
retrieval path. Its final assertions: a query with *different words* than the
recorded failure must retrieve it, and `rca PROJ-123` must produce a timeline
containing events from **all three sources**. Flashback gets negative tests
too: an unrelated failing command must produce **total silence**, so must an
unreachable Supermemory, and prompt latency with flashback enabled must be
indistinguishable from disabled (the hook stays async).

<details>
<summary>Harness notes (backlog abort, pointing at another instance)</summary>

The harness aborts early with an explanation if Supermemory is mid-backlog
(each document costs ~1 min of local-LLM time to fully process) — pause your
own capture with `blackbox ingest-daemon --stop` and re-run once it drains.
`BLACKBOX_E2E_BASEURL` points the harness at a different Supermemory instance.

</details>

## Notes & known limits

- Codex CLI support is written against the documented rollout format with
  fixture tests, but was not verified against a live Codex install (none on the
  dev machine — see [DECISIONS.md](DECISIONS.md) D4). Claude Code support is
  verified against real transcripts.
- `blackbox record` needs `script(1)` (present on macOS and util-linux).
  Passive capture (commands, exit codes, durations — no output) needs only zsh.
- Search uses `/v3/search`; on Supermemory Local 0.0.5, `/v4/search` covers
  extracted memories, not raw documents (see [docs/api-notes.md](docs/api-notes.md)).
- bash hooks: not shipped yet; the zsh implementation is the reference.

## Docs

- [docs/api-notes.md](docs/api-notes.md) — observed Supermemory API + agent transcript formats
- [DECISIONS.md](DECISIONS.md) — design choices and the reasoning behind them

## Contributing & license

Issues and PRs welcome — `npm run test:all` must stay green (the e2e harness
needs Supermemory Local running on `:6767`).

[MIT](LICENSE).

<div align="center">
<sub>Like a real flight recorder, the logo is orange — black boxes never were black.</sub>
</div>
