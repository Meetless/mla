import {
  parseKbPersonalArgs,
  buildPersonalQuery,
  runKbPersonalWith,
  KbPersonalDeps,
  KbPersonalDoc,
} from "../../src/commands/kb_personal";

// Behavioral lock for `mla kb personal list/show` (Phase 3, Task 3.3).
//
//   "`mla kb personal list`: list THIS actor's own Personal-KB docs by calling
//    the owner-scoped GET /internal/v1/kb/documents with the configured actor as
//    owner and posture=SHADOW. `mla kb personal show <id>`: reuse the existing
//    single-doc detail path."
//
// The list view is owner-scoped: the query MUST carry ownerUserId=<actor> and
// posture=SHADOW so a user only ever lists their own personal docs. The returned
// `documents` array is surfaced to the caller verbatim.

function doc(over: Partial<KbPersonalDoc> = {}): KbPersonalDoc {
  return {
    id: "kbd_" + "a".repeat(20),
    canonicalPath: "a.md",
    currentPosture: "SHADOW",
    ownerUserId: "user_a",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...over,
  };
}

describe("mla kb personal: arg parsing", () => {
  it("parses the list subcommand", () => {
    expect(parseKbPersonalArgs(["list"])).toEqual({ sub: "list", id: null, json: false });
  });

  it("parses list --json", () => {
    expect(parseKbPersonalArgs(["list", "--json"])).toEqual({ sub: "list", id: null, json: true });
  });

  it("parses show with a positional id", () => {
    expect(parseKbPersonalArgs(["show", "kbd_x"])).toEqual({ sub: "show", id: "kbd_x", json: false });
  });

  it("rejects show with no id", () => {
    expect(() => parseKbPersonalArgs(["show"])).toThrow(/requires.*id/i);
  });

  it("rejects an unknown subcommand", () => {
    expect(() => parseKbPersonalArgs(["bogus"])).toThrow(/list|show/i);
  });
});

describe("mla kb personal list: query construction", () => {
  it("pins ownerUserId=<actor> and posture=SHADOW for the workspace", () => {
    const qs = buildPersonalQuery("ws_test", "user_a");
    expect(qs).toContain("workspaceId=ws_test");
    expect(qs).toContain("ownerUserId=user_a");
    expect(qs).toContain("posture=SHADOW");
  });

  it("url-encodes the owner id", () => {
    const qs = buildPersonalQuery("ws_test", "user:a/b");
    expect(qs).toContain("ownerUserId=user%3Aa%2Fb");
  });
});

async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    const code = await run();
    return { code, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

const CTX = { workspaceId: "ws_test", ownerUserId: "user_a" };

describe("runKbPersonalWith: list wiring", () => {
  it("fetches with an owner-scoped + posture=SHADOW query and surfaces the documents", async () => {
    let seenQs = "";
    const deps: KbPersonalDeps = {
      fetchPersonal: async (qs) => {
        seenQs = qs;
        return { documents: [doc()] };
      },
      showDocument: async () => 0,
    };

    const out = await runKbPersonalWith(["list"], CTX, deps);

    // The owner-scoping invariant: every list request carries the actor as owner.
    expect(seenQs).toContain("ownerUserId=user_a");
    expect(seenQs).toContain("posture=SHADOW");
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0].canonicalPath).toBe("a.md");
  });

  it("renders a concise human list and returns code 0", async () => {
    const deps: KbPersonalDeps = {
      fetchPersonal: async () => ({ documents: [doc(), doc({ id: "kbd_b", canonicalPath: "b.md" })] }),
      showDocument: async () => 0,
    };
    const res = await capture(() => runKbPersonalWith(["list"], CTX, deps).then((r) => r.code));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("a.md");
    expect(res.stdout).toContain("b.md");
  });

  it("reports an empty personal KB plainly", async () => {
    const deps: KbPersonalDeps = {
      fetchPersonal: async () => ({ documents: [] }),
      showDocument: async () => 0,
    };
    const res = await capture(() => runKbPersonalWith(["list"], CTX, deps).then((r) => r.code));
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/no personal|empty/i);
  });
});

describe("runKbPersonalWith: show delegation", () => {
  // The id `mla kb personal list` prints is a bare KbDocument cuid. `mla kb show`
  // only skips path-resolution when the input parses as `kbdoc:<id>`; a bare token
  // is classified as a canonical PATH and 404s ("no KbDocument matches that path").
  // So the delegate MUST normalize a bare id to the kbdoc: form before handing off,
  // or `mla kb personal show <id>` can never resolve the very ids `list` emits.
  it("normalizes a bare id to kbdoc:<id> for the detail path", async () => {
    let seenId = "";
    const deps: KbPersonalDeps = {
      fetchPersonal: async () => ({ documents: [] }),
      showDocument: async (id) => {
        seenId = id;
        return 0;
      },
    };
    const out = await runKbPersonalWith(["show", "kbd_x"], CTX, deps);
    expect(seenId).toBe("kbdoc:kbd_x");
    expect(out.code).toBe(0);
  });

  it("passes an already-prefixed kbdoc:<id> through without double-prefixing", async () => {
    let seenId = "";
    const deps: KbPersonalDeps = {
      fetchPersonal: async () => ({ documents: [] }),
      showDocument: async (id) => {
        seenId = id;
        return 0;
      },
    };
    const out = await runKbPersonalWith(["show", "kbdoc:kbd_x"], CTX, deps);
    expect(seenId).toBe("kbdoc:kbd_x");
    expect(out.code).toBe(0);
  });
});
