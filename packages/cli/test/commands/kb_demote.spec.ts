import { runKbDemote } from "../../src/commands/kb_demote";

// `mla kb demote` is the reverse of promote: it flips SCOPE (WORKSPACE ->
// PERSON) via POST /internal/v1/kb/documents/<id>/scope. It shares the flip
// core (kb_scope.ts) with promote, so these tests focus on demote-specific
// behavior: the PERSON target, no --reject path, and the shared arg parsing.

describe("mla kb demote", () => {
  it("demote posts scope PERSON to the /scope route", async () => {
    const calls: any[] = [];
    const http = {
      intelPost: async (_c: any, path: string, body: any) => {
        calls.push({ path, body });
        return { documentId: "doc_1", scope: "PERSON" };
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    const out = await runKbDemote(["doc_1"], { cfg: cfg as any, http: http as any });
    expect(out.code).toBe(0);
    expect(calls[0].path).toContain("/kb/documents/doc_1/scope");
    expect(calls[0].path).toContain("workspaceId=ws_1");
    expect(calls[0].body.scope).toBe("PERSON");
    expect(calls[0].body.actorBy).toBe("user_a");
  });

  it("forwards --reason into the scope body", async () => {
    const calls: any[] = [];
    const http = {
      intelPost: async (_c: any, path: string, body: any) => {
        calls.push({ path, body });
        return { documentId: "doc_1", scope: "PERSON" };
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    await runKbDemote(["doc_1", "--reason", "was overshared"], {
      cfg: cfg as any,
      http: http as any,
    });
    expect(calls[0].body.reason).toBe("was overshared");
  });

  it("strips a kbdoc: prefix so `demote kbdoc:<id>` hits the right route", async () => {
    const calls: any[] = [];
    const http = {
      intelPost: async (_c: any, path: string, body: any) => {
        calls.push({ path, body });
        return { documentId: "doc_1", scope: "PERSON" };
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    await runKbDemote(["kbdoc:doc_1"], { cfg: cfg as any, http: http as any });
    expect(calls[0].path).toContain("/kb/documents/doc_1/scope");
    expect(calls[0].path).not.toContain("kbdoc:");
  });

  it("rejects --reject as an unknown flag (demote has no decline path)", async () => {
    // Promote's --reject declines a share; demote has nothing to decline. The
    // flag must be a usage error (code 2), not silently accepted.
    const calls: any[] = [];
    const http = {
      intelPost: async () => {
        calls.push("post");
        return {};
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a" };
    const out = await runKbDemote(["--reject", "doc_1"], { cfg: cfg as any, http: http as any });
    expect(out.code).toBe(2);
    expect(calls).toHaveLength(0); // never reached the transport
  });

  it("a failed demote POST returns a nonzero exit code", async () => {
    const http = {
      intelPost: async () => {
        const err: any = new Error("POST /scope -> HTTP 409: not rescopable");
        err.status = 409;
        err.body = "not rescopable";
        throw err;
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" };
    const out = await runKbDemote(["doc_1"], { cfg: cfg as any, http: http as any });
    expect(out.code).toBe(1);
  });

  it("a missing document id is a usage error", async () => {
    const calls: any[] = [];
    const http = {
      intelPost: async () => {
        calls.push("post");
        return {};
      },
    };
    const cfg = { workspaceId: "ws_1", actorUserId: "user_a" };
    const out = await runKbDemote([], { cfg: cfg as any, http: http as any });
    expect(out.code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
