import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import {
  getToolAttempt,
  getRuleEvaluationRecord,
  listEvaluationsForAttempt,
} from "../../../src/lib/rules/interception-store";
import {
  observeAndRecordNotesRule,
  recordR0Observation,
  replayVerdictFromSnapshot,
  type R0PersistenceContext,
} from "../../../src/lib/rules/durable-observation";
import { INTERCEPTION_SCHEMA } from "../../../src/lib/rules/interception-schema";
import { type EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";
import { type ObservedRuleSpec } from "../../../src/lib/rules/types";
import { type RandInt32 } from "../../../src/lib/rules/ulid";
import { type Directive } from "../../../src/lib/scanner/types";

// Persistence slice 4 (proposal §10.2): the R0 acceptance gates R0-1..R0-8, exercised end to end
// through the durable seam against a real ce0 database (no mock DB, no mock store). The genuinely
// new production code this slice adds is the snapshot-pure REPLAY (replayVerdictFromSnapshot): the
// durable verdict must be reproducible from tool_attempt.evaluation_input_snapshot ALONE, with no
// version table, no second filesystem probe, and no read of the evaluation row. The remaining gates
// codify the R0 contract the schema + durable seam already satisfy; where a gate's mechanism is
// owned by a unit suite (the applicability parser's diagnostic for R0-1, the symlink canonicalizer
// for R0-3) the cross-reference is noted and the seam-observable half is asserted here.

let dir: string;
let store: Ce0Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r0-acceptance-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

const FORBIDDEN_ROOT = "notes";
const NOW = 1718700000000;

function notesSpec(over: Partial<ObservedRuleSpec> = {}): ObservedRuleSpec {
  return {
    text: "Notes go in the standalone vault, not the repo.",
    applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } },
    effect: "PROHIBIT",
    forbiddenRootRelativePath: FORBIDDEN_ROOT,
    ...over,
  };
}

// A deterministic ULID randomness source: a counter so two ulids in one call differ.
function counterRand(): RandInt32 {
  let n = 0;
  return () => n++ % 32;
}

function ctx(over: Partial<R0PersistenceContext> = {}): R0PersistenceContext {
  return {
    runtimeScopeId: "scope_a",
    sessionId: "sess_1",
    createdAt: "2026-06-19T00:00:00.000Z",
    now: NOW,
    rand: counterRand(),
    ...over,
  };
}

function directive(): Directive {
  return {
    id: "dir_notes",
    text: "Notes go in the standalone vault, not the repo.",
    source: "CLAUDE.md",
    kind: "RULE",
    strength: "MUST_FOLLOW",
    attestation: "human_attested",
  };
}

function stdin(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess_1",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "notes/x.md", content: "hi" },
    ...over,
  });
}

// An injected runtime classifier so the seam test never touches the filesystem: it echoes the raw
// path back as a runtime-relative one; the forbidden-root verdict is then derived purely from that
// path by the durable seam.
const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

function input(over: Partial<Parameters<typeof observeAndRecordNotesRule>[1]> = {}) {
  return {
    rawStdin: stdin(),
    directives: [directive()],
    runtimeProjectRoot: "/runtime/root",
    runtimeScopeId: "scope_a",
    createdAt: "2026-06-19T00:00:00.000Z",
    now: NOW,
    rand: counterRand(),
    classifyRuntime,
    ...over,
  };
}

const countAttempts = (): number =>
  (store.db.prepare("SELECT COUNT(*) AS n FROM tool_attempt").get() as { n: number }).n;
const countEvals = (): number =>
  (store.db.prepare("SELECT COUNT(*) AS n FROM rule_evaluation_record").get() as { n: number }).n;
const countVersions = (): number =>
  (store.db.prepare("SELECT COUNT(*) AS n FROM local_rule_version").get() as { n: number }).n;

// The DDL block for a single R0 table, for the schema-text gates (R0-2, R0-7).
function r0TableDdl(table: string): string {
  const start = INTERCEPTION_SCHEMA.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = INTERCEPTION_SCHEMA.indexOf(") STRICT;", start);
  expect(end).toBeGreaterThan(start);
  return INTERCEPTION_SCHEMA.slice(start, end);
}

describe("R0-1 scope fails closed (no silent ambient match)", () => {
  it("a tool the rule is not scoped to does not fire an ambient match and persists nothing", async () => {
    const { outcome } = await observeAndRecordNotesRule(
      store,
      input({ rawStdin: stdin({ tool_name: "Bash", tool_input: { command: "ls" } }) }),
    );
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(countAttempts()).toBe(0);
    // The diagnostic-on-broken-matcher half of R0-1 is owned by the applicability parser and is
    // proven in applicability.spec.ts / evaluator.spec.ts; here we prove the durable seam never
    // turns a non-scoped call into a silent observation.
  });
});

describe("R0-2 four-state in, three-state durable", () => {
  it("an applicable-but-undecidable (UNKNOWN) action persists UNKNOWN and routes to the normal flow", async () => {
    const classifyUnknown = async (): Promise<EvaluationTarget> => ({
      kind: "UNKNOWN",
      reasonCode: "CANONICALIZATION_FAILED",
    });
    const { response, outcome } = await observeAndRecordNotesRule(
      store,
      input({ classifyRuntime: classifyUnknown }),
    );
    // An empty response is the normal permission flow: UNKNOWN never denies or asks.
    expect(response).toEqual({});
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind === "PERSISTED") {
      expect(outcome.result).toBe("UNKNOWN");
      expect(getRuleEvaluationRecord(store, outcome.evaluationId)?.result).toBe("UNKNOWN");
    }
  });

  it("a non-matching rule persists no row (NOT_APPLICABLE is selector-internal, never durable)", async () => {
    const { outcome } = await observeAndRecordNotesRule(
      store,
      input({ rawStdin: stdin({ tool_input: { file_path: "notes/x.txt" } }) }),
    );
    expect(outcome).toEqual({ kind: "NOT_APPLICABLE" });
    expect(countAttempts()).toBe(0);
    expect(countEvals()).toBe(0);
  });

  it("the durable result column is three-state: the CHECK admits no NOT_APPLICABLE", () => {
    const ddl = r0TableDdl("rule_evaluation_record");
    expect(ddl).toContain("CHECK (result IN ('COMPLIANT','VIOLATION','UNKNOWN'))");
    expect(ddl).not.toContain("NOT_APPLICABLE");
  });
});

describe("R0-3 path match is canonical or UNKNOWN (real filesystem, real canonicalizer)", () => {
  let runtimeRoot: string;

  beforeEach(() => {
    // realpath so the runtime root is already canonical (macOS /var -> /private/var symlink).
    runtimeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "r0-runtime-")));
    fs.mkdirSync(path.join(runtimeRoot, "notes"));
  });

  afterEach(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

  // No injected classifyRuntime: this exercises the real notes-path canonicalizer through the seam.
  function realInput(filePath: string) {
    return {
      rawStdin: stdin({ tool_input: { file_path: filePath, content: "x" } }),
      directives: [directive()],
      runtimeProjectRoot: runtimeRoot,
      runtimeScopeId: "scope_a",
      createdAt: "2026-06-19T00:00:00.000Z",
      now: NOW,
      rand: counterRand(),
    };
  }

  it("a Write under the notes root canonicalizes to a VIOLATION", async () => {
    const { outcome } = await observeAndRecordNotesRule(
      store,
      realInput(path.join(runtimeRoot, "notes", "x.md")),
    );
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind === "PERSISTED") expect(outcome.result).toBe("VIOLATION");
  });

  it("a Write outside the notes root is COMPLIANT", async () => {
    const { outcome } = await observeAndRecordNotesRule(store, realInput(path.join(runtimeRoot, "src.md")));
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind === "PERSISTED") expect(outcome.result).toBe("COMPLIANT");
  });

  it("an uncanonicalizable (NUL-bearing) path degrades to UNKNOWN, never a verdict", async () => {
    const { outcome } = await observeAndRecordNotesRule(store, realInput("notes/\u0000x.md"));
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind === "PERSISTED") expect(outcome.result).toBe("UNKNOWN");
  });
});

describe("R0-4 two records, observed-arm evaluation, one row per interception", () => {
  it("two interceptions write two distinct attempt rows (no dedupe by tool identity)", async () => {
    const a = await observeAndRecordNotesRule(store, input({ now: NOW }));
    const b = await observeAndRecordNotesRule(store, input({ now: NOW + 1 }));
    expect(a.outcome.kind).toBe("PERSISTED");
    expect(b.outcome.kind).toBe("PERSISTED");
    if (a.outcome.kind === "PERSISTED" && b.outcome.kind === "PERSISTED") {
      // Identical tool_input, yet two distinct locally-minted attempt ids.
      expect(a.outcome.attemptId).not.toBe(b.outcome.attemptId);
    }
    expect(countAttempts()).toBe(2);
    expect(countEvals()).toBe(2);
  });

  it("each interception writes exactly one observed-arm eval; the attempt carries NO_DECISION + NOT_APPLICABLE", async () => {
    const { outcome } = await observeAndRecordNotesRule(store, input());
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind !== "PERSISTED") return;

    const att = getToolAttempt(store, outcome.attemptId);
    expect(att).not.toBeNull();
    expect(att?.aggregateDecision).toBe("NO_DECISION");
    expect(att?.denyEmissionStatus).toBe("NOT_APPLICABLE");

    const evals = listEvaluationsForAttempt(store, outcome.attemptId);
    expect(evals).toHaveLength(1);
    expect(evals[0].observedRuleSnapshot).not.toBeNull();
    expect(evals[0].observedRuleHash).not.toBeNull();
    expect(evals[0].ruleVersionId).toBeNull();
  });
});

describe("R0-5 observed snapshot persisted inline, hashed, replayable from the snapshot alone", () => {
  const cases: Array<[EvaluationTarget, "COMPLIANT" | "VIOLATION" | "UNKNOWN"]> = [
    [{ kind: "RUNTIME_RELATIVE", path: "notes/x.md" }, "VIOLATION"],
    [{ kind: "RUNTIME_RELATIVE", path: "src/x.md" }, "COMPLIANT"],
    [{ kind: "OUTSIDE_RUNTIME_SCOPE" }, "COMPLIANT"],
    [{ kind: "UNKNOWN", reasonCode: "CANONICALIZATION_FAILED" }, "UNKNOWN"],
  ];

  it.each(cases)(
    "replay over the stored snapshot reproduces the persisted %o verdict",
    (target, expected) => {
      const res = recordR0Observation(store, { toolName: "Write", target, spec: notesSpec() }, ctx());
      const att = getToolAttempt(store, res.attemptId);
      const stored = getRuleEvaluationRecord(store, res.evaluationId);
      expect(att).not.toBeNull();
      expect(stored).not.toBeNull();

      const replayed = replayVerdictFromSnapshot(att!.evaluationInputSnapshot);
      expect(replayed.result).toBe(expected);
      expect(replayed.result).toBe(stored!.result);
      expect(replayed.verdictReasonCode).toBe(stored!.verdictReasonCode);
    },
  );

  it("a recorded verdict replays from the stored snapshot alone with NO version table present", async () => {
    const { outcome } = await observeAndRecordNotesRule(store, input()); // notes/x.md -> VIOLATION
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind !== "PERSISTED") return;

    const snapshot = getToolAttempt(store, outcome.attemptId)!.evaluationInputSnapshot;
    const stored = getRuleEvaluationRecord(store, outcome.evaluationId)!;

    // Tear the R1 attestation table out entirely: replay must not depend on it.
    store.db.exec("DROP TABLE local_rule_version");

    const replayed = replayVerdictFromSnapshot(snapshot);
    expect(replayed.result).toBe("VIOLATION");
    expect(replayed.result).toBe(stored.result);
    expect(replayed.verdictReasonCode).toBe(stored.verdictReasonCode);
  });

  it("replay needs nothing but the snapshot string (no store handle, no filesystem)", () => {
    const snapshot = JSON.stringify({
      toolName: "Write",
      target: { kind: "RUNTIME_RELATIVE", path: "notes/deep/x.md" },
      forbiddenRootRelativePath: "notes",
      evaluatorContractVersion: "four-state-evaluator-v1",
      matcherSchemaVersion: "action-applicability-v1",
      pathCanonicalizerVersion: "notes-path-v1",
    });
    expect(replayVerdictFromSnapshot(snapshot)).toEqual({
      result: "VIOLATION",
      verdictReasonCode: "FORBIDDEN_PATH_MATCH",
    });
  });
});

describe("R0-6 no version, no attestation at R0", () => {
  it("no local_rule_version row is written and every eval row has NULL version arm", async () => {
    const { outcome } = await observeAndRecordNotesRule(store, input());
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind !== "PERSISTED") return;

    expect(countVersions()).toBe(0);
    const ev = getRuleEvaluationRecord(store, outcome.evaluationId);
    expect(ev?.ruleVersionId).toBeNull();
    expect(ev?.canonicalPayloadHash).toBeNull();
  });
});

describe("R0-7 no rule-state axis at R0 (no lifecycle, posture, or STALE on an R0 rule row)", () => {
  it.each(["tool_attempt", "rule_evaluation_record"])("%s carries no version-state axis", (table) => {
    const ddl = r0TableDdl(table);
    expect(ddl).not.toMatch(/lifecycle/i);
    expect(ddl).not.toMatch(/posture/i);
    expect(ddl).not.toMatch(/STALE/i);
  });
});

describe("R0-8 observe never grants", () => {
  it("the observe path returns an empty response with no permissionDecision, even for a VIOLATION", async () => {
    const { response, outcome } = await observeAndRecordNotesRule(store, input()); // notes/x.md -> VIOLATION
    expect(outcome.kind).toBe("PERSISTED");
    if (outcome.kind === "PERSISTED") {
      expect(outcome.result).toBe("VIOLATION");
      const ev = getRuleEvaluationRecord(store, outcome.evaluationId);
      // The eligible/effective enforcement is OBSERVE: the observe path cannot deny or ask.
      expect(ev?.eligibleEnforcement).toBe("OBSERVE");
      expect(ev?.effectiveEnforcement).toBe("OBSERVE");
    }
    expect(response).toEqual({});
    expect("permissionDecision" in response).toBe(false);
    expect("hookSpecificOutput" in response).toBe(false);
    expect(Object.keys(response)).toHaveLength(0);
  });
});
