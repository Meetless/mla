import * as fs from "fs";
import * as path from "path";
import { resolveMeetlessHome } from "../lib/config";

// `mla summary` -- aggregate view over the hook's enrichment trace JSONL
// (T18b, §6.9). Counts/latency/cost/labels across the most recent N prompts.
//
//   mla summary [--last N] [--json] [--all]
//
// By default it auto-scopes to the CURRENT session via CLAUDE_CODE_SESSION_ID
// (the env var the parent Claude Code shell exports, same as `mla review`), so
// there is deliberately NO `--session` flag: the shell already told us which
// session this is. `--all` opts back out to the cross-session aggregate; when
// run outside a session (var unset) it defaults to global.
//
// Was `mla traces summarize`; the `traces show`/`traces label` subcommands were
// removed 2026-05-31. Per-trace inspection is unnecessary from the CLI: every
// enrichment writes its trace_id to ~/.meetless/logs/ask-traces.jsonl AND the
// same id is printed live on each prompt's `<meetless-context trace="...">`
// block, so the operator pins a run via the prompt or `jq`/`tail` over the
// JSONL and opens it in the Langfuse dashboard. This command stays as the only
// thing the JSONL can't trivially give you by hand: the rolled-up aggregates.
//
// The trace line schema is produced by user-prompt-submit.sh write_trace(); we
// read only the fields we tally and treat everything as optional/best-effort so
// a partially-written or future-extended line never crashes the summary.

// Paths are resolved lazily from MEETLESS_HOME (same fallback as lib/config's
// HOME) so the short-lived CLI process picks up the operator's env, and tests
// can point at a temp dir without module-cache tricks.
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
  ts?: string;
  session_id?: string;
  surface?: string;
  experiment?: { variant?: string | null };
  enrichment?: {
    strategy?: string | null;
    status?: string | null;
    latency_ms?: number | null;
    cost_usd?: number | null;
    confidence?: string | null;
  } | null;
  arbitration?: { decision?: string | null; reason?: string | null; discarded_after_compute?: boolean | null };
  hook?: {
    intercept_latency_ms?: number | null;
    injected?: boolean | null;
    injected_chars?: number | null;
    fail_open_reason?: string | null;
    truncated?: boolean | null;
  };
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

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil(p * sortedAsc.length) - 1;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, idx))];
}

function isLabeled(l: OperatorLabel | null | undefined): boolean {
  if (!l) return false;
  return (
    l.useful === true ||
    l.noisy === true ||
    l.harmful === true ||
    l.prevented_mistake === true ||
    (typeof l.notes === "string" && l.notes.trim().length > 0)
  );
}

interface SummaryArgs {
  last: number;
  json: boolean;
  all: boolean;
}

export function parseSummaryArgs(argv: string[]): SummaryArgs {
  const out: SummaryArgs = { last: 20, json: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--all") out.all = true;
    else if (a === "--last") {
      const v = argv[++i];
      const parsed = Number(v);
      if (!v || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--last requires a positive integer (got: ${v ?? "(none)"})`);
      }
      out.last = parsed;
    } else throw new Error(`Unknown flag for \`mla summary\`: ${a}`);
  }
  return out;
}

function buildSummary(traces: TraceLine[]) {
  let injected = 0;
  let discarded = 0;
  let failOpen = 0;
  let timeouts = 0;
  let totalCost = 0;
  const latencies: number[] = [];
  const injectedChars: number[] = [];
  const strategies: Record<string, number> = {};
  let useful = 0;
  let noisy = 0;
  let harmful = 0;
  let labeled = 0;

  for (const t of traces) {
    const decision = t.arbitration?.decision ?? "";
    if (decision === "injected") injected++;
    if (t.arbitration?.discarded_after_compute === true) discarded++;
    if (decision === "fail_open") failOpen++;

    const failReason = t.hook?.fail_open_reason ?? "";
    if (failReason === "timeout" || t.enrichment?.status === "timeout") timeouts++;

    const lat = num(t.enrichment?.latency_ms);
    if (lat !== null) latencies.push(lat);

    const cost = num(t.enrichment?.cost_usd);
    if (cost !== null) totalCost += cost;

    if (decision === "injected") {
      const chars = num(t.hook?.injected_chars);
      if (chars !== null) injectedChars.push(chars);
    }

    const strat = t.experiment?.variant || t.enrichment?.strategy || "unknown";
    strategies[strat] = (strategies[strat] ?? 0) + 1;

    const ol = t.operator_label;
    if (ol?.useful === true) useful++;
    if (ol?.noisy === true) noisy++;
    if (ol?.harmful === true) harmful++;
    if (isLabeled(ol)) labeled++;
  }

  latencies.sort((a, b) => a - b);
  const avgLat = latencies.length ? latencies.reduce((s, v) => s + v, 0) / latencies.length : 0;
  const p95Lat = percentile(latencies, 0.95);
  const avgChars = injectedChars.length
    ? Math.round(injectedChars.reduce((s, v) => s + v, 0) / injectedChars.length)
    : 0;
  const timeoutRate = traces.length ? timeouts / traces.length : 0;

  return {
    prompt_count: traces.length,
    injected,
    discarded_after_compute: discarded,
    fail_open: failOpen,
    avg_enrichment_latency_ms: Math.round(avgLat),
    p95_enrichment_latency_ms: p95Lat,
    timeout_rate: timeoutRate,
    total_cost_usd: totalCost,
    avg_injected_chars: avgChars,
    strategies,
    operator_labels: { useful, noisy, harmful, unlabeled: traces.length - labeled },
  };
}

function renderSummary(s: ReturnType<typeof buildSummary>): string {
  const secs = (ms: number) => (ms / 1000).toFixed(1) + "s";
  const pct = (r: number) => (r * 100).toFixed(0) + "%";
  const strat = Object.entries(s.strategies)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return [
    `Prompt count: ${s.prompt_count}`,
    `Injected: ${s.injected}   Discarded after compute: ${s.discarded_after_compute}   Fail-open: ${s.fail_open}`,
    `Avg enrichment latency: ${secs(s.avg_enrichment_latency_ms)}   P95: ${secs(
      s.p95_enrichment_latency_ms,
    )}   Timeout rate: ${pct(s.timeout_rate)}`,
    `Total cost: $${s.total_cost_usd.toFixed(2)}   Avg injected chars: ${s.avg_injected_chars}   Strategies: ${
      strat || "(none)"
    }`,
    `Operator labels: ${s.operator_labels.useful} useful / ${s.operator_labels.noisy} noisy / ${s.operator_labels.harmful} harmful / ${s.operator_labels.unlabeled} unlabeled`,
  ].join("\n");
}

export function runSummary(argv: string[]): number {
  let args: SummaryArgs;
  try {
    args = parseSummaryArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const lines = readLines();
  if (lines.length === 0) {
    console.error(`No traces found at ${tracesFile()}.`);
    return 1;
  }
  let traces = lines.map(parse).filter((t): t is TraceLine => t !== null);

  // Auto-scope to the current live session. The parent shell (Claude Code)
  // exports CLAUDE_CODE_SESSION_ID, the same var `mla review` binds to, so the
  // operator never passes a session id by hand. `--all` opts back out to the
  // cross-session aggregate; outside a session (var unset) we default to global
  // since there is no current session to scope to. Scope BEFORE --last so the
  // window is "last N of this session", not "last N overall then filtered".
  const session = (process.env.CLAUDE_CODE_SESSION_ID || "").trim();
  const scoped = !args.all && session.length > 0;
  if (scoped) traces = traces.filter((t) => t.session_id === session);
  if (traces.length === 0) {
    console.error(
      scoped
        ? `No traces for the current session (${session}) at ${tracesFile()}. Use --all for every session.`
        : `No traces found at ${tracesFile()}.`,
    );
    return 1;
  }

  traces = traces.slice(-args.last);
  const summary = buildSummary(traces);
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderSummary(summary));
  }
  return 0;
}
