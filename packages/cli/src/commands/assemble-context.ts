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
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { Buffer } from "node:buffer";
import { ScanResult, SCAN_SCHEMA_VERSION } from "../lib/scanner/types";
import {
  PersistedAssembleAudit,
  writeAssembleAudit,
} from "../lib/scanner/cache";
import {
  ArtifactByteReader,
  filterReconciliationFindings,
} from "../lib/scanner/reconciliation-rehash";
import { readScanCacheForRoot } from "./scan-context";
import { assembleContext } from "../lib/scanner/assemble";
import { extractExplicitPaths } from "../lib/scanner/prompt-paths";
import {
  renderIncompleteDeliveryMarker,
  renderScopedUnavailableMarker,
} from "../lib/scanner/render";
import { RuleMeterFile } from "../lib/analytics/envelope";

// The connector-owned byte ceiling for the assembled head (base + floor + scoped).
//
// THE ~2048B "HARNESS INLINE CAP" THIS BUDGET WAS BUILT ON DOES NOT EXIST. The Phase-0 note
// claimed the harness only shows the model ~2048B of additionalContext and that anything the hook
// appends after the head "lands beyond the window by design". Both halves are false, and the
// second one refutes the first: the Layer-2 evidence block IS appended after the head, and the
// agent visibly reads and cites it. That block is the product. If the window were real, evidence
// injection could never have worked once.
//
// MEASURED (2026-07-13, live dogfood ws, one real hook run): the hook
// emits ONE additionalContext string of 5933B (static base 887B + floor-rules 1500B + evidence
// 3546B) and the model reads it whole, tail included. Nothing is trimmed at 2048B or anywhere near
// it.
//
// WHAT THE PHANTOM CAP COST: base (887B, it grew) + floor (1500B, 8 MUSTs) = 2387B > 2000, so the
// base invariant threw BaseInvariantError on EVERY turn in this repo. The assembler printed
// nothing, the hook silently fell back to emitting the base and floor blocks itself, and the floor
// survived only by accident. The scoped tier does not exist on the fallback path, so every
// applicable scoped MUST was dropped in silence: two of them, live in the cache, never delivered
// once in this repo's history. A budget that forces a 2387B payload down a path that then emits
// 5933B unbudgeted is not a safety rail, it is a hole.
//
// SAFE_TOTAL now budgets ONLY the best-effort SHOULD tail. Required content (base + global MUST
// floor + every applicable scoped MUST) is always delivered whole by the assembler: since there is
// no harness cap, the assembler's byte budget expands to max(SAFE_TOTAL, requiredBytes) rather than
// throwing or blocking when the required set outgrows this number. So the base invariant is gone,
// the §7.5 fail-loud path is retired (the assembler's `overflow` is permanently false), and this
// constant no longer gates whether a MUST is delivered, only how much OPTIONAL tail rides on top.
// It is set from measured content: base 887 + floor 1500 + both scoped MUSTs ~650 = ~3.3KB today.
// 6000 leaves roughly 2x headroom of SHOULD-tail slack before the floor+required set eats it.
export const SAFE_TOTAL = 6000;

export interface AssembleContextDeps {
  readStdin?: () => string;
  readCache?: (home: string | undefined, workspaceId: string) => ScanResult | null;
  writeAudit?: (home: string | undefined, workspaceId: string, audit: PersistedAssembleAudit) => void;
  writeMeter?: (path: string, json: string) => void;
  // Byte reader for the reconciliation rehash gate (ADR §3.3 item 9). Injected in tests to feed
  // controlled bytes; defaults to a repoRoot-contained filesystem reader built per call.
  readArtifactBytes?: ArtifactByteReader;
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
  // Optional caller-owned path for the rule-cost meter (audit 6.G). The hook mktemps it, reads
  // it after we exit, and hands the JSON to a DETACHED emitter. It is a per-call temp path and
  // not a well-known one on purpose: the per-workspace assemble-audit is last-write-wins and 10+
  // concurrent sessions clobber it, so a meter read from there would be attributed to the wrong
  // turn. Absent key = no meter, which is the correct behavior for every non-hook caller.
  meterFile?: string;
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
  const meterFile = typeof j.meterFile === "string" && j.meterFile ? j.meterFile : undefined;
  return { base, prompt, workingSet, workspaceId, repoRoot, safeTotal, meterFile };
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

// The default artifact byte reader for the reconciliation rehash gate: read one
// repo-relative instruction file's UTF-8 bytes, contained under `repoRoot`. It
// mirrors normalizeWorkingSet's containment discipline exactly (reject absolute
// paths and `..` escapes) so a finding can never coerce a read outside the repo,
// and swallows every fs error to null so an unreadable path becomes
// NEEDS_REEVALUATION rather than throwing. Pure-posix join, matching the rest of
// this file's path handling.
function makeArtifactByteReader(repoRoot: string | undefined): ArtifactByteReader {
  const root = repoRoot ?? process.cwd();
  return (rel: string): string | null => {
    const t = rel.trim();
    if (!t || t.startsWith("/")) return null;
    const n = posix.normalize(t);
    if (n === "" || n === "." || n === ".." || n.startsWith("../") || n.startsWith("/")) return null;
    try {
      return readFileSync(posix.join(root, n), "utf8");
    } catch {
      return null;
    }
  };
}

interface AssembleCtx {
  // undefined = the cache module resolves the state root (it honors MEETLESS_HOME).
  home: string | undefined;
  now: () => string;
  readCache: (home: string | undefined, workspaceId: string) => ScanResult | null;
  writeAudit: (home: string | undefined, workspaceId: string, audit: PersistedAssembleAudit) => void;
  // Reads one repo-relative instruction file's bytes for the rehash gate; null when unreadable.
  readArtifactBytes: ArtifactByteReader;
}

// The result of a byte-budgeted assembly attempt. `head` is the exact model-facing envelope. Since
// the base invariant + §7.5 fail-loud path were retired, every branch now produces a non-null head
// and a non-null meter: required content always rides whole (the budget expands to hold it) and a
// degraded branch still emits a visible-marker head. The nullable types, `overflow`, and
// `blockedVersions` are a DORMANT, typed safety net: `overflow` is permanently false and
// `blockedVersions` permanently empty today, but the shape stays valid so a future real byte ceiling
// could re-arm fail-closed delivery (head null -> bash fallback owns it; overflow true -> the caller
// turns rc==3 into a blocked prompt) without re-plumbing the audit/meter/hook contract.
interface AssembleResult {
  head: string | null;
  overflow: boolean;
  blockedVersions: Array<{ versionId: string; text: string }>;
  // The rule-cost meter for this turn (audit 6.G), pure numbers, no text. Non-null on every live
  // branch; the null type is reserved for the dormant head-null path described above, where the bash
  // fallback owns delivery and metering a head we did not build would misreport what the model got.
  meter: RuleMeterFile | null;
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

  // Prompt-time reconciliation rehash gate (ADR §3.3 item 9). Re-hash every cited instruction
  // file's current bytes and partition the findings into KEPT (digest still matches) vs
  // NEEDS_REEVALUATION (drifted / unreadable / normalization-refused). Computed ONCE from the
  // cache and recorded in the out-of-band audit below (the sole Phase 2A consumer). This is the
  // filter GATE only; rendering the kept findings into the head is Phase 3 (blocked), so KEPT has
  // no head-side effect today and an empty partition (every Phase 2A cache) leaves the head
  // byte-identical. `reconciliationFindings` is forward-only and absent in every 2A cache, so this
  // is a clean no-op that costs zero file reads until the Phase 2B detector populates it.
  const reconciliation = filterReconciliationFindings(
    cache?.reconciliationFindings ?? [],
    ctx.readArtifactBytes,
  );
  const reconciliationAudit =
    reconciliation.kept.length || reconciliation.needsReevaluation.length
      ? {
          reconciliation: {
            kept: reconciliation.kept.map((o) => ({ path: o.finding.path, reason: o.reason })),
            needsReevaluation: reconciliation.needsReevaluation.map((o) => ({
              path: o.finding.path,
              reason: o.reason,
            })),
          },
        }
      : {};

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
      // Recorded only when the rehash actually partitioned findings; omitted on every Phase 2A
      // audit (no findings in the cache), matching the versionId/represents "absent when unknown"
      // idiom above so an older reader still parses.
      ...reconciliationAudit,
    });
  };

  // A degraded-branch meter: the cache could not be assembled from, so no rule COUNT is knowable
  // and `degraded` is set. The BYTES are still true (they describe the head the model actually
  // got), which is why these rows are kept rather than dropped: a turn that delivered no rules at
  // all is exactly the turn a cost/coverage board must not silently omit.
  const degradedMeter = (text: string, alwaysOnBytes: number): RuleMeterFile => ({
    base_bytes: byteLength(input.base),
    always_on_bytes: alwaysOnBytes,
    always_on_rules: 0,
    scoped_bytes: 0,
    scoped_rules: 0,
    scoped_configured: 0,
    avoided_bytes: 0,
    omitted_rules: 0,
    head_bytes: byteLength(text),
    safe_total: input.safeTotal,
    overflow: false,
    degraded: true,
    base_invariant: false,
  });

  // Row 5: invalid cache, no usable last-good -> base + visible incomplete-delivery marker.
  if (!cache) {
    const text = joinSegments([input.base, renderIncompleteDeliveryMarker()]);
    emitAudit("incomplete", text, false, [], []);
    return { head: text, overflow: false, blockedVersions: [], meter: degradedMeter(text, 0) };
  }

  // Rows 3/4: old schema. Post-activation, the bulk compat path is gone, so scoped rules cannot
  // be surfaced from this cache. Deliver the pre-rendered floor and a VISIBLE marker (not a
  // silent floor-only success), which drives the operator to rescan to the current schema.
  //
  // Marker BEFORE floor. The original reason was wrong (it assumed a harness window that trims the
  // tail, so a trailing marker would be the segment cut; see SAFE_TOTAL above, no such window
  // exists). The ordering stands on its own merit: this state means the operator's cache is stale,
  // and the instruction to distrust the missing scoped rules is worth more than the floor bullets
  // it precedes, so it leads.
  if ((cache.schemaVersion ?? 1) < SCAN_SCHEMA_VERSION) {
    const text = joinSegments([input.base, renderScopedUnavailableMarker(), cache.floorRulesXml ?? ""]);
    emitAudit("old-schema", text, false, [], []);
    return {
      head: text,
      overflow: false,
      blockedVersions: [],
      // The pre-rendered floor XML DID ride, so its bytes are real always-on cost even though the
      // old cache cannot tell us how many rules are inside it.
      meter: degradedMeter(text, byteLength(cache.floorRulesXml ?? "")),
    };
  }

  // Rows 1/2: current schema. Real byte-budgeted assembly. A cache written by a scan that failed
  // to recompile is simply the previous on-disk cache (the scan side preserves last-known-good by
  // not overwriting on failure), so reading current on-disk state IS "use last-known-good".
  const floorRules = cache.floorRules ?? [];
  const scopedRules = cache.scopedRules ?? [];
  // The assembler is pure and, since the base invariant + §7.5 fail-loud path were retired, never
  // throws for budget: required content is always delivered whole. Any UNEXPECTED throw here (a
  // genuine bug) propagates to the fail-soft catch in runAssembleContext, which yields to the bash
  // fallback rather than crashing the hook.
  const out = assembleContext({
    base: input.base,
    prompt: input.prompt,
    floorRules,
    scopedRules,
    explicitPaths,
    workingSetPaths,
    safeTotal: input.safeTotal,
  });
  // `out.overflow` is permanently false (see assemble.ts). The overflow-conditional plumbing below
  // (state "overflow", blockedVersions, the rc==3 path in runAssembleContext) is a DORMANT, typed
  // safety net: it never fires today, but it stays valid so a future real byte ceiling could re-arm
  // fail-closed delivery without re-plumbing the audit/meter/hook contract.
  emitAudit(out.overflow ? "overflow" : "normal", out.text, out.overflow, out.delivered, out.omitted, out.bytes);
  const blockedVersions = out.overflow
    ? out.omitted.map((o) => {
        const id = identityByRuleId.get(o.ruleId);
        return { versionId: id?.versionId ?? o.ruleId, text: id?.text ?? "" };
      })
    : [];
  const m = out.meter;
  return {
    head: out.text,
    overflow: out.overflow,
    blockedVersions,
    meter: {
      base_bytes: m.baseBytes,
      always_on_bytes: m.ambientBytes,
      always_on_rules: m.ambientRules,
      scoped_bytes: m.scopedBytes,
      scoped_rules: m.scopedRules,
      scoped_configured: m.scopedConfigured,
      avoided_bytes: m.avoidedBytes,
      omitted_rules: m.omittedRules,
      head_bytes: m.headBytes,
      safe_total: input.safeTotal,
      overflow: out.overflow,
      degraded: false,
      base_invariant: false,
    },
  };
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
 *   3 — FAIL-CLOSED (§7.5), DORMANT: reserved for "an applicable MUST could not be delivered". The
 *       assembler now always delivers required content whole (`overflow` is permanently false), so
 *       this path never fires today. It is kept intact so a future real byte ceiling could re-arm
 *       fail-closed delivery: the hook still turns rc==3 into a blocked prompt (exit 2) so a run is
 *       never reported INJECTED while a MUST went undelivered.
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
    const input = parseInput(readStdin());
    if (!input) return 0; // fail-soft: bash fallback emits LAYER1 + floor
    const ctx: AssembleCtx = {
      home: deps.home, // undefined = the cache module's state root (it honors MEETLESS_HOME)
      now: deps.now ?? (() => new Date().toISOString()),
      // Repo-contained byte reader for the rehash gate, rooted at this turn's repoRoot (the hook
      // passes it; absent -> process.cwd(), the session repo). Injected wholesale in tests.
      readArtifactBytes: deps.readArtifactBytes ?? makeArtifactByteReader(input.repoRoot),
      // Guarded read: the assembler injects locally-parsed scopedRules, which belong to ONE
      // checkout. A workspace shared by several checkouts writes one scan-cache.json, so an
      // unguarded read could inject a sibling checkout's scoped rules into this session. On a
      // mismatch this returns null and the assembler degrades to the bash floor fallback (the
      // floor block is bundle-sourced and workspace-global, so it stays correct). cwd defaults to
      // process.cwd() = the session repo here in the hook.
      readCache: deps.readCache ?? readScanCacheForRoot,
      writeAudit: deps.writeAudit ?? writeAssembleAudit,
    };
    const log = deps.log ?? ((out: string) => process.stdout.write(out));
    const logErr = deps.logErr ?? ((out: string) => process.stderr.write(out));

    const result = assemble(input, ctx);
    if (result.head) log(result.head);
    // Drop the rule-cost meter (audit 6.G) where the caller asked for it. STRICTLY best-effort and
    // deliberately not in the `try` that guards delivery: a full disk or a vanished temp dir must
    // cost us a telemetry row, never the user's rules. Note the ordering. The head is already on
    // stdout, so even a throw here (impossible, it is caught) could not unsend it.
    if (input.meterFile && result.meter) {
      const writeMeter = deps.writeMeter ?? ((p: string, j: string) => writeFileSync(p, j, "utf8"));
      try {
        writeMeter(input.meterFile, JSON.stringify(result.meter));
      } catch {
        /* telemetry is never load-bearing */
      }
    }
    if (result.overflow) {
      // DORMANT fail-closed (result.overflow is permanently false; see assemble.ts). Kept so a
      // future real byte ceiling can re-arm it: name what failed on stderr and signal rc==3 so the
      // hook blocks the prompt. Never a silent INJECTED (INV-DELIVERY, acceptance test 30).
      logErr(renderBlockMessage(result.blockedVersions));
      return 3;
    }
    return 0;
  } catch {
    return 0; // fail-soft on any unexpected failure
  }
}
