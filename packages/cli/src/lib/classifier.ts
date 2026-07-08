/**
 * File-path risk classifier.
 *
 * Maps a repository file path to a coarse risk category so an automated code
 * reviewer can state deterministic pre-prompt facts ("this change touches
 * auth", "this is a schema migration") before the LLM reasons about the diff.
 *
 * This is a generic, config-driven utility: it ships a DEFAULT_RULES ruleset
 * built from COMMON repository conventions (a Prisma schema, a `migrations/`
 * dir, an `auth`/`authz` dir, `webhooks`/`integrations`, a `prompts/` dir of
 * YAML, an `outbox`/`handlers` dir, NestJS-style `*.controller.ts` / `*.dto.ts`
 * or an `api/` dir, shell scripts and a `tools/` dir, docs). None of the rules
 * encode any one repo's internal service map; point `classify` at your own
 * ruleset (or extend DEFAULT_RULES) to fit a differently-structured codebase.
 *
 * Ordering is load-bearing. First match wins. Narrow rules come before broad
 * rules (e.g. `*.controller.ts` before a bare `api/` dir).
 *
 * The ruleset is pinned by a VERSIONED fixture (`fixtures/risk-classifier.fixture.json`,
 * `version: 1`) and a drift test (`test/lib/classifier.spec.ts`): every fixture
 * case must classify to its declared category, the fixture's declared taxonomy
 * must equal ALL_CATEGORIES, and every non-`unknown` category must be exercised.
 * Adding or changing a rule therefore forces a matching fixture update (and, on
 * a taxonomy change, a version bump).
 */

export type RiskCategory =
  | "schema_or_migration"
  | "auth_or_permission"
  | "external_integration"
  | "llm_prompt"
  | "outbox_or_handler"
  | "api_contract"
  | "cli_or_tooling"
  | "docs"
  | "unknown";

// Runtime list of every category. The drift test asserts the fixture's declared
// taxonomy equals this set, so the type and the fixture cannot drift apart.
export const ALL_CATEGORIES = [
  "schema_or_migration",
  "auth_or_permission",
  "external_integration",
  "llm_prompt",
  "outbox_or_handler",
  "api_contract",
  "cli_or_tooling",
  "docs",
  "unknown",
] as const satisfies readonly RiskCategory[];

// Compile-time completeness guard: if a RiskCategory is added to the union but
// not to ALL_CATEGORIES above, this assignment stops type-checking.
type _CategoryCompleteness =
  RiskCategory extends (typeof ALL_CATEGORIES)[number] ? true : never;
const _categoryCompletenessCheck: _CategoryCompleteness = true;
void _categoryCompletenessCheck;

export interface Rule {
  pattern: RegExp;
  category: RiskCategory;
}

// Generic default ruleset. Patterns are prefix-agnostic ((^|\/) anchors a path
// segment whether it is at the repo root or nested), so the same rule matches
// `auth/x.ts`, `src/auth/x.ts`, and `packages/api/src/auth/x.ts`.
export const DEFAULT_RULES: ReadonlyArray<Rule> = [
  { pattern: /(^|\/)prisma\/schema\.prisma$/, category: "schema_or_migration" },
  { pattern: /(^|\/)migrations?\//, category: "schema_or_migration" },
  { pattern: /(^|\/)(auth|authz)\//, category: "auth_or_permission" },
  { pattern: /(^|\/)(webhooks?|integrations?)\//, category: "external_integration" },
  { pattern: /(^|\/)prompts\/.*\.ya?ml$/, category: "llm_prompt" },
  { pattern: /(^|\/)(outbox|handlers?)\//, category: "outbox_or_handler" },
  { pattern: /\.(controller|dto)\.ts$/, category: "api_contract" },
  { pattern: /(^|\/)api\//, category: "api_contract" },
  { pattern: /(^|\/)tools\//, category: "cli_or_tooling" },
  { pattern: /\.sh$/, category: "cli_or_tooling" },
  { pattern: /(^|\/)docs\//, category: "docs" },
  { pattern: /\.md$/, category: "docs" },
];

function normalize(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.startsWith("./") || p.startsWith(".\\")) {
    p = p.slice(2);
  }
  while (p.startsWith("/")) {
    p = p.slice(1);
  }
  return p;
}

export function classify(
  path: string,
  rules: ReadonlyArray<Rule> = DEFAULT_RULES,
): RiskCategory {
  if (!path) return "unknown";
  const normalized = normalize(path);
  for (const rule of rules) {
    if (rule.pattern.test(normalized)) return rule.category;
  }
  return "unknown";
}

export function classifyMany(
  paths: string[],
  rules: ReadonlyArray<Rule> = DEFAULT_RULES,
): Record<string, RiskCategory> {
  const out: Record<string, RiskCategory> = {};
  for (const p of paths) out[p] = classify(p, rules);
  return out;
}
