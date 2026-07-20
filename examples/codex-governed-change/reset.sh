#!/usr/bin/env bash
#
# reset.sh: return the fixture to its pre-demo state so you can run the demo again.
#
# What "reset" means here, and what it deliberately does NOT touch:
#
#   1. It removes the Markdown files Codex WROTE during the demo (the corrected
#      note under docs/decisions/, and any stray file under notes/ if the run was
#      in advisory mode and the write was permitted). The tracked .gitkeep markers
#      are left in place. This is the reset that matters: it lets the
#      write-blocked-then-corrected sequence replay from a clean slate.
#
#   2. It does NOT tear down the seeded decision in governed memory. Governed
#      memory is DURABLE by design: once a decision is recorded it keeps informing
#      the agent, exactly as a real ADR would. You do not purge your decisions
#      between demo runs, so neither does this script. Retrieval stays grounded and
#      the next run works with no re-seed.
#
#   3. Enforcement incidents are an append-only audit trail. Re-running the demo
#      appends another incident; that is correct behavior, not residue. Adjudicate
#      with `mla enforcement confirm <id>` / `mla enforcement dismiss <id>`.
#
# To fully retire the governed record (rarely needed; e.g. tearing down a scratch
# workspace), run the `mla kb purge` command this script prints at the end. Two
# honest caveats: (a) slice A has no un-purge and re-adding the identical bytes is
# a `noop_unchanged`, so to re-ground after a purge you edit the decision file
# first; (b) the authoritative serving state is `mla kb show` (`serving: NO` once
# tombstoned), because the shadow retrieval index can briefly lag a tombstone.
#
# Usage:
#   ./reset.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DECISION="$SCRIPT_DIR/governance/superseding-decision.md"

echo "==> Removing the Markdown Codex wrote during the demo (keeping .gitkeep)"
rm -f "$SCRIPT_DIR"/docs/decisions/*.md
rm -f "$SCRIPT_DIR"/notes/*.md

echo "==> Working tree reset. The seeded decision stays in governed memory (durable"
echo "    by design), so retrieval is still grounded. Just run the demo again."
echo
echo "    To fully retire the governed record from a scratch workspace, run:"
echo "        MEETLESS_NOTES_ROOT=\"$SCRIPT_DIR\" mla kb purge \"$DECISION\" \\"
echo "          --reason \"retire codex-governed-change fixture decision\""
echo "    (no un-purge in slice A; re-adding identical bytes is a noop; the"
echo "     authoritative serving state is 'mla kb show', not retrieval.)"
