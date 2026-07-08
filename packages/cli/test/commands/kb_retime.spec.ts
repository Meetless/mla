import { runKbRetime, parseKbRetimeArgs } from "../../src/commands/kb_retime";

// `mla kb retime <source-item> --effective-date <date>` (Phase 5.3).
//
// retime fixes the SOURCE ITEM's trusted effective date. The non-negotiable
// contract this spec locks: it routes to the Phase 4 correction path
// (POST /internal/v1/kb/retime -> create_temporal_correction), which stales and
// REGENERATES derived relations under the Option-3 invariant. It must NEVER hit
// a raw relation-update route that would edit an accepted relation's valid_at in
// place. The arg parser, the client-side date validation, and the exit codes are
// all driven offline through deps injection (no network, config, or disk).

const baseCfg = {
  workspaceId: "ws_1",
  actorUserId: "user_a",
  intelUrl: "http://127.0.0.1:8100",
};

function recordingPost() {
  const calls: any[] = [];
  const intelPost = async (_c: any, path: string, body: any) => {
    calls.push({ path, body });
    return {
      workspaceId: "ws_1",
      sourceItemId: "note:20260301-source.md",
      effectiveDate: "2026-04-01T00:00:00+00:00",
      newAnchorId: "anc_new",
      priorAnchorId: "anc_old",
      staledRelationIds: ["rel_1"],
      regeneratedRelationIds: ["rel_2"],
      regenerated: true,
    };
  };
  return { calls, http: { intelPost } };
}

describe("mla kb retime arg parsing", () => {
  it("parses a source item id plus --effective-date", () => {
    const p = parseKbRetimeArgs(["note:20260301-source.md", "--effective-date", "2026-04-01"]);
    expect(p.sourceItemId).toBe("note:20260301-source.md");
    expect(p.effectiveDate).toBe("2026-04-01");
    expect(p.json).toBe(false);
  });

  it("accepts an optional --reason and --json", () => {
    const p = parseKbRetimeArgs([
      "note:x.md",
      "--effective-date",
      "2026-04-01",
      "--reason",
      "wrong date",
      "--json",
    ]);
    expect(p.reason).toBe("wrong date");
    expect(p.json).toBe(true);
  });

  it("throws when the source item id is missing", () => {
    expect(() => parseKbRetimeArgs(["--effective-date", "2026-04-01"])).toThrow();
  });

  it("throws when --effective-date has no value", () => {
    expect(() => parseKbRetimeArgs(["note:x.md", "--effective-date"])).toThrow();
  });

  it("throws on an unknown flag", () => {
    expect(() => parseKbRetimeArgs(["note:x.md", "--effective-date", "2026-04-01", "--bogus"])).toThrow();
  });
});

describe("mla kb retime", () => {
  it("POSTs to the correction route with the actor in the body", async () => {
    const { calls, http } = recordingPost();
    const code = await runKbRetime(
      ["note:20260301-source.md", "--effective-date", "2026-04-01"],
      { cfg: baseCfg as any, http: http as any },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/internal/v1/kb/retime");
    // The actor rides in the body (intel's CLI HTTP layer stamps no actor header).
    expect(calls[0].body.actor).toBe("user_a");
    expect(calls[0].body.workspaceId).toBe("ws_1");
    expect(calls[0].body.sourceItemId).toBe("note:20260301-source.md");
  });

  it("routes to the correction endpoint, NOT a raw relation-update route", async () => {
    // The core Option-3 guarantee: retime corrects a SOURCE ITEM's effective date
    // and regenerates derived relations. It must never PATCH/PUT a relation's
    // valid_at in place. This pins the path so a future refactor cannot silently
    // re-point retime at a relation-mutation route.
    const { calls, http } = recordingPost();
    await runKbRetime(["note:x.md", "--effective-date", "2026-04-01"], {
      cfg: baseCfg as any,
      http: http as any,
    });
    const path = calls[0].path;
    expect(path).toContain("/kb/retime");
    expect(path).not.toMatch(/relations?\//);
    expect(path).not.toMatch(/valid[_-]?at/i);
  });

  it("sends the client-normalized RFC3339 instant for effectiveDate", async () => {
    // Client-side parseAsOf normalizes YYYY-MM-DD to a UTC instant before the
    // POST, so the server never has to guess a clock from a bare calendar date.
    const { calls, http } = recordingPost();
    await runKbRetime(["note:x.md", "--effective-date", "2026-04-01"], {
      cfg: baseCfg as any,
      http: http as any,
    });
    expect(calls[0].body.effectiveDate).toBe("2026-04-01T00:00:00.000Z");
  });

  it("forwards an optional --reason in the body", async () => {
    const { calls, http } = recordingPost();
    await runKbRetime(
      ["note:x.md", "--effective-date", "2026-04-01", "--reason", "wrong effective date"],
      { cfg: baseCfg as any, http: http as any },
    );
    expect(calls[0].body.reason).toBe("wrong effective date");
  });

  it("rejects a malformed --effective-date with exit 2 and no HTTP call", async () => {
    const { calls, http } = recordingPost();
    const code = await runKbRetime(["note:x.md", "--effective-date", "not-a-date"], {
      cfg: baseCfg as any,
      http: http as any,
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("treats a missing source item id as a usage error (exit 2, no HTTP call)", async () => {
    const { calls, http } = recordingPost();
    const code = await runKbRetime(["--effective-date", "2026-04-01"], {
      cfg: baseCfg as any,
      http: http as any,
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("treats a missing --effective-date as a usage error (exit 2, no HTTP call)", async () => {
    const { calls, http } = recordingPost();
    const code = await runKbRetime(["note:x.md"], {
      cfg: baseCfg as any,
      http: http as any,
    });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("returns exit 1 when the correction POST fails", async () => {
    const http = {
      intelPost: async () => {
        const err: any = new Error("POST /kb/retime -> HTTP 404: not found");
        err.status = 404;
        err.body = "not found";
        throw err;
      },
    };
    const code = await runKbRetime(["note:x.md", "--effective-date", "2026-04-01"], {
      cfg: baseCfg as any,
      http: http as any,
    });
    expect(code).toBe(1);
  });
});
