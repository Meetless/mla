// src/lib/scanner/agent-memory.ts
//
// Claude Code stores per-project agent memory at
// `~/.claude/projects/<cwd-with-slashes-and-dots-as-dashes>/memory/`. Past sessions
// distill the rules the user taught them into `feedback_*.md` topic files there. That
// directory is NOT git-tracked, so `scanWorkspace`'s `git ls-files` enumeration
// structurally misses it. This module discovers those files so the cold-start scan can
// surface "the other things we need to support" beyond the committed instruction files.
//
// Hard trust gate: everything minted here is `machine_inferred` (untracked, per-machine,
// agent-distilled). Per the cold-start proposal (§54, §225, §305) untracked content is
// "not attested" and can NEVER earn must-follow; it rides advisory until a human attests.
// `render.ts` already enforces this (must-follow requires `human_attested`), and
// `scanWorkspace` keeps these out of the auto-injected `confirmedRulesXml` pack entirely.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userHomeDir } from "../config";
import { Directive, directiveId } from "./types";
import { parseFrontmatter } from "./frontmatter";

// A description that SHOUTS a normative modal is a MUST; everything else is a SHOULD.
// Mirrors parse-directives.ts MUST_TOKENS so strength is consistent across sources.
const MUST_TOKENS = /\b(MUST|NEVER|ALWAYS|REQUIRED|DO NOT|DON'?T|FORBIDDEN|NON-NEGOTIABLE)\b/;

// Resolve the agent-memory dir for a workspace cwd. Replicates Claude Code's projects-dir
// encoding (slashes AND dots become dashes). `home` is injectable for tests. This is an
// implementation detail of the Claude Code provider below, NOT a workspace identity: the
// same repo encodes to different dirs from its git root, a nested dir, a worktree, or a
// symlinked clone (memo Phase 2). Discovery keeps it behind the provider seam so the
// path convention never leaks into the workspace model.
export function agentMemoryDir(cwd: string, home = userHomeDir()): string {
  const encoded = cwd.replace(/[/.]/g, "-");
  return join(home, ".claude", "projects", encoded, "memory");
}

export interface MemoryFile {
  name: string;
  text: string;
  // Provenance, set by collectAgentMemoryFiles (undefined when read via readAgentMemoryFiles
  // directly). `provider` names the adapter that found the file; `sourcePath` is the absolute
  // path it was read from and the source half of the dedupe fingerprint.
  provider?: string;
  sourcePath?: string;
}

// --- Provider adapter -------------------------------------------------------------
//
// Agent-memory discovery must NOT define workspace identity (memo Phase 2). Each coding
// tool keeps its per-project memory under its OWN path convention; mla activation/binding
// is what owns identity. A provider is the seam that hides one tool's convention so it
// cannot leak into the workspace model. Adding a second tool (e.g. a Cursor or Codex
// memory layout) is a new provider, not a change to discovery or the scanner.
export interface AgentMemoryProvider {
  readonly name: string;
  // The directories this provider would look in for a given workspace search path, using
  // its own convention. Non-existent dirs are a harmless zero-result (readAgentMemoryFiles
  // fails open), so a provider may over-list candidate locations freely.
  memoryDirs(searchPath: string, home: string): string[];
}

// Claude Code: ~/.claude/projects/<encoded-cwd>/memory/.
export const claudeCodeProvider: AgentMemoryProvider = {
  name: "claude-code",
  memoryDirs(searchPath, home) {
    return [agentMemoryDir(searchPath, home)];
  },
};

// The default provider set. Today only Claude Code; the list is the extension point.
export const DEFAULT_AGENT_MEMORY_PROVIDERS: readonly AgentMemoryProvider[] = [claudeCodeProvider];

function contentFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Read the `feedback_*.md` topic files (the "rules the user gave" bucket) from an
// agent-memory dir, sorted for a stable/diffable worklist. Fails open to []: a missing
// dir (fresh machine, no prior agent memory) is the common case and must never abort the
// scan. The MEMORY.md index and project_/reference_ topic files are intentionally skipped
// here: the index is one-line pointers, and only feedback memories are coordination rules.
export function readAgentMemoryFiles(dir: string): MemoryFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: MemoryFile[] = [];
  for (const name of names) {
    if (!name.startsWith("feedback_") || !name.endsWith(".md")) continue;
    try {
      out.push({ name, text: readFileSync(join(dir, name), "utf8") });
    } catch {
      // An unreadable single file must not abort discovery of the rest.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// One advisory directive per feedback memory: its frontmatter `description` is the
// distilled one-line rule, which is exactly the grain a review worklist wants (§316,
// "one-line reason per file"). Files without a description are skipped; identical
// descriptions collapse to one.
export function parseAgentMemoryDirectives(files: MemoryFile[]): Directive[] {
  const out: Directive[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const { data } = parseFrontmatter(f.text);
    const desc = (data.description ?? "").trim();
    if (!desc) continue;
    const text = desc.replace(/\s+/g, " ");
    if (seen.has(text)) continue;
    seen.add(text);
    const source = `agent-memory:${f.name}`;
    out.push({
      id: directiveId(source, text),
      text,
      source,
      kind: "RULE",
      strength: MUST_TOKENS.test(text) ? "MUST_FOLLOW" : "SHOULD_FOLLOW",
      attestation: "machine_inferred",
    });
  }
  return out;
}

// The default cap is a pathological-directory guard (e.g. a symlink loop or an unrelated
// tool dumping thousands of files under ~/.claude/projects), NOT a curation limit. A real
// feedback corpus is tens to low-hundreds of files (the dogfood repo has ~55) and must
// surface in full; bounding scan-time I/O only matters at the absurd end. Scan runs on
// `mla activate`, not the per-Write hot path, so reading a few hundred small files is cheap.
const DEFAULT_AGENT_MEMORY_CAP = 500;

export interface AgentMemoryDiscoveryOptions {
  // The repo's canonical root (git toplevel), when known and possibly distinct from cwd.
  // Searching both the active session path AND the canonical root catches memory written
  // from a nested dir, a worktree, or an alternate clone of the same repo (memo Phase 2).
  canonicalRoot?: string;
  // Override the provider set (tests / future tools). Defaults to DEFAULT_AGENT_MEMORY_PROVIDERS.
  providers?: readonly AgentMemoryProvider[];
}

// Collect feedback memory files for a workspace across every provider and search path,
// deduped by CONTENT fingerprint: the same memory found under two encoded paths (e.g. the
// repo opened once at its root and once at a nested dir) collapses to a single entry,
// tagged with the first provider/path that surfaced it. Missing memory is a harmless
// zero-result. Sorted by name (then sourcePath) for a stable, diffable worklist.
export function collectAgentMemoryFiles(
  cwd: string,
  home = userHomeDir(),
  opts: AgentMemoryDiscoveryOptions = {},
): MemoryFile[] {
  const providers = opts.providers ?? DEFAULT_AGENT_MEMORY_PROVIDERS;
  // Active session path + canonical root, order-preserving and de-duplicated.
  const searchPaths: string[] = [];
  for (const p of [cwd, opts.canonicalRoot]) {
    if (p && !searchPaths.includes(p)) searchPaths.push(p);
  }
  const seen = new Set<string>();
  const out: MemoryFile[] = [];
  for (const provider of providers) {
    for (const searchPath of searchPaths) {
      for (const dir of provider.memoryDirs(searchPath, home)) {
        for (const f of readAgentMemoryFiles(dir)) {
          const fp = contentFingerprint(f.text);
          if (seen.has(fp)) continue;
          seen.add(fp);
          out.push({ ...f, provider: provider.name, sourcePath: join(dir, f.name) });
        }
      }
    }
  }
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || (a.sourcePath ?? "").localeCompare(b.sourcePath ?? ""),
  );
}

// Discover + parse the agent-memory rules for a workspace. The advisory worklist is
// surfaced for review, never bulk-injected. Fully fail-open via readAgentMemoryFiles.
// The default 3-arg call (cwd, home, cap) is preserved; pass opts to search a canonical
// root or a custom provider set.
export function discoverAgentMemoryDirectives(
  cwd: string,
  home = userHomeDir(),
  cap = DEFAULT_AGENT_MEMORY_CAP,
  opts: AgentMemoryDiscoveryOptions = {},
): Directive[] {
  return parseAgentMemoryDirectives(collectAgentMemoryFiles(cwd, home, opts)).slice(0, cap);
}
