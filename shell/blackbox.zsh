# blackbox zsh hooks — passive terminal capture.
# Pure zsh, no subprocess on the hot path (<5ms per command). Every step is
# defensive: capture must never break the prompt, even with a full disk or a
# missing spool dir.
#
# Passive mode records {command, cwd, ts, duration_ms, exit_code, session_id}.
# Output capture happens only inside `blackbox record` (BLACKBOX_RECORD=1),
# where these hooks emit sentinels instead of spool files.

[[ -n "$BLACKBOX_DISABLE" ]] && return 0

zmodload zsh/datetime 2>/dev/null || return 0

: ${BLACKBOX_HOME:="$HOME/.blackbox"}
_BB_SPOOL_TMP="$BLACKBOX_HOME/spool/tmp"
_BB_SPOOL_NEW="$BLACKBOX_HOME/spool/new"
mkdir -p "$_BB_SPOOL_TMP" "$_BB_SPOOL_NEW" 2>/dev/null || return 0

_BB_SESSION="zsh-$$-$EPOCHSECONDS"
# flashback (M8b) needs the CLI — resolved relative to this file at source time
_BB_CLI="${${(%):-%x}:A:h:h}/cli/blackbox.js"
[[ -f "$_BB_CLI" ]] || _BB_CLI=""
# noise commands skipped shell-side; the daemon applies config.ignore authoritatively
: ${BLACKBOX_IGNORE:="cd ls ll la pwd clear exit history bg fg jobs which"}

_bb_json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/}
  print -rn -- "$s"
}

# flashback (M8b): failed command → async hint from past events. The disowned
# subshell returns in ~1ms; the node side prints only on a confident match and
# is silent on every failure mode (Supermemory down, low similarity, disabled).
# 130 = SIGINT: the user aborting a command is not a failure worth a hint.
_bb_flashback() {
  [[ -z "$_BB_CLI" || -n "$BLACKBOX_NO_FLASHBACK" ]] && return 0
  (( $1 == 0 || $1 == 130 )) && return 0
  ( command node "$_BB_CLI" _flashback --exit "$1" --cwd "$PWD" -- "$2" \
      </dev/null >>"${BLACKBOX_FLASHBACK_OUT:-/dev/tty}" 2>/dev/null & ) >/dev/null 2>&1
  return 0
} 2>/dev/null

_bb_preexec() {
  [[ -z "$1" ]] && return 0
  _BB_CMD="$1"
  _BB_START="$EPOCHREALTIME"
  if [[ -n "$BLACKBOX_RECORD" ]]; then
    # record mode: emit a start sentinel (base64 dodges all escaping), then
    # erase it from the visible terminal. `script` keeps it in the typescript.
    local b64 pwd64
    b64=$(print -rn -- "$_BB_CMD" | command base64 | command tr -d '\n') 2>/dev/null
    pwd64=$(print -rn -- "$PWD" | command base64 | command tr -d '\n') 2>/dev/null
    print -rn -- $'\x1e'"BB1;S;${b64};${pwd64};${EPOCHREALTIME}"$'\x1e\n\e[1A\e[2K' 2>/dev/null
  fi
} 2>/dev/null

_bb_precmd() {
  local exit_code=$?
  [[ -z "$_BB_CMD" ]] && return 0
  local cmd="$_BB_CMD" start="$_BB_START"
  _BB_CMD="" _BB_START=""

  if [[ -n "$BLACKBOX_RECORD" ]]; then
    print -rn -- $'\x1e'"BB1;E;${exit_code};${EPOCHREALTIME}"$'\x1e\n\e[1A\e[2K' 2>/dev/null
    _bb_flashback "$exit_code" "$cmd"
    return 0
  fi

  # ignore-list check on the first word
  local first=${cmd%% *}
  local w
  for w in ${=BLACKBOX_IGNORE}; do
    [[ "$first" == "$w" ]] && return 0
  done

  local dur_ms=0
  (( dur_ms = int((EPOCHREALTIME - start) * 1000) )) 2>/dev/null
  local f="terminal-${EPOCHREALTIME/./}-$$-$RANDOM.json"
  {
    print -rn -- "{\"v\":1,\"source\":\"terminal\",\"ts_epoch\":${EPOCHREALTIME},\"session_id\":\"${_BB_SESSION}\",\"cwd\":\"$(_bb_json_escape "$PWD")\",\"command\":\"$(_bb_json_escape "$cmd")\",\"exit_code\":${exit_code},\"duration_ms\":${dur_ms}}" > "$_BB_SPOOL_TMP/$f" \
      && mv "$_BB_SPOOL_TMP/$f" "$_BB_SPOOL_NEW/$f"
  } 2>/dev/null
  _bb_flashback "$exit_code" "$cmd"
  return 0
} 2>/dev/null

autoload -Uz add-zsh-hook 2>/dev/null || return 0
add-zsh-hook preexec _bb_preexec 2>/dev/null
add-zsh-hook precmd _bb_precmd 2>/dev/null
return 0
