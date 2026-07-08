import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseKbForgetArgs, resolveForgetHandle } from "../../src/commands/kb_forget";

// realpath dodges the macOS /var -> /private/var symlink so the resolved vault
// root matches path.resolve()'d file paths (vaultRelPath would otherwise fail to
// relativize). Mirrors mkTmp in kb-reingest-resolve.spec.ts.
function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// `mla kb forget` no longer shells out to a python worker; the CLI picks the
// server-resolvable handle (`ref` for an identity, `relPath` for a real local
// file) and POSTs it. These two specs lock that decision -- the migration's
// correctness crux, since a wrong handle 404s a doc that exists. The vault-root
// resolution and `vaultRelPath` math themselves are covered by the reingest /
// kb-add specs; here we only pin the ref-vs-relPath branching and the argv
// contract.

describe("parseKbForgetArgs", () => {
  it("takes a single positional input", () => {
    expect(parseKbForgetArgs(["kbdoc:abc"])).toEqual({
      input: "kbdoc:abc",
      workspace: undefined,
      reason: undefined,
    });
  });

  it("parses --workspace and --reason", () => {
    expect(parseKbForgetArgs(["note:notes/a.md", "--workspace", "ws9", "--reason", "superseded"])).toEqual({
      input: "note:notes/a.md",
      workspace: "ws9",
      reason: "superseded",
    });
  });

  it("requires exactly one positional", () => {
    expect(() => parseKbForgetArgs([])).toThrow(/requires a positional input/);
    expect(() => parseKbForgetArgs(["a", "b"])).toThrow(/exactly one positional/);
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseKbForgetArgs(["x", "--nope"])).toThrow(/Unknown flag/);
    expect(() => parseKbForgetArgs(["x", "--reason"])).toThrow(/Missing value/);
    expect(() => parseKbForgetArgs(["x", "--reason", "--workspace"])).toThrow(/Missing value/);
  });
});

describe("resolveForgetHandle", () => {
  it("passes kbdoc:<id> through as ref (opaque, never a file)", () => {
    expect(resolveForgetHandle("kbdoc:cmabc123")).toEqual({ ref: "kbdoc:cmabc123" });
  });

  it("rejects a bare kbdoc: prefix with no id", () => {
    expect(() => resolveForgetHandle("kbdoc:")).toThrow(/requires an id/);
  });

  it("passes a note:<eoid> identity through as ref when it is not a local file", () => {
    // An identity string that does not exist on disk: the server resolves it.
    expect(resolveForgetHandle("note:notes/decisions/no-such-file.md")).toEqual({
      ref: "note:notes/decisions/no-such-file.md",
    });
  });

  it("passes a bare identity string through as ref when it is not a local file", () => {
    expect(resolveForgetHandle("notes/decisions/no-such-file.md")).toEqual({
      ref: "notes/decisions/no-such-file.md",
    });
  });

  it("throws on empty input", () => {
    expect(() => resolveForgetHandle("   ")).toThrow(/non-empty input/);
  });

  it("maps a real local file to its vault-relative relPath", () => {
    const vault = mkTmp("mla-forget-");
    const prev = process.env.MEETLESS_NOTES_ROOT;
    try {
      // MEETLESS_NOTES_ROOT wins the vault-root resolution, so no git repo needed.
      process.env.MEETLESS_NOTES_ROOT = vault;
      const rel = path.join("decisions", "Real.md");
      const abs = path.join(vault, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "# real\n");

      // Bare path and note:<path> forms both map a real file to the SAME relPath.
      expect(resolveForgetHandle(abs)).toEqual({ relPath: "decisions/Real.md" });
      expect(resolveForgetHandle(`note:${abs}`)).toEqual({ relPath: "decisions/Real.md" });
    } finally {
      if (prev === undefined) delete process.env.MEETLESS_NOTES_ROOT;
      else process.env.MEETLESS_NOTES_ROOT = prev;
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
