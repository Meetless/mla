import {
  parseKbTensionsArgs,
  stripCitationMarker,
} from "../../src/commands/kb_tensions";

// Behavioral lock for `mla kb tensions` (T1) argument parsing. The command takes one
// positional ref (a note path, note:<path>, or kbdoc:<id>) plus --workspace and --json.

describe("parseKbTensionsArgs", () => {
  it("requires a positional ref", () => {
    expect(() => parseKbTensionsArgs([])).toThrow(/a document ref is required/i);
  });

  it("parses a bare note path with no flags", () => {
    expect(parseKbTensionsArgs(["notes/foo.md"])).toEqual({
      input: "notes/foo.md",
      workspace: undefined,
      json: false,
    });
  });

  it("parses --workspace (space and = forms) and --json", () => {
    expect(parseKbTensionsArgs(["kbdoc:abc", "--workspace", "ws1", "--json"])).toEqual({
      input: "kbdoc:abc",
      workspace: "ws1",
      json: true,
    });
    expect(parseKbTensionsArgs(["--workspace=ws2", "note:notes/b.md"])).toEqual({
      input: "note:notes/b.md",
      workspace: "ws2",
      json: false,
    });
  });

  it("rejects a second positional and an unknown flag", () => {
    expect(() => parseKbTensionsArgs(["a", "b"])).toThrow(/unexpected argument/i);
    expect(() => parseKbTensionsArgs(["a", "--nope"])).toThrow(/unexpected argument/i);
  });
});

describe("stripCitationMarker", () => {
  it("strips a leading NT: citation marker so an evidence citation resolves", () => {
    expect(stripCitationMarker("NT:notes/foo.md")).toBe("notes/foo.md");
  });

  it("leaves an artifact prefix untouched (note:/kbdoc: are not NT:)", () => {
    expect(stripCitationMarker("note:notes/foo.md")).toBe("note:notes/foo.md");
    expect(stripCitationMarker("kbdoc:abc")).toBe("kbdoc:abc");
    expect(stripCitationMarker("notes/foo.md")).toBe("notes/foo.md");
  });
});
