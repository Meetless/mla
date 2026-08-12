import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// The committed-marker funnel leak (prod, 2026-07-31).
//
// `mla activate` keys create-vs-bind on marker PRESENCE alone, and the bind path was
// pure local truth: it printed "Already activated", exited 0, and never asked control
// whether this session can actually reach that workspace. The CLI's own commit guidance
// tells teams to COMMIT `.meetless.json` so the binding is shared, so the documented
// team-onboarding path is: teammate commits the marker -> new hire clones -> `mla login`
// (which mints an Account and deliberately no workspace, INV-ACC-3) -> `mla activate`
// -> bind -> green.
//
// That new hire has no WorkspaceUser row anywhere, so every workspace-scoped call
// afterwards is denied 403 NO_WORKSPACE_YET, and both call sites that make them
// (the per-run tracing prefetch and the trace ingest) swallow errors by design. One
// prod account lived in this state for three days and 178 denials with every surface
// green: the one command whose entire job is "get me a workspace" reported success
// while provisioning nothing.
//
// So: bind must ask. Only a deny answer (401/403) may change the verdict; anything
// else (offline, 5xx, timeout) keeps bind's local-truth behavior, which is the same
// rule `mla activate --repair` already follows.

const MARKER = "cmexampleteamws000000000a";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bind-e2e-home-"));
process.env.MEETLESS_HOME = HOME;
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bind-e2e-userhome-"));
const prevHomeEnv = process.env.HOME;
process.env.HOME = FAKE_HOME;

// require AFTER MEETLESS_HOME is set: config.ts freezes the HOME dir at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activate = require("../../src/commands/activate") as typeof import("../../src/commands/activate");
const { runActivate } = activate;

let server: http.Server;
let port: number;
let meHits: URLSearchParams[] = [];
let meResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname === "/internal/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (u.pathname === "/internal/v1/workspaces/me") {
      meHits.push(u.searchParams);
      res.writeHead(meResponse.status, { "content-type": "application/json" });
      res.end(JSON.stringify(meResponse.body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  fs.writeFileSync(
    path.join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: `http://127.0.0.1:${port}`,
      controlToken: "ik-test",
      actorUserId: "wu_test_actor",
      mlaPath: "/bin/true",
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  if (prevHomeEnv === undefined) delete process.env.HOME;
  else process.env.HOME = prevHomeEnv;
});

beforeEach(() => {
  meHits = [];
});

// Run `mla activate` (no flags) from a fresh folder that already carries a committed
// marker, capturing stdout + stderr. This is exactly the new-hire-clones-the-repo state.
async function runActivateInBoundFolder(): Promise<{
  code: number;
  out: string;
  err: string;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bind-e2e-repo-"));
  fs.writeFileSync(
    path.join(dir, ".meetless.json"),
    JSON.stringify({ workspaceId: MARKER, activatedAt: "2026-07-28T00:00:00.000Z" }),
  );
  const prevCwd = process.cwd();
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = jest
    .spyOn(console, "log")
    .mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  const errSpy = jest
    .spyOn(console, "error")
    .mockImplementation((...a) => void err.push(a.map(String).join(" ")));
  try {
    process.chdir(dir);
    const code = await runActivate([]);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

describe("mla activate: bind path membership probe (blackbox against a control stub)", () => {
  it("refuses to report success when the session has no workspace at all (403 NO_WORKSPACE_YET)", async () => {
    meResponse = {
      status: 403,
      body: {
        statusCode: 403,
        code: "NO_WORKSPACE_YET",
        message: "No workspace yet. Run `mla activate` to create one.",
      },
    };

    const { code, out, err } = await runActivateInBoundFolder();
    const all = `${out}\n${err}`;

    // The wire actually carried the marker id: bind ASKED control about this binding.
    expect(meHits).toHaveLength(1);
    expect(meHits[0].get("workspaceId")).toBe(MARKER);

    // The lie: "Already activated" is a claim that this folder works. It does not.
    expect(all).not.toContain("Already activated");
    expect(all).not.toContain("already bound to a workspace");

    // The user must be told the actual state and a remedy they can apply themselves.
    expect(all).toContain(MARKER);
    expect(all).toMatch(/no workspace/i);
    // Both remedies: get invited into the marker's workspace, or provision their own.
    expect(all).toContain("mla workspace invite");
    expect(all).toContain("mla deactivate");

    // A dead binding must fail the command, not exit 0.
    expect(code).not.toBe(0);
  });

  it("still binds when control confirms the membership", async () => {
    meResponse = { status: 200, body: { tracing: { fullContextCaptures: false } } };

    const { code, out } = await runActivateInBoundFolder();

    expect(meHits).toHaveLength(1);
    expect(out).toContain("Already activated");
    expect(out).toContain(MARKER);
    expect(code).toBe(0);
  });

  it("keeps binding when control is unreachable: bind is local truth, never blocked on connectivity", async () => {
    // Point the config at a dead port for this case only. `mla activate --repair` has
    // followed this rule since 2026-06-04 and bind must not be stricter: an operator on
    // a plane, or with control down, still has a valid local binding.
    const cfgPath = path.join(HOME, "cli-config.json");
    const good = fs.readFileSync(cfgPath, "utf8");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        controlToken: "ik-test",
        actorUserId: "wu_test_actor",
        mlaPath: "/bin/true",
      }),
    );
    try {
      const { code, out } = await runActivateInBoundFolder();
      expect(out).toContain("Already activated");
      expect(code).toBe(0);
    } finally {
      fs.writeFileSync(cfgPath, good);
    }
  });
});
