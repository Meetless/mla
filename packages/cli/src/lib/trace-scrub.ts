// One-shot drain for raw prompt bodies left in `~/.meetless/logs/ask-traces.jsonl`.
//
// The hook's `write_trace` no longer records `input.prompt` at all, and the comment there
// states the reasoning this file inherits: redaction KEEPS text, so every secret shape the
// scanner does not yet know still lands on disk, while not writing the field cannot fail
// open. So this drops the field; it does not redact it.
//
// That fix is forward-only. The dogfood machine carries 4,302 pre-fix rows spanning
// 2026-06-03 to 2026-08-06, including the four credential shapes reported on 2026-08-04
// (`sk-ant-` len 108, `ghp_` len 40, two `cf*t_` len 53) and still unrotated. Nothing in
// the hot path may rewrite this file -- a hook that silently rewrites history on every
// prompt is a far worse failure mode than the one it fixes -- so this is an explicit
// operator command (`mla _internal scrub-traces`), run once, reporting what it found.

import { readFileSync, writeFileSync, renameSync, statSync, chmodSync, unlinkSync, readdirSync } from "fs";
import { dirname, join } from "path";

import { scanForCredentials } from "./redactor";

// The only free-text field ever written into a trace row. Verified against the live
// corpus: `.input | keys` over 4,319 rows yields exactly raw_prompt_hash (4,319),
// prompt_chars (4,319) and prompt (4,302). Dropping `prompt` therefore removes the entire
// free-text surface while leaving every row with the length and hash it already had.
const RAW_BODY_FIELD = "prompt";

export interface ScrubbedLine {
  line: string;
  changed: boolean;
  /** True when the line is not JSON we could read. Such a line is PRESERVED verbatim. */
  unparseable?: boolean;
  /** Credential rule ids seen in the dropped body. Ids only, never the matched text. */
  credentialKinds?: string[];
}

export function scrubTraceLine(line: string): ScrubbedLine {
  if (line.trim() === "") return { line, changed: false };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A truncated tail is the normal shape of a file being appended to under a lock.
    // Deleting it would destroy a whole row to protect a field it may not even carry.
    return { line, changed: false, unparseable: true };
  }

  const input = parsed.input;
  if (!input || typeof input !== "object" || !(RAW_BODY_FIELD in input)) {
    // Already conforms to the current writer's contract. Returned byte-identical rather
    // than re-serialized: the hook's jq chose this key order, and re-emitting it would
    // churn every clean row and make a diff of this file unreadable.
    return { line, changed: false };
  }

  const body = (input as Record<string, unknown>)[RAW_BODY_FIELD];
  const credentialKinds = typeof body === "string" ? scanForCredentials(body) : [];
  delete (input as Record<string, unknown>)[RAW_BODY_FIELD];

  return { line: JSON.stringify(parsed), changed: true, credentialKinds };
}

export interface ScrubReport {
  total: number;
  scrubbed: number;
  unparseable: number;
  /** Sorted, de-duplicated credential rule ids across the whole file. Never values. */
  credentialKinds: string[];
}

export function scrubTraceFile(path: string): ScrubReport {
  const original = readFileSync(path, "utf8");
  // A trailing newline is meaningful (the file is append-only under a lock), so split on
  // it and restore it rather than letting the last row lose its terminator.
  const hadTrailingNewline = original.endsWith("\n");
  const lines = original.split("\n");
  if (hadTrailingNewline) lines.pop();

  const report: ScrubReport = { total: 0, scrubbed: 0, unparseable: 0, credentialKinds: [] };
  const kinds = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    if (line.trim() !== "") report.total += 1;
    const result = scrubTraceLine(line);
    if (result.changed) report.scrubbed += 1;
    if (result.unparseable) report.unparseable += 1;
    for (const kind of result.credentialKinds ?? []) kinds.add(kind);
    out.push(result.line);
  }
  report.credentialKinds = [...kinds].sort();

  // Nothing to do: leave the inode, the mtime and the mode exactly as they were. This is
  // what makes a second run provably a no-op rather than merely idempotent in content.
  if (report.scrubbed === 0) return report;

  // Preserve the mode across the atomic replace. `rename` installs a NEW inode, so a
  // fresh file would take whatever the umask says; the live file is 0600 via
  // `ml_private_file`, and scrubbing secrets out of a file while widening its permissions
  // would trade one exposure for another.
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    /* default to owner-only, the stricter guess */
  }

  const tmp = join(dirname(path), `.${Date.now()}.scrub.tmp`);
  try {
    writeFileSync(tmp, out.join("\n") + (hadTrailingNewline ? "\n" : ""), { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  return report;
}

// ---------------------------------------------------------------------------------------
// The sidecar: logs/enrichments/<trace_id>.md
//
// `write_sidecar` printed the RAW prompt under a `## Prompt` heading on every turn. That is
// the SAME material `write_trace` stopped recording on 2026-08-04, written to a different
// file that nobody named, at mode 0644, one file per prompt. On 2026-08-05 the dogfood
// machine held 4,323 of them and all four credential families the 08-04 audit reported "in
// the trace" were still sitting in these, world-readable.
//
// Two independent defects live here and both are repaired below: the body, and the mode. A
// sidecar with no prompt is still a 0644 file holding the injected payload, so the chmod is
// applied to EVERY file, not only the ones that carried a body.

const PROMPT_HEADING = "## Prompt";

// Written in place of the body so a scrubbed file states what happened to it. A section that
// merely goes blank is indistinguishable from a turn that had no prompt, and this string is
// also what makes a second run provably a no-op.
const REMOVED_MARKER =
  "(prompt body removed by `mla _internal scrub-traces`; the length and hash for this turn are in ask-traces.jsonl, keyed by this file's trace id)";

export function scrubSidecarText(text: string): { text: string; changed: boolean; credentialKinds: string[] } {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === PROMPT_HEADING);
  if (start === -1) return { text, changed: false, credentialKinds: [] };

  // The body runs to the NEXT `## ` heading, not to the next blank line: a real prompt is
  // routinely multi-line (pasted logs, diffs, whole specs), and a fix that dropped only the
  // first line would pass a single-line fixture while leaking every interesting case.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start + 1, end).join("\n");
  if (body.includes(REMOVED_MARKER)) return { text, changed: false, credentialKinds: [] };

  const credentialKinds = scanForCredentials(body);
  const replaced = [...lines.slice(0, start + 1), "", REMOVED_MARKER, "", ...lines.slice(end)];
  return { text: replaced.join("\n"), changed: true, credentialKinds };
}

export interface SidecarScrubReport {
  total: number;
  scrubbed: number;
  tightened: number;
  credentialKinds: string[];
}

export function scrubSidecarDir(dir: string): SidecarScrubReport {
  const report: SidecarScrubReport = { total: 0, scrubbed: 0, tightened: 0, credentialKinds: [] };
  const kinds = new Set<string>();

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return report;
  }

  for (const name of entries) {
    const path = join(dir, name);
    report.total += 1;

    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    const result = scrubSidecarText(current);
    if (result.changed) {
      // Written in place rather than through a temp+rename. These files are per-turn and
      // write-once: unlike ask-traces.jsonl nothing appends to a sidecar after its turn
      // ends, so there is no concurrent writer to race with, and an atomic replace would
      // cost 4,323 inode churns to protect against a writer that does not exist.
      try {
        writeFileSync(path, result.text);
        report.scrubbed += 1;
        for (const kind of result.credentialKinds) kinds.add(kind);
      } catch {
        continue;
      }
    }

    // Always, including for files that had no body. The permission defect is independent of
    // the body defect; fixing only the files that happen to carry a prompt would leave most
    // of the corpus world-readable while the report claimed the leak was closed.
    try {
      if ((statSync(path).mode & 0o777) !== 0o600) {
        chmodSync(path, 0o600);
        report.tightened += 1;
      }
    } catch {
      /* best effort */
    }
  }

  report.credentialKinds = [...kinds].sort();
  return report;
}
