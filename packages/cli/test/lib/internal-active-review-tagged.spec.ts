import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Deliverable 3 (A3): `mla _internal active-review` merges supersession advisories
// (from captured tagged_reference records joined against approved relation facts)
// into the Phase 1 advisoryText. Hermetic: MEETLESS_TAGGED_FACTS_STUB supplies the
// facts so the merge runs offline with zero network and zero KB write.

describe("internal active-review tagged_reference merge (Phase 2, A3)", () => {
  const ORIG_ENV = { ...process.env };
  let logSpy: jest.SpyInstance;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env = { ...ORIG_ENV };
    jest.resetModules();
  });

  it("a captured tagged_reference plus a stubbed SUPERSEDED_BY fact merges a supersession line into advisoryText", async () => {
    const home = mkdtempSync(join(tmpdir(), "mlhome-"));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({ controlUrl: "http://127.0.0.1:8000", controlToken: "t", workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
    );
    // A captured tagged_reference naming old.md (the metadata-only A3 capture).
    writeFileSync(
      join(home, "logs", "kb-knowledge.jsonl"),
      JSON.stringify({
        event: "active_memory_record",
        workspaceId: "ws_1",
        ownerUserId: "user_a",
        repoRootHash: "repoA",
        canonicalPath: "old.md",
        contentHash: "",
        sessionId: "sess_1",
        turnIndex: 1,
        sourceProduct: "claude_code",
        kind: "tagged_reference",
        createdAt: new Date().toISOString(),
      }) + "\n",
    );

    process.env.MEETLESS_HOME = home;
    process.env.HOME = home;
    // Phase 1 detect stays a hermetic no-op (no conflict advisories).
    process.env.MEETLESS_ACTIVE_REVIEW_STUB_DETECT = JSON.stringify({ detections: [], persisted: false });
    // A3 facts stubbed: old.md is superseded by new.md, approved (LIVE/ACCEPTED).
    process.env.MEETLESS_TAGGED_FACTS_STUB = JSON.stringify([
      { fromPath: "old.md", relationType: "SUPERSEDED_BY", toPath: "new.md", toKbId: "DD:new", posture: "LIVE", status: "ACCEPTED" },
    ]);

    jest.resetModules();
    const mod = await import("../../src/commands/internal-active-review");
    const code = await mod.runInternalActiveReview(["--session", "sess_1"]);
    expect(code).toBe(0);

    const out = JSON.parse(captured[captured.length - 1]);
    expect(out.advisoryText).toContain("old.md");
    expect(out.advisoryText).toContain("superseded by new.md");
    expect(out.advisoryText).toContain("DD:new");
  });

  it("an unapproved (SHADOW/PENDING_REVIEW) fact never surfaces in advisoryText", async () => {
    const home = mkdtempSync(join(tmpdir(), "mlhome-"));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({ controlUrl: "http://127.0.0.1:8000", controlToken: "t", workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
    );
    writeFileSync(
      join(home, "logs", "kb-knowledge.jsonl"),
      JSON.stringify({
        event: "active_memory_record",
        workspaceId: "ws_1",
        ownerUserId: "user_a",
        repoRootHash: "repoA",
        canonicalPath: "old.md",
        contentHash: "",
        sessionId: "sess_1",
        turnIndex: 1,
        sourceProduct: "claude_code",
        kind: "tagged_reference",
        createdAt: new Date().toISOString(),
      }) + "\n",
    );

    process.env.MEETLESS_HOME = home;
    process.env.HOME = home;
    process.env.MEETLESS_ACTIVE_REVIEW_STUB_DETECT = JSON.stringify({ detections: [], persisted: false });
    process.env.MEETLESS_TAGGED_FACTS_STUB = JSON.stringify([
      { fromPath: "old.md", relationType: "SUPERSEDED_BY", toPath: "new.md", toKbId: "DD:new", posture: "SHADOW", status: "PENDING_REVIEW" },
    ]);

    jest.resetModules();
    const mod = await import("../../src/commands/internal-active-review");
    const code = await mod.runInternalActiveReview(["--session", "sess_1"]);
    expect(code).toBe(0);

    const out = JSON.parse(captured[captured.length - 1]);
    expect(out.advisoryText).toBe("");
  });
});
