import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// D2 (notes/20260810-worktree-binding-loss-and-multi-repo-shared-workspace.md):
// a company with several repos could not bind them to one shared workspace.
// `mla activate` is provision-or-bind keyed on marker PRESENCE, so the second
// repo minted a SECOND workspace by design, and control says so in its own
// comment ("`mla activate` in a second repo creates a second workspace the
// human owns"). `mla workspace use <id>` was removed in T3.2 and nothing
// replaced it.
//
// `mla activate --workspace <id>` is the explicit third option: bind THIS
// folder to an EXISTING workspace. It provisions nothing, it verifies
// membership with the machinery the bind path already uses, and it never
// silently repoints a binding that is already here.

const EXISTING = "cmexample0000000000000021";
const OTHER = "cmotherws00000000000000b";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-wsflag-home-"));
process.env.MEETLESS_HOME = HOME;
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-wsflag-userhome-"));
const prevHomeEnv = process.env.HOME;
process.env.HOME = FAKE_HOME;

// require AFTER MEETLESS_HOME is set: config.ts freezes the HOME dir at load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const activate = require("../../src/commands/activate") as typeof import("../../src/commands/activate");
const { runActivate, parseActivateArgs } = activate;

let server: http.Server;
let port: number;
let meHits: URLSearchParams[] = [];
let provisionHits: number;
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
    if (u.pathname === "/internal/v1/workspaces" && req.method === "POST") {
      // The assertion that matters most: binding must never mint a workspace.
      provisionHits += 1;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ws_should_never_happen", name: "nope", isNew: true }));
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
  provisionHits = 0;
  meResponse = { status: 200, body: { tracing: { fullContextCaptures: false } } };
});

interface RunResult {
  code: number;
  out: string;
  err: string;
  marker: { workspaceId?: string } | null;
}

async function runIn(dir: string, argv: string[]): Promise<RunResult> {
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
    const code = await runActivate(argv);
    const p = path.join(dir, ".meetless.json");
    const marker = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
    return { code, out: out.join("\n"), err: err.join("\n"), marker };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(prevCwd);
  }
}

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mla-wsflag-repo-"));
}

function writeMarker(dir: string, workspaceId: string): void {
  fs.writeFileSync(path.join(dir, ".meetless.json"), JSON.stringify({ workspaceId }));
}

describe("parseActivateArgs --workspace", () => {
  it("parses the id", () => {
    expect(parseActivateArgs(["--workspace", EXISTING])).toEqual({ workspace: EXISTING });
  });

  it("rejects a missing value", () => {
    expect(() => parseActivateArgs(["--workspace"])).toThrow(/Missing value/);
  });

  it("composes with the flags that still mean something (note, bootstrap)", () => {
    expect(parseActivateArgs(["--workspace", EXISTING, "--note", "n", "--bootstrap", "fast"])).toEqual({
      workspace: EXISTING,
      note: "n",
      bootstrap: "fast",
    });
  });

  it("has no --force escape hatch", () => {
    expect(() => parseActivateArgs(["--workspace", EXISTING, "--force"])).toThrow(/Unknown argument/);
  });
});

describe("mla activate --workspace <id>: binds an EXISTING workspace, provisions nothing", () => {
  it("writes the marker after control confirms the membership", async () => {
    const dir = tmpRepo();
    try {
      const { code, out, marker } = await runIn(dir, ["--workspace", EXISTING]);
      expect(code).toBe(0);
      expect(marker?.workspaceId).toBe(EXISTING);
      // It ASKED, and it asked about the right workspace.
      expect(meHits).toHaveLength(1);
      expect(meHits[0].get("workspaceId")).toBe(EXISTING);
      // It never minted anything.
      expect(provisionHits).toBe(0);
      expect(out).not.toMatch(/Provisioned workspace/i);
      expect(out).toContain(EXISTING);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("refuses on a definite membership DENY and writes no marker", async () => {
    meResponse = {
      status: 403,
      body: { statusCode: 403, code: "WORKSPACE_ACCESS_DENIED", message: "denied" },
    };
    const dir = tmpRepo();
    try {
      const { code, out, err, marker } = await runIn(dir, ["--workspace", EXISTING]);
      const all = `${out}\n${err}`;
      expect(code).not.toBe(0);
      expect(marker).toBeNull();
      expect(provisionHits).toBe(0);
      // The remedy the bind path already knows how to give.
      expect(all).toContain("mla workspace invite");
      expect(all).toContain(EXISTING);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("binds when control is UNREACHABLE, matching the established bind rule", async () => {
    // Only a definite DENY changes the verdict. Offline/5xx keeps local truth,
    // exactly as `mla activate` bind and `--repair` have behaved since 2026-06-04.
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
    const dir = tmpRepo();
    try {
      const { code, marker } = await runIn(dir, ["--workspace", EXISTING]);
      expect(code).toBe(0);
      expect(marker?.workspaceId).toBe(EXISTING);
    } finally {
      fs.writeFileSync(cfgPath, good);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("is idempotent when this folder is ALREADY bound to the requested workspace", async () => {
    const dir = tmpRepo();
    writeMarker(dir, EXISTING);
    try {
      const { code, out, marker } = await runIn(dir, ["--workspace", EXISTING]);
      expect(code).toBe(0);
      expect(marker?.workspaceId).toBe(EXISTING);
      expect(provisionHits).toBe(0);
      expect(out).toMatch(/already/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("REFUSES when this folder is bound to a DIFFERENT workspace, and leaves it alone", async () => {
    const dir = tmpRepo();
    writeMarker(dir, OTHER);
    try {
      const { code, out, err, marker } = await runIn(dir, ["--workspace", EXISTING]);
      const all = `${out}\n${err}`;
      expect(code).not.toBe(0);
      // Untouched: no silent repoint. That is the defect `mla workspace use` had.
      expect(marker?.workspaceId).toBe(OTHER);
      expect(all).toContain(OTHER);
      expect(all).toContain(EXISTING);
      expect(all).toContain("mla deactivate");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("writes a NEARER marker when only an ANCESTOR marker exists (deliberate operator intent)", async () => {
    // The multi-repo shape: an umbrella folder was activated once, and the
    // operator now wants each repo under it bound in its own right so each keeps
    // its own scan root. Nearest-wins then does the rest.
    const umbrella = tmpRepo();
    const repo = path.join(umbrella, "repo-b");
    fs.mkdirSync(repo, { recursive: true });
    writeMarker(umbrella, OTHER);
    try {
      const { code, marker } = await runIn(repo, ["--workspace", EXISTING]);
      expect(code).toBe(0);
      expect(marker?.workspaceId).toBe(EXISTING);
      // The ancestor is untouched.
      expect(JSON.parse(fs.readFileSync(path.join(umbrella, ".meetless.json"), "utf8")).workspaceId).toBe(OTHER);
    } finally {
      fs.rmSync(umbrella, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("binds a NON-git directory without --create (nothing is being provisioned)", async () => {
    // The repo-root guard exists to stop accidental workspace FRAGMENTS from
    // auto-creation (INV-FLAGS-1). `--workspace` creates nothing, so the guard's
    // premise does not apply and it must not demand an override flag.
    const dir = tmpRepo();
    try {
      const { code, marker } = await runIn(dir, ["--workspace", EXISTING]);
      expect(code).toBe(0);
      expect(marker?.workspaceId).toBe(EXISTING);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("refuses to combine with the create-path overrides and with --repair", async () => {
    const dir = tmpRepo();
    try {
      for (const combo of [["--here"], ["--create"], ["--repair"], ["--name", "x"]]) {
        const { code, out, err } = await runIn(dir, ["--workspace", EXISTING, ...combo]);
        const all = `${out}\n${err}`;
        expect(code).not.toBe(0);
        expect(all).toContain("--workspace");
        expect(fs.existsSync(path.join(dir, ".meetless.json"))).toBe(false);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("rejects a malformed workspace id before any network call or write", async () => {
    const dir = tmpRepo();
    try {
      const { code, marker } = await runIn(dir, ["--workspace", "  "]);
      expect(code).not.toBe(0);
      expect(marker).toBeNull();
      expect(meHits).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});
