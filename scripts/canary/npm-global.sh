#!/usr/bin/env bash
# Phase 5 canary: the npm `-g` distribution surface.
#
# Installs the just-published @meetless/mla@<version> into a THROWAWAY global prefix
# (never the runner's real global) and asserts the installed `mla` reports exactly
# that version. This is the post-publish check that the packed tarball resolves from
# the registry, links its `mla` bin, and runs from a clean install (proposal B8, npm
# surface). npm ships the JS entrypoint (not a pkg binary), so there is no Gatekeeper
# quarantine dimension here -- version identity is the whole assertion.
#
# Usage: canary/npm-global.sh <version>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

VERSION="${1:?usage: npm-global.sh <version>}"
VERSION="${VERSION#v}"

command -v npm >/dev/null 2>&1 || canary_die "npm not on PATH"

canary_init "npm-global"

PREFIX="$CANARY_ROOT/npm-global"
mkdir -p "$PREFIX"

canary_ok "npm i -g @meetless/mla@$VERSION (prefix: $PREFIX)"
# npm publish is not read-after-write consistent: the exact version can 404 from
# the registry/CDN for a few seconds after the publish job finishes. Retry a
# handful of times so propagation lag reads as "not yet", not as a broken release.
_installed=0
for _try in 1 2 3 4 5 6; do
  if npm install -g --prefix "$PREFIX" "@meetless/mla@$VERSION"; then
    _installed=1; break
  fi
  canary_warn "npm install attempt $_try failed (registry propagation?); retrying in 10s"
  sleep 10
done
[ "$_installed" = 1 ] || canary_die "npm global install failed for @meetless/mla@$VERSION after retries"

MLA_BIN="$PREFIX/bin/mla"
canary_assert_version "$MLA_BIN" "$VERSION"

canary_ok "PASS: npm -g surface for $VERSION"
