#!/usr/bin/env bash
# npm exact-tarball smoke (release-testing proposal Phase 2, §187-202).
#
# Publishing @meetless/mla with `pnpm publish` re-packs at publish time, so the
# bytes a smoke would exercise are NOT the bytes users install. This smoke closes
# that gap: it installs the EXACT .tgz `pnpm pack` produced (the same file the
# release then hands to `npm publish <tgz>`) into a throwaway prefix, which forces
# better-sqlite3 to build/fetch its own addon (the npm package embeds no
# /snapshot addon), then drives three offline scenarios against the installed bin:
#   ce0-export  the freshly-built better-sqlite3 addon dlopens and backs a real
#               CE0 SQLite store (the npm storage proof; the pkg `storage` scenario
#               asserts /snapshot materialization, which does not apply here).
#   mcp         `mla init` wires a real executable MCP command (resolveMlaPath
#               realpath-resolves the .bin/mla symlink to dist/cli.js) with args
#               [mcp], and `mla mcp` completes the JSON-RPC handshake.
#   docs        the bundled docs corpus renders offline, with no login and no
#               workspace. This one is npm-specific in a way worth naming: the
#               corpus ships as a plain dist ASSET, so here it is gated by the
#               `files` list in package.json rather than by pkg embedding. A `files`
#               regression drops it from the tarball ONLY, leaving the native archive
#               green (self-documenting-CLI proposal 20260711 §11 test 26).
#
# Usage: npm-tarball.sh <path-to-.tgz>
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

TGZ="${1:?usage: npm-tarball.sh <path-to-.tgz>}"
case "$TGZ" in
  /*) : ;;
  *)  TGZ="$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")" ;;
esac
[ -f "$TGZ" ] || { printf 'npm-tarball: FAIL: no such tarball: %s\n' "$TGZ" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { printf 'npm-tarball: FAIL: npm not on PATH\n' >&2; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mla-npm-smoke.XXXXXX")"
# shellcheck disable=SC2064  # expand ROOT now, on purpose.
trap 'rm -rf "$ROOT"' EXIT

printf 'npm-tarball: installing %s into a throwaway prefix (builds better-sqlite3)\n' "$TGZ"
# --prefix installs the tgz + its runtime deps under $ROOT/inst/node_modules and
# links the mla bin into $ROOT/inst/node_modules/.bin. --no-audit/--no-fund keep
# the output clean; the better-sqlite3 install script (prebuild-install, then
# node-gyp fallback) runs as part of this.
npm install --prefix "$ROOT/inst" --no-audit --no-fund --loglevel=error "$TGZ" \
  || { printf 'npm-tarball: FAIL: npm install of the tarball failed\n' >&2; exit 1; }

BIN="$ROOT/inst/node_modules/.bin/mla"
[ -x "$BIN" ] || { printf 'npm-tarball: FAIL: installed mla bin not executable: %s\n' "$BIN" >&2; exit 1; }

printf 'npm-tarball: driving ce0-export + mcp + docs against the installed bin\n'
bash "$DIR/packaged.sh" "$BIN" ce0-export mcp docs \
  || { printf 'npm-tarball: FAIL: packaged scenarios failed against the installed tarball\n' >&2; exit 1; }

printf 'npm-tarball: OK: installed tarball passes ce0-export + mcp + docs\n'
