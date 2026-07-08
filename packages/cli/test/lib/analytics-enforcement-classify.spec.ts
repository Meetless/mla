// Pure, PII-safe classifiers for the enforcement-incident event (the deny tile, §5.1).
// classifyTouchedSurface and normalizeEnforcedTool read a path / tool name ONLY to derive a
// closed enum; the raw string never enters the returned value (INV-POSTHOG-PII-1). These tests
// pin the enum mapping and the order-of-precedence that makes it well-defined.

import {
  classifyTouchedSurface,
  normalizeEnforcedTool,
} from "../../src/lib/analytics/enforcement-classify";
import { ENFORCED_TOOLS, TOUCHED_SURFACES } from "../../src/lib/analytics/envelope";

describe("normalizeEnforcedTool", () => {
  it("passes the two armed pilot tools through verbatim", () => {
    expect(normalizeEnforcedTool("Write")).toBe("Write");
    expect(normalizeEnforcedTool("Edit")).toBe("Edit");
  });

  it("collapses every other tool name to the closed 'unknown' fallback (no open string escapes)", () => {
    for (const t of ["Read", "MultiEdit", "NotebookEdit", "Bash", "write", "EDIT", ""]) {
      expect(normalizeEnforcedTool(t)).toBe("unknown");
    }
    expect(normalizeEnforcedTool(null)).toBe("unknown");
    expect(normalizeEnforcedTool(undefined)).toBe("unknown");
  });

  it("only ever returns a member of the closed ENFORCED_TOOLS enum", () => {
    for (const t of ["Write", "Edit", "Read", null, undefined, "weird"]) {
      expect(ENFORCED_TOOLS).toContain(normalizeEnforcedTool(t as string | null));
    }
  });
});

describe("classifyTouchedSurface", () => {
  it("classifies docs (.md and friends)", () => {
    expect(classifyTouchedSurface("notes/scratch.md")).toBe("docs");
    expect(classifyTouchedSurface("README.MD")).toBe("docs");
    expect(classifyTouchedSurface("docs/guide.mdx")).toBe("docs");
    expect(classifyTouchedSurface("CHANGES.rst")).toBe("docs");
    expect(classifyTouchedSurface("a/b/c.txt")).toBe("docs");
  });

  it("classifies code", () => {
    expect(classifyTouchedSurface("src/app/main.ts")).toBe("code");
    expect(classifyTouchedSurface("lib/util.py")).toBe("code");
    expect(classifyTouchedSurface("cmd/server/main.go")).toBe("code");
    expect(classifyTouchedSurface("src/Component.tsx")).toBe("code");
  });

  it("classifies tests, and tests win over code", () => {
    expect(classifyTouchedSurface("src/app/main.spec.ts")).toBe("tests");
    expect(classifyTouchedSurface("foo.test.tsx")).toBe("tests");
    expect(classifyTouchedSurface("src/__tests__/widget.ts")).toBe("tests");
    expect(classifyTouchedSurface("tests/integration/x.py")).toBe("tests");
    expect(classifyTouchedSurface("pkg/handler_test.go")).toBe("tests");
  });

  it("classifies migrations, and migration wins over config/code", () => {
    expect(classifyTouchedSurface("packages/control-db/prisma/migrations/0001_init/migration.sql")).toBe(
      "migration",
    );
    expect(classifyTouchedSurface("db/schema.sql")).toBe("migration");
    expect(classifyTouchedSurface("migrations/2026_add_col.ts")).toBe("migration");
  });

  it("classifies infra (containers, IaC, CI, shell), before the generic buckets", () => {
    expect(classifyTouchedSurface("Dockerfile")).toBe("infra");
    expect(classifyTouchedSurface("infra/deploy.tf")).toBe("infra");
    expect(classifyTouchedSurface("scripts/run.sh")).toBe("infra");
    // .github wins as a path segment even though ci.yml looks like config.
    expect(classifyTouchedSurface(".github/workflows/ci.yml")).toBe("infra");
    expect(classifyTouchedSurface("deploy/values.yaml")).toBe("infra");
  });

  it("classifies config (the generic settings bucket)", () => {
    expect(classifyTouchedSurface("tsconfig.json")).toBe("config");
    expect(classifyTouchedSurface("app/settings.yaml")).toBe("config");
    expect(classifyTouchedSurface(".env")).toBe("config");
    expect(classifyTouchedSurface(".env.local")).toBe("config");
    expect(classifyTouchedSurface("pyproject.toml")).toBe("config");
  });

  it("degrades to 'unknown' for empty/absent/unrecognized input rather than guessing", () => {
    expect(classifyTouchedSurface(null)).toBe("unknown");
    expect(classifyTouchedSurface(undefined)).toBe("unknown");
    expect(classifyTouchedSurface("")).toBe("unknown");
    expect(classifyTouchedSurface("LICENSE")).toBe("unknown");
    expect(classifyTouchedSurface("bin/some-binary")).toBe("unknown");
  });

  it("only ever returns a member of the closed TOUCHED_SURFACES enum", () => {
    for (const p of ["a.md", "b.ts", "c.spec.ts", "d.sql", "Dockerfile", "e.json", "", null]) {
      expect(TOUCHED_SURFACES).toContain(classifyTouchedSurface(p as string | null));
    }
  });

  it("handles windows-style separators without leaking the path", () => {
    expect(classifyTouchedSurface("src\\app\\__tests__\\x.ts")).toBe("tests");
    expect(classifyTouchedSurface("notes\\scratch.md")).toBe("docs");
  });
});
