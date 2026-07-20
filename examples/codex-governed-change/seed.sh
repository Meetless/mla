#!/usr/bin/env bash
#
# seed.sh: seed this fixture's superseding decision into the bound workspace's
# governed memory, so Codex can retrieve it during the demo.
#
# After this runs, `meetless__retrieve_knowledge` (the MCP tool Codex calls
# through the mla plugin) returns the superseding decision, so Codex can discover
# that ADR-0007 is superseded before it writes any code. A freshly added doc is
# served and grounds retrieval immediately (born PENDING, flagged untrusted).
#
# The decision doc lives inside this fixture (governance/superseding-decision.md).
# We point the KB vault root at this fixture directory with MEETLESS_NOTES_ROOT so
# the seed lands with a self-contained, purgeable identity and never touches any
# real notes vault. The governed doc id becomes:
#
#     notes/governance/superseding-decision.md
#
# IDEMPOTENT: governed memory is durable. The first run reports `ingested`. If the
# decision is already grounded from a prior run, the governed front door is a
# content-addressed upsert with no restore branch, so a re-run reports
# `noop_unchanged`. That is NOT an error: it means the decision is already in
# governed memory and retrieval is still grounded. You do not need to re-seed
# between demo runs; use reset.sh to clear only the files Codex writes.
#
# Accepting the claim (so it is TRUSTED, not just served) is deliberately a human
# verdict: `mla kb accept` refuses `--agent` because accepting manufactures
# institutional memory. So this script seeds and then shows you the one command to
# accept. The demo works either way; accept it for the fully-trusted state.
#
# Prerequisites:
#   - `mla` on PATH, logged in (`mla login`) or a shared key (`mla init`).
#   - The workspace is bound to a repo (`mla activate`) and reachable
#     (deployed backend, or local Control + Intel).
#
# Usage:
#   ./seed.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DECISION="$SCRIPT_DIR/governance/superseding-decision.md"

command -v mla >/dev/null 2>&1 || { echo "mla is not on PATH. Install it first." >&2; exit 1; }
[ -f "$DECISION" ] || { echo "missing $DECISION" >&2; exit 1; }

echo "==> Seeding the superseding decision into governed memory"
OUT="$(MEETLESS_NOTES_ROOT="$SCRIPT_DIR" mla kb add "$DECISION" --mode file --provenance codex-fixture 2>&1)"
echo "$OUT"

echo
if grep -q "noop_unchanged" <<<"$OUT"; then
  echo "==> Already grounded from a prior run (governed memory is durable)."
  echo "    'noop_unchanged' is expected here, not a failure: the decision is"
  echo "    already in governed memory and retrieval still surfaces it. To replay"
  echo "    the demo, run ./reset.sh (it clears only what Codex writes)."
else
  echo "==> Seeded. It already grounds retrieval as PENDING."
fi

echo
echo "    To make it TRUSTED (accepted), list the pending claim and accept it:"
echo
echo "        mla kb claims --pending"
echo "        mla kb accept <claimId>"
echo
echo "    Verify retrieval surfaces it: ask Codex (or the MCP tool) about the"
echo "    webhook retry policy; the answer should cite the exponential-backoff ruling."
