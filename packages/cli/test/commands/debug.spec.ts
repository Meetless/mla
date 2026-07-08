import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { runDebug, parseArgs, BackendResult } from "../../src/commands/debug";
import { readStoredZip } from "../../src/lib/zip";

// `mla debug bundle` (Phase 5 / spec gap 6.7). These tests drive the real
// command end-to-end against a temp HOME, injecting the clock and the backend
// fetcher so nothing touches a network or a wall clock. The bundle is read back
// with readStoredZip and its contents asserted: the four safety guarantees from
// the spec (shape-guard reject, manifest present, redaction report present, raw
// payloads excluded by default) each get a test.

const VALID_ID = "a".repeat(32);

// A backend fetcher that never reaches the network: returns a fixed, already-
// "summarized" blob (with a payload-bearing key to prove redaction reaches it).
const fakeBackend = async (): Promise<BackendResult> => ({
  summary: { status: "ok", note: "from-backend" },
  langfuseProjectId: "p_test",
  warning: null,
});

function readBundle(home: string, traceId: string) {
  const zipPath = path.join(home, "debug", `${traceId}.zip`);
  const entries = readStoredZip(fs.readFileSync(zipPath));
  const byName = new Map(entries.map((e) => [e.name, e.data.toString("utf8")]));
  return { zipPath, entries, byName };
}

describe("debug bundle: argv parsing", () => {
  it("requires --trace-id", () => {
    expect(() => parseArgs([])).toThrow(/requires --trace-id/);
  });

  it("rejects a value-flag with no value", () => {
    expect(() => parseArgs(["--trace-id"])).toThrow(/Missing value/);
  });

  it("rejects a value-flag swallowing the next flag", () => {
    expect(() => parseArgs(["--trace-id", "--out"])).toThrow(/got the next flag/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--trace-id", VALID_ID, "--nope"])).toThrow(/Unknown flag/);
  });

  it("parses the include flags and --yes", () => {
    const f = parseArgs(["--trace-id", VALID_ID, "--include-prompts", "--include-diffs", "-y"]);
    expect(f.includePrompts).toBe(true);
    expect(f.includeDiffs).toBe(true);
    expect(f.yes).toBe(true);
  });
});

describe("debug bundle: command behavior (P5-T5)", () => {
  let home: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mla-debug-"));
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("rejects a malformed --trace-id up front (OBS-1 guard), writing nothing", async () => {
    const rc = await runDebug(["bundle", "--trace-id", "not-a-trace-id"], {
      home,
      backendFetcher: fakeBackend,
    });
    expect(rc).toBe(2);
    expect(fs.existsSync(path.join(home, "debug"))).toBe(false);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/32 lowercase hex/);
  });

  it("rejects an upper-case (non-canonical) trace id", async () => {
    const rc = await runDebug(["bundle", "--trace-id", "A".repeat(32)], {
      home,
      backendFetcher: fakeBackend,
    });
    expect(rc).toBe(2);
  });

  it("rejects an unknown subcommand", async () => {
    const rc = await runDebug(["frobnicate"], { home, backendFetcher: fakeBackend });
    expect(rc).toBe(2);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/Unknown debug subcommand/);
  });

  it("writes a bundle whose first entry is manifest.json with the core fields", async () => {
    const rc = await runDebug(["bundle", "--trace-id", VALID_ID, "--command", "ask"], {
      home,
      backendFetcher: fakeBackend,
      now: () => "2026-06-07T00:00:00.000Z",
    });
    expect(rc).toBe(0);
    const { entries, byName } = readBundle(home, VALID_ID);
    expect(entries[0].name).toBe("manifest.json");
    const manifest = JSON.parse(byName.get("manifest.json")!);
    expect(manifest.trace_id).toBe(VALID_ID);
    expect(manifest.created_at).toBe("2026-06-07T00:00:00.000Z");
    expect(manifest.command).toBe("ask");
    expect(typeof manifest.telemetry_enabled).toBe("boolean");
    expect(Array.isArray(manifest.files)).toBe(true);
    // manifest never lists itself
    expect(manifest.files).not.toContain("manifest.json");
  });

  it("includes a mandatory redaction report and a README", async () => {
    await runDebug(["bundle", "--trace-id", VALID_ID], { home, backendFetcher: fakeBackend });
    const { byName } = readBundle(home, VALID_ID);
    expect(byName.has("redaction-report.json")).toBe(true);
    expect(byName.has("README.txt")).toBe(true);
    const report = JSON.parse(byName.get("redaction-report.json")!);
    expect(report.raw_payloads_included).toEqual({ prompts: false, diffs: false, secrets: false });
    expect(report.redactors_run.length).toBeGreaterThan(0);
    expect(byName.get("README.txt")).toMatch(/generated locally/i);
    expect(byName.get("README.txt")).toMatch(/uploaded/i);
  });

  it("always includes offline deep-link search hints for the trace id", async () => {
    await runDebug(["bundle", "--trace-id", VALID_ID, "--no-backend"], { home });
    const { byName } = readBundle(home, VALID_ID);
    const links = byName.get("deep-links.txt")!;
    expect(links).toContain(VALID_ID);
    expect(links).toMatch(/Langfuse/);
    expect(links).toMatch(/Sentry/);
  });

  it("excludes raw payloads by default and counts the redactions", async () => {
    // Seed a local log line carrying the trace id AND payload-bearing keys.
    const logsDir = path.join(home, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "kb-knowledge.jsonl"),
      JSON.stringify({
        trace_id: VALID_ID,
        prompt: "SECRET PROMPT TEXT",
        diff: "SECRET DIFF",
        status: "ok",
      }) + "\n",
    );

    await runDebug(["bundle", "--trace-id", VALID_ID, "--no-backend"], { home });
    const { byName } = readBundle(home, VALID_ID);
    const logBlob = byName.get("logs/kb-knowledge.jsonl")!;
    expect(logBlob).not.toContain("SECRET PROMPT TEXT");
    expect(logBlob).not.toContain("SECRET DIFF");
    expect(logBlob).toContain("[REDACTED:prompts]");
    expect(logBlob).toContain("[REDACTED:diffs]");
    // status (a non-payload field) survives so the log stays inspectable.
    expect(logBlob).toContain("\"status\":\"ok\"");

    const report = JSON.parse(byName.get("redaction-report.json")!);
    expect(report.redacted_counts.prompts).toBeGreaterThanOrEqual(1);
    expect(report.redacted_counts.diffs).toBeGreaterThanOrEqual(1);
  });

  it("scrubs secrets and LLM-output content under keys NOT in the prompt/diff denylist", async () => {
    // The denylist alone is unwinnable: payloads hide under keys it never named.
    // Layer 1 must catch LLM-output keys (completion, llm_response) and credential
    // keys (api_key, authorization); Layer 2 (the value scrubber) must catch a
    // token sitting under a totally unlisted key (custom_field). None of these
    // were in the original denylist, so this is the regression guard for CRITICAL-1.
    const SK = "sk-proj-abcdefghij1234567890ABCDEFGH";
    const GHP_BARE = "ghp_abcdefghij1234567890ABCDEFGH";
    const GHP_BEARER = "Bearer ghp_zyxwvut987654321ABCDEFGH";
    const logsDir = path.join(home, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "kb-knowledge.jsonl"),
      JSON.stringify({
        trace_id: VALID_ID,
        completion: "SECRET LLM OUTPUT",
        llm_response: "MORE SECRET OUTPUT",
        api_key: SK,
        authorization: GHP_BEARER,
        custom_field: GHP_BARE, // unlisted key; only the value scrubber can save us
        status: "ok",
      }) + "\n",
    );

    await runDebug(["bundle", "--trace-id", VALID_ID, "--no-backend"], { home });
    const { byName } = readBundle(home, VALID_ID);
    const logBlob = byName.get("logs/kb-knowledge.jsonl")!;

    // No content, no credential survives anywhere in the bundle.
    expect(logBlob).not.toContain("SECRET LLM OUTPUT");
    expect(logBlob).not.toContain("MORE SECRET OUTPUT");
    expect(logBlob).not.toContain(SK);
    expect(logBlob).not.toContain(GHP_BARE);
    expect(logBlob).not.toContain("ghp_zyxwvut987654321ABCDEFGH");
    // Markers prove which layer fired.
    expect(logBlob).toContain("[REDACTED:prompts]"); // completion / llm_response
    expect(logBlob).toContain("[REDACTED:secrets]"); // api_key / authorization
    expect(logBlob).toContain("[REDACTED]"); // Layer 2 scrubber on custom_field
    // The trace id (join key) and a benign field stay readable.
    expect(logBlob).toContain(VALID_ID);
    expect(logBlob).toContain('"status":"ok"');

    const report = JSON.parse(byName.get("redaction-report.json")!);
    expect(report.redacted_counts.secrets).toBeGreaterThanOrEqual(1);
    expect(report.raw_payloads_included.secrets).toBe(false);
  });

  it("scrubs a credential from a non-JSON plaintext line, preserving the trace id (CRITICAL-2 guard)", async () => {
    // A .log line that is not JSON used to pass through verbatim. A plaintext
    // "Authorization: Bearer ghp_..." must still be scrubbed. The scoped trace
    // id (a real high-entropy hex id, which the entropy heuristic WOULD redact
    // without the sentinel) must survive so the bundle stays greppable.
    const HEX_ID = "3f9a2b1c4d5e6f70819293a4b5c6d7e8"; // 32 lowercase hex, high entropy
    const GHP = "ghp_plaintextSECRET1234567890ABCD";
    const logsDir = path.join(home, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "app.log"),
      `2026-06-07 12:00:00 trace=${HEX_ID} Authorization: Bearer ${GHP} request failed\n`,
    );

    await runDebug(["bundle", "--trace-id", HEX_ID, "--no-backend"], { home });
    const { byName } = readBundle(home, HEX_ID);
    const logBlob = byName.get("logs/app.log")!;

    expect(logBlob).not.toContain(GHP);
    expect(logBlob).toContain("[REDACTED]");
    // Surrounding plaintext and the trace id stay intact (over-redaction would
    // make the bundle useless).
    expect(logBlob).toContain(HEX_ID);
    expect(logBlob).toContain("request failed");

    const report = JSON.parse(byName.get("redaction-report.json")!);
    expect(report.redacted_counts.secrets).toBeGreaterThanOrEqual(1);
  });

  it("keeps deliberately-included prompts but still scrubs embedded credentials", async () => {
    // --include-prompts re-exposes content, NOT secrets: a credential embedded
    // inside an included prompt must still be stripped by Layer 2.
    const GHP = "ghp_embeddedINprompt1234567890ABCD";
    const logsDir = path.join(home, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "x.jsonl"),
      JSON.stringify({ trace_id: VALID_ID, prompt: `call the API with token ${GHP} now` }) + "\n",
    );

    const rc = await runDebug(
      ["bundle", "--trace-id", VALID_ID, "--no-backend", "--include-prompts", "--yes"],
      { home },
    );
    expect(rc).toBe(0);
    const { byName } = readBundle(home, VALID_ID);
    const logBlob = byName.get("logs/x.jsonl")!;
    // The prose survives (content was opted in) but the token does not.
    expect(logBlob).toContain("call the API with token");
    expect(logBlob).not.toContain(GHP);
    expect(logBlob).toContain("[REDACTED]");
  });

  it("includes raw payloads when --include-prompts/--include-diffs + --yes are passed", async () => {
    const logsDir = path.join(home, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "kb-knowledge.jsonl"),
      JSON.stringify({ trace_id: VALID_ID, prompt: "KEEP ME", diff: "KEEP DIFF" }) + "\n",
    );

    const rc = await runDebug(
      ["bundle", "--trace-id", VALID_ID, "--no-backend", "--include-prompts", "--include-diffs", "--yes"],
      { home },
    );
    expect(rc).toBe(0);
    const { byName } = readBundle(home, VALID_ID);
    const logBlob = byName.get("logs/kb-knowledge.jsonl")!;
    expect(logBlob).toContain("KEEP ME");
    expect(logBlob).toContain("KEEP DIFF");
    expect(logBlob).not.toContain("[REDACTED");
    const report = JSON.parse(byName.get("redaction-report.json")!);
    expect(report.raw_payloads_included).toEqual({ prompts: true, diffs: true, secrets: false });
  });

  it("refuses raw-payload include flags non-interactively without --yes", async () => {
    const rc = await runDebug(
      ["bundle", "--trace-id", VALID_ID, "--no-backend", "--include-prompts"],
      { home, isTTY: false },
    );
    expect(rc).toBe(2);
    expect(fs.existsSync(path.join(home, "debug", `${VALID_ID}.zip`))).toBe(false);
    expect(errSpy.mock.calls.flat().join(" ")).toMatch(/non-interactively/);
  });

  it("honors an interactive confirm: yes includes, no aborts", async () => {
    const logsDir = path.join(home, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, "x.jsonl"),
      JSON.stringify({ trace_id: VALID_ID, prompt: "P" }) + "\n",
    );

    // declines -> abort, no file
    const rcNo = await runDebug(
      ["bundle", "--trace-id", VALID_ID, "--no-backend", "--include-prompts"],
      { home, isTTY: true, confirm: async () => false },
    );
    expect(rcNo).toBe(1);
    expect(fs.existsSync(path.join(home, "debug", `${VALID_ID}.zip`))).toBe(false);

    // confirms -> writes with the payload
    const rcYes = await runDebug(
      ["bundle", "--trace-id", VALID_ID, "--no-backend", "--include-prompts"],
      { home, isTTY: true, confirm: async () => true },
    );
    expect(rcYes).toBe(0);
    const { byName } = readBundle(home, VALID_ID);
    expect(byName.get("logs/x.jsonl")).toContain("\"prompt\":\"P\"");
  });

  it("folds a backend summary in and records its warning when the fetch fails", async () => {
    const failing = async (): Promise<BackendResult> => ({
      summary: null,
      langfuseProjectId: null,
      warning: "backend unreachable",
    });
    await runDebug(["bundle", "--trace-id", VALID_ID], { home, backendFetcher: failing });
    const { byName } = readBundle(home, VALID_ID);
    // no backend-summary.json on failure, but the warning is recorded
    expect(byName.has("backend-summary.json")).toBe(false);
    const manifest = JSON.parse(byName.get("manifest.json")!);
    expect(manifest.backend_summary_present).toBe(false);
    expect(manifest.warnings).toContain("backend unreachable");

    // and a successful fetch lands backend-summary.json
    fs.rmSync(path.join(home, "debug"), { recursive: true, force: true });
    await runDebug(["bundle", "--trace-id", VALID_ID], { home, backendFetcher: fakeBackend });
    const ok = readBundle(home, VALID_ID);
    expect(ok.byName.has("backend-summary.json")).toBe(true);
    expect(ok.byName.get("backend-summary.json")).toContain("from-backend");
  });

  it("--no-backend produces a local-only bundle with a warning, no network", async () => {
    let called = false;
    const spyBackend = async (): Promise<BackendResult> => {
      called = true;
      return { summary: null, langfuseProjectId: null, warning: null };
    };
    const rc = await runDebug(["bundle", "--trace-id", VALID_ID, "--no-backend"], {
      home,
      backendFetcher: spyBackend,
    });
    expect(rc).toBe(0);
    expect(called).toBe(false);
    const { byName } = readBundle(home, VALID_ID);
    const manifest = JSON.parse(byName.get("manifest.json")!);
    expect(manifest.warnings.join(" ")).toMatch(/--no-backend/);
  });

  it("writes to a custom --out path", async () => {
    const out = path.join(home, "custom", "mybundle.zip");
    const rc = await runDebug(["bundle", "--trace-id", VALID_ID, "--no-backend", "--out", out], {
      home,
    });
    expect(rc).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const entries = readStoredZip(fs.readFileSync(out));
    expect(entries[0].name).toBe("manifest.json");
  });
});
