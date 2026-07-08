import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  buildDiagnosticBundle,
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  DiagnosticBundleInputs,
} from "../../src/lib/diagnostic-bundle";
import { readStoredZip } from "../../src/lib/zip";
import { hashWorkspaceId } from "../../src/lib/debug-bundle";

// The safe diagnostic exporter for `mla bug report`
// (notes/20260705-mla-bug-report-command-proposal.md §3.2). Phase 0: the
// highest-risk piece, so it is tested FIRST and adversarially.
//
// The contract these tests pin is ALLOWLIST-FIRST, not denylist-scrubbed:
//   - Only a fixed set of structured fields is ever emitted, each enum- or
//     shape-constrained. A field the projection does not know about is dropped
//     and counted, never passed through (adversarial: injected free-form text
//     in a novel key must not appear in the bundle).
//   - The two sources are events.jsonl and telemetry-deadletter.jsonl ONLY. No
//     raw logs, database, or transcript is read.
//   - scanForCredentials runs as Layer-2 defense-in-depth over every emitted
//     scalar; a hit is redacted and counted (it should be 0 by design).
//   - The 32-hex trace id is NEVER redacted (it is the join key; the scanner has
//     no entropy heuristic, so it survives).
//
// Every test drives the real pure core against a temp HOME with an injected
// clock/bundle-id, then reads the zip back with readStoredZip and asserts the
// projected contents.

const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mla-bug-bundle-"));
}

// Write objects as jsonl into <home>/<file>.
function writeJsonl(home: string, file: string, records: unknown[]): void {
  fs.writeFileSync(
    path.join(home, file),
    records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""),
    "utf8",
  );
}

// A realistic mla_command analytics event (matches CommandPayload + envelope).
function commandEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    event_id: "evt_" + Math.abs(hashCode(JSON.stringify(over))),
    event_type: "mla_command",
    created_at: "2026-07-05T12:00:00.000Z",
    emitted_at: "2026-07-05T12:00:00.500Z",
    workspace_id: "ws_realcuid1234567890",
    distinct_id: "u_abc",
    session_id: SESSION_A,
    run_id: "run-1234",
    trace_id: TRACE_A,
    source: "cli",
    attribution: { source: "mla", sourceProduct: "MLA" },
    // payload
    command: "bug",
    subcommand: "report",
    flags_shape: ["--trace-id"],
    scope: "workspace",
    duration_ms: 42,
    exit_code: 0,
    outcome: "success",
    error_class: null,
    retryable: false,
    touched_surface: "unknown",
    mla_version: "1.4.2",
    git_sha: "abc1234",
    command_index_in_session: 3,
    preceded_by: "status",
    session_idle_gap_ms: 1000,
    ...over,
  };
}

function deadletterRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    created_at: "2026-07-05T12:00:00.000Z",
    expires_at: "2026-07-12T12:00:00.000Z",
    attempts: 1,
    last_attempt_at: null,
    failure_class: "telemetry_upload_failed",
    event: {
      event_type: "mla_command",
      trace_id: TRACE_A,
      session_id: SESSION_A,
      severity: "error",
      metadata_only_context: { status: 500, reason_code: "backend-5xx" },
    },
    ...over,
  };
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function baseInputs(home: string, over: Partial<DiagnosticBundleInputs> = {}): DiagnosticBundleInputs {
  return {
    home,
    selector: { traceId: TRACE_A, sessionId: null },
    createdAt: "2026-07-05T12:34:56.000Z",
    bundleId: "bundle-fixed-uuid",
    mlaVersion: "1.4.2",
    now: Date.parse("2026-07-05T13:00:00.000Z"),
    ...over,
  };
}

function readZip(zip: Buffer) {
  const entries = readStoredZip(zip);
  const byName = new Map(entries.map((e) => [e.name, e.data.toString("utf8")]));
  return { entries, byName };
}

function parseJsonl(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("diagnostic-bundle: structure + positive utility", () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("emits the fixed four-file set plus a manifest, always", () => {
    writeJsonl(home, "events.jsonl", [commandEvent()]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    expect([...byName.keys()].sort()).toEqual([
      "environment.json",
      "errors.jsonl",
      "manifest.json",
      "redaction-report.json",
      "trace-events.jsonl",
    ]);
  });

  it("produces a valid store-only zip that round-trips through readStoredZip", () => {
    writeJsonl(home, "events.jsonl", [commandEvent()]);
    const built = buildDiagnosticBundle(baseInputs(home));
    // readStoredZip verifies CRC per entry; a throw here means corruption.
    expect(() => readStoredZip(built.zip)).not.toThrow();
  });

  it("carries the useful, structured signal a debugger needs (positive utility)", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ command: "diff", subcommand: "create", outcome: "success" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const events = parseJsonl(byName.get("trace-events.jsonl")!);
    expect(events).toHaveLength(1);
    const e = events[0];
    // The bundle must be USEFUL, not just safe: the command, its outcome,
    // timing, exit code, version, and join keys all survive.
    expect(e.command).toBe("diff");
    expect(e.subcommand).toBe("create");
    expect(e.eventType).toBe("mla_command");
    expect(e.outcome).toBe("success");
    expect(e.exitCode).toBe(0);
    expect(e.durationMs).toBe(42);
    expect(e.mlaVersion).toBe("1.4.2");
    expect(e.gitSha).toBe("abc1234");
    expect(e.traceId).toBe(TRACE_A);
    expect(e.sessionId).toBe(SESSION_A);
  });

  it("manifest describes the bundle with counts + hashed workspace", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ outcome: "system_error", error_class: "BackendError" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const manifest = JSON.parse(byName.get("manifest.json")!);
    expect(manifest.schema_version).toBe(DIAGNOSTIC_BUNDLE_SCHEMA_VERSION);
    expect(manifest.bundle_id).toBe("bundle-fixed-uuid");
    expect(manifest.created_at).toBe("2026-07-05T12:34:56.000Z");
    expect(manifest.trace_id).toBe(TRACE_A);
    expect(manifest.mla_version).toBe("1.4.2");
    expect(manifest.trace_event_count).toBe(1);
    expect(manifest.error_count).toBe(1);
    // workspace id is hashed, never raw.
    expect(manifest.workspace_id_hash).toBe(hashWorkspaceId("ws_realcuid1234567890"));
    expect(manifest.workspace_id_hash).not.toContain("ws_realcuid");
  });

  it("environment.json carries only fixed fields (no hostname/username)", () => {
    writeJsonl(home, "events.jsonl", [commandEvent()]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const env = JSON.parse(byName.get("environment.json")!);
    expect(Object.keys(env).sort()).toEqual(["arch", "mlaVersion", "nodeVersion", "platform"]);
    expect(env.platform).toBe(os.platform());
    expect(env.arch).toBe(os.arch());
    // No hostname, username, home dir, or raw uname anywhere.
    const blob = JSON.stringify(env);
    expect(blob).not.toContain(os.hostname());
    expect(blob).not.toContain(os.userInfo().username);
  });

  it("empty home yields a valid, empty bundle (fresh box, no crash)", () => {
    const built = buildDiagnosticBundle(baseInputs(home));
    expect(built.traceEventCount).toBe(0);
    expect(built.errorCount).toBe(0);
    const { byName } = readZip(built.zip);
    expect(byName.get("trace-events.jsonl")).toBe("");
    expect(byName.get("errors.jsonl")).toBe("");
    const manifest = JSON.parse(byName.get("manifest.json")!);
    expect(manifest.trace_event_count).toBe(0);
  });
});

describe("diagnostic-bundle: selection", () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("filters by trace id: only the target trace is included", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ trace_id: TRACE_A, command: "keep" }),
      commandEvent({ trace_id: TRACE_B, command: "drop" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home, { selector: { traceId: TRACE_A, sessionId: null } }));
    const { byName } = readZip(built.zip);
    const events = parseJsonl(byName.get("trace-events.jsonl")!);
    expect(events.map((e) => e.command)).toEqual(["keep"]);
  });

  it("filters by session id when no trace id is given", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ session_id: SESSION_A, trace_id: TRACE_A, command: "keep" }),
      commandEvent({ session_id: SESSION_B, trace_id: TRACE_B, command: "drop" }),
    ]);
    const built = buildDiagnosticBundle(
      baseInputs(home, { selector: { traceId: null, sessionId: SESSION_A } }),
    );
    const { byName } = readZip(built.zip);
    const events = parseJsonl(byName.get("trace-events.jsonl")!);
    expect(events.map((e) => e.command)).toEqual(["keep"]);
  });

  it("intersects trace AND session when both are given", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ trace_id: TRACE_A, session_id: SESSION_A, command: "keep" }),
      commandEvent({ trace_id: TRACE_A, session_id: SESSION_B, command: "drop-session" }),
      commandEvent({ trace_id: TRACE_B, session_id: SESSION_A, command: "drop-trace" }),
    ]);
    const built = buildDiagnosticBundle(
      baseInputs(home, { selector: { traceId: TRACE_A, sessionId: SESSION_A } }),
    );
    const { byName } = readZip(built.zip);
    const events = parseJsonl(byName.get("trace-events.jsonl")!);
    expect(events.map((e) => e.command)).toEqual(["keep"]);
  });

  it("drops expired deadletter records (TTL honored, non-mutating)", () => {
    const expired = deadletterRecord({ expires_at: "2026-07-01T00:00:00.000Z" });
    const live = deadletterRecord({ expires_at: "2026-08-01T00:00:00.000Z" });
    writeJsonl(home, "telemetry-deadletter.jsonl", [expired, live]);
    const before = fs.readFileSync(path.join(home, "telemetry-deadletter.jsonl"), "utf8");
    const built = buildDiagnosticBundle(baseInputs(home));
    expect(built.errorCount).toBe(1); // only the live one
    // The exporter must NOT mutate the deadletter store.
    const after = fs.readFileSync(path.join(home, "telemetry-deadletter.jsonl"), "utf8");
    expect(after).toBe(before);
  });
});

describe("diagnostic-bundle: errors.jsonl projection", () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("projects a failing command into a structured error with a stable fingerprint", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ outcome: "system_error", error_class: "BackendError" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const errors = parseJsonl(byName.get("errors.jsonl")!);
    expect(errors).toHaveLength(1);
    const err = errors[0];
    expect(err.source).toBe("command");
    expect(err.errorClass).toBe("BackendError");
    expect(err.outcome).toBe("system_error");
    expect(err.errorFingerprint).toMatch(/^fp_[0-9a-f]{16}$/);
    // rule 8/9: no free-form message, no raw stack.
    expect(err.mlaOwnedFrames).toEqual([]);
    expect(err).not.toHaveProperty("message");
    expect(err).not.toHaveProperty("stack");
  });

  it("does not treat a successful or noop command as an error", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ outcome: "success" }),
      commandEvent({ outcome: "noop" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    expect(built.errorCount).toBe(0);
  });

  it("projects a deadletter record into a structured error", () => {
    writeJsonl(home, "telemetry-deadletter.jsonl", [deadletterRecord()]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const errors = parseJsonl(byName.get("errors.jsonl")!);
    expect(errors).toHaveLength(1);
    const err = errors[0];
    expect(err.source).toBe("deadletter");
    expect(err.failureClass).toBe("telemetry_upload_failed");
    expect(err.severity).toBe("error");
    expect(err.reasonCode).toBe("backend-5xx");
    expect(err.status).toBe(500);
    expect(err.errorFingerprint).toMatch(/^fp_[0-9a-f]{16}$/);
  });

  it("same class+command+outcome yields the same fingerprint (groupable)", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ outcome: "system_error", error_class: "BackendError" }),
      commandEvent({ outcome: "system_error", error_class: "BackendError", created_at: "2026-07-05T12:05:00.000Z" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const errors = parseJsonl(byName.get("errors.jsonl")!);
    expect(errors).toHaveLength(2);
    expect(errors[0].errorFingerprint).toBe(errors[1].errorFingerprint);
  });
});

describe("diagnostic-bundle: ADVERSARIAL allowlist enforcement", () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The whole-bundle text: every emitted file concatenated. Used to prove a
  // hostile string appears NOWHERE in the output.
  function bundleText(zip: Buffer): string {
    return readStoredZip(zip)
      .map((e) => e.data.toString("utf8"))
      .join("\n");
  }

  it("drops an unknown top-level key carrying injected free-form text", () => {
    const poison = "SELECT * FROM secrets WHERE user='attacker' -- /Users/an/private/path";
    writeJsonl(home, "events.jsonl", [
      commandEvent({ malicious_freeform_field: poison, another_evil: "rm -rf ~/" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const text = bundleText(built.zip);
    expect(text).not.toContain(poison);
    expect(text).not.toContain("rm -rf");
    // and the drop is counted.
    expect(built.counts.fieldsDroppedByAllowlist).toBeGreaterThan(0);
  });

  it("coerces an unknown eventType enum value to OTHER", () => {
    writeJsonl(home, "events.jsonl", [
      commandEvent({ event_type: "mla_command", command: "x" }),
      // event_type is enum-constrained: a novel value must become OTHER.
      { ...commandEvent({ command: "y" }), event_type: "attacker_injected_event_type" },
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const events = parseJsonl(byName.get("trace-events.jsonl")!);
    const types = events.map((e) => e.eventType);
    expect(types).toContain("OTHER");
    expect(bundleText(built.zip)).not.toContain("attacker_injected_event_type");
    expect(built.counts.enumValuesCoercedToOther).toBeGreaterThan(0);
  });

  it("coerces a command token that smuggles a path/query to OTHER", () => {
    writeJsonl(home, "events.jsonl", [
      // The command field has no closed enum, so a SHAPE allowlist applies:
      // a token with a slash, space, or quote cannot pass.
      commandEvent({ command: "diff; cat /etc/passwd" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const events = parseJsonl(byName.get("trace-events.jsonl")!);
    expect(events[0].command).toBe("OTHER");
    expect(bundleText(built.zip)).not.toContain("/etc/passwd");
  });

  it("NEVER opens logs/, ce0/, or a transcript even if present and juicy", () => {
    // Plant hostile content in exactly the files the exporter must not read.
    fs.mkdirSync(path.join(home, "logs"), { recursive: true });
    fs.mkdirSync(path.join(home, "ce0"), { recursive: true });
    const secret = "TRANSCRIPT_SECRET_do_not_leak_9f8e7d";
    fs.writeFileSync(path.join(home, "logs", "ask-traces.jsonl"), JSON.stringify({ prompt: secret }) + "\n");
    fs.writeFileSync(path.join(home, "logs", "mcp-calls.jsonl"), JSON.stringify({ body: secret }) + "\n");
    fs.writeFileSync(path.join(home, "ce0", "evidence.db"), secret);
    fs.writeFileSync(path.join(home, "transcript.jsonl"), JSON.stringify({ text: secret }) + "\n");
    writeJsonl(home, "events.jsonl", [commandEvent()]);

    const built = buildDiagnosticBundle(baseInputs(home));
    expect(bundleText(built.zip)).not.toContain(secret);
  });

  it("Layer-2 scanner redacts a credential that leaked into a structured field", () => {
    // A token-shaped error_class that is actually a provider token: the shape
    // allowlist would let a bare token through, but Layer-2 scanForCredentials
    // catches the known credential FORMAT and redacts it.
    writeJsonl(home, "events.jsonl", [
      commandEvent({ outcome: "auth_error", error_class: "ghp_ABCDEFGHIJKLMNOPQRSTUVWX" }),
    ]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const text = bundleText(built.zip);
    expect(text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(text).toContain("[REDACTED]");
    expect(built.counts.knownPatternMatchesRemoved).toBeGreaterThan(0);
  });

  it("does NOT redact the 32-hex trace id (the join key survives)", () => {
    writeJsonl(home, "events.jsonl", [commandEvent()]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const events = parseJsonl(byName.get("trace-events.jsonl")!);
    expect(events[0].traceId).toBe(TRACE_A);
    expect(built.counts.knownPatternMatchesRemoved).toBe(0);
  });

  it("skips torn/corrupt jsonl lines instead of crashing", () => {
    fs.writeFileSync(
      path.join(home, "events.jsonl"),
      JSON.stringify(commandEvent({ command: "good" })) +
        "\n{ this is not valid json \n" +
        JSON.stringify(commandEvent({ command: "good2" })) +
        "\n",
      "utf8",
    );
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const events = parseJsonl(byName.get("trace-events.jsonl")!);
    expect(events.map((e) => e.command).sort()).toEqual(["good", "good2"]);
  });

  it("redaction-report describes counts honestly with the scanner version", () => {
    writeJsonl(home, "events.jsonl", [commandEvent()]);
    const built = buildDiagnosticBundle(baseInputs(home));
    const { byName } = readZip(built.zip);
    const report = JSON.parse(byName.get("redaction-report.json")!);
    expect(report.scanner.name).toBe("scanForCredentials");
    expect(report.scanner.entropy_heuristic).toBe(false);
    expect(report.counts).toHaveProperty("known_pattern_matches_removed");
    expect(report.counts).toHaveProperty("fields_dropped_by_allowlist");
    expect(report.counts).toHaveProperty("enum_values_coerced_to_other");
    // rule 6: honest framing, not a false "secrets scrubbed" guarantee.
    expect(report.note).toMatch(/allowlist-first/i);
    expect(report.note).not.toMatch(/secrets scrubbed/i);
    expect(report.note).not.toMatch(/guaranteed safe/i);
  });
});
