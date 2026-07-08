import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

// Behavioral lock for the per-session `turn_index` stamped on every enrichment
// trace line by user-prompt-submit.sh write_trace(). The field used to be a
// hardcoded `null`; it must be a dense, 1-based, monotonic integer WITHIN a
// session (turn 1, 2, 3...) and reset independently per session id. This is the
// ordering key that lets `mla summary` (and Langfuse) place a trace inside its
// session without parsing timestamps.
//
// Unlike intercept-hook.spec.ts (fresh HOME per run), these tests keep ONE HOME
// across several hook invocations so the counter can accumulate. The only
// external seam is the intel stub, per the project testing rules.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "user-prompt-submit.sh";

const CLS_INJECT_HIGH = { decision: "inject", confidence: "high", reason: "architecture_sensitive" };
function enrichOk(markdown: string) {
  return {
    enrichment: {
      strategy: "agentic_mission_structured",
      status: "ok",
      confidence: "high",
      markdown,
      latency_ms: 1234,
      cost_usd: 0.012,
      fields_present: ["constraints"],
      context_items: [],
    },
    steps: [],
  };
}

function startStub(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<import("net").Socket>();
  const server = http.createServer((req, res) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      const url = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.includes("/v1/intercept/classify")) res.end(JSON.stringify(CLS_INJECT_HIGH));
      else if (url.includes("/v1/ask")) res.end(JSON.stringify(enrichOk("## Retrieved LIVE memory candidates (not relevance-filtered); verify before using:\n- x")));
      else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => res());
          }),
      });
    });
  });
}

describe("user-prompt-submit.sh: per-session turn_index", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
    if (spawnSync("curl", ["--version"]).status !== 0) throw new Error("curl required");
  });

  it("stamps a dense monotonic integer per session, reset across sessions", async () => {
    const stub = await startStub();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-turnidx-"));
    try {
      fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
      fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
      fs.chmodSync(path.join(tmp, HOOK), 0o755);

      const home = path.join(tmp, "home");
      fs.mkdirSync(home);
      fs.writeFileSync(
        path.join(home, "cli-config.json"),
        JSON.stringify({
          controlUrl: "http://127.0.0.1:1",
          intelUrl: `http://127.0.0.1:${stub.port}`,
          controlToken: "ik-test",
          workspaceId: "ws_test",
          mlaPath: "/bin/true",
        }),
      );
      const workdir = path.join(tmp, "workdir");
      fs.mkdirSync(workdir);
      fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");

      const fire = (sessionId: string, prompt: string) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn("bash", [path.join(tmp, HOOK)], {
            cwd: workdir,
            env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
          });
          child.stdout.on("data", () => {});
          child.stderr.on("data", () => {});
          child.on("error", reject);
          child.on("close", () => resolve());
          child.stdin.write(JSON.stringify({ session_id: sessionId, prompt }));
          child.stdin.end();
        });

      // Two turns in session A, then one in session B. Serial, as Claude Code
      // fires UserPromptSubmit one prompt at a time per session.
      await fire("sess-A", "first A prompt");
      await fire("sess-A", "second A prompt");
      await fire("sess-B", "first B prompt");

      const raw = fs.readFileSync(path.join(home, "logs", "ask-traces.jsonl"), "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
      expect(lines.length).toBe(3);

      const a = lines.filter((l) => l.session_id === "sess-A").map((l) => l.turn_index);
      const b = lines.filter((l) => l.session_id === "sess-B").map((l) => l.turn_index);

      // Dense, 1-based, monotonic within a session.
      expect(a).toEqual([1, 2]);
      // Reset independently per session.
      expect(b).toEqual([1]);
      // Never null, always an integer.
      for (const l of lines) {
        expect(typeof l.turn_index).toBe("number");
        expect(Number.isInteger(l.turn_index)).toBe(true);
      }
    } finally {
      await stub.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
});
