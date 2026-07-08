import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  runInternalEvidenceTurnOpen,
  runInternalEvidenceCapture,
  runInternalEvidenceStop,
} from "../../src/commands/internal-evidence-hooks";
import {
  openCe0Store,
  closeCe0Store,
  getTurnMemoryAssessment,
  getTurnRuleObligation,
  getConsultationAttempt,
  resolveLatestTurnIdentity,
  listDeadlineClaimedObligations,
} from "../../src/lib/rules/ce0-store";
import {
  CONSULT_EVIDENCE_RULE_VERSION_ID,
  CONSULT_EVIDENCE_RULE_ID,
  CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
} from "../../src/lib/rules/ce0-rule";
import { insertLocalRuleVersion } from "../../src/lib/rules/local-rule-version-repo";
import type { RecordInput } from "../../src/lib/analytics/recorder";
import type { Ce0EmitCoords } from "../../src/lib/rules/ce0-emit";

/** A deterministic monotonic clock: yields the queued values in order and throws if over-consumed, so
 * a hook that calls it more times than expected fails loudly rather than computing a NaN duration. */
function seq(values: number[]): () => number {
  const q = [...values];
  return () => {
    const v = q.shift();
    if (v === undefined) throw new Error("monotonic clock exhausted");
    return v;
  };
}

// The CE0 hook subcommands are the live wiring between Claude Code's hooks and the CE0
// durable store. Each is a thin IO shell over a committed adapter: read stdin best-effort,
// resolve the logged-in workspace, open the local store, run the adapter, close, and ALWAYS
// emit the empty `{}` body + exit 0. They never inject and never block a turn (RECORD_ONLY).
//
// These tests use a REAL tmp-file CE0 store (the store is an internal service; only the
// stdin/stdout/workspace seams are injected).

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-hooks-"));
  return path.join(dir, "evidence.db");
}

/** A runtime scope an operator has "armed" by attesting a LIVE consult-evidence version. */
const ARMED_SCOPE = "/work/armed-scope";

/** Seed a LIVE consult-evidence LocalRuleVersion for ARMED_SCOPE so the entrypoints' binding resolves
 * to it. Carries the registry's canonical hash (so only the version id distinguishes armed from unarmed)
 * and a real version id, NOT the synthetic compile-time constant. */
function armScope(dbPath: string, versionId: string): void {
  const store = openCe0Store(dbPath);
  try {
    insertLocalRuleVersion(store, {
      versionId,
      ruleId: CONSULT_EVIDENCE_RULE_ID,
      runtimeScopeId: ARMED_SCOPE,
      rulePayload: "{}",
      canonicalPayloadHash: CONSULT_EVIDENCE_CANONICAL_PAYLOAD_HASH,
      lifecycleStatus: "LIVE",
      attestationMethod: "AGENT_ON_USER_REQUEST",
      attestedBy: "user_an",
      supersedesVersionId: null,
      derivedFromObservedHash: null,
      attestedAt: "2026-06-22T00:00:00.000Z",
    });
  } finally {
    closeCe0Store(store);
  }
}

describe("runInternalEvidenceTurnOpen: UserPromptSubmit durable path", () => {
  it("persists an assessment AND an obligation for a REQUIRED turn, emits {} exit 0", async () => {
    const dbPath = tmpStorePath();
    const written: string[] = [];
    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: "sess-A", prompt: "what did we decide about auth tokens" }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1000,
      newId: (kind) => (kind === "obligation" ? "obl:t1" : "asm:t1"),
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      const asm = getTurnMemoryAssessment(store, "asm:t1");
      expect(asm?.requirement).toBe("REQUIRED");
      expect(asm?.workspaceId).toBe("ws-test");
      expect(asm?.sessionId).toBe("sess-A");
      expect(asm?.localTurnSequence).toBe(1);

      const obl = getTurnRuleObligation(store, "obl:t1");
      expect(obl?.status).toBe("OPEN");
      expect(obl?.ruleVersionId).toBe(CONSULT_EVIDENCE_RULE_VERSION_ID);
      expect(obl?.localTurnSequence).toBe(1);
    } finally {
      closeCe0Store(store);
    }
  });

  it("persists an assessment but NO obligation for a NOT_REQUIRED turn", async () => {
    const dbPath = tmpStorePath();
    const written: string[] = [];
    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: "sess-B", prompt: "why does the cache evict on write" }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 2000,
      newId: (kind) => (kind === "obligation" ? "obl:b1" : "asm:b1"),
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      const asm = getTurnMemoryAssessment(store, "asm:b1");
      expect(asm?.requirement).toBe("NOT_REQUIRED");
      expect(getTurnRuleObligation(store, "obl:b1")).toBeNull();
      const identity = resolveLatestTurnIdentity(store, {
        workspaceId: "ws-test",
        sessionId: "sess-B",
      });
      expect(identity?.localTurnSequence).toBe(1);
    } finally {
      closeCe0Store(store);
    }
  });

  it("is dormant with no resolved workspace: writes nothing, still emits {} exit 0", async () => {
    const dbPath = tmpStorePath();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    const written: string[] = [];
    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () => JSON.stringify({ session_id: "sess-C", prompt: "what did we decide" }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => undefined,
      storePath: dbPath,
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("fails soft on malformed stdin: no throw, no write, still {} exit 0", async () => {
    const dbPath = tmpStorePath();
    const written: string[] = [];
    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () => "{ not json",
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      expect(
        resolveLatestTurnIdentity(store, { workspaceId: "ws-test", sessionId: "sess-A" }),
      ).toBeNull();
    } finally {
      closeCe0Store(store);
    }
  });
});

describe("runInternalEvidenceTurnOpen: the obligation binds to the runtime scope's LIVE attested version", () => {
  it("stamps the REQUIRED turn's obligation with the LIVE attested version id, not the compile-time constant", async () => {
    const dbPath = tmpStorePath();
    armScope(dbPath, "ver_armed_1");

    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: "sess-armed", prompt: "what did we decide about auth tokens" }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      resolveRuntimeScopeId: () => ARMED_SCOPE,
      storePath: dbPath,
      now: () => 1000,
      newId: (kind) => (kind === "obligation" ? "obl:armed" : "asm:armed"),
    });

    expect(code).toBe(0);

    const store = openCe0Store(dbPath);
    try {
      const obl = getTurnRuleObligation(store, "obl:armed");
      expect(obl?.ruleVersionId).toBe("ver_armed_1");
      expect(obl?.ruleVersionId).not.toBe(CONSULT_EVIDENCE_RULE_VERSION_ID);
    } finally {
      closeCe0Store(store);
    }
  });

  it("falls back to the compile-time identity when the runtime scope has no LIVE attested version", async () => {
    const dbPath = tmpStorePath();
    // No armScope: the scope is UNARMED, so CE0 keeps measuring with the frozen compile-time identity.

    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: "sess-unarmed", prompt: "what did we decide about auth tokens" }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      resolveRuntimeScopeId: () => "/work/some-other-unarmed-scope",
      storePath: dbPath,
      now: () => 1000,
      newId: (kind) => (kind === "obligation" ? "obl:unarmed" : "asm:unarmed"),
    });

    expect(code).toBe(0);

    const store = openCe0Store(dbPath);
    try {
      const obl = getTurnRuleObligation(store, "obl:unarmed");
      expect(obl?.ruleVersionId).toBe(CONSULT_EVIDENCE_RULE_VERSION_ID);
    } finally {
      closeCe0Store(store);
    }
  });
});

describe("runInternalEvidenceTurnOpen: evidence_hook_health emission (§6.4 P0.2)", () => {
  it("emits one USER_PROMPT_SUBMIT health event keyed by the assessmentId, failed:false", async () => {
    const dbPath = tmpStorePath();
    const emitted: Array<{ input: RecordInput; coords: Ce0EmitCoords }> = [];
    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: "sess-A", prompt: "what did we decide about auth tokens" }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1000,
      newId: (kind) => (kind === "obligation" ? "obl:t1" : "asm:t1"),
      emit: (input, coords) => {
        emitted.push({ input, coords });
      },
      monotonicNowMs: seq([5, 12]),
    });

    expect(code).toBe(0);
    expect(emitted).toHaveLength(1);
    const { input, coords } = emitted[0];
    expect(input.eventType).toBe("evidence_hook_health");
    expect(input.payload).toMatchObject({
      hook: "USER_PROMPT_SUBMIT",
      operation_identity: "asm:t1",
      failed: false,
      reason: null,
      duration_ms: 7,
    });
    expect(coords).toMatchObject({ workspaceId: "ws-test", sessionId: "sess-A", nowMs: 1000 });
  });

  // Characterizes the type-forced no-coordinate guard: an INFRA outcome (here from malformed stdin)
  // opens no turn and surfaces no assessmentId, so the shell produces no operationIdentity and emits
  // no health event. A coordinate-less invocation cannot form the deterministic eventId (§6.4 P0.2).
  it("emits NO health event on malformed stdin (INFRA, no assessment coordinate)", async () => {
    const dbPath = tmpStorePath();
    const emitted: unknown[] = [];
    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () => "not json{",
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1000,
      emit: (input, coords) => {
        emitted.push({ input, coords });
      },
    });

    expect(code).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  // Characterizes the outer fail-soft try: the health emit runs AFTER the durable store write commits,
  // so a throwing sink must be swallowed (never escalate into a blocking hook) while the assessment the
  // hook already persisted stays intact and the pass-through body still ships (§6.4 P0.2).
  it("is fail-soft when the emit sink throws: no throw, assessment persisted, still {} exit 0", async () => {
    const dbPath = tmpStorePath();
    const written: string[] = [];
    const code = await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: "sess-A", prompt: "what did we decide about auth tokens" }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1000,
      newId: (kind) => (kind === "obligation" ? "obl:t1" : "asm:t1"),
      emit: () => {
        throw new Error("spool down");
      },
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);
    const store = openCe0Store(dbPath);
    try {
      expect(getTurnMemoryAssessment(store, "asm:t1")).not.toBeNull();
    } finally {
      closeCe0Store(store);
    }
  });
});

describe("runInternalEvidenceCapture: PostToolUse durable path", () => {
  async function openTurn(dbPath: string, sessionId: string): Promise<void> {
    await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: sessionId, prompt: "what did we decide about auth tokens" }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1000,
      newId: (kind) => (kind === "obligation" ? `obl:${sessionId}` : `asm:${sessionId}`),
    });
  }

  it("records a ConsultationAttempt for a governed-memory pull under the live turn", async () => {
    const dbPath = tmpStorePath();
    await openTurn(dbPath, "sess-A");

    const written: string[] = [];
    const code = await runInternalEvidenceCapture([], {
      readStdin: async () =>
        JSON.stringify({
          session_id: "sess-A",
          tool_name: "mcp__meetless__meetless__retrieve_knowledge",
          tool_input: { query: "auth tokens" },
          tool_response: { content: [{ type: "text", text: JSON.stringify({ count: 3 }) }] },
        }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1500,
      newId: () => "con:c1",
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      const con = getConsultationAttempt(store, "con:c1");
      expect(con?.execution).toBe("COMPLETE");
      expect(con?.result).toBe("RESULTS_RETURNED");
      expect(con?.localTurnSequence).toBe(1);
      expect(con?.orderingToken).toBe(1);
      expect(con?.deliveredToAnsweringContext).toBe(true);
    } finally {
      closeCe0Store(store);
    }
  });

  it("emits a CONSULTATION_CAPTURE health event keyed by the consultationId, failed:false", async () => {
    const dbPath = tmpStorePath();
    await openTurn(dbPath, "sess-A");

    const emitted: Array<{ input: RecordInput; coords: Ce0EmitCoords }> = [];
    const code = await runInternalEvidenceCapture([], {
      readStdin: async () =>
        JSON.stringify({
          session_id: "sess-A",
          tool_name: "mcp__meetless__meetless__retrieve_knowledge",
          tool_input: { query: "auth tokens" },
          tool_response: { content: [{ type: "text", text: JSON.stringify({ count: 3 }) }] },
        }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1500,
      newId: () => "con:c1",
      emit: (input, coords) => {
        emitted.push({ input, coords });
      },
      monotonicNowMs: seq([2, 9]),
    });

    expect(code).toBe(0);
    // A CAPTURED capture ships two events: the evidence_consultation_completed primary, then the health
    // watchdog (in that order, so the health durationMs covers the primary append, §6.4 P0.2).
    expect(emitted).toHaveLength(2);
    expect(emitted[0].input.eventType).toBe("evidence_consultation_completed");
    const health = emitted[1];
    expect(health.input.eventType).toBe("evidence_hook_health");
    expect(health.input.payload).toMatchObject({
      hook: "CONSULTATION_CAPTURE",
      operation_identity: "con:c1",
      failed: false,
      reason: null,
      duration_ms: 7,
    });
    expect(health.coords).toMatchObject({ workspaceId: "ws-test", sessionId: "sess-A", nowMs: 1500 });
  });

  it("emits an evidence_consultation_completed primary event for a governed-memory pull, keyed by the consultationId", async () => {
    const dbPath = tmpStorePath();
    await openTurn(dbPath, "sess-A");

    const emitted: Array<{ input: RecordInput; coords: Ce0EmitCoords }> = [];
    const code = await runInternalEvidenceCapture([], {
      readStdin: async () =>
        JSON.stringify({
          session_id: "sess-A",
          tool_name: "mcp__meetless__meetless__retrieve_knowledge",
          tool_input: { query: "auth tokens" },
          tool_response: { content: [{ type: "text", text: JSON.stringify({ count: 3 }) }] },
        }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1500,
      newId: () => "con:c1",
      emit: (input, coords) => {
        emitted.push({ input, coords });
      },
    });

    expect(code).toBe(0);
    const completed = emitted.find((e) => e.input.eventType === "evidence_consultation_completed");
    expect(completed).toBeDefined();
    expect(completed?.input.payload).toMatchObject({
      consultation_id: "con:c1",
      local_turn_sequence: 1,
      source: "AGENT_PULL",
      execution: "COMPLETE",
      result: "RESULTS_RETURNED",
      delivered_to_answering_context: true,
    });
    // §6.4 R4 P1.2 / P0.2: a CE0 capture carries neither a rule version nor a timed latency.
    expect(completed?.input.payload).not.toHaveProperty("rule_version_id");
    expect(completed?.input.payload).not.toHaveProperty("latency_ms");
    expect(completed?.coords).toMatchObject({ workspaceId: "ws-test", sessionId: "sess-A", nowMs: 1500 });
  });

  it("emits NO health event when the captured tool is non-governed (no consultation coordinate)", async () => {
    const dbPath = tmpStorePath();
    await openTurn(dbPath, "sess-A");

    const emitted: unknown[] = [];
    await runInternalEvidenceCapture([], {
      readStdin: async () =>
        JSON.stringify({
          session_id: "sess-A",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          tool_response: { content: [] },
        }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      newId: () => "con:nope",
      emit: (input, coords) => {
        emitted.push({ input, coords });
      },
    });

    expect(emitted).toHaveLength(0);
  });

  it("records nothing for a non-governed tool, still {} exit 0", async () => {
    const dbPath = tmpStorePath();
    await openTurn(dbPath, "sess-A");

    const written: string[] = [];
    const code = await runInternalEvidenceCapture([], {
      readStdin: async () =>
        JSON.stringify({
          session_id: "sess-A",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          tool_response: { content: [] },
        }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      newId: () => "con:nope",
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      expect(getConsultationAttempt(store, "con:nope")).toBeNull();
    } finally {
      closeCe0Store(store);
    }
  });

  it("fails soft when no turn identity exists yet: no record, still {} exit 0", async () => {
    const dbPath = tmpStorePath();
    const written: string[] = [];
    const code = await runInternalEvidenceCapture([], {
      readStdin: async () =>
        JSON.stringify({
          session_id: "sess-Z",
          tool_name: "mcp__meetless__meetless__retrieve_knowledge",
          tool_input: { query: "auth tokens" },
          tool_response: { content: [{ type: "text", text: JSON.stringify({ count: 3 }) }] },
        }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      newId: () => "con:orphan",
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      expect(getConsultationAttempt(store, "con:orphan")).toBeNull();
    } finally {
      closeCe0Store(store);
    }
  });
});

describe("runInternalEvidenceStop: Stop deadline-claim durable path", () => {
  async function openTurn(dbPath: string, sessionId: string): Promise<void> {
    await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: sessionId, prompt: "what did we decide about auth tokens" }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1000,
      newId: (kind) => (kind === "obligation" ? `obl:${sessionId}` : `asm:${sessionId}`),
    });
  }

  async function capture(dbPath: string, sessionId: string, consultationId: string): Promise<void> {
    await runInternalEvidenceCapture([], {
      readStdin: async () =>
        JSON.stringify({
          session_id: sessionId,
          tool_name: "mcp__meetless__meetless__retrieve_knowledge",
          tool_input: { query: "auth tokens" },
          tool_response: { content: [{ type: "text", text: JSON.stringify({ count: 3 }) }] },
        }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      now: () => 1500,
      newId: () => consultationId,
    });
  }

  async function stop(dbPath: string, sessionId: string, written: string[]): Promise<number> {
    return runInternalEvidenceStop([], {
      readStdin: async () => JSON.stringify({ session_id: sessionId }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
    });
  }

  it("claims the ARMED obligation at Stop: a turn opened under an armed scope is frozen by a Stop in the same scope", async () => {
    const dbPath = tmpStorePath();
    armScope(dbPath, "ver_armed_stop");

    // Prompt-submit under the armed scope stamps the obligation with "ver_armed_stop".
    await runInternalEvidenceTurnOpen([], {
      readStdin: async () =>
        JSON.stringify({ session_id: "sess-armed", prompt: "what did we decide about auth tokens" }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      resolveRuntimeScopeId: () => ARMED_SCOPE,
      storePath: dbPath,
      now: () => 1000,
      newId: (kind) => (kind === "obligation" ? "obl:armed" : "asm:armed"),
    });

    // Stop under the SAME armed scope must claim THAT obligation (claimFirstStop joins on the version id),
    // not look for one stamped with the compile-time constant. A constant-claiming Stop would orphan the
    // armed obligation and never freeze its deadline.
    const written: string[] = [];
    const code = await runInternalEvidenceStop([], {
      readStdin: async () => JSON.stringify({ session_id: "sess-armed" }),
      writeOut: (s) => written.push(s),
      resolveWorkspaceId: () => "ws-test",
      resolveRuntimeScopeId: () => ARMED_SCOPE,
      storePath: dbPath,
    });

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      const obl = getTurnRuleObligation(store, "obl:armed");
      expect(obl?.ruleVersionId).toBe("ver_armed_stop");
      // The deadline is FROZEN (non-null), proving the Stop found and claimed the armed obligation.
      expect(obl?.deadlineClaimedAt).not.toBeNull();
      expect(obl?.stateVersion).toBe(1);
      expect(listDeadlineClaimedObligations(store, "ws-test")).toHaveLength(1);
    } finally {
      closeCe0Store(store);
    }
  });

  it("emits a STOP health event keyed by the rendered LocalTurnIdentity, failed:false", async () => {
    const dbPath = tmpStorePath();
    await openTurn(dbPath, "sess-A");
    await capture(dbPath, "sess-A", "con:c1");

    const emitted: Array<{ input: RecordInput; coords: Ce0EmitCoords }> = [];
    const code = await runInternalEvidenceStop([], {
      readStdin: async () => JSON.stringify({ session_id: "sess-A" }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      emit: (input, coords) => {
        emitted.push({ input, coords });
      },
      monotonicNowMs: seq([4, 10]),
      now: () => 2000,
    });

    expect(code).toBe(0);
    expect(emitted).toHaveLength(1);
    const { input, coords } = emitted[0];
    expect(input.eventType).toBe("evidence_hook_health");
    expect(input.payload).toMatchObject({
      hook: "STOP",
      operation_identity: "ws-test:sess-A:1",
      failed: false,
      reason: null,
      duration_ms: 6,
    });
    expect(coords).toMatchObject({ workspaceId: "ws-test", sessionId: "sess-A", nowMs: 2000 });
  });

  it("emits NO STOP health event for a session with no obligation (NOT_APPLICABLE, nothing claimed)", async () => {
    const dbPath = tmpStorePath();
    const emitted: unknown[] = [];
    await runInternalEvidenceStop([], {
      readStdin: async () => JSON.stringify({ session_id: "sess-never" }),
      writeOut: () => undefined,
      resolveWorkspaceId: () => "ws-test",
      storePath: dbPath,
      emit: (input, coords) => {
        emitted.push({ input, coords });
      },
    });

    expect(emitted).toHaveLength(0);
  });

  it("freezes the obligation's deadline at the high-water token, emits {} exit 0", async () => {
    const dbPath = tmpStorePath();
    await openTurn(dbPath, "sess-A");
    await capture(dbPath, "sess-A", "con:c1");

    const written: string[] = [];
    const code = await stop(dbPath, "sess-A", written);

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      const obl = getTurnRuleObligation(store, "obl:sess-A");
      expect(obl?.deadlineClaimedAt).toBe(1);
      expect(obl?.deadlineClaimedVersion).toBe(0);
      expect(obl?.stateVersion).toBe(1);
      expect(listDeadlineClaimedObligations(store, "ws-test")).toHaveLength(1);
    } finally {
      closeCe0Store(store);
    }
  });

  it("is idempotent: a second Stop never moves the boundary", async () => {
    const dbPath = tmpStorePath();
    await openTurn(dbPath, "sess-A");
    await capture(dbPath, "sess-A", "con:c1");

    await stop(dbPath, "sess-A", []);
    const written: string[] = [];
    const code = await stop(dbPath, "sess-A", written);

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      const obl = getTurnRuleObligation(store, "obl:sess-A");
      expect(obl?.deadlineClaimedAt).toBe(1);
      expect(obl?.stateVersion).toBe(1);
    } finally {
      closeCe0Store(store);
    }
  });

  it("claims nothing for a session with no obligation, still {} exit 0", async () => {
    const dbPath = tmpStorePath();
    const written: string[] = [];
    const code = await stop(dbPath, "sess-never", written);

    expect(code).toBe(0);
    expect(written).toEqual(["{}"]);

    const store = openCe0Store(dbPath);
    try {
      expect(listDeadlineClaimedObligations(store, "ws-test")).toHaveLength(0);
    } finally {
      closeCe0Store(store);
    }
  });
});
