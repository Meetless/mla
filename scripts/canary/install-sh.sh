#!/usr/bin/env bash
# Phase 5 canary: the GCS `curl install.sh` distribution surface.
#
# Installs mla the way the public one-liner does -- fetch the just-published
# install.sh and run it with MLA_VERSION pinned to THIS release -- then asserts the
# installed binary reports exactly that version and runs. This is the only coverage
# for install.sh + the pinned GCS artifact layout + checksum verification as an
# integrated whole (proposal B8); Phases 0-4 never touch the shipped installer.
#
# macOS note (BUG-1): the curl path does NOT quarantine the installed binary. CLI
# `tar` does not propagate quarantine and install.sh copies with `install -m 0755`
# (install.sh:177), which does not carry xattrs; install.sh's own comment says a
# Terminal curl download is "usually NOT quarantined" (install.sh:184). So
# install.sh:49 strip_quarantine is belt-and-braces on this surface, and this canary
# asserts the shipped guarantee: the installed binary carries no quarantine and runs
# (exit 0, not 137). It ALSO reproduces the user-facing recovery for the case a
# user's mla DID get quarantined (e.g. a browser-downloaded tarball): re-running the
# official installer clears it. The GENUINE brew-quarantine -> cask-postflight-strip
# reproduction lives in canary/homebrew.sh, where brew really stamps the attribute.
#
# Usage: canary/install-sh.sh <version>
#   MLA_CANARY_INSTALL_URL  installer URL (default: the published GCS install.sh)
#   MLA_DOWNLOAD_URL        artifact base (passed through to install.sh; default is
#                           install.sh's own public GCS default)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

VERSION="${1:?usage: install-sh.sh <version>}"
VERSION="${VERSION#v}"
INSTALL_URL="${MLA_CANARY_INSTALL_URL:-https://storage.googleapis.com/meetless-public/cli/install.sh}"

canary_init "install-sh"
MLA_BIN="$HOME/.meetless/bin/mla"

run_installer() {
  # MLA_VERSION pins the exact release; MLA_NO_WIRE (exported by canary_init) keeps it
  # from touching Claude Code.
  #
  # MLA_NO_MODIFY_PATH=0 deliberately OVERRIDES the canary_init default. PATH setup is
  # the single most fragile part of the curl surface and it shipped broken once
  # precisely because every test opted out of it: the unit suite pre-created a .zshrc,
  # and this canary disabled the code path outright, so nothing ever ran configure_path
  # against a pristine account. canary_init gives us an isolated empty $HOME (lib.sh:40),
  # which IS a pristine account -- exactly the machine that broke -- so letting the
  # installer write its rc files there is both safe and the only real coverage we get.
  MLA_VERSION="$VERSION" MLA_NO_MODIFY_PATH=0 sh "$CANARY_ROOT/install.sh" \
    || canary_die "install.sh failed for version $VERSION (url: $INSTALL_URL)"
}

# The guarantee the install page makes: after this, a NEW shell can run `mla`.
# Asserted per-shell against the sandbox $HOME, because the shells disagree about
# which rc file they read -- zsh -c (what a coding agent spawns) reads .zshenv and
# never .zshrc, which is how "command not found: mla" survived a green install.
assert_on_path() {
  _shell="$1"; shift
  command -v "$_shell" >/dev/null 2>&1 || { canary_warn "$_shell not installed; skipping PATH check"; return 0; }
  # `|| true`: when mla is NOT on PATH `command -v` exits nonzero, and under the
  # `set -e` at the top of this file that would kill the canary silently -- turning
  # the very failure we are here to catch into a blank exit with no diagnosis.
  got="$(env -i HOME="$HOME" "$_shell" "$@" 'command -v mla' 2>/dev/null || true)"
  [ "$got" = "$MLA_BIN" ] \
    || canary_die "a fresh '$_shell' cannot find mla on PATH (got '${got:-nothing}', want '$MLA_BIN')"
  canary_ok "fresh '$_shell' resolves mla on PATH"
}

canary_ok "fetching installer: $INSTALL_URL"
if [ -f "$INSTALL_URL" ]; then
  # A local path is accepted so an installer fix can be canaried BEFORE it is published.
  # Without this the only way to exercise install.sh end to end was to ship it first,
  # which is how a broken PATH setup reached users.
  cp "$INSTALL_URL" "$CANARY_ROOT/install.sh"
else
  canary_fetch_installer "$INSTALL_URL" "$CANARY_ROOT/install.sh"
fi

canary_ok "installing mla $VERSION via install.sh"
run_installer

# 1. Headline: the shipped installer produced a binary that reports exactly this
#    release and runs (exit 0, not the BUG-1 SIGKILL).
canary_assert_version "$MLA_BIN" "$VERSION"

# 2. Shipped curl-path guarantee: no quarantine on the installed binary.
canary_assert_no_quarantine "$MLA_BIN"

# 3. The install page's actual promise: a new shell finds mla. `zsh -c` is the
#    non-interactive shell Claude Code and other agents spawn; `bash -lc` is the
#    login shell. Both must resolve the binary we just installed.
assert_on_path zsh -c
assert_on_path bash -lc

# 4. macOS recovery reproduction: if a user's mla somehow carries quarantine (a
#    browser-staged tarball), re-running the official installer must clear it. Stamp
#    the attr on the installed binary, then re-run install.sh (its install_bin
#    rewrite + strip_quarantine together clear it) and re-assert.
if canary_is_macos && command -v xattr >/dev/null 2>&1; then
  canary_ok "recovery repro: stamping com.apple.quarantine, then re-running installer"
  xattr -w com.apple.quarantine "0081;00000000;canary;" "$MLA_BIN" \
    || canary_warn "could not stamp quarantine (skipping recovery repro)"
  # Opportunistic (NOT asserted): a quarantined ad-hoc binary is SIGKILLed on Apple
  # Silicon (BUG-1). Headless-CI Gatekeeper behavior varies, so we only log it.
  if "$MLA_BIN" --version >/dev/null 2>&1; then
    canary_warn "quarantined binary still ran (runner Gatekeeper did not block; BUG-1 not reproduced here)"
  else
    canary_ok "quarantined binary was blocked (BUG-1 danger confirmed on this runner)"
  fi
  run_installer
  canary_assert_no_quarantine "$MLA_BIN"
  canary_assert_version "$MLA_BIN" "$VERSION"
fi

canary_ok "PASS: install.sh surface for $VERSION"
