// Pure, PII-safe classifiers for the enforcement-incident event (the deny tile,
// notes/20260627-mla-product-health-dashboard-posthog-metrics.md §5.1).
//
// Both functions read a tool name / file path ONLY to derive a closed enum; the
// raw string NEVER leaves the function (INV-POSTHOG-PII-1). Importing this module
// pulls in no recorder, config, store, or I/O, so the non-deny hot path of the
// PreToolUse hook can keep it at top level without weight.

import { type EnforcedTool, type TouchedSurface } from "./envelope";

/**
 * Map a PreToolUse tool name to the closed ENFORCED_TOOLS enum. The notes-location
 * pilot's admission gate guarantees the deny only fires on {Write, Edit}; anything
 * else degrades to "unknown" rather than leaking the raw tool string.
 */
export function normalizeEnforcedTool(toolName: string | null | undefined): EnforcedTool {
  if (toolName === "Write" || toolName === "Edit") return toolName;
  return "unknown";
}

/**
 * Classify a file path into the PII-safe touched-surface enum. The path is read only
 * to derive the enum (extension + a few well-known path segments); the path itself
 * never enters the returned value. Best-effort: an unrecognized shape degrades to
 * "unknown" rather than guessing. Order is load-bearing -- a `.spec.ts` is a test
 * (not code), a `.sql` under migrations is a migration (not config), etc.
 */
export function classifyTouchedSurface(filePath: string | null | undefined): TouchedSurface {
  if (!filePath || typeof filePath !== "string") return "unknown";
  const p = filePath.toLowerCase().replace(/\\/g, "/");
  const base = p.split("/").pop() ?? p;

  // tests win over code: a .spec.ts / __tests__/ path is a test surface.
  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /(^|\/)__tests__\//.test(p) ||
    /(^|\/)tests?\//.test(p) ||
    /_test\.(py|go|rb)$/.test(base)
  ) {
    return "tests";
  }

  // migrations win over config/code: a .sql or a migrations/ path is a migration.
  if (/(^|\/)migrations?\//.test(p) || base.endsWith(".sql")) return "migration";

  // infra: container/IaC/CI/shell, before the generic config/code buckets.
  if (
    base === "dockerfile" ||
    base.endsWith(".dockerfile") ||
    base.endsWith(".tf") ||
    base.endsWith(".sh") ||
    base.endsWith(".bash") ||
    /(^|\/)(infra|deploy|\.github|terraform|helm|k8s)\//.test(p)
  ) {
    return "infra";
  }

  if (/\.(md|mdx|markdown|rst|txt|adoc)$/.test(base)) return "docs";

  if (
    /\.(ya?ml|json|jsonc|toml|ini|cfg|conf|properties|lock)$/.test(base) ||
    base.startsWith(".env") ||
    base === ".gitignore" ||
    base === ".npmrc"
  ) {
    return "config";
  }

  if (
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|kts|scala|m|mm|vue|svelte|ex|exs|clj|hs)$/.test(
      base,
    )
  ) {
    return "code";
  }

  return "unknown";
}
