// `mla _internal turn-prepare-shadow` (E1 shadow). Spawned DETACHED from the hook AFTER the turn
// injection is already on stdout, so it never touches the critical latency path. It recomputes the
// legacy turn decision from the local scan cache (the CLI's own assembleContext), calls the
// canonical `POST /v1/turns/prepare`, and logs one greppable comparison line. Legacy is
// authoritative and already delivered; this only observes. NEVER throws to the caller with a
// nonzero exit that could look like a hook failure: it returns 0 on every path.
//
// INPUT is a small JSON on stdin (the hook already has these facts, so we thread them rather than
// re-deriving and drifting): { prompt, sessionId, repoRoot?, workingSet? }. Everything else the
// shadow reads itself (config for the token/url, the scan cache for the governed rules).
import { loadWorkspaceConfig } from "../lib/config";
import { readScanCacheForRoot } from "./scan-context";
import { assembleContext } from "../lib/scanner/assemble";
import { extractExplicitPaths } from "../lib/scanner/prompt-paths";
import {
  runTurnPrepareShadow,
  formatTurnPrepareShadow,
  type LegacyTurnDecision,
} from "../lib/turn-prepare-shadow";

interface ShadowInput {
  prompt: string;
  sessionId: string;
  repoRoot?: string;
  workingSet?: string[];
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

function parseInput(raw: string): ShadowInput | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.prompt !== "string" || typeof j.sessionId !== "string") return null;
    return {
      prompt: j.prompt,
      sessionId: j.sessionId,
      repoRoot: typeof j.repoRoot === "string" ? j.repoRoot : undefined,
      workingSet: Array.isArray(j.workingSet) ? (j.workingSet.filter((s) => typeof s === "string") as string[]) : [],
    };
  } catch {
    return null;
  }
}

// A ceiling large enough that the legacy assembler never DROPS a best-effort rule for budget, so
// its best-effort set is apples-to-apples with the canonical candidate set (which is unbudgeted).
// The required set (floor-must + scoped-required) is never dropped regardless.
const NO_BUDGET_CEILING = 100_000_000;

export async function runInternalTurnPrepareShadow(): Promise<number> {
  // Enable is the same env switch shape as the D0/D3 shadows; off by default.
  if (process.env.MEETLESS_E1_SHADOW !== "1") return 0;

  const input = parseInput(await readStdin());
  if (!input) return 0;

  try {
    const cfg = loadWorkspaceConfig();
    const accessToken = cfg.auth?.mode === "user-token" ? cfg.auth.accessToken : undefined;
    const platformUrl = process.env.MEETLESS_PLATFORM_URL;

    // home = undefined lets the cache module resolve the state root, which honors
    // MEETLESS_HOME, exactly as status.ts and context.ts do for this same call. Never
    // os.homedir() here: it bypasses userHomeDir()'s poisoned-$HOME recovery, which is
    // what the home-resolution guard forbids.
    const cache = readScanCacheForRoot(undefined, cfg.workspaceId, input.repoRoot ?? process.cwd());
    const floorRules = cache?.floorRules ?? [];
    const scopedRules = cache?.scopedRules ?? [];
    const explicitPaths = extractExplicitPaths(input.prompt);

    // The LEGACY decision, from the CLI's own assembler over the local cache. Its `delivered`
    // array is exactly what the hook injected this turn (deterministic over the same inputs).
    const assembled = assembleContext({
      base: "",
      prompt: input.prompt,
      floorRules,
      scopedRules,
      explicitPaths,
      workingSetPaths: input.workingSet ?? [],
      safeTotal: NO_BUDGET_CEILING,
    });
    const byTier = (tier: string): string[] =>
      assembled.delivered.filter((d) => d.tier === tier).map((d) => d.ruleId);
    const legacy: LegacyTurnDecision = {
      floorMust: byTier("floor-must"),
      scopedRequired: byTier("scoped-required"),
      bestEffort: byTier("best-effort"),
      warnings: (cache?.reconciliationFindings ?? []).map((f) => f.path),
    };

    const cmp = await runTurnPrepareShadow({
      enabled: true,
      platformUrl,
      accessToken,
      legacy,
      task: input.prompt,
      sessionId: input.sessionId,
      signals: { explicitPaths, workingSet: input.workingSet ?? [] },
    });
    if (cmp.ran || cmp.error || cmp.skipped) console.error(formatTurnPrepareShadow(cmp));
  } catch (e) {
    // A shadow must never fail the (already-detached) hook flow. Report and return 0.
    console.error(`e1_shadow skipped=error error=${(e as Error).message?.slice(0, 160)}`);
  }
  return 0;
}
