import { classifyTier, isInstructionFile, isCuratedDoc } from "../../../src/lib/scanner/score";

describe("classifyTier", () => {
  it("tiers agent-instruction files as T1", () => {
    expect(classifyTier("CLAUDE.md")).toBe("T1");
    expect(classifyTier(".claude/rules/api.md")).toBe("T1");
    expect(classifyTier("AGENTS.md")).toBe("T1");
  });

  it("tiers NESTED agent-instruction files as T1 by basename (monorepo packages)", () => {
    // Real monorepos keep a CLAUDE.md per package; matching only the repo-root
    // path silently demoted these to generic T2 docs and dropped all their rules.
    expect(classifyTier("apps/control/CLAUDE.md")).toBe("T1");
    expect(classifyTier("packages/cli/AGENTS.md")).toBe("T1");
    expect(classifyTier("services/api/GEMINI.md")).toBe("T1");
    expect(classifyTier(".github/copilot-instructions.md")).toBe("T1");
    expect(isInstructionFile("apps/control/CLAUDE.md")).toBe(true);
  });

  it("tiers ADR/spec docs as T2 and legacy notes as T4", () => {
    expect(classifyTier("docs/adr/0007-x.md")).toBe("T2");
    expect(classifyTier("README.md")).toBe("T2");
    expect(classifyTier("notes/20260101-old.md")).toBe("T4");
  });

  it("tiers config as T3 and denies code/lockfiles", () => {
    expect(classifyTier("package.json")).toBe("T3");
    expect(classifyTier("src/index.ts")).toBeNull();
    expect(classifyTier("pnpm-lock.yaml")).toBeNull();
  });

  it("denies docs committed under generated/vendor output directories", () => {
    // A Forge app that checks in its webpack bundle: the LICENSE.txt sidecar and any
    // README under build/ are machine output, not governance docs. They must not
    // displace real docs (this repo shipped two such sidecars at rank 13-14).
    expect(classifyTier("apps/forge-jira/static/x/build/static/js/main.abc.js.LICENSE.txt")).toBeNull();
    expect(classifyTier("dist/README.md")).toBeNull();
    expect(classifyTier("packages/x/dist/CLAUDE.md")).toBeNull();
    expect(classifyTier("node_modules/foo/AGENTS.md")).toBeNull();
    expect(classifyTier("apps/web/.next/build-manifest.txt")).toBeNull();
    expect(classifyTier("coverage/lcov-report/index.md")).toBeNull();
  });

  it("denies minified-bundle license sidecars even outside a build dir", () => {
    expect(classifyTier("static/js/main.0857d72d.js.LICENSE.txt")).toBeNull();
  });

  it("still tiers a genuine doc whose path merely contains a denied word as a substring", () => {
    // The denylist matches whole path SEGMENTS, so a real doc is not dropped just
    // because a word like "build" or "output" appears inside a filename or longer name.
    expect(classifyTier("docs/adr/0009-build-pipeline.md")).toBe("T2");
    expect(classifyTier("apps/home/docker-build-performance.md")).toBe("T2");
    expect(classifyTier("notes/output-format-decision.md")).toBe("T4");
  });

  it("denies docs under test/eval/fixture corpora (not governance documentation)", () => {
    // The intel repo proved this: 171 of 179 tracked .md files lived under evals/,
    // drowning a real notes/ doc out of the top 20, and broken_outputs/*.txt are
    // DELIBERATELY malformed eval fixtures that would mint false governance claims.
    expect(classifyTier("evals/agentic-slices/benchmarks/A.01/CURATION.md")).toBeNull();
    expect(classifyTier("evals/agentic-slices/benchmarks/A.05/broken_outputs/legacy_citation_leak.txt")).toBeNull();
    expect(classifyTier("eval/cases/x.md")).toBeNull();
    expect(classifyTier("tests/README.md")).toBeNull();
    expect(classifyTier("test/fixtures/sample.md")).toBeNull();
    expect(classifyTier("packages/cli/__tests__/notes.md")).toBeNull();
    expect(classifyTier("e2e/flows/walkthrough.md")).toBeNull();
    expect(classifyTier("src/__fixtures__/payload.txt")).toBeNull();
    expect(classifyTier("server/testdata/seed.md")).toBeNull();
    expect(classifyTier("server/test-data/seed.md")).toBeNull();
    expect(classifyTier("ui/__snapshots__/Button.md")).toBeNull();
  });

  it("does NOT deny real spec/specification docs or test-like substrings (segment-bounded)", () => {
    // `spec`/`specs` is intentionally NOT a denied segment: `docs/specs/` is a
    // governance T2_DIR and OpenAPI/spec prose is real. And the segment boundary
    // keeps `latest/` and a `testing-policy` filename from being swept up.
    expect(classifyTier("docs/specs/api-contract.md")).toBe("T2");
    expect(classifyTier("latest/release-notes.md")).toBe("T2");
    expect(classifyTier("docs/adr/0010-testing-policy.md")).toBe("T2");
    expect(classifyTier("notes/test-strategy-decision.md")).toBe("T4");
  });

  it("isInstructionFile is true only for T1 sources", () => {
    expect(isInstructionFile("CLAUDE.md")).toBe(true);
    expect(isInstructionFile("docs/adr/0007-x.md")).toBe(false);
  });
});

describe("isCuratedDoc (curated T2 vs generic prose, for the enrichment ranker)", () => {
  it("treats known doc names as curated by BASENAME at any depth", () => {
    // The bug: T2 names were matched by full path while T1 was matched by basename,
    // so the canonical meetless-cli/packages/mcp/README.md was demoted to anonymous
    // prose and crowded out of the target budget by alphabetically-earlier marketing
    // .md. Curated names must be recognized at any depth, exactly like T1.
    expect(isCuratedDoc("README.md")).toBe(true);
    expect(isCuratedDoc("meetless-cli/packages/mcp/README.md")).toBe(true);
    expect(isCuratedDoc("apps/control/ARCHITECTURE.md")).toBe(true);
    expect(isCuratedDoc("packages/x/CONTRIBUTING.md")).toBe(true);
  });

  it("treats decision-record directories as curated", () => {
    expect(isCuratedDoc("docs/adr/0007-x.md")).toBe(true);
    expect(isCuratedDoc("docs/rfc/0001-y.md")).toBe(true);
    expect(isCuratedDoc("docs/specs/api-contract.md")).toBe(true);
  });

  it("treats arbitrary prose as generic (not curated)", () => {
    // These are still tier T2, but generic: the ranker floats curated docs above them.
    expect(isCuratedDoc("DESIGN_SYSTEM.md")).toBe(false);
    expect(isCuratedDoc("apps/home/docker-build-performance.md")).toBe(false);
    expect(isCuratedDoc("apps/home/public/og-image-template.md")).toBe(false);
    expect(isCuratedDoc("guide.md")).toBe(false);
  });
});
