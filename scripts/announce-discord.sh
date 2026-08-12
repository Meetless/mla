#!/usr/bin/env bash
# Announce an mla release to the PUBLIC Meetless community Discord (#announcements).
#
# WHY THIS LIVES IN THE REPO AND NOT IN A SKILL:
# It used to live only in ~/.claude/skills/mla-release/ as "Phase 8" of a checklist an
# agent was trusted to finish. 0.2.17 shipped to GCS, npm and Homebrew, was verified
# live against prod, and was announced to nobody, because the checklist stopped at
# Phase 7. A release step that only happens when someone remembers it is not a step.
# CI runs it now; the skill's copy is the manual fallback.
#
# THE BODY IS THE `## <version>` CHANGELOG SECTION, POSTED NEARLY VERBATIM.
# That section is written for a user, not for us: one or two plain sentences saying what this
# release gives you, then **New** / **Fixed** bullets naming the commands, under 150 words, with
# no commit subjects, no internal file/env/function names, and no em dashes.
#
# There is no second place to write a nicer announcement. Whatever went into the changelog is
# what the public reads, so the quality of this post was decided when the changelog was written.
#
# The conventional-commit strip below is a LEGACY SAFETY NET, not the design. Releases through
# 0.2.34 pasted the raw commit list under the prose ("fix(cli): activate told you to restart and
# not to restart, in one breath" is a great commit subject and a terrible announcement), so this
# drops those bullets. The current format never emits them. If a version somehow has nothing but
# commits, it falls back to a capped list rather than announcing an empty body.
#
# NO LINK TO THE MIRROR, and the reason is no longer the one written here.
# github.com/Meetless/mla was private when this script was written, so a "full changelog"
# link would have 404'd for everyone we announce to. An ruled it PUBLIC on 2026-07-17
# (verified `isPrivate:false`), so that link would resolve today. The behavior stays as it
# is anyway: adding a mirror link to the announcement is a product decision for An, not a
# default this script gets to make. Do not restore the old rationale; it is false.
#
# Usage: announce-discord.sh <version> [--changelog <path>] [--dry-run]
#
# Webhook resolution (first hit wins):
#   1. $DISCORD_RELEASE_WEBHOOK            (CI: repo secret)
#   2. $MEETLESS_DISCORD_RELEASE_WEBHOOK   (local operator override)
#   3. ~/.meetless/discord-release-webhook (local file: just the URL, chmod 600)
# With no webhook it prints the payload and exits 0 (dry run).
#
# SCOPE: this webhook targets the PUBLIC community server ONLY. It is unrelated to the
# private Hermes agent-box bot (#build). It is a WEBHOOK URL, never a bot token.
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: announce-discord.sh <version> [--changelog <path>] [--dry-run]" >&2
  exit 2
fi
shift
VERSION="${VERSION#cli-v}"; VERSION="${VERSION#v}"   # tolerate v / cli-v prefixes

HERE="$(cd "$(dirname "$0")" && pwd)"
CHANGELOG="${MEETLESS_CHANGELOG:-$HERE/../CHANGELOG.md}"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --changelog) CHANGELOG="${2:-}"; shift 2;;
    --dry-run)   DRY_RUN=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "WARN: jq not found; cannot build the payload safely. Skipping announce." >&2; exit 0; }
[ -f "$CHANGELOG" ] || { echo "WARN: changelog not found at $CHANGELOG; skipping announce." >&2; exit 0; }

# The section for this version: everything between "## <version>" and the next "## ".
SECTION="$(awk -v ver="$VERSION" '
  $0 ~ ("^## " ver "([ ]|\\(|$)") { grab=1; next }
  grab && /^## / { exit }
  grab { print }
' "$CHANGELOG")"

# Trim leading + trailing blank lines. Portable (no tac), macOS-safe.
trim_blanks() {
  awk '
    { lines[NR]=$0 }
    END {
      s=1;  while (s<=NR && lines[s] ~ /^[ \t]*$/) s++
      e=NR; while (e>=s  && lines[e] ~ /^[ \t]*$/) e--
      for (i=s;i<=e;i++) print lines[i]
    }'
}

# The prose: drop every conventional-commit bullet ("- feat(cli): ...", "* fix: ...").
# What survives is the human paragraph plus any bullet a human actually wrote.
PROSE="$(printf '%s\n' "$SECTION" \
  | grep -Ev '^[ \t]*[-*][ \t]+(feat|fix|chore|ci|test|docs|refactor|perf|build|style|revert)(\([^)]*\))?!?:' \
  | trim_blanks)"

if [ -n "${PROSE//[$'\n\t ']/}" ]; then
  BODY="$PROSE"
else
  # Pre-0.2.16 releases have no prose. Announce the commit list rather than nothing,
  # but keep it to a readable head so #announcements never becomes a git log.
  echo "NOTE: v$VERSION has no changelog prose; falling back to the commit list." >&2
  BODY="$(printf '%s\n' "$SECTION" | trim_blanks | head -12)"
fi

if [ -z "${BODY//[$'\n\t ']/}" ]; then
  echo "WARN: no changelog entry found for v$VERSION in $CHANGELOG; skipping announce." >&2
  exit 0
fi

# Discord's embed description caps at 4096 CHARACTERS and rejects the entire POST with
# HTTP 400 {"embeds":["0"]} when you go over. Keep margin.
#
# This cap was a NO-OP from the day it was written. `cut -c1-N` truncates every LINE to N
# characters, not the stream to N characters, and a changelog body is many short lines, so
# it handed back the body unchanged and appended an ellipsis to a string it had not cut.
# 0.2.32's prose was 4499 characters: the guard fired, the cut did nothing, Discord refused
# 4501, and the release announced itself to nobody while the log said the body was trimmed.
#
# Truncate on LINE boundaries, then fall back to the last paragraph break. That can never
# split a word or a UTF-8 sequence (which would be a second, subtler 400), and it ends the
# announcement at the end of a paragraph instead of mid-sentence. For a changelog shaped
# "prose paragraphs, then a bullet list" it lands exactly where a reader would want it: the
# whole prose, none of the severed list.
MAXLEN=3800
if [ "${#BODY}" -gt "$MAXLEN" ]; then
  TRUNCATED="$(printf '%s\n' "$BODY" | awk -v max="$MAXLEN" '
    { n = length($0) + 1
      if (total + n > max) exit
      total += n
      buf[++k] = $0
      if ($0 ~ /^[ \t]*$/) last_blank = k
    }
    END {
      end = (last_blank > 0 ? last_blank - 1 : k)
      for (i = 1; i <= end; i++) print buf[i]
    }')"
  # One line longer than the whole cap would leave nothing at all: hard-cut that case.
  [ -n "${TRUNCATED//[$'\n\t ']/}" ] || TRUNCATED="${BODY:0:$MAXLEN}"
  BODY="$TRUNCATED"$'\n…'
fi

NPM_URL="https://www.npmjs.com/package/@meetless/mla"
INSTALL_CMD='curl -fsSL https://meetless.ai/install.sh | sh'

PAYLOAD="$(jq -n \
  --arg ver "$VERSION" \
  --arg body "$BODY" \
  --arg npm "$NPM_URL" \
  --arg install "$INSTALL_CMD" \
  '{
     username: "Meetless Releases",
     content: ("🚀 `mla v" + $ver + "` shipped"),
     embeds: [{
       title: ("mla v" + $ver),
       url: $npm,
       description: $body,
       color: 6579433,
       fields: [{ name: "Update", value: ("```\n" + $install + "\n```"), inline: false }],
       footer: { text: "Meetless · mla CLI" }
     }]
   }')"

WEBHOOK="${DISCORD_RELEASE_WEBHOOK:-${MEETLESS_DISCORD_RELEASE_WEBHOOK:-}}"
if [ -z "$WEBHOOK" ] && [ -f "$HOME/.meetless/discord-release-webhook" ]; then
  WEBHOOK="$(tr -d ' \t\r\n' < "$HOME/.meetless/discord-release-webhook")"
fi

if [ "$DRY_RUN" = "1" ] || [ -z "$WEBHOOK" ]; then
  [ -z "$WEBHOOK" ] && echo "NOTE: no webhook configured (DISCORD_RELEASE_WEBHOOK) so this is a DRY RUN." >&2
  echo "----- Discord payload (dry run) -----"
  printf '%s\n' "$PAYLOAD"
  exit 0
fi

# The temp file holds Discord's response body, which we only ever print on failure.
#
# `mktemp -t ml-discord-resp` is what used to be here. It is legal on BSD/macOS, where -t
# treats its argument as a PREFIX and appends the randomness itself. It is a hard error on
# GNU coreutils ("too few X's in template"), which is what every Linux CI runner has. This
# script had only ever been run on An's Mac, so the announce job died on its first real CI
# execution (0.2.18) with the webhook sitting right there, present and unused. Give the
# template its own X's: that form is the one both implementations accept.
#
# And do not let this file be load-bearing. If mktemp fails for any reason at all, the POST
# still goes out with the body discarded. The announcement is the product of this script;
# a scratch file for an error message we might never print is not worth failing it over.
RESP="$(mktemp "${TMPDIR:-/tmp}/ml-discord-resp.XXXXXX" 2>/dev/null || true)"
[ -n "$RESP" ] || RESP="/dev/null"
HTTP="$(curl -sS -o "$RESP" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -X POST -d "$PAYLOAD" "$WEBHOOK" 2>/dev/null || echo "000")"
if [ "$HTTP" = "200" ] || [ "$HTTP" = "204" ]; then
  echo "✅ Announced mla v$VERSION to the community Discord (HTTP $HTTP)."
  rm -f "$RESP" 2>/dev/null || true
  exit 0
fi

# The release is already published and verified by the time this runs, so a failure here
# cannot un-ship anything. It must still be LOUD: a silent skip is the bug we are fixing.
echo "::error::Discord announce FAILED (HTTP $HTTP) for mla v$VERSION. The release is published and unaffected, but the community was not told. Re-run: meetless-cli/scripts/announce-discord.sh $VERSION" >&2
cat "$RESP" >&2 2>/dev/null || true
rm -f "$RESP" 2>/dev/null || true
exit 1
