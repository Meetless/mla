// hook-contract.ts: the neutral, dependency-free data contract for Claude Code
// hook wiring. wire.ts's installers (fs/os side effects) and the plugin
// renderers (plugin-artifact.ts, pure functions) both need MANAGED_HOOK_SCRIPTS
// and MCP_SERVER_KEY; importing them from wire.ts would drag wire's fs/os/
// runWire dependency graph into a pure renderer's (and a future .mjs
// generator's require graph). This module is a constants file: it declares no
// IO and no behavior, only the shared shape both sides render from.

// THE LAYER-2 ENRICH DEADLINE. One value, here, for every consumer.
//
// 10s since 2026-08-09 (d7e5bcc12), an evidence-backed and design-reviewed change, not a
// latency ceiling raised to hide something: 270 of the 298 timeouts carrying a latency landed
// in 6,000-6,100ms, which is the CLIENT deadline firing, and a replay served the same request
// in 1,086ms. Rationale, the forward-only recovery cohort that prices it, and the stop
// condition live in NT:notes/20260809-mla-the-answer-existed-in-1086ms-and-the-budget-cut-it-at-6000.md.
//
// WHY IT SITS IN THE CONTRACT MODULE. d7e5bcc12 gave the deadline one home inside the hook
// because "a trace that reports a budget the hook did not apply is an instrument lying about
// the very thing it exists to measure". The same argument does not stop at the script: every
// READER of that trace has to agree with it too, and `stats.ts` prints the budget beside the
// success-latency tail and decides from it whether the tail is near the wall. A reader's copy
// that lags the hook turns that line into a comparison of two different regimes, which is
// exactly what happened between 08-09 08:39 and this commit.
//
// The hook is a standalone bash script and cannot import this at runtime, so
// `MLA_DEFAULT_INTERCEPT_MAX_S` in hooks-template/user-prompt-submit.sh still carries the
// literal. It is no longer INDEPENDENT of this one: test/lib/enrich-budget-canonical.spec.ts
// binds them, and moving either alone goes red. Generating the script would be a much larger
// change than the drift is worth.
//
// NOT the same number as ask-outcomes' PRIOR_ENRICH_BUDGET_MS (6,000). That one is the frozen
// historical boundary the recovery cohort measures against, and it must NOT follow this when
// this next moves.
export const LAYER2_ENRICH_BUDGET_S = 10;
export const LAYER2_ENRICH_BUDGET_MS = LAYER2_ENRICH_BUDGET_S * 1000;

// PostToolUse matcher. EMPTY STRING is Claude Code's catch-all (equivalent to
// "*"): the hook fires after EVERY tool call. This is deliberate, not lazy.
//
// The hook does two jobs and they have different gating needs:
//   1. SPOOL the captured tools (Bash, Write/Edit/MultiEdit/NotebookEdit,
//      AskUserQuestion, the `mcp__meetless__*` evidence pulls). post-tool-use.sh
//      self-filters to exactly these by tool name, so the spool set is enforced
//      in the SCRIPT, not in the matcher.
//   2. Fire the F3-B throttled liveness HEARTBEAT at the top of every invocation
//      so lastSeenAt keeps advancing mid-turn.
//
// A named-list matcher (the old "Bash|Write|Edit|AskUserQuestion|mcp__meetless__")
// gated job 2 on job 1's set: during a read/explore/subagent-heavy turn (Read,
// Grep, Glob, Task, WebFetch never match) the hook never ran, the heartbeat never
// fired, lastSeenAt froze, and deriveLiveness aged an actively-working session
// into IDLE. The catch-all decouples them: the heartbeat fires on every tool, and
// the script still spools only the captured set, so the v0 privacy boundary (a
// Read/Grep turn spools nothing) is unchanged.
export const POST_TOOL_USE_MATCHER = "";

// PreToolUse matcher: every tool that can put bytes on disk.
//
// This was "^(Write|Edit)$" until 2026-07-11, when our own enforcement benchmark
// caught the hole that narrowness left. A forbidden-root rule says "never create or
// edit any file under <root>/" — a statement about a PATH — but a matcher scoped to
// two tools silently turned it into "…using Write or Edit". An agent that was told
// to route around a block did exactly that, in one step:
//
//     Write  notes/design.md        -> DENIED by the governed rule
//     Bash   cat > notes/design.md  -> succeeded; this hook never fired
//
// So the block stopped a model that was going to comply anyway and failed to stop the
// one that wasn't. The matcher now covers Bash (shell redirects, tee, cp/mv, sed -i)
// and the two file tools the old anchored regex also exempted, MultiEdit and
// NotebookEdit. `deriveWriteTargets` then decides what a call actually writes, and a
// read-only Bash command (`ls`, `grep`) derives no targets and passes straight through.
//
// 2026-08-08 (F1, notes/20260807-did-mla-help-this-session-measured-and-a-fix-proposal.md):
// Grep and Glob were ADDED. This comment used to end "Read, Grep, Glob and friends never
// spawn the subcommand", and for Grep and Glob that is no longer true, deliberately.
//
// F1 re-surfaces a document mla already delivered THIS TURN at the moment the agent
// reaches for the same fact by hand. The measured cases were a `Grep` for
// current_revision_id and a `git log` over profiles.py; only the Bash call reached this
// hook, so a mechanism registered on the old matcher could not fire on half the evidence
// it exists for. That is a REACHABILITY failure of the kind that later reads as a tuning
// problem.
//
// READ IS DELIBERATELY NOT HERE, and the reason is measured, not aesthetic. Every hooked
// call spawns `node dist/pretool-entry.js`, and that spawn costs ~200ms on this machine
// (benchmarked 2026-08-08: 233ms for the entry on an EMPTY payload, 207ms for a real
// Write, 222ms for a Read; the spread is noise and F1's own logic is inside it). Bash
// already pays that toll and always has. Read is the most frequent tool in a coding
// session by a wide margin, so adding it would roughly double the number of tolled calls
// for the WEAKEST arm of the matcher: a Read of the exact note mla delivered means the
// agent is already using the evidence, which is the case F1 least needs to fix. Grep and
// Glob are SEARCHES -- the agent hunting a fact it does not have -- which is precisely
// F1's trigger, and they are far rarer than Read.
//
// (`extractNeedles` still understands Read. If the spawn cost ever collapses, or a
// connector hooks Read for its own reasons, the matcher is the only line to change.)
//
// WHAT THIS DOES NOT WIDEN: what can be DENIED. `computePretoolDecision` fences the
// enforcement ladder behind `ENFORCEABLE_TOOLS` (exactly the five write-capable tools),
// so an inspection call takes the advisory path and returns BEFORE the bundle is read.
// The enforcement surface is identical to the pre-F1 one; only the advisory surface
// grew. Leaning on "deriveWriteTargets returns nothing for a Grep" instead would have
// left the block / no-block boundary resting on an inference about today's rule set.
export const PRE_TOOL_USE_MATCHER = "^(Write|Edit|MultiEdit|NotebookEdit|Bash|Grep|Glob)$";

// PostToolUse matcher for the CE0 evidence-consultation hook (ce0-post-tool-use.sh,
// proposal §4.1). Unlike the load-bearing PostToolUse hook (catch-all so the F3-B
// heartbeat fires on EVERY tool), the CE0 hook only needs to observe the governed
// memory pulls, so it is scoped to the `mcp__meetless__*` MCP tools. The capture
// adapter then filters precisely to the three governed pulls, so a slightly broad
// matcher only spawns the subcommand on meetless tools, never on every tool.
//
// THE `.*` IS LOAD-BEARING. This shipped as the bare prefix `mcp__meetless__`, and the
// comment here asserted it was "an UNANCHORED substring regex" that "matches the full
// tool name". It does not. Claude Code decides whether a hook runs by FULL-matching the
// matcher against the tool name, so a bare prefix matches NOTHING. Measured 2026-08-04
// by registering probe hooks on one real MCP call:
//
//     matcher                 fired
//     ""            (control)   yes
//     mcp__meetless__           NO
//     mcp__meetless__.*         yes
//     ^mcp__meetless__.*$       yes
//
// The cost of that one missing `.*`: the CE0 hook never ran, so
// `evidence_consultation_completed` recorded ZERO events across 18 production
// workspaces, and `consultation_attempt` was empty in every local store too. The
// capture adapter beneath it was correct and fully unit-tested the entire time. What
// was missing was any test that the hook is ever REACHED, which is why the guard in
// wire-ce0-hooks.spec.ts is written against the REAL tool names rather than against
// this literal.
//
// Anchored rather than bare `mcp__meetless__.*`, because the anchored form is correct
// under BOTH full-match and substring semantics; it cannot break again if that changes.
// Same shape as PRE_TOOL_USE_MATCHER above, which is anchored and has always worked.
export const CE0_POST_TOOL_USE_MATCHER = "^mcp__meetless__.*$";

// Single source of truth for the Claude Code hook events Meetless manages.
// wire.ts's ensureClaudeSettings derives its wanted list from this; unwire.ts's
// removeMeetlessHooks iterates the SAME list so a hook added to install can
// never be silently missed by uninstall. `matcher === ""` is the catch-all.
//
// The engine keys a managed entry by script BASENAME (wire.ts's
// isManagedHookCommand), so MORE THAN ONE script can ride the same event: each
// basename owns its own settings entry. The three ce0-*.sh evidence hooks
// (RECORD_ONLY measurement harness, proposal §4.1) ride the EXISTING
// UserPromptSubmit/PostToolUse/Stop events as second managed entries beside the
// load-bearing capture hooks.
export type ManagedHookScript = {
  event: string;
  script: string;
  matcher?: string;
  timeout?: number;
};

export const MANAGED_HOOK_SCRIPTS: ManagedHookScript[] = [
  { event: "SessionStart", script: "session-start.sh" },
  { event: "UserPromptSubmit", script: "user-prompt-submit.sh", timeout: 30 },
  { event: "Stop", script: "stop.sh" },
  { event: "PostToolUse", script: "post-tool-use.sh", matcher: POST_TOOL_USE_MATCHER },
  { event: "PreToolUse", script: "pre-tool-use.sh", matcher: PRE_TOOL_USE_MATCHER },
  // Enforcement backstop (2026-07-11). Catch-all ON PURPOSE: it never inspects the tool
  // name, only whether a file appeared under a governed forbidden root — so a shell
  // redirect the PreToolUse parser cannot see is still reverted. This is the half of
  // enforcement that does not depend on out-guessing a shell.
  { event: "PostToolUse", script: "posttool-sweep.sh", matcher: "", timeout: 10 },
  // CE0 evidence-consultation hooks (RECORD_ONLY). No timeout: they mirror
  // pre-tool-use.sh (best-effort, fail-soft, always `{}` exit 0).
  { event: "UserPromptSubmit", script: "ce0-user-prompt-submit.sh" },
  { event: "PostToolUse", script: "ce0-post-tool-use.sh", matcher: CE0_POST_TOOL_USE_MATCHER },
  { event: "Stop", script: "ce0-stop.sh" },
  // CE0 telemetry-projection hook (proposal §6.4): gives the offline sweep an
  // automatic caller so the two precision/recall denominator events
  // (memory_requirement_assessed, evidence_obligation_finalized) project on each
  // session start instead of only when a human runs `mla evidence ce0-emit-telemetry`.
  // It carries a timeout because, unlike the three pure-local turn hooks, the sweep
  // ends in a best-effort network flush; the local projection runs first, so a
  // timed-out invocation still lands the denominator events locally.
  { event: "SessionStart", script: "ce0-session-start.sh", timeout: 30 },
];

// Single source of truth for the MCP server KEY in ~/.claude.json. wire.ts's
// ensureClaudeMcpServer registers exactly this key; unwire.ts's removeMeetlessMcp
// deletes exactly this key, so install and uninstall stay symmetric: register it
// there, remove it there, never drift.
export const MCP_SERVER_KEY = "meetless";
