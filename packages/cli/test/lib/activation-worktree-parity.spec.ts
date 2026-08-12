import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { findActivation } from "../../src/lib/activation";

// TS <-> bash resolver parity for D1 worktree inheritance.
//
// `meetless_activated` (hooks-template/common.sh) and `findActivation`
// (lib/activation.ts) are two implementations of ONE rule. The hooks decide
// what gets captured with the bash one; every CLI command decides with the TS
// one. If they disagree about which workspace owns a directory, capture lands
// in one workspace while the command that reads it looks in another, and the
// disagreement is invisible from either side.
//
// So this asks BOTH resolvers the same question about the same real
// `git worktree add` on disk, and compares the answers.

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "seed.txt"), "x\n", "utf8");
  git(dir, ["add", "seed.txt"]);
  git(dir, ["commit", "-qm", "seed"]);
}

/** What the bash gate resolves for `dir`: the workspace id and the via stamp. */
function bashResolve(dir: string): { ok: boolean; workspaceId: string; via: string } {
  const script = `
    set -u
    MEETLESS_HOME_DIR="\${MEETLESS_HOME_DIR:-$HOME/.meetless}"
    SESSION_GATE_DIR="$MEETLESS_HOME_DIR/session-gate"
    QUEUE_DIR="$MEETLESS_HOME_DIR/queue"
    source ${JSON.stringify(COMMON_SH)} >/dev/null 2>&1 || true
    if meetless_activated ${JSON.stringify(dir)}; then
      printf 'ok\\t%s\\t%s\\n' "$WORKSPACE_ID" "\${MEETLESS_MARKER_VIA:-}"
    else
      printf 'no\\t\\t\\n'
    fi
  `;
  const out = execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
  const line = out.split("\n").pop() ?? "";
  const [status, workspaceId = "", via = ""] = line.split("\t");
  return { ok: status === "ok", workspaceId, via };
}

function assertParity(dir: string): { workspaceId?: string; via?: string } {
  const ts = findActivation(dir);
  const sh = bashResolve(dir);
  expect(sh.ok).toBe(ts !== null);
  expect(sh.workspaceId).toBe(ts?.workspaceId ?? "");
  expect(sh.via).toBe(ts?.via ?? "");
  return { workspaceId: ts?.workspaceId, via: ts?.via };
}

describe("worktree inheritance: the TS and bash resolvers agree", () => {
  let base: string;
  let main: string;
  let wt: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "mla-parity-"));
    main = join(base, "main");
    wt = join(base, "wt");
    initRepo(main);
    git(main, ["worktree", "add", "-q", "--detach", wt, "HEAD"]);
    expect(statSync(join(wt, ".git")).isFile()).toBe(true);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  const bind = (dir: string, id: string) =>
    writeFileSync(join(dir, ".meetless.json"), JSON.stringify({ workspaceId: id }), "utf8");

  it("agrees on an inherited binding from the worktree root", () => {
    bind(main, "ws-origin");
    expect(assertParity(wt)).toEqual({ workspaceId: "ws-origin", via: "worktree" });
  });

  it("agrees from a nested dir inside the worktree", () => {
    bind(main, "ws-origin");
    const nested = join(wt, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(assertParity(nested)).toEqual({ workspaceId: "ws-origin", via: "worktree" });
  });

  it("agrees that a worktree-local marker wins", () => {
    bind(main, "ws-origin");
    bind(wt, "ws-local");
    expect(assertParity(wt)).toEqual({ workspaceId: "ws-local", via: undefined });
  });

  it("agrees that an unbound origin stays unbound", () => {
    assertParity(wt);
    expect(findActivation(wt)).toBeNull();
  });

  it("agrees on the ordinary activated checkout (no via stamp)", () => {
    bind(main, "ws-origin");
    expect(assertParity(main)).toEqual({ workspaceId: "ws-origin", via: undefined });
  });

  it("agrees that unprovable worktree metadata stays unbound", () => {
    bind(main, "ws-origin");
    writeFileSync(join(wt, ".git"), `gitdir: ${join(base, "nope")}\n`, "utf8");
    assertParity(wt);
    expect(findActivation(wt)).toBeNull();
  });

  it("agrees on a relative gitdir pointer", () => {
    bind(main, "ws-origin");
    writeFileSync(join(wt, ".git"), "gitdir: ../main/.git/worktrees/wt\n", "utf8");
    expect(assertParity(wt)).toEqual({ workspaceId: "ws-origin", via: "worktree" });
  });

  it("agrees that a plain unbound directory is unbound", () => {
    const loose = join(base, "loose");
    mkdirSync(loose, { recursive: true });
    assertParity(loose);
  });
});
