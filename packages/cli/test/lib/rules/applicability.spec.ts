import { parseApplicability } from "../../../src/lib/rules/applicability";

// R0 applicability parser (notes/20260615-rules-as-node-and-action-interception-
// consolidated-proposal.md, schema-independent core). The parser turns a raw,
// untrusted applicability descriptor into an explicit OK / DISABLED / INVALID
// result. It NEVER infers a mode from absence: a missing or malformed mode is a
// diagnostic, not a silent fall-through to "ambient".

describe("parseApplicability", () => {
  describe("ambient mode", () => {
    it("accepts an explicit ambient descriptor", () => {
      const result = parseApplicability({ mode: "ambient" });
      expect(result.status).toBe("OK");
      expect(result.applicability).toEqual({ mode: "ambient" });
      expect(result.diagnostic).toBeUndefined();
    });
  });

  describe("action mode", () => {
    it("accepts an action descriptor with tools and a path matcher", () => {
      const result = parseApplicability({
        mode: "action",
        tools: ["Write", "Edit"],
        matcher: { field: "file_path", glob: "*.md" },
      });
      expect(result.status).toBe("OK");
      expect(result.applicability).toEqual({
        mode: "action",
        tools: ["Write", "Edit"],
        matcher: { field: "file_path", glob: "*.md" },
      });
    });

    it("accepts an action descriptor whose matcher has no glob", () => {
      const result = parseApplicability({
        mode: "action",
        tools: ["Write"],
        matcher: { field: "file_path" },
      });
      expect(result.status).toBe("OK");
      expect(result.applicability).toEqual({
        mode: "action",
        tools: ["Write"],
        matcher: { field: "file_path" },
      });
    });

    it("rejects an action descriptor with a missing tools list", () => {
      const result = parseApplicability({ mode: "action", matcher: { field: "file_path" } });
      expect(result.status).toBe("INVALID");
      expect(result.applicability).toBeUndefined();
      expect(result.diagnostic).toMatch(/tools/i);
    });

    it("rejects an action descriptor with an empty tools list", () => {
      const result = parseApplicability({
        mode: "action",
        tools: [],
        matcher: { field: "file_path" },
      });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/tools/i);
    });

    it("rejects an action descriptor whose tools are not all strings", () => {
      const result = parseApplicability({
        mode: "action",
        tools: ["Write", 7],
        matcher: { field: "file_path" },
      });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/tools/i);
    });

    it("rejects an action descriptor with a missing matcher", () => {
      const result = parseApplicability({ mode: "action", tools: ["Write"] });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/matcher/i);
    });

    it("rejects an action descriptor whose matcher has no field", () => {
      const result = parseApplicability({ mode: "action", tools: ["Write"], matcher: {} });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/field/i);
    });
  });

  describe("turn mode (Layer B injection trigger)", () => {
    it("accepts a trigger with only promptAny", () => {
      const result = parseApplicability({
        mode: "turn",
        trigger: { promptAny: ["design doc", "architecture"] },
      });
      expect(result.status).toBe("OK");
      expect(result.applicability).toEqual({
        mode: "turn",
        trigger: { promptAny: ["design doc", "architecture"] },
      });
      expect(result.diagnostic).toBeUndefined();
    });

    it("accepts a trigger with only explicitPathAny", () => {
      const result = parseApplicability({
        mode: "turn",
        trigger: { explicitPathAny: ["**/*.md", "notes/**"] },
      });
      expect(result.status).toBe("OK");
      expect(result.applicability).toEqual({
        mode: "turn",
        trigger: { explicitPathAny: ["**/*.md", "notes/**"] },
      });
    });

    it("accepts a trigger carrying both lists", () => {
      const result = parseApplicability({
        mode: "turn",
        trigger: { promptAny: ["design doc"], explicitPathAny: ["**/*.md"] },
      });
      expect(result.status).toBe("OK");
      expect(result.applicability).toEqual({
        mode: "turn",
        trigger: { promptAny: ["design doc"], explicitPathAny: ["**/*.md"] },
      });
    });

    it("rejects a turn descriptor with no trigger object", () => {
      const result = parseApplicability({ mode: "turn" });
      expect(result.status).toBe("INVALID");
      expect(result.applicability).toBeUndefined();
      expect(result.diagnostic).toMatch(/trigger/i);
    });

    it("rejects a turn descriptor whose trigger is not an object", () => {
      const result = parseApplicability({ mode: "turn", trigger: "design doc" });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/trigger/i);
    });

    it("rejects a trigger with neither list present (never infers a match-all)", () => {
      const result = parseApplicability({ mode: "turn", trigger: {} });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/at least one/i);
    });

    it("rejects a trigger with an empty promptAny list", () => {
      const result = parseApplicability({ mode: "turn", trigger: { promptAny: [] } });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/promptAny/);
    });

    it("rejects a trigger whose promptAny entries are not all non-empty strings", () => {
      const result = parseApplicability({ mode: "turn", trigger: { promptAny: ["ok", ""] } });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/promptAny/);
    });

    it("rejects a whitespace-only promptAny needle (would normalize to '' and match every turn)", () => {
      // "   " is non-empty (length 3) but blank after trim; if it survived parsing it would
      // normalize to "" at match time and `norm.includes("")` fires on EVERY prompt, reinstating
      // the every-turn floor tax the turn variant removes. The grammar owner must reject it.
      const result = parseApplicability({ mode: "turn", trigger: { promptAny: ["design doc", "   "] } });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/promptAny/);
    });

    it("rejects a whitespace-only explicitPathAny needle (blank glob carries no signal)", () => {
      const result = parseApplicability({ mode: "turn", trigger: { explicitPathAny: ["\t\n"] } });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/explicitPathAny/);
    });

    it("rejects a trigger whose promptAny holds a non-string", () => {
      const result = parseApplicability({ mode: "turn", trigger: { promptAny: ["ok", 7] } });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/promptAny/);
    });

    it("rejects a trigger with an empty explicitPathAny list", () => {
      const result = parseApplicability({ mode: "turn", trigger: { explicitPathAny: [] } });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/explicitPathAny/);
    });

    it("rejects a trigger carrying an unknown field (closed struct, not a DSL)", () => {
      const result = parseApplicability({
        mode: "turn",
        trigger: { promptAny: ["x"], triggerEvaluator: "llm" },
      });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/triggerEvaluator/);
    });
  });

  describe("missing / malformed / unknown modes", () => {
    it("never infers ambient from an absent mode", () => {
      const result = parseApplicability({});
      expect(result.status).toBe("INVALID");
      expect(result.applicability).toBeUndefined();
      expect(result.diagnostic).toMatch(/mode/i);
    });

    it("rejects a null descriptor", () => {
      const result = parseApplicability(null);
      expect(result.status).toBe("INVALID");
      expect(result.applicability).toBeUndefined();
    });

    it("rejects a non-object descriptor", () => {
      const result = parseApplicability("ambient");
      expect(result.status).toBe("INVALID");
      expect(result.applicability).toBeUndefined();
    });

    it("rejects an unknown mode and names it in the diagnostic", () => {
      const result = parseApplicability({ mode: "whenever" });
      expect(result.status).toBe("INVALID");
      expect(result.diagnostic).toMatch(/whenever/);
    });

    it("rejects a non-string mode", () => {
      const result = parseApplicability({ mode: 42 });
      expect(result.status).toBe("INVALID");
      expect(result.applicability).toBeUndefined();
    });
  });
});
