import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findActivation } from "../../src/lib/activation";

// T1.2 (folder = workspace, notes/20260604-folder-equals-workspace-binding-
// design.md): the bash capture gate `meetless_activated` (common.sh) and the TS
// resolver `findActivation` (lib/activation.ts) MUST resolve the SAME marker for
// the same effective session directory, and the capture path MUST POST under the
// MARKER workspaceId, never the cli-config one.
//
// This is the design's "cwd / nearest-wins parity (hard test, not a note)": the
// 5-case matrix below drives the real bash function and the real TS resolver
// over identical fixtures and asserts they agree. The final block locks the hard
// cutover: after the gate fires, WORKSPACE_ID is the marker's id, NOT a stale
// cli-config workspaceId left over from the pre-folder-binding world.

const COMMON_SH = path.resolve(__dirname, "../../src/hooks-template/common.sh");

interface BashResolve {
  activated: boolean;
  markerFile: string;
  markerWs: string;
  workspaceId: string;
}

// Source common.sh in a real bash, run meetless_activated, and print the state it
// resolved. `startDir` (when given) is passed as the explicit arg the way a test
// drives it; when omitted, the gate falls back to $PWD exactly as the capture
// hooks invoke it, so `cwd`/`pwd` model "hook subprocess invoked with a cwd".
function bashResolve(opts: {
  home: string;
  startDir?: string;
  pwd?: string;
}): BashResolve {
  const arg = opts.startDir ? JSON.stringify(opts.startDir) : "";
  const probe =
    "source " +
    JSON.stringify(COMMON_SH) +
    "\n" +
    "if meetless_activated " +
    arg +
    "; then act=1; else act=0; fi\n" +
    'printf "ACT=%s\\n" "$act"\n' +
    'printf "MARKER=%s\\n" "${MEETLESS_MARKER_FILE:-}"\n' +
    'printf "MARKERWS=%s\\n" "${MEETLESS_MARKER_WORKSPACE_ID:-}"\n' +
    'printf "WORKSPACE_ID=%s\\n" "${WORKSPACE_ID:-}"\n';

  const env: NodeJS.ProcessEnv = { ...process.env, MEETLESS_HOME: opts.home };
  if (opts.pwd) env.PWD = opts.pwd;

  const out = execFileSync("bash", ["-c", probe], {
    cwd: opts.pwd ?? opts.home,
    env,
    encoding: "utf8",
  });

  const fields: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return {
    activated: fields.ACT === "1",
    markerFile: fields.MARKER ?? "",
    markerWs: fields.MARKERWS ?? "",
    workspaceId: fields.WORKSPACE_ID ?? "",
  };
}

// Compare the bash gate and the TS resolver over the same start dir. Marker paths
// are compared by realpath so macOS /var -> /private/var symlinking (bash `cd &&
// pwd` is physical, path.resolve is logical) never produces a false mismatch.
function assertParity(bash: BashResolve, startDir: string): void {
  const ts = findActivation(startDir);
  expect(bash.activated).toBe(ts !== null);
  if (ts) {
    expect(fs.realpathSync(bash.markerFile)).toBe(fs.realpathSync(ts.path));
    expect(bash.markerWs).toBe(ts.workspaceId ?? "");
  } else {
    expect(bash.markerFile).toBe("");
  }
}

function writeMarker(dir: string, body: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, ".meetless.json");
  fs.writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

function writeCfg(home: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify(cfg, null, 2) + "\n",
  );
}

describe("hook resolver parity: bash gate == TS resolver (T1.2 matrix)", () => {
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-parity-"));
    home = path.join(tmp, "home");
    // A cli-config WITH a (stale) workspaceId, to prove marker resolution never
    // depends on it and never leaks it into the capture path.
    writeCfg(home, {
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "t",
      workspaceId: "ws_stale_config",
      actorUserId: "u_an",
    });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("case 1: launched from the repo root resolves the root marker", () => {
    const repo = path.join(tmp, "repo");
    writeMarker(repo, { workspaceId: "ws_root" });

    const bash = bashResolve({ home, startDir: repo });

    expect(bash.activated).toBe(true);
    expect(bash.markerWs).toBe("ws_root");
    assertParity(bash, repo);
  });

  it("case 2: launched from a subdir walks up to the root marker (nearest-wins)", () => {
    const repo = path.join(tmp, "repo");
    writeMarker(repo, { workspaceId: "ws_root" });
    const sub = path.join(repo, "apps", "control", "src");
    fs.mkdirSync(sub, { recursive: true });

    const bash = bashResolve({ home, startDir: sub });

    expect(bash.activated).toBe(true);
    expect(bash.markerWs).toBe("ws_root");
    assertParity(bash, sub);
  });

  it("case 3: hook subprocess with a cwd != repo root resolves via $PWD", () => {
    const repo = path.join(tmp, "repo");
    writeMarker(repo, { workspaceId: "ws_root" });
    const sub = path.join(repo, "deep", "nested", "leaf");
    fs.mkdirSync(sub, { recursive: true });

    // No explicit arg: the gate falls back to $PWD, exactly as the four capture
    // hooks call it. The bash process runs with cwd = the nested subdir.
    const bash = bashResolve({ home, pwd: sub });

    expect(bash.activated).toBe(true);
    expect(bash.markerWs).toBe("ws_root");
    assertParity(bash, sub);
  });

  it("case 4: a sub-project marker wins over the monorepo root marker", () => {
    const repo = path.join(tmp, "repo");
    writeMarker(repo, { workspaceId: "ws_root" });
    const widget = path.join(repo, "packages", "widget");
    writeMarker(widget, { workspaceId: "ws_widget" });
    const sub = path.join(widget, "src");
    fs.mkdirSync(sub, { recursive: true });

    const bash = bashResolve({ home, startDir: sub });

    expect(bash.activated).toBe(true);
    expect(bash.markerWs).toBe("ws_widget");
    assertParity(bash, sub);
  });

  it("case 5: no marker anywhere => both resolve to not activated", () => {
    const bare = path.join(tmp, "bare", "no", "marker");
    fs.mkdirSync(bare, { recursive: true });

    const bash = bashResolve({ home, startDir: bare });

    expect(bash.activated).toBe(false);
    expect(bash.markerFile).toBe("");
    assertParity(bash, bare);
  });
});

describe("hook capture cutover: WORKSPACE_ID is the marker id, not cli-config (T1.2)", () => {
  let tmp: string;
  let home: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-cutover-"));
    home = path.join(tmp, "home");
    // The stale cli-config workspaceId that the pre-cutover bash read into
    // WORKSPACE_ID. The marker MUST shadow it.
    writeCfg(home, {
      controlUrl: "http://127.0.0.1:3006",
      controlToken: "t",
      workspaceId: "ws_stale_config",
      actorUserId: "u_an",
    });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the marker workspaceId shadows a stale cli-config workspaceId", () => {
    const repo = path.join(tmp, "repo");
    writeMarker(repo, { workspaceId: "ws_marker" });

    const bash = bashResolve({ home, startDir: repo });

    // Hard cutover: the capture path POSTs under the MARKER id. A leftover
    // cli-config workspaceId must never reach WORKSPACE_ID.
    expect(bash.workspaceId).toBe("ws_marker");
    expect(bash.workspaceId).not.toBe("ws_stale_config");
  });

  it("a not-activated folder leaves WORKSPACE_ID empty (no cli-config fallback)", () => {
    const bare = path.join(tmp, "bare");
    fs.mkdirSync(bare, { recursive: true });

    const bash = bashResolve({ home, startDir: bare });

    // No marker => no workspace. The gate returns 1 and the capture hooks exit 0
    // before spooling; WORKSPACE_ID must be empty, never the stale cli-config id.
    expect(bash.activated).toBe(false);
    expect(bash.workspaceId).toBe("");
  });
});
