import {
  runWorkspace,
  runWorkspaceInvite,
  runWorkspaceMembers,
  runWorkspaceRemove,
} from "../../src/commands/workspace";
import type { WorkspaceCliConfig } from "../../src/lib/config";
import type {
  WorkspaceMemberClientHttp,
  InviteMemberResult,
  ListMembersResult,
  RemoveMemberResult,
} from "../../src/lib/control-workspace-member-client";

// The Shared-Workspace Membership Doorway CLI verbs (mla workspace
// invite/members/remove), pinned with the deps-injection convention the
// rules-backend spec established: the http seam (WorkspaceMemberClientHttp) and
// loadConfig are injected, so nothing here touches the network or on-disk config.
// A programmable fake records every verb/path/body and returns a typed result or
// throws a status-bearing HTTP error (with a control-shaped JSON body) / a
// status-less offline error. We assert: path + query construction, --workspace
// override threading, --json vs human rendering, serverMessage parsing, and the
// exit-code contract (2 for arg/config failure, 1 for a client-call failure).

const WS = "ws_home";

function cfg(workspaceId = WS): WorkspaceCliConfig {
  return {
    workspaceId,
    controlUrl: "https://control.test",
    controlToken: "tok",
    auth: { mode: "shared-key", accessToken: "tok" },
  } as WorkspaceCliConfig;
}

interface RecordedCall {
  verb: "get" | "post" | "del";
  path: string;
  body?: unknown;
}

type Handler = (path: string, body?: unknown) => unknown;

/** A status-bearing HTTP error carrying a control-shaped JSON body (api-exception.ts). */
function httpError(status: number, message: string, code = "conflict"): Error {
  const e = new Error(`DELETE /x -> HTTP ${status}`) as Error & {
    status: number;
    body: string;
  };
  e.status = status;
  e.body = JSON.stringify({ statusCode: status, code, message });
  return e;
}

/** A status-LESS transport error (ECONNREFUSED / abort): control was never reached. */
function offlineError(): Error {
  return new Error("connect ECONNREFUSED 127.0.0.1:3000");
}

function fakeHttp(handlers: { get?: Handler; post?: Handler; del?: Handler }): {
  http: WorkspaceMemberClientHttp;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const mk =
    (verb: "get" | "post" | "del") =>
    async (_cfg: unknown, p: string, body?: unknown) => {
      // GET/DEL forward `body` as the timeout arg; only POST carries a real body.
      const recordedBody = verb === "post" ? body : undefined;
      calls.push({ verb, path: p, body: recordedBody });
      const h = handlers[verb];
      if (!h) throw new Error(`unexpected ${verb} ${p}`);
      return h(p, recordedBody);
    };
  const http: WorkspaceMemberClientHttp = {
    get: mk("get") as WorkspaceMemberClientHttp["get"],
    post: mk("post") as WorkspaceMemberClientHttp["post"],
    del: mk("del") as WorkspaceMemberClientHttp["del"],
  };
  return { http, calls };
}

interface Rec {
  out: string[];
  err: string[];
}
function sink(): { rec: Rec; out: (l: string) => void; err: (l: string) => void } {
  const rec: Rec = { out: [], err: [] };
  return { rec, out: (l) => rec.out.push(l), err: (l) => rec.err.push(l) };
}

/** A loadConfig spy that records the override it was called with and returns cfg. */
function loaderSpy(conf: WorkspaceCliConfig = cfg()): {
  loadConfig: (override?: string) => WorkspaceCliConfig;
  seen: (string | undefined)[];
} {
  const seen: (string | undefined)[] = [];
  return {
    loadConfig: (override?: string) => {
      seen.push(override);
      return conf;
    },
    seen,
  };
}

/** A loadConfig that always throws (unactivated folder / missing marker). */
function throwingLoader(message: string): (override?: string) => WorkspaceCliConfig {
  return () => {
    throw new Error(message);
  };
}

// ───────────────────────────────────────────────────────────────────────────
// invite
// ───────────────────────────────────────────────────────────────────────────

describe("runWorkspaceInvite", () => {
  const invited: InviteMemberResult = { email: "bob@example.com", role: "MEMBER" };

  it("POSTs the email + workspaceId and prints the human grant line", async () => {
    const { http, calls } = fakeHttp({ post: () => invited });
    const { loadConfig, seen } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceInvite(["bob@example.com"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(seen).toEqual([undefined]); // no --workspace: folder-bound config
    expect(calls).toEqual([
      {
        verb: "post",
        path: "/internal/v1/workspaces/members",
        body: { email: "bob@example.com", workspaceId: WS },
      },
    ]);
    expect(rec.out[0]).toContain("bob@example.com is now a MEMBER");
    expect(rec.out[0]).toContain(WS);
    expect(rec.err).toEqual([]);
  });

  it("--json dumps the raw InviteMemberResult", async () => {
    const { http } = fakeHttp({ post: () => invited });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceInvite(["bob@example.com", "--json"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(JSON.parse(rec.out.join("\n"))).toEqual(invited);
  });

  it("threads --workspace <id> into loadConfig (BUG-3/BUG-4 target override)", async () => {
    const target = cfg("ws_target");
    const { http, calls } = fakeHttp({ post: () => invited });
    const { loadConfig, seen } = loaderSpy(target);
    const { out, err } = sink();
    const code = await runWorkspaceInvite(
      ["--workspace", "ws_target", "bob@example.com"],
      { loadConfig, http, out, err },
    );
    expect(code).toBe(0);
    expect(seen).toEqual(["ws_target"]); // override extracted before the positional
    // the override's workspaceId is what rides in the POST body, not the home id
    expect(calls[0].body).toEqual({
      email: "bob@example.com",
      workspaceId: "ws_target",
    });
  });

  it("exits 2 with usage when the email positional is missing", async () => {
    const { http, calls } = fakeHttp({ post: () => invited });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceInvite(["--json"], { loadConfig, http, out, err });
    expect(code).toBe(2);
    expect(calls).toEqual([]); // never reached the client
    expect(rec.err.join("\n")).toContain("an email is required");
    expect(rec.err.join("\n")).toContain("usage: mla workspace invite");
  });

  it("exits 2 on a dangling --workspace flag", async () => {
    const { http, calls } = fakeHttp({ post: () => invited });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceInvite(["bob@example.com", "--workspace"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(rec.err.join("\n")).toContain("--workspace needs a value");
  });

  it("exits 2 when loadConfig throws (unactivated folder)", async () => {
    const { http, calls } = fakeHttp({ post: () => invited });
    const { rec, out, err } = sink();
    const code = await runWorkspaceInvite(["bob@example.com"], {
      loadConfig: throwingLoader("no workspace bound to this folder"),
      http,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(rec.err.join("\n")).toContain(
      "workspace invite: no workspace bound to this folder",
    );
  });

  it("exits 1 and surfaces the control message on a 403 gate rejection", async () => {
    const { http } = fakeHttp({
      post: () => {
        throw httpError(403, "Only an owner or admin can invite members", "forbidden");
      },
    });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceInvite(["bob@example.com"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("workspace invite failed:");
    expect(rec.err.join("\n")).toContain(
      "Only an owner or admin can invite members (HTTP 403)",
    );
  });

  it("exits 1 with the raw message when control is offline (no JSON body)", async () => {
    const { http } = fakeHttp({
      post: () => {
        throw offlineError();
      },
    });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceInvite(["bob@example.com"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain("ECONNREFUSED");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// members
// ───────────────────────────────────────────────────────────────────────────

describe("runWorkspaceMembers", () => {
  const roster: ListMembersResult = {
    members: [
      { email: "owner@example.com", role: "OWNER" },
      { email: "admin@example.com", role: "ADMIN" },
      { email: "bob@example.com", role: "MEMBER" },
    ],
  };

  it("GETs /members with the workspaceId query and renders the roster in order", async () => {
    const { http, calls } = fakeHttp({ get: () => roster });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceMembers([], { loadConfig, http, out, err });
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        verb: "get",
        path: `/internal/v1/workspaces/members?workspaceId=${WS}`,
        body: undefined,
      },
    ]);
    // header + three rows, owner first (server order preserved verbatim)
    expect(rec.out[0]).toContain(`Members of workspace ${WS}`);
    expect(rec.out[1]).toContain("OWNER");
    expect(rec.out[1]).toContain("owner@example.com");
    expect(rec.out[3]).toContain("MEMBER");
    expect(rec.out[3]).toContain("bob@example.com");
  });

  it("--json dumps the members array (not the wrapper)", async () => {
    const { http } = fakeHttp({ get: () => roster });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    await runWorkspaceMembers(["--json"], { loadConfig, http, out, err });
    expect(JSON.parse(rec.out.join("\n"))).toEqual(roster.members);
  });

  it("prints (no active members) on an empty roster", async () => {
    const { http } = fakeHttp({ get: (): ListMembersResult => ({ members: [] }) });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceMembers([], { loadConfig, http, out, err });
    expect(code).toBe(0);
    expect(rec.out.join("\n")).toContain("(no active members)");
  });

  it("threads --workspace <id> into loadConfig and the query", async () => {
    const target = cfg("ws_target");
    const { http, calls } = fakeHttp({ get: (): ListMembersResult => ({ members: [] }) });
    const { loadConfig, seen } = loaderSpy(target);
    const { out, err } = sink();
    await runWorkspaceMembers(["--workspace", "ws_target"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(seen).toEqual(["ws_target"]);
    expect(calls[0].path).toBe(
      "/internal/v1/workspaces/members?workspaceId=ws_target",
    );
  });

  it("exits 2 when loadConfig throws", async () => {
    const { http, calls } = fakeHttp({ get: () => roster });
    const { rec, out, err } = sink();
    const code = await runWorkspaceMembers([], {
      loadConfig: throwingLoader("stale marker"),
      http,
      out,
      err,
    });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(rec.err.join("\n")).toContain("workspace members: stale marker");
  });

  it("exits 1 and surfaces the control message on a server error", async () => {
    const { http } = fakeHttp({
      get: () => {
        throw httpError(404, "Workspace not found", "not_found");
      },
    });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceMembers([], { loadConfig, http, out, err });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain(
      "workspace members failed: Workspace not found (HTTP 404)",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// remove
// ───────────────────────────────────────────────────────────────────────────

describe("runWorkspaceRemove", () => {
  it("DELETEs with email + workspaceId query and confirms on removed=true", async () => {
    const removed: RemoveMemberResult = { email: "bob@example.com", removed: true };
    const { http, calls } = fakeHttp({ del: () => removed });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceRemove(["bob@example.com"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        verb: "del",
        path: `/internal/v1/workspaces/members?email=bob%40example.com&workspaceId=${WS}`,
        body: undefined,
      },
    ]);
    expect(rec.out.join("\n")).toContain(`Removed bob@example.com from workspace ${WS}`);
  });

  it("reports nothing-to-remove on removed=false (idempotent)", async () => {
    const nooped: RemoveMemberResult = { email: "ghost@example.com", removed: false };
    const { http } = fakeHttp({ del: () => nooped });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceRemove(["ghost@example.com"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(code).toBe(0);
    expect(rec.out.join("\n")).toContain("was not an active member");
    expect(rec.out.join("\n")).toContain("nothing to remove");
  });

  it("--json dumps the raw RemoveMemberResult", async () => {
    const removed: RemoveMemberResult = { email: "bob@example.com", removed: true };
    const { http } = fakeHttp({ del: () => removed });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    await runWorkspaceRemove(["bob@example.com", "--json"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(JSON.parse(rec.out.join("\n"))).toEqual(removed);
  });

  it("exits 2 with usage when the email positional is missing", async () => {
    const { http, calls } = fakeHttp({ del: () => ({ email: "", removed: false }) });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceRemove([], { loadConfig, http, out, err });
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(rec.err.join("\n")).toContain("an email is required");
    expect(rec.err.join("\n")).toContain("usage: mla workspace remove");
  });

  it("threads --workspace <id> into loadConfig and the query", async () => {
    const target = cfg("ws_target");
    const removed: RemoveMemberResult = { email: "bob@example.com", removed: true };
    const { http, calls } = fakeHttp({ del: () => removed });
    const { loadConfig, seen } = loaderSpy(target);
    const { out, err } = sink();
    await runWorkspaceRemove(["bob@example.com", "--workspace", "ws_target"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(seen).toEqual(["ws_target"]);
    expect(calls[0].path).toContain("workspaceId=ws_target");
  });

  it("exits 1 and surfaces the control message when removing a privileged member 409s", async () => {
    const { http } = fakeHttp({
      del: () => {
        throw httpError(409, "Cannot remove an owner or admin; demote them first");
      },
    });
    const { loadConfig } = loaderSpy();
    const { rec, out, err } = sink();
    const code = await runWorkspaceRemove(["owner@example.com"], {
      loadConfig,
      http,
      out,
      err,
    });
    expect(code).toBe(1);
    expect(rec.err.join("\n")).toContain(
      "workspace remove failed: Cannot remove an owner or admin; demote them first (HTTP 409)",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// runWorkspace dispatch (the non-networking branches)
// ───────────────────────────────────────────────────────────────────────────

describe("runWorkspace dispatch", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("hard-errors `use` with a pointer to activate (exit 2)", async () => {
    const code = await runWorkspace(["use", "ws_x"]);
    expect(code).toBe(2);
    expect(errSpy.mock.calls.flat().join("\n")).toContain(
      "`mla workspace use` has been removed",
    );
  });

  it("exits 2 on an unknown subcommand", async () => {
    const code = await runWorkspace(["frobnicate"]);
    expect(code).toBe(2);
    expect(errSpy.mock.calls.flat().join("\n")).toContain(
      "Unknown workspace subcommand: frobnicate",
    );
  });
});
