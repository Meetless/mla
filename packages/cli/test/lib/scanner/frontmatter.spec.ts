import { parseFrontmatter } from "../../../src/lib/scanner/frontmatter";

describe("parseFrontmatter", () => {
  it("extracts simple key/value frontmatter and the body", () => {
    const text = "---\nstatus: superseded\nowner: an\n---\n# Title\nbody line\n";
    const { data, body } = parseFrontmatter(text);
    expect(data.status).toBe("superseded");
    expect(data.owner).toBe("an");
    expect(body).toBe("# Title\nbody line\n");
  });

  it("returns empty data and the original text when there is no frontmatter", () => {
    const text = "# No frontmatter\njust prose\n";
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe(text);
  });

  it("ignores list/nested values rather than throwing (paths handled separately)", () => {
    const text = "---\nstatus: active\npaths:\n  - 'src/**'\n---\nbody\n";
    const { data } = parseFrontmatter(text);
    expect(data.status).toBe("active");
    expect(data.paths).toBeUndefined();
  });

  it("unescapes a double-quoted scalar (strips the outer quotes, turns \\\" into a real quote)", () => {
    // This is the exact shape the agent-memory feedback files use for descriptions
    // that embed a quoted phrase; the naive strip left literal backslashes behind.
    const text = '---\ndescription: "assert the OUTPUT, not just \\"was called\\"."\n---\nbody\n';
    const { data } = parseFrontmatter(text);
    expect(data.description).toBe('assert the OUTPUT, not just "was called".');
  });

  it("unescapes an escaped backslash in a double-quoted scalar without eating the next char", () => {
    const text = '---\nre: "a\\\\nb"\n---\nbody\n';
    // YAML double-quoted: \\ -> one backslash, then a literal n (NOT a newline).
    const { data } = parseFrontmatter(text);
    expect(data.re).toBe("a\\nb");
  });

  it("unescapes a single-quoted scalar via YAML doubled-quote rule ('' -> ')", () => {
    const text = "---\nname: 'An''s rule'\n---\nbody\n";
    const { data } = parseFrontmatter(text);
    expect(data.name).toBe("An's rule");
  });

  it("leaves a plain scalar that merely contains a quote untouched (no spurious stripping)", () => {
    const text = '---\nnote: say "hi" loudly\n---\nbody\n';
    const { data } = parseFrontmatter(text);
    expect(data.note).toBe('say "hi" loudly');
  });
});
