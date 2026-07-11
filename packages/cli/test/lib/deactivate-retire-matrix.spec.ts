import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { runDeactivate } from "../../src/commands/activate";
import type { WorkspaceCliConfig } from "../../src/lib/config";
import type {
  DeactivationPreflightResult,
  DeactivateWorkspaceResult,
} from "../../src/lib/control-workspace-lifecycle-client";

// Behavioral lock for the E2 ("retire the workspace") decision matrix of
// `mla deactivate` (notes/20260710-mla-workspace-deactivate-retired-state.md §3).
//
// `mla deactivate` has two independent effects: E1 unbinds this folder (local,
// always happens, covered by deactivate-marker.spec.ts) and E2 retires the whole
// workspace (backend, OWNER/ADMIN-gated). A preflight selects which prompt E2
// shows:
//   - member        -> E1-only; retire is NEVER offered.
//   - sole owner     -> ONE default-YES prompt covers retire + unbind.
//   - multi-member   -> E1 confirmed, retire is a SEPARATE default-NO opt-in.
//   - offline / already-retired / --keep-workspace / --marker -> E1-only.
//
// The whole point of the injectable DeactivateDeps seams is to pin this matrix
// with no network, no real config, and no TTY. We stage a real marker on disk so
// E1's unbind is exercised for real, and inject preflight/retire/confirm/isTTY.

const MARKER = ".meetless.json";
const WS = "ws_target";

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

const fakeCfg: WorkspaceCliConfig = {
  controlUrl: "http://127.0.0.1:1",
  controlToken: "t",
  mlaPath: "/bin/true",
  workspaceId: WS,
  auth: { mode: "shared-key", accessToken: "t" },
};

interface HarnessResult {
  code: number;
  logs: string[];
  retireCalled: boolean;
  preflightCalled: boolean;
  confirmCalls: { question: string; defaultYes: boolean }[];
}

// Run runDeactivate with injected E2 seams + an isolated cwd/home. `preflight`
// null means "make the preflight throw" (offline/not-a-member => E1-only branch).
async function runMatrix(opts: {
  home: string;
  cwd: string;
  argv: string[];
  preflight: DeactivationPreflightResult | null;
  retire?: DeactivateWorkspaceResult | Error;
  confirmReturns?: (question: string, defaultYes: boolean) => boolean;
  isTTY?: boolean;
}): Promise<HarnessResult> {
  const prevCwd = process.cwd();
  const logs: string[] = [];
  const push = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const outSpy = jest.spyOn(console, "log").mockImplementation(push);
  const errSpy = jest.spyOn(console, "error").mockImplementation(push);

  let retireCalled = false;
  let preflightCalled = false;
  const confirmCalls: { question: string; defaultYes: boolean }[] = [];

  try {
    process.chdir(opts.cwd);
    const code = await runDeactivate(opts.argv, {
      loadConfig: () => fakeCfg,
      preflight: async () => {
        preflightCalled = true;
        if (opts.preflight === null) throw new Error("preflight unreachable");
        return opts.preflight;
      },
      retire: async () => {
        retireCalled = true;
        if (opts.retire instanceof Error) throw opts.retire;
        return opts.retire ?? { workspaceId: WS, retiredAt: "2026-07-11T00:00:00.000Z" };
      },
      confirm: async (question: string, defaultYes: boolean) => {
        confirmCalls.push({ question, defaultYes });
        return opts.confirmReturns ? opts.confirmReturns(question, defaultYes) : true;
      },
      isTTY: () => opts.isTTY ?? true,
    });
    return { code, logs, retireCalled, preflightCalled, confirmCalls };
  } finally {
    process.chdir(prevCwd);
    errSpy.mockRestore();
    outSpy.mockRestore();
  }
}

describe("mla deactivate E2 retire matrix (design §3)", () => {
  let tmp: string;
  let home: string;
  let repo: string;
  let marker: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-retire-"));
    home = stageHome(tmp);
    repo = path.join(tmp, "repo");
    marker = writeMarker(repo, WS);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const active = (over: Partial<DeactivationPreflightResult> = {}): DeactivationPreflightResult => ({
    workspaceId: WS,
    callerRole: "OWNER",
    activeMemberCount: 1,
    retiredAt: null,
    ...over,
  });

  // ── member branch: retire NEVER offered ──────────────────

  it("member: unbinds the folder only, never retires the workspace", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: [],
      preflight: active({ callerRole: "MEMBER", activeMemberCount: 3 }),
    });
    expect(r.code).toBe(0);
    expect(r.retireCalled).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.logs.join("\n")).toContain("Only an owner/admin");
  });

  // ── sole owner: ONE default-YES prompt covers retire + unbind ──

  it("sole owner: prompts default-YES and retires + unbinds on accept", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: [],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 1 }),
    });
    expect(r.code).toBe(0);
    expect(r.retireCalled).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    // The combined prompt defaults to YES (the design's chosen behavior, not silence).
    expect(r.confirmCalls).toHaveLength(1);
    expect(r.confirmCalls[0].defaultYes).toBe(true);
  });

  it("sole owner: declining the default-YES prompt aborts BOTH retire and unbind", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: [],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 1 }),
      confirmReturns: () => false,
    });
    expect(r.code).toBe(0);
    expect(r.retireCalled).toBe(false);
    expect(fs.existsSync(marker)).toBe(true);
    expect(r.logs.join("\n")).toContain("Aborted");
  });

  it("sole owner: --yes retires + unbinds without prompting", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: ["--yes"],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 1 }),
    });
    expect(r.code).toBe(0);
    expect(r.retireCalled).toBe(true);
    expect(r.confirmCalls).toHaveLength(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("sole owner: a retire failure aborts cleanly with the folder still bound", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: ["--yes"],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 1 }),
      retire: new Error("role changed"),
    });
    expect(r.code).toBe(1);
    expect(r.retireCalled).toBe(true);
    // Retire runs BEFORE unbind, so its failure leaves E1 untouched.
    expect(fs.existsSync(marker)).toBe(true);
    expect(r.logs.join("\n")).toContain("still bound");
  });

  // ── multi-member: retire is a SEPARATE default-NO opt-in ──

  it("multi-member: --yes unbinds this folder only and does NOT retire for everyone", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: ["--yes"],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 3 }),
    });
    expect(r.code).toBe(0);
    expect(r.retireCalled).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.logs.join("\n")).toContain("other member(s)");
  });

  it("multi-member: --deactivate-workspace forces the retire for everyone", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: ["--yes", "--deactivate-workspace"],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 3 }),
    });
    expect(r.code).toBe(0);
    expect(r.retireCalled).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("multi-member: the retire opt-in prompt defaults to NO", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: [],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 3 }),
      // E1 confirm -> true (proceed); retire opt-in -> false (decline).
      confirmReturns: (q) => !/Also deactivate it for/i.test(q),
    });
    expect(r.code).toBe(0);
    expect(r.retireCalled).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    const optIn = r.confirmCalls.find((c) => /Also deactivate it for/i.test(c.question));
    expect(optIn).toBeDefined();
    expect(optIn!.defaultYes).toBe(false);
  });

  // ── E1-only fall-throughs ─────────────────────────────────

  it("offline: a failed preflight falls back to unbind-only", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: ["--yes"],
      preflight: null,
    });
    expect(r.code).toBe(0);
    expect(r.preflightCalled).toBe(true);
    expect(r.retireCalled).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.logs.join("\n")).toContain("Could not check the workspace");
  });

  it("already retired: unbinds only, no second retire call", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: ["--yes"],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 1, retiredAt: "2026-07-01T00:00:00.000Z" }),
    });
    expect(r.code).toBe(0);
    expect(r.retireCalled).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.logs.join("\n")).toContain("already deactivated");
  });

  it("--keep-workspace: skips E2 entirely (no preflight, no retire)", async () => {
    const r = await runMatrix({
      home,
      cwd: repo,
      argv: ["--yes", "--keep-workspace"],
      preflight: active({ callerRole: "OWNER", activeMemberCount: 1 }),
    });
    expect(r.code).toBe(0);
    expect(r.preflightCalled).toBe(false);
    expect(r.retireCalled).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(r.logs.join("\n")).toContain("--keep-workspace");
  });
});
