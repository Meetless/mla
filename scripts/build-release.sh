#!/usr/bin/env bash
# build-release.sh: compile one mla release artifact for a single platform.
#
# Usage:   scripts/build-release.sh <platform-key>
#   platform-key = macos-arm64 | macos-x64 | linux-x64
#
# Produces, under the release dir:
#   mla-<triple>.tar.gz          (executable `mla` at the archive root)
#   mla-<triple>.tar.gz.sha256   (<hex>  <filename>, the format install.sh reads)
#
# macOS targets are ad-hoc signed (codesign -s -) and the signature is verified,
# because pkg invalidates the donor Node binary's signature and arm64 will not
# execute unsigned. Windows is intentionally unsupported here (not ratified).
#
# Env overrides (the matrix CI sets none of these; they exist for tests/local):
#   MLA_CLI_DIR     path to packages/cli      (default: <repo>/packages/cli)
#   MLA_RELEASE_DIR output dir                (default: <repo>/release)
#   MLA_SKIP_BUILD  skip `pnpm build`         (default: unset -> build runs)
#   MLA_PKG_BIN     pkg executable            (default: local node_modules/.bin/pkg)
#   MLA_CODESIGN    codesign executable       (default: codesign)
#   MLA_SMOKE       run --version/--help gate (default: unset; CI sets 1)
#
# NOTE: pin/verify the @yao-pkg/pkg version and that its node22 base binaries
# exist for every target before a real release; pkg-fetch downloads them once.
set -euo pipefail

KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "build-release: error: missing platform key (macos-arm64|macos-x64|linux-x64)" >&2
  exit 2
fi

# map platform key -> pkg target, release triple. Windows is deliberately absent.
case "$KEY" in
  macos-arm64) PKG_TARGET="node22-macos-arm64"; TRIPLE="aarch64-apple-darwin";      SIGN=1 ;;
  macos-x64)   PKG_TARGET="node22-macos-x64";   TRIPLE="x86_64-apple-darwin";       SIGN=1 ;;
  linux-x64)   PKG_TARGET="node22-linux-x64";   TRIPLE="x86_64-unknown-linux-gnu";  SIGN=0 ;;
  *)
    echo "build-release: error: unknown platform key '$KEY' (want macos-arm64|macos-x64|linux-x64)" >&2
    exit 2 ;;
esac

EXE="mla"
ARCHIVE="mla-${TRIPLE}.tar.gz"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_DIR="${MLA_CLI_DIR:-$REPO_DIR/packages/cli}"
RELEASE_DIR="${MLA_RELEASE_DIR:-$REPO_DIR/release}"
CODESIGN="${MLA_CODESIGN:-codesign}"

say() { printf 'build-release: %s\n' "$*"; }
err() { printf 'build-release: error: %s\n' "$*" >&2; exit 1; }

# 1. build the whole meetless-cli workspace, unless told to skip. The CLI's tsc
#    imports @meetless/trace-core (and bundles @meetless/mcp), whose dist + type
#    declarations must exist FIRST. Building only packages/cli fails on a clean
#    checkout with TS2307 "Cannot find module '@meetless/trace-core'". `pnpm -r
#    run build` from the workspace root runs each package's build in topological
#    (dependency-first) order: trace-core/mcp before cli; ask-core ships source
#    and has no build script, so pnpm skips it.
if [ "${MLA_SKIP_BUILD:-}" != "1" ]; then
  say "building meetless-cli workspace (pnpm -r, topological)"
  ( cd "$REPO_DIR" && pnpm -r run build )
fi
[ -f "$CLI_DIR/dist/cli.js" ] || err "no dist/cli.js in $CLI_DIR (run the build first)"

# 2. resolve the pkg binary.
PKG="${MLA_PKG_BIN:-}"
if [ -z "$PKG" ]; then
  if   [ -x "$CLI_DIR/node_modules/.bin/pkg" ];  then PKG="$CLI_DIR/node_modules/.bin/pkg"
  elif [ -x "$REPO_DIR/node_modules/.bin/pkg" ]; then PKG="$REPO_DIR/node_modules/.bin/pkg"
  else PKG="pkg"; fi
fi

# 3. compile to a single binary in a staging dir (exec named exactly `mla`).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
say "compiling $KEY -> $PKG_TARGET"
"$PKG" "$CLI_DIR" --targets "$PKG_TARGET" --output "$STAGE/$EXE"
[ -f "$STAGE/$EXE" ] || err "pkg did not produce $STAGE/$EXE"
chmod +x "$STAGE/$EXE"

# 4. macOS: ad-hoc sign, then verify the signature is present.
if [ "$SIGN" = "1" ]; then
  say "ad-hoc signing $EXE"
  "$CODESIGN" -s - --force "$STAGE/$EXE"
  "$CODESIGN" -dv "$STAGE/$EXE" || err "ad-hoc signature verification failed"
fi

# 5. optional smoke gate (CI runs this on the native runner before upload).
if [ "${MLA_SMOKE:-}" = "1" ]; then
  say "smoke: mla --version / --help"
  "$STAGE/$EXE" --version >/dev/null || err "smoke failed: --version"
  "$STAGE/$EXE" --help    >/dev/null || err "smoke failed: --help"
fi

# 6. archive with the canonical name, executable at the archive root.
mkdir -p "$RELEASE_DIR"
tar -czf "$RELEASE_DIR/$ARCHIVE" -C "$STAGE" "$EXE"

# 7. enforce the archive-root contract that install.sh depends on.
tar -tzf "$RELEASE_DIR/$ARCHIVE" | grep -qx "$EXE" \
  || err "archive root does not contain exactly '$EXE' (release-layout bug)"

# 8. per-asset checksum in install.sh's expected "<hex>  <filename>" format.
(
  cd "$RELEASE_DIR"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256"
  else err "no sha256 tool (need sha256sum or shasum)"; fi
)

say "done: $RELEASE_DIR/$ARCHIVE"
say "      $(cut -d' ' -f1 < "$RELEASE_DIR/$ARCHIVE.sha256")  $ARCHIVE"
