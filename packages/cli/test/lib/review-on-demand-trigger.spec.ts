import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { bindWorkspaceMarker } from "./workspace-marker.helper";

// runReview is loaded via require() AFTER MEETLESS_HOME is redirected to the
// per-test tmp home. config.ts freezes HOME/CFG_PATH/QUEUE_DIR at module-load
// from process.env.MEETLESS_HOME, so a static top-level import would bind the
// real ~/.meetless config (wrong workspaceId, real queue dir). jest.resetModules
// + require picks up the test home, matching workspace-use.spec.ts.
type RunReview = typeof import("../../src/commands/review").runReview;
function loadRunReview(): RunReview {
  jest.resetModules();
  return (require("../../src/commands/review") as typeof import("../../src/commands/review"))
    .runReview;
}

// Phase 7 behavioral lock: the on-demand `mla review` trigger
// (notes/20260604-mla-mission-and-review-packet-rethink.md, PATCH 5 / INV-M6).
//
// Before this change, `mla review` was a PASSIVE poller: the by-session review
// packet only existed if the Claude Code Stop hook had already fired
// `mla _internal finalize-session` (-> AGENT_RUN_FINALIZED -> the worker builds
// the packet). Run `mla review` mid-session, before any Stop, and there is no
// packet, so the poll loop spins to the 60s timeout. Synthesis was gated on a
// session-end signal that, in practice, never cleanly arrives ("I don't even
// know when I will stop using this session").
//
// INV-M6 promotes the on-demand path to a hard acceptance criterion: review
// must be producible by AT LEAST ONE non-Stop trigger, and the floor is an
// explicit `mla review`. So `mla review` now FIRES the finalize itself (the same
// POST /internal/v1/agent-runs/by-session/<sid>/finalize that the Stop-hook path
// invokes) before polling. The Stop-hook finalize stays as one trigger among
// several; it is no longer the sole producer.
//
// The trigger is:
//   - non-Stop: it does not require a session_stopped / finalize_requested spool
//     event; `mla review` is itself the trigger.
//   - missionless (PR1): the finalize body carries no mission / missionId.
//   - branch-agnostic (INV-M1): a run with branch = null (here: a non-repo
//     MEETLESS_REPO_PATH, so captureGitEvidence yields an empty `branch`) is a
//     first-class reviewed run; the trigger fires regardless.
//   - best-effort: a finalize failure (e.g. 404 because no run is attached yet)
//     is non-fatal; the poll loop surfaces a missing packet, exactly as it did
//     when Stop was the only trigger.

const READY_PACKET = {
  id: "pkt_ondemand",
  workspaceId: "ws_test",
  runId: "run_ondemand",
  status: "ready",
  synthesisStatus: "ready",
  synthesisCompletedAt: null,
  facts: null,
  bashEvents: [],
  missingEvidence: [],
  agentClaimsRaw: null,
  summary: null,
  agentClaimsParsed: null,
  verification: null,
  risks: null,
  intelTraceId: null,
  intelTraceError: null,
  warnings: [],
};

interface CapturedCall {
  method: string;
  url: string;
  body: string | null;
}

describe("`mla review` fires an on-demand finalize trigger (PATCH 5 / INV-M6)", () => {
  const fetchOriginal = global.fetch;
  let tmpHome: string;
  let nonRepo: string;
  let originalRepoPathEnv: string | undefined;
  let originalHomeEnv: string | undefined;
  let originalSessionEnv: string | undefined;
  let restoreCwd: () => void;
  let calls: CapturedCall[];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mla-review-ondemand-"));
    fs.writeFileSync(
      path.join(tmpHome, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        controlToken: "test-token",
        consoleUrl: "http://127.0.0.1:3000",
        mlaPath: "/dev/null",
      }),
    );
    // Folder = workspace (T1.1): the finalize body's workspaceId now comes from
    // the nearest `.meetless.json` marker, not cli-config. Bind ws_test at the
    // tmp home and run from inside it so any cwd-based resolution is coherent.
    restoreCwd = bindWorkspaceMarker(tmpHome, "ws_test");
    // A non-repo path => captureGitEvidence returns an empty-shell evidence with
    // branch = "" (the branch-null case). This proves the trigger fires for a
    // first-class run that has no branch (INV-M1).
    nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-nonrepo-"));
    // triggerSessionFinalize resolves the run's workspace from the SESSION REPO
    // PATH (MEETLESS_REPO_PATH below), not cwd, because flush.sh is nohup-spawned
    // from $HOME so cwd is never the repo. The marker must therefore live at the
    // resolved repo path. A marker in a non-git dir is coherent: workspace
    // binding is independent of git-repo-ness, so git evidence still yields the
    // empty branch this test asserts.
    fs.writeFileSync(
      path.join(nonRepo, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_test", activatedAt: "2026-06-04T00:00:00.000Z" }),
    );

    originalRepoPathEnv = process.env.MEETLESS_REPO_PATH;
    originalHomeEnv = process.env.MEETLESS_HOME;
    originalSessionEnv = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.MEETLESS_HOME = tmpHome;
    process.env.MEETLESS_REPO_PATH = nonRepo;
    calls = [];
  });

  afterEach(() => {
    restoreCwd();
    if (originalRepoPathEnv === undefined) delete process.env.MEETLESS_REPO_PATH;
    else process.env.MEETLESS_REPO_PATH = originalRepoPathEnv;
    if (originalHomeEnv === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = originalHomeEnv;
    if (originalSessionEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = originalSessionEnv;
    global.fetch = fetchOriginal;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(nonRepo, { recursive: true, force: true });
  });

  // Route by URL: finalize POST is captured + 200; the packet GET returns a
  // terminal ready packet so the poll loop exits on the first iteration (no real
  // 60s wait). Any other call (defensive) returns 200 empty.
  function installRouter(opts: { finalizeThrows?: boolean } = {}): void {
    global.fetch = (async (url: unknown, init: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      calls.push({ method, url: u, body: init?.body ?? null });
      if (u.includes("/finalize")) {
        if (opts.finalizeThrows) throw new Error("ECONNRESET");
        return { ok: true, status: 200, text: async () => "" } as unknown as Response;
      }
      if (u.includes("/review-packets/by-session/")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(READY_PACKET),
        } as unknown as Response;
      }
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as typeof global.fetch;
  }

  it("POSTs by-session finalize BEFORE polling, missionless, with an empty (null) branch", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sess-ondemand";
    installRouter();
    const runReview = loadRunReview();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    let code: number;
    try {
      // --no-flush isolates the trigger from the spool-drain machinery. The
      // trigger is UNCONDITIONAL: it fires even when flush is skipped, because
      // INV-M6 makes "mla review on demand" the producing floor, not a
      // flush side effect.
      code = await runReview(["--no-flush"]);
    } finally {
      logSpy.mockRestore();
    }
    expect(code).toBe(0);

    const finalizeIdx = calls.findIndex((c) => c.url.includes("/finalize"));
    const pollIdx = calls.findIndex((c) => c.url.includes("/review-packets/by-session/"));

    // The on-demand finalize trigger fired at all (the non-Stop trigger).
    expect(finalizeIdx).toBeGreaterThanOrEqual(0);
    // ...and it fired BEFORE the first packet poll (trigger -> then poll).
    expect(pollIdx).toBeGreaterThanOrEqual(0);
    expect(finalizeIdx).toBeLessThan(pollIdx);

    const finalize = calls[finalizeIdx];
    expect(finalize.method).toBe("POST");
    // Exact by-session finalize route, session id propagated.
    expect(finalize.url).toContain(
      "/internal/v1/agent-runs/by-session/sess-ondemand/finalize",
    );

    const body = JSON.parse(finalize.body as string);
    expect(body.workspaceId).toBe("ws_test");
    expect(body.gitEvidence).toBeDefined();
    // Branch-null case (INV-M1): a non-repo checkout yields an empty branch and
    // the trigger still fires.
    expect(body.gitEvidence.branch).toBe("");
    // Missionless (PR1): no mission anywhere in the trigger payload.
    expect((finalize.body as string).toLowerCase()).not.toContain("mission");
  });

  it("does NOT fire a finalize trigger when CLAUDE_CODE_SESSION_ID is unset (current-session-only lock)", async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    installRouter();
    const runReview = loadRunReview();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    let code: number;
    try {
      code = await runReview([]);
    } finally {
      logSpy.mockRestore();
    }
    // No session to attribute the review to: print console URLs and exit 0, the
    // locked outcome. Crucially, fire NO trigger -- the on-demand trigger is
    // scoped to the session you are running inside, never workspace-wide.
    expect(code).toBe(0);
    expect(calls.find((c) => c.url.includes("/finalize"))).toBeUndefined();
    expect(calls.find((c) => c.url.includes("/review-packets/by-session/"))).toBeUndefined();
  });

  it("is best-effort: a finalize trigger failure is non-fatal and the review still renders", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "sess-ondemand";
    installRouter({ finalizeThrows: true });
    const runReview = loadRunReview();
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    let code: number;
    try {
      // The finalize POST throws (e.g. no run attached yet -> 404, or a transient
      // network error). runReview must NOT crash; it swallows the trigger error
      // and falls through to the poll, which here finds a ready packet.
      code = await runReview(["--no-flush"]);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(code).toBe(0);
    // The trigger was attempted (and threw), then the poll ran anyway.
    expect(calls.find((c) => c.url.includes("/finalize"))).toBeDefined();
    expect(calls.find((c) => c.url.includes("/review-packets/by-session/"))).toBeDefined();
  });
});

// Drift guards: pin the wiring at the source level so a future refactor cannot
// silently revert `mla review` to a passive poller (which would re-gate review
// on the unreliable Stop signal) or reintroduce a mission into the trigger.
describe("on-demand review trigger wiring (drift guards)", () => {
  it("review.ts wires the on-demand finalize trigger and stays missionless", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/commands/review.ts"),
      "utf8",
    );
    // The trigger is imported from the shared finalize core and invoked.
    expect(src).toMatch(/triggerSessionFinalize/);
    expect(src).toMatch(/from\s+["']\.\/internal-finalize["']/);
    // The removed durable-intent field does not reappear in the review command
    // (PR1). We pin the code token `missionId`, not the bare substring "mission":
    // the latter false-matches English ("emission") and the plan-doc filename
    // (`...mla-mission-and-review...`) that this file legitimately cites.
    expect(src).not.toMatch(/missionId/i);
  });

  it("internal-finalize.ts exposes a reusable trigger that runInternalFinalize delegates to", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/commands/internal-finalize.ts"),
      "utf8",
    );
    // The finalize core is extracted and exported for reuse by `mla review`.
    expect(src).toMatch(/export\s+async\s+function\s+triggerSessionFinalize/);
    // runInternalFinalize delegates to it rather than re-implementing the POST.
    expect(src).toMatch(/runInternalFinalize[\s\S]*?triggerSessionFinalize\(/);
    // The env-var repo preference (Epoch 35) survives the extraction.
    expect(src).toMatch(/process\.env\.MEETLESS_REPO_PATH/);
    // The removed durable-intent field does not reappear in the finalize core
    // (PR1). Pin the code token `missionId`, not the bare substring "mission"
    // (which false-matches the plan-doc filename this file cites for traceability).
    expect(src).not.toMatch(/missionId/i);
  });
});
