#!/usr/bin/env bash
# Rewrite malformed `user_goal` values in the per-session turn ledgers.
#
# WHAT IS MALFORMED. Before extract_user_goal, record_session_turn stored
# `goal="${goal:0:400}"`: the first 400 characters of the prompt, called a goal.
# Measured over the live ledger 2026-08-06, 179 of 388 rows (46%) were at the cap,
# ended without terminal punctuation, spanned several lines, or opened with a
# markdown heading. Those four shapes are the test below.
#
# THE HONEST BLAST RADIUS, stated up front because it is small. collect_recent_turns
# reads only the LAST THREE rows of the CURRENT session's ledger. A row in a session
# that has ended can never be served again, and a row deeper than three in a live one
# cannot either. So this job repairs a corpus that is, in practice, almost entirely
# unreachable. It is run for the same reason a corrupt record gets fixed rather than
# reasoned about: the next person to read the ledger should not have to know which
# rows were a lie.
#
# WHAT IT DOES, per malformed row:
#   1. RECOMPUTE when the original prompt is recoverable. Recovery is exact, not
#      positional: ask-traces.jsonl carries input.raw_prompt_hash for
#      (session_id, turn_index), and the Claude Code transcript for that session
#      carries the prompt text. The row's prompt is the transcript message whose
#      sha256 MATCHES the recorded hash. No hash, no match, no recompute -- turn
#      ordinal alignment is NOT used as a fallback, because harness events advance
#      the counter without writing a ledger row and an off-by-one would silently
#      attach one turn's goal to another turn's evidence.
#   2. CLEAR otherwise. An empty goal is a truthful "we do not know what was asked";
#      the 400-char paste is not. A goal-less row still carries its turn identity, and
#      touched_files / outcome are attached at collect time regardless.
#   3. PRESERVE everything else byte for byte: turn_id, sequence, and any field a
#      future writer adds. The jq program below rewrites ONE key.
#
# REVERSIBLE AND IDEMPOTENT. Every touched ledger is copied to
# `<file>.pre-goal-remediation.bak` before the first write (never overwritten, so a
# second run cannot destroy the original). Idempotent because the malformed test is
# a property of the VALUE: a repaired row is well-formed or empty, and neither is
# malformed, so a re-run rewrites nothing.
#
# DEFAULT IS DRY RUN. `--apply` writes.
#
#   scripts/remediate-turn-goals.sh              # report only
#   scripts/remediate-turn-goals.sh --apply      # rewrite, with backups
#   scripts/remediate-turn-goals.sh --restore    # put every .bak back
set -uo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../src/hooks-template" && pwd)"
# shellcheck source=/dev/null
source "$HOOKS_DIR/common.sh" >/dev/null 2>&1 || {
  printf 'cannot source common.sh (needed for extract_user_goal)\n' >&2
  exit 1
}

QUEUE="${QUEUE_DIR:-$HOME/.meetless/queue}"
TRACES="${LOG_DIR:-$HOME/.meetless/logs}/ask-traces.jsonl"
TRANSCRIPTS="$HOME/.claude/projects"
MODE="dry"
case "${1:-}" in
  --apply) MODE="apply" ;;
  --restore) MODE="restore" ;;
  "" | --dry-run) MODE="dry" ;;
  *) printf 'usage: %s [--apply|--restore]\n' "$0" >&2; exit 2 ;;
esac

if [[ "$MODE" == "restore" ]]; then
  n=0
  for b in "$QUEUE"/*.turns.pre-goal-remediation.bak; do
    [[ -e "$b" ]] || continue
    cp -f "$b" "${b%.pre-goal-remediation.bak}" && n=$((n + 1))
  done
  printf 'restored %d ledger(s) from backup\n' "$n"
  exit 0
fi

# The four shapes the census measured. A goal that is already empty is NOT malformed
# (it is the new writer saying "no confident request"), which is what makes a re-run
# a no-op.
is_malformed() {
  local g="$1"
  [[ -z "$g" ]] && return 1
  (( ${#g} >= 400 )) && return 0                    # cut at the cap
  [[ "$g" == *$'\n'* ]] && return 0                 # several lines: a paste, not a request
  [[ "$g" =~ ^[[:space:]]*# ]] && return 0          # opens with a markdown heading
  [[ "$g" =~ [.!?:\)\"][[:space:]]*$ ]] && return 1 # ends cleanly
  return 0                                          # no terminal punctuation
}

# Print the ORIGINAL prompt for (session, turn) or nothing. Hash-verified only.
recover_prompt() {
  local sid="$1" turn="$2" want
  [[ -s "$TRACES" ]] || return 0
  want="$(grep -F "\"$sid\"" "$TRACES" 2>/dev/null \
    | jq -r --argjson t "$turn" 'select(.session_id != null and .turn_index == $t) | .input.raw_prompt_hash // empty' 2>/dev/null \
    | grep -m1 '^sha256:' || true)"
  [[ -n "$want" ]] || return 0
  local f
  for f in "$TRANSCRIPTS"/*/"$sid".jsonl; do
    [[ -f "$f" ]] || continue
    # One JSON object per candidate message, so a prompt containing newlines
    # survives the read loop below intact.
    local tmp; tmp="$(mktemp)" || return 0
    jq -c --arg want "${want#sha256:}" '
      select(.type == "user")
      | (if (.message.content | type) == "string" then .message.content
         elif (.message.content | type) == "array"
           then ([.message.content[] | select(.type == "text") | .text] | join("\n"))
         else "" end) as $t
      | select($t != "") | {t: $t}' "$f" 2>/dev/null > "$tmp"
    # `jq -j`, NOT `jq -r`. The hook hashed `printf '%s' "$PROMPT"`, with no
    # trailing newline; -r appends one, which changes every digest and makes the
    # whole recovery silently find nothing. It cost a run of 183 rows reported as
    # "unrecoverable" when the first candidate of the first session was an exact
    # match, so this is spelled out rather than left as a flag choice.
    local line got
    while IFS= read -r line; do
      got="$(printf '%s' "$line" | jq -j '.t' | shasum -a 256 2>/dev/null | awk '{print $1}')"
      if [[ "$got" == "${want#sha256:}" ]]; then
        printf '%s' "$line" | jq -j '.t'
        rm -f "$tmp"
        return 0
      fi
    done < "$tmp"
    rm -f "$tmp"
  done
  return 0
}

total=0 malformed=0 recomputed=0 cleared=0 files_touched=0
for ledger in "$QUEUE"/*.turns; do
  [[ -e "$ledger" ]] || continue
  sid="$(basename "$ledger" .turns)"
  out="$ledger.remediated.$$"
  : > "$out"
  changed=0
  while IFS= read -r row; do
    [[ -n "$row" ]] || continue
    total=$((total + 1))
    goal="$(printf '%s' "$row" | jq -r '.user_goal // ""' 2>/dev/null || printf '')"
    if ! is_malformed "$goal"; then
      printf '%s\n' "$row" >> "$out"
      continue
    fi
    malformed=$((malformed + 1))
    seq="$(printf '%s' "$row" | jq -r '.sequence // 0' 2>/dev/null || printf 0)"
    prompt="$(recover_prompt "$sid" "$seq")"
    new=""
    if [[ -n "$prompt" ]]; then
      new="$(extract_user_goal "$(strip_harness_blocks "$prompt")")"
    fi
    # IDEMPOTENCE IS A PROPERTY OF THE DIFF, NOT OF THE TEST. The first version
    # keyed only on is_malformed, and is_malformed flags "no terminal punctuation"
    # -- which is a SHAPE extract_user_goal legitimately produces, because a line
    # with no full stop is bounded at the line. So 15 correctly-repaired rows were
    # re-flagged and rewritten on every subsequent run, forever, with the identical
    # value. A row is only CHANGED when the new value differs from the old one.
    if [[ "$new" == "$goal" ]]; then
      malformed=$((malformed - 1))
      printf '%s\n' "$row" >> "$out"
      continue
    fi
    if [[ -n "$new" ]]; then
      recomputed=$((recomputed + 1))
    else
      cleared=$((cleared + 1))
    fi
    # ONE key rewritten; every other field, present or future, rides through.
    printf '%s\n' "$row" | jq -c --arg g "$new" '.user_goal = $g' >> "$out" 2>/dev/null \
      || printf '%s\n' "$row" >> "$out"
    changed=1
    [[ "$MODE" == "dry" ]] && printf 'WOULD %s  %s:%s  %s\n' \
      "$([[ -n "$new" ]] && printf recompute || printf clear)" "$sid" "$seq" \
      "$(printf '%.70s' "${new:-<clear>}")"
  done < "$ledger"

  if [[ "$changed" == "1" && "$MODE" == "apply" ]]; then
    # Backup once, never overwritten: a second run must not be able to destroy the
    # original by backing up the already-repaired file over it.
    [[ -f "$ledger.pre-goal-remediation.bak" ]] || cp -f "$ledger" "$ledger.pre-goal-remediation.bak"
    mv -f "$out" "$ledger"
    files_touched=$((files_touched + 1))
  else
    rm -f "$out"
  fi
done

printf '\n%s: rows=%d malformed=%d recomputed=%d cleared=%d ledgers_written=%d\n' \
  "$([[ "$MODE" == "apply" ]] && printf APPLIED || printf 'DRY RUN')" \
  "$total" "$malformed" "$recomputed" "$cleared" "$files_touched"
[[ "$MODE" == "apply" ]] && printf 'backups: %s/*.turns.pre-goal-remediation.bak (restore with --restore)\n' "$QUEUE"
exit 0
