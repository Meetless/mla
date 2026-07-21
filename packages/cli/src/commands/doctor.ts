import { execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readConfig,
  CliAuth,
  HOOKS_DIR,
  SESSION_GATE_DIR,
  codexHooksPath,
  userHomeDir,
} from "../lib/config";
import { tryResolveWorkspaceId } from "../lib/workspace";
import { get, ping } from "../lib/http";
import { queueDepth, reapQueue } from "../lib/spool";
import { findActivation } from "../lib/activation";
import {
  checkHookDrift,
  isSupportHookFile,
  MCP_SERVER_KEY,
  mcpCommandExecutable,
  isPkgSnapshotPath,
} from "../lib/wire";
import {
  openCe0Store,
  closeCe0Store,
  type Ce0Store,
} from "../lib/rules/ce0-store";
import { CE0_INTERCEPTION_SCHEMA_VERSION } from "../lib/rules/interception-schema";
import { type InputAuthorityResolution } from "../lib/rules/input-authority-resolver";
import { resolveLiveInputAuthority } from "../lib/rules/live-input-authority";
import {
  resolveAttestedPathRoot,
  type PathRootAdmission,
} from "../lib/rules/deny-admission";
import {
  countDenyDecisionsAwaitingEmission,
  countFailOpenEnforcementViolations,
} from "../lib/rules/interception-store";
import { getLiveLocalRuleVersion } from "../lib/rules/local-rule-version-repo";
import {
  detectWslUnderWindows,
  shouldSurfaceWslHint,
  WSL_MLA_HINT,
} from "../lib/wsl-detect";
import { NOTES_LOCATION_RULE_ID } from "../lib/rules/attest-notes-location";
import { resolveActiveRuntimeScopeId } from "../lib/rules/runtime-scope";
import { type RulePayloadV1 } from "../lib/rules/types";
import { defaultCe0StorePath } from "./evidence";
import {
  detectPluginOwnership,
  type PluginOwnership,
} from "../connectors/claude-code/plugin-detect";
import {
  inspectLegacyWiring,
  planLegacyReconcile,
  applyLegacyReconcile,
  legacyWiringPaths,
  defaultReconcileIO,
  type ReconcilePlan,
  type ReconcileIO,
} from "../connectors/claude-code/plugin-migrate";
import { codexHooksInstalled } from "../connectors/codex/wire";
import {
  readRuleBundleCache,
  type BundleCacheRead,
} from "../lib/rules/bundle-cache";
import { resolveBundlePrincipal } from "../lib/rules/bundle-principal";

// `mla doctor` (§4.9, §6.4 step 14, Acceptance §11.14)
//
// Verifies the chain end to end. Red anywhere = block dogfood.
//
//   1. control reachable      GET /internal/v1/health
//   2. token valid + workspace + actor + caseKind  GET /internal/v1/whoami
//   3. intel reachable        GET /health (if intelUrl configured)
//   4. ~/.claude/settings.json registers all required hooks
//   5. /mla skill installed
//   5b. Meetless MCP server registered (user scope ~/.claude.json, or project .mcp.json)
//   6. mlaPath resolves and is executable
//   7. ALL hook scripts present + executable under ~/.meetless/hooks/
//   8. queue depth (sessions, events, orphans, oldest event age)
//
// It also reports the TWO distinct lifecycles (folder = workspace, T3.3),
// kept separate so an operator can tell "this folder is bound" apart from
// "this session is being captured":
//
//   9.  Workspace binding   the `.meetless.json` marker (activate / deactivate):
//                           activated / not activated, workspaceId, marker path,
//                           and (via the whoami probe above) workspace exists /
//                           inaccessible.
//   10. Session capture     the `<sid>.off` sentinel (mute / unmute):
//                           active / muted for THIS session. A folder can be
//                           activated while this session is muted.

export const REQUIRED_HOOKS = [
  "common.sh",
  "session-start.sh",
  "user-prompt-submit.sh",
  "stop.sh",
  "flush.sh",
  // CE0 evidence-consultation measurement harness (proposal §4.1, §6.4). The four
  // ce0-*.sh scripts are installed unconditionally by `mla rewire` (no opt-out flag,
  // unlike post-tool-use.sh). They are REQUIRED, not OPTIONAL, for the same reason
  // event-batch-filter.jq is: a binary upgrade without a re-rewire would leave them
  // absent and silently break measurement. A missing CE0 script is otherwise
  // invisible (not drift -- the byte check ignores absent files), so doctor must go
  // RED here to force the re-rewire.
  //
  // The first three ride UserPromptSubmit / PostToolUse / Stop as second managed
  // entries; absent, they silently under-record every turn. The fourth,
  // ce0-session-start.sh, rides SessionStart and gives the offline §6.4 sweep an
  // automatic caller: absent, the two precision/recall denominator events
  // (memory_requirement_assessed, evidence_obligation_finalized) stop projecting and
  // the ratios silently lose their denominator -- the same invisible-when-missing
  // failure, so it is REQUIRED on the same footing.
  "ce0-user-prompt-submit.sh",
  "ce0-post-tool-use.sh",
  "ce0-stop.sh",
  "ce0-session-start.sh",
  // Wedge v6 Epoch 27: the Pass 2 batch filter is a separate file so it can be
  // unit-tested independently and shared between runtime + tests. If a user
  // upgrades the mla binary but does NOT re-run `mla init`, their old flush.sh
  // stays on disk and this file is missing -- but the NEW flush.sh (when it
  // ships next) references it, so any future re-install + missed re-init would
  // silently drop every event batch via the `|| echo "[]"` fallback. Doctor
  // RED if the file is missing OR the installed flush.sh predates the
  // filter-file extraction (content drift check below).
  "event-batch-filter.jq",
  // The live PreToolUse enforcement hook (A1). It pipes the raw PreToolUse stdin to
  // `mla _internal pretool-observe`, which runs the version-backed enforce seam and emits the deny
  // on the wire. Like the CE0 scripts it is installed unconditionally by `mla rewire` (only
  // PostToolUse carries the --no-post-tool-use opt-out, wire.ts), so a binary upgrade that skipped a
  // re-rewire would leave it absent and SILENTLY STOP ENFORCING under an otherwise GREEN doctor. RED
  // on missing to force the re-rewire.
  "pre-tool-use.sh",
];
export const OPTIONAL_HOOKS = ["post-tool-use.sh"];

// PreToolUse joins the required events with A1: wire.ts registers it unconditionally (it carries no
// opt-out flag, unlike PostToolUse), so a missing registration means the live enforcement hook never
// fires and the pilot silently stops enforcing. RED on missing.
export const REQUIRED_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
];
const OPTIONAL_HOOK_EVENTS = ["PostToolUse"];

// The MCP command-health probe (check 5b, below) and the pkg-snapshot guard live
// in wire.ts now, next to resolveMlaPath and the ensureClaudeMcpServer auto-heal
// that share them, so the health definition has one home and there is no
// wire<->doctor import cycle. Re-exported here so tests and callers that reach the
// check via the doctor surface keep their import path.
export { mcpCommandExecutable, isPkgSnapshotPath };

// `mla doctor` takes at most one flag, --fix, which reconciles legacy home-dir
// wiring against an installed plugin (removing the duplicate legacy hooks/MCP when
// the plugin owns them, or completing an EXISTING but degraded legacy capture;
// never installing from a clean absence; `mla rewire` is the create-from-zero
// installer). Any other argument is rejected: doctor is a read-only check by default, and
// silently ignoring a typo'd flag would hide a mistake. The removed --gc flag (a
// long-standing no-op) gets a targeted message so an old script fails loudly.
export function parseDoctorArgs(argv: string[]): {
  fix: boolean;
  json: boolean;
} {
  let fix = false;
  let json = false;
  for (const a of argv) {
    if (a === "--fix") {
      fix = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    const gcNote =
      a === "--gc" ? " (the --gc flag was a no-op and has been removed)" : "";
    throw new Error(
      `mla doctor accepts only the optional --fix and --json flags; got: ${argv.join(" ")}${gcNote}`,
    );
  }
  return { fix, json };
}

interface Check {
  ok: boolean;
  label: string;
  detail?: string;
  level?: "info";
  // Stable machine identifier for the `--json` emitter. English labels are free
  // to reword; `id` is the contract a harness asserts against (§6.3 names
  // control.reachable, actor.member, actor.owner, casekind.seeded, plus
  // mcp.registered / ce0.integrity). Optional: checks without an explicit id
  // fall back to a slug derived from the label in doctorJson.
  id?: string;
}

function fmt(c: Check): string {
  if (c.level === "info")
    return `  ⓘ ${c.label}${c.detail ? `: ${c.detail}` : ""}`;
  const mark = c.ok ? "✓" : "✗";
  return `  ${mark} ${c.label}${c.detail ? ` (${c.detail})` : ""}`;
}

// A read-only health line describing the plugin install (design §8). The version
// string is echoed VERBATIM and treated as OPAQUE (never parsed, never hardcoded):
// whatever `claude plugin list` reports for this install (a semver, a commit SHA,
// "unknown", or any other source-assigned string) is passed straight through. This
// is the install-time version, independent of the real semver the manifest carries
// and of the `plugin.json.version` that governs release delivery. Non-global/absent/unknown are
// informational, not failures: the plugin is one of two supported wiring modes, not a
// requirement, and a project-scope install provides no global wiring.
export function pluginStatusCheck(ownership: PluginOwnership): Check {
  if (ownership.status === "owned") {
    return {
      ok: true,
      label: "mla plugin",
      detail: `installed at ${ownership.scope} scope (version ${ownership.version})`,
    };
  }
  if (ownership.status === "non-global") {
    return {
      ok: true,
      label: "mla plugin",
      detail: `installed at ${ownership.scope} scope only; it does not provide global wiring`,
      level: "info",
    };
  }
  if (ownership.status === "absent") {
    return {
      ok: true,
      label: "mla plugin",
      detail: "not installed (using legacy home-dir wiring)",
      level: "info",
    };
  }
  return {
    ok: true,
    label: "mla plugin",
    detail: `install state unknown (${ownership.reason})`,
    level: "info",
  };
}

export function codexHookDoctorCheck(installed: boolean, hooksPath: string): Check {
  return installed
    ? {
        id: "codex.hooks.registered",
        ok: true,
        label: "Codex Meetless hooks registered",
        detail: hooksPath,
      }
    : {
        id: "codex.hooks.registered",
        ok: true,
        level: "info",
        label: "Codex Meetless hooks not installed",
        detail: "run `mla codex install` to enable Codex grounding and enforcement",
      };
}

/**
 * Codex intentionally exposes a smaller managed lifecycle than Claude Code.
 * Keep that boundary visible in doctor so a healthy install is not mistaken
 * for feature parity: grounding and pre-write governance are live, while the
 * Stop/PostToolUse-dependent capture and correlation paths are unavailable.
 */
export function codexLifecycleCoverageCheck(installed: boolean): Check {
  return installed
    ? {
        id: "codex.hooks.coverage",
        ok: true,
        level: "info",
        label: "Codex hook coverage: PreToolUse + UserPromptSubmit",
        detail:
          "SessionStart, PostToolUse, and Stop are not installed on Codex; Claude-only session capture, decision capture, and end-of-turn correlation do not run here",
      }
    : {
        id: "codex.hooks.coverage",
        ok: true,
        level: "info",
        label: "Codex hook coverage inactive",
        detail: "no Meetless Codex hooks are installed",
      };
}

export function ruleBundleDoctorChecks(read: BundleCacheRead): Check[] {
  if (read.status === "unavailable" || !read.bundle) {
    return [
      {
        id: "rules.bundle",
        ok: true,
        level: "info",
        label: "governed rule bundle unavailable",
        detail: read.reason ?? "run `mla scan` to refresh it",
      },
    ];
  }

  const checks: Check[] = [
    {
      id: "rules.bundle",
      ok: read.status === "fresh" && read.droppedForIntegrity === 0,
      label: `governed rule bundle ${read.status}`,
      detail:
        `revision ${read.bundle.bundleRevision}, ${read.bundle.rules.length} active rule(s)` +
        (read.droppedForIntegrity
          ? `; ${read.droppedForIntegrity} rule(s) failed integrity validation`
          : ""),
    },
  ];

  const noteVaultRule = read.bundle.rules.find((entry) => {
    const payload = entry.payload as RulePayloadV1 | undefined;
    const config = payload?.compliance?.config;
    return !!config && "allowedRootAbsolutePath" in config;
  });
  if (!noteVaultRule) {
    checks.push({
      id: "rules.notes-vault",
      ok: true,
      level: "info",
      label: "date-prefixed notes vault rule not configured",
    });
    return checks;
  }

  const payload = noteVaultRule.payload as RulePayloadV1;
  const config = payload.compliance.config;
  checks.push({
    id: "rules.notes-vault",
    ok: true,
    label: "date-prefixed notes vault rule active",
    detail:
      `${"allowedRootAbsolutePath" in config ? config.allowedRootAbsolutePath : "unknown vault"}; ` +
      `${payload.enforcementCeiling} via rule ${noteVaultRule.ruleNodeId}; receipts: \`mla enforcement --json\``,
  });
  return checks;
}

export type CodexMcpProbe =
  | { kind: "configured"; detail: string }
  | { kind: "absent"; detail: string }
  | { kind: "unavailable"; detail: string };

export function codexMcpDoctorCheck(probe: CodexMcpProbe): Check {
  if (probe.kind === "configured") {
    return {
      id: "codex.mcp.registered",
      ok: true,
      label: "Codex Meetless MCP server registered",
      detail: probe.detail,
    };
  }
  return {
    id: "codex.mcp.registered",
    ok: true,
    level: "info",
    label:
      probe.kind === "absent"
        ? "Codex Meetless MCP server not installed"
        : "Codex MCP status unavailable",
    detail: probe.detail,
  };
}

/**
 * Codex support has two independent halves. Keep Codex optional when neither
 * half is installed, but fail doctor when an operator has installed only one:
 * that state can retrieve without governance, or govern without retrieval.
 */
export function codexConnectorCompleteCheck(
  hooksInstalled: boolean,
  probe: CodexMcpProbe,
): Check {
  const mcpInstalled = probe.kind === "configured";
  if (!hooksInstalled && !mcpInstalled) {
    return {
      id: "codex.connector.complete",
      ok: true,
      level: "info",
      label: "Codex connector not enabled",
      detail: "install the MLA Codex plugin and run `mla codex install` to enable it",
    };
  }
  if (hooksInstalled && mcpInstalled) {
    return {
      id: "codex.connector.complete",
      ok: true,
      label: "Codex connector complete for supported surfaces",
      detail:
        "governed retrieval, prompt grounding, and pre-write governance are installed; see codex.hooks.coverage for lifecycle limits",
    };
  }
  return {
    id: "codex.connector.complete",
    ok: false,
    label: "Codex connector incomplete",
    detail: hooksInstalled
      ? "hooks are installed but the Meetless MCP plugin is missing or unavailable"
      : "the Meetless MCP plugin is installed but hooks are missing; run `mla codex install`",
  };
}

function probeCodexMcp(): CodexMcpProbe {
  try {
    const raw = execFileSync("codex", ["mcp", "get", "meetless", "--json"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw);
    const transport = parsed?.transport;
    const args = Array.isArray(transport?.args) ? transport.args : [];
    if (
      parsed?.enabled === true &&
      transport?.type === "stdio" &&
      transport?.command === "mla" &&
      args[0] === "mcp"
    ) {
      return { kind: "configured", detail: "meetless -> `mla mcp` (enabled)" };
    }
    return {
      kind: "absent",
      detail: "a meetless entry exists but is disabled or does not launch `mla mcp`; install `mla@meetless`",
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return { kind: "unavailable", detail: "Codex CLI is not on PATH" };
    }
    return {
      kind: "absent",
      detail: "install the `mla@meetless` Codex plugin to enable governed retrieval",
    };
  }
}

// Resolve the directory that actually holds the live capture hooks, so doctor's
// presence + drift checks match how the user installed rather than assuming the
// legacy home dir. Mirrors activate's resolveSessionStartHook precedence exactly:
// legacy home-dir wiring (~/.meetless/hooks) first, else the owned plugin's
// bundled hooks (<installPath>/hooks). Without this, a fully-wired plugin user
// (the shipped marketplace install, whose hooks live under the plugin root) sees
// an UNFIXABLE red "hook script session-start.sh installed" -- the exact
// contradiction behind activate telling those users to run `mla init`
// (dogfood 2026-07-10). Falls back to HOOKS_DIR (the `mla init` target) when
// neither surface is present, so a genuinely-unwired machine still goes red
// against the path a repair would populate.
export function resolveHooksDir(ownership: PluginOwnership): {
  dir: string;
  surface: string;
} {
  if (fs.existsSync(path.join(HOOKS_DIR, "session-start.sh"))) {
    return { dir: HOOKS_DIR, surface: "home-dir wiring" };
  }
  if (ownership.status === "owned" && ownership.installPath) {
    const pluginDir = path.join(ownership.installPath, "hooks");
    if (fs.existsSync(path.join(pluginDir, "session-start.sh"))) {
      return {
        dir: pluginDir,
        surface: `mla@meetless plugin, ${ownership.scope} scope`,
      };
    }
  }
  return { dir: HOOKS_DIR, surface: "home-dir wiring" };
}

// The workspace-binding assertion, extracted from runDoctor's IO shell so it can be pinned
// directly (like doctorExitCode). doctor sends the folder's marker workspaceId to control's
// whoami; control echoes back the workspace it actually resolved for that (token, workspaceId).
// Reporting "workspace resolves" GREEN without confirming the resolved id EQUALS the marker id
// is a false-green: it hides a real misbinding -- a stale marker, a phantom workspace, or a
// cli-config aimed at a backend that cannot see this folder's workspace (the dogfood marker was
// once silently re-pointed to a workspace no local control had, and doctor showed green anyway).
// On a match we surface the id (not just the slug) so this line and the "folder activated" line
// are visibly the SAME workspace even when their display names differ (marker name vs live slug).
export function workspaceBindingCheck(
  markerWorkspaceId: string,
  whoami: { workspace?: { id?: string; slug?: string } } | null | undefined,
): Check {
  const resolvedId = whoami?.workspace?.id;
  const slug = whoami?.workspace?.slug;
  const shown = (id: string) => (slug ? `${id} (${slug})` : id);
  if (resolvedId && resolvedId === markerWorkspaceId) {
    return {
      ok: true,
      label: "token valid + workspace resolves",
      detail: shown(resolvedId),
    };
  }
  return {
    ok: false,
    label: "resolved workspace does not match the folder binding",
    detail:
      `marker binds ${markerWorkspaceId} but the token resolves ` +
      `${resolvedId ? shown(resolvedId) : "no workspace"}; the backend in cli-config cannot ` +
      `see this folder's workspace. Re-run \`mla activate\` here, or point cli-config at the ` +
      `backend that owns ${markerWorkspaceId}.`,
  };
}

// Turn a reconcile plan + mode into doctor Check lines. PURE except for the injected
// `io` (applied only when `fix` is true). Blocker 3: the `plan.warn` advisory is
// appended INDEPENDENT of `fix` AND of `plan.action`, so a plain `mla doctor` on a
// non-global install (which is ALWAYS a noop, Task 7) still surfaces the reinstall
// notice. Info-level + ok:true keeps it advisory (never flips the §6.7 CI exit code).
export function reconcileChecks(
  plan: ReconcilePlan,
  fix: boolean,
  io: ReconcileIO,
): Check[] {
  const out: Check[] = [];
  if (fix) {
    const { changed } = applyLegacyReconcile(plan, io);
    out.push({
      ok: true,
      label: "wiring reconcile",
      detail: changed
        ? `${plan.action}: ${plan.reason}` +
          (plan.restartRequired ? "; RESTART Claude Code to apply" : "")
        : `no change (${plan.reason})`,
      level: changed ? undefined : "info",
    });
  } else if (plan.action !== "noop") {
    out.push({
      ok: true,
      label: "wiring reconcile",
      detail: `would ${plan.action} (${plan.reason}); run \`mla doctor --fix\``,
      level: "info",
    });
  }
  if (plan.warn) {
    out.push({
      ok: true,
      label: "wiring reconcile",
      detail: plan.warn,
      level: "info",
    });
  }
  return out;
}

// The CI-gate exit contract: 1 when any non-info posture check is RED, else 0. The `level: "info"`
// carve-out is load-bearing. The append-only accounting rows (historical fail-open count, deny-emission
// backlog) report as info and must never fail the gate, because the ledger is append-only and one
// transient install-time fail-open would otherwise pin every future `mla doctor` non-zero forever. A
// genuine store fault (corrupt ce0, schema drift, busy_timeout drift, an inadmissible attested root) is
// not info, so it drives a non-zero exit and a CI / script `$?` check catches the degraded store.
// Pinned in doctor-exit-code.spec.ts.
export function doctorExitCode(checks: Check[]): number {
  return checks.some((c) => c.level !== "info" && !c.ok) ? 1 : 0;
}

// The three-value status the `--json` emitter reports per check. `info` is the
// same load-bearing carve-out doctorExitCode honors: an info row never flips the
// roll-up, it is context (auth mode, muted session, append-only accounting), not
// a pass/fail posture. A non-info check is pass when ok, fail otherwise.
export type DoctorCheckStatus = "pass" | "fail" | "info";
export function checkStatus(c: Check): DoctorCheckStatus {
  if (c.level === "info") return "info";
  return c.ok ? "pass" : "fail";
}

// Slug fallback for a check that carries no explicit stable id: lower-case, drop
// any parenthetical (the human detail like "(GET /internal/v1/health)"), and
// collapse the rest to dot-separated tokens. Only the named checks the harness
// asserts (§6.3) carry explicit ids; this keeps the JSON well-formed for the
// rest without inventing a contract nobody depends on.
function slugifyCheckLabel(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return s.slice(0, 60) || "check";
}

export interface DoctorJson {
  status: "green" | "red";
  checks: { id: string; status: DoctorCheckStatus; message: string }[];
}

// The `--json` payload (proposal §217): a roll-up `status` plus one entry per
// check with a stable `id`, a three-value `status`, and a human `message`. The
// roll-up mirrors doctorExitCode exactly (green == exit 0), so `--json` and the
// exit code can never disagree. Derived-slug collisions get a numeric suffix so
// the array is well-formed; explicit stable ids fire once per run (their push
// sites are mutually exclusive branches), so they are never suffixed.
export function doctorJson(checks: Check[]): DoctorJson {
  const seen = new Map<string, number>();
  const out = checks.map((c) => {
    const base = c.id ?? slugifyCheckLabel(c.label);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const id = n === 0 ? base : `${base}.${n + 1}`;
    return {
      id,
      status: checkStatus(c),
      message: c.detail ? `${c.label}: ${c.detail}` : c.label,
    };
  });
  return {
    status: doctorExitCode(checks) === 0 ? "green" : "red",
    checks: out,
  };
}

// Session-capture lifecycle status (folder = workspace, T3.3). DISTINCT from the
// workspace-binding lifecycle (the `.meetless.json` marker): a folder can be
// activated while THIS session is muted. `mla mute` writes a `<sid>.off` sentinel
// into the session gate; `mla unmute` removes it. This reports whether the
// current live Claude Code session is muted, reading the gate dir directly so the
// check is a pure function of (sessionId, gateDir) and unit-pinned in
// doctor-session-capture.spec.ts.
//
// Always informational: a muted session is a deliberate, valid state, never a
// doctor failure (mirrors a dormant folder being info, not red). When there is no
// live session id, capture status is per-session and cannot be reported.
export function sessionCaptureCheck(
  sessionId: string | undefined,
  gateDir: string,
): Check {
  const sid = (sessionId || "").trim();
  if (!sid) {
    return {
      ok: true,
      level: "info",
      label:
        "session capture: no live Claude Code session here (status is " +
        "per-session; run `mla doctor` inside a session to see active / muted)",
    };
  }
  const sid8 = sid.slice(0, 8);
  const muted = fs.existsSync(path.join(gateDir, `${sid}.off`));
  return {
    ok: true,
    level: "info",
    label: muted
      ? `session capture: MUTED for this session (${sid8}); run \`mla unmute\` to resume capture`
      : `session capture: active for this session (${sid8})`,
  };
}

// The four CE0 interception-store checks that gate the R1 notes-location deny pilot
// (proposal §10.1 step 1(d)). Each is a pure function of an already-read value so it is
// unit-pinned in doctor-ce0-schema.spec.ts, exactly like sessionCaptureCheck; the IO that
// reads the pragmas and the settings layers lives in runDoctor below. A red row here means a
// would-be deny would degrade to NONE at runtime, so doctor surfaces it before the pilot runs.

// (1) The local interception schema is at the version this binary expects. A mismatch means a
// stale or foreign database is open under the same path; the deny machinery must not run on it.
export function schemaVersionCheck(actual: number, expected: number): Check {
  const ok = actual === expected;
  return {
    ok,
    label: "CE0 interception schema version",
    detail: ok
      ? `user_version ${actual}`
      : `user_version ${actual}, expected ${expected}; rebuild the CE0 store`,
  };
}

// (2) WAL journal mode keeps a PreToolUse read from ever blocking on a concurrent writer.
export function walModeCheck(journalMode: string): Check {
  const mode = (journalMode || "").toLowerCase();
  const ok = mode === "wal";
  return {
    ok,
    label: "CE0 store journal_mode = WAL",
    detail: ok
      ? undefined
      : `journal_mode is ${journalMode || "unset"}; PreToolUse reads must not block on a writer`,
  };
}

// (3) Foreign keys enforced so an evaluation row can never orphan its attempt or rule version.
export function foreignKeysCheck(foreignKeys: number): Check {
  const ok = foreignKeys === 1;
  return {
    ok,
    label: "CE0 store foreign_keys = ON",
    detail: ok
      ? undefined
      : `foreign_keys is ${foreignKeys}; evaluation rows could orphan their attempt or version`,
  };
}

// (3b) busy_timeout stays small so a contended read fails fast (P0.15). The PreToolUse subcommand
// opens this store and reads it synchronously; if another process holds a write lock the read waits up
// to busy_timeout before SQLITE_BUSY. With busy_timeout <= 50 ms a contended read degrades fast (the
// seam's try/catch then fails open well inside the hook's wall-clock guard); a large value could
// instead stall the hook until that guard fires. openCe0Store hardcodes 50; this guards that number
// against drift, RED if it ever exceeds the ceiling. (The proposal's 500 ms hard-timeout figure is NOT
// the implemented guard: the managed pre-tool-use.sh wrapper uses a 5 s `timeout`; see the dogfood
// report's P0.15 latency section. We deliberately do not quote 500 ms here as if it were wired.)
export function busyTimeoutCheck(busyTimeoutMs: number): Check {
  const ok = busyTimeoutMs >= 0 && busyTimeoutMs <= 50;
  return {
    ok,
    label: "CE0 store busy_timeout <= 50ms",
    detail: ok
      ? `busy_timeout ${busyTimeoutMs}ms`
      : `busy_timeout is ${busyTimeoutMs}ms; a lock-contended read could stall the hook past its wall-clock guard before it fails open`,
  };
}

// (4) MLA is the sole effective PreToolUse Write/Edit input authority (P0.58). Anything else
// (a foreign mutator, an unreadable layer, or no MLA hook at all) means a deny is not admissible.
export function managedPreToolUseHookCheck(
  resolution: InputAuthorityResolution,
): Check {
  if (resolution.kind === "MLA_SOLE_AUTHORITY") {
    return {
      ok: true,
      label: "MLA is the sole effective PreToolUse Write/Edit authority",
      detail: `input authority config ${resolution.configHash.slice(0, 12)}`,
    };
  }
  return {
    ok: false,
    label: "MLA is the sole effective PreToolUse Write/Edit authority",
    detail: `${resolution.reason}: ${resolution.detail}`,
  };
}

// (4b) The attested forbidden root resolves against the active runtime root (P0.63). A deny is
// admitted only when the path root resolves; if a LIVE rule is attested but its root will not resolve
// (no attested content, or the active runtime root is unresolved), a would-be deny silently fails open,
// so doctor goes RED. doctor passes the SAME resolveAttestedPathRoot result the enforce seam computes.
export function attestedPathRootCheck(admission: PathRootAdmission): Check {
  if (admission.admitted) {
    return {
      ok: true,
      label: "attested forbidden path root resolves (deny admissible)",
      detail: admission.forbiddenRoot,
    };
  }
  return {
    ok: false,
    label: "attested forbidden path root resolves (deny admissible)",
    detail: `${admission.reason}: a would-be deny would silently fail open`,
  };
}

// (4c) Honest deny-emission accounting (P0.60). A committed deny is recorded BEFORE it is emitted, so a
// crash in that window leaves a DECISION_RECORDED row that was never advanced to RESPONSE_EMITTED. That
// is honest and recoverable, NEVER corruption, so this is informational and never RED; it only surfaces
// the count so an operator can notice the hook recording denials it never emitted.
export function denyEmissionAccountingCheck(awaitingEmission: number): Check {
  return {
    ok: true,
    level: "info",
    label:
      awaitingEmission === 0
        ? "deny-emission accounting clean (no decisions awaiting emission)"
        : `${awaitingEmission} deny decision(s) recorded but not yet emitted (honest crash-window leftovers; recoverable, never lost)`,
  };
}

// (4d) Historical fail-open visibility. deny-admission.ts promises that when a DENY-ceiling violation
// cannot be denied (RULE_ENFORCEMENT_UNAVAILABLE, decision 5) the action passes, an alert fires, and the
// operator can see it here. Unlike a stuck deny-emission, a fail-open is NOT recoverable: the prohibited
// action already passed un-governed. But the rule_evaluation_record ledger is append-only and an
// install-time transient fail-open must not pin `mla doctor` RED forever, so the count is surfaced as
// info (the count IS the loud alert), never a permanent RED.
export function failOpenEnforcementCheck(failedOpen: number): Check {
  return {
    ok: true,
    level: "info",
    label:
      failedOpen === 0
        ? "enforcement has never failed open (no deny-ceiling violation passed un-governed)"
        : `${failedOpen} deny-ceiling violation(s) failed open (passed un-governed); enforcement was unavailable at decision time`,
  };
}

// (5) The local SQLite authority is structurally sound (P0.15). A PreToolUse hook fails OPEN on an
// invalid or unreadable local store, which silently takes enforcement DOWN, so P0.15 requires the
// degraded store be "surfaced through mla doctor as a failure". The other ce0 reads only catch
// corruption incidentally, when a query happens to touch a damaged page; this runs a deliberate
// full-database PRAGMA quick_check so a corrupt authority is reported authoritatively. Unlike the
// append-only accounting checks this is a LIVE infrastructure failure (enforcement is down right
// now), so it is RED, never info.
export function ce0IntegrityCheck(quickCheckResult: string): Check {
  const ok = quickCheckResult.trim().toLowerCase() === "ok";
  if (ok) {
    return {
      ok: true,
      label: "CE0 store integrity (PRAGMA quick_check)",
      detail: "ok",
    };
  }
  const summary = quickCheckResult.trim().slice(0, 200);
  return {
    ok: false,
    label: "CE0 store integrity (PRAGMA quick_check)",
    detail: `${summary}; the local SQLite authority is unreadable, enforcement is silently failing open`,
  };
}

// Runs the deliberate full-database integrity scan behind ce0IntegrityCheck and returns "ok" when the
// store is sound, otherwise the failure text. Severe corruption makes better-sqlite3 THROW rather than
// return a row, so a throw is folded into the same failure string: either way the authority is unsound
// and the pure check above goes RED.
export function ce0QuickCheckResult(store: Ce0Store): string {
  try {
    const rows = store.db.pragma("quick_check") as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => String(Object.values(r)[0])).join("; ");
  } catch (e) {
    return (e as Error).message;
  }
}

// Newest mtime (ms) of any .ts file under `dir`, walked recursively. Used by
// the build-freshness check to detect a dist/ that lags behind src/.
function newestTsMtimeMs(dir: string): number {
  let newest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      newest = Math.max(newest, newestTsMtimeMs(full));
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        // unreadable file: ignore
      }
    }
  }
  return newest;
}

// One-line, token-free description of the active credential path (§6.4). For a
// user session it adds the display name and how much access-token runway is
// left, so an operator debugging "why am I getting 401s" sees the mode AND
// whether the access token is near expiry (the auto-refresh trigger).
export function describeAuthMode(auth: CliAuth): string {
  if (auth.mode === "none") {
    return "none (not logged in; run `mla login`)";
  }
  if (auth.mode === "shared-key") {
    return "shared-key (internal key; no user identity)";
  }
  const who = auth.user.displayName || auth.user.id;
  const ms = Date.parse(auth.accessExpiresAt) - Date.now();
  let runway: string;
  if (Number.isNaN(ms)) {
    runway = "expiry unknown";
  } else if (ms <= 0) {
    // Access token expired. Auto-refresh fires on the next control call, but it
    // is NOT guaranteed: if the refresh token was revoked or rotated away
    // server-side, the refresh 401s and `mla login` is the only recovery. Do not
    // promise a refresh that may not happen (the old "(will auto-refresh)" lie
    // sent operators into a no-op loop). When the refresh window has also lapsed
    // locally, say so plainly.
    const refreshMs = Date.parse(auth.refreshExpiresAt) - Date.now();
    runway =
      !Number.isNaN(refreshMs) && refreshMs > 0
        ? "access token expired (auto-refresh, else `mla login`)"
        : "session expired; run `mla login`";
  } else {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    runway =
      hours < 48
        ? `access expires ~${hours}h`
        : `access expires ~${Math.floor(hours / 24)}d`;
  }
  return `user-token (${who}; ${runway})`;
}

export async function runDoctor(argv: string[]): Promise<number> {
  // A bad flag is a usage error, not an internal fault. parseDoctorArgs throws on
  // one (its contract, locked by doctor-no-args.spec); catch it here and exit 2
  // with the one-line reason, the same "you typed it wrong" path as "Unknown
  // command" and every sub-dispatcher. Returning non-zero WITHOUT re-throwing
  // keeps it out of cli.ts's top-level catch, so classifyOutcome buckets it as
  // user_error and the "MLA hit an internal error -> mla bug report" nudge (which
  // is for genuine faults on our side) never fires on an operator's typo.
  let fix = false;
  let json = false;
  try {
    ({ fix, json } = parseDoctorArgs(argv));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  // `--json` is a read-only emitter: a machine consumer never wants side effects,
  // so it forces the reconcile plan to plan-only regardless of --fix. It also owns
  // stdout exclusively (the single JSON line is the only thing printed), so every
  // human "Doctor:" / GREEN / RED / WSL-hint write below is gated on `!json`.
  const effectiveFix = json ? false : fix;

  const checks: Check[] = [];
  let cfg: ReturnType<typeof readConfig> | null = null;
  try {
    cfg = readConfig();
    checks.push({
      ok: true,
      label: "cli-config.json present",
      detail: cfg.controlUrl,
    });
    // §6.4: surface which credential path is active at a glance. Info-level (does
    // not fail the doctor): all three modes are valid states. NEVER prints a
    // token, only the mode and, for a user session, the display name + expiry.
    checks.push({
      ok: true,
      label: "auth.mode",
      detail: describeAuthMode(cfg.auth),
      level: "info",
    });
  } catch (e) {
    checks.push({
      ok: false,
      label: "cli-config.json present",
      detail: (e as Error).message,
    });
    if (json) {
      console.log(JSON.stringify(doctorJson(checks)));
    } else {
      console.log("Doctor:");
      for (const c of checks) console.log(fmt(c));
    }
    return 1;
  }

  // 1. control reachable
  const health = await ping(cfg, "/internal/v1/health");
  checks.push({
    id: "control.reachable",
    ok: health.ok,
    label: "control reachable (GET /internal/v1/health)",
    detail: health.ok ? cfg.controlUrl : health.error,
  });

  // Folder = workspace (T1.1): the workspace this directory is bound to comes
  // from the nearest `.meetless.json` marker, never cli-config. doctor is a
  // diagnostic that must run from any directory, so resolution is best-effort:
  // null means "this folder is not activated" and the workspace-scoped probes
  // (whoami, kb/health) report that instead of calling control with no id.
  const markerWorkspaceId = tryResolveWorkspaceId();
  if (markerWorkspaceId) {
    checks.push(
      ...ruleBundleDoctorChecks(
        readRuleBundleCache(resolveBundlePrincipal(markerWorkspaceId)),
      ),
    );
  }

  // 2. whoami
  //
  // KB curation (proposal v2.3 §9.3, T39) extends this in two ways:
  //
  //   - When cli-config carries `actorUserId`, pass it on the query so the
  //     control resolver verifies (workspaceId, actorUserId) is a member AND
  //     has role OWNER. Owner-only is the v1 ACL (proposal §9 footnote #13);
  //     no per-call --actor flag, no KB_CURATE scope yet.
  //   - When `actorUserId` is missing, doctor still calls whoami (legacy
  //     agent_review path stays green) but flags the missing field as RED so
  //     the operator sees the gap before they try to run `mla kb ...`.
  let whoami: any = null;
  const actorUserId = (cfg.actorUserId || "").trim();
  if (!actorUserId) {
    checks.push({
      ok: false,
      label: "cli-config.actorUserId present",
      detail:
        "missing. KB curation commands stamp this onto every outbox event. " +
        "Re-run `mla init --actor <id>` or edit cli-config.json directly.",
    });
  }
  if (health.ok && !markerWorkspaceId) {
    checks.push({
      ok: false,
      label: "workspace activated (.meetless.json)",
      detail:
        `no marker at or above ${process.cwd()}. whoami + KB probes need a ` +
        "workspace binding; run `mla activate` here.",
    });
  }
  if (health.ok && markerWorkspaceId) {
    try {
      const whoamiPath = actorUserId
        ? `/internal/v1/whoami?workspaceId=${encodeURIComponent(markerWorkspaceId)}&actorUserId=${encodeURIComponent(actorUserId)}`
        : `/internal/v1/whoami?workspaceId=${encodeURIComponent(markerWorkspaceId)}`;
      whoami = await get(cfg, whoamiPath, 6000);
      checks.push(workspaceBindingCheck(markerWorkspaceId, whoami));
      checks.push({
        id: "actor.member",
        ok: !!whoami?.actor,
        label: "actor resolves (workspace member)",
        detail: whoami?.actor?.displayName ?? whoami?.actor?.email,
      });
      // Owner-only ACL gate (§9.3). Fall back to actorIsMember when the
      // server is the pre-§9.3 build that does not emit actorIsOwner so the
      // doctor does not flap during the rollout.
      if (actorUserId) {
        const isOwner =
          typeof whoami?.actorIsOwner === "boolean"
            ? whoami.actorIsOwner
            : whoami?.actor?.role === "OWNER";
        checks.push({
          id: "actor.owner",
          ok: !!isOwner,
          label: "actor is workspace OWNER (KB curation §9.3)",
          detail: isOwner
            ? `role=${whoami?.actor?.role ?? "OWNER"}`
            : `role=${whoami?.actor?.role ?? "UNKNOWN"}; KB curation requires OWNER.`,
        });
      }
      checks.push({
        id: "casekind.seeded",
        ok: !!whoami?.caseKindAgentReviewSeeded,
        label: "CaseKind 'agent_review' seeded",
      });
    } catch (e) {
      const err = e as Error & { status?: number };
      checks.push({
        ok: false,
        label: "whoami (token + workspace + actor)",
        detail: `HTTP ${err.status ?? "?"}: ${err.message.slice(0, 120)}`,
      });
    }
  }

  // 3. intel reachable
  let intelReachable = false;
  if (cfg.intelUrl) {
    try {
      const res = await fetch(`${cfg.intelUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      intelReachable = res.ok;
      checks.push({
        ok: res.ok,
        label: "intel reachable (GET /health)",
        detail: cfg.intelUrl,
      });
    } catch (e) {
      checks.push({
        ok: false,
        label: "intel reachable (GET /health)",
        detail: (e as Error).message,
      });
    }
  }

  // 3b. KB substrate health probe (proposal v2.3 §9.3, T39).
  //
  // GET /internal/v1/kb/health?workspaceId=<ws> returns
  //   outboxConsumerLagSec (warn > 300s)
  //   hardDeletePendingMaxAgeSec (warn > 86400s)
  //   warnings: [...]
  //
  // Both surface as RED (not info) when the threshold trips: a lagging
  // outbox means `mla kb show` audit-trails miss recent events; a stuck
  // HARD_DELETE_PENDING doc means the phase-2 Weaviate-delete IntelJob is
  // wedged and the doc body is half-purged. The endpoint is rolling out
  // alongside the CLI; until the intel build with /kb/health lands, the
  // doctor logs an info row instead of failing.
  if (intelReachable && cfg.intelUrl && markerWorkspaceId) {
    try {
      const url = `${cfg.intelUrl}/internal/v1/kb/health?workspaceId=${encodeURIComponent(markerWorkspaceId)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${cfg.controlToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 404) {
        checks.push({
          ok: true,
          level: "info",
          label:
            "KB health probe: endpoint absent on this intel build (skipped)",
        });
      } else if (!res.ok) {
        checks.push({
          ok: false,
          label: "KB health probe (GET /internal/v1/kb/health)",
          detail: `HTTP ${res.status}`,
        });
      } else {
        const body: any = await res.json();
        const lag: number | null = body?.outboxConsumerLagSec ?? null;
        const pending: number = body?.hardDeletePendingCount ?? 0;
        const pendingAge: number | null =
          body?.hardDeletePendingMaxAgeSec ?? null;
        const warnings: string[] = Array.isArray(body?.warnings)
          ? body.warnings
          : [];
        const lagOk = !warnings.some((w) => w.includes("outbox consumer lag"));
        const pendingOk = !warnings.some((w) =>
          w.includes("HARD_DELETE_PENDING"),
        );
        checks.push({
          ok: lagOk,
          label: "KB outbox consumer lag (warn > 5min)",
          detail:
            lag === null
              ? "no unconsumed KB outbox rows"
              : `${lag}s lag, ${body?.outboxUnconsumedCount ?? 0} unconsumed`,
        });
        checks.push({
          ok: pendingOk,
          label: "HARD_DELETE_PENDING age (warn > 24h)",
          detail:
            pending === 0
              ? "0 docs pending"
              : `${pending} doc(s) pending, oldest ${pendingAge ?? "?"}s`,
        });
      }
    } catch (e) {
      checks.push({
        ok: false,
        label: "KB health probe (GET /internal/v1/kb/health)",
        detail: (e as Error).message,
      });
    }
  }

  // 4. hooks registered in ~/.claude/settings.json
  const settingsPath = path.join(userHomeDir(), ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const installedCmds = new Set<string>();
      for (const ev of Object.keys(s.hooks ?? {})) {
        for (const entry of s.hooks[ev] ?? []) {
          for (const h of entry.hooks ?? []) {
            if (h?.type === "command" && typeof h.command === "string")
              installedCmds.add(h.command);
          }
        }
      }
      for (const ev of REQUIRED_HOOK_EVENTS) {
        const present = (s.hooks?.[ev] ?? []).length > 0;
        checks.push({ ok: present, label: `hook event ${ev} registered` });
      }
      for (const ev of OPTIONAL_HOOK_EVENTS) {
        const present = (s.hooks?.[ev] ?? []).length > 0;
        checks.push({
          ok: true,
          label: `hook event ${ev}: ${present ? "ON" : "OFF (opt-out flag)"}`,
          level: "info",
        });
      }
      void installedCmds;
    } catch (e) {
      checks.push({
        ok: false,
        label: "~/.claude/settings.json parseable",
        detail: (e as Error).message,
      });
    }
  } else {
    checks.push({ ok: false, label: "~/.claude/settings.json present" });
  }

  // Codex is an optional connector, so absence is informational for operators
  // who only use Claude Code. When present, these rows make its two independent
  // halves visible: lifecycle hooks and the governed-retrieval MCP plugin.
  const liveCodexHooksPath = codexHooksPath();
  const liveCodexHooksInstalled = codexHooksInstalled({
    hooksPathOverride: liveCodexHooksPath,
  });
  const liveCodexMcpProbe = probeCodexMcp();
  checks.push(
    codexHookDoctorCheck(
      liveCodexHooksInstalled,
      liveCodexHooksPath,
    ),
  );
  checks.push(codexLifecycleCoverageCheck(liveCodexHooksInstalled));
  checks.push(codexMcpDoctorCheck(liveCodexMcpProbe));
  checks.push(
    codexConnectorCompleteCheck(liveCodexHooksInstalled, liveCodexMcpProbe),
  );

  // 5. /mla skill installed
  const skillPath = path.join(
    userHomeDir(),
    ".claude",
    "skills",
    "mla",
    "SKILL.md",
  );
  checks.push({
    ok: fs.existsSync(skillPath),
    label: "/mla skill installed",
    detail: skillPath,
  });

  // 5b. Meetless MCP server registered for Claude Code.
  //
  // `mla init`/`mla rewire` write a user-scope server into ~/.claude.json
  // (top-level mcpServers.meetless -> `mla mcp`, auto-loads with no approval
  // prompt, scopes per-repo via CLAUDE_PROJECT_DIR). Without it the
  // meetless__* tools never appear and the consult-governed-memory-first rule
  // is unenforceable: a silent, invisible failure, so it earns a doctor check.
  //
  // The dogfood setup instead pins a project-scope `.mcp.json` (often above the
  // git root, with a custom env block) -- a deliberate hand-rolled override, not
  // drift. So if the user-scope entry is absent we walk up from cwd looking for
  // a `.mcp.json` that registers the server before going RED, and only suggest
  // `mla rewire` when neither path has it.
  {
    const serverCommand = (obj: any): string | null => {
      const s = obj?.mcpServers?.[MCP_SERVER_KEY];
      return s && typeof s === "object" && typeof s.command === "string"
        ? s.command
        : null;
    };
    const hasServer = (obj: any): boolean => serverCommand(obj) !== null;
    const claudeJsonPath = path.join(userHomeDir(), ".claude.json");
    let userCommand: string | null = null;
    if (fs.existsSync(claudeJsonPath)) {
      try {
        userCommand = serverCommand(
          JSON.parse(fs.readFileSync(claudeJsonPath, "utf8")),
        );
      } catch {
        // unparseable ~/.claude.json: treat as not-registered; the wire step
        // reports the parse failure separately.
        userCommand = null;
      }
    }
    if (userCommand) {
      // Registered is NOT enough. Claude Code spawns `command` directly with no
      // PATH fallback, so a stale absolute path -- e.g. the `/snapshot/...`
      // pkg-VFS entry an older binary baked from process.argv[1] -- leaves the
      // meetless__* tools silently absent while a presence-only check stays
      // green. Verify the command actually resolves to an executable; a broken
      // one goes RED with a rewire hint (which now re-derives it from execPath).
      // A non-absolute command (bare `mla`) relies on PATH at spawn time and
      // can't be cheaply proven here, so it is left as present, not failed.
      if (mcpCommandExecutable(userCommand)) {
        checks.push({
          id: "mcp.registered",
          ok: true,
          label: "Meetless MCP server registered (user scope)",
          detail: claudeJsonPath,
        });
      } else {
        checks.push({
          id: "mcp.registered",
          ok: false,
          label: "Meetless MCP server command executable",
          detail: `${userCommand} is not executable (stale/moved binary); run \`mla rewire\` then restart Claude Code`,
        });
      }
    } else {
      // Walk up from cwd to the filesystem root, stopping if we pass home, and
      // look for a project-scope `.mcp.json` that registers the server.
      let projectMcp: string | null = null;
      let dir = process.cwd();
      const home = userHomeDir();
      for (;;) {
        const candidate = path.join(dir, ".mcp.json");
        if (fs.existsSync(candidate)) {
          try {
            if (hasServer(JSON.parse(fs.readFileSync(candidate, "utf8")))) {
              projectMcp = candidate;
              break;
            }
          } catch {
            // ignore an unparseable .mcp.json and keep walking up
          }
        }
        const parent = path.dirname(dir);
        if (parent === dir || dir === home) break;
        dir = parent;
      }
      if (projectMcp) {
        checks.push({
          id: "mcp.registered",
          ok: true,
          label: "Meetless MCP server registered (project scope)",
          detail: projectMcp,
          level: "info",
        });
      } else {
        checks.push({
          id: "mcp.registered",
          ok: false,
          label: "Meetless MCP server registered",
          detail: `not found in ${claudeJsonPath}; run \`mla wire\` then restart Claude Code`,
        });
      }
    }
  }

  // 5c. Plugin ownership + legacy wiring reconcile (design §6.7, §8).
  const ownership = detectPluginOwnership();
  checks.push(pluginStatusCheck(ownership));

  // legacyWiringPaths() is the SINGLE source of the four home-dir paths, shared with
  // both the inspector (reads all four surfaces) and the executor (targets the same
  // four), so the planner's inputs and applyLegacyReconcile's targets cannot drift.
  // inspectLegacyWiring returns the full 8-field LegacyWiringInspection the planner keys
  // on (hooksAny/hooksComplete/mcpAny/globalMcpPresent/skillsAny/skillsComplete/agentsAny/
  // agentsComplete).
  const paths = legacyWiringPaths();
  const reconcilePlan = planLegacyReconcile({
    ownership: ownership.status,
    inspection: inspectLegacyWiring(paths),
    mode: "repair", // doctor --fix MAY restore an existing degraded install (never create-from-zero)
  });
  checks.push(
    ...reconcileChecks(reconcilePlan, effectiveFix, defaultReconcileIO(paths)),
  );

  // 6. mlaPath resolves + executable
  let mlaExec = false;
  try {
    fs.accessSync(cfg.mlaPath, fs.constants.X_OK);
    mlaExec = true;
  } catch {
    mlaExec = false;
  }
  checks.push({
    ok: mlaExec,
    label: "mlaPath resolves + executable",
    detail: cfg.mlaPath,
  });

  // 6b. build freshness (stale-dist footgun).
  //
  // The mla binary runs from dist/cli.js. If a source change landed in src/
  // but `pnpm build` was not re-run, the binary silently executes stale
  // compiled code: the exact footgun behind "I changed it but mla still does
  // the old thing", which historically burned real debugging time because
  // `mla --version` reported a frozen string that never moved across builds.
  // doctor.js runs from dist/commands/, so dist/cli.js is one level up and src/
  // is two levels up. Compare the compiled cli.js mtime against the newest
  // src/*.ts mtime; RED when dist lags. Skipped (info) when src/ is absent (a
  // published install ships only dist/).
  {
    const distCli = path.join(__dirname, "..", "cli.js");
    const srcDir = path.join(__dirname, "..", "..", "src");
    if (!fs.existsSync(srcDir)) {
      checks.push({
        ok: true,
        level: "info",
        label: "build freshness: src/ absent (published install), not checked",
      });
    } else {
      let distMs = 0;
      try {
        distMs = fs.statSync(distCli).mtimeMs;
      } catch {
        distMs = 0;
      }
      const srcMs = newestTsMtimeMs(srcDir);
      const stale = distMs === 0 || srcMs > distMs;
      let freshDetail = distMs
        ? `built ${new Date(distMs).toISOString()}`
        : "dist/cli.js missing";
      try {
        const bi = JSON.parse(
          fs.readFileSync(
            path.join(__dirname, "..", "build-info.json"),
            "utf8",
          ),
        );
        freshDetail = `${bi.sha ?? "?"}${bi.dirty ? "-dirty" : ""}, built ${bi.builtAt ?? freshDetail}`;
      } catch {
        // no build-info.json (pre-stamp build): fall back to dist mtime detail
      }
      checks.push({
        ok: !stale,
        label: "build fresh (dist newer than src)",
        detail: stale
          ? `STALE; run \`pnpm build\` in meetless-cli/packages/cli (newest src ${new Date(srcMs).toISOString()} > dist ${distMs ? new Date(distMs).toISOString() : "missing"})`
          : freshDetail,
      });
    }
  }

  // 7a. hook lock primitive. common.sh locks via flock when present and falls
  // back to a portable mkdir(2) mutex when it is absent (Windows Git Bash ships
  // no flock, macOS ships none by default). So flock is an OPTIMIZATION, never a
  // requirement: present -> a passing check; absent -> an info line, not a RED
  // failure, because the mkdir fallback keeps passive capture working.
  let flockPath: string | null = null;
  try {
    flockPath =
      execSync("command -v flock", { encoding: "utf8" }).trim() || null;
  } catch {
    flockPath = null;
  }
  if (flockPath) {
    checks.push({
      ok: true,
      label: "hook lock primitive (flock on PATH)",
      detail: flockPath,
    });
  } else {
    checks.push({
      ok: true,
      level: "info",
      label: "hook lock primitive",
      detail:
        "flock not on PATH; hooks use the portable mkdir lock fallback (works without flock). Optional: `brew install flock` (macOS) / `apt-get install util-linux` (Linux) for a marginally faster lock.",
    });
  }

  // 7b. hook scripts present + executable. Resolve the live hooks dir from the
  // install surface (home-dir wiring OR the owned plugin's bundled hooks) so a
  // plugin user is not falsely reported unwired against ~/.meetless/hooks.
  const { dir: hooksDir, surface: hooksSurface } = resolveHooksDir(ownership);
  for (const f of REQUIRED_HOOKS) {
    const p = path.join(hooksDir, f);
    const ok = fs.existsSync(p);
    let exec = false;
    if (ok) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        exec = true;
      } catch {
        exec = false;
      }
    }
    checks.push({
      ok: ok && (f.endsWith(".sh") ? exec : true),
      label: `hook script ${f} installed (${hooksSurface})`,
      detail: p,
    });
  }
  for (const f of OPTIONAL_HOOKS) {
    const p = path.join(hooksDir, f);
    const present = fs.existsSync(p);
    checks.push({
      ok: true,
      label: `hook script ${f}: ${present ? "present" : "skipped (--no-post-tool-use)"}`,
      level: "info",
    });
  }

  // 7c. hook content-drift check (generic byte comparison vs shipped template).
  //
  // Compares every installed hook in ~/.meetless/hooks/ against the template
  // THIS binary would install (the exact bytes `mla rewire` copies). Any
  // difference means the operator upgraded the binary but never re-ran
  // `mla rewire`, so the live hooks lag the code.
  //
  // This REPLACES the old per-file marker-substring scan (Epoch 27/35), which
  // only covered flush.sh + session-start.sh and silently missed edits to
  // common.sh / user-prompt-submit.sh -- exactly the gap that let the
  // 2026-05-31 turn_index fix ship in the binary while the installed hooks
  // kept writing `turn_index: null` under a GREEN doctor. Byte comparison
  // covers all seven hook files for free and needs no per-edit maintenance.
  // Missing files are NOT drift: presence is reported by the per-hook checks
  // above, and a legit opt-out (post-tool-use.sh under --no-post-tool-use)
  // would otherwise false-positive.
  //
  // Skipped under plugin ownership: the plugin bundles its hooks and its `mla`
  // binary as one release and updates atomically via `claude plugin update`
  // (never `mla rewire`), so comparing the plugin's hooks against THIS binary's
  // template would false-positive whenever the running binary is a different
  // standalone install. Drift is only actionable for home-dir wiring, where the
  // binary and the installed hooks version independently.
  if (hooksDir !== HOOKS_DIR) {
    checks.push({
      ok: true,
      level: "info",
      label: `hook drift check skipped (hooks managed by ${hooksSurface}; update via \`claude plugin update\`)`,
    });
  } else {
    try {
      const drift = checkHookDrift({ hooksDir });
      const stale = drift.drifted;
      checks.push({
        ok: stale.length === 0,
        label:
          stale.length === 0
            ? "hook scripts match shipped templates"
            : `hook scripts stale: ${stale.join(", ")}`,
        detail:
          stale.length === 0
            ? undefined
            : "installed copy differs from this binary's template; run `mla wire` to refresh",
      });
      // A missing SUPPORT file (see isSupportHookFile) is a corrupt install, never an
      // opt-out. Doctor computed `missing` and dropped it on the floor, so on
      // 2026-07-13 it reported a green "hook scripts match shipped templates" on a box
      // whose common.sh sourced a home.sh that was not installed. A missing REGISTERED
      // script is left unflagged here: it is what `--no-post-tool-use` looks like, and
      // the hook-event checks above already cover whether the events an operator wants
      // are wired.
      const missingSupport = drift.missing.filter(isSupportHookFile);
      if (missingSupport.length > 0) {
        checks.push({
          ok: false,
          label: `hook support files missing: ${missingSupport.join(", ")}`,
          detail:
            "the installed hooks source these; the install is incomplete. run `mla wire` to repair",
        });
      }
      for (const e of drift.errors) {
        checks.push({
          ok: false,
          label: `hook drift check: ${e.file}`,
          detail: e.error,
        });
      }
    } catch (e) {
      // Template dir not found (published install lacking dist/hooks-template).
      // Not a failure of the operator's wiring; surface as info, not red.
      checks.push({
        ok: true,
        level: "info",
        label: `hook drift check skipped (template not found): ${(e as Error).message}`,
      });
    }
  }

  // 8. queue depth
  const qd = queueDepth();
  checks.push({
    ok: true,
    level: "info",
    label: `queue depth: ${qd.sessions} active sessions, ${qd.events} events, ${qd.orphans} orphan snapshots, oldest age ${qd.oldestAgeSec ?? "n/a"}s`,
  });

  // 8b. stale-session debt (read-only). queueDepth() counts every `.jsonl` and
  // draining snapshot as an "active session", but a session that drained its
  // events and never cleanly finalized leaves behind a 0-byte spool plus
  // `.lock`/`.turn`/`.repoPath`/`.gitBaseline` sidecars that NOTHING in the hook
  // pipeline ever removes, so "active sessions" inflates without bound (the
  // phantom count this surfaces). reapQueue({dryRun}) counts what `mla flush
  // --gc` WOULD remove without touching disk (doctor must never mutate). It
  // counts two safe-to-clear classes: empty dead litter idle > 24h, and stranded
  // sessions whose undelivered spool is idle > 7d (a no-workspace strand that can
  // never drain). The latter discards undeliverable events; we surface that count
  // explicitly so the operator sees exactly what `--gc` would drop.
  const debt = reapQueue({ dryRun: true });
  if (debt.reaped.length > 0) {
    const stranded = debt.strandedReaped.length;
    checks.push({
      ok: true,
      level: "info",
      label:
        `stale-session debt: ${debt.reaped.length} reapable session(s), ${debt.removedFiles} dead file(s). Run \`mla flush --gc\` to clear.` +
        (stranded > 0
          ? ` (${stranded} stranded > 7d will discard ${debt.discardedEvents} undeliverable event(s).)`
          : ""),
    });
  }

  // 9. per-folder activation (opt-in capture gate). Informational: a dormant
  // folder is a valid state, not a failure. Walk up from the cwd where the
  // operator invoked `mla doctor` (the same walk the bash gate does from a
  // hook's $PWD). When found, surface the marker path and the resolved
  // workspace so the operator can confirm THIS folder will actually capture.
  const activation = findActivation(process.cwd());
  if (activation) {
    // Folder = workspace (T1.1): the marker IS the source of the workspace for
    // both capture and the CLI. A marker with no usable workspaceId is a stale
    // binding the operator must repair with `mla activate`.
    const wsDetail = activation.workspaceId
      ? `workspace ${activation.workspaceId}` +
        (activation.workspaceName ? ` (${activation.workspaceName})` : "")
      : "marker present but workspaceId missing; re-run `mla activate` to repair";
    checks.push({
      ok: !!activation.workspaceId,
      level: activation.workspaceId ? "info" : undefined,
      label: `folder activated: ${activation.path} -> ${wsDetail}`,
    });
    if (activation.parseError) {
      checks.push({
        ok: false,
        label: `  marker JSON unparseable (${activation.parseError.slice(0, 80)}); re-run \`mla activate\` to repair the binding`,
      });
    }
  } else {
    checks.push({
      ok: true,
      level: "info",
      label: `folder NOT activated (no .meetless.json at or above ${process.cwd()}). Run \`mla activate\` here to capture sessions.`,
    });
  }

  // 10. session capture (mute / unmute). Reported DISTINCTLY from the
  // workspace-binding lifecycle above: activation is about the folder, capture
  // is about THIS session. A folder can be activated while this session is muted.
  checks.push(
    sessionCaptureCheck(process.env.CLAUDE_CODE_SESSION_ID, SESSION_GATE_DIR),
  );

  // 11. CE0 interception store posture + the three deny-enablement gates (R1 deny-admission
  // preconditions, §10.1 step 1(d)).
  //
  // The store posture gates the notes-location deny pilot: the local interception schema is at the
  // version this binary expects, and the CE0 store is in WAL with foreign keys enforced (so a
  // PreToolUse read never blocks on a writer and an evaluation row can never orphan its attempt or
  // rule version). On top of posture, the three deny-enablement gates report whether a would-be deny
  // is admissible right now: P0.58 (MLA is the sole effective PreToolUse Write/Edit authority), P0.63
  // (the active scope's attested forbidden root resolves), and P0.60 (denies are honestly accounted,
  // none stuck recorded-but-unemitted). The store is created on the first intercepted tool call, so
  // its absence is informational, not red; P0.58 always runs because admissibility never depends on
  // any row existing yet, while P0.63/P0.60 read the store and so run only once it exists.
  {
    const ce0Path = defaultCe0StorePath();
    if (fs.existsSync(ce0Path)) {
      let ce0: Ce0Store | undefined;
      try {
        ce0 = openCe0Store(ce0Path);

        // P0.15: a deliberate full-database integrity scan FIRST. If the local SQLite authority is
        // corrupt the PreToolUse hook silently fails open, so doctor must surface that RED before
        // reading anything else; the version/wal/fk/accounting/path-root reads below are meaningless
        // on an unsound store, so they only run once integrity holds.
        const integrity = ce0IntegrityCheck(ce0QuickCheckResult(ce0));
        checks.push({ ...integrity, id: "ce0.integrity" });
        if (integrity.ok) {
          const version = ce0.db.pragma("user_version", {
            simple: true,
          }) as number;
          const journalMode = ce0.db.pragma("journal_mode", {
            simple: true,
          }) as string;
          const foreignKeys = ce0.db.pragma("foreign_keys", {
            simple: true,
          }) as number;
          const busyTimeout = ce0.db.pragma("busy_timeout", {
            simple: true,
          }) as number;
          checks.push(
            schemaVersionCheck(version, CE0_INTERCEPTION_SCHEMA_VERSION),
          );
          checks.push(walModeCheck(journalMode));
          checks.push(foreignKeysCheck(foreignKeys));
          checks.push(busyTimeoutCheck(busyTimeout));

          // P0.60: honest deny-emission accounting (never RED, just surfaces the count).
          checks.push(
            denyEmissionAccountingCheck(
              countDenyDecisionsAwaitingEmission(ce0),
            ),
          );

          // Historical fail-open visibility: any DENY-ceiling violation that ever passed un-governed
          // (RULE_ENFORCEMENT_UNAVAILABLE, decision 5). Info, not RED: the append-only ledger must not
          // pin doctor RED forever, so the count itself is the loud alert deny-admission.ts promises.
          checks.push(
            failOpenEnforcementCheck(countFailOpenEnforcementViolations(ce0)),
          );

          // P0.63: the attested forbidden root resolves for the active scope. Mirror the enforce seam:
          // read the active scope's LIVE notes-location version, and if one is attested, resolve its
          // forbidden root against the active runtime root exactly as the seam would at a would-be deny.
          // With no LIVE version the path-root gate is simply inactive (informational, not red).
          const runtimeRoot = resolveActiveRuntimeScopeId();
          const liveVersion = getLiveLocalRuleVersion(
            ce0,
            runtimeRoot,
            NOTES_LOCATION_RULE_ID,
          );
          if (liveVersion) {
            const payload = JSON.parse(
              liveVersion.rulePayload,
            ) as RulePayloadV1;
            const config = payload.compliance.config;
            if ("forbiddenRootRelativePath" in config) {
              checks.push(
                attestedPathRootCheck(
                  resolveAttestedPathRoot({
                    configuredRelativeForbiddenPath:
                      config.forbiddenRootRelativePath,
                    activeRuntimeProjectRoot: runtimeRoot,
                  }),
                ),
              );
            } else {
              checks.push({
                ok: true,
                level: "info",
                label: `notes vault rule uses ${config.allowedRootAbsolutePath}`,
              });
            }
          } else {
            checks.push({
              ok: true,
              level: "info",
              label: `no LIVE notes-location rule attested in this scope (${runtimeRoot}); path-root gate inactive`,
            });
          }
        }
      } catch (e) {
        checks.push({
          ok: false,
          label: "CE0 interception store posture",
          detail: (e as Error).message,
        });
      } finally {
        if (ce0) closeCe0Store(ce0);
      }
    } else {
      checks.push({
        ok: true,
        level: "info",
        label: `CE0 interception store not yet created (${ce0Path}); posture checks run after the first intercepted tool call`,
      });
    }
    checks.push(managedPreToolUseHookCheck(resolveLiveInputAuthority()));
  }

  const code = doctorExitCode(checks);

  // `--json`: emit the machine payload as the sole stdout line and return the
  // same exit code the human path would. No "Doctor:" table, no GREEN/RED tail,
  // no WSL hint (all human-only). The roll-up in doctorJson mirrors `code`.
  if (json) {
    console.log(JSON.stringify(doctorJson(checks)));
    return code;
  }

  console.log("Doctor:");
  for (const c of checks) console.log(fmt(c));

  // Cross-boundary invocation nudge for a Windows-side agent driving mla under
  // WSL. Gated to non-interactive runs (see shouldSurfaceWslHint) so an
  // interactive WSL human's report stays clean. Prints on both GREEN and RED: the
  // wiring can be perfect and the caller still invoke mla the wrong way.
  if (shouldSurfaceWslHint(detectWslUnderWindows(), Boolean(process.stdout.isTTY)))
    console.log(WSL_MLA_HINT);

  if (code !== 0) {
    console.error("\nDoctor RED. Fix the failing rows before dogfooding.");
    return code;
  }
  console.log("\nDoctor GREEN.");
  return 0;
}
