import { runKbPromote } from "../../src/commands/kb_promote";

describe("mla kb promote", () => {
  it("promote calls the posture PATCH to LIVE", async () => {
    const calls: any[] = [];
    const http = {
      intelPatch: async (_c: any, path: string, body: any) => {
        calls.push({ path, body });
        return { documentId: "doc_1", currentPosture: "LIVE" };
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    await runKbPromote(["doc_1"], { cfg: cfg as any, http: http as any });
    expect(calls[0].path).toContain("/kb/documents/doc_1/posture");
    expect(calls[0].body.posture).toBe("LIVE");
  });

  it("strips a kbdoc: prefix so `promote kbdoc:<id>` hits the right route (F4)", async () => {
    // Dogfood friction (2026-06-10 F5): kb add / reingest receipts print the id
    // as `kbdoc:<cuid>`, so operators copy-paste `mla kb promote kbdoc:<cuid>`.
    // The prefix used to flow verbatim into the URL -> /kb/documents/kbdoc:<id>/
    // posture -> 404 with a misleading "intel does not expose the posture
    // endpoint" message. The prefix must be stripped to the bare cuid.
    const calls: any[] = [];
    const http = {
      intelPatch: async (_c: any, path: string, body: any) => {
        calls.push({ path, body });
        return { documentId: "doc_1", currentPosture: "LIVE" };
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    await runKbPromote(["kbdoc:doc_1"], { cfg: cfg as any, http: http as any });
    expect(calls[0].path).toContain("/kb/documents/doc_1/posture");
    expect(calls[0].path).not.toContain("kbdoc:");
  });

  it("strips the kbdoc: prefix on the --reject path too", async () => {
    const recordReject = jest.fn();
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a" };
    const out = await runKbPromote(["--reject", "kbdoc:doc_1"], {
      cfg: cfg as any,
      http: { intelPatch: async () => ({}) } as any,
      recordReject,
    });
    expect(out.rejected).toBe(true);
    expect(recordReject).toHaveBeenCalledWith(cfg, "doc_1"); // bare cuid, no prefix
  });

  it("--reject preserves the personal doc (no posture change, no delete) (test 16)", async () => {
    const calls: any[] = [];
    const http = {
      intelPatch: async () => {
        calls.push("patch");
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
    expect(calls).toHaveLength(0); // no posture call; doc stays SHADOW and undeleted
    expect(out.rejected).toBe(true);
    expect(recordReject).toHaveBeenCalledTimes(1);
    expect(recordReject).toHaveBeenCalledWith(cfg, "doc_1");
  });

  it("a failed promote PATCH returns a nonzero exit code and does not reject", async () => {
    // The injected transport throws an HttpError-shaped failure (status + body,
    // like the real http client). runKbPromote must catch it, surface the error,
    // and return code 1 without letting the rejection escape.
    const http = {
      intelPatch: async () => {
        const err: any = new Error("PATCH /posture -> HTTP 404: not found");
        err.status = 404;
        err.body = "not found";
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
      intelPatch: async () => ({ documentId: "doc_1", currentPosture: "LIVE" }),
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
