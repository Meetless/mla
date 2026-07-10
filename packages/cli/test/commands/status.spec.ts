// test/commands/status.spec.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderStatus, notMemberStatusMessage } from "../../src/commands/status";
import { writeScanCache } from "../../src/lib/scanner/cache";

describe("renderStatus", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "mla-status-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

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
    expect(out).toContain("1 confirmed rule injected");
    expect(out).toContain("2 pending review items");
    expect(out).toContain("hooks installed");
    // No agent-memory rules here (count 0): the advisory line is omitted (no spam).
    expect(out).not.toContain("advisory");
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
