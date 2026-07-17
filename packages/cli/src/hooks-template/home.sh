#!/usr/bin/env bash
# home.sh: the ONE home-directory resolver for the hook layer. Sourced FIRST by
# common.sh and by every self-contained hook (the ce0-* family, pre-tool-use.sh).
#
# WHY THIS FILE EXISTS
# -------------------
# $HOME is not trustworthy, and the hooks are the most exposed surface we have: they
# run in whatever environment Claude Code was launched with, BEFORE any mla process
# starts, so the Node-side repair (lib/config.ts repairHomeEnv) cannot reach them.
#
# On 2026-07-13 a session was launched with HOME='' (a shell that sourced its env file
# from the wrong cwd, so the box's $HOME expanded to nothing). Everything that session
# spawned inherited the empty value. In shell that is not a crash, it is a SILENT
# RE-ROOTING, because "$HOME/.meetless" is then the RELATIVE path "/.meetless" (empty
# HOME) or the RELATIVE path "~/.meetless" (a literal "~"; a quoted tilde is NOT
# expanded by the shell). So a hook would either
#   - mkdir a literal "~" directory inside whatever repo the session was started in, or
#   - try to write to /.meetless and die under `set -e`, killing capture,
# and in the tilde case it would then read an EMPTY cli-config.json and behave as if
# the operator were logged out.
#
# THE RECOVERY
# ------------
# `eval "h=~$user"` expands through the PASSWORD DATABASE (getpwnam), NOT through
# $HOME. It is the shell twin of Node's os.userInfo().homedir, and it is the only way
# back to the truth once $HOME lies. Verified in sh, bash and zsh on macOS with HOME
# set to "", to "~", and to a relative path.
#
# Everything here is fail-open: no `set -e`, every step guarded, and a machine with no
# resolvable home at all yields an EMPTY state dir, which callers treat as "do nothing"
# (never as "write into the cwd").

# Repair $HOME in place, and EXPORT it, so that everything this hook spawns (mla, jq,
# git, and any child of theirs) also gets an honest home. Accept $HOME only when it is
# absolute. Returns 0 when $HOME is usable afterwards, 1 when there was nothing to
# repair it to.
ml_repair_home() {
  case "${HOME:-}" in
    /*) return 0 ;;
  esac

  # An UNSET $HOME is repaired silently: every tool falls back to passwd for it anyway,
  # and leaving it unset would make "$HOME/.meetless" the absolute-but-wrong "/.meetless".
  # A SET-but-broken $HOME ("" or "~" or a relative path) is repaired LOUDLY: something
  # in the launch chain is misconfigured and the operator needs to know.
  #
  # `${HOME+x}` tests SET-ness, not emptiness. `-n "$HOME"` would be wrong, and wrong in
  # the one way that matters: HOME='' is the exact value the 2026-07-13 launcher set, so
  # an emptiness test hands the incident itself the silent path. Empty is a LIE told by a
  # launcher, not an absence.
  local __ml_broken=0
  [ -n "${HOME+x}" ] && __ml_broken=1

  local __ml_user __ml_home
  __ml_user="$(id -un 2>/dev/null || true)"
  __ml_home=""
  # Only a plain username may reach `eval`. A shell-metacharacter in there would be
  # executed, and this runs on every hook.
  case "$__ml_user" in
    ''|*[!A-Za-z0-9._-]*) ;;
    *) eval "__ml_home=~$__ml_user" 2>/dev/null || __ml_home="" ;;
  esac
  # `~nosuchuser` does not expand: bash leaves the literal string. Absolute or nothing.
  case "$__ml_home" in
    /*) ;;
    *) __ml_home="" ;;
  esac

  if [ -z "$__ml_home" ]; then
    return 1
  fi
  if [ "$__ml_broken" = "1" ]; then
    printf "[Meetless] ignoring \$HOME='%s' (not an absolute path); using %s instead. Whatever launched this process set \$HOME wrong.\n" \
      "$HOME" "$__ml_home" >&2
  fi
  HOME="$__ml_home"
  export HOME
  return 0
}

# Echo the absolute Meetless state dir, or NOTHING when no home can be resolved.
# MEETLESS_HOME (the operator override) wins, but only when it is absolute: a relative
# one is exactly the bug this file exists to prevent, so it is refused, not honored.
# Always returns 0, so it is safe inside a `set -e` command substitution.
ml_state_dir() {
  case "${MEETLESS_HOME:-}" in
    /*) printf '%s' "$MEETLESS_HOME"; return 0 ;;
    '') ;;
    *)
      printf '[Meetless] ignoring MEETLESS_HOME=%s (not an absolute path); falling back to the home directory.\n' \
        "$MEETLESS_HOME" >&2
      ;;
  esac
  ml_repair_home || { printf ''; return 0; }
  printf '%s/.meetless' "$HOME"
  return 0
}

# Run the repair at source time. Cheap on the happy path: an absolute $HOME is one
# `case` match and zero forks. Guarded so an unrepairable box cannot abort the hook.
ml_repair_home || true

# The resolved state dir, for the hooks that want it as a variable. Empty means "no
# usable home"; callers must treat that as "do nothing".
MEETLESS_HOME_DIR="$(ml_state_dir)"
