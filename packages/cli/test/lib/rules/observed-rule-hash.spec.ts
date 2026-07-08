import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { canonicalize, sha256Hex } from "../../../src/lib/rules/canonical-json";
import {
  OBSERVED_RULE_HASH_DOMAIN,
  buildObservedRulePayload,
  serializeObservedRule,
  observedRuleHash,
  ObservedRuleHashError,
} from "../../../src/lib/rules/observed-rule-hash";
import { ObservedRuleSpec } from "../../../src/lib/rules/types";

// Slice 4: the `observed-rule-v1` canonical hash domain (proposal P0.36 / P0.53).
//
// The digest is SHA-256(domainTag || 0x00 || JCS(payload)), lowercase hex, where JCS
// is the repo's existing RFC 8785 canonicalizer (canonical-json.ts) and the payload is
// EXACTLY the R0 evaluator-consumed ObservedRuleSpec. The domain tag prefix + 0x00
// separator make this digest non-collidable with any other hashed artifact even when
// the normalized bodies are byte-identical.
//
// These tests are an INDEPENDENT oracle: the per-vector golden corpus was derived by
// hashing hand-written RFC 8785 strings with raw `crypto` (never this module), and the
// property tests below reconstruct the domain-separated digest with raw `crypto` too. A
// one-byte drift in the payload schema, the set discipline, the omit-absent rule, or the
// domain separation rotates a hash and fails this suite.

const FIXTURES = path.join(__dirname, "fixtures");
const CORPUS_PATH = path.join(FIXTURES, "observed-rule-v1-corpus.json");
const SIDECAR_PATH = path.join(FIXTURES, "observed-rule-v1-corpus.sha256");

interface Vector {
  label: string;
  spec: ObservedRuleSpec;
  jcs: string;
  hash: string;
}

const corpusRaw = fs.readFileSync(CORPUS_PATH, "utf8");
const corpus = JSON.parse(corpusRaw) as { domain: string; note: string; vectors: Vector[] };

// The notes-location pilot spec, the rule the R0 evaluator actually reads.
function pilotSpec(): ObservedRuleSpec {
  return {
    text: "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
    applicability: { mode: "action", tools: ["Write", "Edit"], matcher: { field: "file_path", glob: "*.md" } },
    effect: "PROHIBIT",
    forbiddenRootRelativePath: "notes",
  };
}

// An independent (non-module) recomputation of the domain-separated digest from a known
// canonical JCS string, exactly as the corpus generator did.
function rawDomainDigest(jcs: string): string {
  const h = crypto.createHash("sha256");
  h.update(OBSERVED_RULE_HASH_DOMAIN, "utf8");
  h.update(Buffer.from([0x00]));
  h.update(jcs, "utf8");
  return h.digest("hex");
}

describe("the observed-rule-v1 golden corpus is byte-pinned by its sidecar", () => {
  it("matches the sha256 sidecar (the cross-language byte anchor)", () => {
    const expected = fs.readFileSync(SIDECAR_PATH, "utf8").trim();
    const actual = crypto.createHash("sha256").update(corpusRaw, "utf8").digest("hex");
    expect(actual).toBe(expected);
  });

  it("declares the observed-rule-v1 domain", () => {
    expect(corpus.domain).toBe("observed-rule-v1");
    expect(OBSERVED_RULE_HASH_DOMAIN).toBe("observed-rule-v1");
  });
});

describe("observedRuleHash reproduces every golden vector byte-for-byte", () => {
  for (const v of corpus.vectors) {
    it(`reproduces the '${v.label}' canonical string and digest`, () => {
      expect(serializeObservedRule(v.spec)).toBe(v.jcs);
      expect(observedRuleHash(v.spec)).toBe(v.hash);
      // The golden hash is itself the raw domain-separated digest of the golden JCS.
      expect(rawDomainDigest(v.jcs)).toBe(v.hash);
    });
  }
});

describe("domain separation (P0.53)", () => {
  it("mixes the domain tag + 0x00 into the digest (not a bare JCS hash)", () => {
    const spec = pilotSpec();
    const bare = sha256Hex(canonicalize(buildObservedRulePayload(spec)));
    expect(observedRuleHash(spec)).not.toBe(bare);
    expect(observedRuleHash(spec)).toBe(rawDomainDigest(serializeObservedRule(spec)));
  });

  it("emits a lowercase 64-char hex digest", () => {
    expect(observedRuleHash(pilotSpec())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: the same spec hashes identically every time", () => {
    expect(observedRuleHash(pilotSpec())).toBe(observedRuleHash(pilotSpec()));
  });
});

describe("set vs list discipline (P0.53)", () => {
  it("treats tools as a SET: order and duplicates do not change the hash", () => {
    const base = pilotSpec();
    const reordered: ObservedRuleSpec = {
      ...base,
      applicability: { mode: "action", tools: ["Edit", "Write"], matcher: { field: "file_path", glob: "*.md" } },
    };
    const duped: ObservedRuleSpec = {
      ...base,
      applicability: {
        mode: "action",
        tools: ["Write", "Edit", "Write", "Edit"],
        matcher: { field: "file_path", glob: "*.md" },
      },
    };
    expect(observedRuleHash(reordered)).toBe(observedRuleHash(base));
    expect(observedRuleHash(duped)).toBe(observedRuleHash(base));
    // The canonical tools array is the sorted, deduped form.
    expect(serializeObservedRule(duped)).toContain('"tools":["Edit","Write"]');
  });
});

describe("absent optionals are omitted, never null (P0.53)", () => {
  it("omits the matcher glob key entirely when the glob is absent", () => {
    const noGlob: ObservedRuleSpec = {
      text: "Some prose rule.",
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path" } },
      effect: "PROHIBIT",
      forbiddenRootRelativePath: "secrets",
    };
    const jcs = serializeObservedRule(noGlob);
    expect(jcs).not.toContain("glob");
    expect(jcs).not.toContain("null");
  });

  it("hashes differently with vs without a glob (the glob is part of identity)", () => {
    const withGlob: ObservedRuleSpec = {
      text: "Some prose rule.",
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path", glob: "*.md" } },
      effect: "PROHIBIT",
      forbiddenRootRelativePath: "secrets",
    };
    const withoutGlob: ObservedRuleSpec = {
      ...withGlob,
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path" } },
    };
    expect(observedRuleHash(withGlob)).not.toBe(observedRuleHash(withoutGlob));
  });
});

describe("per-field NFC: prose is normalized (P0.53)", () => {
  it("folds an NFD text to the same digest as its NFC form", () => {
    const nfc = "Notes go in café vault."; // é = U+00E9
    const nfd = "Notes go in café vault."; // e + U+0301 combining acute
    expect(nfd).not.toBe(nfc);
    const base: Omit<ObservedRuleSpec, "text"> = {
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path", glob: "*.md" } },
      effect: "PROHIBIT",
      forbiddenRootRelativePath: "notes",
    };
    expect(observedRuleHash({ ...base, text: nfd })).toBe(observedRuleHash({ ...base, text: nfc }));
    // and it equals the committed golden vector for this prose
    const golden = corpus.vectors.find((v) => v.label === "prose-nfc-folding");
    expect(observedRuleHash({ ...base, text: nfd })).toBe(golden?.hash);
  });
});

describe("unknown fields are REJECTED, not ignored (P0.53)", () => {
  it("throws on an unknown top-level field", () => {
    const bad = { ...pilotSpec(), surprise: 1 } as unknown as ObservedRuleSpec;
    expect(() => observedRuleHash(bad)).toThrow(ObservedRuleHashError);
  });

  it("throws on an unknown applicability field", () => {
    const bad = {
      ...pilotSpec(),
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path" }, extra: true },
    } as unknown as ObservedRuleSpec;
    expect(() => observedRuleHash(bad)).toThrow(ObservedRuleHashError);
  });

  it("throws on an unknown matcher field", () => {
    const bad = {
      ...pilotSpec(),
      applicability: { mode: "action", tools: ["Write"], matcher: { field: "file_path", regex: "x" } },
    } as unknown as ObservedRuleSpec;
    expect(() => observedRuleHash(bad)).toThrow(ObservedRuleHashError);
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
    expect(hasNumber(buildObservedRulePayload(pilotSpec()))).toBe(false);
  });
});

describe("the ambient applicability branch is supported and deterministic", () => {
  it("builds {mode:'ambient'} and hashes stably", () => {
    const ambient: ObservedRuleSpec = {
      text: "An ambient rule.",
      applicability: { mode: "ambient" },
      effect: "REQUIRE",
      forbiddenRootRelativePath: "notes",
    };
    expect(serializeObservedRule(ambient)).toContain('"applicability":{"mode":"ambient"}');
    expect(observedRuleHash(ambient)).toMatch(/^[0-9a-f]{64}$/);
    expect(observedRuleHash(ambient)).toBe(observedRuleHash(ambient));
  });
});

describe("a turn applicability is OUTSIDE the observed-rule-v1 schema (fail closed)", () => {
  // A turn rule is prompt-time injection authored directly (targeted-rule-injection §5.1); the scanner
  // never observes one and --from-observed attestation rejects it upstream, so this hash domain must
  // never mint a digest for it. It fails closed at the boundary rather than silently define a shape it
  // does not own.
  it("throws rather than serialize a turn applicability", () => {
    const turn = {
      text: "A turn rule.",
      applicability: { mode: "turn", trigger: { promptAny: ["design doc"] } },
      effect: "REQUIRE",
      forbiddenRootRelativePath: "notes",
    } as unknown as ObservedRuleSpec;
    expect(() => observedRuleHash(turn)).toThrow(ObservedRuleHashError);
  });
});
