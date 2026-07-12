import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// BLACKBOX (command-boundary) coverage for the folder-binding assertion. The pure
// `workspaceBindingCheck` is pinned in doctor-workspace-binding.spec.ts; what THIS proves is
// the whole wire: readConfig -> tryResolveWorkspaceId (the `.meetless.json` marker) -> the
// whoami GET (URL built with the marker id + actorUserId) -> control's echoed workspace ->
// workspaceBindingCheck -> fmt -> emitted line + doctor exit code. A real local HTTP stub
// stands in for control (only the external boundary is faked, per the testing floor), the
// marker is a real file in a real cwd, and we assert on what `mla doctor` actually prints and
// returns. This is the layer the unit test cannot see: a regression that dropped the marker id
// from the whoami URL, or stopped feeding whoami into the check, would pass the unit test and
// fail here.

const MARKER = "cmq9l2xom002n5ueiwjuoy9bb";
const OTHER = "cmr9nonon00r37o4rspjl9n88";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-doctor-e2e-home-"));
process.env.MEETLESS_HOME = HOME;
// Isolate os.homedir() so the hooks/skill/MCP checks read an empty temp home (deterministic in
// CI) instead of the operator's real ~/.claude. Those checks are irrelevant here; the binding
// line and its RED-forces-exit-1 contribution are what we assert.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-doctor-e2e-userhome-"));
const prevHomeEnv = process.env.HOME;
process.env.HOME = FAKE_HOME;

// require AFTER MEETLESS_HOME is set: config.ts freezes the HOME dir at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const doctor = require("../../src/commands/doctor") as typeof import("../../src/commands/doctor");
const { runDoctor } = doctor;

// --- the control stub -------------------------------------------------------------------
let server: http.Server;
let port: number;
let whoamiHits: URLSearchParams[] = [];
let whoamiResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname === "/internal/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (u.pathname === "/internal/v1/whoami") {
      whoamiHits.push(u.searchParams);
      res.writeHead(whoamiResponse.status, { "content-type": "application/json" });
      res.end(JSON.stringify(whoamiResponse.body));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  // cli-config: shared-key (legacy top-level controlToken normalizes to shared-key mode).
  // intelUrl is omitted so the intel probes are skipped entirely (irrelevant to the binding).
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
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  if (prevHomeEnv === undefined) delete process.env.HOME;
  else process.env.HOME = prevHomeEnv;
});

// Run runDoctor from inside a freshly-created folder bound to `markerWorkspaceId`, capturing
// every console.log line and restoring cwd after. runDoctor reads the marker from cwd and the
// config from MEETLESS_HOME at call time, so no module reset is needed between cases.
async function runDoctorInBoundFolder(markerWorkspaceId: string): Promise<{ code: number; out: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-doctor-e2e-repo-"));
  fs.writeFileSync(
    path.join(dir, ".meetless.json"),
    JSON.stringify({ workspaceId: markerWorkspaceId, activatedAt: "2026-06-04T00:00:00.000Z" }),
  );
  const prevCwd = process.cwd();
  const lines: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.map(String).join(" ")));
  // Swallow the doctor's own "Doctor RED" banner (console.error): in an isolated FAKE_HOME the
  // CE0 store + hooks are absent so the global verdict is red regardless of the binding. Each
  // test asserts on the specific binding line, not the global verdict, so this is only noise.
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.chdir(dir);
    const code = await runDoctor([]);
    return { code, out: lines.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  whoamiHits = [];
});

describe("mla doctor: folder-binding assertion (blackbox against a control stub)", () => {
  it("prints a GREEN binding line carrying the workspace id when control resolves the marker id", async () => {
    whoamiResponse = {
      status: 200,
      body: {
        workspace: { id: MARKER, slug: "an-pham-s-workspace-jgqmd4cc" },
        actor: { displayName: "An Pham", role: "OWNER" },
        actorIsOwner: true,
        caseKindAgentReviewSeeded: true,
      },
    };

    const { out } = await runDoctorInBoundFolder(MARKER);

    // The wire actually carried the marker id + actor onto the whoami query.
    expect(whoamiHits).toHaveLength(1);
    expect(whoamiHits[0].get("workspaceId")).toBe(MARKER);
    expect(whoamiHits[0].get("actorUserId")).toBe("wu_test_actor");

    // The emitted binding line is the green one AND it surfaces the id (so this line and the
    // "folder activated" line are recognizably the same workspace despite differing labels).
    const bindingLine = out.split("\n").find((l) => l.includes("token valid + workspace resolves"));
    expect(bindingLine).toBeDefined();
    expect(bindingLine).toContain(MARKER);
    expect(out).not.toContain("does not match the folder binding");
  });

  it("prints a RED mismatch line (both ids) and exits non-zero when control resolves a different id", async () => {
    whoamiResponse = {
      status: 200,
      body: {
        workspace: { id: OTHER, slug: "phantom" },
        actor: { displayName: "Someone", role: "OWNER" },
        actorIsOwner: true,
        caseKindAgentReviewSeeded: true,
      },
    };

    const { code, out } = await runDoctorInBoundFolder(MARKER);

    const bindingLine = out.split("\n").find((l) => l.includes("does not match the folder binding"));
    expect(bindingLine).toBeDefined();
    expect(bindingLine).toContain(MARKER); // what the folder binds
    expect(bindingLine).toContain(OTHER); // what the token actually resolved
    // A red, non-info binding check must fail the CI gate. runDoctor returns 1 whenever any
    // non-info check is red; a misbinding is exactly that, so the exit is deterministically 1.
    expect(code).toBe(1);
  });

  it("goes RED (not silently green) when the backend cannot see the workspace at all", async () => {
    // control returns {} for a workspaceId its DB does not hold (cli-config aimed at the wrong
    // backend). Before the fix this passed as green; it must now fail the gate.
    whoamiResponse = { status: 200, body: {} };

    const { code, out } = await runDoctorInBoundFolder(MARKER);

    const bindingLine = out.split("\n").find((l) => l.includes("does not match the folder binding"));
    expect(bindingLine).toBeDefined();
    expect(bindingLine).toContain("no workspace");
    expect(code).toBe(1);
  });
});
