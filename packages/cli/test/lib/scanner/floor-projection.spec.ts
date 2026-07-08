// Phase 1 coverage-matrix tests for the PURE projection module (render + parse + hash +
// ownership). The IO writer is exercised separately in floor-projection-writer.spec.ts.
// Each test names the matrix-doc row it pins.
import {
  FLOOR_PROJECTION_RELPATH,
  declaredPayloadHash,
  isOwnedProjection,
  projectionBodyHash,
  renderFloorProjection,
  renderProjectionBody,
  splitProjection,
} from "../../../src/lib/scanner/floor-projection";
import { Directive } from "../../../src/lib/scanner/types";

// A backend-bundle human-attested MUST rule: the ONLY shape isFloorRule accepts.
const floor = (over: Partial<Directive> = {}): Directive => ({
  id: "abc",
  text: "Work directly on main.",
  source: "rule-bundle",
  kind: "RULE",
  strength: "MUST_FOLLOW",
  attestation: "human_attested",
  ...over,
});

describe("renderProjectionBody — floor-only body (matrix: content)", () => {
  it("row 'body → only global floor rules': keeps rule-bundle MUSTs (incl. 'When…' preambles), drops per-service + SHOULD", () => {
    const body = renderProjectionBody([
      floor({ text: "Notes vault is /Users/x/notes." }),
      // A global bundle MUST that opens with "When…" is a self-contained imperative. The old
      // CONDITIONAL_PREAMBLE prose gate is RETIRED (targeted-rule-injection §4.2 / isFloorRule):
      // classification never parses prose, so this STAYS on the floor. This row guards that.
      floor({ text: "When authoring a doc, use mermaid." }),
      // per-subsystem CLAUDE.md MUST -> source token is not `rule-bundle` -> never projected
      floor({ text: "Per-service rule.", source: "apps/control/CLAUDE.md" }),
      // SHOULD, not MUST -> not floor
      floor({ text: "Prefer small PRs.", strength: "SHOULD_FOLLOW" }),
    ]);
    expect(body).toContain("- Notes vault is /Users/x/notes.");
    expect(body).toContain("- When authoring a doc, use mermaid.");
    expect(body).not.toContain("Per-service rule.");
    expect(body).not.toContain("Prefer small PRs.");
    // Exactly the two global bundle MUSTs survived; per-service + SHOULD were dropped.
    expect((body.match(/^- /gm) || []).length).toBe(2);
  });

  it("row 'hook vs projection precedence': body self-identifies as the SUPERSEDED fallback", () => {
    const body = renderProjectionBody([floor()]);
    expect(body).toContain("# MLA Governing Floor");
    expect(body).toContain("fallback floor snapshot for subagents");
    expect(body).toContain("supersedes this snapshot");
  });

  it("collapses a stray newline in a rule so it stays a single bullet", () => {
    const body = renderProjectionBody([floor({ text: "Line one\n  and continuation." })]);
    expect(body).toContain("- Line one and continuation.");
    expect((body.match(/^- /gm) || []).length).toBe(1);
  });

  it("returns '' when nothing qualifies for the floor (no projection to write)", () => {
    expect(renderProjectionBody([])).toBe("");
    expect(renderProjectionBody([floor({ source: "apps/worker/CLAUDE.md" })])).toBe("");
    expect(renderFloorProjection([], "rev-1")).toBe("");
  });
});

describe("renderFloorProjection — ownership header (matrix: ownership + subagent path)", () => {
  it("row 'subagent receives projection': lands as a .claude/rules markdown file the agent can read", () => {
    // The mechanical proxy for 'a write-capable subagent inherits the floor': the file is
    // at the conventional path Claude Code loads instruction files from, its BODY is
    // model-facing markdown, and the ownership header is an HTML comment (stripped at load).
    expect(FLOOR_PROJECTION_RELPATH).toBe(".claude/rules/meetless-mla-floor.generated.md");
    const content = renderFloorProjection([floor({ text: "Notes vault is /notes." })], "rev-7");
    expect(content.startsWith("<!-- meetless-mla-floor-projection")).toBe(true);
    expect(content).toContain("bundleId: rev-7");
    expect(content).toContain("-->\n# MLA Governing Floor");
    expect(content).toContain("- Notes vault is /notes.");
  });

  it("declares a payloadHash that is sha256 over the BODY only, and round-trips via split", () => {
    const content = renderFloorProjection([floor()], "rev-1");
    const parts = splitProjection(content)!;
    expect(parts).not.toBeNull();
    expect(declaredPayloadHash(parts.header)).toBe(projectionBodyHash(parts.body));
  });

  it("bundleId is provenance only: a different bundleId does NOT change the payloadHash", () => {
    const a = renderFloorProjection([floor()], "rev-1");
    const b = renderFloorProjection([floor()], "rev-999");
    expect(declaredPayloadHash(splitProjection(a)!.header)).toBe(
      declaredPayloadHash(splitProjection(b)!.header),
    );
  });

  it("the payloadHash DOES change when the floor rule set changes (new version)", () => {
    const a = renderFloorProjection([floor({ text: "Rule A." })], "rev-1");
    const b = renderFloorProjection([floor({ text: "Rule B." })], "rev-1");
    expect(declaredPayloadHash(splitProjection(a)!.header)).not.toBe(
      declaredPayloadHash(splitProjection(b)!.header),
    );
  });
});

describe("isOwnedProjection — ownership by body hash (matrix: ownership gates)", () => {
  it("accepts a freshly rendered projection", () => {
    expect(isOwnedProjection(renderFloorProjection([floor()], "rev-1"))).toBe(true);
  });

  it("row 'edited body → not owned': any body edit breaks the hash equality", () => {
    const content = renderFloorProjection([floor()], "rev-1");
    const tampered = content.replace("Work directly on main.", "Work on any branch you like.");
    expect(tampered).not.toBe(content);
    expect(isOwnedProjection(tampered)).toBe(false);
  });

  it("row 'foreign file → not owned': a file without the sentinel is never owned", () => {
    expect(isOwnedProjection("# Just some user notes\n\n- do a thing\n")).toBe(false);
    expect(splitProjection("# Just some user notes\n")).toBeNull();
  });

  it("a sentinel file whose declared hash was hand-edited is not owned", () => {
    const content = renderFloorProjection([floor()], "rev-1");
    // Flip one hex digit of the declared payloadHash so it no longer matches the body.
    const tampered = content.replace(/payloadHash:\s*sha256:./, (m) =>
      m.endsWith("a") ? m.slice(0, -1) + "b" : m.slice(0, -1) + "a",
    );
    expect(tampered).not.toBe(content);
    expect(isOwnedProjection(tampered)).toBe(false);
  });

  it("declaredPayloadHash returns null when the header carries no valid hash", () => {
    expect(declaredPayloadHash("<!-- meetless-mla-floor-projection\nno hash here\n-->")).toBeNull();
  });
});
