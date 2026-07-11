// src/commands/rules-backend.ts
//
// The `mla rules` verbs (notes/20260627-rules-store-unification-backend-sot-proposal.md §7,
// P1E / G1). Post-cutover this is the ONE implementation: cli.ts dispatches every `mla rules`
// verb here unconditionally, and each verb goes through the backend Rule API
// (lib/rules/control-rule-client.ts), which is the single source of truth. The former legacy
// CE0 + `.meetless/rules.md`-as-authority path is retired (`.meetless/rules.md` is now a read
// projection only).
//
// The §7 verb contract this module implements:
//   - list   -> GET /rules (so the CLI rule SET matches the console exactly, §6.1). Offline,
//               it falls back to the principal bundle cache and stamps revision + age
//               (acceptance 16), never silently showing an empty set as "no rules".
//   - add    -> mint a TEAM RuleNode (the old convention rule, now backend-authored). The
//               local `.meetless/rules.md`-as-authority write is gone; the file is a read
//               projection only. A binding rule requires an authenticated human (acceptance 8).
//   - edit   -> PATCH /rules/:id carrying expectedCurrentVersionId (mint-next, never overwrite,
//               §4.1); a stale token surfaces the backend 409 as a friendly conflict
//               (acceptance 6, 7). There is no legacy counterpart to this verb.
//   - revoke -> POST /rules/:id/revoke compare-and-swap; already-revoked is an idempotent
//               no-op; a stale token surfaces the 409. This is the kill switch (§7).
//   - attest -> fork assumption #7: the observed-snapshot resolution + §2.4 admission
//               conversion stay LOCAL (R0 hooks record to the local CE0 ledger), but the SINK
//               flips: instead of minting a LocalRuleVersion into CE0 it mints a PERSONAL
//               RuleNode on the backend (ownerUserId = the attesting human), so the backend is
//               the one authority and `revoke` can disarm it. requestIdempotencyKey =
//               canonicalPayloadHash is recorded on the minted version for audit/forensics; the
//               native mint does NOT dedup on it, so a re-attest of an identical snapshot mints a
//               fresh PERSONAL RuleNode (the operator deduplicates by revoking the duplicate).
//   - remove -> unsupported: `.meetless/rules.md` is no longer an authority. Points the
//               operator at `revoke <nodeId>`.
//
// OFFLINE-BINDING FAIL-FAST (§7): every mutating verb resolves the workspace via
// loadWorkspaceConfig(), which THROWS when no workspace marker is bound. That is a hard exit-2
// ("offline binding writes fail fast"): there is no local store to fall back to.
//
// All seams (config load, the http transport, operator resolution, confirm, clock, bundle
// reader) are injectable so every verb is unit-testable with no network and no disk, matching
// the publish-bridge convention (the http seam is the established CLI test boundary).

import * as fs from "fs";
import * as path from "path";

import { loadWorkspaceConfig, readConfig, type WorkspaceCliConfig } from "../lib/config";
import type { HttpError } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import {
  editRule,
  getRule,
  listRules,
  mintRule,
  revokeRule,
  type RuleAuthorityScope,
  type RuleClientHttp,
  type RuleLifecycleStatus,
  type RuleNodeView,
} from "../lib/rules/control-rule-client";
import { makeManagedRule } from "../lib/scanner/managed-rules";
import { managedRuleToRulePayload } from "../lib/rules/rule-import-mapping";
import { ruleVersionHash } from "../lib/rules/rule-version-hash";
import { parseApplicability } from "../lib/rules/applicability";
import { resolveActiveRuntimeScopeId } from "../lib/rules/runtime-scope";
import type { ObservedRuleSpec, RulePayloadV1, TurnTrigger } from "../lib/rules/types";
import type { EligibleEnforcement } from "../lib/rules/deny-admission";
import {
  readRuleBundleCache,
  type BundleCacheRead,
  type BundlePrincipal,
} from "../lib/rules/bundle-cache";
import { resolveBundlePrincipal } from "../lib/rules/bundle-principal";
import { openCe0Store, closeCe0Store, type Ce0Store } from "../lib/rules/ce0-store";
import { resolveObservedSnapshotInScope } from "../lib/rules/interception-store";
import {
  convertForbiddenRootSnapshot,
  convertNotesLocationSnapshot,
  NOTES_LOCATION_RULE_ID,
} from "../lib/rules/attest-notes-location";
import { serializeObservedRule } from "../lib/rules/observed-rule-hash";
import { defaultCe0StorePath } from "./evidence";
import { Strength } from "../lib/scanner/types";

// ───────────────────────────────────────────────────────────────────────────
// Usage
// ───────────────────────────────────────────────────────────────────────────

export const RULES_LIST_BACKEND_USAGE =
  "usage: mla rules list [--revoked] [--json] [--workspace <id>]\n" +
  "  Lists the workspace's rules from the backend store (matches the console).\n" +
  "  --revoked  include revoked rules.  --json  raw RuleNode JSON.\n" +
  "  --workspace <id>  act on the given workspace instead of the folder-bound one.";

export const RULES_ADD_BACKEND_USAGE =
  "usage: mla rules add \"<statement>\" [--personal | --team] [--must] [--applies-to <glob>]... [--source <ref>]... [--json] [--workspace <id>]\n" +
  "  Mints a rule on the backend (the single source of truth). Requires `mla login`.\n" +
  "  --personal  (default) the rule enforces for you alone; promote it later to share.\n" +
  "  --team      the rule enforces for the whole workspace (asks you to confirm).\n" +
  "  --applies-to <glob>  restrict the rule to matching paths (repeatable). Alias: --scope.\n" +
  "  --workspace <id>  file the rule into the given workspace instead of the folder-bound one.";

export const RULES_EDIT_BACKEND_USAGE =
  "usage: mla rules edit <nodeId> \"<new statement>\" [--must] [--scope <glob>]... [--source <ref>]... [--json] [--workspace <id>]\n" +
  "  Mints the NEXT version of an existing rule (the previous version is retained).";

export const RULES_REVOKE_BACKEND_USAGE =
  "usage: mla rules revoke <nodeId> [--yes] [--workspace <id>]\n" +
  "  Revokes a rule on the backend (the kill switch). Already-revoked is a no-op.";

export const RULES_ATTEST_BACKEND_USAGE =
  "usage: mla rules attest (--from-observed <hash> | --forbidden-root <path>) [--ceiling observe|warn]\n" +
  "                        [--text <rationale>] [--scope team|personal] [--agent-on-user-request --yes] [--workspace <id>]\n" +
  "  Mints a forbidden-root PROHIBIT rule on the backend.\n" +
  "  --from-observed <hash>   mint from a recorded R0 observed snapshot. With NO --ceiling this is the\n" +
  "                           armed notes-location DENY pilot (the only DENY arming surface).\n" +
  "  --forbidden-root <path>  author a rule for <path> directly, no observation needed. Defaults to the\n" +
  "                           WARN ceiling (a non-blocking advisory; a freshly armed rule warns, INV-8).\n" +
  "  --ceiling observe|warn   the enforcement authority to arm at. ask/deny are refused here: a new rule\n" +
  "                           must earn DENY end to end before it blocks.\n" +
  "  --text <rationale>       the rule statement shown to the agent (direct authoring only; defaulted).\n" +
  "  --scope personal (default) enforces only for you; --scope team enforces for the whole workspace.";

export const RULES_DEMOTE_BACKEND_USAGE =
  "usage: mla rules demote <nodeId> [--yes] [--workspace <id>]\n" +
  "  Demotes a TEAM rule to PERSONAL: mints a PERSONAL copy owned by you, then revokes the\n" +
  "  team rule. It then enforces for you alone, not the whole workspace. The audit trail is\n" +
  "  preserved (the personal version records you as its author).";

export const RULES_PROMOTE_BACKEND_USAGE =
  "usage: mla rules promote <nodeId> [--yes] [--workspace <id>]\n" +
  "  Promotes a PERSONAL rule to TEAM: mints a TEAM copy (owned by no one), then revokes the\n" +
  "  personal rule. It then enforces for the whole workspace, not you alone. The audit trail is\n" +
  "  preserved (the team version records you as its author).";

// ───────────────────────────────────────────────────────────────────────────
// Shared seams + helpers
// ───────────────────────────────────────────────────────────────────────────

/** The accountable operator behind a binding mutation, resolved from the authenticated session. */
export interface BackendOperator {
  /** The audited human; only a user-token session is a human attestor (acceptance 8). */
  userId: string;
  displayName?: string;
}

/** Read the audited operator from the session; only a user-token is a human author/attestor. */
function defaultResolveOperator(): BackendOperator | null {
  const cfg = readConfig();
  if (cfg.auth.mode !== "user-token") return null;
  return { userId: cfg.auth.user.id, displayName: cfg.auth.user.displayName || cfg.auth.user.id };
}

/** Synchronously read one line of confirmation from stdin (the interactive default). */
function defaultConfirm(prompt: string): boolean {
  process.stderr.write(`${prompt} [y/N] `);
  const buf = Buffer.alloc(256);
  try {
    const n = fs.readSync(0, buf, 0, buf.length, null);
    const answer = buf.toString("utf8", 0, n).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  }
}

function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** The HTTP status of a rejected request, or undefined when the request never reached the server. */
function httpStatus(err: unknown): number | undefined {
  const s = (err as HttpError | undefined)?.status;
  return typeof s === "number" ? s : undefined;
}

/** True when the error is a transport failure (ECONNREFUSED / abort), i.e. the backend is unreachable. */
function isOffline(err: unknown): boolean {
  return httpStatus(err) === undefined;
}

/**
 * The flags that consume the FOLLOWING token as a value (the only non-boolean ones).
 *
 * `--turn-when-prompt` / `--turn-when-path` are the Layer B trigger options (targeted-rule-injection
 * §5.1, P1). They are REPEATED value-flags (each occurrence contributes one literal phrase / glob; no
 * comma splitting, so `--turn-when-prompt "a, b"` is the single phrase "a, b"), matching `--scope` /
 * `--source`. They are deliberately kept OUT of the add/edit USAGE strings until the whole read +
 * assemble path is in the build (§7): the parser understands them so the round-trip is testable now,
 * but no help text advertises authoring a turn rule before every reader can honor it.
 */
const VALUE_FLAGS = new Set([
  "--applies-to",
  "--scope",
  "--source",
  "--turn-when-prompt",
  "--turn-when-path",
]);

interface ParsedRuleArgs {
  /** Positional tokens, in argv order, with every flag and consumed value removed. */
  positionals: string[];
  scope: string[];
  sources: string[];
  /** Repeated `--turn-when-prompt` literal phrases (Layer B trigger, §5.1). */
  turnPrompts: string[];
  /** Repeated `--turn-when-path` explicit-prompt-path globs (Layer B trigger, §5.1). */
  turnPaths: string[];
  /** A value-flag with no following value; the caller usage-errors on it. */
  danglingFlag?: string;
}

/**
 * Split argv with ONE sequential walk, exactly like the legacy `runRulesAdd` parser in
 * commands/rules.ts: `--scope <v>` / `--source <v>` each consume the next token, every
 * other `--flag` is boolean (left for the caller's `argv.includes` checks), and everything
 * else is a positional. This is the only correct split: the old two-scan approach
 * (`firstPositional` + a per-flag collector) could not tell that a token had already been
 * eaten as a flag value, so a value-flag placed BEFORE the statement (e.g.
 * `add --source slack-42 "Defer SSO"`) leaked "slack-42" out as the statement and minted a
 * corrupt rule. Value consumption is unconditional (matching legacy: even a `--`-looking
 * next token is taken as the value), so the index always advances past it.
 */
function parseRuleArgs(argv: string[]): ParsedRuleArgs {
  const positionals: string[] = [];
  const scope: string[] = [];
  const sources: string[] = [];
  const turnPrompts: string[] = [];
  const turnPaths: string[] = [];
  let danglingFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (!v) {
        danglingFlag = a;
        break;
      }
      // `--applies-to` is the current name for the applicability glob; `--scope` is the deprecated
      // alias (add/edit only; attest's `--scope` is authority plane and never reaches this parser).
      if (a === "--applies-to" || a === "--scope") scope.push(v);
      else if (a === "--source") sources.push(v);
      else if (a === "--turn-when-prompt") turnPrompts.push(v);
      else turnPaths.push(v);
      i++; // consumed the value; never re-examine it as a positional
      continue;
    }
    if (a.startsWith("--")) continue; // boolean flag, not a positional
    positionals.push(a);
  }
  return { positionals, scope, sources, turnPrompts, turnPaths, danglingFlag };
}

/**
 * Assemble a validated TurnTrigger from the repeated `--turn-when-prompt` / `--turn-when-path`
 * options, or `{ trigger: undefined }` when neither is present (the ambient default, unchanged).
 * The raw lists are handed to the SINGLE grammar owner (`parseApplicability`, targeted-rule-injection
 * §3.2 / P0) rather than re-validated here, so a malformed set (an empty phrase, say) is rejected with
 * the exact diagnostic the parser emits everywhere else, and the CLI never mints a turn payload the
 * hash serializer or the assembler would later choke on.
 */
function triggerFromArgs(parsed: ParsedRuleArgs): { trigger?: TurnTrigger } | { error: string } {
  if (parsed.turnPrompts.length === 0 && parsed.turnPaths.length === 0) {
    return { trigger: undefined };
  }
  const raw: { promptAny?: string[]; explicitPathAny?: string[] } = {};
  if (parsed.turnPrompts.length > 0) raw.promptAny = parsed.turnPrompts;
  if (parsed.turnPaths.length > 0) raw.explicitPathAny = parsed.turnPaths;
  const result = parseApplicability({ mode: "turn", trigger: raw });
  if (result.status !== "OK" || result.applicability?.mode !== "turn") {
    return { error: result.diagnostic ?? "invalid turn trigger" };
  }
  return { trigger: result.applicability.trigger };
}

/** The first non-flag positional, or undefined. Safe only for verbs with NO value-flags. */
function firstPositional(argv: string[]): string | undefined {
  return argv.find((a) => !a.startsWith("--"));
}

/**
 * Pull a `--workspace <id>` override out of argv (T1.1 folder=workspace admin escape hatch,
 * matching `mla kb` / `mla bug` / `mla ask`). Returns the override plus argv with the flag AND
 * its value removed, so each verb's own parse (parseRuleArgs / firstPositional / argv.includes)
 * never mistakes the workspace id for a rule statement, a nodeId, or a boolean flag. The override
 * is threaded into loadWorkspaceConfig(override), which authorizes it server-side (the tenant guard
 * 403s a workspace the human is not a member of, and errors on an unknown id) instead of the CLI
 * silently ignoring it. Run this FIRST in every rules verb.
 */
export function extractWorkspaceOverride(argv: string[]): {
  workspace?: string;
  rest: string[];
  danglingFlag?: string;
} {
  const rest: string[] = [];
  let workspace: string | undefined;
  let danglingFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace" || a === "--workspace-id") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        danglingFlag = a;
        break;
      }
      workspace = v;
      i++; // consumed the value; never re-examine it as a positional
      continue;
    }
    rest.push(a);
  }
  return { workspace, rest, danglingFlag };
}

function lifecycleOf(node: RuleNodeView): RuleLifecycleStatus {
  return node.lifecycleStatusId === "REVOKED" ? "REVOKED" : "ACTIVE";
}

function payloadText(node: RuleNodeView): string {
  const p = node.currentVersion?.payload as Partial<RulePayloadV1> | undefined;
  return p?.text ?? "(no live version)";
}

function payloadStrength(node: RuleNodeView): string {
  const p = node.currentVersion?.payload as Partial<RulePayloadV1> | undefined;
  return p?.strength ?? "?";
}

/**
 * Humanize the authority plane for a list row: a PERSONAL rule shows `PERSONAL owner:<id>` so the
 * operator can see WHOSE rule it is (and never tries to demote someone else's); TEAM / ORGANIZATION
 * carry no owner and print bare. This is the one place the raw authorityScopeId is turned into the
 * "personal vs team" signal the whole feature is about.
 */
function humanScope(scope: string, ownerUserId: string | null | undefined): string {
  return ownerUserId ? `${scope} owner:${ownerUserId}` : scope;
}

/** Render one rule node as a human line: id, scope+owner, strength, text, version, lifecycle. */
function renderRuleLine(node: RuleNodeView): string {
  const ver = node.currentVersionId ? `v:${node.currentVersionId}` : "(no version)";
  return (
    `${node.id}  [${humanScope(node.authorityScopeId, node.ownerUserId)}/${lifecycleOf(node)}]  ` +
    `(${payloadStrength(node)})  ${payloadText(node)}  ${ver}`
  );
}

// Surface a rules-backend HTTP failure. A workspace-membership 403 (an explicit
// --workspace, or the folder marker, names a workspace this human is not in) is
// NOT a token/config problem, so it is routed to the ONE canonical line (BUG-5):
// "You are not a member of workspace 'X'..." instead of a raw
// `PATCH https://.../internal/... -> HTTP 403: {...}` dump that leaks the internal
// URL. Every other error keeps its verb-specific prefix. Call this from the
// non-offline branch of each verb's catch so all rules verbs share one handler.
function reportRulesBackendError(
  e: unknown,
  verbFailedPrefix: string,
  err: (line: string) => void,
): number {
  if (isWorkspaceAccessDenied(e)) {
    err(workspaceAccessDeniedMessage(e));
    return 1;
  }
  err(`${verbFailedPrefix}: ${(e as Error).message}`);
  return 1;
}

// ───────────────────────────────────────────────────────────────────────────
// list
// ───────────────────────────────────────────────────────────────────────────

export interface RulesListBackendDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RuleClientHttp;
  /** Offline fallback: read the principal bundle cache (acceptance 16). */
  readBundle?: (principal: BundlePrincipal) => BundleCacheRead;
  /** Resolve the live session's bundle principal for the offline read. */
  resolvePrincipal?: (workspaceId: string) => BundlePrincipal;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `mla rules list`. Reads the backend Rule API so the SET matches the console exactly
 * (§6.1). When the backend is UNREACHABLE it degrades to the offline principal bundle and
 * stamps the bundle revision + age (acceptance 16), so a stale offline view is never mistaken
 * for "no rules". A real HTTP error (4xx/5xx) is surfaced, not masked by the offline path.
 */
export async function runRulesListBackend(argv: string[], deps: RulesListBackendDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  // Pull `--workspace <id>` out FIRST so its value never leaks into the boolean-flag checks
  // below, then thread it into loadWorkspaceConfig so the server authorizes the target (BUG-3/BUG-4).
  const { workspace, rest, danglingFlag } = extractWorkspaceOverride(argv);
  if (danglingFlag) {
    err(`${danglingFlag} needs a value\n${RULES_LIST_BACKEND_USAGE}`);
    return 2;
  }
  const json = rest.includes("--json");
  const includeRevoked = rest.includes("--revoked");

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`rules list: ${(e as Error).message}`);
    return 2;
  }

  try {
    const nodes = await listRules(
      cfg,
      includeRevoked ? {} : { lifecycleStatus: "ACTIVE" },
      deps.http,
    );
    if (json) {
      out(JSON.stringify(nodes, null, 2));
      return 0;
    }
    if (nodes.length === 0) {
      out("(no rules)");
      return 0;
    }
    for (const node of nodes) out(renderRuleLine(node));
    return 0;
  } catch (e) {
    if (!isOffline(e)) {
      return reportRulesBackendError(e, "rules list failed", err);
    }
    // Offline: fall back to the principal bundle cache so the operator still sees the
    // last-good set, clearly labelled with its revision + age (acceptance 16).
    return listFromBundle(cfg, deps, out, err, json);
  }
}

function listFromBundle(
  cfg: WorkspaceCliConfig,
  deps: RulesListBackendDeps,
  out: (l: string) => void,
  err: (l: string) => void,
  json: boolean,
): number {
  const resolvePrincipal = deps.resolvePrincipal ?? ((ws: string) => resolveBundlePrincipal(ws));
  const readBundle = deps.readBundle ?? ((p: BundlePrincipal) => readRuleBundleCache(p));
  const read = readBundle(resolvePrincipal(cfg.workspaceId));
  if (read.status === "unavailable" || !read.bundle) {
    err("rules list unavailable: backend unreachable and no cached rule bundle on disk");
    return 1;
  }
  const ageMin = read.ageMs === null ? "unknown" : `${Math.round(read.ageMs / 60000)}m`;
  const stale = read.status === "stale" ? " (STALE, past lease)" : "";
  if (json) {
    out(JSON.stringify(read.bundle, null, 2));
    return 0;
  }
  out(`(offline) bundle revision ${read.bundle.bundleRevision}, age ${ageMin}${stale}`);
  if (read.droppedForIntegrity > 0) {
    out(`(${read.droppedForIntegrity} entr${read.droppedForIntegrity === 1 ? "y" : "ies"} dropped for integrity)`);
  }
  if (read.bundle.rules.length === 0) {
    out("(no rules in bundle)");
    return 0;
  }
  for (const entry of read.bundle.rules) {
    const p = entry.payload as Partial<RulePayloadV1> | undefined;
    out(
      `${entry.ruleNodeId}  [${humanScope(entry.authorityScope, entry.ownerUserId)}]  (${p?.strength ?? "?"})  ` +
        `${p?.text ?? "(opaque)"}  v:${entry.ruleVersionId}`,
    );
  }
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
// add
// ───────────────────────────────────────────────────────────────────────────

export interface RulesAddBackendDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RuleClientHttp;
  resolveOperator?: () => BackendOperator | null;
  resolveRuntimeScopeId?: (cwd?: string) => string;
  cwd?: string;
  isInteractive?: () => boolean;
  confirm?: (prompt: string) => boolean | Promise<boolean>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `mla rules add`. Mints a RuleNode on the backend from the convention text + flags (the legacy
 * managed-rule shape, converted to the triple-safe RulePayloadV1 so it is injected but never
 * enforces). The authority plane defaults to PERSONAL (enforces for the author alone; every mint
 * prints a promote nudge); `--team` opts into workspace-wide enforcement and, being higher blast
 * radius, confirms exactly like attest/revoke (interactive Y/n or --yes). `--personal` + `--team`
 * together is a usage error. A binding rule REQUIRES an authenticated human (acceptance 8): a
 * shared-key / logged-out session is refused locally with a clear pointer, rather than a bare
 * server 403. requestIdempotencyKey = the payload hash is recorded on the version for audit; the
 * native mint does NOT dedup on it, so re-running `add` with identical text mints a second
 * RuleNode. Offline binding writes fail fast (loadWorkspaceConfig throws -> exit 2).
 */
export async function runRulesAddBackend(argv: string[], deps: RulesAddBackendDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  // Pull `--workspace <id>` out FIRST so its value can never be joined into the statement, then
  // thread it into loadWorkspaceConfig so the rule is filed into (and authorized against) the
  // named workspace instead of the folder-bound one (BUG-3/BUG-4).
  const { workspace, rest, danglingFlag: wsFlag } = extractWorkspaceOverride(argv);
  if (wsFlag) {
    err(`${wsFlag} needs a value\n${RULES_ADD_BACKEND_USAGE}`);
    return 2;
  }
  const json = rest.includes("--json");

  const parsed = parseRuleArgs(rest);
  if (parsed.danglingFlag) {
    err(`${parsed.danglingFlag} needs a value\n${RULES_ADD_BACKEND_USAGE}`);
    return 2;
  }
  // Mirror legacy runRulesAdd: the statement is EVERY positional joined, so an unquoted
  // multi-word statement survives and a --scope/--source value that precedes it can never be
  // mistaken for the statement (the sequential walk already consumed it).
  const statement = parsed.positionals.join(" ").trim();
  if (!statement) {
    err(RULES_ADD_BACKEND_USAGE);
    return 2;
  }
  const strength: Strength = rest.includes("--must") ? "MUST_FOLLOW" : "SHOULD_FOLLOW";
  const scope = parsed.scope;
  const sources = parsed.sources;

  // Authority plane. Default PERSONAL (enforces for the author alone; promotable later); --team
  // opts into workspace-wide enforcement. Passing both is a usage error; --personal spells out the
  // default. Boolean flags (not --scope, which stays the applicability-glob alias) so add never
  // overloads one flag with two meanings.
  const wantTeam = rest.includes("--team");
  const wantPersonal = rest.includes("--personal");
  if (wantTeam && wantPersonal) {
    err(`pass either --team or --personal, not both\n${RULES_ADD_BACKEND_USAGE}`);
    return 2;
  }
  const authorityScope: RuleAuthorityScope = wantTeam ? "TEAM" : "PERSONAL";

  // A malformed turn trigger is a usage error (exit 2), surfaced BEFORE we touch auth or the network.
  const triggerResult = triggerFromArgs(parsed);
  if ("error" in triggerResult) {
    err(`${triggerResult.error}\n${RULES_ADD_BACKEND_USAGE}`);
    return 2;
  }

  const resolveOperator = deps.resolveOperator ?? defaultResolveOperator;
  const operator = resolveOperator();
  if (!operator) {
    err(
      "refusing to add: a binding rule requires an authenticated human (run `mla login`); " +
        "an agent or shared key can never mint a binding rule",
    );
    return 1;
  }
  // PERSONAL is owner-private (the author owns the private-ACL row); TEAM carries no owner and is
  // workspace-visible. The backend re-derives this via resolveOwner (ownerUserId is an ignored hint,
  // INV-AUTH-1), so this is the wire value, not a trust boundary.
  const ownerUserId = authorityScope === "PERSONAL" ? operator.userId : null;

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`rules add: ${(e as Error).message}`);
    return 2;
  }

  const resolveScope = deps.resolveRuntimeScopeId ?? resolveActiveRuntimeScopeId;
  const runtimeScopeId = resolveScope(deps.cwd);
  const managed = makeManagedRule({ statement, strength, scope, sources });
  const payload = managedRuleToRulePayload(managed, runtimeScopeId, triggerResult.trigger);
  const requestIdempotencyKey = ruleVersionHash(payload);

  // TEAM is higher blast radius (enforces workspace-wide), so it confirms exactly like
  // attest/revoke: interactive Y/n, or --yes for an explicit non-interactive instruction. PERSONAL
  // (the default, enforces for the author alone) needs no confirmation.
  if (authorityScope === "TEAM" && !rest.includes("--yes")) {
    const isInteractive = deps.isInteractive ?? defaultIsInteractive;
    if (!isInteractive()) {
      err("refusing to mint a TEAM rule non-interactively without --yes (it enforces workspace-wide)");
      return 1;
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const ok = await confirm("Mint a TEAM rule (it will enforce for the whole workspace)?");
    if (!ok) {
      err("team rule not confirmed; nothing minted");
      return 1;
    }
  }

  try {
    const node = await mintRule(
      cfg,
      {
        workspaceId: cfg.workspaceId,
        authorityScope,
        ownerUserId,
        projectId: null,
        payload: payload as unknown as Record<string, unknown>,
        // Send the CLI hash as the canonical hash so the backend stores it verbatim and
        // the read-path re-hash (verifyEntryIntegrity) agrees; same value doubles as the
        // idempotency key.
        canonicalPayloadHash: requestIdempotencyKey,
        requestIdempotencyKey,
      },
      deps.http,
    );
    if (json) {
      out(JSON.stringify(node, null, 2));
      return 0;
    }
    // Loud, scope-stating success + the audience line. For PERSONAL, nudge toward promotion so the
    // author knows the rule is theirs alone and how to share it (the one mitigation for the PERSONAL
    // default undercutting team propagation).
    const scopeLabel = authorityScope === "TEAM" ? "TEAM" : "PERSONAL";
    out(`MINTED ${scopeLabel} rule ${node.id} version ${node.currentVersionId} (${requestIdempotencyKey})`);
    if (authorityScope === "TEAM") {
      out("This is a TEAM rule: it enforces for every member of the workspace.");
    } else {
      out(
        "This is a PERSONAL rule: it enforces for you alone. " +
          `Run \`mla rules promote ${node.id}\` to share it with the team.`,
      );
    }
    return 0;
  } catch (e) {
    if (isOffline(e)) {
      err("rules add failed: backend unreachable; the rule was NOT minted (the backend is the source of truth)");
      return 1;
    }
    return reportRulesBackendError(e, "rules add failed", err);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// edit (NEW verb, no legacy counterpart)
// ───────────────────────────────────────────────────────────────────────────

export interface RulesEditBackendDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RuleClientHttp;
  resolveOperator?: () => BackendOperator | null;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `mla rules edit <nodeId> "<new statement>"` (NEW verb; no legacy counterpart). Reads the
 * current live version for its expectedCurrentVersionId, then PATCHes a
 * NEW version (the previous one is retained, acceptance 3). A concurrent edit/revoke that moved
 * the node surfaces the backend 409 as a friendly conflict (acceptance 6, 7). The new payload
 * preserves the existing runtimeScopeId so the rule stays in the same scope.
 */
export async function runRulesEditBackend(argv: string[], deps: RulesEditBackendDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  // Pull `--workspace <id>` out FIRST so its value never lands in the nodeId/statement positionals,
  // then thread it into loadWorkspaceConfig so the edit targets the named workspace (BUG-3/BUG-4).
  const { workspace, rest, danglingFlag: wsFlag } = extractWorkspaceOverride(argv);
  if (wsFlag) {
    err(`${wsFlag} needs a value\n${RULES_EDIT_BACKEND_USAGE}`);
    return 2;
  }
  const json = rest.includes("--json");

  const parsed = parseRuleArgs(rest);
  if (parsed.danglingFlag) {
    err(`${parsed.danglingFlag} needs a value\n${RULES_EDIT_BACKEND_USAGE}`);
    return 2;
  }
  // nodeId is the first positional; the rest join into the statement (legacy parity, and a
  // --scope/--source value before the statement can never be misread as nodeId or statement).
  const nodeId = parsed.positionals[0];
  const statement = parsed.positionals.slice(1).join(" ").trim();
  if (!nodeId || !statement) {
    err(RULES_EDIT_BACKEND_USAGE);
    return 2;
  }
  const strength: Strength = rest.includes("--must") ? "MUST_FOLLOW" : "SHOULD_FOLLOW";
  const scope = parsed.scope;
  const sources = parsed.sources;

  // A malformed turn trigger is a usage error (exit 2), surfaced BEFORE we touch auth or the network.
  const triggerResult = triggerFromArgs(parsed);
  if ("error" in triggerResult) {
    err(`${triggerResult.error}\n${RULES_EDIT_BACKEND_USAGE}`);
    return 2;
  }

  const resolveOperator = deps.resolveOperator ?? defaultResolveOperator;
  if (!resolveOperator()) {
    err("refusing to edit: editing a binding rule requires an authenticated human (run `mla login`)");
    return 1;
  }

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`rules edit: ${(e as Error).message}`);
    return 2;
  }

  let node: RuleNodeView;
  try {
    node = await getRule(cfg, nodeId, deps.http);
  } catch (e) {
    if (httpStatus(e) === 404) {
      err(`no rule ${nodeId} is visible in this workspace`);
      return 1;
    }
    if (isOffline(e)) {
      err("rules edit failed: backend unreachable; nothing changed");
      return 1;
    }
    return reportRulesBackendError(e, "rules edit failed", err);
  }
  if (lifecycleOf(node) === "REVOKED") {
    err(`rule ${nodeId} is revoked; revive it by minting a new rule, not editing a revoked one`);
    return 1;
  }
  if (!node.currentVersionId) {
    err(`rule ${nodeId} has no live version to supersede`);
    return 1;
  }

  // Preserve the existing scope id so an edit never silently relocates the rule.
  // Everything the operator authors (statement, strength, scope, sources, and now the
  // turn trigger) is restated from args: an edit with no --turn-when-* flags mints an
  // ambient payload, exactly as an edit with no --must mints a SHOULD one. This is how
  // P4 flips the doctrine rule ambient->turn atomically (new statement + turn flags in
  // one supersede); only runtimeScopeId, a machine checkout fingerprint, is carried.
  const existing = node.currentVersion?.payload as Partial<RulePayloadV1> | undefined;
  const runtimeScopeId = existing?.runtimeScopeId ?? resolveActiveRuntimeScopeId();
  const managed = makeManagedRule({ statement, strength, scope, sources });
  const payload = managedRuleToRulePayload(managed, runtimeScopeId, triggerResult.trigger);
  const requestIdempotencyKey = ruleVersionHash(payload);

  try {
    const updated = await editRule(
      cfg,
      nodeId,
      {
        workspaceId: cfg.workspaceId,
        expectedCurrentVersionId: node.currentVersionId,
        payload: payload as unknown as Record<string, unknown>,
        // Store the CLI hash verbatim so the read-path re-hash agrees (see runRulesAddBackend).
        canonicalPayloadHash: requestIdempotencyKey,
        requestIdempotencyKey,
      },
      deps.http,
    );
    if (json) {
      out(JSON.stringify(updated, null, 2));
      return 0;
    }
    out(`EDITED rule ${nodeId}: ${node.currentVersionId} -> ${updated.currentVersionId}`);
    return 0;
  } catch (e) {
    if (httpStatus(e) === 409) {
      err(
        `rule ${nodeId} changed since you read it (a concurrent edit or revoke won the ` +
          "compare-and-swap); nothing was minted, re-run to retry against the new version",
      );
      return 1;
    }
    if (isOffline(e)) {
      err("rules edit failed: backend unreachable; nothing changed");
      return 1;
    }
    return reportRulesBackendError(e, "rules edit failed", err);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// revoke (kill switch)
// ───────────────────────────────────────────────────────────────────────────

export interface RulesRevokeBackendDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RuleClientHttp;
  resolveOperator?: () => BackendOperator | null;
  isInteractive?: () => boolean;
  confirm?: (prompt: string) => boolean | Promise<boolean>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `mla rules revoke <nodeId>`. The kill switch: compare-and-swap the node to REVOKED
 * carrying expectedCurrentVersionId. An already-revoked node is an idempotent no-op (exit 0).
 * A stale token (the node moved under a concurrent edit) surfaces the backend 409. Confirmation
 * mirrors attest: interactive Y/n, or `--yes` for an explicit non-interactive instruction.
 */
export async function runRulesRevokeBackend(argv: string[], deps: RulesRevokeBackendDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  // Pull `--workspace <id>` out FIRST so it is never mistaken for the nodeId, then thread it into
  // loadWorkspaceConfig so `list --workspace <ws>` + `revoke --workspace <ws> <id>` can clean up
  // rules mis-filed into another workspace (the BUG-4 migration path).
  const { workspace, rest, danglingFlag } = extractWorkspaceOverride(argv);
  if (danglingFlag) {
    err(`${danglingFlag} needs a value\n${RULES_REVOKE_BACKEND_USAGE}`);
    return 2;
  }
  const nodeId = firstPositional(rest);
  if (!nodeId) {
    err(RULES_REVOKE_BACKEND_USAGE);
    return 2;
  }
  const yes = rest.includes("--yes");

  const resolveOperator = deps.resolveOperator ?? defaultResolveOperator;
  if (!resolveOperator()) {
    err("refusing to revoke: revoking a binding rule requires an authenticated human (run `mla login`)");
    return 1;
  }

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`rules revoke: ${(e as Error).message}`);
    return 2;
  }

  let node: RuleNodeView;
  try {
    node = await getRule(cfg, nodeId, deps.http);
  } catch (e) {
    if (httpStatus(e) === 404) {
      err(`no rule ${nodeId} is visible in this workspace`);
      return 1;
    }
    if (isOffline(e)) {
      err("rules revoke failed: backend unreachable; nothing changed");
      return 1;
    }
    return reportRulesBackendError(e, "rules revoke failed", err);
  }
  if (lifecycleOf(node) === "REVOKED") {
    out(`already revoked: rule ${nodeId}; no-op`);
    return 0;
  }
  if (!node.currentVersionId) {
    err(`rule ${nodeId} has no live version to revoke`);
    return 1;
  }

  const isInteractive = deps.isInteractive ?? defaultIsInteractive;
  if (!yes) {
    if (!isInteractive()) {
      err("refusing to revoke non-interactively without --yes (the kill switch is explicit)");
      return 1;
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const ok = await confirm(`Revoke rule ${nodeId} (${payloadText(node)})?`);
    if (!ok) {
      err("revoke not confirmed; nothing changed");
      return 1;
    }
  }

  try {
    await revokeRule(
      cfg,
      nodeId,
      { workspaceId: cfg.workspaceId, expectedCurrentVersionId: node.currentVersionId },
      deps.http,
    );
    out(`REVOKED rule ${nodeId}`);
    return 0;
  } catch (e) {
    if (httpStatus(e) === 409) {
      err(
        `rule ${nodeId} changed since you read it (a concurrent edit won the compare-and-swap); ` +
          "nothing was revoked, re-run to retry against the new version",
      );
      return 1;
    }
    if (isOffline(e)) {
      err("rules revoke failed: backend unreachable; nothing changed");
      return 1;
    }
    return reportRulesBackendError(e, "rules revoke failed", err);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// attest (fork assumption #7)
// ───────────────────────────────────────────────────────────────────────────

export interface RulesAttestBackendDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RuleClientHttp;
  resolveOperator?: () => BackendOperator | null;
  resolveRuntimeScopeId?: (cwd?: string) => string;
  cwd?: string;
  storePath?: string;
  openStore?: (dbPath: string) => Ce0Store;
  isInteractive?: () => boolean;
  confirm?: (prompt: string) => boolean | Promise<boolean>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Pull the token after `name` from argv. `dangling` is true when the flag is present but its value
 * is missing or is itself another flag, so the caller can fail with the usage rather than swallow it. */
function attestFlagValue(argv: string[], name: string): { value?: string; dangling: boolean } {
  const i = argv.indexOf(name);
  if (i < 0) return { dangling: false };
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) return { dangling: true };
  return { value: v, dangling: false };
}

/** The four enforcement rungs as lowercase CLI tokens (the ladder OBSERVE < WARN < ASK < DENY). */
const CEILING_TOKENS: Record<string, EligibleEnforcement> = {
  observe: "OBSERVE",
  warn: "WARN",
  ask: "ASK",
  deny: "DENY",
};

/** The operator-facing note describing what an armed rule at `ceiling` does at enforcement time. ASK is
 * unreachable here (the notes pilot is DENY, the generic path is capped to observe|warn), so only the
 * three armable rungs are described. */
function ceilingArmingNote(ceiling: EligibleEnforcement, scopeLabel: string, audienceNote: string): string {
  if (ceiling === "DENY") {
    return (
      `note: enforcementCeiling is DENY. Once this ${scopeLabel} rule is LIVE in the bundle and the ` +
      "deny-admission gates pass, a VIOLATION is denied on the wire; otherwise it degrades to ASK. " +
      audienceNote
    );
  }
  if (ceiling === "OBSERVE") {
    return (
      `note: enforcementCeiling is OBSERVE. Once this ${scopeLabel} rule is LIVE it records matches but ` +
      `never warns or blocks; it is the watch-only first rung of the ramp. ${audienceNote}`
    );
  }
  // WARN (the default arming rung): non-blocking advisory on the next turn, never a hard stop (INV-8).
  return (
    `note: enforcementCeiling is WARN. Once this ${scopeLabel} rule is LIVE in the bundle, a VIOLATION ` +
    "hands the agent a non-blocking advisory on its next turn; the action itself is never blocked (INV-8). " +
    `Promote it to DENY only after it is proven end to end. ${audienceNote}`
  );
}

/**
 * `mla rules attest --from-observed <hash> [--scope team|personal]` (fork assumption #7).
 * Observation is inherently LOCAL (R0 PreToolUse hooks record to the CE0 ledger), so the
 * observed-snapshot resolution and the §2.4 admission conversion to the notes-location DENY payload
 * stay local, UNCHANGED from the retired local path. The SINK flips: instead of minting a
 * LocalRuleVersion into CE0, it mints a RuleNode on the backend, so the backend is the one rule
 * authority and `revoke` can disarm it, and PreToolUse enforces it from the bundle.
 *
 * SCOPE (An's directive: "enforcement must take into account both personal and team rules"). The
 * enforcing payload is identical in both planes; only the node's authorityScope differs, and the
 * ONE enforcer (decideBundleEnforcement) is scope-blind, so both planes enforce through the same path:
 *   - --scope personal (default): a PERSONAL node owned by the attesting human. In every principal's
 *     bundle only for that human (personalAclWhere), so it enforces for the attestor alone.
 *   - --scope team: a TEAM node with ownerUserId null. TEAM is visible to every workspace member
 *     (personalAclWhere returns authorityScope != PERSONAL to all principals), so it enforces for the
 *     whole team. The human author is still recorded on the version (attestedByUserId, stamped
 *     server-side from the authenticated actor; never null), so the team rule keeps a full audit trail.
 *
 * requestIdempotencyKey = canonicalPayloadHash is recorded on the version for audit; the native
 * mint does NOT dedup on it, so re-attesting the same snapshot mints a fresh node (this matches
 * "attest always mints a fresh node" below; deduplicate by revoking the duplicate).
 *
 * CEILING + SOURCE (the whole PROHIBIT forbidden-root family, not just the notes pilot). Two authoring
 * sources, exactly one per call:
 *   - --from-observed <hash>: convert a recorded R0 observation. With NO --ceiling this is the
 *     notes-location DENY pilot (pinned to the "notes" root, EARNED DENY) exactly as before; with
 *     --ceiling it is the generic family at the requested rung.
 *   - --forbidden-root <path>: author a rule for any root directly, no observation needed (the WARN-first
 *     arming surface). The spec is synthesized and run through the SAME production admission gate.
 * --ceiling selects the enforcement authority and is capped to the non-blocking rungs (observe|warn):
 * a freshly armed rule warns before it blocks (INV-8), so DENY/ASK are refused for a cold arming. The
 * only DENY arming surface stays the proven notes-location pilot. The P0.55 logical-identity flags
 * (`--new-rule` / `--rule`) are SUBSUMED by the backend nodeId model: attest always mints a fresh node;
 * re-edit by nodeId via `edit`. `--from-code-rule` is deferred to Phase 2 (it arms a RECORD_ONLY rule
 * that changes no runtime behavior). Both error with a clear pointer.
 */
export async function runRulesAttestBackend(argv: string[], deps: RulesAttestBackendDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  // Pull `--workspace <id>` out FIRST so it never collides with --from-observed / --scope parsing,
  // then thread it into loadWorkspaceConfig so the attested rule is minted into the named workspace.
  const { workspace, rest, danglingFlag: wsFlag } = extractWorkspaceOverride(argv);
  if (wsFlag) {
    err(`${wsFlag} needs a value\n${RULES_ATTEST_BACKEND_USAGE}`);
    return 2;
  }

  if (rest.includes("--from-code-rule")) {
    err(
      "`mla rules attest --from-code-rule` is deferred to Phase 2 under the backend store " +
        "(it arms a RECORD_ONLY rule that changes no runtime behavior); not available yet",
    );
    return 2;
  }
  if (rest.includes("--new-rule") || rest.includes("--rule")) {
    err(
      "--new-rule / --rule are subsumed by the backend nodeId model: attest mints a " +
        "fresh node; target an existing rule by nodeId with `mla rules edit` / `revoke`",
    );
    return 2;
  }

  // A forbidden-root rule can be authored two ways, and exactly one source must be chosen:
  //   --from-observed <hash>   pull the spec from a recorded R0 observation (the original path).
  //   --forbidden-root <path>  author the spec directly by naming the root (no observation needed).
  // --ceiling selects the enforcement authority to arm at. It is capped to the non-blocking rungs
  // (observe|warn): a freshly armed rule warns before it blocks (INV-8), so DENY/ASK are refused here.
  // The ONE DENY arming surface is --from-observed with NO --ceiling: the proven, notes-pinned
  // notes-location pilot, whose EARNED DENY authority is preserved for backward compatibility.
  const observed = attestFlagValue(rest, "--from-observed");
  const forbiddenRoot = attestFlagValue(rest, "--forbidden-root");
  const ceilingFlag = attestFlagValue(rest, "--ceiling");
  const textFlag = attestFlagValue(rest, "--text");
  if (observed.dangling || forbiddenRoot.dangling || ceilingFlag.dangling || textFlag.dangling) {
    err(RULES_ATTEST_BACKEND_USAGE);
    return 2;
  }
  const observedRuleHash = observed.value;
  const directRoot = forbiddenRoot.value;
  if (observedRuleHash !== undefined && directRoot !== undefined) {
    err(`pass either --from-observed <hash> or --forbidden-root <path>, not both\n${RULES_ATTEST_BACKEND_USAGE}`);
    return 2;
  }
  if (observedRuleHash === undefined && directRoot === undefined) {
    err(RULES_ATTEST_BACKEND_USAGE);
    return 2;
  }

  // Parse the requested ceiling, if any. The generic forbidden-root family arms at WARN by default and
  // admits only the non-blocking rungs from the CLI; DENY/ASK are earned promotions, not a cold arming,
  // so refuse them with a pointer rather than mint a first-arming hard block.
  let requestedCeiling: EligibleEnforcement | undefined;
  if (ceilingFlag.value !== undefined) {
    const mapped = CEILING_TOKENS[ceilingFlag.value.toLowerCase()];
    if (!mapped) {
      err(`--ceiling takes one of observe|warn|ask|deny\n${RULES_ATTEST_BACKEND_USAGE}`);
      return 2;
    }
    requestedCeiling = mapped;
  }
  // Any --ceiling arming, and every --forbidden-root arming, is the GENERIC family (never the notes
  // DENY pilot, which is reached only by --from-observed with no --ceiling).
  const genericArming = directRoot !== undefined || requestedCeiling !== undefined;
  if (genericArming && (requestedCeiling === "ASK" || requestedCeiling === "DENY")) {
    err(
      `--ceiling ${requestedCeiling.toLowerCase()} is refused when arming a new forbidden-root rule: a ` +
        "freshly armed rule warns before it blocks (INV-8). Arm it at --ceiling warn, prove it end to " +
        "end, then promote. Today only the notes-location pilot (--from-observed, no --ceiling) arms at DENY.",
    );
    return 2;
  }
  // The generic path arms at the requested rung, defaulting to WARN (the non-blocking middle rung).
  const genericCeiling: EligibleEnforcement = requestedCeiling ?? "WARN";

  const agentOnUserRequest = rest.includes("--agent-on-user-request");
  const yes = rest.includes("--yes");

  // --scope selects the authority plane. An's rule: enforcement takes BOTH personal and team
  // into account, so team is a first-class attest target, not a separate verb. The enforcer
  // (decideBundleEnforcement) is scope-blind and every principal's bundle already carries the
  // non-PERSONAL rules, so a TEAM attest binds the SAME DENY payload for the whole workspace;
  // only the minted node's authorityScope + ownerUserId change. Default personal (enforces for
  // you alone) preserves the prior single-operator behavior when the flag is omitted.
  const scopeIdx = rest.indexOf("--scope");
  let authorityScope: RuleAuthorityScope = "PERSONAL";
  if (scopeIdx >= 0) {
    const raw = rest[scopeIdx + 1];
    if (raw === "team") authorityScope = "TEAM";
    else if (raw === "personal") authorityScope = "PERSONAL";
    else {
      err(`--scope takes 'team' or 'personal'\n${RULES_ATTEST_BACKEND_USAGE}`);
      return 2;
    }
  }
  const scopeLabel = authorityScope === "TEAM" ? "TEAM" : "PERSONAL";

  const resolveOperator = deps.resolveOperator ?? defaultResolveOperator;
  const operator = resolveOperator();
  if (!operator) {
    err(
      "refusing to attest: not logged in as a human operator (run `mla login`); " +
        "attestation requires an authenticated MLA operator",
    );
    return 1;
  }

  // PERSONAL is owner-private (the attestor owns the private-ACL row); TEAM carries no owner and
  // is workspace-visible. The backend re-derives this via resolveOwner (input.ownerUserId is an
  // ignored hint, INV-AUTH-1), so this is the wire value, not a trust boundary. Either way the
  // human is recorded for audit via the server-stamped, never-null attestedByUserId.
  const ownerUserId = authorityScope === "PERSONAL" ? operator.userId : null;

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`rules attest: ${(e as Error).message}`);
    return 2;
  }

  const resolveScope = deps.resolveRuntimeScopeId ?? resolveActiveRuntimeScopeId;
  const runtimeScopeId = resolveScope(deps.cwd);

  let payload: RulePayloadV1;
  // notesPilot marks the one EARNED-DENY, notes-pinned arming (--from-observed, no --ceiling), used
  // only for the display label; every other arming is the generic forbidden-root family.
  let notesPilot = false;
  if (directRoot !== undefined) {
    // Direct authoring: synthesize the exact observed-rule-v1 spec the scanner would emit for a
    // whole-root Write/Edit PROHIBIT, then run it through the SAME production admission gate as the
    // observed path (serialize -> convertForbiddenRootSnapshot). No CE0 store is touched: authoring a
    // new root needs no prior observation. Omitting the matcher glob forbids ALL files under the root.
    const spec: ObservedRuleSpec = {
      text:
        textFlag.value ??
        `Files under ${directRoot}/ are governed; write them elsewhere unless a change is explicitly allowed there.`,
      applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path" } },
      effect: "PROHIBIT",
      forbiddenRootRelativePath: directRoot,
    };
    let snapshotJson: string;
    try {
      snapshotJson = serializeObservedRule(spec);
    } catch (e) {
      err(`rules attest: cannot author forbidden-root rule: ${(e as Error).message}`);
      return 2;
    }
    const conversion = convertForbiddenRootSnapshot(snapshotJson, runtimeScopeId, genericCeiling);
    if (!conversion.admitted) {
      err(`cannot author forbidden-root rule (${conversion.reason}): ${conversion.detail}`);
      return 2;
    }
    payload = conversion.payload;
  } else {
    // Observed path: resolve the recorded snapshot from the local CE0 ledger, then convert. With NO
    // --ceiling this is the notes-location DENY pilot (pinned to the "notes" root, EARNED DENY); with
    // --ceiling it is the generic forbidden-root family at the requested (non-blocking) rung.
    const dbPath = deps.storePath ?? defaultCe0StorePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const open = deps.openStore ?? openCe0Store;
    const store = open(dbPath);
    try {
      const resolution = resolveObservedSnapshotInScope(store, runtimeScopeId, observedRuleHash as string);
      if (resolution.kind === "NOT_FOUND") {
        err(
          `no observed rule with hash ${observedRuleHash} in runtime scope ${runtimeScopeId}: ` +
            "not found, nothing to attest",
        );
        return 1;
      }
      if (resolution.kind === "COLLISION") {
        err(
          `observed hash ${observedRuleHash} is a collision in scope ${runtimeScopeId}: ` +
            `${resolution.distinctSnapshotCount} distinct snapshots share it; refusing to attest`,
        );
        return 1;
      }
      const conversion =
        requestedCeiling !== undefined
          ? convertForbiddenRootSnapshot(resolution.observedRuleSnapshot, runtimeScopeId, genericCeiling)
          : convertNotesLocationSnapshot(resolution.observedRuleSnapshot, runtimeScopeId);
      if (!conversion.admitted) {
        const what = requestedCeiling !== undefined ? "a forbidden-root rule" : "a supported notes-location rule";
        err(`snapshot is not ${what} (${conversion.reason}): ${conversion.detail}`);
        return 1;
      }
      payload = conversion.payload;
      notesPilot = requestedCeiling === undefined;
    } finally {
      closeCe0Store(store);
    }
  }

  const canonicalPayloadHash = ruleVersionHash(payload);

  // Read the armed authority + root back off the frozen payload, so the display is always accurate
  // regardless of which converter ran.
  const ceiling = payload.enforcementCeiling;
  const forbiddenRootLabel = payload.compliance.config.forbiddenRootRelativePath;
  const ruleLabel = notesPilot ? NOTES_LOCATION_RULE_ID : `forbidden-root:${forbiddenRootLabel}`;

  const audienceNote =
    authorityScope === "TEAM"
      ? "This is a TEAM rule: once LIVE it enforces for every member of the workspace, not just you."
      : "This is a PERSONAL rule: once LIVE it enforces only for you.";
  const identityLabel =
    authorityScope === "TEAM" ? `author ${operator.userId}` : `owner ${operator.userId}`;
  out(ceilingArmingNote(ceiling, scopeLabel, audienceNote));
  out(
    `rule:  ${ruleLabel} (${scopeLabel}, ${identityLabel})\n` +
      `scope: ${runtimeScopeId}\nhash:  ${canonicalPayloadHash}\ntext:  ${payload.text}`,
  );

  if (!(agentOnUserRequest && yes)) {
    const isInteractive = deps.isInteractive ?? defaultIsInteractive;
    if (!isInteractive()) {
      err(
        "refusing to attest non-interactively without confirmation; pass " +
          "--agent-on-user-request --yes to attest on the operator's explicit instruction",
      );
      return 1;
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const ok = await confirm(
      `Attest this ${ceiling} forbidden-root rule for "${forbiddenRootLabel}/" as a ${scopeLabel} rule ` +
        `(runtime scope ${runtimeScopeId})?`,
    );
    if (!ok) {
      err("attestation not confirmed; nothing minted");
      return 1;
    }
  }

  try {
    const node = await mintRule(
      cfg,
      {
        workspaceId: cfg.workspaceId,
        authorityScope,
        ownerUserId,
        projectId: null,
        payload: payload as unknown as Record<string, unknown>,
        // Store the CLI hash verbatim so the read-path re-hash agrees (see runRulesAddBackend).
        canonicalPayloadHash,
        requestIdempotencyKey: canonicalPayloadHash,
      },
      deps.http,
    );
    out(
      `MINTED rule ${node.id} version ${node.currentVersionId} (${canonicalPayloadHash}) ${scopeLabel} ${ceiling}`,
    );
    return 0;
  } catch (e) {
    if (isOffline(e)) {
      err("rules attest failed: backend unreachable; the rule was NOT minted");
      return 1;
    }
    return reportRulesBackendError(e, "rules attest failed", err);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// demote (TEAM -> PERSONAL)
// ───────────────────────────────────────────────────────────────────────────

export interface RulesDemoteBackendDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RuleClientHttp;
  resolveOperator?: () => BackendOperator | null;
  isInteractive?: () => boolean;
  confirm?: (prompt: string) => boolean | Promise<boolean>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `mla rules demote <nodeId>`: lower a TEAM rule to PERSONAL so it enforces for the
 * demoting human alone instead of the whole workspace. The counterpart to `attest --scope team`.
 *
 * A node's authorityScope is IMMUTABLE (rules.service.ts: edit only mints a new payload version,
 * revoke only flips lifecycle; nothing rewrites authorityScopeId). So demote is not an in-place
 * scope bump: it is a MOVE. Mint a PERSONAL copy owned by the operator carrying the TEAM node's
 * exact live payload, then revoke the TEAM node. The new node gets a fresh id; the audit trail is
 * preserved because the personal version records the operator as attestedByUserId (server-stamped,
 * never null). Order is mint-first, revoke-second: if the mint fails the TEAM rule is untouched;
 * if the revoke fails the operator is told the demotion is half-done and how to finish it, so the
 * failure mode is "the rule enforces for MORE people than intended" (recoverable), never "the rule
 * silently stops enforcing for everyone".
 *
 * AUTHORIZATION: any authenticated member can already `revoke` a TEAM rule (personalAclWhere makes
 * every TEAM node visitable + revocable workspace-wide), so demote (strictly less destructive: the
 * rule survives, just for a narrower audience) inherits that exact posture. No new boundary.
 */
export async function runRulesDemoteBackend(argv: string[], deps: RulesDemoteBackendDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  // Pull `--workspace <id>` out FIRST so it is never mistaken for the nodeId, then thread it into
  // loadWorkspaceConfig so the demote targets the named workspace (BUG-3/BUG-4).
  const { workspace, rest, danglingFlag } = extractWorkspaceOverride(argv);
  if (danglingFlag) {
    err(`${danglingFlag} needs a value\n${RULES_DEMOTE_BACKEND_USAGE}`);
    return 2;
  }
  const nodeId = firstPositional(rest);
  if (!nodeId) {
    err(RULES_DEMOTE_BACKEND_USAGE);
    return 2;
  }
  const yes = rest.includes("--yes");

  const resolveOperator = deps.resolveOperator ?? defaultResolveOperator;
  const operator = resolveOperator();
  if (!operator) {
    err("refusing to demote: demoting a binding rule requires an authenticated human (run `mla login`)");
    return 1;
  }

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`rules demote: ${(e as Error).message}`);
    return 2;
  }

  let node: RuleNodeView;
  try {
    node = await getRule(cfg, nodeId, deps.http);
  } catch (e) {
    if (httpStatus(e) === 404) {
      err(`no rule ${nodeId} is visible in this workspace`);
      return 1;
    }
    if (isOffline(e)) {
      err("rules demote failed: backend unreachable; nothing changed");
      return 1;
    }
    return reportRulesBackendError(e, "rules demote failed", err);
  }

  if (lifecycleOf(node) === "REVOKED") {
    err(`rule ${nodeId} is revoked; there is nothing to demote`);
    return 1;
  }
  if (node.authorityScopeId !== "TEAM") {
    err(
      `rule ${nodeId} is ${node.authorityScopeId}, not a TEAM rule; ` +
        "demote only lowers a TEAM rule to PERSONAL",
    );
    return 1;
  }
  if (!node.currentVersionId || !node.currentVersion) {
    err(`rule ${nodeId} has no live version to demote`);
    return 1;
  }

  // Copy the TEAM node's live payload verbatim into the new PERSONAL node: RulePayloadV1 carries no
  // authorityScope/ownerUserId (those are node-level mint args), so it is "the same rule, narrower
  // audience". The idempotency key is the payload hash, recorded on the version for forensics.
  const payload = node.currentVersion.payload as Record<string, unknown>;
  const requestIdempotencyKey = ruleVersionHash(payload as unknown as RulePayloadV1);

  out(
    `demote: TEAM rule ${nodeId} -> a PERSONAL copy owned by ${operator.userId}.\n` +
      `text:  ${payloadText(node)}\n` +
      "after: it enforces for you alone; the team rule is revoked. The audit trail is preserved.",
  );

  if (!yes) {
    const isInteractive = deps.isInteractive ?? defaultIsInteractive;
    if (!isInteractive()) {
      err("refusing to demote non-interactively without --yes (it changes a live rule's blast radius)");
      return 1;
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const ok = await confirm(
      `Demote rule ${nodeId} from TEAM to PERSONAL (it will then enforce for you alone)?`,
    );
    if (!ok) {
      err("demote not confirmed; nothing changed");
      return 1;
    }
  }

  // Step 1: mint the PERSONAL copy. If this fails the TEAM rule is untouched (still enforcing for all).
  let personal: RuleNodeView;
  try {
    personal = await mintRule(
      cfg,
      {
        workspaceId: cfg.workspaceId,
        authorityScope: "PERSONAL",
        ownerUserId: operator.userId,
        projectId: node.projectId,
        payload,
        // Store the CLI hash verbatim so the read-path re-hash agrees (see runRulesAddBackend).
        canonicalPayloadHash: requestIdempotencyKey,
        requestIdempotencyKey,
      },
      deps.http,
    );
  } catch (e) {
    // A membership 403 at the mint step means the copy was never created, so the
    // TEAM rule is still untouched: route to the canonical line (BUG-5) but keep
    // that reassurance instead of a raw wire dump.
    if (isWorkspaceAccessDenied(e)) {
      err(`${workspaceAccessDeniedMessage(e)} (the team rule is untouched)`);
      return 1;
    }
    if (isOffline(e)) {
      err("rules demote failed: backend unreachable; nothing changed (the team rule is untouched)");
      return 1;
    }
    err(`rules demote failed while minting the personal copy: ${(e as Error).message}; the team rule is untouched`);
    return 1;
  }

  // Step 2: revoke the TEAM node (compare-and-swap on the version we read). If this fails the demotion
  // is half-done: the PERSONAL copy exists AND the TEAM rule still enforces for everyone. Tell the
  // operator exactly how to finish, rather than leaving them to discover the double-enforcement.
  try {
    await revokeRule(
      cfg,
      nodeId,
      { workspaceId: cfg.workspaceId, expectedCurrentVersionId: node.currentVersionId },
      deps.http,
    );
  } catch (e) {
    const why =
      httpStatus(e) === 409
        ? "it changed since read (a concurrent edit won the compare-and-swap)"
        : isOffline(e)
          ? "the backend became unreachable"
          : (e as Error).message;
    err(
      `demote is half-done: PERSONAL rule ${personal.id} was minted, but the TEAM rule ${nodeId} was ` +
        `NOT revoked (${why}); it is STILL ACTIVE for the whole workspace. ` +
        `Run \`mla rules revoke ${nodeId}\` to finish the demotion.`,
    );
    return 1;
  }

  out(`DEMOTED rule ${nodeId} (TEAM, revoked) -> ${personal.id} (PERSONAL, owner ${operator.userId})`);
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
// promote (PERSONAL -> TEAM)
// ───────────────────────────────────────────────────────────────────────────

export interface RulesPromoteBackendDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RuleClientHttp;
  resolveOperator?: () => BackendOperator | null;
  isInteractive?: () => boolean;
  confirm?: (prompt: string) => boolean | Promise<boolean>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `mla rules promote <nodeId>`: raise a PERSONAL rule to TEAM so it enforces for the whole
 * workspace instead of the owning human alone. The exact inverse of `demote`, and the operator-facing
 * complement to the PERSONAL-default `add`.
 *
 * A node's authorityScope is IMMUTABLE (rules.service.ts: edit only mints a new payload version,
 * revoke only flips lifecycle; nothing rewrites authorityScopeId). So promote is not an in-place scope
 * bump: it is a MOVE. Mint a TEAM copy (ownerUserId null) carrying the PERSONAL node's exact live
 * payload, then revoke the PERSONAL node. The new node gets a fresh id; the audit trail is preserved
 * because the team version records the operator as attestedByUserId (server-stamped, never null). Order
 * is mint-first, revoke-second: if the mint fails the PERSONAL rule is untouched; if the revoke fails
 * the operator is told the promotion is half-done and how to finish it, so the failure mode is "the
 * rule enforces for MORE people than intended plus a redundant personal copy" (recoverable), never "the
 * rule silently stops enforcing".
 *
 * AUTHORIZATION: a PERSONAL rule is owner-private (personalAclWhere hides it from everyone but the
 * owner), so only the owner can even read it here; a non-owner's promote 404s at the getRule step.
 * The explicit owner guard below is defense in depth with a clear message.
 */
export async function runRulesPromoteBackend(argv: string[], deps: RulesPromoteBackendDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  // Pull `--workspace <id>` out FIRST so it is never mistaken for the nodeId, then thread it into
  // loadWorkspaceConfig so the promote targets the named workspace (BUG-3/BUG-4).
  const { workspace, rest, danglingFlag } = extractWorkspaceOverride(argv);
  if (danglingFlag) {
    err(`${danglingFlag} needs a value\n${RULES_PROMOTE_BACKEND_USAGE}`);
    return 2;
  }
  const nodeId = firstPositional(rest);
  if (!nodeId) {
    err(RULES_PROMOTE_BACKEND_USAGE);
    return 2;
  }
  const yes = rest.includes("--yes");

  const resolveOperator = deps.resolveOperator ?? defaultResolveOperator;
  const operator = resolveOperator();
  if (!operator) {
    err("refusing to promote: promoting a binding rule requires an authenticated human (run `mla login`)");
    return 1;
  }

  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)(workspace);
  } catch (e) {
    err(`rules promote: ${(e as Error).message}`);
    return 2;
  }

  let node: RuleNodeView;
  try {
    node = await getRule(cfg, nodeId, deps.http);
  } catch (e) {
    if (httpStatus(e) === 404) {
      err(`no rule ${nodeId} is visible in this workspace`);
      return 1;
    }
    if (isOffline(e)) {
      err("rules promote failed: backend unreachable; nothing changed");
      return 1;
    }
    return reportRulesBackendError(e, "rules promote failed", err);
  }

  if (lifecycleOf(node) === "REVOKED") {
    err(`rule ${nodeId} is revoked; there is nothing to promote`);
    return 1;
  }
  if (node.authorityScopeId !== "PERSONAL") {
    err(
      `rule ${nodeId} is ${node.authorityScopeId}, not a PERSONAL rule; ` +
        "promote only raises a PERSONAL rule to TEAM",
    );
    return 1;
  }
  if (node.ownerUserId && node.ownerUserId !== operator.userId) {
    err(
      `rule ${nodeId} is owned by ${node.ownerUserId}, not you; ` +
        "you can only promote your own personal rule",
    );
    return 1;
  }
  if (!node.currentVersionId || !node.currentVersion) {
    err(`rule ${nodeId} has no live version to promote`);
    return 1;
  }

  // Copy the PERSONAL node's live payload verbatim into the new TEAM node: RulePayloadV1 carries no
  // authorityScope/ownerUserId (those are node-level mint args), so it is "the same rule, wider
  // audience". The idempotency key is the payload hash, recorded on the version for forensics.
  const payload = node.currentVersion.payload as Record<string, unknown>;
  const requestIdempotencyKey = ruleVersionHash(payload as unknown as RulePayloadV1);

  out(
    `promote: PERSONAL rule ${nodeId} -> a TEAM copy (owned by no one).\n` +
      `text:  ${payloadText(node)}\n` +
      "after: it enforces for the whole workspace; your personal rule is revoked. The audit trail is preserved.",
  );

  if (!yes) {
    const isInteractive = deps.isInteractive ?? defaultIsInteractive;
    if (!isInteractive()) {
      err("refusing to promote non-interactively without --yes (it enforces the rule workspace-wide)");
      return 1;
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const ok = await confirm(
      `Promote rule ${nodeId} from PERSONAL to TEAM (it will then enforce for the whole workspace)?`,
    );
    if (!ok) {
      err("promote not confirmed; nothing changed");
      return 1;
    }
  }

  // Step 1: mint the TEAM copy. If this fails the PERSONAL rule is untouched (still enforcing for you).
  let team: RuleNodeView;
  try {
    team = await mintRule(
      cfg,
      {
        workspaceId: cfg.workspaceId,
        authorityScope: "TEAM",
        ownerUserId: null,
        projectId: node.projectId,
        payload,
        // Store the CLI hash verbatim so the read-path re-hash agrees (see runRulesAddBackend).
        canonicalPayloadHash: requestIdempotencyKey,
        requestIdempotencyKey,
      },
      deps.http,
    );
  } catch (e) {
    // A membership 403 at the mint step means the copy was never created, so the
    // PERSONAL rule is still untouched: route to the canonical line (BUG-5) but keep
    // that reassurance instead of a raw wire dump.
    if (isWorkspaceAccessDenied(e)) {
      err(`${workspaceAccessDeniedMessage(e)} (your personal rule is untouched)`);
      return 1;
    }
    if (isOffline(e)) {
      err("rules promote failed: backend unreachable; nothing changed (your personal rule is untouched)");
      return 1;
    }
    err(`rules promote failed while minting the team copy: ${(e as Error).message}; your personal rule is untouched`);
    return 1;
  }

  // Step 2: revoke the PERSONAL node (compare-and-swap on the version we read). If this fails the
  // promotion is half-done: the TEAM copy exists AND the PERSONAL rule still enforces for you. The net
  // is over-enforcement (the whole team, which includes you, plus a redundant personal copy), which is
  // safe; tell the operator exactly how to remove the leftover, rather than leave them to find it.
  try {
    await revokeRule(
      cfg,
      nodeId,
      { workspaceId: cfg.workspaceId, expectedCurrentVersionId: node.currentVersionId },
      deps.http,
    );
  } catch (e) {
    const why =
      httpStatus(e) === 409
        ? "it changed since read (a concurrent edit won the compare-and-swap)"
        : isOffline(e)
          ? "the backend became unreachable"
          : (e as Error).message;
    err(
      `promote is half-done: TEAM rule ${team.id} was minted (it now enforces workspace-wide), but the ` +
        `PERSONAL rule ${nodeId} was NOT revoked (${why}); it is STILL ACTIVE as a redundant copy for you. ` +
        `Run \`mla rules revoke ${nodeId}\` to finish the promotion.`,
    );
    return 1;
  }

  out(`PROMOTED rule ${nodeId} (PERSONAL, revoked) -> ${team.id} (TEAM)`);
  return 0;
}

// ───────────────────────────────────────────────────────────────────────────
// remove (unsupported)
// ───────────────────────────────────────────────────────────────────────────

/**
 * `mla rules remove`: unsupported. Post-cutover, `.meetless/rules.md` is a read
 * projection, not an authority (§7), so there is nothing local to remove. Point the operator
 * at `revoke <nodeId>`, the backend kill switch.
 */
export function runRulesRemoveBackend(_argv: string[], deps: { err?: (l: string) => void } = {}): number {
  const err = deps.err ?? ((l: string) => console.error(l));
  err(
    "`mla rules remove` is unsupported with the backend rule store: `.meetless/rules.md` is no " +
      "longer an authority. Revoke a backend rule with `mla rules revoke <nodeId>`.",
  );
  return 2;
}
