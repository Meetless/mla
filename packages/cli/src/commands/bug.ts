import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as readline from "readline";

import { HOME, getConsoleUrl, loadWorkspaceConfig } from "../lib/config";
import type { WorkspaceCliConfig } from "../lib/config";
import { get, post } from "../lib/http";
import {
  canonicalizeSessionId,
  getRunSessionId,
  getRunTraceId,
  isCanonicalTraceId,
  loadBuildInfo,
} from "../lib/observability";
import { buildDiagnosticBundle } from "../lib/diagnostic-bundle";
import type {
  BuiltDiagnosticBundle,
  DiagnosticSelector,
} from "../lib/diagnostic-bundle";

// `mla bug report | list | status` (notes/20260705-mla-bug-report-command-proposal.md §3.5).
//
// The prominent way for an operator to file a PRIVATE, REDACTED diagnostic bug
// report to Meetless and track it to resolution. The heavy lifting — building a
// safe, allowlist-first bundle — lives in lib/diagnostic-bundle.ts; the state
// machine, storage, and audit trail live in control. This file is the IO + argv
// shell: resolve the diagnostic target, build the bundle into a private temp
// zip, PREVIEW it, get an interactive y/N confirm, then run the reordered
// signed-URL upload flow (§3.4): mint a write URL -> PUT the zip straight to GCS
// -> ask control to create the row (create verifies the object and reads its
// true size). The temp zip is deleted on every path.
//
// Identity is never sent from here: the workspace id rides as the guard's tenant
// marker and the reporter is the token-derived actor server-side (INV-AUTH). A
// forged workspaceId/reporterId in the body is ignored.

// Content bounds, mirrored from control's CreateBugReportDto so a too-long
// title/message is a clean local error instead of a server 400. Kept as local
// literals (the CLI and control are separate packages; there is no shared
// constant to import).
const BUG_TITLE_MAX = 200;
const BUG_MESSAGE_MAX = 5000;

interface ReportFlags {
  traceId?: string;
  session?: string;
  last: boolean;
  title?: string;
  message?: string;
  messageFile?: string;
  /** Skip the interactive y/N confirm and send. Required non-interactively. */
  yes: boolean;
  /**
   * `--workspace <id>` admin escape hatch (BUG-2 I). By default the report is
   * filed against the workspace bound to the current directory's .meetless.json
   * marker. When the operator runs from an unbound directory, or belongs to a
   * DIFFERENT workspace than the marker points at, this overrides marker
   * resolution so `mla bug report` never dead-ends on "not activated" / a 403.
   */
  workspace?: string;
}

// Wire shapes (control/apps/control/src/bug-report). Dates serialize to ISO
// strings across the wire, hence `string` for the timestamps.
interface BundleUploadUrl {
  objectKey: string;
  uploadUrl: string;
}

interface ReporterView {
  id: string;
  ref: number;
  handle: string;
  status: string;
  title: string;
  message: string;
  traceId: string | null;
  sessionId: string | null;
  mlaVersion: string | null;
  platform: string | null;
  bundleBytes: number;
  resolutionMessage: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunBugDeps {
  home?: string;
  nowMs?: () => number;
  bundleId?: () => string;
  confirm?: (prompt: string) => Promise<boolean>;
  isTTY?: boolean;
  fetchImpl?: typeof fetch;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// BUG-2 I: the marker-model workspace guard (control) answers a non-member with
// a 403 whose body carries code WORKSPACE_ACCESS_DENIED. buildError (lib/http.ts)
// puts the status on `.status` and inlines the body into the message, so a
// substring match on the code is stable across get/post/patch.
export function isWorkspaceAccessDenied(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  const msg = e instanceof Error ? e.message : String(e);
  return status === 403 && msg.includes("WORKSPACE_ACCESS_DENIED");
}

// Turn a WORKSPACE_ACCESS_DENIED 403 into actionable guidance instead of the raw
// `POST ... -> HTTP 403: {...}` wire error. We deliberately do NOT silently
// redirect to some "home" workspace (there is no server support for resolving
// one, and a silent tenant switch would file the report against the wrong
// workspace); the operator must name a workspace they belong to.
export function workspaceAccessDeniedGuidance(
  workspaceId: string,
  usedOverride: boolean,
): string {
  const head = `You are not a member of workspace '${workspaceId}', so this bug report was not filed.`;
  const fix = usedOverride
    ? `Pass --workspace <id> for a workspace you belong to, or ask an admin to add you to '${workspaceId}'.`
    : `This directory is bound to that workspace by its .meetless.json marker. ` +
      `Ask a workspace admin to add you, or file against a workspace you belong to:\n` +
      `  mla bug report --workspace <id> --message "..."`;
  return `${head}\n${fix}`;
}

// A value-bearing flag must be followed by a real value, never the next flag,
// or an operator's "drop the value" typo silently changes intent.
function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  if (v.startsWith("-")) {
    throw new Error(`Missing value for ${flag} (got the next flag ${v} instead)`);
  }
  return v;
}

const KNOWN_REPORT_FLAGS = new Set([
  "--trace-id",
  "--session",
  "--last",
  "--title",
  "--message",
  "--message-file",
  "--yes",
  "-y",
  "--workspace",
  "-w",
]);

export function parseReportArgs(argv: string[]): ReportFlags {
  const out: ReportFlags = { last: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--trace-id":
        out.traceId = takeValue(argv, i, a);
        i += 1;
        break;
      case "--session":
        out.session = takeValue(argv, i, a);
        i += 1;
        break;
      case "--last":
        out.last = true;
        break;
      case "--title":
        out.title = takeValue(argv, i, a);
        i += 1;
        break;
      case "--message":
        out.message = takeValue(argv, i, a);
        i += 1;
        break;
      case "--message-file":
        out.messageFile = takeValue(argv, i, a);
        i += 1;
        break;
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--workspace":
      case "-w":
        out.workspace = takeValue(argv, i, a);
        i += 1;
        break;
      default:
        if (a.startsWith("-") && !KNOWN_REPORT_FLAGS.has(a)) {
          throw new Error(
            `Unknown flag: ${a}. Supported: ${[...KNOWN_REPORT_FLAGS].join(", ")}`,
          );
        }
        throw new Error(`Unexpected argument: ${a}`);
    }
  }
  if (out.traceId && out.session) {
    throw new Error("Pass only one of --trace-id or --session.");
  }
  if (out.message !== undefined && out.messageFile !== undefined) {
    throw new Error("Pass only one of --message or --message-file.");
  }
  return out;
}

// Resolve which events the bundle scopes to. An explicit --trace-id/--session
// wins; otherwise (--last or nothing) fall back to the current run's session,
// then this run's trace id. At least one selector is always non-null.
function resolveSelector(flags: ReportFlags): DiagnosticSelector {
  if (flags.traceId) {
    if (!isCanonicalTraceId(flags.traceId)) {
      throw new Error(
        `Invalid --trace-id "${flags.traceId}": expected 32 lowercase hex chars ` +
          `(the id mla prints in its failure footer / run deep-link).`,
      );
    }
    return { traceId: flags.traceId, sessionId: null };
  }
  if (flags.session) {
    const canon = canonicalizeSessionId(flags.session);
    if (!canon) {
      throw new Error(`Invalid --session "${flags.session}".`);
    }
    return { traceId: null, sessionId: canon };
  }
  const sessionId = getRunSessionId();
  if (sessionId) return { traceId: null, sessionId };
  const traceId = getRunTraceId();
  if (traceId) return { traceId, sessionId: null };
  throw new Error(
    "No diagnostic target available. Pass --trace-id <id> or --session <sid> " +
      "(the trace id is in mla's failure footer).",
  );
}

async function promptLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await new Promise<string>((resolve) => rl.question(prompt, resolve));
  } finally {
    rl.close();
  }
}

async function confirmInteractive(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer: string = await new Promise((resolve) =>
      rl.question(prompt, resolve),
    );
    const norm = answer.trim().toLowerCase();
    return norm === "y" || norm === "yes";
  } finally {
    rl.close();
  }
}

// Resolve the human-facing title + message. Both are required non-empty by
// control; message comes from --message / --message-file, or an interactive
// prompt when a TTY (never prompted non-interactively, so a piped confirm answer
// is never mistaken for the message). Title defaults to the message's first line.
async function resolveContent(
  flags: ReportFlags,
  isTTY: boolean,
): Promise<{ title: string; message: string }> {
  let message: string;
  if (flags.messageFile !== undefined) {
    message = fs.readFileSync(flags.messageFile, "utf8");
  } else if (flags.message !== undefined) {
    message = flags.message;
  } else if (isTTY) {
    message = await promptLine("Describe what went wrong: ");
  } else {
    throw new Error(
      "Provide a description with --message <text> or --message-file <path> " +
        "(or run in an interactive terminal).",
    );
  }
  message = message.trim();
  if (!message) {
    throw new Error("Bug report message cannot be empty.");
  }
  if (message.length > BUG_MESSAGE_MAX) {
    throw new Error(`Message is too long (max ${BUG_MESSAGE_MAX} characters).`);
  }

  let title = flags.title?.trim();
  if (!title) {
    const firstLine = message.split(/\r?\n/, 1)[0].trim();
    title = firstLine ? firstLine.slice(0, BUG_TITLE_MAX) : "mla diagnostic report";
  } else if (title.length > BUG_TITLE_MAX) {
    throw new Error(`Title is too long (max ${BUG_TITLE_MAX} characters).`);
  }

  return { title, message };
}

function redactionCounts(built: BuiltDiagnosticBundle): {
  known_pattern_matches_removed: number;
  fields_dropped_by_allowlist: number;
  enum_values_coerced_to_other: number;
} {
  const c = built.redactionReport.counts as {
    known_pattern_matches_removed?: number;
    fields_dropped_by_allowlist?: number;
    enum_values_coerced_to_other?: number;
  };
  return {
    known_pattern_matches_removed: c.known_pattern_matches_removed ?? 0,
    fields_dropped_by_allowlist: c.fields_dropped_by_allowlist ?? 0,
    enum_values_coerced_to_other: c.enum_values_coerced_to_other ?? 0,
  };
}

function printPreview(
  cfg: WorkspaceCliConfig,
  selector: DiagnosticSelector,
  built: BuiltDiagnosticBundle,
  tmpPath: string,
  title: string,
  message: string,
): void {
  const c = redactionCounts(built);
  const target = selector.traceId
    ? `trace ${selector.traceId}`
    : selector.sessionId
      ? `session ${selector.sessionId}`
      : "current run";
  // The preview + prompt are interactive context, so they go to stderr; the
  // final "Filed BUG-xxx" result goes to stdout so a script can capture it.
  console.error("");
  console.error("Diagnostic bug report");
  console.error(`  Target:      ${target}`);
  console.error(
    `  Contents:    ${built.traceEventCount} trace event(s), ${built.errorCount} error(s)`,
  );
  console.error(
    `  Redaction:   ${c.known_pattern_matches_removed} secret pattern(s) removed, ` +
      `${c.fields_dropped_by_allowlist} field(s) dropped, ` +
      `${c.enum_values_coerced_to_other} value(s) coerced`,
  );
  console.error(`  Bundle:      ${tmpPath} (${built.zip.length} bytes)`);
  console.error(`  Title:       ${title}`);
  console.error(`  Message:     ${message}`);
  console.error(
    `  Destination: ${cfg.controlUrl} (workspace ${cfg.workspaceId})`,
  );
  console.error("");
  console.error("Meetless support staff will review this to debug it.");
  console.error("");
}

async function runReport(rest: string[], deps: RunBugDeps): Promise<number> {
  let flags: ReportFlags;
  try {
    flags = parseReportArgs(rest);
  } catch (e) {
    console.error(errText(e));
    return 2;
  }

  let selector: DiagnosticSelector;
  try {
    selector = resolveSelector(flags);
  } catch (e) {
    console.error(errText(e));
    return 2;
  }

  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const autoYes = flags.yes;
  // Non-interactive safety: confirmInteractive() calls readline.question, which
  // NEVER resolves on a non-TTY stdin (nothing feeds it a newline) -- the process
  // would hang, then exit without ever sending. So a non-interactive caller (a
  // pipe, CI, a coding agent) MUST pass --yes to confirm. A test-injected
  // deps.confirm resolves synchronously and never hangs, so it is exempt. This
  // mirrors resolveContent's non-TTY --message requirement: explicit intent, or a
  // real terminal.
  if (!autoYes && !isTTY && !deps.confirm) {
    console.error(
      "Non-interactive terminal: pass --yes to confirm sending this report " +
        "(or run in an interactive terminal). Nothing was sent.",
    );
    return 2;
  }
  const confirm = deps.confirm ?? confirmInteractive;

  let title: string;
  let message: string;
  try {
    ({ title, message } = await resolveContent(flags, isTTY));
  } catch (e) {
    console.error(errText(e));
    return 2;
  }

  let cfg: WorkspaceCliConfig;
  try {
    cfg = loadWorkspaceConfig(flags.workspace);
  } catch (e) {
    console.error(errText(e));
    return 2;
  }

  const home = deps.home ?? HOME;
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  const bundleId = (deps.bundleId ?? (() => crypto.randomUUID()))();
  const build = loadBuildInfo();
  const fetchImpl = deps.fetchImpl ?? fetch;

  const tmpPath = path.join(
    os.tmpdir(),
    `mla-bug-${crypto.randomUUID()}.zip`,
  );
  try {
    const built = buildDiagnosticBundle({
      home,
      selector,
      createdAt: new Date(nowMs).toISOString(),
      bundleId,
      mlaVersion: build.version,
      now: nowMs,
    });
    // 0600: the temp bundle is private to the user until they choose to send it.
    fs.writeFileSync(tmpPath, built.zip, { mode: 0o600 });

    printPreview(cfg, selector, built, tmpPath, title, message);

    // --yes (or a non-interactive caller that already passed the guard above)
    // sends without prompting; the preview still printed, so intent is on record.
    const ok = autoYes
      ? true
      : await confirm("Send this diagnostic report to Meetless? [y/N] ");
    if (!ok) {
      console.error("Aborted. Nothing was sent.");
      return 1;
    }

    // Reordered signed-URL flow (§3.4): mint URL -> PUT zip to GCS -> create row.
    const upload = await post<BundleUploadUrl>(
      cfg,
      "/internal/v1/bug-reports/upload-url",
      { workspaceId: cfg.workspaceId },
    );

    // The GCS PUT is a direct object write, NOT a control call, so it uses raw
    // fetch (never the http.ts helpers, which target controlUrl). The headers
    // must match exactly what the v4 signed URL was minted with.
    const putRes = await fetchImpl(upload.uploadUrl, {
      method: "PUT",
      body: built.zip,
      headers: {
        "Content-Type": "application/zip",
        "x-goog-if-generation-match": "0",
      },
    });
    if (!putRes.ok) {
      let detail = "";
      try {
        detail = (await putRes.text()).slice(0, 300);
      } catch {
        // best effort
      }
      throw new Error(
        `Bundle upload failed (HTTP ${putRes.status}).${detail ? ` ${detail}` : ""}`,
      );
    }

    const report = await post<ReporterView>(cfg, "/internal/v1/bug-reports", {
      workspaceId: cfg.workspaceId,
      title,
      message,
      objectKey: upload.objectKey,
      traceId: selector.traceId ?? undefined,
      sessionId: selector.sessionId ?? undefined,
      mlaVersion: build.version,
      platform: `${os.platform()}-${os.arch()}`,
      redactionSummary: redactionCounts(built),
    });

    console.log(
      `Filed ${report.handle}. Track it: mla bug status ${report.handle}`,
    );
    console.log(`  ${getConsoleUrl(cfg)}/bug-reports/${report.handle}`);
    return 0;
  } catch (e) {
    // A failed submission is a normal, expected error (network, rate limit,
    // rejected bundle); it must NOT trip the top-level "file a bug report"
    // footer. Print a clean message and exit non-zero via return (not throw).
    if (isWorkspaceAccessDenied(e)) {
      console.error(workspaceAccessDeniedGuidance(cfg.workspaceId, Boolean(flags.workspace)));
    } else {
      console.error(errText(e));
    }
    return 1;
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best effort: a leftover temp zip is harmless
    }
  }
}

// Pull a `--workspace <id>` / `-w <id>` admin override out of an otherwise
// positional argv (BUG-2 I). list/status take no value flags of their own, so a
// tiny extractor keeps their strict "unexpected argument" checks intact while
// still honoring the escape hatch. Returns the override (if any) and the argv
// with it removed; throws on a missing value so a "-w" typo never silently drops.
export function extractWorkspaceOverride(rest: string[]): { workspace?: string; rest: string[] } {
  const out: string[] = [];
  let workspace: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--workspace" || a === "-w") {
      workspace = takeValue(rest, i, a);
      i += 1;
      continue;
    }
    out.push(a);
  }
  return { workspace, rest: out };
}

async function runList(rest: string[]): Promise<number> {
  let workspace: string | undefined;
  try {
    ({ workspace, rest } = extractWorkspaceOverride(rest));
  } catch (e) {
    console.error(errText(e));
    return 2;
  }
  if (rest.length) {
    console.error(`Unexpected argument: ${rest[0]}. Usage: mla bug list [--workspace <id>]`);
    return 2;
  }
  let cfg: WorkspaceCliConfig;
  try {
    cfg = loadWorkspaceConfig(workspace);
  } catch (e) {
    console.error(errText(e));
    return 2;
  }
  let reports: ReporterView[];
  try {
    reports = await get<ReporterView[]>(
      cfg,
      `/internal/v1/bug-reports?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
    );
  } catch (e) {
    if (isWorkspaceAccessDenied(e)) {
      console.error(workspaceAccessDeniedGuidance(cfg.workspaceId, Boolean(workspace)));
      return 1;
    }
    throw e;
  }
  if (!reports.length) {
    console.log('No bug reports filed yet. File one with: mla bug report --message "..."');
    return 0;
  }
  for (const r of reports) {
    const when = String(r.createdAt).slice(0, 10);
    console.log(`${r.handle.padEnd(9)} ${r.status.padEnd(12)} ${when}  ${r.title}`);
  }
  return 0;
}

async function runStatus(rest: string[]): Promise<number> {
  let workspace: string | undefined;
  try {
    ({ workspace, rest } = extractWorkspaceOverride(rest));
  } catch (e) {
    console.error(errText(e));
    return 2;
  }
  const ref = rest[0];
  if (!ref) {
    console.error("Usage: mla bug status <BUG-ref> [--workspace <id>]");
    return 2;
  }
  if (rest.length > 1) {
    console.error(`Unexpected argument: ${rest[1]}. Usage: mla bug status <BUG-ref> [--workspace <id>]`);
    return 2;
  }
  let cfg: WorkspaceCliConfig;
  try {
    cfg = loadWorkspaceConfig(workspace);
  } catch (e) {
    console.error(errText(e));
    return 2;
  }
  let r: ReporterView;
  try {
    r = await get<ReporterView>(
      cfg,
      `/internal/v1/bug-reports/${encodeURIComponent(ref)}?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
    );
  } catch (e) {
    if (isWorkspaceAccessDenied(e)) {
      console.error(workspaceAccessDeniedGuidance(cfg.workspaceId, Boolean(workspace)));
      return 1;
    }
    throw e;
  }
  console.log(`${r.handle}  ${r.status}`);
  console.log(`  Title:      ${r.title}`);
  console.log(`  Filed:      ${r.createdAt}`);
  if (r.traceId) console.log(`  Trace:      ${r.traceId}`);
  if (r.sessionId) console.log(`  Session:    ${r.sessionId}`);
  if (r.mlaVersion) console.log(`  mla:        ${r.mlaVersion}`);
  console.log(`  Bundle:     ${r.bundleBytes} bytes`);
  if (r.resolvedAt) console.log(`  Resolved:   ${r.resolvedAt}`);
  if (r.resolutionMessage) console.log(`  Resolution: ${r.resolutionMessage}`);
  return 0;
}

export async function runBug(
  argv: string[],
  deps: RunBugDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "report":
      return runReport(rest, deps);
    case "list":
      return runList(rest);
    case "status":
      return runStatus(rest);
    default:
      console.error(
        `Unknown bug subcommand: ${sub ?? "(none)"}. Usage:\n` +
          "  mla bug report [--trace-id <id> | --session <sid> | --last]\n" +
          "                 [--title <t>] [--message <m> | --message-file <f>] [--yes]\n" +
          "                 [--workspace <id>]\n" +
          "  mla bug list [--workspace <id>]\n" +
          "  mla bug status <BUG-ref> [--workspace <id>]",
      );
      return 2;
  }
}
