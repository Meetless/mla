import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindWorkspaceMarker } from "../lib/workspace-marker.helper";
import { loadRunRecord, writeRunRecord } from "../../src/lib/enrichment/plan";

// Command-boundary coverage for the scout's wall-clock deadline.
//
// `run.deadlineAt` is frozen at PLAN time (createdAt + budgetMs). The scout does NOT start at
// plan time: between plan and dispatch the agent runs `enrich brief` for both roles and relays
// each brief verbatim into a Task prompt, and the history brief is tens of kilobytes of git
// evidence that the orchestrator has to emit token by token. Measured on the real repo, that
// orchestration alone ate most of the four-minute default budget. A scout handed an
// already-spent deadline reads its own brief as "stop and return `timed_out`", having read
// nothing. Ingest never enforces the deadline either, so the frozen value was pure downside.
//
// `enrich brief` therefore re-anchors: it prints now + budgetMs. The run record is untouched
// (it keeps its plan-time deadlineAt for audit and lock math); only the sentence the scout
// reads moves. buildScoutPrompt's own purity is covered in lib/enrichment/scout-brief.spec.ts;
// what THIS proves is that the command actually passes the re-anchored value, which no unit
// test can see.

const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-brief-home-"));
process.env.MEETLESS_HOME = HOME;

// require (not import) AFTER MEETLESS_HOME is set: config.ts freezes HOME at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrich } = enrich;

const WS = "ws_enrich_brief";

function seedCliConfig(): void {
  writeFileSync(
    join(HOME, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      intelUrl: "http://127.0.0.1:1",
      controlToken: "ik-test",
      actorUserId: "user_test",
      mlaPath: "/bin/true",
    }),
  );
}

function initRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nGoverning rule: do the thing.\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
}

// Anchor on the trailing " If" so the ISO timestamp's own dots (the milliseconds) are not
// mistaken for the sentence-ending period. A truncated timestamp still parses, but as LOCAL
// time, which is exactly the kind of silently-passing test this file exists to prevent.
function deadlineIn(text: string): string {
  const m = text.match(/Wall-clock deadline: (\S+)\. If/);
  if (!m) throw new Error(`no wall-clock deadline in brief:\n${text.slice(0, 400)}`);
  return m[1];
}

describe("mla enrich brief: the scout's deadline is re-anchored at dispatch", () => {
  let repoDir: string;
  let restoreCwd: () => void;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    seedCliConfig();
    rmSync(join(HOME, "workspaces"), { recursive: true, force: true });
    repoDir = mkdtempSync(join(tmpdir(), "mla-enrich-brief-repo-"));
    initRepo(repoDir);
    restoreCwd = bindWorkspaceMarker(repoDir, WS);
    out = [];
    err = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    restoreCwd();
    rmSync(repoDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  async function plan(): Promise<string> {
    const rc = await runEnrich(["plan", "--json"]);
    expect(rc).toBe(0);
    const { runId } = JSON.parse(out.join("\n")) as { runId: string };
    out = [];
    return runId;
  }

  for (const role of ["documentation", "history"] as const) {
    it(`the ${role} brief prints a FUTURE deadline even when the run's frozen one is long past`, async () => {
      const runId = await plan();

      // Simulate the real failure: the orchestration between plan and dispatch outran the
      // budget, so the run's plan-time deadline is already history by the time we render.
      const run = loadRunRecord(HOME, WS, runId)!;
      const stale = new Date(Date.now() - 60 * 60_000).toISOString();
      writeRunRecord(HOME, { ...run, deadlineAt: stale });

      const rc = await runEnrich(["brief", "--run-id", runId, "--role", role]);
      expect(rc).toBe(0);

      const printed = deadlineIn(out.join("\n"));
      expect(printed).not.toBe(stale); // the dead deadline never reaches the scout
      expect(Date.parse(printed)).toBeGreaterThan(Date.now()); // it has time to actually work
      // Re-anchored to now + the run's budget, so the scout gets the WHOLE budget it was
      // promised, not the sliver the orchestrator left behind.
      expect(Date.parse(printed)).toBeLessThanOrEqual(Date.now() + run.limits.budgetMs + 1000);
    });
  }

  it("leaves the run record's own deadlineAt alone (the audit value does not move)", async () => {
    const runId = await plan();
    const before = loadRunRecord(HOME, WS, runId)!.deadlineAt;

    expect(await runEnrich(["brief", "--run-id", runId, "--role", "documentation"])).toBe(0);

    expect(loadRunRecord(HOME, WS, runId)!.deadlineAt).toBe(before);
  });
});
