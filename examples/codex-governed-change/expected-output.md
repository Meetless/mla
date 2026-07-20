# What success looks like

Three artifacts prove the workflow ran. Shapes are shown; exact ids, timestamps,
and reason wording depend on your workspace and the active rule.

## 1. Governed retrieval surfaces the superseding decision (step 2)

When Codex calls `meetless__retrieve_knowledge` about the webhook retry policy,
the seeded decision comes back as evidence:

```
Decision: webhook retries must use exponential backoff with jitter (supersedes ADR-0007)
  ... exponential backoff with full jitter, base 1s, 2x, cap 300s, max 8 attempts ...
  ... the fixed 30-second interval from ADR-0007 is prohibited for all new delivery code ...
```

Codex should then implement exponential backoff with jitter, not the fixed
30-second interval the stale ADR still describes.

## 2. The pre-execution hard block (step 5)

When Codex tries to `Write` its design note under `notes/`, the PreToolUse hook
(`mla _internal pretool-observe`) returns the deny envelope on stdout, exit 0.
The decision rides the body, never the exit code:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by Meetless rule <ruleNodeId>. Writing notes/<your-note>.md under the forbidden \"notes/\" root is prohibited. design notes, decision records, and working Markdown belong in the reviewed docs/decisions/ tree, never in an unreviewed notes/ scratch directory.\n\nRun `mla enforcement` to confirm or dismiss this block."}}
```

The `permissionDecisionReason` is assembled by the enforcement seam: a fixed lead
sentence (`Blocked by Meetless rule <id>. Writing <path> under the forbidden
"notes/" root is prohibited.`), then the active rule's own text, then a blank line
and the `mla enforcement` hint. The rule id and the note path vary with your
workspace and run; the shape is fixed.

Codex sees the deny, does not write the file, and writes to `docs/decisions/`
instead (step 6). A write under `docs/decisions/` returns the empty pass-through
body `{}` (permitted).

Note: the block only fires when the session raised the ceiling with
`MEETLESS_ACTION_INTERCEPT_MAX=deny`. Without it, the same rule surfaces as an
advisory (WARN) and the write is permitted. See the top-level README.

## 3. The incident in the audit surface (step 7)

The denied attempt is captured. It appears in the enforcement surface:

```
$ mla enforcement --all
1 unreviewed enforcement block(s) in this workspace:

1. [...<id-suffix>] Write on docs  (<timestamp>)
   blocked: notes/<your-note>.md
   rule:    notes-location
   says:    design notes, decision records, and working Markdown belong in the reviewed docs/decisions/ tree, never in an unreviewed notes/ scratch directory.
   id:      <incident-id>

To adjudicate, run `mla enforcement confirm <id>` (a real catch) or
`mla enforcement dismiss <id>` (a false positive).
```

The bracket shows the id suffix; the full id is on the `id:` line. The `rule:` slug
and `says:` text come from the active rule, so they vary with your workspace.
Adjudicate with `mla enforcement confirm <id>` or `mla enforcement dismiss <id>`.
