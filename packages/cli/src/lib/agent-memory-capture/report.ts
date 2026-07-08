// src/lib/agent-memory-capture/report.ts
//
// Phase 0A static corpus value gate (§6): read-only statistics over a memory
// directory, sends nothing. It measures the STATIC properties the doc allows to
// be computed automatically (counts by type, size distribution) and explicitly
// leaves the judgement gates (net-new reviewable %, overlap with session
// capture, mixed-content rate) to a manual stratified review, which it reminds
// the operator to run. Dynamic volume is NOT measured here (the memory dir has
// no reliable revision history); that lives in the Phase 1 dry-run collector.
//
// Secret scanning here is OBSERVE-ONLY (An's verdict 2026-06-27): a hit is a
// reported signal, never a value gate and never a block. The local phases upload
// nothing, so there is nothing to protect; pre-upload credential blocking is a
// Phase 2B concern. The named-fixture check is kept only as a Phase 2B
// readiness probe (does the scanner still catch the known live credential?).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { scanForSecrets } from "../redactor";
import { classifyMemory } from "./classify";

// Tokens that the future Phase 2B pre-upload credential denylist MUST catch
// (the credential-denylist readiness probe). The space-delimited Redis
// `requirepass` directive is the canonical hard fixture: it is the live secret
// known to sit in the real corpus and it slips past the uppercase
// env_assignment + 32-char entropy patterns, so the scanner needs its directive
// pattern to catch it. If a file carries one of these tokens but the scanner
// does NOT match it, the probe fails loudly so the gap is visible before any
// remote capture is ever enabled.
const FIXTURE_TOKENS = ["requirepass", "masterauth", "masteruser"];

export interface FileStat {
  file: string;
  type: string | null;
  malformed: boolean;
  bytes: number;
  // Scanner rule ids that block this file (empty = clean). Rule ids only; never
  // the matched secret.
  blockRuleIds: string[];
  // Carries a known fixture token (gate-3 cross-check).
  hasFixtureToken: boolean;
}

export interface CorpusReport {
  memoryDir: string;
  exists: boolean;
  totalMdFiles: number;
  byType: Record<string, number>;
  projectFiles: number;
  malformedFiles: number;
  sizeBytes: { min: number; median: number; p90: number; max: number };
  // Project files carrying a secret signal (observe-only; NOT blocked, NOT a
  // value gate). Reported so the operator can eyeball false positives.
  secretSignalFiles: Array<{ file: string; ruleIds: string[] }>;
  // Files carrying a known credential fixture token that the scanner FAILED to
  // match. Empty = the Phase 2B credential-denylist probe holds. Non-empty = a
  // known live secret would slip past a future pre-upload blocker.
  credentialProbeMisses: string[];
  credentialProbePass: boolean;
  manualGates: string[];
  files: FileStat[];
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

export function analyzeCorpus(memoryDir: string): CorpusReport {
  let names: string[];
  try {
    names = readdirSync(memoryDir);
  } catch {
    return {
      memoryDir,
      exists: false,
      totalMdFiles: 0,
      byType: {},
      projectFiles: 0,
      malformedFiles: 0,
      sizeBytes: { min: 0, median: 0, p90: 0, max: 0 },
      secretSignalFiles: [],
      credentialProbeMisses: [],
      credentialProbePass: true,
      manualGates: [],
      files: [],
    };
  }

  const files: FileStat[] = [];
  const byType: Record<string, number> = {};
  const sizes: number[] = [];

  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const abs = join(memoryDir, name);
    let bytes: number;
    let text: string;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      bytes = st.size;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const cls = classifyMemory(text);
    const typeKey = cls.malformed ? "malformed" : (cls.type ?? "none");
    byType[typeKey] = (byType[typeKey] ?? 0) + 1;
    sizes.push(bytes);

    // Scan only what MVP would actually capture (project files); still record
    // fixture tokens everywhere so a misclassified secret file is visible.
    const blockRuleIds = cls.type === "project" ? scanForSecrets(text) : [];
    const lower = text.toLowerCase();
    const hasFixtureToken = FIXTURE_TOKENS.some((t) => lower.includes(t));

    files.push({ file: name, type: cls.type, malformed: cls.malformed, bytes, blockRuleIds, hasFixtureToken });
  }

  files.sort((a, b) => a.file.localeCompare(b.file));
  sizes.sort((a, b) => a - b);

  const secretSignalFiles = files
    .filter((f) => f.type === "project" && f.blockRuleIds.length > 0)
    .map((f) => ({ file: f.file, ruleIds: f.blockRuleIds }));

  // Credential-denylist readiness probe: any file carrying a known fixture token
  // must be matched by the scanner. (Scan even non-project files for the
  // cross-check so a mistyped secret file is still caught here.)
  const credentialProbeMisses = files
    .filter((f) => f.hasFixtureToken && scanForSecrets(safeRead(memoryDir, f.file)).length === 0)
    .map((f) => f.file);

  return {
    memoryDir,
    exists: true,
    totalMdFiles: files.length,
    byType,
    projectFiles: byType["project"] ?? 0,
    malformedFiles: byType["malformed"] ?? 0,
    sizeBytes: {
      min: sizes[0] ?? 0,
      median: percentile(sizes, 50),
      p90: percentile(sizes, 90),
      max: sizes[sizes.length - 1] ?? 0,
    },
    secretSignalFiles,
    credentialProbeMisses,
    credentialProbePass: credentialProbeMisses.length === 0,
    manualGates: [
      "Gate 1 (>= 15% of sampled project files carry a net-new reviewable durable item): MANUAL stratified review of 50-75 files.",
      "Gate 2 (existing session capture does not already cover the large majority of valuable findings): MANUAL cross-reference against session-derived KB.",
      "Mixed-content rate (durable claim + transient log in one file): MANUAL design finding, not a numeric gate.",
    ],
    files,
  };
}

function safeRead(dir: string, name: string): string {
  try {
    return readFileSync(join(dir, name), "utf8");
  } catch {
    return "";
  }
}
