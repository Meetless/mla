// `mla enrich`: the two CLI bookends for agent-orchestrated onboarding enrichment.
//
//   enrich plan   -> derive the workspace + git root, mint a runId, scan the repo into
//                    an immutable run record (ranked doc targets + a bounded git-history
//                    allowlist), persist it locally, and print the plan the agent reads.
//   enrich ingest -> the agent dispatched read-only scouts against that plan and reports
//                    candidates; this loads the authoritative run record, re-verifies it,
//                    validates + verifies every candidate, and persists the survivors to
//                    the governed KB born PENDING.
//
// The agent never supplies plan data: it gets a runId from `plan` and returns only the
// scout results. All trust enforcement (realpath containment, exist-at-HEAD, line range,
// commit allowlist, plan-digest match) lives in lib/enrichment, exercised here with the
// real filesystem, git, and the kb-add route. See
// notes/20260626-mla-agent-onboarding-enrichment-plan.md (§5, §5b, §6, §6b).

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { HOME, getConsoleUrl, readKbConfig, type KbCliConfig } from "../lib/config";
import { resolveWorkspaceContext } from "../lib/workspace";
import { intelPost } from "../lib/http";
import type { KbAddReceipt } from "../lib/render";
import { buildPlan, persistPlan, loadRunRecord } from "../lib/enrichment/plan";
import {
  acquireOnboardingLock,
  releaseOnboardingLock,
  onboardingLockPath,
  ONBOARDING_LOCK_GRACE_MS,
} from "../lib/enrichment/lock";
import { ingestRun, findCompletedRunWithDigest, type Persister } from "../lib/enrichment/ingest";
import { buildScoutPrompt } from "../lib/enrichment/scout-brief";
import {
  PROTOCOL_VERSION,
  DEFAULT_BUDGET_MS,
  SCOUT_NAMES,
  validateCandidateShape,
  type ScoutName,
  type ScoutIngestOutcome,
  type EnrichmentCandidate,
  type CandidateValidationError,
} from "../lib/enrichment/protocol";
import { MANAGED_RULES_PATH } from "../lib/scanner/managed-rules";
import {
  MATERIALIZE_SHARE_MESSAGE,
  materializeRules,
  type MaterializeResult,
} from "../lib/enrichment/materialize-rules";

const USAGE = `mla enrich: agent-orchestrated onboarding enrichment.

  mla enrich plan [--json] [--budget-ms <n>] [--workspace <id>] [--force]
      Scan this repository into an immutable run record and print the plan the
      agent reads to dispatch its read-only scouts. --json prints the machine
      plan (the agent contract); without it, a human summary. The runId in the
      output is what you pass back to \`enrich ingest\`. If the repository is
      unchanged since a completed onboarding run (same plan digest), the command
      short-circuits to a no-op (\`gated\` in --json) so a re-run adds no duplicate
      candidates; --force overrides and onboards again.

  mla enrich brief --run-id <id> --role <documentation|history> [--workspace <id>]
      Print the exact subagent brief for one scout role, rendered from the run
      record named by --run-id. Read-only; used by \`/mla onboard\` to dispatch each
      scout with the run-specific prompt \`enrich ingest\` will validate against.

  mla enrich ingest --run-id <id> [--results-file <path>] [--json] [--workspace <id>]
      Validate + persist the scouts' candidates against the run record named by
      --run-id. Reads the scout results as JSON from --results-file, or from
      stdin when no file is given (an array of scout results, or an object with a
      \`results\` array). Candidates land in the governed KB born PENDING.
      Exit: 0 clean, 1 a scout needs attention (persistence failed / malformed),
      2 the request was rejected (unknown run, mismatch, corrupt record).

  mla enrich materialize [--accepted-file <path>] [--dry-run] [--json]
      Write the accepted DURABLE rules (constraint, convention, boundary) into the
      mla-managed local rule file (.meetless/rules.md), the file mla materializes
      accepted rules into. Reads the accepted candidates as JSON from --accepted-file,
      or from stdin (a bare array, or an object with an \`accepted\` array). Decisions and
      deprecations are reported as skipped, never written. Local only: no commit, no push
      (prints "Effective locally. Commit and push to share with teammates."). --dry-run
      reports the change without writing. Exit: 0 done (or nothing to do), 2 bad input.`;

// Mirror kb_add's ingest timeout heuristic (it is module-private there). Generous,
// scales with document count: the kb-add route runs the full atomic-claim pipeline.
function ingestTimeoutMs(docCount: number): number {
  return Math.max(120_000, docCount * 20_000);
}

// The git toplevel is the enrichment repository root: `git ls-files` / `git log` must
// run from it so the paths the scouts cite are repo-root-relative and the realpath
// containment check has the right base. Throws a clean error outside a git repo.
function resolveRepositoryRoot(startDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      `mla enrich requires a git repository. No git toplevel found at ${startDir}. ` +
        `Run it from inside an activated, git-tracked repository.`,
    );
  }
}

interface PlanFlags {
  json: boolean;
  budgetMs?: number;
  workspace?: string;
  force: boolean;
}

// The §8 budget knob. `--budget-ms` wins; else MLA_ENRICH_BUDGET_MS; else the protocol
// default (buildPlan applies it). An invalid env value is IGNORED with a warning rather
// than failing the command (an explicit flag with a bad value still hard-errors upstream).
//
// Contract honesty (§8, Phase 0B): this knob sets the run's `deadlineAt`; it is a SOFT
// budget. The CLI does not supervise the scouts (the agent does), so the deadline steers
// the skill's dispatch/wait and the scouts self-limit. Ingest already records a scout that
// reports `timed_out` as partial-and-rerunnable; no late arrival is rejected on time. Do
// not call this a hard ceiling until a live hang-test proves the runtime can abandon a
// straggler at the deadline (background dispatch + scheduled wake + task-stop).
export function resolveBudgetMs(
  flagBudget: number | undefined,
  rawEnv: string | undefined,
): { budgetMs?: number; warning?: string } {
  if (flagBudget !== undefined) return { budgetMs: flagBudget };
  if (rawEnv === undefined || rawEnv.trim() === "") return {};
  const v = Number(rawEnv);
  if (!Number.isFinite(v) || v <= 0) {
    return { warning: `ignoring invalid MLA_ENRICH_BUDGET_MS=${rawEnv} (expected a positive number of milliseconds)` };
  }
  return { budgetMs: v };
}

// Exported for unit tests: the pure flag/payload helpers are the only new logic in this
// shell worth isolating (buildPlan/persistPlan/ingestRun are covered by their own specs).
export function parsePlanArgs(argv: string[]): PlanFlags {
  const flags: PlanFlags = { json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--budget-ms") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error("--budget-ms must be a positive number of milliseconds");
      flags.budgetMs = v;
    } else if (a === "--workspace") {
      flags.workspace = argv[++i];
      if (!flags.workspace) throw new Error("--workspace requires a workspace id");
    } else throw new Error(`Unknown flag for \`mla enrich plan\`: ${a}`);
  }
  return flags;
}

async function runEnrichPlan(argv: string[]): Promise<number> {
  let flags: PlanFlags;
  try {
    flags = parsePlanArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let repositoryRoot: string;
  try {
    const ctx = resolveWorkspaceContext();
    repositoryRoot = resolveRepositoryRoot(ctx.markerDir);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const budget = resolveBudgetMs(flags.budgetMs, process.env.MLA_ENRICH_BUDGET_MS);
  if (budget.warning) console.error(budget.warning);

  const runId = `run-${randomUUID()}`;

  // Active-run guard (verdict item 3): claim the single per-workspace onboarding lock before
  // the expensive scan + scout fan-out. A second `enrich plan` while a run is live is
  // rejected; the lock self-expires after the budget + grace so a crashed run never blocks
  // forever, and `enrich ingest` releases it on completion.
  const ttlMs = (budget.budgetMs ?? DEFAULT_BUDGET_MS) + ONBOARDING_LOCK_GRACE_MS;
  const lock = acquireOnboardingLock({
    home: HOME,
    workspaceId: cfg.workspaceId,
    runId,
    repositoryRoot,
    now: new Date().toISOString(),
    ttlMs,
  });
  if (!lock.ok) {
    const held = lock.held;
    console.error(
      held
        ? `An onboarding run is already active for this workspace (run ${held.runId}, started ${held.createdAt}; the lock frees at ${held.expiresAt}). Wait for it to finish, or retry after it expires.`
        : `An onboarding-run lock exists for this workspace but could not be read; refusing to start a second run. If no run is active, remove ${onboardingLockPath(HOME, cfg.workspaceId)} and retry.`,
    );
    return 2;
  }

  // Build the plan in memory first (no fs writes) so we can compute the deterministic
  // planDigest and run the idempotency gate BEFORE committing a new run record.
  let built;
  try {
    built = buildPlan({
      runId,
      workspaceId: cfg.workspaceId,
      repositoryRoot,
      now: new Date().toISOString(),
      budgetMs: budget.budgetMs,
    });
  } catch (e) {
    // Don't strand the lock on a failed plan: the run never started.
    releaseOnboardingLock(HOME, cfg.workspaceId, runId);
    console.error((e as Error).message);
    return 2;
  }

  // Idempotency gate (verdict: re-running onboarding on an unchanged repo must add nothing).
  // If this repo was already onboarded at this exact plan digest, re-running only spawns
  // near-duplicate PENDING candidates (LLM scout output is non-deterministic, so candidateIds
  // drift and server dedup never fires). Short-circuit to a no-op unless --force. Release the
  // lock first: a no-op holds no run, and we must NOT persist or prune (pruning would delete
  // the very completed record we are gating against).
  if (!flags.force) {
    const prior = findCompletedRunWithDigest(HOME, cfg.workspaceId, repositoryRoot, built.run.planDigest, runId);
    if (prior) {
      releaseOnboardingLock(HOME, cfg.workspaceId, runId);
      const persisted =
        (prior.state.scouts.documentation.candidateCount ?? 0) + (prior.state.scouts.history.candidateCount ?? 0);
      if (flags.json) {
        console.log(
          JSON.stringify(
            {
              gated: true,
              reason: "unchanged_repository",
              planDigest: built.run.planDigest,
              priorRunId: prior.run.runId,
              priorCompletedAt: prior.state.updatedAt,
              candidatesPersisted: persisted,
              workspaceId: cfg.workspaceId,
              repositoryRoot,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      const plural = persisted === 1 ? "" : "s";
      console.log(
        [
          `Repository unchanged since onboarding run ${prior.run.runId} (plan digest ${built.run.planDigest.slice(0, 12)}).`,
          `That run persisted ${persisted} candidate${plural} born PENDING; review them in the console at ${getConsoleUrl(cfg)} (the "Needs Review" tab).`,
          `Nothing new to onboard. Re-run with \`--force\` to onboard this repository again.`,
        ].join("\n"),
      );
      return 0;
    }
  }

  // Not gated (or --force): commit the built plan to disk and prune this repo's stale runs.
  let persistedPlan;
  try {
    persistedPlan = persistPlan(HOME, built.run);
  } catch (e) {
    releaseOnboardingLock(HOME, cfg.workspaceId, runId);
    console.error((e as Error).message);
    return 2;
  }
  const run = built.run;
  const historyTruncated = built.historyTruncated;
  const { recordPath, pruned } = persistedPlan;

  if (flags.json) {
    // The agent contract: the run record plus the truncation signal. The agent reads
    // documentationTargets + historyEvidence to dispatch its scouts and passes runId
    // back to `enrich ingest`. It is the SAME record persisted on disk (no divergence).
    console.log(JSON.stringify({ ...run, historyTruncated }, null, 2));
    return 0;
  }

  const lines = [
    `Onboarding enrichment plan ready.`,
    ``,
    `  runId:            ${run.runId}`,
    `  workspace:        ${run.workspaceId}`,
    `  repository:       ${run.repositoryRoot}`,
    `  budget:           ${run.limits.budgetMs} ms (deadline ${run.deadlineAt})`,
    `  doc targets:      ${run.documentationTargets.length}`,
    `  history commits:  ${run.historyEvidence.length}${historyTruncated ? " (truncated)" : ""}`,
    `  max candidates:   ${run.limits.maxCandidatesTotal}`,
    `  record:           ${recordPath}${pruned ? ` (pruned ${pruned} stale)` : ""}`,
    ``,
    `Run \`mla enrich plan --json\` for the machine plan, then dispatch scouts and`,
    `report with \`mla enrich ingest --run-id ${run.runId}\`.`,
  ];
  console.log(lines.join("\n"));
  return 0;
}

interface IngestFlags {
  runId?: string;
  resultsFile?: string;
  json: boolean;
  workspace?: string;
}

export function parseIngestArgs(argv: string[]): IngestFlags {
  const flags: IngestFlags = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--run-id") {
      flags.runId = argv[++i];
      if (!flags.runId) throw new Error("--run-id requires a value");
    } else if (a === "--results-file") {
      flags.resultsFile = argv[++i];
      if (!flags.resultsFile) throw new Error("--results-file requires a path");
    } else if (a === "--workspace") {
      flags.workspace = argv[++i];
      if (!flags.workspace) throw new Error("--workspace requires a workspace id");
    } else throw new Error(`Unknown flag for \`mla enrich ingest\`: ${a}`);
  }
  if (!flags.runId) throw new Error("--run-id is required (the id printed by `mla enrich plan`)");
  return flags;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// Normalize the agent's payload into the results array. Accept three shapes for
// ergonomics: a bare array, `{results:[...]}`, or the full `{runId, results}` request.
// When a runId is present in the body it MUST match --run-id (defense against a stale
// paste pointing the wrong run's results at this record).
export function extractResults(raw: string, runId: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`scout results are not valid JSON: ${(e as Error).message}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (obj.runId !== undefined && obj.runId !== runId) {
      throw new Error(`results runId (${String(obj.runId)}) does not match --run-id (${runId})`);
    }
    if (Array.isArray(obj.results)) return obj.results;
  }
  throw new Error("scout results must be a JSON array, or an object with a `results` array");
}

export function renderIngestSummary(
  outcomes: ScoutIngestOutcome[],
  status: string | undefined,
  reviewUrl: string,
): string {
  const lines = [`Onboarding ingest complete (state: ${status ?? "unknown"}).`, ``];
  let totalPersisted = 0;
  let totalDeduped = 0;
  for (const o of outcomes) {
    totalPersisted += o.persisted;
    totalDeduped += o.deduped;
    // Only break the count out when the repo was already (partly) onboarded: a clean first run
    // (deduped 0) keeps the plain "N persisted" line. When dedup happened, the split is the
    // idempotency signal: "M new, K already present".
    const newCount = o.persisted - o.deduped;
    let breakdown = "";
    if (o.deduped > 0) {
      breakdown = newCount > 0 ? ` (${newCount} new, ${o.deduped} already present)` : ` (all ${o.deduped} already present)`;
    }
    lines.push(`  ${o.scout}: ${o.accepted} accepted, ${o.rejected} rejected, ${o.persisted} persisted${breakdown} (received ${o.received})`);
    for (const e of o.errors) {
      const where = e.index >= 0 ? `candidate ${e.index}` : "scout";
      lines.push(`      - ${where}: ${e.code} (${e.message})`);
    }
  }

  // Review handoff: candidates land born PENDING in the governed KB, so a human reviews
  // them next. They are KB documents, not relationship candidates, so `mla review` (which
  // serves the control review-packet of relationship/agent-review items) cannot show them.
  // The review surface is the console KB index, which opens on its "Needs Review" tab by
  // default. Point the operator there; nothing is accepted until they act.
  if (totalPersisted > 0) {
    const totalNew = totalPersisted - totalDeduped;
    const plural = totalPersisted === 1 ? "" : "s";
    lines.push(``);
    if (totalNew === 0) {
      // Pure dedup: a re-run added nothing. This is onboarding proving it is idempotent.
      lines.push(
        `Next: all ${totalPersisted} candidate${plural} were already present from a prior onboarding run ` +
          `(nothing new to add). Review them in the console at ${reviewUrl} (the "Needs Review" tab).`,
      );
    } else if (totalDeduped > 0) {
      lines.push(
        `Next: review ${totalPersisted} candidate${plural} born PENDING (${totalNew} new, ${totalDeduped} already present) ` +
          `in the console at ${reviewUrl} (the "Needs Review" tab). Nothing is accepted until you say so.`,
      );
    } else {
      lines.push(
        `Next: review ${totalPersisted} candidate${plural} born PENDING in the console at ` +
          `${reviewUrl} (the "Needs Review" tab). Nothing is accepted until you say so.`,
      );
    }
  }
  return lines.join("\n");
}

async function runEnrichIngest(argv: string[]): Promise<number> {
  let flags: IngestFlags;
  try {
    flags = parseIngestArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let repositoryRoot: string;
  try {
    const ctx = resolveWorkspaceContext();
    repositoryRoot = resolveRepositoryRoot(ctx.markerDir);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // Source the scout results: an explicit file, or piped stdin. Refuse to hang on a TTY.
  let rawResults: string;
  try {
    if (flags.resultsFile) {
      rawResults = readFileSync(flags.resultsFile, "utf8");
    } else if (!process.stdin.isTTY) {
      rawResults = await readStdin();
    } else {
      console.error("provide --results-file <path> or pipe the scout results JSON to stdin");
      return 2;
    }
  } catch (e) {
    console.error(`could not read scout results: ${(e as Error).message}`);
    return 2;
  }

  let results: unknown[];
  try {
    results = extractResults(rawResults, flags.runId!);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // The real kb-add persister: born-PENDING governed notes. provenance is advisory (the
  // server derives the recorded value from the envelope). The server returns one receipt per
  // document IN INPUT ORDER (kb_add.py iterates body.documents), so we zip each receipt's real
  // outcome back to the doc we sent. ingest turns that into an honest new-vs-already-present
  // tally; an "ingested" outcome minted a revision, "noop_unchanged" deduped against the
  // governed head, "failed" is a per-document failure the 200 still carries.
  const persist: Persister = async (docs) => {
    const body = {
      workspaceId: cfg.workspaceId,
      actor: cfg.actorUserId,
      documents: docs.map((d) => ({ relPath: d.relPath, content: d.content })),
      provenance: "agent_distilled",
      profile: "markdown_atomic_v1",
      mode: "file",
    };
    const res = await intelPost<{ receipts: KbAddReceipt[] }>(
      cfg,
      "/internal/v1/kb/add",
      body,
      ingestTimeoutMs(docs.length),
    );
    const receipts = res.receipts ?? [];
    return {
      docs: docs.map((d, i) => ({
        relPath: d.relPath,
        // A missing receipt (short response) reads as "failed" here; ingest's length guard
        // catches the mismatch first and treats the whole POST as failed, so this is defensive.
        outcome: receipts[i]?.outcome ?? "failed",
      })),
    };
  };

  const res = await ingestRun({
    env: { home: HOME, workspaceId: cfg.workspaceId, repositoryRoot },
    request: { protocolVersion: PROTOCOL_VERSION, runId: flags.runId, results },
    persist,
    now: new Date().toISOString(),
  });

  // Release the active-run lock once the run is fully complete so a new run can start at
  // once. A partial run stays locked (it may resume) until its lock self-expires. Keyed by
  // runId, so this only ever frees THIS run's lock, never a successor that reclaimed it.
  if (res.ok && res.runId && res.state?.status === "complete") {
    releaseOnboardingLock(HOME, cfg.workspaceId, res.runId);
  }

  if (!res.ok) {
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else console.error(`enrich ingest rejected: ${res.rejectionReason}`);
    return 2;
  }

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(renderIngestSummary(res.outcomes, res.state?.status, `${getConsoleUrl(cfg)}/kb`));
  }

  // 1 when a scout needs attention (infra failure or a malformed envelope worth a retry);
  // 0 otherwise. A scout that merely "timed_out" is rerunnable state, not an error here.
  const needsAttention = (res.state ? Object.values(res.state.scouts) : []).some(
    (s) => s.status === "persistence_failed" || s.status === "malformed",
  );
  return needsAttention ? 1 : 0;
}

interface BriefFlags {
  runId?: string;
  role?: ScoutName;
  workspace?: string;
}

export function parseBriefArgs(argv: string[]): BriefFlags {
  const flags: BriefFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-id") {
      flags.runId = argv[++i];
      if (!flags.runId) throw new Error("--run-id requires a value");
    } else if (a === "--role") {
      const v = argv[++i];
      if (!v) throw new Error("--role requires a value");
      if (!(SCOUT_NAMES as readonly string[]).includes(v)) {
        throw new Error(`--role must be one of: ${SCOUT_NAMES.join(", ")}`);
      }
      flags.role = v as ScoutName;
    } else if (a === "--workspace") {
      flags.workspace = argv[++i];
      if (!flags.workspace) throw new Error("--workspace requires a workspace id");
    } else throw new Error(`Unknown flag for \`mla enrich brief\`: ${a}`);
  }
  if (!flags.runId) throw new Error("--run-id is required (the id printed by `mla enrich plan`)");
  if (!flags.role) throw new Error(`--role is required (one of: ${SCOUT_NAMES.join(", ")})`);
  return flags;
}

// Print one scout's run-specific brief. Pure read of the persisted run record plus
// buildScoutPrompt; no git, no network, no mutation. `/mla onboard` calls this to get
// the exact prompt it hands each subagent, so the brief logic stays in tested TS and
// every scout input matches what `enrich ingest` re-validates against the same record.
function runEnrichBrief(argv: string[]): number {
  let flags: BriefFlags;
  try {
    flags = parseBriefArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const run = loadRunRecord(HOME, cfg.workspaceId, flags.runId!);
  if (!run) {
    console.error(
      `no onboarding run record for ${flags.runId} in workspace ${cfg.workspaceId}. ` +
        "Run `mla enrich plan` first, from the same workspace.",
    );
    return 2;
  }

  console.log(buildScoutPrompt(run, flags.role!));
  return 0;
}

// --- enrich materialize: the accepted-durable-rule -> managed file bridge ----------
//
// The local-first ACCEPT half of onboarding (memo Phase 1, line 535: "accepted DURABLE
// rules materialize into the managed file; accepted decisions enter governed knowledge
// and do NOT silently become rules"). `enrich ingest` parks candidates born PENDING in
// the governed KB; the human governs which ones are durable repository policy. For the
// ones the human accepts, THIS command materializes them into the mla-managed local file,
// `.meetless/rules.md`. The backend rule store is the source of truth, and the scanner's
// prompt injection is served from the backend rule bundle, not from this file directly.
//
// It is deliberately a LOCAL operation: the managed file is a git-tracked file in the
// repo, so no server, workspace id, or auth is needed to materialize it. mla never commits
// or pushes (the memo forbids it); it prints MATERIALIZE_SHARE_MESSAGE so sharing stays an
// explicit human git step. Decisions/deprecations are reported as skipped, never written
// (INV-AUTH-2). This is NOT the CE0 `mla rules` deny engine; it is the durable
// managed-conventions file.
interface MaterializeFlags {
  acceptedFile?: string;
  json: boolean;
  dryRun: boolean;
}

export function parseMaterializeArgs(argv: string[]): MaterializeFlags {
  const flags: MaterializeFlags = { json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--accepted-file") {
      flags.acceptedFile = argv[++i];
      if (!flags.acceptedFile) throw new Error("--accepted-file requires a path");
    } else throw new Error(`Unknown flag for \`mla enrich materialize\`: ${a}`);
  }
  return flags;
}

// Normalize the accepted payload into the candidate array. Accept a bare array, or an
// object with an `accepted` array (the natural name for "the ones the human accepted"),
// or a `candidates` array (so an onboard scout-result candidate list pastes through).
export function extractAcceptedCandidates(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`accepted candidates are not valid JSON: ${(e as Error).message}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.accepted)) return obj.accepted;
    if (Array.isArray(obj.candidates)) return obj.candidates;
  }
  throw new Error(
    "accepted candidates must be a JSON array, or an object with an `accepted` (or `candidates`) array",
  );
}

// Validate every accepted candidate with the SAME shape validator ingest uses, so a
// candidate that survives ingest survives materialize unchanged. All-or-nothing by
// design: a single malformed candidate fails the whole batch (exit 2) rather than being
// silently dropped, so the operator fixes the input instead of trusting a partial write.
export type AcceptedValidation =
  | { ok: true; candidates: EnrichmentCandidate[] }
  | { ok: false; errors: CandidateValidationError[] };

export function validateAcceptedCandidates(raw: unknown[]): AcceptedValidation {
  const candidates: EnrichmentCandidate[] = [];
  const errors: CandidateValidationError[] = [];
  raw.forEach((r, i) => {
    const res = validateCandidateShape(r, i);
    if (res.ok) candidates.push(res.candidate);
    else errors.push(...res.errors);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, candidates };
}

// Human-readable summary. Pure (no fs) and exported so its wording is pinned by a test.
// `dryRun` flips the verb from "materialized" to "would materialize" and suppresses the
// share line (nothing was written, so there is nothing local to share yet).
export function renderMaterializeSummary(
  result: MaterializeResult,
  relPath: string,
  dryRun: boolean,
): string {
  const lines: string[] = [];
  const added = [...result.materialized].sort((a, b) => a.statement.localeCompare(b.statement));
  const skipped = [...result.skipped].sort((a, b) => a.statement.localeCompare(b.statement));

  if (added.length > 0) {
    const verb = dryRun ? "Would materialize" : "Materialized";
    lines.push(`${verb} ${added.length} durable rule${added.length === 1 ? "" : "s"} into ${relPath}:`);
    for (const r of added) lines.push(`  + ${r.statement}`);
  } else {
    lines.push(`No durable rules to materialize (${relPath} unchanged).`);
  }

  if (skipped.length > 0) {
    lines.push("");
    lines.push(`Skipped ${skipped.length} non-rule candidate${skipped.length === 1 ? "" : "s"}:`);
    for (const s of skipped) {
      const why = s.reason === "empty_statement" ? "empty statement" : `${s.kind} (governed knowledge, not a rule)`;
      lines.push(`  - ${s.statement || "(empty)"}: ${why}`);
    }
  }

  if (result.changed && !dryRun) {
    lines.push("");
    lines.push(MATERIALIZE_SHARE_MESSAGE);
  }
  return lines.join("\n");
}

function readManagedFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return ""; // missing file is the empty starting point, not an error
  }
}

// Atomic write: render to a sibling temp file then rename, so a crash mid-write never
// leaves a half-written rules file (the scanner reads it directly from disk every turn).
function writeManagedFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

async function runEnrichMaterialize(argv: string[]): Promise<number> {
  let flags: MaterializeFlags;
  try {
    flags = parseMaterializeArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // Local-only: the managed file lives at the git root. No workspace id, no auth.
  let repositoryRoot: string;
  try {
    repositoryRoot = resolveRepositoryRoot(process.cwd());
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  let raw: string;
  try {
    if (flags.acceptedFile) {
      raw = readFileSync(flags.acceptedFile, "utf8");
    } else if (!process.stdin.isTTY) {
      raw = await readStdin();
    } else {
      console.error("provide --accepted-file <path> or pipe the accepted candidates JSON to stdin");
      return 2;
    }
  } catch (e) {
    console.error(`could not read accepted candidates: ${(e as Error).message}`);
    return 2;
  }

  let rawCandidates: unknown[];
  try {
    rawCandidates = extractAcceptedCandidates(raw);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  const validation = validateAcceptedCandidates(rawCandidates);
  if (!validation.ok) {
    console.error(`refusing to materialize: ${validation.errors.length} invalid candidate(s).`);
    for (const e of validation.errors) {
      console.error(`  - candidate ${e.index}: ${e.code}${e.field ? ` (${e.field})` : ""} ${e.message}`);
    }
    return 2;
  }

  const managedPath = join(repositoryRoot, MANAGED_RULES_PATH);
  const existing = readManagedFile(managedPath);
  const result = materializeRules(existing, validation.candidates);

  if (result.changed && !flags.dryRun) {
    writeManagedFile(managedPath, result.text);
  }

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          path: MANAGED_RULES_PATH,
          changed: result.changed,
          wrote: result.changed && !flags.dryRun,
          dryRun: flags.dryRun,
          materialized: result.materialized.map((r) => ({ id: r.id, statement: r.statement, strength: r.strength })),
          skipped: result.skipped,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderMaterializeSummary(result, MANAGED_RULES_PATH, flags.dryRun));
  }
  return 0;
}

export async function runEnrich(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return 0;
  }
  switch (sub) {
    case "plan":
      return runEnrichPlan(rest);
    case "brief":
      return runEnrichBrief(rest);
    case "ingest":
      return runEnrichIngest(rest);
    case "materialize":
      return runEnrichMaterialize(rest);
    default:
      console.error(`unknown \`mla enrich\` subcommand: ${sub}\n`);
      console.error(USAGE);
      return 2;
  }
}
