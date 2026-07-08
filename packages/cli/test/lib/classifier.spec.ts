import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ALL_CATEGORIES,
  classify,
  classifyMany,
  type RiskCategory,
} from "../../src/lib/classifier";

interface FixtureCase {
  path: string;
  category: RiskCategory;
}

interface Fixture {
  version: number;
  categories: RiskCategory[];
  cases: FixtureCase[];
}

const FIXTURE_PATH = resolve(
  __dirname,
  "../../../../fixtures/risk-classifier.fixture.json",
);

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

describe("risk classifier (default ruleset)", () => {
  it.each(fixture.cases.map((c) => [c.path, c.category] as const))(
    "classifies %s as %s",
    (path, expected) => {
      expect(classify(path)).toBe(expected);
    },
  );

  it("returns unknown for empty string", () => {
    expect(classify("")).toBe("unknown");
  });

  it("normalizes leading ./ and absolute /", () => {
    expect(classify("./src/webhooks/github.ts")).toBe("external_integration");
    expect(classify("/src/webhooks/github.ts")).toBe("external_integration");
  });

  it("classifyMany maps each path independently", () => {
    expect(classifyMany(["README.md", "src/auth/x.ts"])).toEqual({
      "README.md": "docs",
      "src/auth/x.ts": "auth_or_permission",
    });
  });

  it("honors a caller-supplied ruleset (config-driven override)", () => {
    const custom = [
      { pattern: /\.tf$/, category: "external_integration" as const },
    ];
    // A path that the default ruleset would call unknown is reclassified by the
    // custom rules; a path the custom rules do not cover falls through.
    expect(classify("infra/main.tf", custom)).toBe("external_integration");
    expect(classify("README.md", custom)).toBe("unknown");
  });
});

// Drift guard: the fixture is the versioned contract for the default ruleset.
// These assertions fail the moment the ruleset and the fixture fall out of sync,
// forcing a matching fixture update (and a version bump on a taxonomy change).
describe("risk classifier drift guard", () => {
  it("is versioned", () => {
    expect(Number.isInteger(fixture.version)).toBe(true);
    expect(fixture.version).toBeGreaterThanOrEqual(1);
  });

  it("declares exactly the code-side taxonomy (ALL_CATEGORIES)", () => {
    expect([...fixture.categories].sort()).toEqual([...ALL_CATEGORIES].sort());
  });

  it("every declared category is a real RiskCategory", () => {
    for (const c of fixture.categories) {
      expect(ALL_CATEGORIES).toContain(c);
    }
  });

  it("exercises every non-unknown category at least once", () => {
    const exercised = new Set(fixture.cases.map((c) => c.category));
    for (const category of ALL_CATEGORIES) {
      if (category === "unknown") continue;
      expect(exercised.has(category)).toBe(true);
    }
  });
});
