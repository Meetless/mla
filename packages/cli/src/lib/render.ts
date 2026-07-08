// Plain-text ReviewPacket renderer per §5.3 + §6.
// Used by `mla review [--plain]`. ANSI colors stripped when --plain.


// Intel's locked contract (code_review.py): evidence is list[str] with
// prefixes `file:<path>`, `bash:<index>`, or `agent:claims`.
export type EvidenceRef = string;

function fmtEvidenceRef(ev: unknown): string | null {
  if (typeof ev !== "string") return null;
  const s = ev.trim();
  return s.length ? s : null;
}

export interface ReviewPacketView {
  id: string;
  workspaceId: string;
  runId: string;
  status: "pending" | "ready" | "failed";
  synthesisStatus: "not_started" | "pending" | "ready" | "failed" | null;
  synthesisCompletedAt: string | null;
  facts: Record<string, unknown> | null;
  bashEvents: unknown[] | null;
  missingEvidence: string[] | null;
  agentClaimsRaw: string | null;
  // Legacy review-steering fields (Mission deletion, PR1). The producer dropped
  // both columns; the renderer deliberately never surfaces them. Kept optional so
  // a packet from an older control build / not-yet-migrated row still deserializes.
  recommendation?: string | null;
  recommendedNextPrompt?: string | null;
  summary: string | null;
  agentClaimsParsed: unknown[] | null;
  verification: unknown[] | null;
  risks: Array<{
    category: string;
    severity: string;
    title: string;
    description?: string;
    evidence?: EvidenceRef[];
    fingerprint?: string;
  }> | null;
  intelTraceId: string | null;
  intelTraceError: string | null;
  correlationId?: string | null;
  langfuseTraceId?: string | null;
  langfuseTraceUrl?: string | null;
  warnings: string[];
  createdAt?: string;
  updatedAt?: string;
  // Stale-digest guard (P0 2026-05-31). Computed control-side: how many run
  // events were recorded AFTER this packet's synthesis watermark, and the
  // watermark ISO itself. A long-lived / continued session keeps one run alive
  // all day; the packet freezes at synthesis time while work continues, so a
  // non-zero count means the recommendation below predates real work and must
  // not be rendered as an authoritative verdict. Absent on older control
  // builds (treated as not stale).
  staleEventCount?: number | null;
  staleSince?: string | null;
  latestEventAt?: string | null;
}

function fmtList(items: string[] | null | undefined): string {
  if (!items || items.length === 0) return "  (none)";
  return items.map((i) => `  - ${i}`).join("\n");
}

function fmtFacts(facts: Record<string, unknown> | null): string {
  if (!facts) return "  (deterministic facts not yet populated)";
  const lines: string[] = [];
  if (facts.branch) lines.push(`  branch: ${facts.branch}`);
  if (facts.lastCommit) lines.push(`  last commit: ${facts.lastCommit}`);
  const ds = facts.diffStat as { filesChanged?: number; insertions?: number; deletions?: number } | undefined;
  if (ds) {
    lines.push(`  diffStat: files=${ds.filesChanged ?? 0} +${ds.insertions ?? 0} -${ds.deletions ?? 0}`);
  }
  const changed = facts.changedFiles as string[] | undefined;
  if (changed && changed.length > 0) {
    lines.push(`  changed files (${changed.length}):`);
    for (const f of changed.slice(0, 50)) lines.push(`    - ${f}`);
    if (changed.length > 50) lines.push(`    ... +${changed.length - 50} more`);
  }
  const cls = facts.classifications as Record<string, string> | undefined;
  if (cls) {
    const counts: Record<string, number> = {};
    for (const c of Object.values(cls)) counts[c] = (counts[c] ?? 0) + 1;
    const summary = Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    if (summary) lines.push(`  classifications: ${summary}`);
  }
  return lines.length ? lines.join("\n") : "  (empty)";
}

function fmtBashEvents(events: unknown[] | null): string {
  if (!events || events.length === 0) return "  (none observed)";
  const lines: string[] = [];
  for (const e of events.slice(0, 30)) {
    const ev = e as { category?: string; command?: string; exitCode?: number };
    const cmd = (ev.command || "").replace(/\s+/g, " ").slice(0, 120);
    lines.push(`  [${ev.category || "unknown"}] exit=${ev.exitCode ?? "?"}  ${cmd}`);
  }
  if (events.length > 30) lines.push(`  ... +${events.length - 30} more`);
  return lines.join("\n");
}

// Capture-count rollup. This is the §10 Phase 1 "print capture counts" block:
// the deterministic shape of what the run captured, NOT a verdict on it. Phase 1
// has no claim/decision/contradiction extraction (that lands with the per-turn
// extraction substrate, RCA Phase 3), so we count only what is captured
// deterministically: changed files, observed bash events, missing-evidence
// flags, and whether the agent left a verbatim self-report.
function fmtCaptureSummary(packet: ReviewPacketView): string {
  const ds = (packet.facts?.diffStat ?? {}) as {
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
  };
  const changedFiles =
    (packet.facts?.changedFiles as string[] | undefined)?.length ?? ds.filesChanged ?? 0;
  const bashCount = packet.bashEvents?.length ?? 0;
  const missingCount = packet.missingEvidence?.length ?? 0;
  const selfReport = !!(packet.agentClaimsRaw && packet.agentClaimsRaw.trim().length > 0);
  const lines = [
    `  changed files:          ${changedFiles}`,
    `  observed bash events:   ${bashCount}`,
    `  missing-evidence flags: ${missingCount}`,
    `  agent self-report:      ${selfReport ? "captured (unverified)" : "none"}`,
  ];
  return lines.join("\n");
}

// INV-T3 / §5.3 / §5.4: this surface renders NO verdict, recommendation, or
// approve/reject for an agent-session capture. A captured run is a deterministic
// ledger of what the agent did and self-reported, never an independent review.
// The renderer DELIBERATELY ignores any recommendation / verification / risks /
// summary / LLM-trace fields the wire may still carry (e.g. a packet written by
// an older control build), so the false-authority line cannot reappear by data
// alone. The reviewable artifacts (relationship candidates, claims) live in the
// Console queues; this block is a convenience snapshot of capture, not a sign-off.
export function renderPacket(packet: ReviewPacketView): string {
  const out: string[] = [];
  const isStale = typeof packet.staleEventCount === "number" && packet.staleEventCount > 0;
  out.push(`╭─ Meetless Capture Ledger ────────────────────────────────────────────╮`);
  out.push(`  packet id:   ${packet.id}`);
  out.push(`  run id:      ${packet.runId}`);
  out.push(`  status:      ${packet.status}`);
  out.push(`  note:        this is a capture ledger, not a sign-off. No verdict is rendered here.`);
  out.push(`────────────────────────────────────────────────────────────────────────`);

  if (isStale) {
    const n = packet.staleEventCount as number;
    const since = packet.staleSince ? ` (${packet.staleSince})` : "";
    const latest = packet.latestEventAt ? `; latest at ${packet.latestEventAt}` : "";
    out.push(``);
    out.push(`⚠ STALE LEDGER`);
    out.push(
      `  ${n} event(s) were recorded on this run AFTER this ledger was built${since}${latest}.`,
    );
    out.push(
      `  This run is still live (one long-lived / continued session). The facts`,
    );
    out.push(
      `  below reflect the session at build time and may be incomplete for the work since.`,
    );
    out.push(
      `  Regenerate: end the session (SessionEnd) to finalize a fresh ledger, then re-run mla review.`,
    );
    out.push(`  Inspect raw turns now: mla session show`);
  }

  if (packet.warnings && packet.warnings.length > 0) {
    out.push(`\nWarnings`);
    out.push(fmtList(packet.warnings));
  }

  out.push(`\nCapture summary`);
  out.push(fmtCaptureSummary(packet));

  out.push(`\nFacts (deterministic)`);
  out.push(fmtFacts(packet.facts));

  out.push(`\nObserved Bash events`);
  out.push(fmtBashEvents(packet.bashEvents));

  out.push(`\nMissing evidence flags`);
  out.push(fmtList(packet.missingEvidence));

  if (packet.agentClaimsRaw) {
    out.push(`\nAgent self-report (verbatim final message; NOT verified)`);
    out.push(`  ${packet.agentClaimsRaw.slice(0, 1200).replace(/\n/g, "\n  ")}`);
  }

  // No "Recommended next prompt" block (Mission deletion, PR1 Correction 5): the
  // steering prompt was the lone surviving review-steering output and it embedded
  // "Continue mission <X>". The producer side stopped emitting it; the renderer
  // deliberately never surfaces `recommendedNextPrompt` even if a legacy/unmigrated
  // packet still carries one on the wire. The surviving failure signal lives in the
  // Missing-evidence flags above (e.g. `test_command_failed`).

  // E2 run-end review directive (interim form). Per-session pending counts need
  // the session->candidate linkage that lands with extraction (RCA Phase 3); until
  // then this points at the session-scoped `mla review` and the Console queues the
  // command already leads with. No verdict, no count fabrication.
  out.push(`\nReview pending items`);
  out.push(`  This ledger carries no verdict. Captured candidates and claims are reviewed`);
  out.push(`  in the Console queues above. Re-run for this session: mla review`);

  out.push(`\n╰──────────────────────────────────────────────────────────────────────╯`);
  return out.join("\n");
}

export function renderCaseRow(c: {
  id: string;
  status: string;
  riskCategory: string;
  severity: string;
  title: string;
  createdAt?: string;
}): string {
  return `  ${c.id}  [${c.status}]  ${c.severity.toUpperCase()}  ${c.riskCategory}  ${c.title}`;
}

// Matches the risk on a ReviewPacket back to the case row. Cases were created
// via createFromAgentReview using risk.title + risk.category, so a (title,
// category) tuple is the load-bearing key the bridge already commits to. The
// fingerprint sha1 is not exposed on the packet's risks payload, so we cannot
// match by fingerprint client-side.
function pickRiskForCase(
  packet: { risks?: ReviewPacketView["risks"] } | null,
  rowMeta: { title?: string; riskCategory?: string },
): NonNullable<ReviewPacketView["risks"]>[number] | null {
  if (!packet || !packet.risks || packet.risks.length === 0) return null;
  const t = (rowMeta.title || "").trim();
  const cat = (rowMeta.riskCategory || "").trim();
  if (!t && !cat) return null;
  const exact = packet.risks.find(
    (r) => (r.title || "").trim() === t && (r.category || "").trim() === cat,
  );
  if (exact) return exact;
  const byCat = packet.risks.find((r) => (r.category || "").trim() === cat);
  return byCat ?? null;
}

export function fmtCaseShow(row: any, packet: any | null): string {
  const meta = (row?.metadata ?? {}) as Record<string, any>;
  const out: string[] = [];
  out.push(`╭─ Meetless CoordinationCase ───────────────────────────────────────────╮`);
  out.push(`  id:           ${row?.id ?? "?"}`);
  out.push(`  kind:         ${row?.kindId ?? "?"}`);
  out.push(`  status:       ${row?.statusId ?? row?.status ?? "?"}`);
  if (row?.canonicalFingerprint) {
    out.push(`  fingerprint:  ${row.canonicalFingerprint}`);
  }
  if (row?.createdAt) out.push(`  created:      ${row.createdAt}`);
  if (row?.closedAt) {
    out.push(`  closed:       ${row.closedAt}  (${row.closedReason ?? "no reason"})`);
  }
  out.push(`────────────────────────────────────────────────────────────────────────`);

  const sev = (meta.severity || "?").toString().toUpperCase();
  const cat = meta.riskCategory || row?.kindId || "?";
  const title = meta.title || "(no title)";
  out.push(`\n  ${sev}  ${cat}  ${title}`);
  if (meta.description) {
    out.push(`\n${("  " + String(meta.description)).replace(/\n/g, "\n  ")}`);
  }

  // Evidence: prefer the packet's risk row (carries the wire refs). Fall back
  // to evidenceCount on the case row so we at least surface that signal.
  const matched = pickRiskForCase(packet, {
    title: meta.title,
    riskCategory: meta.riskCategory,
  });
  if (matched && matched.evidence && matched.evidence.length > 0) {
    const rendered = matched.evidence.map(fmtEvidenceRef).filter((s): s is string => !!s);
    if (rendered.length > 0) {
      out.push(`\n  evidence:`);
      for (const r of rendered) out.push(`    - ${r}`);
    }
  } else if (typeof meta.evidenceCount === "number" && meta.evidenceCount > 0) {
    out.push(`\n  evidence: (${meta.evidenceCount} refs on packet; run \`mla review by-run <runId>\` to inspect)`);
  }

  if (meta.runId) {
    out.push(`\n  run id:       ${meta.runId}`);
    if (meta.packetId) out.push(`  packet id:    ${meta.packetId}`);
    out.push(`\n  next: mla review   (run inside the Claude Code session that produced this packet)`);
  }

  out.push(`\n╰──────────────────────────────────────────────────────────────────────╯`);
  return out.join("\n");
}

// =============================================================================
// KB curation receipts (notes/20260530-mla-kb-curation-cli-proposal-v2 §4)
// =============================================================================
//
// The renderers below feed `mla kb add | show | forget | reingest | purge |
// move`. Each command's HTTP layer returns a typed JSON
// envelope; the commands hand the parsed envelope to a renderer here and a
// final console.log of the returned string is the only stdout the operator
// sees. Receipts always close with a one-line `next:` hint so the operator
// knows what verifies the action.
//
// Display formatting choices:
//   - Box-drawing characters match the existing review/case renderers so
//     `mla` output looks consistent across surfaces.
//   - Hashes render as 12-char prefixes (`a3f9e2c10b48...`). The full value
//     lives in the audit log; the prefix is enough to spot a divergence.
//   - Counterpart tags ("[tombstoned: 2026-05-30T...]") inline next to the
//     edge counterpart per §4.2 correction #8.
//   - Timestamps render as the raw ISO string from intel. No timezone
//     conversion in the CLI; the operator's terminal already knows.

function fmtKv(key: string, value: string | number | undefined | null): string {
  const v = value === undefined || value === null ? "(unset)" : String(value);
  return `  ${key.padEnd(18, " ")} ${v}`;
}

function fmtHashPrefix(hash: string | null | undefined): string {
  if (!hash) return "(none)";
  return hash.length <= 12 ? hash : `${hash.slice(0, 12)}...`;
}


// B1: turn a GRAPH_EXTRACT extraction state into a human + agent signal. The
// async-queued case is the current default (the worker owns the LLM detector);
// the concrete states arrive once B3 polls the job to completion.
function fmtExtractionValue(ex: NonNullable<KbAddReceipt["extraction"]>): string {
  switch (ex.state) {
    case "queued":
      return "extraction queued (async; check `mla kb show` once it completes)";
    case "running":
      return "extracting now (async; check `mla kb show` once it completes)";
    case "completed": {
      const n = ex.candidateCount ?? 0;
      const c = ex.conflictCount ?? 0;
      const noun = `${n} candidate${n === 1 ? "" : "s"}`;
      const conflictPart =
        c > 0 ? ` (${c} conflict${c === 1 ? "" : "s"}: CONTRADICTS/SUPERSEDES)` : "";
      const review = n > 0 ? "; review with `mla kb pending`" : "; none to review";
      return `${noun}${conflictPart}${review}`;
    }
    case "failed":
      return "extraction FAILED; retry with `mla kb reingest`";
    case "skipped":
      return "not re-extracted (no body change)";
  }
}

export interface KbAddReceipt {
  mode: "file" | "corpus";
  workspaceId: string;
  // Governed UPSERT collapses the old tombstone tree to two non-failure outcomes:
  // a new revision was minted + activated ("ingested"), or the delivered content was
  // byte-identical to the current head and nothing changed ("noop_unchanged"). The
  // old restore_* branches are dead under the governed front door.
  outcome: "ingested" | "noop_unchanged" | "failed";
  documentId: string;
  canonicalPath: string;
  parentUuid: string;
  // ADVISORY echo. Governed provenance is server-derived from the delivery envelope
  // (a git-commit import derives external_imported); on a minted revision this
  // reports the server-derived value, not the --provenance flag.
  provenance: string;
  revisionId?: string | null;
  revisionStatus?: string | null;
  chunkCount?: number | null;
  normalizedBodyHash?: string | null;
  fullDocumentHash?: string | null;
  outboxEventType?: string | null;
  // B1/B3: relationship extraction (GRAPH_EXTRACT) status for this ingest. When
  // the ingest pipeline reports a concrete state (sync poll, B3) it is rendered
  // verbatim; when absent on a body-changing ingest the receipt infers the
  // async-queued state. A bare `outbox event` is never the only signal.
  extraction?: {
    state: "queued" | "running" | "completed" | "failed" | "skipped";
    candidateCount?: number | null;
    conflictCount?: number | null;
    jobId?: string | null;
  } | null;
  // B4a: the clickable Console review URL. Computed by the command layer via
  // getConsoleUrl(cfg) (the renderer stays pure: no config / env access). Printed
  // ALWAYS when present so the operator can jump to the human review surface;
  // never auto-opened (a receipt is text, not a browser launch).
  consoleUrl?: string | null;
  // corpus mode: per-doc rollup
  corpus?: {
    corpusName: string;
    rootPath: string;
    ingested: number;
    restored: number;
    noChange: number;
    failed: number;
    perDoc: Array<{
      canonicalPath: string;
      outcome: string;
      revisionId?: string | null;
      chunkCount?: number | null;
      failureCode?: string | null;
    }>;
  };
  // failure metadata when outcome=failed
  failure?: { code: string; reason: string; failedAt: string } | null;
}

export function renderKbAddReceipt(r: KbAddReceipt): string {
  const out: string[] = [];
  const verb = r.mode === "corpus" ? "corpus" : "file";
  out.push(`╭─ mla kb add (${verb}) ${"─".repeat(Math.max(0, 49 - verb.length))}╮`);
  out.push(fmtKv("workspace:", r.workspaceId));
  out.push(fmtKv("outcome:", r.outcome));
  out.push(fmtKv("documentId:", r.documentId));
  out.push(fmtKv("canonicalPath:", r.canonicalPath));
  out.push(fmtKv("parentUuid:", r.parentUuid));
  out.push(fmtKv("provenance:", r.provenance));

  if (r.outcome === "failed" && r.failure) {
    out.push("");
    out.push(fmtKv("FAILED code:", r.failure.code));
    out.push(fmtKv("FAILED reason:", r.failure.reason));
    out.push(fmtKv("FAILED at:", r.failure.failedAt));
  } else {
    out.push("");
    out.push(fmtKv("revisionId:", r.revisionId || "(unset)"));
    out.push(fmtKv("revision status:", r.revisionStatus || "(unset)"));
    out.push(fmtKv("chunk count:", r.chunkCount ?? 0));
    out.push(fmtKv("normalizedBody:", fmtHashPrefix(r.normalizedBodyHash)));
    out.push(fmtKv("fullDocument:", fmtHashPrefix(r.fullDocumentHash)));
    out.push(fmtKv("outbox event:", r.outboxEventType || "(none)"));
    // B1: never let `outbox event` be the only post-ingest signal. A minted
    // revision enqueues GRAPH_EXTRACT; say so honestly. A noop_unchanged delivery
    // mints nothing, so it enqueues no extraction.
    const enqueuesExtraction = r.outcome === "ingested";
    if (r.extraction) {
      out.push(fmtKv("relationships:", fmtExtractionValue(r.extraction)));
    } else if (enqueuesExtraction) {
      out.push(fmtKv("relationships:", fmtExtractionValue({ state: "queued" })));
    }
  }

  if (r.corpus) {
    out.push("");
    out.push(`  corpus: ${r.corpus.corpusName}`);
    out.push(`  root:   ${r.corpus.rootPath}`);
    out.push(
      `  totals: ingested=${r.corpus.ingested} restored=${r.corpus.restored} ` +
        `no_change=${r.corpus.noChange} failed=${r.corpus.failed}`,
    );
    if (r.corpus.perDoc.length > 0) {
      out.push("");
      out.push("  per doc:");
      for (const d of r.corpus.perDoc) {
        const chunkPart = typeof d.chunkCount === "number" ? ` chunks=${d.chunkCount}` : "";
        const failPart = d.failureCode ? ` failure=${d.failureCode}` : "";
        out.push(`    - ${d.canonicalPath}  [${d.outcome}]${chunkPart}${failPart}`);
      }
    }
  }

  // B4a: always surface the Console review URL when the command layer supplies
  // it. The human reviews candidate edges in the Console; the CLI prints the
  // clickable link rather than auto-opening a browser.
  if (r.consoleUrl) {
    out.push("");
    out.push(fmtKv("review (console):", r.consoleUrl));
  }

  out.push("");
  out.push(`  next: mla kb show ${r.canonicalPath}`);
  out.push(`╰──────────────────────────────────────────────────────────────────────╯`);
  return out.join("\n");
}

export interface KbShowRevision {
  id: string;
  // Lifecycle axis: INGESTING | ACTIVE | SUPERSEDED | FAILED.
  status: string;
  // Trust axis: PENDING ("Proposed") | ACCEPTED ("Trusted") | REJECTED.
  reviewOutcome: string;
  // Provenance axis (origin label): human_authored | agent_distilled | ...
  provenance: string;
  // Provenance axis (actor): human | agent | tool | import.
  actorType: string;
  scopeAtIngest?: string | null;
  rawContentHash?: string | null;
  normalizedContentHash?: string | null;
  contentNormalizationVersion?: string | null;
  externalRevisionId?: string | null;
  // Redaction axis: NONE | REDACTED.
  redactionState?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  createdAt?: string | null;
}

export interface KbShowChunkPreview {
  id: string;
  revisionId: string;
  startOffset: number;
  endOffset: number;
  bytes: number;
  // True when the source revision is REDACTED: text withheld, offsets retained.
  redacted: boolean;
  preview: string;
}

// One derived claim (read-only). Trust (`reviewOutcome`, null when never
// reviewed) and the orthogonal machine `groundingStatus` are surfaced
// separately, never conflated.
export interface KbShowClaimPreview {
  id: string;
  kind: string;
  groundingStatus: string;
  reviewOutcome: string | null;
  // Lifecycle: ACTIVE | RETIRED | SUPERSEDED | REJECTED | ...
  lifecycleStatus: string;
  preview: string;
}

// One entry in the unified audit timeline. `entryKind` is REVIEW (a trust
// verdict) or LIFECYCLE (a tombstone / redact); `summary` is the human-readable
// one-liner for that variant. `actorId` + `occurredAt` are hoisted so the
// timeline renders who + when without unwrapping the variant.
export interface KbShowAuditEntry {
  entryKind: string;
  actorId: string;
  occurredAt: string;
  summary: string;
}

export interface KbShowView {
  workspaceId: string;
  document: {
    id: string;
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
  };
  // Intel's authoritative governed-liveness rollup; the CLI never re-derives it.
  serving: boolean;
  // Lifecycle classification behind `serving`: SERVING | NO_HEAD |
  // NO_SERVING_REVISION.
  servingStatus: string;
  // The current head when activated; null before the first activation.
  headRevision: KbShowRevision | null;
  // Newest-first.
  revisionHistory: KbShowRevision[];
  revisionHistoryTruncated: boolean;
  chunks: {
    totalCount: number;
    totalBytes: number;
    preview: KbShowChunkPreview[];
  };
  // The derived claim rail (head revision's claims), read-only.
  claims: {
    totalCount: number;
    preview: KbShowClaimPreview[];
  };
  // Oldest-first unified timeline: trust verdicts + lifecycle mutations.
  audit: KbShowAuditEntry[];
  auditTruncated: boolean;
  // B4a: the clickable Console URL for review. Computed by the command layer via
  // getConsoleUrl(cfg); printed ALWAYS when present, never auto-opened.
  consoleUrl?: string | null;
}

function fmtRevisionLine(r: KbShowRevision): string {
  const parts = [`${r.id}  [${r.status}]`];
  parts.push(`trust=${r.reviewOutcome}`);
  parts.push(`provenance=${r.provenance}`);
  if (r.redactionState && r.redactionState !== "NONE") {
    parts.push(`redaction=${r.redactionState}`);
  }
  if (r.createdAt) parts.push(r.createdAt);
  return parts.join("  ");
}

export function renderKbShow(view: KbShowView): string {
  const out: string[] = [];
  const d = view.document;
  out.push(`╭─ mla kb show ────────────────────────────────────────────────────────╮`);
  out.push(`  workspace: ${view.workspaceId}`);
  out.push("");
  out.push(`  IDENTITY + LIFECYCLE`);
  out.push(fmtKv("id:", d.id));
  out.push(fmtKv("source:", `${d.sourceSystem}:${d.sourceTenantId}`));
  out.push(fmtKv("externalObjectId:", d.externalObjectId));
  out.push(fmtKv("scope:", d.scope));
  out.push(fmtKv("owner:", d.ownerUserId));
  out.push(fmtKv("currentRevisionId:", d.currentRevisionId || "(none)"));
  out.push(fmtKv("headGeneration:", d.headGeneration));
  out.push(fmtKv("tombstoneState:", d.tombstoneState));

  out.push("");
  out.push(`  GROUNDING`);
  // `serving` is the authoritative signal that this doc's text is live in the
  // retrieval corpus; `servingStatus` classifies the not-serving reasons. The
  // CLI never re-derives either (they are intel's governed-liveness rollup).
  out.push(
    fmtKv("serving:", view.serving ? "YES (text is live in retrieval)" : "NO"),
  );
  out.push(fmtKv("servingStatus:", view.servingStatus));

  out.push("");
  out.push(`  HEAD REVISION`);
  if (!view.headRevision) {
    out.push(
      `    (no activated head; doc state = ${d.tombstoneState}, serving = ${view.servingStatus})`,
    );
  } else {
    const cr = view.headRevision;
    out.push(fmtKv("revisionId:", cr.id));
    out.push(fmtKv("status:", cr.status));
    out.push(fmtKv("trust (reviewOutcome):", cr.reviewOutcome));
    out.push(fmtKv("provenance:", cr.provenance));
    out.push(fmtKv("actorType:", cr.actorType));
    out.push(fmtKv("scopeAtIngest:", cr.scopeAtIngest || "(unset)"));
    out.push(fmtKv("redaction:", cr.redactionState || "NONE"));
    out.push(fmtKv("normalizedContent:", fmtHashPrefix(cr.normalizedContentHash)));
    out.push(fmtKv("rawContent:", fmtHashPrefix(cr.rawContentHash)));
    if (cr.reviewedBy) out.push(fmtKv("reviewedBy:", cr.reviewedBy));
    if (cr.reviewedAt) out.push(fmtKv("reviewedAt:", cr.reviewedAt));
    out.push(fmtKv("createdAt:", cr.createdAt || "(unset)"));
  }

  out.push("");
  out.push(`  REVISION HISTORY${view.revisionHistoryTruncated ? "  (truncated; pass --all)" : ""}`);
  if (view.revisionHistory.length === 0) {
    out.push(`    (no revisions on file)`);
  } else {
    for (const r of view.revisionHistory) {
      out.push(`    ${fmtRevisionLine(r)}`);
    }
  }

  out.push("");
  out.push(`  CHUNKS  (head revision's served text)`);
  out.push(fmtKv("total count:", view.chunks.totalCount));
  out.push(fmtKv("total bytes:", view.chunks.totalBytes));
  if (view.chunks.preview.length > 0) {
    out.push("    preview:");
    for (const c of view.chunks.preview) {
      const body = c.redacted ? "(redacted)" : c.preview.slice(0, 80);
      out.push(`      [${c.startOffset}-${c.endOffset}] ${body}`);
    }
  }

  out.push("");
  out.push(`  CLAIMS  (${view.claims.totalCount})`);
  if (view.claims.preview.length === 0) {
    out.push(`    (no claims extracted for the head revision)`);
  } else {
    for (const c of view.claims.preview) {
      const trust = c.reviewOutcome || "unreviewed";
      out.push(
        `    [${c.lifecycleStatus}/${trust}/${c.groundingStatus}] ${c.preview.slice(0, 80)}`,
      );
    }
    if (view.claims.totalCount > view.claims.preview.length) {
      const more = view.claims.totalCount - view.claims.preview.length;
      out.push(`    ... and ${more} more (pass --all to list every claim)`);
    }
  }

  out.push("");
  out.push(`  AUDIT TRAIL${view.auditTruncated ? "  (truncated; pass --audit-all)" : ""}`);
  if (view.audit.length === 0) {
    out.push(`    (no audit rows)`);
  } else {
    for (const a of view.audit) {
      out.push(`    ${a.occurredAt}  ${a.entryKind}  ${a.summary}  (by ${a.actorId})`);
    }
  }

  // Relationship edges (candidates + promoted) are no longer part of the detail
  // bundle: intel re-homed them to the navigation lane (kb-console re-home,
  // notes/20260621-kb-console-rehome-two-axis.md §3.2). The Console is the human
  // surface for reviewing them.
  if (view.consoleUrl) {
    out.push("");
    out.push(`  CONSOLE`);
    out.push(`    relationships + review queue: ${view.consoleUrl}`);
  }

  out.push("");
  out.push(`╰──────────────────────────────────────────────────────────────────────╯`);
  return out.join("\n");
}

export interface KbForgetReceipt {
  workspaceId: string;
  outcome: "tombstoned" | "already_tombstoned";
  documentId: string;
  canonicalPath: string;
  priorRevisionId?: string | null;
  reason?: string | null;
}

// The governed tombstone flips one column (tombstoneState ACTIVE -> TOMBSTONED);
// the serve gate drops the doc at read time via the liveness predicate, so there
// is no chunk sweep, no outbox event, and no tombstone-timestamp column to echo.
export function renderKbForgetReceipt(r: KbForgetReceipt): string {
  const out: string[] = [];
  out.push(`╭─ mla kb forget ──────────────────────────────────────────────────────╮`);
  out.push(fmtKv("workspace:", r.workspaceId));
  out.push(fmtKv("outcome:", r.outcome));
  out.push(fmtKv("documentId:", r.documentId));
  out.push(fmtKv("canonicalPath:", r.canonicalPath));
  out.push(fmtKv("priorRevisionId:", r.priorRevisionId || "(none)"));
  if (r.reason) out.push(fmtKv("reason:", r.reason));
  out.push("");
  out.push(`  next: mla kb show kbdoc:${r.documentId}   (verify tombstoneState)`);
  out.push(`╰──────────────────────────────────────────────────────────────────────╯`);
  return out.join("\n");
}

export interface KbReingestReceipt {
  workspaceId: string;
  // Governed UPSERT outcomes (mirror mla kb add): a content no-op, a new ACTIVE
  // revision, or a failure. The posture-era enum
  // (no_change/frontmatter_only/shadow_pending_review/accepted_on_write) is dead.
  outcome: "ingested" | "noop_unchanged" | "failed";
  documentId: string;
  canonicalPath: string;
  parentUuid: string;
  priorRevisionId?: string | null;
  // Server-derived provenance recorded on the minted revision (advisory at the CLI).
  provenance?: string | null;
  newRevisionId?: string | null;
  newRevisionStatus?: string | null;
  chunkCount?: number | null;
  normalizedBodyHash?: string | null;
  fullDocumentHash?: string | null;
  reason?: string | null;
  failure?: { code: string; reason: string; failedAt: string } | null;
}

export function renderKbReingestReceipt(r: KbReingestReceipt): string {
  const out: string[] = [];
  out.push(`╭─ mla kb reingest ────────────────────────────────────────────────────╮`);
  out.push(fmtKv("workspace:", r.workspaceId));
  out.push(fmtKv("outcome:", r.outcome));
  out.push(fmtKv("documentId:", r.documentId));
  out.push(fmtKv("canonicalPath:", r.canonicalPath));
  out.push(fmtKv("parentUuid:", r.parentUuid));
  out.push(fmtKv("priorRevisionId:", r.priorRevisionId || "(none)"));

  if (r.outcome === "failed" && r.failure) {
    out.push(fmtKv("newRevisionId:", r.newRevisionId || "(none)"));
    out.push(fmtKv("FAILED code:", r.failure.code));
    out.push(fmtKv("FAILED reason:", r.failure.reason));
    out.push(fmtKv("FAILED at:", r.failure.failedAt));
  } else if (r.outcome === "noop_unchanged") {
    // Content-identical re-delivery: nothing minted, prior head unchanged.
    out.push(fmtKv("note:", "content unchanged; no new revision minted"));
  } else {
    out.push(fmtKv("newRevisionId:", r.newRevisionId || "(unset)"));
    out.push(fmtKv("revision status:", r.newRevisionStatus || "(unset)"));
    out.push(fmtKv("provenance:", r.provenance || "(unset)"));
    out.push(fmtKv("chunk count:", r.chunkCount ?? 0));
    out.push(fmtKv("normalizedBody:", fmtHashPrefix(r.normalizedBodyHash)));
    out.push(fmtKv("fullDocument:", fmtHashPrefix(r.fullDocumentHash)));
  }

  if (r.reason) out.push(fmtKv("reason:", r.reason));
  out.push("");
  out.push(`  next: mla kb show kbdoc:${r.documentId}`);
  out.push(`╰──────────────────────────────────────────────────────────────────────╯`);
  return out.join("\n");
}

export interface KbPurgeReceipt {
  workspaceId: string;
  // Governed purge = redact EVERY revision (irreversible content removal in
  // slice A, audit metadata retained) + tombstone the document. "purged" did
  // work this run; "already_purged" found nothing left to redact or tombstone.
  // The old phase1_committed/blocked enum and the §7 edge-guard/two-phase/
  // HARD_DELETE_PENDING/weaviate/graph-cleanup machinery are dead.
  outcome: "purged" | "already_purged";
  documentId: string;
  canonicalPath: string;
  priorRevisionId?: string | null;
  revisionsTotal: number;
  revisionsRedacted: number;
  revisionsAlreadyRedacted: number;
  // Always TOMBSTONED after a successful purge: slice A ships no PURGED setter,
  // so a terminal physical hard-delete stays deferred.
  tombstoneState: string;
  reason: string;
}

export function renderKbPurgeReceipt(r: KbPurgeReceipt): string {
  const out: string[] = [];
  out.push(`╭─ mla kb purge ───────────────────────────────────────────────────────╮`);
  out.push(fmtKv("workspace:", r.workspaceId));
  out.push(fmtKv("outcome:", r.outcome));
  out.push(fmtKv("documentId:", r.documentId));
  out.push(fmtKv("canonicalPath:", r.canonicalPath));
  out.push(fmtKv("priorRevisionId:", r.priorRevisionId || "(none)"));
  out.push(fmtKv("revisions total:", r.revisionsTotal));
  out.push(fmtKv("revisions redacted:", r.revisionsRedacted));
  out.push(fmtKv("already redacted:", r.revisionsAlreadyRedacted));
  out.push(fmtKv("tombstoneState:", r.tombstoneState));
  out.push(fmtKv("reason:", r.reason));
  out.push("");
  if (r.outcome === "already_purged") {
    out.push(`  note: every revision was already redacted and the document was`);
    out.push(`        already tombstoned; nothing to do.`);
  } else {
    out.push(`  note: all revisions redacted (content gone, audit metadata kept).`);
    out.push(`        slice A has no physical-purge primitive, so the document is`);
    out.push(`        TOMBSTONED rather than PURGED.`);
  }
  out.push(`  next: mla kb show kbdoc:${r.documentId}   (verify tombstoneState)`);
  out.push(`╰──────────────────────────────────────────────────────────────────────╯`);
  return out.join("\n");
}

// `mla kb move` is a BLOCKED capability in slice A (governed identity is the
// source tuple; re-pathing yields a different document and there is no redirect
// primitive yet), so it emits no receipt. The legacy KbMoveReceipt /
// renderKbMoveReceipt were removed: they modeled now-dead concepts (parentUuid,
// path_aliases, the KB_MOVED outbox event). When move is unblocked under a real
// redirect primitive, a fresh receipt should be defined against that model.

