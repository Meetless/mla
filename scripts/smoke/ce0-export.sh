#!/usr/bin/env bash
# CE0 export smoke (Phase 2 npm-tarball path, §187-202).
#
# The npm package declares better-sqlite3 as a runtime dep and builds its OWN addon
# (no /snapshot embedding), so the storage proof for the .tgz is not "did the embedded
# addon materialize" but "does the freshly-built addon dlopen and back a real CE0 store".
# `mla evidence ce0-export` is the shortest command that opens the store and writes it.
#
# Assertions:
#   * exit 0.
#   * MEETLESS_HOME/ce0/evidence.db exists and carries the SQLite file magic
#     ("SQLite format 3\0"), so a zero-byte or truncated file cannot green the run.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$DIR/lib.sh"
smoke_init ce0-export "${1:?usage: ce0-export.sh <mla-bin>}"

# ce0-export resolves a workspace before it opens the store (evidence.ts
# withWorkspaceAndStore -> exit 1 with no store if none resolves). The sandbox has
# no .meetless.json marker, so hand it one via the operator override env var.
export MEETLESS_WORKSPACE_ID="ws_smoke"

OUT="$SMOKE_ROOT/export.out"
ERR="$SMOKE_ROOT/export.err"
if ! "$SMOKE_BIN" evidence ce0-export >"$OUT" 2>"$ERR"; then
  cat "$ERR" >&2
  smoke_die "mla evidence ce0-export exited nonzero"
fi

DB="$MEETLESS_HOME/ce0/evidence.db"
[ -f "$DB" ] || smoke_die "CE0 store not created at $DB"

# SQLite magic is the first 16 bytes: "SQLite format 3\000".
MAGIC="$(dd if="$DB" bs=1 count=15 2>/dev/null)"
[ "$MAGIC" = "SQLite format 3" ] \
  || smoke_die "CE0 store is not a SQLite database (bad magic: '$MAGIC')"

smoke_ok "OK: ce0-export ran, evidence.db is a valid SQLite database"
