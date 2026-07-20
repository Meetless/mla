# Governance rule: notes-location (documentation must land in docs/decisions)

This fixture assumes one governance rule is active in the bound workspace. It is
the single **hard block** the demo relies on.

## Rule

- **id (example):** `notes-location`
- **applies to:** `Write` / `Edit` of any `*.md` file
- **prohibited location:** a `notes/` directory at the repository root
- **approved location:** `docs/decisions/`
- **reason:** design notes, decision records, and working Markdown belong in the
  reviewed `docs/decisions/` tree, never in an unreviewed `notes/` scratch
  directory.

## Why this rule is the demo's hard block

Meetless ships **WARN** as the default enforcement ceiling: a decision
contradiction surfaces evidence and warns, but does not block. The
notes-location rule is the one family that can hard-deny **before execution**,
and only when the session raises the ceiling with
`MEETLESS_ACTION_INTERCEPT_MAX=deny`. The demo raises the ceiling for exactly
this rule so the block is real and visible on camera. Everything else stays
advisory. See the top-level `README.md` for the full enforcement-ceiling
explanation.

## Installing the rule (operator / hosted judge env, §7.1)

In the hosted judge workspace, register this rule so a Markdown write under
`notes/` is denied and the reason points at `docs/decisions/`. The reset script
does not touch this rule; it is part of the pre-seeded workspace state.
