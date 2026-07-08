import {
  parseGraphConnectionsArgs,
  renderConnectionsHuman,
  renderConnectionsJson,
  runGraphConnectionsWith,
  ConnectionsView,
  RelationAssertionItem,
  PendingConnectionsResponse,
  GraphConnectionsDeps,
} from "../../src/commands/graph_connections";

const base = "https://app.meetless.ai";

function item(over: Partial<RelationAssertionItem> = {}): RelationAssertionItem {
  return {
    assertionId: "ra_1",
    relationType: "CONTRADICTS",
    subjectLabel: "Claim A about auth",
    objectLabel: "Claim B about auth",
    subjectStableIdentity: "claim:aaaa",
    objectStableIdentity: "claim:bbbb",
    reviewOutcome: "PENDING",
    createdAt: "2026-07-05T00:00:00.000Z",
    ...over,
  };
}

function view(items: RelationAssertionItem[], count?: number): ConnectionsView {
  return {
    workspaceId: "ws1",
    consoleBase: base,
    count: count ?? items.length,
    items,
  };
}

describe("parseGraphConnectionsArgs", () => {
  it("defaults to human output and limit 200", () => {
    expect(parseGraphConnectionsArgs([])).toEqual({ json: false, limit: 200 });
  });

  it("accepts --json and --limit", () => {
    expect(parseGraphConnectionsArgs(["--json"])).toEqual({ json: true, limit: 200 });
    expect(parseGraphConnectionsArgs(["--limit", "50"])).toEqual({ json: false, limit: 50 });
    expect(parseGraphConnectionsArgs(["--limit", "50", "--json"])).toEqual({ json: true, limit: 50 });
  });

  it("rejects a non-integer, out-of-range, or missing --limit", () => {
    expect(() => parseGraphConnectionsArgs(["--limit"])).toThrow(/requires a value/);
    expect(() => parseGraphConnectionsArgs(["--limit", "0"])).toThrow(/between 1 and 500/);
    expect(() => parseGraphConnectionsArgs(["--limit", "501"])).toThrow(/between 1 and 500/);
    expect(() => parseGraphConnectionsArgs(["--limit", "x"])).toThrow(/between 1 and 500/);
  });

  it("rejects unknown flags and positionals", () => {
    expect(() => parseGraphConnectionsArgs(["--nope"])).toThrow(/Unknown flag/);
    expect(() => parseGraphConnectionsArgs(["foo"])).toThrow(/no positional args/);
  });
});

describe("renderConnectionsHuman", () => {
  it("renders the relation type, both endpoint labels, the id, and the MCP verdict pointer", () => {
    const text = renderConnectionsHuman(view([item()]));
    expect(text).toContain("[CONTRADICTS]");
    expect(text).toContain("Claim A about auth");
    expect(text).toContain("Claim B about auth");
    expect(text).toContain("id ra_1");
    // The verdict path for THIS surface is the MCP tool, never an `mla` verb.
    expect(text).toContain("relationship_verdict");
    expect(text).toContain(`${base}/relationships`);
  });

  it("distinguishes the page from the full backlog (showing X of N)", () => {
    const text = renderConnectionsHuman(view([item()], 2657));
    expect(text).toMatch(/2657 pending relationship connections \(showing 1\)/);
    expect(text).toMatch(/Showing 1 of 2657/);
  });

  it("falls back to the stable identity when a label is missing", () => {
    const text = renderConnectionsHuman(
      view([item({ subjectLabel: null, objectLabel: "  " })]),
    );
    // subject: null label -> stable identity; object: whitespace label -> stable identity.
    expect(text).toContain("claim:aaaa");
    expect(text).toContain("claim:bbbb");
  });

  it("shows an explicit empty message (not a bare zero)", () => {
    const text = renderConnectionsHuman(view([], 0));
    expect(text).toMatch(/No pending relationship connections \(workspace ws1\)/);
  });
});

describe("renderConnectionsJson", () => {
  it("emits count, shown, the MCP verdict path, and structured connections", () => {
    const json = JSON.parse(renderConnectionsJson(view([item()], 2657)));
    expect(json.count).toEqual(2657);
    expect(json.shown).toEqual(1);
    expect(json.verdictPath).toEqual("mcp:relationship_verdict");
    expect(json.consoleUrl).toEqual(`${base}/relationships`);
    expect(json.connections[0]).toMatchObject({
      assertionId: "ra_1",
      relationType: "CONTRADICTS",
      subject: { label: "Claim A about auth", stableIdentity: "claim:aaaa" },
      object: { label: "Claim B about auth", stableIdentity: "claim:bbbb" },
    });
  });
});

describe("runGraphConnectionsWith", () => {
  const ctx = { workspaceId: "ws1", consoleBase: base };

  function capture(): { logs: string[]; errs: string[]; restore: () => void } {
    const logs: string[] = [];
    const errs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (m?: unknown) => logs.push(String(m));
    console.error = (m?: unknown) => errs.push(String(m));
    return { logs, errs, restore: () => { console.log = origLog; console.error = origErr; } };
  }

  it("forwards the workspace + limit to the fetcher and prints the human view", async () => {
    const cap = capture();
    let seen: { workspaceId: string; limit: number } | null = null;
    const deps: GraphConnectionsDeps = {
      fetchPending: async (workspaceId, limit) => {
        seen = { workspaceId, limit };
        return { items: [item()], count: 2657 } as PendingConnectionsResponse;
      },
    };
    const code = await runGraphConnectionsWith(["--limit", "10"], ctx, deps);
    cap.restore();
    expect(code).toEqual(0);
    expect(seen).toEqual({ workspaceId: "ws1", limit: 10 });
    expect(cap.logs.join("\n")).toContain("[CONTRADICTS]");
    expect(cap.logs.join("\n")).toMatch(/showing 1/);
  });

  it("emits JSON when --json is set", async () => {
    const cap = capture();
    const deps: GraphConnectionsDeps = {
      fetchPending: async () => ({ items: [item()], count: 1 }),
    };
    const code = await runGraphConnectionsWith(["--json"], ctx, deps);
    cap.restore();
    expect(code).toEqual(0);
    const json = JSON.parse(cap.logs.join("\n"));
    expect(json.connections[0].assertionId).toEqual("ra_1");
  });

  it("returns 1 and reports the failure when the fetch throws (Intel 502) — never a silent empty", async () => {
    const cap = capture();
    const deps: GraphConnectionsDeps = {
      fetchPending: async () => {
        throw new Error("GET /internal/v1/relation-assertions/pending -> HTTP 502: UPSTREAM_UNAVAILABLE");
      },
    };
    const code = await runGraphConnectionsWith([], ctx, deps);
    cap.restore();
    expect(code).toEqual(1);
    expect(cap.errs.join("\n")).toContain("Failed to list pending relationship connections");
    expect(cap.errs.join("\n")).toContain("502");
    // Critically: nothing printed to stdout implying an empty queue.
    expect(cap.logs.join("\n")).not.toMatch(/No pending relationship connections/);
  });

  it("returns 2 on a bad flag without calling the fetcher", async () => {
    const cap = capture();
    let called = false;
    const deps: GraphConnectionsDeps = {
      fetchPending: async () => { called = true; return { items: [], count: 0 }; },
    };
    const code = await runGraphConnectionsWith(["--limit", "9999"], ctx, deps);
    cap.restore();
    expect(code).toEqual(2);
    expect(called).toBe(false);
  });
});
