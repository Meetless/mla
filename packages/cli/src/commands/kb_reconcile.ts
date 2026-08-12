import * as fs from "fs";
import * as path from "path";
import { readKbConfig } from "../lib/config";
import { intelGet, intelPost } from "../lib/http";
import {
  planCorpusWithdrawals,
  storedIdInCorpusScope,
  type KbCorpusDocument,
  type KbTombstoneState,
  type WithdrawalPlan,
} from "../lib/kb-withdraw-plan";
import { readCorpusMarker, globFiles, vaultRelPath } from "./kb_add";

// `mla kb reconcile [<folder>] [--glob <g>] [--apply] [--reason <s>] [--workspace <id>]`
//
// Compare a pinned notes corpus on disk against what the KB serves, and withdraw the documents
// that are no longer there. `kb add --mode corpus` already enumerates the complete marker-pinned
// set on every run and simply never asked the question; this asks it.
//
// DRY RUN BY DEFAULT. Tombstoning is the one direction here that removes something from serving, so
// it requires an explicit `--apply`. The default prints the plan and exits 0, which also makes the
// command safe to run on a schedule or by hand to see drift.
//
// WHY kb/forget AND NOT kb/withdraw. `kb/withdraw` is the automated reconciliation route and would
// otherwise be the obvious fit, but its contract refuses `sourceSystem=notes` on purpose so it
// cannot become "a general note-tombstone backdoor". The notes keyspace belongs to `kb/forget`, so
// each decision goes through that route, one audited actor-stamped call per document.

const DEFAULT_GLOB = "*.md";
const LIST_PAGE_LIMIT = 200;
const LIST_TIMEOUT_MS = 20000;
const FORGET_TIMEOUT_MS = 30000;
// A runaway backstop on cursor paging: 200 pages x 200 rows is far past any real corpus, so
// reaching it means the cursor is not advancing and we must stop rather than loop forever.
const MAX_PAGES = 200;

export interface KbReconcileFlags {
  folder: string | null;
  glob: string | null;
  apply: boolean;
  reason: string | null;
  workspace: string | null;
}

export function parseKbReconcileArgs(argv: string[]): KbReconcileFlags {
  const out: KbReconcileFlags = { folder: null, glob: null, apply: false, reason: null, workspace: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = (name: string): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`\`mla kb reconcile\` ${name} requires a value`);
      return v;
    };
    switch (a) {
      case "--apply":
        out.apply = true;
        break;
      case "--glob":
        out.glob = takeValue("--glob");
        break;
      case "--reason":
        out.reason = takeValue("--reason");
        break;
      case "--workspace":
        out.workspace = takeValue("--workspace");
        break;
      default:
        if (a.startsWith("--")) throw new Error(`\`mla kb reconcile\`: unknown flag ${a}`);
        if (out.folder !== null) {
          throw new Error(`\`mla kb reconcile\` takes at most one folder (got '${out.folder}' and '${a}')`);
        }
        out.folder = a;
    }
  }
  return out;
}

interface KbDocumentListItem {
  documentId: string;
  sourceSystem: string;
  externalObjectId: string;
  tombstoneState: string;
}

/**
 * The identity `kb/forget` resolves. It takes a PREFIXED handle (`kbdoc:<id>`), not a bare uuid.
 *
 * The first live `--apply` run failed all 52 documents with `KB_DOCUMENT_NOT_FOUND` for exactly
 * this reason. It is a one-token fix, and it lives in a named function so the call site cannot
 * quietly grow a second, unprefixed path.
 */
export function forgetRefFor(doc: KbCorpusDocument): string {
  return doc.documentId.startsWith("kbdoc:") ? doc.documentId : `kbdoc:${doc.documentId}`;
}

/**
 * Is this error just "the document is already in the state we wanted"?
 *
 * `kb forget` is a user command, so it 404s an unknown document and 409s a PURGED one. That is the
 * right contract for a human naming one document, and the wrong one for an idempotent
 * reconciliation over a derived set: a document that vanished between the list and the flip has
 * reached the target state. Counting it as a failure makes a clean run look broken and buries the
 * failures that are real, so those two conditions are absorbed and everything else propagates.
 */
export function isAlreadyGone(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b404\b/.test(msg) && /KB_DOCUMENT_NOT_FOUND/.test(msg)) return true;
  if (/\b409\b/.test(msg) && /PURGED/.test(msg)) return true;
  return false;
}

export interface ReconcileDeps {
  /** One page of KB documents. `tab: "all"` so already-tombstoned rows are counted, not re-forgotten. */
  listDocuments: (cursor: string | null) => Promise<{ items: KbDocumentListItem[]; nextCursor: string | null }>;
  /** Tombstone one document by its stored identity. Resolves to true when the flip happened. */
  forget: (doc: KbCorpusDocument, reason: string) => Promise<boolean>;
  log: (line: string) => void;
  logError: (line: string) => void;
}

/** Page the KB document list to completion. A non-advancing cursor is fatal, never an infinite loop. */
export async function collectAllDocuments(deps: ReconcileDeps): Promise<KbCorpusDocument[]> {
  const all: KbCorpusDocument[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const res: { items: KbDocumentListItem[]; nextCursor: string | null } = await deps.listDocuments(cursor);
    for (const it of res.items) {
      all.push({
        documentId: it.documentId,
        externalObjectId: it.externalObjectId,
        sourceSystem: it.sourceSystem,
        tombstoneState: it.tombstoneState as KbTombstoneState,
      });
    }
    const next = res.nextCursor;
    if (!next) return all;
    if (seenCursors.has(next)) {
      throw new Error("KB document list returned a repeating cursor; refusing to page forever");
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error(`KB document list exceeded ${MAX_PAGES} pages; refusing to continue`);
}

/** Render the plan for a human. Returns the lines so the shape is testable without a console. */
export function renderPlan(plan: WithdrawalPlan, glob: string, apply: boolean): string[] {
  const lines: string[] = [];
  if (plan.abstained) {
    lines.push(`kb reconcile: ABSTAINED, nothing withdrawn.`);
    lines.push(`  reason: ${plan.abstainReason}`);
    return lines;
  }
  lines.push(`kb reconcile (glob ${glob}):`);
  lines.push(`  on disk and serving:      ${plan.keptActive}`);
  lines.push(`  already withdrawn:        ${plan.alreadyWithdrawn}`);
  lines.push(`  outside the scanned scope:${String(plan.outOfScope).padStart(4)}`);
  lines.push(`  MISSING from disk:        ${plan.withdraw.length}`);
  if (plan.withdraw.length > 0) {
    lines.push("");
    for (const d of plan.withdraw) lines.push(`    ${d.externalObjectId}`);
    lines.push("");
    lines.push(
      apply
        ? `Withdrawing ${plan.withdraw.length} document(s) via kb/forget.`
        : `DRY RUN. Re-run with --apply to withdraw these ${plan.withdraw.length} document(s).`,
    );
  }
  return lines;
}

export async function runKbReconcileWith(
  flags: KbReconcileFlags,
  vaultRoot: string,
  effectiveGlob: string,
  deps: ReconcileDeps,
): Promise<number> {
  const files = globFiles(vaultRoot, effectiveGlob);
  // A zero-file scan is indistinguishable from a scan pointed at the wrong root. The planner
  // abstains on it too, but failing here gives the operator the actionable message.
  if (files.length === 0) {
    deps.logError(`kb reconcile: no files matched ${effectiveGlob} under ${vaultRoot}; refusing to treat that as "everything was deleted".`);
    return 2;
  }

  let known: KbCorpusDocument[];
  try {
    known = await collectAllDocuments(deps);
  } catch (e) {
    deps.logError(`kb reconcile: could not list KB documents: ${(e as Error).message}`);
    return 1;
  }

  const plan = planCorpusWithdrawals({
    scannedRelPaths: files.map((f) => `notes/${vaultRelPath(vaultRoot, f)}`),
    known,
    scanComplete: true,
    inScope: (id) => storedIdInCorpusScope(id, effectiveGlob),
  });

  for (const line of renderPlan(plan, effectiveGlob, flags.apply)) deps.log(line);
  if (plan.abstained) return 2;
  if (!flags.apply || plan.withdraw.length === 0) return 0;

  const reason = flags.reason ?? `source absent from corpus scan (${effectiveGlob})`;
  let ok = 0;
  let noop = 0;
  let failed = 0;
  for (const d of plan.withdraw) {
    try {
      const flipped = await deps.forget(d, reason);
      if (flipped) {
        ok += 1;
        deps.log(`  withdrawn: ${d.externalObjectId}`);
      } else {
        noop += 1;
      }
    } catch (e) {
      if (isAlreadyGone(e)) {
        noop += 1;
        continue;
      }
      failed += 1;
      deps.logError(`  FAILED:    ${d.externalObjectId} (${(e as Error).message})`);
    }
  }
  deps.log("");
  deps.log(`kb reconcile: ${ok} withdrawn, ${noop} already gone, ${failed} failed.`);
  return failed > 0 ? 1 : 0;
}

export async function runKbReconcile(argv: string[]): Promise<number> {
  let flags: KbReconcileFlags;
  try {
    flags = parseKbReconcileArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const cfg = readKbConfig(flags.workspace ?? undefined);
  const folder = path.resolve(flags.folder ?? process.cwd());
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.error(`kb reconcile: ${folder} is not a directory`);
    return 2;
  }
  const vaultRoot = fs.realpathSync(folder);

  let effectiveGlob = flags.glob ?? DEFAULT_GLOB;
  try {
    const marker = readCorpusMarker(vaultRoot, cfg.workspaceId);
    if (marker.allowedGlob) {
      if (flags.glob && flags.glob !== marker.allowedGlob) {
        console.error(
          `corpus marker pins allowedGlob=${JSON.stringify(marker.allowedGlob)} but --glob=${JSON.stringify(flags.glob)} was passed; the marker wins.`,
        );
        return 2;
      }
      effectiveGlob = marker.allowedGlob;
    }
  } catch (e) {
    console.error(`kb reconcile: ${(e as Error).message}`);
    return 2;
  }

  const deps: ReconcileDeps = {
    listDocuments: async (cursor) => {
      const qs = new URLSearchParams({
        workspaceId: cfg.workspaceId,
        tab: "all",
        limit: String(LIST_PAGE_LIMIT),
      });
      if (cursor) qs.set("cursor", cursor);
      const res = await intelGet<{ items: KbDocumentListItem[]; nextCursor: string | null }>(
        cfg,
        `/internal/v1/kb/documents?${qs.toString()}`,
        LIST_TIMEOUT_MS,
      );
      return { items: res.items ?? [], nextCursor: res.nextCursor ?? null };
    },
    forget: async (doc, reason) => {
      const res = await intelPost<{ receipt?: { outcome?: string } }>(
        cfg,
        "/internal/v1/kb/forget",
        {
          workspaceId: cfg.workspaceId,
          actor: cfg.actorUserId,
          reason,
          ref: forgetRefFor(doc),
        },
        FORGET_TIMEOUT_MS,
      );
      return res.receipt?.outcome === "tombstoned";
    },
    log: (l) => console.log(l),
    logError: (l) => console.error(l),
  };

  return runKbReconcileWith(flags, vaultRoot, effectiveGlob, deps);
}
