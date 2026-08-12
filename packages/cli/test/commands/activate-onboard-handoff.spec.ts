import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// The onboarding hand-off was an EDGE trigger with no recovery (prod, 2026-08-02).
//
// `onboardRecommendation` fired only when `justProvisioned` was true, and that flag is
// set by the provision path alone. So the hand-off into `/mla onboard` reached exactly
// one person: whoever ran the very first `mla activate` in a folder, in a live session.
// Everyone else got nothing, forever:
//
//   - the teammate who clones a repo with a COMMITTED `.meetless.json` takes the bind
//     path (justProvisioned=false) on their first activate and every activate after;
//   - the operator whose first activate ran outside a session (inSession=false) burned
//     the single edge and can never get it back, because activate 2..N also bind.
//
// Measured in prod: of 29 workspaces that ever ran an mla command, only 7 ever ran
// `activate` at all, and 22 hold zero rules. Of the 7, the 2 that chained into onboarding
// both ended with rules (32 and 11); the 5 that did not hold 0, 1, 7, 0, 0.
//
// The fix makes the hand-off a LEVEL condition: "this workspace has never been onboarded",
// read from the workspace-grain onboarding marker. The marker gate then silences it after
// one successful onboarding, so it is still one-shot per workspace, just recoverable.
//
// Fail-QUIET, not fail-open: a nudge is not a gate. `enrich plan` fails open (an
// unreachable intel must never BLOCK onboarding), but an unknown answer here must not
// nag on every activate, so only an affirmative "no marker" speaks.

const MARKER = "cmexamplehandoffws0000001";
const SESSION = "sess-handoff-0000-1111-2222";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-handoff-home-"));
process.env.MEETLESS_HOME = HOME;
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-handoff-userhome-"));
const prevHomeEnv = process.env.HOME;
process.env.HOME = FAKE_HOME;
const prevSession = process.env.CLAUDE_CODE_SESSION_ID;
process.env.CLAUDE_CODE_SESSION_ID = SESSION;

// require AFTER MEETLESS_HOME is set: config.ts freezes the HOME dir at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activate = require("../../src/commands/activate") as typeof import("../../src/commands/activate");
const { runActivate, onboardRecommendation } = activate;

let server: http.Server;
let port: number;
let statusHits: URLSearchParams[] = [];
let statusResponse: { status: number; body: unknown } = { status: 200, body: { onboarded: false } };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname === "/internal/v1/onboarding/status") {
      statusHits.push(u.searchParams);
      res.writeHead(statusResponse.status, { "content-type": "application/json" });
      res.end(JSON.stringify(statusResponse.body));
      return;
    }
    if (u.pathname === "/internal/v1/workspaces/me") {
      // Membership confirmed: bind proceeds to the activation tail.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tracing: { fullContextCaptures: false } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  seedConfig(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Teardown must never be able to fail a suite that passed. `force` only swallows
  // ENOENT; the hooks these tests exercise run `mkdir -p "$QUEUE_DIR"` from a spawned
  // shell (hooks-template/common.sh), so a writer that lands a file between rmSync's
  // readdir and its rmdir throws ENOTEMPTY and fails the whole SUITE with every test
  // green (CI: "6748 passed, 0 total failed", suite failed to run). Retry, then give
  // up quietly. Same hazard and same remedy as activation-gate.spec.ts.
  for (const dir of [HOME, FAKE_HOME]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch {
      /* best effort: os.tmpdir() litter is not what this spec asserts on */
    }
  }
  if (prevHomeEnv === undefined) delete process.env.HOME;
  else process.env.HOME = prevHomeEnv;
  if (prevSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = prevSession;
});

function seedConfig(intelUrl: string): void {
  fs.writeFileSync(
    path.join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: `http://127.0.0.1:${port}`,
      intelUrl,
      controlToken: "ik-test",
      actorUserId: "wu_test_actor",
      mlaPath: "/bin/true",
    }),
  );
}

beforeEach(() => {
  statusHits = [];
  statusResponse = { status: 200, body: { onboarded: false } };
  seedConfig(`http://127.0.0.1:${port}`);
});

// `mla activate` from a folder that already carries a COMMITTED marker: the bind path,
// which is what every activate after the first one takes, and what a teammate's first
// one takes too.
async function activateBoundFolder(): Promise<{ code: number; out: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-handoff-repo-"));
  fs.writeFileSync(
    path.join(dir, ".meetless.json"),
    JSON.stringify({ workspaceId: MARKER, activatedAt: "2026-07-28T00:00:00.000Z" }),
  );
  const prevCwd = process.cwd();
  const out: string[] = [];
  const logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.map(String).join(" ")));
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    process.chdir(dir);
    const code = await runActivate([]);
    return { code, out: out.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

// ---------------------------------------------------------------------------------
// The pure decision. justProvisioned stays a LOCAL shortcut (a workspace created this
// second cannot have a marker, and must not need the network to be told so); the
// workspace-grain answer is what makes the hand-off recoverable on the bind path.
// ---------------------------------------------------------------------------------
describe("onboardRecommendation (pure)", () => {
  it("fires on the bind path when the workspace has NEVER been onboarded", () => {
    const out = onboardRecommendation({ inSession: true, justProvisioned: false, workspaceOnboarded: false });
    expect(out).not.toBeNull();
    expect(out!.split("\n")).toContain("MLA_NEXT: onboard");
  });

  it("stays silent once the workspace HAS been onboarded (one-shot, not a nag)", () => {
    expect(onboardRecommendation({ inSession: true, justProvisioned: false, workspaceOnboarded: true })).toBeNull();
  });

  it("stays silent when the answer is UNKNOWN (fail-quiet: a nudge is not a gate)", () => {
    expect(onboardRecommendation({ inSession: true, justProvisioned: false, workspaceOnboarded: null })).toBeNull();
  });

  it("still fires for a just-provisioned workspace with no network answer at all", () => {
    // A workspace created this second has no marker by construction, so the hand-off
    // must not depend on intel being reachable at that moment.
    expect(onboardRecommendation({ inSession: true, justProvisioned: true, workspaceOnboarded: null })).not.toBeNull();
  });

  it("stays silent outside a session, whatever the marker says", () => {
    expect(onboardRecommendation({ inSession: false, justProvisioned: true, workspaceOnboarded: false })).toBeNull();
    expect(onboardRecommendation({ inSession: false, justProvisioned: false, workspaceOnboarded: false })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------
// Command boundary: real `mla activate`, real bind path, live stubs for control + intel.
// ---------------------------------------------------------------------------------
describe("mla activate: onboarding hand-off on the bind path", () => {
  it("hands off to onboarding when the bound workspace has no marker (the bug)", async () => {
    statusResponse = { status: 200, body: { onboarded: false } };

    const { code, out } = await activateBoundFolder();

    expect(code).toBe(0);
    expect(out).toContain("Already activated"); // it really did take the bind path
    expect(out.split("\n")).toContain("MLA_NEXT: onboard");
    expect(out).toContain("/mla onboard");
  });

  it("asks the WORKSPACE-grain question: no headCommit on the probe", async () => {
    await activateBoundFolder();

    expect(statusHits).toHaveLength(1);
    expect(statusHits[0].get("workspaceId")).toBe(MARKER);
    // Commit grain would answer "was THIS commit onboarded", which reads false at every
    // new HEAD and would turn a one-shot hand-off into a nag on every commit.
    expect(statusHits[0].get("headCommit")).toBeNull();
  });

  it("stays silent once the workspace has been onboarded", async () => {
    statusResponse = {
      status: 200,
      body: { onboarded: true, completedAt: "2026-07-02T00:00:00.000Z", candidatesPersisted: 12 },
    };

    const { code, out } = await activateBoundFolder();

    expect(code).toBe(0);
    expect(out).toContain("Already activated");
    expect(out).not.toContain("MLA_NEXT: onboard");
  });

  it("stays silent when intel is unreachable, and still exits 0", async () => {
    seedConfig("http://127.0.0.1:1"); // dead port

    const { code, out } = await activateBoundFolder();

    expect(code).toBe(0);
    expect(out).toContain("Already activated");
    expect(out).not.toContain("MLA_NEXT: onboard");
  });

  it("stays silent when intel 5xxs", async () => {
    statusResponse = { status: 503, body: { error: "down" } };

    const { code, out } = await activateBoundFolder();

    expect(code).toBe(0);
    expect(out).not.toContain("MLA_NEXT: onboard");
    expect(statusHits).toHaveLength(1); // it DID ask
  });
});
