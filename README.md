# blackbox 🛩️

**A fully local flight recorder for modern dev work.**

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
*"NOAUTH"*. That's the point.

```console
$ blackbox rca PROJ-123 --out rca.md      # drafted RCA: summary, timeline,
                                          # root cause, fix, cited evidence
$ blackbox standup --since 24h            # Worked on / Fixed / Blocked
$ blackbox ask "..." --explain            # grounded answer, local LLM, cited
```

**Nothing leaves your machine.** No cloud APIs, no telemetry. See
[Privacy](#privacy-what-never-leaves-your-machine).

## 60-second quickstart

Prereqs: macOS (or Linux) with zsh, Node ≥ 20, git. [Ollama](https://ollama.com)
recommended for the LLM features (everything else works without it).

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
npm run test:all      # 38 unit tests + autonomous end-to-end harness
```

## Architecture

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
        blackbox ask · standup · rca  ──── --explain / drafts
```

Every component fails soft: hooks work without the daemon (events wait in the
spool), the daemon retries with backoff without Supermemory, `ask` works without
Ollama, unknown transcript lines are skipped, and a broken capture path can
never break your prompt (`|| true` everywhere on the hot path).

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

## vs. Atuin / plain history / Claude Code --resume

|                                    | blackbox | Atuin | zsh history | `claude --resume` |
|------------------------------------|:--:|:--:|:--:|:--:|
| Terminal commands                  | ✅ | ✅ | ✅ | ❌ |
| …with **output** captured          | ✅ (`record` mode) | ❌ | ❌ | ❌ |
| AI agent sessions (Claude, Codex)  | ✅ | ❌ | ❌ | ⚠️ one session, resume-only |
| Git commits                        | ✅ | ❌ | ❌ | ❌ |
| Cross-stream correlation (ticket)  | ✅ repo/branch/ticket | ❌ | ❌ | ❌ |
| Semantic search ("auth problem" finds NOAUTH) | ✅ | ❌ substring/fuzzy | ❌ Ctrl-R | ❌ |
| Ask questions / standup / RCA      | ✅ local LLM | ❌ | ❌ | ❌ |
| Secret redaction before storage    | ✅ | ⚠️ filters | ❌ | ❌ |
| Fully local                        | ✅ | ✅ (sync optional) | ✅ | ⚠️ transcripts local, model is cloud |

## Commands

| command | what it does |
|---|---|
| `blackbox ask "<q>" [--explain] [--limit N]` | semantic search over everything; `--explain` = grounded local-LLM answer with citations |
| `blackbox standup [--since 24h] [--no-llm]` | Worked on / Fixed / Blocked draft |
| `blackbox rca <TICKET> [--out rca.md] [--no-llm]` | cross-source timeline + drafted root-cause analysis |
| `blackbox record` | subshell where command **output** is captured (≤8 KB head+tail per command) |
| `blackbox init` | record commits of the current repo (opt-in) |
| `blackbox status` | health of every component |
| `blackbox ingest-daemon [--daemonize\|--stop\|--once]` | the spool → Supermemory pipeline |

## Configuration (`~/.blackbox/config.json`)

```jsonc
{
  "baseURL": "http://localhost:6767",   // Supermemory Local
  "containerTag": "blackbox",           // memory namespace
  "sources": { "terminal": true, "agent": true, "git": true },
  "ignore": ["cd", "ls", "pwd", "clear", "..."],  // never recorded
  "maxOutputBytes": 8192,               // per-command output budget (head+tail)
  "ollama": { "baseURL": "http://localhost:11434", "model": "llama3.2:3b" },
  "ticketRegex": "[A-Z][A-Z0-9]+-\\d+", // PROJ-123 style; customize per tracker
  "jiraBaseURL": "",                    // optional, for future ticket enrichment
  "agents": {
    "claude-code": { "dir": "~/.claude/projects", "enabled": true },
    "codex":       { "dir": "~/.codex/sessions",  "enabled": true }
  }
}
```

## Testing

```bash
npm test          # 38 unit tests: parsers, redaction, correlation, record
                  # splitting, spool, config
npm run test:e2e  # autonomous rule-3 harness: scripted zsh session with a
                  # planted failure + live agent-transcript replay + hooked
                  # git commit → daemon → semantic ask → rca timeline
npm run test:all
```

The e2e harness runs against the real Supermemory Local with an isolated
container tag and an isolated `BLACKBOX_HOME` — no human input, no mocks in the
retrieval path. Its final assertions: a query with *different words* than the
recorded failure must retrieve it, and `rca PROJ-123` must produce a timeline
containing events from **all three sources**.

## Notes & known limits

- Codex CLI support is written against the documented rollout format with
  fixture tests, but was not verified against a live Codex install (none on the
  dev machine — see `DECISIONS.md` D4). Claude Code support is verified against
  real transcripts.
- `blackbox record` needs `script(1)` (present on macOS and util-linux).
  Passive capture (commands, exit codes, durations — no output) needs only zsh.
- Search uses `/v3/search`; on Supermemory Local 0.0.5, `/v4/search` covers
  extracted memories, not raw documents (see `docs/api-notes.md`).
- bash hooks: not shipped yet; the zsh implementation is the reference.

Docs: [docs/api-notes.md](docs/api-notes.md) (observed API + transcript formats) ·
[DECISIONS.md](DECISIONS.md) (choices + reasoning) · [demo/script.md](demo/script.md)
(3-minute demo screenplay)

## License

[MIT](LICENSE). Issues and PRs welcome — `npm run test:all` must stay green
(the e2e harness needs Supermemory Local running on :6767).
