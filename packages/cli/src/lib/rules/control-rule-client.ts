/**
 * The CLI's typed client for the unified backend rule store
 * (notes/20260627-rules-store-unification-backend-sot-proposal.md §4, §5.1, §6.1, §7).
 *
 * This is the ONE place the CLI knows the native Rule API: every `/internal/v1/rules*`
 * path, request body, and response shape lives here, mirrored from the control DTOs and
 * service so a path or field rename surfaces as a compile error in exactly one module.
 * The verbs map 1:1 to RulesController:
 *
 *   importRules  -> POST   /internal/v1/rules/import        (G2 one-time importer)
 *   mintRule     -> POST   /internal/v1/rules               (§5.1 mint v1)
 *   listRules    -> GET    /internal/v1/rules               (§4 list)
 *   getRule      -> GET    /internal/v1/rules/:ruleId        (§4 detail)
 *   editRule     -> PATCH  /internal/v1/rules/:ruleId        (§4.1 mint-next; carries
 *                                                             expectedCurrentVersionId)
 *   revokeRule   -> POST   /internal/v1/rules/:ruleId/revoke (§4.3 compare-and-swap)
 *   getBundle    -> GET    /internal/v1/rules/bundle         (§6.1 principal bundle)
 *
 * It is a THIN transport shell over lib/http.ts: it builds the path + query, forwards
 * the body verbatim, and types the result. It does NOT compute hashes, resolve actors,
 * or make policy decisions: the backend resolves the acting human server-side (§5.1) and
 * the payloads are produced upstream (the import mapper, the attest/edit slices). The
 * http verbs are injectable (last param) so the client is unit-testable with no network;
 * commands inject their own seam on top of this, matching the publish bridge convention.
 *
 * `workspaceId` is sent on every call. A cli-session caller is pinned to its session
 * workspace by the backend (the supplied value must match or the tenant guard 403s); an
 * internal-key caller needs it to scope the write. Sending cfg.workspaceId satisfies both.
 */
import type { WorkspaceCliConfig } from "../config";
import { get, patch, post } from "../http";

// ───────────────────────────────────────────────────────────────────────────
// Shared enums (mirrored from @meetless/utils; the CLI has no dependency on the
// control package, so the closed unions are restated here as the wire contract).
// ───────────────────────────────────────────────────────────────────────────

/** Ownership/visibility scope. PERSONAL requires an ownerUserId (§4.1). */
export type RuleAuthorityScope = "PERSONAL" | "TEAM" | "ORGANIZATION";

/** A RuleNode's lifecycle on the backend. */
export type RuleLifecycleStatus = "ACTIVE" | "REVOKED";

// ───────────────────────────────────────────────────────────────────────────
// Importer (G2): mirrors ImportRulesDto / ImportRulesResult.
// ───────────────────────────────────────────────────────────────────────────

/** One historical version to import, oldest-first within its rule. */
export interface ImportRuleVersionInput {
  /** Legacy versionId, preserved verbatim so a historical citation still resolves. */
  sourceVersionId: string;
  /** Legacy content hash, preserved verbatim (integrity + cross-run idempotency). */
  canonicalPayloadHash: string;
  /** The version payload (RulePayloadV1), stored verbatim. */
  payload: Record<string, unknown>;
  /** Historical attestor; null for versions that predate actor capture. */
  attestedByUserId?: string | null;
  /** Historical attestation timestamp (ISO 8601). */
  attestedAt: string;
}

/** One legacy rule (node identity + full version history) to import. */
export interface ImportRuleInput {
  /** Stable legacy rule identity (managedRuleId or CE0 rule id). */
  sourceRuleId: string;
  authorityScope: RuleAuthorityScope;
  /** Required iff authorityScope === PERSONAL; null otherwise. */
  ownerUserId?: string | null;
  /** Optional applicability boundary (an activated projectId); null = cross-project. */
  projectId?: string | null;
  /** Final node lifecycle: ACTIVE (binds currentSourceVersionId) or REVOKED. */
  lifecycleStatus: RuleLifecycleStatus;
  /** The live version's sourceVersionId; required when ACTIVE, null when REVOKED. */
  currentSourceVersionId?: string | null;
  /** Oldest-first; the supersedes chain is reconstructed in this order. */
  versions: ImportRuleVersionInput[];
}

export interface ImportRulesBody {
  workspaceId: string;
  rules: ImportRuleInput[];
}

/** One rule the importer refused (same sourceVersionId, different hash). */
export interface ImportRuleConflict {
  sourceRuleId: string;
  sourceVersionId: string;
  reason: string;
  existingHash: string;
  incomingHash: string;
}

/** The importer's batch outcome (mirrors RulesImportService.ImportRulesResult). */
export interface ImportRulesResult {
  rulesReceived: number;
  rulesImported: number;
  rulesSkipped: number;
  rulesConflicted: number;
  versionsMinted: number;
  versionsSkipped: number;
  conflicts: ImportRuleConflict[];
}

// ───────────────────────────────────────────────────────────────────────────
// Native CRUD (§4, §5.1): mirrors the RuleNodeWithCurrent JSON shape. Dates are
// ISO strings over the wire; Prisma's Date serializes to a string in the response.
// ───────────────────────────────────────────────────────────────────────────

/** One immutable rule version, as the backend serializes it. */
export interface RuleVersionView {
  id: string;
  ruleId: string;
  payload: unknown;
  canonicalPayloadHash: string;
  supersedesVersionId: string | null;
  attestedByUserId: string | null;
  attestedAt: string;
  requestIdempotencyKey: string | null;
}

/** A RuleNode with its current live version (the mint/edit/revoke/get/list shape). */
export interface RuleNodeView {
  id: string;
  workspaceId: string;
  authorityScopeId: string;
  ownerUserId: string | null;
  projectId: string | null;
  lifecycleStatusId: string;
  currentVersionId: string | null;
  currentVersion: RuleVersionView | null;
}

export interface MintRuleBody {
  workspaceId: string;
  authorityScope: RuleAuthorityScope;
  ownerUserId?: string | null;
  projectId?: string | null;
  payload: Record<string, unknown>;
  /**
   * The CLI-computed ruleVersionHash of `payload`. The backend stores it VERBATIM as
   * the version's canonicalPayloadHash so the read-path re-hash (verifyEntryIntegrity)
   * agrees. Without it the backend recomputes with a generic preserve-order canonicalizer
   * that diverges from the CLI's set-sort + NFC hash on multi-element set fields (e.g. a
   * turn trigger's promptAny), silently dropping the rule at bundle-verify time.
   */
  canonicalPayloadHash?: string | null;
  requestIdempotencyKey?: string | null;
}

export interface EditRuleBody {
  workspaceId: string;
  /** Optimistic-concurrency token: the version the caller believes is current (§4.3). */
  expectedCurrentVersionId: string;
  payload: Record<string, unknown>;
  /** CLI-computed ruleVersionHash of `payload`, stored verbatim (see MintRuleBody). */
  canonicalPayloadHash?: string | null;
  requestIdempotencyKey?: string | null;
}

export interface RevokeRuleBody {
  workspaceId: string;
  expectedCurrentVersionId: string;
}

export interface ListRulesQuery {
  /** Optional lifecycle filter (ACTIVE | REVOKED). */
  lifecycleStatus?: RuleLifecycleStatus;
}

// ───────────────────────────────────────────────────────────────────────────
// Bundle (§6.1): mirrors apps/control/src/rules/rule-bundle.ts verbatim.
// ───────────────────────────────────────────────────────────────────────────

/** One human-attested LIVE rule version, as it appears in the bundle. */
export interface RuleBundleEntry {
  ruleNodeId: string;
  ruleVersionId: string;
  authorityScope: string;
  ownerUserId: string | null;
  projectId: string | null;
  payload: unknown;
  canonicalPayloadHash: string;
  attestedByUserId: string | null;
  attestedAt: string;
  supersedesVersionId: string | null;
}

/** The §6.1 bundle shape, principal- and project-bound. */
export interface RuleBundle {
  schemaVersion: number;
  principalUserId: string | null;
  workspaceId: string;
  projectId: string | null;
  bundleRevision: number;
  generatedAt: string;
  validUntil: string;
  rules: RuleBundleEntry[];
}

export interface GetBundleQuery {
  /** The activated projectId to resolve applicability against; omit for none. */
  projectId?: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Transport
// ───────────────────────────────────────────────────────────────────────────

/** The http verbs this client needs; injectable so it is testable with no network. */
export interface RuleClientHttp {
  get: typeof get;
  post: typeof post;
  patch: typeof patch;
}

const defaultHttp: RuleClientHttp = { get, post, patch };

const BASE = "/internal/v1/rules";

/** Append a query string to BASE, dropping null/undefined/empty params. */
function withQuery(path: string, params: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      qs.set(key, value);
    }
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/**
 * Run the one-time importer (G2). Returns the per-batch outcome including any
 * per-rule conflicts; an HTTP error (network / 4xx / 5xx) rejects.
 */
export async function importRules(
  cfg: WorkspaceCliConfig,
  body: ImportRulesBody,
  http: RuleClientHttp = defaultHttp,
): Promise<ImportRulesResult> {
  return http.post<ImportRulesResult>(cfg, `${BASE}/import`, body);
}

/** Mint a new rule (v1). The acting human is resolved server-side from the session. */
export async function mintRule(
  cfg: WorkspaceCliConfig,
  body: MintRuleBody,
  http: RuleClientHttp = defaultHttp,
): Promise<RuleNodeView> {
  return http.post<RuleNodeView>(cfg, BASE, body);
}

/** List rules in the workspace, newest-first per the backend ordering. */
export async function listRules(
  cfg: WorkspaceCliConfig,
  query: ListRulesQuery = {},
  http: RuleClientHttp = defaultHttp,
): Promise<RuleNodeView[]> {
  const path = withQuery(BASE, {
    workspaceId: cfg.workspaceId,
    lifecycleStatus: query.lifecycleStatus,
  });
  return http.get<RuleNodeView[]>(cfg, path);
}

/**
 * Read one rule plus its live version; rejects 404 when the rule is not visible.
 *
 * Carries workspaceId as the marker (exactly like listRules/getBundle) so the
 * cli-session tenant guard resolves effectiveWorkspaceId to cfg.workspaceId. GET
 * carries no body, so without this query param the guard would fall back to the
 * session HOME workspace and 404 on any non-home rule. That silently broke the
 * `edit`/`revoke` preflight for every non-home target (folder marker OR
 * --workspace) -- the BUG-4 migration path (list --workspace + revoke --workspace).
 */
export async function getRule(
  cfg: WorkspaceCliConfig,
  ruleId: string,
  http: RuleClientHttp = defaultHttp,
): Promise<RuleNodeView> {
  const path = withQuery(`${BASE}/${encodeURIComponent(ruleId)}`, {
    workspaceId: cfg.workspaceId,
  });
  return http.get<RuleNodeView>(cfg, path);
}

/**
 * Mint the NEXT version of an existing rule (§4.1: PATCH means mint-next, never
 * overwrite). Carries expectedCurrentVersionId; a stale token yields 409.
 */
export async function editRule(
  cfg: WorkspaceCliConfig,
  ruleId: string,
  body: EditRuleBody,
  http: RuleClientHttp = defaultHttp,
): Promise<RuleNodeView> {
  return http.patch<RuleNodeView>(cfg, `${BASE}/${encodeURIComponent(ruleId)}`, body);
}

/** Revoke a rule (compare-and-swap to REVOKED). A stale token yields 409. */
export async function revokeRule(
  cfg: WorkspaceCliConfig,
  ruleId: string,
  body: RevokeRuleBody,
  http: RuleClientHttp = defaultHttp,
): Promise<RuleNodeView> {
  return http.post<RuleNodeView>(cfg, `${BASE}/${encodeURIComponent(ruleId)}/revoke`, body);
}

/** Fetch the §6.1 principal-bound bundle for the authenticated session + project. */
export async function getBundle(
  cfg: WorkspaceCliConfig,
  query: GetBundleQuery = {},
  http: RuleClientHttp = defaultHttp,
): Promise<RuleBundle> {
  const path = withQuery(`${BASE}/bundle`, {
    workspaceId: cfg.workspaceId,
    projectId: query.projectId,
  });
  return http.get<RuleBundle>(cfg, path);
}
