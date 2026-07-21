/**
 * `mla _internal enforcement-baseline`  — snapshot the forbidden roots at SessionStart.
 * `mla _internal posttool-sweep`        — after every tool call, revert anything that
 *                                          appeared under a forbidden root.
 *
 * Together these are the enforcement BACKSTOP. The PreToolUse gate stops the write it
 * can see; this catches the write it cannot. It never inspects the tool name or its
 * arguments, so no amount of shell cleverness routes around it: it only asks whether a
 * file appeared where the team said none may exist, and if one did, it removes it.
 *
 * DORMANT AT THE SHIPPED CEILING. Reverting a file requires a DENY session ceiling, and
 * we ship WARN (owner ruling, 2026-07-12: "we will only ship warn and never block"). Out
 * of the box both entry points below are no-ops that emit `{}`. Only an operator who has
 * explicitly set MEETLESS_ACTION_INTERCEPT_MAX=deny gets the backstop, and gets it having
 * asked for it.
 *
 * Fail-open, always. Every failure path (no principal, no bundle, unreadable baseline,
 * any throw) emits the empty `{}` body and exit 0: a broken sweep must never wedge a
 * session. The cost of that choice is stated on the benchmark page rather than hidden.
 */
import { HOME } from "../lib/config";
import { readRuleBundleCache, type BundlePrincipal } from "../lib/rules/bundle-cache";
import { resolveBundlePrincipal } from "../lib/rules/bundle-principal";
import {
  baselinePath,
  readBaseline,
  snapshotRoots,
  sweep,
  writeBaseline,
  type SweepBaseline,
} from "../lib/rules/enforcement-sweep";
import { mayRevertFiles } from "../lib/rules/max-enforcement";
import { resolveActiveRuntimeScopeId } from "../lib/rules/runtime-scope";
import type { RulePayloadV1 } from "../lib/rules/types";
import { resolveWorkspaceIdWithEnv } from "../lib/workspace";

const PASS = "{}";

type HookInput = { session_id?: string; cwd?: string };

function parseInput(raw: string): HookInput | null {
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? (o as HookInput) : null;
  } catch {
    return null;
  }
}

function principal(): BundlePrincipal | null {
  try {
    const ws = resolveWorkspaceIdWithEnv();
    if (!ws) return null;
    return resolveBundlePrincipal(ws);
  } catch {
    return null;
  }
}

/**
 * The forbidden roots this runtime must hold. Only rules that could actually BLOCK are
 * swept: a WARN/OBSERVE rule is advisory, and reverting a user's file over an advisory
 * rule would be a far worse bug than the one this fixes.
 *
 * The session ceiling comes FIRST, before any rule is even read. Deleting a file is the
 * most destructive thing this CLI does, and it is only ever authorised at a DENY
 * ceiling. We ship WARN (owner ruling, 2026-07-12), so out of the box this returns []
 * and the sweep reverts nothing. That is also the fix for a real bypass: the ceiling was
 * private to the PreToolUse gate, so `MEETLESS_ACTION_INTERCEPT_MAX=warn` would let a
 * write through as an advisory and then this sweep, which had never heard of the
 * kill switch, would silently delete the file the gate had just allowed.
 */
function forbiddenRoots(p: BundlePrincipal): string[] {
  if (!mayRevertFiles()) return [];
  const read = readRuleBundleCache(p, { home: HOME, nowMs: Date.now() });
  // Only a FRESH bundle authorises deleting a file. Stale (past its lease) degrades a
  // DENY to an ASK on the pre-tool path, so it must not silently revert here either;
  // unavailable means the runtime holds no rules at all.
  if (read.status !== "fresh" || !read.bundle) return [];
  const roots: string[] = [];
  for (const entry of read.bundle.rules ?? []) {
    const payload = entry.payload as RulePayloadV1 | undefined;
    if (!payload) continue;
    if (payload.effect !== "PROHIBIT" || payload.applicability?.mode !== "action") continue;
    if (payload.enforcementCeiling !== "DENY") continue;
    if (!payload.deliveryChannels?.includes("preToolUse")) continue;
    const config = payload.compliance?.config;
    const root =
      config && "forbiddenRootRelativePath" in config
        ? config.forbiddenRootRelativePath
        : null;
    if (typeof root === "string" && root.length > 0) roots.push(root);
  }
  return [...new Set(roots)];
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve("")); // a stdin error must never wedge a tool
  });
}

/** SessionStart: record what was already there, so we only ever revert what the agent adds. */
export async function runInternalEnforcementBaseline(_argv: string[] = []): Promise<number> {
  const raw = await readStdin().catch(() => "");
  try {
    const input = parseInput(raw) ?? {};
    const p = principal();
    if (!p) return emit(PASS);
    const roots = forbiddenRoots(p);
    if (roots.length === 0) return emit(PASS);
    const projectRoot = resolveActiveRuntimeScopeId();
    const baseline: SweepBaseline = {
      version: 1,
      projectRoot,
      roots,
      files: snapshotRoots(projectRoot, roots),
    };
    writeBaseline(baselinePath(HOME, input.session_id ?? "", projectRoot), baseline);
  } catch {
    /* fail open */
  }
  return emit(PASS);
}

/** PostToolUse: anything new under a forbidden root is removed, and the agent is told. */
export async function runInternalPosttoolSweep(_argv: string[] = []): Promise<number> {
  const raw = await readStdin().catch(() => "");
  try {
    const input = parseInput(raw);
    if (!input) return emit(PASS);
    const p = principal();
    if (!p) return emit(PASS);
    const roots = forbiddenRoots(p);
    if (roots.length === 0) return emit(PASS);

    const projectRoot = resolveActiveRuntimeScopeId();
    const file = baselinePath(HOME, input.session_id ?? "", projectRoot);
    let baseline = readBaseline(file);

    if (!baseline) {
      // SessionStart never ran (or a fresh root). Seed the baseline and revert nothing:
      // we cannot distinguish the agent's writes from what was already on disk, and
      // deleting a user's pre-existing file would be unforgivable.
      baseline = { version: 1, projectRoot, roots, files: snapshotRoots(projectRoot, roots) };
      writeBaseline(file, baseline);
      return emit(PASS);
    }

    const result = sweep(projectRoot, roots, baseline);
    if (result.reverted.length === 0 && result.modified.length === 0) return emit(PASS);

    for (const r of result.reverted) delete baseline.files[r];
    writeBaseline(file, baseline);

    const parts: string[] = [];
    if (result.reverted.length > 0) {
      parts.push(
        `Meetless removed ${result.reverted.length} file(s) written under a governed forbidden root: ` +
          `${result.reverted.slice(0, 5).join(", ")}. A governed team rule prohibits creating files there, ` +
          `and that rule holds regardless of which tool is used — a shell redirect is not a way around it. ` +
          `Write the file outside the forbidden root, or ask a human to change the rule.`,
      );
    }
    if (result.modified.length > 0) {
      parts.push(
        `Meetless detected ${result.modified.length} modified file(s) under a governed forbidden root ` +
          `(${result.modified.slice(0, 5).join(", ")}); their previous contents were not restored.`,
      );
    }
    // PostToolUse `decision: block` cannot undo the call — the sweep already did that —
    // but it puts the reason in front of the model so it stops retrying and reports.
    return emit(JSON.stringify({ decision: "block", reason: parts.join(" ") }));
  } catch {
    return emit(PASS);
  }
}

function emit(body: string): number {
  process.stdout.write(body);
  return 0;
}
