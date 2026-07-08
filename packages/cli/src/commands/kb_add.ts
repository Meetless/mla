import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { readKbConfig, KbCliConfig, getConsoleUrl, HOME } from "../lib/config";
import { intelGet, intelPost } from "../lib/http";
import { verifyKbActorIsOwner, KbOwnerCheckError } from "../lib/kb_acl";
import { KbAddReceipt, renderKbAddReceipt } from "../lib/render";
import { openUrl } from "../lib/open-url";
import { findWorkspaceContext } from "../lib/workspace";
import { governedPathEntryForReceipt, writeGovernedPath } from "../lib/governed-path-cache";
import { recordKbWriteBlocked } from "../lib/failure-telemetry";
import { getRunTraceId, canonicalizeSessionId } from "../lib/observability";

// `mla kb add <path> --mode file|corpus --provenance <kind> [flags]`
// (proposal §4.1).
//
// Remote-capable: this command POSTs the note bodies to the intel route
// `POST /internal/v1/kb/add`, which owns the governed ingestion front door
// (intake_delivery -> execute_run_set -> activation CAS head swap) and the
// server-authoritative canonical identity. The CLI no longer spawns a local
// python subprocess or needs an intel checkout on the operator's machine, so
// seeding works from any laptop against any backend (local dogfood or staging)
// the same way every other `mla` command does (INV-OSS-1).
//
// Split of responsibilities:
//   - CLIENT (here, holds the filesystem): strict argv parsing, owner-only ACL
//     pre-flight, path-existence + mode/dir guards, vault-root resolution
//     (MEETLESS_NOTES_ROOT -> git-repo walk-up; corpus mode = the corpus
//     folder), corpus-marker (`.meetless-kb-corpus.json`) read + glob
//     enumeration, content reads, and the vault-relative POSIX path per doc.
//   - SERVER (intel route): prefixes the single `notes/` root, runs the PURE
//     canonicalizer (NFC + casefold) to reproduce exactly what the local
//     `notes_external_object_id` computes (so HTTP-seeded and locally-seeded
//     docs dedup against each other), mints/dedups the revision, runs the heavy
//     LDM body inline, and returns the KbAddReceipt array `render.ts` consumes.
//
// The receipt tail (sync-extract poll, governed-path cache, Console URL stamp,
// `--open`) is unchanged: it operates on the receipts the route returns exactly
// as it did on the receipts the worker used to print.

const CORPUS_MARKER = ".meetless-kb-corpus.json";
const DEFAULT_GLOB = "*.md";
const DEFAULT_PROFILE = "markdown_atomic_v1";

interface KbAddFlags {
  path: string;
  mode: "file" | "corpus";
  provenance: string;
  workspace?: string;
  profile?: string;
  glob?: string;
  ingestRunId?: string;
  // Channel B (session grouping): the raw Claude session UUID, relayed verbatim to
  // the intel ingest route as `agentSession`. The route canonicalizes + composes
  // it into the Langfuse session exactly once (INV-COMPOSE-ONCE). Never composed
  // here; an absent/invalid value is dropped (no agent session, ingest still runs).
  agentSession?: string;
  allowProvenanceChange: boolean;
  // B3: --queue returns immediately after ingest without polling GRAPH_EXTRACT
  // to completion. Default (false) is sync-extract: the CLI polls the
  // worker-owned job to a terminal state or the latency budget.
  queue: boolean;
  // B4b: --open is opt-in. After the receipt prints (with the Console review URL),
  // launch that URL in a browser. NEVER auto-opens; the agent-proxy loop is headless.
  open: boolean;
  // Add-or-update: when set, an ACTIVE doc with changed content is reingested in
  // place (new revision for a body change, frontmatter patch otherwise) instead of
  // a hard "use mla kb reingest" refusal. The auto-index loop sets it so re-edited
  // docs actually accrue revisions. Wire-compat: the governed UPSERT is always
  // add-or-update server-side, so this is advisory only.
  reingestIfActive: boolean;
}

const VALUE_FLAGS = new Set([
  "--mode",
  "--provenance",
  "--workspace",
  "--profile",
  "--glob",
  "--ingest-run-id",
  "--agent-session",
]);
const BOOLEAN_FLAGS = new Set(["--allow-provenance-change", "--queue", "--open", "--reingest-if-active"]);

export function parseKbAddArgs(argv: string[]): KbAddFlags {
  const out: Partial<KbAddFlags> & {
    allowProvenanceChange?: boolean;
    queue?: boolean;
    open?: boolean;
    reingestIfActive?: boolean;
  } = {
    allowProvenanceChange: false,
    queue: false,
    open: false,
    reingestIfActive: false,
  };
  let positional: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
        case "--mode":
          if (v !== "file" && v !== "corpus") {
            throw new Error(`--mode must be 'file' or 'corpus' (got '${v}')`);
          }
          out.mode = v;
          break;
        case "--provenance":
          out.provenance = v;
          break;
        case "--workspace":
          out.workspace = v;
          break;
        case "--profile":
          out.profile = v;
          break;
        case "--glob":
          out.glob = v;
          break;
        case "--ingest-run-id":
          out.ingestRunId = v;
          break;
        case "--agent-session":
          out.agentSession = v;
          break;
      }
      i += 1;
      continue;
    }
    if (BOOLEAN_FLAGS.has(a)) {
      if (a === "--allow-provenance-change") out.allowProvenanceChange = true;
      else if (a === "--queue") out.queue = true;
      else if (a === "--open") out.open = true;
      else if (a === "--reingest-if-active") out.reingestIfActive = true;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. Supported flags: ${[...VALUE_FLAGS, ...BOOLEAN_FLAGS].sort().join(", ")}`,
      );
    }
    if (positional !== null) {
      throw new Error(
        `\`mla kb add\` takes exactly one positional path (got '${positional}' and '${a}')`,
      );
    }
    positional = a;
  }

  if (positional === null) {
    throw new Error("`mla kb add` requires a positional <path>");
  }
  if (!out.mode) {
    throw new Error("--mode file|corpus is required");
  }
  if (!out.provenance) {
    throw new Error("--provenance <kind> is required");
  }
  return {
    path: positional,
    mode: out.mode,
    provenance: out.provenance,
    workspace: out.workspace,
    profile: out.profile,
    glob: out.glob,
    ingestRunId: out.ingestRunId,
    agentSession: out.agentSession,
    allowProvenanceChange: !!out.allowProvenanceChange,
    queue: !!out.queue,
    open: !!out.open,
    reingestIfActive: !!out.reingestIfActive,
  };
}

// ---------------------------------------------------------------------------
// Vault-root resolution + enumeration (client-side; was tools/mla_kb_add.py)
//
// The governed identity is the vault-relative POSIX path under a single
// `notes/` root. The CLIENT alone holds the filesystem, so it resolves the
// vault root and computes each file's relative path here, exactly mirroring the
// python worker's `_resolve_vault_root` / `_enumerate_files` /
// `notes_external_object_id`, then ships `{relPath, content}` to the route. The
// SERVER prefixes `notes/` and canonicalizes, so the externalObjectId matches
// the locally-seeded one byte-for-byte (dedup parity).
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Walk up from `start` looking for a `.git` entry; return the containing dir.
// Mirrors the worker's `_git_root_for` (first/closest match wins).
export function gitRootForVault(start: string): string | null {
  let cur: string;
  try {
    cur = fs.realpathSync(start);
  } catch {
    cur = path.resolve(start);
  }
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// Resolve the notes vault root the governed identity is relative to.
// Order (mirrors the worker, minus the removed `--vault-root` flag): corpus
// folder (corpus mode), else MEETLESS_NOTES_ROOT, else a git-repo-root walk-up
// from the file's directory. `resolvedPath` is the absolute target.
export function resolveVaultRoot(
  flags: Pick<KbAddFlags, "mode">,
  resolvedPath: string,
): string {
  if (flags.mode === "corpus") {
    return fs.realpathSync(resolvedPath);
  }
  const envRoot = process.env.MEETLESS_NOTES_ROOT;
  if (envRoot) {
    const expanded = path.resolve(expandHome(envRoot));
    if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory()) {
      throw new Error(`MEETLESS_NOTES_ROOT=${envRoot} is not a directory`);
    }
    return fs.realpathSync(expanded);
  }
  const anchor = path.dirname(resolvedPath);
  const gitRoot = gitRootForVault(anchor);
  if (gitRoot) return gitRoot;
  throw new Error(
    "could not resolve a notes vault root for the governed identity; set MEETLESS_NOTES_ROOT or run inside a git repo",
  );
}

// The vault-relative POSIX path for `file`, validated to live INSIDE the vault.
// The server prefixes `notes/` + canonicalizes this. Mirrors the worker's
// `notes_external_object_id`, which raises when the file escapes the vault.
export function vaultRelPath(vaultRoot: string, file: string): string {
  const root = fs.realpathSync(vaultRoot);
  const f = fs.realpathSync(file);
  const rel = path.relative(root, f);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`file ${f} is not inside the notes vault root ${root}`);
  }
  return rel.split(path.sep).join("/");
}

interface CorpusMarker {
  workspaceId: string;
  corpusName: string;
  allowedGlob: string | null;
  allowedProvenance: string[] | null;
}

// Read + validate `.meetless-kb-corpus.json`. Mirrors the worker's
// `_read_corpus_marker`: the marker pins the corpus to one workspace and may
// carry an allowedGlob / allowedProvenance guardrail.
export function readCorpusMarker(folder: string, workspaceId: string): CorpusMarker {
  const markerPath = path.join(folder, CORPUS_MARKER);
  if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
    throw new Error(
      `corpus mode requires ${markerPath}; create one with the workspaceId and an optional allowedGlob / allowedProvenance guardrail`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (e) {
    throw new Error(`${markerPath}: invalid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${markerPath}: marker must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.workspaceId !== workspaceId) {
    throw new Error(
      `${markerPath}: workspaceId=${JSON.stringify(obj.workspaceId)} does NOT match --workspace (${JSON.stringify(workspaceId)}); the marker pins the corpus to one workspace`,
    );
  }
  const allowedGlob = obj.allowedGlob ?? null;
  if (allowedGlob !== null && typeof allowedGlob !== "string") {
    throw new Error(`${markerPath}: allowedGlob must be a string`);
  }
  const allowedProvenance = obj.allowedProvenance ?? null;
  if (allowedProvenance !== null && !Array.isArray(allowedProvenance)) {
    throw new Error(`${markerPath}: allowedProvenance must be a list of strings`);
  }
  return {
    workspaceId,
    corpusName: (typeof obj.corpusName === "string" && obj.corpusName) || path.basename(folder),
    allowedGlob: allowedGlob as string | null,
    allowedProvenance: allowedProvenance as string[] | null,
  };
}

function segmentToRegex(seg: string): RegExp {
  let re = "";
  for (const ch of seg) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// Enumerate files under `root` matching a glob, mirroring python `Path.glob`:
// `**` matches zero-or-more directory segments, `*`/`?` match within a single
// segment, and (Unix-glob convention) a `*` segment skips dotfiles. Returns
// absolute file paths, deduped + sorted (matching the worker's `sorted(...)`).
export function globFiles(root: string, pattern: string): string[] {
  const parts = pattern.split("/").filter((p) => p.length > 0);
  const results: string[] = [];

  const walk = (dir: string, idx: number): void => {
    if (idx >= parts.length) return;
    const part = parts[idx];
    const isLast = idx === parts.length - 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (part === "**") {
      // zero-directory case: try the rest of the pattern at this level...
      walk(dir, idx + 1);
      // ...then descend, keeping `**` active.
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name), idx);
      }
      return;
    }
    const rx = segmentToRegex(part);
    const skipDot = !part.startsWith(".");
    for (const e of entries) {
      if (skipDot && e.name.startsWith(".")) continue;
      if (!rx.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (isLast) {
        if (e.isFile()) results.push(full);
      } else if (e.isDirectory()) {
        walk(full, idx + 1);
      }
    }
  };

  walk(root, 0);
  return Array.from(new Set(results)).sort();
}

interface KbAddDocument {
  relPath: string;
  content: string;
}

// Build the per-document upload list (relative path + body). File mode is the
// single target; corpus mode globs the marker-pinned set under the folder.
export function enumerateDocuments(
  flags: KbAddFlags,
  resolvedPath: string,
  vaultRoot: string,
  marker: CorpusMarker | null,
): KbAddDocument[] {
  if (flags.mode === "file") {
    return [
      {
        relPath: vaultRelPath(vaultRoot, resolvedPath),
        content: fs.readFileSync(resolvedPath, "utf8"),
      },
    ];
  }
  // corpus
  let effectiveGlob = flags.glob ?? DEFAULT_GLOB;
  if (marker?.allowedGlob) {
    if (flags.glob && flags.glob !== DEFAULT_GLOB && flags.glob !== marker.allowedGlob) {
      throw new Error(
        `corpus marker pins allowedGlob=${JSON.stringify(marker.allowedGlob)} but --glob=${JSON.stringify(flags.glob)} was passed; the marker wins. Drop --glob or align it with the marker.`,
      );
    }
    effectiveGlob = marker.allowedGlob;
  }
  const files = globFiles(vaultRoot, effectiveGlob);
  if (files.length === 0) {
    throw new Error(`--mode corpus: no files matched ${effectiveGlob} under ${resolvedPath}`);
  }
  return files.map((f) => ({
    relPath: vaultRelPath(vaultRoot, f),
    content: fs.readFileSync(f, "utf8"),
  }));
}

// ---------------------------------------------------------------------------
// B3: sync-extract poll (notes/20260603-mla-kb-agent-proxy-and-evidence
// -adoption.md §3 B3, §7.4 "B3 polling idempotency").
//
// `kb add <file>` without --queue blocks on the worker-owned GRAPH_EXTRACT job
// by POLLING the intel detail route (the same `extraction` field B2 added) to a
// terminal state (completed/failed) or a wall-clock budget (~25s, mirroring the
// enrich-hook deadline). On timeout it degrades to the honest queued/running
// state so the receipt points at `mla kb show` / `mla kb pending`, never a false
// "done". The CLI never forks an inline executor: it only READS job state, so
// the single-writer invariant (the worker owns execution, locks, promotion,
// retries) holds. "Reuses the existing job, enqueues no duplicate" is satisfied
// for free here because the poller enqueues nothing at all (the ingest route is
// the only enqueuer, once per body-changing ingest via the pipeline).
//
// NOTE: the design doc's literal step (2) ("a unique key on IntelJob for
// (workspace, document, revision, extractor_version)") is NOT implemented:
// GRAPH_EXTRACT is canonically batch-keyed per detection_run (many
// artifact_paths) and idempotency is enforced at the EDGE level (the
// KnowledgeRelation unique constraint + upsert), not the job level. Adding a
// per-doc unique key would fight that canon and the delicate intel-dev
// migration state. The §7.4 acceptance is purely behavioral and is met by the
// read-only poll. See notes/20260604-b3-sync-extract-poll.md.

export interface PolledExtraction {
  state: "queued" | "running" | "completed" | "failed";
  candidateCount?: number | null;
  conflictCount?: number | null;
  jobId?: string | null;
}

export interface ExtractionPollDeps {
  // Read the current GRAPH_EXTRACT state for a document. Returns null when the
  // intel detail route carries no `extraction` field (pre-B2 intel), so the
  // poller leaves the receipt's inferred queued state untouched.
  fetchExtraction: (documentId: string) => Promise<PolledExtraction | null>;
  // Injectable sleep + monotonic clock so tests drive the budget without timers.
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface ExtractionPollOptions {
  queue: boolean; // --queue: return immediately, never poll.
  budgetMs: number; // total wall-clock budget (single file ~25s).
  intervalMs: number; // delay between polls.
}

// Mirrors render.ts: only a body-changing FILE ingest (a minted, activated
// revision) enqueues a GRAPH_EXTRACT job worth polling. Corpus rollups are
// async-default; noop_unchanged and failed ingests enqueue nothing.
function receiptEnqueuesExtraction(r: KbAddReceipt): boolean {
  return r.mode === "file" && r.outcome === "ingested";
}

export async function pollReceiptsToTerminal(
  receipts: KbAddReceipt[],
  opts: ExtractionPollOptions,
  deps: ExtractionPollDeps,
): Promise<void> {
  if (opts.queue) return; // opt-out: leave the inferred async-queued state.
  const deadline = deps.now() + opts.budgetMs;
  for (const r of receipts) {
    if (!receiptEnqueuesExtraction(r)) continue;
    for (;;) {
      let polled: PolledExtraction | null;
      try {
        polled = await deps.fetchExtraction(r.documentId);
      } catch {
        // A transient read failure must NOT fail the ingest: the revision is
        // already committed. Stop polling this receipt and let whatever state
        // we last observed (or the inferred queued state) render.
        break;
      }
      if (!polled) break; // pre-B2 intel: no job state to read.
      r.extraction = {
        state: polled.state,
        candidateCount: polled.candidateCount ?? null,
        conflictCount: polled.conflictCount ?? null,
        jobId: polled.jobId ?? null,
      };
      if (polled.state === "completed" || polled.state === "failed") break;
      if (deps.now() >= deadline) break; // timeout: render queued/running honestly.
      await deps.sleep(opts.intervalMs);
    }
  }
}

// Default budget mirrors the enrich-hook contract (deadline ~30s, budget ~25s;
// NT:20260528 §3.6). Interval keeps the poll count modest (~16 max) while still
// catching a fast worker within a couple seconds.
const EXTRACTION_POLL_BUDGET_MS = 25_000;
const EXTRACTION_POLL_INTERVAL_MS = 1_500;
const EXTRACTION_DETAIL_TIMEOUT_MS = 8_000;

// Minimal slice of the intel detail response this poll reads. Kept local (not
// the full DetailResponse from kb_show) so a server-side field add never breaks
// the poll, and so the candidate-count math is explicit.
interface KbDetailForPoll {
  extraction?: {
    state: "queued" | "running" | "completed" | "failed";
    jobId?: string | null;
  } | null;
  candidates?: Array<{ relationType: string; status: string }>;
}

// Build the real fetcher: GET the B2 detail route and project its `extraction`
// field into a PolledExtraction. When the job has COMPLETED we count the
// PENDING_REVIEW candidates on the doc (the ones `mla kb pending` will list) so
// the receipt summary lines up with the review command it points at; conflicts
// are the CONTRADICTS / SUPERSEDES subset.
function buildExtractionFetcher(
  cfg: KbCliConfig,
  workspaceId: string,
): ExtractionPollDeps["fetchExtraction"] {
  return async (documentId: string): Promise<PolledExtraction | null> => {
    const qs = new URLSearchParams({
      workspaceId,
      revisionLimit: "1",
      auditLimit: "1",
    }).toString();
    const detail = await intelGet<KbDetailForPoll>(
      cfg,
      `/internal/v1/kb/documents/${encodeURIComponent(documentId)}/detail?${qs}`,
      EXTRACTION_DETAIL_TIMEOUT_MS,
    );
    const ex = detail.extraction;
    if (!ex) return null;
    let candidateCount: number | null = null;
    let conflictCount: number | null = null;
    if (ex.state === "completed") {
      const pending = (detail.candidates ?? []).filter(
        (c) => c.status === "PENDING_REVIEW",
      );
      candidateCount = pending.length;
      conflictCount = pending.filter(
        (c) => c.relationType === "CONTRADICTS" || c.relationType === "SUPERSEDES",
      ).length;
    }
    return {
      state: ex.state,
      jobId: ex.jobId ?? null,
      candidateCount,
      conflictCount,
    };
  };
}

// Local pre-flight echo so the operator sees what is about to happen before the
// (possibly slow) server-side per-file pipeline runs. Keeps the silent-shell-out
// feel of `mla session remember` but lets corpus mode announce its target.
function printPreflight(flags: KbAddFlags, cfg: KbCliConfig): void {
  const ws = flags.workspace || cfg.workspaceId;
  const target = path.resolve(flags.path);
  console.log(
    `mla kb add (${flags.mode}) workspace=${ws} provenance=${flags.provenance} path=${target}`,
  );
}

// Scale the request timeout by document count: a single file is fast (one
// inline LDM body + embeds), but a corpus holds the connection while the server
// ingests every doc sequentially. 120s floor for the common single-file/seed
// case, ~20s/doc above that.
function ingestTimeoutMs(docCount: number): number {
  return Math.max(120_000, docCount * 20_000);
}

export async function runKbAdd(argv: string[]): Promise<number> {
  // Parse flags BEFORE loading config so `--workspace <id>` can override the
  // marker-resolved workspace (T1.1 folder = workspace). Passing the override
  // into readKbConfig short-circuits marker resolution, so an admin can curate
  // another workspace without activating the current directory.
  let flags: KbAddFlags;
  try {
    flags = parseKbAddArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // §13.14 owner-only ACL: verify the configured actor is a workspace OWNER
  // before any side effect (ingest POST, outbox emit). v1 has no KB_CURATE
  // scope per §11 Q8.
  try {
    await verifyKbActorIsOwner(cfg);
  } catch (e) {
    if (e instanceof KbOwnerCheckError) {
      console.error(e.message);
      // F5 (kb-write-blocked): the agent tried to write a lesson down and the
      // owner-only ACL refused it. This is the canonical F5 signal. Records to
      // the local deadletter only (never throws, respects the kill switch).
      recordKbWriteBlocked({
        traceId: getRunTraceId(),
        workspaceId: cfg.workspaceId,
        reasonCode: "owner_gate",
        status: 2,
      });
      return 2;
    }
    throw e;
  }

  // §4.1 explicit-path guards. The server also enforces these implicitly but
  // surfacing them at the CLI boundary gives operators a faster, clearer error
  // than waiting on a round trip.
  const resolved = path.resolve(flags.path);
  if (!fs.existsSync(resolved)) {
    console.error(`path does not exist: ${resolved}`);
    return 2;
  }
  const stat = fs.statSync(resolved);
  if (flags.mode === "file" && stat.isDirectory()) {
    console.error(
      `--mode file requires a file path, got directory: ${resolved}`,
    );
    return 2;
  }
  if (flags.mode === "corpus" && !stat.isDirectory()) {
    console.error(
      `--mode corpus requires a directory path, got file: ${resolved}`,
    );
    return 2;
  }

  const workspaceId = flags.workspace || cfg.workspaceId;

  // Resolve the vault root + assemble the upload list client-side (the CLI is
  // the only side that holds the filesystem). Marker read (corpus) + the
  // allowedProvenance guardrail run here, before the body bytes are read.
  let documents: KbAddDocument[];
  let marker: CorpusMarker | null = null;
  let corpusRootDisplay: string | null = null;
  try {
    if (flags.mode === "corpus") {
      marker = readCorpusMarker(resolved, workspaceId);
      // The corpus-marker provenance guardrail still applies to the operator's
      // stated intent even though provenance is advisory at the governed layer.
      if (marker.allowedProvenance && !marker.allowedProvenance.includes(flags.provenance)) {
        throw new Error(
          `corpus marker allowedProvenance=${JSON.stringify(marker.allowedProvenance)} does NOT include --provenance=${flags.provenance}`,
        );
      }
    }
    const vaultRoot = resolveVaultRoot(flags, resolved);
    if (flags.mode === "corpus") corpusRootDisplay = vaultRoot;
    documents = enumerateDocuments(flags, resolved, vaultRoot, marker);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  printPreflight(flags, cfg);

  // Relay the session UUID, canonicalized (defense in depth: a direct
  // `mla kb add --agent-session X` may carry a non-canonical value). The server
  // canonicalizes again and is the authoritative fail-closed gate; an invalid
  // value yields no session here, never a composed or console value.
  const agentSession = canonicalizeSessionId(flags.agentSession ?? null);

  const body = {
    workspaceId,
    actor: cfg.actorUserId,
    documents,
    provenance: flags.provenance, // advisory; the server derives the recorded value
    profile: flags.profile || DEFAULT_PROFILE,
    agentSession: agentSession ?? undefined,
    mode: flags.mode,
    corpusName: marker?.corpusName,
  };

  let receipts: KbAddReceipt[];
  try {
    const res = await intelPost<{ receipts: KbAddReceipt[] }>(
      cfg,
      "/internal/v1/kb/add",
      body,
      ingestTimeoutMs(documents.length),
    );
    receipts = res.receipts ?? [];
  } catch (e) {
    console.error(`kb add failed: ${(e as Error).message}`);
    // F5 (kb-write-blocked): the ingest POST did not land, so the lesson did not
    // land. Record locally only; never throws, kill-switch aware.
    recordKbWriteBlocked({
      traceId: getRunTraceId(),
      workspaceId,
      reasonCode: "ingest_post_failed",
      status: 1,
    });
    return 1;
  }

  if (receipts.length === 0) {
    console.error("kb add: the ingest route returned no receipts.");
    return 1;
  }

  // The server has no filesystem, so it cannot fill the corpus display root.
  // Stamp the resolved corpus folder back onto the rollup the operator sees.
  if (flags.mode === "corpus" && corpusRootDisplay && receipts[0].corpus) {
    receipts[0].corpus.rootPath = corpusRootDisplay;
  }

  // A per-doc intake failure is reported in the receipt, not the HTTP status.
  // Mirror the worker's exit semantics: any failed doc -> non-zero exit.
  const anyFailed = receipts.some((r) => r.outcome === "failed");
  if (anyFailed) {
    recordKbWriteBlocked({
      traceId: getRunTraceId(),
      workspaceId,
      reasonCode: "ingest_doc_failed",
      status: 1,
    });
  }
  const exit = anyFailed ? 1 : 0;

  // B3: sync-extract by default. Block on the worker-owned GRAPH_EXTRACT job by
  // polling the B2 detail route to a terminal state or the latency budget.
  // --queue opts out; corpus / failed / no-op-restore receipts are skipped by
  // receiptEnqueuesExtraction so we never serialize on a bulk ingest.
  const willPoll = !flags.queue && receipts.some(receiptEnqueuesExtraction);
  if (willPoll) {
    console.error(
      "waiting for relationship extraction (up to 25s; pass --queue to skip and check `mla kb show` later)...",
    );
  }
  await pollReceiptsToTerminal(
    receipts,
    {
      queue: flags.queue,
      budgetMs: EXTRACTION_POLL_BUDGET_MS,
      intervalMs: EXTRACTION_POLL_INTERVAL_MS,
    },
    {
      fetchExtraction: buildExtractionFetcher(cfg, workspaceId),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      now: () => Date.now(),
    },
  );

  // Task 3.4: owner-namespaced governed-path cache write-after-ingest. Record
  // every produced doc as "this owner governed this exact (repo, path) as KB doc
  // <id>" so a later turn can recognize a governed surface without a server round
  // trip. This is the SAFE half only: we NEVER gate the POST on a cache hit (the
  // server's resolve_by_canonical_path is the authoritative resolver, and a stale
  // 3-day entry could point at a doc tombstoned server-side). The whole pass is
  // best-effort: a cache write must never fail or interrupt the add.
  try {
    // repoRootHash: prefer the .meetless.json marker DIRECTORY (the governed repo
    // root per the folder=workspace T1.1 binding), resolved from where the target
    // file actually lives so it matches that file's repo. Fall back to process.cwd()
    // only when the file's tree carries no usable marker.
    const markerCtx = findWorkspaceContext(path.dirname(resolved));
    const repoRootDir = markerCtx ? markerCtx.markerDir : process.cwd();
    const repoRootHash = createHash("sha256").update(repoRootDir).digest("hex").slice(0, 24);
    for (const receipt of receipts) {
      const entry = governedPathEntryForReceipt(receipt, {
        workspaceId,
        ownerUserId: cfg.actorUserId,
        repoRootHash,
      });
      if (entry) writeGovernedPath(entry.key, entry.docId, HOME);
    }
  } catch (e) {
    // Advise, never block: the revision already committed. Swallow and continue.
    console.error(`governed-path cache write skipped: ${(e as Error).message}`);
  }

  // B4a: stamp the Console review URL onto every receipt so `kb add` always
  // surfaces the clickable human review surface. The server does not know the
  // console base; the CLI owns it via getConsoleUrl(cfg).
  const consoleUrl = `${getConsoleUrl(cfg)}/relationships`;
  for (const receipt of receipts) {
    receipt.consoleUrl = consoleUrl;
    console.log(renderKbAddReceipt(receipt));
    console.log("");
  }

  // B4b: `--open` is opt-in (the URL is always printed in the receipt above; we
  // NEVER auto-open, since the agent-proxy loop drives `kb add` headless). Launch
  // once for the whole add, not per-receipt. Status note -> stderr.
  if (flags.open) {
    const res = openUrl(consoleUrl);
    if (res.ok) console.error(`opened ${consoleUrl} in your browser`);
    else console.error(`could not open a browser (${res.error}); the URL is in the receipt above`);
  }

  return exit;
}
