import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for `mla deactivate` = workspace-binding removal (folder =
// workspace, T2.2, notes/20260604-folder-equals-workspace-binding-design.md).
//
// `deactivate` no longer writes a per-session sentinel (that is `mla mute` now).
// It REMOVES the nearest `.meetless.json` binding. Because nearest-wins supports
// monorepos, the removal is guarded:
//   - confirm before deleting (INV-DEACTIVATE-1); `--yes` skips the prompt.
//     In a non-interactive context (no TTY) it refuses without `--yes` rather
//     than hang.
//   - nested-dir safety: when the nearest marker lives in an ANCESTOR of cwd,
//     a plain run refuses (it would unbind the whole subtree). The user opts in
//     with `--from-root` (remove the resolved ancestor) or `--marker <path>`
//     (target a specific marker).

const MARKER = ".meetless.json";

function stageHome(tmp: string): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({ controlUrl: "http://127.0.0.1:1", controlToken: "t", mlaPath: "/bin/true" }),
  );
  return home;
}

function writeMarker(dir: string, workspaceId: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, MARKER);
  fs.writeFileSync(p, JSON.stringify({ workspaceId }, null, 2) + "\n");
  return p;
}

// Run runDeactivate in-process with an isolated MEETLESS_HOME + cwd. Under jest
// process.stdin.isTTY is undefined (non-interactive), so a run without `--yes`
// takes the refuse-don't-hang path; `--yes` exercises the removal path.
async function runDeactivateIn(opts: {
  home: string;
  cwd: string;
  argv?: string[];
}): Promise<{ code: number; logs: string[] }> {
  const prevCwd = process.cwd();
  const prevHome = process.env.MEETLESS_HOME;
  const logs: string[] = [];
  const push = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  const outSpy = jest.spyOn(console, "log").mockImplementation(push);
  const errSpy = jest.spyOn(console, "error").mockImplementation(push);
  try {
    process.env.MEETLESS_HOME = opts.home;
    process.chdir(opts.cwd);
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../../src/commands/activate");
    const code = (await mod.runDeactivate(opts.argv ?? [])) as number;
    return { code, logs };
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = prevHome;
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
}

describe("mla deactivate (workspace-binding removal, T2.2)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-deact2-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("removes the marker at cwd with --yes", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    const marker = writeMarker(repo, "ws_local");

    const r = await runDeactivateIn({ home, cwd: repo, argv: ["--yes"] });

    expect(r.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.logs.join("\n")).toContain("Removed");
  });

  it("does not touch the session gate (no <sid>.off written)", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    writeMarker(repo, "ws_local");

    const r = await runDeactivateIn({ home, cwd: repo, argv: ["--yes"] });

    expect(r.code).toBe(0);
    const gate = path.join(home, "session-gate");
    const files = fs.existsSync(gate) ? fs.readdirSync(gate) : [];
    expect(files).toEqual([]);
  });

  it("refuses (exit 1) without --yes in a non-interactive context; marker survives", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    const marker = writeMarker(repo, "ws_local");

    const r = await runDeactivateIn({ home, cwd: repo, argv: [] });

    expect(r.code).toBe(1);
    expect(fs.existsSync(marker)).toBe(true);
    expect(r.logs.join("\n")).toContain("--yes");
  });

  it("points the operator at `mla mute` in the confirm explanation", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    writeMarker(repo, "ws_local");

    const r = await runDeactivateIn({ home, cwd: repo, argv: [] });

    // Even on the refuse path the binding-removal explanation is shown.
    expect(r.logs.join("\n")).toContain("mla mute");
  });

  it("reports nothing to do (exit 1) when no marker resolves", async () => {
    const home = stageHome(tmp);
    const empty = path.join(tmp, "nowhere");
    fs.mkdirSync(empty);

    const r = await runDeactivateIn({ home, cwd: empty, argv: ["--yes"] });

    expect(r.code).toBe(1);
    expect(r.logs.join("\n").toLowerCase()).toContain("nothing to deactivate");
  });

  it("nested-dir safety: refuses to delete an ANCESTOR marker from a subdir without --from-root", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    const marker = writeMarker(repo, "ws_root");
    const sub = path.join(repo, "apps", "svc");
    fs.mkdirSync(sub, { recursive: true });

    // Even with --yes (which only bypasses the y/N prompt), the locality guard
    // holds: the ancestor marker is not removed without an explicit opt-in.
    const r = await runDeactivateIn({ home, cwd: sub, argv: ["--yes"] });

    expect(r.code).toBe(1);
    expect(fs.existsSync(marker)).toBe(true);
    expect(r.logs.join("\n")).toContain("--from-root");
  });

  it("removes the ancestor marker from a subdir with --from-root --yes", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    const marker = writeMarker(repo, "ws_root");
    const sub = path.join(repo, "apps", "svc");
    fs.mkdirSync(sub, { recursive: true });

    const r = await runDeactivateIn({ home, cwd: sub, argv: ["--from-root", "--yes"] });

    expect(r.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("targets an explicit marker with --marker <path> --yes", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    const marker = writeMarker(repo, "ws_root");
    const sub = path.join(repo, "apps", "svc");
    fs.mkdirSync(sub, { recursive: true });

    const r = await runDeactivateIn({ home, cwd: sub, argv: ["--marker", marker, "--yes"] });

    expect(r.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("errors (exit 1) when --marker points at a non-existent marker", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);

    const r = await runDeactivateIn({
      home,
      cwd: repo,
      argv: ["--marker", path.join(repo, MARKER), "--yes"],
    });

    expect(r.code).toBe(1);
    expect(r.logs.join("\n").toLowerCase()).toContain("no marker");
  });

  it("rejects --marker combined with --from-root (exit 2)", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    writeMarker(repo, "ws_root");

    const r = await runDeactivateIn({
      home,
      cwd: repo,
      argv: ["--marker", path.join(repo, MARKER), "--from-root", "--yes"],
    });

    expect(r.code).toBe(2);
    expect(r.logs.join("\n")).toContain("cannot be combined");
  });

  it("rejects unexpected arguments (exit 2)", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    writeMarker(repo, "ws_root");

    const r = await runDeactivateIn({ home, cwd: repo, argv: ["--force"] });

    expect(r.code).toBe(2);
    expect(r.logs.join("\n")).toContain("Unknown argument");
  });

  it("notes a still-governing parent marker after removing the nearer one", async () => {
    const home = stageHome(tmp);
    const repo = path.join(tmp, "repo");
    writeMarker(repo, "ws_root");
    const sub = path.join(repo, "apps", "svc");
    const subMarker = writeMarker(sub, "ws_sub");

    const r = await runDeactivateIn({ home, cwd: sub, argv: ["--yes"] });

    expect(r.code).toBe(0);
    expect(fs.existsSync(subMarker)).toBe(false);
    // The repo-root marker still governs the subtree; deactivate says so.
    expect(r.logs.join("\n")).toContain("ws_root");
  });
});
