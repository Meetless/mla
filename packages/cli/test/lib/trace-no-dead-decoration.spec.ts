import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

// A field that has never held a value is not pending, it is decoration, and it makes the
// trace look far more observable than it is.
//
// `future_helpfulness` was written by `write_trace` as a hardcoded all-null literal:
//
//   future_helpfulness: {usage_score: null, first_pass_score: null, prevented_trap_score:
//     null, review_case_reduction: null, noise_penalty: null, composite: null}
//
// Measured over the whole local corpus on 2026-08-06: 4,329 of 4,329 rows carry ZERO
// non-null members. Not one value, ever, on any field, and no consumer anywhere reads it
// (the only other mentions in the tree are two comments observing that it is always null).
// It is the instrument built to answer "did MLA help?", and it has never answered anything.
//
// So it is deleted rather than instrumented. Instrumenting is real work on a hot path and
// nothing has asked for the number; the concrete harm today is that a reader scanning the
// trace sees six scoring fields and concludes the question is being measured.
//
// `steps[]` is NOT deleted, and the distinction is the point of measuring first. The fix
// proposal grouped them as "two dead instruments" and reported that "every entry in steps[]
// reads status not_instrumented on every trace in the file". That is false. The same corpus
// says:
//
//   not_instrumented  31,251      ok  4,989      skipped  929      degraded  141
//
// Roughly one entry in six carries a real status, and every stage name that reports
// `not_instrumented` on one strategy reports `ok` on another (weaviate_hybrid: 2,830
// not_instrumented and 539 ok). A partially instrumented field is a coverage gap, which is
// a different thing from a dead one, and deleting it would have destroyed live telemetry.
const HOOK = join(__dirname, "../../src/hooks-template/user-prompt-submit.sh");
const WORKSPACE_ID = "ws_decoration";

function runHook(): Record<string, unknown> {
  const home = mkdtempSync(join(tmpdir(), "mla-dec-home-"));
  const repo = mkdtempSync(join(tmpdir(), "mla-dec-repo-"));
  writeFileSync(join(repo, ".meetless.json"), JSON.stringify({ workspaceId: WORKSPACE_ID }));
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(
    join(home, "cli-config.json"),
    JSON.stringify({ workspaceId: WORKSPACE_ID, actorUserId: "user_a", intelUrl: "http://127.0.0.1:8100" }),
  );

  spawnSync("bash", [HOOK], {
    input: JSON.stringify({ session_id: "decoration_probe", prompt: "add a retry to the fetch function", cwd: repo }),
    encoding: "utf8",
    cwd: repo,
    env: { ...process.env, MEETLESS_HOME: home, HOME: home },
    timeout: 20000,
  });

  return readFileSync(join(home, "logs", "ask-traces.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
    .pop() as Record<string, unknown>;
}

describe("the trace carries no permanently-null block", () => {
  it("writes a trace at all, so the rest of this suite is not vacuous", () => {
    expect(runHook().trace_id).toBeTruthy();
  });

  it("does not emit future_helpfulness", () => {
    expect(runHook()).not.toHaveProperty("future_helpfulness");
  });

  it("still emits operator_label, which is the same shape but is actually writable", () => {
    // The neighbouring all-null block, deliberately kept. `operator_label` is filled in by
    // `mla label`, so its nulls mean "this turn has not been labelled yet" -- a real state
    // an operator can change. That is the difference between a field awaiting input and a
    // field awaiting an implementation nobody scheduled.
    expect(runHook()).toHaveProperty("operator_label");
  });
});
