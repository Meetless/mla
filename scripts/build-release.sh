#!/usr/bin/env bash
# build-release.sh: compile one mla release artifact for a single platform.
#
# Usage:   scripts/build-release.sh <platform-key>
#   platform-key = macos-arm64 | macos-x64 | linux-x64 | linux-arm64
#
# The live release matrix (.github/workflows/release-cli.yml) builds only
# macos-arm64 + linux-x64; macos-x64 and linux-arm64 are the two install.sh can
# ask for but the matrix deliberately skips (runner cost / thin audience), so
# those users take the npm fallback. Their keys exist here so that "if demand
# ever justifies it" is a one-line matrix add, never a build-script change under
# release pressure. pkg cross-compiles every target from any host (it fetches the
# per-target node22 base), so a macos-14 arm64 runner can build all four.
#
# Produces, under the release dir:
#   mla-<triple>.tar.gz          (executable `mla` at the archive root)
#   mla-<triple>.tar.gz.sha256   (<hex>  <filename>, the format install.sh reads)
#
# macOS signing has two modes (BUG-1: a quarantined, un-notarized binary is
# SIGKILLed with exit 137 on Apple Silicon):
#   * Developer-ID (MLA_APPLE_SIGN_IDENTITY set): sign with a real Developer ID
#     Application cert + hardened runtime + secure timestamp, then (if the notary
#     trio is set) notarize via notarytool so Gatekeeper admits a quarantined
#     download. This is the durable fix.
#   * ad-hoc (identity unset, the default): codesign -s - . pkg invalidates the
#     donor Node binary's signature and arm64 refuses to run UNSIGNED, so an
#     ad-hoc signature is the floor that lets a NON-quarantined copy run; it is
#     not notarizable and a quarantined copy is still gated. This keeps local/dev
#     and the pre-secret CI green until the MLA_APPLE_* credentials are provisioned.
# Windows is intentionally unsupported here (not ratified).
#
# Env overrides (the matrix CI sets none of the first group; they exist for tests/local):
#   MLA_CLI_DIR     path to packages/cli      (default: <repo>/packages/cli)
#   MLA_RELEASE_DIR output dir                (default: <repo>/release)
#   MLA_SKIP_BUILD  skip `pnpm build`         (default: unset -> build runs)
#   MLA_PKG_BIN     pkg executable            (default: local node_modules/.bin/pkg)
#   MLA_CODESIGN    codesign executable       (default: codesign)
#   MLA_XCRUN       xcrun executable          (default: xcrun; used for notarytool/stapler)
#   MLA_SMOKE       run --version/--help gate (default: unset; CI sets 1)
#
# Apple Developer-ID signing + notarization (all optional; absent -> ad-hoc):
#   MLA_APPLE_SIGN_IDENTITY        Developer ID Application identity (name or SHA-1).
#                                  Presence flips macOS signing to Developer-ID.
#   MLA_APPLE_NOTARY_KEY_ID        App Store Connect API key id       ) all three
#   MLA_APPLE_NOTARY_ISSUER_ID     App Store Connect issuer uuid       > required
#   MLA_APPLE_NOTARY_KEY_P8_BASE64 base64 of the AuthKey_XXXX.p8 file ) to notarize
#
# NOTE: pin/verify the @yao-pkg/pkg version and that its node22 base binaries
# exist for every target before a real release; pkg-fetch downloads them once.
set -euo pipefail

KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "build-release: error: missing platform key (macos-arm64|macos-x64|linux-x64|linux-arm64)" >&2
  exit 2
fi

# map platform key -> pkg target, release triple. Windows is deliberately absent.
# The triples MUST equal install.sh's detect_target output (<arch>-<os>) so the
# published asset name is the one the installer resolves.
case "$KEY" in
  macos-arm64) PKG_TARGET="node22-macos-arm64"; TRIPLE="aarch64-apple-darwin";      SIGN=1 ;;
  macos-x64)   PKG_TARGET="node22-macos-x64";   TRIPLE="x86_64-apple-darwin";       SIGN=1 ;;
  linux-x64)   PKG_TARGET="node22-linux-x64";   TRIPLE="x86_64-unknown-linux-gnu";  SIGN=0 ;;
  linux-arm64) PKG_TARGET="node22-linux-arm64"; TRIPLE="aarch64-unknown-linux-gnu"; SIGN=0 ;;
  *)
    echo "build-release: error: unknown platform key '$KEY' (want macos-arm64|macos-x64|linux-x64|linux-arm64)" >&2
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

# 4. macOS signing. Developer-ID when MLA_APPLE_SIGN_IDENTITY is set (the durable
#    BUG-1 fix), else ad-hoc (the floor, kept for local/dev + pre-secret CI).
if [ "$SIGN" = "1" ]; then
  SIGN_IDENTITY="${MLA_APPLE_SIGN_IDENTITY:-}"
  if [ -n "$SIGN_IDENTITY" ]; then
    say "Developer-ID signing $EXE (hardened runtime + secure timestamp) as: $SIGN_IDENTITY"
    # --options runtime is REQUIRED for notarization; --timestamp gets a secure
    # Apple timestamp so the signature keeps validating after the cert expires.
    "$CODESIGN" --sign "$SIGN_IDENTITY" --options runtime --timestamp \
      --force "$STAGE/$EXE"
    # --strict: reject an ad-hoc or malformed signature; a real Developer-ID sig
    # must pass before we bother notarizing.
    "$CODESIGN" --verify --strict --verbose=2 "$STAGE/$EXE" \
      || err "Developer-ID signature verification failed"
  else
    say "ad-hoc signing $EXE (no MLA_APPLE_SIGN_IDENTITY; not notarizable)"
    "$CODESIGN" -s - --force "$STAGE/$EXE"
    "$CODESIGN" -dv "$STAGE/$EXE" || err "ad-hoc signature verification failed"
  fi
fi

# 4b. Notarization (macOS, Developer-ID only). Submits the signed binary to
#     Apple's notary service, which registers its code-directory hash so a
#     QUARANTINED download passes Gatekeeper instead of being SIGKILLed (BUG-1).
#     Gated on the App Store Connect API-key trio; when the identity is set but
#     the trio is absent we sign-only and WARN. notarytool needs a container, so
#     we zip the exec with ditto (preserves the embedded signature).
#     A BARE Mach-O executable cannot hold a stapled ticket (`stapler` only
#     staples .app/.pkg/.dmg), so stapling is best-effort: on the expected
#     failure we rely on Gatekeeper's ONLINE notarization check plus install.sh's
#     quarantine strip, rather than failing the release.
if [ "$SIGN" = "1" ] && [ -n "${MLA_APPLE_SIGN_IDENTITY:-}" ]; then
  XCRUN="${MLA_XCRUN:-xcrun}"
  NKEY_ID="${MLA_APPLE_NOTARY_KEY_ID:-}"
  NISSUER="${MLA_APPLE_NOTARY_ISSUER_ID:-}"
  NKEY_B64="${MLA_APPLE_NOTARY_KEY_P8_BASE64:-}"
  if [ -n "$NKEY_ID" ] && [ -n "$NISSUER" ] && [ -n "$NKEY_B64" ]; then
    say "notarizing $EXE via notarytool (key-id $NKEY_ID)"
    NZIP="$STAGE/${EXE}-notarize.zip"
    P8="$STAGE/notary-key.p8"
    # Materialize the private key from base64 inside the auto-cleaned STAGE tmpdir
    # so it never lands in the release dir or the archive.
    printf '%s' "$NKEY_B64" | base64 -d > "$P8" \
      || err "could not decode MLA_APPLE_NOTARY_KEY_P8_BASE64"
    ( cd "$STAGE" && ditto -c -k "$EXE" "$NZIP" ) \
      || err "could not zip $EXE for notarization"
    "$XCRUN" notarytool submit "$NZIP" \
      --key "$P8" --key-id "$NKEY_ID" --issuer "$NISSUER" \
      --wait --timeout 20m \
      || err "notarization was rejected (see the notarytool log above)"
    rm -f "$P8" "$NZIP"
    if "$XCRUN" stapler staple "$STAGE/$EXE" 2>/dev/null; then
      say "stapled the notarization ticket to $EXE"
    else
      say "note: a bare executable cannot be stapled (expected); relying on online notarization + install-time de-quarantine"
    fi
  else
    say "WARNING: Developer-ID signed but NOT notarized. Set MLA_APPLE_NOTARY_KEY_ID + MLA_APPLE_NOTARY_ISSUER_ID + MLA_APPLE_NOTARY_KEY_P8_BASE64 to notarize; a quarantined download may still be gated."
  fi
fi

# 5. archive with the canonical name, executable at the archive root.
mkdir -p "$RELEASE_DIR"
tar -czf "$RELEASE_DIR/$ARCHIVE" -C "$STAGE" "$EXE"

# 6. enforce the archive-root contract that install.sh depends on.
tar -tzf "$RELEASE_DIR/$ARCHIVE" | grep -qx "$EXE" \
  || err "archive root does not contain exactly '$EXE' (release-layout bug)"

# 7. per-asset checksum in install.sh's expected "<hex>  <filename>" format.
(
  cd "$RELEASE_DIR"
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256"
  else err "no sha256 tool (need sha256sum or shasum)"; fi
)

# 8. extract-verify-smoke (CI runs this on the NATIVE runner, MLA_SMOKE=1). The
#    prior gate ran --version on the STAGED binary; that proved nothing about the
#    shipped archive, and neither the addon dlopen nor the MCP wiring. This one
#    unpacks the REAL archive into a throwaway dir with NO chmod and asserts:
#      (a) the archive root really is the `mla` executable, and
#      (b) the extracted file is ALREADY executable (test -x) -- the exec bit is
#          load-bearing for the Homebrew cask path (render-cask.sh never chmods),
#          so we must NEVER chmod +x here to make a smoke pass.
#    Then it drives the offline pkg-binary scenarios (storage/mcp/ask-core/docs)
#    against the extracted binary; `docs` is the one that proves the compiled-in
#    documentation corpus survived pkg (the pre-auth surface: no login, no workspace,
#    no network). Each scenario self-isolates HOME/MEETLESS_HOME/TMPDIR and
#    cleans up on EXIT; the extracted dir is removed by this block's own trap. Only
#    the native runner sets MLA_SMOKE=1 (a cross-compiled target can't execute here).
if [ "${MLA_SMOKE:-}" = "1" ]; then
  say "smoke: extract archive + drive packaged scenarios (no chmod)"
  SMOKE_EXTRACT="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand SMOKE_EXTRACT now, on purpose.
  trap 'rm -rf "$STAGE" "$SMOKE_EXTRACT"' EXIT
  tar -xzf "$RELEASE_DIR/$ARCHIVE" -C "$SMOKE_EXTRACT"
  [ -f "$SMOKE_EXTRACT/$EXE" ] || err "extract-smoke: archive did not yield $EXE at its root"
  [ -x "$SMOKE_EXTRACT/$EXE" ] \
    || err "extract-smoke: extracted $EXE is not executable (exec bit lost in the archive)"
  bash "$SCRIPT_DIR/smoke/packaged.sh" "$SMOKE_EXTRACT/$EXE" \
    || err "extract-smoke: packaged scenarios failed against the extracted binary"
  say "smoke: OK (extracted binary is executable and all packaged scenarios passed)"
fi

say "done: $RELEASE_DIR/$ARCHIVE"
say "      $(cut -d' ' -f1 < "$RELEASE_DIR/$ARCHIVE.sha256")  $ARCHIVE"
