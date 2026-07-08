import { directiveId } from "../../../src/lib/scanner/types";

describe("directiveId", () => {
  it("is stable for the same source+text", () => {
    const a = directiveId("CLAUDE.md", "Use pnpm, not npm.");
    const b = directiveId("CLAUDE.md", "Use pnpm, not npm.");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs when source or text differs", () => {
    expect(directiveId("CLAUDE.md", "x")).not.toBe(directiveId("AGENTS.md", "x"));
    expect(directiveId("CLAUDE.md", "x")).not.toBe(directiveId("CLAUDE.md", "y"));
  });
});
