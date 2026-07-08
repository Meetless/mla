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
