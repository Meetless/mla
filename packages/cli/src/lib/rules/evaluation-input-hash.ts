import { createHash } from "crypto";

import { CanonicalObject, canonicalize } from "./canonical-json";

/**
 * The `evaluation-input-v1` canonical hash domain (proposal §10.1 step 2, decision 4).
 *
 * It computes the content identity of the ACTION-SIDE replay basis: the
 * post-canonicalization compliance-replay input the R0 build persists as
 * tool_attempt.evaluation_input_snapshot. This is NOT a rule hash; it is the exact input the
 * four-state evaluator judged, so a later replay can recompute the verdict from the stored
 * snapshot alone, with no re-read of CLAUDE.md and no second filesystem probe. The digest is
 *
 *     SHA-256( domainTag || 0x00 || JCS(payload) )   (lowercase hex)
 *
 * where JCS is the repo's existing RFC 8785 canonicalizer (canonical-json.ts) and the domain
 * tag + single 0x00 separator (decision 6) guarantee this digest can NEVER collide with the
 * observed snapshot (`observed-rule-v1`), an attested version (`rule-version-v1`), or any other
 * hashed artifact, even when two normalized bodies are byte-identical. JCS escapes control
 * characters, so the only raw 0x00 byte in the hash input is the separator; the boundary
 * between tag and payload is unambiguous.
 *
 * LOCKED SHAPE (proposal §10.1 step 2): exactly these JSON names, and `target` is the
 * discriminated three-arm union. An in-scope target is a runtime-root-RELATIVE `path` (never an
 * absolute home path); an out-of-scope target carries no path; an uncanonicalizable target is
 * `UNKNOWN` with the single locked `reasonCode: "CANONICALIZATION_FAILED"`. The payload
 * deliberately EXCLUDES file contents, tool output, and any unrestricted absolute home path. No
 * unknown fields (fail-closed); no floats (float-free by construction).
 *
 * Universal-NFC caveat (honest). Unlike `observed-rule-v1`, this payload has NO prose field:
 * `toolName` is an enum, `path` and `forbiddenRootRelativePath` are filesystem-derived, and the
 * three version tags are opaque. The proposal's per-field rule says filesystem-derived and opaque
 * values stay byte-for-byte; the vendored JCS primitive applies NFC to EVERY string. For the
 * all-ASCII notes-location pilot every field is NFC-stable, so universal NFC is byte-identical to
 * the per-field rule and the golden vectors are contract-correct. When a future evaluation input
 * can carry a non-NFC `path` (for instance a target path with combining marks), this domain must
 * switch to a per-field-NFC encoder so those bytes are preserved verbatim. That boundary is
 * recorded in the ledger.
 */
export const EVALUATION_INPUT_HASH_DOMAIN = "evaluation-input-v1";

/** The locked reasonCode for an uncanonicalizable target. */
export const CANONICALIZATION_FAILED = "CANONICALIZATION_FAILED";

/** The discriminated three-arm target union (proposal §10.1 step 2). */
export type EvaluationTarget =
  | { kind: "RUNTIME_RELATIVE"; path: string }
  | { kind: "OUTSIDE_RUNTIME_SCOPE" }
  | { kind: "UNKNOWN"; reasonCode: "CANONICALIZATION_FAILED" };

/** The frozen evaluation-input-v1 shape persisted as tool_attempt.evaluation_input_snapshot. */
export interface EvaluationInputV1 {
  toolName: "Write" | "Edit";
  target: EvaluationTarget;
  forbiddenRootRelativePath: string;
  evaluatorContractVersion: string;
  matcherSchemaVersion: string;
  pathCanonicalizerVersion: string;
}

/** Thrown when an input carries a field or value outside the evaluation-input-v1 schema. */
export class EvaluationInputHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationInputHashError";
  }
}

// The closed key sets for each object in the payload schema. Unknown fields are an error
// (decision 6), so a forward-incompatible producer cannot silently mint a hash a consumer
// would compute differently.
const TOP_LEVEL_KEYS = new Set([
  "toolName",
  "target",
  "forbiddenRootRelativePath",
  "evaluatorContractVersion",
  "matcherSchemaVersion",
  "pathCanonicalizerVersion",
]);
const TARGET_RUNTIME_RELATIVE_KEYS = new Set(["kind", "path"]);
const TARGET_OUTSIDE_KEYS = new Set(["kind"]);
const TARGET_UNKNOWN_KEYS = new Set(["kind", "reasonCode"]);

function rejectUnknownKeys(obj: object, allowed: Set<string>, context: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new EvaluationInputHashError(
        `unknown field '${key}' in ${context} is outside the ${EVALUATION_INPUT_HASH_DOMAIN} schema`,
      );
    }
  }
}

function buildTargetPayload(target: EvaluationTarget): CanonicalObject {
  switch (target.kind) {
    case "RUNTIME_RELATIVE":
      rejectUnknownKeys(target, TARGET_RUNTIME_RELATIVE_KEYS, "target(RUNTIME_RELATIVE)");
      return { kind: "RUNTIME_RELATIVE", path: target.path };
    case "OUTSIDE_RUNTIME_SCOPE":
      rejectUnknownKeys(target, TARGET_OUTSIDE_KEYS, "target(OUTSIDE_RUNTIME_SCOPE)");
      return { kind: "OUTSIDE_RUNTIME_SCOPE" };
    case "UNKNOWN":
      rejectUnknownKeys(target, TARGET_UNKNOWN_KEYS, "target(UNKNOWN)");
      if (target.reasonCode !== CANONICALIZATION_FAILED) {
        throw new EvaluationInputHashError(
          `target(UNKNOWN).reasonCode must be '${CANONICALIZATION_FAILED}', got '${String(target.reasonCode)}'`,
        );
      }
      return { kind: "UNKNOWN", reasonCode: CANONICALIZATION_FAILED };
    default: {
      const unexpected = target as { kind?: unknown };
      throw new EvaluationInputHashError(
        `unknown target kind '${String(unexpected.kind)}' is outside the ${EVALUATION_INPUT_HASH_DOMAIN} schema`,
      );
    }
  }
}

/**
 * Build the closed canonical payload for an EvaluationInputV1: the exact object that gets
 * canonicalized and hashed. Rejects unknown fields and an unknown target arm, and locks the
 * UNKNOWN reasonCode. Field NFC is applied by the JCS encoder on the way out; see the
 * universal-NFC caveat in the file header.
 */
export function buildEvaluationInputPayload(input: EvaluationInputV1): CanonicalObject {
  rejectUnknownKeys(input, TOP_LEVEL_KEYS, "evaluation input");
  return {
    toolName: input.toolName,
    target: buildTargetPayload(input.target),
    forbiddenRootRelativePath: input.forbiddenRootRelativePath,
    evaluatorContractVersion: input.evaluatorContractVersion,
    matcherSchemaVersion: input.matcherSchemaVersion,
    pathCanonicalizerVersion: input.pathCanonicalizerVersion,
  };
}

/** The exact RFC 8785 canonical JSON string that is hashed (UTF-8). Exposed for golden
 * vectors and debugging; the digest is over these bytes prefixed by the domain. */
export function serializeEvaluationInput(input: EvaluationInputV1): string {
  return canonicalize(buildEvaluationInputPayload(input));
}

/** The evaluation-input-v1 content hash: SHA-256(domainTag || 0x00 || JCS(payload)), lowercase hex. */
export function evaluationInputHash(input: EvaluationInputV1): string {
  const jcs = serializeEvaluationInput(input);
  const h = createHash("sha256");
  h.update(EVALUATION_INPUT_HASH_DOMAIN, "utf8");
  h.update(Buffer.from([0x00]));
  h.update(jcs, "utf8");
  return h.digest("hex");
}
