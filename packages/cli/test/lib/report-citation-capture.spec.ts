import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// P3 (notes/20260603-mla-kb-agent-proxy §7.1 P3, §7.2 backlog "P3*"; blocks A1b + A2):
// the citation / source_id extractor over the agent's FINAL report. The Stop
// hook already captures the last assistant message (finalMessage); P3 parses the
// [XX:id] evidence tokens out of it so A1b push-reference-followthrough can ask
// "did the agent's final report cite a source_id we injected?" without a Pull.
//
// Like P1's pull side (mcp-calls.jsonl), this lands in a LOCAL sibling of
// ask-traces.jsonl (~/.meetless/logs/report-citations.jsonl), keyed by
// (session_id, turn_index), so A1 can join inject / pull / push-reference all
// locally. The citation grammar is the single shared common.sh helper
// extract_source_ids, used by both the pull side and this push-reference side.

const HOOKS_DIR = path.resolve(__dirname, "../../src/hooks-template");
const COMMON = path.join(HOOKS_DIR, "common.sh");
const HOOK = "stop.sh";

interface Harness {
  fire: (input: object) => number;
  reportCitations: () => any[];
  queueFiles: () => string[];
  writeTranscript: (lines: object[]) => string;
  seedTurn: (sessionId: string, n: number) => void;
  readTurn: (sessionId: string) => string | null;
  tmp: string;
}

function mkHarness(activate = true): { h: Harness; cleanup: () => void } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-reportcap-"));
  fs.copyFileSync(COMMON, path.join(tmp, "common.sh"));
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
      mlaPath: "/bin/true",
    }),
  );
  const workdir = path.join(tmp, "workdir");
  fs.mkdirSync(workdir);
  if (activate) fs.writeFileSync(path.join(workdir, ".meetless.json"), "{}\n");

  const queueDir = path.join(home, "queue");
  const logsDir = path.join(home, "logs");

  const h: Harness = {
    tmp,
    fire: (input: object) => {
      const r = spawnSync("bash", [path.join(tmp, HOOK)], {
        input: JSON.stringify(input),
        encoding: "utf8",
        cwd: workdir,
        // Stop spawns a detached flusher; keep it quiet and let it fail closed.
        env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0" },
      });
      return r.status ?? -1;
    },
    reportCitations: () => {
      const p = path.join(logsDir, "report-citations.jsonl");
      if (!fs.existsSync(p)) return [];
      return fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    },
    queueFiles: () =>
      fs.existsSync(queueDir)
        ? fs.readdirSync(queueDir).filter((f) => f.endsWith(".jsonl"))
        : [],
    writeTranscript: (lines: object[]) => {
      const p = path.join(tmp, "transcript.jsonl");
      fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return p;
    },
    seedTurn: (sessionId: string, n: number) => {
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(path.join(queueDir, `${sessionId}.turn`), String(n));
    },
    readTurn: (sessionId: string) => {
      const p = path.join(queueDir, `${sessionId}.turn`);
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
    },
  };
  return { h, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

// A minimal modern-transcript assistant entry with one text block.
function assistantText(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("stop.sh: citation extractor over the agent's final report (P3)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  it("extracts source_ids cited in the final assistant message, keyed to the current turn", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-1", 7);
      const transcript = h.writeTranscript([
        assistantText("earlier turn [NT:ignore-me-not-last]"),
        { type: "user", message: { content: [{ type: "text", text: "do it" }] } },
        assistantText(
          "Done. Per [NT:20260603-mla-kb-agent-proxy-and-evidence-adoption] and [DD:abc123] this is governed.",
        ),
      ]);
      const status = h.fire({ session_id: "sess-1", transcript_path: transcript });
      expect(status).toBe(0);

      const recs = h.reportCitations();
      expect(recs.length).toBe(1);
      const r = recs[0];
      expect(r.event).toBe("report_citations");
      expect(r.session_id).toBe("sess-1");
      expect(r.turn_index).toBe(7);
      expect(r.source_ids).toEqual(
        expect.arrayContaining([
          "NT:20260603-mla-kb-agent-proxy-and-evidence-adoption",
          "DD:abc123",
        ]),
      );
      // Only the LAST assistant message is the final report.
      expect(r.source_ids).not.toContain("NT:ignore-me-not-last");
    } finally {
      cleanup();
    }
  });

  it("writes an empty source_ids array when the final report cites nothing (A1b denominator signal)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-2", 1);
      const transcript = h.writeTranscript([
        assistantText("All set, no citations in this answer."),
      ]);
      h.fire({ session_id: "sess-2", transcript_path: transcript });
      const r = h.reportCitations()[0];
      expect(r.source_ids).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("reads the turn counter WITHOUT advancing it", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-3", 4);
      const transcript = h.writeTranscript([assistantText("cite [TH:theme-1]")]);
      h.fire({ session_id: "sess-3", transcript_path: transcript });
      expect(h.readTurn("sess-3")).toBe("4");
      expect(h.reportCitations()[0].turn_index).toBe(4);
    } finally {
      cleanup();
    }
  });

  it("still spools the session_stopped + finalize events (no regression)", () => {
    const { h, cleanup } = mkHarness();
    try {
      h.seedTurn("sess-4", 1);
      const transcript = h.writeTranscript([assistantText("done [DD:x]")]);
      h.fire({ session_id: "sess-4", transcript_path: transcript });
      expect(h.queueFiles()).toEqual(["sess-4.jsonl"]);
    } finally {
      cleanup();
    }
  });

  it("stays DORMANT (no report-citations) when the folder is not activated", () => {
    const { h, cleanup } = mkHarness(false);
    try {
      h.seedTurn("sess-5", 1);
      const transcript = h.writeTranscript([assistantText("cite [NT:foo]")]);
      const status = h.fire({ session_id: "sess-5", transcript_path: transcript });
      expect(status).toBe(0);
      expect(h.reportCitations()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("drift guard: stop.sh extracts report citations into the local file", () => {
    const src = fs.readFileSync(path.join(HOOKS_DIR, HOOK), "utf8");
    expect(src).toContain("report-citations.jsonl");
    expect(src).toMatch(/extract_source_ids/);
  });
});

// The shared extractor itself: one grammar for BOTH the pull side
// (post-tool-use.sh) and the push-reference side (stop.sh). Sourcing common.sh
// and calling the function directly locks the grammar (dedup, sort, empty -> []).
describe("common.sh extract_source_ids (P3 shared grammar)", () => {
  beforeAll(() => {
    if (spawnSync("jq", ["--version"]).status !== 0) throw new Error("jq required");
  });

  function extract(text: string): string[] {
    const r = spawnSync(
      "bash",
      ["-c", `source "${COMMON}"; extract_source_ids "$1"`, "bash", text],
      { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: os.tmpdir() } },
    );
    if (r.status !== 0) throw new Error(`extract_source_ids failed: ${r.stderr}`);
    return JSON.parse(r.stdout.trim());
  }

  it("pulls every supported evidence token, sorted and de-duplicated", () => {
    const out = extract("see [NT:a] and [DD:b] and again [NT:a] plus [TH:c]");
    expect(out).toEqual(["DD:b", "NT:a", "TH:c"]);
  });

  it("recognizes the op tokens (CC/PP/PT/RC/WA/AU/DM)", () => {
    const out = extract("[CC:x] [PP:y] [PT:z] [RC:r] [WA:w] [AU:u] [DM:d]");
    expect(out).toEqual(
      expect.arrayContaining(["CC:x", "PP:y", "PT:z", "RC:r", "WA:w", "AU:u", "DM:d"]),
    );
  });

  it("returns an empty array (never a bare value) when there are no citations", () => {
    expect(extract("no citations at all")).toEqual([]);
    expect(extract("")).toEqual([]);
  });

  it("accepts dotted / hyphenated ids and bare (unbracketed) tokens", () => {
    expect(extract("NT:20260603-mla-kb.v2")).toEqual(["NT:20260603-mla-kb.v2"]);
  });

  it("drift guard: extract_source_ids is defined in common.sh", () => {
    const src = fs.readFileSync(COMMON, "utf8");
    expect(src).toMatch(/extract_source_ids\(\) \{/);
  });
});
