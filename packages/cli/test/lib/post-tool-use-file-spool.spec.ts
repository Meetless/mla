import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Governed tool trace for file-modifying tools (dogfood-audit 2026-06-10
// issue 3: "tool capture is bash-only").
//
// Pre-fix the hook spooled a governed event ONLY for Bash. Write / Edit /
// MultiEdit / NotebookEdit produced LOCAL side effects alone (the A2
// produced-doc record and the DUR advisory flag), so a code-only session left
// ZERO governed tool trace: no event row in control, no substantive event for
// the turn assembler, a review packet that says "no_postToolUse_capture" while
// the agent rewrote half the repo.
//
// Post-fix each file-modifying tool call spools ONE `tool_used_file` event.
// Payload is METADATA ONLY: { tool, filePath }. No file content, no diff, no
// tool I/O. That keeps the v0 privacy boundary (the rejected
// --unsafe-capture-non-bash flag was about shipping tool I/O); a path is
// strictly milder evidence than the stdout/stderr tails the Bash spool
// already ships.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const HOOK = "post-tool-use.sh";

interface FireResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface Harness {
  home: string;
  queueDir: string;
  workdir: string;
  fire: (input: object) => FireResult;
  queueLines: (sessionId: string) => Record<string, unknown>[];
}

function mkHarness(): { h: Harness; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-filespool-"));
  fs.copyFileSync(
    path.join(HOOKS_DIR, "common.sh"),
    path.join(tmp, "common.sh"),
  );
  fs.copyFileSync(path.join(HOOKS_DIR, HOOK), path.join(tmp, HOOK));
  fs.chmodSync(path.join(tmp, HOOK), 0o755);

  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, "cli-config.json"),
    JSON.stringify({
      controlUrl: "http://127.0.0.1:1",
      controlToken: "x",
      workspaceId: "ws_test",
      actorUserId: "user_a",
      mlaPath: "/bin/true",
    }),
  );
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  fs.writeFileSync(
    path.join(workdir, ".meetless.json"),
    JSON.stringify({ workspaceId: "ws_test" }),
  );

  const queueDir = path.join(home, "queue");
  const h: Harness = {
    home,
    queueDir,
    workdir,
    fire: (input: object) => {
      const r = spawnSync("bash", [path.join(tmp, HOOK)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        cwd: workdir,
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
        timeout: 5000,
      });
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    },
    queueLines: (sessionId: string) => {
      const q = path.join(queueDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(q)) return [];
      return fs
        .readFileSync(q, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
  return { h, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function fileToolInput(opts: {
  sessionId: string;
  tool: string;
  filePath: string;
}) {
  const ti: Record<string, unknown> =
    opts.tool === "NotebookEdit"
      ? { notebook_path: opts.filePath, new_source: "x" }
      : opts.tool === "Write"
        ? { file_path: opts.filePath, content: "SECRET CONTENT" }
        : { file_path: opts.filePath, old_string: "a", new_string: "b" };
  return {
    session_id: opts.sessionId,
    tool_name: opts.tool,
    tool_input: ti,
    tool_response: { success: true },
  };
}

describe("post-tool-use.sh: tool_used_file governed spool", () => {
  beforeAll(() => {
    const jq = spawnSync("jq", ["--version"], { encoding: "utf8" });
    if (jq.status !== 0) {
      throw new Error("jq must be installed to run file-spool specs");
    }
  });

  it.each(["Write", "Edit", "MultiEdit"])(
    "%s spools ONE tool_used_file event with metadata-only payload",
    (tool) => {
      const { h, cleanup } = mkHarness();
      try {
        // A CODE file: must spool even though prose_path_allowed would reject
        // it. The governed trace is not the A2 prose record; the prose gate
        // must never gate capture.
        const fp = path.join(h.workdir, "src", "service.ts");
        const r = h.fire(fileToolInput({ sessionId: "s1", tool, filePath: fp }));
        expect(r.status).toBe(0);
        const lines = h.queueLines("s1");
        const fileEvents = lines.filter((l) => l.event === "tool_used_file");
        expect(fileEvents).toHaveLength(1);
        const ev = fileEvents[0];
        expect(typeof ev.eventKey).toBe("string");
        expect((ev.eventKey as string).length).toBeGreaterThan(0);
        expect(ev.sessionId).toBe("s1");
        expect(typeof ev.ts).toBe("string");
        const payload = ev.payload as Record<string, unknown>;
        // storyCategory is stamped at capture (governed-story §5.3): a .ts file
        // is "other" so the console hides it from the markdown story.
        expect(payload).toEqual({ tool, filePath: fp, storyCategory: "other" });
      } finally {
        cleanup();
      }
    },
  );

  it.each(["Write", "Edit"])(
    "%s of a PROSE file OUTSIDE any marker still spools tool_used_file and exits 0",
    (tool) => {
      // Regression (dogfood-audit 2026-06-10 issue 3, follow-up). The A2
      // produced-doc block above the governed-trace block computes
      //   A2_ROOT="$(meetless_repo_root "$(dirname "$A2_FILE")")"
      // for any prose path. When the prose file lives OUTSIDE every
      // .meetless.json tree, meetless_repo_root returns 1, and under
      // `set -euo pipefail` that command-substitution assignment aborted the
      // WHOLE hook (exit 1) BEFORE the tool_used_file spool ever ran. Net: a
      // prose edit outside a marked workspace (a note in /tmp, a sibling repo,
      // ~/.claude) silently dropped the governed file trace AND surfaced a
      // non-zero PostToolUse hook error. The primary governed trace must be
      // immune to the assistive A2 block's exit status. Code files dodged this
      // only because prose_path_allowed rejects them and skips A2 entirely.
      const { h, cleanup } = mkHarness();
      try {
        // A PROSE (.md) file in a directory with NO .meetless.json above it.
        // Sibling of workdir under the mkdtemp root, whose ancestors (the OS
        // temp dir) carry no marker, so meetless_repo_root walks to / and fails.
        const outside = path.join(h.home, "..", "outside-no-marker");
        fs.mkdirSync(outside, { recursive: true });
        const fp = path.join(outside, "note.md");
        const r = h.fire(
          fileToolInput({ sessionId: "s-prose", tool, filePath: fp }),
        );
        expect(r.status).toBe(0);
        const fileEvents = h
          .queueLines("s-prose")
          .filter((l) => l.event === "tool_used_file");
        expect(fileEvents).toHaveLength(1);
        // A .md path is "markdown" regardless of whether it sits inside a marker.
        expect(fileEvents[0].payload as Record<string, unknown>).toEqual({
          tool,
          filePath: fp,
          storyCategory: "markdown",
        });
      } finally {
        cleanup();
      }
    },
  );

  it("an UNREADABLE in-marker prose file still exits 0 and keeps the trace (A2 inner set -e landmine)", () => {
    // Second-order regression for the assistive A2 produced-doc block. Even when
    // the prose path DOES resolve to a marker, the inner body runs
    //   A2_CHASH="$(content_hash "$A2_FILE")"   # shasum|cut, fails under pipefail
    //   record_active_memory ...                # returns its flock-write status
    // and under `set -euo pipefail` either aborts the WHOLE hook (exit 1) after
    // the governed trace already spooled, surfacing a non-zero PostToolUse error.
    // The whole A2 block is wrapped so no inner failure can abort the parent.
    if (process.getuid && process.getuid() === 0) {
      return; // root bypasses chmod 000; the landmine can't be staged
    }
    const { h, cleanup } = mkHarness();
    const fp = path.join(h.workdir, "note.md");
    try {
      fs.writeFileSync(fp, "hello");
      fs.chmodSync(fp, 0o000); // forces content_hash (shasum) to fail
      const r = h.fire(
        fileToolInput({ sessionId: "s-unread", tool: "Write", filePath: fp }),
      );
      expect(r.status).toBe(0);
      const fileEvents = h
        .queueLines("s-unread")
        .filter((l) => l.event === "tool_used_file");
      expect(fileEvents).toHaveLength(1);
    } finally {
      try {
        fs.chmodSync(fp, 0o644);
      } catch {
        /* ignore */
      }
      cleanup();
    }
  });

  it("NotebookEdit spools with the notebook_path as filePath", () => {
    const { h, cleanup } = mkHarness();
    try {
      const fp = path.join(h.workdir, "analysis.ipynb");
      const r = h.fire(
        fileToolInput({ sessionId: "s2", tool: "NotebookEdit", filePath: fp }),
      );
      expect(r.status).toBe(0);
      const fileEvents = h
        .queueLines("s2")
        .filter((l) => l.event === "tool_used_file");
      expect(fileEvents).toHaveLength(1);
      expect((fileEvents[0].payload as Record<string, unknown>).filePath).toBe(
        fp,
      );
    } finally {
      cleanup();
    }
  });

  it("NEVER ships tool I/O: Write content is absent from the spooled line", () => {
    const { h, cleanup } = mkHarness();
    try {
      const fp = path.join(h.workdir, "notes", "x.md");
      h.fire(fileToolInput({ sessionId: "s3", tool: "Write", filePath: fp }));
      const q = path.join(h.queueDir, "s3.jsonl");
      const raw = fs.existsSync(q) ? fs.readFileSync(q, "utf8") : "";
      expect(raw).toContain("tool_used_file");
      expect(raw).not.toContain("SECRET CONTENT");
      expect(raw).not.toContain("old_string");
    } finally {
      cleanup();
    }
  });

  it("a Read of a CODE file spools nothing (prose gate keeps the stream clean)", () => {
    // Session Files rail Phase 2: Read now spools a markdown trace, but ONLY for
    // prose. A code Read (.ts) must still spool nothing so the read lane is a
    // knowledge story, not every source-file open.
    const { h, cleanup } = mkHarness();
    try {
      const r = h.fire({
        session_id: "s4",
        tool_name: "Read",
        tool_input: { file_path: path.join(h.workdir, "a.ts") },
        tool_response: { success: true },
      });
      expect(r.status).toBe(0);
      expect(h.queueLines("s4")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("a Read of a MARKDOWN file spools ONE tool_used_file with access:read", () => {
    // Session Files rail Phase 2: the "read by the agent" lane. A prose Read is
    // captured as a metadata-only tool_used_file discriminated by access:"read"
    // (reusing the event type, not a new one) so the console routes it to the
    // read lane and the timeline labels it "Read a file".
    const { h, cleanup } = mkHarness();
    try {
      const fp = path.join(h.workdir, "notes", "plan.md");
      const r = h.fire({
        session_id: "s4md",
        tool_name: "Read",
        tool_input: { file_path: fp },
        tool_response: { success: true },
      });
      expect(r.status).toBe(0);
      const fileEvents = h
        .queueLines("s4md")
        .filter((l) => l.event === "tool_used_file");
      expect(fileEvents).toHaveLength(1);
      expect(fileEvents[0].payload as Record<string, unknown>).toEqual({
        tool: "Read",
        filePath: fp,
        access: "read",
        storyCategory: "markdown",
      });
    } finally {
      cleanup();
    }
  });

  it("a Read with no file_path spools nothing and exits 0", () => {
    const { h, cleanup } = mkHarness();
    try {
      const r = h.fire({
        session_id: "s4nil",
        tool_name: "Read",
        tool_input: { not_a_path: true },
        tool_response: { success: true },
      });
      expect(r.status).toBe(0);
      expect(h.queueLines("s4nil")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("missing file path (malformed tool_input) spools nothing and exits 0", () => {
    const { h, cleanup } = mkHarness();
    try {
      const r = h.fire({
        session_id: "s5",
        tool_name: "Edit",
        tool_input: { not_a_path: true },
        tool_response: { success: true },
      });
      expect(r.status).toBe(0);
      expect(
        h.queueLines("s5").filter((l) => l.event === "tool_used_file"),
      ).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("Bash still spools tool_used_bash (file spool did not displace the bash route)", () => {
    const { h, cleanup } = mkHarness();
    try {
      const r = h.fire({
        session_id: "s6",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_response: { exit_code: 0, stdout: "hi", stderr: "" },
      });
      expect(r.status).toBe(0);
      const lines = h.queueLines("s6");
      expect(lines.filter((l) => l.event === "tool_used_bash")).toHaveLength(1);
      expect(lines.filter((l) => l.event === "tool_used_file")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
