#!/usr/bin/env bash
# common.sh
# Sourced by every Meetless hook. Sets QUEUE_DIR, CFG, MLA_PATH; exposes
# gen_event_key + spool_append (locked) + spawn_flush.
#
# Source: notes/20260527-bare-bones-mvp-codebase-evaluation-and-plan.md §5.2.
set -euo pipefail

MEETLESS_HOME_DIR="${MEETLESS_HOME:-$HOME/.meetless}"
QUEUE_DIR="$MEETLESS_HOME_DIR/queue"
LOG_DIR="$MEETLESS_HOME_DIR/logs"
CFG="$MEETLESS_HOME_DIR/cli-config.json"
# The absolute dir this common.sh lives in. flush.sh is ALWAYS co-located with it
# (legacy: ~/.meetless/hooks/; plugin: ${CLAUDE_PLUGIN_ROOT}/hooks/), so spawn_flush
# resolves flush.sh from HERE, never from $MEETLESS_HOME_DIR (which under the plugin
# points at a ~/.meetless/hooks that need not exist). MEETLESS_HOME_DIR still roots
# the runtime state dirs (queue/logs/cli-config/session-gate) above.
MEETLESS_HOOK_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# Per-session OFF overrides. `mla mute` drops a `<sid>.off` sentinel here (cleared
# by `mla unmute`) to silence ONE live session even inside an activated folder
# (dogfooding A/B: run the same repo with capture+Push on in one session, off in
# another). This is the per-session CAPTURE lifecycle and is distinct from the
# folder's workspace BINDING, which `mla activate` / `mla deactivate` manage via
# the `.meetless.json` marker (muting never removes the marker).
SESSION_GATE_DIR="$MEETLESS_HOME_DIR/session-gate"
mkdir -p "$QUEUE_DIR"
mkdir -p "$LOG_DIR" 2>/dev/null || true

# --- Portable hook mutex -----------------------------------------------------
# All hooks contend on per-session lock files. The primitive used to be raw
# `flock` on an fd. `flock(1)` is util-linux and is ABSENT on Git Bash / MSYS
# (Windows) and on stock macOS (An's box only has it via `brew install flock`),
# so under `set -euo pipefail` a missing flock is `command not found` (127) and
# ABORTS the hook -- capture silently dies (Windows prod incident 2026-07-10,
# notes/20260710-windows-hook-wiring-and-portable-lock-fix.md).
#
# ml_lock/ml_trylock/ml_unlock take the SAME (fd, lockfile) the old flock idiom
# used, so call sites convert mechanically:
#   exec 9>"$lock"; flock 9   -> ml_lock 9 "$lock"
#   flock -n 9 || ...         -> ml_trylock 9 "$lock" || ...
#   exec 9>&-                 -> ml_unlock 9 "$lock"
# Where flock exists we defer to it (byte-for-byte the old behavior; the kernel
# releases on process death). Where it does not, we use mkdir(2): atomic on every
# filesystem, so the first `mkdir <lock>.d` wins and others spin. Deadlock is
# impossible -- a lock dir older than the stale TTL is reaped, and every blocking
# acquire steals after a bounded spin budget (our critical sections are a single
# append, so a spin-out only ever happens on a dead holder).
if command -v flock >/dev/null 2>&1; then
  MEETLESS_HAVE_FLOCK=1
else
  MEETLESS_HAVE_FLOCK=0
fi

# Blocking acquire. Always returns 0 (safe under `set -e`).
ml_lock() {
  local fd="$1" lock="$2"
  if [[ "$MEETLESS_HAVE_FLOCK" == "1" ]]; then
    eval "exec $fd>\"\$lock\""
    flock "$fd"
    return 0
  fi
  local d="$lock.d" spins=0
  while ! mkdir "$d" 2>/dev/null; do
    # Reap a lock dir left by a crashed holder (older than the stale TTL).
    if [[ -n "$(find "$d" -maxdepth 0 -mmin +2 2>/dev/null)" ]]; then
      rmdir "$d" 2>/dev/null || true
      continue
    fi
    spins=$((spins + 1))
    if (( spins > 500 )); then
      # ~10s of contention on a sub-ms critical section => the holder is dead.
      # Steal rather than block the hook forever.
      rmdir "$d" 2>/dev/null || true
      mkdir "$d" 2>/dev/null || true
      break
    fi
    sleep 0.02 2>/dev/null || sleep 1
  done
  return 0
}

# Non-blocking acquire. 0 = acquired, 1 = held by another live holder.
ml_trylock() {
  local fd="$1" lock="$2"
  if [[ "$MEETLESS_HAVE_FLOCK" == "1" ]]; then
    eval "exec $fd>\"\$lock\""
    if flock -n "$fd"; then return 0; fi
    eval "exec $fd>&-"
    return 1
  fi
  local d="$lock.d"
  if mkdir "$d" 2>/dev/null; then return 0; fi
  if [[ -n "$(find "$d" -maxdepth 0 -mmin +2 2>/dev/null)" ]]; then
    rmdir "$d" 2>/dev/null || true
    mkdir "$d" 2>/dev/null && return 0
  fi
  return 1
}

# Release. Always returns 0. Idempotent (double-release is harmless).
ml_unlock() {
  local fd="$1" lock="$2"
  if [[ "$MEETLESS_HAVE_FLOCK" == "1" ]]; then
    eval "exec $fd>&-"
    return 0
  fi
  rmdir "$lock.d" 2>/dev/null || true
  return 0
}

# Meetless-branded observability log. The hook pipeline is otherwise a black
# box (spawn_flush detaches flush.sh to a background process), so without this
# there is no way to watch the spool -> control -> finalize hops live. Every
# line is prefixed `[Meetless]` so it is unmistakable in a shared terminal.
# Writes to both a per-session file and a combined flush.log so a single
# `tail -f ~/.meetless/logs/flush.log` follows every session. When stderr is a
# TTY (interactive `mla flush`) it also echoes inline. Default-on; opt out with
# MEETLESS_DEBUG=0. Always returns 0 so it is safe under `set -euo pipefail`.
log() {
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then return 0; fi
  local sid="${SESSION_ID:-unknown}"
  local short="${sid:0:8}"
  local line
  line="[Meetless] $(date '+%H:%M:%S') flush[$short] $*"
  printf '%s\n' "$line" >> "$LOG_DIR/flush-$sid.log" 2>/dev/null || true
  printf '%s\n' "$line" >> "$LOG_DIR/flush.log" 2>/dev/null || true
  if [[ -t 2 ]]; then printf '%s\n' "$line" >&2 || true; fi
  return 0
}

# Path of the per-session throttle stamp for capture-auth warnings. Kept in
# LOG_DIR (not QUEUE_DIR) so the queue reaper never has to know about it and the
# spool sweep stays purely about queued events. Single argument: the session id.
capture_auth_warn_file() {
  printf '%s/capture-auth-%s.warn' "$LOG_DIR" "$1"
}

# T1.5 fail-soft (folder = workspace, notes/20260604-folder-equals-workspace-
# binding-design.md "Hook failure behavior (fail soft)"): a capture write got an
# auth/visibility rejection (401 / 403 / 404). Capture is assistive and must
# NEVER break the session, so the detached flusher records a THROTTLED, human-
# readable local warning and keeps the queued events for a later retry. A 403
# here is usually the transient "committed marker, token not yet a workspace
# member" onboarding state, which clears the moment an owner adds you; warning on
# every turn would be noise, so we re-warn at most once per
# MEETLESS_AUTH_WARN_THROTTLE_SECS (default 3600), gated on a persisted timestamp
# so the throttle survives across the short-lived flusher processes. Warnings are
# appended to logs/capture-auth-warnings.log (and the live flush.log via log()).
# Args: <session-id> <http-code> <endpoint>. ALWAYS returns 0 (safe under set -e).
warn_capture_auth() {
  local sid="$1" code="$2" endpoint="$3"
  local throttle="${MEETLESS_AUTH_WARN_THROTTLE_SECS:-3600}"
  local warn_file now last age
  warn_file="$(capture_auth_warn_file "$sid")"
  now="$(date +%s 2>/dev/null || echo 0)"
  if [[ -f "$warn_file" ]]; then
    last="$(head -n1 "$warn_file" 2>/dev/null || echo 0)"
    [[ "$last" =~ ^[0-9]+$ ]] || last=0
    age=$(( now - last ))
    # Re-warned within the window: stay quiet this turn (but still fail-soft).
    if (( age < throttle )); then return 0; fi
  fi
  printf '%s\n' "$now" > "$warn_file" 2>/dev/null || true

  local ws="${WORKSPACE_ID:-}"
  # Recovery for a 401 depends on HOW this CLI authenticated. A `user-token`
  # session (browser OAuth via `mla login`) re-authenticates with `mla login`;
  # telling it to run `mla init --control-token` is wrong twice over -- it points
  # at the SHARED-KEY path, and readConfig() now hard-errors if a control token is
  # layered over a logged-in session. A `shared-key` session (CI / headless) is
  # correctly told to refresh that key. Unknown / no config falls back to the
  # shared-key advice (the historical default). Read it fail-soft.
  local auth_mode=""
  auth_mode="$(jq -r '.auth.mode // empty' "$CFG" 2>/dev/null || true)"
  local msg
  case "$code" in
    401)
      if [[ "$auth_mode" == "user-token" ]]; then
        msg="capture paused: your Meetless login expired or was revoked (HTTP 401). Run \`mla login\` to re-authenticate. Queued events are kept and will retry."
      else
        msg="capture paused: control rejected the token (HTTP 401, invalid or expired). Run \`mla init --control-token <token>\` to refresh. Queued events are kept and will retry."
      fi
      ;;
    403)
      # The guard 403s for two distinct reasons on a capture write, and they need
      # different remedies. When flush.sh resolved no actor (ACTOR_USER_ID empty),
      # it omitted the X-Meetless-Actor header and control rejected for missing
      # actor identity (a client-side cli-config gap, NOT a membership gap). When
      # an actor WAS sent, the 403 means that actor is not a provisioned member of
      # the workspace. Blaming membership in the first case sends the operator
      # chasing a ghost, so distinguish them.
      if [[ -z "${ACTOR_USER_ID:-}" ]]; then
        msg="capture paused: the CLI sent no actor identity for workspace ${ws:-<unknown>} (HTTP 403). Set actorUserId in ~/.meetless/cli-config.json (run \`mla init\` or \`mla activate\`). Queued events are kept and will retry."
      else
        msg="capture paused: actor ${ACTOR_USER_ID} is not a member of workspace ${ws:-<unknown>} (HTTP 403). Run \`mla activate\` (or ask a workspace owner to add you). Queued events are kept and will retry once you are a member."
      fi
      ;;
    404)
      msg="capture paused: workspace ${ws:-<unknown>} was not found on control (HTTP 404). The marker may point at a deleted workspace; run \`mla doctor\` or \`mla activate --repair\`. Queued events are kept."
      ;;
    *)
      msg="capture paused: control returned HTTP $code on $endpoint. Queued events are kept and will retry."
      ;;
  esac
  log "WARN $msg"
  printf '[Meetless] %s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || echo unknown)" "$msg" \
    >> "$LOG_DIR/capture-auth-warnings.log" 2>/dev/null || true
  return 0
}

# Correction 7: absolute path resolved at install time; mla in PATH is NOT relied on.
MLA_PATH="$(jq -r '.mlaPath // empty' "$CFG" 2>/dev/null || true)"
if [[ -z "${MLA_PATH:-}" || ! -x "$MLA_PATH" ]]; then
  MLA_PATH="$(command -v mla 2>/dev/null || true)"
fi

# T1.2 hard cutover (folder = workspace): the marker is the ONLY source of the
# workspaceId. WORKSPACE_ID starts empty and is set by meetless_activated() from
# the resolved .meetless.json; the cli-config workspaceId is no longer read here.
# The four capture hooks call meetless_activated (which fills this in) before they
# spool, so it is populated by the time flush.sh wraps lines into Nest DTO shape
# ({workspaceId, ...}). The nohup-detached flusher cannot walk up to the marker
# (cwd=$HOME), so it sources WORKSPACE_ID from the per-session .workspaceId sidecar
# written at session start. Empty string => spool + skip rather than POST a 400.
WORKSPACE_ID=""

# Bash twin of canonicalizeSessionId (TS) / canonicalize_agent_session_id
# (Python). ONE shared grammar across all three languages so the same Claude
# session UUID never canonicalizes to two strings and splits the Langfuse
# Session. Pure: trim leading/trailing whitespace, match the canonical dashed
# UUID (case-insensitive, ANCHORED), lowercase; on no match print nothing (empty
# => "no agent session"). The anchored match is the header-injection guard: any
# newline, leftover whitespace, or stray byte after trim fails the match, so the
# value is safe to hand to a `curl -H` header (validate BEFORE -H, per the spec).
# The regex is stored in a var and referenced UNQUOTED so bash 3.2's `=~` treats
# it as a pattern, not a literal.
canonicalize_agent_session_id() {
  local raw="${1:-}"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  raw="${raw%"${raw##*[![:space:]]}"}"
  local re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  if [[ "$raw" =~ $re ]]; then
    printf '%s' "$raw" | tr '[:upper:]' '[:lower:]'
  fi
}

# Smaller-B: uuidgen preferred, openssl rand -hex 16 fallback. Stable per logical event.
gen_event_key() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
  else
    openssl rand -hex 16
  fi
}

# Resolve the live session name from a Claude Code transcript so the console
# Sessions page shows the same name the operator sees in the local picker.
#
# The tool records the name on TWO line types and the picker shows them with a
# fixed precedence: a human title set via /title (`custom-title`) wins, and
# otherwise the auto-titler's name (`ai-title`) is shown. The auto title is the
# COMMON case -- most sessions are never manually renamed -- so grepping only
# `custom-title` (the historical behavior) left those sessions untitled in
# control, which then fell back to the raw first prompt or "Session <id>" and
# diverged from the picker. We mirror the picker: latest custom-title if any,
# else latest ai-title. Either grep scans only the small title lines (~5ms on a
# 6k-line transcript), well inside the <1s Stop budget. Fail-soft: a missing
# transcript or any error yields an empty title and control's last-write-wins,
# no-clobber-on-empty rule leaves any prior title untouched.
resolve_session_title() {
  local transcript="$1"
  [[ -n "$transcript" && -f "$transcript" ]] || { printf ''; return 0; }
  local title=""
  title="$(grep '"type":"custom-title"' "$transcript" 2>/dev/null \
    | tail -n 1 \
    | jq -r 'try (.customTitle // empty) catch empty' 2>/dev/null || true)"
  if [[ -z "$title" ]]; then
    title="$(grep '"type":"ai-title"' "$transcript" 2>/dev/null \
      | tail -n 1 \
      | jq -r 'try (.aiTitle // empty) catch empty' 2>/dev/null || true)"
  fi
  printf '%s' "$title"
}

# I1 (interception): best-effort snapshot of the files the agent is about to
# touch, sourced from the git working-tree delta at prompt-submit time. This is
# literally "the surfaces the agent is actually modifying" (spec §I1: enrich must
# seed retrieval from the touched-file SET, not from the prompt's phrasing), and
# it picks up Bash-driven edits too, which keeps us inside the v0 Bash-only
# capture boundary (Edit/Write tool I/O is out of scope until the rejected
# --unsafe-capture-non-bash ships in v0.1).
#
# Emits a compact JSON array of paths on stdout (e.g. ["a.ts","b.ts"]), deduped
# and bounded to MEETLESS_TOUCHED_FILES_MAX (default 50). ALWAYS returns 0 and
# prints "[]" on any failure (no git binary, not a repo, empty repo with no HEAD,
# detached worktree). An empty result is the compat-6.2 signal: callers OMIT the
# field entirely, so retrieval falls back to today's prompt-only behavior.
#
# Deliberately does NOT emit a structured proposed_action. At UserPromptSubmit
# there is no concrete pending action to describe; that field is reserved for a
# future PreToolUse interception surface. touched_files are ranking hints only
# (spec I-SEC-1) and never widen ACL (I-SEC-3); intel treats them as such.
collect_touched_files() {
  local dir="${1:-$PWD}"
  local max="${MEETLESS_TOUCHED_FILES_MAX:-50}"
  command -v git >/dev/null 2>&1 || { printf '[]'; return 0; }
  command -v jq >/dev/null 2>&1 || { printf '[]'; return 0; }
  git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '[]'; return 0; }
  # Tracked changes vs HEAD (staged + unstaged) plus untracked-but-not-ignored
  # files. Two clean newline-separated path lists, no porcelain status prefix and
  # no rename arrows to parse. Each command is independently best-effort: a fresh
  # repo with no HEAD makes `diff HEAD` fail, but ls-files still contributes.
  local files
  files="$(
    {
      git -C "$dir" diff --name-only HEAD 2>/dev/null
      git -C "$dir" ls-files --others --exclude-standard 2>/dev/null
    } | awk 'NF' | sort -u | head -n "$max"
  )"
  [[ -z "$files" ]] && { printf '[]'; return 0; }
  printf '%s' "$files" | jq -R -s -c 'split("\n") | map(select(length > 0))' 2>/dev/null || printf '[]'
  return 0
}

# Per-folder activation gate (opt-in). Modeled on how Claude Code discovers
# CLAUDE.md: walk UP from the start dir (default $PWD) looking for the nearest
# `.meetless.json` marker, nearest-wins. A session is captured ONLY when a
# marker is found. Without one, the capture hooks `exit 0` before spooling, so
# Meetless stays dormant in every folder the operator has not explicitly
# activated with `mla activate`.
#
# CALLED ONLY by the four CAPTURE hooks (session-start, user-prompt-submit,
# post-tool-use, stop), which Claude Code fires with cwd = the session's launch
# dir. It MUST NOT be called from flush.sh: the flusher is nohup-detached and
# inherits cwd=$HOME, so a walk-up there would always miss the repo marker and
# wrongly suppress an already-queued session.
#
# On success: returns 0 and sets MEETLESS_MARKER_FILE (absolute path) plus
# MEETLESS_MARKER_WORKSPACE_ID (optional workspaceId parsed from the marker;
# empty when absent or unparseable). T1.2 cutover: it ALSO sets WORKSPACE_ID to
# the marker's workspaceId so the capture path POSTs under the marker id, never
# the cli-config one. On miss: returns 1 and leaves all three vars empty (no
# cli-config fallback), so the capturing hook exits 0 before spooling.
meetless_activated() {
  local dir="${1:-$PWD}"
  MEETLESS_MARKER_FILE=""
  MEETLESS_MARKER_WORKSPACE_ID=""
  WORKSPACE_ID=""
  # Canonicalize so the walk terminates at "/" deterministically even when the
  # hook was fired with a relative or symlinked cwd.
  dir="$(cd "$dir" 2>/dev/null && pwd || true)"
  [[ -z "$dir" ]] && return 1
  while :; do
    if [[ -f "$dir/.meetless.json" ]]; then
      MEETLESS_MARKER_FILE="$dir/.meetless.json"
      MEETLESS_MARKER_WORKSPACE_ID="$(jq -r '.workspaceId // empty' "$MEETLESS_MARKER_FILE" 2>/dev/null || true)"
      WORKSPACE_ID="$MEETLESS_MARKER_WORKSPACE_ID"
      return 0
    fi
    [[ "$dir" == "/" ]] && break
    dir="$(dirname "$dir")"
  done
  return 1
}

# Per-session OFF override. Returns 0 (disabled) when a `<sid>.off` sentinel
# exists in SESSION_GATE_DIR, written by `mla mute` (cleared by `mla unmute`) for
# this exact live session. Lets the operator silence ONE session (capture AND
# Push) even inside an activated folder, without un-activating the folder for
# every other session. Distinct from `mla deactivate`, which removes the folder's
# `.meetless.json` binding for all sessions.
# Existence check only (no jq parse) so it stays cheap on the hook hot path.
#
# CALLED ONLY by the four CAPTURE hooks, and ONLY AFTER SESSION_ID has been
# parsed from stdin (the per-folder gate runs first, before stdin is read). A
# missing or empty sid is treated as "not disabled" (the empty-sid guard in each
# hook has already exited 0 by then).
meetless_session_disabled() {
  local sid="$1"
  [[ -n "$sid" && -f "$SESSION_GATE_DIR/$sid.off" ]]
}

# Correction 5: append-under-lock. ALL writers + flusher contend for the same
# lock file ($QUEUE_DIR/$SESSION_ID.lock) via ml_lock (flock or mkdir mutex).
spool_append() {
  local session_id="$1"
  local line="$2"
  local lock="$QUEUE_DIR/$session_id.lock"
  local queue="$QUEUE_DIR/$session_id.jsonl"
  ml_lock 9 "$lock"
  printf '%s\n' "$line" >> "$queue"
  ml_unlock 9 "$lock"
}

# Monotonic per-session turn counter. Returns (echoes) the next 1-based index
# for this session and persists it, under the SAME per-session lock spool_append
# uses so it cannot race a concurrent writer. user-prompt-submit.sh stamps the
# returned value as turn_index on the enrichment trace line, giving every trace
# a dense, ordered position within its session (turn 1, 2, 3...) without parsing
# timestamps. A corrupt or missing counter file is treated as 0 (next = 1).
next_turn_index() {
  local session_id="$1"
  local lock="$QUEUE_DIR/$session_id.lock"
  local counter="$QUEUE_DIR/$session_id.turn"
  local n
  ml_lock 9 "$lock"
  n="$(cat "$counter" 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  n=$((n + 1))
  printf '%s' "$n" > "$counter"
  ml_unlock 9 "$lock"
  printf '%s' "$n"
}

# Read-only peek at the per-session turn counter. Echoes the CURRENT 1-based
# index without advancing it, under the same per-session lock so it never reads
# a half-written value. next_turn_index is bumped exactly once per
# UserPromptSubmit, so during a turn's tool calls the counter holds that turn's
# index; post-tool-use.sh uses this to attribute the agent's own MCP calls
# (mcp-calls.jsonl) to the turn we enriched, giving A1 its (session_id,
# turn_index) join key against ask-traces.jsonl. A corrupt or missing counter
# (no UserPromptSubmit seen yet) reads as 0.
current_turn_index() {
  local session_id="$1"
  local lock="$QUEUE_DIR/$session_id.lock"
  local counter="$QUEUE_DIR/$session_id.turn"
  local n
  ml_lock 9 "$lock"
  n="$(cat "$counter" 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  ml_unlock 9 "$lock"
  printf '%s' "$n"
}

# Minimal NOT_RUN liveness trace, written at a deliberate early exit where mla did
# NOT run a real agent turn (today: a muted session, `mla mute`). The per-turn
# assist recap (turn-recap.ts) and `mla turn N` join on (session_id, turn_index);
# without this line a muted turn is an unexplained GAP, indistinguishable from a
# crash, a timeout, or the session simply ending. So we record exactly one line
# that says WHY mla was silent: it PEEKS the per-session turn counter (the agent
# DID take this turn; the counter was already advanced once at UserPromptSubmit
# entry per governed-story §4.2) and stamps not_run_reason + injected=false, with NO prompt
# body. The line is LOCAL-only (never spooled, never forwarded to control/intel) and
# shares write_trace's ask-traces.lock so it can never interleave with a full trace.
# Fully fail-soft: every step is guarded and it always returns 0, so it can never
# block the prompt. Args: <session-id> <not_run_reason>, where reason is one of the
# NotRunReason enum (muted | not_activated | suppressed | timeout | error).
write_not_run_trace() {
  local sid="$1" reason="$2"
  [[ -n "$sid" && -n "$reason" ]] || return 0
  local ts trace_id turn_index surface line
  ts="$(date -u +%FT%TZ 2>/dev/null || printf '')"
  trace_id="$(gen_event_key 2>/dev/null | tr -d '-' | tr 'A-F' 'a-f')" || trace_id=""
  turn_index="$(current_turn_index "$sid" 2>/dev/null || printf 0)"
  [[ "$turn_index" =~ ^[0-9]+$ ]] || turn_index=0
  surface="${MEETLESS_INTERCEPT_SURFACE:-cli_intercept}"
  line="$(jq -c -n \
    --arg trace_id "$trace_id" \
    --arg ts "$ts" \
    --arg surface "$surface" \
    --arg session_id "$sid" \
    --argjson turn_index "$turn_index" \
    --arg workspace_id "${WORKSPACE_ID:-}" \
    --arg reason "$reason" \
    '{
      trace_id: $trace_id, ts: $ts, surface: $surface, mode: "not_run",
      session_id: $session_id, turn_index: $turn_index,
      workspace_id: $workspace_id,
      input: null, enrichment: null,
      hook: {injected: false, layer2_injected: false, not_run_reason: $reason},
      error: null
    }' 2>/dev/null || printf '')"
  [[ -n "$line" ]] || return 0
  (
    ml_lock 8 "$LOG_DIR/ask-traces.lock"
    printf '%s\n' "$line" >> "$LOG_DIR/ask-traces.jsonl"
    ml_unlock 8 "$LOG_DIR/ask-traces.lock"
  ) 2>/dev/null || true
  return 0
}

# DUR (§5.4 DURING) coordination state. When the BEFORE-turn hook promotes an
# inject to an imperative coordination reminder it persists the validated triggers
# here, keyed on the turn index it just advanced. The PostToolUse hook reads the
# same path to raise a just-in-time flag when the agent edits a governed surface,
# and records flagged surfaces (one per line) so it never re-flags the same surface
# in a session. Co-located under logs/ so both hooks resolve the identical path.
coordination_dir() { printf '%s/coordination' "$LOG_DIR"; }
coordination_state_file() { printf '%s/coordination/%s.json' "$LOG_DIR" "$1"; }
coordination_flagged_file() { printf '%s/coordination/%s.flagged' "$LOG_DIR" "$1"; }

# A-0c (A4 surface 2) governance-nudge state. The pending-count cache is the
# out-of-band hand-off the `mla kb pending` CLI writes (it already knows the count
# from the list it just fetched) and the prompt-submit hook reads with NO network
# call (Patch 8: the count must not add a synchronous hot-path round trip). Keyed by
# workspace so a repointed home never reads a stale cross-workspace count; the CLI
# sanitizes the workspace id the SAME way (governance-cache.ts) so both sides
# resolve the identical filename. The inject-state is keyed by session so a fresh
# session re-shows the prose form once. Co-located under logs/ so they share the
# root the CLI computes from MEETLESS_HOME.
governance_dir() { printf '%s/governance' "$LOG_DIR"; }
governance_count_file() {
  local ws_safe; ws_safe="$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_')"
  printf '%s/governance/pending-count-%s.json' "$LOG_DIR" "$ws_safe"
}
governance_inject_file() { printf '%s/governance/inject-%s.json' "$LOG_DIR" "$1"; }

# Cross-session steer transport (Plan 1, conflict-resolution loop). The cache is
# the out-of-band hand-off `mla _internal steer-sync` writes (pulled steers) and
# the prompt-submit hook reads with NO network call. The inject-state is written
# by the hook (the steer ids it injected, one session) and read back by steer-sync
# to mark them injected. Both keyed by session id (opaque CLAUDE_CODE_SESSION_ID, used
# verbatim like governance_inject_file). Co-located under logs/ so the CLI
# (steer-cache.ts) and these resolve the identical paths under MEETLESS_HOME.
steer_dir() { printf '%s/steer' "$LOG_DIR"; }
steer_cache_file() { printf '%s/steer/steer-%s.json' "$LOG_DIR" "$1"; }
steer_inject_file() { printf '%s/steer/inject-%s.json' "$LOG_DIR" "$1"; }

# (The regime-1 first-run pack and its per-session inject-state are RETIRED:
# targeted-rule-injection §Phase 2 moved rule delivery to the per-turn assemble-context head,
# so there is no once-per-session bulk block to gate anymore.)

# The closed CoordinationTrigger enum (§5.4.1). Both hooks hard-filter to this set
# so a malformed or injected trigger type can never manufacture an escalation.
COORDINATION_TRIGGER_ENUM='["GOVERNED_SURFACE_TOUCHED","ACCEPTED_DECISION_APPLIES","OPEN_COORDINATION_CASE","OWNER_APPROVAL_REQUIRED","BLAST_RADIUS_EDGE","CONTRADICTION_RISK","SUPERSESSION_RISK"]'

# Shared citation / source_id extractor (P3). Pulls every evidence token out of
# arbitrary text and echoes them as a sorted, de-duplicated JSON array (never a
# bare value; no match -> []). The token grammar mirrors intel's
# citation_validator: DD / TH / NT (decision-diff / theme / note) plus the
# CC|PP|PT|RC|WA|AU|DM operation tokens. Both bracketed `[NT:id]` and bare
# `NT:id` forms match. Used by post-tool-use.sh (the source_ids the agent PULLED)
# and stop.sh (the source_ids the agent's final report CITED) so the pull side
# and the push-reference side share one grammar. The grep can match zero (rc 1
# under pipefail); `|| true` keeps that from aborting the caller's `set -e`.
extract_source_ids() {
  local text="$1"
  local ids
  ids="$(printf '%s' "$text" \
    | grep -oE '(DD|TH|NT|CC|PP|PT|RC|WA|AU|DM):[A-Za-z0-9_.-]+' \
    | sort -u \
    | jq -R -s -c 'split("\n") | map(select(length > 0))' || true)"
  [[ -z "$ids" ]] && ids="[]"
  printf '%s' "$ids"
}

# classify_mcp_outcome: read a full PostToolUse hook INPUT json on stdin, print
# the honest three-valued outcome of a meetless MCP call: success | error |
# unknown (governed-story §3.3; NEVER inferred from "PostToolUse fired").
#
# OBSERVED Claude Code shape (verified 2026-07-11 by dumping raw hook input):
#   - SUCCESS: tool_response is the UNWRAPPED MCP content-block ARRAY
#     ([{type:"text",text:"{...}"}]) with NO isError anywhere. The earlier
#     classifier only matched a {content,isError} OBJECT, so every array-shaped
#     success fell through to "unknown" and under-counted governed pulls.
#   - ERROR: Claude Code marks the tool_result is_error:true but does NOT fire
#     PostToolUse at all, so an errored pull never reaches this hook (absent, not
#     mislabeled). We still classify defensively below in case CC re-wraps later.
#
# Classifier, most-specific first: object+isError:true -> error; object+content
# -> success (legacy wrap, kept defensively); a non-empty array is a completed
# pull -> success, but we cheaply probe its first text block: if that block parses
# as JSON carrying an `error` key or a `status >= 400` (the meetless MCP server's
# own error envelope) -> error, so we stay honest if CC ever fires PostToolUse on
# MCP errors. Only key PRESENCE / the numeric status is read; NO raw error text
# leaves the machine. Empty array / null / scalar / missing -> unknown.
#
# Kept here (not inline in post-tool-use.sh) so the hook and its regression test
# (test/hooks/mcp-outcome-classify-bash.spec.ts) drive the SAME grammar and cannot
# drift; the exact trap that let the array-shape bug ship silently.
classify_mcp_outcome() {
  local out
  out="$(jq -r '
    (.tool_response // .tool_result) as $r
    | if ($r | type) == "object" and ($r.isError == true) then "error"
      elif ($r | type) == "object" and ($r | has("content")) then "success"
      elif ($r | type) == "array" and ($r | length) > 0 then
        (($r[0].text // "") | (try fromjson catch null)) as $body
        | if ($body | type) == "object"
            and (($body.error != null) or (($body.status // 0) >= 400))
          then "error" else "success" end
      else "unknown" end' 2>/dev/null || printf 'unknown')"
  case "$out" in
    success|error|unknown) printf '%s' "$out" ;;
    *) printf 'unknown' ;;
  esac
}

# A5 relevance-persistence ("carry ONCE"). P2 verified the prior trace line is
# only written, never read into enrich at turn N+1, and that intel cannot read it
# (two-DSN; the trace lives on this machine). So the carry read is HOOK-SIDE,
# mirroring the P1/P3 local-first precedent (see
# notes/20260604-p2-prior-trace-read-verification.md).
#
# read_prior_carry_state echoes the carry state distilled from this session's
# immediately-prior ask-traces.jsonl line:
#   {"prior_carry": {<source_id>: <carry_count>, ...}, "harmful": <bool>}
# prior_carry merges (a) what we INJECTED last turn at carry_count 0
# (enrichment.context_items[] with injected==true and a non-empty source_id) with
# (b) what we already CARRIED last turn at its stamped carry_count
# (carry_forward.carried[]); a carried entry wins over an injected one for the
# same source_id, so an item that was carried once reads back as carry_count 1 and
# the once-only decay drops it. harmful is true when the operator rated last turn
# harmful, which suppresses every carry regardless of relevance (§7.4 A5 case 3).
# Best-effort and lock-free: a tail-read may clip the final partial line, but
# fromjson? drops it and we take the latest COMPLETE line by turn_index. A missing
# file or no matching line reads as the empty, not-harmful state.
read_prior_carry_state() {
  local session_id="$1"
  local f="$LOG_DIR/ask-traces.jsonl"
  local state
  state="$(tail -n 500 "$f" 2>/dev/null \
    | jq -R -s -c --arg sid "$session_id" '
        ( split("\n")
          | map(select(length > 0) | fromjson?)
          | map(select(.session_id == $sid))
          | sort_by(.turn_index // 0)
          | last
        ) as $prior
        | if $prior == null then {prior_carry: {}, harmful: false}
          else
            ( ($prior.enrichment.context_items // [])
              | map(select((.injected == true) and ((.source_id // "") != ""))
                    | {key: .source_id, value: 0})
              | from_entries
            ) as $inj
            | ( ($prior.carry_forward.carried // [])
                | map({key: .source_id, value: .carry_count})
                | from_entries
              ) as $car
            | {prior_carry: ($inj + $car), harmful: ($prior.operator_label.harmful == true)}
          end
      ' 2>/dev/null || true)"
  [[ -z "$state" ]] && state='{"prior_carry":{},"harmful":false}'
  printf '%s' "$state"
}

# A5 carry computation (pure). Given the prior carry state (read_prior_carry_state
# output) and THIS turn's enrichment object, echoes the carry list as a JSON array
# [{"source_id": ..., "carry_count": 1}, ...]: the prior-injected, not-yet-carried
# (carry_count == 0), still-surfaced items, stamped carry_count 1. "Still
# surfaced" = present in this turn's enrichment.context_items with a source_id, so
# a topic shift (no overlap) carries nothing. A harmful prior turn carries nothing.
# Empty array on any error so the caller's set -e is never tripped.
compute_carry() {
  local state="$1" enrichment="$2"
  jq -c -n --argjson state "$state" --argjson enr "$enrichment" '
    ($state.prior_carry // {}) as $pc
    | (($state.harmful // false) == true) as $harm
    | ( [ ($enr.context_items // [])[]
          | select((.source_id // "") != "")
          | .source_id ]
        | unique ) as $cur
    | [ $cur[]
        | select(($pc[.] != null) and ($harm | not) and ($pc[.] == 0))
        | {source_id: ., carry_count: 1} ]
  ' 2>/dev/null || printf '[]'
}

# Detached background flush. Hook process exits immediately. When debug logging
# is on, the detached flush's stdout+stderr are appended to its per-session log
# so stray curl/jq errors and any `set -e` abort are captured alongside the
# branded log() lines (which go to the file directly, not via stdout).
spawn_flush() {
  local session_id="$1"
  # Defense in depth for the workspace sidecar (prod session 11436b5c). flush.sh
  # is nohup-detached with cwd=$HOME and CANNOT walk up to the .meetless.json
  # marker, so $QUEUE_DIR/<sid>.workspaceId is its ONLY workspace source; with no
  # sidecar it resolves an empty workspace and exits before POSTing anything.
  # session-start.sh writes that sidecar, but SessionStart fires only on
  # startup/resume/clear/compact, NEVER on a plain next turn, and not at all
  # when a folder is activated mid-session (`mla activate` after the session
  # began). Every capture hook runs `meetless_activated` (which sets the global
  # WORKSPACE_ID) before reaching here, so re-assert the sidecar from that id
  # whenever it is resolved and the sidecar is missing/empty. This heals both the
  # mid-session-activation gap and any turn whose sidecar went missing. We never
  # overwrite a good sidecar; session-start.sh's value is identical anyway.
  if [[ -n "${WORKSPACE_ID:-}" && -n "${session_id:-}" && ! -s "$QUEUE_DIR/$session_id.workspaceId" ]]; then
    printf '%s' "$WORKSPACE_ID" > "$QUEUE_DIR/$session_id.workspaceId" 2>/dev/null || true
  fi
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MEETLESS_HOOK_SCRIPT_DIR/flush.sh" "$session_id" >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MEETLESS_HOOK_SCRIPT_DIR/flush.sh" "$session_id" >>"$LOG_DIR/flush-$session_id.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# F3-B throttled mid-turn liveness heartbeat. PostToolUse spools tool events but
# historically never flushed them, so a long, tool-heavy turn (many tool calls
# spanning >5min between the prompt-submit flush and the Stop flush) left
# control's lastSeenAt pinned at turn start and deriveLiveness aged the session
# into IDLE while it was actively working. Calling this at the top of PostToolUse
# fires a detached flush at most once per MEETLESS_HEARTBEAT_THROTTLE_SECS
# (default 60) per session, draining the events already queued this turn so
# lastSeenAt keeps advancing. It spools NO new event -- a Read/Grep turn still
# spools nothing; this is purely a periodic drain of the existing spool. Throttle
# state is a per-session epoch sidecar ($QUEUE_DIR/<sid>.hb) guarded by the same
# fd-9 ml_lock idiom spool_append uses, so concurrent fires cannot double-flush.
# Fail-soft and always returns 0 so it can never block the tool under `set -e`.
heartbeat_flush() {
  local session_id="$1"
  [[ -n "$session_id" ]] || return 0
  local throttle="${MEETLESS_HEARTBEAT_THROTTLE_SECS:-60}"
  [[ "$throttle" =~ ^[0-9]+$ ]] || throttle=60
  local hb="$QUEUE_DIR/$session_id.hb"
  local lock="$QUEUE_DIR/$session_id.hb.lock"
  local now last fire
  now="$(date +%s 2>/dev/null || echo 0)"
  [[ "$now" =~ ^[0-9]+$ ]] || now=0
  fire=0
  ml_lock 9 "$lock"
  last="$(cat "$hb" 2>/dev/null || echo 0)"
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  if (( now - last >= throttle )); then
    printf '%s' "$now" > "$hb"
    fire=1
  fi
  ml_unlock 9 "$lock"
  if (( fire == 1 )); then
    spawn_flush "$session_id"
  fi
  return 0
}

# ---- Active Review (Zone 1) helpers -------------------------------------
# Allowlist of prose extensions Zone 1 may capture; everything else (code,
# vendored trees, build output) is ignored. Denylist takes precedence.
# Spec tests 1 (code ignored) and 2 (node_modules ignored).
prose_path_allowed() {
  local p="$1"
  case "$p" in
    */node_modules/*|node_modules/*|*/.git/*|.git/*|*/dist/*|dist/*|*/build/*|build/*|*/.next/*|.next/*|*/vendor/*|vendor/*) return 1 ;;
  esac
  # Synthetic eval/fixture/testdata prose is corpus material, never knowledge.
  # Dogfood incident 2026-06-10: authoring an eval corpus (evals/*/corpus/*.md)
  # got every fixture captured as a produced_doc and auto-indexed into the
  # owner's Personal KB as SHADOW docs, minting bogus relationship candidates.
  # Directory-segment match only, so a doc NAMED "...-eval-results.md" stays in.
  case "$p" in
    */evals/*|evals/*|*/fixtures/*|fixtures/*|*/__fixtures__/*|__fixtures__/*|*/testdata/*|testdata/*) return 1 ;;
  esac
  case "$p" in
    *.md|*.markdown|*.mdx|*.rst|*.txt|*.adoc) return 0 ;;
    *) return 1 ;;
  esac
}

# storyCategory for a Bash command (governed-story §5.3 / acceptance #24). The
# session-detail body shows the agent's mla CLI commands and hides generic bash;
# this stamps the bucket at CAPTURE so the console never parses argv in React.
# Returns "mla_cli" iff the RESOLVED command word is exactly `mla`: we skip any
# leading ENV=VAL assignments (FOO=bar mla ...) and strip a path prefix
# (/usr/local/bin/mla, ./mla) before comparing. A bare `mla` substring INSIDE an
# argument never matches (echo mla, cat notes/mla.md, git commit -m "update mla",
# the command `mlathing`), so the first real command word alone decides. Anything
# else is "other". An exec-wrapper prefix (sudo mla, env mla, time mla, xargs mla)
# is deliberately NOT peeled: the first real word is the wrapper, so the command
# falls to "other" and the governed story simply hides it. That is a leak-free
# conservative miss (a wrapped mla call is render-hidden, never mislabeled or
# leaked) for a path an agent effectively never takes, since the hook and the
# agent both invoke `mla` directly. This is the single tested classifier; no UI
# re-derivation.
story_category_for_command() {
  # Empty / whitespace-only command never reaches awk's per-record body (zero
  # records -> no output); classify it explicitly so the caller always gets a
  # value. An empty command is not `mla`, so it is "other".
  [[ -z "${1// }" ]] && { printf 'other'; return 0; }
  # NR==1 + exit: only the FIRST line decides, and awk emits exactly one token.
  # The old rule had no record guard, so a multi-line command (heredoc, && chains)
  # ran the body per line and printed one token PER line -- e.g. a command that
  # starts with `mla` produced "mla_cli\nother\nother...", which the console's
  # `storyCategory === 'mla_cli'` bucket then failed to match, wrongly hiding a
  # real mla call. The first real word of line 1 is the command; that alone decides.
  printf '%s' "$1" | awk 'NR==1 {
    cat = "other"
    for (i = 1; i <= NF; i++) {
      tok = $i
      if (tok ~ /^[A-Za-z_][A-Za-z0-9_]*=/) continue   # leading env assignment
      n = split(tok, parts, "/")                         # strip any path prefix
      if (parts[n] == "mla") cat = "mla_cli"
      break                                              # first real word decides
    }
    print cat
    exit
  }'
}

# storyCategory for a file path (governed-story §5.3). Reuses prose_path_allowed
# so "markdown" means exactly the one prose allowlist the rest of the hook uses
# (.md/.markdown/.mdx/.rst/.txt/.adoc, minus vendored/eval/fixture dirs). Code
# paths and anything non-prose are "other"; the console hides them.
story_category_for_path() {
  if prose_path_allowed "$1"; then printf 'markdown'; else printf 'other'; fi
}

# A3 tagged_reference capture (Zone 1). Echoes the set of doc paths a user prompt
# NAMES, one per line, de-duplicated. Pure text scan: pulls every filename token
# ending in a prose extension (the same allowlist prose_path_allowed uses). This
# is the read side of A3: the UserPromptSubmit hook records each named path as a
# tagged_reference Active Memory record so Layer 3 can later join it against
# approved supersession/contradiction facts. The token grammar [A-Za-z0-9_./-]
# excludes quotes, backticks, and parentheses, so `old.md`, "old.md", and
# (old.md) all yield the clean token old.md without extra trimming. The grep can
# match zero (rc 1 under pipefail); `|| true` keeps that from aborting the caller.
extract_referenced_doc_paths() {
  local text="$1"
  printf '%s' "$text" \
    | grep -oE '[A-Za-z0-9_./-]+\.(md|markdown|mdx|rst|txt|adoc)' \
    | sort -u \
    || true
}

# Stable hash of the repo root absolute path. Distinct roots -> distinct hashes,
# which keeps same-named docs in different repos from deduping (spec test 5).
repo_root_hash() {
  printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
}

# Path relative to the repo root (portable; macOS lacks GNU realpath --relative-to).
canonical_path() {
  local root="$1" abs="$2"
  printf '%s' "${abs#"$root"/}"
}

# SHA-256 of the file's raw bytes; matches across identical content (spec test 4).
content_hash() {
  shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1
}

# Echo the directory containing the nearest .meetless.json, walking up from $1.
meetless_repo_root() {
  local dir="$1"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    [[ -f "$dir/.meetless.json" ]] && { printf '%s' "$dir"; return 0; }
    dir="$(dirname "$dir")"
  done
  return 1
}

# Append one Active Review record (Zone 1). Pure local write under the hook lock; never
# touches the network. Phase 0: this is the ONLY thing a produced-doc capture does.
# Args: kind sessionId turnIndex workspaceId ownerUserId repoRootHash canonicalPath contentHash [repoRoot]
# repoRoot (9th, optional) is the absolute repo root, stored LOCAL-only so the Zone 2
# auto-index can resolve the doc on disk (absPath = join(repoRoot, canonicalPath)). It
# is never transmitted (the detect wire sends only canonicalPath + kind + empty body).
# Optional under set -u because the tagged_reference caller passes only 8 args.
record_active_memory() {
  local kind="$1" sid="$2" turn="$3" ws="$4" owner="$5" rrh="$6" cpath="$7" chash="$8"
  local repoRoot="${9:-}"
  local ts; ts="$(date -u +%FT%TZ)"
  mkdir -p "$LOG_DIR"
  local line
  line="$(jq -c -n \
    --arg ts "$ts" --arg event "active_memory_record" \
    --arg ws "$ws" --arg owner "$owner" --arg rrh "$rrh" \
    --arg cpath "$cpath" --arg chash "$chash" \
    --arg sid "$sid" --argjson turn "$turn" \
    --arg sp "claude_code" --arg kind "$kind" --arg createdAt "$ts" \
    --arg repoRoot "$repoRoot" \
    '{ts:$ts,event:$event,workspaceId:$ws,ownerUserId:$owner,repoRootHash:$rrh,canonicalPath:$cpath,contentHash:$chash,sessionId:$sid,turnIndex:$turn,sourceProduct:$sp,kind:$kind,createdAt:$createdAt,repoRoot:$repoRoot}')"
  (
    ml_lock 9 "$LOG_DIR/kb-knowledge.lock"
    printf '%s\n' "$line" >> "$LOG_DIR/kb-knowledge.jsonl"
    ml_unlock 9 "$LOG_DIR/kb-knowledge.lock"
  )
}

# Detached, age-gated stale-session GC. Runs `mla flush --reap-only` (reap
# WITHOUT draining) so a Stop hook can sweep dead-session litter
# (`.lock`/`.turn`/`.repoPath`/`.gitBaseline`/`.workspaceId` + 0-byte spools idle > 24h) without
# re-draining every active session -- the O(sessions) fan-out that left 99
# stranded locks. The reap is age-gated, so on a healthy box this is a cheap
# read-only dir scan that removes nothing. Fully detached + best-effort so it can
# never delay the hook (Stop's <1s budget) or fail it. No-op when the CLI cannot
# be located. Reuses MLA_PATH resolved above (config mlaPath, else `mla` in PATH).
spawn_reap() {
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" flush --reap-only --quiet >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" flush --reap-only >>"$LOG_DIR/reap.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# ---- Zone 2 auto-index (Personal KB SHADOW ingest) ----------------------
# Default-on kill switch for the Zone 2 auto-index loop. Returns 0 (enabled)
# unless MEETLESS_AUTO_INDEX is explicitly "0". Kept as a pure predicate so the
# gate is unit-testable without spawning anything. dev-flags-default-on: on once
# built; one env var flips it off if it ever misbehaves in the field.
auto_index_enabled() {
  [[ "${MEETLESS_AUTO_INDEX:-1}" != "0" ]]
}

# Detached, fail-soft Zone 2 auto-index. Reads THIS session's produced-doc
# captures from the Active Review spool and indexes each into the owner's
# Personal KB as a SHADOW / agent_distilled doc (`mla _internal auto-index`).
# SHADOW never grounds anyone (INV-GROUNDING-APPROVED), so unattended ingest is
# safe; the explicit human gate moves to `mla kb promote` (SHADOW -> LIVE). Fully
# detached + best-effort, so it can never delay Stop (<1s budget) or fail it.
# No-op when disabled via the kill switch or when the CLI cannot be located.
# Reuses MLA_PATH resolved above (config mlaPath, else `mla` in PATH).
spawn_auto_index() {
  local session_id="$1"
  auto_index_enabled || return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" _internal auto-index --session "$session_id" >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" _internal auto-index --session "$session_id" >>"$LOG_DIR/auto-index-$session_id.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# ---- Deleted-session reconcile (archive AgentRuns whose transcript is gone) ----
# Default-on kill switch for the deleted-session sweep. Returns 0 (enabled)
# unless MEETLESS_SESSION_RECONCILE is explicitly "0". Pure predicate so the gate
# is unit-testable without spawning. dev-flags-default-on: on once built; one env
# var flips it off if it ever misbehaves in the field.
session_reconcile_enabled() {
  [[ "${MEETLESS_SESSION_RECONCILE:-1}" != "0" ]]
}

# Detached, fail-soft deleted-session reconcile. Claude Code has NO "session
# deleted" event, so the only way to notice a session was deleted is to compare
# the workspace's captured AgentRuns against the transcripts still present under
# ~/.claude/projects and archive the ones whose transcript is provably gone
# (`mla session reconcile`; the sweep itself is fail-SAFE, archiving only on
# positive proof of deletion). Fired on SessionStart as the natural throttling
# tick: an archived row drops out of the default list, so steady state is one
# cheap GET. Fully detached + best-effort so it can never delay or fail the hook.
# No-op when disabled via the kill switch or when the CLI cannot be located.
spawn_reconcile() {
  session_reconcile_enabled || return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" session reconcile >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" session reconcile >>"$LOG_DIR/session-reconcile.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# ---- Evidence analytics (T4.1 inject / T4.2 outcome correlator) ----------
# Default-on kill switch for the evidence-analytics inject + correlate loop.
# Returns 0 (enabled) unless MEETLESS_EVIDENCE_ANALYTICS is explicitly "0". Pure
# predicate so the gate is unit-testable without spawning. dev-flags-default-on:
# on once built; one env var flips it off if it ever misbehaves in the field.
evidence_analytics_enabled() {
  [[ "${MEETLESS_EVIDENCE_ANALYTICS:-1}" != "0" ]]
}

# Detached, fail-soft mla_evidence_inject record (spec T4.1). Fired from the
# UserPromptSubmit hook ONLY on a turn that actually pushed >= 1 evidence
# source_id (the SAME population parseInjectTurns scopes the adoption join to:
# enrichment.context_items[] with injected==true and a non-empty source_id), so
# the analytics inject denominator matches the followthrough join exactly. Records
# one local mla_evidence_inject line (inject_id + window_deadline) and best-effort
# forwards when telemetry is on. Fully detached + best-effort, so it never delays
# the hot path (UserPromptSubmit budget) or fails the prompt. No-op when disabled,
# when the CLI cannot be located, or when no offered ids were pushed.
# Args: turnIndex offeredIdsCsv tokens confidence latencyMs traceId workspaceId sessionId
spawn_evidence_inject() {
  local turn="$1" ids="$2" tokens="$3" conf="$4" latency="$5" trace="$6" ws="$7" sid="$8"
  evidence_analytics_enabled || return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  [[ -n "$ids" ]] || return 0   # no offered source_ids -> not an inject turn
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" _internal evidence-inject \
      --turn-index "$turn" --offered-ids "$ids" --tokens "$tokens" \
      --confidence "$conf" --latency-ms "$latency" --trace-id "$trace" \
      --workspace-id "$ws" --session-id "$sid" >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" _internal evidence-inject \
      --turn-index "$turn" --offered-ids "$ids" --tokens "$tokens" \
      --confidence "$conf" --latency-ms "$latency" --trace-id "$trace" \
      --workspace-id "$ws" --session-id "$sid" >>"$LOG_DIR/evidence-inject-$sid.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# Detached, fail-soft Stop-hook correlator (spec T4.2, INV-CORRELATOR-1). Closes
# every eligible PENDING inject window (3 turns or 15 minutes) across ALL sessions
# and appends one mla_evidence_outcome per closed inject to the local jsonl, then
# best-effort forwards when telemetry is on. It sweeps cross-session because a
# window can only close by time_limit minutes after the session ended, and a Stop
# is the natural recompute tick, so it takes NO session argument. Fully detached +
# best-effort + kill-switchable, so it never delays Stop (<1s budget) or fails it.
# No-op when disabled or when the CLI cannot be located.
spawn_evidence_correlate() {
  evidence_analytics_enabled || return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" _internal evidence-correlate >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" _internal evidence-correlate >>"$LOG_DIR/evidence-correlate.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# Default-on kill switch for the enforcement-outcome (STAR "R") correlator. Returns 0
# (enabled) unless MEETLESS_ENFORCEMENT_OUTCOME is explicitly "0". Pure predicate so the
# gate is unit-testable without spawning. dev-flags-default-on: on once built; one env
# var flips it off if it ever misbehaves in the field.
enforcement_outcome_enabled() {
  [[ "${MEETLESS_ENFORCEMENT_OUTCOME:-1}" != "0" ]]
}

# Detached, fail-soft Stop-hook enforcement correlator (STAR "R"). Reads THIS session's
# deny incidents + reconstructs what the agent did next from THIS session's transcript,
# appending one mla_enforcement_outcome per closed deny, then best-effort forwards. Unlike
# spawn_evidence_correlate it is session-scoped (a deny's follow-through is same-session),
# so it takes the session id AND the transcript path. Fully detached + best-effort +
# kill-switchable, so it never delays Stop (<1s budget) or fails it. No-op when disabled,
# when the CLI cannot be located, or when the session / transcript is missing.
# Args: sessionId transcriptPath
spawn_enforcement_correlate() {
  local sid="$1" transcript="$2"
  enforcement_outcome_enabled || return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  [[ -n "$sid" && -n "$transcript" && -f "$transcript" ]] || return 0
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" _internal enforcement-correlate \
      --session "$sid" --transcript "$transcript" >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" _internal enforcement-correlate \
      --session "$sid" --transcript "$transcript" >>"$LOG_DIR/enforcement-correlate.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# ---- Layer D per-turn recap -> Langfuse emission -------------------------
# Default-on kill switch for the Layer D Langfuse emission ONLY. Returns 0
# (enabled) unless MEETLESS_TURN_RECAP_LANGFUSE is explicitly "off". This is a
# SEPARATE flag from MEETLESS_TURN_RECAP (which gates the Layer C-lite next-prompt
# injection in user-prompt-submit.sh): the two surfaces are independent, so you can
# keep the free Langfuse observability on while silencing the context injection, or
# vice versa. Pure predicate so the gate is unit-testable without spawning anything.
# See notes/20260609-mla-per-turn-assist-recap-plan.md §4.4.
turn_recap_langfuse_enabled() {
  [[ "${MEETLESS_TURN_RECAP_LANGFUSE:-on}" != "off" ]]
}

# Detached, fail-soft Layer D emission. Posts the JUST-FINISHED turn's assist
# recap to intel (`mla _internal turn-recap --emit-langfuse`), which attaches the
# mla_ran / mla_assist Langfuse scores + the full recap as trace metadata to that
# turn's Langfuse trace (keyed on the per-turn $TRACE_ID intel adopts as the
# langfuse_trace_id). Routed through intel so the Langfuse keys stay out of the
# (soon-to-be-OSS) CLI. Fully detached + best-effort + kill-switchable
# (MEETLESS_TURN_RECAP_LANGFUSE=off, independent of the C-lite injection), so it can
# never delay Stop (<1s budget) or fail it. No-op when disabled, when the CLI
# cannot be located, or when no real turn ran (turn index not a positive integer;
# the `--turn` parser requires >= 1 anyway). Reuses MLA_PATH resolved above.
# Args: session_id turn_index
spawn_turn_recap_emit() {
  local session_id="$1" turn="$2"
  turn_recap_langfuse_enabled || return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  [[ -n "$session_id" ]] || return 0
  [[ "$turn" =~ ^[0-9]+$ && "$turn" -ge 1 ]] || return 0
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" _internal turn-recap --session "$session_id" --turn "$turn" --emit-langfuse >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" _internal turn-recap --session "$session_id" --turn "$turn" --emit-langfuse >>"$LOG_DIR/turn-recap-emit-$session_id.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# ---- Reactive/proactive user-token refresh (Part 3) ----------------------
# See notes/20260611-mla-hook-token-autorefresh-proposal.md. Hook-triggered token
# refresh is UNCONDITIONAL: there is no kill switch. A logged-in user always wants
# an expired access token to self-heal, so gating it behind an env var only added
# branches and a way to silently break the feature. (The legacy
# MEETLESS_HOOK_AUTOREFRESH var is intentionally ignored.)

# SYNCHRONOUS, fail-soft trigger for the TS CLI's concurrency-safe refreshUserToken
# (`mla _internal refresh`). UNLIKE the detached spawn_* helpers above, this runs
# in the FOREGROUND because the caller branches on its exit code: the reactive
# 401-retry only re-runs the request when this returns 0 (token rotated). bash
# writes ZERO tokens; the TS CLI owns the sidecar lock, single-flight, and atomic
# writeConfig. Exit-code contract (kept in sync with commands/internal-refresh.ts):
#   0  refreshed (rotated, adopted a concurrent winner, or proactively still-fresh)
#   75 EX_TEMPFAIL: busy / transient; keep events queued, do NOT retry now
#   77 EX_NOPERM:   refresh token dead server-side; surface `mla login`
#   64 EX_USAGE:    wrong mode / unreadable config / bad args
#   70 NOT ATTEMPTED (local sentinel): the CLI could not be located.
#      NOT a sysexits code the subcommand emits (it is EX_SOFTWARE, never returned
#      by internal-refresh.ts), so callers can tell "we never tried" apart from
#      "the subcommand ran and said X".
# set -e-safe: the one command that can exit non-zero uses `|| rc=$?`, so a caller
# running under `set -euo pipefail` (e.g. flush.sh) is never aborted by this helper
# even on a 75/77/64. Callers must still consume the return via `|| rc=$?`.
# Optional $1: seconds for the proactive `--if-expiring-within <secs>` gate. With
# no arg the flag is omitted (a plain reactive refresh). --quiet is always passed
# (defense in depth: the subcommand never prints a token, and we /dev/null it too).
refresh_user_token() {
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 70
  local rc=0
  if [[ -n "${1:-}" ]]; then
    "$MLA_PATH" _internal refresh --quiet --if-expiring-within "$1" >/dev/null 2>&1 || rc=$?
  else
    "$MLA_PATH" _internal refresh --quiet >/dev/null 2>&1 || rc=$?
  fi
  return "$rc"
}

# Best-effort ISO8601 -> epoch seconds, cross-platform (Linux GNU date + macOS
# BSD date). Prints the epoch on success and returns 0; prints nothing and
# returns 1 when the timestamp cannot be parsed. Tries GNU `date -d` first (a
# no-op-fail on BSD, where -d is the DST flag), then BSD `date -j -f` after
# normalizing away fractional seconds and a trailing Z. A timezone OFFSET form
# (`+00:00`) only parses on the GNU branch; on BSD it falls through to a parse
# failure, which the caller treats as fail-safe (spawn the TS gate) rather than a
# skip. Used by the proactive refresh gate below.
iso_to_epoch() {
  local iso="$1" e=""
  e="$(date -d "$iso" +%s 2>/dev/null || true)"
  if [[ -n "$e" ]]; then printf '%s' "$e"; return 0; fi
  local norm="${iso%.*}"   # drop fractional seconds if present
  norm="${norm%Z}"          # drop trailing Z
  e="$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "$norm" +%s 2>/dev/null || true)"
  if [[ -n "$e" ]]; then printf '%s' "$e"; return 0; fi
  return 1
}

# Proactive "refresh-ahead" (Part 3 §A, Phase 2). Call BEFORE reading the enrich
# token so a near-expiry access token is rotated on disk first and Layer 2 uses a
# fresh token instead of taking a reactive 401. Cheap by design: a pure-bash
# freshness check skips the node spawn on the overwhelmingly common path (token
# comfortably fresh, > skew seconds of life left). It spawns the TS gate
# (`refresh_user_token <skew>` -> `mla _internal refresh --if-expiring-within`)
# ONLY when the token is within the skew window OR its timestamp cannot be parsed.
# The parse-failure branch is FAIL-SAFE: it spawns (the TS gate re-checks the same
# skew in well-tested Date logic and no-ops if actually fresh) rather than skip a
# refresh the session may need. Gated on user-token mode only. Best-effort: a
# non-zero refresh rc is NOT fatal here (the reactive 401 path remains the real
# safety net), so the call is `|| true` and this helper always returns 0. Skew
# override: MEETLESS_HOOK_REFRESH_SKEW_SECS (default 600s / 10 min).
maybe_refresh_ahead() {
  local mode expires_at skew now exp
  mode="$(jq -r '.auth.mode // empty' "$CFG" 2>/dev/null || true)"
  [[ "$mode" == "user-token" ]] || return 0
  skew="${MEETLESS_HOOK_REFRESH_SKEW_SECS:-600}"
  expires_at="$(jq -r '.auth.accessExpiresAt // empty' "$CFG" 2>/dev/null || true)"
  if [[ -n "$expires_at" ]]; then
    exp="$(iso_to_epoch "$expires_at" 2>/dev/null || true)"
    now="$(date +%s 2>/dev/null || echo 0)"
    # Comfortably fresh => skip the spawn entirely (the hot-path-clean case).
    if [[ -n "$exp" && "$now" -gt 0 && $((exp - now)) -gt "$skew" ]]; then
      return 0
    fi
  fi
  # Near expiry, unparseable, or unknown: let the TS gate decide (it re-checks the
  # same skew and no-ops cheaply when the token is actually still fresh).
  refresh_user_token "$skew" || true
  return 0
}
