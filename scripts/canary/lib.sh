#!/usr/bin/env bash
# Shared helpers for the mla post-publish DISTRIBUTION canaries (release-testing
# proposal 20260711, Phase 5 §224-232).
#
# UNLIKE scripts/smoke/lib.sh, a canary does NOT receive a pre-built binary: it
# exercises a SHIPPED distribution channel end to end -- it installs mla the way a
# user would (curl install.sh, npm -g, or a Homebrew cask), then asserts the
# INSTALLED binary reports the exact version this release published and actually
# runs (exit 0, not the Gatekeeper SIGKILL of BUG-1). So `canary_init` sets up the
# isolated sandbox but never asserts an existing executable.
#
# Canaries run AFTER a release has published. They PAGE (a red job is the alert),
# they do NOT GATE -- the bytes are already live, so a canary cannot un-publish
# them. A red canary means "a channel is serving something broken; go yank/fix".
set -euo pipefail

CANARY_NAME="canary"
CANARY_ROOT=""

canary_ok()   { printf 'canary[%s]: %s\n' "$CANARY_NAME" "$*"; }
canary_warn() { printf 'canary[%s]: warn: %s\n' "$CANARY_NAME" "$*" >&2; }
canary_die()  { printf 'canary[%s]: FAIL: %s\n' "$CANARY_NAME" "$*" >&2; exit 1; }

# canary_init <name>: one auto-cleaned sandbox (isolated HOME/MEETLESS_HOME/TMPDIR
# + a workdir it cds into), hermetic env, and NO rc/Claude-Code mutation. The EXIT
# trap removes everything even on a failed assertion, so a red run never greens the
# next one (mirrors smoke_init, minus the pre-existing-binary assertion).
canary_init() {
  CANARY_NAME="${1:?canary_init: name required}"
  CANARY_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mla-canary-${CANARY_NAME}.XXXXXX")"
  # shellcheck disable=SC2064  # expand CANARY_ROOT now, on purpose.
  trap "rm -rf '$CANARY_ROOT'" EXIT

  export HOME="$CANARY_ROOT/home"
  export MEETLESS_HOME="$CANARY_ROOT/meetless"
  export TMPDIR="$CANARY_ROOT/tmp"
  export TMP="$TMPDIR"
  export TEMP="$TMPDIR"
  mkdir -p "$HOME" "$MEETLESS_HOME" "$TMPDIR" "$CANARY_ROOT/work"

  # Hermetic + quiet: no telemetry, no self-update probe, CI semantics, and never
  # touch the runner's shell rc or Claude Code config. install.sh honors
  # MLA_NO_MODIFY_PATH / MLA_NO_WIRE; the binary honors the rest.
  export MEETLESS_TELEMETRY=off
  export MLA_NO_UPDATE_NOTIFIER=1
  export CI=1
  export MLA_NO_WIRE=1
  export MLA_NO_MODIFY_PATH=1

  cd "$CANARY_ROOT/work"
  canary_ok "sandbox at $CANARY_ROOT"
}

# canary_assert_version <mla-bin> <expected-bare-semver>
#   `mla --version` prints "<semver> (<sha>[-dirty], built <ts>)" (cli.ts
#   versionString), or "<semver> (dev build, ...)" when no build-info is bundled.
#   We assert exit 0 AND the leading whitespace-delimited token == expected, so:
#     - a latest/pin drift (wrong bytes served) is caught, and
#     - the SIGKILL of a quarantined un-notarized binary (exit 137, no stdout)
#       fails loudly here rather than looking like a passing install.
canary_assert_version() {
  _bin="$1"; _want="$2"
  [ -x "$_bin" ] || canary_die "installed mla is not executable: $_bin"
  if ! _out="$("$_bin" --version 2>/dev/null)"; then
    canary_die "'$_bin --version' exited nonzero (Gatekeeper SIGKILL / crash?): got '${_out:-<no output>}'"
  fi
  _got="${_out%% *}"        # first whitespace-delimited token
  [ "$_got" = "$_want" ] \
    || canary_die "version mismatch: installed '$_got' (full: '$_out'), expected '$_want'"
  canary_ok "version ok: $_out"
}

canary_is_macos() { [ "$(uname -s)" = "Darwin" ]; }

# canary_assert_no_quarantine <file>: on macOS assert the file carries NO
# com.apple.quarantine attr (xattr -p fails). No-op off macOS / without xattr.
canary_assert_no_quarantine() {
  canary_is_macos || return 0
  command -v xattr >/dev/null 2>&1 || return 0
  if xattr -p com.apple.quarantine "$1" >/dev/null 2>&1; then
    canary_die "installed binary still carries com.apple.quarantine: $1"
  fi
  canary_ok "no com.apple.quarantine on $1"
}

# canary_fetch_installer <url> <out>: fetch install.sh with the same TLS-pinned
# flags install.sh itself uses. Fatal on failure.
canary_fetch_installer() {
  _u="$1"; _o="$2"
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$_o" "$_u" \
      || canary_die "could not fetch installer: $_u"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only -qO "$_o" "$_u" || canary_die "could not fetch installer: $_u"
  else
    canary_die "need curl or wget to fetch the installer"
  fi
}
