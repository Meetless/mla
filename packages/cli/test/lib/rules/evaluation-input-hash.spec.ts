import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { canonicalize, sha256Hex } from "../../../src/lib/rules/canonical-json";
import {
  EVALUATION_INPUT_HASH_DOMAIN,
  EvaluationInputV1,
  EvaluationInputHashError,
  buildEvaluationInputPayload,
  serializeEvaluationInput,
  evaluationInputHash,
} from "../../../src/lib/rules/evaluation-input-hash";

// Persistence slice 2: the `evaluation-input-v1` canonical hash domain (proposal §10.1
// step 2, decision 4). The digest is SHA-256(domainTag || 0x00 || JCS(payload)), lowercase
// hex, where JCS is the repo's existing RFC 8785 canonicalizer (canonical-json.ts) and the
// payload is the action-side replay basis persisted as tool_attempt.evaluation_input_snapshot:
// the post-canonicalization compliance-replay input, NOT a rule hash. The domain tag prefix +
// 0x00 separator make this digest non-collidable with observed-rule-v1, rule-version-v1, or
// any other hashed artifact even when the normalized bodies are byte-identical.
//
// These tests are an INDEPENDENT oracle: the per-vector golden corpus was derived by hashing
// hand-written RFC 8785 strings with raw `crypto` (never this module), and the property tests
// reconstruct the domain-separated digest with raw `crypto` too. A one-byte drift in the
// payload schema, the target-union arms, the closed key sets, or the domain separation rotates
// a hash and fails this suite.

const FIXTURES = path.join(__dirname, "fixtures");
const CORPUS_PATH = path.join(FIXTURES, "evaluation-input-v1-corpus.json");
const SIDECAR_PATH = path.join(FIXTURES, "evaluation-input-v1-corpus.sha256");

interface Vector {
  label: string;
  input: EvaluationInputV1;
  jcs: string;
  hash: string;
}

const corpusRaw = fs.readFileSync(CORPUS_PATH, "utf8");
const corpus = JSON.parse(corpusRaw) as { domain: string; note: string; vectors: Vector[] };

// The notes-location pilot input: a Write to a runtime-root-relative path.
function pilotInput(): EvaluationInputV1 {
  return {
    toolName: "Write",
    target: { kind: "RUNTIME_RELATIVE", path: "src/app/main.ts" },
    forbiddenRootRelativePath: "notes",
    evaluatorContractVersion: "four-state-evaluator-v1",
    matcherSchemaVersion: "action-applicability-v1",
    pathCanonicalizerVersion: "notes-path-v1",
  };
}

// An independent (non-module) recomputation of the domain-separated digest from a known
// canonical JCS string, exactly as the corpus generator did.
function rawDomainDigest(jcs: string): string {
  const h = crypto.createHash("sha256");
  h.update(EVALUATION_INPUT_HASH_DOMAIN, "utf8");
  h.update(Buffer.from([0x00]));
  h.update(jcs, "utf8");
  return h.digest("hex");
}

describe("the evaluation-input-v1 golden corpus is byte-pinned by its sidecar", () => {
  it("matches the sha256 sidecar (the cross-language byte anchor)", () => {
    const expected = fs.readFileSync(SIDECAR_PATH, "utf8").trim();
    const actual = crypto.createHash("sha256").update(corpusRaw, "utf8").digest("hex");
    expect(actual).toBe(expected);
  });

  it("declares the evaluation-input-v1 domain", () => {
    expect(corpus.domain).toBe("evaluation-input-v1");
    expect(EVALUATION_INPUT_HASH_DOMAIN).toBe("evaluation-input-v1");
  });
});

describe("evaluationInputHash reproduces every golden vector byte-for-byte", () => {
  for (const v of corpus.vectors) {
    it(`reproduces the '${v.label}' canonical string and digest`, () => {
      expect(serializeEvaluationInput(v.input)).toBe(v.jcs);
      expect(evaluationInputHash(v.input)).toBe(v.hash);
      // The golden hash is itself the raw domain-separated digest of the golden JCS.
      expect(rawDomainDigest(v.jcs)).toBe(v.hash);
    });
  }

  it("covers all three target-union arms", () => {
    const kinds = corpus.vectors.map((v) => v.input.target.kind).sort();
    expect(kinds).toEqual(["OUTSIDE_RUNTIME_SCOPE", "RUNTIME_RELATIVE", "UNKNOWN"]);
  });
});

describe("domain separation (decision 6)", () => {
  it("mixes the domain tag + 0x00 into the digest (not a bare JCS hash)", () => {
    const input = pilotInput();
    const bare = sha256Hex(canonicalize(buildEvaluationInputPayload(input)));
    expect(evaluationInputHash(input)).not.toBe(bare);
    expect(evaluationInputHash(input)).toBe(rawDomainDigest(serializeEvaluationInput(input)));
  });

  it("never collides with the observed-rule-v1 domain for the same JCS bytes", () => {
    const input = pilotInput();
    const jcs = serializeEvaluationInput(input);
    const h = crypto.createHash("sha256");
    h.update("observed-rule-v1", "utf8");
    h.update(Buffer.from([0x00]));
    h.update(jcs, "utf8");
    expect(evaluationInputHash(input)).not.toBe(h.digest("hex"));
  });

  it("emits a lowercase 64-char hex digest", () => {
    expect(evaluationInputHash(pilotInput())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: the same input hashes identically every time", () => {
    expect(evaluationInputHash(pilotInput())).toBe(evaluationInputHash(pilotInput()));
  });
});

describe("the discriminated target union (proposal §10.1 step 2 lock)", () => {
  it("hashes the three arms to three distinct digests", () => {
    const base = pilotInput();
    const relative = evaluationInputHash(base);
    const outside = evaluationInputHash({ ...base, target: { kind: "OUTSIDE_RUNTIME_SCOPE" } });
    const unknown = evaluationInputHash({
      ...base,
      target: { kind: "UNKNOWN", reasonCode: "CANONICALIZATION_FAILED" },
    });
    expect(new Set([relative, outside, unknown]).size).toBe(3);
  });

  it("OUTSIDE_RUNTIME_SCOPE carries no path key", () => {
    const jcs = serializeEvaluationInput({ ...pilotInput(), target: { kind: "OUTSIDE_RUNTIME_SCOPE" } });
    expect(jcs).toContain('"target":{"kind":"OUTSIDE_RUNTIME_SCOPE"}');
    // no `path` key (the version/forbidden-root keys legitimately contain the substring "path").
    expect(jcs).not.toContain('"path":');
  });

  it("UNKNOWN carries exactly the locked CANONICALIZATION_FAILED reasonCode", () => {
    const jcs = serializeEvaluationInput({
      ...pilotInput(),
      target: { kind: "UNKNOWN", reasonCode: "CANONICALIZATION_FAILED" },
    });
    expect(jcs).toContain('"target":{"kind":"UNKNOWN","reasonCode":"CANONICALIZATION_FAILED"}');
  });

  it("rejects an unknown target kind (fail-closed)", () => {
    const bad = { ...pilotInput(), target: { kind: "ELSEWHERE" } } as unknown as EvaluationInputV1;
    expect(() => evaluationInputHash(bad)).toThrow(EvaluationInputHashError);
  });

  it("rejects an UNKNOWN target whose reasonCode is not the locked literal", () => {
    const bad = {
      ...pilotInput(),
      target: { kind: "UNKNOWN", reasonCode: "SOMETHING_ELSE" },
    } as unknown as EvaluationInputV1;
    expect(() => evaluationInputHash(bad)).toThrow(EvaluationInputHashError);
  });

  it("rejects an unknown field inside a target arm", () => {
    const bad = {
      ...pilotInput(),
      target: { kind: "RUNTIME_RELATIVE", path: "src/x.ts", extra: 1 },
    } as unknown as EvaluationInputV1;
    expect(() => evaluationInputHash(bad)).toThrow(EvaluationInputHashError);
  });
});

describe("unknown top-level fields are REJECTED, not ignored (decision 6 fail-closed)", () => {
  it("throws on an unknown top-level field", () => {
    const bad = { ...pilotInput(), surprise: 1 } as unknown as EvaluationInputV1;
    expect(() => evaluationInputHash(bad)).toThrow(EvaluationInputHashError);
  });

  it("the payload carries exactly the six locked top-level names", () => {
    const payload = buildEvaluationInputPayload(pilotInput());
    expect(Object.keys(payload).sort()).toEqual(
      [
        "evaluatorContractVersion",
        "forbiddenRootRelativePath",
        "matcherSchemaVersion",
        "pathCanonicalizerVersion",
        "target",
        "toolName",
      ].sort(),
    );
  });
});

describe("the payload is float-free by construction (decision 6: floats BANNED)", () => {
  it("contains no number-typed value anywhere in the canonical payload", () => {
    const hasNumber = (v: unknown): boolean => {
      if (typeof v === "number") return true;
      if (Array.isArray(v)) return v.some(hasNumber);
      if (v && typeof v === "object") return Object.values(v).some(hasNumber);
      return false;
    };
    expect(hasNumber(buildEvaluationInputPayload(pilotInput()))).toBe(false);
  });
});

describe("every field is part of identity", () => {
  it("rotates the digest when any single field changes", () => {
    const base = pilotInput();
    const baseHash = evaluationInputHash(base);
    const mutations: EvaluationInputV1[] = [
      { ...base, toolName: "Edit" },
      { ...base, target: { kind: "RUNTIME_RELATIVE", path: "src/app/other.ts" } },
      { ...base, forbiddenRootRelativePath: "secrets" },
      { ...base, evaluatorContractVersion: "four-state-evaluator-v2" },
      { ...base, matcherSchemaVersion: "action-applicability-v2" },
      { ...base, pathCanonicalizerVersion: "notes-path-v2" },
    ];
    for (const m of mutations) {
      expect(evaluationInputHash(m)).not.toBe(baseHash);
    }
  });
});
