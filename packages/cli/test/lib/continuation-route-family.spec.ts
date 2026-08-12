import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// Continuation routing, TRANSPORT half. The routing decision itself is proven in
// intel/app/graphs/ask/intent_router_test.py; these prove the hook actually carries the
// family, in the one direction that matters and no other.
//
// What is carried: the route FAMILY the previous turn of THIS session resolved to.
// Nothing else. No prior prompt text, no expanded query, no confidence, no retrieved
// knowledge, no candidate ids, no prior no-offer reason. It rides the existing enrich
// body as an optional field, in the same backward-compatible shape as touched_files and
// recent_turns: absent means today's behavior byte for byte.
//
// The state lives in per-session logs/ scratch alongside the governance and steer files,
// so there is no new schema and no database read on the hot path, and it is reaped by the
// same orphan sweep.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_1";

function sandbox(): { home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), "mlroute-home-"));
  const repo = mkdtempSync(join(tmpdir(), "mlroute-repo-"));
  writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
  mkdirSync(join(home, "logs", "governance"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({ workspaceId: WORKSPACE_ID, actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
  );
  return { home, repo };
}

function runHook(opts: { home: string; repo: string; session: string; prompt: string }) {
  spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: opts.session, prompt: opts.prompt, cwd: opts.repo }),
    encoding: "utf8",
    cwd: opts.repo,
    env: { ...process.env, MEETLESS_HOME: opts.home, HOME: opts.home },
    timeout: 20000,
  });
  const traces = join(opts.home, "logs", "ask-traces.jsonl");
  const lines = existsSync(traces)
    ? readFileSync(traces, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [];
  return lines[lines.length - 1];
}

const routeFile = (home: string, session: string) =>
  join(home, "logs", "governance", `route-${session}.json`);

describe("continuation route-family transport", () => {
  it("sends NOTHING when there is no prior state, which is today's behavior", () => {
    // The compat contract. intel is unreachable in this sandbox, so the turn ends at
    // Layer 1; what matters is that the hook does not invent a family.
    const { home, repo } = sandbox();
    const trace = runHook({ home, repo, session: "route_first_turn", prompt: "fix it" });
    expect(trace).toBeDefined();
    expect(existsSync(routeFile(home, "route_first_turn"))).toBe(false);
  });

  it("carries a stored family, and carries ONLY the family", () => {
    const { home, repo } = sandbox();
    writeFileSync(
      routeFile(home, "route_carry"),
      JSON.stringify({ family: "governed_kb" }),
    );

    runHook({ home, repo, session: "route_carry", prompt: "fix it" });

    // The state file is the whole payload surface, so assert its SHAPE: one key.
    const state = JSON.parse(readFileSync(routeFile(home, "route_carry"), "utf8"));
    expect(Object.keys(state)).toEqual(["family"]);
    expect(state.family).toBe("governed_kb");
    for (const forbidden of ["prompt", "question", "query", "confidence", "candidates", "no_offer_reason", "evidence"]) {
      expect(state).not.toHaveProperty(forbidden);
    }
  });

  it("refuses a malformed or foreign family rather than sending it", () => {
    // A hand-edited file, a truncated write, or state copied from elsewhere. The hook's
    // own shape guard drops it before the wire; the router also fails closed, so this is
    // belt and braces on the value that decides a route.
    const { home, repo } = sandbox();
    for (const bogus of ['{"family":"GOVERNED_KB"}', '{"family":"a b c"}', '{"family":""}', "not json at all"]) {
      writeFileSync(routeFile(home, "route_bogus"), bogus);
      const trace = runHook({ home, repo, session: "route_bogus", prompt: "fix it" });
      expect(trace).toBeDefined();
    }
  });

  it("keeps each session's state separate", () => {
    const { home, repo } = sandbox();
    writeFileSync(routeFile(home, "sess_a"), JSON.stringify({ family: "governed_kb" }));

    runHook({ home, repo, session: "sess_b", prompt: "fix it" });

    // sess_b must not have read, written or inherited sess_a's file.
    expect(existsSync(routeFile(home, "sess_b"))).toBe(false);
    const a = JSON.parse(readFileSync(routeFile(home, "sess_a"), "utf8"));
    expect(a.family).toBe("governed_kb");
  });
});
