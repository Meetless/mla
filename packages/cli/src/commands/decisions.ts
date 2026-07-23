/**
 * `mla decisions show <id>`: export one governed decision as a DecisionRecord
 * (ADR notes/20260717-adr-decision-record-projection-and-reconciliation.md, Phase 4 / T12).
 *
 * There is no stored DecisionRecord. Control assembles it from the governed graph on
 * every read, and console, CLI and MCP all render the SAME `DecisionRecordDto`. This
 * command adds no field, infers nothing, and reformats nothing: it fetches that DTO and
 * hands it to the pure Markdown serializer (`--format md`) or prints it verbatim
 * (`--format json`).
 *
 * The viewer is NOT sent from here. Control derives it from the cli-session token
 * (INV-AUTH-1, the same discipline as `mla conflicts resolve`), which matters because
 * §4.5 evidence withholding is viewer-dependent: a decision sourced from someone else's
 * Ask turn shows the source as private rather than disclosing its identity. A caller who
 * could name the viewer could read past that fence.
 */
import {
  loadWorkspaceConfig,
  consoleDeepLink,
  WorkspaceCliConfig,
} from "../lib/config";
import { get, HttpError } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";
import {
  renderDecisionRecordMarkdown,
  type DecisionRecord,
} from "../lib/decision-record-markdown";

const FETCH_TIMEOUT_MS = 15_000;

export type DecisionFormat = "md" | "json";

export interface DecisionsDeps {
  loadConfig?: () => WorkspaceCliConfig;
  fetchRecord?: (
    cfg: WorkspaceCliConfig,
    id: string,
  ) => Promise<DecisionRecord>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function defaultFetchRecord(
  cfg: WorkspaceCliConfig,
  id: string,
): Promise<DecisionRecord> {
  // The agent plane (InternalOrCliSessionGuard). workspaceId only ECHOES the session's
  // own workspace; control rejects a mismatch rather than honoring it.
  const qs = new URLSearchParams({ workspaceId: cfg.workspaceId });
  return get<DecisionRecord>(
    cfg,
    `/internal/v1/decisions/${encodeURIComponent(id)}?${qs.toString()}`,
    FETCH_TIMEOUT_MS,
  );
}

export interface ParsedDecisionsArgs {
  verb: "show";
  id: string;
  format: DecisionFormat;
}

/**
 * Parse `mla decisions show <id> [--format md|json] [--json]`.
 * Throws on any malformed invocation so a bad call fails loud instead of exporting
 * the wrong record or a silently empty one.
 */
export function parseDecisionsArgs(argv: string[]): ParsedDecisionsArgs {
  if (argv.length === 0 || argv[0] !== "show") {
    throw new Error("Usage: mla decisions show <decision-id> [--format md|json]");
  }

  let id: string | undefined;
  let format: DecisionFormat = "md";

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--format requires a value (md|json)");
      if (v !== "md" && v !== "json") {
        throw new Error(`Unknown --format '${v}'. Use md or json.`);
      }
      format = v;
    } else if (a === "--json") {
      // Alias for --format json, matching every other `mla` read command.
      format = "json";
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag '${a}' for \`mla decisions show\`.`);
    } else if (id === undefined) {
      id = a;
    } else {
      throw new Error(`Unexpected argument '${a}'. Pass exactly one decision id.`);
    }
  }

  if (!id || !id.trim()) {
    throw new Error("Usage: mla decisions show <decision-id> [--format md|json]");
  }
  return { verb: "show", id: id.trim(), format };
}

export async function runDecisions(
  argv: string[],
  deps: DecisionsDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));

  let parsed: ParsedDecisionsArgs;
  try {
    parsed = parseDecisionsArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }

  const cfg = (deps.loadConfig ?? loadWorkspaceConfig)();
  const fetchRecord = deps.fetchRecord ?? defaultFetchRecord;

  let record: DecisionRecord;
  try {
    record = await fetchRecord(cfg, parsed.id);
  } catch (e) {
    return reportFetchError(e, parsed.id, cfg, err);
  }

  if (parsed.format === "json") {
    out(JSON.stringify(record, null, 2));
    return 0;
  }
  // The serializer already ends with exactly one newline; console.log would add a
  // second. Trim the trailing break and let the writer supply the line ending.
  out(renderDecisionRecordMarkdown(record).replace(/\n$/, ""));
  return 0;
}

function reportFetchError(
  e: unknown,
  id: string,
  cfg: WorkspaceCliConfig,
  err: (l: string) => void,
): number {
  if (isWorkspaceAccessDenied(e)) {
    err(workspaceAccessDeniedMessage(e));
    return 1;
  }
  const status = (e as HttpError | undefined)?.status;
  if (status === 401 || status === 403) {
    err("Not authorized. Run `mla login` to read decisions as yourself.");
    return 1;
  }
  if (status === 404) {
    err(
      `No decision ${id} in this workspace. Browse them here: ${consoleDeepLink(cfg, "/decisions")}`,
    );
    return 1;
  }
  if (status === 422) {
    // The assembler projects ACCEPTED and SUPERSEDED only. A candidate, pending,
    // expired, dismissed, retracted or challenged commitment is not a decision yet,
    // and saying "not found" for one would be a lie.
    err(
      `${id} is not a projectable decision: only an ACCEPTED or SUPERSEDED commitment has a DecisionRecord.`,
    );
    return 1;
  }
  if (status === undefined) {
    err("Could not reach the backend to read this decision.");
    return 1;
  }
  err(`Could not read decision ${id}: HTTP ${status}`);
  return 1;
}
