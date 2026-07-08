import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

import { HOME, readConfig } from "../lib/config";
import {
  isCanonicalTraceId,
  loadBuildInfo,
  telemetryDisabled,
} from "../lib/observability";
import { tryResolveWorkspaceId } from "../lib/workspace";
import { get as controlGet } from "../lib/http";
import {
  BundleInputs,
  RedactionCounts,
  RedactionOptions,
  buildBundle,
  collectLocalLogs,
  redactValue,
} from "../lib/debug-bundle";

// `mla debug bundle --trace-id <id>` (Phase 5 / spec gap 6.7).
//
// Produces a single local .zip the user can inspect and then choose to attach
// to an issue. Nothing is uploaded. The hard guarantees (manifest-first,
// offline-capable, mandatory redaction report, raw payloads excluded by
// default) live in lib/debug-bundle.ts; this file is the IO + argv shell around
// it: parse flags, run the OBS-1 shape guard, gather local logs + a best-effort
// backend summary, gate the raw-payload opt-ins behind a confirmation, and
// write the zip.
//
// Output path note (deviation from the spec's literal `.mla/debug/<id>.zip`):
// every other piece of mla state lives under HOME (~/.meetless), and minting a
// brand-new `.mla/` directory in the user's cwd risks it being committed to
// their repo by accident. We write to `${HOME}/debug/<trace_id>.zip` and print
// the absolute path so it is findable; `--out <path>` overrides. The literal
// path in the doc is updated to match.

interface DebugBundleFlags {
  traceId: string;
  out?: string;
  includePrompts: boolean;
  includeDiffs: boolean;
  yes: boolean;
  noBackend: boolean;
  command?: string;
  runId?: string;
  sessionId?: string;
  quiet: boolean;
}

const KNOWN_FLAGS = new Set([
  "--trace-id",
  "--out",
  "--include-prompts",
  "--include-diffs",
  "--yes",
  "-y",
  "--no-backend",
  "--command",
  "--run-id",
  "--session-id",
  "--quiet",
  "-q",
]);

const FLAGS_WITH_VALUES = new Set([
  "--trace-id",
  "--out",
  "--command",
  "--run-id",
  "--session-id",
]);

// A value-bearing flag must be followed by a real value, never the next flag,
// or an operator's "drop the value" typo silently changes intent.
function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  if (v.startsWith("-")) {
    throw new Error(`Missing value for ${flag} (got the next flag ${v} instead)`);
  }
  return v;
}

export function parseArgs(argv: string[]): DebugBundleFlags {
  const out: Partial<DebugBundleFlags> = {
    includePrompts: false,
    includeDiffs: false,
    yes: false,
    noBackend: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--trace-id":
        out.traceId = takeValue(argv, i, a);
        i += 1;
        break;
      case "--out":
        out.out = takeValue(argv, i, a);
        i += 1;
        break;
      case "--command":
        out.command = takeValue(argv, i, a);
        i += 1;
        break;
      case "--run-id":
        out.runId = takeValue(argv, i, a);
        i += 1;
        break;
      case "--session-id":
        out.sessionId = takeValue(argv, i, a);
        i += 1;
        break;
      case "--include-prompts":
        out.includePrompts = true;
        break;
      case "--include-diffs":
        out.includeDiffs = true;
        break;
      case "--yes":
      case "-y":
        out.yes = true;
        break;
      case "--no-backend":
        out.noBackend = true;
        break;
      case "--quiet":
      case "-q":
        out.quiet = true;
        break;
      default:
        if (a.startsWith("-") && !KNOWN_FLAGS.has(a)) {
          throw new Error(
            `Unknown flag: ${a}. Supported: ${[...KNOWN_FLAGS].join(", ")}`,
          );
        }
        throw new Error(`Unexpected argument: ${a}`);
    }
  }
  if (!out.traceId) {
    throw new Error("`mla debug bundle` requires --trace-id <id>");
  }
  return out as DebugBundleFlags;
}

// Best-effort backend summary. The result is folded into the bundle: `summary`
// (already redacted) goes in as backend-summary.json, `langfuseProjectId`
// upgrades the deep-links to a concrete URL, and a `warning` (never an error)
// records why the summary is missing. Injectable so tests never touch a network.
export interface BackendResult {
  summary: unknown | null;
  langfuseProjectId: string | null;
  warning: string | null;
}

export type BackendFetcher = (
  traceId: string,
  opts: RedactionOptions,
  counts: RedactionCounts,
) => Promise<BackendResult>;

// Default fetcher: ask control for an observability summary of the trace. There
// is no such endpoint today, so this will normally fail; that is fine and
// expected. The point of the seam is that it is fail-soft (any error becomes a
// warning + a partial bundle) and that it lights up automatically the day
// control grows the endpoint. A bundle never requires backend access (spec 6.7).
const defaultBackendFetcher: BackendFetcher = async (traceId, opts, counts) => {
  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    return {
      summary: null,
      langfuseProjectId: null,
      warning: `backend summary skipped: no usable config (${errText(e)})`,
    };
  }
  try {
    const raw = await controlGet<{ summary?: unknown; langfuseProjectId?: string }>(
      cfg,
      `/internal/v1/observability/trace/${traceId}`,
      8000,
    );
    const summary =
      raw && typeof raw === "object" && "summary" in raw
        ? redactValue((raw as { summary: unknown }).summary, opts, counts)
        : redactValue(raw, opts, counts);
    const lf =
      raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).langfuseProjectId === "string"
        ? ((raw as Record<string, unknown>).langfuseProjectId as string)
        : null;
    return { summary, langfuseProjectId: lf, warning: null };
  } catch (e) {
    return {
      summary: null,
      langfuseProjectId: null,
      warning:
        `backend trace summary unavailable (${errText(e)}); bundle is partial ` +
        `(local logs only). This is expected offline or against a backend ` +
        `without the observability summary endpoint.`,
    };
  }
};

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// Interactive confirmation for the raw-payload opt-ins. Default reads from the
// TTY. Non-interactive callers (no TTY) MUST pass --yes to include raw payloads;
// otherwise we refuse rather than silently bundling sensitive content.
async function confirmInteractive(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer: string = await new Promise((resolve) => rl.question(prompt, resolve));
    const norm = answer.trim().toLowerCase();
    return norm === "y" || norm === "yes";
  } finally {
    rl.close();
  }
}

export interface RunDebugDeps {
  home?: string;
  now?: () => string;
  backendFetcher?: BackendFetcher;
  confirm?: (prompt: string) => Promise<boolean>;
  isTTY?: boolean;
  cwd?: string;
}

export async function runDebug(argv: string[], deps: RunDebugDeps = {}): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "bundle") {
    console.error(
      `Unknown debug subcommand: ${sub ?? "(none)"}. Usage: mla debug bundle --trace-id <id>`,
    );
    return 2;
  }

  let flags: DebugBundleFlags;
  try {
    flags = parseArgs(rest);
  } catch (e) {
    console.error(errText(e));
    return 2;
  }

  // OBS-1 shape guard up front: a malformed id never seeds a bundle path.
  if (!isCanonicalTraceId(flags.traceId)) {
    console.error(
      `Invalid --trace-id "${flags.traceId}": expected 32 lowercase hex chars ` +
        `(OBS-1). The id is the last path segment of the Langfuse deep-link mla ` +
        `prints on a run.`,
    );
    return 2;
  }

  const home = deps.home ?? HOME;
  const now = deps.now ?? (() => new Date().toISOString());
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const confirm = deps.confirm ?? confirmInteractive;
  const backendFetcher = deps.backendFetcher ?? defaultBackendFetcher;
  const opts: RedactionOptions = {
    includePrompts: flags.includePrompts,
    includeDiffs: flags.includeDiffs,
  };

  // Gate the raw-payload opt-ins. Interactive: ask once, naming exactly what
  // would be included. Non-interactive without --yes: refuse (never silently
  // bundle sensitive content for an automated caller).
  if (opts.includePrompts || opts.includeDiffs) {
    const categories = [
      opts.includePrompts ? "prompts, document bodies, tool payloads, raw requests" : null,
      opts.includeDiffs ? "source diffs" : null,
    ]
      .filter(Boolean)
      .join("; ");
    if (!flags.yes) {
      if (!isTTY) {
        console.error(
          `Refusing to include raw payloads (${categories}) non-interactively. ` +
            `Re-run with --yes to confirm in a non-interactive context.`,
        );
        return 2;
      }
      const ok = await confirm(
        `This bundle will include RAW payloads (${categories}). These can contain ` +
          `sensitive content. Include them? [y/N] `,
      );
      if (!ok) {
        console.error("Aborted: raw payloads not included. Re-run without the include flags for a redacted bundle.");
        return 1;
      }
    }
  }

  const counts: RedactionCounts = { diffs: 0, prompts: 0, secrets: 0 };
  const warnings: string[] = [];

  // Local logs: always, offline-capable. Trace-scoped + redacted in the core.
  const logsDir = path.join(home, "logs");
  const localLogs = collectLocalLogs(logsDir, flags.traceId, opts, counts);

  // Best-effort backend summary (skippable with --no-backend).
  let backendSummary: unknown | null = null;
  let langfuseProjectId: string | null = null;
  if (flags.noBackend) {
    warnings.push("backend summary skipped (--no-backend); bundle is local-only.");
  } else {
    const r = await backendFetcher(flags.traceId, opts, counts);
    backendSummary = r.summary;
    langfuseProjectId = r.langfuseProjectId;
    if (r.warning) warnings.push(r.warning);
  }

  const workspaceId = (() => {
    try {
      return tryResolveWorkspaceId(deps.cwd ?? process.cwd());
    } catch {
      return null;
    }
  })();

  const build = loadBuildInfo();
  const inputs: BundleInputs = {
    traceId: flags.traceId,
    createdAt: now(),
    mlaVersion: build.version,
    releaseSha: build.sha,
    workspaceId,
    command: flags.command ?? "unknown",
    runId: flags.runId ?? null,
    sessionId: flags.sessionId ?? null,
    telemetryEnabled: !telemetryDisabled(),
    langfuseProjectId,
    sentryUrl: null,
    opts,
    localLogs,
    backendSummary,
    warnings,
    redactionCounts: counts,
  };

  const built = buildBundle(inputs);

  const outPath = flags.out
    ? path.resolve(flags.out)
    : path.join(home, "debug", `${flags.traceId}.zip`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, built.zip, { mode: 0o600 });

  if (!flags.quiet) {
    console.log(`Wrote debug bundle: ${outPath}`);
    console.log(`  trace_id:  ${flags.traceId}`);
    console.log(`  files:     ${built.fileList.length + 1} (incl. manifest.json)`);
    console.log(
      `  redacted:  ${counts.prompts} prompt-field(s), ${counts.diffs} diff-field(s), ` +
        `${counts.secrets} secret(s)` +
        (opts.includePrompts || opts.includeDiffs ? " (raw payloads INCLUDED per flags)" : ""),
    );
    if (warnings.length > 0) {
      console.log(`  warnings:  ${warnings.length} (see manifest.json / redaction-report.json)`);
    }
    console.log(
      "Review manifest.json + redaction-report.json before sharing. Nothing was uploaded.",
    );
  }

  return 0;
}
