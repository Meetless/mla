import { readConfig, CliConfig, getConsoleUrl, consoleDeepLinkFrom } from "../lib/config";
import { resolveWorkspaceId } from "../lib/workspace";
import { intelGet, HttpError, DEFAULT_INTEL_URL } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import { openUrl } from "../lib/open-url";
import {
  parseArtifactInput,
  ArtifactInputError,
  ArtifactInput,
} from "../lib/artifact_id";
import {
  KbShowView,
  KbShowRevision,
  KbShowChunkPreview,
  KbShowClaimPreview,
  KbShowAuditEntry,
  renderKbShow,
} from "../lib/render";

// `mla kb show <input>` (kb-console re-home, notes/20260621-kb-console-rehome-two-axis.md).
//
// Read-only. Calls two intel routes:
//   1. GET /internal/v1/kb/documents/resolve?workspaceId=<ws>&path=<canonical>
//      Only when the operator passed a bare path or `note:<path>`. Skipped
//      for `kbdoc:<id>` because we already have the id.
//   2. GET /internal/v1/kb/documents/{document_id}/detail?workspaceId=<ws>
//      Returns the document-centric bundle: identity + the governed-liveness
//      rollup (serving / servingStatus), the full revision chain, the head
//      revision's chunk + claim rails, and the unified audit timeline.
//
// The re-homed detail route takes ONLY `workspaceId`; the bundle is whole, so
// there are no server-side revision / audit / chunk knobs. `--all` and
// `--audit-all` truncate the revision + audit sections CLIENT-side.
//
// Relationship edges (the old candidates / promoted-edge sections) are no
// longer part of this bundle: intel re-homed them to the navigation lane
// (F1A/F2, §3.2). The Console is the human surface for reviewing them, so the
// edge-oriented flags (--posture, --include-tombstoned) and the per-edge
// point-in-time flag (--as-of) are gone; they hard-error with a pointer.
//
// kbdocrev:<id> is rejected at parse-time. The detail endpoint is
// document-scoped; revision detail is surfaced inside the document view.

interface KbShowFlags {
  input: string;
  workspace?: string;
  json: boolean;
  all: boolean;
  auditAll: boolean;
  open: boolean;
}

const VALUE_FLAGS = new Set(["--workspace"]);
const BOOLEAN_FLAGS = new Set(["--json", "--all", "--audit-all", "--open"]);

// Edge-oriented flags removed when relationships left the detail bundle. Kept
// as explicit hard errors (not "unknown flag") so an operator relying on the
// old point-in-time safety guarantee gets a clear pointer instead of a silent
// fall-through to a live "now" view.
const REMOVED_FLAGS: Record<string, string> = {
  "--as-of":
    "`--as-of` is no longer supported by `mla kb show`. It filtered relationship edges by their validity window, and edges moved out of the detail view into the Console relationships lane.",
  "--posture":
    "`--posture` is no longer supported by `mla kb show`. It filtered relationship edges, which moved out of the detail view into the Console relationships lane.",
  "--include-tombstoned":
    "`--include-tombstoned` is no longer supported by `mla kb show`. It only affected relationship edges, which moved out of the detail view into the Console relationships lane.",
};

// How many revisions / claims / audit rows the human view shows before it
// truncates. The server returns the WHOLE bundle; these caps are client-side so
// a 60-claim doc does not flood the terminal. --all / --audit-all lift them.
const REVISION_LIMIT_DEFAULT = 20;
const REVISION_LIMIT_ALL = 200;
const CLAIM_PREVIEW_DEFAULT = 8;
const CHUNK_PREVIEW_DEFAULT = 5;
const AUDIT_LIMIT_DEFAULT = 10;
const AUDIT_LIMIT_ALL = 500;

export function parseKbShowArgs(argv: string[]): KbShowFlags {
  const out: Partial<KbShowFlags> = {
    json: false,
    all: false,
    auditAll: false,
    open: false,
  };
  let positional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (REMOVED_FLAGS[a]) {
      throw new Error(REMOVED_FLAGS[a]);
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`Missing value for ${a}`);
      }
      if (v.startsWith("--") || v.startsWith("-")) {
        throw new Error(
          `Missing value for ${a} (got the next flag ${v} instead)`,
        );
      }
      switch (a) {
        case "--workspace":
          out.workspace = v;
          break;
      }
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      if (a === "--json") out.json = true;
      else if (a === "--all") out.all = true;
      else if (a === "--audit-all") out.auditAll = true;
      else if (a === "--open") out.open = true;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. Supported flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ")}`,
      );
    }
    if (positional !== null) {
      throw new Error(
        `\`mla kb show\` takes exactly one positional <input> (got '${positional}' and '${a}')`,
      );
    }
    positional = a;
  }

  if (positional === null) {
    throw new Error(
      "`mla kb show` requires a positional <input> (kbdoc:<id> or a note path)",
    );
  }
  return {
    input: positional,
    workspace: out.workspace,
    json: !!out.json,
    all: !!out.all,
    auditAll: !!out.auditAll,
    open: !!out.open,
  };
}

interface ResolveResponse {
  documentId: string;
  canonicalPath: string;
  tombstoneState: string;
  tombstonedAt: string | null;
}

// The reshaped detail bundle (intel's KbDocumentDetail; mirrors console
// lib/server/kb-api.ts). Document-centric: identity + governed-liveness rollup
// + full revision chain + the head revision's chunk & claim rails + audit.

interface DetailDocument {
  documentId: string;
  workspaceId: string;
  ownerUserId: string;
  sourceSystem: string;
  sourceTenantId: string;
  externalObjectId: string;
  // Access axis: PERSON ("Personal") | WORKSPACE ("Shared").
  scope: string;
  currentRevisionId: string | null;
  headGeneration: number;
  // Lifecycle axis (document side): ACTIVE | TOMBSTONED | PURGED.
  tombstoneState: string;
}

interface DetailRevision {
  revisionId: string;
  documentId: string;
  // Lifecycle axis: INGESTING | ACTIVE | SUPERSEDED | FAILED.
  status: string;
  // Trust axis: PENDING | ACCEPTED | REJECTED.
  reviewOutcome: string;
  scopeAtIngest: string;
  // Provenance axis (origin label): human_authored | agent_distilled | ...
  provenance: string;
  // Provenance axis (actor): human | agent | tool | import.
  actorType: string;
  rawContentHash: string;
  normalizedContentHash: string;
  contentNormalizationVersion: string;
  externalRevisionId: string | null;
  // Redaction axis: NONE | REDACTED.
  redactionState: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

interface DetailChunk {
  chunkId: string;
  revisionId: string;
  runId: string;
  normalizedContentHash: string;
  startOffset: number;
  endOffset: number;
  normalizationVersion: string;
  // Normalized-content slice; null when the source revision is REDACTED.
  indexedText: string | null;
  createdAt: string;
}

interface DetailClaim {
  claimId: string;
  sourceRevisionId: string;
  ontologyRunId: string;
  claimExtractionKind: string;
  verbatimText: string;
  normalizedText: string | null;
  groundingStatus: string;
  reviewOutcome: string | null;
  // Lifecycle: ACTIVE | RETIRED | SUPERSEDED | REJECTED | ...
  lifecycleStatus: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
}

interface DetailAuditReview {
  reviewEventId: string;
  eventSequence: number;
  targetKind: string;
  targetId: string;
  priorOutcome: string;
  newOutcome: string;
  reviewMethod: string;
}

interface DetailAuditLifecycle {
  lifecycleEventId: string;
  eventSequence: number;
  // TOMBSTONE | REDACT.
  eventKind: string;
  revisionId: string | null;
  reason: string | null;
}

interface DetailAuditEntry {
  // REVIEW | LIFECYCLE. Exactly one of review / lifecycle is populated.
  entryKind: string;
  actorId: string;
  occurredAt: string;
  review: DetailAuditReview | null;
  lifecycle: DetailAuditLifecycle | null;
}

interface DetailResponse {
  document: DetailDocument;
  // Authoritative governed-liveness rollup; never re-derived client-side.
  serving: boolean;
  // Lifecycle classification behind serving: SERVING | NO_HEAD | NO_SERVING_REVISION.
  servingStatus: string;
  // The current head when activated; null before the first activation.
  headRevision: DetailRevision | null;
  // Newest-first.
  revisions: DetailRevision[];
  // Flat, ordered by startOffset (head revision's chunks).
  chunks: DetailChunk[];
  // Flat, ordered by startOffset.
  claims: DetailClaim[];
  // Oldest-first unified timeline: trust verdicts + lifecycle mutations.
  audit: DetailAuditEntry[];
}

function explainIntelError(err: HttpError, intelUrl: string): string {
  if (err.status === 404) {
    return err.body && err.body.includes("KB_DOCUMENT_PATH_NOT_FOUND")
      ? `No KbDocument matches that path in the requested workspace. Try \`mla kb dump\` to list ingested sources.`
      : err.body && err.body.includes("KB_DOCUMENT_NOT_FOUND")
        ? `No KbDocument matches that id in the requested workspace.`
        : `intel returned 404. ${err.body.slice(0, 200)}`;
  }
  // Membership 403 (folder marker / --workspace names a workspace you are not
  // in) is not a token problem; route it to the shared canonical line (BUG-5).
  if (isWorkspaceAccessDenied(err)) {
    return workspaceAccessDeniedMessage(err);
  }
  if (err.status === 401 || err.status === 403) {
    return `intel rejected the token (HTTP ${err.status}). Run \`mla doctor\` to check your login and workspace access.`;
  }
  if (err.status === undefined) {
    return `intel not reachable at ${intelUrl}. Is it running? Try \`mla doctor\`.`;
  }
  return err.message;
}

function toShowRevision(r: DetailRevision): KbShowRevision {
  return {
    id: r.revisionId,
    status: r.status,
    reviewOutcome: r.reviewOutcome,
    provenance: r.provenance,
    actorType: r.actorType,
    scopeAtIngest: r.scopeAtIngest,
    rawContentHash: r.rawContentHash,
    normalizedContentHash: r.normalizedContentHash,
    contentNormalizationVersion: r.contentNormalizationVersion,
    externalRevisionId: r.externalRevisionId,
    redactionState: r.redactionState,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
  };
}

function toShowChunk(c: DetailChunk): KbShowChunkPreview {
  // Offsets are retained even when the source revision is REDACTED (text
  // withheld), so the offset delta is the stable "size" and redacted chunks
  // still count toward the byte total.
  return {
    id: c.chunkId,
    revisionId: c.revisionId,
    startOffset: c.startOffset,
    endOffset: c.endOffset,
    bytes: c.endOffset - c.startOffset,
    redacted: c.indexedText === null,
    preview: c.indexedText ?? "",
  };
}

function toShowClaim(c: DetailClaim): KbShowClaimPreview {
  return {
    id: c.claimId,
    kind: c.claimExtractionKind,
    groundingStatus: c.groundingStatus,
    reviewOutcome: c.reviewOutcome,
    lifecycleStatus: c.lifecycleStatus,
    preview: c.verbatimText,
  };
}

function summarizeAudit(a: DetailAuditEntry): string {
  if (a.entryKind === "REVIEW" && a.review) {
    const r = a.review;
    return `${r.targetKind} ${r.priorOutcome} -> ${r.newOutcome} (${r.reviewMethod})`;
  }
  if (a.entryKind === "LIFECYCLE" && a.lifecycle) {
    const l = a.lifecycle;
    return l.reason ? `${l.eventKind}: ${l.reason}` : l.eventKind;
  }
  return a.entryKind;
}

function toAuditEntry(a: DetailAuditEntry): KbShowAuditEntry {
  return {
    entryKind: a.entryKind,
    actorId: a.actorId,
    occurredAt: a.occurredAt,
    summary: summarizeAudit(a),
  };
}

function buildShowView(resp: DetailResponse, flags: KbShowFlags): KbShowView {
  // The server returns the WHOLE bundle (no pagination on the re-homed route);
  // truncation is client-side so a large doc does not flood the terminal.
  const revisionLimit = flags.all ? REVISION_LIMIT_ALL : REVISION_LIMIT_DEFAULT;
  const auditLimit = flags.auditAll ? AUDIT_LIMIT_ALL : AUDIT_LIMIT_DEFAULT;
  const claimLimit = flags.all ? resp.claims.length : CLAIM_PREVIEW_DEFAULT;

  const totalBytes = resp.chunks.reduce(
    (sum, c) => sum + (c.endOffset - c.startOffset),
    0,
  );

  return {
    workspaceId: resp.document.workspaceId,
    document: {
      id: resp.document.documentId,
      ownerUserId: resp.document.ownerUserId,
      sourceSystem: resp.document.sourceSystem,
      sourceTenantId: resp.document.sourceTenantId,
      externalObjectId: resp.document.externalObjectId,
      scope: resp.document.scope,
      currentRevisionId: resp.document.currentRevisionId,
      headGeneration: resp.document.headGeneration,
      tombstoneState: resp.document.tombstoneState,
    },
    serving: resp.serving,
    servingStatus: resp.servingStatus,
    headRevision: resp.headRevision ? toShowRevision(resp.headRevision) : null,
    revisionHistory: resp.revisions.slice(0, revisionLimit).map(toShowRevision),
    revisionHistoryTruncated: resp.revisions.length > revisionLimit,
    chunks: {
      totalCount: resp.chunks.length,
      totalBytes,
      preview: resp.chunks.slice(0, CHUNK_PREVIEW_DEFAULT).map(toShowChunk),
    },
    claims: {
      totalCount: resp.claims.length,
      preview: resp.claims.slice(0, claimLimit).map(toShowClaim),
    },
    audit: resp.audit.slice(0, auditLimit).map(toAuditEntry),
    auditTruncated: resp.audit.length > auditLimit,
  };
}

async function resolveToDocumentId(
  cfg: CliConfig,
  workspaceId: string,
  input: ArtifactInput,
  intelUrl: string,
): Promise<string> {
  if (input.kind === "kbdoc") {
    return input.id;
  }
  if (input.kind === "kbdocrev") {
    throw new Error(
      "`mla kb show` does not accept kbdocrev:<id>. Pass the parent kbdoc:<id> or the note path; revision details are rendered inside the document view.",
    );
  }
  const qs = new URLSearchParams({
    workspaceId,
    path: input.path,
  }).toString();
  try {
    const r = await intelGet<ResolveResponse>(
      cfg,
      `/internal/v1/kb/documents/resolve?${qs}`,
      10000,
    );
    return r.documentId;
  } catch (e) {
    const err = e as HttpError;
    throw new Error(explainIntelError(err, intelUrl));
  }
}

export async function runKbShow(argv: string[]): Promise<number> {
  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let flags: KbShowFlags;
  try {
    flags = parseKbShowArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let input: ArtifactInput;
  try {
    input = parseArtifactInput(flags.input);
  } catch (e) {
    const msg =
      e instanceof ArtifactInputError ? e.message : (e as Error).message;
    console.error(msg);
    return 2;
  }

  // Folder = workspace (T1.1): the workspace comes from the nearest marker;
  // `--workspace <id>` overrides it (admin cross-workspace inspection) and
  // short-circuits marker resolution so an unbound directory does not block it.
  let workspaceId: string;
  try {
    workspaceId = flags.workspace || resolveWorkspaceId();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const intelUrl = cfg.intelUrl || DEFAULT_INTEL_URL;

  let documentId: string;
  try {
    documentId = await resolveToDocumentId(cfg, workspaceId, input, intelUrl);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  // The re-homed detail route takes ONLY workspaceId; the bundle is whole, so
  // there are no revision / audit / chunk knobs to forward. --all / --audit-all
  // truncate client-side in buildShowView.
  const qs = new URLSearchParams({ workspaceId }).toString();

  let detail: DetailResponse;
  try {
    detail = await intelGet<DetailResponse>(
      cfg,
      `/internal/v1/kb/documents/${encodeURIComponent(documentId)}/detail?${qs}`,
      15000,
    );
  } catch (e) {
    console.error(explainIntelError(e as HttpError, intelUrl));
    return 1;
  }

  const view = buildShowView(detail, flags);
  // B4a: always surface the Console review URL. The renderer stays pure, so the
  // command layer resolves it and stamps it on the view. Pin the resolved
  // workspaceId (cfg here is a bare readConfig() without it) so the link lands in
  // THIS workspace, not whichever one the Console session happens to be bound to.
  view.consoleUrl = consoleDeepLinkFrom(getConsoleUrl(cfg), workspaceId, "/relationships");

  if (flags.json) {
    console.log(JSON.stringify(view, null, 2));
  } else {
    console.log(renderKbShow(view));
  }

  // B4b: `--open` is opt-in (never auto-open; the URL is always printed above). The
  // status note goes to stderr so it never pollutes `--json` stdout.
  if (flags.open && view.consoleUrl) {
    const res = openUrl(view.consoleUrl);
    if (res.ok) console.error(`opened ${view.consoleUrl} in your browser`);
    else console.error(`could not open a browser (${res.error}); the URL is above`);
  }

  return 0;
}
