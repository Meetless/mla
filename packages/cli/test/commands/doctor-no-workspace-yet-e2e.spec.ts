import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// `mla doctor` is the command a stuck operator runs, and it was the one place that
// DID surface control's 403 on whoami. It surfaced it as
// `HTTP 403: ${err.message.slice(0, 120)}`, where err.message is built by
// http.ts's buildError as `GET <url> -> HTTP <status>: <body>`. With a prod control
// URL plus a 25-char workspaceId plus a 25-char actorUserId, that prefix alone runs
// ~126 chars, so the 120-char slice ends INSIDE the query string and the body never
// appears. Control writes NO_WORKSPACE_YET with the message "No workspace yet. Run
// `mla activate` to create one." precisely so the human can self-serve; the doctor
// truncated the remedy off and printed a URL.
//
// Two things are asserted here: the specific NO_WORKSPACE_YET diagnosis (which is a
// membership problem, not a token problem), and the general rule that a control error
// carrying a JSON envelope renders the SERVER's message rather than a sliced URL.

const MARKER = "cmexampledogfoodws0000000";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-doctor-nwy-home-"));
process.env.MEETLESS_HOME = HOME;
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-doctor-nwy-userhome-"));
const prevHomeEnv = process.env.HOME;
process.env.HOME = FAKE_HOME;

// require AFTER MEETLESS_HOME is set: config.ts freezes the HOME dir at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const doctor = require("../../src/commands/doctor") as typeof import("../../src/commands/doctor");
const { runDoctor } = doctor;

let server: http.Server;
let port: number;
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
      res.writeHead(whoamiResponse.status, { "content-type": "application/json" });
      res.end(JSON.stringify(whoamiResponse.body));
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

async function runDoctorInBoundFolder(): Promise<{ code: number; out: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-doctor-nwy-repo-"));
  fs.writeFileSync(
    path.join(dir, ".meetless.json"),
    JSON.stringify({ workspaceId: MARKER, activatedAt: "2026-07-28T00:00:00.000Z" }),
  );
  const prevCwd = process.cwd();
  const lines: string[] = [];
  const logSpy = jest
    .spyOn(console, "log")
    .mockImplementation((...a) => void lines.push(a.map(String).join(" ")));
  const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    process.chdir(dir);
    const code = await runDoctor([]);
    return { code, out: lines.join("\n") };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}

describe("mla doctor: a control error must render its remedy, not a truncated URL", () => {
  it("diagnoses NO_WORKSPACE_YET as a missing membership and names both remedies", async () => {
    whoamiResponse = {
      status: 403,
      body: {
        statusCode: 403,
        code: "NO_WORKSPACE_YET",
        message: "No workspace yet. Run `mla activate` to create one.",
      },
    };

    const { code, out } = await runDoctorInBoundFolder();

    const line = out
      .split("\n")
      .find((l) => /no workspace/i.test(l) && l.includes(MARKER));
    expect(line).toBeDefined();
    // The two remedies, same as the bind path: get invited, or use your own workspace.
    expect(line).toContain("mla workspace invite");
    expect(line).toContain("mla deactivate");
    // It is NOT a token problem, so it must not read as one.
    expect(line).not.toMatch(/token (is )?(invalid|expired)/i);
    expect(code).toBe(1);
  });

  it("names the signed-in email in the invite remedy so it is copy-pasteable", async () => {
    whoamiResponse = {
      status: 403,
      body: {
        statusCode: 403,
        code: "NO_WORKSPACE_YET",
        message: "No workspace yet. Run `mla activate` to create one.",
      },
    };
    const cfgPath = path.join(HOME, "cli-config.json");
    const good = fs.readFileSync(cfgPath, "utf8");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        controlUrl: `http://127.0.0.1:${port}`,
        auth: {
          mode: "user-token",
          accessToken: "at_test",
          refreshToken: "rt_test",
          accessExpiresAt: "2099-01-01T00:00:00.000Z",
          refreshExpiresAt: "2099-01-01T00:00:00.000Z",
          sessionId: "sess_test",
          user: {
            id: "cmtestuser00000000000000",
            displayName: "New Hire",
            email: "newhire@example.com",
            role: "MEMBER",
          },
        },
        mlaPath: "/bin/true",
      }),
    );
    try {
      const { out } = await runDoctorInBoundFolder();
      const line = out
        .split("\n")
        .find((l) => /no workspace/i.test(l) && l.includes(MARKER));
      expect(line).toContain("mla workspace invite newhire@example.com");
      expect(line).not.toContain("<your-email>");
    } finally {
      fs.writeFileSync(cfgPath, good);
    }
  });

  it("prints the server's message for any enveloped control error, never a sliced URL", async () => {
    whoamiResponse = {
      status: 400,
      body: {
        statusCode: 400,
        code: "BAD_REQUEST",
        message: "workspaceId query param required",
      },
    };

    const { out } = await runDoctorInBoundFolder();

    const line = out.split("\n").find((l) => l.includes("HTTP 400"));
    expect(line).toBeDefined();
    expect(line).toContain("workspaceId query param required");
    // The old rendering leaked the full request URL into the detail and cut the body off.
    expect(line).not.toContain("/internal/v1/whoami?workspaceId=");
  });
});
