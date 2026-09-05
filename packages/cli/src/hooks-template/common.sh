#!/usr/bin/env bash
# common.sh
# Sourced by every Meetless hook. Sets QUEUE_DIR, CFG, MLA_PATH; exposes
# gen_event_key + spool_append (locked) + spawn_flush.
#
# Source: an internal design note §5.2.
set -euo pipefail

# home.sh FIRST, before any path is built. It repairs a poisoned $HOME (empty, a
# literal "~", relative) from the password database and exports the honest value, so
# every "$HOME/..." below AND every process we spawn is anchored to a real absolute
# home. Without it, `${MEETLESS_HOME:-$HOME/.meetless}` silently resolves to the
# RELATIVE "~/.meetless" or "/.meetless" and the whole state tree (queue, logs,
# cli-config, session-gate, the ce0 evidence store) re-roots under the session's cwd,
# i.e. inside the operator's repo. See home.sh for the 2026-07-13 incident.
# It also sets MEETLESS_HOME_DIR, honoring an ABSOLUTE MEETLESS_HOME override only.
#
# Sourced best-effort: home.sh ships with common.sh in every install (wire.ts copies the
# whole template dir; the plugin generator lists both), so a missing one means a CORRUPT
# install, which `mla doctor` reports as hook drift. The hook layer's contract is fail
# open, so a corrupt install must degrade, not wedge the session. The fallback below
# cannot reintroduce the bug: without home.sh we lose the REPAIR, never the RULE, and
# the rule is that a state dir is absolute or it does not exist.
source "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/home.sh" 2>/dev/null || true

if [[ -z "${MEETLESS_HOME_DIR+x}" ]]; then
  case "${MEETLESS_HOME:-}" in
    /*) MEETLESS_HOME_DIR="$MEETLESS_HOME" ;;
    *) if [[ "${HOME:-}" == /* ]]; then MEETLESS_HOME_DIR="$HOME/.meetless"; else MEETLESS_HOME_DIR=""; fi ;;
  esac
fi

# Empty = no home is resolvable on this box (no $HOME, no passwd entry, no absolute
# MEETLESS_HOME). There is nowhere legitimate to put the state, and the one thing we must
# never do is fall back to the cwd. Capture is assistive, so degrade to a clean no-op.
if [[ -z "${MEETLESS_HOME_DIR:-}" ]]; then
  printf '[Meetless] no home directory could be resolved; capture is disabled for this session.\n' >&2
  exit 0
fi

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
# an internal design note).
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

# Resolve a slash command to a RETRIEVAL KEY, or print nothing.
#
# "/pulse" is six characters and answers no question, so the hook skipped Layer 2
# on every slash command. That reasoning is right about the TEXT and wrong about
# the TURN: /pulse expands into dozens of tool calls across topics the governed KB
# covers, and it was the most knowledge-hungry turn of the session that surfaced
# this. The command's meaning is not in the text the human typed, it is in the
# command's own definition, which is already on disk.
#
# So we resolve it instead of guessing, and DELIBERATELY not from a table of known
# commands. A static skill-to-intent map is a second source of truth the day a user
# writes their own command, and mla does not own another agent's command registry.
# Reading the definition costs one file read and stays correct for commands that do
# not exist yet.
#
# Search order is most-specific-first, matching how the harness itself resolves a
# command: project skills, project commands, then the user's own. Prints
# "<name> <description> <args>" so the retrieval key carries the command's meaning
# AND what the operator asked it to do; prints nothing when the command is unknown,
# and the caller keeps the existing skip (an unresolvable name IS unanswerable).
resolve_slash_command_key() {
  local s="${1-}"
  [[ "$s" =~ ^/([A-Za-z][A-Za-z0-9_:-]*)([[:space:]]+(.*))?$ ]] || return 0
  local name="${BASH_REMATCH[1]}" args="${BASH_REMATCH[3]:-}"
  # Plugin-qualified commands arrive as "plugin:skill"; the directory is the skill.
  local leaf="${name##*:}"
  # Defence in depth: the name is interpolated into paths below, so anything that
  # is not a plain command token is refused rather than sanitized into something.
  [[ "$leaf" =~ ^[A-Za-z0-9_-]+$ ]] || return 0

  local proj="${CLAUDE_PROJECT_DIR:-$PWD}" f desc=""
  for f in \
    "$proj/.claude/skills/$leaf/SKILL.md" \
    "$proj/.claude/commands/$leaf.md" \
    "$HOME/.claude/skills/$leaf/SKILL.md" \
    "$HOME/.claude/commands/$leaf.md"; do
    [[ -r "$f" ]] || continue
    # description: from the YAML frontmatter only (first 20 lines), single line.
    desc="$(sed -n '1,20p' "$f" 2>/dev/null | sed -n 's/^description:[[:space:]]*//p' | head -1)"
    [[ -n "$desc" ]] && break
    desc=""
  done
  [[ -n "$desc" ]] || return 0

  printf '%s %s' "$name" "$desc"
  [[ -n "$args" ]] && printf ' %s' "$args"
  return 0
}

# Owner-only (0600) before the first byte lands. `>>` creates a new file at
# 0666 & ~umask, which on a default 022 umask is 0644: world-readable to every
# local user. ask-traces.jsonl is append-only and unbounded, so a single
# permissive creation is inherited by every row written for the life of the file.
#
# Both halves matter and neither alone is enough: the `touch` fixes files this
# process creates, the `chmod` fixes the ones already sitting at 0644 from before
# this change. Fully fail-soft (a chmod we do not own must not block a prompt).
ml_private_file() {
  local f="$1"
  [[ -n "$f" ]] || return 0
  [[ -e "$f" ]] || { : >> "$f" 2>/dev/null || true; }
  chmod 600 "$f" 2>/dev/null || true
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

# T1.5 fail-soft (folder = workspace, an internal design note
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

# Correction 7: the absolute path resolved at install time is PREFERRED, and it is what
# a healthy install uses. PATH is the FALLBACK, not a non-dependency: a pinned mlaPath
# that no longer passes -x (the binary was reinstalled elsewhere, a version manager moved
# it, the config predates a move) must not kill capture outright, so we take whatever
# `mla` PATH can find rather than going silently dark.
#
# Know what that costs, because the earlier version of this comment claimed PATH was "NOT
# relied on" and taught readers to assume otherwise: when the pinned path is dead, these
# hooks will invoke whatever `mla` happens to sit first on PATH. On a machine with a
# stale, foreign, or shimmed mla, that is the wrong binary, running with MEETLESS_HOME
# pointed at this install. The failure is silent by construction.
#
# It is also the reason the test suite plants a no-op `mla` at the head of PATH
# (test/jest.global-setup.js): 39 specs pinned mlaPath to "/bin/true", which does not
# exist on macOS, so the -x guard fired and this fallback reached for the developer's
# real global binary mid-test.
# The Codex wrapper pins nested helper calls to the same CLI executable that
# received the hook. This prevents a newly registered hook from delegating its
# inner capture work to an older globally installed binary during upgrades (or
# while running a source-checkout build). Other connectors retain the persisted
# mlaPath -> PATH fallback contract below.
if [[ "${MEETLESS_CONNECTOR:-}" == "codex" && "${MEETLESS_CODEX_MLA_PATH:-}" == /* && -x "${MEETLESS_CODEX_MLA_PATH:-}" ]]; then
  MLA_PATH="$MEETLESS_CODEX_MLA_PATH"
else
  MLA_PATH="$(jq -r '.mlaPath // empty' "$CFG" 2>/dev/null || true)"
  if [[ -z "${MLA_PATH:-}" || ! -x "$MLA_PATH" ]]; then
    MLA_PATH="$(command -v mla 2>/dev/null || true)"
  fi
fi

# Run one internal subcommand through its LEAN sibling entrypoint when one is present,
# falling back to the fat `mla _internal <sub>` when it is not. Reads stdin, writes
# stdout, and FORWARDS THE EXIT CODE unchanged.
#
#   $1  sibling basename, resolved next to $MLA_PATH   (e.g. redact-entry.js)
#   $2  timeout seconds, or "" for no timeout
#   $@  the fat fallback argv                          (e.g. _internal redact-capture)
#
# WHY (measured 2026-08-09, D1 of
# an internal design note).
# The pre-enrich window holds exactly two synchronous `mla` spawns and the cost is process
# STARTUP, not work. Interleaved, median of 9:
#
#     empty script (node's own floor)             25ms
#     redact-capture closure alone                26ms
#     assemble-context closure alone             144ms
#     dist/cli.js --version (does NOTHING)       334ms
#
# `dist/cli.js` eagerly imports 30+ command modules plus Sentry/analytics top-level init;
# a sibling entry pays only its own closure. Against a live `pre_enrich_ms` of median 928ms
# / p90 1,745ms that is ~470ms/turn of pure registry. This is lever A from
# an internal design note (355.9ms -> 56.1ms on the
# PreToolUse path), extended to the hook it was never applied to.
#
# ONE ENTRY PER SUBCOMMAND, NOT ONE SHARED DISPATCHER. A shared entry drags
# assemble-context's ~120ms closure onto the redaction spawn for nothing (141+141 per turn
# against 144+26). Measured, not assumed.
#
# THE MIDDLE RUNG IS NOT OPTIONAL. `pnpm pack` normalizes every packed file to 0644 and
# force-sets 0755 only on `bin` entries, so the `chmod +x` in our build script is real on
# disk and discarded into the tarball: the sibling arrives from npm at 0644, forever. An
# `-x`-only guard would send every npm install down the slow path on every turn, correctly
# and invisibly. That exact bug shipped on the pretool path up to 0.2.17.
#
# NOT A COMMAND FRAMEWORK. It resolves a path and picks one of three transports. Callers
# keep owning their own payloads, their own parsing and their own failure handling, which
# is what lets the redaction sites stay fail-closed: a non-zero exit reaches the caller
# unchanged, so an empty result still becomes `redaction_failed` rather than a silent pass.
# `pre-tool-use.sh` keeps its own inline copy on purpose (it sources home.sh, never this
# file, precisely to stay off this require graph), so there is one mechanism, not two.
ml_run_internal() {
  local _entry_name="$1" _tmo="$2"
  shift 2
  local _entry _t=""
  [[ -n "$_tmo" ]] && _t="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
  # A resolvable sibling requires a resolvable mla. With neither we still run the fat
  # fallback, which fails the same way it always did rather than differently.
  if [[ -n "${MLA_PATH:-}" ]]; then
    _entry="$(dirname "$MLA_PATH")/$_entry_name"
    if [[ -x "$_entry" ]]; then
      ${_t:+"$_t" "$_tmo"} "$_entry"
      return $?
    fi
    if [[ -f "$_entry" ]] && command -v node >/dev/null 2>&1; then
      ${_t:+"$_t" "$_tmo"} node "$_entry"
      return $?
    fi
  fi
  ${_t:+"$_t" "$_tmo"} "$MLA_PATH" "$@"
}

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

# The DIRTY WORKING TREE: every path git reports as changed vs HEAD (staged +
# unstaged) plus untracked-but-not-ignored files, as of right now, in $dir.
#
# The name states exactly what it measures and nothing more. This is a
# REPOSITORY fact, not a session fact: in a checkout shared by several
# concurrent agent sessions (our own dogfood tree runs 10+), most of what this
# returns was written by somebody else. Do NOT use it to answer "what did THIS
# session touch"; that is what collect_touched_files below is for.
#
# Legitimate consumers are the ones that genuinely want the repository's current
# state: the rule assembler matches governance rules against the whole working
# set on purpose, because a rule that governs a dirty file should be delivered no
# matter who dirtied it.
#
# Emits a compact JSON array of repo-relative paths on stdout (e.g.
# ["a.ts","b.ts"]), deduped and bounded to MEETLESS_TOUCHED_FILES_MAX (default
# 50). ALWAYS returns 0 and prints "[]" on any failure (no git binary, not a
# repo, empty repo with no HEAD, detached worktree).
collect_dirty_working_tree() {
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

# Append one path to THIS session's touched-file ledger. Called by post-tool-use
# on every file-modifying tool call, which is the only place in the hook layer
# that knows, as a fact rather than an inference, that this session just wrote
# this file.
#
# Append-only, newline-delimited, one `>>` with no lock: a single short line
# written with one write(2) under PIPE_BUF is atomic on every filesystem we
# support, and the reader dedupes anyway, so a concurrent post-tool-use in the
# SAME session can at worst produce a duplicate line. Never fails the caller.
record_touched_file() {
  local sid="$1" path="$2"
  [[ -n "$sid" && -n "$path" ]] || return 0
  case "$path" in *$'\n'*) return 0 ;; esac
  # Record the PHYSICAL path. The agent host hands us the LOGICAL path the
  # operator works in, while `git rev-parse --show-toplevel` (the scope root the
  # reader strips) always answers physically. A project reached through a symlink
  # (`~/work` pointing at `/Volumes/dev/work`, or anything under macOS /tmp, which
  # is itself a link to /private/tmp) would therefore match no root at read time,
  # every path would be dropped, and touched_files would go silently empty: the
  # exact failure mode this ledger exists to remove. Resolving here costs one
  # subshell per file-modifying tool call instead of one per path per prompt.
  # Best effort by design: a path whose directory is already gone is kept
  # verbatim rather than discarded.
  local _rtf_dir _rtf_base _rtf_phys
  if [[ "$path" == /* ]]; then
    _rtf_dir="${path%/*}"
    [[ -z "$_rtf_dir" ]] && _rtf_dir="/"
    _rtf_base="${path##*/}"
    _rtf_phys="$(cd "$_rtf_dir" 2>/dev/null && pwd -P || true)"
    [[ -n "$_rtf_phys" ]] && path="${_rtf_phys%/}/$_rtf_base"
  fi
  mkdir -p "$QUEUE_DIR" 2>/dev/null || return 0
  printf '%s\n' "$path" >> "$QUEUE_DIR/$sid.touched" 2>/dev/null || true
  return 0
}

# I1 (interception): the files THIS session actually modified, read back from the
# ledger record_touched_file appends to (spec §I1: enrich must seed retrieval
# from the touched-file SET, not from the prompt's phrasing).
#
# 2026-07-27 dogfood finding (an internal design note): this used to
# be the git working-tree delta, which is a REPOSITORY fact. In a shared checkout
# it injected a concurrent peer's uncommitted work as "the surfaces the agent is
# actually modifying" (verified live: four paths, none of them ours). The failure
# was silent and plausible: wrong paths that look exactly like right ones. Worse,
# it invited the agent to `git add` files it had never touched. Attribution must
# be exact, so the substrate moved to the only exact signal available at
# UserPromptSubmit.
#
# Coverage is partial by construction and that is the correct trade. A path lands
# here only when it came through Edit/Write/MultiEdit/NotebookEdit/apply_patch,
# so a Bash-driven edit (`sed -i`, a `>` redirect) is NOT captured; PostToolUse
# sees the command, never the files it wrote. Partial and exact beats complete
# and wrong: a missing path costs one ranking hint, a wrong path poisons the
# seed AND misattributes another human's work.
#
# Emits a compact JSON array of repo-relative paths on stdout, most-recently-
# touched FIRST (recency is the ranking signal, so the bound must not truncate
# it away), deduped and bounded to MEETLESS_TOUCHED_FILES_MAX (default 50).
# Paths outside $dir are dropped: the wire contract is repo-relative, and a path
# in some other repo is not a surface of this workspace. ALWAYS returns 0 and
# prints "[]" on any failure or when the session has modified nothing yet. An
# empty result is the compat-6.2 signal: callers OMIT the field entirely, so
# retrieval falls back to today's prompt-only behavior.
#
# Deliberately does NOT emit a structured proposed_action. At UserPromptSubmit
# there is no concrete pending action to describe; that field is reserved for a
# future PreToolUse interception surface. touched_files are ranking hints only
# (spec I-SEC-1) and never widen ACL (I-SEC-3); intel treats them as such.

# ---- Non-retrievable prompt taxonomy ------------------------------------
# Not every string arriving on UserPromptSubmit is an operator QUESTION. Two
# distinct classes reach this hook that the retrieval layer can never help with,
# and both were being routed anyway: measured over the 3973 enrich rows in
# ~/.meetless/logs/ask-traces.jsonl, 294 IDE events and 66 slash commands paid
# for a full intel /v1/ask round trip and then landed in the router's `unknown`
# bucket, inflating the abstain denominator with turns that were never
# answerable. Echoes the class, or NOTHING when this is a real prompt:
#
#   harness_event  The coding-agent harness authored the WHOLE turn; no human
#                  typed anything. `<task-notification>` (background-task
#                  wake-up) is the established case. Nothing at all should run:
#                  no floor, no enrich, no trace.
#
#                  A leading harness block is NOT by itself a harness event, and
#                  assuming it was cost 299 real operator turns. The
#                  `<task-notification>` precedent was generalized to `<ide_*>`
#                  and `<hint>` on the strength of the shape alone; re-measured
#                  over the 3991 rows in ~/.meetless/logs/ask-traces.jsonl it
#                  holds for exactly one of the three:
#
#                    <task-notification>  148 rows, 148 block-only, 0 with text
#                    <ide_*>              294 rows,   0 block-only, 294 with text
#                    <hint>                 5 rows,   0 block-only,   5 with text
#
#                  The IDE extension PREPENDS its telemetry to the message the
#                  operator typed; it does not replace it. So every one of those
#                  299 turns was a human asking a real question ("remove .claude
#                  dir out of git of the Meetless repo") behind a block, and the
#                  gate gave each of them no floor, no enrich, and no trace row
#                  at all. Invisible twice over: the turn cannot be counted as an
#                  abstain either, so the miss does not even show up as a miss.
#                  Still arriving on 2026-07-28, i.e. it was live when found.
#
#                  Hence: strip the leading blocks, then classify what SURVIVES.
#                  A block-only prompt still lands on harness_event (all the
#                  pre-existing cases are block-only and still pass), and a block
#                  followed by human text is the human's turn, keyed on the
#                  human's words rather than on editor telemetry.
#   slash_command  A human DID author this turn and the agent WILL do real work
#                  in it (`/implement <doc>` is a full implementation run), but
#                  the prompt TEXT is a command invocation, not a question, so it
#                  is a useless retrieval key. Layer 1's floor MUST still inject
#                  (the turn writes code and the governing rules apply); only the
#                  Layer 2 pull is skipped. This is why the two classes are not
#                  collapsed into one boolean.
#
# The slash pattern deliberately requires the leading token to carry no SECOND
# slash, so a pasted absolute path ("/Users/an/notes/x.md ...") stays a real
# prompt. Verified against the corpus: 0 false positives over 3973 rows.
# A mid-text "/implement" is likewise a real prompt; only a LEADING token counts.
# Peel leading harness blocks off a prompt and echo what the human actually
# typed. Echoes the input unchanged when there is no leading block.
#
# Non-greedy by construction (`${s#*"$close"}` cuts at the FIRST close tag) so a
# `</ide_selection>` mentioned inside a later pasted document cannot swallow the
# operator's text. The loop bound is a runaway guard, not a semantic limit; no
# corpus row carries more than two stacked blocks.
#
# An UNTERMINATED block is left in place deliberately. If the close tag never
# arrives we cannot say where harness telemetry stops and a human would start,
# and inventing a boundary there would send editor telemetry to intel as a
# retrieval key. Leaving it makes classify_non_prompt below still call it a
# harness_event, which is the safe reading and matches today's behavior.
# UTF-8 BYTE length of $1. Prints an integer, always.
#
# `${#var}` is CODEPOINTS under a UTF-8 locale and BYTES under C, so it answers a
# different question depending on the operator's environment, and neither answer is
# the one the host's inline-context ceiling asks. That ceiling is counted in JS
# String.length (UTF-16 code units, measured 2026-08-06 at 10,000). Three numbers
# describe the same text and exactly one relation holds for ALL input:
#
#     utf8_bytes  >=  utf16_units  >=  codepoints
#
# Bytes is therefore the only unit bash can compute that is a sound UPPER BOUND on
# the host's, without reimplementing UTF-16 here.
#
# Be precise about where a codepoint budget actually breaks, because it is not where
# it looks. For ASCII, Vietnamese and BMP CJK, codepoints == utf16_units, so a
# codepoint budget is safe against the host and merely imprecise about bytes. It is
# UNSAFE only for ASTRAL characters, where utf16_units == 2 x codepoints: an
# emoji-dense payload can measure 3,000 to bash and 6,000 to the host. That is a live
# case, not a hypothetical -- 1,226 of 1,729 measured real injections contain at least
# one, because the turn-recap block opens with an emoji.
#
# The byte budget costs a little evidence on multibyte scripts (a Vietnamese payload
# is ~1.4x its own utf16 length in bytes) and that is the price of one unit that is
# never wrong in the dangerous direction.
#
# `local LC_ALL=C` is what makes `${#}` count bytes; bash re-reads the locale on the
# assignment and restores it when the function returns. No fork, no pipe, no subshell,
# which matters on a hot path that already spends its budget on jq and curl.
ctx_bytes() {
  local LC_ALL=C
  printf '%s' "${#1}"
}

# Cut $1 down to at most $2 UTF-8 BYTES, never splitting a character. Prints the
# result; total, and a no-op when it already fits.
#
# Slicing is the half of the budget that `ctx_bytes` does not solve. `${s:0:N}` takes
# CHARACTERS under a UTF-8 locale and BYTES under C, so the same call means two
# different things, and the C reading cuts mid-sequence: measured over 60 consecutive
# cut points on Vietnamese evidence, 14 of them (23%) produced invalid UTF-8, which
# `jq --arg` then has to mangle or reject. Under a UTF-8 locale the same sweep split
# nothing, which is exactly why this is the kind of defect that ships: it is invisible
# on the machine you wrote it on.
#
# Forcing LC_ALL=C makes both operations bytes, so the arithmetic is honest, and the
# repair pass below puts the character boundary back. The repair is bounded at 4 steps
# because a UTF-8 sequence is at most 4 bytes: walking back past 3 continuation bytes
# always reaches either the lead byte or ASCII.
utf8_cut_bytes() {
  local LC_ALL=C s="$1" max="$2" i have need b
  (( max < 0 )) && max=0
  (( ${#s} <= max )) && { printf '%s' "$s"; return 0; }
  s="${s:0:$max}"
  for (( i = 0; i < 4 && ${#s} > 0; i++ )); do
    have=$(( i + 1 ))
    b="${s: -have:1}"
    case "$b" in
      # Continuation byte: this is not the start, keep walking back.
      [$'\x80'-$'\xbf']) continue ;;
      # Lead bytes, with the length each one promises.
      [$'\xc2'-$'\xdf']) need=2 ;;
      [$'\xe0'-$'\xef']) need=3 ;;
      [$'\xf0'-$'\xf4']) need=4 ;;
      # ASCII (or a stray byte we will not second-guess): nothing was split.
      *) break ;;
    esac
    # The sequence started `have` bytes from the end but promised `need`. Short means
    # the cut landed inside it, so drop the whole sequence rather than emit a fragment.
    (( have < need )) && s="${s:0:${#s} - have}"
    break
  done
  printf '%s' "$s"
}

# Cut $1 to at most $2 UTF-8 BYTES, landing on a boundary a READER can use. Prints the
# result; a no-op when it already fits.
#
# F3 (an internal design note §4.3).
# `utf8_cut_bytes` guarantees the cut does not split a CHARACTER. Nothing guaranteed it
# did not split a SENTENCE, and it routinely did. Session 6ab21c5e turn 2 delivered:
#
#     Reviewed and approved with two corre[...truncated by Meetless...]
#
# and on the turn-6 chunking-profile question the load-bearing sentence sat a few lines
# past the cut. A fragment is not a cheaper version of the evidence: the reader cannot
# use the last clause, and may complete it wrongly.
#
# WHY THERE IS NO SECOND RANKER HERE, which the proposal left open. The item text is
# `title + ": " + snippet` and `snippet` IS the matched retrieval passage
# (`RetrievalCandidate.snippet`; for a chunk-lane hit it is the matched chunk verbatim).
# There is no separate "matched region" hiding inside the text for a heading scorer to
# go find and prefer, so the entire remaining job is to stop cutting mid-thought. Adding
# a relevance model here would be inventing a signal, not preserving one.
#
# THE LADDER, best boundary first, each accepted only if enough of the allowance
# survives:
#   paragraph (\n\n) -> line (\n) -> sentence (. ! ?) -> word (space)
# The structural three share a 50% floor; the word rung has a 90% floor, because a word
# boundary costs a few bytes and a structural one can cost most of the payload. Below
# every floor we take the raw character-safe cut: delivering 20% of the allowance to buy
# a prettier ending is a worse outcome than the fragment it avoids.
#
# The budget is a HARD ceiling in both directions of this search: backing up only ever
# yields LESS, never more.
#
# One extra rule after a boundary is chosen: never end on a DANGLING HEADING. A markdown
# heading with nothing under it announces a section the reader was not given, which is
# strictly worse than stopping before the heading.
#
# Pure parameter expansion under `local LC_ALL=C` (bytes, no forks) apart from the one
# `utf8_cut_bytes` call that already existed: this runs on the prompt-submit hot path.
cut_at_boundary() {
  local LC_ALL=C s="$1" max="$2" hard cand
  (( max < 0 )) && max=0
  (( ${#s} <= max )) && { printf '%s' "$s"; return 0; }
  hard="$(utf8_cut_bytes "$s" "$max")"
  local -i n=${#hard}
  (( n == 0 )) && { printf '%s' "$hard"; return 0; }

  # Where the raw cut already fell, decided by the character that comes NEXT IN THE
  # SOURCE and never by the last character kept.
  #
  # "ends in a period" is NOT a sentence end, and reading it as one is how this function
  # shipped a word split of its own on the first pass: an allowance landing inside the
  # token `6.7.` keeps `...section 6.`, which ends in a period, satisfies a
  # last-character test, and is a fragment of a number. Only the source's next character
  # can tell a boundary from a coincidence.
  local nextch="${s:n:1}"
  local at_gap=0
  [[ "$nextch" == " " || "$nextch" == $'\n' || "$nextch" == $'\t' ]] && at_gap=1

  # Consumed everything, or the cut already ends a LINE or a SENTENCE. These three are
  # the only free wins: no rung below can beat them, so returning early costs nothing.
  #
  # A bare word gap is deliberately NOT in this set, and that is the whole reason this
  # is a ladder. The second pass of this function did short-circuit on a word gap, and
  # it delivered `...6.7. Single profile` -- stopping at the gap after "profile" when a
  # complete sentence boundary sat 15 bytes back, comfortably above the floor. A word
  # gap is the FALLBACK rung, checked after the structural ones have been offered their
  # chance, not a reason to stop looking.
  if [[ -z "$nextch" ]]; then _emit_without_dangling_heading "$hard"; return 0; fi
  case "$hard" in
    *$'\n') _emit_without_dangling_heading "$hard"; return 0 ;;
    *[.!?]) (( at_gap )) && { _emit_without_dangling_heading "$hard"; return 0; } ;;
  esac

  local -i struct_floor=$(( n * 50 / 100 )) word_floor=$(( n * 90 / 100 ))

  # 1. Paragraph / section boundary: the prefix before the LAST blank line. `%` removes
  #    the SHORTEST matching suffix, which keeps the LONGEST prefix, i.e. the last
  #    occurrence. An unchanged result means the pattern was not present at all.
  cand="${hard%$'\n\n'*}"
  if [[ "$cand" != "$hard" ]] && (( ${#cand} >= struct_floor )); then
    _emit_without_dangling_heading "$cand"; return 0
  fi

  # 2. Line boundary.
  cand="${hard%$'\n'*}"
  if [[ "$cand" != "$hard" ]] && (( ${#cand} >= struct_floor )); then
    _emit_without_dangling_heading "$cand"; return 0
  fi

  # 3. Sentence boundary: the last `. ` / `! ` / `? `. The punctuation is KEPT (the
  #    match strips it, so one byte is added back); a sentence delivered without its
  #    full stop reads as another fragment.
  cand="${hard%[.!?] *}"
  if [[ "$cand" != "$hard" ]]; then
    cand="${hard:0:$(( ${#cand} + 1 ))}"
    if (( ${#cand} >= struct_floor )); then _emit_without_dangling_heading "$cand"; return 0; fi
  fi

  # 4. Word boundary. Cheap, so it holds a much higher floor: it exists to stop
  #    `two corre`, not to reshape the payload.
  #
  #    Free case first: no structural boundary cleared its floor, and the raw cut
  #    ALREADY sits in a word gap. Backing up to the previous space here would throw a
  #    whole word away to arrive at the boundary we are standing on.
  if (( at_gap )); then _emit_without_dangling_heading "$hard"; return 0; fi
  cand="${hard% *}"
  if [[ "$cand" != "$hard" ]] && (( ${#cand} >= word_floor )); then
    _emit_without_dangling_heading "$cand"; return 0
  fi

  # No boundary worth the loss. The character-safe cut stands.
  printf '%s' "$hard"
}

# Drop a trailing heading line that has no body under it. A cut that ends on `## Registry`
# promises a section it did not deliver. Only ever removes the FINAL line, and only when
# that line is a heading, so ordinary prose is returned byte-identical.
_emit_without_dangling_heading() {
  local LC_ALL=C s="$1" head last
  head="${s%$'\n'*}"
  if [[ "$head" != "$s" ]]; then
    last="${s##*$'\n'}"
    case "$last" in
      '#'*) s="$head" ;;
    esac
  fi
  printf '%s' "$s"
}

# THE ONE DEFINITION of "this line opens a rendered evidence item". Every consumer of
# the evidence block (the budgeter's segmenter, the delivered-citation recorder) asks
# THIS, so a band added upstream is added in exactly one place downstream.
#
# The shapes are intel's, not a guess: `_render_enrichment_markdown` (agentic_service.py)
# emits `- [<band>][<source_id>] <text>`, or `- [<band>] <text>` when the item has no
# source_id, for exactly four bands. Nothing else in the block is a top-level item.
#
# WHY NOT `- [` (the glob this replaced, session a4a779b2 turn 3). A retrieved snippet is
# arbitrary markdown, and `- [x]` / `- [ ]` (GFM checkboxes) and `- [text](url)` (link
# bullets) all match that glob. A to-do-list note made the segmenter see FIFTEEN items
# where there were three; `reserve = max / n` then cut every real item's allowance by 5x
# and twelve phantom segments each spent a reservation on a 40-byte checkbox line. One of
# three documents reached the model, and the `max / n < min_share` guard could not fire
# because it was evaluated against the same inflated n. Measured on ONE operator's corpus
# on ONE machine: 441 of 948 evidence payloads (46.5%) carried more `- [` lines than real
# items. That is a local prevalence, not a claim about the MLA population.
#
# A CLOSED BAND SET, not a `- [<word>][` pattern. `- [x] a thing` and `- [TODO] a thing`
# are both "a bracketed word", so no generic shape can exclude them; and the no-source_id
# form `- [accepted] text` has no second bracket to key on. The band list is the only
# thing that separates the two populations, so it is written down. If intel adds a band,
# add it here in the same change: an unknown band degrades to "not an item", which costs
# per-item fairness (the whole block takes the single global cut) but never mislabels.
#
# The leading `- [` test is kept as a cheap pre-filter: it rejects the ordinary prose and
# table lines that are most of an evidence payload before any string surgery.
_MLA_EVIDENCE_BANDS=' accepted pending shadow agent-observation '
is_evidence_item_line() {
  local line="${1-}" band
  case "$line" in '- ['*) ;; *) return 1 ;; esac
  band="${line#- \[}"
  case "$band" in *']'*) band="${band%%]*}" ;; *) return 1 ;; esac
  case "$_MLA_EVIDENCE_BANDS" in *" $band "*) return 0 ;; esac
  return 1
}

# How many rendered evidence items a block carries. The same predicate the budgeter
# segments on, exposed so the count can be asserted directly instead of inferred from
# what survived a cut.
count_evidence_items() {
  local LC_ALL=C line
  local -i n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if is_evidence_item_line "$line"; then n=$(( n + 1 )); fi
  done <<< "${1-}"
  printf '%d' "$n"
}

# The source_ids of the rendered evidence items in a block, one per line, in order.
# `- [pending][NT:notes/a.md] text` -> `NT:notes/a.md`. An item with no source_id
# (`- [accepted] text`) contributes nothing: there is no citation to name.
#
# Reads the SAME lines `is_evidence_item_line` accepts, which is what makes it safe to
# run over a BUDGETED block: a citation appears here iff its item header survived the
# cut, so this is the delivered set and not the selected one.
evidence_item_citations() {
  local LC_ALL=C line rest
  while IFS= read -r line || [[ -n "$line" ]]; do
    is_evidence_item_line "$line" || continue
    rest="${line#- \[}"
    rest="${rest#*\]}"
    case "$rest" in
      '['*) rest="${rest#\[}"; case "$rest" in *']'*) printf '%s\n' "${rest%%]*}" ;; esac ;;
    esac
  done <<< "${1-}"
}

# THE INLINE CEILING, resolved in ONE place. Past it Claude Code writes the whole
# additionalContext to <session>/tool-results/hook-*-additionalContext.txt and injects a
# ~2KB <persisted-output> preview in its place, so the floor rules, the evidence and the
# tail are ALL lost, not merely the overrun. Measured 2026-08-06: the host counts JS
# String.length and the bracket is (9,991, 10,108] UTF-16 units / (10,015, 10,119] bytes.
# 9,500 BYTES is the conservative reading of that (bytes >= utf16 units >= codepoints for
# all input, so a byte budget can never under-count what the host will).
#
# Callers had this expression inline with the same default; a budget spelled twice is a
# budget that drifts. Override with MEETLESS_INLINE_CONTEXT_CEILING.
#
# Lives HERE rather than in user-prompt-submit.sh (moved 2026-08-12) because
# `evidence_budget_bytes` below derives from it and has two readers on two sides of a
# network call. A ceiling in the hook and a budget in the library would be the same
# split-brain the budget itself is being consolidated to avoid.
inline_ceiling() {
  local c="${MEETLESS_INLINE_CONTEXT_CEILING:-9500}"
  [[ "$c" =~ ^[0-9]+$ ]] || c=9500
  printf '%s' "$c"
}

# The evidence transport budget in UTF-8 BYTES, derived from the head that precedes it.
# Prints `<budget> <floored 0|1>`.
#
# ONE FORMULA, TWO READERS, and that is the entire reason this is a function. G1 sends
# the budget to intel BEFORE the request so the composer can size its projection to the
# pipe (an internal design note:
# median composed 12,193B into a median transport of 1,209B, 85.9% of turns unable to
# carry half). The same number then bounds the post-response cut. Two copies of this
# arithmetic would agree on the day they were written and drift silently afterwards,
# and a request-time budget that disagrees with the cut is worse than none: the composer
# would size to a pipe that does not exist.
#
# THE TERMS.
#   ceiling  the host's inline limit (see `inline_ceiling`). Past it Claude Code
#            persists the WHOLE additionalContext and injects a ~2KB preview, so the
#            floor rules, the evidence and the tail are all lost, not merely the overrun.
#   head     what is already committed to the payload (static grounding + floor rules +
#            matched scoped rules). Passed in, because the two callers read it at
#            different moments: pre-request from the assembled head, post-response from
#            OUTPUT_ACC. Both are the same bytes; `evidence-budget-on-the-wire.spec.ts`
#            pins that they agree.
#   411      the evidence envelope's own wrapper chrome.
#   1400     the reserve for blocks built AFTER the evidence block (governance, steer,
#            reconcile, active-review, turn-recap). Measured over 127 real
#            evidence-carrying injections: p50 363, p90 394, p99 837, max 1,161, and 0
#            of 127 exceeded 1,200. This is that max plus a block's worth of slack, and
#            it is why the request-time number is a TARGET and the cut is the
#            enforcement: the tail can still move the close by ~1.2KB.
#
# 8600 never grows: a tiny head must not license a payload a future ceiling change would
# persist anyway. 1200 is the floor, and crossing it is a fact worth reporting rather
# than silently absorbing -- 48.4% of evidence turns sit on it, and the second field is
# how `evidence_floored` learns which ones were pushed there.
#
# BYTES, deliberately, and the unit is the one thing here that must not be re-derived.
# The host counts JS String.length (UTF-16 units); the measured bracket is
# (9,991, 10,108] units / (10,015, 10,119] bytes. Since utf8_bytes >= utf16_units >=
# codepoints for ALL input, a byte budget can never under-count what the host will.
# `ctx_bytes` is the counter, and `max_evidence_bytes` on the wire carries this number.
_MLA_EVIDENCE_ENVELOPE_CHROME=411
_MLA_EVIDENCE_TAIL_RESERVE=1400
_MLA_EVIDENCE_MIN=1200
_MLA_EVIDENCE_MAX=8600
evidence_budget_bytes() {
  local head_b="${1-}" ceiling
  # A non-numeric head is treated as zero rather than injected into arithmetic, where
  # bash would either error under `set -e` or silently evaluate it as 0 anyway. Zero is
  # the conservative reading: it yields the historical cap, never an oversized budget.
  [[ "$head_b" =~ ^[0-9]+$ ]] || head_b=0
  ceiling="$(inline_ceiling)"
  local -i b=$(( ceiling - head_b - _MLA_EVIDENCE_ENVELOPE_CHROME - _MLA_EVIDENCE_TAIL_RESERVE ))
  local floored=0
  (( b > _MLA_EVIDENCE_MAX )) && b=$_MLA_EVIDENCE_MAX
  if (( b < _MLA_EVIDENCE_MIN )); then
    b=$_MLA_EVIDENCE_MIN
    floored=1
  fi
  printf '%s %s' "$b" "$floored"
}

# Distribute a byte budget across the RENDERED ITEMS of an evidence block, instead of
# cutting the block once at the end. Prints the budgeted markdown and nothing else.
#
# It reports no "did I cut?" flag ON PURPOSE. Callers invoke it through `$( )`, which
# is a subshell, so any global it assigned would be invisible at the call site: a flag
# here would read as instrumentation and behave as a constant. The caller already knows
# -- it only calls this when the block overflowed, and the output never exceeds the
# budget, so something was always cut.
#
# THE DEFECT (session 6ab21c5e turn 2, 2026-08-07). Two items were delivered. Item 1
# (an irrelevant implementation log) got a long chunk, item 2 (the on-point sibling
# audit) was cut mid-word:
#
#     Reviewed and approved with two corre[...truncated by Meetless...]
#
# One cut, at the end, against a byte ceiling. There was no per-item share, so a
# lower-ranked item that happens to serialize first starves the item that mattered.
# Item order here is RETRIEVAL order, not relevance order, so "first" carries no claim
# that it deserved the whole budget.
#
# THE RULE: reserve a share for every item still to come, THEN let the current item
# spend whatever is left. That is not "cap everyone at budget/n": a naturally short
# item returns its unused share to the pool, so a two-item turn whose first item is
# tiny still hands the second item almost the whole budget. Only an item that would
# have starved a later one pays.
#
# SEGMENTATION. A rendered item is a line `is_evidence_item_line` accepts. Every
# non-item line rides at the FRONT of the segment it introduces, never the back, so a
# cut (which always takes the tail) can eat an item's snippet but never the group
# header of the band that FOLLOWS it. Mislabeling pending evidence as governed is the
# one failure this must not produce.
#
# Two deliberate fallbacks to the single global cut, both of which are today's
# behavior byte for byte:
#   - no item lines at all (synthesis-only markdown): nothing to share between.
#   - more items than the budget can floor: with a share below MIN, per-item fairness
#     is meaningless and every segment would be marker and no content.
budget_evidence_markdown() {
  local md="$1" max="$2"
  # Trailing newline included. Without it the marker and the NEXT segment's item line
  # run together (`[...truncated by Meetless...]- [pending][NT:...]`), which stops the
  # item reading as a list entry to the model and to every `^- \[` scanner downstream.
  local marker=$'\n[...truncated by Meetless...]\n'
  # The smallest share worth reserving: an item line's own chrome
  # (`- [accepted][NT:an internal design note] `) is ~40 bytes, so this leaves ~200 for
  # the snippet. Below it the reservation buys a citation with no evidence attached.
  local -i min_share=240

  local -i total; total="$(ctx_bytes "$md")"
  (( total <= max )) && { printf '%s' "$md"; return 0; }

  # AN ITEM IS NOT A LINE. A retrieved snippet is a chunk of a note, so it carries
  # newlines: headings, table rows, code fences, blank lines. The first cut of this
  # segmented on "one item = one line", passed every single-line test, and did nothing
  # at all on a real payload -- measured live on trace 4d10460d, two items selected and
  # one delivered, with 20,907 bytes of item 1 sitting in what the budgeter believed
  # was item 2's segment and getting cut along with item 2's only line.
  #
  # So: find the item lines, and let each segment run from its item line through every
  # continuation line up to the NEXT item line.
  local -a lines=()
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do lines+=("$line"); done <<< "$md"
  local -a item_idx=()
  local -i i
  for (( i = 0; i < ${#lines[@]}; i++ )); do
    # `if`, not `&&`: this file runs under `set -e`, where a bare `pred && act` list
    # that evaluates false is a failing statement and aborts the hook.
    if is_evidence_item_line "${lines[i]}"; then item_idx+=("$i"); fi
  done
  local -i n=${#item_idx[@]}

  local -i mlen; mlen="$(ctx_bytes "$marker")"
  if (( n == 0 || max / n < min_share )); then
    # F3: boundary-safe here too. This fallback is not the rare path -- it takes every
    # single-item turn and every turn whose per-item share would be under the floor --
    # and it is where the measured `two corre[...]` cut actually happened.
    printf '%s%s' "$(cut_at_boundary "$md" $(( max > mlen ? max - mlen : 0 )))" "$marker"
    return 0
  fi

  # Where each segment BEGINS. An item's own line, except that a `[blank][Header:]` run
  # immediately before it is the header of the band this item OPENS, so it rides at the
  # front of THIS segment rather than at the tail of the previous one. That exact
  # three-line shape is what `_render_enrichment_markdown` emits between groups (blocks
  # joined by "\n\n", each opening with a label line ending in ':'). Keeping it here is
  # what stops a cut from eating the header and rendering pending evidence under the
  # accepted one, which is the only failure mode worse than losing an item.
  local -a starts=(0)
  local -i k s
  for (( k = 1; k < n; k++ )); do
    s=${item_idx[k]}
    if (( s >= 2 )) && [[ -z "${lines[s - 2]}" && "${lines[s - 1]}" == *: ]] && (( s - 2 > ${starts[k - 1]} )); then
      s=$(( s - 2 ))
    fi
    starts+=("$s")
  done

  local -a segs=()
  local -i end j
  local seg
  for (( k = 0; k < n; k++ )); do
    end=$(( k + 1 < n ? starts[k + 1] : ${#lines[@]} ))
    seg=""
    for (( j = ${starts[k]}; j < end; j++ )); do seg+="${lines[j]}"$'\n'; done
    segs+=("$seg")
  done

  local -i reserve=$(( max / n )) remaining=$max segb allow
  local out=""
  for (( i = 0; i < n; i++ )); do
    seg="${segs[i]}"
    segb="$(ctx_bytes "$seg")"
    # What this item may spend: everything left, minus the floor owed to each item
    # that has not been served yet.
    allow=$(( remaining - reserve * (n - 1 - i) ))
    (( allow < 0 )) && allow=0
    if (( segb <= allow )); then
      out+="$seg"
      remaining=$(( remaining - segb ))
    else
      # The marker is paid for INSIDE the allowance, so the sum of the parts is the
      # budget rather than the budget plus one marker per cut item.
      out+="$(cut_at_boundary "$seg" $(( allow > mlen ? allow - mlen : 0 )))$marker"
      remaining=$(( remaining - allow ))
    fi
  done
  printf '%s' "$out"
}

strip_harness_blocks() {
  local s="${1-}" tag close guard=0
  while [[ $guard -lt 8 ]]; do
    guard=$((guard + 1))
    s="${s#"${s%%[![:space:]]*}"}"
    case "$s" in
      '<task-notification>'*) tag="task-notification" ;;
      '<ide_'*) tag="${s#<}"; tag="${tag%%[ >]*}" ;;
      '<hint>'*|'<hint '*) tag="hint" ;;
      *) break ;;
    esac
    close="</$tag>"
    case "$s" in
      *"$close"*) s="${s#*"$close"}" ;;
      *) break ;;
    esac
  done
  printf '%s' "${s#"${s%%[![:space:]]*}"}"
}

classify_non_prompt() {
  local p="${1-}"
  # Classify what SURVIVES the harness blocks, not what leads the string. See the
  # 299-turn measurement above for why the leading token is the wrong key.
  local s
  s="$(strip_harness_blocks "$p")"
  case "$s" in
    # Nothing survived: the harness authored the whole turn.
    '') [[ -n "$p" ]] && { printf 'harness_event'; return 0; }; return 0 ;;
    # Stripping made no progress, so the block never closed. Same reading.
    '<task-notification>'*|'<ide_'*|'<hint>'*|'<hint '*) printf 'harness_event'; return 0 ;;
  esac
  if [[ "$s" =~ ^/[A-Za-z][A-Za-z0-9_:-]*([[:space:]]|$) ]]; then
    printf 'slash_command'
    return 0
  fi
  return 0
}

# The activation root in BOTH spellings, assigned to two caller-named variables.
#
# TWO roots, not one, and the second is not paranoia. `git rev-parse` always answers
# with the PHYSICAL path (symlinks resolved) while the agent host hands post-tool-use
# the LOGICAL path the operator actually works in. Any project reached through a
# symlink (`~/work` -> `/Volumes/dev/work`, or any macOS path under /tmp, where /tmp
# itself is a link to /private/tmp) would then match neither root, every path would be
# dropped, and the reader would go silently empty.
#
# Extracted 2026-08-10 for the peer-overlap scan below. `_touched_files_scan`'s own
# comment already named the risk of a second copy ("the two spellings of the root, the
# symlink fallback and the reverse-then-dedupe order are exactly the details that drift
# apart when they are written twice"), and the overlap scan needs the identical
# resolution: it compares ABSOLUTE paths across sessions, so a root this reader spells
# differently from that one is a missed collision.
#
# Assigns through `eval` on caller-supplied variable NAMES rather than printing two
# lines, because the values are paths and a path is the one thing a newline-delimited
# protocol cannot carry unambiguously. bash 3.2 compatible on purpose: `local -n` is
# 4.3+, and nothing else in this hook layer uses a bash-4 feature.
#   _read_activation_root_pair <dir> <root_var> <root_alt_var>
# Every local here is `_arp_`-prefixed on purpose. bash locals are DYNAMICALLY scoped,
# so a local named `root` would shadow the caller's `root` and the `eval` below would
# assign to this frame instead of theirs -- silently, and only for callers who happened
# to pick the obvious variable name.
_read_activation_root_pair() {
  local _arp_dir="${1:-$PWD}" _arp_rv="$2" _arp_av="$3"
  local _arp_root _arp_alt _arp_phys _arp_suffix
  _arp_root="$(git -C "$_arp_dir" rev-parse --show-toplevel 2>/dev/null || true)"
  _arp_alt=""
  if [[ -n "$_arp_root" ]]; then
    # Derive the LOGICAL spelling of the git top level from the caller's $dir:
    # take the part of the physical cwd below the physical top level and strip
    # that same tail off $dir. Exact, and it costs one subshell.
    _arp_phys="$(cd "$_arp_dir" 2>/dev/null && pwd -P || true)"
    if [[ -n "$_arp_phys" && "$_arp_phys" == "$_arp_root"* ]]; then
      _arp_suffix="${_arp_phys#"$_arp_root"}"
      _arp_alt="${_arp_dir%"$_arp_suffix"}"
    fi
  else
    _arp_root="$_arp_dir"
    _arp_alt="$(cd "$_arp_dir" 2>/dev/null && pwd -P || true)"
  fi
  _arp_root="${_arp_root%/}"
  _arp_alt="${_arp_alt%/}"
  [[ "$_arp_alt" == "$_arp_root" ]] && _arp_alt=""
  eval "$_arp_rv=\$_arp_root"
  eval "$_arp_av=\$_arp_alt"
  return 0
}

_touched_files_scan() {
  # ONE pass over the ledger, TWO answers, so they can never disagree:
  #
  #   line 1     the number of DISTINCT paths dropped for lying outside the
  #              activation root (0 when there is nothing to report);
  #   lines 2..N the kept paths, root-relative, deduped, most-recent-first.
  #
  # Split out of `collect_touched_files` for F3 (2026-08-07). The alternative was a
  # second function with its own copy of the root resolution below, and the two
  # spellings of the root, the symlink fallback and the reverse-then-dedupe order are
  # exactly the details that drift apart when they are written twice. The count is a
  # by-product of the filter that produces the list; deriving it anywhere else means
  # deriving it differently.
  local sid="${1:-${SESSION_ID:-}}"
  local dir="${2:-$PWD}"
  [[ -n "$sid" ]] || { printf '0\n'; return 0; }
  local ledger="$QUEUE_DIR/$sid.touched"
  [[ -s "$ledger" ]] || { printf '0\n'; return 0; }
  # SCOPE: ONE ACTIVATION ROOT, and this is the contract, not an accident of using git.
  #
  # `.meetless.json` marks the workspace and `meetless_activated` takes the NEAREST one
  # walking up from the hook's cwd. On a repo that carries its own marker the activation
  # root and the git top level are the same directory, so scoping here to the git top level
  # IS the activation boundary. A sibling repo under the same umbrella carries its own
  # marker, is its own activation root, and runs its own hook; carrying its files here would
  # attribute one root's edits to another and would send paths from a directory this session
  # never activated.
  #
  # STATED CONTRACT, for anyone reading a thin feed and wondering what it claims:
  #
  #   Session-local context covers activity within the ACTIVE MLA workspace root. Work
  #   performed through sibling workspace activations is reported by those workspaces
  #   independently.
  #
  # The consequence is a legitimately EMPTY feed when a session's work happened elsewhere,
  # and it is not starvation. Session d629ac1c did all its work in a sibling repo, the notes
  # vault and a scratchpad, so touched_files was [], `session_local` had nothing that could
  # escape intel's self-echo guard, and the 2026-08-06 audit filed the boundary as a bug.
  # Naming it here is the fix; see session-local-scope-contract.spec.ts, which pins it.
  #
  # OMISSION MARKER (F3, 2026-08-07). This block used to end "no omission marker is
  # emitted when part of a session's work happened elsewhere", on the reasoning that a
  # marker needs a field on the wire and is only owed if the product claims to summarize
  # a session ACROSS activation roots. The reasoning covered the EMPTY case and not the
  # PARTIAL one, and partial is the case that misleads. Session 770058c5 held 14 distinct
  # paths, 2 inside this root and 12 outside, and the block rendered the two with no
  # signal that 86% was missing; both survivors had been touched in turn 1, so by turn 4
  # they were the least representative pair available. `(none)` tells a reader to
  # discount the field. Two plausible source files tell them nothing.
  #
  # What is emitted is a COUNT and never a path, so nothing crosses the boundary the
  # contract protects, and it rides in the LAYER 1 DISPLAY STRING only. No new wire
  # field, no schema change: the debt named above is still not taken on, because the
  # product still does not claim to summarize across roots. It just stops implying it.
  #
  # Resolve the scope root once. Prefer the git top level so the emitted paths
  # match what collect_dirty_working_tree would emit for the same file; fall back
  # to $dir when this is not a git tree (a marker-only activation still governs).
  #
  # TWO roots, not one, and the second is not paranoia. `git rev-parse` always
  # answers with the PHYSICAL path (symlinks resolved) while the agent host hands
  # post-tool-use the LOGICAL path the operator actually works in. Any project
  # reached through a symlink (`~/work` -> `/Volumes/dev/work`, or any macOS
  # path under /tmp, where /tmp itself is a link to /private/tmp) would then match
  # neither root, every path would be dropped, and touched_files would go silently
  # empty. Silent-and-empty is precisely the failure mode this whole function
  # exists to remove, so we accept a match against either spelling of the root.
  local root="" root_alt=""
  _read_activation_root_pair "$dir" root root_alt
  awk -v root="$root/" -v root_alt="$root_alt" '
    # Reverse then dedupe, so the survivor of a repeated path is its MOST
    # RECENT touch and the head-cap in collect_touched_files keeps the freshest
    # surfaces.
    { a[NR] = $0 }
    END {
      if (root_alt != "") root_alt = root_alt "/"
      omitted = 0
      kept_n = 0
      for (i = NR; i > 0; i--) {
        p = a[i]
        if (p == "") continue
        if (substr(p, 1, 1) == "/") {
          if (index(p, root) == 1) {
            p = substr(p, length(root) + 1)
          } else if (root_alt != "" && index(p, root_alt) == 1) {
            p = substr(p, length(root_alt) + 1)
          } else {
            # OUTSIDE the activation root. Deduped on its own keyspace: the
            # ledger records one line per touch, so a sibling file edited nine
            # times is one omitted PATH, not nine. Counted here and nowhere
            # else, because this is the only line that knows it happened.
            if (!outside[p]++) omitted++
            continue
          }
        }
        if (p == "" || seen[p]++) continue
        kept[++kept_n] = p
      }
      print omitted
      for (i = 1; i <= kept_n; i++) print kept[i]
    }
  ' "$ledger" 2>/dev/null || printf '0\n'
  return 0
}

collect_touched_files() {
  local sid="${1:-${SESSION_ID:-}}"
  local dir="${2:-$PWD}"
  local max="${MEETLESS_TOUCHED_FILES_MAX:-50}"
  command -v jq >/dev/null 2>&1 || { printf '[]'; return 0; }
  local files
  # `tail -n +2` drops the omission count that leads the scan. It reads its input
  # to completion, so the producer is never SIGPIPEd out from under `pipefail`.
  files="$(_touched_files_scan "$sid" "$dir" | tail -n +2 | head -n "$max")"
  [[ -z "$files" ]] && { printf '[]'; return 0; }
  printf '%s' "$files" | jq -R -s -c 'split("\n") | map(select(length > 0))' 2>/dev/null || printf '[]'
  return 0
}

count_touched_files_omitted() {
  # DISTINCT paths this session touched OUTSIDE the activation root. Display only
  # (Layer 1); never sent, never a path. Always a non-negative integer, never the
  # empty string: blank would render as "(+ outside this workspace root)", and a
  # malformed marker is worse than the silence it replaces.
  #
  # Read with an END-block awk rather than `head -n 1` on purpose. `head` exits
  # after the first line and SIGPIPEs the producer, which under `set -o pipefail`
  # in a command substitution is a non-zero status on the enrich hot path.
  local n
  n="$(_touched_files_scan "${1:-${SESSION_ID:-}}" "${2:-$PWD}" | awk 'NR == 1 { v = $0 } END { print (v == "" ? "0" : v) }')"
  case "$n" in
    '' | *[!0-9]*) n=0 ;;
  esac
  printf '%s' "$n"
  return 0
}

# ---- F1: cross-session touched-file overlap ------------------------------
#
# WHAT HAPPENED. On 2026-08-09 at 16:00:11 a peer session created `src/hook-entry.ts`.
# At 16:01:56 and 16:02:11 another session created `src/redact-entry.ts` and
# `src/assemble-entry.ts`. Same repository, same hook, same latency defect, same
# three-transport design, two minutes apart. Four of five paths in common, sitting in
# two plain-text files side by side in `~/.meetless/queue/`. Nothing read the second
# file. The collision was found forty minutes later by running `git status`.
#
# WHY NOTHING LOOKED, and why the obvious fix is the wrong one. The signal that would
# have caught it was the git working-tree delta, and it was deliberately removed on
# 2026-07-27 (see `collect_touched_files`): in a shared checkout it injected a peer's
# uncommitted work as "the surfaces the agent is actually modifying". That fix was
# right and is not being reverted. Attribution must stay exact. What this adds is a
# SECOND, SEPARATELY LABELLED signal that never merges into the first: `touched_files`
# remains only what this session touched, and a peer path never appears in it.
#
# THE IDENTITY PREDICATE IS THE ABSOLUTE PHYSICAL PATH, and that is the whole reason
# this is safe to compute. `record_touched_file` resolves every path through `pwd -P`
# before appending, so two ledgers naming the same string name the same file on this
# machine. The same relative path in a different checkout, or in an independent git
# worktree of the SAME repository, is a different absolute path and is therefore NOT
# reported. A worktree is the case that looks most like a collision and is not: two
# agents editing `src/seed.ts` in two worktrees are editing two different files.
# Anything outside this session's activation root is dropped too, on the same scope
# contract `_touched_files_scan` states.
#
# WHAT IT CLAIMS, EXACTLY. That another session WROTE a file this session also wrote,
# recently. Not that it is editing it now, not that it is still running, not that the
# work is duplicated. A touched path is not an intent, and on a 143KB shared file the
# common case is two sessions doing unrelated things. The block reports the fact and
# names its own recency; it is not a lock, a reservation, a severity, or a gate.
#
# WHY RECENCY IS LOCAL AND NOT THE CANONICAL LIVENESS. control has one
# (`deriveLiveness`, LIVE_WINDOW_MS 5min / ABANDONED_AFTER_MS 24h) but it is derived
# server-side from ingested `lastSeenAt`, and this runs on the prompt hot path with no
# network. The local `.hb` sidecar is a THROTTLE timestamp for `heartbeat_flush`, not
# a liveness record, and reading "is active" off a throttle is the kind of over-claim
# this corpus has already paid for twice. The ledger's own mtime is the exact time the
# peer last touched a file, which is precisely the event being reported, so that is
# what gates it -- and the wording says "recently", never "active".

# The recency window for a peer ledger, in minutes. A CONSTANT and deliberately not a
# setting: a knob here would let a noisy block look configured-away instead of fixed,
# and the number is a claim the block's own text makes out loud.
_MLA_PEER_OVERLAP_WINDOW_MINS=90
# How many overlapping paths the rendered block names before it summarizes the rest.
_MLA_PEER_OVERLAP_MAX_PATHS=6

# Per-session record of the (peer, path) pairs already reported. Same
# `<area>/<name>-<sid>` shape as the delivered/inject/steer sidecars.
peer_overlap_notified_file() { printf '%s/overlap/notified-%s.tsv' "$LOG_DIR" "$1"; }

# The NEW (peer session, path) pairs, one `<peer_sid>\t<root-relative path>` per line,
# most-recently-touched-by-THIS-session first. Prints nothing and ALWAYS returns 0 when
# there is nothing to say or anything at all goes wrong: an absent queue, an absent or
# empty ledger on either side, a peer ledger that is unreadable, malformed, half-written
# by a concurrent append, or reaped between the directory listing and the read.
collect_peer_overlap() {
  local sid="${1:-${SESSION_ID:-}}"
  local dir="${2:-$PWD}"
  [[ -n "$sid" ]] || return 0
  [[ -d "$QUEUE_DIR" ]] || return 0
  local mine="$QUEUE_DIR/$sid.touched"
  # No ledger of our own means no intersection to take. This is the common case on the
  # first turns of a session and must cost nothing.
  [[ -s "$mine" ]] || return 0

  local root="" root_alt=""
  _read_activation_root_pair "$dir" root root_alt
  [[ -n "$root" ]] || return 0

  # ELIGIBLE PEERS: `-type f` so a dangling symlink (the same observable state as a
  # ledger reaped mid-scan) is never handed to the parser, and `-mmin` so a ledger that
  # has not moved inside the window is not read at all. One process, and on a healthy
  # box it returns a handful of paths out of the ~40 sessions on disk.
  local peers_n=0
  local peers
  peers=()
  local f
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    [[ "$f" != "$mine" ]] || continue
    [[ -f "$f" && -r "$f" && -s "$f" ]] || continue
    peers[$peers_n]="$f"
    peers_n=$(( peers_n + 1 ))
  done < <(find "$QUEUE_DIR" -maxdepth 1 -type f -name '*.touched' \
             -mmin "-$_MLA_PEER_OVERLAP_WINDOW_MINS" 2>/dev/null || true)
  (( peers_n > 0 )) || return 0

  # Already-reported pairs. `/dev/null` rather than a missing path: awk aborts the whole
  # run on an unreadable operand, which would take the valid peers down with it.
  local already
  already="$(peer_overlap_notified_file "$sid")"
  [[ -f "$already" && -r "$already" ]] || already=/dev/null

  awk -v root="$root/" -v root_alt="$root_alt" -v mine="$mine" -v already="$already" '
    function rel(p) {
      if (substr(p, 1, 1) != "/") return ""
      if (index(p, root) == 1) return substr(p, length(root) + 1)
      if (root_alt != "" && index(p, root_alt) == 1) return substr(p, length(root_alt) + 1)
      return ""
    }
    function sid_of(f,   n, parts, b) {
      n = split(f, parts, "/")
      b = parts[n]
      sub(/\.touched$/, "", b)
      return b
    }
    BEGIN { if (root_alt != "") root_alt = root_alt "/" }
    FILENAME == already { if ($0 != "") suppressed[$0] = 1; next }
    # This session own ledger, read BEFORE any peer so the intersection is complete by
    # the time a peer line is judged. NR (not FNR) is the recency rank: monotonic across
    # the whole read, and a repeated path keeps its LAST touch, so the sort below puts
    # the freshest collision first.
    FILENAME == mine { p = rel($0); if (p != "") mypos[p] = NR; next }
    {
      p = rel($0)
      if (p == "" || !(p in mypos)) next
      s = sid_of(FILENAME)
      if (s == "") next
      key = s "\t" p
      if (key in suppressed || key in pair) next
      pair[key] = 1
      if (!(p in pathseen)) { pathseen[p] = 1; paths[++np] = p }
      plist[p] = plist[p] " " s
    }
    END {
      for (i = 2; i <= np; i++) {
        v = paths[i]; j = i - 1
        while (j >= 1 && mypos[paths[j]] < mypos[v]) { paths[j + 1] = paths[j]; j-- }
        paths[j + 1] = v
      }
      for (i = 1; i <= np; i++) {
        p = paths[i]
        n = split(plist[p], sids, " ")
        for (k = 1; k <= n; k++) if (sids[k] != "") print sids[k] "\t" p
      }
    }
  ' "$already" "$mine" "${peers[@]}" 2>/dev/null || true
  return 0
}

# The rendered block, or nothing. Records what it reported, so the same (peer, path)
# pair is never said twice to the same session -- and so a NEW peer on an
# already-reported path still surfaces, which is why the suppression key carries the
# peer id and not just the path.
#
# RECORDS ONLY WHAT IT RENDERS. Paths past the display cap are deliberately left
# unrecorded so they drain onto later turns instead of being silently swallowed by a
# "+N more" that named nobody.
#
# $3 is optional: a drop file for the pairs this call reported. The hook passes one and
# promotes it to the suppression ledger ONLY after the block actually reached the
# payload, because `append_optional_block` may decline it at the inline ceiling and a
# notice that was suppressed but never shown is the one outcome worse than silence.
# With no drop file the pairs are recorded immediately, which is what a direct caller
# (and every test of the suppression rule itself) wants.
build_peer_overlap_block() {
  local sid="${1:-${SESSION_ID:-}}"
  local dir="${2:-$PWD}"
  local drop="${3:-}"
  local pairs
  pairs="$(collect_peer_overlap "$sid" "$dir")"
  [[ -n "$pairs" ]] || return 0

  # ONE awk pass emits the rendered bullets (`L`), the pairs they account for (`K`), the
  # distinct peer count among them (`N`) and the number of paths held back (`H`), so the
  # block and the suppression ledger can never describe different sets.
  local rendered
  rendered="$(printf '%s\n' "$pairs" | awk -F'\t' -v max="$_MLA_PEER_OVERLAP_MAX_PATHS" '
    {
      if (!($2 in rank)) { rank[$2] = ++np; order[np] = $2 }
      if (!($0 in seenpair)) { seenpair[$0] = 1; pi[++pn] = $0 }
    }
    END {
      shown = (np < max ? np : max)
      for (i = 1; i <= pn; i++) {
        split(pi[i], f, "\t")
        if (rank[f[2]] > shown) continue
        cnt[f[2]]++
        dpeer[f[1]] = 1
        print "K\t" pi[i]
      }
      ns = 0
      for (s in dpeer) ns++
      print "N\t" ns
      print "H\t" (np - shown)
      for (i = 1; i <= shown; i++) {
        p = order[i]
        printf "L\t- %s (%d other session%s)\n", p, cnt[p], (cnt[p] == 1 ? "" : "s")
      }
    }
  ' 2>/dev/null || true)"
  [[ -n "$rendered" ]] || return 0

  local n_sessions n_hidden lines keys
  n_sessions="$(printf '%s\n' "$rendered" | awk -F'\t' '$1 == "N" { print $2 }')"
  n_hidden="$(printf '%s\n' "$rendered" | awk -F'\t' '$1 == "H" { print $2 }')"
  # substr($0, 3) strips the one-char tag and its tab. Not a sed `\t`, which BSD sed
  # does not read as a tab.
  lines="$(printf '%s\n' "$rendered" | awk -F'\t' '$1 == "L" { print substr($0, 3) }')"
  keys="$(printf '%s\n' "$rendered" | awk -F'\t' '$1 == "K" { print substr($0, 3) }')"
  [[ -n "$lines" ]] || return 0
  [[ "$n_sessions" =~ ^[0-9]+$ ]] || n_sessions=0
  [[ "$n_hidden" =~ ^[0-9]+$ ]] || n_hidden=0
  (( n_sessions > 0 )) || return 0

  # Agreement, spelled out rather than inferred. The sentence below makes a careful
  # claim about WHICH THING IS RECENT (the ledger, not the path), and a mis-agreeing
  # verb is the cheapest way to blur exactly that distinction back out of it.
  local plural="" tail=""
  local verb="has" ledger_noun="a file-activity ledger" that_ledger="that ledger" verb2="has"
  if (( n_sessions != 1 )); then
    plural="s"; verb="have"; ledger_noun="file-activity ledgers"; that_ledger="those ledgers"; verb2="have"
  fi
  # The bullets carry no timestamp, so this plural is about the LIST, not the window.
  local path_plural=""
  (( $(printf '%s\n' "$lines" | awk 'NF' | wc -l) == 1 )) || path_plural="s"
  (( n_hidden == 0 )) || tail="
+$n_hidden more path$( (( n_hidden == 1 )) || printf 's' ) overlap the same way; they are held back to keep this short and will be named on a later turn."

  # Record BEFORE returning when no drop file was given (see the header): the caller
  # then owns nothing, and a direct caller is by definition displaying what it asked for.
  if [[ -n "$drop" ]]; then
    printf '%s\n' "$keys" > "$drop" 2>/dev/null || true
  else
    record_peer_overlap_notified "$sid" "$keys"
  fi

  printf '%s' "<meetless-context kind=\"concurrent-sessions\">
$n_sessions other agent session$plural on this machine $verb $ledger_noun written within the last $_MLA_PEER_OVERLAP_WINDOW_MINS minutes, and $that_ledger $verb2 also touched the path$path_plural below. THE WINDOW BOUNDS THE LEDGER, NOT THE PATH: it says only that the session wrote SOMETHING recently, and a path listed here may have been written much earlier in that session. This is a record of file WRITES that already happened. It does NOT mean those sessions are still running, nor that anyone is editing these files now, nor that the work is duplicated; a shared file is often two unrelated edits. Same physical path only: a same-named file in another checkout or git worktree is not listed. These paths are NOT part of touched_files above, which stays exactly what this session touched.
$lines$tail
</meetless-context>"
  return 0
}

# Append reported (peer, path) pairs to this session's suppression ledger. Per-session
# file, so there is no cross-session contention and no lock: one `>>` of a few short
# lines. Never fails the caller.
#   record_peer_overlap_notified <sid> <pairs-text>
record_peer_overlap_notified() {
  local sid="${1:-}" pairs="${2:-}"
  [[ -n "$sid" && -n "$pairs" ]] || return 0
  local f
  f="$(peer_overlap_notified_file "$sid")"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  ml_private_file "$f"
  printf '%s\n' "$pairs" >> "$f" 2>/dev/null || true
  return 0
}

# ---- I4 session-local feed: the per-session recent-turn ledger ------------
#
# WHY THIS EXISTS. intel has shipped a `session_local` evidence provider since
# P0.3 (enrich_session_local.py) and it is the ONLY non-KB surface with a live
# provider (enrich_router_plan.py `_BUILT_NON_KB_SURFACES`). It reads the feed
# from the enrich REQUEST BODY only, never by cross-querying control-db (the
# two-DSN discipline). Its first act is:
#
#     has_feed = bool(recent_turns) or bool((changes_summary or "").strip())
#     if not has_feed: return SessionLocalResult(items=[], provider_available=False)
#
# and this hook never sent either field. So a built provider was structurally
# starved: every `session_report` turn resolved to NO_OFFER with reason
# `surface_provider_missing`, which reads in the trace like "intel has no
# provider for this" when the truth was "the client sent no feed". Measured
# 2026-07-28 over the local trace log: 46 of 138 diagnosable turns (33%) died
# here, and NONE of them could ever have succeeded.
#
# THE LEDGER. One line per turn, appended at UserPromptSubmit, in the same
# QUEUE_DIR/<session>.<kind> shape as the `.touched` ledger above. Deliberately
# NOT read from ask-traces.jsonl: that file is local analytics and is contracted
# never to be networked, so sourcing a wire payload from it would cross a stated
# boundary (and cost a 38MB scan on the hot path).
#
# WHAT WE HONESTLY KNOW at UserPromptSubmit is only the CURRENT turn's prompt and
# touched set. `assistant_summary` / `commands_run` / `outcome` belong to a turn
# that has not run yet, so they are recorded empty here and back-filled
# best-effort from the still-undrained capture spool by collect_recent_turns.
# `outcome` stays "unknown" rather than guessing: we do not track apply/revert,
# and a fabricated outcome would be laundered into the model as evidence.
#
# TRUST. The text written here is the REDACTED prompt (the caller passes
# ENRICH_Q, never $PROMPT), so the ledger never holds a secret the wire would
# not already carry. intel re-redacts on its side and frames every item as
# low-trust `derived_from_agent_session` evidence.
SESSION_TURNS_MAX_DEFAULT=3
# Longest sentence still credible as a REQUEST. Not a truncation budget: nothing is
# ever cut to fit it. A candidate longer than this is DISCARDED (see
# extract_user_goal), because a 400-character sentence is a paragraph that forgot
# its punctuation, not something an operator asked for.
SESSION_TURN_GOAL_CHARS=400

# ---- Deterministic request extraction (the `user_goal` of a turn) ----------
#
# WHAT THIS REPLACES. This function exists because the line here used to be:
#
#     goal="${goal:0:$SESSION_TURN_GOAL_CHARS}"
#
# the first 400 characters of the prompt, stored under the name "goal". On the
# prompt shape this workspace actually produces -- a short instruction paragraph,
# a `---`, and a pasted 17KB review document (in either order) -- that prefix is
# the DOCUMENT'S first paragraph, cut mid-word. Measured over the live ledger on
# 2026-08-06: 179 of 388 stored goals (46%) were at the 400-char cap, ended
# without terminal punctuation, spanned several lines, or opened with a markdown
# heading. intel's session_local provider then renders the string verbatim as
# `Prior session turn N (outcome: applied). Goal: <prefix>` and injects it as
# evidence, so the defect is inherited by every consumer downstream. The item
# served into session 5734f9de turn 8 was, verbatim:
#
#     Goal: # Verdict **Implementation is correct... but the
#
# THE RULE. Extract the operator's REQUEST or emit NOTHING. There is no prefix
# fallback: a wrong extraction that looks intentional is worse than a prefix, and
# a prefix is worse than silence. `_render_turn` on the intel side already drops a
# turn whose fields are empty, and a goal-less turn still carries `touched_files`
# and `outcome`, which is the part of a session-local item that was ever useful.
#
# HOW. Deterministic, zero LLM, zero network, zero node spawn (this runs on the
# hot path, and the turn that already timed out this session did not have 200ms of
# node startup to spare). One awk pass:
#
#   1. SECTION. A markdown horizontal rule is a section break. Sections are then
#      scanned LAST to FIRST, so "the final instruction section" wins whichever
#      side of the rule the operator put it on. A `---` directly under non-blank
#      text is a setext h2 underline, not a rule, and does not open a section.
#   2. ELIGIBILITY. Fenced and indented code, blockquotes, headings, tables, HTML
#      / harness tags, link-only lines and reference definitions are not places a
#      request lives. They are skipped as CANDIDATES (never edited, never
#      reordered). This is what keeps `Review coverage: 8 / 11` -- the only
#      sentence-initial "Review" in one real 17KB paste -- from becoming a goal.
#   3. TIER 1 first, everywhere, then tier 2. Tier 1 is the explicit request forms
#      (Help me / Please / Can you / Review / Implement / Investigate ...). Tier 2
#      is a plain imperative and fires ONLY when no tier-1 form exists anywhere in
#      the prompt; that ordering is why a pasted document ending in "Build that.
#      Delete the rest." cannot outrank the operator's own "Help me review ...".
#      The tier-1 verb list is deliberately SHORT for the same reason: every verb
#      added to it is a verb that can match prose inside a pasted document.
#   4. STANDING CONSTRAINTS are never a goal, at either tier: "Do not", "Avoid",
#      "Keep", "Always", "Never", "Make sure" describe how to work, not what was
#      asked. Checked BEFORE the tier match, so "Make sure" cannot enter through
#      tier 2's "make".
#   5. BOUNDS. The result is always a whole sentence (or a whole line when the
#      line has no terminal punctuation). Nothing is ever cut mid-word or
#      mid-sentence. Over-length candidates are dropped, not trimmed.
#
# Locked down by test/lib/goal-extraction.spec.ts against the real prompt shape.
# No apostrophes in the awk program below: the whole thing is single-quoted in
# bash, so `don.?t` is how "don t" is spelled here.
extract_user_goal() {
  local text="${1:-}"
  [[ -n "$text" ]] || return 0
  command -v awk >/dev/null 2>&1 || return 0
  # LC_ALL=C IS LOad-BEARING, not hygiene. macOS ships BWK awk, which in a UTF-8
  # locale ABORTS the whole program on the first character it cannot convert:
  #
  #     awk: towc: multibyte conversion failure on: ...
  #
  # An types curly quotes and em dashes, so in practice that is EVERY real prompt.
  # The abort is rc=2 with empty stdout, which this function is contracted to
  # swallow, so the failure mode was a goal that silently vanished on exactly the
  # prompts the extractor exists for -- measured on two real 17KB prompts, both
  # returned "" before this line and the correct sentence after it. In the C
  # locale awk treats the input as bytes and passes non-ASCII through untouched;
  # every cut point below (`.` `!` `?`, ASCII whitespace) is single-byte, so no
  # multi-byte character can be split by a byte-wise substr.
  printf '%s\n' "$text" | LC_ALL=C awk -v cap="${SESSION_TURN_GOAL_CHARS:-400}" '
    function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }

    # "" unless the sentence is a request at this tier. Constraints lose first.
    function classify(sent, tier,   lc, w) {
      sent = trim(sent)
      if (sent == "") return ""
      # A literal backslash-n means this text is ESCAPED DATA that was pasted in
      # (a JSON blob, a log line, a captured summary), so its "lines" are not
      # lines and none of the block analysis above applies to it. Measured on 80
      # real prompts: this is how a three-paragraph fragment of a pasted document
      # arrived looking like one tidy sentence.
      if (index(sent, "\\n") > 0) return ""
      # An ellipsis is an elision, so the sentence is not complete, and a
      # one-word sentence ("Fix...", "Go!") states no goal worth injecting.
      if (sent ~ /\.\.\.[^a-zA-Z0-9]*$/) return ""
      w = split(sent, WORDS, /[ \t]+/)
      if (w < 2) return ""
      lc = tolower(sent)
      if (lc ~ CON) return ""
      if (tier == 1) { if (lc ~ T1) return sent; return "" }
      if (tier == 2) { if (lc ~ T2) return sent; return "" }
      if (lc ~ T3) return sent
      return ""
    }

    # First request in one cleaned line, split at sentence boundaries only.
    function first_request(c, tier,   L, i, ch, nxt, start, sent, res) {
      L = length(c); start = 1
      for (i = 1; i <= L; i++) {
        ch = substr(c, i, 1)
        if (ch != "." && ch != "!" && ch != "?") continue
        nxt = (i < L) ? substr(c, i + 1, 1) : ""
        if (i < L && nxt != " " && nxt != "\t") continue
        # "e.g." / "i.e." / a lone initial: a single letter before the dot that is
        # itself preceded by a dot or a space is an abbreviation, not a sentence end.
        if (i >= 2 && substr(c, i - 1, 1) ~ /[A-Za-z]/ &&
            (i == 2 || substr(c, i - 2, 1) ~ /[ \t.]/)) continue
        sent = substr(c, start, i - start + 1)
        res = classify(sent, tier)
        if (res != "") return res
        start = i + 1
        while (start <= L && substr(c, start, 1) ~ /[ \t]/) start++
      }
      if (start <= L) {
        res = classify(substr(c, start), tier)
        if (res != "") return res
      }
      return ""
    }

    BEGIN {
      # T1: an unambiguous SECOND-PERSON ask. Only a person addressing the agent
      # writes these, so they cannot be prose inside a pasted document.
      T1 = "^(help me|help us|please|can you|could you|would you|will you|i need you to|i want you to|i would like you to)([^a-z0-9_]|$)"
      # T2: the named request VERBS. Ranked below T1 rather than beside it, because
      # measured on the real 17,685-char prompt they are not unambiguous: the pasted
      # review document contained the list item "- Review coverage will vary by
      # team.", which is a sentence ABOUT review, and at one tier it outranked the
      # operator own line "Help me review the proposal(s)." two sections above.
      T2 = "^(review|implement|investigate)([^a-z0-9_]|$)"
      CON = "^(do not|don.?t|avoid|keep|always|never|make sure|ensure|note that|remember|stay|only|instead|prefer)([^a-z0-9_]|$)"
      T3 = "^(fix|add|build|create|write|update|refactor|remove|delete|rename|migrate|debug|diagnose|analyze|analyse|explain|document|design|check|verify|test|run|proceed|continue|draft|summarize|summarise|compare|audit|trace|measure|extract|generate|integrate|wire|ship|land|commit|revert|split|merge|apply|finish|complete|make|rewrite|replace|move|port|enable|disable|instrument|benchmark|profile|optimize|optimise|simplify|harden|address|resolve|triage|improve|extend|deploy|release|publish|install|configure|handle|find|search|read|open|start|stop|restart|bump|revisit|look|figure|tell|show|give|walk)([^a-z0-9_]|$)"
      n = 0; sec = 0; maxsec = 0; fence = 0; prevblank = 1
    }

    {
      n++
      line = $0; sub(/\r$/, "", line)
      t = line; sub(/^[ \t]+/, "", t)
      indent = length(line) - length(t)
      bare = t; gsub(/[ \t]/, "", bare)
      e = 1

      if (t ~ /^```/ || t ~ /^~~~/) { fence = 1 - fence; e = 0 }
      else if (fence) { e = 0 }
      else if (indent <= 3 && (bare ~ /^---+$/ || bare ~ /^\*\*\*+$/ || bare ~ /^___+$/)) {
        e = 0
        if (bare ~ /^---+$/ && n > 1 && prevblank == 0) { elig[n - 1] = 0 }   # setext h2
        else { sec++ }
      }
      else if (t == "") { e = 0 }
      else if (substr(line, 1, 4) == "    " || substr(line, 1, 1) == "\t") { e = 0 }
      else if (t ~ /^#/) { e = 0 }
      else if (t ~ /^>/) { e = 0 }
      else if (t ~ /^\|/) { e = 0 }
      else if (t ~ /\|/ && t ~ /^[-:| \t]+$/) { e = 0 }
      else if (t ~ /^</) { e = 0 }
      else {
        c = t
        sub(/^[-*+][ \t]+/, "", c)
        sub(/^[0-9]+[.)][ \t]+/, "", c)
        sub(/^\[[ xX]\][ \t]+/, "", c)
        gsub(/\*\*/, "", c)
        gsub(/`/, "", c)
        c = trim(c)
        if (c == "") { e = 0 }
        else if (c ~ /^\[[^]]*\]:/) { e = 0 }                       # link reference definition
        else if (c ~ /^<?https?:\/\/[^ ]*>?$/) { e = 0 }            # bare URL
        else if (c ~ /^\[[^]]*\]\([^)]*\)$/) { e = 0 }              # link-only line
        else { txt[n] = c }
      }
      elig[n] = e
      secof[n] = sec
      prevblank = (t == "") ? 1 : 0
      if (sec > maxsec) maxsec = sec
    }

    END {
      for (tier = 1; tier <= 3; tier++) {
        for (s = maxsec; s >= 0; s--) {
          for (i = 1; i <= n; i++) {
            if (secof[i] != s || !elig[i] || !(i in txt)) continue
            g = first_request(txt[i], tier)
            # Too long to be a request: drop it and keep looking. Never trim.
            if (g != "" && length(g) <= cap) { print g; exit }
          }
        }
      }
    }
  ' 2>/dev/null || true
  return 0
}

# Append ONE turn record to the ledger. Best-effort: any failure is silent and
# non-fatal (the feed degrades to "fewer turns", never to a broken hook).
# $1 = session id, $2 = turn index, $3 = turn id, $4 = the REDACTED PROMPT TEXT.
#
# $4 is the prompt, NOT a goal: the goal is DERIVED from it here by
# extract_user_goal. Callers must pass the FULL redacted text, not the
# middle-truncated wire `question` -- the instruction section is routinely the
# part the wire cut drops, and extracting from the cut text would rebuild the
# original defect one layer down.
record_session_turn() {
  local sid="${1:-}" turn="${2:-0}" turn_id="${3:-}" text="${4:-}" goal=""
  command -v jq >/dev/null 2>&1 || return 0
  [[ -n "$sid" ]] || return 0
  # No prompt at all is nothing to record. An empty GOAL is NOT the same thing:
  # the turn still happened and still carries touched_files / outcome, which is
  # the half of a session-local item that was ever worth injecting, so a
  # goal-less turn is written with `user_goal: ""` and left for intel to judge.
  [[ -n "$text" ]] || return 0
  # --argjson below is strict: a non-numeric sequence would abort the jq call and
  # silently drop the turn. Coerce instead, so a caller passing a weird index
  # costs us the ordinal, not the record.
  [[ "$turn" =~ ^[0-9]+$ ]] || turn=0
  [[ -n "$turn_id" ]] || turn_id="${sid}:${turn}"
  goal="$(extract_user_goal "$text")"
  local ledger="$QUEUE_DIR/$sid.turns"
  local line
  line="$(jq -c -n --arg id "$turn_id" --argjson seq "${turn:-0}" --arg goal "$goal" \
    '{turn_id: $id, sequence: $seq, user_goal: $goal}' 2>/dev/null || true)"
  [[ -n "$line" ]] || return 0
  printf '%s\n' "$line" >>"$ledger" 2>/dev/null || true
  # Bound the file so a long-lived session cannot grow it without limit. Keep a
  # generous tail (far more than we ever send) so the trim is rare.
  local keep=200 count
  # BSD `wc -l` pads its count with leading spaces, so an un-stripped value fails
  # the numeric guard below and the bound silently becomes dead code on macOS
  # (caught by intercept-recent-turns.spec.ts, which is why the guard is tested).
  count="$(wc -l <"$ledger" 2>/dev/null | tr -cd '0-9' || printf 0)"
  if [[ "$count" =~ ^[0-9]+$ ]] && (( count > keep * 2 )); then
    local tmp="$ledger.tmp.$$"
    if tail -n "$keep" "$ledger" >"$tmp" 2>/dev/null; then
      mv -f "$tmp" "$ledger" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
    else
      rm -f "$tmp" 2>/dev/null || true
    fi
  fi
  return 0
}

# Emit the `recent_turns` array for the enrich body: the last N COMPLETED turns,
# freshest first, in intel's RecentTurnSummary shape. Prints `[]` when there is
# no usable feed, which the caller treats as "omit the field" (compat 6.2:
# absent == today's prompt-only behavior).
#
# The current turn is NOT in the ledger yet (record_session_turn runs after the
# enrich body is built), so a turn is never its own evidence.
collect_recent_turns() {
  local sid="${1:-${SESSION_ID:-}}"
  local max="${2:-${MEETLESS_RECENT_TURNS_MAX:-$SESSION_TURNS_MAX_DEFAULT}}"
  command -v jq >/dev/null 2>&1 || { printf '[]'; return 0; }
  [[ -n "$sid" ]] || { printf '[]'; return 0; }
  [[ "$max" =~ ^[0-9]+$ ]] || max="$SESSION_TURNS_MAX_DEFAULT"
  (( max > 0 )) || { printf '[]'; return 0; }
  local ledger="$QUEUE_DIR/$sid.turns"
  [[ -s "$ledger" ]] || { printf '[]'; return 0; }

  # Best-effort back-fill from the capture spool: it holds this session's
  # assistant narration and bash commands keyed by the SAME session id. The
  # spool is drained periodically, so treat a miss as normal, not an error.
  local spool="$QUEUE_DIR/$sid.jsonl"
  local narration="[]" commands="[]"
  if [[ -s "$spool" ]]; then
    narration="$(tail -n 400 "$spool" 2>/dev/null \
      | jq -s -c '[ .[] | select(.event == "assistant_message")
                    | (.payload.narration // "") | select(length > 0) ]' 2>/dev/null || printf '[]')"
    commands="$(tail -n 400 "$spool" 2>/dev/null \
      | jq -s -c '[ .[] | select(.event == "tool_used_bash")
                    | (.payload.command // "") | select(length > 0) ]' 2>/dev/null || printf '[]')"
  fi
  case "$narration" in '['*']') ;; *) narration="[]" ;; esac
  case "$commands" in '['*']') ;; *) commands="[]" ;; esac

  # The spool is not turn-indexed for these two events, so attribute the freshest
  # narration/commands to the freshest turn ONLY. Attaching them to every turn
  # would assert a join we cannot prove and would repeat the same text three times.
  local out
  out="$(tail -n "$max" "$ledger" 2>/dev/null \
    | jq -s -c --argjson narr "$narration" --argjson cmds "$commands" \
        --argjson tf "${TOUCHED_FILES_JSON:-[]}" '
      # A HEREDOC BODY IS DATA, NOT COMMANDS. Every signal below matches raw command
      # text, so a git subcommand written INSIDE a heredoc body (a commit message, a
      # doc, an example) would read as a USE of that subcommand (F1, An review
      # 2026-08-20). Strip heredoc bodies first, keeping the opener line (a real
      # `git commit -F - <<EOF` still counts) and every later command. This is the
      # bash/jq twin of analyze.py `_strip_heredocs`; an UNTERMINATED heredoc drops
      # everything after the opener, because the command was cut and what follows is
      # unknowable. Delimiter: `<<` / `<<-`, and an optional opening quote is matched
      # as a single non-word char (`[^ \tA-Za-z0-9_]?`) so `<<EOF`, `<<-EOF`, `<<"EOF"`
      # and `<<QUOTE EOF QUOTE` all resolve to the bare `EOF`, with no apostrophe
      # written into a program that is itself single-quoted in bash.
      def strip_heredocs:
        (. // "")
        | (. | split("\n")) as $lines
        | reduce $lines[] as $line (
            {out: [], delim: null};
            if .delim != null then
              (if (($line | sub("^[ \t]+"; "")) | sub("[ \t]+$"; "")) == .delim
               then .delim = null else . end)
            else
              (.out += [$line])
              | ([ $line | match("<<-?[ \t]*[^ \tA-Za-z0-9_]?([A-Za-z_][A-Za-z0-9_]*)"; "g") ]) as $m
              | (if ($m | length) > 0 then .delim = ($m[0].captures[0].string) else . end)
            end
          )
        | (.out | join("\n"));
      # A QUOTED ARGUMENT IS DATA TOO. Heredoc stripping does not touch a `-m "..."` message
      # or any other quoted span, so a git subcommand on a line-start INSIDE a multiline
      # quoted string is the same mention-vs-use defect in another representation (F1 second
      # ambiguity, An review 2026-08-26). Collapse every quoted span to `Q`, the jq twin of
      # analyze.py `_mask_quoted` (`_QUOTED_SPAN_RE`, single-quote-first); the class `[^X]*`
      # matches newlines, so a multiline span collapses whole -- a newline inside a quote is
      # then neither a statement boundary nor a place a signal can hide. Run AFTER
      # strip_heredocs (which needs the unmasked `<<QUOTE EOF QUOTE` delimiter). The quote
      # chars are built from codepoints (39=apostrophe, 34=double) so no literal quote is
      # written into this program, which is itself single-quoted in bash.
      def mask_quoted:
        ([39] | implode) as $sq
        | ([34] | implode) as $dq
        | gsub($sq + "[^" + $sq + "]*" + $sq + "|" + $dq + "[^" + $dq + "]*" + $dq; "Q");
      # freshest first, so the max-items trim downstream keeps the latest turns.
      #
      # A row is kept regardless of whether it carries a goal. It used to require
      # a non-empty user_goal, which was safe only while the goal was a prompt
      # PREFIX and therefore always present. Now that the goal is an EXTRACTED
      # request (extract_user_goal), "no confident request" is a normal outcome,
      # and dropping those rows would throw away the touched_files / outcome that
      # intel actually renders -- the half of a session-local item that was ever
      # worth injecting. intel decides: _render_turn returns None for a turn with
      # nothing in any field, and _is_self_echo still suppresses a goal-only turn.
      ( . | map(select(type == "object")) | reverse ) as $rows
      | [ $rows | to_entries[]
          | .key as $i | .value as $r
          # F1 (An review 2026-08-20): resolve the outcome CONSERVATIVELY, from the
          # session-owned commands THIS turn ran, and NOTHING ELSE. No git log, no HEAD
          # diff, no time window (ten-plus sessions share this tree, so a peer moving HEAD
          # mid-turn must not change any classification), and no matching of goal text to
          # file paths. The prior rule read a touched file OR any mutating command as
          # `applied`; that is what served a REVERTED goal as done.
          #
          # THE CAVEAT (An, 2026-08-20 follow-up): `outcome` is whether the GOAL succeeded,
          # while these commands describe REPOSITORY MUTATIONS, and the two are not always
          # the same. Two mutations look like "revert" but are opposite kinds of work:
          #   - DISCARD (git restore / reset --hard / checkout -- path): throws away
          #     UNCOMMITTED work without a commit. A turn that only discards, and commits
          #     nothing, undid its own work -> `reverted`.
          #   - COMMIT A REVERT (git revert): creates a NEW commit that undoes an earlier
          #     one. This is forward, committing work. A user-requested rollback run with
          #     `git revert` is SUCCESSFUL work, never "the goal was reverted". But we
          #     cannot prove from the command alone that the rollback WAS the goal, so the
          #     honest floor is `unknown` with the goal dropped, NOT `reverted`.
          #
          #   applied  : an unambiguous turn-owned COMMIT, no discard and no git-revert.
          #   reverted : the turn DISCARDED uncommitted work and committed nothing.
          #   unknown  : commit AND discard together (seam-3 mixed); OR a `git revert`
          #              (ambiguous rollback, per the caveat); OR neither (an uncommitted
          #              edit, a build, research). A false `applied`/`reverted` is worse
          #              than a conservative `unknown`.
          #   blocked  : ONLY when the row carries an explicit recorded blocked signal;
          #              NEVER derived from "no commit".
          #
          # `commit-tree` alone writes an object without landing it and is not counted.
          # Each signal is anchored at a STATEMENT HEAD: the start of the command, or right
          # after `;` `&&` `||` `|` or a NEWLINE, with optional leading whitespace. This is
          # matched against $recent_exec, where heredoc BODIES are stripped and quoted spans
          # are masked to `Q`, so a newline is a safe boundary and no subcommand word can hide
          # inside a message or heredoc. A subcommand word mid-line -- inside a `-m` message
          # ("revert the skip"), a comment, or any quoted argument (even a multiline one) --
          # is a MENTION, not a use, and does not fire (F1, An review 2026-08-20 + 2026-08-26). The commit signal additionally allows an ENVIRONMENT-ASSIGNMENT
          # prefix (`GIT_INDEX_FILE=$IDX git commit`, the canonical isolated-index recipe);
          # a discard/revert never runs against an isolated index, so they get no prefix.
          # scoped-commit.sh is anchored the same way (optional bash/sh/zsh + path, then an
          # argument), so a prose mention is not a run. Only the freshest turn ($i==0)
          # carries spool commands; older turns stay unknown unless they carry an explicit
          # signal. (No apostrophes below: this program is single-quoted in bash.)
          | ($cmds | .[-5:]) as $recent
          | ($recent | map(strip_heredocs | mask_quoted)) as $recent_exec
          | (($r.outcome // "") | ascii_downcase) as $recorded
          | ($i == 0 and ($recent_exec | map(select(test("(^|[;&|\n])[ \t]*([A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+)*git +commit($|[^-])"; "i") or test("(^|[;&|\n])[ \t]*(bash|sh|zsh)?[ \t]*[^ \t;&|<>]*scoped-commit\\.sh([ \t]|$)"; "i"))) | length > 0)) as $committed
          | ($i == 0 and ($recent_exec | map(select(test("(^|[;&|\n])[ \t]*git +(restore\\b|reset\\b[^;|&\n]*--hard|checkout\\b[^;|&\n]* -- )"; "i"))) | length > 0)) as $discarded
          | ($i == 0 and ($recent_exec | map(select(test("(^|[;&|\n])[ \t]*git +revert\\b"; "i"))) | length > 0)) as $git_revert
          | (if $recorded == "blocked" then "blocked"
             elif $git_revert then "unknown"
             elif $committed and $discarded then "unknown"
             elif $committed then "applied"
             elif $discarded then "reverted"
             else "unknown" end) as $oc
          | ($committed or $discarded or $git_revert) as $git_action
          | {
              turn_id: ($r.turn_id // "unknown"),
              sequence: ($r.sequence // 0),
              # Drop the goal on `unknown` when the turn shows a concrete git action (files
              # committed/touched, OR a commit/discard/git-revert command): keeping it would
              # assert a goal<->action pairing we cannot prove (the seam-3 false attribution,
              # or a `git revert` read as the goal). The action still travels in
              # touched_files / commands_run, just never bound to the goal. A goal-only
              # unknown turn keeps its goal (nothing to be falsely paired with, and the
              # intel self-echo guard drops it anyway).
              user_goal: (if $oc == "unknown" and $i == 0 and (($tf | length) > 0 or $git_action) then "" else ($r.user_goal // "") end),
              assistant_summary: (if $i == 0 then ($narr | last // "") else "" end),
              touched_files: (if $i == 0 then $tf else [] end),
              commands_run: (if $i == 0 then $recent else [] end),
              outcome: $oc,
              low_trust: true
            } ]' 2>/dev/null || printf '[]')"
  case "$out" in '['*']') printf '%s' "$out" ;; *) printf '[]' ;; esac
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
# The nearest-wins walk itself, factored out so meetless_activated can run it
# twice: once from the hook's cwd, and once from a linked worktree's origin
# checkout. Sets the same three globals as its caller on success.
_meetless_walk_up_marker() {
  local dir="$1"
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

# Canonicalize a FILE path (dirname through `cd -P`, then re-append the base).
# `cd` alone cannot canonicalize a file, and macOS bash 3.2 has no `realpath`.
# Split with parameter expansion rather than dirname/basename: this runs on the
# capture-hook path and each of those is a fork.
_meetless_canon_file() {
  local p="$1" d b
  b="${p##*/}"
  d="${p%/*}"
  [[ "$d" == "$p" ]] && d="."
  [[ -z "$d" ]] && d="/"
  d="$(cd -P "$d" 2>/dev/null && pwd)" || return 1
  printf '%s/%s' "$d" "$b"
}

# First line of a file, trimmed, via the `read` builtin: no head/sed/tr forks.
# Returns non-zero on an unreadable or empty file. The trim also eats a trailing
# \r, so a file written on Windows parses the same.
_meetless_first_line() {
  local line=""
  IFS= read -r line < "$1" 2>/dev/null || true
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" ]] && return 1
  printf '%s' "$line"
}

# The origin checkout of the linked git worktree containing $1, printed on
# stdout; non-zero exit when $1 is not a provably linked worktree.
#
# The bash twin of findWorktreeOrigin in lib/activation.ts, and it MUST agree
# with it (test/lib/activation-worktree-parity.spec.ts pins that). Reads git's
# own worktree metadata rather than doing string surgery on a path:
#
#   <worktree>/.git         a FILE holding `gitdir: <admin dir>` (abs or relative)
#   <admin dir>/gitdir      a back-pointer that must name that same `.git` FILE
#   <admin dir>/commondir   the shared .git, relative to the admin dir
#
# Anything unproven exits 1 and the caller stays unbound (fail visible). No
# `git` subprocess: this sits behind the marker walk on the capture-hook path.
_meetless_worktree_origin() {
  local dir="$1" dotgit admin backptr common origin
  while :; do
    dotgit="$dir/.git"
    if [[ -f "$dotgit" ]]; then
      admin="$(_meetless_first_line "$dotgit")" || return 1
      case "$admin" in
        gitdir:*) admin="${admin#gitdir:}" ;;
        *) return 1 ;;
      esac
      admin="${admin#"${admin%%[![:space:]]*}"}"
      [[ -z "$admin" ]] && return 1
      case "$admin" in
        /*) ;;
        *) admin="$dir/$admin" ;;
      esac
      admin="$(cd -P "$admin" 2>/dev/null && pwd)" || return 1
      [[ -f "$admin/gitdir" && -f "$admin/commondir" ]] || return 1

      backptr="$(_meetless_first_line "$admin/gitdir")" || return 1
      case "$backptr" in
        /*) ;;
        *) backptr="$admin/$backptr" ;;
      esac
      [[ "$(_meetless_canon_file "$backptr")" == "$(_meetless_canon_file "$dotgit")" ]] || return 1

      common="$(_meetless_first_line "$admin/commondir")" || return 1
      case "$common" in
        /*) ;;
        *) common="$admin/$common" ;;
      esac
      common="$(cd -P "$common" 2>/dev/null && pwd)" || return 1
      # A bare origin has no checkout to carry a marker; only <checkout>/.git does.
      [[ "${common##*/}" == ".git" ]] || return 1
      origin="${common%/*}"
      [[ -z "$origin" ]] && origin="/"
      [[ -d "$origin" ]] || return 1
      printf '%s' "$origin"
      return 0
    fi
    # A `.git` FILE we could not prove, or a `.git` DIRECTORY, is the repository
    # boundary either way: walking past it would answer for a different repo.
    [[ -e "$dotgit" ]] && return 1
    [[ "$dir" == "/" ]] && return 1
    dir="$(dirname "$dir")"
  done
}

meetless_activated() {
  local dir="${1:-$PWD}" origin
  MEETLESS_MARKER_FILE=""
  MEETLESS_MARKER_WORKSPACE_ID=""
  MEETLESS_MARKER_VIA=""
  WORKSPACE_ID=""
  # Canonicalize so the walk terminates at "/" deterministically even when the
  # hook was fired with a relative or symlinked cwd.
  dir="$(cd "$dir" 2>/dev/null && pwd || true)"
  [[ -z "$dir" ]] && return 1

  # 1. The ordinary nearest-wins walk. Unchanged, and an activated checkout
  #    never proceeds past it, so the hot path costs exactly what it did.
  _meetless_walk_up_marker "$dir" && return 0

  # 2. D1: a linked worktree inherits its origin checkout's binding. The marker
  #    is untracked in most repos, so `git worktree add` (tracked files only)
  #    could never carry it and every agent in an isolated worktree ran
  #    ungoverned. Workspace binding ONLY: the worktree keeps its own repoPath,
  #    scan root and runtime scope, which are all derived from its own cwd.
  origin="$(_meetless_worktree_origin "$dir")" || return 1
  [[ -z "$origin" ]] && return 1
  if _meetless_walk_up_marker "$origin"; then
    MEETLESS_MARKER_VIA="worktree"
    return 0
  fi
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

# End-of-run review card: surface up to 5 deterministic stale signals to the user.
# P0A-minimal: appended to a LOCAL jsonl only (review_card is not in the flush
# allowlist), later surfaced by `mla status` / `mla context list`. A cheap jq read of
# the scan cache; it never recomputes the scan. Always returns 0 so it cannot abort Stop.
#
# This lives in common.sh, next to MEETLESS_HOME_DIR, precisely because it resolves
# state paths: while it sat inline in stop.sh it hard-coded $HOME/.meetless and so
# ignored MEETLESS_HOME, unlike every other path in this file. Nothing could catch that,
# because the only test copied the jq filter into TypeScript instead of driving the real
# function. test/hooks/build-stop-card.spec.ts now drives THIS function.
write_stop_review_card() {
  local session_id="$1" ts="$2"
  local ws_dir="$MEETLESS_HOME_DIR/workspaces/$WORKSPACE_ID"
  local cache="$ws_dir/scan-cache.json"
  [[ -r "$cache" ]] || return 0
  local line
  line="$(jq -c -n \
    --slurpfile c "$cache" \
    --arg sid "$session_id" \
    --arg ts "$ts" \
    '{
       ts: $ts, event: "review_card", session_id: $sid,
       items: ($c[0].staleSignals // [])[0:5] | map({id: .id, detail: .detail, source: .source}),
       total: (($c[0].staleSignals // []) | length),
       scan_root: ($c[0].scanRootPath // null)
     }' 2>/dev/null || true)"
  [[ -n "$line" ]] || return 0
  printf '%s\n' "$line" >> "$ws_dir/review-cards.jsonl" 2>/dev/null || true
  return 0
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

# ---- The exactly-once terminal-trace guard --------------------------------
#
# INVARIANT: one hook invocation writes AT MOST ONE terminal row to
# ask-traces.jsonl, and (past the activation gate) at LEAST one. Both writers
# below claim through here, so a path that both wrote a full trace and then hit
# the EXIT trap cannot produce two rows for one turn, and a retry cannot either.
#
# Why an invariant and not a convention: session 5734f9de took 8 turns and left 6
# rows. The two missing ones were `<task-notification>` wake-ups that hit a
# deliberate early return which happened to be silent. A turn with no row is
# indistinguishable from a crash, a kill, or mla not being installed, so every
# rate computed over this log was quietly conditioned on "turns that happened to
# reach the writer". Set-membership is the fix, not a bigger writer.
MLA_TERMINAL_TRACE_WRITTEN=0

# 0 (and claims the slot) when this invocation has not written its terminal row
# yet; 1 when it has. Deliberately a plain global, not a lock file: the guard is
# per-PROCESS (one hook invocation), while ask-traces.lock is cross-process.
claim_terminal_trace() {
  [[ "${MLA_TERMINAL_TRACE_WRITTEN:-0}" == "1" ]] && return 1
  MLA_TERMINAL_TRACE_WRITTEN=1
  return 0
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
  claim_terminal_trace || return 0
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
    ml_private_file "$LOG_DIR/ask-traces.jsonl"
    printf '%s\n' "$line" >> "$LOG_DIR/ask-traces.jsonl"
    ml_unlock 8 "$LOG_DIR/ask-traces.lock"
  ) 2>/dev/null || true
  return 0
}

# ---- F1/F2: the candidates this caller ALREADY HAS -------------------------
#
# MEASURED on session 4ff1f7f5 (2026-08-06): 51,077 characters delivered across six
# prompts, of which 48,383 (94.7%) were TWO documents re-sent on three consecutive
# turns, one of them written by the agent ITSELF earlier in the same session. Zero
# citations. Every existing guard passed it, because `_is_self_echo` covers
# `prior_session_turn` items (source_id null, agent-session band) and these carried
# `NT:notes/...` + `derived_from_accepted_kb` + `architecture_constraint`: by every
# field the system reads, a governed retrieval success.
#
# intel cannot derive either fact. It is stateless across turns, and WHO AUTHORED a
# document is recorded locally at produce time. So the hook declares what it already
# has and intel drops it BEFORE the band caps, where the freed slot is refilled by
# the next relevant candidate (a trim after the fact would just shrink the payload).
#
# Turn 3 of that session retrieved 16 candidates and rendered 2.
MEETLESS_DELIVERED_TURN_WINDOW_DEFAULT=8

delivered_ledger_file() { printf '%s/governance/delivered-%s.jsonl' "$LOG_DIR" "$1"; }

# F1: the notes THIS session produced, as NT: citations.
#
# Reads the active-memory store the Zone-2 auto-index loop already writes
# (internal-auto-index.ts), which records {sessionId, workspaceId, canonicalPath} at
# PRODUCE time. That is an exact origin-session fact, not an inference.
#
# NOT a timestamp comparison. `kb_document.created_at > session_start` was the
# rejected design: it is temporal truth, not authorship truth, so it also suppresses
# a note a TEAMMATE or a concurrent agent published mid-session, which is exactly the
# newly-governed material this system exists to propagate. It is also the wrong
# clock: for the incident document the store says 04:11:01Z and kb_document.created_at
# says 04:12:32Z, because that column records INGESTION.
#
# The join key is verified against the real store: canonicalPath is `notes/<base>`
# and the enrich citation is `NT:notes/<base>`.
session_authored_source_ids() {
  local sid="${1:-}" ws="${2:-}"
  command -v jq >/dev/null 2>&1 || { printf '[]'; return 0; }
  [[ -n "$sid" && -n "$ws" ]] || { printf '[]'; return 0; }
  local store="$LOG_DIR/kb-knowledge.jsonl"
  [[ -s "$store" ]] || { printf '[]'; return 0; }
  # grep FIRST: the store is multi-megabyte and append-only across every session on
  # this box, so slurping it through jq on a hot path would cost more than the whole
  # enrich budget. The fixed-string prefilter is a cheap narrowing; jq below re-checks
  # `.sessionId` properly, so a coincidental match elsewhere in the line is dropped.
  #
  # `|| true` ON THE GREP, and it is load-bearing rather than defensive. This file runs
  # under `set -euo pipefail` (line 7), so a grep that matches NOTHING returns 1 and
  # fails the whole pipeline -- AFTER jq has already printed `[]`. The `|| printf '[]'`
  # tail then fires too and the function returns `[]\n[]`, which is two JSON values and
  # not an array. That passed the caller's `[*]` glob check, poisoned the `--argjson`
  # it was spliced into, and emptied the ENTIRE exclusion set. Invisible for as long as
  # the union had one term whose correct answer was also `[]`; found by M1 the moment a
  # second term had content.
  { grep -F "$sid" "$store" 2>/dev/null || true; } | tail -n 500 | jq -s -c --arg sid "$sid" --arg ws "$ws" '
    [ .[]
      | select(type == "object")
      | select(.event == "active_memory_record")
      | select(.kind == "produced_doc")
      | select(.sessionId == $sid)
      | select(.workspaceId == $ws)
      | (.canonicalPath // "")
      | select(length > 0)
      | "NT:" + .
    ] | unique' 2>/dev/null || printf '[]'
}

# F2: remember what was actually delivered this turn, with a digest of the exact text.
#
# The digest is over `context_items[].text` verbatim, because intel re-hashes the
# string it composes and drops only on a match. Any other basis (the note path, a
# revision id, the untrimmed snippet) is a different string on the two ends of the
# wire, so the compare would silently never fire and repeat-suppression would read as
# "not working" rather than as a mismatch.
#
# Runs AFTER the response, never before the injection, so its cost is off the
# critical path. At most `enrich_render_max_items` (3) items, so the per-item shasum
# loop is bounded by construction.
# The file holding THIS session's CURRENT-turn offer (F1). One per session, OVERWRITTEN
# every turn, so it is bounded by construction and holds no history.
turn_offer_file() {
  printf '%s/offers/%s.json' "$LOG_DIR" "${1//[^a-zA-Z0-9_-]/_}"
}

# F1: write down what this turn offered, so the PreToolUse hook can point back at it.
#
# WHY A SIDECAR AND NOT ask-traces.jsonl, which already has all of this. That file is
# 35MB and growing, and this is read on a hot tool-call path. Even the tail reader parses
# an 8MB window (~950 turns of other sessions' 8.4KB lines) to find one line. A small
# per-session file that is REWRITTEN each turn costs one read of a few KB and cannot be
# windowed out by a busy machine.
#
# NOT SESSION MEMORY. It holds ONE turn, the current one, and the next turn replaces it.
# F1 is deliberately scoped to evidence the agent was given THIS turn; carrying earlier
# turns would be a different mechanism with a different (unmeasured) false-positive
# profile, and the proposal calls that out as out of scope.
#
# Text INCLUDED, unlike the delivered-ledger next to it (which stores only a digest):
# the pointer resurfaces the already-delivered excerpt rather than paraphrasing it, so
# it needs the words. Private (0600) like every other spool, because a snippet is
# workspace content.
record_turn_offer() {
  local sid="${1:-}" turn="${2:-0}" enrichment_json="${3:-}"
  command -v jq >/dev/null 2>&1 || return 0
  [[ -n "$sid" && -n "$enrichment_json" ]] || return 0
  [[ "$turn" =~ ^[0-9]+$ ]] || turn=0
  local f; f="$(turn_offer_file "$sid")"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  local body
  body="$(printf '%s' "$enrichment_json" | jq -c \
    --arg sid "$sid" --argjson turn "$turn" '
      {session_id: $sid, turn_index: $turn,
       items: [ (.context_items // [])[]
                | select(.injected == true)
                | select((.source_id // "") != "")
                | {source_id: .source_id, status: (.status // null), text: (.text // "")} ]}' \
    2>/dev/null || true)"
  [[ -n "$body" ]] || return 0
  ml_private_file "$f"
  printf '%s\n' "$body" >"$f" 2>/dev/null || true
  return 0
}

record_delivered_sources() {
  local sid="${1:-}" turn="${2:-0}" enrichment_json="${3:-}"
  command -v jq >/dev/null 2>&1 || return 0
  [[ -n "$sid" && -n "$enrichment_json" ]] || return 0
  [[ "$turn" =~ ^[0-9]+$ ]] || turn=0
  local sel='[ (.context_items // [])[] | select(.injected != false) | select((.source_id // "") != "") ]'
  local n
  n="$(printf '%s' "$enrichment_json" | jq -r "$sel | length" 2>/dev/null || printf 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || return 0
  (( n > 0 )) || return 0
  local ledger; ledger="$(delivered_ledger_file "$sid")"
  mkdir -p "$(dirname "$ledger")" 2>/dev/null || true
  local i src txt sha line
  for (( i = 0; i < n; i++ )); do
    src="$(printf '%s' "$enrichment_json" | jq -r "$sel | .[$i].source_id // empty" 2>/dev/null || true)"
    [[ -n "$src" ]] || continue
    # intel strips title and snippet before composing, so the rendered text never
    # carries trailing whitespace and $( )'s newline strip cannot change the digest.
    txt="$(printf '%s' "$enrichment_json" | jq -r "$sel | .[$i].text // \"\"" 2>/dev/null || true)"
    sha="$(printf '%s' "$txt" | shasum -a 256 2>/dev/null | cut -d' ' -f1)"
    [[ -n "$sha" ]] || continue
    line="$(jq -c -n --arg s "$src" --arg h "$sha" --argjson t "$turn" \
      '{source_id:$s, sha:$h, turn:$t}' 2>/dev/null || true)"
    [[ -n "$line" ]] || continue
    printf '%s\n' "$line" >>"$ledger" 2>/dev/null || true
  done
  return 0
}

# M1: the governed sources THIS TURN'S PROMPT already names.
#
# THE DEFECT. Measured over the whole local ledger (4,892 traces joined turn by turn to
# the Claude Code transcripts, 2026-08-10): on turns where the harness said a `.md` file
# was OPEN in the editor and MLA delivered a payload, the payload contained that same
# file on 13 of 32 (41%), across 13 distinct sessions; 13 of the 88 items delivered on
# those turns. The other two exclusion sets both ask "did MLA already SEND this?" and
# neither asks "does the agent ALREADY HAVE it?" -- and an open editor buffer, or a path
# the operator typed, is the strongest available statement that it does. The slot is
# byte-budgeted (one measured turn cut 14 of 16 candidates), so a redundant item is a
# non-redundant one that did not ship.
#
# THIS IS NOT SELF-ECHO AND NO EXISTING DETECTOR SEES IT. `classify_selected` keys on
# `agent-observation` provenance; these are ordinary governed notes with
# `derived_from_accepted_kb`, so every dashboard reads such a turn as a clean governed
# delivery. Same waste, different substrate, third time (self-echo, carry-forward, this).
#
# RESOLUTION IS EXACT AND INVENTS NOTHING. No string algebra turns a path into an id:
# `kb-knowledge.jsonl` -- the SAME store F1 already reads -- records `repoRoot` and
# `canonicalPath` per indexed doc, so `repoRoot + "/" + canonicalPath` reconstructs the
# absolute path and an EQUALITY against what the prompt named is the whole matcher.
# Verified against the real store: all 13 mirrored documents resolve, each to exactly
# one canonical path. A path with no recorded entry yields nothing rather than a
# fabricated `NT:notes/<basename>`, which would be an id intel has never heard of.
#
# ONE ABSOLUTE PATH CAN CARRY SEVERAL IDS AND THAT IS NOT AMBIGUITY. 12 paths in the
# real store are recorded under two canonical forms (indexed under two repo roots), and
# the served corpus shows one document delivered as both `NT:notes/x.md` and `NT:x.md`.
# Excluding one form would leave the other free to be served, so an absolute match
# excludes EVERY id form of that one file.
#
# A BARE FILENAME IS AMBIGUOUS AND IS TREATED AS SUCH. It resolves only when exactly one
# governed source carries that basename. Two candidates excludes NEITHER: a wrong
# exclusion silences a document the operator does not have, which is worse than one
# redundant delivery. (The one real collision in the served corpus: `notes/readme.md`
# versus `notes/meetless-cli/packages/cli/readme.md`.)
#
# NO NEW STATE, NO NEW FLAG, NO NEW TELEMETRY. The exclusion is auditable from data that
# already exists: intel's `retrieved_citations` lists what retrieval found in rank order
# and `context_items` lists what was delivered, so a document in the first and not the
# second is a visible drop.
#
# BOUNDED ON THE HOT PATH. At most MEETLESS_PROMPT_NAMED_MAX distinct names are
# considered, and the multi-megabyte store is narrowed by a fixed-string grep on those
# basenames before jq ever parses a line -- the same idiom `session_authored_source_ids`
# uses one function above.
MEETLESS_PROMPT_NAMED_MAX=8

# A PARSED guard, not a glob. `[]\n[]` (see `session_authored_source_ids`) starts with
# `[` and ends with `]`, so the `case ... in '['*']'` idiom waves it through and the
# `--argjson` it feeds then aborts the union that was supposed to degrade gracefully.
# Slurped on purpose: two JSON values in one string must read as INVALID here, and
# unslurped jq would happily echo both back.
json_array_or_empty() {
  local v="${1:-}"
  [[ -n "$v" ]] || { printf '[]'; return 0; }
  printf '%s' "$v" | jq -c -e -s \
    'if length == 1 and (.[0] | type) == "array" then .[0] else empty end' 2>/dev/null \
    || printf '[]'
}

prompt_named_source_ids() {
  local prompt="${1:-}" ws="${2:-}"
  command -v jq >/dev/null 2>&1 || { printf '[]'; return 0; }
  [[ -n "$prompt" && -n "$ws" ]] || { printf '[]'; return 0; }
  local store="$LOG_DIR/kb-knowledge.jsonl"
  [[ -s "$store" ]] || { printf '[]'; return 0; }
  # A pure-bash substring test before anything forks. MEASURED: the extraction below
  # costs ~48ms even when it finds nothing, because it spawns grep/sed/sort regardless,
  # and only ~5% of real prompts name a `.md` at all (253 of 4,892). Paying 48ms on 95%
  # of turns to serve 5% is the wrong trade on a hot path with a 25s budget it shares
  # with a network call.
  [[ "$prompt" == *".md"* ]] || { printf '[]'; return 0; }

  # Two candidate sets with two different resolution rules. `abs` keeps the full path
  # (the disambiguator); `bare` is reduced to basenames, which is the only grain a
  # loose mention can be matched on.
  local abs bare bases
  abs="$(printf '%s' "$prompt" | grep -oE '/[^[:space:]<>"'"'"'`]+\.md' 2>/dev/null | sort -u | head -n "$MEETLESS_PROMPT_NAMED_MAX" || true)"
  bare="$(printf '%s' "$prompt" | grep -oE '[A-Za-z0-9][A-Za-z0-9._/-]*\.md' 2>/dev/null | sed 's:.*/::' | sort -u | head -n "$MEETLESS_PROMPT_NAMED_MAX" || true)"
  bases="$( { printf '%s\n' "$abs" | sed 's:.*/::'; printf '%s\n' "$bare"; } | sed '/^$/d' | sort -u )"
  [[ -n "$bases" ]] || { printf '[]'; return 0; }

  local rows
  rows="$(grep -F -f <(printf '%s\n' "$bases") "$store" 2>/dev/null | tail -n 2000 || true)"
  [[ -n "$rows" ]] || { printf '[]'; return 0; }

  local abs_json bare_json
  abs_json="$(printf '%s\n' "$abs" | jq -R -s -c 'split("\n") | map(select(length > 0))' 2>/dev/null || printf '[]')"
  bare_json="$(printf '%s\n' "$bare" | jq -R -s -c 'split("\n") | map(select(length > 0))' 2>/dev/null || printf '[]')"
  case "$abs_json" in '['*']') ;; *) abs_json="[]" ;; esac
  case "$bare_json" in '['*']') ;; *) bare_json="[]" ;; esac

  printf '%s\n' "$rows" | jq -s -c --arg ws "$ws" --argjson abs "$abs_json" --argjson bare "$bare_json" '
    [ .[]
      | select(type == "object")
      | select(.event == "active_memory_record")
      | select(.workspaceId == $ws)
      | select(((.canonicalPath // "") | length) > 0)
      | {cp: .canonicalPath, root: ((.repoRoot // "") | sub("/+$"; ""))}
    ] | unique
    | . as $recs
    # An absolute path names ONE file; every canonical form of that file is excluded.
    | ($abs | map(. as $a | $recs[] | select(.root != "" and (.root + "/" + .cp) == $a) | .cp)) as $by_abs
    | ($by_abs | map(sub(".*/"; ""))) as $settled
    # A bare mention resolves only when it can mean exactly one governed source. Names
    # an absolute path already settled are skipped rather than re-judged, so an
    # unambiguous full path is never vetoed by its own ambiguous basename.
    | ($bare
        | map(select(. as $b | ($settled | index($b)) == null))
        | map(. as $b | [ $recs[] | select((.cp | sub(".*/"; "")) == $b) | .cp ] | unique)
        | map(select(length == 1))
        | (add // [])
      ) as $by_bare
    | (($by_abs + $by_bare) | unique | map("NT:" + .))' 2>/dev/null || printf '[]'
}

# The union the enrich body carries: authored-here (no digest, drop any version),
# named by this turn's prompt (no digest, same reason), plus recently-delivered
# (digest, drop only this exact payload).
#
# BOUNDED THREE WAYS, deliberately, because `at_most_once_per_source_per_session`
# would be a permanent blindfold on a long session:
#   1. a TURN WINDOW, so a document worth re-reading later comes back;
#   2. the DIGEST, so a changed revision is served again immediately;
#   3. session-start drops the ledger on compact/clear, so a wiped context window
#      re-earns everything (that is the existing boundary, not a new epoch concept).
# Losing this file costs one redundant delivery, never a wrong one.
collect_excluded_sources() {
  local sid="${1:-}" ws="${2:-}" turn="${3:-0}" prompt="${4:-}"
  command -v jq >/dev/null 2>&1 || { printf '[]'; return 0; }
  [[ -n "$sid" ]] || { printf '[]'; return 0; }
  [[ "$turn" =~ ^[0-9]+$ ]] || turn=0
  local window="${MEETLESS_DELIVERED_TURN_WINDOW:-$MEETLESS_DELIVERED_TURN_WINDOW_DEFAULT}"
  [[ "$window" =~ ^[0-9]+$ ]] || window="$MEETLESS_DELIVERED_TURN_WINDOW_DEFAULT"
  local authored; authored="$(json_array_or_empty "$(session_authored_source_ids "$sid" "$ws")")"
  # M1. Omitting the argument keeps the old two-signal behaviour byte for byte, which
  # is what every pre-M1 caller and test relies on.
  local named="[]"
  if [[ -n "$prompt" ]]; then
    named="$(json_array_or_empty "$(prompt_named_source_ids "$prompt" "$ws")")"
  fi
  local ledger; ledger="$(delivered_ledger_file "$sid")"
  local delivered="[]"
  if [[ -s "$ledger" ]]; then
    delivered="$(tail -n 500 "$ledger" 2>/dev/null | jq -s -c --argjson turn "$turn" --argjson w "$window" '
      [ .[]
        | select(type == "object")
        | select((.source_id // "") != "")
        | select(($turn - (.turn // 0)) <= $w)
      ]
      # LATEST delivery per source wins: excluding on a stale digest would let the
      # newest payload be re-sent forever, the same bug pointing the other way.
      | group_by(.source_id) | map(.[-1])
      | map({source_id: .source_id, text_sha256: .sha})' 2>/dev/null || printf '[]')"
  fi
  delivered="$(json_array_or_empty "$delivered")"
  jq -c -n --argjson a "$authored" --argjson p "$named" --argjson d "$delivered" '
    # Authored here and named by this prompt are the SAME semantic on the wire: the
    # agent holds the document, so no version of it is worth a slot. Both therefore
    # emit a bare source_id (no digest).
    (($a + $p) | unique) as $have
    | ($have | map({source_id: .})) as $auth
    # Having DOMINATES: a doc the agent holds AND was served back is excluded
    # unconditionally, not merely for the payload we happened to see.
    | ($d | map(select(([.source_id] | inside($have)) | not))) as $del
    | $auth + $del' 2>/dev/null || printf '[]'
}

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
governance_refresh_marker() {
  local ws_safe; ws_safe="$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_')"
  printf '%s/governance/refresh-%s.json' "$LOG_DIR" "$ws_safe"
}

# ---- Governance pending-count self-heal -------------------------------------
#
# THE CIRCULARITY THIS BREAKS. The pending-count cache is written by exactly one
# thing: a human running `mla kb review`. The nudge that reads it exists to prompt
# that human to review. So the signal whose job is to cause reviewing was a
# function of the reviewing it was supposed to cause, and the moment nobody
# reviewed it went quiet and stayed quiet. Measured three times on this machine:
# 171h stale on 2026-08-04, 32h stale on 2026-08-07, and all four turns of session
# a9192083 on 2026-08-08.
#
# Commit 13ed49e0d made that silence VISIBLE (an unavailable count now says so,
# with its age). It could not make it END, because nothing refreshed the number.
#
# NOTHING NEW IS BUILT HERE. `mla kb review --all` already computes the workspace
# count and already writes the cache (kb_pending.ts `onWorkspaceCount` ->
# `writePendingCountCache`), and this file already has the detached-spawn idiom
# five other background jobs use. This wires the one to the other. No scheduler, no
# daemon, no second cache, no new flag: the lane stays gated by the existing
# MEETLESS_GOVERNANCE_HINT kill switch and throttled by the existing
# MEETLESS_GOVERNANCE_BLOCK_TTL_S.
#
# --all, not the default scope, because the cache holds the WORKSPACE count.
# `kb_pending.ts` deliberately refuses to cache a session-scoped subset, so a
# default-scoped refresh would write nothing and this would be a no-op that looks
# like a fix.
#
# The throttle marker is keyed on the WORKSPACE, not the session. A session-keyed
# one would re-arm on every new session, and on this machine ten sessions share one
# tree: that is ten spawns per stale workspace per half hour, which is the spam the
# throttle exists to prevent.
#
# Fully detached and best-effort, like every spawn_* above: it can never delay the
# prompt path (the hook returns while this is still running) and never fail it. A
# dead token, an offline control, a missing binary all cost the refresh and nothing
# else -- the block already says the count is unavailable, which stays true.
spawn_governance_count_refresh() {
  local ws="$1"
  [[ -n "$ws" ]] || return 0
  [[ "${MEETLESS_GOVERNANCE_HINT:-1}" == "0" ]] && return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0

  local marker last now ttl
  marker="$(governance_refresh_marker "$ws")"
  now="$(date +%s)"
  ttl="${MEETLESS_GOVERNANCE_BLOCK_TTL_S:-1800}"
  [[ "$ttl" =~ ^[0-9]+$ ]] || ttl=1800
  last=0
  if [[ -f "$marker" ]]; then
    last="$(jq -r '.ts // 0' "$marker" 2>/dev/null || printf 0)"
    [[ "$last" =~ ^[0-9]+$ ]] || last=0
  fi
  (( now - last > ttl )) || return 0

  # Stamped BEFORE the spawn, deliberately. If the refresh itself is what is
  # failing (a dead refresh token, say), stamping after would leave the marker
  # unwritten and re-spawn on the very next prompt, forever. The cost of stamping
  # first is one lost refresh window on a transient failure; the cost of stamping
  # last is an unbounded spawn loop on a persistent one.
  mkdir -p "$(governance_dir)" 2>/dev/null || true
  jq -cn --argjson t "$now" '{ts:$t}' > "$marker" 2>/dev/null || true

  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" kb review --all --json >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" kb review --all --json >>"$LOG_DIR/governance-refresh.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# Continuation routing (measured 2026-08-04). The route FAMILY the previous user turn in
# THIS session resolved to. One short string, per session, in the same logs/ scratch
# convention as the governance and steer state beside it, so there is no new schema and
# no database read on the hot path.
#
# It holds the family and NOTHING else: no prompt text, no query, no confidence, no
# retrieved knowledge, no candidate ids, no prior no-offer reason. Swept by the same
# orphan TTL as its neighbours (governance-orphan-sweep.spec.ts).
route_family_file() { printf '%s/governance/route-%s.json' "$LOG_DIR" "$1"; }

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

# Shared citation / source_id extractor (P3). Pulls every evidence token out of
# arbitrary text and echoes them as a sorted, de-duplicated JSON array (never a
# bare value; no match -> []). The token grammar mirrors intel's
# citation_validator: DD / TH / NT (decision-diff / theme / note) plus the
# CC|PP|PT|RC|WA|AU|DM operation tokens. Both bracketed `[NT:id]` and bare
# `NT:id` forms match. Used by post-tool-use.sh (the source_ids the agent PULLED)
# and stop.sh (the source_ids the agent's final report CITED) so the pull side
# and the push-reference side share one grammar. The grep can match zero (rc 1
# under pipefail); `|| true` keeps that from aborting the caller's `set -e`.
#
# `/` is IN the character class on purpose: a note id is a PATH
# (NT:an internal design note), which is the form the injector offers. Without the
# slash the token stopped at the first separator and every full-path citation was
# harvested as the useless stem `NT:notes`, so it could never overlap the offered
# id and report_cited / citation_precision were dead by construction.
#
# The sed trims trailing sentence punctuation. `.` has to stay in the class (ids
# end in `.md`), so an id cited at the end of a prose sentence came out as
# `NT:...foo.md.` with the period glued on, which normId (it only strips a
# trailing `.md`) could never reconcile with the offered id either.
# config_actor_id: the ONE reader of the CLI's actor identity for capture payloads.
# Prints the configured workspace-member id, or NOTHING when the CLI is logged out.
#
# `mla login` writes `actorUserId` into cli-config.json; before it, or after
# `mla logout`, the key is simply absent. Callers MUST render an absent value as
# JSON `null`, never `""` and never a machine id. `actorId` is contracted as "a
# workspace member, when known" (schema.prisma) and the console renders it as a
# person, so a hashed machine id here would put a DIFFERENT id space into a column
# that claims to hold `workspace_users.id`. That is exactly the grain mixing the
# analytics manifest exists to prevent, and unlike a null it is undetectable
# downstream.
#
# Deliberately NOT a new identity source: this is the same key the analytics
# envelope already sends as `distinctId`, so it discloses nothing new (see
# notes/meetless-cli/telemetry.md).
config_actor_id() {
  [[ -r "$CFG" ]] || return 0
  jq -r '.actorUserId // empty' "$CFG" 2>/dev/null || true
}

extract_source_ids() {
  local text="$1"
  local ids
  ids="$(printf '%s' "$text" \
    | grep -oE '(DD|TH|NT|CC|PP|PT|RC|WA|AU|DM):[A-Za-z0-9_./-]+' \
    | sed -E 's/[.,;:)]+$//' \
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
      else "unknown" end' 2>/dev/null || printf '%s\n' 'unknown')"
  case "$out" in
    success|error|unknown) printf '%s' "$out" ;;
    *) printf '%s\n' 'unknown' ;;
  esac
}

# A5 relevance-persistence ("carry ONCE") lived here: `read_prior_carry_state` and
# `compute_carry`. REMOVED 2026-08-09, owner ruling. See the emit site in
# user-prompt-submit.sh for the ledger (227 fires, 3 consumptions, 1.3% against a 6.2%
# baseline) and for why the two proposed repairs were both self-defeating.
#
# Nothing else called either function; they were a closed pair with one caller. The
# session-turn ledger and the ask-traces reader they leaned on are shared primitives and
# stay exactly where they are.

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

# E1 SHADOW spawn. Fires the canonical turns/prepare comparison in a fully detached process, so
# it can never add latency to the injection that already went out on stdout. Reads its one JSON
# argument on stdin. Off unless MEETLESS_E1_SHADOW=1 (the caller gates on that). The comparison
# line the command writes to stderr lands in e1-shadow.log for later analysis, which is the raw
# data the E1-specific comparator is derived from (proposal §11 row 5).
spawn_e1_shadow() {
  local input="$1"
  [[ -z "$input" || -z "${MLA_PATH:-}" ]] && return 0
  local target="/dev/null"
  [[ -n "${LOG_DIR:-}" ]] && target="$LOG_DIR/e1-shadow.log"
  ( printf '%s' "$input" | nohup "$MLA_PATH" _internal turn-prepare-shadow >>"$target" 2>&1 & ) >/dev/null 2>&1 || true
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
# (`.lock`/`.turn`/`.repoPath`/`.gitBaseline`/`.touched`/`.workspaceId` + 0-byte spools idle > 24h) without
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
# ---- Query topic classification (Phase 5A) --------------------------------
# Map this turn's prompt onto the CLOSED `QUERY_TOPIC_CATEGORIES` enum owned by
# src/lib/analytics/envelope.ts, so a coverage gap can say what KIND of question
# went unanswered. Deterministic, no LLM, no network.
#
# Why here: the hook is the only place that legitimately holds the prompt. The
# analytics plane must never carry it (INV-POSTHOG-PII-1), and exposing query text
# on the gap payload would mean BUILDING a prompt-capture path, which is the
# opposite of what the coverage-gap surface was asked for. So the prompt is
# reduced to one enum token HERE and only that token travels.
#
# The dimension existed, was rendered by `mla stats`, and was permanently
# `unknown` because nothing ever passed `--topic-category`. This is its writer.
#
# Contract, asserted in test/lib/query-topic-classify.spec.ts:
#   * emits exactly one enum token on stdout, never a fragment of the input;
#   * NEVER fails and never blocks the caller: any unmatched, empty, hostile or
#     huge input yields `unknown` and exit 0;
#   * never widens the enum (a value outside it is coerced to `unknown`
#     downstream by coerceTopicCategory, so a widening would be invisible).
#
# Order is specificity, not preference: the narrow, unambiguous families are
# tested before the broad ones, because a prompt about a "schema migration" is a
# migration question first and a data-model question second.
classify_query_topic() {
  local text="${1:-}"
  # Lowercase without a subprocess; bash 4+ has ${var,,} and macOS ships bash 3.2,
  # so use tr, which is present everywhere and cannot fail on this input.
  local t
  t="$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]' 2>/dev/null)" || t=""
  [[ -z "$t" ]] && { printf '%s\n' 'unknown'; return 0; }

  # grep is given the text on STDIN, never as a pattern or an argument, so no
  # prompt content can be interpreted as a flag or a regex.
  _qt_has() { printf '%s' "$t" | grep -qiE "$1" 2>/dev/null; }

  if _qt_has 'migrat|backfill'; then printf '%s\n' 'migration'
  elif _qt_has 'secret|credential|token|password|auth|acl|permission|vulnerab|encrypt|redact|leak'; then printf '%s\n' 'security'
  elif _qt_has 'endpoint|api |rest |route|payload|request body|response (body|shape)|openapi|contract|dto'; then printf '%s\n' 'api_contract'
  elif _qt_has 'schema|column|table|prisma|foreign key|data model|index on'; then printf '%s\n' 'data_model'
  elif _qt_has 'test|spec|jest|pytest|vitest|fixture|assertion|coverage|suite'; then printf '%s\n' 'testing'
  elif _qt_has 'deploy|release|rollout|prod|staging|cloud run|docker|promote|revision|ci pipeline|build pipeline'; then printf '%s\n' 'deployment'
  elif _qt_has 'architect|design|pattern|boundary|layer|refactor|coupling|abstraction|pipeline'; then printf '%s\n' 'architecture'
  elif _qt_has 'customer|pilot|prospect|churn|onboard|user feedback'; then printf '%s\n' 'customer_context'
  elif _qt_has 'decision|decide|should we|trade.?off|priorit|roadmap|scope|wedge'; then printf '%s\n' 'product_decision'
  elif _qt_has 'convention|standard|policy|runbook|workflow|process|review before|how do we'; then printf '%s\n' 'process'
  else printf '%s\n' 'unknown'
  fi
  unset -f _qt_has 2>/dev/null || true
  return 0
}

spawn_evidence_inject() {
  local turn="$1" ids="$2" tokens="$3" conf="$4" latency="$5" trace="$6" ws="$7" sid="$8"
  # 9th arg: the CLASSIFIED topic, never the prompt. Optional so an older caller
  # keeps working, and it degrades to `unknown`, which is the value this field
  # already carried on every row before Phase 5A wired a writer.
  local topic="${9:-unknown}"
  # 10th arg: the ROUTER's intent for this turn, read off the enrich trace the hook
  # already holds. Optional and EMPTY by default, not "unknown": the flag is omitted
  # entirely when we have no intent, so the event records null ("nobody told us")
  # rather than joining the router's own unknown bucket.
  local intent="${10:-}"
  evidence_analytics_enabled || return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  [[ -n "$ids" ]] || return 0   # no offered source_ids -> not an inject turn
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" _internal evidence-inject \
      --turn-index "$turn" --offered-ids "$ids" --tokens "$tokens" \
      --confidence "$conf" --latency-ms "$latency" --trace-id "$trace" \
      --workspace-id "$ws" --session-id "$sid" --topic-category "$topic" \
      ${intent:+--intent-type "$intent"} >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" _internal evidence-inject \
      --turn-index "$turn" --offered-ids "$ids" --tokens "$tokens" \
      --confidence "$conf" --latency-ms "$latency" --trace-id "$trace" \
      --workspace-id "$ws" --session-id "$sid" --topic-category "$topic" \
      ${intent:+--intent-type "$intent"} >>"$LOG_DIR/evidence-inject-$sid.log" 2>&1 &) >/dev/null 2>&1 || true
  fi
}

# ---- Rule-injection cost meter (audit 6.G / 7.10) ------------------------
# Detached, fail-soft mla_rule_injection record. Fired from the UserPromptSubmit
# hook on every turn the assembler produced a head, carrying the meter JSON that
# `_internal assemble-context` just wrote to its --meterFile: how many bytes and
# rules this prompt was charged, split ambient (the always-on floor, billed to
# every user on every turn) vs scoped.
#
# The meter rides as ONE opaque JSON argv value on purpose. It is pure numbers and
# booleans (no rule id, no path, no prompt), so unlike the assembler's inputs it is
# safe in the process table; passing the PROMPT instead, to let this process
# recompute the match, would leak the user's text to every `ps` on the box.
#
# Reuses the evidence-analytics kill switch: same hot path, same blast radius, and
# one flag to silence all of it beats a second flag nobody remembers.
# Args: meterJson traceId workspaceId sessionId turnIndex
spawn_rule_meter() {
  local meter="$1" trace="$2" ws="$3" sid="$4" turn="$5"
  evidence_analytics_enabled || return 0
  [[ -n "${MLA_PATH:-}" && -x "$MLA_PATH" ]] || return 0
  [[ -n "$meter" ]] || return 0
  if [[ "${MEETLESS_DEBUG:-1}" == "0" ]]; then
    (nohup "$MLA_PATH" _internal rule-meter \
      --meter "$meter" --trace-id "$trace" \
      --workspace-id "$ws" --session-id "$sid" --turn-index "$turn" \
      >/dev/null 2>&1 &) >/dev/null 2>&1 || true
  else
    (nohup "$MLA_PATH" _internal rule-meter \
      --meter "$meter" --trace-id "$trace" \
      --workspace-id "$ws" --session-id "$sid" --turn-index "$turn" \
      >>"$LOG_DIR/rule-meter-$sid.log" 2>&1 &) >/dev/null 2>&1 || true
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
# See an internal design note §4.4.
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
# See an internal design note. Hook-triggered token
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

# N1 (2026-08-15). The citations carried by the governing RULES that fired this turn,
# one per line, deduped, in head order. Printed for `rule_citations` on the enrich
# request; empty output on ~98% of turns, which is the byte-identical path.
#
# THE DEFECT IT CLOSES. A `[MUST]` rule can name a governed document by citation, this
# hook injects that rule, and no selector on intel's enrich path ever fetches the
# document: every selector reads `probe_text or question`, and until now no field on the
# request carried rule text at all. So the system stated a document as a requirement and
# then ran a relevance gate that could not see the requirement it had just issued.
# Measured on session ef697800: 17 rules live, 2 naming a citation, 31 turns delivering
# any citation, and 0 delivering the document their own rule names.
#
# ONLY THE RULE BLOCKS, and this is the load-bearing part of the parse. The assembled
# head also carries the static grounding block (which documents the citation KINDS as
# prose, `NT:<note>`, and would mine as a citation) and, later in the turn, the evidence
# block (which names the ids intel just served us). Feeding either back would report our
# own delivery as a governance obligation and pin the payload to whatever was served
# once, which is a self-echo loop wearing a governance label.
#
# NO CAP HERE, DELIBERATELY. Intel caps at `RULE_CITATION_CAP` and reports the overflow
# as `rule_citations_dropped_for_cap`. Capping on this side would truncate the
# denominator before intel ever saw it, so the drop counter would read 0 while documents
# went missing: the silent-cap failure this workstream has now found three times.
#
# ALL THREE KINDS ARE EMITTED, not just the one intel resolves. `NT:` is a governed KB
# document and is the only kind any live rule cites today (7 of 90 rule versions on
# control-dev carry a citation, all three distinct ones `NT:`). `CC:` and `DE:` are sent
# so intel can COUNT them as `rule_citations_unsupported`; filtering them here would make
# the day a rule starts citing a case indistinguishable from the day none does.
#
# Rule bodies are operator-authored prose and reach this function as DATA: `$1`, never
# eval, never a here-doc, so a body carrying backticks or `$VAR` cannot execute. MUST
# exit 0 so `RULE_CITATIONS_RAW="$(extract_rule_citations ...)"` can never abort a turn.
extract_rule_citations() {
  local head="${1:-}"
  [[ -n "$head" ]] || return 0
  # ONE awk pass: isolate the rule blocks, scan them for citations, strip prose
  # punctuation, dedupe in first-seen order. A pipeline of grep and sed was the first
  # cut and it needed a `|| true` on the grep, because a turn whose rules cite nothing
  # is the COMMON case (~98%) and a no-match grep exits 1, which under `pipefail` makes
  # the naive spelling print its fallback TWICE. That defect is already recorded on this
  # tree; not building a pipeline is a cheaper way to not have it.
  #
  # BLOCK MATCHED ON THE `kind=` ATTRIBUTE with `index()`, not on the whole header:
  # `floor-rules` carries `trust="must-follow"` and `scoped-rules` carries nothing
  # today, so a header-equality test would silently stop matching the day either grows
  # an attribute. `index()` over a regex for the same reason the two patterns are not
  # one alternation: this runs under whichever awk the operator's machine ships, and
  # BSD awk is the floor here, not gawk.
  printf '%s\n' "$head" \
    | awk '
        index($0, "kind=\"floor-rules\"")  > 0 { inblk = 1; next }
        index($0, "kind=\"scoped-rules\"") > 0 { inblk = 1; next }
        inblk && index($0, "</meetless-context>") > 0 { inblk = 0; next }
        inblk {
          s = $0
          while (match(s, /(NT|CC|DE):[A-Za-z0-9_][A-Za-z0-9_.\/-]*/)) {
            tok = substr(s, RSTART, RLENGTH)
            s = substr(s, RSTART + RLENGTH)
            # Trailing prose punctuation is not part of the id. A real citation ends in
            # its extension or its opaque id, so stripping these can never shorten a
            # well-formed one, and leaving them on would ship an unresolvable id that
            # degrades to silence and says nothing about why.
            sub(/[.,;:!?)\]}>"'"'"'`]+$/, "", tok)
            if (tok != "" && !(tok in seen)) { seen[tok] = 1; out[++n] = tok }
          }
        }
        END { for (i = 1; i <= n; i++) print out[i] }
      ' 2>/dev/null || true
  return 0
}
