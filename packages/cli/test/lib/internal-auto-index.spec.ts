// tools/meetless-agent/test/lib/internal-auto-index.spec.ts
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runInternalAutoIndex as rawRunInternalAutoIndex,
  type AutoIndexDeps,
} from "../../src/commands/internal-auto-index";
import { ActiveMemoryRecord } from "../../src/lib/active-memory";
import { KbOwnerCheckError } from "../../src/lib/kb_acl";
import type { LiveBindingPassResult } from "../../src/lib/agent-memory-capture/live-collector";
import type { LiveOutcome } from "../../src/lib/agent-memory-capture/types";

// Live capture is default-on in production (no env gate). For tests that are not
// about live capture, default `runLive` to a no-op so the suite never touches the
// real ~/.meetless config, per-binding lock, live ledger, or the network. Tests
// that DO exercise live capture pass their own `runLive`, which overrides this.
function runInternalAutoIndex(argv: string[], deps: AutoIndexDeps = {}): Promise<number> {
  return rawRunInternalAutoIndex(argv, { runLive: async () => [], ...deps });
}

function store(records: Partial<ActiveMemoryRecord>[], repo: string): string {
  const home = mkdtempSync(join(tmpdir(), "ai-home-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  const f = join(home, "logs", "kb-knowledge.jsonl");
  const lines = records.map((o) =>
    JSON.stringify({
      ts: "t",
      event: "active_memory_record",
      workspaceId: "ws_1",
      ownerUserId: "u",
      repoRootHash: "rrh",
      canonicalPath: "notes/x.md",
      contentHash: "c1",
      sessionId: "s1",
      turnIndex: 1,
      sourceProduct: "claude_code",
      kind: "produced_doc",
      createdAt: new Date().toISOString(),
      repoRoot: repo,
      ...o,
    }),
  );
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

describe("runInternalAutoIndex", () => {
  it("calls the add fn once per on-disk produced doc, scoped to the session", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ai-repo-"));
    mkdirSync(join(repo, "notes"), { recursive: true });
    writeFileSync(join(repo, "notes", "x.md"), "decided to defer SSO");
    const storePath = store([{ sessionId: "s1" }, { sessionId: "other" }], repo);
    const calls: string[][] = [];
    const code = await runInternalAutoIndex(["--session", "s1"], {
      storePath,
      add: async (argv) => {
        calls.push(argv);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    // born-PENDING (e7f20756): the loop must NOT pass --posture or `mla kb add`
    // rejects it as an unknown flag and the ingest fails. It still carries the
    // agent_distilled provenance + queued upsert contract.
    expect(calls[0]).not.toContain("--posture");
    expect(calls[0]).toContain("--provenance");
    expect(calls[0]).toContain("agent_distilled");
    expect(calls[0][0]).toBe(join(repo, "notes", "x.md"));
  });

  it("skips a doc that is no longer on disk (moved/deleted since capture)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ai-repo-"));
    const storePath = store([{ sessionId: "s1" }], repo); // file never written
    const calls: string[][] = [];
    const code = await runInternalAutoIndex(["--session", "s1"], {
      storePath,
      add: async (argv) => {
        calls.push(argv);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("is fail-soft: an add that throws never escapes (returns 0)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ai-repo-"));
    mkdirSync(join(repo, "notes"), { recursive: true });
    writeFileSync(join(repo, "notes", "x.md"), "x");
    const storePath = store([{ sessionId: "s1" }], repo);
    const code = await runInternalAutoIndex(["--session", "s1"], {
      storePath,
      add: async () => {
        throw new Error("intel down");
      },
    });
    expect(code).toBe(0);
  });

  it("rejects an unknown flag with exit 2", async () => {
    const code = await runInternalAutoIndex(["--bogus"], { add: async () => 0 });
    expect(code).toBe(2);
  });

  // Fix B3 (auto-index incident): an owner-check denial must HALT the whole
  // run with one message instead of fail-softing once per doc (154 denial
  // lines in the incident). All other per-doc errors stay fail-soft.

  function twoDocRepo(): { repo: string; storePath: string } {
    const repo = mkdtempSync(join(tmpdir(), "ai-repo-"));
    mkdirSync(join(repo, "notes"), { recursive: true });
    writeFileSync(join(repo, "notes", "x.md"), "doc one");
    writeFileSync(join(repo, "notes", "y.md"), "doc two");
    const storePath = store(
      [
        { sessionId: "s1", canonicalPath: "notes/x.md" },
        { sessionId: "s1", canonicalPath: "notes/y.md", contentHash: "c2" },
      ],
      repo,
    );
    return { repo, storePath };
  }

  it("halts the run when the add boundary throws an owner-check denial (second doc never attempted)", async () => {
    const { storePath } = twoDocRepo();
    const calls: string[][] = [];
    const code = await runInternalAutoIndex(["--session", "s1"], {
      storePath,
      add: async (argv) => {
        calls.push(argv);
        throw new KbOwnerCheckError(
          "KB owner check failed: actor 'u' has role 'MEMBER' in workspace 'ws_1'; KB curation requires OWNER",
        );
      },
    });
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("halts on a cross-boundary error that carries the denial name but not the class identity", async () => {
    const { storePath } = twoDocRepo();
    const calls: string[][] = [];
    const denial = new Error(
      "KB owner check failed: actor 'u' has role 'MEMBER' in workspace 'ws_1'; KB curation requires OWNER",
    );
    denial.name = "KbOwnerCheckError";
    const code = await runInternalAutoIndex(["--session", "s1"], {
      storePath,
      add: async (argv) => {
        calls.push(argv);
        throw denial;
      },
    });
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("halts before any add when the owner preflight denies", async () => {
    const { storePath } = twoDocRepo();
    const calls: string[][] = [];
    const verified: string[] = [];
    const code = await runInternalAutoIndex(["--session", "s1"], {
      storePath,
      add: async (argv) => {
        calls.push(argv);
        return 0;
      },
      verifyOwner: async (ws) => {
        verified.push(ws);
        throw new KbOwnerCheckError(
          "KB owner check failed: actor 'u' has role 'MEMBER' in workspace 'ws_1'; KB curation requires OWNER",
        );
      },
    });
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(verified).toEqual(["ws_1"]);
  });

  it("a preflight failure that is NOT a denial stays fail-soft (adds proceed)", async () => {
    const { storePath } = twoDocRepo();
    const calls: string[][] = [];
    const code = await runInternalAutoIndex(["--session", "s1"], {
      storePath,
      add: async (argv) => {
        calls.push(argv);
        return 0;
      },
      verifyOwner: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3001");
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("a generic per-doc add error stays fail-soft and the loop continues", async () => {
    const { storePath } = twoDocRepo();
    const calls: string[][] = [];
    const code = await runInternalAutoIndex(["--session", "s1"], {
      storePath,
      add: async (argv) => {
        calls.push(argv);
        if (calls.length === 1) throw new Error("intel down");
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
  });

  // Live agent-memory capture wiring (proposal §6): the collector attached to
  // this worker runs by default AFTER the Zone-2 loop, self-gates inside the
  // collector (a consented binding + a resolvable actor), and is fully fail-soft.
  // The dep `runLive` is injected here so the default-on run and the tally fold
  // are tested without touching the network or the env.

  function liveResult(outcomes: LiveOutcome[]): LiveBindingPassResult {
    return {
      bindingId: "bind-1",
      locked: true,
      appended: outcomes.filter((o) => o !== "unchanged" && o !== "skipped").length,
      summary: {
        bindingId: "bind-1",
        memoryDir: "/mem",
        workspaceId: "ws_1",
        scanComplete: true,
        records: outcomes.map((outcome, i) => ({
          sourceId: `s${i}`,
          relativePath: `f${i}.md`,
          hash: null,
          bytes: 0,
          outcome,
          reason: "",
          secretRuleIds: [],
          observedAt: "t",
        })),
      },
    };
  }

  // Parse the final JSON summary line the worker prints to stdout.
  function lastJson(spy: jest.SpyInstance): Record<string, unknown> {
    const calls = spy.mock.calls;
    return JSON.parse(String(calls[calls.length - 1][0]));
  }

  function emptyStore(): string {
    const repo = mkdtempSync(join(tmpdir(), "ai-repo-"));
    return store([{ sessionId: "s1" }], repo); // file never on disk -> 0 targets
  }

  it("runs live capture by default (no opt-in) and folds an empty tally into the summary", async () => {
    let ran = false;
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runInternalAutoIndex(["--session", "s1"], {
        storePath: emptyStore(),
        add: async () => 0,
        runLive: async () => {
          ran = true;
          return [];
        },
      });
      expect(code).toBe(0);
      expect(ran).toBe(true); // no gate: the collector runs every pass
      // An empty result still records a (zeroed) tally, proving the pass ran.
      expect(lastJson(log).liveCapture).toEqual({
        bindings: 0,
        uploaded: 0,
        deferred: 0,
        blocked: 0,
        withdrawn: 0,
        failed: 0,
        skippedBindings: 0,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("folds a populated live tally into the summary", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runInternalAutoIndex(["--session", "s1"], {
        storePath: emptyStore(),
        add: async () => 0,
        runLive: async () =>
          [
            liveResult(["uploaded", "uploaded", "deferred", "blocked", "reclassified", "deleted", "failed", "unchanged", "skipped"]),
            { bindingId: "bind-2", locked: false, summary: null, appended: 0 },
          ] as LiveBindingPassResult[],
      });
      expect(code).toBe(0);
      const summary = lastJson(log);
      expect(summary.liveCapture).toEqual({
        bindings: 1, // bind-1 did work; bind-2 was lock-skipped
        uploaded: 2,
        deferred: 1,
        blocked: 1,
        withdrawn: 2, // reclassified + deleted
        failed: 1,
        skippedBindings: 1,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("is fail-soft: a throwing live collector never disturbs the worker (exit 0, no liveCapture)", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await runInternalAutoIndex(["--session", "s1"], {
        storePath: emptyStore(),
        add: async () => 0,
        runLive: async () => {
          throw new Error("live blew up");
        },
      });
      expect(code).toBe(0);
      expect(lastJson(log).liveCapture).toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});
