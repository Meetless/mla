import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  openCe0Store,
  closeCe0Store,
  insertTurnMemoryAssessment,
  getConsultationAttempt,
  type Ce0Store,
} from "../../../src/lib/rules/ce0-store";
import { buildConsultationSubjectFromQuery } from "../../../src/lib/rules/requirement-subject";
import { samplingBucketFor } from "../../../src/lib/rules/ce0-sampling-bucket";
import {
  captureMemoryConsultation,
  parsePostToolUseInput,
  classifyConsultationTool,
  classifyRetrievalEnvelope,
  type ConsultationCaptureConfig,
} from "../../../src/lib/rules/consultation-capture-adapter";

// Commit 7b: the CE0 PostToolUse capture adapter, the AGENT_PULL seam
// (notes/20260617-evidence-consultation-forcing-function-proposal.md §1.6). When the agent
// calls a governed-memory tool mid-turn, this records the FACT of that consultation as a
// ConsultationAttempt under the current turn's LocalTurnIdentity. It mirrors the observe /
// prompt-submit adapters' discipline:
//   - It NEVER injects. The hook response is the empty object on EVERY branch. RECORD_ONLY:
//     a PostToolUse capture observes and records, it never steers, asks, or denies.
//   - It NEVER turns an infrastructure problem into a write or a throw: malformed input, a
//     missing session coordinate, a missing query, no turn to anchor, or a persistence
//     failure all surface as INFRA with an empty response and zero writes.
//   - It records the FACT regardless of how the retrieval went. A FAILED or UNKNOWN
//     execution is still a recorded consultation (it simply never contributes a proof); the
//     satisfaction reducer, not this adapter, decides what counts.
//   - It does NOT run the matcher or advance any obligation. Coverage is recomputed
//     deterministically later (the first-Stop deadline claim, Commit 8); 7b only captures.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce0-capture-"));
  store = openCe0Store(path.join(dir, "ce0.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const FIXED_NOW = 1718700000500;
const RK_TOOL = "mcp__meetless__meetless__retrieve_knowledge";
const KBD_TOOL = "mcp__meetless__meetless__kb_doc_detail";
const QUERY_TOOL = "mcp__meetless__meetless__query";

/** Deterministic consultation-id minting: con_1, con_2, ... */
function seqIds(): () => string {
  let n = 0;
  return () => `con_${(n += 1)}`;
}

function config(over: Partial<ConsultationCaptureConfig> = {}): ConsultationCaptureConfig {
  return { store, workspaceId: "ws_abc", now: () => FIXED_NOW, newId: seqIds(), ...over };
}

/** Seed a UserPromptSubmit assessment so a later hook's LocalTurnIdentity resolves. */
function seedTurn(sessionId = "sess_1", seq = 1): void {
  insertTurnMemoryAssessment(store, {
    assessmentId: `asm_${sessionId}_${seq}`,
    workspaceId: "ws_abc",
    sessionId,
    localTurnSequence: seq,
    requirement: "REQUIRED",
    markersMatched: [],
    exclusionsMatched: [],
    classifierVersion: "raw-prompt-substring-v1",
    markerSetVersion: "seed-v1",
    exclusionSetVersion: "seed-v1",
    createdAt: 1718700000000,
    samplingBucket: samplingBucketFor({ workspaceId: "ws_abc", sessionId, localTurnSequence: seq }),
    promptHash: "ph_seed",
  });
}

/** A successful MCP CallToolResult: one text content block carrying the JSON payload. */
function okResult(payload: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/** An errored MCP CallToolResult (isError set, as the meetless server emits on a thrown handler). */
function errResult(payload: unknown = { error: "retrieval boom" }): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

const RK_QUERY = "the soft gate enforcement decision";

/** A retrieve_knowledge PostToolUse payload with two hits, overridable per field. */
function post(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess_1",
    hook_event_name: "PostToolUse",
    tool_name: RK_TOOL,
    tool_input: { query: RK_QUERY },
    tool_response: okResult({
      tool: "meetless__retrieve_knowledge",
      workspace: "ws_abc",
      query: RK_QUERY,
      count: 2,
      candidates: [{ id: "ev_1" }, { id: "ev_2" }],
    }),
    ...over,
  };
}

function rowCount(table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("captureMemoryConsultation: tool-surface gate", () => {
  it.each(["Read", "Bash", "mcp__other__query", "mcp__meetless__meetless__relationship_verdict"])(
    "ignores a non-governed-pull tool (%s): NOT_APPLICABLE, empty response, zero writes",
    (tool_name) => {
      seedTurn();
      const { response, outcome } = captureMemoryConsultation(post({ tool_name }), config());
      expect(response).toEqual({});
      expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
      expect(rowCount("consultation_attempt")).toBe(0);
    },
  );
});

describe("captureMemoryConsultation: records an AGENT_PULL fact", () => {
  it("never injects: the hook response is the empty object even when it captures", () => {
    seedTurn();
    const { response } = captureMemoryConsultation(post(), config());
    expect(response).toEqual({});
    expect(Object.keys(response)).toEqual([]);
  });

  it("captures a retrieve_knowledge pull with hits as COMPLETE + RESULTS_RETURNED, delivered, token 1", () => {
    seedTurn("sess_1", 1);
    const { outcome } = captureMemoryConsultation(post(), config());
    expect(outcome).toEqual({
      kind: "CAPTURED",
      consultationId: "con_1",
      source: "AGENT_PULL",
      execution: "COMPLETE",
      result: "RESULTS_RETURNED",
      localTurnSequence: 1,
      orderingToken: 1,
    });
  });

  it("persists the fact under the resolved turn identity with the query's consultation subject", () => {
    seedTurn("sess_1", 4);
    captureMemoryConsultation(post(), config());
    expect(getConsultationAttempt(store, "con_1")).toEqual({
      consultationId: "con_1",
      workspaceId: "ws_abc",
      sessionId: "sess_1",
      localTurnSequence: 4,
      source: "AGENT_PULL",
      consultationSubjects: [buildConsultationSubjectFromQuery(RK_QUERY)],
      execution: "COMPLETE",
      result: "RESULTS_RETURNED",
      deliveredToAnsweringContext: true,
      orderingToken: 1,
      createdAt: FIXED_NOW,
    });
  });

  it("advances the orderingToken for a second pull in the same turn", () => {
    seedTurn();
    const cfg = config();
    captureMemoryConsultation(post(), cfg);
    const { outcome } = captureMemoryConsultation(post(), cfg);
    expect(outcome).toMatchObject({ consultationId: "con_2", orderingToken: 2 });
  });

  it("captures a clean-empty retrieve_knowledge as COMPLETE + NO_MATCH (a no-match still attests consultation)", () => {
    seedTurn();
    const empty = post({
      tool_response: okResult({ tool: "meetless__retrieve_knowledge", count: 0, candidates: [] }),
    });
    const { outcome } = captureMemoryConsultation(empty, config());
    expect(outcome).toMatchObject({ execution: "COMPLETE", result: "NO_MATCH" });
    expect(getConsultationAttempt(store, "con_1")?.result).toBe("NO_MATCH");
  });

  it("captures a kb_doc_detail pull, lifting the consultation subject from document_id", () => {
    seedTurn();
    const docId = "NT:notes/20260617-evidence-consultation-forcing-function-proposal.md";
    const kbd = post({
      tool_name: KBD_TOOL,
      tool_input: { document_id: docId },
      tool_response: okResult({ tool: "meetless__kb_doc_detail", requestedDocumentId: docId }),
    });
    const { outcome } = captureMemoryConsultation(kbd, config());
    expect(outcome).toMatchObject({ execution: "COMPLETE", result: "RESULTS_RETURNED" });
    expect(getConsultationAttempt(store, "con_1")?.consultationSubjects).toEqual([
      buildConsultationSubjectFromQuery(docId),
    ]);
  });

  it("captures a query pull from its query text", () => {
    seedTurn();
    const q = post({
      tool_name: QUERY_TOOL,
      tool_input: { query: "what is our canonical ingestion model", mode: "canonical" },
      tool_response: okResult({ mode: "canonical", answer: "...", workspace: "ws_abc" }),
    });
    const { outcome } = captureMemoryConsultation(q, config());
    expect(outcome).toMatchObject({ execution: "COMPLETE", result: "RESULTS_RETURNED" });
  });
});

describe("captureMemoryConsultation: a failed / unknown retrieval is still a recorded fact", () => {
  it("records an explicit API error as FAILED with a null result", () => {
    seedTurn();
    const { outcome } = captureMemoryConsultation(post({ tool_response: errResult() }), config());
    expect(outcome).toMatchObject({ kind: "CAPTURED", execution: "FAILED", result: null });
    const row = getConsultationAttempt(store, "con_1");
    expect(row?.execution).toBe("FAILED");
    expect(row?.result).toBeNull();
  });

  it("records a malformed / uncorrelatable tool_response as UNKNOWN with a null result", () => {
    seedTurn();
    const { outcome } = captureMemoryConsultation(post({ tool_response: { junk: true } }), config());
    expect(outcome).toMatchObject({ kind: "CAPTURED", execution: "UNKNOWN", result: null });
    expect(getConsultationAttempt(store, "con_1")?.execution).toBe("UNKNOWN");
  });

  it("records unparseable content text as UNKNOWN", () => {
    seedTurn();
    const bad = post({ tool_response: { content: [{ type: "text", text: "not json {" }] } });
    expect(captureMemoryConsultation(bad, config()).outcome).toMatchObject({
      kind: "CAPTURED",
      execution: "UNKNOWN",
    });
  });
});

describe("captureMemoryConsultation: infrastructure problems never become writes or throws", () => {
  it("maps unparseable input to INFRA, empty response, zero writes", () => {
    seedTurn();
    const { response, outcome } = captureMemoryConsultation("not json at all", config());
    expect(response).toEqual({});
    expect(outcome).toEqual({ kind: "INFRA", diagnostic: "malformed hook input" });
    expect(rowCount("consultation_attempt")).toBe(0);
  });

  it("maps a missing session coordinate to INFRA and zero writes", () => {
    seedTurn();
    const { outcome } = captureMemoryConsultation(post({ session_id: undefined }), config());
    expect(outcome).toEqual({ kind: "INFRA", diagnostic: "missing session_id coordinate" });
    expect(rowCount("consultation_attempt")).toBe(0);
  });

  it("maps a governed pull with no query / document_id to INFRA and zero writes", () => {
    seedTurn();
    const { outcome } = captureMemoryConsultation(post({ tool_input: {} }), config());
    expect(outcome).toEqual({ kind: "INFRA", diagnostic: "missing consultation query" });
    expect(rowCount("consultation_attempt")).toBe(0);
  });

  it("maps a pull with no turn to anchor (no assessment yet) to INFRA and zero writes", () => {
    const { outcome } = captureMemoryConsultation(post(), config());
    expect(outcome).toEqual({ kind: "INFRA", diagnostic: "no turn identity for session" });
    expect(rowCount("consultation_attempt")).toBe(0);
  });

  it("maps a persistence failure to INFRA, never a throw", () => {
    seedTurn();
    store.db.exec("DROP TABLE consultation_attempt");
    const { response, outcome } = captureMemoryConsultation(post(), config());
    expect(response).toEqual({});
    expect(outcome.kind).toBe("INFRA");
  });
});

describe("parsePostToolUseInput: defensive shape gate", () => {
  it("returns null for unparseable strings, non-objects, and a missing tool_name / tool_input", () => {
    expect(parsePostToolUseInput("{not json")).toBeNull();
    expect(parsePostToolUseInput(42)).toBeNull();
    expect(parsePostToolUseInput(null)).toBeNull();
    expect(parsePostToolUseInput({ tool_input: {} })).toBeNull();
    expect(parsePostToolUseInput({ tool_name: "" })).toBeNull();
    expect(parsePostToolUseInput({ tool_name: RK_TOOL })).toBeNull();
  });

  it("returns the normalized input for a well-formed payload, string or object", () => {
    const parsed = parsePostToolUseInput(post());
    expect(parsed).toMatchObject({ session_id: "sess_1", tool_name: RK_TOOL });
    expect(parsePostToolUseInput(JSON.stringify(post()))?.tool_name).toBe(RK_TOOL);
  });
});

describe("classifyConsultationTool: the governed-memory pull surface", () => {
  it("recognizes the three pull tools by their meetless suffix", () => {
    expect(classifyConsultationTool(RK_TOOL)).toBe("retrieve_knowledge");
    expect(classifyConsultationTool(KBD_TOOL)).toBe("kb_doc_detail");
    expect(classifyConsultationTool(QUERY_TOOL)).toBe("query");
    expect(classifyConsultationTool("meetless__query")).toBe("query");
  });

  it("rejects non-pull tools, including the verdict write and a foreign query tool", () => {
    expect(classifyConsultationTool("mcp__meetless__meetless__relationship_verdict")).toBeNull();
    expect(classifyConsultationTool("mcp__other__query")).toBeNull();
    expect(classifyConsultationTool("Read")).toBeNull();
    expect(classifyConsultationTool("")).toBeNull();
  });
});

describe("classifyRetrievalEnvelope: COMPLETE / FAILED / UNKNOWN + result", () => {
  it("COMPLETE + RESULTS_RETURNED when the payload carries hits", () => {
    expect(classifyRetrievalEnvelope(okResult({ count: 3, candidates: [1, 2, 3] }))).toEqual({
      execution: "COMPLETE",
      result: "RESULTS_RETURNED",
    });
  });

  it("COMPLETE + NO_MATCH on a clean empty result (count 0 / empty candidates)", () => {
    expect(classifyRetrievalEnvelope(okResult({ count: 0, candidates: [] }))).toEqual({
      execution: "COMPLETE",
      result: "NO_MATCH",
    });
  });

  it("COMPLETE + RESULTS_RETURNED for a structured success with no emptiness signal (kb_doc_detail, query)", () => {
    expect(classifyRetrievalEnvelope(okResult({ mode: "kb_doc_detail", requestedDocumentId: "x" }))).toEqual(
      { execution: "COMPLETE", result: "RESULTS_RETURNED" },
    );
  });

  it("FAILED when isError is set, with no result", () => {
    expect(classifyRetrievalEnvelope(errResult())).toEqual({ execution: "FAILED" });
  });

  it("UNKNOWN for a malformed / missing / unparseable response, with no result", () => {
    expect(classifyRetrievalEnvelope({ junk: true })).toEqual({ execution: "UNKNOWN" });
    expect(classifyRetrievalEnvelope(null)).toEqual({ execution: "UNKNOWN" });
    expect(classifyRetrievalEnvelope({ content: [{ type: "text", text: "nope {" }] })).toEqual({
      execution: "UNKNOWN",
    });
  });
});
