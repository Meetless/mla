import { runKbPromote } from "../../src/commands/kb_promote";

// `mla kb promote` now flips SCOPE (PERSON -> WORKSPACE) via
// POST /internal/v1/kb/documents/<id>/scope. It used to PATCH a dead
// .../posture route (404 since the 2026-06-21 two-axis cutover). These tests
// pin the new transport: intelPost, a `scope` body of "WORKSPACE", the id in
// the path (kbdoc: prefix stripped), and the workspaceId as a query param.

describe("mla kb promote", () => {
  it("promote posts scope WORKSPACE to the /scope route", async () => {
    const calls: any[] = [];
    const http = {
      intelPost: async (_c: any, path: string, body: any) => {
        calls.push({ path, body });
        return { documentId: "doc_1", scope: "WORKSPACE" };
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    await runKbPromote(["doc_1"], { cfg: cfg as any, http: http as any });
    expect(calls[0].path).toContain("/kb/documents/doc_1/scope");
    expect(calls[0].path).toContain("workspaceId=ws_1");
    expect(calls[0].body.scope).toBe("WORKSPACE");
    expect(calls[0].body.actorBy).toBe("user_a");
  });

  it("forwards --reason into the scope body", async () => {
    const calls: any[] = [];
    const http = {
      intelPost: async (_c: any, path: string, body: any) => {
        calls.push({ path, body });
        return { documentId: "doc_1", scope: "WORKSPACE" };
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    await runKbPromote(["doc_1", "--reason", "team needs it"], {
      cfg: cfg as any,
      http: http as any,
    });
    expect(calls[0].body.reason).toBe("team needs it");
  });

  it("strips a kbdoc: prefix so `promote kbdoc:<id>` hits the right route (F4)", async () => {
    // Dogfood friction (2026-06-10 F5): kb add / reingest receipts print the id
    // as `kbdoc:<cuid>`, so operators copy-paste `mla kb promote kbdoc:<cuid>`.
    // The prefix used to flow verbatim into the URL -> /kb/documents/kbdoc:<id>/
    // scope -> 404. The prefix must be stripped to the bare cuid.
    const calls: any[] = [];
    const http = {
      intelPost: async (_c: any, path: string, body: any) => {
        calls.push({ path, body });
        return { documentId: "doc_1", scope: "WORKSPACE" };
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    await runKbPromote(["kbdoc:doc_1"], { cfg: cfg as any, http: http as any });
    expect(calls[0].path).toContain("/kb/documents/doc_1/scope");
    expect(calls[0].path).not.toContain("kbdoc:");
  });

  it("strips the kbdoc: prefix on the --reject path too", async () => {
    const recordReject = jest.fn();
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a" };
    const out = await runKbPromote(["--reject", "kbdoc:doc_1"], {
      cfg: cfg as any,
      http: { intelPost: async () => ({}) } as any,
      recordReject,
    });
    expect(out.rejected).toBe(true);
    expect(recordReject).toHaveBeenCalledWith(cfg, "doc_1"); // bare cuid, no prefix
  });

  it("--reject preserves the personal doc (no scope change, no delete) (test 16)", async () => {
    const calls: any[] = [];
    const http = {
      intelPost: async () => {
        calls.push("post");
        return {};
      },
    };
    // Inject a spy recorder so the test stays hermetic (no write to the real
    // ~/.meetless/logs/kb-share-rejections.jsonl) and so we can assert the
    // decline is actually recorded. The spool filename keeps the legacy
    // `kb-share` spelling on purpose (durable append-only contract; the command
    // was renamed promote but the record name stays stable).
    const recordReject = jest.fn();
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a" };
    const out = await runKbPromote(["--reject", "doc_1"], {
      cfg: cfg as any,
      http: http as any,
      recordReject,
    });
    expect(calls).toHaveLength(0); // no scope call; doc stays Personal and undeleted
    expect(out.rejected).toBe(true);
    expect(recordReject).toHaveBeenCalledTimes(1);
    expect(recordReject).toHaveBeenCalledWith(cfg, "doc_1");
  });

  it("a failed promote POST returns a nonzero exit code and does not reject", async () => {
    // The injected transport throws an HttpError-shaped failure (status + body,
    // like the real http client). runKbPromote must catch it, surface the error,
    // and return code 1 without letting the rejection escape.
    const http = {
      intelPost: async () => {
        const err: any = new Error("POST /scope -> HTTP 409: already shared");
        err.status = 409;
        err.body = "already shared";
        throw err;
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    const out = await runKbPromote(["doc_1"], { cfg: cfg as any, http: http as any });
    expect(out.code).toBe(1);
    expect(out.rejected).toBe(false);
  });

  it("the promote path does not record a rejection", async () => {
    // Promote and decline are distinct: a successful promotion never touches the
    // rejection recorder.
    const http = {
      intelPost: async () => ({ documentId: "doc_1", scope: "WORKSPACE" }),
    };
    const recordReject = jest.fn();
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a" };
    const out = await runKbPromote(["doc_1"], {
      cfg: cfg as any,
      http: http as any,
      recordReject,
    });
    expect(out.rejected).toBe(false);
    expect(out.code).toBe(0);
    expect(recordReject).not.toHaveBeenCalled();
  });
});
