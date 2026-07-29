import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// The A-0c governance nudge (surface 2) declines to fire far more often than it
// fires, and until now every one of those declines wrote the same thing into the
// trace: `governance: null`. Measured over 3977 real dogfood rows, the block was
// present on 932 and null on 3045, and that null could not distinguish "the
// operator muted it" from "no pending-count cache was ever written" from "the
// cache is corrupt" from "the cache decayed past its TTL".
//
// The live condition on the dogfood machine turned out to be the last of those,
// and it is datable to the minute: the count cache holds {"count":0,"ts":
// 1783301418} (2026-07-06T01:30:18Z), the TTL defaults to 86400s, so it expired
// at 2026-07-07T01:30:18Z, and the last trace row carrying any governance block
// at all is 2026-07-07T01:24:22Z. Six minutes inside the boundary. The surface
// did not break; it decayed on schedule and then stayed dark for three weeks
// writing the same null a muted session writes.
//
// These drive the REAL src/hooks-template/user-prompt-submit.sh, the same way the
// harness drives it: JSON on stdin, MEETLESS_HOME pointed at a sandbox, then read
// the ask-traces.jsonl line the hook actually wrote. No mocks, no re-implemented
// bash.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_1";
const PROMPT = "add a retry to the fetch function";

type Governance = {
  pending_count: number | null;
  injected: boolean;
  form: string | null;
  silent_reason: string | null;
};

/**
 * Run the hook in a fresh sandbox home. `cache` is the pending-count cache body
 * to write (undefined writes no cache file at all, the live condition).
 */
function runHook(opts: {
  session: string;
  cache?: string;
  env?: Record<string, string>;
}): { governance: Governance; context: string; status: number | null } {
  const home = mkdtempSync(join(tmpdir(), "mlgov-home-"));
  const repo = mkdtempSync(join(tmpdir(), "mlgov-repo-"));
  writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
  mkdirSync(join(home, "logs", "governance"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({ workspaceId: WORKSPACE_ID, actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
  );
  if (opts.cache !== undefined) {
    // The path common.sh's governance_count_file() builds: ws id sanitized through
    // `tr -c 'A-Za-z0-9_.-' '_'`, which leaves "ws_1" untouched.
    writeFileSync(join(home, "logs", "governance", `pending-count-${WORKSPACE_ID}.json`), opts.cache);
  }

  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: opts.session, prompt: PROMPT, cwd: repo }),
    encoding: "utf8",
    // The activation gate walks up from the subprocess $PWD, not the stdin cwd field.
    cwd: repo,
    env: { ...process.env, MEETLESS_HOME: home, HOME: home, ...(opts.env ?? {}) },
    timeout: 15000,
  });

  const lines = readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);

  let context = "";
  try {
    context = JSON.parse(r.stdout || "{}")?.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    context = "";
  }
  return { governance: lines[0].governance, context, status: r.status };
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe("governance nudge: silence is recorded, not implied", () => {
  it("no cache file at all reports no_cache, not a bare null", () => {
    // A workspace where nobody has ever run `mla kb pending`: governance-cache.ts
    // never wrote the count file. Distinct from stale_cache below, and the
    // distinction is the whole point: this one is fixed by running the command
    // once, that one is fixed by running it AGAIN.
    const { governance, status } = runHook({ session: "gov_no_cache" });
    expect(status).toBe(0);
    expect(governance.silent_reason).toBe("no_cache");
    expect(governance.pending_count).toBeNull();
    expect(governance.injected).toBe(false);
  });

  it("the kill switch reports disabled, which is a choice and not a fault", () => {
    const { governance } = runHook({
      session: "gov_disabled",
      cache: JSON.stringify({ count: 3, ts: nowSec() }),
      env: { MEETLESS_GOVERNANCE_HINT: "0" },
    });
    expect(governance.silent_reason).toBe("disabled");
    expect(governance.injected).toBe(false);
  });

  it("a non-numeric count reports malformed_cache", () => {
    const { governance } = runHook({
      session: "gov_bad_count",
      cache: JSON.stringify({ count: "abc", ts: nowSec() }),
    });
    expect(governance.silent_reason).toBe("malformed_cache");
  });

  it("a non-numeric ts reports malformed_cache and NOT stale_cache", () => {
    // The regression this test exists for. The old code coerced an unparseable ts
    // to 0, which then tripped the staleness guard, so a CORRUPT file reported
    // itself as merely OLD. That sends the reader to the wrong fix: no amount of
    // waiting for the next `mla kb pending` repairs a malformed file.
    const { governance } = runHook({
      session: "gov_bad_ts",
      cache: JSON.stringify({ count: 3, ts: "not-a-number" }),
    });
    expect(governance.silent_reason).toBe("malformed_cache");
    expect(governance.silent_reason).not.toBe("stale_cache");
  });

  it("a cache older than the TTL reports stale_cache", () => {
    const { governance } = runHook({
      session: "gov_stale",
      cache: JSON.stringify({ count: 3, ts: 1 }),
    });
    expect(governance.silent_reason).toBe("stale_cache");
  });

  it("the ACTUAL live dogfood cache bytes report stale_cache", () => {
    // Not a synthetic ts:1. These are the literal bytes sitting in
    // ~/.meetless/logs/governance/pending-count-<ws>.json on the machine this was
    // written on, and they are why the whole surface has been dark since
    // 2026-07-07T01:30:18Z. Pinned as a test so the diagnosis is reproducible by
    // someone who does not have that machine, and so a future TTL change has to
    // confront the case that actually happened rather than a made-up one.
    const { governance } = runHook({
      session: "gov_live_bytes",
      cache: '{"count":0,"ts":1783301418}',
    });
    expect(governance.silent_reason).toBe("stale_cache");
    // count:0 in the file, but stale wins: a decayed 0 is not a known-empty
    // queue. Reporting pending_count:0 here would claim knowledge we do not have.
    expect(governance.pending_count).toBeNull();
  });

  it("a fresh KNOWN-empty queue keeps silent_reason null: it ran and decided", () => {
    // count==0 is not silence, it is a real answer. Conflating the two is exactly
    // what made the old null unreadable.
    const { governance } = runHook({
      session: "gov_zero",
      cache: JSON.stringify({ count: 0, ts: nowSec() }),
    });
    expect(governance.pending_count).toBe(0);
    expect(governance.silent_reason).toBeNull();
    expect(governance.injected).toBe(false);
  });

  it("a fresh non-empty queue still injects the nudge, with silent_reason null", () => {
    // The instrumentation must not have cost us the behavior it measures.
    const { governance, context } = runHook({
      session: "gov_fires",
      cache: JSON.stringify({ count: 3, ts: nowSec() }),
    });
    expect(governance.pending_count).toBe(3);
    expect(governance.injected).toBe(true);
    expect(governance.form).toBe("prose");
    expect(governance.silent_reason).toBeNull();
    expect(context).toContain('kind="governance"');
    expect(context).toContain("governance_pending_count: 3");
  });

  it("every path emits the same four keys, so a reader never has to probe for one", () => {
    const cases: Array<{ session: string; cache?: string; env?: Record<string, string> }> = [
      { session: "shape_no_cache" },
      { session: "shape_disabled", env: { MEETLESS_GOVERNANCE_HINT: "0" } },
      { session: "shape_malformed", cache: JSON.stringify({ count: "abc", ts: nowSec() }) },
      { session: "shape_stale", cache: JSON.stringify({ count: 3, ts: 1 }) },
      { session: "shape_zero", cache: JSON.stringify({ count: 0, ts: nowSec() }) },
      { session: "shape_fires", cache: JSON.stringify({ count: 3, ts: nowSec() }) },
    ];
    for (const c of cases) {
      const { governance } = runHook(c);
      expect(Object.keys(governance).sort()).toEqual(
        ["form", "injected", "pending_count", "silent_reason"].sort(),
      );
      // A silent path never claims to have injected; a live path never carries a
      // reason for a silence that did not happen.
      if (governance.silent_reason !== null) {
        expect(governance.injected).toBe(false);
        expect(governance.pending_count).toBeNull();
      }
    }
  });
});
