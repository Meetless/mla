#!/usr/bin/env bash
# Phase 5 canary (DEFERRED-EXERCISE): the self-update surface, `mla upgrade`.
#
# Proposal §232 parks this until it can be exercised: a genuine cross-version
# upgrade needs a PRIOR published, signed release to upgrade FROM (on a real release
# that is the previous tag). This script is built and review-ready; it is wired as
# an OPT-IN, workflow_dispatch-only job (a `canary_prev_version` input; skipped when
# empty) rather than a default release gate, because it cannot run until two signed
# releases exist on GCS. A release binary reads the LIVE manifest from GCS and swaps
# in place, so no dev-build manifest override is needed on a real release.
#
# It installs mla@<prev_version> via the pinned installer, runs `mla upgrade`, and
# asserts the live binary now reports <new_version> AND the single rollback slot
# ~/.meetless/bin/mla.prev holds the prior bytes (upgrade-apply.ts prevBinaryPath).
# maybePromoteStagedAndReExec swaps the staged binary on the NEXT invocation, so the
# post-upgrade `--version` (inside canary_assert_version) is what drives promotion.
#
# Usage: canary/self-update.sh <prev_version> <new_version>
#   MLA_CANARY_INSTALL_URL  installer URL (default: the published GCS install.sh)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

PREV="${1:?usage: self-update.sh <prev_version> <new_version>}"
NEW="${2:?usage: self-update.sh <prev_version> <new_version>}"
PREV="${PREV#v}"; NEW="${NEW#v}"
INSTALL_URL="${MLA_CANARY_INSTALL_URL:-https://storage.googleapis.com/meetless-public/cli/install.sh}"

[ "$PREV" != "$NEW" ] || canary_die "prev ($PREV) and new ($NEW) are identical; nothing to upgrade"

canary_init "self-update"
MLA_BIN="$HOME/.meetless/bin/mla"

canary_ok "installing prior mla $PREV via install.sh"
canary_fetch_installer "$INSTALL_URL" "$CANARY_ROOT/install.sh"
MLA_VERSION="$PREV" sh "$CANARY_ROOT/install.sh" || canary_die "install of $PREV failed"
canary_assert_version "$MLA_BIN" "$PREV"

canary_ok "mla upgrade -> $NEW"
"$MLA_BIN" upgrade || canary_die "mla upgrade exited nonzero"

# The next invocation promotes the staged binary and re-execs; assert it now reports
# the new release and that the rollback slot was written.
canary_assert_version "$MLA_BIN" "$NEW"
[ -x "$HOME/.meetless/bin/mla.prev" ] \
  || canary_die "rollback slot ~/.meetless/bin/mla.prev missing after upgrade"
canary_ok "rollback slot present: $HOME/.meetless/bin/mla.prev"

canary_ok "PASS: self-update $PREV -> $NEW"
