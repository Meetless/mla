import { runKbAccept, runKbReject, parseKbRevisionArgs } from "../../src/commands/kb_revision";

// `mla kb accept <doc-id>` / `mla kb reject <doc-id>` (trust verdict).
//
// These record a reviewer's verdict on a KB document's HEAD revision: accept
// flips its reviewOutcome PENDING -> ACCEPTED, reject flips it to REJECTED. The
// verb makes TWO intel calls, mirroring `mla kb show`'s resolve-then-act shape:
//   1. GET  /internal/v1/kb/documents/<id>/detail?workspaceId=<ws>  (resolve head)
//   2. POST /internal/v1/kb/documents/<id>/review?workspaceId=<ws>  (record verdict)
// The POST carries the head revisionId + its expectedPriorOutcome (read from the
// detail bundle) and the actor in the BODY; workspaceId rides in the query string.
// The arg parser, the two call shapes, and the exit codes are all driven offline
// through deps injection (no network, config, or disk).
//
// Naming note locked by these tests: accept/reject act on a DOCUMENT id and the
// verb resolves its head revision. A `note:`/`kbdocrev:` input is a usage error,
// not a silent path resolution, because the verb is doc-id-keyed.

const baseCfg = {
  workspaceId: "ws_1",
  actorUserId: "user_a",
  intelUrl: "http://127.0.0.1:8100",
};

// A recording double for the resolve GET + the verdict POST. `priorOutcome`
// controls the head revision's current trust the GET reports (default PENDING).
function recordingHttp(opts?: { priorOutcome?: string; reviewOverrides?: Record<string, unknown> }) {
  const calls: Array<{ kind: "get" | "post"; path: string; body?: any }> = [];
  const prior = opts?.priorOutcome ?? "PENDING";
  const intelGet = async (_c: any, path: string) => {
    calls.push({ kind: "get", path });
    return {
      document: { documentId: "doc_1", currentRevisionId: "rev_head" },
      headRevision: { revisionId: "rev_head", reviewOutcome: prior },
    };
  };
  const intelPost = async (_c: any, path: string, body: any) => {
    calls.push({ kind: "post", path, body });
    return {
      reviewEventId: "revt_1",
      revisionId: body.revisionId,
      documentId: "doc_1",
      eventSequence: 1,
      priorOutcome: body.expectedPriorOutcome,
      newOutcome: body.outcome,
      actorId: "user_a",
      reviewMethod: "EXPLICIT_REVIEW",
      reviewedAt: "2026-07-05T00:00:00.000Z",
      idempotentReplay: false,
      ...opts?.reviewOverrides,
    };
  };
  return { calls, http: { intelGet, intelPost } };
}

describe("mla kb accept/reject arg parsing", () => {
  it("parses a bare document id", () => {
    const p = parseKbRevisionArgs(["doc_1"]);
    expect(p.documentId).toBe("doc_1");
    expect(p.json).toBe(false);
  });

  it("strips the kbdoc: prefix to the raw id", () => {
    const p = parseKbRevisionArgs(["kbdoc:doc_1"]);
    expect(p.documentId).toBe("doc_1");
  });

  it("accepts an optional --workspace and --json", () => {
    const p = parseKbRevisionArgs(["doc_1", "--workspace", "ws_9", "--json"]);
    expect(p.workspace).toBe("ws_9");
    expect(p.json).toBe(true);
  });

  it("throws when the document id is missing", () => {
    expect(() => parseKbRevisionArgs([])).toThrow();
  });

  it("throws on a note: input (verb is doc-id-keyed, not path-resolving)", () => {
    expect(() => parseKbRevisionArgs(["note:20260301-source.md"])).toThrow();
  });

  it("throws on a kbdocrev: input (the verb resolves the head revision itself)", () => {
    expect(() => parseKbRevisionArgs(["kbdocrev:rev_1"])).toThrow();
  });

  it("throws on a second positional", () => {
    expect(() => parseKbRevisionArgs(["doc_1", "doc_2"])).toThrow();
  });

  it("throws on an unknown flag", () => {
    expect(() => parseKbRevisionArgs(["doc_1", "--bogus"])).toThrow();
  });

  it("throws when --workspace has no value", () => {
    expect(() => parseKbRevisionArgs(["doc_1", "--workspace"])).toThrow();
  });

  it("no longer accepts the removed --reason flag", () => {
    expect(() => parseKbRevisionArgs(["doc_1", "--reason", "x"])).toThrow();
  });
});

describe("mla kb accept", () => {
  it("resolves the head revision then POSTs the verdict to the review route", async () => {
    const { calls, http } = recordingHttp();
    const code = await runKbAccept(["doc_1"], { cfg: baseCfg as any, http: http as any });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].kind).toBe("get");
    expect(calls[0].path).toBe("/internal/v1/kb/documents/doc_1/detail?workspaceId=ws_1");
    expect(calls[1].kind).toBe("post");
    expect(calls[1].path).toBe("/internal/v1/kb/documents/doc_1/review?workspaceId=ws_1");
    expect(calls[1].body.revisionId).toBe("rev_head");
    expect(calls[1].body.outcome).toBe("ACCEPTED");
    expect(calls[1].body.expectedPriorOutcome).toBe("PENDING");
    expect(calls[1].body.actorUserId).toBe("user_a");
  });

  it("uses the raw id (no kbdoc: prefix) in both URL paths", async () => {
    const { calls, http } = recordingHttp();
    await runKbAccept(["kbdoc:doc_1"], { cfg: baseCfg as any, http: http as any });
    expect(calls[0].path).toContain("/kb/documents/doc_1/detail");
    expect(calls[1].path).toContain("/kb/documents/doc_1/review");
  });

  it("short-circuits to a no-op when the head is already ACCEPTED (no POST)", async () => {
    const { calls, http } = recordingHttp({ priorOutcome: "ACCEPTED" });
    const code = await runKbAccept(["doc_1"], { cfg: baseCfg as any, http: http as any });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1); // resolve only, no verdict POST
    expect(calls[0].kind).toBe("get");
  });

  it("emits the recorded verdict as JSON under --json", async () => {
    const { http } = recordingHttp();
    const logs: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((m?: any) => {
      logs.push(String(m));
    });
    try {
      await runKbAccept(["doc_1", "--json"], { cfg: baseCfg as any, http: http as any });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.newOutcome).toBe("ACCEPTED");
    expect(parsed.priorOutcome).toBe("PENDING");
    expect(parsed.revisionId).toBe("rev_head");
  });

  it("returns exit 1 when the review POST fails", async () => {
    const http = {
      intelGet: async () => ({
        document: { documentId: "doc_1", currentRevisionId: "rev_head" },
        headRevision: { revisionId: "rev_head", reviewOutcome: "PENDING" },
      }),
      intelPost: async () => {
        const err: any = new Error("POST .../review -> HTTP 409");
        err.status = 409;
        err.body = JSON.stringify({ code: "KB_REVIEW_STALE" });
        throw err;
      },
    };
    const code = await runKbAccept(["doc_1"], { cfg: baseCfg as any, http: http as any });
    expect(code).toBe(1);
  });

  it("returns exit 1 when the doc has no head revision to review", async () => {
    const http = {
      intelGet: async () => ({
        document: { documentId: "doc_1", currentRevisionId: null },
        headRevision: null,
      }),
      intelPost: async () => {
        throw new Error("should not be called");
      },
    };
    const code = await runKbAccept(["doc_1"], { cfg: baseCfg as any, http: http as any });
    expect(code).toBe(1);
  });

  it("treats a missing document id as a usage error (exit 2, no HTTP call)", async () => {
    const { calls, http } = recordingHttp();
    const code = await runKbAccept([], { cfg: baseCfg as any, http: http as any });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("mla kb reject", () => {
  it("POSTs a REJECTED verdict against the head revision", async () => {
    const { calls, http } = recordingHttp();
    const code = await runKbReject(["doc_1"], { cfg: baseCfg as any, http: http as any });
    expect(code).toBe(0);
    expect(calls[1].path).toBe("/internal/v1/kb/documents/doc_1/review?workspaceId=ws_1");
    expect(calls[1].body.outcome).toBe("REJECTED");
    expect(calls[1].body.actorUserId).toBe("user_a");
  });

  it("surfaces the drop-from-serving consequence in the receipt", async () => {
    const { http } = recordingHttp();
    const logs: string[] = [];
    const spy = jest.spyOn(console, "log").mockImplementation((m?: any) => {
      logs.push(String(m));
    });
    try {
      await runKbReject(["doc_1"], { cfg: baseCfg as any, http: http as any });
    } finally {
      spy.mockRestore();
    }
    expect(logs.join("\n")).toContain("no longer grounds answers");
  });

  it("short-circuits to a no-op when the head is already REJECTED (no POST)", async () => {
    const { calls, http } = recordingHttp({ priorOutcome: "REJECTED" });
    const code = await runKbReject(["doc_1"], { cfg: baseCfg as any, http: http as any });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("returns exit 1 when the resolve GET fails", async () => {
    const http = {
      intelGet: async () => {
        const err: any = new Error("GET .../detail -> HTTP 404");
        err.status = 404;
        err.body = "not found";
        throw err;
      },
      intelPost: async () => {
        throw new Error("should not be called");
      },
    };
    const code = await runKbReject(["doc_1"], { cfg: baseCfg as any, http: http as any });
    expect(code).toBe(1);
  });
});
