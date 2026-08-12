import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// `mla activate` while logged out blamed the NETWORK (2026-08-07 clean-room audit, #4).
//
// The provision catch branches on `err.status` alone:
//
//   401/403        -> "Control rejected the provision request (not authorized)."
//   any other code -> "Control could not provision the workspace (HTTP <n>)."
//   undefined      -> "Could not reach control to provision the workspace. Is it running?"
//
// There is no branch for "we hold no credential at all". `doFetch` fails fast on
// `auth.mode === 'none'` by THROWING `notLoggedInError()` before a socket is ever
// opened, so that throw carries no `.status` and lands in the connectivity `else`.
//
// The result is a diagnosis that contradicts the very command it recommends: the user
// is told control may be down and to run `mla doctor`, and `mla doctor` then reports
// `✓ control reachable`. Measured live against production control on 2026-08-07:
// activate printed "Could not reach control" while doctor printed control reachable
// in the same clean-room HOME, seconds apart.
//
// This test pins the differential the audit used. Control here is REACHABLE and
// answers /internal/v1/workspaces with a real workspace, so any "could not reach"
// claim is provably false rather than merely unhelpful. The only defect is the
// missing credential, and the message must say so and name `mla login`.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-actv-noauth-home-"));
process.env.MEETLESS_HOME = HOME;
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-actv-noauth-userhome-"));
const prevHomeEnv = process.env.HOME;
process.env.HOME = FAKE_HOME;

// require AFTER MEETLESS_HOME is set: config.ts freezes the HOME dir at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activate = require("../../src/commands/activate") as typeof import("../../src/commands/activate");
const { runActivate } = activate;

let server: http.Server;
let port: number;
let provisionHits = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname === "/internal/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (u.pathname === "/internal/v1/workspaces") {
      // Reachable AND willing. If activate ever got here it would succeed, which is
      // what makes "could not reach control" a false statement rather than a guess.
      provisionHits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ id: "cmnotloggedinws00000000a", name: "x", isNew: true }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  fs.writeFileSync(
    path.join(HOME, "cli-config.json"),
    // The state every brand-new install is in: wired, pointed at a live control,
    // and logged out. `install.sh` writes exactly this (auth.mode none).
    JSON.stringify({
      controlUrl: `http://127.0.0.1:${port}`,
      intelUrl: `http://127.0.0.1:${port}`,
      mlaPath: "/bin/true",
      auth: { mode: "none" },
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
  provisionHits = 0;
});

async function runActivateLoggedOut(): Promise<{
  code: number;
  out: string;
  err: string;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-actv-noauth-repo-"));
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
    // --create: the temp dir is not inside a Git repo. Orthogonal to the auth defect.
    const code = await runActivate(["--create"]);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

describe("mla activate: logged out is an auth failure, not a network failure", () => {
  it("names the missing credential and never blames connectivity", async () => {
    const { code, out, err } = await runActivateLoggedOut();
    const all = `${out}\n${err}`;

    // Nothing was ever sent: doFetch fails fast on auth.mode none. This is what
    // strips `.status` off the error and is the mechanism behind the misdiagnosis.
    expect(provisionHits).toBe(0);

    // The lie. Control is up and answering on this very port.
    expect(all).not.toMatch(/could not reach control/i);
    expect(all).not.toMatch(/is it running/i);

    // The truth, plus the one command that fixes it.
    expect(all).toMatch(/not signed in|not logged in/i);
    expect(all).toContain("mla login");

    // Still a failure: activate provisioned nothing.
    expect(code).toBe(1);
  });

  it("does not send the user to `mla doctor`, which will report control reachable", async () => {
    const { out, err } = await runActivateLoggedOut();
    const all = `${out}\n${err}`;
    // The audit's dead end: activate -> "run mla doctor" -> "✓ control reachable".
    // A remedy that contradicts the diagnosis is worse than no remedy.
    expect(all).not.toMatch(/mla doctor/);
  });
});
