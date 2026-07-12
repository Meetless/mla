#!/usr/bin/env bash
# Phase 5 canary: the Homebrew cask distribution surface (macOS only).
#
# This is the GENUINE BUG-1 reproduction. Homebrew stamps com.apple.quarantine on
# cask artifacts, and on Apple Silicon a quarantined + un-notarized (ad-hoc-signed)
# binary is SIGKILLed by Gatekeeper (exit 137). The cask's postflight strips the
# attr (render-cask.sh:86-89). So this canary drives the real shipped path: tap +
# install the just-published cask, then assert the on-PATH mla carries NO quarantine
# AND reports exactly this release and runs (exit 0, not 137). Unlike the curl
# surface, brew really quarantines, so this is where the strip is actually exercised.
#
# Usage: canary/homebrew.sh <version>
#   MLA_CANARY_TAP  tap to install from (default: meetless/tap)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

VERSION="${1:?usage: homebrew.sh <version>}"
VERSION="${VERSION#v}"
TAP="${MLA_CANARY_TAP:-meetless/tap}"

canary_is_macos || canary_die "homebrew canary is macOS-only (got $(uname -s))"
command -v brew >/dev/null 2>&1 || canary_die "brew not on PATH"

canary_init "homebrew"

# brew mutates the shared prefix (Caskroom + tap), not just our sandbox HOME, so
# clean both up on exit. Overrides canary_init's trap; still removes the sandbox.
cleanup_brew() {
  brew uninstall --cask mla >/dev/null 2>&1 || true
  brew untap "$TAP" >/dev/null 2>&1 || true
  rm -rf "$CANARY_ROOT"
}
trap cleanup_brew EXIT

canary_ok "brew tap $TAP"
brew tap "$TAP" || canary_die "brew tap $TAP failed"

canary_ok "brew install --cask mla ($VERSION)"
brew install --cask mla || canary_die "brew install --cask mla failed"

# Informational: what version the tapped cask advertises (not the load-bearing
# check -- the binary's own --version below is authoritative).
CASK_VER="$(brew info --cask mla 2>/dev/null | awk 'NR==1{print $NF}')" || true
canary_ok "cask advertises version: ${CASK_VER:-<unknown>}"

MLA_BIN="$(command -v mla || true)"
[ -n "$MLA_BIN" ] || canary_die "mla not on PATH after cask install"

# The BUG-1 assertions: postflight stripped quarantine AND the binary runs == tag.
canary_assert_no_quarantine "$MLA_BIN"
canary_assert_version "$MLA_BIN" "$VERSION"

canary_ok "PASS: homebrew cask surface for $VERSION"
