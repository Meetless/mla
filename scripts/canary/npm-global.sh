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
# the registry/CDN for a minute or two after the publish job reports success.
#
# Sleeping longer is NOT sufficient, and 0.2.17 proved it: the macOS runner failed
# all six attempts with ETARGET while the ubuntu runner installed the same version
# from the same registry, and a manual install worked minutes later. The reason is
# npm's PACKUMENT CACHE. The first resolve fetches the package metadata, and if that
# fetch lands on a CDN edge that has not seen the new version, npm caches that stale
# index and every retry re-reads it from disk. The retry loop was re-asking a cached
# answer. So each retry must force revalidation (--prefer-online), which is what
# actually makes waiting work.
_installed=0
_delay=5
for _try in 1 2 3 4 5 6 7 8 9 10; do
  # --prefer-online: revalidate the cached packument instead of trusting it.
  if npm install -g --prefer-online --prefix "$PREFIX" "@meetless/mla@$VERSION"; then
    _installed=1; break
  fi
  canary_warn "npm install attempt $_try failed (registry propagation?); retrying in ${_delay}s"
  sleep "$_delay"
  [ "$_delay" -lt 30 ] && _delay=$(( _delay * 2 ))
done
[ "$_installed" = 1 ] || canary_die "npm global install failed for @meetless/mla@$VERSION after retries"

MLA_BIN="$PREFIX/bin/mla"
canary_assert_version "$MLA_BIN" "$VERSION"

canary_ok "PASS: npm -g surface for $VERSION"
