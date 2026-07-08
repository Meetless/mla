import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

// I1 hook wiring: the UserPromptSubmit hook must pass the touched-file SET it
// derives from the git working tree into the intel enrich call (/v1/ask), so
// Layer 2 retrieval seeds from the surfaces the agent is actually modifying
// rather than from the prompt's words (spec
// notes/20260601-agent-brain-sequencing-and-ownership.md §I1, line 478).
//
// Under the two-layer redesign (notes/20260602-two-layer-prompt-enrichment-
// plan.md) the classifier is GONE: /v1/ask is the only intel call the hook makes,
// so touched_files flows into the enrich body only (it is also surfaced in the
// Layer 1 static block as display text, asserted in intercept-hook.spec.ts).
//
// Two layers of coverage:
//   1. collect_touched_files (common.sh) in isolation: emits a bounded, deduped
//      JSON array from the git working tree; "[]" on any non-git / failure path
//      (compat 6.2).
//   2. The wired hook: when the workdir is a dirty git repo, the enrich body
//      carries touched_files; when it is NOT a git repo, the field is OMITTED
//      entirely (byte-for-byte today's prompt-only behavior). proposed_action is
//      never sent at this surface, and the classifier is never called.
//
// Only external seam mocked is intel (an in-process HTTP stub), per the project
// testing rules. The stub RECORDS request bodies so we can assert the payload.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "user-prompt-submit.sh";

function git(repo: string, args: string[]): void {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

// A fresh repo with one committed file, so HEAD exists and `diff HEAD` works.
function initRepoWithSeed(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mla-touched-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t.t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "seed.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed"]);
  return repo;
}

// ---------------------------------------------------------------------------
// Layer 1: collect_touched_files (common.sh) in isolation.
// ---------------------------------------------------------------------------
function collectTouchedFiles(dir: string, env: Record<string, string> = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-touched-home-"));
  // Source common.sh (which runs under `set -euo pipefail`), then call the
  // function with an explicit dir so $PWD does not matter.
  const script = `source "${COMMON}" >/dev/null 2>&1; collect_touched_files "${dir}"`;
  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", ...env },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return (r.stdout || "").trim();
}

describe("collect_touched_files (common.sh)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("jq required");
    if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("git required");
  });

  it("returns [] for a non-git directory (compat 6.2 dormant fallback)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-nongit-"));
    try {
      expect(collectTouchedFiles(dir)).toBe("[]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for a clean repo with no working-tree changes", () => {
    const repo = initRepoWithSeed();
    try {
      expect(collectTouchedFiles(repo)).toBe("[]");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("captures both a modified tracked file and an untracked file", () => {
    const repo = initRepoWithSeed();
    try {
      fs.writeFileSync(path.join(repo, "seed.ts"), "export const a = 2;\n"); // tracked change
      fs.writeFileSync(path.join(repo, "fresh.ts"), "export const b = 1;\n"); // untracked
      const arr = JSON.parse(collectTouchedFiles(repo)) as string[];
      expect(arr).toContain("seed.ts");
      expect(arr).toContain("fresh.ts");
      expect(arr.length).toBe(2);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("dedupes a path that is both staged and further modified", () => {
    const repo = initRepoWithSeed();
    try {
      fs.writeFileSync(path.join(repo, "seed.ts"), "export const a = 2;\n");
      git(repo, ["add", "seed.ts"]); // staged
      fs.writeFileSync(path.join(repo, "seed.ts"), "export const a = 3;\n"); // + unstaged on top
      const arr = JSON.parse(collectTouchedFiles(repo)) as string[];
      expect(arr.filter((p) => p === "seed.ts").length).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("respects MEETLESS_TOUCHED_FILES_MAX (bounded against context bloat)", () => {
    const repo = initRepoWithSeed();
    try {
      for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), `// ${i}\n`);
      const arr = JSON.parse(collectTouchedFiles(repo, { MEETLESS_TOUCHED_FILES_MAX: "2" })) as string[];
      expect(arr.length).toBe(2);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores gitignored files (exclude-standard)", () => {
    const repo = initRepoWithSeed();
    try {
      fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
      git(repo, ["add", ".gitignore"]);
      git(repo, ["commit", "-q", "-m", "ignore"]);
      fs.writeFileSync(path.join(repo, "ignored.log"), "noise\n"); // untracked but ignored
      fs.writeFileSync(path.join(repo, "real.ts"), "// real\n"); // untracked, tracked-worthy
      const arr = JSON.parse(collectTouchedFiles(repo)) as string[];
      expect(arr).toContain("real.ts");
      expect(arr).not.toContain("ignored.log");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2: the wired hook sends touched_files into BOTH intel endpoints.
// ---------------------------------------------------------------------------
interface BodyCapture {
  classify: any[];
  enrich: any[];
}

function startRecordingStub(): Promise<{
  server: http.Server;
  port: number;
  bodies: BodyCapture;
  close: () => Promise<void>;
}> {
  const bodies: BodyCapture = { classify: [], enrich: [] };
  const sockets = new Set<import("net").Socket>();
  const server = http.createServer((req, res) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      const url = req.url ?? "";
      let parsed: any = null;
      try {
        parsed = JSON.parse(chunks || "{}");
      } catch {
        parsed = { __unparseable: chunks };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.includes("/v1/intercept/classify")) {
        bodies.classify.push(parsed);
        res.end(JSON.stringify({ decision: "inject", confidence: "high", reason: "architecture_sensitive" }));
      } else if (url.includes("/v1/ask")) {
        bodies.enrich.push(parsed);
        res.end(
          JSON.stringify({
            enrichment: {
              strategy: "agentic_mission_structured",
              status: "ok",
              confidence: "high",
              markdown: "## Accepted-record claims (cited; verify before relying):\n- seeded",
              fields_present: ["constraints"],
              context_items: [],
            },
            steps: [],
          }),
        );
      } else {
        res.end("{}");
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
        server,
        port,
        bodies,
        close: () =>
          new Promise<void>((r) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => r());
          }),
      });
    });
  });
}

interface WiredRun {
  classifyCount: number;
  enrichBody: any | null;
}

async function runWiredHook(opts: { gitRepo: boolean; prompt?: string }): Promise<WiredRun> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-wired-"));
  const stub = await startRecordingStub();
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

    // The workdir is the hook cwd; collect_touched_files reads its $PWD.
    let workdir: string;
    if (opts.gitRepo) {
      workdir = initRepoWithSeed();
      fs.writeFileSync(path.join(workdir, "seed.ts"), "export const a = 99;\n"); // modified tracked
      fs.writeFileSync(path.join(workdir, "untracked.ts"), "// new\n"); // untracked
    } else {
      workdir = path.join(tmp, "workdir");
      fs.mkdirSync(workdir);
    }
    fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");

    const prompt = opts.prompt ?? "Refactor the seed module.";
    const input = JSON.stringify({ session_id: "sess-tf", prompt });

    await new Promise<void>((resolve, reject) => {
      const child = spawn("bash", [path.join(tmp, HOOK)], {
        cwd: workdir,
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
      });
      child.stdout.on("data", () => {});
      child.stderr.on("data", () => {});
      child.on("error", reject);
      child.on("close", () => resolve());
      child.stdin.write(input);
      child.stdin.end();
    });

    if (opts.gitRepo) fs.rmSync(workdir, { recursive: true, force: true });

    return {
      classifyCount: stub.bodies.classify.length,
      enrichBody: stub.bodies.enrich[0] ?? null,
    };
  } finally {
    await stub.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("user-prompt-submit.sh forwards touched_files to intel", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("jq required");
    if (spawnSync("curl", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("curl required");
    if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("git required");
  });

  it("includes the working-tree touched files in the enrich body (classifier never called)", async () => {
    const r = await runWiredHook({ gitRepo: true });

    expect(r.classifyCount).toBe(0); // two-layer hook makes no classifier call
    expect(r.enrichBody).not.toBeNull();

    expect(Array.isArray(r.enrichBody.touched_files)).toBe(true);
    expect(r.enrichBody.touched_files).toContain("seed.ts");
    expect(r.enrichBody.touched_files).toContain("untracked.ts");
    // proposed_action is reserved for a future PreToolUse surface; never sent here.
    expect(r.enrichBody.proposed_action).toBeUndefined();
    // enrich carries the prompt as `question`.
    expect(r.enrichBody.question).toBe("Refactor the seed module.");
  });

  it("OMITS touched_files entirely in a non-git workdir (byte-for-byte compat 6.2)", async () => {
    const r = await runWiredHook({ gitRepo: false });

    expect(r.classifyCount).toBe(0);
    expect(r.enrichBody).not.toBeNull();
    expect("touched_files" in r.enrichBody).toBe(false);
    expect(r.enrichBody.proposed_action).toBeUndefined();
  });
});
