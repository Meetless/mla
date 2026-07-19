// test/lib/scanner/scan.spec.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorkspace } from "../../../src/lib/scanner/scan";
import {
  CONTENT_NORMALIZATION_V1,
  normalizedContentHash,
} from "../../../src/lib/scanner/content-normalization";
import { agentMemoryDir } from "../../../src/lib/scanner/agent-memory";
import {
  MANAGED_RULES_PATH,
  makeManagedRule,
  renderManagedRules,
} from "../../../src/lib/scanner/managed-rules";
import { writeRuleBundleCache } from "../../../src/lib/rules/bundle-cache";
import { managedRuleToRulePayload } from "../../../src/lib/rules/rule-import-mapping";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import type { RuleBundle, RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("scanWorkspace", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-scan-"));
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@test"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "CLAUDE.md"), "# Rules\n- NEVER commit secrets.\n- Use pnpm, not npm.\n");
    mkdirSync(join(repo, "docs", "adr"), { recursive: true });
    writeFileSync(join(repo, "docs", "adr", "0007-x.md"), "Status: superseded by ADR-0012\n## Decision\nuse X\n");
    mkdirSync(join(repo, "notes"), { recursive: true });
    writeFileSync(join(repo, "notes", "20260101-old.md"), "---\nstatus: deprecated\n---\nold thinking\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("produces directives, stale signals, inventory, and pre-rendered XML", () => {
    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "2026-06-12T00:00:00Z" });
    expect(result.directives.map((d) => d.text)).toEqual(
      expect.arrayContaining(["NEVER commit secrets.", "Use pnpm, not npm."]),
    );
    expect(result.staleSignals.map((s) => s.reason)).toEqual(
      expect.arrayContaining(["adr_superseded", "frontmatter_deprecated"]),
    );
    expect(result.inventory.instructionFiles).toBe(1);
    expect(result.confirmedRulesXml).toContain('authority="must-follow"');
    expect(result.staleContextXml).toContain("ADR-0012");
    expect(result.commitSha).toMatch(/^[0-9a-f]{7,40}$/);
    const noteSignals = result.staleSignals.filter((s) => s.source === "notes/20260101-old.md");
    expect(noteSignals.map((s) => s.reason)).toEqual(["frontmatter_deprecated"]);
    const adrSignals = result.staleSignals.filter((s) => s.source === "docs/adr/0007-x.md");
    expect(adrSignals.map((s) => s.reason)).toEqual(["adr_superseded"]);
    expect(result.staleSignals).toHaveLength(2);
  });

  // Local normalized digest per instruction-file (T1) artifact (ADR §3.3 item 2):
  // the primitive the artifact-revision contract addresses. Digested through the
  // shared content-normalization-v1 helper so a locally-computed digest equals a
  // server-evaluated one.
  it("emits a content-normalization-v1 digest per instruction-file (T1) artifact only", () => {
    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "x" });
    const digests = result.artifactDigests ?? [];
    const raw = "# Rules\n- NEVER commit secrets.\n- Use pnpm, not npm.\n";
    const claude = digests.find((d) => d.relativePath === "CLAUDE.md");
    expect(claude).toBeDefined();
    expect(claude!.normalizedContentHash).toBe(normalizedContentHash(raw));
    expect(claude!.contentNormalizationVersion).toBe(CONTENT_NORMALIZATION_V1);
    expect(claude!.byteLength).toBe(Buffer.byteLength(raw, "utf8"));
    // T2 decision docs and T4 legacy notes are NOT instruction files: no digest.
    const paths = digests.map((d) => d.relativePath);
    expect(paths).not.toContain("docs/adr/0007-x.md");
    expect(paths).not.toContain("notes/20260101-old.md");
  });

  it("digest is stable across CRLF/BOM capture artifacts and covers .claude/rules/", () => {
    const lf = "# Rules\n- NEVER commit secrets.\n- Use pnpm, not npm.\n";
    // Rewrite CLAUDE.md with a leading BOM + CRLF endings; the normalized digest must not move.
    const crlfBom = "\uFEFF" + lf.replace(/\n/g, "\r\n");
    writeFileSync(join(repo, "CLAUDE.md"), crlfBom);
    // A .claude/rules/ file is also a T1 instruction source (covered by the same digest branch).
    mkdirSync(join(repo, ".claude", "rules"), { recursive: true });
    writeFileSync(join(repo, ".claude", "rules", "a.md"), "- MUST ship tests.\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "crlf"]);
    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "x" });
    const byPath = new Map((result.artifactDigests ?? []).map((d) => [d.relativePath, d]));
    expect(byPath.get("CLAUDE.md")!.normalizedContentHash).toBe(normalizedContentHash(lf));
    expect(byPath.has(".claude/rules/a.md")).toBe(true);
  });

  // The same boilerplate rule repeated across per-service CLAUDE.md files must
  // collapse to a single directive: the grounding pack (and the reported rule
  // count) should reflect distinct rules, not per-file occurrences.
  it("dedupes an identical rule shared across multiple instruction files", () => {
    const dup = "- NEVER log sensitive data.\n";
    mkdirSync(join(repo, "apps", "control"), { recursive: true });
    mkdirSync(join(repo, "apps", "worker"), { recursive: true });
    writeFileSync(join(repo, "apps", "control", "CLAUDE.md"), `# Control rules\n${dup}`);
    writeFileSync(join(repo, "apps", "worker", "CLAUDE.md"), `# Worker rules\n${dup}`);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "dup-rule"]);

    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "2026-06-14T00:00:00Z" });
    const matches = result.directives.filter((d) => d.text === "NEVER log sensitive data.");
    expect(matches).toHaveLength(1);
    // Provenance preserved: both service docs are recorded as sources.
    expect(matches[0].source).toContain("apps/control/CLAUDE.md");
    expect(matches[0].source).toContain("apps/worker/CLAUDE.md");
    // The rule appears exactly once in the rendered grounding pack.
    expect((result.confirmedRulesXml.match(/NEVER log sensitive data\./g) || []).length).toBe(1);
  });

  it("ignores untracked files", () => {
    writeFileSync(join(repo, "AGENTS.md"), "- MUST do untracked thing.\n");
    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "x" });
    expect(result.directives.map((d) => d.text)).not.toContain("MUST do untracked thing.");
  });

  // Fix E: a T2 ADR file with BOTH a body Status: line and a YAML frontmatter
  // status: field must produce exactly ONE stale signal (the adr_superseded one,
  // because parseAdrStatus runs before the frontmatter branch).
  it("emits exactly one stale signal per file even when both adr-body and frontmatter triggers fire", () => {
    const adrPath = join(repo, "docs", "adr", "0007-x.md");
    // Overwrite with a file that has both triggers: frontmatter status + body Status:.
    writeFileSync(adrPath, "---\nstatus: deprecated\n---\nStatus: superseded by ADR-0012\n## Decision\nuse X\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "dual-trigger"]);

    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "2026-06-12T00:00:00Z" });
    const adrSignals = result.staleSignals.filter((s) => s.source === "docs/adr/0007-x.md");
    expect(adrSignals).toHaveLength(1);
    // The first signal emitted is adr_superseded (parseAdrStatus runs first).
    expect(adrSignals[0].reason).toBe("adr_superseded");
  });

  // The agent auto-memory (~/.claude/projects/<enc>/memory/) is untracked, so git ls-files
  // misses it. The scan discovers its feedback rules as a SEPARATE advisory set, never folded
  // into the auto-injected confirmed-rules pack (untracked => machine_inferred => never
  // must-follow; ingest != accept).
  it("surfaces agent-memory feedback as advisory machine_inferred directives, out of the confirmed pack", () => {
    const memDir = agentMemoryDir(repo, repo); // reuse repo as a throwaway HOME root
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "feedback_branch.md"),
      "---\ndescription: Commit directly on main; never branch in this repo\n---\nbody\n",
    );

    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "x", home: repo });

    expect(result.advisoryDirectives.map((d) => d.text)).toContain(
      "Commit directly on main; never branch in this repo",
    );
    expect(result.advisoryDirectives.every((d) => d.attestation === "machine_inferred")).toBe(true);
    expect(result.inventory.agentMemoryRules).toBe(1);
    // Must NOT pollute the committed directives or the auto-injected grounding pack.
    expect(result.directives.map((d) => d.text)).not.toContain(
      "Commit directly on main; never branch in this repo",
    );
    expect(result.confirmedRulesXml).not.toContain("never branch in this repo");
  });

  // "find OTHER things we need to support": an agent-memory rule that merely restates a
  // committed instruction-file rule (identical text) is dropped from the advisory set.
  it("drops an agent-memory rule whose text duplicates a committed instruction-file rule", () => {
    const memDir = agentMemoryDir(repo, repo);
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "feedback_dup.md"),
      "---\ndescription: NEVER commit secrets.\n---\nbody\n",
    );

    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "x", home: repo });

    // CLAUDE.md already attests "NEVER commit secrets." as a committed rule.
    expect(result.directives.map((d) => d.text)).toContain("NEVER commit secrets.");
    expect(result.advisoryDirectives.map((d) => d.text)).not.toContain("NEVER commit secrets.");
  });

  // Without any agent memory, advisory is empty and the new field/count are stable defaults.
  it("defaults advisoryDirectives to [] and agentMemoryRules to 0 when no agent memory exists", () => {
    const result = scanWorkspace(repo, { workspaceId: "ws1", now: () => "x", home: repo });
    expect(result.advisoryDirectives).toEqual([]);
    expect(result.inventory.agentMemoryRules).toBe(0);
  });

  // Post-cutover the on-disk .meetless/rules.md is the AUTHORING + import input, no longer the
  // live injection source: the scanner skips it in the git walk (so it is never double-counted
  // as a T2 doc or stale-scanned) and reads the principal-bound backend bundle for injection
  // instead (the bundle group below). This helper materializes the on-disk file so the skip
  // behavior can be verified.
  function writeManagedRules(root: string, rules: Parameters<typeof makeManagedRule>[0][]): void {
    mkdirSync(join(root, ".meetless"), { recursive: true });
    writeFileSync(join(root, MANAGED_RULES_PATH), renderManagedRules(rules.map(makeManagedRule)));
  }

  it("does not double-count the managed rule file as a T2 decision doc", () => {
    // A bare .md under a non-.claude path would otherwise classify as a T2 prose doc. The
    // scanner must skip it in the git loop and handle it only through the managed parser.
    writeManagedRules(repo, [{ statement: "Prefer relative imports.", strength: "SHOULD_FOLLOW" }]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "add managed rules"]);

    const baseline = scanWorkspace(repo, { workspaceId: "ws1", now: () => "x", home: repo });
    // The committed managed file is present but the decisionDocs count reflects only the ADR,
    // not the managed file (the seed repo has exactly one T2 doc: docs/adr/0007-x.md).
    expect(baseline.inventory.decisionDocs).toBe(1);
    // No stale signal is ever derived from the managed file.
    expect(baseline.staleSignals.map((s) => s.source)).not.toContain(MANAGED_RULES_PATH);
  });

  // The injected rule set is sourced from the principal-bound BACKEND BUNDLE cache, never the
  // on-disk .meetless/rules.md (which the scanner now skips: the bundle is the single live
  // source). The bundle's source of truth is the cache file written by the turn-boundary sync;
  // here we forge a fresh one.
  const BASE_MS = Date.parse("2026-06-20T00:00:00.000Z");
  const LEASE_MS = 24 * 60 * 60 * 1000;
  const fresh = () => new Date(BASE_MS + 1000).toISOString();

  function bundleEntry(
    statement: string,
    strength: "MUST_FOLLOW" | "SHOULD_FOLLOW",
    channels: string[] = ["runtimeInject"],
  ): RuleBundleEntry {
    const payload = {
      ...managedRuleToRulePayload(makeManagedRule({ statement, strength }), "scope_a"),
      deliveryChannels: channels,
    };
    const slug = statement.replace(/\s+/g, "-");
    return {
      ruleNodeId: `node-${slug}`,
      ruleVersionId: `ver-${slug}`,
      authorityScope: "TEAM",
      ownerUserId: null,
      projectId: null,
      payload,
      canonicalPayloadHash: ruleVersionHash(payload as Parameters<typeof ruleVersionHash>[0]),
      attestedByUserId: null,
      attestedAt: "2026-06-20T00:00:00.000Z",
      supersedesVersionId: null,
    };
  }

  function writeBundle(
    home: string,
    entries: RuleBundleEntry[],
    principalUserId: string,
    projectId: string | null = null,
  ): void {
    const b: RuleBundle = {
      schemaVersion: 1,
      principalUserId,
      workspaceId: "ws1",
      projectId,
      bundleRevision: 1,
      generatedAt: new Date(BASE_MS).toISOString(),
      validUntil: new Date(BASE_MS + LEASE_MS).toISOString(),
      rules: entries,
    };
    writeRuleBundleCache(b, { home });
  }

  function withBundleHome(fn: (bundleHome: string) => void): void {
    const bundleHome = mkdtempSync(join(tmpdir(), "mla-bundlehome-"));
    try {
      fn(bundleHome);
    } finally {
      rmSync(bundleHome, { recursive: true, force: true });
    }
  }

  it("injects the backend bundle's runtimeInject rules and IGNORES the on-disk managed file", () => {
    // An on-disk managed rule that MUST be ignored: the bundle is the single live source.
    writeManagedRules(repo, [{ statement: "DISK ONLY rule", strength: "MUST_FOLLOW" }]);
    withBundleHome((bundleHome) => {
      writeBundle(bundleHome, [bundleEntry("BUNDLE must rule", "MUST_FOLLOW")], "user_1");
      const result = scanWorkspace(repo, {
        workspaceId: "ws1",
        now: fresh,
        home: repo,
        principalUserId: "user_1",
        projectId: null,
        bundleHome,
      });
      const texts = result.directives.map((d) => d.text);
      expect(texts).toContain("BUNDLE must rule");
      expect(texts).not.toContain("DISK ONLY rule");
      // human_attested + MUST_FOLLOW => must-follow authority in the rendered pack.
      expect(result.confirmedRulesXml).toContain("BUNDLE must rule");
      expect(result.directives.find((d) => d.text === "BUNDLE must rule")!.source).toBe("rule-bundle");
    });
  });

  it("never serves another principal's bundle (injects nothing from the bundle)", () => {
    withBundleHome((bundleHome) => {
      writeBundle(bundleHome, [bundleEntry("BUNDLE rule", "MUST_FOLLOW")], "user_1");
      // The live session is user_2: their keyed file is absent -> unavailable -> no bundle rules.
      const result = scanWorkspace(repo, {
        workspaceId: "ws1",
        now: fresh,
        home: repo,
        principalUserId: "user_2",
        bundleHome,
      });
      expect(result.directives.map((d) => d.source)).not.toContain("rule-bundle");
      expect(result.directives.map((d) => d.text)).not.toContain("BUNDLE rule");
    });
  });

  it("a preToolUse-only bundle entry is enforced elsewhere, never injected", () => {
    withBundleHome((bundleHome) => {
      writeBundle(
        bundleHome,
        [bundleEntry("inject me", "MUST_FOLLOW", ["runtimeInject"]), bundleEntry("deny only", "MUST_FOLLOW", ["preToolUse"])],
        "user_1",
      );
      const result = scanWorkspace(repo, {
        workspaceId: "ws1",
        now: fresh,
        home: repo,
        principalUserId: "user_1",
        bundleHome,
      });
      const texts = result.directives.map((d) => d.text);
      expect(texts).toContain("inject me");
      expect(texts).not.toContain("deny only");
    });
  });

  it("collapses a bundle rule that duplicates a committed instruction-file rule, keeping must-follow", () => {
    // CLAUDE.md attests "Use pnpm, not npm." as a committed directive (SHOULD here); the same
    // statement delivered by the bundle as MUST_FOLLOW must dedupe to a single directive that
    // keeps the stronger must-follow authority. The dedupe is source-blind, so it spans the
    // committed instruction file and the backend bundle exactly as it once did the managed file.
    withBundleHome((bundleHome) => {
      writeBundle(bundleHome, [bundleEntry("Use pnpm, not npm.", "MUST_FOLLOW")], "user_1");
      const result = scanWorkspace(repo, {
        workspaceId: "ws1",
        now: fresh,
        home: repo,
        principalUserId: "user_1",
        bundleHome,
      });
      const matches = result.directives.filter((d) => d.text === "Use pnpm, not npm.");
      expect(matches).toHaveLength(1);
      expect(matches[0].strength).toBe("MUST_FOLLOW");
      expect((result.confirmedRulesXml.match(/Use pnpm, not npm\./g) || []).length).toBe(1);
    });
  });
});
