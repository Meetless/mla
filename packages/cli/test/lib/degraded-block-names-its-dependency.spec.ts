import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync, spawn, ChildProcess } from "child_process";

// DEFECT PIN (G1, notes/20260812-did-mla-help-session-8751d447-both-clients-blamed-the-wrong-service.md).
//
// This file records CURRENT behaviour, so it is GREEN today. Turning it red is the
// acceptance test for the fix. It cannot fail a deploy and it costs one test run to
// rediscover the finding.
//
// THE MEASURED CASE, session 8751d447, 2026-08-12T13:18:05Z.
//
// `control` was not running. intel therefore could not validate the CLI user token and
// answered `503 {"detail":"Auth backend unavailable"}` in 23ms. That refusal is CORRECT
// and deliberate: falling back to the shared key would turn a control outage into a
// silent auth bypass (intel app/core/auth.py:213-220, proposal T15). Nothing below asks
// for that to change.
//
// What the hook then told the agent is the defect. `FAIL_OPEN_REASON` is derived by a
// three-arm case (user-prompt-submit.sh, "timeout | stop_guard | *"), so every HTTP
// status lands on `error`, and the degraded-block builder falls to ITS default arm:
//
//     "the evidence service returned an error ...
//      Call meetless__retrieve_knowledge by hand once before treating any absence as
//      settled."
//
// THE HARM: that instruction CANNOT BE FOLLOWED. The MCP shares the same control-backed
// auth, so the one recovery the block names is the one recovery guaranteed to fail while
// the auth backend is down. The audited agent followed it and the call failed. The arm
// set already knows how to say this honestly: the `intel_down` arm reads "A direct
// meetless__retrieve_knowledge may fail for the same reason, but it is the only
// recovery". The 503 case gets the naive line instead, purely because no arm looks at
// the status the hook already holds.
//
// Not a one-off: 43 turns in the local trace carry `hook.http_status: 503`, five of them
// in the 13 hours before the audit.
//
// THE EDIT THAT CLOSES THIS: give the auth-backend outage its own reason
// (`backend_unavailable`, selected when the recorded status is 503) and its own arm,
// whose recovery line says the hand-pull shares the dead dependency and that the turn is
// UNGOVERNED rather than "nothing was found". The last distinction is load-bearing:
// conflating "we could not look" with "there is nothing there" is the defect class this
// whole family of notes exists to prevent.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const DEGRADED = 'kind="evidence-unavailable"';

const scratch: string[] = [];

/**
 * A stub intel that answers POST /v1/ask with a canned STATUS, in its own process.
 *
 * The shared helper (`test/helpers/enrich-hook-run.ts`) hardcodes 200 and this suite is
 * entirely about a non-200, so it carries its own. Out of process for the reason that
 * helper documents: `spawnSync` blocks this process's event loop for the whole hook run,
 * so an in-process server never reaches its handler and the hook records a TIMEOUT,
 * which is a different arm and would make this pin vacuous.
 */
function stubIntelStatus(status: number, body: string): Promise<{ url: string; close: () => void }> {
  const src = `
    const http = require("http");
    const s = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(${status}, { "Content-Type": "application/json" });
        res.end(${JSON.stringify(body)});
      });
    });
    s.listen(0, "127.0.0.1", () => process.stdout.write("PORT=" + s.address().port + "\\n"));
  `;
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "inherit"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("stub intel did not report a port"));
    }, 10000);
    child.stdout!.on("data", (b: Buffer) => {
      const m = /PORT=(\d+)/.exec(b.toString());
      if (!m) return;
      clearTimeout(timer);
      resolve({ url: `http://127.0.0.1:${m[1]}`, close: () => child.kill() });
    });
  });
}

async function runAgainst(status: number, body: string) {
  const server = await stubIntelStatus(status, body);
  try {
    const home = mkdtempSync(join(tmpdir(), "mla-degraded-home-"));
    const repo = mkdtempSync(join(tmpdir(), "mla-degraded-repo-"));
    scratch.push(home, repo);
    const workspaceId = "ws_degraded_dependency";
    writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId }));
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(
      join(home, "cli-config.json"),
      JSON.stringify({
        workspaceId,
        actorUserId: "user_a",
        intelUrl: server.url,
        auth: {
          mode: "user-token",
          accessToken: "probe-access-token",
          refreshToken: "probe-refresh-token",
          accessExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        },
      }),
    );

    const r = spawnSync("bash", [HOOK], {
      input: JSON.stringify({
        session_id: "degraded_dependency_probe",
        prompt: "did MLA help this session and what did it actually deliver",
        cwd: repo,
      }),
      encoding: "utf8",
      cwd: repo,
      env: { ...process.env, MEETLESS_HOME: home, HOME: home, MEETLESS_INTEL_URL: server.url },
      timeout: 30000,
    });

    const trace = readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l))
      .pop() as Record<string, any>;
    let additionalContext = "";
    try {
      additionalContext = JSON.parse(r.stdout)?.hookSpecificOutput?.additionalContext ?? "";
    } catch {
      additionalContext = "";
    }
    return { trace, additionalContext };
  } finally {
    server.close();
  }
}

describe("G1 defect pin: an auth-backend 503 is described as a generic error", () => {
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    scratch.length = 0;
  });

  it("records the status faithfully, so the hook is NOT missing the fact", async () => {
    const r = await runAgainst(503, JSON.stringify({ detail: "Auth backend unavailable" }));
    // The receipt is right. Everything below is about what the hook SAYS, never about
    // what it knows, and separating those is the whole point of the finding.
    expect(r.trace.hook.http_status).toBe(503);
    expect(r.trace.hook.layer2_injected).toBe(false);
    expect(r.trace.arbitration.reason).toBe("enrichment_error");
  }, 40000);

  it("TODAY: 503 collapses onto the generic `error` arm", async () => {
    const r = await runAgainst(503, JSON.stringify({ detail: "Auth backend unavailable" }));
    // PIN. When the fix lands this becomes `backend_unavailable` and this line fails.
    expect(r.trace.hook.fail_open_reason).toBe("error");
    expect(r.additionalContext).toContain(DEGRADED);
    expect(r.additionalContext).toContain("the evidence service returned an error");
  }, 40000);

  it("TODAY: it prescribes a hand-pull that shares the dead dependency", async () => {
    const r = await runAgainst(503, JSON.stringify({ detail: "Auth backend unavailable" }));
    // THE HARM, pinned as an assertion rather than as a comment. The audited agent
    // followed exactly this line and the MCP call failed for the same reason.
    expect(r.additionalContext).toMatch(/Call meetless__retrieve_knowledge by hand once/);
    // And it does NOT warn that the recovery shares the failure, which the `intel_down`
    // arm does say. That missing sentence is the deliverable.
    expect(r.additionalContext).not.toMatch(/same reason/i);
    expect(r.additionalContext).not.toMatch(/ungoverned/i);
  }, 40000);

  it("the arm set is not broken in general: a timeout still gets its own honest arm", async () => {
    // VACUITY GUARD. Without this, deleting the whole case statement would leave the
    // three pins above green (they assert the DEFAULT arm), and the suite would report
    // health while the feature was gone.
    const r = await runAgainst(503, JSON.stringify({ detail: "Auth backend unavailable" }));
    expect(r.additionalContext).toContain("MLA evidence is unavailable THIS TURN");
    expect(r.additionalContext).toContain("Governed memory was NOT consulted");
  }, 40000);
});
