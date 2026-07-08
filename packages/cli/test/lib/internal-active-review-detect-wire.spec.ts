import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Gate: `mla _internal active-review` REAL detect path (no stub) must POST a body
// the intel endpoint (ActiveReviewDetectRequest) actually accepts. The endpoint
// requires a top-level `ownerUserId` (INV-DETECTION-OWNER-SCOPED, owner-scoped
// corpus) AND each candidate must match ActiveReviewCandidate {canonicalPath,
// body, kind}. The Zone 1 spool is metadata-only (contentHash, no body), so at
// review time the CLI reads the produced doc's CURRENT content from disk
// (absPath = join(repoRoot, canonicalPath), the same resolution Zone 2 auto-index
// uses) and sends that as candidate.body, so the in-process detector has real text
// to score against the approved corpus. The absolute repoRoot stays LOCAL: only
// the file CONTENT and the relative canonicalPath go on the wire.
//
// This drives the REAL intel client (MEETLESS_ACTIVE_REVIEW_STUB_DETECT unset),
// intercepting global.fetch to capture the exact wire body. The existing specs
// only exercise the STUB seam, which is why a missing ownerUserId/body slipped
// past a green suite: the stub never builds the HTTP request.

interface CapturedCall {
  url: string;
  body: unknown;
}

describe("internal active-review REAL detect wire body (Phase 1, owner scope)", () => {
  const ORIG_ENV = { ...process.env };
  const ORIG_CWD = process.cwd();
  const ORIG_FETCH = global.fetch;
  let logSpy: jest.SpyInstance;
  let captured: string[];
  let calls: CapturedCall[];

  beforeEach(() => {
    captured = [];
    calls = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env = { ...ORIG_ENV };
    process.chdir(ORIG_CWD);
    global.fetch = ORIG_FETCH;
    jest.resetModules();
  });

  it("posts ownerUserId and candidate {canonicalPath, body, kind} with the produced-doc body read from disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "mlhome-"));
    mkdirSync(join(home, "logs"), { recursive: true });
    // The produced doc on disk: repoRoot is `home`, canonicalPath is relative, so
    // the CLI resolves absPath = join(home, "notes/new.md") and sends THIS content
    // as candidate.body. This is what the detector scores against the corpus.
    const DOC_BODY = "We are deferring SSO enforcement to Q3 2026.\n";
    mkdirSync(join(home, "notes"), { recursive: true });
    writeFileSync(join(home, "notes", "new.md"), DOC_BODY);
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:8000",
        controlToken: "t",
        actorUserId: "user_a",
        intelUrl: "http://127.0.0.1:8100",
      }),
    );
    // The real path resolves workspaceId from the nearest `.meetless.json`
    // marker (folder = workspace), NOT from cli-config. Plant one in home and
    // run from there so loadWorkspaceConfig resolves ws_1 instead of throwing
    // NotActivatedError (which P6 would swallow, masking the real assertion).
    writeFileSync(join(home, ".meetless.json"), JSON.stringify({ workspaceId: "ws_1" }));
    // One produced_doc record (metadata-only: no body, just like the hook writes).
    // It carries the absolute `repoRoot` so the CLI can resolve the doc on disk
    // (LOCAL-only; never transmitted, only the file CONTENT is).
    writeFileSync(
      join(home, "logs", "kb-knowledge.jsonl"),
      JSON.stringify({
        event: "active_memory_record",
        workspaceId: "ws_1",
        ownerUserId: "user_a",
        repoRootHash: "repoA",
        repoRoot: home,
        canonicalPath: "notes/new.md",
        contentHash: "deadbeef",
        sessionId: "sess_1",
        turnIndex: 1,
        sourceProduct: "claude_code",
        kind: "produced_doc",
        createdAt: new Date().toISOString(),
      }) + "\n",
    );

    process.env.MEETLESS_HOME = home;
    process.env.HOME = home;
    process.chdir(home);
    // No detect stub: exercise the real HTTP client.
    delete process.env.MEETLESS_ACTIVE_REVIEW_STUB_DETECT;
    delete process.env.MEETLESS_TAGGED_FACTS_STUB;

    // Capture the wire body; return a valid dry-run response.
    global.fetch = jest.fn(async (url: unknown, init: unknown) => {
      const i = (init || {}) as { body?: string };
      calls.push({ url: String(url), body: i.body ? JSON.parse(i.body) : undefined });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ detections: [], persisted: false }),
        headers: { get: () => null },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    jest.resetModules();
    const mod = await import("../../src/commands/internal-active-review");
    const code = await mod.runInternalActiveReview(["--session", "sess_1"]);
    expect(code).toBe(0);

    // The real detect call fired exactly once, to the detect endpoint.
    const detectCalls = calls.filter((c) => c.url.includes("/internal/v1/active-review/detect"));
    expect(detectCalls).toHaveLength(1);

    const body = detectCalls[0].body as {
      workspaceId?: string;
      ownerUserId?: string;
      dryRun?: boolean;
      candidates?: Array<{ canonicalPath?: string; body?: string; kind?: string }>;
    };
    // Top-level contract: owner-scoped + dry-run + env-pinned workspace.
    expect(body.workspaceId).toBe("ws_1");
    expect(body.ownerUserId).toBe("user_a");
    expect(body.dryRun).toBe(true);
    // Candidate contract: exactly ActiveReviewCandidate {canonicalPath, body, kind}.
    expect(body.candidates).toHaveLength(1);
    const cand = body.candidates![0];
    expect(cand.canonicalPath).toBe("notes/new.md");
    expect(cand.kind).toBe("produced_doc");
    // body is the doc's CURRENT on-disk content (read at review time via repoRoot),
    // not the empty placeholder the metadata-only spool carries.
    expect(cand.body).toBe(DOC_BODY);
  });
});
