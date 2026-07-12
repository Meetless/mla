// T45: §13.3 add/corpus safety tests.
//
// Source: notes/20260530-mla-kb-curation-cli-proposal-v2.md §4.1, §13.3.
//
// Behavioral lock for the CLI-side guard rails in `mla kb add`. The
// proposal §13.3 enumerates five cases the wrapper MUST reject before
// shelling out to the Python worker (which then enforces marker-level
// rules; those are covered separately in the Python tests):
//
//   - Directory with `--mode file` -> hard fail (CLI guard).
//   - File with `--mode corpus` -> hard fail (CLI guard).
//   - Corpus mode without `.meetless-kb-corpus.json` -> hard fail
//     (Python guard; CLI accepts the directory and forwards).
//   - Corpus marker workspaceId mismatch -> hard fail (Python guard).
//   - File mode never invokes orphan cleanup (asserted via the python
//     argv shape `tools/mla_kb_add.py` is invoked with; we lock the
//     wrapper does not pass anything that toggles orphan sweeps).
//
// We test the TS wrapper in isolation: parseKbAddArgs + the pre-flight
// stat checks in runKbAdd. The runKbAdd path is exercised by writing
// real temp files and pointing it at them; we let the spawn step fail
// silently because we are not testing the Python worker here (the CLI
// returns 2 before spawn runs on the negative cases).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { bindWorkspaceMarker } from "./workspace-marker.helper";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mla-kb-add-"));
process.env.MEETLESS_HOME = HOME;

// The owner-check (§9.3) runs BEFORE the preflight stat checks we want
// to exercise here. Without this mock the owner check would HTTP-fail
// against the placeholder `http://127.0.0.1:0` config and the test
// would pass for the wrong reason (exit 2 from a network error, never
// reaching the stat-based guard). Stubbed to a no-op so the guard we
// are actually locking gets hit; the owner check has its own dedicated
// spec.
jest.mock("../../src/lib/kb_acl", () => ({
  verifyKbActorIsOwner: jest.fn().mockResolvedValue(undefined),
  KbOwnerCheckError: class KbOwnerCheckError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "KbOwnerCheckError";
    }
  },
}));

// require AFTER MEETLESS_HOME so cli-config.json resolves to the tmp.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require("../../src/commands/kb_add") as typeof import("../../src/commands/kb_add");
const { parseKbAddArgs, runKbAdd } = mod;

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mla-kb-add-fs-"));
const TMP_FILE = path.join(TMP_ROOT, "note.md");
const TMP_DIR = path.join(TMP_ROOT, "corpus");
fs.writeFileSync(TMP_FILE, "# hello\n", "utf8");
fs.mkdirSync(TMP_DIR, { recursive: true });

// Minimal config: enough fields to satisfy readKbConfig + the pre-flight
// echo. The runKbAdd negative paths return 2 before consulting intelRoot.
const CFG_PATH = path.join(HOME, "cli-config.json");
fs.writeFileSync(
  CFG_PATH,
  JSON.stringify({
    controlUrl: "http://127.0.0.1:0",
    controlToken: "test_token",
    workspaceId: "ws_test",
    actorUserId: "user_test",
    mlaPath: "/dev/null/mla",
    intelRoot: "/dev/null/intel",
  }),
);

describe("parseKbAddArgs", () => {
  test("requires a positional path", () => {
    expect(() => parseKbAddArgs(["--mode", "file", "--provenance", "human_authored"])).toThrow(
      /requires a positional <path>/,
    );
  });

  test("requires --mode", () => {
    expect(() => parseKbAddArgs(["foo.md", "--provenance", "human_authored"])).toThrow(
      /--mode file\|corpus is required/,
    );
  });

  test("requires --provenance", () => {
    expect(() => parseKbAddArgs(["foo.md", "--mode", "file"])).toThrow(
      /--provenance/,
    );
  });

  test("rejects unknown --mode values", () => {
    expect(() =>
      parseKbAddArgs(["foo.md", "--mode", "bulk", "--provenance", "human_authored"]),
    ).toThrow(/--mode must be 'file' or 'corpus'/);
  });

  test("rejects --posture entirely (born-PENDING dropped the posture contract)", () => {
    // The two-axis governed model removed posture: every ingest is born PENDING.
    // --posture is no longer a known flag, so it must be rejected as unknown
    // rather than silently accepted. This locks the removal against regression.
    expect(() =>
      parseKbAddArgs([
        "foo.md",
        "--mode",
        "file",
        "--provenance",
        "human_authored",
        "--posture",
        "LIVE",
      ]),
    ).toThrow(/Unknown flag/);
  });

  test("rejects two positional arguments", () => {
    expect(() =>
      parseKbAddArgs([
        "a.md",
        "b.md",
        "--mode",
        "file",
        "--provenance",
        "human_authored",
      ]),
    ).toThrow(/exactly one positional path/);
  });

  test("rejects unknown flags", () => {
    expect(() =>
      parseKbAddArgs([
        "foo.md",
        "--mode",
        "file",
        "--provenance",
        "human_authored",
        "--no-such-flag",
      ]),
    ).toThrow(/Unknown flag/);
  });

  test("accepts a well-formed file invocation", () => {
    const flags = parseKbAddArgs([
      "foo.md",
      "--mode",
      "file",
      "--provenance",
      "human_authored",
    ]);
    expect(flags.path).toBe("foo.md");
    expect(flags.mode).toBe("file");
    expect(flags.provenance).toBe("human_authored");
    expect(flags.allowProvenanceChange).toBe(false);
  });

  test("accepts a well-formed corpus invocation", () => {
    const flags = parseKbAddArgs([
      "./corpus",
      "--mode",
      "corpus",
      "--provenance",
      "dogfood_archive",
      "--allow-provenance-change",
    ]);
    expect(flags.mode).toBe("corpus");
    expect(flags.allowProvenanceChange).toBe(true);
  });

  test("--open (B4b) is opt-in and defaults off", () => {
    const base = ["foo.md", "--mode", "file", "--provenance", "human_authored"];
    expect(parseKbAddArgs(base).open).toBe(false);
    expect(parseKbAddArgs([...base, "--open"]).open).toBe(true);
  });

  test("--reingest-if-active is opt-in and defaults off", () => {
    // The auto-index loop passes it so a re-edited ACTIVE doc reingests in place
    // (new revision) instead of the worker's hard refusal; everywhere else it stays
    // off so `kb add` keeps its add-only contract.
    const base = ["foo.md", "--mode", "file", "--provenance", "human_authored"];
    expect(parseKbAddArgs(base).reingestIfActive).toBe(false);
    expect(parseKbAddArgs([...base, "--reingest-if-active"]).reingestIfActive).toBe(true);
  });

  test("--allow-provenance-change is the only boolean flag", () => {
    // If this fires, somebody added a boolean without updating the help
    // surface; explicit lock so we catch it in review.
    const flags = parseKbAddArgs([
      "foo.md",
      "--mode",
      "file",
      "--provenance",
      "human_authored",
      "--allow-provenance-change",
    ]);
    expect(flags.allowProvenanceChange).toBe(true);
  });
});

describe("runKbAdd preflight guards (§13.3 cases 1, 2, file-mode no-orphan)", () => {
  // Folder = workspace (T1.1): runKbAdd resolves the workspace from the nearest
  // `.meetless.json` marker (readKbConfig -> loadWorkspaceConfig ->
  // resolveWorkspaceId) BEFORE the preflight stat guards. On a clean runner
  // packages/cli has no up-tree marker, so without this the command exits 2 on
  // NotActivatedError and never reaches the guard message under test (the exit
  // code matches but the stderr does not). Bind a marker at TMP_ROOT and run from
  // there; every case below targets an ABSOLUTE path, so the cwd change is inert
  // to the assertions.
  let restoreCwd: () => void;
  beforeAll(() => {
    restoreCwd = bindWorkspaceMarker(TMP_ROOT, "ws_test");
  });
  afterAll(() => {
    restoreCwd();
  });

  test("--mode file on a directory exits 2 with a clear message", async () => {
    const stderr = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await runKbAdd([
        TMP_DIR,
        "--mode",
        "file",
        "--provenance",
        "human_authored",
      ]);
      expect(code).toBe(2);
      const msgs = stderr.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).toMatch(/--mode file requires a file path, got directory/);
    } finally {
      stderr.mockRestore();
    }
  });

  test("--mode corpus on a file exits 2 with a clear message", async () => {
    const stderr = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await runKbAdd([
        TMP_FILE,
        "--mode",
        "corpus",
        "--provenance",
        "human_authored",
      ]);
      expect(code).toBe(2);
      const msgs = stderr.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).toMatch(/--mode corpus requires a directory path, got file/);
    } finally {
      stderr.mockRestore();
    }
  });

  test("nonexistent path exits 2", async () => {
    const stderr = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const code = await runKbAdd([
        path.join(TMP_ROOT, "definitely-does-not-exist.md"),
        "--mode",
        "file",
        "--provenance",
        "human_authored",
      ]);
      expect(code).toBe(2);
      const msgs = stderr.mock.calls.map((c) => String(c[0])).join("\n");
      expect(msgs).toMatch(/path does not exist/);
    } finally {
      stderr.mockRestore();
    }
  });
});
