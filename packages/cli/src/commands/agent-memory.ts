// src/commands/agent-memory.ts
//
// `mla agent-memory <enable|disable|status|scan|push|report>`: the operator
// surface for the agent-memory capture pipeline
// (notes/20260626-agent-memory-auto-capture-proposal.md).
//
// `scan` is the Phase 1 DRY-RUN: it observes, classifies, secret-scans
// (observe-only: signals are recorded, nothing is blocked), and records
// metadata-only decisions locally; it uploads NOTHING.
//
// `push` is the LIVE pass: it uploads changed project-type memory revisions to
// the governed KB (born PENDING, non-grounding), withholding any file carrying a
// known credential format (SECRET-1). It refuses without --yes and otherwise
// self-gates on a consented binding + a resolvable actor. The same collector
// also runs (with the same gates) from the Stop auto-index worker, so a manual
// push and an automatic Stop pass behave identically. Claim extraction over the
// resulting derived revisions runs in intel (Phase 2B); the cross-revision
// claim-grain identity (DERIVED-IDEMPOTENCY-1) keeps a re-extracted claim's
// human verdict bound across revisions.
//
// Consent (CONSENT-1) is explicit and per-directory: `enable` shows the resolved
// directory, the target workspace, and exactly what capture does, and refuses to
// persist a binding without `--yes`.
import { existsSync, statSync } from "node:fs";

import { agentMemoryDir } from "../lib/scanner/agent-memory";
import { resolveWorkspaceContext } from "../lib/workspace";
import {
  canonicalizeDir,
  disableBinding,
  enableBinding,
  listBindings,
} from "../lib/agent-memory-capture/binding";
import { runDryRunCollector } from "../lib/agent-memory-capture/collector";
import { runLiveCollector } from "../lib/agent-memory-capture/live-collector";
import { readLedger } from "../lib/agent-memory-capture/ledger";
import { readLiveLedger } from "../lib/agent-memory-capture/live-ledger";
import { analyzeCorpus } from "../lib/agent-memory-capture/report";
import type { DecisionRecord, LiveRecord } from "../lib/agent-memory-capture/types";

interface ParsedArgs {
  sub: string | null;
  dir: string | null;
  workspace: string | null;
  yes: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { sub: null, dir: null, workspace: null, yes: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      out.dir = argv[++i] ?? null;
      continue;
    }
    if (a === "--workspace") {
      out.workspace = argv[++i] ?? null;
      continue;
    }
    if (a === "--yes" || a === "-y") {
      out.yes = true;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    }
    if (out.sub === null) {
      out.sub = a;
      continue;
    }
    throw new Error(`Unexpected argument: ${a}`);
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

// Resolve the directory to operate on: --dir override, else the Claude
// auto-memory dir for the current project cwd.
function resolveDir(dir: string | null): string {
  return dir && dir.trim() ? dir.trim() : agentMemoryDir(process.cwd());
}

const CONSENT_LINES = [
  "This enables LOCAL DRY-RUN capture only (Phase 1).",
  "mla will observe project-type memory files in this directory, hash and",
  "secret-scan them, and record metadata-only decisions to a local log.",
  "Nothing is uploaded in this phase.",
  "",
  "Secret patterns are recorded as observations only here; they do not block",
  "anything, because nothing leaves the machine. Pre-upload credential",
  "blocking arrives with remote capture (Phase 2B), not in this phase.",
  "Raw memory notes never ground any agent answer.",
];

function runEnable(args: ParsedArgs): number {
  const dir = resolveDir(args.dir);
  let workspaceId: string;
  if (args.workspace && args.workspace.trim()) {
    workspaceId = args.workspace.trim();
  } else {
    try {
      workspaceId = resolveWorkspaceContext().workspaceId;
    } catch {
      console.error(
        "No activated workspace found. Run this inside an activated repo or pass --workspace <id>.",
      );
      return 2;
    }
  }

  const canonical = canonicalizeDir(dir);
  if (!canonical) {
    console.error(`Memory directory does not resolve: ${dir}`);
    console.error("Pass an existing directory with --dir, or activate Claude memory first.");
    return 2;
  }

  if (!args.yes) {
    console.log(`Directory: ${canonical}`);
    console.log(`Workspace: ${workspaceId}`);
    console.log("");
    for (const l of CONSENT_LINES) console.log(l);
    console.log("");
    console.log("Re-run with --yes to consent and enable dry-run capture.");
    return 0;
  }

  const outcome = enableBinding(canonical, workspaceId, nowIso());
  if (!outcome.ok) {
    if (outcome.reason === "workspace-conflict") {
      console.error(
        `This directory is already bound to workspace ${outcome.conflictWorkspaceId}. ` +
          "One memory directory binds exactly one workspace (MEMORY-WORKSPACE-1). " +
          "Disable the existing binding first.",
      );
      return 2;
    }
    console.error(`Memory directory does not resolve: ${dir}`);
    return 2;
  }

  const b = outcome.binding;
  console.log(
    `${outcome.reactivated ? "Reactivated" : "Enabled"} dry-run capture for ${b.memoryDir}`,
  );
  console.log(`Binding: ${b.bindingId} -> workspace ${b.workspaceId}`);
  console.log("Run `mla agent-memory scan` to record a dry-run pass (uploads nothing).");
  return 0;
}

function runDisable(args: ParsedArgs): number {
  const dir = resolveDir(args.dir);
  const canonical = canonicalizeDir(dir) ?? dir;
  const b = disableBinding(canonical);
  if (!b) {
    console.error(`No capture binding found for ${canonical}`);
    return 1;
  }
  console.log(`Disabled capture for ${b.memoryDir} (binding ${b.bindingId} preserved).`);
  return 0;
}

// Derive the live ledger's counts for one binding: how many paths the SERVER has
// acked (uploaded), how many are currently WITHHELD by the credential denylist
// (blocked), and the total tracked. The live ledger stores acks/blocks, not
// outcomes, so these are computed from the entry shape.
function liveLedgerCounts(bindingId: string): {
  tracked: number;
  uploaded: number;
  blocked: number;
} {
  const entries = Object.values(readLiveLedger(bindingId).entries);
  let uploaded = 0;
  let blocked = 0;
  for (const e of entries) {
    if (e.lastUploadedHash) uploaded++;
    if (e.blockedHash) blocked++;
  }
  return { tracked: entries.length, uploaded, blocked };
}

function runStatus(args: ParsedArgs): number {
  const bindings = listBindings();
  if (args.json) {
    const rows = bindings.map((b) => ({
      ...b,
      ledgerEntries: Object.keys(readLedger(b.bindingId).entries).length,
      live: liveLedgerCounts(b.bindingId),
    }));
    console.log(JSON.stringify({ bindings: rows }, null, 2));
    return 0;
  }
  if (bindings.length === 0) {
    console.log("No agent-memory capture bindings. Run `mla agent-memory enable` to create one.");
    return 0;
  }
  console.log("Live capture runs for [enabled] bindings (per-binding consent is the control).");
  for (const b of bindings) {
    const entries = Object.keys(readLedger(b.bindingId).entries).length;
    const live = liveLedgerCounts(b.bindingId);
    console.log(`${b.enabled ? "[enabled] " : "[disabled]"} ${b.memoryDir}`);
    console.log(`  binding   ${b.bindingId}`);
    console.log(`  workspace ${b.workspaceId}`);
    console.log(`  consented ${b.consentedAt}`);
    console.log(`  tracked   ${entries} file(s) in dry-run ledger`);
    console.log(
      `  live      ${live.tracked} tracked, ${live.uploaded} uploaded, ${live.blocked} blocked`,
    );
  }
  return 0;
}

function tally(records: DecisionRecord[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const r of records) t[r.decision] = (t[r.decision] ?? 0) + 1;
  return t;
}

function runScan(args: ParsedArgs): number {
  const results = runDryRunCollector({ nowIso: nowIso() });
  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return 0;
  }
  if (results.length === 0) {
    console.log("No enabled bindings. Run `mla agent-memory enable` first.");
    return 0;
  }
  for (const r of results) {
    if (!r.locked) {
      console.log(`${r.bindingId}: skipped (another collector holds the lock)`);
      continue;
    }
    const s = r.summary;
    if (!s) {
      console.log(`${r.bindingId}: no summary`);
      continue;
    }
    const t = tally(s.records);
    const parts = Object.entries(t).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(
      `${s.memoryDir} [scan ${s.scanComplete ? "complete" : "PARTIAL"}] ${parts || "(no files)"}`,
    );
    console.log(`  appended ${r.appended} actionable decision(s) to the dry-run log`);
  }
  return 0;
}

function liveTally(records: LiveRecord[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const r of records) t[r.outcome] = (t[r.outcome] ?? 0) + 1;
  return t;
}

// `push`: the LIVE upload pass. Refuses without --yes; otherwise shares the exact
// collector + gates the Stop worker uses (a consented binding + a resolvable
// actor), so a manual push and an automatic Stop pass behave identically.
async function runPush(args: ParsedArgs): Promise<number> {
  if (!args.yes) {
    console.log("This will UPLOAD changed project-type memory files from every enabled binding");
    console.log("to the governed KB (born PENDING, non-grounding). They never ground any agent");
    console.log("answer until a human accepts a derived claim. Files carrying a known credential");
    console.log("format are withheld. Re-run with --yes to upload.");
    console.log("");
    console.log("With no enabled binding, or while logged out, this uploads nothing.");
    return 0;
  }

  const results = await runLiveCollector({ nowIso: nowIso() });
  if (args.json) {
    console.log(JSON.stringify({ results }, null, 2));
    return 0;
  }
  if (results.length === 0) {
    console.log(
      "No live upload performed (no enabled bindings, or no resolvable actor identity).",
    );
    return 0;
  }
  for (const r of results) {
    if (!r.locked) {
      console.log(`${r.bindingId}: skipped (another collector holds the lock)`);
      continue;
    }
    const s = r.summary;
    if (!s) {
      console.log(`${r.bindingId}: no summary`);
      continue;
    }
    const t = liveTally(s.records);
    const parts = Object.entries(t)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(
      `${s.memoryDir} [scan ${s.scanComplete ? "complete" : "PARTIAL"}] ${parts || "(no files)"}`,
    );
    console.log(`  appended ${r.appended} actionable outcome(s) to the live log`);
  }
  return 0;
}

function runReport(args: ParsedArgs): number {
  const dir = resolveDir(args.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`Not a directory: ${dir}`);
    return 2;
  }
  const report = analyzeCorpus(dir);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`Corpus: ${report.memoryDir}`);
  console.log(`Total .md files: ${report.totalMdFiles}`);
  console.log(`By type: ${JSON.stringify(report.byType)}`);
  console.log(
    `Size bytes: min=${report.sizeBytes.min} median=${report.sizeBytes.median} ` +
      `p90=${report.sizeBytes.p90} max=${report.sizeBytes.max}`,
  );
  console.log(`Project files with a secret signal (observe-only): ${report.secretSignalFiles.length}`);
  for (const b of report.secretSignalFiles) {
    console.log(`  ${b.file}: ${b.ruleIds.join(", ")}`);
  }
  console.log(
    `Phase 2B credential-denylist probe (known fixtures caught): ${report.credentialProbePass ? "PASS" : "FAIL"}`,
  );
  if (report.credentialProbeMisses.length > 0) {
    console.log(`  UNDETECTED known credential token(s) in: ${report.credentialProbeMisses.join(", ")}`);
  }
  console.log("");
  console.log("Manual gates (not auto-measured):");
  for (const g of report.manualGates) console.log(`  - ${g}`);
  return 0;
}

export async function runAgentMemory(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  switch (args.sub) {
    case "enable":
      return runEnable(args);
    case "disable":
      return runDisable(args);
    case "status":
      return runStatus(args);
    case "scan":
      return runScan(args);
    case "push":
      return runPush(args);
    case "report":
      return runReport(args);
    default:
      console.error(
        "Usage: mla agent-memory <enable|disable|status|scan|push|report> [--dir <path>] [--workspace <id>] [--yes] [--json]",
      );
      return 2;
  }
}
