// src/lib/agent-memory-capture/classify.ts
//
// Eligibility is decided by frontmatter `metadata.type`, NEVER by filename
// (notes/20260626-agent-memory-auto-capture-proposal.md §1, §4). MVP captures
// `project` only; `user`/`feedback`/`reference` are skipped. The existing
// scanner/frontmatter.ts parser is intentionally flat (scalar `key: value`
// only) and does not descend into the nested `metadata:` block, so this module
// extracts `metadata.type` itself.
//
// "Malformed frontmatter" (an opened `---` fence that never closes) is a
// distinct outcome from "no project type": the former routes to a processing
// failure (do not upload, do not retire, retry when corrected), the latter to
// ineligible/reclassified. Keep them separate.

export interface MemoryClassification {
  // metadata.type lowercased + trimmed; null when absent.
  type: string | null;
  hasFrontmatter: boolean;
  // A frontmatter fence was opened (`---\n`) but never closed. Routes to
  // `failed`, not `skipped`.
  malformed: boolean;
}

function stripScalar(v: string): string {
  let s = v.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  return s.trim().toLowerCase();
}

export function classifyMemory(text: string): MemoryClassification {
  if (!text.startsWith("---\n")) {
    return { type: null, hasFrontmatter: false, malformed: false };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    // Opened but never closed: a real structural defect, not just "no type".
    return { type: null, hasFrontmatter: true, malformed: true };
  }
  const block = text.slice(4, end);
  const lines = block.split("\n");

  let type: string | null = null;
  let inMetadata = false;
  for (const line of lines) {
    // Enter the nested metadata: block.
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    // A new top-level key (no leading whitespace, ends the metadata block).
    if (inMetadata && /^\S/.test(line)) {
      inMetadata = false;
    }
    // metadata.type (indented under metadata:).
    if (inMetadata) {
      const m = /^\s+type:\s*(\S.*?)\s*$/.exec(line);
      if (m) {
        type = stripScalar(m[1]);
        break;
      }
      continue;
    }
    // Fallback: a top-level `type:` (defensive; the corpus nests it).
    const top = /^type:\s*(\S.*?)\s*$/.exec(line);
    if (top && type === null) {
      type = stripScalar(top[1]);
    }
  }

  return { type, hasFrontmatter: true, malformed: false };
}

// MVP captures `project` only.
export function isCapturable(c: MemoryClassification): boolean {
  return c.type === "project";
}
