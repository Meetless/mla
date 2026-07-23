// Behavioral spec for `mla decisions show`. Two layers:
//   1. parseDecisionsArgs: every malformed invocation fails loud (exit 2) rather
//      than silently exporting the wrong record or nothing.
//   2. runDecisions orchestration with injected deps: which id was requested, md
//      vs json output, and the HTTP error mapping (notably the 422 that must not
//      be reported as "not found").

import {
  parseDecisionsArgs,
  runDecisions,
  type DecisionsDeps,
} from "../../src/commands/decisions";
import type { DecisionRecord } from "../../src/lib/decision-record-markdown";
import type { WorkspaceCliConfig } from "../../src/lib/config";
import type { HttpError } from "../../src/lib/http";

function httpError(message: string, status?: number): HttpError {
  const e = new Error(message) as HttpError;
  if (status !== undefined) e.status = status;
  e.body = "";
  return e;
}

const CFG: WorkspaceCliConfig = {
  controlUrl: "http://127.0.0.1:3006",
  controlToken: "t",
  mlaPath: "/tmp/mla",
  consoleUrl: "https://console.test",
  workspaceId: "ws_test",
  auth: { mode: "none" },
};

const RECORD: DecisionRecord = {
  id: "cmt_live",
  status: "ACCEPTED",
  title: "Ship SSO in Q2 as the primary login",
  scope: "WORKSPACE",
  supersedes: [],
  supersededBy: [],
  acceptance: { by: "an@meetless.ai", at: "2026-07-22T10:00:00.000Z" },
  evidence: [],
  linkedCase: null,
  reconciliation: null,
};

function harness(over: Partial<DecisionsDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: DecisionsDeps = {
    loadConfig: () => CFG,
    fetchRecord: async () => RECORD,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { out, err, deps };
}

describe("parseDecisionsArgs", () => {
  it("defaults to markdown when only an id is given", () => {
    expect(parseDecisionsArgs(["show", "cmt_1"])).toEqual({
      verb: "show",
      id: "cmt_1",
      format: "md",
    });
  });

  it("accepts --format json and the --json alias", () => {
    expect(parseDecisionsArgs(["show", "cmt_1", "--format", "json"]).format).toBe("json");
    expect(parseDecisionsArgs(["show", "cmt_1", "--json"]).format).toBe("json");
  });

  it("rejects a missing verb, a missing id, an unknown format and a stray flag", () => {
    expect(() => parseDecisionsArgs([])).toThrow(/Usage/);
    expect(() => parseDecisionsArgs(["list"])).toThrow(/Usage/);
    expect(() => parseDecisionsArgs(["show"])).toThrow(/Usage/);
    expect(() => parseDecisionsArgs(["show", "cmt_1", "--format"])).toThrow(/requires a value/);
    expect(() => parseDecisionsArgs(["show", "cmt_1", "--format", "adr"])).toThrow(/Unknown --format/);
    expect(() => parseDecisionsArgs(["show", "cmt_1", "--pretty"])).toThrow(/Unknown flag/);
    expect(() => parseDecisionsArgs(["show", "cmt_1", "cmt_2"])).toThrow(/exactly one decision id/);
  });
});

describe("runDecisions", () => {
  it("renders Markdown by default, through the shared serializer", async () => {
    const { out, deps } = harness();
    expect(await runDecisions(["show", "cmt_live"], deps)).toBe(0);
    const md = out.join("\n");
    expect(md).toContain("# Ship SSO in Q2 as the primary login");
    expect(md).toContain("- **Accepted:** an@meetless.ai on 2026-07-22T10:00:00.000Z");
    // The honesty note travels with every export.
    expect(md).toContain("the governed graph holds no native value");
  });

  it("prints the raw DTO with --format json, with no rendering applied", async () => {
    const { out, deps } = harness();
    expect(await runDecisions(["show", "cmt_live", "--format", "json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual(RECORD);
  });

  it("requests exactly the id it was given", async () => {
    const seen: string[] = [];
    const { deps } = harness({
      fetchRecord: async (_cfg, id) => {
        seen.push(id);
        return RECORD;
      },
    });
    await runDecisions(["show", "  cmt_padded  "], deps);
    expect(seen).toEqual(["cmt_padded"]);
  });

  it("exits 2 on a parse error and never reaches the network", async () => {
    let called = false;
    const { err, deps } = harness({
      fetchRecord: async () => {
        called = true;
        return RECORD;
      },
    });
    expect(await runDecisions(["show"], deps)).toBe(2);
    expect(called).toBe(false);
    expect(err.join("\n")).toMatch(/Usage/);
  });

  it("maps 401/403 to a login prompt", async () => {
    const { err, deps } = harness({
      fetchRecord: async () => {
        throw httpError("nope", 403);
      },
    });
    expect(await runDecisions(["show", "cmt_1"], deps)).toBe(1);
    expect(err.join("\n")).toContain("mla login");
  });

  it("distinguishes a 422 non-projectable commitment from a 404", async () => {
    const notFound = harness({
      fetchRecord: async () => {
        throw httpError("gone", 404);
      },
    });
    expect(await runDecisions(["show", "cmt_1"], notFound.deps)).toBe(1);
    expect(notFound.err.join("\n")).toContain("No decision cmt_1");

    // A PENDING or DISMISSED commitment EXISTS; calling it "not found" would be a
    // lie about the graph, which is exactly what this whole surface is against.
    const notProjectable = harness({
      fetchRecord: async () => {
        throw httpError("wrong state", 422);
      },
    });
    expect(await runDecisions(["show", "cmt_1"], notProjectable.deps)).toBe(1);
    const msg = notProjectable.err.join("\n");
    expect(msg).toContain("not a projectable decision");
    expect(msg).not.toContain("No decision");
  });

  it("reports an unreachable backend distinctly from an HTTP failure", async () => {
    const unreachable = harness({
      fetchRecord: async () => {
        throw httpError("ECONNREFUSED");
      },
    });
    expect(await runDecisions(["show", "cmt_1"], unreachable.deps)).toBe(1);
    expect(unreachable.err.join("\n")).toContain("Could not reach the backend");

    const server = harness({
      fetchRecord: async () => {
        throw httpError("boom", 500);
      },
    });
    expect(await runDecisions(["show", "cmt_1"], server.deps)).toBe(1);
    expect(server.err.join("\n")).toContain("HTTP 500");
  });
});
