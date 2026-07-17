import * as fs from "fs";
import * as path from "path";
import { resolveMeetlessHome } from "../lib/config";

// `mla label` -- the A3 operator-label affordance (notes/20260603-mla-kb-agent
// -proxy-and-evidence-adoption.md §3, §7.2). A lightweight way for the operator
// to mark a handful of enrichments useful / noisy / harmful / prevented-a
// -mistake. It writes the reserved `operator_label` block back into a trace line
// in ~/.meetless/logs/ask-traces.jsonl. Low volume, high signal: this is the
// ground-truth anchor the composite needs before any weight tuning, and the
// `harmful` flag is the exact field the A5 carry-forward hook reads to suppress
// a re-surface, so a `--harmful` label here closes that loop.
//
//   mla label [<trace_id>] [--useful] [--noisy] [--harmful]
//             [--prevented-mistake] [--note <text>]
//
// With no <trace_id> it labels the LATEST trace in the current session, scoping
// to CLAUDE_CODE_SESSION_ID exactly like `mla summary` / `mla review`. The
// parent Claude Code shell exports that var, so the operator labels "the
// enrichment I just saw" without copying its id off the prompt. Pass an explicit
// trace_id to label any past trace from outside a session.
//
// This is the WRITE side of the block that `mla summary` reads and tallies; it
// is deliberately a standalone command, not a revival of the removed `mla
// traces` tree (that subtree was dropped 2026-05-31, see summary.ts header).

// Paths resolve lazily from MEETLESS_HOME (same fallback as lib/config + summary)
// so the short-lived CLI picks up the operator's env and tests can point at a
// temp dir.
function logDir(): string {
  return path.join(resolveMeetlessHome(), "logs");
}
function tracesFile(): string {
  return path.join(logDir(), "ask-traces.jsonl");
}

interface OperatorLabel {
  useful?: boolean | null;
  noisy?: boolean | null;
  harmful?: boolean | null;
  prevented_mistake?: boolean | null;
  notes?: string | null;
}

interface TraceLine {
  trace_id?: string;
  session_id?: string;
  operator_label?: OperatorLabel | null;
}

function readLines(): string[] {
  if (!fs.existsSync(tracesFile())) return [];
  return fs
    .readFileSync(tracesFile(), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

function parse(line: string): TraceLine | null {
  try {
    const o = JSON.parse(line);
    return o && typeof o === "object" ? (o as TraceLine) : null;
  } catch {
    return null;
  }
}

export interface LabelArgs {
  // null => default to the latest trace in the current session.
  traceId: string | null;
  patch: OperatorLabel;
}

export function parseLabelArgs(argv: string[]): LabelArgs {
  let traceId: string | null = null;
  const patch: OperatorLabel = {};
  let any = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--useful") {
      patch.useful = true;
      any = true;
    } else if (a === "--noisy") {
      patch.noisy = true;
      any = true;
    } else if (a === "--harmful") {
      patch.harmful = true;
      any = true;
    } else if (a === "--prevented-mistake") {
      patch.prevented_mistake = true;
      any = true;
    } else if (a === "--note") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--note requires a value");
      patch.notes = v;
      any = true;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag for \`mla label\`: ${a}`);
    } else if (traceId === null) {
      traceId = a;
    } else {
      throw new Error(`Unexpected extra argument: ${a}`);
    }
  }
  if (!any) {
    throw new Error(
      "Provide at least one of --useful / --noisy / --harmful / --prevented-mistake / --note.",
    );
  }
  return { traceId, patch };
}

// Compact, deterministic render of the merged label state for the confirmation
// line. Shows the FULL resulting block (not just this patch) so the operator
// sees the cumulative verdict after a merge.
function renderLabel(l: OperatorLabel): string {
  const parts: string[] = [];
  if (l.useful === true) parts.push("useful");
  if (l.noisy === true) parts.push("noisy");
  if (l.harmful === true) parts.push("harmful");
  if (l.prevented_mistake === true) parts.push("prevented-mistake");
  if (typeof l.notes === "string" && l.notes.length > 0) parts.push(`note="${l.notes}"`);
  return parts.length ? parts.join(", ") : "(no flags set)";
}

export function runLabel(argv: string[]): number {
  let args: LabelArgs;
  try {
    args = parseLabelArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const lines = readLines();
  if (lines.length === 0) {
    console.error(`No traces found at ${tracesFile()}.`);
    return 1;
  }

  // Resolve which line index(es) to label, plus a label for the confirmation.
  let targetIdxs: number[];
  let what: string;
  if (args.traceId) {
    // Explicit trace_id: rewrite every matching line. trace_id is a unique join
    // key, but if a line were ever duplicated we label them all so the read side
    // can never see a stale copy.
    targetIdxs = lines.flatMap((line, i) => (parse(line)?.trace_id === args.traceId ? [i] : []));
    if (targetIdxs.length === 0) {
      console.error(`Trace not found: ${args.traceId}`);
      return 1;
    }
    what = args.traceId;
  } else {
    // Default selector: the latest trace in the current session.
    const session = (process.env.CLAUDE_CODE_SESSION_ID || "").trim();
    if (!session) {
      console.error(
        "No <trace_id> given and no current session (CLAUDE_CODE_SESSION_ID unset). " +
          "Pass an explicit trace_id, or run `mla label` inside a Claude Code session.",
      );
      return 2;
    }
    let lastIdx = -1;
    let lastTid = "";
    lines.forEach((line, i) => {
      const t = parse(line);
      if (t && t.session_id === session) {
        lastIdx = i;
        lastTid = t.trace_id ?? "";
      }
    });
    if (lastIdx < 0) {
      console.error(
        `No traces for the current session (${session}) at ${tracesFile()}. ` +
          "Pass an explicit trace_id to label a trace from another session.",
      );
      return 1;
    }
    targetIdxs = [lastIdx];
    what = lastTid || `(latest in ${session})`;
  }

  const targets = new Set(targetIdxs);
  let merged: OperatorLabel = {};
  const rewritten = lines.map((line, i) => {
    if (!targets.has(i)) return line;
    const t = parse(line);
    if (!t) return line; // defensive: selection only picks parseable lines.
    merged = { ...(t.operator_label ?? {}), ...args.patch };
    return JSON.stringify({ ...t, operator_label: merged });
  });

  // Atomic replace: write a sibling temp file, then rename over the target.
  // Node has no native advisory lock and we deliberately do NOT shell out to
  // flock(1) for this; labeling is a single-operator action that happens
  // BETWEEN prompts (never during a hook write), so the lost-append window if
  // the hook appends a brand-new trace between our read and rename is
  // negligible, and the temp+rename guarantees any concurrent reader always
  // sees a complete, consistent file.
  const tmp = path.join(logDir(), `.ask-traces.${process.pid}.tmp`);
  fs.writeFileSync(tmp, rewritten.join("\n") + "\n");
  fs.renameSync(tmp, tracesFile());

  const n = targetIdxs.length;
  console.log(`Labeled ${what}: ${renderLabel(merged)} (${n} line${n === 1 ? "" : "s"}).`);
  return 0;
}
