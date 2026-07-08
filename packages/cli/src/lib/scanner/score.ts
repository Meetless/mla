export type Tier = "T1" | "T2" | "T3" | "T4";

// Agent-instruction filenames matched by BASENAME, not full path: real monorepos
// keep one per package (apps/control/CLAUDE.md, packages/x/AGENTS.md). Matching the
// repo-root path only would demote every nested copy to a generic T2 doc and drop
// all its rules, which is the whole reason this scanner exists.
const T1_BASENAMES = new Set([
  "CLAUDE.md", "AGENTS.md", "GEMINI.md", "memory.md", "copilot-instructions.md",
]);
// Curated decision / instruction-adjacent docs: known high-signal BASENAMES plus
// decision-record directories. Basenames are matched by basename (not full path) for
// the SAME reason as T1_BASENAMES above: a monorepo keeps a README.md / ARCHITECTURE.md
// per package, and full-path matching would treat every nested one as anonymous prose.
// These are still tier T2, but `isCuratedDoc` lets the enrichment ranker float them
// above generic prose so a tight target budget is not spent on arbitrary marketing .md
// while a real ADR or package README is crowded out (plan §5b).
const T2_BASENAMES = new Set(["README.md", "README", "ARCHITECTURE.md", "CONTRIBUTING.md"]);
const T2_DIRS = ["docs/adr/", "docs/rfc/", "docs/decisions/", "docs/specs/", "docs/runbooks/"];
const T3_NAMES = new Set(["package.json", "prisma/schema.prisma", "docker-compose.yml", ".env.example"]);
const DENY_EXT = /\.(ts|tsx|js|jsx|py|go|rs|java|lock|map|png|jpg|svg|snap)$/i;
const DENY_NAME = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/i;
// Generated / vendored output directories. Even when a repo commits them (e.g. a
// Forge app that checks in its webpack bundle), nothing under them is a governance
// doc: it is third-party or machine-emitted. Match the segment anywhere in the path
// so a committed `apps/x/build/static/...` is excluded the same as a root `dist/`.
const DENY_DIR = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.output)\//i;
// Minified-bundle license sidecars (terser/webpack emit `<chunk>.js.LICENSE.txt`):
// pure third-party license boilerplate, never a governance doc, and they can sit
// outside a build dir when an app serves its bundle from a tracked static folder.
const DENY_GENERATED = /\.LICENSE\.txt$/i;
// Test / eval / fixture corpora. These trees hold test data, eval benchmarks, and
// deliberately-broken fixtures (e.g. an eval's `broken_outputs/*.txt` are MALFORMED
// answers used to test the harness): reading them as governance docs both drowns the
// real docs and risks minting false claims from poison. The intel repo proved it: 171
// of 179 tracked .md files live under `evals/`, crowding a real `notes/` doc out of
// the top 20. Match whole path SEGMENTS so `latest/` or a `docs/testing-policy.md` are
// untouched. Deliberately EXCLUDES `spec`/`specs` (overloaded: `docs/specs/` is a
// governance T2_DIR, and OpenAPI/spec docs are real). Widen only on real dogfood need.
const DENY_TESTDIR =
  /(^|\/)(evals?|tests?|__tests__|e2e|fixtures|__fixtures__|testdata|test[-_]data|__mocks__|__snapshots__)\//i;

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// A curated T2 doc: a known high-signal doc name (at any depth) or a file under a
// decision-record directory, as opposed to arbitrary prose that merely ends in .md.
// Used by the enrichment ranker to order curated docs above generic prose within T2.
// Pure name/path test: it does NOT run the DENY checks, so call it only on a path
// `classifyTier` has already accepted (the deny gates ran there first).
export function isCuratedDoc(p: string): boolean {
  return T2_BASENAMES.has(basename(p)) || T2_DIRS.some((d) => p.startsWith(d));
}

export function classifyTier(p: string): Tier | null {
  if (
    DENY_NAME.test(p) ||
    DENY_EXT.test(p) ||
    DENY_DIR.test(p) ||
    DENY_GENERATED.test(p) ||
    DENY_TESTDIR.test(p)
  )
    return null;
  if (T1_BASENAMES.has(basename(p)) || p.startsWith(".claude/rules/") || p.startsWith(".cursor/rules/")) return "T1";
  if (p.startsWith("notes/")) return "T4";
  if (isCuratedDoc(p)) return "T2";
  if (T3_NAMES.has(p) || p.startsWith(".github/workflows/")) return "T3";
  if (/\.(md|mdc|rst|adoc|txt)$/i.test(p)) return "T2"; // generic prose doc
  return null;
}

export function isInstructionFile(p: string): boolean {
  return classifyTier(p) === "T1";
}
