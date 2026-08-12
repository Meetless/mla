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
import {
  HOME,
  consoleDeepLink,
  loadWorkspaceConfig,
  readKbConfig,
  type KbCliConfig,
  type WorkspaceCliConfig,
} from "../lib/config";
import { resolveWorkspaceContext } from "../lib/workspace";
import { intelGet, intelPost } from "../lib/http";
import { INGEST_TIMEOUT_MS } from "../lib/intel-ingest-budget";
import type { KbAddReceipt } from "../lib/render";
import { buildPlan, persistPlan, loadRunRecord } from "../lib/enrichment/plan";
import { fetchOnboardingStatus } from "../lib/enrichment/onboarding-status-client";
import {
  acquireOnboardingLock,
  releaseOnboardingLock,
  onboardingLockPath,
  ONBOARDING_LOCK_GRACE_MS,
} from "../lib/enrichment/lock";
import {
  ingestRun,
  findCompletedRunWithDigest,
  loadCandidatesSidecar,
  upsertCandidatesSidecar,
  type Persister,
} from "../lib/enrichment/ingest";
import { buildScoutPrompt } from "../lib/enrichment/scout-brief";
import {
  PROTOCOL_VERSION,
  DEFAULT_BUDGET_MS,
  DISPATCH_SCOUT_NAMES,
  assertDispatchableRole,
  validateCandidateShape,
  assertNever,
  FINDING_RESOLUTIONS,
  RECONCILIATION_FINDING_KIND,
  findingToRuleCandidate,
  isFindingResolution,
  FINDING_PROPOSED_RULE_KIND,
  NO_FILE_OPERATION_FINDINGS,
  type FindingResolution,
  type ProposedRuleKind,
  type FindingResolutionRecord,
  type ScoutName,
  type ScoutIngestOutcome,
  type EnrichmentCandidate,
  type OnboardingCandidateRecord,
  type CandidateValidationError,
  type OnboardingRun,
} from "../lib/enrichment/protocol";
import { MANAGED_RULES_PATH, type ManagedRule } from "../lib/scanner/managed-rules";
import {
  MATERIALIZE_SHARE_MESSAGE,
  isDurableRuleKind,
  materializeRules,
  type MaterializeResult,
} from "../lib/enrichment/materialize-rules";
import { confirm as defaultConfirm, isInteractive as defaultIsInteractive } from "../lib/prompt";
import {
  emitEnvelope,
  failInMode,
  getMachineCommand,
  isMachineMode,
  successEnvelope,
  type DecisionOption,
  type DecisionRequest,
} from "../lib/machine-output";
import { noteHandledFailure } from "../lib/analytics/handled-failure";
import { emitOnboardingFinding } from "../lib/analytics/onboarding-finding";
import { resolveBackendOperator, type BackendOperator } from "../lib/rules/backend-operator";
import {
  alreadyMintedHashes,
  managedRuleHash,
  mintManagedRule,
} from "../lib/rules/mint-managed-rule";
import { resolveActiveRuntimeScopeId } from "../lib/rules/runtime-scope";
import { type RuleAuthorityScope, type RuleClientHttp } from "../lib/rules/control-rule-client";
// Delivery is the seam's job, not accept's: every verb that mutates the rule authority carries the
// change down to the caches an agent reads. See commands/rule-delivery.ts for the three-hop chain.
import { refreshRuleDelivery } from "./rule-delivery";
import { terminalSafe } from "../lib/terminal-safe";

const USAGE = `mla enrich: agent-orchestrated onboarding enrichment.

  mla enrich plan [--json] [--budget-ms <n>] [--workspace <id>] [--force]
      Scan this repository into an immutable run record and print the plan the
      agent reads to dispatch its read-only scouts. --json prints the machine
      plan (the agent contract); without it, a human summary. The runId in the
      output is what you pass back to \`enrich ingest\`. If the repository is
      unchanged since a completed onboarding run (same plan digest), the command
      short-circuits to a no-op (\`gated\` in --json) so a re-run adds no duplicate
      candidates; --force overrides and onboards again. --force also takes the
      active-run lock from an abandoned run (one whose agent crashed or was
      interrupted), which otherwise blocks a re-run until it expires.

  mla enrich brief --run-id <id> --role <${DISPATCH_SCOUT_NAMES.join("|")}> [--workspace <id>]
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

  mla enrich materialize [--accepted-file <path>] [--team | --personal] [--yes]
                         [--dry-run] [--json] [--workspace <id>]
      Materialize accepted DURABLE rules (constraint, convention, boundary) from a JSON
      payload. MATERIALIZING IS MINTING: each durable rule is minted into the backend rule
      bundle, the authority \`mla scan\` injects from, and only then is .meetless/rules.md
      re-rendered as the local read projection of that. A rule that only landed in the file
      would be a rule no agent ever sees. Minting reaches the authority, but nothing on the
      hot path fetches it, so materialize then refreshes the two local caches an agent reads
      (the rule bundle \`scan\` reads, and the scan cache the prompt hook reads); the rules
      apply from your very next turn, with no \`mla scan\` in between.
      Reads the accepted candidates as JSON from --accepted-file, or from stdin (a bare
      array, or an object with an \`accepted\` array). Decisions and deprecations are governed
      knowledge, reported as skipped, never minted.
      Minting requires an authenticated human (\`mla login\`) and a bound workspace. The default
      plane is PERSONAL (enforces for you alone); --team enforces workspace-wide and confirms
      first (interactive Y/n, or --yes non-interactively). Re-running is safe: a rule whose
      payload is already live is skipped, never minted twice. A mint failure writes nothing.
      --dry-run previews without minting or writing. Exit: 0 done (or nothing to do), 1 mint
      refused/failed, 2 bad input.

  mla enrich accept --run-id <id> [--all | --only <id-prefixes>] [--team | --personal] [--yes]
                    [--dry-run] [--json] [--workspace <id>]
      Accept the durable rules an onboarding run found, read from the run's candidates sidecar
      (written by \`enrich ingest\`). ACCEPTANCE IS THE MINT: each accepted rule is minted into
      the backend rule bundle, the authority \`mla scan\` injects from, and .meetless/rules.md is
      re-rendered as the local read projection of that. A rule that only landed in the file
      would be a rule no agent ever sees.
      ACCEPTANCE IS ALSO THE DELIVERY: minting reaches the authority, but nothing on the hot
      path fetches it, so accept then refreshes the two local caches an agent actually reads
      (the rule bundle \`scan\` reads, and the scan cache the prompt hook reads). Accepted rules
      apply from your very next turn, with no \`mla scan\` in between. Re-run accept to heal a
      cache that has gone stale.
      With neither --all nor --only it is a read-only review: it prints the durable rules plus
      the governed-knowledge candidates and mints/writes nothing, so a human sees the candidates
      first. --all accepts every durable rule this run found; --only accepts just the candidates
      whose id starts with one of the comma-separated prefixes (>= 6 hex chars each, fail-closed
      on no/ambiguous match). Decisions and deprecations are governed knowledge, reported as
      skipped, never minted.
      Minting requires an authenticated human (\`mla login\`) and a bound workspace. The default
      plane is PERSONAL (enforces for you alone); --team enforces workspace-wide and confirms
      first (interactive Y/n, or --yes non-interactively). Re-running is safe: a rule whose
      payload is already live is skipped, never minted twice. A mint failure writes nothing.
      --dry-run previews without minting or writing. Exit: 0 done (or nothing to do), 1 mint
      refused/failed, 2 bad input (unknown run, bad/ambiguous prefix).

  mla enrich resolve --run-id <id> [--finding <id-prefix> --as <code_diverged|doc_stale|carve_out>]
                     [--team | --personal] [--yes] [--dry-run] [--json] [--workspace <id>]
      Answer a doc/code finding: a place where a document says one thing and a commit in this
      repository's history did another, with the document's sentence quoted verbatim out of the
      file and the commit's own changed-file record as proof. A finding is a QUESTION, which is
      why it never appears in \`enrich accept\`'s durable list: nothing about it is decided until
      a human says which side was right.
      With no --finding it is a read-only review: it prints the open findings and closes nothing.
      --finding names one (>= 6 hex chars of its id, fail-closed on no/ambiguous match) and --as
      answers it. The three answers:
        code_diverged  the document was right and the change broke it. YOUR SELECTION IS THE
                       APPROVAL: the quoted sentence is minted as a rule through the same path
                       \`enrich accept\` mints through, and there is no second prompt.
        doc_stale      the change was right and the document is out of date. Nothing is minted;
                       the finding closes. Update the document yourself.
        carve_out      both were right and this was a deliberate exception. Nothing is minted.
      Minting requires an authenticated human (\`mla login\`). The default plane is PERSONAL;
      --team enforces workspace-wide and confirms first (interactive Y/n, or --yes). --dry-run
      previews without minting, writing, or closing. Answering the same way twice is a no-op;
      answering a DIFFERENT way is refused rather than silently overwritten.
      Exit: 0 done, 1 mint refused/failed, 2 bad input (unknown run, bad/ambiguous prefix,
      already resolved another way).`;

// The git toplevel is the enrichment repository root: `git ls-files` / `git log` must
// run from it so the paths the scouts cite are repo-root-relative and the realpath
// containment check has the right base. Throws a clean error outside a git repo.
//
// Resolve it from where the HUMAN IS STANDING (process.cwd()), never from the activation
// marker's directory. The marker is the WORKSPACE scope, and it does not have to be a git
// repo: activating an umbrella folder that holds several sibling repos (the meetless tree
// is exactly this: `meetless/`, `intel/`, `notes/`, `gtm/` under one marker) is a supported
// binding, and it is the whole point of one workspace spanning repos. Starting the git walk
// at the marker made `enrich plan` and `enrich brief` hard-fail there with "not a git
// repository" while `enrich accept`, which already started from cwd, worked fine: the same
// command family answered the same question two different ways. Marker in a repo SUBDIR is
// unaffected: git walks up from cwd to the same toplevel either way.
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

// --- Workspace-grain idempotency gate (§4A) --------------------------------------
//
// The local run record only proves onboarding happened on THIS machine at THIS path;
// it cannot stop a teammate's clone (or the same user on a second clone / re-clone at a
// different path) from re-onboarding the SAME git HEAD and dumping LLM-drifted near-dup
// PENDING candidates into the shared KB. The gate is therefore an OR over two sources:
// the local record (fast, offline, path-precise) and the workspace marker keyed on the
// cross-machine git HEAD. `--force` bypasses both.

export interface WorkspaceOnboardStatus {
  onboarded: boolean;
  completedAt?: string;
  candidatesPersisted?: number;
}

export type GateDecision = { gated: false } | { gated: true; by: "local" | "workspace" };

// Pure precedence: --force wins (never gated); else the local record wins over the
// workspace marker (it carries the precise same-path candidate count and needs no
// network). Isolated so the precedence table is unit-tested without touching git,
// the filesystem, or intel.
export function decideOnboardingGate(input: {
  force: boolean;
  localHit: boolean;
  workspaceOnboarded: boolean;
}): GateDecision {
  if (input.force) return { gated: false };
  if (input.localHit) return { gated: true, by: "local" };
  if (input.workspaceOnboarded) return { gated: true, by: "workspace" };
  return { gated: false };
}

// Consult the workspace marker for this git HEAD. FAIL-OPEN is the whole contract: a
// missing headCommit (no usable git), an unreachable intel, a 5xx, or an un-authed CLI
// must NEVER block onboarding, so every failure resolves to `onboarded:false` and the
// command proceeds (the local gate still applies). A true marker is the only thing that
// can gate here.
export async function checkWorkspaceOnboarded(
  cfg: KbCliConfig,
  headCommit: string | null,
): Promise<WorkspaceOnboardStatus> {
  if (!headCommit) return { onboarded: false };
  const res = await fetchOnboardingStatus(cfg, { headCommit });
  // Fail OPEN at this call site: the client's `null` (offline, 5xx, un-authed) collapses
  // to false here, so a network hiccup never blocks onboarding. `activate` reads the same
  // client and collapses the other way (unknown -> stay silent), which is why the tri-state
  // lives in the client and the policy lives in each caller.
  return {
    onboarded: res.onboarded === true,
    completedAt: res.completedAt,
    candidatesPersisted: res.candidatesPersisted,
  };
}

// Build the best-effort marker request written after a successful ingest (§4C). Returns
// null when the run has no git HEAD to key on (nothing to record cross-machine). Pure so
// the payload (candidate sum, carried root/digest) is pinned by a test without a network.
export function buildOnboardingMarkerRequest(
  run: OnboardingRun | null,
  outcomes: ScoutIngestOutcome[],
  workspaceId: string,
): { workspaceId: string; headCommit: string; rootCommit: string | null; planDigest: string | null; candidatesPersisted: number } | null {
  const headCommit = run?.headCommit ?? null;
  if (!headCommit) return null;
  const candidatesPersisted = outcomes.reduce((n, o) => n + o.persisted, 0);
  return {
    workspaceId,
    headCommit,
    rootCommit: run?.rootCommit ?? null,
    planDigest: run?.planDigest ?? null,
    candidatesPersisted,
  };
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
  // In machine mode the capability gate already resolved and recorded this
  // operation; read it back so the envelope `command` can never drift from the
  // operation the gate armed. Fallback is defensive (the gate guarantees it set).
  const command = getMachineCommand() ?? "enrich.plan";

  let flags: PlanFlags;
  try {
    flags = parsePlanArgs(argv);
  } catch (e) {
    return failInMode(command, "usage_error", (e as Error).message, 2);
  }

  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    return failInMode(command, "config_error", (e as Error).message, 2);
  }

  let repositoryRoot: string;
  try {
    // Call for its side effect: it throws unless this folder is activated. The marker it
    // finds is the workspace scope, NOT the enrichment target; see resolveRepositoryRoot.
    resolveWorkspaceContext();
    repositoryRoot = resolveRepositoryRoot(process.cwd());
  } catch (e) {
    return failInMode(command, "not_activated", (e as Error).message, 2);
  }

  const budget = resolveBudgetMs(flags.budgetMs, process.env.MLA_ENRICH_BUDGET_MS);
  // Informational stderr is silent in machine mode: the Bash tool merges stdout
  // and stderr, so a progress line would corrupt the agent's single-envelope parse.
  if (budget.warning && !isMachineMode()) console.error(budget.warning);

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
    force: flags.force,
  });
  if (!lock.ok) {
    const held = lock.held;
    return failInMode(
      command,
      "run_locked",
      held
        ? `An onboarding run is already active for this workspace (run ${held.runId}, started ${held.createdAt}; the lock frees at ${held.expiresAt}). Wait for it to finish, or re-run with \`--force\` if that run was abandoned.`
        : `An onboarding-run lock exists for this workspace but could not be read; refusing to start a second run. If no run is active, re-run with \`--force\`, or remove ${onboardingLockPath(HOME, cfg.workspaceId)} and retry.`,
      2,
    );
  }
  // Displacing a run that had not expired is a real consequence of --force; say it out loud.
  // Silent in machine mode (informational stderr would corrupt the single-envelope parse).
  if (lock.reclaimedLive && !isMachineMode()) {
    console.error(
      `--force: took the onboarding lock from run ${lock.reclaimedLive.runId} (started ${lock.reclaimedLive.createdAt}, not yet expired). This run supersedes it.`,
    );
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
    return failInMode(command, "runtime_error", (e as Error).message, 2);
  }

  // Idempotency gate (verdict: re-running onboarding on an unchanged repo must add nothing).
  // Re-onboarding only spawns near-duplicate PENDING candidates (LLM scout output is
  // non-deterministic, so candidateIds drift and server dedup never fires). We gate on an OR
  // of two sources: the LOCAL record (this machine, this path, same plan digest) and the
  // WORKSPACE marker keyed on the cross-machine git HEAD (a teammate's clone, or this user on
  // a second clone). Short-circuit to a no-op unless --force. Release the lock first: a no-op
  // holds no run, and we must NOT persist or prune (pruning would delete the very completed
  // local record we are gating against).
  const localPrior = flags.force
    ? null
    : findCompletedRunWithDigest(HOME, cfg.workspaceId, repositoryRoot, built.run.planDigest, runId);
  // OR short-circuit: only pay the network round-trip when the local gate missed (and never
  // under --force). checkWorkspaceOnboarded is fail-open, so an unreachable intel is a miss.
  const workspace: WorkspaceOnboardStatus =
    flags.force || localPrior ? { onboarded: false } : await checkWorkspaceOnboarded(cfg, built.run.headCommit ?? null);
  const decision = decideOnboardingGate({
    force: flags.force,
    localHit: !!localPrior,
    workspaceOnboarded: workspace.onboarded,
  });

  if (decision.gated) {
    releaseOnboardingLock(HOME, cfg.workspaceId, runId);

    if (decision.by === "local" && localPrior) {
      const persisted =
        (localPrior.state.scouts.documentation.candidateCount ?? 0) + (localPrior.state.scouts.history.candidateCount ?? 0);
      // The machine payload is byte-identical to the --json payload, wrapped in the
      // envelope's `result`. Machine mode is checked first so it wins over --json.
      const gatedPayload = {
        gated: true,
        gatedBy: "local",
        reason: "unchanged_repository",
        planDigest: built.run.planDigest,
        priorRunId: localPrior.run.runId,
        priorCompletedAt: localPrior.state.updatedAt,
        candidatesPersisted: persisted,
        workspaceId: cfg.workspaceId,
        repositoryRoot,
      };
      if (isMachineMode()) return emitEnvelope(successEnvelope(command, gatedPayload), 0);
      if (flags.json) {
        console.log(JSON.stringify(gatedPayload, null, 2));
        return 0;
      }
      const plural = persisted === 1 ? "" : "s";
      console.log(
        [
          `Repository unchanged since onboarding run ${localPrior.run.runId} (plan digest ${built.run.planDigest.slice(0, 12)}).`,
          `That run persisted ${persisted} candidate${plural} born PENDING; review them in the console at ${consoleDeepLink(cfg, "/")} (the "Needs Review" tab).`,
          `Nothing new to onboard. Re-run with \`--force\` to onboard this repository again.`,
        ].join("\n"),
      );
      return 0;
    }

    // Workspace hit: another clone already onboarded this exact git HEAD in this workspace.
    const head = built.run.headCommit ?? "";
    const persisted = workspace.candidatesPersisted ?? 0;
    const gatedPayload = {
      gated: true,
      gatedBy: "workspace",
      reason: "already_onboarded_in_workspace",
      planDigest: built.run.planDigest,
      headCommit: head,
      completedAt: workspace.completedAt ?? null,
      candidatesPersisted: persisted,
      workspaceId: cfg.workspaceId,
      repositoryRoot,
    };
    if (isMachineMode()) return emitEnvelope(successEnvelope(command, gatedPayload), 0);
    if (flags.json) {
      console.log(JSON.stringify(gatedPayload, null, 2));
      return 0;
    }
    const plural = persisted === 1 ? "" : "s";
    console.log(
      [
        `This repository (HEAD ${head.slice(0, 12)}) was already onboarded in this workspace from another clone.`,
        `That run persisted ${persisted} candidate${plural} born PENDING; review them in the console at ${consoleDeepLink(cfg, "/")} (the "Needs Review" tab).`,
        `Nothing new to onboard. Re-run with \`--force\` to onboard this repository again.`,
      ].join("\n"),
    );
    return 0;
  }

  // Not gated (or --force): commit the built plan to disk and prune this repo's stale runs.
  let persistedPlan;
  try {
    persistedPlan = persistPlan(HOME, built.run);
  } catch (e) {
    releaseOnboardingLock(HOME, cfg.workspaceId, runId);
    return failInMode(command, "runtime_error", (e as Error).message, 2);
  }
  const run = built.run;
  const historyTruncated = built.historyTruncated;
  const { recordPath, pruned } = persistedPlan;

  // The agent contract: the run record plus the truncation signal. The agent reads
  // documentationTargets + historyEvidence to dispatch its scouts and passes runId
  // back to `enrich ingest`. It is the SAME record persisted on disk (no divergence).
  const planPayload = { ...run, historyTruncated };
  if (isMachineMode()) return emitEnvelope(successEnvelope(command, planPayload), 0);
  if (flags.json) {
    console.log(JSON.stringify(planPayload, null, 2));
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

/**
 * What ingest knows about this run's doc/code findings, for the finding-first terminal state.
 *
 * `candidates` is the WHOLE sidecar, not a pre-filtered finding list: the renderer selects and
 * filters, so no caller can hand it a list that quietly omits one. Optional at the call site
 * only because a caller that has no sidecar (a pure unit test of the counts) must not be able to
 * fake "this run examined the code and found nothing", which is a claim about evidence.
 */
export interface IngestFindingsView {
  runId: string;
  candidates: readonly OnboardingCandidateRecord[];
}

// How much of each repository-controlled value a terminal row shows.
//
// Every value these renderers print comes out of the repository: the quote out of a document, the
// paths out of git's name-status, the name out of a commit header, the statement out of whatever
// the mint was handed. On a shared repository the person controlling those bytes is not the
// person reading the row, and the row is the screen where a human signs a rule into their agent's
// authority. So each one goes through `terminalSafe`: it may change what the row SAYS, never what
// the terminal DOES, and never how many lines the report appears to have.
//
// The caps are on the RENDERING only. Nothing truncated here is ever stored: the mint and the
// ancestry proof re-read the quote out of the document, so the sidecar keeps it byte-exact and
// only the screen gets the short version. The protocol accepts a 600-character claim; a terminal
// row is not 600 characters wide, and `terminalSafe` marks the cut so a human is never asked to
// approve a sentence whose remainder they silently never saw.
const DISPLAY_LEN = {
  quote: 240,
  scope: 120,
  path: 160,
  status: 8,
  author: 60,
  statement: 300,
} as const;

// A repository-controlled value printed INSIDE double quotes. `terminalSafe` guarantees the value
// cannot add a line or drive the terminal; it says nothing about the delimiter it lands in, and a
// straight `"` in the document would close the quote early. On one line that still forges layout:
//   CLAUDE.md says: "never edit" then run: mla enrich resolve --run-id attacker"
// reads as a quote that ended and an instruction that did not. Inner quotes become apostrophes so
// the quoted region has exactly one opening and one closing delimiter, both written by us. This is
// display only; the sidecar keeps the byte-exact sentence, because the mint and the ancestry proof
// re-read it out of the document.
function quoted(value: string, maxLen: number): string {
  return `"${terminalSafe(value, maxLen).replace(/"/g, "'")}"`;
}

export function renderIngestSummary(
  outcomes: ScoutIngestOutcome[],
  status: string | undefined,
  reviewUrl: string,
  findings?: IngestFindingsView,
  // The run whose candidates these are, so the last line can be a command the operator can run
  // where they already are. Optional and last so every existing caller is unchanged; without it
  // the handoff degrades to the console-only sentence rather than printing a command with a
  // missing id, which would be worse than no command at all.
  runId?: string,
): string {
  const lines = [`Onboarding ingest complete (state: ${status ?? "unknown"}).`, ``];

  // The finding leads, ahead of every count. It is the one line in this summary that is a
  // QUESTION rather than a tally, and a question printed under twenty numbers is a question
  // nobody answers. Neither side is declared wrong here: the headline states the disagreement
  // and the next line is the command that asks the human which one is right.
  const open = (findings?.candidates ?? []).filter((c) => isFinding(c) && !c.resolution);

  // The zero-result sentence asserts something about EVIDENCE, so it prints only where this run
  // holds that evidence. Three conditions, each able to fail on its own:
  //
  //   ran      the reconciliation scout produced an outcome in THIS ingest. No outcome, no claim:
  //            an examination that never happened cannot report a clean result.
  //   clean    nothing it proposed was refused and its envelope carried no error. A refused claim
  //            is one the CLI could not stand behind, not one that proved false, and printing
  //            "found nothing" over it launders a verification failure into a clean bill.
  //   empty    no OPEN finding survived. The sidecar answers that exactly when there is one; with
  //            no sidecar the answer is only knowable when the scout accepted nothing at all,
  //            because from here an accepted rule and an accepted finding look identical.
  //
  // The last one is why the sentence is NOT gated on the findings view: a run whose scout
  // completed with nothing to report persists nothing, so it writes no sidecar. That is the one
  // run whose zero result is fully proved, and it used to be the one run that said nothing.
  const recon = outcomes.find((o) => o.scout === "reconciliation");
  const provedZero =
    !!recon &&
    recon.rejected === 0 &&
    recon.errors.length === 0 &&
    (findings ? open.length === 0 : recon.accepted === 0);

  if (findings && open.length > 0) {
    lines.push(
      `  ${open.length} finding${open.length === 1 ? "" : "s"}: a document and a commit appear ` +
        `inconsistent, and neither is assumed right.`,
      ``,
    );
    for (const r of open) lines.push(...renderFindingRow(r));
    lines.push(``, `  Answer ${open.length === 1 ? "it" : "them"}:  mla enrich resolve --run-id ${findings.runId}`, ``);
  } else if (provedZero) {
    // Claim ONLY what was examined, on both axes: which evidence (the documents this run planned
    // and the commits it listed, never the repository) and which question (the file operations a
    // porcelain status letter can prove, never "is this codebase consistent"). The sentence is
    // the shared constant so this screen and the resolve review cannot drift into two claims.
    lines.push(`  ${NO_FILE_OPERATION_FINDINGS}`, ``);
  }
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
    // `index` is the 0-based position in the scout's array; a human counting down a list of
    // candidates starts at 1, and printing the raw index sent them to the wrong one. Render the
    // ordinal, and echo the statement that was dropped: a rejected candidate is gone, so this
    // line is the operator's ONLY record of the claim they just lost. Print the excerpt once
    // per candidate, not once per error, so a candidate failing four checks says it once.
    let excerptShownFor = -1;
    for (const e of o.errors) {
      const where = e.index >= 0 ? `candidate ${e.index + 1}` : "scout";
      lines.push(`      - ${where}: ${e.code} (${e.message})`);
      if (e.excerpt && e.index !== excerptShownFor) {
        lines.push(`        dropped: ${quoted(e.excerpt, DISPLAY_LEN.quote)}`);
        excerptShownFor = e.index;
      }
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
        `${totalPersisted} candidate${plural} were already present from a prior onboarding run ` +
          `(nothing new to add). They are on the console KB at ${reviewUrl} (the "Needs Review" tab).`,
      );
    } else if (totalDeduped > 0) {
      lines.push(
        `${totalPersisted} candidate${plural} born PENDING (${totalNew} new, ${totalDeduped} already present). ` +
          `They are on the console KB at ${reviewUrl} (the "Needs Review" tab). Nothing is accepted until you say so.`,
      );
    } else {
      lines.push(
        `${totalPersisted} candidate${plural} born PENDING, on the console KB at ` +
          `${reviewUrl} (the "Needs Review" tab). Nothing is accepted until you say so.`,
      );
    }
    // The LAST line is the next action, and the last line is where a terminal state actually
    // ends. It used to be "review N candidates in the console at <url>": a to-do list handed to
    // an operator standing in a terminal that can already do the job, and a context switch to a
    // different surface at the exact moment the run had just proved its worth.
    //
    // `mla enrich accept --run-id <id>` with neither --all nor --only is READ-ONLY review that
    // prints the durable rules right here. It already existed; nothing new is built, and no
    // second review surface is introduced. The console stays reachable above, it is just no
    // longer the only way through.
    if (runId) {
      lines.push(``, `Next:  mla enrich accept --run-id ${runId}`);
    }
  }
  return lines.join("\n");
}

async function runEnrichIngest(argv: string[]): Promise<number> {
  // The capability gate recorded this operation; read it back for the envelope `command`.
  const command = getMachineCommand() ?? "enrich.ingest";

  let flags: IngestFlags;
  try {
    flags = parseIngestArgs(argv);
  } catch (e) {
    return failInMode(command, "usage_error", (e as Error).message, 2);
  }

  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    return failInMode(command, "config_error", (e as Error).message, 2);
  }

  let repositoryRoot: string;
  try {
    // Call for its side effect: it throws unless this folder is activated. The marker it
    // finds is the workspace scope, NOT the enrichment target; see resolveRepositoryRoot.
    resolveWorkspaceContext();
    repositoryRoot = resolveRepositoryRoot(process.cwd());
  } catch (e) {
    return failInMode(command, "not_activated", (e as Error).message, 2);
  }

  // Source the scout results: an explicit file, or piped stdin. Refuse to hang on a TTY.
  let rawResults: string;
  try {
    if (flags.resultsFile) {
      rawResults = readFileSync(flags.resultsFile, "utf8");
    } else if (!process.stdin.isTTY) {
      rawResults = await readStdin();
    } else {
      return failInMode(
        command,
        "usage_error",
        "provide --results-file <path> or pipe the scout results JSON to stdin",
        2,
      );
    }
  } catch (e) {
    return failInMode(command, "runtime_error", `could not read scout results: ${(e as Error).message}`, 2);
  }

  let results: unknown[];
  try {
    results = extractResults(rawResults, flags.runId!);
  } catch (e) {
    return failInMode(command, "invalid_request", (e as Error).message, 2);
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
      INGEST_TIMEOUT_MS,
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

  // One analytics row per finding that newly landed (design §9). This is the clock for "time
  // to first finding" and the denominator side of the share metrics; without it the §9 list is
  // a set of intentions with no producer. Fail-soft inside the seam: the documents already
  // landed, and a telemetry fault must not change what this command reports or returns.
  for (const findingId of res.newFindingIds ?? []) {
    emitOnboardingFinding(
      { candidateId: findingId },
      {
        workspaceId: cfg.workspaceId,
        sessionId: (process.env.CLAUDE_CODE_SESSION_ID || "").trim() || null,
        nowMs: Date.now(),
      },
    );
  }

  // Release the active-run lock once the run is fully complete so a new run can start at
  // once. A partial run stays locked (it may resume) until its lock self-expires. Keyed by
  // runId, so this only ever frees THIS run's lock, never a successor that reclaimed it.
  if (res.ok && res.runId && res.state?.status === "complete") {
    releaseOnboardingLock(HOME, cfg.workspaceId, res.runId);

    // Best-effort workspace marker (§4C): record that this git HEAD was onboarded in this
    // workspace so a teammate's clone (or this user on another clone) short-circuits the gate
    // instead of dumping near-dup PENDING candidates. NON-FATAL by design: the candidates
    // already landed, so a failed marker only risks one future re-onboard that self-heals on
    // the next successful run. Never changes the exit code. Skipped when there is no git HEAD.
    const markerBody = buildOnboardingMarkerRequest(
      loadRunRecord(HOME, cfg.workspaceId, res.runId),
      res.outcomes,
      cfg.workspaceId,
    );
    if (markerBody) {
      try {
        await intelPost(cfg, "/internal/v1/onboarding/marker", markerBody);
      } catch (e) {
        // Informational stderr, silent in machine mode (it would corrupt the single-envelope parse).
        if (!isMachineMode()) {
          console.error(
            `note: onboarding marker not recorded (${(e as Error).message}); a future re-onboard of this HEAD may re-run.`,
          );
        }
      }
    }
  }

  if (!res.ok) {
    // A rejected request landed nothing (unknown run, digest mismatch, corrupt record): a real failure.
    const msg = `enrich ingest rejected: ${res.rejectionReason}`;
    if (isMachineMode()) return failInMode(command, "ingest_rejected", msg, 2);
    if (flags.json) console.log(JSON.stringify(res, null, 2));
    else console.error(msg);
    return 2;
  }

  // res.ok: the candidates landed. In machine mode the whole run result IS the envelope; the
  // agent reads per-scout status from res.state.scouts, so the human "needs attention" exit-1
  // hint (a TTY affordance) does not apply and the operation succeeded (exit 0).
  if (isMachineMode()) return emitEnvelope(successEnvelope(command, res), 0);

  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    // Read the sidecar this ingest just wrote so the summary can lead with the findings. Its
    // absence is not an error: a run with nothing to persist writes none. The summary does not
    // need it to state the run's scope (the reconciliation OUTCOME carries that), only to name
    // and quote findings that exist, so the no-sidecar run still gets its honest zero line.
    const sidecar = res.runId ? loadCandidatesSidecar(HOME, cfg.workspaceId, res.runId) : null;
    console.log(
      renderIngestSummary(
        res.outcomes,
        res.state?.status,
        consoleDeepLink(cfg, "/kb"),
        sidecar ? { runId: sidecar.runId, candidates: sidecar.candidates } : undefined,
        // From the ingest RESULT, not the sidecar: a run that persisted only rules writes no
        // findings sidecar, and that run needs the review gesture just as much as one that did.
        res.runId,
      ),
    );
  }

  // 1 when a scout needs attention (infra failure or a malformed envelope worth a retry);
  // 0 otherwise. A scout that merely "timed_out" is rerunnable state, not an error here.
  const attention = (res.state ? Object.values(res.state.scouts) : []).filter(
    (s) => s.status === "persistence_failed" || s.status === "malformed",
  );
  if (attention.length === 0) return 0;

  // This exit bypasses failInMode (it is a plain non-zero return), so nothing else would
  // tell analytics WHY: it landed as an unexplained user_error with a null class, which is
  // how a prod workspace burned three ingest attempts leaving no recoverable reason.
  // Declare it: neither status is the operator's mistake (one is a KB write that failed,
  // one is a scout envelope we could not parse) and both are worth a rerun.
  noteHandledFailure({
    error_class: attention.some((s) => s.status === "persistence_failed")
      ? "scout_persistence_failed"
      : "scout_malformed",
    outcome: "system_error",
    retryable: true,
  });
  return 1;
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
      // Dispatch roster, not the parse roster: a retired scout must be unbriefable, which
      // is what makes "no new token cost" enforceable rather than merely intended. Old run
      // records that still name it stay readable; they just cannot be briefed again.
      flags.role = assertDispatchableRole(v);
    } else if (a === "--workspace") {
      flags.workspace = argv[++i];
      if (!flags.workspace) throw new Error("--workspace requires a workspace id");
    } else throw new Error(`Unknown flag for \`mla enrich brief\`: ${a}`);
  }
  if (!flags.runId) throw new Error("--run-id is required (the id printed by `mla enrich plan`)");
  if (!flags.role)
    throw new Error(`--role is required (one of: ${DISPATCH_SCOUT_NAMES.join(", ")})`);
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

  // Re-anchor the scout's deadline to NOW plus the run's budget, rather than handing it the
  // run's frozen plan-time deadline. The brief is rendered immediately before the agent
  // dispatches the scout, so now is the closest we can get to when the scout actually starts.
  // Anchoring at plan time silently charged the scout for the orchestration in between: two
  // `enrich brief` calls, plus the agent relaying the brief verbatim into the Task prompt
  // (the history brief is tens of KB of git evidence, emitted token by token). On the real
  // repo that gap alone consumed most of the four-minute default, and a slow relay hands the
  // scout a deadline already in the past, which the brief reads as "return timed_out
  // immediately". The budget is meant to bound the scout's work, not the orchestrator's.
  const deadlineAt = new Date(Date.now() + run.limits.budgetMs).toISOString();
  console.log(buildScoutPrompt(run, flags.role!, deadlineAt));
  return 0;
}

// --- enrich materialize: mint accepted durable rules from a JSON payload -----------
//
// The manual ACCEPT path of onboarding (memo Phase 1, line 535: "accepted DURABLE rules
// materialize into the managed file; accepted decisions enter governed knowledge and do
// NOT silently become rules"). Where `enrich accept` reads a run's candidates sidecar by
// run id, `materialize` takes the accepted-candidates JSON directly (a hand-assembled
// batch, or a paste of a scout-result list). `enrich ingest` parks candidates born
// PENDING; the human governs which are durable policy; this command binds the ones they
// accept.
//
// MATERIALIZING IS MINTING, exactly like `enrich accept`. Each durable rule is minted into
// the backend rule bundle (the same authority `mla rules add` writes) and only then is
// .meetless/rules.md re-rendered as its local read projection. This ordering is the whole
// point: `scan` builds the injected rule set from the principal-bound backend bundle and
// explicitly SKIPS .meetless/rules.md as an injection source (scan.ts), so a rule that is
// only written to the file is a rule no agent ever sees. Materialize used to write ONLY the
// file, which is precisely the "accepted but never injected" bug `enrich accept` was fixed
// for; this closes the same gap on the manual path. After minting, it delivers into the two
// local caches an agent reads (refreshRuleDelivery). Minting is a binding act, so it needs
// an authenticated human and a bound workspace (PERSONAL by default, --team for
// workspace-wide). Decisions/deprecations are reported as skipped, never minted (INV-AUTH-2).
interface MaterializeFlags {
  acceptedFile?: string;
  json: boolean;
  dryRun: boolean;
  workspace?: string;
  /** Mint into the TEAM plane (workspace-wide enforcement) instead of the PERSONAL default. */
  team: boolean;
  /** Spell out the PERSONAL default. Passing both --team and --personal is a usage error. */
  personal: boolean;
  /** Non-interactive consent for the TEAM plane (same gate `mla rules add --team` uses). */
  yes: boolean;
}

export function parseMaterializeArgs(argv: string[]): MaterializeFlags {
  const flags: MaterializeFlags = { json: false, dryRun: false, team: false, personal: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--team") flags.team = true;
    else if (a === "--personal") flags.personal = true;
    else if (a === "--yes") flags.yes = true;
    else if (a === "--workspace") {
      flags.workspace = argv[++i];
      if (!flags.workspace) throw new Error("--workspace requires a workspace id");
    } else if (a === "--accepted-file") {
      flags.acceptedFile = argv[++i];
      if (!flags.acceptedFile) throw new Error("--accepted-file requires a path");
    } else throw new Error(`Unknown flag for \`mla enrich materialize\`: ${a}`);
  }
  if (flags.team && flags.personal) {
    throw new Error("pass either --team or --personal, not both (they are the two authority planes)");
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
//
// `shareHint` is false for `enrich accept`, which mints: there, the file is a projection of a rule
// the authority already holds, so "commit and push to share" would be a lie about how sharing works
// (sharing is `--team`, not a git push). Accept prints the mint summary instead.
export function renderMaterializeSummary(
  result: MaterializeResult,
  relPath: string,
  dryRun: boolean,
  shareHint = true,
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

  if (result.changed && !dryRun && shareHint) {
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

export async function runEnrichMaterialize(argv: string[], deps: EnrichAcceptDeps = {}): Promise<number> {
  let flags: MaterializeFlags;
  try {
    flags = parseMaterializeArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  // The managed file lives at the git root; the rules bind to that same repository (its runtime
  // scope + delivery target). Resolve it from where the operator stands.
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

  // Materializing IS the mint (identical contract to `enrich accept`): the durable rules reach the
  // backend authority BEFORE the local projection is written, so `.meetless/rules.md` can never claim
  // a rule the authority never received. A mint refusal/failure returns non-zero and writes nothing.
  const authorityScope: RuleAuthorityScope = flags.team ? "TEAM" : "PERSONAL";
  let outcomes: MintOutcome[] = [];
  let delivered = false;
  let deliveryError: string | null = null;

  if (result.materialized.length > 0 && !flags.dryRun) {
    const minted = await mintAndDeliverRules(
      result.materialized,
      // `enrich materialize` is not a machine-mode operation (it resolves to no OperationId, so the
      // bootstrap keeps it human); the command id is inert here and only ever names the envelope for
      // `enrich accept`'s converted mutation path.
      { verb: "materialize", command: "enrich.materialize", team: flags.team, yes: flags.yes, workspace: flags.workspace, repositoryRoot },
      deps,
    );
    if (!minted.ok) return minted.exitCode;
    outcomes = minted.outcomes;
    delivered = minted.delivered;
    deliveryError = minted.deliveryError;
  }

  if (result.changed && !flags.dryRun) {
    writeManagedFile(managedPath, result.text);
  }

  const minted = outcomes.filter((o) => o.status === "minted");
  const alreadyLive = outcomes.filter((o) => o.status === "already_live");

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          path: MANAGED_RULES_PATH,
          changed: result.changed,
          wrote: result.changed && !flags.dryRun,
          dryRun: flags.dryRun,
          authorityScope,
          minted: minted.map((o) => ({ ruleId: o.ruleId, hash: o.hash, statement: o.rule.statement })),
          alreadyLive: alreadyLive.map((o) => ({ hash: o.hash, statement: o.rule.statement })),
          materialized: result.materialized.map((r) => ({ id: r.id, statement: r.statement, strength: r.strength })),
          skipped: result.skipped,
          // Minted != reaching an agent. `delivered` is the local-cache half: false means the rules
          // are live on the authority but the next turn will NOT inject them until `mla scan` runs.
          delivered,
          deliveryError,
        },
        null,
        2,
      ),
    );
  } else {
    // shareHint=false: acceptance mints, so the file is a projection of an authority-held rule and
    // "commit and push to share" would be a lie (sharing is `--team`). The mint summary follows.
    console.log(renderMaterializeSummary(result, MANAGED_RULES_PATH, flags.dryRun, false));
    console.log(
      renderMintSummary(minted, alreadyLive, authorityScope, result.materialized.length, flags.dryRun, {
        delivered,
        deliveryError,
      }),
    );
  }
  return 0;
}

// --- enrich accept: mint a run's accepted candidates into the rule authority -------------
//
// The onboarding-native ACCEPT half. `enrich ingest` parks a run's merged candidates in the
// governed KB born PENDING AND writes a local candidates sidecar (the structured post-merge
// records). This command reads that sidecar by run id and accepts the DURABLE ones
// (constraint / convention / boundary); decisions + deprecations are governed knowledge, reported
// as skipped, never accepted as rules (INV-AUTH-2).
//
// ACCEPTANCE IS THE MINT. Accepting sends each durable rule to the backend rule bundle (the same
// authority `mla rules add` writes) and only then re-renders .meetless/rules.md as its local read
// projection. This ordering is the whole point: `scan` builds the injected rule set from the
// principal-bound backend bundle and explicitly SKIPS .meetless/rules.md as an injection source
// (scan.ts), so a rule that is only materialized into the file is a rule no agent ever sees. Before
// this, an onboarded + accepted rule was never injected: the file was the only sink.
//
// It exists so onboarding has a first-class "accept the rules this run found" step without the
// operator hand-assembling an accepted-candidates JSON for `enrich materialize`. With no selection
// flag it is a READ-ONLY review: it prints what the run found and mints/writes nothing, so a human
// always sees the candidates before anything binds. --all accepts every durable rule; --only
// <id-prefixes> accepts just the named ones. Minting is a binding act, so it requires an
// authenticated human and a bound workspace (PERSONAL by default, --team for workspace-wide).
// mla still never commits or pushes the projection (it prints MATERIALIZE_SHARE_MESSAGE).
interface AcceptFlags {
  runId?: string;
  all: boolean;
  only?: string[];
  dryRun: boolean;
  json: boolean;
  workspace?: string;
  /** Mint into the TEAM plane (workspace-wide enforcement) instead of the PERSONAL default. */
  team: boolean;
  /** Spell out the PERSONAL default. Passing both --team and --personal is a usage error. */
  personal: boolean;
  /** Non-interactive consent for the TEAM plane (same gate `mla rules add --team` uses). */
  yes: boolean;
}

export function parseAcceptArgs(argv: string[]): AcceptFlags {
  const flags: AcceptFlags = {
    all: false,
    dryRun: false,
    json: false,
    team: false,
    personal: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--team") {
      flags.team = true;
    } else if (a === "--personal") {
      flags.personal = true;
    } else if (a === "--yes") {
      flags.yes = true;
    } else if (a === "--run-id") {
      flags.runId = argv[++i];
      if (!flags.runId) throw new Error("--run-id requires a value");
    } else if (a === "--all") {
      flags.all = true;
    } else if (a === "--only") {
      const v = argv[++i];
      if (!v) throw new Error("--only requires a comma-separated list of candidate id prefixes");
      const prefixes = v
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 0);
      if (prefixes.length === 0) throw new Error("--only requires at least one candidate id prefix");
      for (const p of prefixes) {
        if (!/^[0-9a-f]{6,}$/.test(p)) {
          throw new Error(`--only prefix "${p}" must be at least 6 hex characters of a candidate id`);
        }
      }
      flags.only = prefixes;
    } else if (a === "--dry-run") {
      flags.dryRun = true;
    } else if (a === "--json") {
      flags.json = true;
    } else if (a === "--workspace") {
      flags.workspace = argv[++i];
      if (!flags.workspace) throw new Error("--workspace requires a workspace id");
    } else {
      throw new Error(`Unknown flag for \`mla enrich accept\`: ${a}`);
    }
  }
  if (!flags.runId) throw new Error("--run-id is required (the id printed by `mla enrich plan`)");
  if (flags.all && flags.only) {
    throw new Error("--all and --only are mutually exclusive (choose one way to pick which candidates to accept)");
  }
  if (flags.team && flags.personal) {
    throw new Error("pass either --team or --personal, not both (they are the two authority planes)");
  }
  return flags;
}

// Reconstruct the wire candidate materializeRules consumes. It reads only kind/statement/evidence
// (candidateToManagedRule derives sources from evidence); sourceScout is required by the type, so
// we take the first producing scout (a record always carries at least one). rationale is carried
// through for fidelity though the managed file does not render it today.
function recordToCandidate(r: OnboardingCandidateRecord): EnrichmentCandidate {
  return {
    kind: r.kind,
    statement: r.statement,
    evidence: r.evidence,
    sourceScout: r.sourceScouts[0],
    rationale: r.rationale,
    rationaleSource: r.rationaleSource,
  };
}

// How many chars of the sha256 candidate id to show in the review (enough to be readable and to
// paste back into --only, which requires >= 6).
const CANDIDATE_ID_DISPLAY_LEN = 12;

// The read-only review a bare `mla enrich accept --run-id <id>` prints: the durable rules this run
// found (acceptable) and the governed-knowledge candidates it will NOT turn into rules, so a human
// sees everything before choosing --all or --only. The copy says MINT, not "write a file", because
// that is what acceptance does; the file is the projection. Pure (no fs) and exported so a test pins
// the wording. Nothing is minted and nothing is written in this mode.
//
// `runId` is the REAL run id this review is for, interpolated into the next-step commands below
// (proposal §3 bug 3): the menu used to print a literal `--run-id <id>`, so a human (or an agent)
// who copied the line got a guaranteed error. The only remaining placeholder is `<id-prefix>`, which
// is a genuine user choice (which candidate to accept), not a value we already know.
export function renderAcceptReview(
  runId: string,
  durable: readonly OnboardingCandidateRecord[],
  knowledgeOnly: readonly OnboardingCandidateRecord[],
): string {
  // §5.2 placeholder guard (the mechanical backstop for the §3 bug 3 defect): this
  // renderer emits runnable `mla enrich accept --run-id <runId>` next-step lines, so an
  // absent or blank run id would print a command a human could not run. Fail loudly here
  // rather than interpolate an empty argument. runEnrichAccept already requires --run-id,
  // so this only fires if a future caller forgets it; when it does, it must scream.
  if (!runId.trim()) {
    throw new Error(
      "renderAcceptReview: runId is required to render runnable next-step commands (unresolved argument)",
    );
  }
  const lines: string[] = [];
  const byStatement = (a: OnboardingCandidateRecord, b: OnboardingCandidateRecord) =>
    a.statement.localeCompare(b.statement);
  const row = (c: OnboardingCandidateRecord) =>
    `  ${c.candidateId.slice(0, CANDIDATE_ID_DISPLAY_LEN)}  [${c.kind}]  ${c.statement}`;

  if (durable.length > 0) {
    lines.push(
      `${durable.length} durable rule${durable.length === 1 ? "" : "s"} this run found ` +
        `(accept to mint into the rule bundle \`mla scan\` injects from; ${MANAGED_RULES_PATH} is its local projection):`,
    );
    for (const c of [...durable].sort(byStatement)) lines.push(row(c));
  } else {
    lines.push("This run found no durable rules to accept.");
  }

  if (knowledgeOnly.length > 0) {
    lines.push("");
    lines.push(
      `${knowledgeOnly.length} governed-knowledge candidate${knowledgeOnly.length === 1 ? "" : "s"} ` +
        "(NOT materialized; governed in the Console KB):",
    );
    for (const c of [...knowledgeOnly].sort(byStatement)) lines.push(row(c));
  }

  lines.push("");
  if (durable.length > 0) {
    lines.push(`Accept all durable rules:  mla enrich accept --run-id ${runId} --all`);
    lines.push(`Accept specific ones:      mla enrich accept --run-id ${runId} --only <id-prefix>[,<id-prefix>...]`);
    lines.push("Preview without minting:   add --dry-run");
    lines.push("Enforce workspace-wide:    add --team (default is PERSONAL: it enforces for you alone)");
  } else if (knowledgeOnly.length > 0) {
    // Onboarding worked; it just found decisions, not rules. Saying only "no durable rules"
    // reads as a failure and ends the session at zero rules, which is exactly where three
    // prod workspaces stopped. Name the distinction, then hand over a runnable command.
    lines.push("Governed knowledge is answerable through `mla ask`, but only a rule is injected into an agent's context.");
    lines.push(`Write one directly:        mla rules add "<statement>" [--personal|--team] [--must]`);
  } else {
    lines.push("The scouts surfaced nothing to govern in this run.");
    lines.push(`Re-run them:               mla enrich plan  (then brief, then ingest)`);
    lines.push(`Or write a rule directly:  mla rules add "<statement>" [--personal|--team] [--must]`);
  }
  return lines.join("\n");
}

// The typed, deterministically executable decision the read-only preview hands the agent under
// machine mode (§4.5). It carries NO shell command: each option's `selection` is a closed value the
// connector adapter maps to CLI arguments (`all` -> --all, `only` -> --only <ids>, `none` -> nothing).
// The options are the coarse, unambiguous choices; a precise custom subset is handled by explicit
// intent (§4.6), where the agent runs `--only ...` directly and no decision_request is emitted.
// Returns undefined when there is nothing durable to accept, so the envelope carries no request.
function buildAcceptDecisionRequest(
  runId: string,
  durable: readonly OnboardingCandidateRecord[],
): DecisionRequest | undefined {
  if (durable.length === 0) return undefined;

  const plural = (n: number) => (n === 1 ? "" : "s");
  const options: DecisionOption[] = [
    {
      id: "all",
      label: `Accept all ${durable.length} durable rule${plural(durable.length)}`,
      selection: { mode: "all" },
    },
  ];

  // A meaningful middle ground: accept only the hard constraints, offered when they are a PROPER
  // subset (the run also found softer conventions or boundaries). candidate_ids are the full sha256
  // ids so `--only` resolves each to exactly one record with no prefix ambiguity.
  const constraints = durable.filter((c) => c.kind === "constraint");
  if (constraints.length > 0 && constraints.length < durable.length) {
    options.push({
      id: "constraints",
      label: `Accept the ${constraints.length} constraint${plural(constraints.length)} only`,
      selection: { mode: "only", candidate_ids: constraints.map((c) => c.candidateId) },
    });
  }

  options.push({
    id: "none",
    label: "Leave all candidates pending",
    selection: { mode: "none" },
  });

  return {
    kind: "enrich.accept",
    subject: { run_id: runId },
    prompt:
      `Which of the ${durable.length} durable rule${plural(durable.length)} from run ${runId} ` +
      "should be accepted into the rule bundle?",
    options,
  };
}

// Resolve the --only prefixes to concrete records, fail-closed. Each prefix must match exactly one
// candidate id: zero matches or an ambiguous prefix is an error, not a silent skip, so the operator
// never mistakes a typo'd id for "accepted nothing".
type OnlyResolution =
  | { ok: true; selected: OnboardingCandidateRecord[] }
  | { ok: false; error: string };

function resolveOnly(
  prefixes: readonly string[],
  candidates: readonly OnboardingCandidateRecord[],
): OnlyResolution {
  const selected = new Map<string, OnboardingCandidateRecord>();
  for (const p of prefixes) {
    const matches = candidates.filter((c) => c.candidateId.toLowerCase().startsWith(p));
    if (matches.length === 0) {
      return { ok: false, error: `no candidate id starts with "${p}" in this run` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `candidate id prefix "${p}" is ambiguous (matches ${matches.length}); use more characters`,
      };
    }
    selected.set(matches[0].candidateId, matches[0]);
  }
  return { ok: true, selected: [...selected.values()] };
}

// The seams `enrich accept` mints through. Same shape as the `mla rules` verbs (rules-backend.ts):
// config load, the http transport, operator resolution, runtime scope, and the confirm prompt are
// all injectable, so the mint is unit-testable with no network, no disk and no tty.
export interface EnrichAcceptDeps {
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  http?: RuleClientHttp;
  resolveOperator?: () => BackendOperator | null;
  resolveRuntimeScopeId?: (cwd?: string) => string;
  isInteractive?: () => boolean;
  confirm?: (prompt: string) => boolean | Promise<boolean>;
  // The post-mint local-cache refresh (see refreshRuleDelivery). Injected so a command test can
  // assert accept DELIVERS without standing up a bundle route, a real HOME, and a git repo.
  refreshDelivery?: (cfg: WorkspaceCliConfig, repositoryRoot: string, http?: RuleClientHttp) => Promise<void>;
}

// One accepted rule's fate on the authority: minted now, or already live from an earlier accept.
interface MintOutcome {
  rule: ManagedRule;
  ruleId: string;
  hash: string;
  status: "minted" | "already_live";
}

/**
 * Mint the accepted durable rules into the backend rule bundle (the authority). This is what makes
 * acceptance real: `scan` injects from the principal-bound backend bundle, never from
 * `.meetless/rules.md` (scan.ts skips that file by name), so a rule that is only materialized into
 * the local file is a rule NO agent ever sees. Acceptance IS the mint; the file is the projection.
 *
 * Re-runnable: the native mint does not dedup, so anything whose payload hash is already live in the
 * workspace is reported `already_live` and skipped rather than minted twice.
 */
async function mintAcceptedRules(
  rules: readonly ManagedRule[],
  cfg: WorkspaceCliConfig,
  authorityScope: RuleAuthorityScope,
  ownerUserId: string | null,
  runtimeScopeId: string,
  http: RuleClientHttp | undefined,
  // Accumulated in place so a mid-batch failure still reports what DID reach the authority.
  outcomes: MintOutcome[],
): Promise<void> {
  const live = await alreadyMintedHashes(cfg, http);
  for (const rule of rules) {
    const hash = managedRuleHash(rule, runtimeScopeId);
    if (live.has(hash)) {
      outcomes.push({ rule, ruleId: "(already live)", hash, status: "already_live" });
      continue;
    }
    const { node } = await mintManagedRule(cfg, rule, { authorityScope, ownerUserId, runtimeScopeId }, http);
    live.add(hash);
    outcomes.push({ rule, ruleId: node.id, hash, status: "minted" });
  }
}

// The success/refusal shape of the shared mint-and-deliver core. On refusal it has already printed
// the reason; the caller returns `exitCode` and writes NO projection.
type MintAndDeliverResult =
  | { ok: true; outcomes: MintOutcome[]; delivered: boolean; deliveryError: string | null }
  | { ok: false; exitCode: number };

/**
 * The binding core shared by `enrich accept` and `enrich materialize`. Both turn accepted DURABLE
 * rules into authority state and then deliver them to the local caches an agent reads; they differ
 * only in which repository the rules bind to and the verb printed in the operator-facing errors.
 * Extracting it keeps the two commands from forking the binding path: the operator gate, the TEAM
 * blast-radius confirm, the dedup-aware mint, and the best-effort delivery are defined once.
 *
 * Mint-BEFORE-write is the caller's contract, enforced here by returning `{ok:false}` on any refusal
 * so the caller writes nothing: minting is the authority write, and `.meetless/rules.md` must never
 * claim a rule the authority never received. On success it returns what reached the authority
 * (`outcomes`) and whether the local caches refreshed (`delivered`/`deliveryError`) for the summary.
 */
async function mintAndDeliverRules(
  rules: readonly ManagedRule[],
  ctx: { verb: string; command: string; team: boolean; yes: boolean; workspace?: string; repositoryRoot: string },
  deps: EnrichAcceptDeps,
): Promise<MintAndDeliverResult> {
  const authorityScope: RuleAuthorityScope = ctx.team ? "TEAM" : "PERSONAL";

  // Each refusal is routed through failInMode so it becomes a single error envelope under machine
  // mode and stays byte-identical human text otherwise. Only `enrich accept`'s mutation arms machine
  // mode (§4.3); `enrich materialize` resolves to no operation, so the bootstrap downgrades it to
  // human before this runs (cli.ts applyMachineCapability) and every branch here prints as it always did.
  const fail = (code: string, message: string, exitCode: number): MintAndDeliverResult => ({
    ok: false,
    exitCode: failInMode(ctx.command, code, message, exitCode),
  });

  // Minting is a binding act: it requires an authenticated human. A shared-key/CI session (or an
  // agent) is refused, because a rule that enforces on humans must be traceable to one.
  const resolveOperator = deps.resolveOperator ?? resolveBackendOperator;
  const operator = resolveOperator();
  if (!operator) {
    return fail(
      "not_authenticated",
      `refusing to ${ctx.verb}: a binding rule requires an authenticated human (run \`mla login\`); ` +
        "an agent or shared key can never mint a binding rule",
      1,
    );
  }

  let cliCfg: WorkspaceCliConfig;
  try {
    cliCfg = (deps.loadConfig ?? loadWorkspaceConfig)(ctx.workspace);
  } catch (e) {
    return fail("config_error", `enrich ${ctx.verb}: ${(e as Error).message}`, 2);
  }

  // TEAM enforces workspace-wide, so it confirms exactly like `mla rules add --team`: interactive
  // Y/n, or --yes as the explicit non-interactive instruction. One prompt for the whole batch.
  if (authorityScope === "TEAM" && !ctx.yes) {
    const isInteractive = deps.isInteractive ?? defaultIsInteractive;
    if (!isInteractive()) {
      return fail(
        "confirmation_required",
        "refusing to mint TEAM rules non-interactively without --yes (they enforce workspace-wide)",
        1,
      );
    }
    const ask = deps.confirm ?? defaultConfirm;
    const ok = await ask(
      `Mint ${rules.length} TEAM rule(s) (they will enforce for the whole workspace)?`,
    );
    if (!ok) {
      return fail("not_confirmed", "team rules not confirmed; nothing minted, nothing written", 1);
    }
  }

  // The runtime scope + delivery target is the repository the rules bind to: the RUN's repo for
  // accept (it may be run from elsewhere), the cwd git root for materialize.
  const resolveScope = deps.resolveRuntimeScopeId ?? resolveActiveRuntimeScopeId;
  const runtimeScopeId = resolveScope(ctx.repositoryRoot);
  const ownerUserId = authorityScope === "PERSONAL" ? operator.userId : null;

  const outcomes: MintOutcome[] = [];
  try {
    await mintAcceptedRules(rules, cliCfg, authorityScope, ownerUserId, runtimeScopeId, deps.http, outcomes);
  } catch (e) {
    const mintedSoFar = outcomes.filter((o) => o.status === "minted").length;
    return fail(
      "mint_failed",
      `enrich ${ctx.verb} failed: ${(e as Error).message}. The backend rule bundle is the authority, ` +
        `so ${MANAGED_RULES_PATH} was NOT written. ` +
        (mintedSoFar > 0
          ? `${mintedSoFar} rule(s) did reach the authority before the failure; re-run to finish (already-minted rules are skipped, never duplicated).`
          : "No rule reached the authority. Re-run to retry."),
      1,
    );
  }

  // The mint is durable now. Make it REACHABLE. Best-effort: the authority already has the rules, so
  // a refresh failure must not report a mint that did happen as one that did not, but it is NEVER
  // silent: the failure is carried back for the summary.
  let delivered = false;
  let deliveryError: string | null = null;
  try {
    await (deps.refreshDelivery ?? refreshRuleDelivery)(cliCfg, ctx.repositoryRoot, deps.http);
    delivered = true;
  } catch (e) {
    deliveryError = (e as Error).message;
  }

  return { ok: true, outcomes, delivered, deliveryError };
}

export async function runEnrichAccept(argv: string[], deps: EnrichAcceptDeps = {}): Promise<number> {
  // Both forms of this command are machine-mode operations. The dispatch gate resolves a bare
  // `enrich accept --run-id X` to `enrich.accept` (the read-only review, Phase 1) and a selection
  // flag to `enrich.accept.apply` (the mutation, Phase 3); `command` is whichever the gate armed.
  // The review branch attaches the typed decision_request; the mutation branch emits a result
  // envelope. Falls back to the read-only id for a direct (non-dispatch) call in a human context.
  const command = getMachineCommand() ?? "enrich.accept";

  let flags: AcceptFlags;
  try {
    flags = parseAcceptArgs(argv);
  } catch (e) {
    return failInMode(command, "usage_error", (e as Error).message, 2);
  }

  // The sidecar is keyed by workspace + runId. readKbConfig resolves the workspace the run was
  // ingested under (the sidecar lives under that workspace's local onboarding-runs dir).
  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    return failInMode(command, "config_error", (e as Error).message, 2);
  }

  const sidecar = loadCandidatesSidecar(HOME, cfg.workspaceId, flags.runId!);
  if (!sidecar) {
    return failInMode(
      command,
      "unknown_run",
      `no candidates sidecar for run ${flags.runId} in workspace ${cfg.workspaceId}. ` +
        "Run `mla enrich ingest` first, from the same workspace.",
      2,
    );
  }

  const durable = sidecar.candidates.filter((c) => isDurableRuleKind(c.kind));
  const knowledgeOnly = sidecar.candidates.filter((c) => !isDurableRuleKind(c.kind));

  // No selection flag: read-only review. Print what the run found, write nothing.
  if (!flags.all && !flags.only) {
    const reviewPayload = {
      runId: sidecar.runId,
      repositoryRoot: sidecar.repositoryRoot,
      durable: durable.map((c) => ({ candidateId: c.candidateId, kind: c.kind, statement: c.statement })),
      knowledgeOnly: knowledgeOnly.map((c) => ({
        candidateId: c.candidateId,
        kind: c.kind,
        statement: c.statement,
      })),
    };
    if (isMachineMode()) {
      // The read-only preview is where the authority decision is ASKED (§4.5, §4.6). It carries the
      // typed decision_request (absent when nothing is durable) and product-authored prose the agent
      // may relay; it never emits the completed transcript (that stays hook-owned).
      const decisionRequest = buildAcceptDecisionRequest(sidecar.runId, durable);
      const humanSummary =
        durable.length === 0
          ? "This run found no durable rules to accept."
          : `${durable.length} durable rule${durable.length === 1 ? "" : "s"} found` +
            (knowledgeOnly.length > 0
              ? `, ${knowledgeOnly.length} knowledge-only`
              : "") +
            ". Nothing is accepted until you choose.";
      return emitEnvelope(
        successEnvelope(command, reviewPayload, { decisionRequest, humanSummary }),
        0,
      );
    }
    if (flags.json) {
      console.log(JSON.stringify(reviewPayload, null, 2));
    } else {
      console.log(renderAcceptReview(sidecar.runId, durable, knowledgeOnly));
    }
    return 0;
  }

  // Selection: which records to hand to materializeRules. --all forwards every candidate (the
  // bridge itself skips + reports the non-durable ones); --only resolves the named prefixes.
  let selectedRecords: OnboardingCandidateRecord[];
  if (flags.all) {
    selectedRecords = sidecar.candidates;
  } else {
    const res = resolveOnly(flags.only!, sidecar.candidates);
    if (!res.ok) {
      // Fail closed on a selection that no longer resolves (§4.6, item 5: the stale-state boundary
      // between the preview and the mutation). A candidate id from the decision_request that has since
      // moved, or an ambiguous prefix, aborts BEFORE any mint; nothing is accepted.
      return failInMode(command, "invalid_selection", `refusing to accept: ${res.error}`, 2);
    }
    selectedRecords = res.selected;
  }

  const managedPath = join(sidecar.repositoryRoot, MANAGED_RULES_PATH);
  const existing = readManagedFile(managedPath);
  const result = materializeRules(existing, selectedRecords.map(recordToCandidate));

  // Acceptance IS the mint. The durable rules go to the backend rule bundle (the authority `scan`
  // injects from) BEFORE the local projection is written, so `.meetless/rules.md` can never claim a
  // rule the authority never received. A mint failure aborts with a non-zero exit and no file write.
  // The runtime scope + delivery target is the RUN's repository (the sidecar records it), not the
  // cwd: accepting a run from elsewhere must still bind the rule to the repo it was mined from.
  const authorityScope: RuleAuthorityScope = flags.team ? "TEAM" : "PERSONAL";
  let outcomes: MintOutcome[] = [];
  // Did the minted rules actually reach the local caches the agent reads? (refreshRuleDelivery.)
  let delivered = false;
  let deliveryError: string | null = null;

  if (result.materialized.length > 0 && !flags.dryRun) {
    const minted = await mintAndDeliverRules(
      result.materialized,
      {
        verb: "accept",
        command,
        team: flags.team,
        yes: flags.yes,
        workspace: flags.workspace,
        repositoryRoot: sidecar.repositoryRoot,
      },
      deps,
    );
    if (!minted.ok) return minted.exitCode;
    outcomes = minted.outcomes;
    delivered = minted.delivered;
    deliveryError = minted.deliveryError;
  }

  if (result.changed && !flags.dryRun) {
    writeManagedFile(managedPath, result.text);
  }

  const minted = outcomes.filter((o) => o.status === "minted");
  const alreadyLive = outcomes.filter((o) => o.status === "already_live");

  // The one payload shape shared by machine mode and `--json`. Machine mode WRAPS it in `result`
  // (§4.4) and is checked FIRST so the envelope wins over the raw `--json` shape.
  const acceptPayload = {
    runId: sidecar.runId,
    path: MANAGED_RULES_PATH,
    repositoryRoot: sidecar.repositoryRoot,
    changed: result.changed,
    wrote: result.changed && !flags.dryRun,
    dryRun: flags.dryRun,
    authorityScope,
    minted: minted.map((o) => ({ ruleId: o.ruleId, hash: o.hash, statement: o.rule.statement })),
    alreadyLive: alreadyLive.map((o) => ({ hash: o.hash, statement: o.rule.statement })),
    materialized: result.materialized.map((r) => ({ id: r.id, statement: r.statement, strength: r.strength })),
    skipped: result.skipped,
    // Minted != reaching an agent. `delivered` is the local-cache half: false means the rules
    // are live on the authority but the next turn will NOT inject them until `mla scan` runs.
    delivered,
    deliveryError,
  };

  // A completed mutation carries neither next_action nor decision_request (§4.2): the decision was
  // already made on the preview; this is the outcome.
  if (isMachineMode()) return emitEnvelope(successEnvelope(command, acceptPayload), 0);

  if (flags.json) {
    console.log(JSON.stringify(acceptPayload, null, 2));
  } else {
    console.log(renderMaterializeSummary(result, MANAGED_RULES_PATH, flags.dryRun, false));
    console.log(
      renderMintSummary(minted, alreadyLive, authorityScope, result.materialized.length, flags.dryRun, {
        delivered,
        deliveryError,
      }),
    );
  }
  return 0;
}

// What acceptance did to the AUTHORITY, printed under the projection summary. This is the line that
// tells the operator their rules are live for the agent (the file alone never was).
function renderMintSummary(
  minted: readonly MintOutcome[],
  alreadyLive: readonly MintOutcome[],
  authorityScope: RuleAuthorityScope,
  durableCount: number,
  dryRun: boolean,
  delivery: { delivered: boolean; deliveryError: string | null },
): string {
  if (durableCount === 0) return "";
  if (dryRun) {
    return `Would mint ${durableCount} ${authorityScope} rule(s) into the backend rule bundle (the authority \`mla scan\` injects from).`;
  }
  const lines: string[] = [];
  for (const o of minted) {
    lines.push(`MINTED ${authorityScope} rule ${o.ruleId}: ${terminalSafe(o.rule.statement, DISPLAY_LEN.statement)}`);
  }
  for (const o of alreadyLive) {
    lines.push(`Already live (not minted again): ${terminalSafe(o.rule.statement, DISPLAY_LEN.statement)}`);
  }
  if (minted.length > 0) {
    // Only claim injection when the local caches were actually refreshed. Saying "injects them now"
    // over a stale cache is the failure this whole path exists to prevent: the rule IS live on the
    // authority, so nothing looks broken, and the agent quietly never sees it.
    lines.push(
      authorityScope === "TEAM"
        ? "These are TEAM rules: they enforce for every member of the workspace."
        : "These are PERSONAL rules: they enforce for you alone. Re-run with --team to enforce workspace-wide.",
    );
    lines.push(
      delivery.delivered
        ? "Injected: they are in your local rule cache now and apply from your very next turn."
        : `WARNING: the rules are live on the backend but your LOCAL cache could not be refreshed ` +
            `(${delivery.deliveryError ?? "unknown error"}), so this session will NOT inject them yet. ` +
            `Run \`mla scan\` to pull them down.`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// `mla enrich resolve`: answering a doc/code finding (§5.9)
// ---------------------------------------------------------------------------------------

interface ResolveFlags {
  runId?: string;
  finding?: string; // a candidate id prefix, lowercased (>= 6 hex chars)
  as?: FindingResolution;
  dryRun: boolean;
  json: boolean;
  workspace?: string;
  team: boolean;
  personal: boolean;
  yes: boolean;
}

// Accepts both `--flag value` and `--flag=value`, matching what resolveOperation's argv sniff
// looks for: a shape the capability gate recognizes but the parser rejects would resolve to the
// mutation id and then fail as a usage error inside it, which is a lie about what ran.
export function parseResolveArgs(argv: string[]): ResolveFlags {
  const flags: ResolveFlags = { dryRun: false, json: false, team: false, personal: false, yes: false };
  const valueOf = (arg: string, i: number): { value: string | undefined; next: number } => {
    const eq = arg.indexOf("=");
    return eq === -1 ? { value: argv[i + 1], next: i + 1 } : { value: arg.slice(eq + 1), next: i };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (name === "--team") {
      flags.team = true;
    } else if (name === "--personal") {
      flags.personal = true;
    } else if (name === "--yes") {
      flags.yes = true;
    } else if (name === "--dry-run") {
      flags.dryRun = true;
    } else if (name === "--json") {
      flags.json = true;
    } else if (name === "--run-id") {
      const { value, next } = valueOf(a, i);
      if (!value) throw new Error("--run-id requires a value");
      flags.runId = value;
      i = next;
    } else if (name === "--workspace") {
      const { value, next } = valueOf(a, i);
      if (!value) throw new Error("--workspace requires a workspace id");
      flags.workspace = value;
      i = next;
    } else if (name === "--finding") {
      const { value, next } = valueOf(a, i);
      if (!value) throw new Error("--finding requires a candidate id prefix");
      const prefix = value.trim().toLowerCase();
      if (!/^[0-9a-f]{6,}$/.test(prefix)) {
        throw new Error(`--finding prefix "${prefix}" must be at least 6 hex characters of a candidate id`);
      }
      flags.finding = prefix;
      i = next;
    } else if (name === "--as") {
      const { value, next } = valueOf(a, i);
      if (!value) throw new Error(`--as requires one of: ${FINDING_RESOLUTIONS.join(", ")}`);
      const outcome = value.trim().toLowerCase();
      if (!isFindingResolution(outcome)) {
        throw new Error(`--as must be one of: ${FINDING_RESOLUTIONS.join(", ")} (got "${outcome}")`);
      }
      flags.as = outcome;
      i = next;
    } else {
      throw new Error(`Unknown flag for \`mla enrich resolve\`: ${a}`);
    }
  }
  if (!flags.runId) throw new Error("--run-id is required (the id printed by `mla enrich plan`)");
  // Half a verdict is not a verdict. Naming a finding without an outcome would silently degrade to
  // the review (resolving nothing while looking like it did), and naming an outcome without a
  // finding has no subject: a three-way answer is meaningless until you say what it answers.
  if (flags.finding && !flags.as) {
    throw new Error(`--finding also requires --as <${FINDING_RESOLUTIONS.join("|")}> (which answer this finding gets)`);
  }
  if (flags.as && !flags.finding) {
    throw new Error("--as also requires --finding <id-prefix> (which finding this answers)");
  }
  if (flags.team && flags.personal) {
    throw new Error("pass either --team or --personal, not both (they are the two authority planes)");
  }
  return flags;
}

// One finding's line in the review. The QUOTE leads, because the quote is the half the CLI proved
// and the half the human is being asked about; the generated statement is not printed here at all.
function renderFindingRow(record: OnboardingCandidateRecord): string[] {
  const inc = record.inconsistency!;
  const short = record.candidateId.slice(0, CANDIDATE_ID_DISPLAY_LEN);
  const commit = record.evidence.find((e) => e.type === "commit");
  const scope = terminalSafe(inc.claimScope, DISPLAY_LEN.scope);
  const quote = quoted(inc.claimText, DISPLAY_LEN.quote);
  const status = terminalSafe(inc.divergence.status, DISPLAY_LEN.status);
  const path = terminalSafe(inc.divergence.path, DISPLAY_LEN.path);
  const from = inc.divergence.renamedFrom ? terminalSafe(inc.divergence.renamedFrom, DISPLAY_LEN.path) : "";
  const lines = [
    `  ${short}  ${scope} says: ${quote}`,
    `                but ${status} ${path}` +
      (from ? ` (from ${from})` : "") +
      (commit && commit.type === "commit" ? ` in ${commit.commit.slice(0, 12)}` : ""),
  ];
  // "last changed by", not "last wrote": blame names whoever last TOUCHED the anchored range,
  // which may be whoever reflowed the paragraph. Putting a name on authorship git never claimed
  // is a small lie printed under a rule someone is about to sign.
  // An empty name after sanitizing means the commit header held nothing printable; the line is
  // dropped rather than rendered blank, because "last changed by" with nothing after it reads as
  // a person the CLI failed to load.
  const author = inc.attribution?.authorName ? terminalSafe(inc.attribution.authorName, DISPLAY_LEN.author) : "";
  if (author) {
    lines.push(`                last changed by ${author}`);
  }
  return lines;
}

// The read-only review a bare `mla enrich resolve --run-id <id>` prints. Pure (no fs) and exported
// so a test pins the wording. Nothing is minted, written, or closed in this mode.
export function renderResolveReview(
  runId: string,
  open: readonly OnboardingCandidateRecord[],
  resolved: readonly OnboardingCandidateRecord[],
): string {
  if (!runId.trim()) {
    throw new Error(
      "renderResolveReview: runId is required to render runnable next-step commands (unresolved argument)",
    );
  }
  const lines: string[] = [];
  if (open.length === 0) {
    lines.push(
      resolved.length > 0
        ? `Every finding from run ${runId} is resolved (${resolved.length} closed).`
        : NO_FILE_OPERATION_FINDINGS,
    );
  } else {
    lines.push(
      `${open.length} open finding${open.length === 1 ? "" : "s"} from run ${runId} ` +
        "(a document and a commit appear inconsistent; neither is assumed right):",
    );
    for (const r of open) lines.push(...renderFindingRow(r));
  }
  if (resolved.length > 0 && open.length > 0) {
    lines.push("");
    lines.push(`${resolved.length} already resolved:`);
    for (const r of resolved) {
      lines.push(`  ${r.candidateId.slice(0, CANDIDATE_ID_DISPLAY_LEN)}  ${r.resolution!.outcome}`);
    }
  }
  if (open.length > 0) {
    const first = open[0].candidateId.slice(0, CANDIDATE_ID_DISPLAY_LEN);
    lines.push("");
    lines.push("The document was right, the change broke it:");
    lines.push(`  mla enrich resolve --run-id ${runId} --finding ${first} --as code_diverged`);
    lines.push("    Mints the quoted sentence as a rule. Your choice IS the approval; there is no second prompt.");
    lines.push("The change was right, the document is out of date:");
    lines.push(`  mla enrich resolve --run-id ${runId} --finding ${first} --as doc_stale`);
    lines.push("Both were right, this one was a deliberate exception:");
    lines.push(`  mla enrich resolve --run-id ${runId} --finding ${first} --as carve_out`);
    lines.push("Preview without minting:   add --dry-run");
    lines.push("Enforce workspace-wide:    add --team (default is PERSONAL: it enforces for you alone)");
  }
  return lines.join("\n");
}

// The typed decision the review hands the agent under machine mode. One request per finding, and
// the FIRST open one: the three options are verdicts on a specific disagreement, so a request that
// spanned several findings would offer an answer to a question it had not asked. Returns undefined
// when nothing is open, so the envelope carries no request.
function buildResolveDecisionRequest(
  runId: string,
  open: readonly OnboardingCandidateRecord[],
): DecisionRequest | undefined {
  if (open.length === 0) return undefined;
  const target = open[0];
  const inc = target.inconsistency!;
  const label: Record<FindingResolution, string> = {
    // The kind the mint will actually use, not the record's stored copy: an old sidecar may name
    // a kind this version no longer mints, and a prompt that promises one is a lie to the human.
    code_diverged: `The document is right: mint ${quoted(inc.claimText, DISPLAY_LEN.quote)} as a ${FINDING_PROPOSED_RULE_KIND}`,
    doc_stale: "The change is right: the document is out of date",
    carve_out: "Both were right: this change was a deliberate exception",
  };
  const options: DecisionOption[] = FINDING_RESOLUTIONS.map((outcome) => ({
    id: outcome,
    label: label[outcome],
    selection: { mode: "resolve", candidate_id: target.candidateId, resolution: outcome },
  }));
  options.push({ id: "none", label: "Leave this finding open", selection: { mode: "none" } });
  return {
    kind: "enrich.resolve",
    subject: { run_id: runId },
    prompt:
      `${terminalSafe(inc.claimScope, DISPLAY_LEN.scope)} says ` +
      `${quoted(inc.claimText, DISPLAY_LEN.quote)}, and commit ` +
      `${target.evidence.find((e) => e.type === "commit")?.commit.slice(0, 12) ?? "(unknown)"} ` +
      `${terminalSafe(inc.divergence.status, DISPLAY_LEN.status)} ` +
      `${terminalSafe(inc.divergence.path, DISPLAY_LEN.path)} anyway. Which one is right?` +
      (open.length > 1 ? ` (${open.length - 1} more open after this one.)` : ""),
    options,
  };
}

const isFinding = (c: OnboardingCandidateRecord): boolean =>
  c.kind === RECONCILIATION_FINDING_KIND && !!c.inconsistency;

/**
 * What answering a finding does, given what is already recorded on it. Three transitions, named:
 *
 *   perform    nothing is recorded. Mint (if the verdict mints), write, stamp. Exactly once.
 *   settled    the SAME verdict is already recorded. Do nothing at all, and say so.
 *   conflict   a DIFFERENT verdict is recorded. Refuse; the first answer stands.
 *
 * `settled` is the transition worth naming. With only the conflict guard in place a repeat fell
 * through the entire body: it re-entered the mint (a network call), re-wrote the projection, and
 * re-stamped `resolvedAt` from the clock, silently moving WHEN the decision was recorded. Retrying
 * a command that already succeeded (a dropped connection, a re-run script, an agent replaying its
 * own transcript) is normal, and it must not rewrite the audit trail. So the repeat is a no-op
 * rather than a second execution that happens to be harmless.
 *
 * Total in both arguments, so a fourth resolution or a fourth state cannot slip through unhandled.
 */
export type ResolveTransition =
  | { kind: "perform" }
  | { kind: "settled"; resolution: FindingResolutionRecord }
  | { kind: "conflict"; resolution: FindingResolutionRecord };

export function resolveTransition(
  recorded: FindingResolutionRecord | undefined,
  asked: FindingResolution,
): ResolveTransition {
  if (!recorded) return { kind: "perform" };
  return recorded.outcome === asked
    ? { kind: "settled", resolution: recorded }
    : { kind: "conflict", resolution: recorded };
}

/**
 * `mla enrich resolve`: close one doc/code finding with one of three answers.
 *
 * A finding is a QUESTION, not a rule, which is why it never appears in `enrich accept`'s durable
 * list. `code_diverged` is the only answer that mints, and it mints through the SAME
 * materializeRules -> mintAndDeliverRules path accept uses: findingToRuleCandidate projects the
 * finding into an ordinary candidate carrying the CLI-VERIFIED quote as its statement and the
 * proposed kind as its kind, and isDurableRuleKind gates it on the far side exactly as before.
 * There is no second authority path and no second approval: the human's selection IS the approval.
 */
export async function runEnrichResolve(argv: string[], deps: EnrichAcceptDeps = {}): Promise<number> {
  const command = getMachineCommand() ?? "enrich.resolve";

  let flags: ResolveFlags;
  try {
    flags = parseResolveArgs(argv);
  } catch (e) {
    return failInMode(command, "usage_error", (e as Error).message, 2);
  }

  let cfg: KbCliConfig;
  try {
    cfg = readKbConfig(flags.workspace);
  } catch (e) {
    return failInMode(command, "config_error", (e as Error).message, 2);
  }

  // A run that persisted nothing writes no sidecar, and the onboarding skill sends the agent
  // through this review regardless: run it, and if it lists nothing, say the one scoped line.
  // Reporting that run's honest zero as an error taught the agent to say the run FAILED, which
  // is a second false statement about a run that worked. The plan record is the discriminator:
  // present means the run happened and had nothing to persist, absent means the id is wrong.
  // Standing in an empty sidecar (rather than branching) keeps ONE review path: the renderer,
  // the machine envelope, and the "no finding id starts with" refusal all stay exactly as they
  // are, and a verdict against a run with no findings is still an invalid selection.
  let sidecar = loadCandidatesSidecar(HOME, cfg.workspaceId, flags.runId!);
  if (!sidecar) {
    const record = loadRunRecord(HOME, cfg.workspaceId, flags.runId!);
    if (!record) {
      return failInMode(
        command,
        "unknown_run",
        `no onboarding run ${flags.runId} in workspace ${cfg.workspaceId}. ` +
          "Run `mla enrich plan` and `mla enrich ingest` first, from the same workspace.",
        2,
      );
    }
    sidecar = {
      schemaVersion: 1,
      workspaceId: cfg.workspaceId,
      runId: record.runId,
      repositoryRoot: record.repositoryRoot,
      updatedAt: record.createdAt,
      candidates: [],
    };
  }

  const findings = sidecar.candidates.filter(isFinding);
  const open = findings.filter((c) => !c.resolution);
  const resolved = findings.filter((c) => c.resolution);

  // No verdict: read-only review. Print what is open, close nothing.
  if (!flags.finding) {
    const reviewPayload = {
      runId: sidecar.runId,
      repositoryRoot: sidecar.repositoryRoot,
      open: open.map((c) => ({
        candidateId: c.candidateId,
        claimText: c.inconsistency!.claimText,
        claimScope: c.inconsistency!.claimScope,
        claimClass: c.inconsistency!.claimClass,
        proposedRuleKind: FINDING_PROPOSED_RULE_KIND,
        divergence: c.inconsistency!.divergence,
        attribution: c.inconsistency!.attribution,
      })),
      resolved: resolved.map((c) => ({ candidateId: c.candidateId, ...c.resolution! })),
    };
    if (isMachineMode()) {
      return emitEnvelope(
        successEnvelope(command, reviewPayload, {
          decisionRequest: buildResolveDecisionRequest(sidecar.runId, open),
          humanSummary:
            open.length === 0
              ? // The same scoped sentence the human review prints. "No open doc/code findings"
                // is a claim about the repository that this run never examined, and an agent
                // relaying it to its user would widen it further, not narrow it.
                NO_FILE_OPERATION_FINDINGS
              : `${open.length} open finding${open.length === 1 ? "" : "s"}: a document and a commit ` +
                "appear inconsistent. Nothing is decided until you answer.",
        }),
        0,
      );
    }
    if (flags.json) {
      console.log(JSON.stringify(reviewPayload, null, 2));
    } else {
      console.log(renderResolveReview(sidecar.runId, open, resolved));
    }
    return 0;
  }

  // A verdict. Resolve the prefix fail-closed against the FINDINGS only: a prefix that matches a
  // durable rule is not "no match", it is the wrong verb, and saying so beats "no candidate id".
  const matches = findings.filter((c) => c.candidateId.toLowerCase().startsWith(flags.finding!));
  if (matches.length === 0) {
    const elsewhere = sidecar.candidates.some((c) => c.candidateId.toLowerCase().startsWith(flags.finding!));
    return failInMode(
      command,
      "invalid_selection",
      elsewhere
        ? `refusing to resolve: "${flags.finding}" is a candidate in this run but not a finding. ` +
            "Durable rules are accepted with `mla enrich accept`, not resolved."
        : `refusing to resolve: no finding id starts with "${flags.finding}" in this run`,
      2,
    );
  }
  if (matches.length > 1) {
    return failInMode(
      command,
      "invalid_selection",
      `refusing to resolve: finding id prefix "${flags.finding}" is ambiguous (matches ${matches.length}); use more characters`,
      2,
    );
  }
  const target = matches[0];
  const short = target.candidateId.slice(0, CANDIDATE_ID_DISPLAY_LEN);
  const transition = resolveTransition(target.resolution, flags.as!);

  // Re-resolving DIFFERENTLY is refused rather than overwritten: the first answer already minted
  // (or explicitly did not), and silently replacing it would leave a rule live under a verdict that
  // no longer says it should be.
  if (transition.kind === "conflict") {
    return failInMode(
      command,
      "already_resolved",
      `refusing to resolve: finding ${short} is already resolved as ${transition.resolution.outcome}. ` +
        "Re-run `mla enrich plan` to re-surface it if the repository has changed.",
      2,
    );
  }

  // The same answer twice is one decision, not two. Nothing mints, nothing is written, and the
  // recorded time stays exactly where the first answer put it. Reported as a success (the caller
  // asked for a state the system is already in) that is explicit about having changed nothing.
  // `--dry-run` lands here too: a settled finding has no future run to preview.
  if (transition.kind === "settled") {
    const settled = transition.resolution;
    const settledPayload = {
      runId: sidecar.runId,
      repositoryRoot: sidecar.repositoryRoot,
      findingId: target.candidateId,
      resolution: settled.outcome,
      resolvedAt: settled.resolvedAt,
      unchanged: true,
      dryRun: flags.dryRun,
      authorityScope: flags.team ? "TEAM" : ("PERSONAL" as RuleAuthorityScope),
      minted: [],
      alreadyLive: [],
      delivered: false,
      deliveryError: null,
    };
    if (isMachineMode()) return emitEnvelope(successEnvelope(command, settledPayload), 0);
    if (flags.json) {
      console.log(JSON.stringify(settledPayload, null, 2));
      return 0;
    }
    console.log(`${short} is already resolved as ${settled.outcome} (${settled.resolvedAt}). Nothing changed.`);
    if (settled.outcome === "code_diverged") {
      // The projection is not the authority, so a missing or edited file is not a governance hole
      // and re-resolving is not how it is repaired. Name the verb that actually re-delivers.
      console.log("The rule is live on the authority; `mla scan` re-delivers it to this machine.");
    }
    return 0;
  }

  const outcome = flags.as!;
  const authorityScope: RuleAuthorityScope = flags.team ? "TEAM" : "PERSONAL";
  let mintOutcomes: MintOutcome[] = [];
  let delivered = false;
  let deliveryError: string | null = null;
  let materialized: MaterializeResult | null = null;

  // `code_diverged` is the ONLY answer that touches the authority. The other two record a verdict.
  let mintedKind: ProposedRuleKind | null = null;
  if (outcome === "code_diverged") {
    const ruleCandidate = findingToRuleCandidate(target);
    if (!ruleCandidate) {
      return failInMode(
        command,
        "invalid_selection",
        `refusing to mint: finding ${target.candidateId.slice(0, CANDIDATE_ID_DISPLAY_LEN)} carries no verified claim`,
        2,
      );
    }
    mintedKind = ruleCandidate.kind as ProposedRuleKind;
    const managedPath = join(sidecar.repositoryRoot, MANAGED_RULES_PATH);
    materialized = materializeRules(readManagedFile(managedPath), [ruleCandidate]);

    if (materialized.materialized.length > 0 && !flags.dryRun) {
      const minted = await mintAndDeliverRules(
        materialized.materialized,
        {
          verb: "resolve",
          command,
          team: flags.team,
          yes: flags.yes,
          workspace: flags.workspace,
          repositoryRoot: sidecar.repositoryRoot,
        },
        deps,
      );
      if (!minted.ok) return minted.exitCode;
      mintOutcomes = minted.outcomes;
      delivered = minted.delivered;
      deliveryError = minted.deliveryError;
    }
    if (materialized.changed && !flags.dryRun) writeManagedFile(managedPath, materialized.text);
  }

  // Stamp the verdict LAST, and never on a dry run: a finding recorded as closed while its rule
  // never reached the authority is the one state this ordering makes unreachable.
  let resolvedAt: string | null = null;
  if (!flags.dryRun) {
    const resolution: FindingResolutionRecord = {
      outcome,
      resolvedAt: new Date().toISOString(),
      // The kind that was actually minted, read off the candidate the mint ran on rather than
      // off the finding, so the audit cannot describe a kind the mint did not use.
      ...(outcome === "code_diverged" && mintOutcomes.length > 0 && mintedKind
        ? { mintedRuleKind: mintedKind }
        : {}),
    };
    try {
      upsertCandidatesSidecar(HOME, {
        ...sidecar,
        updatedAt: new Date().toISOString(),
        candidates: [{ ...target, resolution }],
      });
      resolvedAt = resolution.resolvedAt;
      // The verdict row (design §9). Emitted HERE, inside the success branch of the stamp, so
      // the metric plane can only ever learn about a closure the sidecar actually recorded: a
      // dry run emits nothing (it decided nothing) and a failed stamp emits nothing (the
      // finding is still open). `carve_out` counted from these rows IS the kill metric.
      emitOnboardingFinding(
        {
          candidateId: target.candidateId,
          verdict: outcome,
          mintedRule: mintOutcomes.some((o) => o.status === "minted"),
        },
        {
          workspaceId: cfg.workspaceId,
          sessionId: (process.env.CLAUDE_CODE_SESSION_ID || "").trim() || null,
          nowMs: Date.now(),
        },
      );
    } catch (e) {
      // The other half already committed and is durable. Report the state that actually exists
      // rather than crashing on an unhandled write error, and name the recovery: re-running the
      // SAME verdict is a `perform` (nothing is recorded yet), the mint dedups on payload hash,
      // and the stamp is retried. That is the accept path's idempotency, reused verbatim.
      return failInMode(
        command,
        "resolution_not_recorded",
        `finding ${short} could NOT be recorded as ${outcome}: ${(e as Error).message}. ` +
          (mintOutcomes.length > 0
            ? "The rule IS live on the authority. The finding is still open. Re-run the same " +
              "command to close it (an already live rule is never minted twice)."
            : "The finding is still open. Re-run the same command to close it."),
        1,
      );
    }
  }

  const minted = mintOutcomes.filter((o) => o.status === "minted");
  const alreadyLive = mintOutcomes.filter((o) => o.status === "already_live");
  const resolvePayload = {
    runId: sidecar.runId,
    repositoryRoot: sidecar.repositoryRoot,
    findingId: target.candidateId,
    resolution: outcome,
    // Both halves of "what state is this finding in now", so a caller never has to infer that a
    // command it ran twice only did work once. `unchanged` is always present, never inferred
    // from a missing key.
    resolvedAt,
    unchanged: false,
    dryRun: flags.dryRun,
    authorityScope,
    minted: minted.map((o) => ({ ruleId: o.ruleId, hash: o.hash, statement: o.rule.statement })),
    alreadyLive: alreadyLive.map((o) => ({ hash: o.hash, statement: o.rule.statement })),
    delivered,
    deliveryError,
  };

  if (isMachineMode()) return emitEnvelope(successEnvelope(command, resolvePayload), 0);
  if (flags.json) {
    console.log(JSON.stringify(resolvePayload, null, 2));
    return 0;
  }
  console.log(renderResolveOutcome(target, outcome, flags.dryRun));
  if (materialized) {
    console.log(
      renderMintSummary(minted, alreadyLive, authorityScope, materialized.materialized.length, flags.dryRun, {
        delivered,
        deliveryError,
      }),
    );
  }
  return 0;
}

// What resolving DID, in the operator's words. Each answer says what it changed and, just as
// importantly, what it did not: a verdict that quietly touched nothing reads as a failed command.
function renderResolveOutcome(
  target: OnboardingCandidateRecord,
  outcome: FindingResolution,
  dryRun: boolean,
): string {
  const short = target.candidateId.slice(0, CANDIDATE_ID_DISPLAY_LEN);
  const would = dryRun ? "Would resolve" : "Resolved";
  switch (outcome) {
    case "code_diverged":
      return `${would} ${short} as code_diverged: the document was right, and its sentence is now a rule.`;
    case "doc_stale":
      return (
        `${would} ${short} as doc_stale: the change was right and ` +
        `${terminalSafe(target.inconsistency!.claimScope, DISPLAY_LEN.scope)} is out of date. ` +
        "Nothing was minted. Update the document itself; this only records the verdict."
      );
    case "carve_out":
      return `${would} ${short} as carve_out: a deliberate exception. Nothing was minted, and the finding is closed.`;
    default:
      return assertNever(outcome, "renderResolveOutcome");
  }
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
    case "accept":
      return runEnrichAccept(rest);
    case "resolve":
      return runEnrichResolve(rest);
    default:
      console.error(`unknown \`mla enrich\` subcommand: ${sub}\n`);
      console.error(USAGE);
      return 2;
  }
}
