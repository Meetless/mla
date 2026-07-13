import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindWorkspaceMarker } from "../lib/workspace-marker.helper";
import { runRecordPath } from "../../src/lib/enrichment/plan";

// The activation marker is the WORKSPACE scope; the git repo is the ENRICHMENT TARGET.
// They are not the same thing and need not sit at the same path: a workspace may be bound
// at an umbrella folder holding several sibling repos, which is exactly how the meetless
// tree is laid out (`.meetless.json` at ~/projects/meetless, repos `meetless/`, `intel/`,
// `notes/` beneath it). `enrich plan` and `enrich ingest` used to resolve the git toplevel
// from the marker directory, so on that layout they hard-failed with "not a git repository"
// while `enrich accept`, which resolved from cwd, worked: one command family, two answers.
// Both now start the walk at process.cwd(); resolveWorkspaceContext() stays purely as the
// activation guard.

const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-root-home-"));
process.env.MEETLESS_HOME = HOME;

// require (not import) AFTER MEETLESS_HOME is set: config.ts freezes HOME at module load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrich } = enrich;

const WS = "ws_enrich_root";

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

describe("mla enrich: the git root comes from cwd, not from the marker directory", () => {
  let umbrella: string;
  let repoDir: string;
  let restoreCwd: () => void;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    seedCliConfig();
    rmSync(join(HOME, "workspaces"), { recursive: true, force: true });
    // The umbrella carries the marker and is deliberately NOT a git repo. `git init` is run
    // only in the child, so a walk that starts at the umbrella finds no toplevel (unless the
    // system tmpdir itself is inside a repo, which it is not).
    umbrella = mkdtempSync(join(tmpdir(), "mla-enrich-root-umbrella-"));
    repoDir = join(umbrella, "child-repo");
    mkdirSync(repoDir);
    initRepo(repoDir);
    restoreCwd = bindWorkspaceMarker(umbrella, WS);
    out = [];
    err = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    errSpy = jest.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    restoreCwd();
    rmSync(umbrella, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  it("plans against the repo the human is standing in, with the marker at a non-git parent", async () => {
    process.chdir(repoDir);

    const rc = await runEnrich(["plan", "--json"]);

    expect(err.join("\n")).not.toMatch(/not a git repository/i);
    expect(rc).toBe(0);

    const plan = JSON.parse(out.join("\n")) as { runId: string };
    const record = JSON.parse(readFileSync(runRecordPath(HOME, WS, plan.runId), "utf8")) as {
      workspaceId: string;
      repositoryRoot: string;
    };
    // The child repo, not the umbrella that happens to hold the marker.
    expect(realpathSync(record.repositoryRoot)).toBe(realpathSync(repoDir));
    expect(record.workspaceId).toBe(WS); // scope still comes from the marker
  });

  it("still fails cleanly when cwd itself is outside any git repository", async () => {
    process.chdir(umbrella);

    const rc = await runEnrich(["plan", "--json"]);

    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/requires a git repository/i);
  });
});
