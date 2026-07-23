import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { readKbConfig, KbCliConfig, consoleDeepLink, HOME } from "../lib/config";
import { resolveVaultRootForFile } from "../lib/notes-root";
import { intelGet, intelPost, HttpError } from "../lib/http";
import { verifyKbActorIsOwner, KbOwnerCheckError } from "../lib/kb_acl";
import { KbAddReceipt, renderKbAddReceipt } from "../lib/render";
import { openUrl } from "../lib/open-url";
import { findWorkspaceContext } from "../lib/workspace";
import { governedPathEntryForReceipt, writeGovernedPath } from "../lib/governed-path-cache";
import { recordKbWriteBlocked } from "../lib/failure-telemetry";
import { getRunTraceId, canonicalizeSessionId } from "../lib/observability";
import { INGEST_BATCH_SIZE, INGEST_TIMEOUT_MS } from "../lib/intel-ingest-budget";

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

// The server's immutable lineage labels (intel `app/core/ingest_provenance.py`, PROVENANCE_LABELS).
// Kept in sync by hand: the CLI and the server are two sides of one contract, so a kind accepted
// here that the server does not know is a silent mismatch, which is why this list is validated
// rather than passed through.
const PROVENANCE_KINDS = [
  "human_authored",
  "agent_distilled",
  "tool_emitted",
  "external_imported",
  "external_scraped",
] as const;
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
    throw new Error(
      `--provenance <kind> is required. The server's lineage kinds are: ${PROVENANCE_KINDS.join(", ")}\n` +
        "  Hand-written notes are usually `human_authored`; anything pulled in from another system\n" +
        "  is `external_imported`. The flag is free-form and the server derives the stored label\n" +
        "  itself, so the receipt may show a different value than you pass.",
    );
  }
  if (!(PROVENANCE_KINDS as readonly string[]).includes(out.provenance)) {
    // Deliberately a WARNING, not an error. The flag is free-form by design and the test suite
    // pins that (`dogfood_archive`), because the server owns the immutable lineage label:
    // intel derives it and may record something other than what was passed. Rejecting unknown
    // kinds here would break shipped invocations for no gain.
    //
    // What WAS wrong is the silence: `--provenance research` came back recorded as
    // `external_imported` with nothing said, so the caller had no idea their value was not the
    // one stored. Warn at the boundary instead of coercing quietly.
    console.warn(
      `warning: --provenance ${JSON.stringify(out.provenance)} is not one of the server's lineage ` +
        `kinds (${PROVENANCE_KINDS.join(", ")}).\n` +
        `         The server derives the stored label itself, so the receipt may show a different ` +
        `value than you passed.`,
    );
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

// Resolve the notes vault root the governed identity is relative to.
// Order (mirrors the worker, minus the removed `--vault-root` flag): corpus
// folder (corpus mode), else the shared lib/notes-root ladder (MEETLESS_NOTES_ROOT
// -> git-repo walk-up from the FILE's directory -> sibling vault). Anchoring on
// the file, not on cwd, is the whole trick: it is what makes `kb add` land in the
// standalone notes repo when you run it from the code repo. `mla kb reingest` now
// walks the SAME ladder, so an identity this command mints is one that command can
// always resolve back to a file. `resolvedPath` is the absolute target.
export function resolveVaultRoot(
  flags: Pick<KbAddFlags, "mode">,
  resolvedPath: string,
): string {
  if (flags.mode === "corpus") {
    return fs.realpathSync(resolvedPath);
  }
  return resolveVaultRootForFile(path.dirname(resolvedPath));
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
  /** true when no marker file existed and a permissive one was synthesized in memory. */
  synthesized?: boolean;
}

// Read + validate `.meetless-kb-corpus.json`. Mirrors the worker's
// `_read_corpus_marker`: the marker pins the corpus to one workspace and may
// carry an allowedGlob / allowedProvenance guardrail.
export function readCorpusMarker(folder: string, workspaceId: string): CorpusMarker {
  const markerPath = path.join(folder, CORPUS_MARKER);
  if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
    // A missing marker used to be a hard stop, which made corpus mode effectively unusable: the
    // error named a file but not its schema, so every first-time caller had to read this source to
    // learn the shape. Synthesize the permissive marker in memory instead.
    //
    // Synthesized, NOT written to disk on purpose. Creating a temp file inside the caller's corpus
    // folder and deleting it afterwards would litter that folder on any crash or Ctrl-C, and would
    // mean writing into a directory the caller only asked us to READ.
    //
    // The guardrails the marker exists to provide (pinning to one workspace, restricting glob and
    // provenance) are opt-in by design: committing a marker still enforces them. Without one the
    // caller gets no restriction, and `runKbAdd` prints what it is about to do so the absence is
    // visible rather than silent.
    return {
      workspaceId,
      corpusName: path.basename(folder),
      allowedGlob: null,
      allowedProvenance: null,
      synthesized: true,
    };
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
    synthesized: false,
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

/**
 * A file the client refused to put on the wire.
 *
 * It is NOT a transport failure: it never reached the server, so it is no
 * evidence about the server's health and must never influence the batching
 * loop's consecutive-failure abort. It IS a per-file receipt, because "this
 * note is missing from your KB" is precisely the thing the operator has to be
 * told, by name.
 */
export interface SkippedDocument {
  relPath: string;
  /** Position in the FULL enumeration order, so its receipt splices back into place. */
  index: number;
  reason: string;
}

export interface EnumeratedDocuments {
  documents: KbAddDocument[];
  skipped: SkippedDocument[];
}

/** The failure code stamped on a file this client declined to send. */
export const EMPTY_FILE_FAILURE_CODE = "empty_file";

/**
 * Can this body legally be sent at all?
 *
 * `KbAddDocument.content` is declared `min_length=1` on the server (intel
 * `app/api/routes/kb_add.py:119`) and that field sits inside the REQUEST model,
 * so an empty body is a pydantic REQUEST-validation error: FastAPI rejects the
 * ENTIRE POST with 422 before the route function ever runs. One 0-byte note in
 * a vault therefore took down every healthy sibling sharing its batch, and the
 * CLI stamped all of them `ingest_post_failed` quoting a reason that named a
 * DIFFERENT file. Two 0-byte notes cost ten real notes their ingest.
 *
 * So refuse them here, where we still hold the filesystem and can name the
 * actual file. Whitespace-only bodies go the same way: they clear `min_length=1`
 * but carry nothing governable, and would mint a chunk-less revision that no
 * retrieval path can ever return — a document that exists and answers nothing.
 */
export function isIngestableContent(content: string): boolean {
  return content.trim().length > 0;
}

function skipReasonFor(content: string): string {
  return content.length === 0
    ? "the file is 0 bytes; the ingest route requires a non-empty body (content min_length=1), and sending it would 422 the whole batch"
    : "the file has no non-whitespace content; it would mint a revision with zero chunks that no retrieval path can return";
}

/** Split an enumeration into what may be sent and what must be reported as skipped. */
function partitionIngestable(entries: KbAddDocument[]): EnumeratedDocuments {
  const documents: KbAddDocument[] = [];
  const skipped: SkippedDocument[] = [];
  entries.forEach((doc, index) => {
    if (isIngestableContent(doc.content)) {
      documents.push(doc);
      return;
    }
    skipped.push({ relPath: doc.relPath, index, reason: skipReasonFor(doc.content) });
  });
  return { documents, skipped };
}

// Build the per-document upload list (relative path + body). File mode is the
// single target; corpus mode globs the marker-pinned set under the folder.
// Unsendable files are partitioned out rather than dropped: they come back as
// `skipped` so the caller can emit a named receipt for each one.
export function enumerateDocuments(
  flags: KbAddFlags,
  resolvedPath: string,
  vaultRoot: string,
  marker: CorpusMarker | null,
): EnumeratedDocuments {
  if (flags.mode === "file") {
    return partitionIngestable([
      {
        relPath: vaultRelPath(vaultRoot, resolvedPath),
        content: fs.readFileSync(resolvedPath, "utf8"),
      },
    ]);
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
  return partitionIngestable(
    files.map((f) => ({
      relPath: vaultRelPath(vaultRoot, f),
      content: fs.readFileSync(f, "utf8"),
    })),
  );
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

// A corpus ingest is not one atomic act, and this client used to pretend it was.
//
// Every document went out in ONE POST whose timeout was 20s * n, so a corpus of any size
// asked for longer than the request is ever allowed to take. Past the wall the connection
// dies mid-write and the CLI printed `kb add failed` and returned 1, throwing away every
// receipt in the response, INCLUDING the documents the server had already committed. The
// operator was told nothing landed. Documents had landed. There was no record of which, and
// no way to resume: a corpus over ~15 files was structurally unshippable, and got less
// shippable the more notes you wrote.
//
// So: send the corpus in batches. Which wall, how big a batch, and why the number here used
// to be derived against a ceiling that never fires, are all documented once in
// `../lib/intel-ingest-budget`.
export const KB_ADD_BATCH_SIZE = INGEST_BATCH_SIZE;

// Two in a row is a down server, not a bad batch. Proving that costs a full request budget
// per remaining batch, so a 100-doc corpus against a dead intel would hang for many minutes
// before telling the operator anything. Stop, and report what did not land.
const MAX_CONSECUTIVE_BATCH_FAILURES = 2;

// The POST seam, injected so the batching logic is testable without a server (the same
// idiom `pollReceiptsToTerminal` uses for its fetcher).
export type KbAddPoster = (body: unknown, timeoutMs: number) => Promise<{ receipts?: KbAddReceipt[] }>;

interface FailureStamp {
  mode: "file" | "corpus";
  workspaceId: string;
  provenance: string;
  failedAt: string;
}

// A document that never got governed. It is a receipt, not a silence: the operator must
// be able to read WHICH files are missing from their KB, and `outcome: "failed"` carries
// that into the corpus rollup and the non-zero exit for free. Used for every client-side
// verdict — never reached the wire, batch died in transit, server rejected the request.
function failedDocumentReceipt(
  doc: { relPath: string },
  ctx: FailureStamp,
  code: string,
  reason: string,
): KbAddReceipt {
  return {
    mode: ctx.mode,
    workspaceId: ctx.workspaceId,
    outcome: "failed",
    documentId: "",
    canonicalPath: doc.relPath,
    parentUuid: "",
    provenance: ctx.provenance,
    failure: { code, reason, failedAt: ctx.failedAt },
  };
}

/**
 * Splice one `empty_file` receipt per skipped file back into enumeration order.
 *
 * Kept OUT of `postDocumentsInBatches` on purpose: a file the client never sent is not
 * evidence about the server, so it must not reach the batching loop at all and therefore
 * cannot contribute to MAX_CONSECUTIVE_BATCH_FAILURES. It still gets a named receipt, so
 * the operator reads "20251202-chunking-engine-v0.md [failed] failure=empty_file" instead
 * of a silence, or — the old behavior — instead of nine healthy siblings blamed for it.
 */
export function mergeSkippedReceipts(
  posted: KbAddReceipt[],
  skipped: SkippedDocument[],
  ctx: { mode: "file" | "corpus"; workspaceId: string; provenance: string; now: () => string },
): KbAddReceipt[] {
  if (skipped.length === 0) return posted;
  const out = [...posted];
  const stamp: FailureStamp = { mode: ctx.mode, workspaceId: ctx.workspaceId, provenance: ctx.provenance, failedAt: ctx.now() };
  for (const s of [...skipped].sort((a, b) => a.index - b.index)) {
    const at = Math.min(Math.max(s.index, 0), out.length);
    out.splice(at, 0, failedDocumentReceipt({ relPath: s.relPath }, stamp, EMPTY_FILE_FAILURE_CODE, s.reason));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batch-failure isolation, and the trace that bounds it.
//
// RETRY POLICY. Exactly two cases, and the second one is the default:
//
//   1. A pre-handler 422 is a pydantic REQUEST-validation rejection. FastAPI validates
//      `KbAddRequest` (intel `app/api/routes/kb_add.py:126-148`) BEFORE the route
//      function's body runs, so ZERO documents were processed and the server holds no
//      state from the attempt. Re-POSTing the batch minus the named offenders is
//      therefore provably side-effect-free, and we do it so the healthy siblings still
//      land instead of being punished for a neighbour.
//
//   2. Everything else — 5xx, gateway timeout, severed connection, a short/garbled
//      response — is AMBIGUOUS by construction, so we do NOT auto-retry or bisect. The
//      route is NOT atomic: it loops the documents (`kb_add.py:595`) and each one runs
//      its own `intake_delivery` + `execute_run_set` with per-document faults caught into
//      a receipt (`kb_add.py:607-619`). Documents 0..k can be committed AND activated
//      when the request dies at k+1. We report the batch failed and NAME the documents
//      whose fate is unknown.
//
//      Per-document idempotency is real but not sufficient to license a silent retry:
//      identity is a pure function of relPath (`kb_add.py:163-177`) and `intake_delivery`
//      dedups an identical re-delivery on the normalized content hash
//      (`kb_ingestion_service.py:228`, `_find_dedup_revision` at :501-508), so a re-run
//      mints no duplicate document or revision. What it does NOT prove is convergence: a
//      revision minted but never activated (the request died between
//      `create_revision` and the activation CAS) dedups on the next delivery and comes
//      back `noop_unchanged` — an automatic retry would report "already fine" over a
//      document that is not actually serving. A human re-running `mla kb add` is the
//      same operation with an operator watching the receipts, which is the difference.
//
// Widening this requires redoing that trace, not just raising the constant.
// ---------------------------------------------------------------------------

// Pydantic reports EVERY validation error in one response, so a single isolation round
// names all the offenders. The second round exists only so a server that somehow answers
// with fresh indices cannot loop us.
const MAX_VALIDATION_ISOLATION_ROUNDS = 2;

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  return (err as Partial<HttpError>).status;
}

/**
 * The batch-relative document indices a 422 body blames, or null when it blames none.
 *
 * Intel replaces FastAPI's default 422 body with a scrubbed projection that deliberately
 * KEEPS `loc` (intel `app/api/validation_errors.py:32,52`), so the offending document's
 * position survives: `loc = ["body", "documents", <i>, "content"]`. That is what makes
 * precise isolation possible without bisection — one extra request, not log2(n) of them.
 *
 * Returns null (meaning "cannot isolate; treat as a whole-batch rejection") when the
 * error is not a 422, the body is not the list-shaped detail (a route-level
 * `HTTPException(422, detail="...")` is a string), no `documents` index appears (a
 * request-level fault such as a bad `workspaceId` — dropping documents would not fix it),
 * or an index falls outside the batch we actually sent.
 */
export function validationRejectedIndices(err: unknown, batchSize: number): number[] | null {
  if (httpStatusOf(err) !== 422) return null;
  const body = (err as Partial<HttpError>).body;
  if (typeof body !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const detail = (parsed as { detail?: unknown } | null)?.detail;
  if (!Array.isArray(detail)) return null;
  const hits = new Set<number>();
  for (const item of detail) {
    const loc = (item as { loc?: unknown } | null)?.loc;
    if (!Array.isArray(loc)) continue;
    const at = loc.indexOf("documents");
    if (at < 0) continue;
    const idx = loc[at + 1];
    if (typeof idx !== "number" || !Number.isInteger(idx)) continue;
    // An index the batch does not contain means this body does not describe the request
    // we sent. Refuse to guess rather than fail an innocent document.
    if (idx < 0 || idx >= batchSize) return null;
    hits.add(idx);
  }
  return hits.size > 0 ? [...hits].sort((a, b) => a - b) : null;
}

function ambiguousBatchReason(reason: string, paths: string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  const more = paths.length > 5 ? `, +${paths.length - 5} more` : "";
  return (
    `${reason} (batch of ${paths.length}: ${shown}${more}). Not auto-retried: the ingest route commits ` +
    "each document independently, so part of this batch may already be governed. Re-run the same " +
    "`mla kb add` — an identical re-delivery dedups to noop_unchanged — and check `mla kb show` for these paths."
  );
}

/**
 * Send one batch, isolating pre-handler 422 offenders so their siblings still land.
 *
 * Returns one receipt per document in `batch` order, plus whether the failure (if any)
 * was a transport/ambiguous one. A 422 is NOT a transport failure: the server answered,
 * fast and deterministically, so it says nothing about server health and must not feed
 * the "the server is down" abort.
 */
async function postBatchIsolatingRejected(
  batch: KbAddDocument[],
  baseBody: Record<string, unknown>,
  stamp: FailureStamp,
  post: KbAddPoster,
): Promise<{ receipts: KbAddReceipt[]; errors: string[]; transportFailed: boolean }> {
  const out: (KbAddReceipt | null)[] = new Array(batch.length).fill(null);
  const errors: string[] = [];
  let pending = batch.map((doc, index) => ({ doc, index }));

  const settle = (code: string, reason: (paths: string[]) => string): void => {
    const paths = pending.map((p) => p.doc.relPath);
    for (const p of pending) out[p.index] = failedDocumentReceipt(p.doc, stamp, code, reason(paths));
    pending = [];
  };

  for (let round = 0; round < MAX_VALIDATION_ISOLATION_ROUNDS; round++) {
    try {
      const res = await post({ ...baseBody, documents: pending.map((p) => p.doc) }, INGEST_TIMEOUT_MS);
      const got = res.receipts ?? [];
      // One receipt per document, in order, is the route's contract. A short response
      // means we cannot say which document each receipt belongs to, and mis-attributing
      // an "ingested" to the wrong file would report a document as governed when it is
      // not. Fail the batch instead of guessing.
      if (got.length !== pending.length) {
        throw new Error(`kb add returned ${got.length} receipt(s) for ${pending.length} document(s)`);
      }
      pending.forEach((p, k) => {
        out[p.index] = got[k];
      });
      return { receipts: out as KbAddReceipt[], errors, transportFailed: false };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      errors.push(reason);
      const rejected = validationRejectedIndices(e, pending.length);

      if (rejected === null) {
        // Case 2 above (or a 422 that blames the request, not a document): no auto-retry.
        const isRejection = httpStatusOf(e) === 422;
        settle(
          isRejection ? "ingest_rejected_invalid" : "ingest_post_failed",
          isRejection ? () => reason : (paths) => ambiguousBatchReason(reason, paths),
        );
        return { receipts: out as KbAddReceipt[], errors, transportFailed: !isRejection };
      }

      // Case 1: a pre-handler request-validation rejection. Nothing was committed, so
      // naming the offenders and re-POSTing the survivors is safe.
      const offenders = new Set(rejected);
      for (const idx of rejected) {
        const p = pending[idx];
        out[p.index] = failedDocumentReceipt(
          p.doc,
          stamp,
          "ingest_rejected_invalid",
          `the ingest route rejected this document at request validation, which fails the whole POST: ${reason}`,
        );
      }
      pending = pending.filter((_, k) => !offenders.has(k));
      if (pending.length === 0) {
        return { receipts: out as KbAddReceipt[], errors, transportFailed: false };
      }
    }
  }

  // Rounds exhausted: the server kept rejecting fresh documents. Stop rather than loop.
  settle("ingest_rejected_invalid", () => `not sent: ${MAX_VALIDATION_ISOLATION_ROUNDS} request-validation isolation rounds did not yield an acceptable batch`);
  return { receipts: out as KbAddReceipt[], errors, transportFailed: false };
}

/**
 * POST the documents in bounded batches, one receipt per document, in input order.
 *
 * A failed batch fails only ITS OWN documents, and a batch rejected at request validation
 * fails only the documents actually named. The server's front door is an idempotent
 * per-document upsert with no reconciliation pass (it never removes a document just
 * because this request did not mention it), so a rerun re-delivers the survivors as
 * cheap `noop_unchanged` and retries only what is actually missing. That is the whole
 * point: progress is monotonic, and a big corpus converges across runs instead of
 * failing forever at whichever document happens to blow the budget.
 */
export async function postDocumentsInBatches(
  documents: KbAddDocument[],
  baseBody: Record<string, unknown>,
  ctx: { mode: "file" | "corpus"; workspaceId: string; provenance: string; post: KbAddPoster; now: () => string },
): Promise<{ receipts: KbAddReceipt[]; errors: string[] }> {
  const receipts: KbAddReceipt[] = [];
  const errors: string[] = [];
  let consecutiveFailures = 0;

  for (let start = 0; start < documents.length; start += KB_ADD_BATCH_SIZE) {
    const batch = documents.slice(start, start + KB_ADD_BATCH_SIZE);
    const stamp: FailureStamp = { mode: ctx.mode, workspaceId: ctx.workspaceId, provenance: ctx.provenance, failedAt: ctx.now() };

    if (consecutiveFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
      for (const d of batch) {
        receipts.push(failedDocumentReceipt(d, stamp, "ingest_not_attempted", "skipped: the preceding batches did not land, so the server is treated as down"));
      }
      continue;
    }

    const outcome = await postBatchIsolatingRejected(batch, baseBody, stamp, ctx.post);
    receipts.push(...outcome.receipts);
    errors.push(...outcome.errors);
    // Only an ambiguous/transport failure is evidence the server is unhealthy. A 422 is a
    // deterministic content verdict, answered fast, and proves the server is alive — so it
    // neither trips the abort nor clears a real outage: it leaves the counter where it was.
    if (outcome.transportFailed) consecutiveFailures += 1;
    else if (outcome.errors.length === 0) consecutiveFailures = 0;
  }

  return { receipts, errors };
}

/**
 * Recompute ONE corpus rollup over every batch's receipts.
 *
 * The server stamps a rollup on the first receipt of each response, so a batched corpus
 * comes back carrying several partial summaries, each of which counts only its own
 * batch. Printing them would show the operator three "totals" lines and none of them
 * would be the total. Strip them and derive one, from the receipts, which are the only
 * per-document truth we have.
 */
export function stampMergedCorpusRollup(receipts: KbAddReceipt[], corpusName: string, rootPath: string): void {
  if (receipts.length === 0) return;
  for (const r of receipts) delete r.corpus;

  const count = (outcome: KbAddReceipt["outcome"]) => receipts.filter((r) => r.outcome === outcome).length;
  receipts[0].mode = "corpus";
  receipts[0].corpus = {
    corpusName,
    rootPath,
    ingested: count("ingested"),
    restored: 0, // the governed front door has no restore branch
    noChange: count("noop_unchanged"),
    failed: count("failed"),
    perDoc: receipts.map((r) => ({
      canonicalPath: r.canonicalPath,
      outcome: r.outcome,
      revisionId: r.revisionId ?? null,
      chunkCount: r.chunkCount ?? null,
      failureCode: r.failure?.code ?? null,
    })),
  };
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
  let skipped: SkippedDocument[];
  let marker: CorpusMarker | null = null;
  let corpusRootDisplay: string | null = null;
  try {
    if (flags.mode === "corpus") {
      marker = readCorpusMarker(resolved, workspaceId);
      if (marker.synthesized) {
        console.error(
          `note: no ${CORPUS_MARKER} in ${resolved} — ingesting the whole folder into workspace ${workspaceId}.\n` +
            `      Commit a ${CORPUS_MARKER} there to pin the corpus to one workspace or restrict\n` +
            `      allowedGlob / allowedProvenance.`,
        );
      }
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
    ({ documents, skipped } = enumerateDocuments(flags, resolved, vaultRoot, marker));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  printPreflight(flags, cfg);

  // Say it out loud before the (possibly slow) POSTs, so the operator does not have to
  // find these in the rollup afterwards.
  for (const s of skipped) {
    console.error(`kb add: skipping ${s.relPath} — ${s.reason}`);
  }

  // Relay the session UUID, canonicalized (defense in depth: a direct
  // `mla kb add --agent-session X` may carry a non-canonical value). The server
  // canonicalizes again and is the authoritative fail-closed gate; an invalid
  // value yields no session here, never a composed or console value.
  const agentSession = canonicalizeSessionId(flags.agentSession ?? null);

  const baseBody = {
    workspaceId,
    actor: cfg.actorUserId,
    provenance: flags.provenance, // advisory; the server derives the recorded value
    profile: flags.profile || DEFAULT_PROFILE,
    agentSession: agentSession ?? undefined,
    mode: flags.mode,
    corpusName: marker?.corpusName,
  };

  const receiptCtx = {
    mode: flags.mode,
    workspaceId,
    provenance: flags.provenance,
    now: () => new Date().toISOString(),
  };

  // Never POST an empty `documents` array: it is itself a request-validation error
  // (`documents: list[...] = Field(..., min_length=1)`), so an all-skipped run would
  // trade a clean set of `empty_file` receipts for one opaque 422.
  const posted =
    documents.length > 0
      ? await postDocumentsInBatches(documents, baseBody, {
          ...receiptCtx,
          post: (b, timeoutMs) => intelPost<{ receipts: KbAddReceipt[] }>(cfg, "/internal/v1/kb/add", b, timeoutMs),
        })
      : { receipts: [] as KbAddReceipt[], errors: [] as string[] };
  const errors = posted.errors;
  for (const e of errors) console.error(`kb add: a batch did not land: ${e}`);

  const receipts = mergeSkippedReceipts(posted.receipts, skipped, receiptCtx);

  if (receipts.length === 0) {
    console.error("kb add: the ingest route returned no receipts.");
    return 1;
  }

  // The server stamps one rollup per RESPONSE, so a batched corpus comes back with
  // several partial ones, each counting only its own batch. Replace them with a single
  // rollup derived from every receipt (and fill the display root, which the server has
  // no filesystem to know).
  if (flags.mode === "corpus") {
    stampMergedCorpusRollup(receipts, marker?.corpusName ?? "", corpusRootDisplay ?? "");
  }

  // A per-doc intake failure is reported in the receipt, not the HTTP status, and a batch
  // that never reached the server synthesizes one failed receipt per document it carried.
  // A file this client refused to send is a failure too — it is missing from the KB, and
  // reporting exit 0 over a hole is the lie this whole change exists to stop.
  const anyFailed = receipts.some((r) => r.outcome === "failed");
  if (anyFailed) {
    // One deadletter per run, named for the dominant cause: a dead transport is an
    // operator/infra problem, a server-side per-doc rejection is a content problem, and
    // an unsendable file is a vault-hygiene problem the operator fixes in their editor.
    const onlySkips = receipts.every((r) => r.outcome !== "failed" || r.failure?.code === EMPTY_FILE_FAILURE_CODE);
    recordKbWriteBlocked({
      traceId: getRunTraceId(),
      workspaceId,
      reasonCode: errors.length > 0 ? "ingest_post_failed" : onlySkips ? EMPTY_FILE_FAILURE_CODE : "ingest_doc_failed",
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
  // console base; the CLI owns it and pins the active workspace so the link
  // lands in THIS workspace, not whichever one the Console session is bound to.
  const consoleUrl = consoleDeepLink(cfg, "/relationships");
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
