// The §5.1 envelope-boundary LAW, promoted to a shared support module so every spec
// that captures a real machine envelope enforces the SAME protocol contract rather than
// hand-rolling a partial check ("promote helpers, don't duplicate"). It is a pure
// assertion over the raw stdout string: parse exactly one JSON document, match the
// envelope schema, and enforce the connector-trust boundary the executor contract
// depends on. It is deliberately framework-agnostic (plain Errors, no `expect`) so the
// same law runs from any spec and each violation names itself.
//
// The load, verbatim from §5.1:
//   - stdout parses as EXACTLY one JSON document;
//   - it matches the envelope schema (protocol, schema_version === 1, command, ok);
//   - `ok` and the result/error arms agree (result XOR error);
//   - AT MOST one of next_action / decision_request is present;
//   - next_action uses only the closed kind/ref enums and carries no shell-command string;
//   - a decision_request carries only typed selections and no shell-command string;
//   - the PRODUCT-AUTHORED human_summary contains no `mla <verb>` imperative.
//
// What the law does NOT touch: the `result` object. §5.1 leaves it "unrestricted and
// treated as untrusted" because it may legitimately quote a command as data (e.g. a rule
// statement). The connector never executes anything inside `result`, so the law never
// recurses into it. Scanning result for an imperative would be exactly the confusion the
// boundary exists to prevent.

import {
  MACHINE_PROTOCOL,
  MACHINE_SCHEMA_VERSION,
  MachineEnvelope,
  NextAction,
  DecisionRequest,
} from "../../src/lib/machine-output";

// A bare `mla <verb>` imperative in human-facing prose is the leak the whole proposal
// closes: it is a runnable command handed to a reader. `\bmla\s+[a-z]` matches the CLI
// name followed by a lowercase word (a subcommand), which is what every runnable `mla`
// invocation looks like and what convenience prose must never contain.
export const MLA_IMPERATIVE = /\bmla\s+[a-z]/i;

function fail(msg: string): never {
  throw new Error(`envelope-boundary: ${msg}`);
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse the raw stdout as EXACTLY one JSON document. `JSON.parse` already rejects a
 * trailing second document (`{...}{...}` throws), so a successful parse of the whole
 * (trimmed) string is the single-document guarantee. Empty stdout is a violation: a
 * machine-supported command must emit an envelope.
 */
export function parseSingleEnvelopeDocument(raw: string): unknown {
  const trimmed = raw.trim();
  check(trimmed.length > 0, "stdout is empty; a machine-supported command must emit one envelope");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    fail(`stdout is not a single JSON document: ${(err as Error).message}`);
  }
  return parsed;
}

function assertClosedNextAction(na: unknown): asserts na is NextAction {
  check(isPlainObject(na), "next_action must be an object");
  const o = na as Record<string, unknown>;
  check(o.kind === "skill", `next_action.kind must be the closed value "skill", got ${JSON.stringify(o.kind)}`);
  check(o.ref === "onboard", `next_action.ref must be the closed value "onboard", got ${JSON.stringify(o.ref)}`);
  const extra = Object.keys(o).filter((k) => k !== "kind" && k !== "ref");
  check(extra.length === 0, `next_action carries unexpected keys: ${extra.join(", ")}`);
  // Closed enums cannot hold a shell string, but assert the boundary explicitly so a
  // regression that widens the enum to a command string is caught here, not in prod.
  for (const v of Object.values(o)) {
    if (typeof v === "string") {
      check(!MLA_IMPERATIVE.test(v), `next_action carries a shell-command string: ${JSON.stringify(v)}`);
    }
  }
}

function assertTypedSelection(sel: unknown, where: string): void {
  check(isPlainObject(sel), `${where}.selection must be an object`);
  const s = sel as Record<string, unknown>;
  if (s.mode === "all" || s.mode === "none") {
    const extra = Object.keys(s).filter((k) => k !== "mode");
    check(extra.length === 0, `${where}.selection(${String(s.mode)}) carries unexpected keys: ${extra.join(", ")}`);
    return;
  }
  if (s.mode === "only") {
    check(Array.isArray(s.candidate_ids), `${where}.selection(only) must carry a candidate_ids array`);
    for (const id of s.candidate_ids as unknown[]) {
      check(typeof id === "string" && id.length > 0, `${where}.selection(only) candidate id must be a non-empty string`);
    }
    const extra = Object.keys(s).filter((k) => k !== "mode" && k !== "candidate_ids");
    check(extra.length === 0, `${where}.selection(only) carries unexpected keys: ${extra.join(", ")}`);
    return;
  }
  fail(`${where}.selection.mode must be one of all|only|none, got ${JSON.stringify(s.mode)}`);
}

function assertDecisionRequest(dr: unknown): asserts dr is DecisionRequest {
  check(isPlainObject(dr), "decision_request must be an object");
  const o = dr as Record<string, unknown>;
  check(o.kind === "enrich.accept", `decision_request.kind must be the closed value "enrich.accept", got ${JSON.stringify(o.kind)}`);
  check(isPlainObject(o.subject), "decision_request.subject must be an object");
  const subject = o.subject as Record<string, unknown>;
  check(
    typeof subject.run_id === "string" && subject.run_id.length > 0,
    "decision_request.subject.run_id must be a non-empty string",
  );
  check(typeof o.prompt === "string" && o.prompt.length > 0, "decision_request.prompt must be a non-empty string");
  check(
    !MLA_IMPERATIVE.test(o.prompt as string),
    `decision_request.prompt carries a shell-command string: ${JSON.stringify(o.prompt)}`,
  );
  check(Array.isArray(o.options) && o.options.length > 0, "decision_request.options must be a non-empty array");
  const seenIds = new Set<string>();
  for (const [i, opt] of (o.options as unknown[]).entries()) {
    const where = `decision_request.options[${i}]`;
    check(isPlainObject(opt), `${where} must be an object`);
    const op = opt as Record<string, unknown>;
    check(typeof op.id === "string" && op.id.length > 0, `${where}.id must be a non-empty string`);
    check(!seenIds.has(op.id as string), `${where}.id is duplicated: ${JSON.stringify(op.id)}`);
    seenIds.add(op.id as string);
    check(typeof op.label === "string" && op.label.length > 0, `${where}.label must be a non-empty string`);
    // No shell command anywhere the human reads: id and label are the human-facing
    // strings. The typed `selection` is what the connector acts on; it never carries a
    // command, so a runnable string can only sneak in through prose. Assert both.
    check(!MLA_IMPERATIVE.test(op.id as string), `${where}.id carries a shell-command string: ${JSON.stringify(op.id)}`);
    check(!MLA_IMPERATIVE.test(op.label as string), `${where}.label carries a shell-command string: ${JSON.stringify(op.label)}`);
    check(!("command" in op), `${where} must not carry a "command" field; the connector maps the typed selection to argv`);
    assertTypedSelection(op.selection, where);
    // The option is exactly {id,label,selection}; nothing else is part of the contract.
    const extra = Object.keys(op).filter((k) => k !== "id" && k !== "label" && k !== "selection");
    check(extra.length === 0, `${where} carries unexpected keys: ${extra.join(", ")}`);
  }
}

const SUCCESS_KEYS = new Set([
  "protocol",
  "schema_version",
  "command",
  "ok",
  "result",
  "next_action",
  "decision_request",
  "human_summary",
]);
const ERROR_KEYS = new Set(["protocol", "schema_version", "command", "ok", "error"]);

/**
 * Assert the raw stdout is a single well-formed machine envelope obeying the full §5.1
 * boundary, and return it typed. Throws a named Error on the first violation. Callers may
 * make further, envelope-specific assertions on the returned value (e.g. a particular
 * command name or result shape); this law owns only the protocol boundary.
 */
export function assertEnvelopeBoundary(raw: string): MachineEnvelope {
  const env = parseSingleEnvelopeDocument(raw);
  check(isPlainObject(env), "envelope must be a JSON object (not an array or scalar)");
  const o = env as Record<string, unknown>;

  check(o.protocol === MACHINE_PROTOCOL, `protocol must be ${JSON.stringify(MACHINE_PROTOCOL)}, got ${JSON.stringify(o.protocol)}`);
  check(
    o.schema_version === MACHINE_SCHEMA_VERSION,
    `schema_version must be ${MACHINE_SCHEMA_VERSION}, got ${JSON.stringify(o.schema_version)}`,
  );
  check(typeof o.command === "string" && (o.command as string).length > 0, "command must be a non-empty string");
  check(typeof o.ok === "boolean", "ok must be a boolean");

  // result XOR error, agreeing with `ok`. `ok === (exitCode === 0)` is enforced at emit
  // time; here we enforce the shape the two arms imply.
  const hasResult = "result" in o;
  const hasError = "error" in o;
  check(hasResult !== hasError, "envelope must carry exactly one of result / error");

  if (o.ok === true) {
    check(hasResult, "a success envelope (ok:true) must carry result");
    // result is UNTRUSTED and UNRESTRICTED: intentionally not inspected. It may be any
    // JSON, including a string that quotes a command as data.
    const extra = Object.keys(o).filter((k) => !SUCCESS_KEYS.has(k));
    check(extra.length === 0, `success envelope carries unexpected top-level keys: ${extra.join(", ")}`);

    const hasNext = "next_action" in o;
    const hasDecision = "decision_request" in o;
    check(!(hasNext && hasDecision), "an envelope must not carry both next_action and decision_request");
    if (hasNext) assertClosedNextAction(o.next_action);
    if (hasDecision) assertDecisionRequest(o.decision_request);

    if ("human_summary" in o) {
      check(typeof o.human_summary === "string", "human_summary must be a string when present");
      check(
        !MLA_IMPERATIVE.test(o.human_summary as string),
        `product-authored human_summary carries an "mla <verb>" imperative (it must never be a command): ${JSON.stringify(o.human_summary)}`,
      );
    }
  } else {
    check(hasError, "an error envelope (ok:false) must carry error");
    check("next_action" in o === false, "an error envelope must not carry next_action");
    check("decision_request" in o === false, "an error envelope must not carry decision_request");
    check("human_summary" in o === false, "an error envelope must not carry human_summary");
    const extra = Object.keys(o).filter((k) => !ERROR_KEYS.has(k));
    check(extra.length === 0, `error envelope carries unexpected top-level keys: ${extra.join(", ")}`);
    check(isPlainObject(o.error), "error must be an object");
    const errBody = o.error as Record<string, unknown>;
    check(typeof errBody.code === "string" && (errBody.code as string).length > 0, "error.code must be a non-empty string");
    check(typeof errBody.message === "string", "error.message must be a string");
    check(typeof errBody.trace_id === "string", "error.trace_id must be a string");
  }

  return env as unknown as MachineEnvelope;
}
