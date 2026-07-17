# Decisions

Running log of technical decisions, options considered, and reasoning.

## D1 — Search endpoint: /v3/search instead of /v4/search

**Options:** (a) `/v4/search` as the mission text suggested; (b) `/v3/search`.

**Observed:** On Supermemory Local 0.0.5, `/v4/search` accepts `{"q": ...}` but
returns `{"results":[],"total":0}` for documents that are fully processed
(`status: "done"`, `dreamingStatus: "done"`). Tried `containerTag` (string),
`containerTags` (array), and `include:{documents:true,...}` — all empty. It
searches extracted memory entries, which `/v3/documents` ingestion does not
populate locally. `/v3/search` returns the document with chunk-level scores and
a strong semantic match (0.79 for a query using different words than the content).

**Decision:** `blackbox ask` uses `POST /v3/search`. Ground rule 1 (observed
shapes win over assumed schemas) applies. Recorded in docs/api-notes.md with the
raw payloads.

## D2 — Raw fetch instead of the Supermemory JS SDK

**Options:** (a) official `supermemory` npm SDK with `baseURL` override;
(b) raw `fetch` against observed endpoints.

**Reasoning:** The local server already deviates from the cloud API surface the
SDK is generated for (D1: v4/search empty; `/v3/documents/list` returns
`memories`; no `/health`). An SDK typed against cloud schemas adds a dependency
that can silently mismatch the local server, and we only need 4 endpoints. Raw
fetch keeps the dep tree at just `chokidar` and makes every request/response
shape explicit and testable against api-notes.md. The SDK offers no offline
advantage — it is the harder-to-debug option here, not the better one.

## D3 — Supermemory Local's LLM backend points at Ollama

Supermemory Local 0.0.5 refuses to boot without a model-provider key. Cloud keys
would violate the local-only rule. We start it with
`OPENAI_BASE_URL=http://localhost:11434/v1, OPENAI_API_KEY=ollama,
OPENAI_MODEL=llama3.2:3b` so its internal LLM features also stay on-machine.
Embeddings are its built-in local model (bge-base-en-v1.5) either way.

## D4 — Codex CLI parser ships unverified-on-machine

Codex CLI is not installed here (`~/.codex/` absent). Options: (a) drop Codex
support; (b) build the parser against the documented open-source rollout format
with a hand-made fixture. Chose (b): the watcher architecture is
per-agent-adapter anyway, the fixture-driven parser costs little, and users with
Codex get best-effort support. Flagged in README and api-notes.md; Claude Code
is the verified path and the demo path.

## D5 — Generation model: llama3.2:3b

Ollama had gemma4 models (7–17 GB) but no small instruct model. Pulled
`llama3.2:3b` (~2 GB) per the mission default: fastest cold generation for
standup/rca on modest hardware, good enough for grounded summarization with
citations. Model name is configurable in `~/.blackbox/config.json`.

## D6 — e2e drives `blackbox record` through a real shell pipe

macOS `script(1)` calls tcgetattr on stdin and rejects the socketpairs Node
uses for `stdio: "pipe"`. The harness therefore feeds the recorded shell via
`sh -c '{ paced printfs; } | blackbox record'` (a FIFO), matching how a human
tty behaves. Input is paced because zsh installs the hooks at the end of rc
sourcing — commands typed before that would be invisible to preexec.

## D7 — proceeded with defaults where user input was optional

Batched decisions taken without blocking (flagged for the user): product name
kept as "blackbox"; Codex CLI supported best-effort via fixtures (not installed
here); Jira enrichment for `rca` skipped (stretch goal requiring credentials —
`jiraBaseURL` config key reserved); no clipboard capture (not in scope of the
three streams).

## Update round 1 (2026-07-16) — audit

State of every milestone before applying this round's updates, verified by
running the full suite + e2e from a clean state:

| milestone | state | evidence |
|---|---|---|
| M1 foundation (config, spool, atomic events) | done | unit tests green; spool drains in e2e |
| M2 terminal capture (zsh hooks + `record` output mode) | done | e2e records planted failure with output |
| M3 agent-session capture (claude-code live-tail; codex fixture) | done — **protected, do not weaken** | e2e replays transcript with mid-line split |
| M4 git capture (opt-in post-commit) | done | e2e hooked commit spooled |
| M5 redaction pre-ingestion | done — frozen | 10 unit tests |
| M6 ingest daemon (correlate, batch, backoff) | done | e2e three sources tagged repo+ticket |
| M7 `ask` (+ `--explain`) | done — frozen | e2e semantic retrieval with different words |
| M8 `standup` / `rca` | done | e2e rca timeline has all three sources |
| M8b flashback (proactive recall on failure) | **missing** → built this round (D9, D10) | was never implemented; no trace in code or log |
| M9 `status` / install.sh | done | extended this round (per-source counts, flashback, backlog) |
| M10 e2e harness + docs + demo | done | hardened this round (D8) |
| M11 ui | missing — last priority, not built this round | — |

The audit run itself: 38/38 unit tests green; e2e failed 3 assertions for an
environmental reason analysed in D8 (not a code regression).

## D8 — e2e vs a busy shared Supermemory instance

**Observed:** Supermemory Local 0.0.5 processes every document through a
"memory agent" LLM step (~40–60 s per document on llama3.2:3b, 2 concurrent
workers). Dogfooding blackbox while developing it means the agent watcher
captures the dev session itself, continuously refilling the queue — the e2e's 7
documents queued behind ~40 others and its 300 s wait expired, failing 3
assertions with no code at fault.

**Also observed (hazard):** running a *second* supermemory-server on another
port for test isolation does not work — both instances attach to one rivet
workflow engine, the second instance steals the first's workflow jobs, and its
storage writes fail (`store-batch-1 ✗`), wedging both. Do not attempt
instance-per-test-run isolation on one machine.

**Decision:** (a) the harness now prefliights the shared queue and aborts early
with an actionable message (pause capture: `blackbox ingest-daemon --stop`,
events wait safely in the spool) instead of failing three ways 8 minutes later;
(b) the harness accepts `BLACKBOX_E2E_BASEURL` so it can run against any
instance; (c) `blackbox status` now shows how many documents are still
processing. Raising the 300 s timeout was rejected: it hides the problem and
makes failures slower, not rarer.

## D9 — flashback similarity threshold: 0.72, calibrated

**Method:** scored real /v3/search results (bge-base-en-v1.5 chunk scores) for
two query classes against both the e2e fixture container and a 200+ document
container of genuine usage:

- true repeats (same planted failure re-typed exactly): **0.923**;
  command-only re-typed: **0.722–0.781**; semantic paraphrase
  ("authentication problem with redis" vs NOAUTH): **0.786–0.793**
- unrelated failing commands (cargo/kubectl/python/make/docker/jest/terraform/
  go, 14 probes across both containers): **max 0.689**, typical 0.56–0.65

**Decision:** threshold 0.72 — above every unrelated probe (margin 0.031),
at/below every true-repeat top hit. Both knobs live in config
(`flashback.enabled`, `flashback.similarity_threshold`); hook and CLI read the
same config. A miss costs nothing (silence); a false hint costs trust — ties
break toward silence.

## D10 — flashback fires from a disowned background spawn, never the prompt

The zsh precmd spawns `blackbox _flashback` in a disowned subshell writing to
`/dev/tty` (`BLACKBOX_FLASHBACK_OUT` overrides for tests) and returns in ~1–5 ms
— measured enabled-vs-disabled in the e2e, which also asserts total silence
when Supermemory is unreachable and when similarity is below threshold. Exit
130 (SIGINT) never triggers a hint: the user aborting a command is not a
failure worth interrupting them about. The hint cites count and recency from
result metadata (`metadata.ts`), and shows a correlated git commit when one
also clears the threshold — the cross-stream story in one glance. Enabled in
`record` mode too (the demo runs there); the hint may land in the typescript
between command sentinels, which the record parser already tolerates.

## D5 — guard hook output: additionalContext with NO permissionDecision

**Options:** (a) `permissionDecision:"allow"` + `additionalContext`;
(b) `permissionDecision:"defer"` + `additionalContext`; (c) `additionalContext`
alone, no decision field.

**Observed (Claude Code 2.1.205, live headless runs):** (a) works but skips the
user's permission prompt for that call — guard would silently widen what the
agent may run, violating "never break the user's agent". (b) is documented but
broken: the session died silently after tool_use (no result, no reply, exit 0).
(c) works exactly as needed: context injected, surfaced to the model as
`PreToolUse:Bash hook additional context: …`, normal permission flow untouched.

**Decision:** guard emits shape (c) only, and exits 0 silently in every other
case (no match, low confidence, timeout, supermemory down, parse error).
Raw payloads in docs/api-notes.md.
