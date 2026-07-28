import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

// I1 hook wiring: the UserPromptSubmit hook must pass the touched-file SET into
// the intel enrich call (/v1/ask), so Layer 2 retrieval seeds from the surfaces
// the agent is actually modifying rather than from the prompt's words (spec
// notes/20260601-agent-brain-sequencing-and-ownership.md §I1, line 478).
//
// Under the two-layer redesign (notes/20260602-two-layer-prompt-enrichment-
// plan.md) the classifier is GONE: /v1/ask is the only intel call the hook makes,
// so touched_files flows into the enrich body only (it is also surfaced in the
// Layer 1 static block as display text, asserted in intercept-hook.spec.ts).
//
// 2026-07-27: the SUBSTRATE changed. touched_files used to be the git
// working-tree delta, which is a REPOSITORY fact, not a session fact. In a
// checkout shared by concurrent agent sessions it injected a peer's uncommitted
// work as "the surfaces the agent is actually modifying"
// (notes/20260514-dogfood-friction.md). It now reads a per-session ledger that
// post-tool-use appends on every file-modifying tool call. The two facts are now
// two functions with two honest names, and both are covered here:
//
//   collect_dirty_working_tree: the repository's dirty set. Still used by the
//     rule assembler on purpose, because a rule governing a dirty file must be
//     delivered no matter which session dirtied it.
//   record_touched_file / collect_touched_files: this session's own edits,
//     exact, partial by construction, most-recent-first, and what goes on the
//     wire as touched_files.
//
// Only external seam mocked is intel (an in-process HTTP stub), per the project
// testing rules. The stub RECORDS request bodies so we can assert the payload.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "user-prompt-submit.sh";
const POST_TOOL_USE = "post-tool-use.sh";

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

// Source common.sh (which runs under `set -euo pipefail`) and run one snippet
// against a throwaway MEETLESS_HOME, so QUEUE_DIR is isolated per call.
function inCommon(snippet: string, env: Record<string, string> = {}, home?: string): string {
  const h = home ?? fs.mkdtempSync(path.join(os.tmpdir(), "mla-touched-home-"));
  const r = spawnSync("bash", ["-c", `source "${COMMON}" >/dev/null 2>&1; ${snippet}`], {
    encoding: "utf8",
    env: { ...process.env, MEETLESS_HOME: h, MEETLESS_DEBUG: "0", ...env },
  });
  if (!home) fs.rmSync(h, { recursive: true, force: true });
  return (r.stdout || "").trim();
}

// ---------------------------------------------------------------------------
// collect_dirty_working_tree (common.sh): the REPOSITORY's dirty set.
// ---------------------------------------------------------------------------
function collectDirtyWorkingTree(dir: string, env: Record<string, string> = {}): string {
  return inCommon(`collect_dirty_working_tree "${dir}"`, env);
}

describe("collect_dirty_working_tree (common.sh)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("jq required");
    if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("git required");
  });

  it("returns [] for a non-git directory (compat 6.2 dormant fallback)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-nongit-"));
    try {
      expect(collectDirtyWorkingTree(dir)).toBe("[]");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for a clean repo with no working-tree changes", () => {
    const repo = initRepoWithSeed();
    try {
      expect(collectDirtyWorkingTree(repo)).toBe("[]");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("captures both a modified tracked file and an untracked file", () => {
    const repo = initRepoWithSeed();
    try {
      fs.writeFileSync(path.join(repo, "seed.ts"), "export const a = 2;\n"); // tracked change
      fs.writeFileSync(path.join(repo, "fresh.ts"), "export const b = 1;\n"); // untracked
      const arr = JSON.parse(collectDirtyWorkingTree(repo)) as string[];
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
      const arr = JSON.parse(collectDirtyWorkingTree(repo)) as string[];
      expect(arr.filter((p) => p === "seed.ts").length).toBe(1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("respects MEETLESS_TOUCHED_FILES_MAX (bounded against context bloat)", () => {
    const repo = initRepoWithSeed();
    try {
      for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(repo, `f${i}.ts`), `// ${i}\n`);
      const arr = JSON.parse(collectDirtyWorkingTree(repo, { MEETLESS_TOUCHED_FILES_MAX: "2" })) as string[];
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
      const arr = JSON.parse(collectDirtyWorkingTree(repo)) as string[];
      expect(arr).toContain("real.ts");
      expect(arr).not.toContain("ignored.log");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// record_touched_file + collect_touched_files: THIS session's own edits.
// ---------------------------------------------------------------------------
function ledgerHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "mla-ledger-home-"));
  fs.mkdirSync(path.join(h, "queue"), { recursive: true });
  return h;
}

function seedLedger(home: string, sid: string, paths: string[]): void {
  fs.writeFileSync(path.join(home, "queue", `${sid}.touched`), paths.map((p) => `${p}\n`).join(""));
}

function collectTouchedFiles(
  home: string,
  sid: string,
  dir: string,
  env: Record<string, string> = {},
): string {
  return inCommon(`collect_touched_files "${sid}" "${dir}"`, env, home);
}

describe("collect_touched_files (common.sh): exact per-session attribution", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("jq required");
    if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("git required");
  });

  // THE REGRESSION. This is the dogfood defect verbatim: a peer session dirties
  // three files in the shared checkout, our session edits one. The old
  // working-tree substrate returned all four and called them ours.
  it("NEVER reports a concurrent peer's dirty file that this session did not touch", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      // A peer session's uncommitted work, live in the shared tree right now.
      fs.writeFileSync(path.join(repo, "peer-a.ts"), "// peer\n");
      fs.writeFileSync(path.join(repo, "peer-b.ts"), "// peer\n");
      fs.writeFileSync(path.join(repo, "seed.ts"), "export const a = 999;\n");
      // Our session touched exactly one file.
      fs.writeFileSync(path.join(repo, "mine.ts"), "// mine\n");
      seedLedger(home, "sess-1", [path.join(repo, "mine.ts")]);

      // The repository fact still sees all four; that function is unchanged.
      const dirty = JSON.parse(collectDirtyWorkingTree(repo)) as string[];
      expect(dirty.sort()).toEqual(["mine.ts", "peer-a.ts", "peer-b.ts", "seed.ts"]);

      // The wire fact sees only ours.
      const mine = JSON.parse(collectTouchedFiles(home, "sess-1", repo)) as string[];
      expect(mine).toEqual(["mine.ts"]);
      expect(mine).not.toContain("peer-a.ts");
      expect(mine).not.toContain("peer-b.ts");
      expect(mine).not.toContain("seed.ts");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns [] when the session has modified nothing yet (compat 6.2)", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      fs.writeFileSync(path.join(repo, "peer.ts"), "// peer\n"); // dirty, but not ours
      expect(collectTouchedFiles(home, "sess-fresh", repo)).toBe("[]");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns [] for an unknown session id and never reads another session's ledger", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      seedLedger(home, "sess-other", [path.join(repo, "theirs.ts")]);
      expect(collectTouchedFiles(home, "sess-mine", repo)).toBe("[]");
      expect(JSON.parse(collectTouchedFiles(home, "sess-other", repo))).toEqual(["theirs.ts"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("emits repo-relative paths for absolute ledger entries", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      seedLedger(home, "s", [path.join(repo, "src", "deep", "x.ts")]);
      expect(JSON.parse(collectTouchedFiles(home, "s", repo))).toEqual(["src/deep/x.ts"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops absolute paths outside the repo (another repo is not a surface of this workspace)", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "mla-other-repo-"));
    try {
      seedLedger(home, "s", [path.join(other, "elsewhere.ts"), path.join(repo, "here.ts")]);
      expect(JSON.parse(collectTouchedFiles(home, "s", repo))).toEqual(["here.ts"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("dedupes repeated edits and keeps the MOST RECENT touch order (recency is the ranking signal)", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      seedLedger(home, "s", [
        path.join(repo, "old.ts"),
        path.join(repo, "mid.ts"),
        path.join(repo, "old.ts"), // re-edited, so it must outrank mid.ts
        path.join(repo, "new.ts"),
      ]);
      expect(JSON.parse(collectTouchedFiles(home, "s", repo))).toEqual(["new.ts", "old.ts", "mid.ts"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("bounds to MEETLESS_TOUCHED_FILES_MAX, truncating the OLDEST touches", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      seedLedger(
        home,
        "s",
        ["a", "b", "c", "d", "e"].map((n) => path.join(repo, `${n}.ts`)),
      );
      const arr = JSON.parse(
        collectTouchedFiles(home, "s", repo, { MEETLESS_TOUCHED_FILES_MAX: "2" }),
      ) as string[];
      expect(arr).toEqual(["e.ts", "d.ts"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("works in a marker-only (non-git) directory, scoping to that dir", () => {
    const home = ledgerHome();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-nongit-ledger-"));
    try {
      seedLedger(home, "s", [path.join(dir, "note.md")]);
      expect(JSON.parse(collectTouchedFiles(home, "s", dir))).toEqual(["note.md"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("record_touched_file appends, is idempotent-at-read, and never fails on a blank arg", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      const snippet = [
        `record_touched_file "s" "${path.join(repo, "one.ts")}"`,
        `record_touched_file "s" "${path.join(repo, "two.ts")}"`,
        `record_touched_file "s" "${path.join(repo, "one.ts")}"`,
        `record_touched_file "" "${path.join(repo, "nosid.ts")}"`,
        `record_touched_file "s" ""`,
        `collect_touched_files "s" "${repo}"`,
      ].join("; ");
      expect(JSON.parse(inCommon(snippet, {}, home))).toEqual(["one.ts", "two.ts"]);
      // The blank-sid call must not have minted a phantom ledger.
      expect(fs.readdirSync(path.join(home, "queue")).sort()).toEqual(["s.touched"]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// post-tool-use.sh writes the ledger the next prompt reads.
// ---------------------------------------------------------------------------
function runPostToolUse(home: string, workdir: string, sid: string, tool: string, filePath: string): void {
  const r = spawnSync("bash", [path.join(HOOKS_DIR, POST_TOOL_USE)], {
    cwd: workdir,
    encoding: "utf8",
    input: JSON.stringify({ session_id: sid, tool_name: tool, tool_input: { file_path: filePath } }),
    env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
  });
  if (r.error) throw r.error;
}

describe("post-tool-use.sh records the I1 attribution ledger", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"], { encoding: "utf8" }).status !== 0)
      throw new Error("jq required");
  });

  it("appends every file-modifying tool call, and the next prompt reads back exactly those", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      fs.writeFileSync(path.join(repo, ".meetless.json"), "{}\n");
      const edited = path.join(repo, "edited.ts");
      const written = path.join(repo, "written.ts");
      fs.writeFileSync(edited, "// e\n");
      fs.writeFileSync(written, "// w\n");
      // A peer dirties the tree in parallel; nothing about it reaches our ledger.
      fs.writeFileSync(path.join(repo, "peer.ts"), "// peer\n");

      runPostToolUse(home, repo, "sess-ptu", "Edit", edited);
      runPostToolUse(home, repo, "sess-ptu", "Write", written);

      const arr = JSON.parse(collectTouchedFiles(home, "sess-ptu", repo)) as string[];
      expect(arr.sort()).toEqual(["edited.ts", "written.ts"]);
      expect(arr).not.toContain("peer.ts");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does NOT record a read-only tool call (Read is not a modification)", () => {
    const home = ledgerHome();
    const repo = initRepoWithSeed();
    try {
      fs.writeFileSync(path.join(repo, ".meetless.json"), "{}\n");
      const doc = path.join(repo, "doc.md");
      fs.writeFileSync(doc, "# doc\n");
      runPostToolUse(home, repo, "sess-read", "Read", doc);
      expect(collectTouchedFiles(home, "sess-read", repo)).toBe("[]");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2: the wired hook sends touched_files into intel.
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

// `session` seeds the ledger for the hook's session id; `peerDirty` writes files
// into the SAME working tree that no session claims, which is the shared-checkout
// condition the wire contract must survive.
async function runWiredHook(opts: {
  gitRepo: boolean;
  prompt?: string;
  sessionTouched?: string[];
  peerDirty?: string[];
}): Promise<WiredRun> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-wired-"));
  const stub = await startRecordingStub();
  const sid = "sess-tf";
  try {
    fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
    fs.copyFileSync(path.join(HOOKS_DIR, "home.sh"), path.join(tmp, "home.sh"));
    fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
    fs.chmodSync(path.join(tmp, HOOK), 0o755);

    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, "queue"));
    fs.writeFileSync(
      path.join(home, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: `http://127.0.0.1:${stub.port}`,
        controlToken: "ik-test",
        workspaceId: "ws_test",
        mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/usr/bin/true",
      }),
    );

    // The workdir is the hook cwd; collect_touched_files scopes to its $PWD.
    let workdir: string;
    if (opts.gitRepo) {
      workdir = initRepoWithSeed();
    } else {
      workdir = path.join(tmp, "workdir");
      fs.mkdirSync(workdir);
    }
    fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");
    for (const p of opts.peerDirty ?? []) fs.writeFileSync(path.join(workdir, p), "// peer\n");
    // The ledger is written by the REAL producer, post-tool-use.sh, so this is an
    // end-to-end wire test: tool call records the path, the next prompt reads it
    // back. Hand-seeding the file would skip the half of the contract most likely
    // to drift.
    for (const p of opts.sessionTouched ?? []) {
      fs.writeFileSync(path.join(workdir, p), "// mine\n");
      runPostToolUse(home, workdir, sid, "Edit", path.join(workdir, p));
    }

    const prompt = opts.prompt ?? "Refactor the seed module.";
    const input = JSON.stringify({ session_id: sid, prompt });

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

  it("sends THIS session's files and never a peer's dirty file (classifier never called)", async () => {
    const r = await runWiredHook({
      gitRepo: true,
      sessionTouched: ["mine.ts"],
      peerDirty: ["peer.ts", "seed.ts"],
    });

    expect(r.classifyCount).toBe(0); // two-layer hook makes no classifier call
    expect(r.enrichBody).not.toBeNull();

    expect(Array.isArray(r.enrichBody.touched_files)).toBe(true);
    expect(r.enrichBody.touched_files).toEqual(["mine.ts"]);
    expect(r.enrichBody.touched_files).not.toContain("peer.ts");
    expect(r.enrichBody.touched_files).not.toContain("seed.ts");
    // proposed_action is reserved for a future PreToolUse surface; never sent here.
    expect(r.enrichBody.proposed_action).toBeUndefined();
    // enrich carries the prompt as `question`.
    expect(r.enrichBody.question).toBe("Refactor the seed module.");
  });

  it("OMITS touched_files entirely when this session has touched nothing (compat 6.2)", async () => {
    // A DIRTY git repo, so this is not merely the non-git path: the old substrate
    // would have filled the field from the peer's work.
    const r = await runWiredHook({ gitRepo: true, peerDirty: ["peer.ts"] });

    expect(r.classifyCount).toBe(0);
    expect(r.enrichBody).not.toBeNull();
    expect("touched_files" in r.enrichBody).toBe(false);
    expect(r.enrichBody.proposed_action).toBeUndefined();
  });

  it("OMITS touched_files entirely in a non-git workdir (byte-for-byte compat 6.2)", async () => {
    const r = await runWiredHook({ gitRepo: false });

    expect(r.classifyCount).toBe(0);
    expect(r.enrichBody).not.toBeNull();
    expect("touched_files" in r.enrichBody).toBe(false);
    expect(r.enrichBody.proposed_action).toBeUndefined();
  });
});
