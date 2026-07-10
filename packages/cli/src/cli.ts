#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import {
  boundedSentryFlush,
  boundedTraceFlush,
  captureCliError,
  captureCliNonZeroExit,
  createRunTracer,
  didIntelEchoTraceId,
  didTraceFlushSucceed,
  getWorkspaceConfig,
  initSentry,
  canonicalizeSessionId,
  loadBuildInfo,
  makeHttpFlush,
  maybePrintDeepLink,
  mintRunId,
  mintTraceId,
  redactArgvForSpan,
  setRepoFingerprint,
  setRunId,
  setRunSessionId,
  setRunTraceId,
  setRunTracer,
  setWorkspaceConfig,
  type WorkspaceConfigForTracing,
} from "./lib/observability";
import { computeRepoFingerprint } from "./lib/git";
import { traceUploadEnabled } from "./lib/analytics/consent";
import { captureCommandEvent } from "./lib/analytics/capture";
import {
  classifyOutcome,
  isReportableFault,
} from "./lib/analytics/command-event";
import { get as controlGet } from "./lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "./lib/workspace-access";
import type { CliConfig } from "./lib/config";
import { readConfig, HOME } from "./lib/config";
import { tryResolveWorkspaceId } from "./lib/workspace";
import type { Tracer } from "@meetless/trace-core";
import { runInit } from "./commands/init";
import { runLogin } from "./commands/login";
import { runLogout } from "./commands/logout";
import { runUninstall } from "./commands/uninstall";
import { runWhoami } from "./commands/whoami";
import { runRewire } from "./commands/rewire";
import { runActivate, runDeactivate, runMute, runUnmute } from "./commands/activate";
import { runReview, runReviewById, reviewUsage } from "./commands/review";
import { runEnforcement } from "./commands/enforcement";
import { runConflicts } from "./commands/conflicts";
import { runFlush } from "./commands/flush";
import { runQueuePrune } from "./commands/queue-prune";
import { runDoctor } from "./commands/doctor";
import { runInternalFinalize } from "./commands/internal-finalize";
import { runInternalActiveReview } from "./commands/internal-active-review";
import { runInternalAutoIndex } from "./commands/internal-auto-index";
import { runInternalEvidenceInject } from "./commands/internal-evidence-inject";
import { runInternalEvidenceCorrelate } from "./commands/internal-evidence-correlate";
import {
  runInternalEvidenceTurnOpen,
  runInternalEvidenceCapture,
  runInternalEvidenceStop,
} from "./commands/internal-evidence-hooks";
import { runInternalSteerSync } from "./commands/internal-steer-sync";
import { runCaptureDecisions } from "./commands/internal-capture-decisions";
import { runInternalPretoolObserve } from "./commands/internal-pretool-observe";
import { runInternalForwardEnforcement } from "./commands/internal-forward-enforcement";
import { runInternalEnforcementCorrelate } from "./commands/internal-enforcement-correlate";
import { runInternalRedactCapture } from "./commands/internal-redact-capture";
import { runInternalTurnRecap } from "./commands/internal-turn-recap";
import { runInternalRefresh } from "./commands/internal-refresh";
import { runInternalSessionNudge } from "./commands/internal-session-nudge";
import {
  maybeSpawnBackgroundCheck,
  maybeShowUpdateNag,
  runInternalUpdateCheck,
} from "./lib/update-notifier";
import { runUpgrade, maybePromoteStagedAndReExec } from "./lib/upgrade-apply";
import { maybeResyncHooks, maybeHealMcpCommand } from "./lib/wire";
import { runScanContext } from "./commands/scan-context";
import { runAssembleContext } from "./commands/assemble-context";
import { runKb } from "./commands/kb";
import { runAgentMemory } from "./commands/agent-memory";
import { runEnrich } from "./commands/enrich";
import { runGraph } from "./commands/graph";
import { runSummary } from "./commands/summary";
import { runLabel } from "./commands/label";
import { runAdoption } from "./commands/adoption";
import { runStats } from "./commands/stats";
import { runTurn } from "./commands/turn";
import { runAsk } from "./commands/ask";
import { runSessionShow, runSessionReconcile } from "./commands/session";
import { runWorkspace } from "./commands/workspace";
import { runDebug } from "./commands/debug";
import { runBug } from "./commands/bug";
import { runMcp } from "./commands/mcp";
import { runMcpSupervisor } from "./commands/mcp-supervisor";
import { shouldSuperviseMcp } from "./lib/mcp-restart";
import { runContext } from "./commands/context";
import { runStatus } from "./commands/status";
import { runEvidence } from "./commands/evidence";
import {
  runRulesActivity,
  runRulesPublish,
  runRulesImport,
} from "./commands/rules";
import {
  runRulesAddBackend,
  runRulesEditBackend,
  runRulesListBackend,
  runRulesRevokeBackend,
  runRulesAttestBackend,
  runRulesDemoteBackend,
  runRulesRemoveBackend,
} from "./commands/rules-backend";

// `mla` dispatcher (§3 hour 6).
//
// Commands:
//   mla init [flags]
//   mla rewire [flags]
//   mla activate [--name <name>] [--note <text>] [--here|--create|--repair] [--bootstrap <fast|agentic>]
//   mla deactivate [--yes] [--from-root|--marker <path>]
//   mla mute | mla unmute
//   mla review [--plain] [--no-flush]
//   mla review <id>
//   mla flush [--all|--session <sid>] [--quiet] [--gc|--reap-only]
//   mla doctor
//   mla _internal finalize-session <sessionId>
//   mla _internal auto-index [--session <sid>]

const USAGE = `mla: Meetless Agent CLI

usage:
  mla init [--control-url <url>] [--control-token <token>] [--intel-url <url>]
          [--actor <id>] [--no-post-tool-use] [--skill-only]
          (machine setup + credential update. Defaults to logged-out (auth.mode
           none): run 'mla login' next to sign in. Pass --control-token only for a
           headless shared-key install. A tokenless re-run preserves a live login.
           No workspace binding here; use 'mla activate' to bind a folder.)
  mla wire [--no-post-tool-use] [--no-install-flock] [--skill-only]
          (idempotent re-wiring after binary upgrade; no token needed.
           alias: rewire)
  mla upgrade [--check] [--force]
          (self-upgrade to the latest signed release: verifies the release
           manifest's Ed25519 signature, enforces the downgrade guard, and
           atomically swaps the binary (curl installs only; brew/npm are
           redirected to their package manager). --check reports without
           installing; --force allows a same-version or downgrade reinstall.)
  mla login [--no-browser] [--console-url <url>] [--port <n>]
                    (browser login: opens the Console authorize page, captures a
                     user session into cli-config.json. --no-browser prints the URL
                     for SSH/headless and REQUIRES --port (the forwarded loopback
                     port). No-op when already logged in with >24h of refresh
                     runway; force re-login with 'mla logout && mla login'.)
  mla logout
                    (revoke the current user session server-side and clear it from
                     cli-config.json (auth.mode -> none). A network failure still
                     clears locally; NEVER restores a prior shared key. No --all.)
  mla uninstall [--dry-run] [--yes]
                    (remove the entire local Meetless footprint: ~/.meetless,
                     the Claude hook + MCP entries, and the /mla skill. Prints
                     how to remove the binary. Local only; server data and other
                     repos' .meetless.json markers are untouched.)
  mla whoami [--json]
                    (print the identity behind the current cli-config.json: a
                     user session resolves live via the control /auth/me endpoint;
                     a shared key prints its mode without a network call. Prints
                     the workspace CUID (for --workspace <id>); --json emits a
                     parseable object. Exit 1 when not configured.)
  mla activate [--name <name>] [--note <text>]
                    (provision-or-bind a workspace for this folder: no marker in
                     the tree provisions a new one named after the dir; a marker
                     present binds to it)
  mla activate --here
                    (in-Git subdir override: bind/provision THIS subdir, shadowing
                     any parent marker via nearest-wins)
  mla activate --create
                    (non-Git override: provision a workspace in a directory that
                     is not inside a Git repository)
  mla activate --repair
                    (re-check the existing binding's membership + connectivity;
                     never mints a new id)
  mla activate --bootstrap <fast|agentic>
                    (bootstrap tier for the activation preview: fast (default) shows
                     the deterministic review bundle. agentic is DEPRECATED: it still
                     emits a static deep-read scout mission, but the consolidated
                     agent-driven onboarding is /mla onboard. The old full tier was
                     removed; --bootstrap full now errors with a migration note.)
  mla deactivate [--yes] [--from-root|--marker <path>]
                    (REMOVE this folder's workspace binding: deletes the nearest
                     .meetless.json. Confirms first (--yes to skip); from a subdir
                     it refuses to delete a parent marker unless --from-root or
                     --marker <path>. For per-session silencing use 'mla mute'.)
  mla mute
                    (per-session: silence capture + Push for the CURRENT Claude
                     Code session only; does not touch .meetless.json)
  mla unmute
                    (per-session: re-enable capture for the CURRENT session;
                     does not touch .meetless.json)
  mla workspace [show]
                    (print the workspace bound to this folder + its health)
  mla workspace invite <email> [--json] [--workspace <id>]
                    (add a teammate's email as a MEMBER so they can share this
                     workspace's governed memory, cases, and conflicts; owner/admin)
  mla workspace members [--json] [--workspace <id>]
                    (list the workspace's active members)
  mla workspace remove <email> [--json] [--workspace <id>]
                    (revoke a MEMBER's access by email; owner/admin)
  mla review [--plain] [--no-flush]
  mla review <id>
  mla enforcement [--all] [--json]
                    (review governed-rule enforcement blocks (PreToolUse denies):
                     lists this session's UNREVIEWED blocks with full evidence (rule
                     text + blocked path), then an interactive confirm/dismiss loop
                     on a TTY. --all widens to the whole workspace; --json prints the
                     list without prompting. Adjudicated as the logged-in human.)
  mla enforcement confirm <id> [--note <text>]
  mla enforcement dismiss <id> [--note <text>]
                    (adjudicate one block by id without the interactive loop:
                     confirm = a real catch, dismiss = a false positive.)
  mla conflicts [--global] [--session <sid>] [--json]
                    (list open cross-session conflicts: a decision this session
                     captured that contradicts approved knowledge or another live
                     session. Defaults to THIS session; --global widens to the whole
                     workspace; --session scopes to an explicit sid; --json prints
                     the raw read.)
  mla conflicts resolve <case-id> --rationale <text>
                    --outcome <uphold-subject|uphold-counterparty|dismiss|reject-both>
  mla conflicts dismiss <case-id> --rationale <text>
                    (record one of the four D1 verdicts on a case, as the logged-in
                     human, via the same endpoint the console drives: closes the
                     case, audits the verdict, broadcasts a steer to the loser
                     session. dismiss = shorthand for --outcome dismiss. --rationale
                     is required.)
  mla session show [sessionId] [--json] [--last <N>]
  mla session reconcile [--dry-run] [--json]
                    (archive sessions whose Claude Code transcript was deleted
                     on disk; reversible, fail-safe, skips anything uncertain)
  mla ask "<query>" [--mode answer|search|canonical|compare] [--workspace <id>]
                    [--as-of <date>] [--max <n>] [--min <n>] [--plain]
                    (--as-of YYYY-MM-DD answers point-in-time: relations not yet
                     valid at that instant are excluded. The validity axis is
                     SEPARATE from posture/relationship; see \`mla kb help\`.)
  mla mcp
                    (start the Meetless MCP server over stdio, authenticated as
                     the logged-in human (cli-config user-token) and scoped to
                     the marker workspace. No service key, no MEETLESS_WORKSPACE_ID
                     pin. Wire it into an MCP client's config as the command.)
  mla kb summary [--json]
  mla kb dump [--markdown] [--json]
  mla kb add <path> --mode file|corpus --provenance <kind>
                    [--workspace <id>] [--profile <p>] [--glob <g>]
                    [--vault-root <dir>] [--ingest-run-id <id>]
                    [--queue] [--open]
                    (<kind>: human_authored | agent_distilled | tool_emitted |
                     external_imported | external_scraped. --provenance is now
                     ADVISORY: the server derives trust from the capture path, so
                     every ingest is born PENDING (reviewOutcome=PENDING) and is
                     readable but not yet trusted for knowledge-use until accepted
                     via \`kb accept\` / Console review. Trust (reviewOutcome) is a
                     SEPARATE axis from relationship review (\`kb pending\`/\`kb
                     review\`). See \`mla kb help\`.)
  mla kb show <kbdoc:<id>|note:<path>|<path>>
                    [--workspace <id>] [--all] [--audit-all] [--json] [--open]
                    (document-centric view: identity, governed-liveness
                     (serving/servingStatus), head revision + history, chunks,
                     derived claims, audit. Relationship edges moved to the
                     Console relationships lane; for point-in-time use
                     \`mla ask --as-of\`.)
  mla kb reingest <kbdoc:<id>|note:<path>|<path>>
                    [--workspace <id>] [--path <new-path>] [--profile <p>]
                    [--ingest-run-id <id>] [--reason <s>]
  mla kb forget <kbdoc:<id>|note:<path>|<path>>
                    [--workspace <id>] [--reason <s>]
  mla kb purge <kbdoc:<id>|note:<path>|<path>> --reason <s>
                    [--workspace <id>] [--force]
  mla kb move <kbdoc:<id>|note:<path>|<path>> <new-path>
                    [--workspace <id>] [--reason <s>] [--allow-file-missing]
  mla kb retime <source-item-id> --effective-date <date>
                    [--reason <s>] [--anchor-type <t>] [--json]
                    (correct the source item's effective date and regenerate its
                     derived relations via the Phase 4 correction path. Edits the
                     SOURCE ITEM, not a relation: an accepted relation is never
                     edited in place nor deleted. The corrected date re-drives
                     valid-time, the same axis \`mla ask --as-of\` filters on.)
  mla kb pending [--doc <id>] [--json]
                    (list PENDING_REVIEW relationship candidates to decide on;
                     canonical home for this is now \`mla graph pending\`)
  mla kb review <candidate-id> --accept | --reject [--note <text>] [--agent]
                    (record a verdict; --accept is human-only, an agent proxy
                     may --reject only mechanically-invalid candidates;
                     canonical home for this is now \`mla graph review\`)
  mla kb promote <doc-id> | mla kb promote --reject <doc-id>
                    (flip a SHADOW Personal-KB doc to LIVE so the workspace grounds
                     on it; --reject declines and leaves it SHADOW)
  mla kb personal list | mla kb personal show <id>
                    (this actor's own SHADOW Personal-KB docs)
  mla kb help
                    (full KB catalog + the posture-vs-relationship-review model)
  mla graph review [scope] [--json] | mla graph review <id> --accept|--reject
  mla graph pending [scope]
  mla graph help    (alias: mla cg)
                    (the coordination graph: relationship review (typed edges
                     SUPERSEDES / CONTRADICTS / REFINES / REFERENCES between docs).
                     Same handlers as \`mla kb review\`/\`kb pending\`, given the
                     relationship axis its own home so it stops hiding under the
                     storage noun \`kb\`. Document ingestion + grounding (posture)
                     stay under \`mla kb\`; doc verbs typed here redirect there.)
  mla rules add "<statement>" [--must] [--scope <glob>]... [--source <s>]...
                    (add an operator-dictated durable CONVENTION to the backend rule
                     store (the workspace source of truth), injected into every agent
                     prompt via the local scan cache. SHOULD_FOLLOW by default; --must
                     escalates to MUST_FOLLOW; no --scope is repository-wide. Born
                     human_attested and idempotent by content. Lands server-side at once;
                     run \`mla scan\` to refresh this repo's cache so the new rule is
                     injected. Soft authoring-rule writer, distinct from the CE0 verbs
                     below.)
  mla rules remove (<ruleId> | "<statement>" [--scope <glob>]...)
                    (unsupported with the backend rule store: \`.meetless/rules.md\` is a
                     read projection, not an authority, so there is nothing local to
                     delete. Disarm a backend convention with \`mla rules revoke
                     <nodeId>\`, the CE0 kill switch.)
  mla rules <list|activity|attest|revoke|demote|publish>
                    (\`list\` shows BOTH stores: the managed conventions above and the
                     CE0 enforcement rules observed in this scope, labeled distinctly.
                     \`activity\` is the per-rule accountability (observed / violated /
                     denied); \`attest\` mints a LIVE notes-location rule from an
                     observed snapshot (--scope team enforces workspace-wide,
                     default personal enforces for you alone); \`revoke\` disarms
                     one (fail-open); \`demote\` lowers a TEAM rule to a PERSONAL copy
                     (mints the copy owned by you, then revokes the team rule, so it
                     enforces for you alone); \`publish\`
                     projects the attested set to the console Rules page. attest /
                     revoke / demote / publish are action-level DENY ceilings, NOT soft
                     authoring conventions; those are added via \`mla rules add\`.)
  mla enrich <plan|brief|ingest|materialize>
                    (agent-orchestrated onboarding enrichment, usually driven by the
                     /mla onboard skill: \`plan\` scans the repo into an immutable run
                     record + prints the scout plan; \`brief\` re-prints a run's scout
                     brief; \`ingest\` validates + persists the scouts' candidates born
                     PENDING in governed knowledge; \`materialize\` regenerates the
                     committed .meetless/rules.md mirror from the accepted rule set (a
                     human-readable projection for git visibility; the backend store +
                     scan cache are the inject source, not this file).)
  mla agent-memory <enable|disable|status|scan|push|report>
                    (operator surface for the agent-memory capture pipeline. Phase 1
                     is DRY-RUN ONLY: \`scan\` observes / classifies / secret-scans
                     project Claude auto-memory files and records metadata-only
                     decisions locally; it uploads nothing. Live ingestion is gated
                     off upstream.)
  mla summary [--last <n>] [--json] [--all]
                    (defaults to the current session; --all for every session)
  mla label [<trace_id>] [--useful] [--noisy] [--harmful]
                    [--prevented-mistake] [--note <text>]
                    (mark an enrichment's operator_label; no trace_id labels the
                     latest trace in the current session)
  mla stats [evidence] [--window <Nd>] [--json] [--verbose] [--global]
                    (usefulness-first dashboard from local events.jsonl: evidence
                     followthrough, contradictions caught, coverage gaps. default
                     window 30d. \`evidence\` is the focused adoption join below.)
  mla turn [N] [--session <sid>] [--json]
                    (per-turn assist recap: did mla run this turn and did it help?
                     no N recaps the latest completed turn of the current session;
                     N recaps turn N. The per-turn analog of \`mla stats\`; also
                     reachable as \`mla stats --turn [N]\`.)
  mla adoption [--last <n>] [--window <w>] [--json] [--all]
                    (A1 evidence-followthrough: did the agent pull or cite the
                     evidence we injected? alias of \`mla stats evidence\`;
                     defaults to the current session)
  mla flush [--all|--session <sid>] [--quiet] [--gc|--reap-only]
                    (--gc drains the spool(s) then reaps stale-session litter;
                     --reap-only reaps stale litter without draining)
  mla queue prune [--yes] [--dry-run] [--no-flush] [--max-age-hours N] [--session SID]
                    (reclaim orphaned queue files from dead sessions; previews
                     unless --yes. Unlike flush --gc it also reclaims non-empty
                     stranded tails, flushing them best-effort first)
  mla doctor
                    (health check; reports both lifecycles distinctly: workspace
                     binding (activated / not) and session capture (active / muted))
  mla status
                    (show whether Meetless is active for this repo and print
                     scan-cache counts: confirmed rules injected, pending review
                     items, inventory)
  mla scan
                    (rebuild this repo's local rule cache from the backend bundle +
                     instruction files: the refresh lever after \`mla rules add\` or a
                     binary upgrade. Reads the current schema, so it also clears the
                     stale/incomplete delivery markers. Same rescan \`mla activate\`
                     runs.)
  mla context <accept|dismiss> <id> | mla context list
                    (accept or dismiss a stale-context review item; list shows all
                     pending items. Verdicts are local; a rescan runs immediately
                     so the next session's injected context reflects the change.)
  mla context advisory
                    (list the untracked agent-memory rules the cold-start scan
                     discovered. These are machine_inferred and NEVER auto-injected;
                     they ride a review-only worklist until a human attests them in a
                     tracked instruction file. Read-only by design.)
  mla debug bundle --trace-id <id> [--out <path>] [--no-backend]
                    [--include-prompts] [--include-diffs] [--yes|-y]
                    [--command <name>] [--run-id <id>] [--session-id <id>] [-q]
                    (write a local, inspectable .zip for a trace_id so you can
                     attach it to an issue by choice. Nothing uploads. Raw
                     payloads (prompts, bodies, diffs) are EXCLUDED by default;
                     the include flags require an interactive confirm or --yes.
                     Manifest-first + mandatory redaction report; offline-capable.
                     Default output: ~/.meetless/debug/<trace_id>.zip)
  mla evidence ce0-export
  mla evidence ce0-import-labels <file>
                    (the human-only CE0 evidence-consultation labeling workflow:
                     ce0-export writes the JSONL of deadline-claimed obligations
                     with the deterministic machine baseline; ce0-import-labels
                     reads a labeled file back and CAS-finalizes each obligation
                     with the human's terminal outcome. Local only, no egress.)
  mla bug report [--trace-id <id> | --session <sid> | --last]
                 [--title <t>] [--message <m> | --message-file <f>]
                    (file a PRIVATE, redacted diagnostic report to Meetless
                     support and track it to resolution. Builds an allowlist-only
                     bundle (structured trace + errors, secrets stripped),
                     PREVIEWS exactly what will be sent, then asks for an
                     interactive y/N confirm before anything leaves your machine.
                     --last (the default) targets the current run; --trace-id /
                     --session target a specific past run.)
  mla bug list      (your filed reports + their status, newest first)
  mla bug status <BUG-ref>
                    (one report: status, metadata, and the staff resolution note
                     once it is resolved)
  mla help
  mla _internal finalize-session <sessionId>
  mla _internal auto-index [--session <sid>]
                    (Zone 2: index this session's produced docs into the owner's
                     Personal KB as SHADOW; fired detached from the Stop hook)
  mla _internal evidence-correlate
                    (close pending evidence-inject windows and append
                     mla_evidence_outcome; fired detached from the Stop hook)
  mla _internal evidence-turn-open
                    (CE0 RECORD_ONLY: classify the turn's memory requirement and
                     open its obligation; fired from the UserPromptSubmit hook)
  mla _internal evidence-capture
                    (CE0 RECORD_ONLY: record a governed-memory pull as a
                     ConsultationAttempt; fired from the PostToolUse hook)
  mla _internal evidence-stop
                    (CE0 RECORD_ONLY: freeze the turn obligation's eligibility
                     boundary; fired from the Stop hook)
  mla _internal steer-sync --session <sid>
                    (pull pending cross-session steers into the local cache and
                     mark the surfaced ones injected; invoked by flush.sh)
  mla _internal capture-decisions --source <post_tool_use|stop_transcript_scan>
                    --session <id> [--transcript <path>] [--spool <path>]
                    (normalize AskUserQuestion Q&A into agent_decision_captured
                     spool events; post_tool_use reads the hook payload from
                     stdin, stop_transcript_scan scans the session transcript)
  mla _internal pretool-observe
                    (observe-only PreToolUse hook entrypoint; reads the raw
                     PreToolUse payload from stdin, records a side-channel
                     observation, and always emits the empty {} pass-through body
                     so it can never change a permission decision)
  mla _internal forward-enforcement [--session <sid>]
                    (deliver hook-emitted mla_enforcement_incident rows from the
                     local spool to control's analytics ingest; fired detached
                     right after a PreToolUse deny, whose own hot path exits
                     before it can flush. Idempotent; fail-soft, always exits 0)
  mla _internal enforcement-correlate --session <sid> --transcript <path>
                    (STAR's "R": reconstruct what the agent did AFTER a deny from
                     the session transcript and append one mla_enforcement_outcome
                     per closed deny -- redirected, stopped, or retried-blocked.
                     Fired detached from the Stop hook; idempotent; fail-soft)
  mla _internal turn-recap [--session <sid>] [--turn <n>]
                    [--style footer|block|block-context] [--json] [--emit-langfuse]
                    (the machine-facing per-turn assist recap; shelled out by the
                     UserPromptSubmit hook (block-context injection) and stop.sh
                     (--emit-langfuse). Fail-soft: prints nothing and exits 0 on any
                     non-argv error so it can never disturb the hook.)
  mla _internal refresh [--quiet] [--if-expiring-within <secs>]
                    (trigger the concurrency-safe user-token refresh and map the
                     outcome to a sysexits code (0 refreshed / 75 busy / 77 dead
                     refresh -> mla login / 64 wrong mode); shelled out by the
                     auth hooks to self-heal an expired access token.)
  mla _internal session-nudge [--cwd <dir>]
                    (SessionStart hook helper: in a logged-in git repo that is
                     NOT activated, prints a one-line 'Meetless installed but
                     inactive here' additionalContext for Claude Code. Silent and
                     exits 0 otherwise. Reuses the same resolver as mla mcp.)
  mla _internal update-check
                    (detached, throttled background version check; fetches the
                     latest release and caches it for the upgrade nag. Honors
                     MLA_NO_UPDATE_NOTIFIER; always exits 0.)
`;

// Build-stamped version string. dist/build-info.json is generated by
// scripts/gen-build-info.js as the second step of `pnpm build`, so the running
// binary reports the exact commit + build time it was compiled from. Under
// ts-node (dev) the file is absent; fall back to the bare package version.
// This is the antidote to the stale-dist footgun: `mla --version` no longer
// returns a frozen "0.1.0" that never moves across rebuilds.
function versionString(): string {
  const pkg = require("../package.json");
  const base = pkg.version ?? "0.0.0";
  try {
    const info = JSON.parse(
      fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8"),
    ) as { sha?: string; dirty?: boolean; builtAt?: string };
    const dirty = info.dirty ? "-dirty" : "";
    return `${base} (${info.sha ?? "unknown"}${dirty}, built ${info.builtAt ?? "?"})`;
  } catch {
    return `${base} (dev build, no build-info.json)`;
  }
}

export async function dispatch(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(versionString());
    return 0;
  }

  switch (cmd) {
    case "init":
      return runInit(argv.slice(1));
    case "wire":
    // `rewire` is the original name, kept as a silent back-compat alias so
    // already-printed operator hints and any muscle memory keep working.
    case "rewire":
      return runRewire(argv.slice(1));
    case "login":
      return runLogin(argv.slice(1));
    case "logout":
      return runLogout(argv.slice(1));
    case "uninstall":
      return runUninstall(argv.slice(1));
    case "whoami":
      return runWhoami(argv.slice(1));
    case "activate":
      return runActivate(argv.slice(1));
    case "deactivate":
      return runDeactivate(argv.slice(1));
    case "mute":
      return runMute(argv.slice(1));
    case "unmute":
      return runUnmute(argv.slice(1));
    case "workspace":
      return runWorkspace(argv.slice(1));
    case "doctor":
      return runDoctor(argv.slice(1));
    case "status":
      return runStatus(argv.slice(1));
    case "scan":
      // Operator-facing rescan lever: rebuild this repo's local rule cache from the
      // backend bundle + instruction files. Same routine as `_internal scan-context`
      // (and the rescan `mla activate` runs); named `scan` because that is the command
      // the degraded-cache delivery markers tell the agent to run (scanner/render.ts).
      return runScanContext(argv.slice(1));
    case "context":
      return runContext(argv.slice(1));
    case "flush":
      return runFlush(argv.slice(1));
    case "queue": {
      if (sub === "prune") return runQueuePrune(rest);
      console.error(`Unknown queue subcommand: ${sub ?? "(none)"}\n\n${USAGE}`);
      return 2;
    }
    case "rules": {
      // The rules verbs operate on the unified backend Rule API (rules-store-unification). `add` mints a
      // TEAM RuleNode, `edit` mints the next version carrying expectedCurrentVersionId, `revoke` is the
      // compare-and-swap kill switch that disarms a LIVE rule, `attest` keeps the LOCAL observed-snapshot
      // resolution but mints the DENY rule to the backend (fork #7), `demote` lowers a TEAM rule to a
      // PERSONAL copy (mint-owned-by-operator then revoke the team node, since authorityScope is
      // node-immutable), `list` reads the backend (matching
      // the console) and falls back to the principal bundle offline, and `remove` is unsupported
      // (`.meetless/rules.md` is no longer an authority). `activity` is the R2-LOCAL accountability
      // projection (per LIVE rule: observed N, violated M, denied; proposal §2.6 / §3.7), `publish` is the
      // deprecation stub kept for the old-client window, and `import` is the one-time migration that reads
      // the local stores (CE0 + managed) for the active scope and POSTs them to the backend (additive,
      // idempotent). The console and the CLI mutate the SAME store, so `revoke` truly disarms a LIVE rule.
      if (sub === "add") return runRulesAddBackend(rest);
      if (sub === "edit") return runRulesEditBackend(rest);
      if (sub === "remove" || sub === "rm") return runRulesRemoveBackend(rest);
      if (sub === "list") return runRulesListBackend(rest);
      if (sub === "activity") return runRulesActivity(rest);
      if (sub === "attest") return runRulesAttestBackend(rest);
      if (sub === "revoke") return runRulesRevokeBackend(rest);
      if (sub === "demote") return runRulesDemoteBackend(rest);
      if (sub === "publish") return runRulesPublish(rest);
      if (sub === "import") return runRulesImport(rest);
      console.error(`Unknown rules subcommand: ${sub ?? "(none)"}\n\n${USAGE}`);
      return 2;
    }
    case "review": {
      // `mla review`               -> current session, no positional, only flags.
      // `mla review <id>`          -> deep-link emission, exactly one positional.
      // Old `latest` / `by-session` are intentionally removed; surface a clear
      // pointer instead of silently routing the operator to the wrong path.
      //
      // `--help`/`-h` is intercepted here, BEFORE either runReview's or
      // runReviewById's strict parser runs. Both parsers throw on any unknown
      // `--`/`-` token by design (to name stray flags), but help is not stray --
      // throwing "Unknown flag: --help" reads as the tool being broken. Match it
      // anywhere in the review args so `mla review -h`, `mla review <id> --help`,
      // and `mla review --plain --help` all print usage and exit 0.
      const reviewArgs = argv.slice(1);
      if (reviewArgs.includes("--help") || reviewArgs.includes("-h")) {
        console.log(reviewUsage());
        return 0;
      }
      if (sub === undefined || sub.startsWith("--")) {
        return runReview(argv.slice(1));
      }
      if (sub === "latest") {
        console.error(
          "`mla review latest` was removed. Run `mla review` inside a Claude Code " +
            "session, or open the queues at /relationships and /cases in the console.",
        );
        return 2;
      }
      if (sub === "by-session") {
        console.error(
          "`mla review by-session <sid>` was removed. The current session is the only " +
            "session `mla review` will surface; open the console queues to browse others.",
        );
        return 2;
      }
      return runReviewById([sub, ...rest]);
    }
    case "enforcement": {
      // `mla enforcement`                 -> this session's unreviewed blocks + loop.
      // `mla enforcement --all|--json`    -> workspace-wide / machine-readable.
      // `mla enforcement confirm|dismiss <id>` -> adjudicate one block by id.
      // All arg parsing (verbs, flags, --note) lives in runEnforcement so the
      // dispatcher stays a thin pass-through of everything after the command word.
      return runEnforcement(argv.slice(1));
    }
    case "conflicts": {
      // `mla conflicts`                     -> open cross-session conflicts touching
      //                                        this session.
      // `mla conflicts --global`            -> every open conflict in the workspace.
      // `mla conflicts --session <sid>`     -> an explicit session's conflicts.
      // `mla conflicts --json`              -> machine-readable mirror.
      // `mla conflicts resolve <id> ...`    -> record one of the four D1 verdicts.
      // `mla conflicts dismiss <id> ...`    -> shorthand for --outcome dismiss.
      // All verb + flag parsing lives in runConflicts so the dispatcher stays a
      // thin pass-through of everything after the command word.
      return runConflicts(argv.slice(1));
    }
    case "cases": {
      console.error(
        "`mla cases` was removed. Open the cases queue in the console, run " +
          "`mla conflicts` for open cross-session conflicts, or " +
          "`mla review <id>` to get a deep link for a specific case.",
      );
      return 2;
    }
    case "session": {
      if (sub === "show") return runSessionShow(rest);
      if (sub === "reconcile") return runSessionReconcile(rest);
      // `distill` + `remember` were removed (dogfood scaffold; the learning
      // loop captures agent output directly per turn). See
      // notes/20260531-agent-review-retraction-and-pending-items-loop.md §2.
      console.error(`Unknown session subcommand: ${sub ?? "(none)"}\n\n${USAGE}`);
      return 2;
    }
    case "ask":
      // `mla ask` loads @meetless/ask-core. ask-core is ESM-only, so it ships as
      // a CJS bundle the binary loads via require() (scripts/bundle-esm.js);
      // runAsk handles bundle-vs-source resolution. Works in the binary and from
      // a source/npm install alike, so no binary gate here.
      return runAsk(argv.slice(1));
    case "kb":
      return runKb(argv.slice(1));
    // `mla agent-memory <enable|disable|status|scan|report>`: operator surface for
    // the agent-memory capture pipeline (notes/20260626-agent-memory-auto-capture-
    // proposal.md). Phase 1 is DRY-RUN ONLY: `scan` observes/classifies/secret-scans
    // project-type Claude auto-memory files and records metadata-only decisions
    // locally; it uploads nothing. Live ingestion is blocked upstream by the missing
    // cross-revision claim-grain idempotency and is intentionally not wired.
    case "agent-memory":
      return runAgentMemory(argv.slice(1));
    // `mla enrich`: agent-orchestrated onboarding enrichment. `enrich plan` scans the
    // repo into an immutable run record + prints the plan the agent reads; `enrich
    // ingest` validates + persists the scouts' candidates born PENDING. The agent
    // dispatches the read-only scouts in between. See commands/enrich.ts.
    case "enrich":
      return runEnrich(argv.slice(1));
    // `mla graph` (alias `cg` = coordination graph) is the relationship axis's own
    // home: `review`/`pending` route to the SAME handlers as `mla kb review`/`kb
    // pending` (one implementation, two entry points). It exists so the coordination
    // graph stops hiding under the storage noun `kb`. Document/posture verbs typed
    // here are redirected back to `mla kb` rather than conflated. See commands/graph.ts.
    case "graph":
    case "cg":
      return runGraph(argv.slice(1));
    case "summary":
      return runSummary(argv.slice(1));
    case "label":
      return runLabel(argv.slice(1));
    case "stats":
      return runStats(argv.slice(1));
    // `mla turn [N]` is the per-turn analog of `mla stats`; `mla stats --turn`
    // routes to the SAME runTurn handler (one implementation, two entry points).
    case "turn":
      return runTurn(argv.slice(1));
    // `mla adoption` is an alias for `mla stats evidence` (INV-ADOPTION-SOURCE-1):
    // both route through the same runStats -> runAdoption code path, so the two
    // entry points are byte-identical, not two implementations.
    case "adoption":
      return runStats(["evidence", ...argv.slice(1)]);
    case "debug":
      return runDebug(argv.slice(1));
    // `mla bug report | list | status`
    // (notes/20260705-mla-bug-report-command-proposal.md): file a private,
    // redacted diagnostic report to Meetless and track it to resolution. The
    // failure footer in runCliBootstrap points crashed runs straight at
    // `mla bug report --trace-id <id>`.
    case "bug":
      return runBug(argv.slice(1));
    // `mla evidence` is the one human-only CE0 evidence-consultation labeling workflow
    // (notes/20260617-evidence-consultation-forcing-function-proposal.md §2.3): ce0-export writes
    // the JSONL a labeler audits, ce0-import-labels reads it back and CAS-finalizes. Local only.
    case "evidence":
      return runEvidence(argv.slice(1));
    // `mla mcp` boots the Meetless MCP server over stdio, authenticated as the
    // logged-in human (cli-config user-token) and scoped to the marker
    // workspace. Replaces the old standalone `meetless-mcp` service-key bin.
    //
    // Self-heal split (lib/mcp-restart.ts): a bare `mla mcp` runs the thin
    // supervising parent, which respawns a `mla mcp --child` worker whenever a
    // newer build lands on disk, so the long-lived daemon stops serving stale
    // code (the "This operation was aborted" footgun) without an editor restart.
    // The child (and the MEETLESS_MCP_SUPERVISOR=0 kill switch) run the worker
    // directly.
    case "mcp":
      // @meetless/mcp is ESM-only and ships as a CJS bundle the binary loads via
      // require() (scripts/bundle-esm.js); runMcp/loadAndServe handle
      // bundle-vs-source resolution. Works in the binary and from a source/npm
      // install alike, so no binary gate here.
      return shouldSuperviseMcp(argv.slice(1), process.env)
        ? runMcpSupervisor(argv.slice(1))
        : runMcp(argv.slice(1));
    // `mla upgrade` [--check] [--force]: explicit, foreground self-upgrade. Fetches
    // and Ed25519-verifies the signed release manifest, enforces the downgrade
    // guard, and atomically swaps the binary in place (curl installs only; brew/
    // npm/unknown are redirected to their package manager). The silent background
    // path (stage + apply-on-launch) is separate; this is the user-driven command.
    case "upgrade":
      return runUpgrade({ argv: argv.slice(1) });
    case "_internal": {
      if (sub === "finalize-session") return runInternalFinalize(rest);
      if (sub === "active-review") return runInternalActiveReview(rest);
      if (sub === "auto-index") return runInternalAutoIndex(rest);
      if (sub === "evidence-inject") return runInternalEvidenceInject(rest);
      if (sub === "evidence-correlate") return runInternalEvidenceCorrelate(rest);
      if (sub === "evidence-turn-open") return runInternalEvidenceTurnOpen(rest);
      if (sub === "evidence-capture") return runInternalEvidenceCapture(rest);
      if (sub === "evidence-stop") return runInternalEvidenceStop(rest);
      if (sub === "steer-sync") return runInternalSteerSync(rest);
      if (sub === "capture-decisions") return runCaptureDecisions(rest);
      if (sub === "pretool-observe") return runInternalPretoolObserve(rest);
      if (sub === "forward-enforcement") return runInternalForwardEnforcement(rest);
      if (sub === "enforcement-correlate") return runInternalEnforcementCorrelate(rest);
      if (sub === "redact-capture") return runInternalRedactCapture(rest);
      if (sub === "turn-recap") return runInternalTurnRecap(rest);
      if (sub === "refresh") return runInternalRefresh(rest);
      if (sub === "session-nudge") return runInternalSessionNudge(rest);
      if (sub === "update-check") return runInternalUpdateCheck();
      if (sub === "scan-context") return runScanContext(rest);
      if (sub === "assemble-context") return runAssembleContext(rest);
      console.error(`Unknown _internal subcommand: ${sub ?? "(none)"}`);
      return 2;
    }
    default:
      console.error(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

// Observability bootstrap: Sentry init MUST run BEFORE any other work so
// bootstrap failures (config load, http first-hop) still surface as alerts.
// trace_id is minted once per invocation and threaded through every outbound
// HTTP request via lib/http.ts (X-Trace-ID header). It is IMMUTABLE for the
// run; mlaFetch never reads response X-Trace-ID back. See spec §4.
//
// Spine note (notes/20260530-mla-observability-diagnostic-spine.md):
//   - Canonical trace_id is 32 hex chars (OTel-native), NOT UUIDv4. This
//     matches intel's RequestContext.langfuse_trace_id format and avoids any
//     translation across Sentry/Langfuse/X-Trace-ID planes.
//   - P2 lifecycle: one root span per command (`mla.<cmd>.<sub>`), one child
//     span per outbound HTTP call (wired in lib/http.ts), root carries
//     redacted argv + exit code, deep link printed only when trace landed.

// Read CliConfig if present; return null otherwise. Used by the lifecycle
// wrapper to know whether the run has any control hop at all (`mla init`,
// `mla --help`, `mla doctor` on a fresh box have no config). When null, the
// run uses a no-op tracer and skips the workspace/me prefetch.
function tryReadConfig(): CliConfig | null {
  try {
    return readConfig();
  } catch {
    return null;
  }
}

// Best-effort GET /internal/v1/workspaces/me. Hydrates the run-local workspace
// config so workspaceSentryAllowed + the Langfuse deep-link gate have real
// data.
//
// If a workspace config is already preset (test fixtures, future programmatic
// callers), we DO NOT touch it: the existing value is treated as authoritative
// and we skip the network hop entirely. On a fresh run with no preset, success
// stores the config; failure (control down, bad token, 404) is a silent no-op
// so the run continues with sentryEnabled=false + no deep link.
async function prefetchWorkspaceConfig(
  cfg: CliConfig,
  workspaceId: string,
): Promise<void> {
  if (getWorkspaceConfig()) return;
  try {
    const data = await controlGet<WorkspaceConfigForTracing>(
      cfg,
      `/internal/v1/workspaces/me?workspaceId=${encodeURIComponent(workspaceId)}`,
      4000,
    );
    setWorkspaceConfig(data);
  } catch {
    // Intentional no-op.
  }
}

// Teardown commands delete the local ~/.meetless footprint as their whole
// purpose (BUG-1 D). `uninstall` is the only one today; `unwire` keeps HOME
// (it only strips settings.json hooks), so it is deliberately NOT here.
export function isTeardownCommand(cmdName: string): boolean {
  return cmdName === "uninstall";
}

// True only when a teardown command has ACTUALLY removed HOME. The homeExists
// probe is lazy (a thunk) so the existsSync never runs on the hot path of a
// normal command -- it is evaluated solely for `uninstall`. A dry-run or
// cancelled uninstall leaves HOME in place, so this returns false and the
// post-command telemetry runs as usual; a real uninstall returns true and every
// disk-writing teardown bows out rather than mkdir the directory back to life.
export function homeWasTornDown(cmdName: string, homeExists: () => boolean): boolean {
  return isTeardownCommand(cmdName) && !homeExists();
}

// Testable orchestration: mints trace_id, hydrates workspace config, opens the
// root span, runs dispatch, captures non-zero / throw signals, ends the root,
// flushes the trace, prints the Langfuse deep link only when the trace likely
// landed. The real require.main entrypoint wraps this and calls process.exit.
export async function runCliBootstrap(argv: string[]): Promise<number> {
  // Apply-on-launch (D3), FIRST thing of all: if the background check has staged
  // a verified newer binary and auto-apply is on (curl installs only), promote it
  // with a cheap local swap and re-exec this exact command on the new binary. The
  // re-exec'd child carries MLA_UPGRADE_REEXECED=1 so it skips this block (loop
  // guard). Runs before the trace/analytics machinery so a promoted run is not
  // double-counted. Best-effort and fail-open: any failure leaves the current
  // binary running. The `_internal`, `upgrade`, and `mcp` commands are carved out
  // inside maybePromoteStagedAndReExec so the check child, explicit upgrades, and
  // the long-lived MCP daemon (which self-heals a stale dist in-band) never
  // self-promote underneath themselves.
  const promote = await maybePromoteStagedAndReExec({ command: argv[0], env: process.env });
  if (promote.reExeced) return promote.code ?? 0;

  // Hook auto-resync, the SECOND thing of all: the installed hooks under
  // ~/.meetless/hooks are a copy of this binary's templates, and only `mla
  // rewire` refreshes them, so any binary upgrade (curl/brew/npm/manual) leaves
  // the live hooks lagging the new code until the operator re-rewires. This
  // self-heals that the moment a new binary runs: a cheap stamp read short-
  // circuits the steady state, and on a build-id change it re-copies only the
  // drifted, already-installed hooks (never adds new hooks or touches
  // settings.json -- those still need an explicit rewire). Best-effort and
  // fail-open: it never throws and never changes the exit code. Runs for every
  // command (including the hook-invoked `_internal` calls, which is exactly how
  // a fresh binary first heals mid-session) since it is idempotent and gated on
  // the stamp. See notes/20260626-hook-auto-resync.md.
  maybeResyncHooks();

  // MCP command auto-heal, the THIRD thing of all: maybeResyncHooks (above)
  // deliberately never touches ~/.claude.json, so a binary upgrade does NOT fix an
  // older pkg binary's poisoned mcpServers.meetless command (`/snapshot/.../cli.js`,
  // which Claude Code cannot spawn). This re-points a provably-broken meetless
  // command at the current binary the moment any command runs -- the capture hooks
  // survive the poison via their PATH fallback, so they carry the heal even while
  // the MCP itself is dead. Same shape as the hook resync: a cheap stamp read
  // short-circuits the steady state (no claude.json parse), it only repairs an
  // EXISTING broken entry (never creates or re-canonicalizes a healthy one), and it
  // is best-effort/fail-open (never throws, never changes the exit code). Runs for
  // every command including the hook-invoked `_internal` calls.
  maybeHealMcpCommand();

  // Wall-clock at the very top: duration_ms for the mla_command journey event is
  // measured from here to finalize, and the sequence idle-gap uses this as the
  // command's start time (spec section 6.2). Captured before any I/O so it
  // reflects the user-perceived command duration.
  const startedAtMs = Date.now();
  const traceId = mintTraceId();
  setRunTraceId(traceId);
  // run_id (INV-RUN-1): the analytics invocation key, minted independently from
  // trace_id (never derived from it). 1:1 with trace_id at the CLI in v1, but a
  // distinct identity so hooks/MCP/child-traces can later mint their own run_id
  // under a shared trace. Every analytics event this run emits reads it back via
  // getRunId().
  setRunId(mintRunId());
  // Repo fingerprint (T1.10): a one-way hash of the repo identity for analytics
  // attribution, computed ONCE here (it shells out to git) and stashed in a
  // run-local singleton that every event reads back via getRepoFingerprint().
  // Null outside a git repo; never a raw path (INV-POSTHOG-PII-1).
  setRepoFingerprint(computeRepoFingerprint());
  // Agent session capture (Channel A substrate): the raw Claude session UUID,
  // canonicalized ONCE here so every intel call this run stamps the same
  // X-Agent-Session-ID and intel composes the workspace-namespaced Langfuse
  // Session a single time. Null when not inside a Claude session or the env value
  // is malformed; the header is then simply omitted. The raw UUID is never
  // composed CLI-side (INV-COMPOSE-ONCE).
  setRunSessionId(canonicalizeSessionId(process.env.CLAUDE_CODE_SESSION_ID ?? null));

  const [cmd, sub] = argv;
  const cmdName = cmd ?? "(none)";
  const subName = sub ?? null;

  // Teardown command (BUG-1 D): `mla uninstall` deletes ~/.meetless as its whole
  // point. Every post-command telemetry writer below routes through ensureHome(),
  // which mkdir's ~/.meetless straight back into existence, so a "clean" uninstall
  // was silently resurrecting the directory (events.jsonl + a trace deadletter).
  // Flag the command here so both the pre-dispatch detached background check and
  // the post-dispatch disk writers can bow out once HOME is actually gone.
  const teardown = isTeardownCommand(cmdName);

  const cfg = tryReadConfig();
  // Folder = workspace (T1.1): the trace workspace comes from the nearest
  // `.meetless.json` marker, never cli-config. This bootstrap runs for EVERY
  // command (including non-workspace ones like `mla init` from an unbound dir),
  // so resolution is best-effort: no marker -> no workspace attribution, and the
  // trace prefetch + flush are simply skipped rather than throwing.
  const workspaceId = cfg ? tryResolveWorkspaceId() : null;
  if (cfg && workspaceId) {
    await prefetchWorkspaceConfig(cfg, workspaceId);
  }

  const buildInfo = loadBuildInfo();

  // Update notifier (I5): kick off a detached, throttled background version check
  // BEFORE dispatch so it overlaps the command and the parent never waits. The
  // nag itself is printed at the end of the run from whatever the LAST completed
  // check cached. Both halves are best-effort and can never change the exit code.
  // Skipped for a teardown command (BUG-1 D): the detached child writes the update
  // state under ~/.meetless and could land AFTER uninstall removes HOME, silently
  // recreating the directory we were asked to delete.
  if (!teardown) {
    maybeSpawnBackgroundCheck({ command: cmdName, env: process.env, now: startedAtMs });
  }

  // Content sub-kill: a null flushFn yields a no-op tracer (createRunTracer), so
  // when trace upload is off the trace plane never POSTs a span batch to control.
  // Gated on traceUploadEnabled() (master kill OR the MEETLESS_TRACE_UPLOAD content
  // sub-kill), the SAME gate as initSentry below, because agent-trace spans are
  // content-bearing (spec section 9). Spans are still built in-process (cheap, never
  // leave the machine).
  const flushFn =
    cfg && workspaceId && traceUploadEnabled()
      ? makeHttpFlush({
          controlUrl: cfg.controlUrl,
          controlToken: cfg.controlToken,
          workspaceId,
          actorUserId: cfg.actorUserId,
        })
      : null;
  const tracer: Tracer = createRunTracer({
    traceId,
    rootName: `mla.${cmdName}.${subName ?? "none"}`,
    buildInfo,
    flushFn,
  });
  // Stamp the redacted argv on the root span before dispatch. Doing it here
  // (not inside dispatch) keeps the attribute on the root regardless of which
  // command runs, and the redactor strips any token-shaped flag values that a
  // user pasted on the command line.
  tracer.root.setAttribute("argv", redactArgvForSpan(argv));
  setRunTracer(tracer);

  let code = 1;
  let threw = false;
  let thrown: unknown = null;
  try {
    code = await dispatch(argv);
    if (code !== 0) {
      captureCliNonZeroExit({
        traceId,
        command: cmdName,
        sub: subName,
        exitCode: code,
      });
    }
  } catch (err) {
    threw = true;
    thrown = err;
    const e = err as Error & { status?: number; body?: string };
    // A workspace-membership 403 (the folder marker, or an explicit --workspace,
    // names a workspace this human is not in) is the single most common way a
    // read command reaches this catch. Route it through the ONE canonical handler
    // (BUG-5) so it reads "You are not a member of workspace 'X'..." instead of a
    // raw `HTTP 403: GET https://.../internal/... -> ...` dump that leaks the
    // internal URL and buries the actual cause. This is the backstop for commands
    // that let the 403 propagate (review --plain, session show); commands that
    // catch locally handle it at their own call site.
    if (isWorkspaceAccessDenied(e)) {
      console.error(workspaceAccessDeniedMessage(e));
    } else if (e.status) {
      console.error(`HTTP ${e.status}: ${e.message}`);
    } else {
      console.error(e.message || String(err));
    }
    // Failure footer (proposal §3.6): the nudge to file a redacted diagnostic
    // report must fire ONLY on a genuine fault on our side (a 5xx from a reachable
    // backend, or an unhandled in-process crash), never on a user-actionable
    // failure (not logged in, repo not activated, offline, a bad ref, a rate
    // limit). classifyOutcome + isReportableFault is the single source of truth
    // for that decision (shared with the analytics journey event below), so the
    // nudge and the recorded outcome can never disagree. A user's own codebase
    // errors never traverse this catch, so the nudge is structurally scoped to
    // mla's own faults.
    if (isReportableFault(classifyOutcome(1, true, err))) {
      console.error(
        "\nMLA hit an internal error. Send us a redacted diagnostic report:\n" +
          `  mla bug report --trace-id ${traceId}`,
      );
    }
    captureCliError(err, { traceId, command: cmdName, sub: subName });
    code = 1;
  }

  tracer.endRoot(
    threw
      ? { status: "error", output: { exitCode: code }, error: thrown }
      : { status: code === 0 ? "ok" : "error", output: { exitCode: code } },
  );
  tracer.root.setAttribute("exit_code", code);
  // homeRemoved (BUG-1 D): true only when this run was an uninstall that actually
  // deleted ~/.meetless. A dry-run or cancelled uninstall leaves HOME in place, so
  // this stays false and telemetry runs normally; a real uninstall skips every
  // disk-writing teardown below so nothing mkdir's the directory back. The
  // existsSync is short-circuited behind the command check so it only runs for
  // uninstall, never on the hot path of every command.
  const homeRemoved = homeWasTornDown(cmdName, () => fs.existsSync(HOME));
  // The trace flush deadletters a failed upload under ~/.meetless; skip it once
  // HOME is gone so a 403/5xx on the uninstall's own trace cannot resurrect it.
  if (!homeRemoved) {
    await boundedTraceFlush(tracer);
  }
  setRunTracer(null);

  // mla_command journey event (spec section 6.2, section 11.4). Recorded after the
  // result is known: a normalized command/subcommand/flags-shape (never raw argv),
  // the closed-enum outcome, the run's sequence fields, and timing. Local-first and
  // fully best-effort: captureCommandEvent swallows every failure so analytics can
  // never change the exit code below. sessionId is the ambient Claude Code session
  // the same way `mla review`/`mla summary` bind it. Skipped once HOME is gone
  // (BUG-1 D): the local jsonl append calls ensureHome() and would recreate the
  // very directory an uninstall just removed.
  if (!homeRemoved) {
    await captureCommandEvent({
      argv,
      exitCode: code,
      threw,
      thrown,
      workspaceId,
      sessionId: (process.env.CLAUDE_CODE_SESSION_ID || "").trim() || null,
      actorUserId: cfg?.actorUserId ?? null,
      mlaVersion: buildInfo.version,
      gitSha: buildInfo.sha,
      startedAtMs,
      nowMs: Date.now(),
      cfg: cfg ?? null,
    });
  }

  // Deep link: print iff tracing.enabled === true AND langfuseProjectId set
  // AND (flush succeeded OR intel echoed the inbound X-Trace-ID). The gate is
  // checked inside maybePrintDeepLink; a no-op tracer + missing workspace
  // config always falls through silently.
  maybePrintDeepLink({
    traceId,
    config: getWorkspaceConfig(),
    flushSucceeded: didTraceFlushSucceed(),
    intelEchoed: didIntelEchoTraceId(),
  });

  // Update notifier (I5): print the install-method-aware upgrade nag last, so it
  // is the final thing the user sees. Reads only the cache; gated on TTY, off CI,
  // and MLA_NO_UPDATE_NOTIFIER. Never affects `code`.
  maybeShowUpdateNag({ currentVersion: buildInfo.version, env: process.env });

  return code;
}

if (require.main === module) {
  const buildInfo = loadBuildInfo();
  // Sentry is the content-bearing error plane, so it is gated on the trace-upload
  // posture (opt-out, master-kill-aware), not just the bare telemetry kill switch.
  // initSentry itself also refuses when telemetryDisabled(); this is the explicit
  // content sub-kill in front of it (INV-CONSENT-1).
  if (traceUploadEnabled()) {
    initSentry(buildInfo);
  }

  const argv = process.argv.slice(2);
  runCliBootstrap(argv)
    .then(async (code) => {
      await boundedSentryFlush();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err?.message || String(err));
      await boundedSentryFlush();
      process.exit(1);
    });
}
