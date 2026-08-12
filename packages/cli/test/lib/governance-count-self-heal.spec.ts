import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// THE CIRCULARITY. The governance nudge's job is to prompt a human to review the
// relationship-candidate queue. It reads its count from a local cache. That cache
// is written by exactly one thing: a human running `mla kb review`. So the signal
// whose purpose is to cause reviewing is a function of the reviewing it is supposed
// to cause, and the moment nobody reviews, it goes quiet and stays quiet.
//
// Measured, three times, on the same machine:
//   2026-08-04  171h stale against a 24h TTL
//   2026-08-07  the cache last refreshed 2026-08-07T04:29:43Z, read 32h later
//   2026-08-08  all four turns of session a9192083: stale_pending_count_cache
//
// 13ed49e0d fixed the block TEXT (an unavailable count now says so, with its age).
// That made the silence VISIBLE. It could not make it END: nothing in the system
// refreshes the number without a human typing the command the number exists to
// prompt.
//
// THE FIX IS NOT A NEW MECHANISM. `mla kb review --all` already computes the
// workspace count and already writes the cache (kb_pending.ts onWorkspaceCount ->
// writePendingCountCache). The hook already has a detached-spawn idiom used by five
// other background jobs (spawn_flush / spawn_reap / spawn_auto_index /
// spawn_reconcile / spawn_evidence_*). This wires the one to the other: when the
// count is unreadable for a reason a refresh can repair, fire that existing command
// detached, throttled, and never on the hot path.
//
// NO NEW SCHEDULER, NO NEW DAEMON, NO NEW CACHE, NO NEW FLAG. The throttle reuses
// MEETLESS_GOVERNANCE_BLOCK_TTL_S and the whole lane is still gated by the existing
// MEETLESS_GOVERNANCE_HINT kill switch.
//
// These drive the REAL hook, with a fake `mla` that records its own argv, so what is
// asserted is the command the hook actually spawns.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_1";
const PROMPT = "add a retry to the fetch function";

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Run the hook in a sandbox whose configured `mla` is a shell script that appends
 * its argv to a log. The spawn is detached (`nohup ... &`), so the log is polled
 * briefly rather than read once.
 */
function runHook(opts: {
  session: string;
  cache?: string;
  env?: Record<string, string>;
  home?: string;
}): { home: string; calls: string[]; governance: Record<string, unknown> } {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "mlheal-home-"));
  const repo = mkdtempSync(join(tmpdir(), "mlheal-repo-"));
  writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
  mkdirSync(join(home, "logs", "governance"), { recursive: true });

  const callLog = join(home, "mla-calls.log");
  const fakeMla = join(home, "fake-mla");
  writeFileSync(fakeMla, `#!/bin/sh\necho "$@" >> "${callLog}"\n`);
  chmodSync(fakeMla, 0o755);

  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({
      workspaceId: WORKSPACE_ID,
      actorUserId: "user_a",
      intelUrl: "http://127.0.0.1:8100",
      mlaPath: fakeMla,
    }),
  );
  if (opts.cache !== undefined) {
    writeFileSync(join(home, "logs", "governance", `pending-count-${WORKSPACE_ID}.json`), opts.cache);
  }

  spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: opts.session, prompt: PROMPT, cwd: repo }),
    encoding: "utf8",
    cwd: repo,
    env: { ...process.env, MEETLESS_HOME: home, HOME: home, ...(opts.env ?? {}) },
    timeout: 15000,
  });

  // The refresh is detached on purpose (it must never sit on the prompt path), so
  // give it a moment to land. Polled rather than slept flat so a fast machine is
  // not punished for being fast.
  const deadline = Date.now() + 4000;
  let calls: string[] = [];
  while (Date.now() < deadline) {
    calls = existsSync(callLog)
      ? readFileSync(callLog, "utf8").split("\n").filter((l) => l.trim().length > 0)
      : [];
    if (calls.some((c) => c.includes("kb review"))) break;
    spawnSync("sleep", ["0.1"]);
  }

  const lines = readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  return { home, calls, governance: lines[lines.length - 1].governance };
}

const refreshCalls = (calls: string[]) => calls.filter((c) => c.includes("kb review"));

describe("governance count: the nudge stops depending on the reviewing it exists to prompt", () => {
  it("a stale cache fires ONE detached refresh, the same command a human would run", () => {
    const { calls, governance } = runHook({
      session: "11111111-1111-4111-8111-111111111111",
      // The live dogfood shape: a real count, long past the TTL.
      cache: JSON.stringify({ count: 7, ts: nowSec() - 200_000 }),
    });
    expect(governance.silent_reason).toBe("stale_pending_count_cache");
    expect(refreshCalls(calls)).toHaveLength(1);
    // --all, because the cache is the WORKSPACE count; a session-scoped listing
    // would write a subset and kb_pending.ts correctly refuses to cache one.
    expect(refreshCalls(calls)[0]).toContain("--all");
  });

  it("no cache at all fires the refresh too: a workspace nobody has reviewed is the common case", () => {
    const { calls, governance } = runHook({ session: "22222222-2222-4222-8222-222222222222" });
    expect(governance.silent_reason).toBe("no_pending_count_cache");
    expect(refreshCalls(calls)).toHaveLength(1);
  });

  it("a malformed cache fires the refresh, because overwriting it is exactly the repair", () => {
    const { calls, governance } = runHook({
      session: "33333333-3333-4333-8333-333333333333",
      cache: "{not json",
    });
    expect(governance.silent_reason).toBe("malformed_pending_count_cache");
    expect(refreshCalls(calls)).toHaveLength(1);
  });

  it("a FRESH cache fires nothing: there is nothing to repair", () => {
    const { calls, governance } = runHook({
      session: "44444444-4444-4444-8444-444444444444",
      cache: JSON.stringify({ count: 0, ts: nowSec() }),
    });
    expect(governance.silent_reason).toBeNull();
    expect(refreshCalls(calls)).toHaveLength(0);
  });

  it("the kill switch silences the refresh too: 'not now' is not a fault to repair", () => {
    const { calls, governance } = runHook({
      session: "55555555-5555-4555-8555-555555555555",
      cache: JSON.stringify({ count: 7, ts: nowSec() - 200_000 }),
      env: { MEETLESS_GOVERNANCE_HINT: "0" },
    });
    expect(governance.silent_reason).toBe("disabled");
    expect(refreshCalls(calls)).toHaveLength(0);
  });

  it("the throttle holds across turns, so a stale workspace does not spawn once per prompt", () => {
    const first = runHook({
      session: "66666666-6666-4666-8666-666666666666",
      cache: JSON.stringify({ count: 7, ts: nowSec() - 200_000 }),
    });
    expect(refreshCalls(first.calls)).toHaveLength(1);

    // Same sandbox, second turn, cache still stale (the detached refresh is a fake
    // `mla` that writes no cache). Without a throttle this fires again, and would
    // keep firing on every prompt of every session forever.
    const second = runHook({
      session: "66666666-6666-4666-8666-666666666666",
      home: first.home,
      cache: JSON.stringify({ count: 7, ts: nowSec() - 200_000 }),
    });
    expect(refreshCalls(second.calls)).toHaveLength(1);
  });

  it("the throttle is WORKSPACE-scoped, not session-scoped: a new session must not re-arm it", () => {
    const first = runHook({
      session: "77777777-7777-4777-8777-777777777777",
      cache: JSON.stringify({ count: 7, ts: nowSec() - 200_000 }),
    });
    expect(refreshCalls(first.calls)).toHaveLength(1);
    const second = runHook({
      session: "88888888-8888-4888-8888-888888888888",
      home: first.home,
      cache: JSON.stringify({ count: 7, ts: nowSec() - 200_000 }),
    });
    expect(refreshCalls(second.calls)).toHaveLength(1);
  });

  it("the refresh never blocks the prompt: the hook returns while the command is still running", () => {
    // Measured as a DELTA against a control, not against an absolute budget. The
    // hook's own baseline in a sandbox is seconds (it reaches a control and an intel
    // that are not there and waits out their timeouts), so an absolute assertion
    // here would be measuring the sandbox, not the spawn.
    const timeHook = (opts: { stale: boolean; sleepSeconds: number }): number => {
      const home = mkdtempSync(join(tmpdir(), "mlheal-home-"));
      const repo = mkdtempSync(join(tmpdir(), "mlheal-repo-"));
      writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
      mkdirSync(join(home, "logs", "governance"), { recursive: true });
      const slowMla = join(home, "slow-mla");
      writeFileSync(slowMla, `#!/bin/sh\nsleep ${opts.sleepSeconds}\n`);
      chmodSync(slowMla, 0o755);
      writeFileSync(
        join(home, "cli-config.json"),
        JSON.stringify({ workspaceId: WORKSPACE_ID, actorUserId: "user_a", mlaPath: slowMla }),
      );
      writeFileSync(
        join(home, "logs", "governance", `pending-count-${WORKSPACE_ID}.json`),
        JSON.stringify({ count: 7, ts: opts.stale ? nowSec() - 200_000 : nowSec() }),
      );
      const started = Date.now();
      const r = spawnSync("bash", [HOOK], {
        input: JSON.stringify({ session_id: "99999999-9999-4999-8999-999999999999", prompt: PROMPT, cwd: repo }),
        encoding: "utf8",
        cwd: repo,
        env: { ...process.env, MEETLESS_HOME: home, HOME: home },
        timeout: 40000,
      });
      expect(r.status).toBe(0);
      return Date.now() - started;
    };

    const control = timeHook({ stale: false, sleepSeconds: 8 }); // fresh cache: no spawn at all
    const treatment = timeHook({ stale: true, sleepSeconds: 8 }); // stale cache: spawns `sleep 8`
    // If the spawn were synchronous the delta would be >= 8000ms.
    expect(treatment - control).toBeLessThan(4000);
  }, 120000);
});
