// `mla _internal assemble-context` — the byte-budgeted UserPromptSubmit envelope assembler
// (targeted-rule-injection §4, Phase 2). This is the hidden internal seam the hot-path hook
// spawns to turn the scan cache + this turn's path signals into ONE model-facing head that is
// asserted to fit the harness inline window. There is deliberately NO public `mla rule-match`
// surface: matching lives behind the hook, process-isolated in Node so it can do UTF-8 byte
// budgeting and share the Plane B glob matcher, which pure jq cannot.
//
// I/O contract (stdin JSON, stdout head):
//   in : { base, prompt, workingSet[], workspaceId, repoRoot?, safeTotal? }
//        `base` is the hook-rendered static preamble (LAYER1), counted as part of the base
//        that must always fit. `prompt` feeds explicit-path extraction. `workingSet` is the
//        FULL git dirty set (best-effort relevance; 50-cap is telemetry only).
//   out : the exact-byte head to emit as additionalContext, or NOTHING on hard failure.
//
// Fail-soft (matches the other `mla _internal` hot-path subcommands): an unknown flag is a
// strict-parse error (exit 2); any other failure prints nothing and exits 0, so the hook's
// bash fallback (LAYER1 + floor XML) still delivers the floor. The degraded cache states in
// §6 are SUCCESS outputs (non-empty, with a visible marker), NOT the silent fail-soft path:
// only a genuinely unusable environment (no cache readable AND no base) yields empty output.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { Buffer } from "node:buffer";
import { ScanResult, SCAN_SCHEMA_VERSION } from "../lib/scanner/types";
import {
  PersistedAssembleAudit,
  readScanCache,
  writeAssembleAudit,
} from "../lib/scanner/cache";
import { assembleContext, BaseInvariantError } from "../lib/scanner/assemble";
import { extractExplicitPaths } from "../lib/scanner/prompt-paths";
import {
  renderIncompleteDeliveryMarker,
  renderScopedUnavailableMarker,
} from "../lib/scanner/render";

// The connector-owned byte ceiling: strictly below the Phase-0-measured harness inline cap
// (~2048B of the complete, line-trimmed, RAW-text additionalContext — the harness trims the
// visible text to the last complete line, it does not count JSON-serialized bytes). The
// assembler asserts the head (base + floor + scoped) fits this; the variable Layer-2 blocks
// the hook appends AFTER land beyond the window by design and cannot displace anything asserted
// here. Set to the plan's P0.2 target (§Phase 0): 2048 cap, less margin for the block separator
// and the trim line landing mid-block.
//
// MEASURED (2026-07-06, live dogfood ws cmq9l2xom002n5ueiwjuoy9bb): LAYER1 base = 709B. The
// original VERBOSE 6-rule global-MUST floor block measured 1896B, so base+floor = 2605B overran
// the ~2048 cap by ~557B before any scoped rule and the base invariant could not hold at any
// sub-cap value. Fixed by GOVERNANCE (not a renderer change): the 6 floor rules were rewritten to
// compact single-line imperatives, shrinking the floor block to ~1258B, so base+floor = ~1967B,
// under this 2048-anchored budget. The overflow-marker room (~224B) is now reserved CONDITIONALLY
// (assemble.ts: only when a scoped rule exists, since the marker is unreachable otherwise), so the
// zero-scoped common turn delivers the whole compressed floor at ~1967B instead of failing loud.
// SAFE_TOTAL is set to 2000 (2048 cap less a small margin for the block separator and the harness
// trimming the visible text to the last complete line).
export const SAFE_TOTAL = 2000;

export interface AssembleContextDeps {
  readStdin?: () => string;
  readCache?: (home: string, workspaceId: string) => ScanResult | null;
  writeAudit?: (home: string, workspaceId: string, audit: PersistedAssembleAudit) => void;
  home?: string;
  now?: () => string;
  log?: (out: string) => void;
  logErr?: (out: string) => void;
}

interface AssembleStdin {
  base: string;
  prompt: string;
  workingSet: string[];
  workspaceId: string;
  repoRoot?: string;
  safeTotal: number;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// Join non-empty segments with one newline — identical seam to the assembler, so a degraded
// head (base + floor + marker) concatenates exactly as the normal head does.
function joinSegments(parts: string[]): string {
  return parts.filter((p) => p.length > 0).join("\n");
}

/** Parse the stdin envelope. Returns null when the minimum (base + workspaceId) is missing. */
function parseInput(raw: string): AssembleStdin | null {
  const j = JSON.parse(raw) as Record<string, unknown>;
  if (typeof j !== "object" || j === null) return null;
  const base = typeof j.base === "string" ? j.base : "";
  const workspaceId = typeof j.workspaceId === "string" ? j.workspaceId.trim() : "";
  if (!base || !workspaceId) return null;
  const prompt = typeof j.prompt === "string" ? j.prompt : "";
  const workingSet = Array.isArray(j.workingSet)
    ? (j.workingSet.filter((x) => typeof x === "string") as string[])
    : [];
  const repoRoot = typeof j.repoRoot === "string" && j.repoRoot ? j.repoRoot : undefined;
  const safeTotal =
    typeof j.safeTotal === "number" && Number.isFinite(j.safeTotal) && j.safeTotal > 0
      ? Math.floor(j.safeTotal)
      : SAFE_TOTAL;
  return { base, prompt, workingSet, workspaceId, repoRoot, safeTotal };
}

// Sanitize the git working set to repo-relative, contained paths (§4.7 "full working set").
// The dirty set can carry absolute paths, escapes, or junk (contaminated-working-set §8); an
// entry that cannot be proven repo-relative is dropped, never guessed, so it can only fail to
// match, never falsely promote a rule. No 50-cap here: the cap is telemetry-only, matching sees
// the whole set.
function normalizeWorkingSet(entries: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const t = raw.trim();
    if (!t || t.startsWith("/")) continue;
    const n = posix.normalize(t);
    if (n === "" || n === "." || n === ".." || n.startsWith("../") || n.startsWith("/")) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

interface AssembleCtx {
  home: string;
  now: () => string;
  readCache: (home: string, workspaceId: string) => ScanResult | null;
  writeAudit: (home: string, workspaceId: string, audit: PersistedAssembleAudit) => void;
}

// The result of a byte-budgeted assembly attempt. `head` is the exact model-facing envelope (or
// null when nothing can be produced and the bash fallback must own the head). `overflow` is true
// iff an applicable MUST could not be delivered (§7.5): the caller MUST turn this into a
// fail-closed exit so the hook blocks the prompt (INV-DELIVERY). `blockedVersions` names the
// undelivered mandatory RuleVersions so the block message can tell the user exactly what failed.
interface AssembleResult {
  head: string | null;
  overflow: boolean;
  blockedVersions: Array<{ versionId: string; text: string }>;
}

/**
 * Core: read the cache, branch on schemaVersion (§6 degradation table), and return the exact
 * head plus the fail-closed signal. Every branch writes an out-of-band audit, enriched at THIS
 * boundary with each rule's durable RuleVersion identity (§7.4) and dedup represent-edge (§7.3);
 * the pure assembler stays minimal so its tests do not churn on identity plumbing.
 */
function assemble(input: AssembleStdin, ctx: AssembleCtx): AssembleResult {
  const cache = ctx.readCache(ctx.home, input.workspaceId);
  const explicitPaths = extractExplicitPaths(input.prompt, { repoRoot: input.repoRoot });
  const workingSetPaths = normalizeWorkingSet(input.workingSet);

  // ruleId -> durable identity, unioned across floor + scoped cache arrays. Used only to enrich
  // the out-of-band audit and the block message; empty when the cache is absent or pre-v2 (those
  // branches deliver no identified rules anyway).
  const identityByRuleId = new Map<string, { versionId: string; text: string; represents?: string[] }>();
  for (const f of cache?.floorRules ?? []) {
    identityByRuleId.set(f.ruleId, { versionId: f.versionId, text: f.text, represents: f.representedVersionIds });
  }
  for (const s of cache?.scopedRules ?? []) {
    identityByRuleId.set(s.ruleId, { versionId: s.versionId, text: s.text, represents: s.representedVersionIds });
  }

  const emitAudit = (
    state: PersistedAssembleAudit["state"],
    text: string,
    overflow: boolean,
    delivered: Array<{ ruleId: string; tier: string }>,
    omitted: Array<{ ruleId: string; reason: string }>,
    bytes = byteLength(text),
  ): void => {
    ctx.writeAudit(ctx.home, input.workspaceId, {
      schemaVersion: 1,
      at: ctx.now(),
      workspaceId: input.workspaceId,
      state,
      bytes,
      safeTotal: input.safeTotal,
      overflow,
      explicitPaths,
      delivered: delivered.map((d) => {
        const id = identityByRuleId.get(d.ruleId);
        return {
          ruleId: d.ruleId,
          tier: d.tier,
          ...(id?.versionId ? { versionId: id.versionId } : {}),
          ...(id?.represents && id.represents.length ? { represents: id.represents } : {}),
        };
      }),
      omitted: omitted.map((o) => {
        const id = identityByRuleId.get(o.ruleId);
        return {
          ruleId: o.ruleId,
          reason: o.reason,
          ...(id?.versionId ? { versionId: id.versionId } : {}),
        };
      }),
    });
  };

  // Row 5: invalid cache, no usable last-good -> base + visible incomplete-delivery marker.
  if (!cache) {
    const text = joinSegments([input.base, renderIncompleteDeliveryMarker()]);
    emitAudit("incomplete", text, false, [], []);
    return { head: text, overflow: false, blockedVersions: [] };
  }

  // Rows 3/4: old schema. Post-activation, the bulk compat path is gone, so scoped rules cannot
  // be surfaced from this cache. Deliver the pre-rendered floor and a VISIBLE marker (not a
  // silent floor-only success), which drives the operator to rescan to the current schema.
  //
  // Marker BEFORE floor: the harness trims the raw text to the last complete line within the
  // inline window, and the pre-rendered floor can itself overrun that window (§Phase 0: base +
  // floor measured at ~2605B > ~2048 cap). If the marker trailed the floor it would be the
  // segment trimmed away, silently degrading this state back to the floor-only success it exists
  // to distinguish. Placing the marker first (base + marker is ~1009B, always within budget)
  // guarantees the load-bearing degradation signal survives; the floor is the segment that gets
  // truncated instead, which is the correct sacrifice.
  if ((cache.schemaVersion ?? 1) < SCAN_SCHEMA_VERSION) {
    const text = joinSegments([input.base, renderScopedUnavailableMarker(), cache.floorRulesXml ?? ""]);
    emitAudit("old-schema", text, false, [], []);
    return { head: text, overflow: false, blockedVersions: [] };
  }

  // Rows 1/2: current schema. Real byte-budgeted assembly. A cache written by a scan that failed
  // to recompile is simply the previous on-disk cache (the scan side preserves last-known-good by
  // not overwriting on failure), so reading current on-disk state IS "use last-known-good".
  const floorRules = cache.floorRules ?? [];
  const scopedRules = cache.scopedRules ?? [];
  try {
    const out = assembleContext({
      base: input.base,
      prompt: input.prompt,
      floorRules,
      scopedRules,
      explicitPaths,
      workingSetPaths,
      safeTotal: input.safeTotal,
    });
    emitAudit(out.overflow ? "overflow" : "normal", out.text, out.overflow, out.delivered, out.omitted, out.bytes);
    // On overflow the omitted set is exactly the applicable MUST rules that did not fit (§7.5).
    // Name them by durable RuleVersion so the fail-closed block message tells the user what failed.
    const blockedVersions = out.overflow
      ? out.omitted.map((o) => {
          const id = identityByRuleId.get(o.ruleId);
          return { versionId: id?.versionId ?? o.ruleId, text: id?.text ?? "" };
        })
      : [];
    return { head: out.text, overflow: out.overflow, blockedVersions };
  } catch (e) {
    if (e instanceof BaseInvariantError) {
      // The universal floor no longer fits the budget (SAFE_TOTAL too small or the floor grew
      // past it). This is the plan's "fall back to last-known-good" case (§4.1): yield to the
      // hook's bash fallback, which emits LAYER1 + the pre-rendered floor XML (the last-known-good
      // compiled floor). That preserves the status-quo floor delivery (the surviving floor rules
      // still ride, harness-truncated) instead of regressing to base+marker with NO floor at all.
      // The floor-too-big condition is an ops problem surfaced by the hook's floor-budget WARN and
      // fixed by reclassifying a marginal global MUST, not by a model-facing marker. We still write
      // the audit so the base-invariant is observable out-of-band. Return null -> subcommand prints
      // nothing -> bash fallback owns the head.
      emitAudit("base-invariant", "", false, [], [], 0);
      return { head: null, overflow: false, blockedVersions: [] };
    }
    throw e;
  }
}

// Truncate a rule's text to a single readable line for the fail-closed block message. The full
// text already rode in the assembler and the audit; here we only need enough to let the user
// recognize which rule failed to fit.
function oneLine(s: string, max = 140): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// The user-facing block message printed to stderr when an applicable MUST could not be delivered
// (§7.5, INV-DELIVERY). The hook cats this to its own stderr and blocks the prompt (exit 2), so
// this text is what the operator sees. It names the undelivered RuleVersions and says what to do.
function renderBlockMessage(blocked: Array<{ versionId: string; text: string }>): string {
  const lines = blocked.map((b) => `  - ${b.versionId}: ${oneLine(b.text)}`);
  return [
    "mla: required rules could not be delivered within the context budget for this prompt.",
    "The following MUST_FOLLOW rules did not fit and were NOT applied:",
    ...lines,
    "Do not make file changes. Narrow the task or split it into smaller prompts so the required rules fit, then retry.",
    "",
  ].join("\n");
}

/**
 * CLI entry: `mla _internal assemble-context`. Reads stdin, prints the head, writes the audit.
 *
 * Exit codes are the hook's control channel:
 *   2 — strict-parse error (unknown flag). Distinct from the fail-closed signal below.
 *   3 — FAIL-CLOSED (§7.5): an applicable MUST could not be delivered. The head (base + floor +
 *       marker) is still printed to stdout and the undelivered RuleVersions are named on stderr;
 *       the hook turns rc==3 into a blocked prompt (exit 2) so the run is never reported INJECTED.
 *   0 — normal delivery, a visible degraded state, or any fail-soft error (bash fallback owns it).
 */
export async function runAssembleContext(
  argv: string[],
  deps: AssembleContextDeps = {},
): Promise<number> {
  for (const a of argv) {
    if (a.startsWith("-")) {
      console.error(`assemble-context: unknown flag ${a}`);
      return 2;
    }
  }
  try {
    const readStdin = deps.readStdin ?? (() => readFileSync(0, "utf8"));
    const ctx: AssembleCtx = {
      home: deps.home ?? homedir(),
      now: deps.now ?? (() => new Date().toISOString()),
      readCache: deps.readCache ?? readScanCache,
      writeAudit: deps.writeAudit ?? writeAssembleAudit,
    };
    const log = deps.log ?? ((out: string) => process.stdout.write(out));
    const logErr = deps.logErr ?? ((out: string) => process.stderr.write(out));

    const input = parseInput(readStdin());
    if (!input) return 0; // fail-soft: bash fallback emits LAYER1 + floor
    const result = assemble(input, ctx);
    if (result.head) log(result.head);
    if (result.overflow) {
      // Fail-closed: an applicable MUST did not fit. Name what failed on stderr and signal rc==3
      // so the hook blocks the prompt. Never a silent INJECTED (INV-DELIVERY, acceptance test 30).
      logErr(renderBlockMessage(result.blockedVersions));
      return 3;
    }
    return 0;
  } catch {
    return 0; // fail-soft on any unexpected failure
  }
}
