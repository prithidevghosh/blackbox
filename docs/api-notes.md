# API Notes — observed behavior, not assumptions

Everything below was observed live on this machine on 2026-07-14/15 against real
services and real files. Client code in this repo is written against these shapes.

## Supermemory Local

- **Version:** supermemory-server 0.0.5 (darwin-arm64 binary)
- **Install:** `curl -fsSL https://supermemory.ai/install | bash` (or `npx supermemory local`,
  which runs the same installer). Binary lands at `~/.supermemory/bin/supermemory-server`
  with a wrapper at `~/.local/bin/supermemory-server`.
- **Startup requirement (observed):** refuses to boot without a model-provider key:
  `No model provider API key configured. Set one of OPENAI_API_KEY, ANTHROPIC_API_KEY, ...`.
  For fully-local operation we point it at Ollama's OpenAI-compatible endpoint:

  ```bash
  SUPERMEMORY_DATA_DIR="$HOME/.supermemory/data" \
  OPENAI_BASE_URL="http://localhost:11434/v1" \
  OPENAI_API_KEY="ollama" \
  OPENAI_MODEL="llama3.2:3b" \
  supermemory-server
  ```

- **Port:** 6767. Root `/` serves a web UI (HTML). There is **no `/health`** (404);
  we use `GET /` status-code as liveness probe.
- **Embeddings:** built-in local `Xenova/bge-base-en-v1.5`, 768d. First boot downloads
  ~106 MB model, ~15 s boot.
- **Data:** encrypted local storage at `$SUPERMEMORY_DATA_DIR` (defaults to `./.supermemory`
  in the CWD — always set the env var or it litters the current directory).
- **Auth:** an `sm_...` API key is printed at boot and — observed — is
  **auto-applied for unauthenticated localhost requests**. All curl calls below
  succeeded with no `Authorization` header.

### Ingest: `POST /v3/documents`

Request (observed working):

```json
{
  "content": "Test document: redis connection failed with NOAUTH Authentication required during deploy of payments service.",
  "containerTag": "blackbox-test",
  "metadata": { "source": "terminal", "repo": "blackbox", "ticket": "PROJ-999" }
}
```

Response — `200`, processing is **async**:

```json
{ "id": "RsPQzTkARdhQaL8JdR4mND", "status": "queued" }
```

### Status: `GET /v3/documents/:id`

```json
{
  "id": "RsPQzTkARdhQaL8JdR4mND",
  "content": "Test document: redis connection failed with NOAUTH...",
  "metadata": { "source": "terminal", "repo": "blackbox", "ticket": "PROJ-999" },
  "status": "done",
  "dreamingStatus": "done",
  "containerTags": ["blackbox-test"],
  "createdAt": "2026-07-14T20:14:51.282Z",
  "type": "text",
  "title": "Test document: redis connection failed with NOAUTH...",
  "...": "connectionId/customId/ogImage/raw/summary/url/filepath also present"
}
```

Processing took ~25 s for the first doc (includes model warm-up); subsequent docs
are faster. A doc is searchable only after `status: "done"`.

### List: `POST /v3/documents/list`

Request `{"containerTags":["blackbox-test"]}` →
`{"memories":[{...same shape as GET...}], "pagination":{"currentPage":1,"limit":10,"totalItems":1,"totalPages":1}}`.
Supports filtering by container tags. Field is named `memories` even though these
are documents.

### Search — the important discovery

**`POST /v4/search` does NOT return document results on Supermemory Local 0.0.5.**
It accepts `{"q": "...", "limit": N}` (rejects a missing `q` with a zod error) but
returned `{"results":[],"total":0}` for content that `/v3/search` finds fine —
v4 searches extracted "memories", which document ingestion does not populate here.

**`POST /v3/search` is the working document search** and is what `blackbox ask` uses:

Request:

```json
{ "q": "authentication problem with redis", "containerTags": ["blackbox-test"], "limit": 5 }
```

Response (semantic hit — query words deliberately different from content):

```json
{
  "results": [
    {
      "documentId": "RsPQzTkARdhQaL8JdR4mND",
      "title": "Test document: redis connection failed with NOAUTH...",
      "score": 0.7923186781311461,
      "chunks": [
        {
          "content": "Test document: redis connection failed with NOAUTH Authentication required during deploy of payments service.",
          "position": 0,
          "isRelevant": true,
          "score": 0.7923186781311461
        }
      ],
      "metadata": { "source": "terminal", "repo": "blackbox", "ticket": "PROJ-999" },
      "createdAt": "2026-07-14T20:14:51.282Z",
      "updatedAt": "2026-07-14T20:15:16.719Z",
      "type": "text"
    }
  ],
  "timing": 43,
  "total": 1
}
```

Notes:
- `containerTags` (array) filters; omitting it searches everything.
- Metadata round-trips intact — we rely on it for `{source, repo, branch, ticket, ts, exit_code}`.
- Metadata **filtering** at search time is not relied on; we filter client-side on
  the returned `metadata` (works regardless of server-side filter support).

## Ollama

- Version 0.22.0 running on `http://localhost:11434`.
- `llama3.2:3b` pulled and available (also gemma4:e2b/e4b/26b already present).
- Generation via `POST /api/generate` `{"model":"llama3.2:3b","prompt":"...","stream":false}`
  (raw fetch, no SDK).

## Supermemory Local — port + data dir (observed, binary strings + live boot)

- `PORT` or `SUPERMEMORY_PORT` env sets the listen port (default 6767);
  `SUPERMEMORY_DATA_DIR` sets the data dir (default `./.supermemory` — i.e.
  **cwd-relative**, so always set it explicitly or the server litters the cwd).
- Verified live: a second isolated instance on :6868 with its own data dir
  boots in ~25s and serves /v3 endpoints — this is how the e2e suite avoids
  fighting the user's real store (`BLACKBOX_E2E_BASEURL`).

## Claude Code transcripts (verified on this machine)

- **Location:** `~/.claude/projects/<munged-project-path>/<session-uuid>.jsonl`
  where the munged path is the absolute project path with `/` and `.` replaced by `-`
  (e.g. `-Users-dev-Documents-my-project`).
- One JSONL file per session; **appended live** while a session runs.
- Line types observed (survey over 30 real session files, `claude-vscode` entrypoint;
  CLI entrypoint shares the schema — same writer):

| `type` | What it is | We use |
|---|---|---|
| `user` | user message; `message.content` is a string OR array of `{type:"text"}` / `{type:"tool_result"}` blocks | ✅ text blocks (prompts) |
| `assistant` | model message; `message.content` array of `{type:"text"}` / `{type:"thinking"}` / `{type:"tool_use"}` blocks | ✅ text; tool_use name+input summary |
| `queue-operation`, `file-history-snapshot`, `ai-title`, `last-prompt`, `mode`, `attachment` | bookkeeping | skipped (`ai-title` read for session title) |

- Envelope fields on `user`/`assistant` lines (observed):
  `uuid`, `parentUuid`, `sessionId`, `timestamp` (ISO 8601), `cwd`, `gitBranch`,
  `version`, `entrypoint` (`claude-vscode`), `isSidechain`, `userType`.
  `cwd` + `gitBranch` give us repo/branch correlation for free.
- `user` lines with `tool_result` content also carry `toolUseResult.{stdout,stderr}`.
- Synthetic/system text arrives wrapped in tags like `<ide_opened_file>`,
  `<system-reminder>`, `<command-name>` — parser filters these out of "user prompt"
  events.
- `assistant` lines carry `message.model` (e.g. `claude-opus-4-8`) and `usage`.
- Malformed/unknown lines must be skipped silently — observed files legitimately
  contain types we don't know about, and a live-appended last line can be partial.

## Codex CLI transcripts

**Not installed on this machine** (`~/.codex/` does not exist) — could not verify
against real files. The Codex parser is written against the format documented in
the open-source Codex CLI repo (rollout files
`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, lines
`{timestamp, type: "session_meta" | "response_item" | ..., payload}`), with a
hand-built fixture, and is clearly flagged as best-effort until verified against
a real installation. Claude Code is the verified, demo-ready path.

## Claude Code PreToolUse hooks (verified on this machine, Claude Code 2.1.205)

Verified live: registered a stdin-capturing hook in a scratch project's
`.claude/settings.json`, ran a headless session (`claude -p`), observed both
directions of the contract. Docs source: code.claude.com/docs hooks reference.

### Settings registration (observed working)

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [ { "type": "command", "command": "/abs/path/to/hook" } ] }
    ]
  }
}
```

- `matcher` filters by tool name; `"Bash"` fires only for Bash. `timeout` field
  (seconds) is supported per docs; default 600s — we enforce our own 800ms cap
  inside the hook instead of relying on it.
- Hooks merge across user/project/local settings files; all matching entries run.

### stdin JSON delivered to the hook (captured verbatim, 2.1.205)

```json
{"session_id":"e590d6da-…","transcript_path":"/Users/…/<session>.jsonl",
 "cwd":"/private/tmp/…/hookverify","prompt_id":"505ceaa2-…",
 "permission_mode":"default","hook_event_name":"PreToolUse",
 "tool_name":"Bash",
 "tool_input":{"command":"echo hook-verify-123","description":"Run the specified echo command"},
 "tool_use_id":"toolu_01XDu6c8…"}
```

- `tool_input.command` is the Bash command string. `tool_input.description` also
  present for Bash. `tool_use_id` present (not in the docs' example). No `effort`
  field observed in this run — treat every field beyond `tool_name`/`tool_input`
  as optional.
- `session_id` is stable per session → our dedupe key.

### Output contract (verified live)

- **Silent allow:** exit 0 with no stdout → normal permission flow, command runs.
  This is guard's fail-open path for every error/timeout/no-match case.
- **Inject context, no permission decision (guard's shape — verified):**
  exit 0 with stdout JSON:

```json
{"hookSpecificOutput":{
  "hookEventName":"PreToolUse",
  "additionalContext":"…the warning text…"}}
```

  Observed effect: the Bash command still executed through the NORMAL permission
  flow, and Claude received the text, surfaced to the model as
  `PreToolUse:Bash hook additional context: <additionalContext>`.
  Claude quoted and acted on it in the reply — the injection channel works with
  zero permission side effects.
- **`permissionDecision:"allow"` + additionalContext** also verified working,
  BUT it bypasses the permission prompt for that call — guard does not use it.
- **`permissionDecision:"defer"` + additionalContext is BROKEN on 2.1.205**
  despite being documented: the headless session died silently right after the
  tool_use (no tool result, no reply, exit 0, empty stdout). Never emit `defer`.
- **Blocking** (`permissionDecision:"deny"` or exit 2) exists but guard NEVER
  uses it — advise-only by design.
