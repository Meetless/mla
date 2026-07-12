#!/usr/bin/env bash
# §6.2a Packaged ask-core load smoke (Phase 1, offline).
#
# Proves B4b: the shipped binary really require()s dist/bundles/ask-core.js. The
# bundle loads AFTER config/workspace resolution and BEFORE any network call, so
# pointing `mla ask` at an unreachable intel must surface a CONNECTION error, never
# a bundle-LOAD error. Two guards keep it honest:
#   * a minimal cli-config.json is written first, else readConfig() throws
#     "cli-config.json not found" pre-bundle -- a false pass (config.ts:319-324).
#   * `--workspace ws_smoke` short-circuits marker resolution (config.ts:413-416),
#     so it never fails on "not activated" before the bundle loads.
#
# Assertion (both classes exit 1, so the message is the discriminator, on stderr):
#   * stderr CONTAINS     "intel not reachable at http://127.0.0.1:1"  (fetch failed)
#   * stderr DOES NOT     "failed to load @meetless/ask-core"          (require failed)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$DIR/lib.sh"
smoke_init ask-core "${1:?usage: ask-core.sh <mla-bin>}"

# Minimal shared-key config so readConfig() succeeds; the token is never used
# because the bundle fails at the socket first. Shape per config.ts CliAuth.
cat > "$MEETLESS_HOME/cli-config.json" <<'JSON'
{
  "auth": { "mode": "shared-key", "accessToken": "smoke-not-a-real-key" },
  "controlUrl": "http://127.0.0.1:1",
  "intelUrl": "http://127.0.0.1:1"
}
JSON

OUT="$SMOKE_ROOT/ask.out"
ERR="$SMOKE_ROOT/ask.err"
set +e
MEETLESS_INTEL_URL="http://127.0.0.1:1" \
  "$SMOKE_BIN" ask "ping" --workspace ws_smoke >"$OUT" 2>"$ERR"
CODE=$?
set -e

[ "$CODE" -eq 1 ] || { cat "$ERR" >&2; smoke_die "expected exit 1 (connection failure), got $CODE"; }

if grep -q "failed to load @meetless/ask-core" "$ERR"; then
  cat "$ERR" >&2
  smoke_die "ask-core bundle FAILED to load (require error, not a connection error)"
fi
grep -q "intel not reachable at http://127.0.0.1:1" "$ERR" \
  || { cat "$ERR" >&2; smoke_die "missing expected 'intel not reachable at http://127.0.0.1:1' connection error"; }

smoke_ok "OK: bundle required, reached the socket, mapped to 'intel not reachable'"
