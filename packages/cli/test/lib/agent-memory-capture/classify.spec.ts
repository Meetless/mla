import { classifyMemory, isCapturable } from "../../../src/lib/agent-memory-capture/classify";

const PROJECT = `---
name: project_x
description: "a thing"
metadata:
  node_type: memory
  type: project
  originSessionId: abc
---

body here
`;

const USER = `---
name: who
metadata:
  type: user
---
body
`;

describe("classifyMemory", () => {
  it("extracts nested metadata.type = project", () => {
    const c = classifyMemory(PROJECT);
    expect(c.type).toBe("project");
    expect(c.hasFrontmatter).toBe(true);
    expect(c.malformed).toBe(false);
    expect(isCapturable(c)).toBe(true);
  });

  it("classifies a user memory and rejects capture", () => {
    const c = classifyMemory(USER);
    expect(c.type).toBe("user");
    expect(isCapturable(c)).toBe(false);
  });

  it("treats a plain markdown file (no fence) as no-type, not malformed", () => {
    const c = classifyMemory("# MEMORY index\n- a\n- b\n");
    expect(c.hasFrontmatter).toBe(false);
    expect(c.malformed).toBe(false);
    expect(c.type).toBeNull();
  });

  it("flags an opened-but-unclosed frontmatter fence as malformed", () => {
    const c = classifyMemory("---\nname: x\ntype: project\nno closing fence\n");
    expect(c.malformed).toBe(true);
    expect(c.type).toBeNull();
  });

  it("does not read type from a later top-level key after the metadata block", () => {
    // `type:` only counts under metadata: (or as a genuine top-level key); a key
    // named otherwise must not leak in.
    const c = classifyMemory(`---
metadata:
  node_type: memory
name: project_y
description: x
---
type: not-frontmatter
`);
    expect(c.type).toBeNull();
  });

  it("accepts a defensive top-level type: (flat frontmatter)", () => {
    const c = classifyMemory("---\ntype: project\nname: x\n---\nbody\n");
    expect(c.type).toBe("project");
  });

  it("lowercases and unquotes the type value", () => {
    const c = classifyMemory(`---
metadata:
  type: "Project"
---
b
`);
    expect(c.type).toBe("project");
  });
});

// --- Phase 2: widen capture beyond `project` ---------------------------------
// notes/20260805-did-mla-help-this-session-...md fix 1, unblocked by §12: a new
// claim serves provisionally on arrival, so widening intake does not deepen an
// inaccessible queue. 411 of 869 memory files were excluded, and they hold the
// single most reusable artifacts this agent produces (the traps index, the
// environment lessons, the working rules). `user` stays excluded: that exclusion
// is a privacy boundary, not an MVP scope decision.
const FEEDBACK = `---
name: feedback_x
description: "a working rule"
metadata:
  type: feedback
---
body
`;

const REFERENCE = `---
name: reference_x
description: "a trap"
metadata:
  type: reference
---
body
`;

describe("capture eligibility by memory type", () => {
  it("captures feedback (Phase 2a)", () => {
    const c = classifyMemory(FEEDBACK);
    expect(c.type).toBe("feedback");
    expect(isCapturable(c)).toBe(true);
  });

  it("captures reference (Phase 2b)", () => {
    const c = classifyMemory(REFERENCE);
    expect(c.type).toBe("reference");
    expect(isCapturable(c)).toBe(true);
  });

  it("still captures project", () => {
    expect(isCapturable(classifyMemory(PROJECT))).toBe(true);
  });

  it("NEVER captures user, and that is a privacy boundary not a scope choice", () => {
    expect(isCapturable(classifyMemory(USER))).toBe(false);
  });

  it("does not capture an unknown or absent type", () => {
    expect(isCapturable({ type: null, hasFrontmatter: false, malformed: false })).toBe(false);
    expect(isCapturable({ type: "scratch", hasFrontmatter: true, malformed: false })).toBe(false);
  });
});
