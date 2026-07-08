import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import Database from "better-sqlite3";

import { openCe0Store, closeCe0Store, type Ce0Store } from "../../../src/lib/rules/ce0-store";
import { CE0_INTERCEPTION_SCHEMA_VERSION } from "../../../src/lib/rules/interception-schema";

// Slice 3 (R0): the final local interception schema, applied by the existing canonical
// opener into the one ce0 evidence database (no second DB, no second migration framework).
// notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §10.1 step 1.
// Three tables from the start: local_rule_version (R1 rows, table up front so the version
// arm FK resolves at creation), tool_attempt, rule_evaluation_record. Every claimed invariant
// is a real SQLite mechanism (index, FK, CHECK, trigger), exercised here with raw SQL so the
// schema contract is proven independent of the typed writers (those are Slice 5).

let dir: string;
let store: Ce0Store;
let db: Database.Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interception-schema-"));
  store = openCe0Store(path.join(dir, "evidence.db"));
  db = store.db;
});

afterEach(() => {
  closeCe0Store(store);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Raw insert helpers. Defaults are a valid R0 row set in scope_a; each test
// overrides exactly the fields whose constraint it exercises.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function insertVersion(over: Row = {}): void {
  db.prepare(
    `INSERT INTO local_rule_version
       (version_id, rule_id, runtime_scope_id, rule_payload, canonical_payload_hash,
        lifecycle_status, attestation_method, attested_by, supersedes_version_id,
        derived_from_observed_hash, attested_at)
     VALUES
       (@version_id, @rule_id, @runtime_scope_id, @rule_payload, @canonical_payload_hash,
        @lifecycle_status, @attestation_method, @attested_by, @supersedes_version_id,
        @derived_from_observed_hash, @attested_at)`,
  ).run({
    version_id: "ver_1",
    rule_id: "rule_notes",
    runtime_scope_id: "scope_a",
    rule_payload: '{"effect":"PROHIBIT"}',
    canonical_payload_hash: "payload_hash_1",
    lifecycle_status: "LIVE",
    attestation_method: "HUMAN_DIRECT",
    attested_by: "user_an",
    supersedes_version_id: null,
    derived_from_observed_hash: null,
    attested_at: "2026-06-19T00:00:00Z",
    ...over,
  });
}

function insertAttempt(over: Row = {}): void {
  db.prepare(
    `INSERT INTO tool_attempt
       (attempt_id, runtime_scope_id, session_id, tool_name, evaluation_input_snapshot,
        evaluation_input_hash, aggregate_decision, deny_emission_status,
        input_authority_config_hash, created_at)
     VALUES
       (@attempt_id, @runtime_scope_id, @session_id, @tool_name, @evaluation_input_snapshot,
        @evaluation_input_hash, @aggregate_decision, @deny_emission_status,
        @input_authority_config_hash, @created_at)`,
  ).run({
    attempt_id: "att_1",
    runtime_scope_id: "scope_a",
    session_id: "sess_1",
    tool_name: "Write",
    evaluation_input_snapshot: '{"toolName":"Write"}',
    evaluation_input_hash: "input_hash_1",
    aggregate_decision: "NO_DECISION",
    deny_emission_status: "NOT_APPLICABLE",
    input_authority_config_hash: null,
    created_at: "2026-06-19T00:00:00Z",
    ...over,
  });
}

function insertEval(over: Row = {}): void {
  db.prepare(
    `INSERT INTO rule_evaluation_record
       (evaluation_id, attempt_id, runtime_scope_id, result, eligible_enforcement,
        effective_enforcement, verdict_reason_code, gate_reason_code,
        evaluator_contract_version, observed_rule_snapshot, observed_rule_hash,
        rule_version_id, canonical_payload_hash, created_at)
     VALUES
       (@evaluation_id, @attempt_id, @runtime_scope_id, @result, @eligible_enforcement,
        @effective_enforcement, @verdict_reason_code, @gate_reason_code,
        @evaluator_contract_version, @observed_rule_snapshot, @observed_rule_hash,
        @rule_version_id, @canonical_payload_hash, @created_at)`,
  ).run({
    evaluation_id: "eval_1",
    attempt_id: "att_1",
    runtime_scope_id: "scope_a",
    result: "COMPLIANT",
    eligible_enforcement: "OBSERVE",
    effective_enforcement: "OBSERVE",
    verdict_reason_code: "VR_OK",
    gate_reason_code: null,
    evaluator_contract_version: "evaluator_v1",
    observed_rule_snapshot: '{"text":"keep notes in the vault"}',
    observed_rule_hash: "observed_hash_1",
    rule_version_id: null,
    canonical_payload_hash: null,
    created_at: "2026-06-19T00:00:00Z",
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Connection posture: WAL, foreign keys, a bounded busy timeout.
// ---------------------------------------------------------------------------

describe("connection posture", () => {
  test("WAL journal mode is set", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  test("foreign keys are enforced", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  test("busy timeout is bounded at 50 ms (PreToolUse must never block)", () => {
    const busy = db.pragma("busy_timeout", { simple: true }) as number;
    expect(busy).toBeGreaterThan(0);
    expect(busy).toBeLessThanOrEqual(50);
  });

  test("schema version is stamped into user_version (mla doctor reads this)", () => {
    expect(CE0_INTERCEPTION_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(db.pragma("user_version", { simple: true })).toBe(CE0_INTERCEPTION_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Tables exist from the start, and the three are STRICT.
// ---------------------------------------------------------------------------

describe("schema shape", () => {
  test("all three tables exist from the first open", () => {
    const names = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["local_rule_version", "tool_attempt", "rule_evaluation_record"]));
  });

  test.each(["local_rule_version", "tool_attempt", "rule_evaluation_record"])(
    "%s is declared STRICT",
    (table) => {
      const { sql } = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table) as { sql: string };
      expect(sql).toMatch(/\)\s*STRICT;?\s*$/);
    },
  );

  test("STRICT rejects a wrong-typed value (BLOB into a TEXT column)", () => {
    expect(() => insertAttempt({ tool_name: Buffer.from([1, 2, 3]) })).toThrow(
      /cannot store BLOB value in TEXT column/i,
    );
  });
});

// ---------------------------------------------------------------------------
// local_rule_version CHECK constraints.
// ---------------------------------------------------------------------------

describe("local_rule_version CHECKs", () => {
  test("accepts a valid LIVE version", () => {
    expect(() => insertVersion()).not.toThrow();
  });

  test("rejects an unknown lifecycle_status", () => {
    expect(() => insertVersion({ lifecycle_status: "ROLLING_OUT" })).toThrow(/CHECK constraint failed/);
  });

  test("rejects an unknown attestation_method (no MACHINE_INFERRED)", () => {
    expect(() => insertVersion({ attestation_method: "MACHINE_INFERRED" })).toThrow(
      /CHECK constraint failed/,
    );
  });

  test("rejects a self-superseding version", () => {
    expect(() => insertVersion({ supersedes_version_id: "ver_1" })).toThrow(/CHECK constraint failed/);
  });

  test("accepts a version that supersedes a different version", () => {
    insertVersion({ version_id: "ver_0", canonical_payload_hash: "h0", lifecycle_status: "SUPERSEDED" });
    expect(() =>
      insertVersion({ version_id: "ver_1", canonical_payload_hash: "h1", supersedes_version_id: "ver_0" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// local_rule_version unique indexes.
// ---------------------------------------------------------------------------

describe("local_rule_version unique indexes", () => {
  test("at most one LIVE version per (scope, rule)", () => {
    insertVersion({ version_id: "ver_1", canonical_payload_hash: "h1" });
    expect(() => insertVersion({ version_id: "ver_2", canonical_payload_hash: "h2" })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  test("a SUPERSEDED version may coexist with the LIVE one (partial index is LIVE-only)", () => {
    insertVersion({ version_id: "ver_1", canonical_payload_hash: "h1" });
    expect(() =>
      insertVersion({ version_id: "ver_2", canonical_payload_hash: "h2", lifecycle_status: "SUPERSEDED" }),
    ).not.toThrow();
  });

  test("a second LIVE version is allowed in a different runtime scope", () => {
    insertVersion({ version_id: "ver_1" });
    expect(() => insertVersion({ version_id: "ver_2", runtime_scope_id: "scope_b" })).not.toThrow();
  });

  test("a payload hash is de-duplicated within (scope, rule), regardless of lifecycle", () => {
    insertVersion({ version_id: "ver_1", canonical_payload_hash: "dupe", lifecycle_status: "LIVE" });
    expect(() =>
      insertVersion({ version_id: "ver_2", canonical_payload_hash: "dupe", lifecycle_status: "SUPERSEDED" }),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

// ---------------------------------------------------------------------------
// tool_attempt CHECK constraints.
// ---------------------------------------------------------------------------

describe("tool_attempt CHECKs", () => {
  test("accepts a NO_DECISION + NOT_APPLICABLE observation", () => {
    expect(() => insertAttempt()).not.toThrow();
  });

  test("rejects an unknown aggregate_decision (only NO_DECISION or DENY)", () => {
    expect(() => insertAttempt({ aggregate_decision: "ALLOW" })).toThrow(/CHECK constraint failed/);
  });

  test("rejects an unknown deny_emission_status", () => {
    expect(() => insertAttempt({ aggregate_decision: "DENY", deny_emission_status: "SENT" })).toThrow(
      /CHECK constraint failed/,
    );
  });

  test("rejects NO_DECISION paired with a deny emission status", () => {
    expect(() =>
      insertAttempt({ aggregate_decision: "NO_DECISION", deny_emission_status: "DECISION_RECORDED" }),
    ).toThrow(/CHECK constraint failed/);
  });

  test("rejects DENY paired with NOT_APPLICABLE", () => {
    expect(() =>
      insertAttempt({ aggregate_decision: "DENY", deny_emission_status: "NOT_APPLICABLE" }),
    ).toThrow(/CHECK constraint failed/);
  });

  test("accepts DENY + DECISION_RECORDED (the inserted-deny shape)", () => {
    expect(() =>
      insertAttempt({ aggregate_decision: "DENY", deny_emission_status: "DECISION_RECORDED" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rule_evaluation_record CHECK constraints (enum domains + the XOR arms).
// ---------------------------------------------------------------------------

describe("rule_evaluation_record CHECKs", () => {
  beforeEach(() => insertAttempt());

  test("accepts a valid observed-arm verdict", () => {
    expect(() => insertEval()).not.toThrow();
  });

  test("rejects an unknown result (three-state durable)", () => {
    expect(() => insertEval({ result: "NOT_APPLICABLE" })).toThrow(/CHECK constraint failed/);
  });

  test("rejects an unknown eligible_enforcement", () => {
    expect(() => insertEval({ eligible_enforcement: "NONE" })).toThrow(/CHECK constraint failed/);
  });

  test("accepts effective_enforcement = NONE (infra unavailable)", () => {
    expect(() => insertEval({ effective_enforcement: "NONE" })).not.toThrow();
  });

  test("rejects an unknown effective_enforcement", () => {
    expect(() => insertEval({ effective_enforcement: "WARN" })).toThrow(/CHECK constraint failed/);
  });

  test("rejects a row with NEITHER arm present", () => {
    expect(() =>
      insertEval({ observed_rule_hash: null, observed_rule_snapshot: null, rule_version_id: null }),
    ).toThrow(/CHECK constraint failed/);
  });

  test("rejects a row with BOTH arms present", () => {
    insertVersion();
    expect(() =>
      insertEval({ rule_version_id: "ver_1", canonical_payload_hash: "payload_hash_1" }),
    ).toThrow(/CHECK constraint failed/);
  });

  test("rejects an observed arm with a hash but no snapshot", () => {
    expect(() => insertEval({ observed_rule_snapshot: null })).toThrow(/CHECK constraint failed/);
  });

  test("accepts a version arm (R1 shape) once its version exists", () => {
    insertVersion();
    expect(() =>
      insertEval({
        evaluation_id: "eval_v",
        observed_rule_hash: null,
        observed_rule_snapshot: null,
        rule_version_id: "ver_1",
        canonical_payload_hash: "payload_hash_1",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rule_evaluation_record idempotence (per-arm partial unique indexes, R0-4).
// ---------------------------------------------------------------------------

describe("rule_evaluation_record per-arm idempotence", () => {
  beforeEach(() => insertAttempt());

  test("two observed verdicts of one attempt against the same observed rule collide", () => {
    insertEval({ evaluation_id: "eval_1", observed_rule_hash: "same" });
    expect(() => insertEval({ evaluation_id: "eval_2", observed_rule_hash: "same" })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  test("two version verdicts of one attempt against the same version collide", () => {
    insertVersion();
    const versionArm = {
      observed_rule_hash: null,
      observed_rule_snapshot: null,
      rule_version_id: "ver_1",
      canonical_payload_hash: "payload_hash_1",
    };
    insertEval({ evaluation_id: "eval_1", ...versionArm });
    expect(() => insertEval({ evaluation_id: "eval_2", ...versionArm })).toThrow(/UNIQUE constraint failed/);
  });
});

// ---------------------------------------------------------------------------
// Composite, runtime-scope-safe foreign keys.
// ---------------------------------------------------------------------------

describe("composite scope-safe foreign keys", () => {
  test("an evaluation must reference an existing attempt", () => {
    expect(() => insertEval({ attempt_id: "ghost" })).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("an evaluation cannot bind an attempt from another runtime scope", () => {
    insertAttempt({ attempt_id: "att_1", runtime_scope_id: "scope_a" });
    // Same attempt_id, different scope: the composite (attempt_id, runtime_scope_id) has no match.
    expect(() => insertEval({ attempt_id: "att_1", runtime_scope_id: "scope_b" })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  test("an evaluation binds an attempt within its own scope", () => {
    insertAttempt();
    expect(() => insertEval()).not.toThrow();
  });

  test("a version arm cannot bind a version from another runtime scope", () => {
    insertVersion({ version_id: "ver_1", runtime_scope_id: "scope_a" });
    insertAttempt({ attempt_id: "att_b", runtime_scope_id: "scope_b" });
    expect(() =>
      insertEval({
        evaluation_id: "eval_x",
        attempt_id: "att_b",
        runtime_scope_id: "scope_b",
        observed_rule_hash: null,
        observed_rule_snapshot: null,
        rule_version_id: "ver_1",
        canonical_payload_hash: "payload_hash_1",
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

// ---------------------------------------------------------------------------
// trg_version_immutable: only a one-way LIVE -> terminal lifecycle move.
// ---------------------------------------------------------------------------

describe("trg_version_immutable", () => {
  test("allows a LIVE -> SUPERSEDED lifecycle transition", () => {
    insertVersion();
    expect(() =>
      db.prepare(`UPDATE local_rule_version SET lifecycle_status = 'SUPERSEDED' WHERE version_id = 'ver_1'`).run(),
    ).not.toThrow();
  });

  test("rejects editing the payload (immutability, not the dedup index)", () => {
    insertVersion();
    expect(() =>
      db.prepare(`UPDATE local_rule_version SET rule_payload = '{"effect":"REQUIRE"}' WHERE version_id = 'ver_1'`).run(),
    ).toThrow(/immutable except a LIVE/);
  });

  test("rejects a payload edit smuggled alongside a valid lifecycle move", () => {
    insertVersion();
    expect(() =>
      db
        .prepare(
          `UPDATE local_rule_version SET lifecycle_status = 'SUPERSEDED', rule_payload = 'x' WHERE version_id = 'ver_1'`,
        )
        .run(),
    ).toThrow(/immutable except a LIVE/);
  });

  test("rejects resurrecting a terminal version to LIVE", () => {
    insertVersion({ lifecycle_status: "SUPERSEDED" });
    expect(() =>
      db.prepare(`UPDATE local_rule_version SET lifecycle_status = 'LIVE' WHERE version_id = 'ver_1'`).run(),
    ).toThrow(/immutable except a LIVE/);
  });

  test("rejects terminal-to-terminal churn", () => {
    insertVersion({ lifecycle_status: "SUPERSEDED" });
    expect(() =>
      db.prepare(`UPDATE local_rule_version SET lifecycle_status = 'DEPRECATED' WHERE version_id = 'ver_1'`).run(),
    ).toThrow(/immutable except a LIVE/);
  });
});

// ---------------------------------------------------------------------------
// trg_attempt_frozen: only the deny-emission advance.
// ---------------------------------------------------------------------------

describe("trg_attempt_frozen", () => {
  test("allows DECISION_RECORDED -> RESPONSE_EMITTED with the decision held at DENY", () => {
    insertAttempt({ aggregate_decision: "DENY", deny_emission_status: "DECISION_RECORDED" });
    expect(() =>
      db.prepare(`UPDATE tool_attempt SET deny_emission_status = 'RESPONSE_EMITTED' WHERE attempt_id = 'att_1'`).run(),
    ).not.toThrow();
  });

  test("rejects upgrading NO_DECISION to DENY (a deny is inserted, never upgraded)", () => {
    insertAttempt();
    expect(() =>
      db
        .prepare(
          `UPDATE tool_attempt SET aggregate_decision = 'DENY', deny_emission_status = 'DECISION_RECORDED' WHERE attempt_id = 'att_1'`,
        )
        .run(),
    ).toThrow(/immutable except the deny emission advance/);
  });

  test("rejects editing a frozen field alongside the deny advance", () => {
    insertAttempt({ aggregate_decision: "DENY", deny_emission_status: "DECISION_RECORDED" });
    expect(() =>
      db
        .prepare(
          `UPDATE tool_attempt SET deny_emission_status = 'RESPONSE_EMITTED', tool_name = 'Edit' WHERE attempt_id = 'att_1'`,
        )
        .run(),
    ).toThrow(/immutable except the deny emission advance/);
  });
});

// ---------------------------------------------------------------------------
// rule_evaluation_record is append-only (no UPDATE; DELETE only via retention cascade).
// ---------------------------------------------------------------------------

describe("rule_evaluation_record append-only", () => {
  beforeEach(() => {
    insertAttempt();
    insertEval();
  });

  test("rejects any direct UPDATE", () => {
    expect(() =>
      db.prepare(`UPDATE rule_evaluation_record SET result = 'VIOLATION' WHERE evaluation_id = 'eval_1'`).run(),
    ).toThrow(/append-only/);
  });

  test("rejects a direct DELETE without the retention sentinel", () => {
    expect(() =>
      db.prepare(`DELETE FROM rule_evaluation_record WHERE evaluation_id = 'eval_1'`).run(),
    ).toThrow(/retention cascade/);
  });

  test("allows the retention cascade: delete the owning attempt under the sentinel", () => {
    // The sentinel is a main-schema table created and dropped inside the one retention
    // transaction (the proposal's temp-table form is unimplementable: a trigger may not
    // reference the temp database). Transaction isolation keeps it private and uncommitted.
    const retain = db.transaction(() => {
      db.exec(`CREATE TABLE _ce0_retention (x)`);
      db.prepare(`DELETE FROM tool_attempt WHERE attempt_id = 'att_1'`).run();
      db.exec(`DROP TABLE _ce0_retention`);
    });
    expect(() => retain()).not.toThrow();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM rule_evaluation_record`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  test("the retention sentinel never persists after the transaction", () => {
    const retain = db.transaction(() => {
      db.exec(`CREATE TABLE _ce0_retention (x)`);
      db.prepare(`DELETE FROM tool_attempt WHERE attempt_id = 'att_1'`).run();
      db.exec(`DROP TABLE _ce0_retention`);
    });
    retain();
    const sentinel = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_ce0_retention'`)
      .get() as { n: number };
    expect(sentinel.n).toBe(0);
  });
});
