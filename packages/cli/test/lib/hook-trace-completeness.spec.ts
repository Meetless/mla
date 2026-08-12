import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

// EXACTLY ONE TERMINAL TRACE ROW PER HOOK INVOCATION.
//
// THE DEFECT THIS LOCKS DOWN. Session 5734f9de took 8 turns; ask-traces.jsonl held
// 6 rows. Turns 6 and 7 were absent. Read from the Claude Code transcript for that
// session, both were `<task-notification>` wake-ups, so both hit the documented
// `harness_event` early return in intercept_main and returned 0 without writing
// anything. It was NOT a writer failure and NOT a crash; it was a designed bypass
// that happened to be silent.
//
// Silent is the whole problem. A turn with no row is indistinguishable from a
// crash, a kill, a timeout before the writer, or mla simply not being installed --
// and "mla did not help on that turn" becomes unfalsifiable, which quietly
// invalidates every rate computed over the log. The muted path already understood
// this and wrote a `not_run` liveness line; the other four bypasses did not.
//
// The enumerated exit paths of user-prompt-submit.sh, and what each must produce:
//
//   outer   not activated .............. NO row (dormancy: an un-opted-in folder
//                                        must not write into ~/.meetless at all)
//   outer   unparseable stdin .......... NO row (no session id exists to key one)
//   outer   no session_id .............. NO row (same)
//   outer   muted ...................... not_run: muted            [pre-existing]
//   main    MEETLESS_SUPPRESS_ENRICH=1 . not_run: suppressed       [ADDED]
//   main    empty prompt ............... not_run: empty_prompt     [ADDED]
//   main    harness event .............. not_run: harness_event    [ADDED, turns 6/7]
//   main    pull_only control .......... enrich row (skipped)      [pre-existing]
//   main    delivery failed (exit 2) ... not_run: delivery_failed  [ADDED]
//   main    normal completion .......... enrich row               [pre-existing]
//   any     killed / crashed ........... not_run: cancelled        [ADDED, EXIT trap]
//
// Only external seam mocked is intel (an in-process HTTP stub). Everything else is
// the real hook, the real lock, and the real JSONL.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const HOOK = "user-prompt-submit.sh";

function requireTools(...tools: string[]): void {
  for (const t of tools) {
    if (spawnSync(t, ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error(`${t} required`);
  }
}

interface Stub {
  port: number;
  close: () => Promise<void>;
}

/** Minimal intel that always answers with a usable enrichment. */
async function startStub(): Promise<Stub> {
  const sockets = new Set<import("net").Socket>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          enrichment: { status: "ok", confidence: "low", markdown: "", context_items: [] },
          steps: [],
        }),
      );
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

interface Harness {
  tmp: string;
  home: string;
  workdir: string;
  hook: string;
}

function makeHarness(stubPort: number, opts: { activate?: boolean } = {}): Harness {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-trace-complete-"));
  for (const f of ["common.sh", "home.sh", HOOK]) {
    fs.copyFileSync(path.join(HOOKS_DIR, f), path.join(tmp, f));
  }
  fs.chmodSync(path.join(tmp, HOOK), 0o755);

  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, "queue"));
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl: `http://127.0.0.1:${stubPort}`,
      controlToken: "ik-test",
      workspaceId: "ws_test",
      mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/usr/bin/true",
    }),
  );

  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  if (opts.activate !== false) fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");

  return { tmp, home, workdir, hook: path.join(tmp, HOOK) };
}

async function fire(
  h: Harness,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
  kill?: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [h.hook], {
      cwd: h.workdir,
      env: { ...process.env, MEETLESS_HOME: h.home, MEETLESS_DEBUG: "0", ...env },
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    if (kill !== undefined) setTimeout(() => child.kill("SIGTERM"), kill);
  });
}

/**
 * Fire the hook and SIGTERM it the moment the capture spool appears, which is the
 * first observable proof that the EXIT trap is armed. Deterministic where a fixed
 * delay is not: bash startup + sourcing common.sh is tens of milliseconds on an
 * idle machine and hundreds under a full jest run.
 */
async function fireAndKillOnce(h: Harness, payload: Record<string, unknown>): Promise<void> {
  const spool = path.join(h.home, "queue", `${payload.session_id}.jsonl`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [h.hook], {
      cwd: h.workdir,
      env: { ...process.env, MEETLESS_HOME: h.home, MEETLESS_DEBUG: "0" },
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", () => {
      clearInterval(poll);
      resolve();
    });
    const poll = setInterval(() => {
      if (fs.existsSync(spool)) {
        clearInterval(poll);
        child.kill("SIGTERM");
      }
    }, 5);
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function traces(h: Harness): Array<Record<string, any>> {
  const p = path.join(h.home, "logs", "ask-traces.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function cleanup(h: Harness): void {
  fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

describe("user-prompt-submit.sh writes exactly one terminal trace per invocation", () => {
  let stub: Stub;
  beforeAll(async () => {
    requireTools("jq", "curl");
    stub = await startStub();
  });
  afterAll(async () => {
    await stub.close();
  });

  it("THE TURNS 6/7 DEFECT: a harness event produces a row, not a silent gap", async () => {
    const h = makeHarness(stub.port);
    try {
      // Verbatim shape of the two untraced turns of session 5734f9de.
      await fire(h, {
        session_id: "sess-harness",
        prompt:
          "<task-notification>\n<task-id>ba0t4swlh</task-id>\n<output-file>/tmp/x.txt</output-file>\n</task-notification>",
      });
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].mode).toBe("not_run");
      expect(rows[0].hook.not_run_reason).toBe("harness_event");
      expect(rows[0].hook.injected).toBe(false);
      // Joinable: the recap and `mla turn N` key on (session_id, turn_index).
      expect(rows[0].session_id).toBe("sess-harness");
      expect(rows[0].turn_index).toBe(1);
    } finally {
      cleanup(h);
    }
  }, 30000);

  it("a real prompt and a harness event in one session each get exactly one row", async () => {
    const h = makeHarness(stub.port);
    try {
      await fire(h, { session_id: "sess-mixed", prompt: "Fix the enrichment router." });
      await fire(h, { session_id: "sess-mixed", prompt: "<task-notification>\n<task-id>z</task-id>\n</task-notification>" });
      await fire(h, { session_id: "sess-mixed", prompt: "Fix the second thing." });
      const rows = traces(h);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.turn_index)).toEqual([1, 2, 3]);
      expect(rows.map((r) => r.mode)).toEqual(["enrich", "not_run", "enrich"]);
      // No turn index is ever reused or skipped, which is what makes a gap in the
      // log readable as a gap rather than as an off-by-one.
      expect(new Set(rows.map((r) => r.turn_index)).size).toBe(3);
    } finally {
      cleanup(h);
    }
  }, 40000);

  it("an internally suppressed turn produces a row", async () => {
    const h = makeHarness(stub.port);
    try {
      await fire(h, { session_id: "sess-supp", prompt: "Fix something." }, { MEETLESS_SUPPRESS_ENRICH: "1" });
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].hook.not_run_reason).toBe("suppressed");
    } finally {
      cleanup(h);
    }
  }, 30000);

  it("an empty prompt produces a row", async () => {
    const h = makeHarness(stub.port);
    try {
      await fire(h, { session_id: "sess-empty", prompt: "" });
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].hook.not_run_reason).toBe("empty_prompt");
    } finally {
      cleanup(h);
    }
  }, 30000);

  it("a muted session still produces exactly one row (and only one)", async () => {
    const h = makeHarness(stub.port);
    try {
      fs.mkdirSync(path.join(h.home, "session-gate"), { recursive: true });
      fs.writeFileSync(path.join(h.home, "session-gate", "sess-mute.off"), "");
      await fire(h, { session_id: "sess-mute", prompt: "Fix something." });
      const rows = traces(h);
      expect(rows).toHaveLength(1);
    } finally {
      cleanup(h);
    }
  }, 30000);

  it("the pull_only control still produces its enrich row", async () => {
    const h = makeHarness(stub.port);
    try {
      await fire(
        h,
        { session_id: "sess-pull", prompt: "Fix something." },
        { MEETLESS_INTERCEPT_STRATEGY: "pull_only" },
      );
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].mode).toBe("enrich");
      expect(rows[0].arbitration.reason).toBe("pull_only_control");
    } finally {
      cleanup(h);
    }
  }, 30000);

  it("a normal turn produces exactly one row, never two", async () => {
    const h = makeHarness(stub.port);
    try {
      await fire(h, { session_id: "sess-normal", prompt: "Fix the enrichment router." });
      const rows = traces(h);
      expect(rows).toHaveLength(1);
      expect(rows[0].mode).toBe("enrich");
      expect(rows[0].hook.not_run_reason ?? null).toBeNull();
    } finally {
      cleanup(h);
    }
  }, 30000);

  it("stays silent in a folder that was never activated (dormancy beats liveness)", async () => {
    const h = makeHarness(stub.port, { activate: false });
    try {
      await fire(h, { session_id: "sess-dormant", prompt: "Fix something." });
      // Deliberate: Meetless must not write into ~/.meetless for a folder the
      // operator never opted into. That absence is explained by the ABSENCE of a
      // marker, which is observable without a log line.
      expect(traces(h)).toHaveLength(0);
    } finally {
      cleanup(h);
    }
  }, 30000);

  it("a killed hook still leaves one terminal row", async () => {
    const h = makeHarness(stub.port);
    try {
      // SIGTERM mid-flight: without an EXIT-trap terminal write this is the crash
      // case that turns 6/7 were indistinguishable from.
      //
      // The kill is gated on the capture spool APPEARING rather than on a fixed
      // delay. The spool is written a few lines after the trap is armed, so its
      // existence proves the handler is installed; a bare `setTimeout(60)` raced
      // bash startup and killed the process before the trap on a loaded machine,
      // which made this test assert scheduler luck instead of the invariant.
      await fireAndKillOnce(h, { session_id: "sess-killed", prompt: "Fix the enrichment router." });
      expect(traces(h)).toHaveLength(1);
    } finally {
      cleanup(h);
    }
  }, 30000);
});
