import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Behavioral lock for Wedge v6 Epoch 35: repoPath sidecar wiring.
//
// flush.sh is `nohup`-spawned by hooks, so its cwd is whatever nohup ran in
// (often $HOME) -- not the repo. session-start.sh writes
// $QUEUE_DIR/$SESSION_ID.repoPath with the SessionStart $CWD; flush.sh reads the
// sidecar and exports MEETLESS_REPO_PATH before invoking the CLI, so the CLI's
// env-var preference resolves to the real repo rather than $HOME.
//
// This sidecar is what makes git corroboration land on the right repo when it is
// available. Under Decision 7 (note 20260528 §11) git is opportunistic, not
// required: a missing or non-repo path no longer blocks finalize (the CLI POSTs
// the empty shell). The sidecar still matters because, when the session DID run
// in a single repo, it points the CLI at that repo so the actuals are captured.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const SESSION_START = path.join(HOOKS_DIR, "session-start.sh");
const FLUSH = path.join(HOOKS_DIR, "flush.sh");
const COMMON = path.join(HOOKS_DIR, "common.sh");

function stageHooksDir(tmp: string): string {
  const stage = path.join(tmp, "hooks");
  fs.mkdirSync(stage, { recursive: true });
  fs.copyFileSync(COMMON, path.join(stage, "common.sh"));
  fs.copyFileSync(SESSION_START, path.join(stage, "session-start.sh"));
  fs.copyFileSync(FLUSH, path.join(stage, "flush.sh"));
  // event-batch-filter.jq is read by flush.sh Pass 2. Copy it through so
  // the missing-filter Epoch 32 path doesn't accidentally trigger.
  const filter = path.join(HOOKS_DIR, "event-batch-filter.jq");
  if (fs.existsSync(filter)) {
    fs.copyFileSync(filter, path.join(stage, "event-batch-filter.jq"));
  }
  fs.chmodSync(path.join(stage, "session-start.sh"), 0o755);
  fs.chmodSync(path.join(stage, "flush.sh"), 0o755);
  return stage;
}

function makeMeetlessHome(tmp: string, mlaPath: string, workspaceId = "ws_test"): string {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "test-token",
      workspaceId,
      mlaPath,
    }),
  );
  return home;
}

describe("repoPath sidecar (Wedge v6 Epoch 35)", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run repo-path-sidecar specs");
    }
  });

  it("session-start.sh writes the sidecar with $CWD on a valid stdin", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-sidecar-ss-"));
    try {
      const stage = stageHooksDir(tmp);
      // session-start.sh ends by DETACHING two children (spawn_flush's nohup'd
      // flush.sh, and spawn_reconcile). They outlive spawnSync and keep writing
      // under $MEETLESS_HOME, so they race this test's rmSync teardown -- which
      // is how it fails: ENOTEMPTY on a loaded CI box, and in principle a real
      // flake, since the detached flusher also mutates the queue dir we assert
      // on. Neuter both, the same way spawn-flush-workspace-reassert.spec.ts
      // does: an inert flush.sh, MEETLESS_DEBUG=0 so the nohup redirect lands on
      // /dev/null instead of a fresh log file inside the tree, and the reconcile
      // kill switch. This spec owns the sidecar WRITE; the spawns themselves are
      // locked by session-reconcile-spawn.spec.ts, so nothing is lost here.
      fs.writeFileSync(path.join(stage, "flush.sh"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });
      const home = makeMeetlessHome(tmp, "/bin/true");
      const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-sidecar-repo-"));
      // Per-folder activation gate (opt-in): session-start.sh exits 0 before
      // spooling unless a .meetless.json marker is found by walking up from
      // $PWD. Activate the fake repo so the sidecar path under test is reached.
      fs.writeFileSync(path.join(fakeRepo, ".meetless.json"), "{}\n");
      try {
        const r = spawnSync("bash", [path.join(stage, "session-start.sh")], {
          input: JSON.stringify({
            session_id: "sess-abc",
            transcript_path: "/tmp/ignored.json",
          }),
          encoding: "utf8",
          cwd: fakeRepo,
          env: {
            ...process.env,
            MEETLESS_HOME: home,
            MEETLESS_DEBUG: "0",
            MEETLESS_SESSION_RECONCILE: "0",
          },
        });
        expect(r.status).toBe(0);

        const sidecar = path.join(home, "queue", "sess-abc.repoPath");
        expect(fs.existsSync(sidecar)).toBe(true);
        // macOS /var -> /private/var; bash's $PWD canonicalizes the path
        // even though we passed a /var-prefixed cwd. Compare via realpath
        // so the sidecar contract is "a valid path that resolves to the
        // repo we cd'd into", not byte-equality with our passed-in string.
        const written = fs.readFileSync(sidecar, "utf8");
        expect(written.length).toBeGreaterThan(0);
        expect(fs.realpathSync(written)).toBe(fs.realpathSync(fakeRepo));
      } finally {
        fs.rmSync(fakeRepo, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("session-start.sh does NOT write the sidecar on empty stdin (no session id)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-sidecar-empty-"));
    try {
      const stage = stageHooksDir(tmp);
      const home = makeMeetlessHome(tmp, "/bin/true");
      const r = spawnSync("bash", [path.join(stage, "session-start.sh")], {
        input: "",
        encoding: "utf8",
        env: { ...process.env, MEETLESS_HOME: home },
      });
      expect(r.status).toBe(0);

      const queueDir = path.join(home, "queue");
      const files = fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : [];
      const sidecars = files.filter((f) => f.endsWith(".repoPath"));
      expect(sidecars).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flush.sh exports MEETLESS_REPO_PATH from the sidecar before invoking mla finalize", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-sidecar-flush-"));
    try {
      const stage = stageHooksDir(tmp);
      // Fake `mla` script that records MEETLESS_REPO_PATH so we can assert
      // flush.sh exported it BEFORE invoking us. Exit 0 = "finalize OK"
      // so flush.sh takes the finalize-OK branch.
      const envCaptureFile = path.join(tmp, "captured-env.txt");
      const mlaPath = path.join(tmp, "fake-mla.sh");
      fs.writeFileSync(
        mlaPath,
        `#!/usr/bin/env bash
printf '%s\\n' "MEETLESS_REPO_PATH=\${MEETLESS_REPO_PATH:-<unset>}" > "${envCaptureFile}"
printf '%s\\n' "argv=$*" >> "${envCaptureFile}"
exit 0
`,
        { mode: 0o755 },
      );

      const home = makeMeetlessHome(tmp, mlaPath);
      const queueDir = path.join(home, "queue");
      fs.mkdirSync(queueDir, { recursive: true });

      const sessionId = "sess-flush-1";
      const sidecarPath = path.join(queueDir, `${sessionId}.repoPath`);
      const repoPath = "/home/dev/some-real-repo";
      fs.writeFileSync(sidecarPath, repoPath);
      // T1.2 cutover: flush sources workspaceId from the .workspaceId sidecar,
      // not cli-config. Stage it so the batch clears the empty-workspace guard.
      fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");

      // Queue file must contain a finalize_requested line so HAS_FINALIZE=1
      // and flush.sh actually reaches the finalize branch. Pass 2 needs a
      // valid event to keep EVENTS_OK=1. session_stopped is the simplest.
      const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
      const stopped = {
        ts: "2026-05-27T00:00:00Z",
        event: "session_stopped",
        eventKey: "ek1",
        sessionId,
        payload: { finalMessage: "done" },
      };
      const finalize = {
        ts: "2026-05-27T00:00:01Z",
        event: "finalize_requested",
        eventKey: "ek2",
        sessionId,
        payload: {},
      };
      fs.writeFileSync(
        queueFile,
        JSON.stringify(stopped) + "\n" + JSON.stringify(finalize) + "\n",
      );

      // Need a control endpoint that 200s the events PATCH so EVENTS_OK
      // stays 1 and Pass 3 takes the finalize-fire branch. We swap the
      // controlUrl to a tiny node http server. Simpler: re-write the
      // config to point at a bash-served 200 via netcat? Cleanest: stub
      // curl by prepending a shim to PATH.
      const binDir = path.join(tmp, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const curlShim = path.join(binDir, "curl");
      fs.writeFileSync(
        curlShim,
        `#!/usr/bin/env bash
exit 0
`,
        { mode: 0o755 },
      );

      const r = spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
        encoding: "utf8",
        env: {
          ...process.env,
          MEETLESS_HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });
      expect(r.status).toBe(0);

      expect(fs.existsSync(envCaptureFile)).toBe(true);
      const captured = fs.readFileSync(envCaptureFile, "utf8");
      expect(captured).toContain(`MEETLESS_REPO_PATH=${repoPath}`);
      expect(captured).toContain(`argv=_internal finalize-session ${sessionId}`);

      // Sidecar SURVIVES a successful finalize. Claude Code has no session-end
      // hook, so stop.sh finalizes at the end of EVERY turn; a later turn still
      // needs this repoPath to export MEETLESS_REPO_PATH for its own finalize.
      // Reaping it here (the old behavior) stranded later-turn finalize; teardown
      // is the 24h idle reaper's job. (prod session 11436b5c, 2026-07-04)
      expect(fs.existsSync(sidecarPath)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flush.sh tolerates a missing sidecar (does NOT export MEETLESS_REPO_PATH, lets CLI handle)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-sidecar-missing-"));
    try {
      const stage = stageHooksDir(tmp);
      const envCaptureFile = path.join(tmp, "captured-env.txt");
      const mlaPath = path.join(tmp, "fake-mla.sh");
      fs.writeFileSync(
        mlaPath,
        `#!/usr/bin/env bash
printf '%s\\n' "MEETLESS_REPO_PATH=\${MEETLESS_REPO_PATH:-<unset>}" > "${envCaptureFile}"
exit 0
`,
        { mode: 0o755 },
      );
      const home = makeMeetlessHome(tmp, mlaPath);
      const queueDir = path.join(home, "queue");
      fs.mkdirSync(queueDir, { recursive: true });

      const sessionId = "sess-no-sidecar";
      // No repoPath sidecar written; queue has finalize_requested. The
      // .workspaceId sidecar IS present (T1.2 cutover requirement) -- this test
      // is about a missing repoPath sidecar, not a missing workspace.
      fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");
      const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        queueFile,
        JSON.stringify({
          ts: "2026-05-27T00:00:01Z",
          event: "finalize_requested",
          eventKey: "fk1",
          sessionId,
          payload: {},
        }) + "\n",
      );

      const binDir = path.join(tmp, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, "curl"),
        `#!/usr/bin/env bash
exit 0
`,
        { mode: 0o755 },
      );

      // Strip MEETLESS_REPO_PATH from the env so a host-side definition
      // can't accidentally fake a green.
      const env = { ...process.env, MEETLESS_HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` };
      delete (env as Record<string, string | undefined>).MEETLESS_REPO_PATH;

      const r = spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
        encoding: "utf8",
        env,
      });
      expect(r.status).toBe(0);
      expect(fs.existsSync(envCaptureFile)).toBe(true);
      const captured = fs.readFileSync(envCaptureFile, "utf8");
      expect(captured).toContain("MEETLESS_REPO_PATH=<unset>");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flush.sh leaves the sidecar in place when finalize FAILS (so next retry can use it)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-sidecar-fail-"));
    try {
      const stage = stageHooksDir(tmp);
      const mlaPath = path.join(tmp, "fake-mla.sh");
      // Non-zero exit simulates any CLI finalize failure (e.g. the control POST
      // erroring out). flush.sh must re-spool finalize_requested AND preserve the
      // sidecar so the next flush can still export the env.
      fs.writeFileSync(
        mlaPath,
        `#!/usr/bin/env bash
exit 1
`,
        { mode: 0o755 },
      );
      const home = makeMeetlessHome(tmp, mlaPath);
      const queueDir = path.join(home, "queue");
      fs.mkdirSync(queueDir, { recursive: true });

      const sessionId = "sess-finalize-fail";
      const sidecarPath = path.join(queueDir, `${sessionId}.repoPath`);
      const repoPath = "/home/dev/some-real-repo";
      fs.writeFileSync(sidecarPath, repoPath);
      // T1.2 cutover: workspaceId comes from the .workspaceId sidecar.
      fs.writeFileSync(path.join(queueDir, `${sessionId}.workspaceId`), "ws_test");

      const queueFile = path.join(queueDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        queueFile,
        JSON.stringify({
          ts: "2026-05-27T00:00:01Z",
          event: "finalize_requested",
          eventKey: "fk1",
          sessionId,
          payload: {},
        }) + "\n",
      );

      const binDir = path.join(tmp, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, "curl"),
        `#!/usr/bin/env bash
exit 0
`,
        { mode: 0o755 },
      );

      const r = spawnSync("bash", [path.join(stage, "flush.sh"), sessionId], {
        encoding: "utf8",
        env: {
          ...process.env,
          MEETLESS_HOME: home,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });
      expect(r.status).toBe(0);
      // Sidecar must survive a failed finalize so the next retry path
      // can still use it.
      expect(fs.existsSync(sidecarPath)).toBe(true);
      expect(fs.readFileSync(sidecarPath, "utf8")).toBe(repoPath);

      // Re-spool should have written a fresh finalize_requested line.
      expect(fs.existsSync(queueFile)).toBe(true);
      const lines = fs
        .readFileSync(queueFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      const respooled = lines.filter((l) => l.includes('"event":"finalize_requested"'));
      expect(respooled.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Drift guards: if a future refactor drops the sidecar write or read,
  // the silent-loss / stuck-loss return. These string-level assertions
  // fail so we never quietly regress.
  it("session-start.sh KEEPS the repoPath sidecar write (drift guard)", () => {
    const src = fs.readFileSync(SESSION_START, "utf8");
    expect(src).toMatch(/printf '%s' "\$CWD" > "\$QUEUE_DIR\/\$SESSION_ID\.repoPath"/);
  });

  it("flush.sh KEEPS the sidecar read + MEETLESS_REPO_PATH export (drift guard)", () => {
    const src = fs.readFileSync(FLUSH, "utf8");
    expect(src).toMatch(/REPO_SIDECAR="\$QUEUE_DIR\/\$SESSION_ID\.repoPath"/);
    expect(src).toMatch(/export MEETLESS_REPO_PATH="\$\(cat "\$REPO_SIDECAR"\)"/);
  });
});
