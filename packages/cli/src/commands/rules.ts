import { execFileSync } from "node:child_process";
import * as fs from "fs";
import * as path from "path";

import { MANAGED_RULES_PATH, parseManagedRules } from "../lib/scanner/managed-rules";
import { loadWorkspaceConfig, type WorkspaceCliConfig } from "../lib/config";
import { post } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import { openCe0Store, closeCe0Store, type Ce0Store } from "../lib/rules/ce0-store";
import {
  listAllLocalRuleVersionsInScope,
  listLiveLocalRuleVersions,
  type LocalRuleVersionRecord,
} from "../lib/rules/local-rule-version-repo";
import {
  importRules,
  type ImportRuleInput,
  type ImportRulesBody,
  type ImportRulesResult,
} from "../lib/rules/control-rule-client";
import {
  ce0VersionsToImportRules,
  managedRulesToImportRules,
} from "../lib/rules/rule-import-mapping";
import { summarizeRuleActivity, type RuleActivitySummary } from "../lib/rules/rule-activity";
import { resolveActiveRuntimeScopeId } from "../lib/rules/runtime-scope";
import { defaultCe0StorePath } from "./evidence";

export interface RulesDeps {
  /** The working directory the active runtime scope is derived from (defaults to process.cwd()). */
  cwd?: string;
  /** Resolve the active runtime scope id (seam for tests; defaults to the realpath repo-root walk). */
  resolveRuntimeScopeId?: (cwd?: string) => string;
  /** Resolve the repo root that owns .meetless/rules.md (seam for tests; defaults to the git toplevel). */
  resolveRoot?: (cwd: string) => string;
  /** Where the CE0 / interception SQLite store lives (defaults to the Meetless home). */
  storePath?: string;
  /** Open the store at a path (seam for tests; defaults to the real opener). */
  openStore?: (dbPath: string) => Ce0Store;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// mla rules activity: the R2-LOCAL accountability projection (proposal §2.6 / §3.7 "still local")
// ---------------------------------------------------------------------------

/**
 * `mla rules activity [--json]`: the §2.6 "observed N, violated M" measurement per LIVE rule in the
 * active scope. This is the SHIPPABLE half of R2: the terminal-outcome half (project a COMMITTED
 * violation, ie "the action the deny named actually happened") is BLOCKED BY DESIGN because the supported
 * PreToolUse payload carries no tool_use_id and heuristic post correlation is forbidden (§9.10, §2.6).
 * The measurement that licenses promoting a rule out of DRY_RUN needs no correlation: it is a pure
 * projection of the records MLA already owns at evaluation time (tool_attempt + rule_evaluation_record),
 * so this command reads them with one local query and never calls the backend or crosses scope. A thin IO
 * shell over summarizeRuleActivity; the runtime-scope resolver and the store path are injectable.
 */
export async function runRulesActivity(argv: string[], deps: RulesDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const json = argv.includes("--json");

  const resolveScope = deps.resolveRuntimeScopeId ?? resolveActiveRuntimeScopeId;
  const runtimeScopeId = resolveScope(deps.cwd);

  const dbPath = deps.storePath ?? defaultCe0StorePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const open = deps.openStore ?? openCe0Store;
  const store = open(dbPath);
  try {
    const rules = summarizeRuleActivity(store, runtimeScopeId);
    out(json ? JSON.stringify({ runtimeScopeId, rules }) : formatActivityText(runtimeScopeId, rules));
    return 0;
  } finally {
    closeCe0Store(store);
  }
}

/** Render the per-rule measurement as a compact, stable text block (one record per LIVE rule). */
function formatActivityText(runtimeScopeId: string, rules: RuleActivitySummary[]): string {
  const lines: string[] = [`runtime scope: ${runtimeScopeId}`];
  if (rules.length === 0) {
    lines.push("no LIVE rules attested in this scope");
    return lines.join("\n");
  }
  lines.push(`${rules.length} LIVE rule(s)`, "");
  for (const r of rules) {
    lines.push(`${r.ruleId} (${r.versionId})`);
    lines.push(
      `  observed ${r.observed}, compliant ${r.compliant}, ` +
        `violation ${r.violation}, denied ${r.deniedEmitted}, ` +
        `enforcement-unavailable ${r.enforcementUnavailable}`,
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// mla rules publish [--json]  (the CLI -> control bridge into the console Rules surface)
// ---------------------------------------------------------------------------

/** One LIVE rule projected to control; mirrors PublishRuleItemDto on the control side. */
interface PublishRuleItem {
  ruleId: string;
  versionId: string;
  text: string;
  payloadHash: string;
  lifecycleStatus: string;
  attestedBy: string | null;
  attestedAt: string | null;
  attestationMethod: string | null;
}

/** The publish batch: the current LIVE set for THIS scope; an empty `rules` still reconciles. */
interface PublishRulesBody {
  workspaceId: string;
  runtimeScopeId: string;
  rules: PublishRuleItem[];
}

/** Control's response; mirrors PublishRulesResult on the service side. */
interface PublishRulesResult {
  published: number;
  retired: number;
  items: Array<{ ruleId: string; candidateId: string; action: "published" | "retired" }>;
}

export interface RulesPublishDeps {
  /** The working directory the active runtime scope is derived from (defaults to process.cwd()). */
  cwd?: string;
  /** Resolve the active runtime scope id (seam for tests; defaults to the realpath repo-root walk). */
  resolveRuntimeScopeId?: (cwd?: string) => string;
  /** Where the CE0 / interception SQLite store lives (defaults to the Meetless home). */
  storePath?: string;
  /** Open the store at a path (seam for tests; defaults to the real opener). */
  openStore?: (dbPath: string) => Ce0Store;
  /** Load the workspace-scoped config (seam for tests; throws when no workspace marker is bound). */
  loadConfig?: () => WorkspaceCliConfig;
  /** POST the publish batch to control (seam for tests; defaults to the authed http post). */
  publish?: (cfg: WorkspaceCliConfig, body: PublishRulesBody) => Promise<PublishRulesResult>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** The console renders evidenceJson.statement verbatim as the rule headline; pull the human-readable rule
 *  text out of the opaque payload, falling back to the logical id for code rules with no `.text` field. */
function ruleHeadline(record: LocalRuleVersionRecord): string {
  try {
    const parsed = JSON.parse(record.rulePayload) as { text?: unknown };
    if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();
  } catch {
    // opaque / non-JSON payload (should not happen for a stored version); fall through to the id.
  }
  return record.ruleId;
}

/** The default network seam: POST the batch to control with the session bearer the rest of the CLI uses. */
function defaultPublish(cfg: WorkspaceCliConfig, body: PublishRulesBody): Promise<PublishRulesResult> {
  return post<PublishRulesResult>(cfg, "/internal/v1/relationship-candidates/publish-rules", body, 15000);
}

/** Map one LIVE LocalRuleVersion to its control publish item (headline pulled from the opaque payload). */
function buildPublishItem(r: LocalRuleVersionRecord): PublishRuleItem {
  return {
    ruleId: r.ruleId,
    versionId: r.versionId,
    text: ruleHeadline(r),
    payloadHash: r.canonicalPayloadHash,
    lifecycleStatus: "LIVE",
    attestedBy: r.attestedBy ?? null,
    attestedAt: r.attestedAt ?? null,
    attestationMethod: r.attestationMethod ?? null,
  };
}

/** The seams a best-effort console sync needs: the local store, the workspace config, and the network. */
interface RulesSyncDeps {
  storePath?: string;
  openStore?: (dbPath: string) => Ce0Store;
  loadConfig?: () => WorkspaceCliConfig;
  publish?: (cfg: WorkspaceCliConfig, body: PublishRulesBody) => Promise<PublishRulesResult>;
}

/** The structured result of one console-sync attempt; the caller decides whether it is fatal. */
type RulesSyncOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "synced"; sent: number; workspaceId: string; result: PublishRulesResult }
  | { kind: "failed"; reason: string };

/**
 * Project the LIVE attested rules in `runtimeScopeId` to control (the exact batch `mla rules publish`
 * sends). It NEVER throws: an unbound workspace / logged-out CLI is reported as `skipped`
 * (loadConfig threw before any network call), an unreachable backend as `failed`; only a real POST that
 * returns is `synced`. The store is opened read-only and always closed; an empty LIVE set still posts so a
 * revoked-to-nothing scope reconciles away on the backend.
 */
async function publishLiveRulesForScope(
  runtimeScopeId: string,
  deps: RulesSyncDeps,
): Promise<RulesSyncOutcome> {
  let cfg: WorkspaceCliConfig;
  try {
    cfg = deps.loadConfig ? deps.loadConfig() : loadWorkspaceConfig();
  } catch (e) {
    return { kind: "skipped", reason: (e as Error).message };
  }

  const dbPath = deps.storePath ?? defaultCe0StorePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const open = deps.openStore ?? openCe0Store;
  const store = open(dbPath);
  let live: LocalRuleVersionRecord[];
  try {
    live = listLiveLocalRuleVersions(store, runtimeScopeId);
  } finally {
    closeCe0Store(store);
  }

  const rules = live.map(buildPublishItem);
  const body: PublishRulesBody = { workspaceId: cfg.workspaceId, runtimeScopeId, rules };
  const publish = deps.publish ?? defaultPublish;
  try {
    const result = await publish(cfg, body);
    return { kind: "synced", sent: rules.length, workspaceId: cfg.workspaceId, result };
  } catch (e) {
    // A workspace-membership 403 is not a wire fault; surface the canonical line
    // (BUG-5) as the reason instead of a raw `POST .../rules -> HTTP 403: {...}`
    // dump. The caller keeps its "failed to publish" prefix for operation context.
    const reason = isWorkspaceAccessDenied(e)
      ? workspaceAccessDeniedMessage(e)
      : (e as Error).message;
    return { kind: "failed", reason };
  }
}

/** Render the publish outcome as a compact, stable text block. */
function formatPublishText(
  runtimeScopeId: string,
  workspaceId: string,
  sent: number,
  result: PublishRulesResult,
): string {
  const lines = [
    `runtime scope: ${runtimeScopeId}`,
    `workspace:     ${workspaceId}`,
    `sent ${sent} LIVE rule(s); published ${result.published}, retired ${result.retired}`,
  ];
  if (result.items.length > 0) {
    lines.push("");
    for (const it of result.items) {
      lines.push(`  ${it.action.padEnd(9)} ${it.ruleId}  (${it.candidateId})`);
    }
  }
  return lines.join("\n");
}

/**
 * `mla rules publish [--json]`: project the LIVE attested rule versions in the ACTIVE runtime scope into
 * control so they surface on the console Rules page. It is the bridge half of the local-first rules engine:
 * `attest` / `revoke` only ever mutate the local CE0 store, and this command is the one place that pushes
 * that local truth to the backend. It reads EVERY LIVE LocalRuleVersion in the scope, maps each to a publish
 * item (the human-readable headline pulled from the opaque payload), and POSTs the whole set to control,
 * which upserts each as an ACCEPTED workspace-scoped rule-kind candidate (idempotent by workspace + ruleId)
 * and reconciles-by-omission: any rule it published from THIS scope before that is no longer LIVE is driven
 * to STALE so a revoked rule disappears from the Active tab. An empty LIVE set is NOT a no-op: it still posts
 * (with the scope) so the last-revoked rule reconciles away. Read-only on the local store; one network call.
 */
export async function runRulesPublish(argv: string[], deps: RulesPublishDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const json = argv.includes("--json");

  const resolveScope = deps.resolveRuntimeScopeId ?? resolveActiveRuntimeScopeId;
  const runtimeScopeId = resolveScope(deps.cwd);

  // The explicit command shares the ONE projection path with the auto-publish hooks, but maps the outcome
  // to its own hard exit codes: an unbound workspace is a usage error (2), a failed POST is a failure (1).
  const outcome = await publishLiveRulesForScope(runtimeScopeId, deps);
  if (outcome.kind === "skipped") {
    err(outcome.reason);
    return 2;
  }
  if (outcome.kind === "failed") {
    err(`failed to publish rules to control: ${outcome.reason}`);
    return 1;
  }

  if (json) {
    out(JSON.stringify({ runtimeScopeId, workspaceId: outcome.workspaceId, ...outcome.result }));
  } else {
    out(formatPublishText(runtimeScopeId, outcome.workspaceId, outcome.sent, outcome.result));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// mla rules import: the G2 one-time migration of BOTH legacy local stores into
// the unified backend rule store (proposal §7 Phase 1 step 2; acceptance 4/18/19).
// ---------------------------------------------------------------------------

export interface RulesImportDeps {
  /** The working directory the active runtime scope is derived from (defaults to process.cwd()). */
  cwd?: string;
  /** Resolve the active runtime scope id (seam for tests; defaults to the realpath repo-root walk). */
  resolveRuntimeScopeId?: (cwd?: string) => string;
  /** Resolve the repo root that owns .meetless/rules.md (seam for tests; defaults to the git toplevel). */
  resolveRoot?: (cwd: string) => string;
  /** Resolve the managed-rule file's historical attestation timestamp (ISO 8601); defaults to its mtime. */
  resolveManagedAttestedAt?: (managedFileAbs: string) => string;
  /** Where the CE0 SQLite store lives (defaults to the Meetless home). */
  storePath?: string;
  /** Open the store at a path (seam for tests; defaults to the real opener). */
  openStore?: (dbPath: string) => Ce0Store;
  /** Load the workspace-scoped config (seam for tests; throws when no workspace marker is bound). */
  loadConfig?: () => WorkspaceCliConfig;
  /** POST the import batch to control (seam for tests; defaults to the typed rule client). */
  importRules?: (cfg: WorkspaceCliConfig, body: ImportRulesBody) => Promise<ImportRulesResult>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** The managed file's mtime as the historical attestation instant (ISO 8601): its content was last edited
 *  then, the closest provenance a managed rule carries. A stat race swallows to the epoch rather than abort
 *  the migration, since the timestamp is informational and the rule is imported regardless. */
function defaultManagedAttestedAt(managedFileAbs: string): string {
  try {
    return fs.statSync(managedFileAbs).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

/** Render the importer outcome as a compact, stable text block (counts first, then any refused conflicts). */
function formatImportText(
  runtimeScopeId: string,
  workspaceId: string,
  result: ImportRulesResult,
): string {
  const lines = [
    `runtime scope: ${runtimeScopeId}`,
    `workspace:     ${workspaceId}`,
    `received ${result.rulesReceived} rule(s): imported ${result.rulesImported}, ` +
      `skipped ${result.rulesSkipped}, conflicted ${result.rulesConflicted}`,
    `versions:      minted ${result.versionsMinted}, skipped ${result.versionsSkipped}`,
  ];
  if (result.conflicts.length > 0) {
    lines.push("", "conflicts (refused; same versionId, different hash):");
    for (const c of result.conflicts) {
      lines.push(`  ${c.sourceRuleId} / ${c.sourceVersionId}: ${c.reason}`);
      lines.push(`    existing ${c.existingHash}`);
      lines.push(`    incoming ${c.incomingHash}`);
    }
  }
  return lines.join("\n");
}

/**
 * `mla rules import [--json]`: the G2 one-time migration. It reads BOTH legacy local stores for the ACTIVE
 * runtime scope (the CE0 SQLite enforcement history via listAllLocalRuleVersionsInScope, and the managed
 * `.meetless/rules.md` conventions at the repo root) and POSTs them to the unified backend importer, which
 * preserves each version's sourceVersionId + canonicalPayloadHash verbatim so a historical citation still
 * resolves after the cutover (acceptance 18). It is ADDITIVE and SAFE TO RE-RUN: the importer is idempotent
 * (same versionId + same hash skips), CE0 rules import as PERSONAL enforcement and managed rules as
 * never-enforcing OBSERVE conventions (see rule-import-mapping), and nothing about the local enforcement
 * path changes. An unbound workspace is a usage error (2); a failed POST is a failure (1); a per-rule hash
 * CONFLICT (the backend refused that rule, committed the rest) exits 1 so a migration script halts and is
 * examined. Read-only on the local stores; one network call.
 */
export async function runRulesImport(argv: string[], deps: RulesImportDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const json = argv.includes("--json");

  // A workspace binding is mandatory: the importer writes RuleNodes scoped to one workspace. An unbound CLI
  // is a usage error (2), exactly like `mla rules publish`, not a silent no-op.
  let cfg: WorkspaceCliConfig;
  try {
    cfg = deps.loadConfig ? deps.loadConfig() : loadWorkspaceConfig();
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  const resolveScope = deps.resolveRuntimeScopeId ?? resolveActiveRuntimeScopeId;
  const runtimeScopeId = resolveScope(deps.cwd);

  const cwd = deps.cwd ?? process.cwd();
  const root = (deps.resolveRoot ?? defaultRepoRoot)(cwd);
  const managedFileAbs = path.join(root, MANAGED_RULES_PATH);
  const managed = parseManagedRules(safeReadManagedFile(managedFileAbs));

  // CE0 enforcement history for the active scope: FULL history, all lifecycle states, grouped oldest-first.
  const dbPath = deps.storePath ?? defaultCe0StorePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const open = deps.openStore ?? openCe0Store;
  const store = open(dbPath);
  let ce0Rows: LocalRuleVersionRecord[];
  try {
    ce0Rows = listAllLocalRuleVersionsInScope(store, runtimeScopeId);
  } finally {
    closeCe0Store(store);
  }

  // Build the import batch: CE0 enforcement rules (PERSONAL) + managed conventions (TEAM). Either side may be
  // empty; an empty batch still posts so the operator gets a definitive "0 imported" rather than a guess.
  const rules: ImportRuleInput[] = [...ce0VersionsToImportRules(ce0Rows)];
  if (managed.length > 0) {
    const resolveAttestedAt = deps.resolveManagedAttestedAt ?? defaultManagedAttestedAt;
    const attestedAt = resolveAttestedAt(managedFileAbs);
    rules.push(...managedRulesToImportRules(managed, { runtimeScopeId, attestedAt }));
  }

  const importFn = deps.importRules ?? ((c, b) => importRules(c, b));
  let result: ImportRulesResult;
  try {
    result = await importFn(cfg, { workspaceId: cfg.workspaceId, rules });
  } catch (e) {
    // Membership 403 -> canonical line (BUG-5), keeping the operation prefix for
    // context; anything else keeps its raw message.
    const reason = isWorkspaceAccessDenied(e)
      ? workspaceAccessDeniedMessage(e)
      : (e as Error).message;
    err(`failed to import rules to control: ${reason}`);
    return 1;
  }

  if (json) {
    out(JSON.stringify({ runtimeScopeId, workspaceId: cfg.workspaceId, ...result }));
  } else {
    out(formatImportText(runtimeScopeId, cfg.workspaceId, result));
  }

  // A conflict (same sourceVersionId, different hash) is an integrity fault the backend refused: the rest of
  // the batch committed, but the operator must see a non-zero exit so a migration halts and is examined.
  return result.rulesConflicted > 0 ? 1 : 0;
}

// The git repo root that owns the managed-rules file. Reading/writing at the toplevel (not cwd) keeps
// one .meetless/rules.md per repo even when the command runs from a nested dir, matching how the
// scanner reads it from the canonical root. Falls back to cwd outside a git repo so a non-Git project
// can still hold a local rule file.
function defaultRepoRoot(cwd: string): string {
  try {
    // stdio ignores git's stderr so the "fatal: not a git repository" line never leaks to the
    // terminal on the supported non-Git fallback path (we catch the throw and return cwd anyway).
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top || cwd;
  } catch {
    return cwd;
  }
}

function safeReadManagedFile(abs: string): string {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}
