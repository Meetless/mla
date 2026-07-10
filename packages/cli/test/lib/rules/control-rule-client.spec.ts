import {
  editRule,
  getBundle,
  getRule,
  importRules,
  listRules,
  mintRule,
  revokeRule,
  type RuleClientHttp,
} from "../../../src/lib/rules/control-rule-client";
import type { WorkspaceCliConfig } from "../../../src/lib/config";

// The client is a thin transport shell: these tests pin the exact path, query string, and forwarded
// body for every verb without touching the network, by recording calls through the injectable http
// seam. A path or query rename surfaces here as a failing assertion.

const cfg: WorkspaceCliConfig = {
  workspaceId: "ws_1",
  actorUserId: "user_1",
} as WorkspaceCliConfig;

interface RecordedCall {
  verb: "get" | "post" | "patch";
  path: string;
  body?: unknown;
}

function recorder(result: unknown = {}): { http: RuleClientHttp; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const http: RuleClientHttp = {
    get: (async (_cfg, path) => {
      calls.push({ verb: "get", path });
      return result;
    }) as RuleClientHttp["get"],
    post: (async (_cfg, path, body) => {
      calls.push({ verb: "post", path, body });
      return result;
    }) as RuleClientHttp["post"],
    patch: (async (_cfg, path, body) => {
      calls.push({ verb: "patch", path, body });
      return result;
    }) as RuleClientHttp["patch"],
  };
  return { http, calls };
}

describe("importRules", () => {
  it("POSTs the batch verbatim to /internal/v1/rules/import and returns the result", async () => {
    const { http, calls } = recorder({ rulesReceived: 2, rulesImported: 2 });
    const body = { workspaceId: "ws_1", rules: [] };
    const result = await importRules(cfg, body, http);
    expect(calls).toEqual([{ verb: "post", path: "/internal/v1/rules/import", body }]);
    expect(result).toEqual({ rulesReceived: 2, rulesImported: 2 });
  });
});

describe("mintRule", () => {
  it("POSTs to the collection root with the body forwarded unchanged", async () => {
    const { http, calls } = recorder();
    const body = { workspaceId: "ws_1", authorityScope: "PERSONAL" as const, ownerUserId: "user_1", payload: {} };
    await mintRule(cfg, body, http);
    expect(calls).toEqual([{ verb: "post", path: "/internal/v1/rules", body }]);
  });
});

describe("listRules", () => {
  it("GETs with the workspace query and no filter when none is given", async () => {
    const { http, calls } = recorder([]);
    await listRules(cfg, {}, http);
    expect(calls[0]).toEqual({ verb: "get", path: "/internal/v1/rules?workspaceId=ws_1" });
  });

  it("appends the lifecycleStatus filter when provided", async () => {
    const { http, calls } = recorder([]);
    await listRules(cfg, { lifecycleStatus: "REVOKED" }, http);
    expect(calls[0].path).toBe("/internal/v1/rules?workspaceId=ws_1&lifecycleStatus=REVOKED");
  });
});

describe("getRule", () => {
  it("GETs the detail path, url-encodes the rule id, and carries the workspace marker", async () => {
    const { http, calls } = recorder();
    await getRule(cfg, "rule/with space", http);
    // The workspaceId query is the marker the cli-session tenant guard resolves to
    // effectiveWorkspaceId. GET has no body, so without it the guard falls back to
    // the session HOME workspace and 404s on any non-home rule -- which silently
    // broke the edit/revoke preflight for every non-home target (folder marker OR
    // --workspace), i.e. the BUG-4 migration path. Must match listRules/getBundle.
    expect(calls[0]).toEqual({
      verb: "get",
      path: "/internal/v1/rules/rule%2Fwith%20space?workspaceId=ws_1",
    });
  });
});

describe("editRule", () => {
  it("PATCHes the detail path carrying expectedCurrentVersionId in the body", async () => {
    const { http, calls } = recorder();
    const body = { workspaceId: "ws_1", expectedCurrentVersionId: "ver_1", payload: { text: "x" } };
    await editRule(cfg, "rule_1", body, http);
    expect(calls).toEqual([{ verb: "patch", path: "/internal/v1/rules/rule_1", body }]);
  });
});

describe("revokeRule", () => {
  it("POSTs to the /revoke sub-path with the compare-and-swap token", async () => {
    const { http, calls } = recorder();
    const body = { workspaceId: "ws_1", expectedCurrentVersionId: "ver_1" };
    await revokeRule(cfg, "rule_1", body, http);
    expect(calls).toEqual([{ verb: "post", path: "/internal/v1/rules/rule_1/revoke", body }]);
  });
});

describe("getBundle", () => {
  it("GETs the bundle with only the workspace query when no project is activated", async () => {
    const { http, calls } = recorder();
    await getBundle(cfg, {}, http);
    expect(calls[0]).toEqual({ verb: "get", path: "/internal/v1/rules/bundle?workspaceId=ws_1" });
  });

  it("adds projectId to the bundle query when one is activated", async () => {
    const { http, calls } = recorder();
    await getBundle(cfg, { projectId: "proj_1" }, http);
    expect(calls[0].path).toBe("/internal/v1/rules/bundle?workspaceId=ws_1&projectId=proj_1");
  });

  it("drops a null projectId rather than sending an empty param", async () => {
    const { http, calls } = recorder();
    await getBundle(cfg, { projectId: null }, http);
    expect(calls[0].path).toBe("/internal/v1/rules/bundle?workspaceId=ws_1");
  });
});
