// src/lib/scanner/scan.ts
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Directive,
  FloorRuleEntry,
  SCAN_SCHEMA_VERSION,
  ScanResult,
  ScopedRuleEntry,
  StaleSignal,
  directiveId,
} from "./types";
import { classifyTier, isInstructionFile } from "./score";
import { parseFrontmatter } from "./frontmatter";
import { parseDirectivesFromMarkdown } from "./parse-directives";
import { parseAdrStatus, parseClaudeRulesFile } from "./parse-structured";
import {
  dedupeDirectives,
  renderConfirmedRulesXml,
  renderFloorRulesXml,
  renderStaleContextXml,
} from "./render";
import { discoverAgentMemoryDirectives } from "./agent-memory";
import { MANAGED_RULES_PATH } from "./managed-rules";
import { readRuleBundleCache } from "../rules/bundle-cache";
import { bundleEntriesToDirectives } from "../rules/bundle-directives";

export interface ScanOptions {
  workspaceId: string;
  now: () => string; // injected clock (Date.now is unavailable in some sandboxes; keep pure)
  home?: string; // override the home dir for agent-memory discovery (tests); defaults to os.homedir()
  // The injected rule set comes from the principal-bound backend bundle cache, which is
  // principal-keyed. These three resolve which bundle to read for the live session.
  principalUserId?: string | null; // the authenticated session user (null = shared-key/headless)
  projectId?: string | null; // the activated project scope (null = cross-project)
  bundleHome?: string; // override $MEETLESS_HOME for the bundle cache read (tests)
}

const MAX_FILE_BYTES = 256 * 1024; // skip large files for the free pass

export function scanWorkspace(cwd: string, opts: ScanOptions): ScanResult {
  const tracked = gitLsFiles(cwd);
  const directives: Directive[] = [];
  const staleSignals: StaleSignal[] = [];
  let instructionFiles = 0;
  let decisionDocs = 0;
  let legacyNotes = 0;

  for (const rel of tracked) {
    // The mla-managed rule file is NOT an injection source: the injected rule set comes from
    // the principal-bound backend rule bundle, folded in below. Skip it here so it is not also
    // processed as a generic T2 prose doc, which would double-count it and run stale detection.
    if (rel === MANAGED_RULES_PATH) continue;
    const tier = classifyTier(rel);
    if (!tier) continue;
    if (isInstructionFile(rel)) instructionFiles++;
    else if (tier === "T2") decisionDocs++;
    else if (tier === "T4") legacyNotes++;
    if (tier === "T3") continue; // grounding-only; no directives/signals in P0A

    const text = safeRead(join(cwd, rel));
    if (text === null) continue;

    if (rel.startsWith(".claude/rules/")) {
      directives.push(...parseClaudeRulesFile(text, rel).directives);
      continue;
    }
    if (tier === "T1") {
      directives.push(...parseDirectivesFromMarkdown(text, rel));
    }
    // ADR status (T2 decision docs only)
    if (tier === "T2") {
      const adr = parseAdrStatus(text, rel);
      if (adr) staleSignals.push(adr);
    }
    // frontmatter status (any prose doc, esp. legacy notes)
    const { data } = parseFrontmatter(text);
    if (data.status && /^(deprecated|superseded|rejected)$/i.test(data.status)) {
      staleSignals.push({
        id: directiveId(rel, `fm:${data.status}`),
        source: rel,
        reason: /superseded/i.test(data.status) ? "frontmatter_superseded" : "frontmatter_deprecated",
        detail: `${rel} is marked ${data.status.toLowerCase()}; prefer current docs unless told otherwise.`,
      });
    }
  }

  // Dedup stale signals by source path: keep the first signal per file.
  // For ADRs the adr_superseded signal is emitted first (parseAdrStatus runs
  // before the frontmatter branch), so it is always the survivor when both
  // triggers fire on the same file.
  const seenSources = new Set<string>();
  const dedupedSignals = staleSignals.filter((s) => {
    if (seenSources.has(s.source)) return false;
    seenSources.add(s.source);
    return true;
  });

  // The durable injected-rule set, sourced from the principal-bound backend bundle cache.
  // Folded in BEFORE dedupe so it participates in authority ranking alongside the
  // instruction-file directives.
  const canonicalRoot = gitToplevel(cwd);
  directives.push(...resolveInjectedRuleDirectives(cwd, canonicalRoot, opts));

  // Collapse the same rule attested by multiple instruction files into one, so
  // the stored array, the reported rule count, and the grounding pack all agree
  // on distinct rules rather than per-file occurrences.
  const dedupedDirectives = dedupeDirectives(directives);

  // Agent auto-memory lives outside the git tree, so `git ls-files` above never sees it.
  // Discover its feedback rules as a SEPARATE advisory set (machine_inferred), dropping any
  // whose text merely restates a committed instruction-file rule. These are surfaced for
  // human review and deliberately excluded from `confirmedRulesXml` (never auto-injected as
  // must-follow): untracked => not attested => ingest is not accept.
  const committedTexts = new Set(dedupedDirectives.map((d) => d.text));
  // Search the active session path AND the canonical repo root: the same repo opened at a
  // nested dir or a worktree encodes to a different agent-memory dir, so binding identity to
  // a single path would silently miss memory (memo Phase 2). Discovery dedupes by content.
  // canonicalRoot was resolved above for the bundle injection step; reuse it.
  const advisoryDirectives = discoverAgentMemoryDirectives(cwd, opts.home, undefined, {
    canonicalRoot,
  }).filter((d) => !committedTexts.has(d.text));

  const inventory = {
    instructionFiles,
    decisionDocs,
    legacyNotes,
    staleSignals: dedupedSignals.length,
    agentMemoryRules: advisoryDirectives.length,
  };

  // Structured floor + scoped arrays for the byte-budgeted assembler (targeted-rule-injection
  // §4.6). Clean partition (F0-prime): backend-bundle rules never carry globs (their scope lives
  // on the enforcement plane, not the injection payload), so FLOOR = bundle-sourced-global and
  // SCOPED = anything carrying globs (.claude/rules) are disjoint sets. Floor mirrors the
  // isFloorRule source gate (only governed bundle rules ride the every-turn floor; per-subsystem
  // CLAUDE.md globals stay in the once-per-session pack until they carry real globs), but widens
  // to MUST + SHOULD so the assembler can offer bundle SHOULD as the droppable global tail.
  const { floorRules, scopedRules } = buildStructuredRules(dedupedDirectives);

  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    workspaceId: opts.workspaceId,
    commitSha: gitHead(cwd),
    generatedAt: opts.now(),
    inventory,
    directives: dedupedDirectives,
    staleSignals: dedupedSignals,
    confirmedRulesXml: renderConfirmedRulesXml(dedupedDirectives),
    floorRulesXml: renderFloorRulesXml(dedupedDirectives),
    floorRules,
    scopedRules,
    staleContextXml: renderStaleContextXml(dedupedSignals),
    advisoryDirectives,
  };
}

// A directive is bundle-sourced iff `rule-bundle` is one of its (possibly dedupe-unioned,
// comma-joined) source tokens. Token test, not substring: `docs/rule-bundle-notes.md` is a
// file, not the bundle.
function isBundleSourced(d: Directive): boolean {
  return d.source
    .split(",")
    .map((s) => s.trim())
    .includes("rule-bundle");
}

function hasGlobs(d: Directive): boolean {
  return Array.isArray(d.globs) && d.globs.length > 0;
}

// A directive carries a turn trigger iff it was threaded from a governed `turn`-mode bundle
// rule (targeted-rule-injection §5.4). Turn rules route to SCOPED (best-effort, trigger-matched
// per turn), never to the always-on FLOOR: a turn rule must not tax every turn's floor budget.
function hasTrigger(d: Directive): boolean {
  return d.trigger !== undefined;
}

// A rule's durable identity for the cache/matcher/audit: the backend rule-node id when the
// directive was threaded from the governed bundle, else its content-hash `id` (file-sourced
// .claude/rules and per-service CLAUDE.md have no bundle identity).
function ruleIdOf(d: Directive): string {
  return d.ruleNodeId ?? d.id;
}
function versionIdOf(d: Directive): string {
  return d.ruleVersionId ?? d.id;
}
function shortStrength(d: Directive): "MUST" | "SHOULD" {
  return d.strength === "MUST_FOLLOW" ? "MUST" : "SHOULD";
}

// Partition the deduped directive set into the assembler's structured inputs. Three disjoint
// branches (targeted-rule-injection §5.5, change 1):
//   FLOOR  = human-attested bundle-global rules carrying NEITHER globs NOR a turn trigger
//            (MUST + SHOULD): the always-on floor block.
//   SCOPED = human-attested rules carrying applicability globs OR a turn trigger. A glob rule
//            is matched against explicit + working-set paths; a turn rule is matched against
//            this turn's prompt + explicit paths (best-effort). A rule may carry both; it lands
//            in SCOPED once.
// Disjointness: the floor filter excludes anything with globs OR a trigger, so a turn rule (no
// globs, has trigger) and a globbed .claude/rules rule both route to SCOPED, never to FLOOR.
export function buildStructuredRules(dirs: Directive[]): {
  floorRules: FloorRuleEntry[];
  scopedRules: ScopedRuleEntry[];
} {
  const floorRules: FloorRuleEntry[] = dirs
    .filter((d) => d.attestation === "human_attested" && isBundleSourced(d) && !hasGlobs(d) && !hasTrigger(d))
    .map((d) => ({
      ruleId: ruleIdOf(d),
      versionId: versionIdOf(d),
      text: d.text,
      strength: shortStrength(d),
    }));
  const scopedRules: ScopedRuleEntry[] = dirs
    .filter((d) => d.attestation === "human_attested" && (hasGlobs(d) || hasTrigger(d)))
    .map((d) => ({
      ruleId: ruleIdOf(d),
      versionId: versionIdOf(d),
      text: d.text,
      strength: shortStrength(d),
      // A turn-only rule has no globs; default to [] so the glob-matched (required) path simply
      // never fires for it, leaving it to the trigger-matched best-effort tier.
      globs: d.globs ?? [],
      // Present only for turn rules; undefined omits the key for pure glob rules.
      trigger: d.trigger,
    }));
  return { floorRules, scopedRules };
}

function gitLsFiles(cwd: string): string[] {
  try {
    return execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// The canonical repo root (git toplevel), or undefined outside a repo. Used only to widen
// agent-memory discovery beyond the active session path; it does NOT define workspace identity.
function gitToplevel(cwd: string): string | undefined {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
    return top || undefined;
  } catch {
    return undefined;
  }
}

// The source of injected rule directives: the principal-bound backend bundle cache. A stale
// bundle (past its DENY lease) is STILL injected here: lease staleness only degrades action-time
// DENY (the PreToolUse hook's concern, §G4), never the advisory injection set, so the last-good
// team conventions keep priming the prompt. Only an unavailable bundle (missing / corrupt /
// wrong-principal) injects nothing.
function resolveInjectedRuleDirectives(
  _cwd: string,
  _canonicalRoot: string | undefined,
  opts: ScanOptions,
): Directive[] {
  const read = readRuleBundleCache(
    {
      workspaceId: opts.workspaceId,
      projectId: opts.projectId ?? null,
      principalUserId: opts.principalUserId ?? null,
    },
    { home: opts.bundleHome, nowMs: Date.parse(opts.now()) },
  );
  return read.bundle ? bundleEntriesToDirectives(read.bundle.rules) : [];
}

function gitHead(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function safeRead(abs: string): string | null {
  try {
    if (statSync(abs).size > MAX_FILE_BYTES) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
