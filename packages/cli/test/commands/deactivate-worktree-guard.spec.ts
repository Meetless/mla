import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runDeactivate } from "../../src/commands/activate";

// D1 follow-on hazard. Worktree inheritance means `findActivation` inside a
// linked worktree now resolves a marker in a DIFFERENT checkout. `mla
// deactivate` deletes the marker it resolves, and its existing locality guard
// is worded for the monorepo case ("in a parent directory") with `--from-root`
// as the opt-in. Neither is true here: the origin checkout is not an ancestor
// of the worktree, and unbinding it would unbind the origin plus every other
// worktree of that repository, from a directory that never carried a marker.
//
// So the worktree case must refuse, and `--from-root` must NOT override it.

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

describe("mla deactivate: a linked worktree cannot unbind its origin checkout", () => {
  let base: string;
  let main: string;
  let wt: string;
  let prevCwd: string;
  let errs: string[];
  let errSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    prevCwd = process.cwd();
    base = mkdtempSync(join(tmpdir(), "mla-deact-wt-"));
    main = join(base, "main");
    wt = join(base, "wt");
    mkdirSync(main, { recursive: true });
    git(main, ["init", "-q", "."]);
    git(main, ["config", "user.email", "t@t.t"]);
    git(main, ["config", "user.name", "t"]);
    writeFileSync(join(main, "seed.txt"), "x\n", "utf8");
    git(main, ["add", "seed.txt"]);
    git(main, ["commit", "-qm", "seed"]);
    git(main, ["worktree", "add", "-q", "--detach", wt, "HEAD"]);
    expect(statSync(join(wt, ".git")).isFile()).toBe(true);
    writeFileSync(
      join(main, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws-origin" }),
      "utf8",
    );
    errs = [];
    errSpy = jest.spyOn(console, "error").mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(wt);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    errSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("refuses, and leaves the origin marker on disk", async () => {
    const code = await runDeactivate(["--yes"]);
    expect(code).toBe(1);
    expect(existsSync(join(main, ".meetless.json"))).toBe(true);
    expect(errs.join("\n")).toContain("linked worktree has no binding of its own");
  });

  it("still refuses under --from-root, which is for an ANCESTOR marker", async () => {
    const code = await runDeactivate(["--yes", "--from-root"]);
    expect(code).toBe(1);
    expect(existsSync(join(main, ".meetless.json"))).toBe(true);
    expect(errs.join("\n")).toContain("origin checkout");
  });

  it("names the explicit escape hatch rather than dead-ending", async () => {
    await runDeactivate(["--yes"]);
    const text = errs.join("\n");
    expect(text).toContain("--marker");
    expect(text).toContain(join(main, ".meetless.json"));
  });

  it("prints no em dash or double dash (writing-style guard)", async () => {
    await runDeactivate(["--yes"]);
    const text = errs.join("\n");
    expect(text).not.toContain("—");
    expect(text.replace(/`--[a-z-]+/g, "").replace(/\B--[a-z-]+/g, "")).not.toContain("--");
  });

  it("a worktree with its OWN marker deactivates normally (nearest-wins)", async () => {
    writeFileSync(join(wt, ".meetless.json"), JSON.stringify({ workspaceId: "ws-local" }), "utf8");
    const code = await runDeactivate(["--yes", "--keep-workspace"]);
    expect(code).toBe(0);
    // Its own binding is gone; the origin's is untouched.
    expect(existsSync(join(wt, ".meetless.json"))).toBe(false);
    expect(existsSync(join(main, ".meetless.json"))).toBe(true);
  });
});
