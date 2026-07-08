// The final local interception schema (R0), applied into the one canonical CE0
// evidence database by the existing opener. There is no second database and no
// second migration framework: this DDL is the second db.exec() of openCe0Store's
// single bootstrap, alongside the CE0 forcing-function schema in ce0-store.ts.
//
// Source of truth: notes/20260615-rules-as-node-and-action-interception-consolidated
// -proposal.md §10.1 step 1. The schema is the FINAL state from a fresh database:
// all three tables exist from the first open (no R0-to-R1 schema delta), every
// invariant the proposal claims is a real SQLite mechanism (partial unique index,
// composite runtime-scope-safe foreign key, CHECK, or trigger), and SQLite is the
// sole local authority (decision 4: the hook never reads a bundle file off disk).
//
//   local_rule_version      The attested rule version (R1). The table is created up
//                           front so the evaluation record's version arm resolves at
//                           creation time, but R0 never writes a row here.
//   tool_attempt            One locally-minted ULID per intercepted tool call. PreToolUse
//                           carries no tool_use_id, so the attempt id is the local key.
//   rule_evaluation_record  One verdict per applicable rule per attempt. The observed
//                           arm (R0) carries the frozen observed-rule snapshot + hash;
//                           the version arm (R1) references local_rule_version.
//
// Comments are SQL block comments deliberately: this string is exec'd verbatim, and a
// leading double-hyphen line comment is a forbidden token in this codebase.

// The schema version stamped into the database's user_version pragma. There is no R0-to-R1
// delta (the schema is created in its final state), so this is 1 from the first open. mla doctor
// reads user_version back and fails if it does not match this constant, which is how a stale or
// foreign database is caught before the deny pilot ever evaluates a rule (slice 9, §10.1 step 1(d)).
export const CE0_INTERCEPTION_SCHEMA_VERSION = 1;

export const INTERCEPTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS local_rule_version (
  version_id                 TEXT NOT NULL PRIMARY KEY,  /* ULID */
  rule_id                    TEXT NOT NULL,              /* logical identity, minted at first attestation */
  runtime_scope_id           TEXT NOT NULL,
  rule_payload               TEXT NOT NULL,              /* immutable canonical rule-version-v1 JSON; SOLE authority (decision 6) */
  canonical_payload_hash     TEXT NOT NULL,              /* rule-version-v1 digest, SHA-256 lowercase-hex */
  lifecycle_status           TEXT NOT NULL
                               CHECK (lifecycle_status IN ('LIVE','SUPERSEDED','DEPRECATED','REVOKED')),
  attestation_method         TEXT NOT NULL
                               CHECK (attestation_method IN ('HUMAN_DIRECT','AGENT_ON_USER_REQUEST')),
  attested_by                TEXT NOT NULL,
  supersedes_version_id      TEXT REFERENCES local_rule_version(version_id),
  derived_from_observed_hash TEXT,
  attested_at                TEXT NOT NULL,
  CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> version_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_one_live_version ON local_rule_version (runtime_scope_id, rule_id)
  WHERE lifecycle_status = 'LIVE';
CREATE UNIQUE INDEX IF NOT EXISTS ux_version_payload ON local_rule_version (runtime_scope_id, rule_id, canonical_payload_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ux_version_scope ON local_rule_version (version_id, runtime_scope_id);

CREATE TABLE IF NOT EXISTS tool_attempt (
  attempt_id                  TEXT NOT NULL PRIMARY KEY,   /* ULID minted locally */
  runtime_scope_id            TEXT NOT NULL,
  session_id                  TEXT NOT NULL,
  tool_name                   TEXT NOT NULL,
  evaluation_input_snapshot   TEXT NOT NULL,               /* canonical evaluation-input-v1 JSON (decision 4) */
  evaluation_input_hash       TEXT NOT NULL,
  aggregate_decision          TEXT NOT NULL DEFAULT 'NO_DECISION'
                                CHECK (aggregate_decision IN ('NO_DECISION','DENY')),
  deny_emission_status        TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'
                                CHECK (deny_emission_status IN ('NOT_APPLICABLE','DECISION_RECORDED','RESPONSE_EMITTED')),
  input_authority_config_hash TEXT,
  created_at                  TEXT NOT NULL,
  CHECK ((aggregate_decision = 'NO_DECISION' AND deny_emission_status =  'NOT_APPLICABLE')
      OR (aggregate_decision = 'DENY'        AND deny_emission_status IN ('DECISION_RECORDED','RESPONSE_EMITTED')))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_attempt_scope ON tool_attempt (attempt_id, runtime_scope_id);

CREATE TABLE IF NOT EXISTS rule_evaluation_record (
  evaluation_id          TEXT    NOT NULL PRIMARY KEY,   /* ULID */
  attempt_id             TEXT    NOT NULL,
  runtime_scope_id       TEXT    NOT NULL,
  result                 TEXT    NOT NULL
                           CHECK (result IN ('COMPLIANT','VIOLATION','UNKNOWN')),
  eligible_enforcement   TEXT    NOT NULL
                           CHECK (eligible_enforcement IN ('OBSERVE','ASK','DENY')),
  effective_enforcement  TEXT    NOT NULL                /* NONE when infra is unavailable (decision 5) */
                           CHECK (effective_enforcement IN ('NONE','OBSERVE','ASK','DENY')),
  verdict_reason_code    TEXT    NOT NULL,
  gate_reason_code       TEXT,
  evaluator_contract_version TEXT NOT NULL,
  observed_rule_snapshot TEXT,                           /* canonical observed-rule-v1 JSON */
  observed_rule_hash     TEXT,                           /* observed-rule-v1 digest */
  rule_version_id        TEXT,
  canonical_payload_hash TEXT,
  created_at             TEXT    NOT NULL,
  CHECK ((rule_version_id IS NULL) = (observed_rule_hash IS NOT NULL)),
  CHECK ((observed_rule_hash IS NULL) = (observed_rule_snapshot IS NULL)),
  CHECK ((rule_version_id IS NULL) = (canonical_payload_hash IS NULL)),
  FOREIGN KEY (attempt_id, runtime_scope_id)
    REFERENCES tool_attempt (attempt_id, runtime_scope_id) ON DELETE CASCADE,
  FOREIGN KEY (rule_version_id, runtime_scope_id)
    REFERENCES local_rule_version (version_id, runtime_scope_id)
) STRICT;

CREATE INDEX IF NOT EXISTS        ix_eval_attempt  ON rule_evaluation_record (attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_eval_observed ON rule_evaluation_record (attempt_id, observed_rule_hash)
  WHERE observed_rule_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_eval_version  ON rule_evaluation_record (attempt_id, rule_version_id)
  WHERE rule_version_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_version_immutable
BEFORE UPDATE ON local_rule_version
FOR EACH ROW WHEN NOT (
      NEW.version_id = OLD.version_id
  AND NEW.rule_id = OLD.rule_id
  AND NEW.runtime_scope_id = OLD.runtime_scope_id
  AND NEW.rule_payload = OLD.rule_payload
  AND NEW.canonical_payload_hash = OLD.canonical_payload_hash
  AND NEW.attestation_method = OLD.attestation_method
  AND NEW.attested_by = OLD.attested_by
  AND NEW.supersedes_version_id IS OLD.supersedes_version_id
  AND NEW.derived_from_observed_hash IS OLD.derived_from_observed_hash
  AND NEW.attested_at = OLD.attested_at
  AND OLD.lifecycle_status = 'LIVE'
  AND NEW.lifecycle_status IN ('SUPERSEDED','DEPRECATED','REVOKED'))
BEGIN
  SELECT RAISE(ABORT, 'local_rule_version is immutable except a LIVE->SUPERSEDED/DEPRECATED/REVOKED lifecycle transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_attempt_frozen
BEFORE UPDATE ON tool_attempt
FOR EACH ROW WHEN NOT (
      OLD.aggregate_decision = 'DENY' AND NEW.aggregate_decision = 'DENY'
  AND OLD.deny_emission_status = 'DECISION_RECORDED'
  AND NEW.deny_emission_status = 'RESPONSE_EMITTED'
  AND NEW.attempt_id = OLD.attempt_id
  AND NEW.runtime_scope_id = OLD.runtime_scope_id
  AND NEW.session_id = OLD.session_id
  AND NEW.tool_name = OLD.tool_name
  AND NEW.evaluation_input_snapshot = OLD.evaluation_input_snapshot
  AND NEW.evaluation_input_hash = OLD.evaluation_input_hash
  AND NEW.input_authority_config_hash IS OLD.input_authority_config_hash
  AND NEW.created_at = OLD.created_at)
BEGIN
  SELECT RAISE(ABORT, 'tool_attempt is immutable except the deny emission advance DECISION_RECORDED->RESPONSE_EMITTED');
END;

CREATE TRIGGER IF NOT EXISTS trg_eval_no_update
BEFORE UPDATE ON rule_evaluation_record
BEGIN
  SELECT RAISE(ABORT, 'rule_evaluation_record is append-only (no UPDATE)');
END;

/* The proposal §10.1 names a temp sentinel (temp.sqlite_master / CREATE TEMP TABLE        */
/* _ce0_retention). That form is unimplementable in SQLite 3.49.2: a trigger may not        */
/* reference the temp database (temp.sqlite_master is rejected at CREATE TRIGGER), and the   */
/* unqualified sqlite_temp_master binds to the trigger's own database (main.sqlite_temp_     */
/* master, which never exists) so it always raises. The sentinel is therefore a MAIN-schema  */
/* table. Privacy and transaction-scoping are preserved by SQLite isolation: the retention   */
/* pass runs ONE transaction that creates _ce0_retention, DELETEs the owning tool_attempt    */
/* rows (the cascade reaches the evaluation rows while the sentinel is visible), then drops   */
/* _ce0_retention. The table is never committed, so no other connection can ever observe it   */
/* or piggyback on it; a direct DELETE on any other path finds no sentinel and aborts.        */
CREATE TRIGGER IF NOT EXISTS trg_eval_no_direct_delete
BEFORE DELETE ON rule_evaluation_record
WHEN NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_ce0_retention')
BEGIN
  SELECT RAISE(ABORT, 'rule_evaluation_record delete only via tool_attempt retention cascade (open the retention sentinel)');
END;

/* Stamp the schema version last, after every object exists, so a half-applied schema never reads */
/* back as the current version. mla doctor compares this against CE0_INTERCEPTION_SCHEMA_VERSION.  */
PRAGMA user_version = ${CE0_INTERCEPTION_SCHEMA_VERSION};
`;
