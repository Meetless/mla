import { deriveWriteTargets, isWriteCapableTool, shellWriteTargets } from "../../src/lib/rules/write-targets";

describe("shellWriteTargets", () => {
  it("catches the bypass our own benchmark caught", () => {
    // The literal escape a cheaper model took after the governed Write was DENIED:
    //   Write notes/design.md -> BLOCKED
    //   Bash  cat > notes/design.md -> succeeded, hook never fired
    expect(shellWriteTargets("cat > notes/design-ec04f3.md <<'EOF'\nhi\nEOF")).toContain("notes/design-ec04f3.md");
  });

  it("catches the common redirect forms", () => {
    expect(shellWriteTargets("echo hi > notes/a.md")).toEqual(["notes/a.md"]);
    expect(shellWriteTargets("echo hi >> notes/a.md")).toEqual(["notes/a.md"]);
    expect(shellWriteTargets("printf x > 'notes/with space.md'")).toEqual(["notes/with space.md"]);
    expect(shellWriteTargets('cat <<EOF > "notes/q.md"')).toEqual(["notes/q.md"]);
    expect(shellWriteTargets("node gen.js 2> notes/err.log")).toEqual(["notes/err.log"]);
  });

  it("catches tee, touch, sed -i, dd, and copy-likes", () => {
    expect(shellWriteTargets("echo hi | tee notes/a.md")).toContain("notes/a.md");
    expect(shellWriteTargets("echo hi | tee -a notes/a.md")).toContain("notes/a.md");
    expect(shellWriteTargets("touch notes/a.md notes/b.md")).toEqual(["notes/a.md", "notes/b.md"]);
    expect(shellWriteTargets("sed -i '' 's/a/b/' notes/a.md")).toContain("notes/a.md");
    expect(shellWriteTargets("dd if=/dev/zero of=notes/a.bin")).toContain("notes/a.bin");
    expect(shellWriteTargets("cp src/x.md notes/a.md")).toContain("notes/a.md");
    expect(shellWriteTargets("mv tmp.md notes/a.md")).toContain("notes/a.md");
  });

  it("does not mistake reads or fd duplication for writes", () => {
    // A false positive costs one confused retry; still, do not block plain reads.
    expect(shellWriteTargets("cat notes/a.md")).toEqual([]);
    expect(shellWriteTargets("grep -r foo notes/")).toEqual([]);
    expect(shellWriteTargets("node x.js < notes/in.txt")).toEqual([]);
    expect(shellWriteTargets("node x.js 2>&1")).toEqual([]);
    expect(shellWriteTargets("ls -la")).toEqual([]);
  });

  it("finds targets in chained and piped commands", () => {
    const t = shellWriteTargets("mkdir -p notes && echo a > notes/a.md && echo b > docs/b.md");
    expect(t).toContain("notes/a.md");
    expect(t).toContain("docs/b.md");
  });

  it("is empty for a non-string command", () => {
    expect(shellWriteTargets(undefined as unknown as string)).toEqual([]);
  });
});

describe("deriveWriteTargets", () => {
  it("reads the declared path for the direct file tools (unchanged behaviour)", () => {
    expect(deriveWriteTargets({ toolName: "Write", toolInput: { file_path: "notes/a.md" } })).toEqual(["notes/a.md"]);
    expect(deriveWriteTargets({ toolName: "Edit", toolInput: { file_path: "notes/a.md" } })).toEqual(["notes/a.md"]);
  });

  it("covers the write tools the old matcher silently exempted", () => {
    // ^(Write|Edit)$ let these through: MultiEdit and NotebookEdit write files too.
    expect(deriveWriteTargets({ toolName: "MultiEdit", toolInput: { file_path: "notes/a.md" } })).toEqual(["notes/a.md"]);
    expect(deriveWriteTargets({ toolName: "NotebookEdit", toolInput: { notebook_path: "notes/a.ipynb" } })).toEqual(["notes/a.ipynb"]);
  });

  it("derives Bash targets from the command", () => {
    expect(deriveWriteTargets({ toolName: "Bash", toolInput: { command: "echo x > notes/a.md" } })).toEqual(["notes/a.md"]);
  });

  it("returns nothing for read-only tools", () => {
    expect(deriveWriteTargets({ toolName: "Read", toolInput: { file_path: "notes/a.md" } })).toEqual([]);
    expect(deriveWriteTargets({ toolName: "Grep", toolInput: { pattern: "x" } })).toEqual([]);
  });

  it("knows which tools can write", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) expect(isWriteCapableTool(t)).toBe(true);
    for (const t of ["Read", "Grep", "Glob", "WebFetch"]) expect(isWriteCapableTool(t)).toBe(false);
  });
});
