# Demo screenplay — 3 minutes

Goal: show the loss (ephemeral work) → the recovery (`ask`) → the payoff
(`rca`, `standup`). Practice once; the timings assume things are warm.

## Setup (before recording — not part of the 3 minutes)

1. `./install.sh` done, `blackbox status` all green, `exec zsh`.
2. A demo repo `payments-worker` with a planted redis bug:
   ```bash
   mkdir ~/demo/payments-worker && cd ~/demo/payments-worker && git init -b main
   printf 'export const client = connect();\n' > cache.js
   printf '#!/bin/sh\necho "(error) NOAUTH Authentication required." >&2\nexit 12\n' > worker.sh
   chmod +x worker.sh && git add . && git commit -m "initial"
   blackbox init
   git checkout -b fix/PROJ-123-redis-auth
   ```
3. Terminal font big, two windows ready: **A** (work), **B** (kept closed until scene 4).

---

## Scene 1 — the incident (0:00–0:40)

**Window A**, inside `payments-worker`, in a *recorded* shell:

```
blackbox record
./worker.sh                # ← fails: NOAUTH Authentication required, exit 12
```

> "Ticket PROJ-123: the payments worker is down. This shell is recorded —
> commands *and* output, straight into a local memory store. Nothing leaves
> the machine."

## Scene 2 — Claude Code investigates (0:40–1:20)

Still in the repo:

```
claude "worker.sh fails on every cache read, ticket PROJ-123 — investigate the redis connection"
```

Let it poke around (it will run `./worker.sh` or `redis-cli`, see NOAUTH, and
explain the missing password). blackbox is tailing the session transcript live.

> "Claude finds it: redis got auth enabled, the client has no password. All of
> this reasoning normally dies with this window."

## Scene 3 — fix + commit (1:20–1:40)

```
printf 'export const client = connect({ password: process.env.REDIS_PASSWORD });\n' > cache.js
git add . && git commit -m "fix: PROJ-123 pass redis password to cache client"
exit                       # end the recorded shell
```

**Close window A. Dramatically.** (⌘W)

> "Terminal closed. Agent session gone. Three weeks pass."

## Scene 4 — total recall (1:40–2:30)

Open **window B** (fresh shell, any directory):

```
blackbox ask "authentication problem with redis" --explain
```

Point at the results as they appear:

> "Different words — I said 'authentication problem', the error said NOAUTH.
> It finds the failing command with its output, the agent's diagnosis, and the
> fix commit — correlated by ticket. And --explain answers from a *local*
> llama3.2, citing the events."

```
blackbox rca PROJ-123 --out rca.md && cat rca.md
```

> "One command: summary, timeline across terminal + agent + git, root cause,
> fix, evidence with session ids and commit hashes. The postmortem writes
> itself — from what actually happened, not from memory."

## Scene 5 — standup + privacy close (2:30–3:00)

```
blackbox standup --since 24h
```

> "And Friday standup is free."

```
grep -A2 "BEGIN BLACKBOX" ~/.zshrc && blackbox status
```

> "Everything ran on localhost: Supermemory Local for memory, Ollama for
> generation, redaction before storage. A flight recorder for your dev work —
> that never phones home."

**Cut.**

---

### Fallbacks

- Ollama slow on the day → drop `--explain`, show `rca --no-llm` (timeline is
  still the money shot) and narrate.
- Claude Code unavailable → replay the fixture instead:
  `cat test/fixtures/claude-code/session.jsonl | sed "s|{{CWD}}|$PWD|g" >> ~/.claude/projects/<munged-path>/demo.jsonl`
- Live-demo allergy → `npm run test:all` on screen is a legitimate flex: the
  whole story, asserted autonomously.
