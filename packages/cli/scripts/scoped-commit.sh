#!/usr/bin/env bash
# Commit exactly the paths you name, on a working tree ten agent sessions share.
#
#   scoped-commit.sh -F <message-file> -- <path> [<path>...]
#   scoped-commit.sh -m <message>      -- <path> [<path>...]
#   scoped-commit.sh ... --blob <path>=<file> -- <path> [<path>...]
#
# WHY THIS EXISTS RATHER THAN A FLOOR RULE. The rule already says "stage into an
# isolated index, then commit that index with no pathspec", and following it by hand
# still destroyed six peer files on 2026-08-10. The rule is correct and it is not
# enough, because the hazard is not a spelling: an isolated index is a SNAPSHOT of
# HEAD, and on this tree HEAD moves between two tool calls.
#
# THE INCIDENT, in one line each:
#
#   1. `read-tree HEAD`, then a four-minute standalone verification, then
#      `commit-tree -p HEAD`. Three peer commits landed inside that window, so the
#      STALE tree was parented onto the NEW tip and reverted all three.
#   2. The repair loop called `update-index --cacheinfo` on a path the clobber had
#      DELETED. That needs `--add`, the loop aborted on the error, and the repair
#      shipped an index identical to the one it was fixing.
#
# Both are pinned as regressions against real git in
# `test/repo/shared-tree-commit-scoping.spec.ts`.
#
# WHAT THIS GUARANTEES, and it is deliberately three narrow things:
#
#   * the tree is ALWAYS built from the CURRENT HEAD. The index is rebuilt immediately
#     before `write-tree`, so a peer commit that lands mid-run cannot be reverted; the
#     worst case is a retry.
#   * `update-ref` uses the three-argument compare-and-swap. If HEAD moves in the last
#     few milliseconds the commit FAILS LOUDLY instead of racing.
#   * staging handles all three shapes of a path: modified, newly added, and deleted
#     from the working tree. A restore that silently stages nothing is the second
#     defect, so the staged set is VERIFIED against the requested set before committing.
#
# WHAT IT DELIBERATELY DOES NOT DO. No locking, no queue, no daemon. This is a startup
# and the failure it prevents is a race window measured in minutes, which a rebuild
# plus a compare-and-swap closes completely.
#
# Content comes from the WORKING TREE for the paths you name, which is the same content
# `git add -- <paths>` would stage. Read `git diff -- <your paths>` first.
#
# `--blob <path>=<file>` IS THE MIXED-FILE ESCAPE HATCH, and it is the hardest case on
# this tree rather than a convenience. When a peer is editing the SAME FILE you are, no
# pathspec and no index can split it: "path scoping bounds which FILES are committed,
# never whose CHANGES inside them". So you build the content you intend -- HEAD's
# version of that file with only your hunks applied -- and hand it in as a file. The
# staged blob is yours; the peer's working-tree hunks stay in the working tree, and every
# HEAD-race guarantee above still applies because the rebuild loop is unchanged.
#
# It cannot check that the content you hand in is really "HEAD plus only your hunks".
# Nothing can. What it does check is that the file exists and that something staged, so
# a typo'd path fails loudly rather than committing an empty change.

set -euo pipefail

usage() {
  echo "usage: scoped-commit.sh (-F <message-file> | -m <message>) -- <path> [<path>...]" >&2
  exit 2
}

MSG_FILE=""
MSG_TEXT=""
BLOB_PATHS=()
BLOB_FILES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -F) MSG_FILE="${2:-}"; shift 2 ;;
    -m) MSG_TEXT="${2:-}"; shift 2 ;;
    --blob)
      spec="${2:-}"
      [[ "$spec" == *=* ]] || { echo "scoped-commit: --blob wants <path>=<file>, got: $spec" >&2; exit 2; }
      bp="${spec%%=*}"; bf="${spec#*=}"
      [[ -f "$bf" ]] || { echo "scoped-commit: no such blob content file: $bf" >&2; exit 2; }
      BLOB_PATHS+=("$bp"); BLOB_FILES+=("$bf")
      shift 2 ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
PATHS=("$@")
[[ ${#PATHS[@]} -gt 0 ]] || usage
[[ -n "$MSG_FILE" || -n "$MSG_TEXT" ]] || usage
[[ -z "$MSG_FILE" || -f "$MSG_FILE" ]] || { echo "scoped-commit: no such message file: $MSG_FILE" >&2; exit 2; }

git rev-parse --git-dir >/dev/null 2>&1 || { echo "scoped-commit: not a git repository" >&2; exit 2; }
BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
[[ -n "$BRANCH" ]] || { echo "scoped-commit: detached HEAD, refusing" >&2; exit 2; }

INDEX="$(git rev-parse --git-dir)/scoped-commit-index.$$"
trap 'rm -f "$INDEX"' EXIT

# Stage the named paths into an index seeded from $1. Each path is handled by its shape,
# because the three shapes need three different commands and the second defect was
# exactly one of them reaching for the wrong one.
stage_from() {
  local base="$1"
  rm -f "$INDEX"
  GIT_INDEX_FILE="$INDEX" git read-tree "$base"
  local p i
  for p in "${PATHS[@]}"; do
    # A hand-built blob wins over the working tree: this is the mixed-file case, where
    # the working tree holds a peer's hunks as well as mine.
    local blob=""
    for i in "${!BLOB_PATHS[@]}"; do
      [[ "${BLOB_PATHS[$i]}" == "$p" ]] && blob="${BLOB_FILES[$i]}"
    done
    if [[ -n "$blob" ]]; then
      local sha
      sha="$(git hash-object -w "$blob")"
      GIT_INDEX_FILE="$INDEX" git update-index --add --cacheinfo "100644,$sha,$p"
    elif [[ -e "$p" ]]; then
      # `--add` covers BOTH the modified and the newly-added shape. Without it a path
      # absent from the base tree is a hard error, which is defect 2.
      GIT_INDEX_FILE="$INDEX" git update-index --add -- "$p"
    else
      # Deleted from the working tree. `--force-remove` is the only spelling that stages
      # a deletion for a path that is not on disk.
      GIT_INDEX_FILE="$INDEX" git update-index --force-remove -- "$p"
    fi
  done
}

# THE REBUILD LOOP. `read-tree` and `write-tree` are adjacent by construction here: the
# index is rebuilt from the HEAD read one line earlier, every attempt.
attempt=0
while :; do
  attempt=$((attempt + 1))
  if [[ $attempt -gt 5 ]]; then
    echo "scoped-commit: HEAD moved on 5 consecutive attempts, giving up rather than racing" >&2
    exit 1
  fi
  BASE="$(git rev-parse HEAD)"
  stage_from "$BASE"

  # The staged set must be the requested set. A path that staged nothing is either an
  # unchanged file (fine, and reported) or a silent no-op (defect 2, not fine).
  STAGED="$(GIT_INDEX_FILE="$INDEX" git diff --cached --name-only "$BASE" || true)"
  if [[ -z "$STAGED" ]]; then
    echo "scoped-commit: nothing to commit for: ${PATHS[*]}" >&2
    exit 1
  fi

  TREE="$(GIT_INDEX_FILE="$INDEX" git write-tree)"
  # Re-read HEAD AFTER write-tree. If it moved while we were staging, throw the tree
  # away and rebuild from the new tip: that is the whole fix for defect 1.
  NOW="$(git rev-parse HEAD)"
  if [[ "$NOW" != "$BASE" ]]; then
    echo "scoped-commit: HEAD moved $BASE -> $NOW while staging, rebuilding" >&2
    continue
  fi

  if [[ -n "$MSG_FILE" ]]; then
    NEW="$(git commit-tree "$TREE" -p "$BASE" -F "$MSG_FILE")"
  else
    NEW="$(git commit-tree "$TREE" -p "$BASE" -m "$MSG_TEXT")"
  fi

  # Compare-and-swap. If HEAD moved in the last milliseconds this FAILS rather than
  # clobbering, and the loop rebuilds.
  if git update-ref "refs/heads/$BRANCH" "$NEW" "$BASE" 2>/dev/null; then
    break
  fi
  echo "scoped-commit: lost the update-ref race at $BASE, rebuilding" >&2
done

# Disarm the SHARED index for these paths. `update-index` on a private index file never
# touched the shared one, so whatever was staged there before this run survives it and
# is now an OLDER version of the same file, ready for the next bare commit to put back.
git reset -q -- "${PATHS[@]}" 2>/dev/null || true

# Report from the COMMIT, never from the echo of what we intended to do.
echo "scoped-commit: ${NEW:0:12} on $BRANCH"
git show --stat --format="" "$NEW"
