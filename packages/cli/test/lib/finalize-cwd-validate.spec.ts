import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

// Folder = workspace (T1.1): finalize resolves the run's workspaceId by walking
// up from the resolved repo path to the nearest `.meetless.json` marker. A clean
// CI checkout has NO ambient up-tree marker (that only exists on a dogfooding
// box), so pointing MEETLESS_REPO_PATH / the sidecar at the monorepo root would
// throw NotActivatedError on CI. Build an ISOLATED git repo that carries its OWN
// marker instead, so BOTH the git evidence (a real `.git`) and the workspace
// resolution (its own marker) are self-contained and CI-hermetic. The marker may
// stay untracked: resolveWorkspaceId reads the filesystem, and
// `git rev-parse --show-toplevel` needs no commit.
function makeIsolatedMarkedRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-known-repo-"));
  fs.writeFileSync(
    path.join(repo, ".meetless.json"),
    JSON.stringify({ workspaceId: "ws_test", activatedAt: "2026-06-04T00:00:00.000Z" }),
  );
  execSync("git init -q", { cwd: repo });
  return repo;
}

// runInternalFinalize is loaded via resetModules+require (NOT a static import):
// config.ts freezes CFG_PATH/QUEUE_DIR from MEETLESS_HOME at module-load time. A
// static import freezes them to the real ~/.meetless BEFORE any beforeEach sets
// MEETLESS_HOME, so on a clean runner (no ~/.meetless/cli-config.json)
// readConfig() throws ConfigError. Requiring AFTER MEETLESS_HOME is set re-freezes
// them onto the test's tmpHome. (Block 2 already relied on this; both blocks now
// share the one loader.)
type RunInternalFinalize =
  typeof import("../../src/commands/internal-finalize").runInternalFinalize;
function loadRunInternalFinalize(): RunInternalFinalize {
  jest.resetModules();
  return (
    require("../../src/commands/internal-finalize") as typeof import("../../src/commands/internal-finalize")
  ).runInternalFinalize;
}

// Behavioral lock for Decision 7 (note 20260528 §11): `mla _internal
// finalize-session` ALWAYS POSTs finalize. Git is opportunistic corroboration,
// not the source of truth (that is the agent's text report -> agentClaimsRaw).
//
// History: Epoch 33 added a guard that REFUSED to POST when git evidence capture
// returned an empty topLevel (non-repo cwd), re-spooling finalize_requested. In a
// multi-repo parent layout (the session cwd is a non-repo parent holding many
// child repos) that re-spooled FOREVER and wedged the whole review loop, because
// a non-repo cwd is a legitimate setup, not a wrong-cwd retry to fix.
//
// Decision 7 reverses the guard:
//   - Real repo (via $MEETLESS_REPO_PATH preference, else process.cwd()): POST
//     the actuals (topLevel, branch, changed files, diff stat).
//   - Non-repo: POST the empty shell. captureGitEvidence returns
//     {topLevel: "", branch: "", errors: ["toplevel:..."], ...}; the populated
//     errors[] keeps the absence VISIBLE rather than silently dropped (preserving
//     Epoch 33's anti-silent-loss intent without the hard block). The worker
//     degrades gracefully on empty git.
//
// The env-var preference ($MEETLESS_REPO_PATH over process.cwd(), Epoch 35) is
// retained: it is how flush.sh feeds the real repo when nohup ran it from $HOME.

describe("`mla _internal finalize-session` always POSTs (Decision 7)", () => {
  const fetchOriginal = global.fetch;
  let tmpHome: string;
  let originalCwd: string;
  let originalRepoPathEnv: string | undefined;
  let originalHomeEnv: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mla-finalize-cwd-"));
    fs.writeFileSync(
      path.join(tmpHome, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        controlToken: "test-token",
        workspaceId: "ws_test",
        mlaPath: "/dev/null",
      }),
    );

    originalCwd = process.cwd();
    originalRepoPathEnv = process.env.MEETLESS_REPO_PATH;
    originalHomeEnv = process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_REPO_PATH;
    process.env.MEETLESS_HOME = tmpHome;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalRepoPathEnv === undefined) delete process.env.MEETLESS_REPO_PATH;
    else process.env.MEETLESS_REPO_PATH = originalRepoPathEnv;
    if (originalHomeEnv === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = originalHomeEnv;
    global.fetch = fetchOriginal;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("POSTs the empty-shell git evidence when cwd is non-repo AND MEETLESS_REPO_PATH unset", async () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-nonrepo-"));
    // Folder = workspace (T1.1): finalize resolves the run's workspaceId from the
    // nearest `.meetless.json` marker at/above the resolved repo path (here the
    // cwd, since env + sidecar are absent). A bound scratch dir that is NOT a git
    // repo is a coherent state: workspace resolves, git evidence stays empty.
    fs.writeFileSync(
      path.join(nonRepo, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_test", activatedAt: "2026-06-04T00:00:00.000Z" }),
    );
    let capturedBody: {
      gitEvidence: { topLevel: string; branch: string; errors: string[] };
    } | null = null;
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as typeof global.fetch;

    const okSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(nonRepo);
      const runInternalFinalize = loadRunInternalFinalize();
      const code = await runInternalFinalize(["test-session"]);
      // Decision 7: a non-repo cwd is a supported layout; finalize MUST proceed.
      expect(code).toBe(0);
      expect(capturedBody).not.toBeNull();
      const body = capturedBody as unknown as {
        gitEvidence: { topLevel: string; branch: string; errors: string[] };
      };
      // Empty shell forwarded, NOT dropped: topLevel empty, but errors[] makes
      // the git absence visible to the worker / Run Ledger.
      expect(body.gitEvidence.topLevel).toBe("");
      expect(body.gitEvidence.errors.length).toBeGreaterThan(0);
    } finally {
      okSpy.mockRestore();
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("honors MEETLESS_REPO_PATH over cwd and POSTs the env-var repo's git evidence", async () => {
    // Known-good target: an ISOLATED git repo carrying its own `.meetless.json`
    // marker, so both the git evidence and the workspace resolution are
    // self-contained (a clean CI checkout has no ambient up-tree marker).
    const knownRepo = makeIsolatedMarkedRepo();
    expect(fs.existsSync(path.join(knownRepo, ".git"))).toBe(true);

    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-nonrepo-"));
    let capturedBody: { gitEvidence: { topLevel: string; branch: string } } | null = null;
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => "",
      } as unknown as Response;
    }) as typeof global.fetch;

    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const okSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(nonRepo);
      process.env.MEETLESS_REPO_PATH = knownRepo;
      const runInternalFinalize = loadRunInternalFinalize();
      const code = await runInternalFinalize(["test-session"]);
      expect(code).toBe(0);
      expect(capturedBody).not.toBeNull();
      const body = capturedBody as unknown as {
        gitEvidence: { topLevel: string; branch: string };
      };
      // topLevel MUST be the env-var repo, NOT the non-repo cwd. This is the
      // exact bit the pre-Epoch-35 code got wrong.
      expect(body.gitEvidence.topLevel.length).toBeGreaterThan(0);
      expect(body.gitEvidence.topLevel).not.toBe(nonRepo);
      // git rev-parse --show-toplevel returns the canonical repo root; on
      // macOS /tmp resolves to /private/tmp, so we compare via realpath.
      expect(fs.realpathSync(body.gitEvidence.topLevel)).toBe(fs.realpathSync(knownRepo));
    } finally {
      errSpy.mockRestore();
      okSpy.mockRestore();
      fs.rmSync(nonRepo, { recursive: true, force: true });
      fs.rmSync(knownRepo, { recursive: true, force: true });
    }
  });

  // Drift guard: if a future refactor re-introduces the empty-topLevel refusal,
  // the multi-repo-parent wedge returns. These string-level assertions fail so
  // we never quietly regress to the blocking guard.
  it("internal-finalize.ts KEEPS the env-var preference AND has NO empty-topLevel block (drift guard)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/commands/internal-finalize.ts"),
      "utf8",
    );
    // Env-var preference (Epoch 35) retained.
    expect(src).toMatch(/process\.env\.MEETLESS_REPO_PATH/);
    // The Epoch 33 blocking guard (refuse + early non-zero return on empty
    // topLevel) must be gone.
    expect(src).not.toMatch(/if\s*\(!git\.topLevel\)\s*\{[\s\S]*?return\s+1/);
    expect(src).not.toMatch(/Refusing to finalize/);
    // The pre-Epoch-35 one-liner that just used process.cwd() unconditionally
    // must also stay gone.
    expect(src).not.toMatch(/^\s*const\s+repoPath\s*=\s*process\.cwd\(\);\s*$/m);
  });
});

// On-demand `mla review` (Phase 7 / PATCH 5 / INV-M6) fires
// triggerSessionFinalize WITHOUT flush.sh in front of it. The Stop-hook path
// gets MEETLESS_REPO_PATH exported by flush.sh from the <sid>.repoPath sidecar
// (flush.sh: `export MEETLESS_REPO_PATH="$(cat "$QUEUE_DIR/$SESSION_ID.repoPath")"`).
// On demand there is no such wrapper, so before this fix the finalize captured
// git evidence from whatever directory the human happened to type `mla review`
// in, and the rolling-snapshot finalize OVERWROTE the run with wrong-repo (or
// empty) evidence. Phase 7's whole premise is that a clean Stop never arrives,
// so this on-demand capture may be the ONLY git evidence the run ever gets.
//
// The repo-resolution ladder must therefore mirror flush.sh:
//   1. $MEETLESS_REPO_PATH env  (Stop-hook path; flush.sh exports it)
//   2. <sid>.repoPath sidecar   (on-demand path recovers the session's repo)
//   3. process.cwd()            (legacy fallback: pre-sidecar session)
//
// QUEUE_DIR is frozen at config.ts module-load from MEETLESS_HOME, so we set
// MEETLESS_HOME and then require the command (resetModules) -- matching
// review-on-demand-trigger.spec.ts / workspace-use.spec.ts.
describe("on-demand finalize recovers the repo from the <sid>.repoPath sidecar (Phase 7)", () => {
  const fetchOriginal = global.fetch;
  let tmpHome: string;
  let queueDir: string;
  let nonRepo: string;
  let knownRepo: string;
  let originalCwd: string;
  let originalRepoPathEnv: string | undefined;
  let originalHomeEnv: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mla-finalize-sidecar-"));
    queueDir = path.join(tmpHome, "queue");
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        controlToken: "test-token",
        workspaceId: "ws_test",
        mlaPath: "/dev/null",
      }),
    );
    nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-nonrepo-"));
    // Folder = workspace (T1.1): bind the scratch cwd so the cwd-fallback rung of
    // the finalize repo ladder still resolves a workspace. The sidecar / env tests
    // resolve repoPath to knownRepo (committed marker) instead, so this marker is
    // harmless to them; only "falls back to cwd" actually reads it.
    fs.writeFileSync(
      path.join(nonRepo, ".meetless.json"),
      JSON.stringify({ workspaceId: "ws_test", activatedAt: "2026-06-04T00:00:00.000Z" }),
    );

    // Known-good repo: an ISOLATED git repo carrying its own `.meetless.json`
    // marker. The sidecar / env tests point repoPath here, so both the git
    // evidence and the workspace resolution are self-contained and CI-hermetic
    // (a clean checkout has no ambient up-tree marker).
    knownRepo = makeIsolatedMarkedRepo();

    originalCwd = process.cwd();
    originalRepoPathEnv = process.env.MEETLESS_REPO_PATH;
    originalHomeEnv = process.env.MEETLESS_HOME;
    delete process.env.MEETLESS_REPO_PATH;
    process.env.MEETLESS_HOME = tmpHome;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalRepoPathEnv === undefined) delete process.env.MEETLESS_REPO_PATH;
    else process.env.MEETLESS_REPO_PATH = originalRepoPathEnv;
    if (originalHomeEnv === undefined) delete process.env.MEETLESS_HOME;
    else process.env.MEETLESS_HOME = originalHomeEnv;
    global.fetch = fetchOriginal;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(nonRepo, { recursive: true, force: true });
    fs.rmSync(knownRepo, { recursive: true, force: true });
  });

  it("reads the <sid>.repoPath sidecar to locate the repo, NOT the invocation cwd", async () => {
    const sid = "sess-sidecar";
    fs.writeFileSync(path.join(queueDir, `${sid}.repoPath`), knownRepo);

    let capturedBody: { gitEvidence: { topLevel: string } } | null = null;
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as typeof global.fetch;

    const okSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Human typed `mla review` from a non-repo directory; the sidecar must win.
      process.chdir(nonRepo);
      const runInternalFinalize = loadRunInternalFinalize();
      const code = await runInternalFinalize([sid]);
      expect(code).toBe(0);
      expect(capturedBody).not.toBeNull();
      const body = capturedBody as unknown as { gitEvidence: { topLevel: string } };
      // topLevel resolves to the SIDECAR repo, not the non-repo cwd.
      expect(body.gitEvidence.topLevel.length).toBeGreaterThan(0);
      expect(body.gitEvidence.topLevel).not.toBe(nonRepo);
      expect(fs.realpathSync(body.gitEvidence.topLevel)).toBe(
        fs.realpathSync(knownRepo),
      );
    } finally {
      okSpy.mockRestore();
    }
  });

  it("still falls back to cwd when no sidecar exists (legacy session, backward compat)", async () => {
    // No sidecar written for this session id.
    let capturedBody: { gitEvidence: { topLevel: string } } | null = null;
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as typeof global.fetch;

    const okSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(nonRepo);
      const runInternalFinalize = loadRunInternalFinalize();
      const code = await runInternalFinalize(["sess-no-sidecar"]);
      expect(code).toBe(0);
      const body = capturedBody as unknown as { gitEvidence: { topLevel: string } };
      // No sidecar => cwd (non-repo) => empty shell, exactly as before this fix.
      expect(body.gitEvidence.topLevel).toBe("");
    } finally {
      okSpy.mockRestore();
    }
  });

  it("MEETLESS_REPO_PATH env still wins over the sidecar (Stop-hook path unchanged)", async () => {
    const sid = "sess-env-over-sidecar";
    // Sidecar points at a non-repo; env points at the real repo. Env must win.
    fs.writeFileSync(path.join(queueDir, `${sid}.repoPath`), nonRepo);
    process.env.MEETLESS_REPO_PATH = knownRepo;

    let capturedBody: { gitEvidence: { topLevel: string } } | null = null;
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }) as typeof global.fetch;

    const okSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(nonRepo);
      const runInternalFinalize = loadRunInternalFinalize();
      const code = await runInternalFinalize([sid]);
      expect(code).toBe(0);
      const body = capturedBody as unknown as { gitEvidence: { topLevel: string } };
      expect(fs.realpathSync(body.gitEvidence.topLevel)).toBe(
        fs.realpathSync(knownRepo),
      );
    } finally {
      okSpy.mockRestore();
    }
  });

  // Drift guard: pin the three-rung resolution ladder so a refactor cannot
  // silently drop the sidecar rung and re-strand on-demand review on cwd.
  it("internal-finalize.ts resolves repo via env -> sidecar -> cwd (drift guard)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../src/commands/internal-finalize.ts"),
      "utf8",
    );
    expect(src).toMatch(/process\.env\.MEETLESS_REPO_PATH/);
    // The sidecar rung: a <sid>.repoPath read feeding the repoPath resolution.
    expect(src).toMatch(/\.repoPath/);
    expect(src).toMatch(/process\.cwd\(\)/);
  });
});
