#!/usr/bin/env bash
# Packaged pkg-binary smoke driver (release-testing proposal Phase 1).
#
# Runs the offline scenarios that prove the SHIPPED pkg binary works end to end
# against the real artifact the release job just built (or extracted from the archive):
#   storage   §6.1  embedded better-sqlite3 addon materializes out of /snapshot + dlopens
#   mcp       §6.2  `mla init` wires a real (non-/snapshot) MCP command; `mla mcp` boots
#   ask-core  §6.2a the ask-core bundle require()s and reaches the network before failing
#   docs      the bundled docs corpus renders offline, with no login and no workspace
#             (self-documenting-CLI proposal 20260711 §11 test 26)
#
# Each scenario is a self-isolating subprocess (its own sandbox + EXIT-trap cleanup),
# so one driver run leaves nothing behind and a failure in one cannot leak into another.
# The driver runs them in sequence and fails fast on the first red (proposal §146).
#
# Usage: packaged.sh <mla-bin> [scenario ...]
#   Default scenario set: storage mcp ask-core docs.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

BIN="${1:?usage: packaged.sh <mla-bin> [scenario ...]}"
shift || true
SCENARIOS=("$@")
if [ "${#SCENARIOS[@]}" -eq 0 ]; then
  SCENARIOS=(storage mcp ask-core docs)
fi

# Absolute-ize the binary once so every child gets a stable path regardless of its cwd.
case "$BIN" in
  /*) : ;;
  *)  BIN="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")" ;;
esac
[ -x "$BIN" ] || { printf 'packaged: FAIL: mla binary is not executable: %s\n' "$BIN" >&2; exit 1; }

printf 'packaged: driving %d scenario(s) against %s\n' "${#SCENARIOS[@]}" "$BIN"
for name in "${SCENARIOS[@]}"; do
  script="$DIR/$name.sh"
  [ -f "$script" ] || { printf 'packaged: FAIL: no such scenario: %s\n' "$script" >&2; exit 1; }
  printf '\npackaged: === %s ===\n' "$name"
  bash "$script" "$BIN" || { printf 'packaged: FAIL: scenario %s failed\n' "$name" >&2; exit 1; }
done

printf '\npackaged: OK: all %d scenario(s) passed\n' "${#SCENARIOS[@]}"
