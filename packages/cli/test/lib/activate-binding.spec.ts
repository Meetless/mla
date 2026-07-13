import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

// Behavioral lock for `mla activate` provision-or-bind + the repo-root guard
// (T2.1, notes/20260604-folder-equals-workspace-binding-design.md).
//
// folder = workspace: `mla activate` with NO marker in the tree provisions a new
// workspace (owned by the token user) by POSTing /internal/v1/workspaces and
// writes the returned id into `.meetless.json`; with a marker present it BINDS
// and provisions nothing. The repo-root guard (Q1 / INV-FLAGS-1) stops accidental
// workspace fragments: auto-create only at a Git repo root, refuse from a Git
// subdir unless `--here`, and refuse outside Git unless `--create`. The two
// override flags are never overloaded: `--here` is the in-Git subdir override,
// `--create` is the non-Git override.
//
// These specs exercise the REAL http client (post/get -> buildRequestHeaders, so
// the T1.4 X-Meetless-Actor header is asserted on the wire) against an ephemeral
// stub control endpoint. The server-side provisioning logic itself is covered by
// the T0.1 real-DB spec; here the boundary under test is the CLI.

interface FakeControl {
  url: string;
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
  setProvision: (status: number, body: unknown) => void;
  setMe: (status: number, body: unknown) => void;
  close: () => Promise<void>;
}

function startFakeControl(): Promise<FakeControl> {
  return new Promise((resolve) => {
    const state = {
      provision: { status: 200, body: { id: "ws_new", name: "repo", isNew: true } as unknown },
      me: { status: 200, body: { fullContextCapture: true } as unknown },
    };
    const requests: FakeControl["requests"] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({
          method: req.method || "",
          url: req.url || "",
          headers: req.headers,
          body,
        });
        let resp = { status: 404, body: { error: "not found" } as unknown };
        if (req.method === "POST" && req.url === "/internal/v1/workspaces") {
          resp = state.provision;
        } else if (req.method === "GET" && (req.url || "").startsWith("/internal/v1/workspaces/me")) {
          resp = state.me;
        }
        res.writeHead(resp.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        setProvision: (status, body) => {
          state.provision = { status, body };
        },
        setMe: (status, body) => {
          state.me = { status, body };
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function stageHome(tmp: string, controlUrl: string): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl,
      controlToken: "test-token",
      actorUserId: "wu_test_actor",
      mlaPath: "/bin/true",
    }),
  );
  return home;
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

interface ActivateRun {
  code: number;
  logs: string[];
}

// Run runActivate in-process with an isolated MEETLESS_HOME + cwd, capturing BOTH
// stdout and stderr (the repo-root guard refuses via console.error). No live
// Claude Code session id is set, so the current-session bootstrap stays inert and
// only the binding/provision behavior is exercised.
async function runActivateIn(opts: {
  home: string;
  cwd: string;
  argv?: string[];
}): Promise<ActivateRun> {
  const prevCwd = process.cwd();
  const prevHome = process.env.MEETLESS_HOME;
  const prevSid = process.env.CLAUDE_CODE_SESSION_ID;
  const logs: string[] = [];
  const push = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  const outSpy = jest.spyOn(console, "log").mockImplementation(push);
  const errSpy = jest.spyOn(console, "error").mockImplementation(push);
  try {
    process.env.MEETLESS_HOME = opts.home;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.chdir(opts.cwd);
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../../src/commands/activate");
    const code = (await mod.runActivate(opts.argv ?? [])) as number;
    return { code, logs };
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    if (prevSid === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevSid;
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
}

function readMarker(dir: string): { workspaceId?: string; workspaceName?: string } {
  return JSON.parse(fs.readFileSync(path.join(dir, ".meetless.json"), "utf8"));
}

describe("mla activate provision-or-bind + repo-root guard (T2.1)", () => {
  let tmp: string;
  let fake: FakeControl;
  let home: string;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bind-"));
    fake = await startFakeControl();
    home = stageHome(tmp, fake.url);
  });
  afterEach(async () => {
    await fake.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function mkRepo(name = "repo"): string {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    return dir;
  }

  // --- provision path -------------------------------------------------------

  it("provisions a workspace at a Git repo root with no marker", async () => {
    const repo = mkRepo();
    gitInit(repo);

    const r = await runActivateIn({ home, cwd: repo });

    expect(r.code).toBe(0);
    // Marker written with the server-returned id + name.
    const marker = readMarker(repo);
    expect(marker.workspaceId).toBe("ws_new");
    expect(marker.workspaceName).toBe("repo");
    // Exactly one provision POST, carrying the cwd basename as the name and the
    // T1.4 actor header.
    const posts = fake.requests.filter((q) => q.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/internal/v1/workspaces");
    expect(JSON.parse(posts[0].body).name).toBe("repo");
    expect(posts[0].headers["x-meetless-actor"]).toBe("wu_test_actor");
    // Loud create output + commit guidance.
    const out = r.logs.join("\n");
    expect(out).toContain("Provisioned workspace ws_new");
    expect(out).toContain("Commit guidance");
    expect(out).toContain("not gitignored");
  });

  it("uses --name to override the provisioned workspace name", async () => {
    const repo = mkRepo();
    gitInit(repo);
    fake.setProvision(200, { id: "ws_custom", name: "Custom WS", isNew: true });

    const r = await runActivateIn({ home, cwd: repo, argv: ["--name", "Custom WS"] });

    expect(r.code).toBe(0);
    const posts = fake.requests.filter((q) => q.method === "POST");
    expect(JSON.parse(posts[0].body).name).toBe("Custom WS");
    expect(readMarker(repo).workspaceName).toBe("Custom WS");
  });

  it("provisions outside Git only with --create", async () => {
    const dir = mkRepo("loose"); // NOT a git repo

    const r = await runActivateIn({ home, cwd: dir, argv: ["--create"] });

    expect(r.code).toBe(0);
    expect(readMarker(dir).workspaceId).toBe("ws_new");
    expect(fake.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  // --- repo-root guard refusals (no network) --------------------------------

  it("refuses from a Git subdir without --here", async () => {
    const repo = mkRepo();
    gitInit(repo);
    const sub = path.join(repo, "apps", "control");
    fs.mkdirSync(sub, { recursive: true });

    const r = await runActivateIn({ home, cwd: sub });

    expect(r.code).toBe(2);
    expect(fs.existsSync(path.join(sub, ".meetless.json"))).toBe(false);
    const out = r.logs.join("\n");
    expect(out).toContain("not at its root");
    expect(out).toContain("mla activate --here");
    // Guard refuses BEFORE any network call.
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses outside Git without --create", async () => {
    const dir = mkRepo("loose");

    const r = await runActivateIn({ home, cwd: dir });

    expect(r.code).toBe(2);
    expect(fs.existsSync(path.join(dir, ".meetless.json"))).toBe(false);
    expect(r.logs.join("\n")).toContain("mla activate --create");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects --here outside Git as a non-Git creation flag (INV-FLAGS-1)", async () => {
    const dir = mkRepo("loose");

    const r = await runActivateIn({ home, cwd: dir, argv: ["--here"] });

    expect(r.code).toBe(2);
    expect(fs.existsSync(path.join(dir, ".meetless.json"))).toBe(false);
    const out = r.logs.join("\n");
    expect(out).toContain("--here");
    expect(out).toContain("--create");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects --create inside Git (use --here / the root)", async () => {
    const repo = mkRepo();
    gitInit(repo);

    const r = await runActivateIn({ home, cwd: repo, argv: ["--create"] });

    expect(r.code).toBe(2);
    expect(fs.existsSync(path.join(repo, ".meetless.json"))).toBe(false);
    expect(r.logs.join("\n")).toContain("--create");
    expect(fake.requests).toHaveLength(0);
  });

  it("rejects --here and --create together (never overloaded)", async () => {
    const repo = mkRepo();
    gitInit(repo);

    const r = await runActivateIn({ home, cwd: repo, argv: ["--here", "--create"] });

    expect(r.code).toBe(2);
    expect(r.logs.join("\n")).toContain("cannot be combined");
    expect(fake.requests).toHaveLength(0);
  });

  // --- --here marker placement (INV-ACTIVATE-1) -----------------------------

  it("--here in a subdir provisions a NEW marker at cwd, shadowing the parent", async () => {
    const repo = mkRepo();
    gitInit(repo);
    // Parent marker present at the repo root.
    fs.writeFileSync(
      path.join(repo, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_parent", workspaceName: "parent" }) + "\n",
    );
    const sub = path.join(repo, "tools", "subproject");
    fs.mkdirSync(sub, { recursive: true });
    fake.setProvision(200, { id: "ws_sub", name: "subproject", isNew: true });

    const r = await runActivateIn({ home, cwd: sub, argv: ["--here"] });

    expect(r.code).toBe(0);
    // New marker at cwd; parent marker untouched.
    expect(readMarker(sub).workspaceId).toBe("ws_sub");
    expect(readMarker(repo).workspaceId).toBe("ws_parent");
    expect(fake.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("--here binds when a marker already sits exactly at cwd (no provision)", async () => {
    const repo = mkRepo();
    gitInit(repo);
    fs.writeFileSync(
      path.join(repo, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_here", workspaceName: "here" }) + "\n",
    );

    const r = await runActivateIn({ home, cwd: repo, argv: ["--here"] });

    expect(r.code).toBe(0);
    expect(r.logs.join("\n")).toContain("Already activated");
    expect(fake.requests).toHaveLength(0);
  });

  // --- bind path (marker present) -------------------------------------------

  it("binds to an existing nearest marker and provisions nothing (even outside Git)", async () => {
    const dir = mkRepo("loose");
    fs.writeFileSync(
      path.join(dir, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_bound", workspaceName: "bound" }) + "\n",
    );

    const r = await runActivateIn({ home, cwd: dir });

    expect(r.code).toBe(0);
    expect(r.logs.join("\n")).toContain("Already activated");
    // Marker left untouched.
    expect(readMarker(dir).workspaceId).toBe("ws_bound");
    expect(fake.requests).toHaveLength(0);
  });

  // --- gitignore migration --------------------------------------------------

  // `.gitignore` is the USER's file. activate used to delete the `.meetless.json`
  // line out of it on the theory that any such line was leftover auto-ignore
  // residue, which it cannot know: a repo may ignore the marker deliberately (this
  // one does, with a hand-written banner saying why). Editing a tracked file to
  // make our own "not gitignored" claim come true left a dirty tree and an orphaned
  // comment behind. We now REPORT the state and touch nothing (activate.ts,
  // isMarkerGitignored). This test asserted the old delete and had been red on main
  // ever since; it now pins the contract that actually shipped.
  it("never rewrites a .gitignore that ignores the marker; it reports and leaves it alone", async () => {
    const repo = mkRepo();
    gitInit(repo);
    const before =
      "node_modules\n# Meetless per-folder activation marker (local opt-in; do not commit)\n.meetless.json\n";
    fs.writeFileSync(path.join(repo, ".gitignore"), before);

    const r = await runActivateIn({ home, cwd: repo });

    expect(r.code).toBe(0);
    // Byte-for-byte untouched, banner comment included.
    expect(fs.readFileSync(path.join(repo, ".gitignore"), "utf8")).toBe(before);
    // And the operator is told the truth about what that means for the binding.
    const out = r.logs.join("\n");
    expect(out).toContain("Commit guidance:");
    expect(out).toContain("mla will not touch it");
  });

  // --- --repair (re-check only, never mints; An 2026-06-04) -----------------

  it("--repair on an active binding re-checks connectivity and never provisions", async () => {
    const dir = mkRepo("loose");
    fs.writeFileSync(
      path.join(dir, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_ok", workspaceName: "ok" }) + "\n",
    );

    const r = await runActivateIn({ home, cwd: dir, argv: ["--repair"] });

    expect(r.code).toBe(0);
    const out = r.logs.join("\n");
    expect(out).toContain("active");
    expect(out).toContain("Nothing to repair");
    // Probe is a GET; never a provision POST.
    expect(fake.requests.some((q) => q.method === "GET")).toBe(true);
    expect(fake.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  it("--repair with no marker refuses and never mints an id", async () => {
    const dir = mkRepo("loose");

    const r = await runActivateIn({ home, cwd: dir, argv: ["--repair"] });

    expect(r.code).toBe(2);
    expect(r.logs.join("\n")).toContain("Nothing to repair");
    expect(fake.requests).toHaveLength(0);
  });

  it("--repair surfaces a missing workspace (404) without re-creating it", async () => {
    const dir = mkRepo("loose");
    fs.writeFileSync(
      path.join(dir, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_gone", workspaceName: "gone" }) + "\n",
    );
    fake.setMe(404, { error: "not found" });

    const r = await runActivateIn({ home, cwd: dir, argv: ["--repair"] });

    expect(r.code).toBe(1);
    const out = r.logs.join("\n");
    expect(out).toContain("does not exist or is inaccessible");
    expect(out).toContain("never re-creates");
    expect(fake.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });
});
