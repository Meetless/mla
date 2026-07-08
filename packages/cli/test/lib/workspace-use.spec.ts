import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for `mla workspace` under folder = workspace (T1.3 / T3.2,
// notes/20260604-folder-equals-workspace-binding-design.md).
//
// `mla workspace show` no longer reads a machine-global cli-config pointer; it
// resolves the workspace from the nearest `.meetless.json` marker (walking UP
// from cwd, nearest-wins) and reports its health against control. `mla
// workspace use` is removed: a hard error that points at `mla activate`.
//
// Traps this spec closes:
//   1. `show` printing a cli-config workspaceId instead of the folder marker.
//   2. Pure-local states (not activated, stale marker) hitting the network --
//      they MUST resolve without a probe.
//   3. A control outage (or 404 / not-member) masking the local binding -- the
//      binding line MUST print before, and regardless of, the probe.
//   4. `use` silently no-opping instead of failing loud with a migration path.

interface Run {
  code: number;
  logs: string[];
  errs: string[];
}

const BASE_CFG = {
  controlUrl: "http://127.0.0.1:3006",
  controlToken: "secret-token",
  intelUrl: "http://127.0.0.1:8100",
  mlaPath: "/usr/local/bin/mla",
  actorUserId: "u_an",
};

function writeCfg(home: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify(cfg, null, 2) + "\n",
  );
}

function writeMarker(dir: string, marker: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, ".meetless.json");
  fs.writeFileSync(p, JSON.stringify(marker));
  return p;
}

// A jest.fn standing in for the global fetch used by the /workspaces/me probe.
// Returns a minimal Response (ok/status/text) -- the only surface lib/http's
// doFetch touches on the control path.
function mockFetch(status: number, body = ""): jest.Mock {
  return jest.fn(
    async () =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      }) as unknown as Response,
  );
}

// A fetch that rejects with no status, exactly like a real ECONNREFUSED /
// AbortError -- control is down or unreachable.
function rejectingFetch(): jest.Mock {
  return jest.fn(async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:3006");
  });
}

// Self-contained driver: set MEETLESS_HOME so config.ts freezes CFG_PATH from
// the test home, chdir into `cwd` so the marker resolver runs from there, stub
// global.fetch for the server probe, then resetModules + require so the module
// graph (config + workspace + http) picks up the test env. Each spec file runs
// in its own jest worker, so chdir + fetch mutations here are isolated to it.
async function runWorkspaceIn(opts: {
  home: string;
  cwd: string;
  fetchMock?: jest.Mock;
  argv: string[];
}): Promise<Run> {
  const prevHome = process.env.MEETLESS_HOME;
  const prevCwd = process.cwd();
  const prevFetch = global.fetch;
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = jest
    .spyOn(console, "log")
    .mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  const errSpy = jest
    .spyOn(console, "error")
    .mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });
  try {
    process.env.MEETLESS_HOME = opts.home;
    process.chdir(opts.cwd);
    if (opts.fetchMock) {
      global.fetch = opts.fetchMock as unknown as typeof fetch;
    }
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../../src/commands/workspace");
    const code = (await mod.runWorkspace(opts.argv)) as number;
    return { code, logs, errs };
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    global.fetch = prevFetch;
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
}

describe("mla workspace show (folder = workspace)", () => {
  let tmp: string;
  let home: string;
  let repo: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-ws-"));
    home = path.join(tmp, "home");
    repo = path.join(tmp, "repo");
    writeCfg(home, BASE_CFG);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports not activated when no marker is found up the tree (no probe)", async () => {
    const bare = path.join(tmp, "bare");
    fs.mkdirSync(bare, { recursive: true });
    const probe = mockFetch(200, "{}");

    const r = await runWorkspaceIn({ home, cwd: bare, fetchMock: probe, argv: [] });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toMatch(/No workspace is bound to this folder/);
    expect(out).toContain("mla activate");
    // Trap 2: a local "not activated" state never touches the network.
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports a stale binding when the marker has no workspaceId (no probe)", async () => {
    const markerPath = writeMarker(repo, {
      activatedAt: "2026-06-04T00:00:00.000Z",
      note: "left over",
    });
    const probe = mockFetch(200, "{}");

    const r = await runWorkspaceIn({ home, cwd: repo, fetchMock: probe, argv: [] });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toMatch(/Stale binding/);
    expect(out).toContain(markerPath);
    expect(out).toContain("mla activate --repair");
    expect(probe).not.toHaveBeenCalled();
  });

  it("prints the bound workspace + marker path, then active on a 200 probe", async () => {
    const markerPath = writeMarker(repo, {
      workspaceId: "ws_acme",
      workspaceName: "Acme Corp",
      activatedAt: "2026-06-04T00:00:00.000Z",
    });
    const probe = mockFetch(200, JSON.stringify({ workspaceId: "ws_acme" }));

    const r = await runWorkspaceIn({ home, cwd: repo, fetchMock: probe, argv: [] });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    // Trap 1: the id comes from the marker, with its display name and path.
    expect(out).toContain("ws_acme");
    expect(out).toContain("Acme Corp");
    expect(out).toContain(markerPath);
    expect(out).toMatch(/Status: active/);
    // The probe targets /workspaces/me with the marker's id.
    expect(probe).toHaveBeenCalledTimes(1);
    const url = String((probe.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/internal/v1/workspaces/me?workspaceId=ws_acme");
  });

  it("reports a missing / inaccessible workspace on a 404 probe", async () => {
    writeMarker(repo, { workspaceId: "ws_gone" });
    const probe = mockFetch(404, "Workspace not found");

    const r = await runWorkspaceIn({ home, cwd: repo, fetchMock: probe, argv: [] });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toContain("ws_gone");
    expect(out).toMatch(/does not exist or is inaccessible/);
    expect(out).toContain("mla activate --repair");
    expect(out).toContain("mla deactivate");
  });

  it("reports not-a-member on a 403 probe (forward-compatible with T1.4)", async () => {
    writeMarker(repo, { workspaceId: "ws_acme" });
    const probe = mockFetch(403, "forbidden");

    const r = await runWorkspaceIn({ home, cwd: repo, fetchMock: probe, argv: [] });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toContain("ws_acme");
    expect(out).toMatch(/not a member/);
  });

  it("tolerates control being offline without masking the local binding", async () => {
    writeMarker(repo, { workspaceId: "ws_acme" });
    const probe = rejectingFetch();

    const r = await runWorkspaceIn({ home, cwd: repo, fetchMock: probe, argv: [] });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    // Trap 3: the binding still prints; the probe failure is non-fatal.
    expect(out).toContain("ws_acme");
    expect(out).toMatch(/could not verify with control/);
  });

  it("bare `mla workspace` and `mla workspace show` both resolve the binding", async () => {
    writeMarker(repo, { workspaceId: "ws_acme" });

    const bare = await runWorkspaceIn({
      home,
      cwd: repo,
      fetchMock: mockFetch(200, "{}"),
      argv: [],
    });
    const show = await runWorkspaceIn({
      home,
      cwd: repo,
      fetchMock: mockFetch(200, "{}"),
      argv: ["show"],
    });

    expect(bare.code).toBe(0);
    expect(show.code).toBe(0);
    expect(bare.logs.join("\n")).toContain("ws_acme");
    expect(show.logs.join("\n")).toContain("ws_acme");
  });

  it("errors (code 2) when cli-config.json is absent", async () => {
    const emptyHome = path.join(tmp, "empty-home");
    writeMarker(repo, { workspaceId: "ws_acme" });

    const r = await runWorkspaceIn({
      home: emptyHome,
      cwd: repo,
      argv: [],
    });

    expect(r.code).toBe(2);
    expect(r.errs.join("\n")).toMatch(/not found|mla init/);
  });
});

describe("mla workspace use (removed, T3.2)", () => {
  let tmp: string;
  let home: string;
  let repo: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-ws-"));
    home = path.join(tmp, "home");
    repo = path.join(tmp, "repo");
    writeCfg(home, BASE_CFG);
    writeMarker(repo, { workspaceId: "ws_acme" });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is a hard error pointing at `mla activate` (Trap 4)", async () => {
    const probe = mockFetch(200, "{}");

    const r = await runWorkspaceIn({
      home,
      cwd: repo,
      fetchMock: probe,
      argv: ["use", "ws_other"],
    });

    expect(r.code).toBe(2);
    const errs = r.errs.join("\n");
    expect(errs).toMatch(/has been removed/);
    expect(errs).toContain("mla activate");
    // Removed verb does no network work and writes nothing.
    expect(probe).not.toHaveBeenCalled();
  });

  it("errors even with no id given (no silent default)", async () => {
    const r = await runWorkspaceIn({ home, cwd: repo, argv: ["use"] });

    expect(r.code).toBe(2);
    expect(r.errs.join("\n")).toMatch(/has been removed/);
  });

  it("rejects an unknown subcommand", async () => {
    const r = await runWorkspaceIn({ home, cwd: repo, argv: ["bogus"] });

    expect(r.code).toBe(2);
    expect(r.errs.join("\n")).toMatch(/[Uu]nknown workspace subcommand/);
  });
});
