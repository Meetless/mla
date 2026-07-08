// src/lib/agent-memory-capture/containment.ts
//
// Enumerate the eligible memory files under a binding's directory (§4 step 3),
// with realpath containment so a symlink can never point the collector at a file
// outside the consented directory (CONTAINMENT-1). MVP scans DIRECT `.md`
// children only (the corpus is flat); nesting support is deferred until topic
// files actually nest.
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// Fixed max byte size (a constant, not user-configurable yet, per SECRET-1 /
// §4). Real memory topic files are 1-6 KB; the 188 KB MEMORY.md index is
// denylisted. A file above this is a processing failure (oversized), never a
// silent truncate-and-send.
export const MAX_FILE_BYTES = 256 * 1024;

// Never a capture source even if it somehow carried a project type: the index
// is one-line pointers, not durable claims. Type-filtering already excludes it
// (it has no frontmatter), but the explicit denylist is belt-and-suspenders.
const DENYLIST = new Set(["memory.md"]);

export interface EligibleFile {
  // Path relative to memoryDir (POSIX separators for a stable synthetic id).
  relativePath: string;
  absPath: string;
  // realpath of absPath; guaranteed contained within realpath(memoryDir).
  realPath: string;
  bytes: number;
}

export interface EnumerationResult {
  files: EligibleFile[];
  // False if readdir/realpath/stat raised mid-scan: the caller then reconciles
  // NO deletions/reclassifications this pass and retries later (§4).
  complete: boolean;
}

function isContained(child: string, parentReal: string): boolean {
  return child === parentReal || child.startsWith(parentReal + sep);
}

// Enumerate direct `.md` children that are regular files, realpath-contained,
// not denylisted, with their byte size. Returns complete=false on ANY iteration
// error so a partial scan never drives deletions.
export function enumerateEligibleFiles(memoryDir: string): EnumerationResult {
  let memoryReal: string;
  try {
    memoryReal = realpathSync(memoryDir);
  } catch {
    return { files: [], complete: false };
  }

  let names: string[];
  try {
    names = readdirSync(memoryReal);
  } catch {
    return { files: [], complete: false };
  }

  const files: EligibleFile[] = [];
  let complete = true;

  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    if (DENYLIST.has(name.toLowerCase())) continue;

    const absPath = join(memoryReal, name);
    let realPath: string;
    let bytes: number;
    try {
      realPath = realpathSync(absPath);
      const st = statSync(realPath);
      if (!st.isFile()) continue; // directories, fifos, etc.
      bytes = st.size;
    } catch {
      // A single entry that vanished/raced mid-scan makes THIS pass incomplete,
      // so we do not mistake other present files' absence for deletions.
      complete = false;
      continue;
    }

    // Symlink escape guard: the resolved target must stay inside the consented
    // directory. A symlink pointing outside is silently excluded.
    if (!isContained(realPath, memoryReal)) continue;

    files.push({ relativePath: name, absPath, realPath, bytes });
  }

  return { files, complete };
}
