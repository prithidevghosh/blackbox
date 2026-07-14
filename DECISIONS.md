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
