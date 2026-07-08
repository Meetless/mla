import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { canonicalize, sha256Hex } from "../../../src/lib/rules/canonical-json";
import {
  RULE_VERSION_HASH_DOMAIN,
  buildRuleVersionPayload,
  serializeRuleVersion,
  ruleVersionHash,
  RuleVersionHashError,
} from "../../../src/lib/rules/rule-version-hash";
import { RulePayloadV1 } from "../../../src/lib/rules/types";

// Slice 6: the `rule-version-v1` canonical hash domain (proposal P0.36 / P0.53, RulePayloadV1 at §3.6).
//
// The digest is SHA-256(domainTag || 0x00 || JCS(payload)), lowercase hex, where JCS is the repo's
// RFC 8785 canonicalizer (canonical-json.ts) and the payload is the IMMUTABLE RulePayloadV1 ONLY (the
// version envelope: ruleId, versionId, lifecycle, lineage, attestation stamps, is deliberately OUTSIDE
// the hash, since a hash cannot include itself and issuance metadata is not enforcement-relevant). The
// domain tag prefix + 0x00 separator make this digest non-collidable with observed-rule-v1,
// evaluation-input-v1, or any other hashed artifact even when the bodies are byte-identical.
//
// These tests are an INDEPENDENT oracle: the per-vector golden corpus was derived by an independent
// canonicalizer (JSON.stringify over a recursively key-sorted object) and raw `crypto`, never this
// module. A one-byte drift in the payload schema, the set discipline, the omit-absent rule, or the
// domain separation rotates a hash and fails this suite.

const FIXTURES = path.join(__dirname, "fixtures");
const CORPUS_PATH = path.join(FIXTURES, "rule-version-v1-corpus.json");
const SIDECAR_PATH = path.join(FIXTURES, "rule-version-v1-corpus.sha256");

interface Vector {
  label: string;
  payload: RulePayloadV1;
  jcs: string;
  hash: string;
}

const corpusRaw = fs.readFileSync(CORPUS_PATH, "utf8");
const corpus = JSON.parse(corpusRaw) as { domain: string; note: string; vectors: Vector[] };

// The notes-location pilot payload: the exact RulePayloadV1 the R1 attest slice mints (rationale
// omitted; every field except text/applicability/forbiddenRootRelativePath fixed by the pilot
// contract, proposal §2.4 conversion table).
function pilotPayload(): RulePayloadV1 {
  return {
    text: "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
    applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } },
    compliance: {
      evaluatorContractVersion: "four-state-evaluator-v1",
      matcherSchemaVersion: "action-applicability-v1",
      pathCanonicalizerVersion: "notes-path-v1",
      config: { forbiddenRootRelativePath: "notes" },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: "DENY",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: "/work/meetless",
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
  };
}

// An independent (non-module) recomputation of the domain-separated digest from a known JCS string.
function rawDomainDigest(jcs: string): string {
  const h = crypto.createHash("sha256");
  h.update(RULE_VERSION_HASH_DOMAIN, "utf8");
  h.update(Buffer.from([0x00]));
  h.update(jcs, "utf8");
  return h.digest("hex");
}

describe("the rule-version-v1 golden corpus is byte-pinned by its sidecar", () => {
  it("matches the sha256 sidecar (the cross-language byte anchor)", () => {
    const expected = fs.readFileSync(SIDECAR_PATH, "utf8").trim();
    const actual = crypto.createHash("sha256").update(corpusRaw, "utf8").digest("hex");
    expect(actual).toBe(expected);
  });

  it("declares the rule-version-v1 domain", () => {
    expect(corpus.domain).toBe("rule-version-v1");
    expect(RULE_VERSION_HASH_DOMAIN).toBe("rule-version-v1");
  });
});

describe("ruleVersionHash reproduces every golden vector byte-for-byte", () => {
  for (const v of corpus.vectors) {
    it(`reproduces the '${v.label}' canonical string and digest`, () => {
      expect(serializeRuleVersion(v.payload)).toBe(v.jcs);
      expect(ruleVersionHash(v.payload)).toBe(v.hash);
      // The golden hash is itself the raw domain-separated digest of the golden JCS.
      expect(rawDomainDigest(v.jcs)).toBe(v.hash);
    });
  }
});

describe("domain separation (P0.53)", () => {
  it("mixes the domain tag + 0x00 into the digest (not a bare JCS hash)", () => {
    const payload = pilotPayload();
    const bare = sha256Hex(canonicalize(buildRuleVersionPayload(payload)));
    expect(ruleVersionHash(payload)).not.toBe(bare);
    expect(ruleVersionHash(payload)).toBe(rawDomainDigest(serializeRuleVersion(payload)));
  });

  it("does NOT collide with the observed-rule-v1 digest of the same logical content", () => {
    // observed-rule-v1 hashes a different (smaller) payload under a different domain tag, so even a
    // shared notes-location rule never produces the same digest in both domains.
    const payload = pilotPayload();
    expect(ruleVersionHash(payload)).not.toBe(
      crypto
        .createHash("sha256")
        .update("observed-rule-v1", "utf8")
        .update(Buffer.from([0x00]))
        .update(serializeRuleVersion(payload), "utf8")
        .digest("hex"),
    );
  });

  it("emits a lowercase 64-char hex digest", () => {
    expect(ruleVersionHash(pilotPayload())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: the same payload hashes identically every time", () => {
    expect(ruleVersionHash(pilotPayload())).toBe(ruleVersionHash(pilotPayload()));
  });
});

describe("set vs list discipline (P0.53)", () => {
  it("treats deliveryChannels as a SET: order and duplicates do not change the hash", () => {
    const base = pilotPayload();
    const scrambled: RulePayloadV1 = {
      ...base,
      deliveryChannels: ["runtimeInject", "preToolUse", "nativeRule"],
    };
    const duped: RulePayloadV1 = {
      ...base,
      deliveryChannels: ["nativeRule", "runtimeInject", "preToolUse", "nativeRule", "preToolUse"],
    };
    expect(ruleVersionHash(scrambled)).toBe(ruleVersionHash(duped));
    // The canonical deliveryChannels array is the sorted, deduped form.
    expect(serializeRuleVersion(duped)).toContain('"deliveryChannels":["nativeRule","preToolUse","runtimeInject"]');
  });

  it("treats applicability.tools as a SET: order and duplicates do not change the hash", () => {
    const base = pilotPayload();
    const reordered: RulePayloadV1 = {
      ...base,
      applicability: { mode: "action", tools: ["Edit", "Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } },
    };
    expect(ruleVersionHash(reordered)).toBe(ruleVersionHash(base));
    expect(serializeRuleVersion(reordered)).toContain('"tools":["Edit","Write"]');
  });
});

describe("turn-mode applicability serialization (Layer B)", () => {
  // A turn payload the P1 `mla rules add --turn-when-*` path mints. Every field except applicability
  // is a plausible injection-rule fixture: OBSERVE ceiling, runtimeInject channel, SHOULD strength.
  function turnPayload(): RulePayloadV1 {
    return {
      ...pilotPayload(),
      applicability: {
        mode: "turn",
        trigger: { promptAny: ["design doc", "architecture"], explicitPathAny: ["**/*.md"] },
      },
      deliveryChannels: ["runtimeInject"],
      enforcementCeiling: "OBSERVE",
      strength: "SHOULD_FOLLOW",
    };
  }

  it("serializes the trigger and hashes to a lowercase 64-char hex digest", () => {
    const jcs = serializeRuleVersion(turnPayload());
    expect(jcs).toContain('"mode":"turn"');
    expect(jcs).toContain('"promptAny":["architecture","design doc"]');
    expect(jcs).toContain('"explicitPathAny":["**/*.md"]');
    expect(ruleVersionHash(turnPayload())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats both trigger lists as SETS: order and duplicates do not change the hash", () => {
    const base = turnPayload();
    const scrambled: RulePayloadV1 = {
      ...base,
      applicability: {
        mode: "turn",
        trigger: {
          promptAny: ["architecture", "design doc", "design doc"],
          explicitPathAny: ["**/*.md", "**/*.md"],
        },
      },
    };
    expect(ruleVersionHash(scrambled)).toBe(ruleVersionHash(base));
  });

  it("omits an absent trigger list entirely (never null)", () => {
    const promptOnly: RulePayloadV1 = {
      ...turnPayload(),
      applicability: { mode: "turn", trigger: { promptAny: ["design doc"] } },
    };
    const jcs = serializeRuleVersion(promptOnly);
    expect(jcs).not.toContain("explicitPathAny");
    expect(jcs).not.toContain("null");
  });

  it("hashes a different trigger to a different identity", () => {
    const a = turnPayload();
    const b: RulePayloadV1 = {
      ...a,
      applicability: { mode: "turn", trigger: { promptAny: ["something else"] } },
    };
    expect(ruleVersionHash(b)).not.toBe(ruleVersionHash(a));
  });

  it("throws on an unknown field inside the trigger (closed struct, fail closed)", () => {
    const bad = {
      ...turnPayload(),
      applicability: { mode: "turn", trigger: { promptAny: ["x"], triggerEvaluator: "llm" } },
    } as unknown as RulePayloadV1;
    expect(() => ruleVersionHash(bad)).toThrow(RuleVersionHashError);
  });

  it("throws on an unknown field on a turn applicability", () => {
    const bad = {
      ...turnPayload(),
      applicability: { mode: "turn", trigger: { promptAny: ["x"] }, extra: true },
    } as unknown as RulePayloadV1;
    expect(() => ruleVersionHash(bad)).toThrow(RuleVersionHashError);
  });
});

describe("absent optionals are omitted, never null (P0.53)", () => {
  it("omits the rationale key entirely when rationale is absent", () => {
    const jcs = serializeRuleVersion(pilotPayload());
    expect(jcs).not.toContain("rationale");
    expect(jcs).not.toContain("null");
  });

  it("hashes differently with vs without a rationale (rationale is part of identity)", () => {
    const without = pilotPayload();
    const withRationale: RulePayloadV1 = { ...without, rationale: "Keeps the monorepo notes directory free of design docs." };
    expect(ruleVersionHash(withRationale)).not.toBe(ruleVersionHash(without));
  });
});

describe("the payload scope is INSIDE the hash (payload-scope == envelope-scope, §3.6)", () => {
  it("rehashes when runtimeScopeId changes (the same rule in another scope is a different payload)", () => {
    const a = pilotPayload();
    const b: RulePayloadV1 = { ...a, runtimeScopeId: "/work/other-checkout" };
    expect(ruleVersionHash(b)).not.toBe(ruleVersionHash(a));
  });

  it("rehashes when the immutable forbidden-root content changes (P0.63: config carries content, not an id)", () => {
    const a = pilotPayload();
    const b: RulePayloadV1 = {
      ...a,
      compliance: { ...a.compliance, config: { forbiddenRootRelativePath: "secrets" } },
    };
    expect(ruleVersionHash(b)).not.toBe(ruleVersionHash(a));
  });
});

describe("unknown fields are REJECTED, not ignored (P0.53, fail closed)", () => {
  it("throws on an unknown top-level field", () => {
    const bad = { ...pilotPayload(), surprise: 1 } as unknown as RulePayloadV1;
    expect(() => ruleVersionHash(bad)).toThrow(RuleVersionHashError);
  });

  it("throws on an unknown compliance field", () => {
    const bad = {
      ...pilotPayload(),
      compliance: { ...pilotPayload().compliance, extra: true },
    } as unknown as RulePayloadV1;
    expect(() => ruleVersionHash(bad)).toThrow(RuleVersionHashError);
  });

  it("throws on an unknown compliance.config field", () => {
    const bad = {
      ...pilotPayload(),
      compliance: { ...pilotPayload().compliance, config: { forbiddenRootRelativePath: "notes", mutableId: "x" } },
    } as unknown as RulePayloadV1;
    expect(() => ruleVersionHash(bad)).toThrow(RuleVersionHashError);
  });

  it("throws on an unknown applicability field", () => {
    const bad = {
      ...pilotPayload(),
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path" }, extra: true },
    } as unknown as RulePayloadV1;
    expect(() => ruleVersionHash(bad)).toThrow(RuleVersionHashError);
  });

  it("throws on an unknown matcher field", () => {
    const bad = {
      ...pilotPayload(),
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path", regex: "x" } },
    } as unknown as RulePayloadV1;
    expect(() => ruleVersionHash(bad)).toThrow(RuleVersionHashError);
  });
});

describe("the payload is float-free by construction (P0.53 floats BANNED)", () => {
  it("contains no number-typed value anywhere in the canonical payload", () => {
    const hasNumber = (v: unknown): boolean => {
      if (typeof v === "number") return true;
      if (Array.isArray(v)) return v.some(hasNumber);
      if (v && typeof v === "object") return Object.values(v).some(hasNumber);
      return false;
    };
    expect(hasNumber(buildRuleVersionPayload(pilotPayload()))).toBe(false);
  });
});
