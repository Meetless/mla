import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// `governance.silent_reason` used to say `stale_cache`, `no_cache`, `malformed_cache`.
// None of those name WHICH cache, and there are two caches a reader could mean:
//
//   ~/.meetless/logs/governance/pending-count-<ws>.json   the review nudge count (this one)
//   ~/.meetless/workspaces/<ws>/scan-cache.json           the governed RULES delivery
//
// Only the second one can stop rules from reaching the agent. The unqualified noun sent
// three separate readings to the wrong one:
//
//   2026-08-04  the mla-helpfulness run diagnosed the scan cache, caught itself, and wrote
//               the lesson down: "stale_cache is NOT the scan cache. Diagnosing the first
//               wastes a run."
//   2026-08-06  the next run read the same field and made the same mistake anyway, filing
//               it as "a RECURRENCE of the poisoned-slot trap".
//   2026-08-06  the fix proposal built on that reading made "stale_cache silenced the
//               governance layer for five days" its number-one defect and proposed a
//               self-heal for scanner/cache.ts that had ALREADY shipped in 3ae06e39e.
//
// Three readers, one word, one wrong cache. Commit 13ed49e0d fixed exactly this class for
// the BLOCK text ("the governance counter never said which queue it counts"); the reason
// value it is reported under kept the ambiguity, and the value is injected into the agent's
// context verbatim, so the agent reads the ambiguous noun too.
//
// This pins the property rather than the spelling: whatever the values are called, a
// silence caused by the pending-count cache must say so, and must not be mistakable for the
// rules cache.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_reason";

function runHook(opts: { session: string; cache?: string }): { silentReason: string | null; context: string } {
  const home = mkdtempSync(join(tmpdir(), "mla-reason-home-"));
  const repo = mkdtempSync(join(tmpdir(), "mla-reason-repo-"));
  writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
  mkdirSync(join(home, "logs", "governance"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({ workspaceId: WORKSPACE_ID, actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
  );
  if (opts.cache !== undefined) {
    writeFileSync(join(home, "logs", "governance", `pending-count-${WORKSPACE_ID}.json`), opts.cache);
  }

  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: opts.session, prompt: "add a retry to the fetch function", cwd: repo }),
    encoding: "utf8",
    cwd: repo,
    env: { ...process.env, MEETLESS_HOME: home, HOME: home },
    timeout: 20000,
  });

  const line = readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .pop();

  let context = "";
  try {
    context = JSON.parse(r.stdout || "{}")?.hookSpecificOutput?.additionalContext ?? "";
  } catch {
    context = "";
  }
  return { silentReason: line.governance?.silent_reason ?? null, context };
}

const STALE = JSON.stringify({ count: 7, ts: 1 });

describe("a governance silence names the cache it is about", () => {
  it("the stale reason identifies the pending-count cache", () => {
    const { silentReason } = runHook({ session: "reason_stale", cache: STALE });

    expect(silentReason).toContain("pending_count");
  });

  it("the missing-cache reason identifies the pending-count cache", () => {
    const { silentReason } = runHook({ session: "reason_none" });

    expect(silentReason).toContain("pending_count");
  });

  it("the malformed reason identifies the pending-count cache", () => {
    const { silentReason } = runHook({ session: "reason_bad", cache: JSON.stringify({ count: "abc", ts: 1 }) });

    expect(silentReason).toContain("pending_count");
  });

  it("no reason is a bare `*_cache` that could mean the rules cache", () => {
    // The specific ambiguity that cost three readings. A reason ending in a bare `cache`
    // with no subject is the shape that reads as "the scan cache went stale", which is the
    // one failure this block CANNOT represent.
    for (const [session, cache] of [
      ["amb_stale", STALE],
      ["amb_none", undefined],
      ["amb_bad", JSON.stringify({ count: "abc", ts: 1 })],
    ] as const) {
      const { silentReason } = runHook({ session, cache });

      expect(silentReason).not.toMatch(/^(stale|no|malformed)_cache$/);
    }
  });

  it("the reason the AGENT reads carries the same qualification as the trace", () => {
    // The value is interpolated into the injected block verbatim, so an ambiguous trace
    // value is an ambiguous instruction. Fixing only the trace would leave the agent
    // reading the noun that misled its predecessors.
    const { silentReason, context } = runHook({ session: "reason_ctx", cache: STALE });

    expect(context).toContain(silentReason as string);
    expect(context).toContain("pending_count");
  });
});
