import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync, spawn, ChildProcess } from "child_process";

// REGRESSION PIN (G1, notes/20260812-did-mla-help-session-8751d447-both-clients-blamed-the-wrong-service.md).
//
// This started as a defect pin recording CURRENT (broken) behaviour. It now asserts the
// SHIPPED, CORRECTED behaviour (An review §1) and finishes GREEN. Turning THESE
// assertions red is a real regression.
//
// THE MEASURED CASE, session 8751d447, 2026-08-12T13:18:05Z.
//
// `control` was not running. intel therefore could not validate the CLI user token and
// answered `503 {"detail":"Auth backend unavailable"}` in 23ms. That refusal is CORRECT
// and deliberate: falling back to the shared key would turn a control outage into a
// silent auth bypass (intel app/core/auth.py:213-220, proposal T15). Nothing here asks
// for that to change.
//
// What the hook told the agent was the defect. `FAIL_OPEN_REASON` is derived by a case
// (user-prompt-submit.sh, "timeout | stop_guard | *"), so every HTTP status landed on
// `error`, and the degraded-block builder fell to ITS default arm:
//
//     "the evidence service returned an error ...
//      Call meetless__retrieve_knowledge by hand once before treating any absence as
//      settled."
//
// THE HARM: that instruction could NOT be followed. The MCP shares the same
// control-backed auth, so the one recovery the block named is the one recovery
// guaranteed to fail while the auth backend is down. The audited agent followed it and
// the call failed.
//
// Not a one-off: 43 turns in the local trace carry `hook.http_status: 503`, five of them
// in the 13 hours before the audit.
//
// THE FIX THAT SHIPPED (An review §1, NOT the proposal's original draft):
//   - The generic error arm consults the status the hook already holds
//     ($ENRICH_HTTP_STATUS). On an HTTP error status (4xx/5xx) it REPORTS THE STATUS
//     ("the retrieval request failed (HTTP 503)") and stops.
//   - It does NOT invent an auth diagnosis: a 503 does not prove the auth dependency is
//     down; it can be any 5xx, a proxy, a gateway.
//   - It does NOT prescribe an unconditional hand-pull, because the MCP shares this
//     backend and is no more likely to survive a server-side failure.
//   - It does NOT call the turn "ungoverned" (Layer 1 operated) and names no port.
//   - It adds NO new FAIL_OPEN_REASON enum: the arbitration reason stays
//     `enrichment_error`, so no emitted vocabulary grew for a wording fix.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const DEGRADED = 'kind="evidence-unavailable"';

// The always-present static grounding block lists meetless__retrieve_knowledge as a
// tool, so a whole-context grep for that name is meaningless. Scope recovery-prose
// assertions to the degraded block itself.
function degradedBlock(additionalContext: string): string {
  const m = /<meetless-context kind="evidence-unavailable"[\s\S]*?<\/meetless-context>/.exec(
    additionalContext,
  );
  return m ? m[0] : "";
}

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

describe("G1: an auth-backend 503 reports its status and prescribes no shared-dependency recovery", () => {
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
    // No new enum: the arbitration reason stays enrichment_error (fail_open_reason
    // "error"). The wording fix rides on $ENRICH_HTTP_STATUS, not on a new reason.
    expect(r.trace.hook.fail_open_reason).toBe("error");
    expect(r.trace.arbitration.reason).toBe("enrichment_error");
  }, 40000);

  it("reports the HTTP status and does NOT invent an auth diagnosis", async () => {
    const r = await runAgainst(503, JSON.stringify({ detail: "Auth backend unavailable" }));
    expect(r.additionalContext).toContain(DEGRADED);
    const block = degradedBlock(r.additionalContext);
    // Reports the status the hook already holds ...
    expect(block).toMatch(/HTTP 503/);
    // ... and drops the old generic "returned an error" line for a status-bearing failure.
    expect(block).not.toContain("the evidence service returned an error");
    // Invents no diagnosis: a 503 does not prove WHICH dependency is down. No claim about
    // the auth backend, no laptop-specific port, and it does not echo intel's body.
    expect(block).not.toMatch(/auth (backend|dependency)/i);
    expect(block).not.toMatch(/3006/);
    expect(block).not.toMatch(/ungoverned/i);
    expect(block).not.toContain("Auth backend unavailable");
  }, 40000);

  it("does NOT prescribe a hand-pull that shares the dead dependency", async () => {
    const r = await runAgainst(503, JSON.stringify({ detail: "Auth backend unavailable" }));
    // THE HARM, closed. The audited agent followed exactly the removed line and the MCP
    // call failed for the same reason; on a server-side status the degraded block now
    // names no meetless__retrieve_knowledge recovery at all. Scoped to the block, because
    // the static grounding block always lists the tool.
    const block = degradedBlock(r.additionalContext);
    expect(block).not.toBe("");
    expect(block).not.toMatch(/Call meetless__retrieve_knowledge by hand/i);
    expect(block).not.toMatch(/retrieve_knowledge/i);
  }, 40000);

  it("is status-driven, not 503-hardcoded: a 500 reports HTTP 500 the same way", async () => {
    // Guards against a fix that special-cased the one measured status. Any HTTP error
    // status the hook received is reported, and none of them prescribe the shared-backend
    // hand-pull.
    const r = await runAgainst(500, JSON.stringify({ detail: "boom" }));
    expect(r.additionalContext).toContain(DEGRADED);
    expect(r.additionalContext).toMatch(/HTTP 500/);
    expect(r.additionalContext).not.toMatch(/Call meetless__retrieve_knowledge by hand/i);
  }, 40000);

  it("the arm set is not broken in general: the degraded block still frames absence honestly", async () => {
    // VACUITY GUARD (retained per An review §4). Without this, deleting the whole case
    // statement would leave the pins above green (they assert absence of strings), and
    // the suite would report health while the feature was gone.
    const r = await runAgainst(503, JSON.stringify({ detail: "Auth backend unavailable" }));
    expect(r.additionalContext).toContain("MLA evidence is unavailable THIS TURN");
    expect(r.additionalContext).toContain("Governed memory was NOT consulted");
    // And the "absence is unknown, not settled" framing (the review's "missing evidence
    // does not mean governed memory contains nothing") survives.
    expect(r.additionalContext).toMatch(/an absence here is unknown, not settled/);
  }, 40000);
});
