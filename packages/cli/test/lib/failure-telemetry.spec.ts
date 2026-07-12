import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  DEADLETTER_MAX_ATTEMPTS,
  DEADLETTER_MAX_RECORDS,
  DEADLETTER_TTL_MS,
  DeadletterRecord,
  FAILURE_KB_WRITE_BLOCKED,
  FAILURE_TELEMETRY_UPLOAD_FAILED,
  TELEMETRY_SCHEMA_VERSION,
  appendDeadletter,
  deadletterPath,
  flushDeadletter,
  hashBasename,
  isAttemptDue,
  loadDeadletter,
  recordKbWriteBlocked,
  recordTelemetryUploadFailure,
  sanitizeTelemetry,
} from "../../src/lib/failure-telemetry";

// Each test gets its own MEETLESS_HOME so the deadletter file is fully isolated
// (no module-cache games, no touching the real ~/.meetless).
function freshHomeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-deadletter-"));
  return { ...extra, MEETLESS_HOME: dir } as NodeJS.ProcessEnv;
}

function readRaw(env: NodeJS.ProcessEnv): string {
  return fs.readFileSync(deadletterPath(env), "utf8");
}

// A home dir rooted under a non-directory: any mkdir beneath it fails fast with
// ENOTDIR on every POSIX platform, exercising the "write failed, swallow it"
// path without a hang. Do NOT use a "/proc/..." path here: procfs returns ENOENT
// for mkdir under /proc, which livelocks Node's RECURSIVE mkdir on Linux (it
// misreads the ENOENT as "create the missing parent", finds /proc already
// exists, and retries the child forever). macOS has no /proc so it throws
// immediately, which is why that path passed locally but hung the Linux CI gate.
const UNWRITABLE_HOME = "/dev/null/cannot/write";

describe("sanitizeTelemetry (INV-TELEMETRY-METADATA-CLASSIFICATION)", () => {
  it("keeps the allowlisted low-cardinality fields verbatim", () => {
    const out = sanitizeTelemetry({
      failure_class: "telemetry_upload_failed",
      severity: "warning",
      trace_id: "a".repeat(32),
      surface: "mla-cli",
      workspace_id: "ws_an_local",
      session_id: "sess_123",
    });
    expect(out).toEqual({
      failure_class: "telemetry_upload_failed",
      severity: "warning",
      trace_id: "a".repeat(32),
      surface: "mla-cli",
      workspace_id: "ws_an_local",
      session_id: "sess_123",
    });
  });

  it("keeps numeric metadata (counts, durations, attempts) only when numeric", () => {
    const out = sanitizeTelemetry({
      candidate_count: 3,
      duration_ms: 1200,
      retry_attempts: 2,
      payload_bytes: 4096,
      candidate_count_str: "3", // string under a numeric-looking key -> dropped (not _count suffix exact)
    });
    expect(out.candidate_count).toBe(3);
    expect(out.duration_ms).toBe(1200);
    expect(out.retry_attempts).toBe(2);
    expect(out.payload_bytes).toBe(4096);
    expect(out).not.toHaveProperty("candidate_count_str");
  });

  it("hashes basenames and never emits the raw name", () => {
    const out = sanitizeTelemetry({ file_basename: "enterprise_sso_policy_bypass.ts" });
    expect(out).not.toHaveProperty("file_basename");
    expect(out.file_basename_hash).toMatch(/^b_[0-9a-f]{16}$/);
    expect(JSON.stringify(out)).not.toContain("enterprise_sso");
  });

  it("reduces a full path smuggled under a basename key to its basename before hashing", () => {
    const justName = sanitizeTelemetry({ basename: "oauth-migration.ts" });
    const withPath = sanitizeTelemetry({
      basename: "customers/acme/security-audit/oauth-migration.ts",
    });
    // Same trailing segment hashes identically; the parent dirs never reach the digest input.
    expect(withPath.basename_hash).toBe(justName.basename_hash);
    expect(JSON.stringify(withPath)).not.toContain("acme");
    expect(JSON.stringify(withPath)).not.toContain("security-audit");
  });

  it("drops content and full-path fields entirely (NEVER_SEND)", () => {
    const out = sanitizeTelemetry({
      full_path: "/Users/an/projects/secret.ts",
      path: "/etc/passwd",
      query: "what is our oauth bypass policy",
      query_text: "...",
      answer: "the answer text",
      prompt: "system prompt",
      tool_output: "stdout dump",
      code: "const secret = 1",
      failure_class: "f2_high_confidence_no_citation",
    });
    expect(out).toEqual({ failure_class: "f2_high_confidence_no_citation" });
  });

  it("drops unclassified fields by default (fail-closed allowlist)", () => {
    const out = sanitizeTelemetry({
      failure_class: "f1",
      some_new_unclassified_field: "leak me",
      another: { nested: "object" },
    });
    expect(out).toEqual({ failure_class: "f1" });
  });

  it("recurses into known container keys, classifying each nested field", () => {
    const out = sanitizeTelemetry({
      failure_class: "telemetry_upload_failed",
      metadata_only_context: {
        status: 401,
        reason_code: "unauthorized",
        query: "should be dropped",
        full_path: "/should/drop",
      },
    });
    expect(out.metadata_only_context).toEqual({ status: 401, reason_code: "unauthorized" });
  });

  it("does not mutate the input event", () => {
    const input = { failure_class: "f1", query: "secret" };
    sanitizeTelemetry(input);
    expect(input).toEqual({ failure_class: "f1", query: "secret" });
  });
});

describe("hashBasename", () => {
  it("is stable and non-reversible-looking", () => {
    expect(hashBasename("foo.ts")).toBe(hashBasename("foo.ts"));
    expect(hashBasename("a/b/foo.ts")).toBe(hashBasename("foo.ts"));
    expect(hashBasename("foo.ts")).not.toContain("foo");
  });
});

describe("appendDeadletter (INV-DEADLETTER-SAFETY)", () => {
  it("creates the file mode 0600 with a schema-versioned, TTL-stamped record", () => {
    const env = freshHomeEnv();
    const now = 1_700_000_000_000;
    const rec = appendDeadletter(
      { failure_class: "telemetry_upload_failed", severity: "warning", trace_id: "b".repeat(32) },
      { env, now },
    );
    expect(rec).not.toBeNull();
    const file = deadletterPath(env);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const lines = readRaw(env).trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as DeadletterRecord;
    expect(parsed.schema_version).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(parsed.created_at).toBe(new Date(now).toISOString());
    expect(parsed.expires_at).toBe(new Date(now + DEADLETTER_TTL_MS).toISOString());
    expect(parsed.attempts).toBe(0);
    expect(parsed.failure_class).toBe("telemetry_upload_failed");
  });

  it("sanitizes the event before writing so content never lands on disk", () => {
    const env = freshHomeEnv();
    appendDeadletter(
      { failure_class: "f2", query: "leak", full_path: "/secret/path.ts" },
      { env, now: 1 },
    );
    const raw = readRaw(env);
    expect(raw).not.toContain("leak");
    expect(raw).not.toContain("/secret/path.ts");
    const parsed = JSON.parse(raw.trim()) as DeadletterRecord;
    expect(parsed.event).toEqual({ failure_class: "f2" });
  });

  it("bounds the record count, dropping the oldest", () => {
    const env = freshHomeEnv();
    for (let i = 0; i < DEADLETTER_MAX_RECORDS + 25; i++) {
      appendDeadletter(
        { failure_class: "f8", severity: "warning", attempt_index: i },
        { env, now: 1_700_000_000_000 + i },
      );
    }
    const lines = readRaw(env).trim().split("\n");
    expect(lines.length).toBe(DEADLETTER_MAX_RECORDS);
    // Oldest dropped: the first surviving record is not index 0.
    const first = JSON.parse(lines[0]) as DeadletterRecord;
    expect(first.event.attempt_index).toBe(25);
  });
});

describe("loadDeadletter", () => {
  it("drops expired records and rewrites the file", () => {
    const env = freshHomeEnv();
    const base = 1_700_000_000_000;
    appendDeadletter({ failure_class: "old" }, { env, now: base });
    // Read back well after the TTL has elapsed.
    const later = base + DEADLETTER_TTL_MS + 1;
    appendDeadletter({ failure_class: "fresh" }, { env, now: later });
    const live = loadDeadletter({ env, now: later });
    const classes = live.map((r) => r.failure_class);
    expect(classes).toContain("fresh");
    expect(classes).not.toContain("old");
    // The rewrite persisted the drop.
    expect(readRaw(env)).not.toContain("\"old\"");
  });
});

describe("isAttemptDue (exponential backoff)", () => {
  const base = 1_700_000_000_000;
  function rec(attempts: number, lastAttemptAt: string | null): DeadletterRecord {
    return {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      created_at: new Date(base).toISOString(),
      expires_at: new Date(base + DEADLETTER_TTL_MS).toISOString(),
      attempts,
      last_attempt_at: lastAttemptAt,
      failure_class: "f8",
      event: { failure_class: "f8" },
    };
  }

  it("is due immediately on a fresh record", () => {
    expect(isAttemptDue(rec(0, null), base)).toBe(true);
  });

  it("waits base*2^(attempts-1) from the last attempt", () => {
    const lastAt = new Date(base).toISOString();
    // attempts=1 -> wait 60_000ms
    expect(isAttemptDue(rec(1, lastAt), base + 30_000)).toBe(false);
    expect(isAttemptDue(rec(1, lastAt), base + 60_000)).toBe(true);
    // attempts=2 -> wait 120_000ms
    expect(isAttemptDue(rec(2, lastAt), base + 119_000)).toBe(false);
    expect(isAttemptDue(rec(2, lastAt), base + 120_000)).toBe(true);
  });
});

describe("flushDeadletter", () => {
  it("uploads due records and removes them on success", async () => {
    const env = freshHomeEnv();
    const now = 1_700_000_000_000;
    appendDeadletter({ failure_class: "f8", severity: "warning" }, { env, now });
    const uploaded: DeadletterRecord[] = [];
    const result = await flushDeadletter({
      env,
      now,
      upload: async (rec) => {
        uploaded.push(rec);
      },
    });
    expect(result.sent).toBe(1);
    expect(uploaded).toHaveLength(1);
    expect(loadDeadletter({ env, now })).toHaveLength(0);
  });

  it("increments attempts on failure and keeps the record until max attempts", async () => {
    const env = freshHomeEnv();
    const now = 1_700_000_000_000;
    appendDeadletter({ failure_class: "f8", severity: "warning" }, { env, now });
    const result = await flushDeadletter({
      env,
      now,
      upload: async () => {
        throw new Error("network down");
      },
    });
    expect(result.kept).toBe(1);
    expect(result.dropped).toBe(0);
    const after = loadDeadletter({ env, now });
    expect(after).toHaveLength(1);
    expect(after[0].attempts).toBe(1);
    expect(after[0].last_attempt_at).toBe(new Date(now).toISOString());
  });

  it("drops a record after MAX_ATTEMPTS rather than retrying forever", async () => {
    const env = freshHomeEnv();
    let now = 1_700_000_000_000;
    appendDeadletter({ failure_class: "f8", severity: "warning" }, { env, now });
    // Fail repeatedly, advancing 7h per step: past the 6h backoff cap so every
    // attempt is due, but 5 steps stay well under the 7-day TTL so the record is
    // dropped for hitting MAX_ATTEMPTS, not for expiring.
    for (let i = 0; i < DEADLETTER_MAX_ATTEMPTS; i++) {
      now += 7 * 60 * 60 * 1000;
      await flushDeadletter({
        env,
        now,
        upload: async () => {
          throw new Error("still down");
        },
      });
    }
    expect(loadDeadletter({ env, now })).toHaveLength(0);
  });

  it("does not forward anything when telemetry is hard-disabled", async () => {
    const env = freshHomeEnv({ MEETLESS_TELEMETRY: "off" });
    const now = 1_700_000_000_000;
    // Append directly (append respects only the kill switch at record time; here we
    // simulate a record written before the switch was flipped by writing with a clean env).
    const cleanEnv = { ...env, MEETLESS_TELEMETRY: "" } as NodeJS.ProcessEnv;
    appendDeadletter({ failure_class: "f8", severity: "warning" }, { env: cleanEnv, now });
    let called = false;
    const result = await flushDeadletter({
      env,
      now,
      upload: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
    expect(result.sent).toBe(0);
    // The local store is left intact (kill switch must not destroy local data).
    expect(loadDeadletter({ env: cleanEnv, now })).toHaveLength(1);
  });
});

describe("recordTelemetryUploadFailure (F8)", () => {
  it("writes an F8 deadletter record with trace/workspace join keys and status context", () => {
    const env = freshHomeEnv();
    const now = 1_700_000_000_000;
    const rec = recordTelemetryUploadFailure(
      {
        traceId: "c".repeat(32),
        workspaceId: "ws_an_local",
        sessionId: "sess_9",
        surface: "mla-cli",
        reasonCode: "http_error",
        status: 401,
      },
      { env, now },
    );
    expect(rec).not.toBeNull();
    expect(rec!.failure_class).toBe(FAILURE_TELEMETRY_UPLOAD_FAILED);
    expect(rec!.event.severity).toBe("warning");
    expect(rec!.event.trace_id).toBe("c".repeat(32));
    expect(rec!.event.workspace_id).toBe("ws_an_local");
    expect(rec!.event.session_id).toBe("sess_9");
    expect(rec!.event.metadata_only_context).toEqual({ status: 401, reason_code: "http_error" });
  });

  it("is a no-op when telemetry is hard-disabled (kill switch)", () => {
    const env = freshHomeEnv({ MEETLESS_TELEMETRY: "off" });
    const rec = recordTelemetryUploadFailure({ traceId: "d".repeat(32), status: 500 }, { env });
    expect(rec).toBeNull();
    expect(fs.existsSync(deadletterPath(env))).toBe(false);
  });

  it("never throws even if the home dir is unwritable", () => {
    const env = { MEETLESS_HOME: UNWRITABLE_HOME } as NodeJS.ProcessEnv;
    expect(() => recordTelemetryUploadFailure({ traceId: "e".repeat(32) }, { env })).not.toThrow();
  });
});

describe("recordKbWriteBlocked (F5)", () => {
  it("writes a kb_write_blocked deadletter record with join keys and sanitized status context", () => {
    const env = freshHomeEnv();
    const now = 1_700_000_000_000;
    const rec = recordKbWriteBlocked(
      {
        traceId: "f".repeat(32),
        workspaceId: "ws_an_local",
        sessionId: "sess_5",
        surface: "mla-cli",
        reasonCode: "owner_gate",
        status: 2,
      },
      { env, now },
    );
    expect(rec).not.toBeNull();
    // The cross-plane contract: this string MUST match intel FailureClass.KB_WRITE_BLOCKED.
    expect(FAILURE_KB_WRITE_BLOCKED).toBe("kb_write_blocked");
    expect(rec!.failure_class).toBe(FAILURE_KB_WRITE_BLOCKED);
    expect(rec!.event.severity).toBe("warning");
    expect(rec!.event.surface).toBe("mla-cli");
    expect(rec!.event.trace_id).toBe("f".repeat(32));
    expect(rec!.event.workspace_id).toBe("ws_an_local");
    expect(rec!.event.session_id).toBe("sess_5");
    expect(rec!.event.metadata_only_context).toEqual({ status: 2, reason_code: "owner_gate" });
  });

  it("defaults the surface to mla-cli and omits absent join keys", () => {
    const env = freshHomeEnv();
    const rec = recordKbWriteBlocked({ reasonCode: "worker_nonzero_exit", status: 1 }, { env, now: 1 });
    expect(rec).not.toBeNull();
    expect(rec!.event.surface).toBe("mla-cli");
    expect(rec!.event).not.toHaveProperty("trace_id");
    expect(rec!.event).not.toHaveProperty("workspace_id");
    expect(rec!.event).not.toHaveProperty("session_id");
    expect(rec!.event.metadata_only_context).toEqual({ status: 1, reason_code: "worker_nonzero_exit" });
  });

  it("never lets content leak through the context bag (drop-by-default)", () => {
    const env = freshHomeEnv();
    const rec = recordKbWriteBlocked(
      // A reasonCode is an allowlisted low-cardinality enum; a path is not. Even if a
      // caller smuggles one in via reasonCode it stays a scalar string, but the bag
      // itself only carries status + reason_code, never a file path or doc body.
      { reasonCode: "owner_gate", status: 2, traceId: "a".repeat(32) },
      { env, now: 1 },
    );
    const raw = readRaw(env);
    expect(raw).not.toContain("full_path");
    expect(rec!.event.metadata_only_context).toEqual({ status: 2, reason_code: "owner_gate" });
  });

  it("is a no-op when telemetry is hard-disabled (kill switch)", () => {
    const env = freshHomeEnv({ MEETLESS_TELEMETRY: "off" });
    const rec = recordKbWriteBlocked({ reasonCode: "owner_gate", status: 2 }, { env });
    expect(rec).toBeNull();
    expect(fs.existsSync(deadletterPath(env))).toBe(false);
  });

  it("never throws even if the home dir is unwritable", () => {
    const env = { MEETLESS_HOME: UNWRITABLE_HOME } as NodeJS.ProcessEnv;
    expect(() => recordKbWriteBlocked({ reasonCode: "owner_gate", status: 2 }, { env })).not.toThrow();
  });
});
