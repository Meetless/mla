import { readConfig, CliConfig } from "../lib/config";
import { resolveWorkspaceId } from "../lib/workspace";
import { intelGet, HttpError, DEFAULT_INTEL_URL } from "../lib/http";
import {
  parseArtifactInput,
  ArtifactInputError,
  ArtifactInput,
} from "../lib/artifact_id";

// `mla kb tensions <ref>` (T1, platform roadmap Phase 0).
//
// Read-only. Surfaces the CONTRADICTS / SUPERSEDES relationship edges that touch <ref>'s
// claims, together with the counterpart document. Every edge is banded DETECTED: a
// machine-detected, pre-serve edge INDEPENDENT of the human verdict, which is exactly the
// Gate-0 question ("is the detector output any good?"). The real verdict travels alongside
// as `reviewOutcome` (PENDING | ACCEPTED | REJECTED), so a REJECTED edge is a false
// contradiction a human already dismissed, not a live one.
//
// Calls two intel routes: resolve (only for a path / note ref) then
// GET /internal/v1/kb/documents/{id}/tensions?workspaceId=<ws>.

interface TensionEdge {
  assertionId: string;
  relationType: string;
  band: string;
  reviewOutcome: string;
  lifecycleStatus: string;
  reviewAuthority: string;
  detectorConfidence: number | null;
  createdAt: string | null;
  thisClaimId: string;
  thisClaimLabel: string | null;
  counterpartEndpointType: string;
  counterpartClaimId: string | null;
  counterpartLabel: string | null;
  counterpartDocumentId: string | null;
  counterpartDocumentRef: string | null;
  counterpartRestricted: boolean;
}

interface TensionsResponse {
  documentId: string;
  workspaceId: string;
  contradictsCount: number;
  supersedesCount: number;
  tensions: TensionEdge[];
}

interface ResolveResponse {
  documentId: string;
}

export interface KbTensionsFlags {
  input: string;
  workspace?: string;
  json: boolean;
}

export function parseKbTensionsArgs(argv: string[]): KbTensionsFlags {
  let input: string | undefined;
  let workspace: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--workspace" || a === "-w") {
      workspace = argv[++i];
    } else if (a.startsWith("--workspace=")) {
      workspace = a.slice("--workspace=".length);
    } else if (!a.startsWith("-") && input === undefined) {
      input = a;
    } else {
      throw new Error(`mla kb tensions: unexpected argument "${a}"`);
    }
  }
  if (!input) {
    throw new Error(
      "mla kb tensions <ref>: a document ref is required (a note path, note:<path>, or kbdoc:<id>).",
    );
  }
  return { input, workspace, json };
}

// Strip a leading `NT:` citation marker so `mla kb tensions NT:notes/foo.md` works. `NT:` is
// the evidence-surface citation prefix for a note; it is not one of parseArtifactInput's
// artifact prefixes (note: / kbdoc: / kbdocrev:), so a raw `NT:` would be sent to the
// resolver as a literal path and fail canonicalization.
export function stripCitationMarker(raw: string): string {
  return raw.replace(/^NT:/, "");
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
      "mla kb tensions does not accept kbdocrev:<id>. Pass the parent kbdoc:<id> or the note path.",
    );
  }
  const qs = new URLSearchParams({ workspaceId, path: input.path }).toString();
  try {
    const r = await intelGet<ResolveResponse>(
      cfg,
      `/internal/v1/kb/documents/resolve?${qs}`,
      10000,
    );
    return r.documentId;
  } catch (e) {
    throw new Error(intelErrorMessage(e, intelUrl));
  }
}

function truncate(s: string | null, n = 110): string {
  if (!s) return "(no label)";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function renderTensions(res: TensionsResponse, ref: string): string {
  const lines: string[] = [];
  const total = res.tensions.length;
  lines.push(`Tensions for ${ref}`);
  lines.push(
    `  ${total} edge${total === 1 ? "" : "s"}: ${res.contradictsCount} contradicts, ${res.supersedesCount} supersedes  (band DETECTED, machine-detected, pre-verdict)`,
  );
  if (total === 0) {
    lines.push(
      "  No CONTRADICTS or SUPERSEDES edges touch this document's claims.",
    );
    return lines.join("\n");
  }
  for (const t of res.tensions) {
    lines.push("");
    lines.push(`  [${t.band} · verdict:${t.reviewOutcome}] ${t.relationType}`);
    lines.push(`    this: ${truncate(t.thisClaimLabel)}`);
    if (t.counterpartRestricted) {
      lines.push("    with: (restricted: another principal's private document)");
    } else {
      const where = t.counterpartDocumentRef ? `  in ${t.counterpartDocumentRef}` : "";
      lines.push(`    with: ${truncate(t.counterpartLabel)}${where}`);
    }
  }
  return lines.join("\n");
}

function intelErrorMessage(e: unknown, intelUrl: string): string {
  const err = e as HttpError;
  if (err && typeof err.status === "number") {
    if (err.status === 404) {
      return `Not found: no such document in this workspace (or it is another principal's private note). intel=${intelUrl}`;
    }
    if (err.status === 401 || err.status === 403) {
      return `intel rejected the token (HTTP ${err.status}). Run \`mla doctor\` to check your login and workspace access.`;
    }
    return `intel returned HTTP ${err.status}. intel=${intelUrl}`;
  }
  return `Could not reach intel at ${intelUrl}: ${(e as Error).message}`;
}

export async function runKbTensions(argv: string[]): Promise<number> {
  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let flags: KbTensionsFlags;
  try {
    flags = parseKbTensionsArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let input: ArtifactInput;
  try {
    input = parseArtifactInput(stripCitationMarker(flags.input));
  } catch (e) {
    console.error(
      e instanceof ArtifactInputError ? e.message : (e as Error).message,
    );
    return 2;
  }

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

  const qs = new URLSearchParams({ workspaceId }).toString();
  let res: TensionsResponse;
  try {
    res = await intelGet<TensionsResponse>(
      cfg,
      `/internal/v1/kb/documents/${encodeURIComponent(documentId)}/tensions?${qs}`,
      15000,
    );
  } catch (e) {
    console.error(intelErrorMessage(e, intelUrl));
    return 1;
  }

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(renderTensions(res, flags.input));
  }
  return 0;
}
