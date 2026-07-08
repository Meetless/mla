import { parseKbShowArgs } from "../../src/commands/kb_show";

// B4b (notes/20260603-mla-kb-agent-proxy-and-evidence-adoption.md §3 B4, §5 #5).
// `mla kb show` gained an opt-in `--open` flag. Lock the parser contract:
// the flag is boolean, defaults off, and never changes the positional <input>.
// The resolved decision (§5 #5) is "print the URL ALWAYS, `--open` opt-in, NO
// browser auto-open", so the default MUST stay off.

describe("parseKbShowArgs: --open (B4b)", () => {
  it("defaults off", () => {
    expect(parseKbShowArgs(["kbdoc:abc"]).open).toBe(false);
  });

  it("is opt-in", () => {
    const flags = parseKbShowArgs(["kbdoc:abc", "--open"]);
    expect(flags.open).toBe(true);
    expect(flags.input).toBe("kbdoc:abc");
  });

  it("composes with other flags without consuming the positional", () => {
    const flags = parseKbShowArgs(["note:foo.md", "--json", "--open", "--all"]);
    expect(flags.open).toBe(true);
    expect(flags.json).toBe(true);
    expect(flags.all).toBe(true);
    expect(flags.input).toBe("note:foo.md");
  });
});
