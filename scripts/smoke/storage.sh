#!/usr/bin/env bash
# §6.1 Packaged storage smoke (Phase 1, offline).
#
# Proves B2: the better-sqlite3 native addon embedded in the pkg binary materializes
# out of /snapshot and dlopens. `mla rules activity --json` is the shortest
# deterministic CE0 trigger (a pure local read; no init, no backend).
#
# Assertions (proposal §259):
#   * TMPDIR/mla-native/better_sqlite3-*.node is ABSENT before (fresh TMPDIR) and
#     PRESENT after -- written only under process.pkg (native-binding.ts:41-72), so
#     a source-tree build can never fake this proof.
#   * exit 0 (a /snapshot dlopen failure throws nonzero).
#   * stdout parses as JSON carrying runtimeScopeId.
#   * MEETLESS_HOME/ce0/evidence.db was created.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$DIR/lib.sh"
smoke_init storage "${1:?usage: storage.sh <mla-bin>}"

NATIVE_GLOB="$TMPDIR/mla-native/better_sqlite3-*.node"

# (a) fresh, not stale: a fresh per-run TMPDIR must not already carry the addon.
if compgen -G "$NATIVE_GLOB" >/dev/null 2>&1; then
  smoke_die "native addon already present in a fresh TMPDIR (stale-state false pass): $NATIVE_GLOB"
fi

OUT="$SMOKE_ROOT/activity.json"
ERR="$SMOKE_ROOT/activity.err"
if ! "$SMOKE_BIN" rules activity --json >"$OUT" 2>"$ERR"; then
  cat "$ERR" >&2
  smoke_die "mla rules activity --json exited nonzero"
fi

# (b) exit 0 + valid JSON carrying runtimeScopeId.
smoke_assert_json_contains "$OUT" '"runtimeScopeId"'

# (c) the addon materialized -> binary-only proof of the /snapshot dlopen.
if ! compgen -G "$NATIVE_GLOB" >/dev/null 2>&1; then
  smoke_die "native addon did NOT materialize after CE0 open: $NATIVE_GLOB"
fi

# (d) the CE0 store exists on disk.
[ -f "$MEETLESS_HOME/ce0/evidence.db" ] \
  || smoke_die "CE0 store not created at $MEETLESS_HOME/ce0/evidence.db"

smoke_ok "OK: addon materialized, evidence.db created, rules activity --json valid"
