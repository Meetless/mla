# Claude Code PreToolUse hook contract (pinned)

Pinned facts for the R0 action-interception layer. Verified against the locally
installed Claude Code **2.1.153** and the official docs
(https://code.claude.com/docs/en/hooks.md,
https://code.claude.com/docs/en/settings.md). The JSON fixtures in this
directory encode these shapes; the spec `contract-fixtures.spec.ts` locks the
observe adapter to them.

## Input (stdin, JSON, snake_case)

```json
{
  "session_id": "...",
  "transcript_path": "/.../transcript.jsonl",
  "cwd": "/...",
  "permission_mode": "default | plan | acceptEdits | bypassPermissions | ...",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write | Edit | Bash | ...",
  "tool_input": { "...tool-specific...": "..." }
}
```

- `tool_input.file_path` is the path field for `Write` and `Edit` (confirmed by
  the repo's own PostToolUse template, which reads `.tool_input.file_path`).
- **`tool_use_id` is NOT present on PreToolUse input.** It appears only on
  PostToolUse and later, post-execution events. The adapter types it optional and
  it stays `undefined` on real input. (This directly contradicts the task brief,
  which listed `tool_use_id` among PreToolUse contract items to verify.)

## Output (stdout, JSON)

A permission decision lives at:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask",
    "permissionDecisionReason": "...",
    "updatedInput": { "...": "..." }
  }
}
```

- **Deny shape**: `hookSpecificOutput.permissionDecision = "deny"` plus a
  `permissionDecisionReason`. Pinned in `pretooluse-deny-response.json`. R0 is
  observe-only and never emits it.
- **Input mutation**: `hookSpecificOutput.updatedInput` (mirrors `tool_input`).
  Not used in R0.
- **No-decision / pass-through**: exit 0 with an empty `{}` body. This is what
  the observe adapter emits (`pretooluse-no-decision-response.json`). The
  documented decision values are `allow | deny | ask`; a `"defer"` value is NOT
  relied upon here (omitting the key is the safe, documented pass-through).
- **Exit codes**: 0 -> parse JSON body for a decision; 2 -> blocking error, tool
  call blocked, stderr surfaced to the model; other non-zero -> non-blocking,
  stderr to debug log only. The observe adapter always exits via the no-decision
  body (exit 0), never exit 2.

## Configuration hierarchy and multi-hook resolution

- Precedence (highest to lowest): Managed > command-line args > Local
  (`.claude/settings.local.json`) > Project (`.claude/settings.json`) > User
  (`~/.claude/settings.json`).
- Hooks across levels are **merged and all run** (not overridden) in precedence
  order.
- When several hooks match one event, all run; the most restrictive decision
  wins (deny > ask > allow > pass-through). A later deny slice must therefore
  assume it is one voice among possibly many, not the sole authority.

## Effective configuration on this machine (inspected 2026-06-18)

- `~/.claude/settings.json` configures these MLA hooks: `UserPromptSubmit`,
  `Stop`, `SessionStart`, `PostToolUse`, plus a `SessionEnd` cleanup. **There is
  no `PreToolUse` hook.**
- No `.claude/settings.json` (project) exists in the repo tree; the
  `.claude/settings.local.json` files carry no `hooks` key.
- `meetless-cli/.../wire.ts` (`MANAGED_HOOK_SCRIPTS`) manages SessionStart,
  UserPromptSubmit, Stop, and PostToolUse only. It does not manage PreToolUse.

**Conclusion**: MLA is NOT currently a PreToolUse hook. There are ZERO effective
matching PreToolUse hooks for `Write` or `Edit` today, so "is MLA the sole
matching PreToolUse hook?" is moot until a deny slice both registers a PreToolUse
hook (a `wire.ts` change, out of R0 scope) and accounts for the most-restrictive
multi-hook resolution above.

## Identity limitation (no per-call correlation handle)

Because PreToolUse input carries no `tool_use_id` (and no alternative per-call id
such as `id` / `call_id` / `tool_call_id`), MLA receives NO stable identity for the
individual tool call it is about to observe. `session_id` and `transcript_path` are
session scoped, not call scoped: two different `Write` calls in one session share
them. The spec `pretool-identity-limitation.spec.ts` pins the consequences:

- The parser surfaces `tool_use_id` as strictly `undefined` and never substitutes a
  value. Defaulting it to `session_id`, generating a uuid, or otherwise minting a
  synthetic id would be a fake value, not a fact from the harness, and must not happen.
- The observe output is content-addressed by rule plus verdict and carries no
  identity-bearing key. Two distinct calls in one session produce identical
  observations, so MLA holds nothing that distinguishes call A from call B.
- A later deny or persistence slice therefore CANNOT correlate a PreToolUse decision
  with the PostToolUse that follows by a shared call id, because none exists. If such
  correlation is ever required, it must come from a real harness-provided signal, not
  a fabricated one. `tool_use_id` stays optional on the parsed shape only so that real
  PostToolUse input (which does carry it) can reuse the same type later.

## Seam left for persistence and deny

- **Persistence**: the pure layer (`applicability.ts`, `evaluator.ts`,
  `notes-path.ts`) and the observe adapter take rules as in-memory values and
  emit an `ObservationOutcome`. Nothing is written. A later slice persists rules
  and observations behind the value contract in `types.ts`.
- **Deny**: `observePreToolUse` always returns the empty no-decision body. The
  single seam to enable deny is to map an `OBSERVED` `VIOLATION` to the pinned
  `pretooluse-deny-response.json` shape, gated on (a) registering a PreToolUse
  hook in `wire.ts`, and (b) the most-restrictive multi-hook rule. Until then,
  `UNKNOWN`/`COMPLIANT`/`NOT_APPLICABLE`/`INFRA` must continue to pass through.
