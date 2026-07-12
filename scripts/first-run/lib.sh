#!/usr/bin/env bash
# Shared helpers for the mla FIRST-RUN e2e harness (design:
# notes/20260712-mla-install-e2e-harness.md).
#
# This is the ONE suite that exercises the real human first-run lane: interactive
# `mla login` (browser OAuth + PKCE loopback), `mla activate` against PROD, and the
# first commands returning real, grounded answers. Everything hermetic/offline/sim
# is already owned by scripts/smoke, scripts/canary, and apps/integration; this
# harness deliberately does not re-run any of those cases. It DOES reuse the canary
# isolation-adjacent helpers (canary_assert_version, canary_assert_no_quarantine,
# canary_fetch_installer, canary_is_macos) so the version guard is shared code.
#
# Unlike canary/smoke, this harness:
#   - forces the PROD backend (unsets every MEETLESS_*_URL / _TOKEN override),
#   - leaves wiring ENABLED so `mla activate` self-heal + `mla mcp` run for real,
#   - keeps its sandboxes under a persistent, gitignored test root so a failed run
#     can be inspected, and does NOT auto-remove per-channel sandboxes on failure
#     unless the whole run is clean (or FR_KEEP=0).
set -euo pipefail

HERE_FR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Reuse the canary assert/install helpers (canary_assert_version, _no_quarantine,
# _fetch_installer, _is_macos). Sourcing defines the functions but never runs
# canary_init, so no canary EXIT trap is installed here.
# shellcheck disable=SC1091
. "$HERE_FR/../canary/lib.sh"

FR_ROOT=""            # persistent test root for the whole run
FR_HOME=""            # current channel's isolated HOME
FR_MHOME=""           # current channel's isolated MEETLESS_HOME
FR_WORK=""            # current channel's fixture-repo working dir
FR_BIN=""             # current channel's installed mla binary
FR_IDENTITY=""        # stashed logged-in cli-config.json (copied across channels)

# ---- logging ---------------------------------------------------------------
fr_log()  { printf 'first-run: %s\n' "$*"; }
fr_ok()   { printf 'first-run: \033[32mok\033[0m %s\n' "$*"; }
fr_warn() { printf 'first-run: \033[33mwarn\033[0m %s\n' "$*" >&2; }
fr_err()  { printf 'first-run: \033[31mFAIL\033[0m %s\n' "$*" >&2; }
fr_die()  { fr_err "$*"; exit 1; }
fr_step() { printf '\n\033[1mfirst-run: == %s ==\033[0m\n' "$*"; }

# ---- scorecard -------------------------------------------------------------
# Flat parallel arrays so a run can print a single PASS/FAIL table at the end.
FR_CASE_LABEL=()
FR_CASE_STATE=()   # PASS | FAIL | WARN
FR_CASE_NOTE=()

fr_pass() { FR_CASE_LABEL+=("$1"); FR_CASE_STATE+=("PASS"); FR_CASE_NOTE+=("${2:-}"); fr_ok "$1"; }
fr_fail() { FR_CASE_LABEL+=("$1"); FR_CASE_STATE+=("FAIL"); FR_CASE_NOTE+=("${2:-}"); fr_err "$1${2:+ -- $2}"; }
fr_skip() { FR_CASE_LABEL+=("$1"); FR_CASE_STATE+=("WARN"); FR_CASE_NOTE+=("${2:-skipped}"); fr_warn "$1${2:+ -- $2}"; }

# fr_expect_contains <label> <haystack> <needle>
fr_expect_contains() {
  local label="$1" hay="$2" needle="$3"
  if printf '%s' "$hay" | grep -qiF -- "$needle"; then
    fr_pass "$label"
  else
    fr_fail "$label" "expected to contain '$needle'"
  fi
}

# fr_expect_nonzero <label> <exit-code> [detail]: assert a command FAILED (used for
# the pre-auth fail-fast checks where success would be the bug).
fr_expect_nonzero() {
  local label="$1" code="$2" detail="${3:-}"
  if [ "$code" -ne 0 ]; then
    fr_pass "$label"
  else
    fr_fail "$label" "${detail:-expected nonzero exit, got 0}"
  fi
}

# fr_expect_zero <label> <exit-code> [detail]
fr_expect_zero() {
  local label="$1" code="$2" detail="${3:-}"
  if [ "$code" -eq 0 ]; then
    fr_pass "$label"
  else
    fr_fail "$label" "${detail:-expected exit 0, got $code}"
  fi
}

# fr_report: print the scorecard; return nonzero iff any case FAILed.
fr_report() {
  local i fails=0 warns=0 total="${#FR_CASE_LABEL[@]}"
  printf '\n\033[1mfirst-run: ==== SCORECARD ====\033[0m\n'
  for i in "${!FR_CASE_LABEL[@]}"; do
    local state="${FR_CASE_STATE[$i]}" note="${FR_CASE_NOTE[$i]}"
    local mark color
    case "$state" in
      PASS) mark="PASS"; color="32" ;;
      WARN) mark="WARN"; color="33"; warns=$((warns+1)) ;;
      *)    mark="FAIL"; color="31"; fails=$((fails+1)) ;;
    esac
    printf '  \033[%sm%-4s\033[0m %s%s\n' "$color" "$mark" "${FR_CASE_LABEL[$i]}" "${note:+  ($note)}"
  done
  printf 'first-run: %d checks, \033[32m%d pass\033[0m, \033[33m%d warn\033[0m, \033[31m%d fail\033[0m\n' \
    "$total" "$((total-fails-warns))" "$warns" "$fails"
  [ "$fails" -eq 0 ]
}

# ---- run root + per-channel sandboxes -------------------------------------
# fr_init [root]: create the persistent test root and register cleanup. Sandboxes
# live UNDER this root (one per channel). The root is removed on exit only when the
# run was clean and FR_KEEP is not set, so a failed/kept run stays inspectable.
fr_init() {
  FR_ROOT="${1:-$HOME/mla-install-test}/run-$(date +%Y%m%d-%H%M%S)-$$"
  mkdir -p "$FR_ROOT"
  # SAFETY (parent-marker hijack): if any `.meetless.json` lives in an ANCESTOR of
  # the test root, `mla activate` in a child would walk up, find it, and take the
  # BIND path (provisioning nothing, writing no marker) instead of provisioning a
  # disposable workspace. Teardown could then unbind a REAL workspace. Refuse up
  # front rather than risk it. (The disposable marker activate writes AT the
  # fixture repo is a DESCENDANT of FR_ROOT, so guarding FR_ROOT-and-up is exact.)
  fr_assert_no_ancestor_marker "$FR_ROOT"
  FR_IDENTITY="$FR_ROOT/identity-cli-config.json"
  # shellcheck disable=SC2064
  trap "fr_cleanup" EXIT
  fr_ok "test root: $FR_ROOT (no ancestor .meetless.json — activate will provision, not bind)"
}

# fr_assert_no_ancestor_marker <dir>: walk from <dir> up to / and die if any
# `.meetless.json` exists on the way. Guarantees `mla activate` in any descendant
# provisions a fresh workspace rather than binding to a pre-existing one.
fr_assert_no_ancestor_marker() {
  local d; d="$(cd "$1" 2>/dev/null && pwd -P)" || fr_die "cannot resolve test root: $1"
  while :; do
    if [ -e "$d/.meetless.json" ]; then
      fr_die "refusing to run: ancestor workspace marker at $d/.meetless.json would hijack \`mla activate\` into BIND (risking a real workspace on teardown). Choose --root OUTSIDE any activated tree (e.g. \$HOME/mla-install-test)."
    fi
    [ "$d" = "/" ] && break
    d="$(dirname "$d")"
  done
}

# fr_cleanup: remove the run root unless FR_KEEP=1 or a FAIL was recorded. Never
# touches An's real HOME/MEETLESS_HOME (every sandbox is under FR_ROOT).
fr_cleanup() {
  local i had_fail=0
  for i in "${!FR_CASE_STATE[@]}"; do
    [ "${FR_CASE_STATE[$i]}" = "FAIL" ] && had_fail=1
  done
  if [ "${FR_KEEP:-0}" = "1" ]; then
    fr_warn "keeping test root for inspection: $FR_ROOT"
  elif [ "$had_fail" = "1" ]; then
    fr_warn "run had failures; keeping test root for inspection: $FR_ROOT"
  else
    rm -rf "$FR_ROOT"
  fi
}

# fr_channel_env <channel>: allocate an isolated sandbox for ONE channel and point
# HOME / MEETLESS_HOME / TMPDIR at it. Forces the PROD backend by unsetting every
# override, but (unlike canary) leaves wiring ENABLED so activate/mcp run for real.
fr_channel_env() {
  local ch="$1"
  local base="$FR_ROOT/$ch"
  FR_HOME="$base/home"
  FR_MHOME="$base/meetless"
  FR_WORK="$base/fixture-repo"
  mkdir -p "$FR_HOME" "$FR_MHOME" "$base/tmp" "$FR_WORK"

  export HOME="$FR_HOME"
  export MEETLESS_HOME="$FR_MHOME"
  export TMPDIR="$base/tmp"
  export TMP="$TMPDIR"; export TEMP="$TMPDIR"

  # Force prod: a shared-key token on disk would HARD-ERROR readConfig() once a
  # user-token exists, and a stray *_URL would point us off prod. Clear them all so
  # the CLI falls back to its baked-in prod defaults (control/intel/app .meetless.ai).
  unset MEETLESS_CONTROL_TOKEN MEETLESS_BACKEND_URL MEETLESS_INTEL_URL MEETLESS_CONSOLE_URL || true

  # Quiet, but NOT CI=1 (we want `mla login` to open a real browser) and NOT
  # MLA_NO_WIRE (we want activate's self-heal + mcp to run against the sandbox HOME).
  export MEETLESS_TELEMETRY=off
  export MLA_NO_UPDATE_NOTIFIER=1

  cd "$FR_WORK"
  fr_ok "[$ch] sandbox HOME=$FR_HOME MEETLESS_HOME=$FR_MHOME"
}

# fr_guard_not_devbuild <channel>: refuse to proceed if the ambient `mla` on PATH
# resolves into a source checkout (An's /opt/homebrew/bin/mla dev symlink). This is
# a contamination guard, not a channel case: we must test the INSTALLED artifact,
# never the dev build. Only consulted for channels that rely on a global PATH `mla`
# (brew); npm/curl pin FR_BIN to an absolute sandbox path and skip this.
fr_guard_not_devbuild() {
  local resolved; resolved="$(command -v mla 2>/dev/null || true)"
  [ -n "$resolved" ] || return 0
  local real; real="$(readlink -f "$resolved" 2>/dev/null || echo "$resolved")"
  case "$real" in
    *"/meetless-cli/"*|*"/dist/cli.js"|*"/dist/"*)
      fr_die "ambient 'mla' resolves into a source checkout ($resolved -> $real). Refusing to test the dev build. Use --channel npm|curl (absolute sandbox bin) or --no-brew-guard on a clean machine." ;;
  esac
}

# fr_stash_identity: after a successful login, copy the sandbox cli-config.json to
# the run-level identity stash so later channels can reuse the token (login once).
fr_stash_identity() {
  local cfg="$FR_MHOME/cli-config.json"
  [ -f "$cfg" ] || fr_die "no cli-config.json at $cfg after login"
  cp "$cfg" "$FR_IDENTITY"
  fr_ok "stashed identity -> $FR_IDENTITY"
}

# fr_restore_identity: seed this channel's sandbox with the stashed logged-in
# config so it skips the interactive login.
fr_restore_identity() {
  [ -f "$FR_IDENTITY" ] || return 1
  cp "$FR_IDENTITY" "$FR_MHOME/cli-config.json"
  fr_ok "restored stashed identity into $FR_MHOME/cli-config.json"
}
