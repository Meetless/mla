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
# THE BODY IS THE CHANGELOG PROSE, NOT THE COMMIT LIST.
# meetless-cli/CHANGELOG.md leads each version with a paragraph of prose and then lists
# the conventional-commit subjects. The prose is written for a human; the commit list is
# written for us ("fix(cli): activate told you to restart and not to restart, in one
# breath" is a great commit subject and a terrible announcement). So this strips the
# conventional-commit bullets and posts the prose. If a version has no prose (every
# release before 0.2.16), it falls back to the commit list rather than announcing an
# empty body, capped so the embed stays readable.
#
# NO LINK TO THE MIRROR. github.com/Meetless/mla is still a PRIVATE repo, so a
# "full changelog" link there is a 404 for everyone we are announcing to.
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

# Discord's embed description caps at 4096. Keep margin. There is deliberately no
# "full changelog" tail link: the public mirror is private, so it would 404.
MAXLEN=3800
if [ "${#BODY}" -gt "$MAXLEN" ]; then
  BODY="$(printf '%s' "$BODY" | cut -c1-"$MAXLEN")"$'\n…'
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
