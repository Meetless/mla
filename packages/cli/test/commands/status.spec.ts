// test/commands/status.spec.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatus, notMemberStatusMessage } from "../../src/commands/status";
import { writeScanCache } from "../../src/lib/scanner/cache";

describe("renderStatus", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mla-status-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

  it("reports active state with rule and review counts from the cache", () => {
    writeScanCache(home, "ws1", {
      schemaVersion: 1, workspaceId: "ws1", commitSha: "abc", generatedAt: "t",
      inventory: { instructionFiles: 2, decisionDocs: 3, legacyNotes: 9, staleSignals: 2, agentMemoryRules: 0 },
      directives: [
        { id: "a", text: "x", source: "CLAUDE.md", kind: "RULE", strength: "MUST_FOLLOW", attestation: "human_attested" },
      ],
      staleSignals: [
        { id: "s1", source: "a.md", reason: "frontmatter_deprecated", detail: "a" },
        { id: "s2", source: "b.md", reason: "frontmatter_deprecated", detail: "b" },
      ],
      confirmedRulesXml: "x", floorRulesXml: "", staleContextXml: "y", advisoryDirectives: [],
    });
    const out = renderStatus({ home, workspaceId: "ws1", hooksInstalled: true });
    expect(out).toContain("Meetless is active");
    // This cache predates delivery accounting (schemaVersion 1, no floorRules array). It cannot
    // prove anything was injected, so it must not claim it: report the scan and name the fix.
    expect(out).toContain("1 directive scanned");
    expect(out).toContain("mla scan");
    expect(out).not.toContain("injected on every prompt");
    expect(out).toContain("2 pending review items");
    expect(out).toContain("hooks installed");
    // No agent-memory rules here (count 0): the advisory line is omitted (no spam).
    expect(out).not.toContain("advisory");
  });

  // Finding B of notes/20260807-mla-activation-onboarding-audit.md. `status` counted scanned
  // DIRECTIVES and printed them as rules "injected on every prompt". A live hook run on exactly
  // this state returned zero of them, and `activate` said so in the same session.
  it("does NOT claim delivery for file-sourced directives that are never injected", () => {
    writeScanCache(home, "ws-fresh", {
      schemaVersion: 2, workspaceId: "ws-fresh", commitSha: "abc", generatedAt: "t",
      inventory: { instructionFiles: 1, decisionDocs: 0, legacyNotes: 0, staleSignals: 0, agentMemoryRules: 0 },
      // Four human-attested directives read out of CLAUDE.md, none bundle-sourced, so the floor
      // filter drops every one of them. This is the brand-new-workspace state.
      directives: [
        { id: "a", text: "w", source: "CLAUDE.md", kind: "RULE", strength: "MUST_FOLLOW", attestation: "human_attested" },
        { id: "b", text: "x", source: "CLAUDE.md", kind: "RULE", strength: "MUST_FOLLOW", attestation: "human_attested" },
        { id: "c", text: "y", source: "CLAUDE.md", kind: "RULE", strength: "MUST_FOLLOW", attestation: "human_attested" },
        { id: "d", text: "z", source: "CLAUDE.md", kind: "RULE", strength: "MUST_FOLLOW", attestation: "human_attested" },
      ],
      staleSignals: [],
      confirmedRulesXml: "", floorRulesXml: "", staleContextXml: "", advisoryDirectives: [],
      floorRules: [], scopedRules: [],
    } as Parameters<typeof writeScanCache>[2]);
    const out = renderStatus({ home, workspaceId: "ws-fresh", hooksInstalled: true });
    expect(out).toContain("No governed rules injected yet");
    expect(out).toContain("4 directives scanned");
    expect(out).toContain("/mla onboard");
    expect(out).not.toContain("4 confirmed rules injected");
  });

  // Wording tightened deliberately (2026-08-08 review of the 08-07 audit). 9f18551e8
  // moved this line off the scanned-directive count and onto the floor, which killed the
  // outright lie. The floor count is still only a fact about a cache on disk, though, so
  // "injected on every prompt" was the same promotion of configuration into delivery one
  // field further along: it reads identically whether the hook is delivering, firing from
  // a sibling checkout, or never installed. Configured and observed are now two lines,
  // and the observed one comes from the hook receipt
  // (see status-observed-delivery.spec.ts).
  it("reports the floor as CONFIGURED, and scoped rules as conditional", () => {
    writeScanCache(home, "ws-gov", {
      schemaVersion: 2, workspaceId: "ws-gov", commitSha: "abc", generatedAt: "t",
      inventory: { instructionFiles: 1, decisionDocs: 0, legacyNotes: 0, staleSignals: 0, agentMemoryRules: 0 },
      directives: [
        { id: "a", text: "w", source: "CLAUDE.md", kind: "RULE", strength: "MUST_FOLLOW", attestation: "human_attested" },
      ],
      staleSignals: [],
      confirmedRulesXml: "", floorRulesXml: "", staleContextXml: "", advisoryDirectives: [],
      floorRules: [{ ruleId: "r1" }, { ruleId: "r2" }],
      scopedRules: [{ ruleId: "r3" }],
    } as Parameters<typeof writeScanCache>[2]);
    const out = renderStatus({ home, workspaceId: "ws-gov", hooksInstalled: true });
    expect(out).toContain("2 governed floor rules configured for injection");
    expect(out).toContain("1 scoped rule when the turn matches");
    // The claim this suite exists to prevent, in its subtler form: a cache read must
    // never assert that a turn happened.
    expect(out).not.toContain("injected on every prompt");
  });

  it("surfaces advisory agent-memory rules when the cache has them", () => {
    writeScanCache(home, "ws-adv", {
      schemaVersion: 1, workspaceId: "ws-adv", commitSha: "abc", generatedAt: "t",
      inventory: { instructionFiles: 1, decisionDocs: 0, legacyNotes: 0, staleSignals: 0, agentMemoryRules: 2 },
      directives: [],
      staleSignals: [],
      confirmedRulesXml: "", floorRulesXml: "", staleContextXml: "",
      advisoryDirectives: [
        { id: "m1", text: "Commit on main", source: "agent-memory:feedback_a.md", kind: "RULE", strength: "SHOULD_FOLLOW", attestation: "machine_inferred" },
        { id: "m2", text: "Never push without asking", source: "agent-memory:feedback_b.md", kind: "RULE", strength: "MUST_FOLLOW", attestation: "machine_inferred" },
      ],
    });
    const out = renderStatus({ home, workspaceId: "ws-adv", hooksInstalled: true });
    expect(out).toContain("2 advisory rules from agent memory");
  });

  // A pre-M1 cache lacks agentMemoryRules entirely; renderStatus must not crash or
  // print "undefined", it must treat a missing count as zero (line omitted).
  it("treats a pre-M1 cache with no agentMemoryRules field as zero advisory rules", () => {
    writeScanCache(home, "ws-old", {
      schemaVersion: 1, workspaceId: "ws-old", commitSha: "abc", generatedAt: "t",
      // Deliberately omit agentMemoryRules / advisoryDirectives to simulate an old cache.
      inventory: { instructionFiles: 1, decisionDocs: 0, legacyNotes: 0, staleSignals: 0 },
      directives: [], staleSignals: [], confirmedRulesXml: "", staleContextXml: "",
    } as unknown as Parameters<typeof writeScanCache>[2]);
    const out = renderStatus({ home, workspaceId: "ws-old", hooksInstalled: true });
    expect(out).not.toContain("advisory");
    expect(out).not.toContain("undefined");
  });

  it("reports not-activated when there is no cache", () => {
    const out = renderStatus({ home, workspaceId: "ws-none", hooksInstalled: false });
    expect(out).toContain("not activated");
  });

  // renderStatus honours a pre-read cache passed by runStatus (so the file is
  // read once, not twice). An explicit null means "no cache", same as reading
  // an empty home.
  it("uses a caller-supplied cache instead of reading disk", () => {
    const out = renderStatus({
      home,
      workspaceId: "ws-passed",
      hooksInstalled: true,
      cache: {
        schemaVersion: 1, workspaceId: "ws-passed", commitSha: "abc", generatedAt: "t",
        inventory: { instructionFiles: 5, decisionDocs: 1, legacyNotes: 0, staleSignals: 0, agentMemoryRules: 0 },
        directives: [], staleSignals: [],
        confirmedRulesXml: "", floorRulesXml: "", staleContextXml: "", advisoryDirectives: [],
      } as unknown as Parameters<typeof writeScanCache>[2],
    });
    expect(out).toContain("Meetless is active");
    expect(out).toContain("5 instruction files");
  });

  it("treats an explicit null cache as not-activated (no disk read)", () => {
    const out = renderStatus({ home, workspaceId: "ws-x", hooksInstalled: false, cache: null });
    expect(out).toContain("not activated");
  });
});

// BUG-6 Issue 1: a repo bound (via .meetless.json) to a workspace the operator
// is not a member of must NOT be reported as "not activated". `mla status`
// probes membership on the no-cache branch and, on a definite 403, renders this
// status-framed message instead of the misleading "run `mla activate`" copy
// (which would just loop on the same denial).
describe("notMemberStatusMessage", () => {
  // A 403 shaped like lib/http.ts buildError: `.status`, raw `.body`, and the
  // body inlined into `.message`.
  function denied(workspaceId: string): Error & { status: number; body: string } {
    const body = JSON.stringify({
      code: "WORKSPACE_ACCESS_DENIED",
      message: `You are not a member of workspace '${workspaceId}'. Ask a workspace admin to add you to it.`,
      details: { requestedWorkspaceId: workspaceId },
    });
    return Object.assign(
      new Error(`GET /internal/v1/whoami -> HTTP 403: ${body}`),
      { status: 403, body },
    ) as Error & { status: number; body: string };
  }

  it("leads with the canonical membership line (shared with the rest of the CLI)", () => {
    const msg = notMemberStatusMessage(denied("ws_target"), "ws_target");
    expect(msg.startsWith("You are not a member of workspace 'ws_target'.")).toBe(true);
    expect(msg).toContain("Ask a workspace admin to add you to it.");
  });

  it("adds the status-only context: the repo IS bound, so activate cannot fix it", () => {
    const msg = notMemberStatusMessage(denied("ws_target"), "ws_target");
    expect(msg).toContain(".meetless.json");
    expect(msg).toContain("mla activate");
    // Crucially, it must NOT reuse the misleading "not activated" copy.
    expect(msg).not.toContain("not activated");
  });

  it("reconstructs the workspace id when the server body is unparseable", () => {
    const opaque = Object.assign(
      new Error("GET /internal/v1/whoami -> HTTP 403: <html>edge proxy</html>"),
      { status: 403, body: "<html>edge proxy</html>" },
    );
    const msg = notMemberStatusMessage(opaque, "ws_fallback");
    expect(msg).toContain("You are not a member of workspace 'ws_fallback'.");
  });
});
