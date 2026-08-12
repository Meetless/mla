// src/commands/status.ts
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readScanCache, readDeliveryReceipt } from "../lib/scanner/cache";
import { type ScanResult } from "../lib/scanner/types";
import { ageLabel } from "../lib/age";
import { readScanCacheForRoot, resolveScanRootIdentity } from "./scan-context";
import { findWorkspaceContext, resolveWorkspaceIdWithEnv } from "../lib/workspace";
import { CliConfig, HOOKS_DIR, readConfig } from "../lib/config";
import { get } from "../lib/http";
import {
  isWorkspaceAccessDenied,
  workspaceAccessDeniedMessage,
} from "../lib/workspace-access";

const NOT_ACTIVATED = "Meetless is not activated for this repo. Run `mla activate`.";

export interface StatusView {
  // undefined = the cache module resolves the state root (it honors MEETLESS_HOME).
  home: string | undefined;
  workspaceId: string;
  hooksInstalled: boolean;
  // The checkout `status` is describing. OPTIONAL, and its absence is meaningful:
  // the delivery receipt is keyed by WORKSPACE, and one workspace is routinely bound
  // by several markers (this repo binds one from three: the umbrella, meetless/, and
  // intel/). Without a root to compare the receipt's `cwd` against, a receipt cannot
  // be attributed to the caller's checkout, and an unattributable delivery line is
  // worse than none: it would credit this folder with a sibling's turn. Callers that
  // cannot say where they are get no delivery line at all.
  repoRoot?: string;
  // Optional pre-read scan cache. When omitted, renderStatus reads it from disk
  // (the behaviour specs rely on). runStatus reads it once to decide whether to
  // probe membership, then passes it here so the file is not read twice.
  cache?: ReturnType<typeof readScanCache>;
}

// The OBSERVED half of status: what the last turn actually delivered in THIS checkout.
//
// Everything else `status` prints is read out of configuration, which is why the audit
// (§2.2) found six of eight states indistinguishable: hook never installed, hook firing
// from a sibling checkout, hook firing and delivering nothing, and hook working all
// render the same configured counts. hook-receipt.json is the one artifact that settles
// it, because the bash hook writes it on EVERY arm, including the ones where the
// assembler never runs (the fallback, the fail-closed block, and the inject-nothing arm).
//
// Strictly observational. Nothing here changes an exit code or grades a state as
// failing. An old receipt means "last seen then", not "broken": the user may simply not
// have worked in this repo today, and there is no cadence to compare against. `doctor`
// owns verdicts; `status` reports.
//
// Returns null when nothing can be said HONESTLY, which is a real answer and not a
// fallback: no root to attribute against, or a receipt written before delivery
// accounting existed (its counts would read as zero and zero is a claim).
function renderObservedDelivery(view: StatusView): string | null {
  if (!view.repoRoot) return null;
  const receipt = readDeliveryReceipt(view.home, view.workspaceId);
  if (!receipt) {
    return (
      "last delivery: no delivery observed in this repo yet " +
      "(the hook writes a receipt on its first turn)."
    );
  }
  const age = ageLabel(receipt.at, new Date());

  // Attribute before reporting. The receipt is keyed by workspace, not by root, so a
  // sibling checkout of the same workspace overwrites it. Reporting its counts here
  // would credit this folder with a turn it never had.
  if (receipt.cwd && !sameRoot(receipt.cwd, view.repoRoot)) {
    return (
      `last delivery: ${age}, but from another checkout (${receipt.cwd}). ` +
      "Nothing observed for this one yet."
    );
  }

  // Pre-accounting receipt: it recorded no counts, so it cannot answer the question.
  if (typeof receipt.floorRules !== "number") {
    return `last delivery: ${age}, by an older hook that recorded no counts (run \`mla wire\`).`;
  }

  // The pull_only control arm injects nothing deliberately. doctor grades this info;
  // status must not contradict it by rendering it as a shortfall.
  if (receipt.path === "none") {
    return `last delivery: ${age}, injected nothing by design (${receipt.reason ?? "no_injection_this_turn"}).`;
  }

  if (receipt.delivery !== "emitted") {
    return (
      `last delivery: ${age}, NO floor rules reached the model` +
      (receipt.reason ? ` (${receipt.reason})` : "") +
      "."
    );
  }

  const scopedPart =
    typeof receipt.scopedRules === "number" ? ` + ${receipt.scopedRules} scoped` : "";
  return (
    `last delivery: ${age}, ${receipt.floorRules} floor${scopedPart} rules delivered` +
    (receipt.degraded ? ` (degraded: ${receipt.degraded})` : "") +
    "."
  );
}

// Does a receipt written from `receiptCwd` belong to the checkout rooted at `root`?
//
// CONTAINMENT, not equality. The hook records `cwd: $PWD` (the raw working directory,
// see emit_delivery_receipt) while `status` resolves a repo ROOT, so anyone who starts
// their agent from a subdirectory produces a receipt sitting below the root. An equality
// test would tell that majority their own delivery came from "another checkout".
//
// The separator boundary is what keeps containment from over-matching: `/repo/here` must
// not swallow the sibling `/repo/here-other`, which a bare `startsWith` would.
//
// Deliberately a normalized-string compare rather than a realpath resolve: the receipt's
// cwd is often a directory that no longer exists (the scratchpad roots that poisoned the
// scan cache twice both vanished), and realpath on a missing path throws. A false
// "another checkout" is a quiet, honest miss; a throw would take out the whole command.
function sameRoot(receiptCwd: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  const a = norm(receiptCwd);
  const b = norm(root);
  return a === b || a.startsWith(`${b}/`);
}

export function renderStatus(view: StatusView): string {
  const cache =
    view.cache !== undefined ? view.cache : readScanCache(view.home, view.workspaceId);
  if (!cache) {
    return NOT_ACTIVATED;
  }
  // What is actually INJECTED is the floor, not the directive count. A directive scanned out of
  // an instruction file is not a floor rule: the floor filter also requires the directive to be
  // bundle-sourced (scan.ts isBundleSourced), because the agent already loads CLAUDE.md itself
  // and re-injecting it would spend the context window on bytes the model has.
  //
  // Printing `directives.length` as "confirmed rules injected on every prompt" therefore claimed
  // delivery that provably never happened: a clean-room run drove the real UserPromptSubmit hook
  // on a workspace this line called "4 confirmed rules injected" and the returned
  // additionalContext carried ZERO of them
  // (notes/20260807-mla-activation-onboarding-audit.md §1.2 Finding B). `activate` said the
  // opposite in the same session. A status surface that overclaims is worse than a silent one,
  // because it sends the user looking for a bug somewhere else.
  //
  // Undefined (not zero) on a pre-v2 cache that predates delivery accounting; the two must not
  // collapse, so that case reports what it can prove and names the re-scan.
  const floor = cache.floorRules?.length;
  const scoped = cache.scopedRules?.length ?? 0;
  const scanned = cache.directives.length;
  const pending = cache.staleSignals.length;
  // `?? 0` guards a pre-M1 on-disk cache that predates the agentMemoryRules field.
  const advisory = cache.inventory.agentMemoryRules ?? 0;
  const hooks = view.hooksInstalled ? "hooks installed" : "hooks NOT installed (run `mla wire`)";
  const delivery =
    floor === undefined
      ? `${plural(scanned, "directive")} scanned; run \`mla scan\` for delivery accounting.`
      : floor > 0
        ? // CONFIGURED, not observed. `floorRules.length` is a fact about a file on
          // disk: it says these rules are eligible to be injected, and says nothing
          // about whether any turn carried them. Calling it "injected on every
          // prompt" is the same promotion of configuration into delivery that made
          // the scanned-directive count a lie, one field further along. The observed
          // half is the `last delivery` line below, sourced from the hook's receipt.
          `${plural(floor, "governed floor rule")} configured for injection` +
          (scoped > 0 ? `, ${plural(scoped, "scoped rule")} when the turn matches.` : ".")
        : `No governed rules injected yet (${plural(scanned, "directive")} scanned from ` +
          `instruction files, which your agent already loads itself). Run the \`/mla onboard\` ` +
          `skill to propose some from this repository.`;
  const observed = renderObservedDelivery(view);
  const lines = [
    `Meetless is active for workspace ${view.workspaceId} (${hooks}).`,
    `  ${delivery}`,
    ...(observed ? [`  ${observed}`] : []),
    `  ${plural(pending, "pending review item")} (mla context list).`,
    `  inventory: ${cache.inventory.instructionFiles} instruction files, ` +
      `${cache.inventory.decisionDocs} docs, ${cache.inventory.legacyNotes} notes.`,
  ];
  // Advisory agent-memory rules are machine_inferred and NOT injected (never must-follow);
  // surface them only when present, so a fresh repo with none stays quiet (no spam).
  if (advisory > 0) {
    lines.push(`  ${plural(advisory, "advisory rule")} from agent memory (pending review; not injected).`);
  }
  return lines.join("\n");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Thin wrapper kept for local readability; delegates to the shared resolver
// in src/lib/workspace.ts (env override first, then .meetless.json marker walk).
function resolveWorkspaceId(): string | undefined {
  return resolveWorkspaceIdWithEnv();
}

// The one line a linked worktree earns (D1). This directory has no marker of
// its own; the binding was inherited from the origin checkout of the worktree,
// and the operator has to be able to see that without running `mla doctor`.
// Names what did NOT come with it, because the checkout keeps its own scan root
// and runtime scope, which is exactly why `mla status` may report no scan here.
// Pure so the wording is pinned by a unit test; returns null on every ordinary
// binding.
export function inheritedBindingLine(cwd?: string): string | null {
  const ctx = findWorkspaceContext(cwd ?? process.cwd());
  if (!ctx || ctx.via !== "worktree") return null;
  return (
    `This is a linked git worktree with no .meetless.json of its own; the workspace ` +
    `binding is inherited from its origin checkout (${ctx.markerDir}).\n` +
    `  Workspace binding only: this checkout keeps its own scan root, rules and runtime scope.`
  );
}

function detectHooksInstalled(): boolean {
  try {
    return existsSync(join(HOOKS_DIR, "user-prompt-submit.sh"));
  } catch {
    return false;
  }
}

// Status-framed message for a bound-but-not-a-member repo (BUG-6 Issue 1). Leads
// with the SAME canonical membership line the rest of the CLI emits (BUG-5), then
// adds the piece status uniquely knows: this repo IS bound, so `mla activate`
// cannot fix it. This is what separates "activated but not a member of X" from
// the "not activated" copy the operator would otherwise see and loop on.
export function notMemberStatusMessage(e: unknown, workspaceId: string): string {
  return (
    `${workspaceAccessDeniedMessage(e, workspaceId)}\n` +
    `This repo is bound to that workspace (.meetless.json), so \`mla activate\` ` +
    `will keep failing until you are added.`
  );
}

// A scan cache exists for this workspace, but another checkout owns it.
//
// `readScanCacheForRoot` returns null for two structurally different reasons and status used
// to collapse both into NOT_ACTIVATED: (a) nothing was ever scanned, where that copy is true,
// and (b) the workspace-global slot carries ANOTHER root's stamp, where it is a lie. Case (b)
// is the 2026-07-28 / 2026-08-02 signature, and it is the case where the operator most needs
// the truth: `mla activate` already succeeded here and running it again changes nothing.
//
// `mla doctor` has named this state correctly since ruleDeliveryDoctorChecks landed; this is
// the same classification on the surface an operator actually reaches for first.
//
// Deliberately precise about the blast radius. The hot-path hook reads `.floorRulesXml` out of
// the workspace-global slot with jq and no root check (hooks-template/user-prompt-submit.sh),
// so the floor still reaches every prompt from here; what is missing is the repo-specific half.
// "Meetless is delivering nothing" would be its own false alarm.
export function foreignRootStatusMessage(
  workspaceId: string,
  root: string,
  globalCache: ScanResult,
  now: Date,
): string {
  const owner = globalCache.scanRootPath ?? "an unstamped scan";
  const gone = globalCache.scanRootPath && !existsSync(globalCache.scanRootPath);
  return [
    `Meetless is activated for workspace ${workspaceId}, but no scan belongs to this checkout.`,
    `  this checkout: ${root}`,
    `  cache owner:   ${owner} (${ageLabel(globalCache.generatedAt, now)}` +
      `${gone ? ", directory no longer exists" : ""})`,
    `  Floor rules still reach every prompt (they are workspace-global). This checkout's`,
    `  scoped rules, inventory and review items do not.`,
    "  Run `mla scan` from this directory to claim a slot for it.",
  ].join("\n");
}

// Best-effort membership probe against control for the no-cache branch. Returns
// the status-framed non-member message when control DEFINITIVELY denies access
// to the bound workspace (403 WORKSPACE_ACCESS_DENIED), else null: a member, or
// the probe simply could not run (no user-token session, control unreachable,
// stale token, any non-membership error). status must never fail or hang on the
// common local case, so anything inconclusive falls back to the activate hint.
//
// Only user-token sessions are probed: shared-key / none carry no per-user
// membership to check, and CI paths should not pay a network round-trip here.
async function probeMembershipDenied(workspaceId: string): Promise<string | null> {
  let cfg: CliConfig;
  try {
    cfg = readConfig();
  } catch {
    // readConfig throws by design when MEETLESS_CONTROL_TOKEN shadows a
    // user-token login; status must not crash on it.
    return null;
  }
  if (cfg.auth.mode !== "user-token") return null;

  const actorUserId = (cfg.actorUserId || "").trim();
  const path = actorUserId
    ? `/internal/v1/whoami?workspaceId=${encodeURIComponent(workspaceId)}&actorUserId=${encodeURIComponent(actorUserId)}`
    : `/internal/v1/whoami?workspaceId=${encodeURIComponent(workspaceId)}`;
  try {
    await get(cfg, path, 6000);
    return null; // 200 -> the session IS a member of this workspace.
  } catch (e) {
    if (isWorkspaceAccessDenied(e)) {
      return notMemberStatusMessage(e, workspaceId);
    }
    // 401 / network / control down / workspace-not-found: inconclusive, don't
    // block status. Fall through to the local activate hint.
    return null;
  }
}

export async function runStatus(_argv: string[]): Promise<number> {
  const workspaceId = resolveWorkspaceId();
  if (!workspaceId) {
    console.log(NOT_ACTIVATED);
    return 0;
  }
  // D1: an inherited binding is never silent. Printed BEFORE the status body so
  // the operator reads "where did this workspace come from" before they read
  // anything attributed to it. Diagnostic only; nothing below branches on it.
  const inherited = inheritedBindingLine();
  if (inherited) console.log(inherited);
  const home = undefined; // let the cache module resolve the state root (it honors MEETLESS_HOME)
  // Guarded read: a scan cache stomped by ANOTHER checkout of this same workspace must read as
  // "no scan for THIS repo" (its commitSha/inventory/stale signals belong to the other checkout),
  // so the operator is steered to re-activate here rather than shown a sibling repo's status.
  const cache = readScanCacheForRoot(home, workspaceId);
  if (!cache) {
    // No local scan for this bound workspace. Before advising `mla activate`,
    // make sure the workspace is actually usable: a marker can name a workspace
    // the operator is not a member of (activate 403'd, or access was later
    // revoked), and "run mla activate" would just loop on the same denial.
    const denied = await probeMembershipDenied(workspaceId);
    if (denied) {
      console.error(denied);
      return 1;
    }
    // Before falling back to the activate hint, separate "never scanned" from "scanned, but
    // by a sibling checkout". Only the first one is a not-activated repo.
    const globalCache = readScanCache(home, workspaceId);
    if (globalCache) {
      console.log(
        foreignRootStatusMessage(workspaceId, resolveScanRootIdentity(), globalCache, new Date()),
      );
      return 0;
    }
    console.log(NOT_ACTIVATED);
    return 0;
  }
  const hooksInstalled = detectHooksInstalled();
  // resolveScanRootIdentity() is the same root the scan-cache guard keys on, so the
  // delivery line is attributed by exactly the rule the rest of the repo-scoped reads
  // already use rather than a second, divergent notion of "this checkout".
  console.log(
    renderStatus({
      home,
      workspaceId,
      hooksInstalled,
      cache,
      repoRoot: resolveScanRootIdentity(),
    }),
  );
  return 0;
}
