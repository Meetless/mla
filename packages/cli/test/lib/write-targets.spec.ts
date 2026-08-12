import {
  applyPatchWriteTargets,
  deriveWriteTargets,
  effectiveCwd,
  isWriteCapableTool,
  shellWriteTargets,
} from "../../src/lib/rules/write-targets";

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

describe("applyPatchWriteTargets", () => {
  it("extracts Codex add, update, delete, and move targets", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: notes/new file.md",
      "+new",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: notes/retired.md",
      "*** End Patch",
    ].join("\n");
    expect(applyPatchWriteTargets(patch)).toEqual([
      "notes/new file.md",
      "src/old.ts",
      "notes/retired.md",
      "src/new.ts",
    ]);
  });

  it("deduplicates targets and ignores malformed input", () => {
    expect(applyPatchWriteTargets("*** Update File: notes/a.md\n*** Update File: notes/a.md")).toEqual([
      "notes/a.md",
    ]);
    expect(applyPatchWriteTargets(undefined as unknown as string)).toEqual([]);
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

  it("derives Codex apply_patch targets from the command", () => {
    expect(
      deriveWriteTargets({
        toolName: "apply_patch",
        toolInput: {
          command: "*** Begin Patch\n*** Add File: notes/a.md\n+x\n*** End Patch",
        },
      }),
    ).toEqual(["notes/a.md"]);
  });

  it("returns nothing for read-only tools", () => {
    expect(deriveWriteTargets({ toolName: "Read", toolInput: { file_path: "notes/a.md" } })).toEqual([]);
    expect(deriveWriteTargets({ toolName: "Grep", toolInput: { pattern: "x" } })).toEqual([]);
  });

  it("knows which tools can write", () => {
    for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "apply_patch"])
      expect(isWriteCapableTool(t)).toBe(true);
    for (const t of ["Read", "Grep", "Glob", "WebFetch"]) expect(isWriteCapableTool(t)).toBe(false);
  });
});


describe("effectiveCwd: a relative write target is judged where it actually lands", () => {
  // THE FALSE POSITIVE THIS CLOSES. A governed note-vault rule warned three times in one
  // session that a COMPLIANT file was "outside the required note vault", and each time the
  // suggested compliant path was the path the file was already at.
  //
  // relativeBase (added 2026-08-05) fixed the case where the operator had cd'd in a PREVIOUS
  // command: the PreToolUse payload's `cwd` carries that. It cannot see a `cd` inside THIS
  // command, and `cd <vault> && cat > 20260806-x.md` is one command. So the bare filename
  // resolved against the repo root and the rule reported on a file that does not exist.
  //
  // A wrong location is not a wrong verdict, it is a verdict about a DIFFERENT FILE, which is
  // the reasoning already written on relativeBase. This extends it to the leading `cd`.
  //
  // Deliberately NOT "regex the command to infer compliance": this computes the effective
  // WORKING DIRECTORY and then lets the existing governed-path rule decide, unchanged. Nothing
  // here knows what a vault is.
  const FALLBACK = "/repo/root";

  it("uses a leading absolute `cd ... &&` as the base", () => {
    expect(effectiveCwd("cd /vault && cat > 20260806-x.md", FALLBACK)).toBe("/vault");
  });

  it("accepts `;` as the separator too", () => {
    expect(effectiveCwd("cd /vault; cat > 20260806-x.md", FALLBACK)).toBe("/vault");
  });

  // THE SEPARATOR THIS FILE MISSED, and the reason the same false positive fired again on
  // 2026-08-08 in session 2be606bb, twice, on a rule that had already been "fixed" for it.
  //
  // A NEWLINE is a command separator in every shell, and it is the separator an agent
  // reaches for whenever the second command is a heredoc, because `cd x && cat <<'EOF'` and
  // `cd x` + newline + `cat <<'EOF'` are the same program and only the second one reads. Both
  // live warnings were literally:
  //
  //     cd /Users/alice/projects/app/notes\ncat >> 20260806-....md <<'EOF'
  //
  // The old pattern terminated on `&&`, `;` or end-of-string only, so it did not match, the
  // base fell back to the payload cwd (`.../meetless/apps/console`), and the rule reported on
  // a file at a path that does not exist. Same defect, same file, one un-modelled separator.
  it("accepts a NEWLINE as the separator, which is what a heredoc write actually uses", () => {
    expect(effectiveCwd("cd /vault\ncat > 20260806-x.md", FALLBACK)).toBe("/vault");
    expect(effectiveCwd("cd /vault\ncat >> 20260806-x.md <<'EOF'\nbody\nEOF", FALLBACK)).toBe("/vault");
    // Trailing spaces before the newline are still just whitespace.
    expect(effectiveCwd("cd /vault  \ncat > a.md", FALLBACK)).toBe("/vault");
    // A relative cd resolves against the fallback on this separator too.
    expect(effectiveCwd("cd notes\ncat > 20260806-x.md", FALLBACK)).toBe("/repo/root/notes");
  });

  it("does not let the newline separator swallow the next word as a target", () => {
    // `cd` alone on its own line is still unresolvable, and must fall back rather than
    // consume `cat` from the following line as the directory.
    expect(effectiveCwd("cd\ncat > a.md", FALLBACK)).toBe(FALLBACK);
  });

  it("handles a quoted path with spaces", () => {
    expect(effectiveCwd('cd "/path with space" && echo hi > a.md', FALLBACK)).toBe("/path with space");
    expect(effectiveCwd("cd '/path with space' && echo hi > a.md", FALLBACK)).toBe("/path with space");
  });

  it("resolves a RELATIVE cd against the fallback, because that is what the shell does", () => {
    expect(effectiveCwd("cd notes && cat > 20260806-x.md", FALLBACK)).toBe("/repo/root/notes");
  });

  it("descends: a subdirectory cd resolves to the subdirectory", () => {
    // The governed rule decides descendant-ness itself; this only has to report where the
    // shell actually is.
    expect(effectiveCwd("cd /vault/sub && cat > a.md", FALLBACK)).toBe("/vault/sub");
  });

  it("returns the fallback when there is no cd at all", () => {
    expect(effectiveCwd("cat > 20260806-x.md", FALLBACK)).toBe(FALLBACK);
    expect(effectiveCwd("", FALLBACK)).toBe(FALLBACK);
  });

  it("IGNORES a cd that is not the leading command", () => {
    // Conservative on purpose. Interpreting a mid-pipeline cd means modelling the shell, and a
    // wrong base here would move the verdict onto a different file in the OTHER direction:
    // silently exempting a non-compliant write. Falling back keeps today's behaviour.
    expect(effectiveCwd("echo hi && cd /vault && cat > a.md", FALLBACK)).toBe(FALLBACK);
  });

  it("returns the fallback for forms it cannot resolve", () => {
    expect(effectiveCwd("cd && cat > a.md", FALLBACK)).toBe(FALLBACK);
    expect(effectiveCwd("cd - && cat > a.md", FALLBACK)).toBe(FALLBACK);
    // No tilde expansion: guessing at $HOME here would be a second source of wrong bases.
    expect(effectiveCwd("cd ~/vault && cat > a.md", FALLBACK)).toBe(FALLBACK);
  });

  it("survives a payload that carried no cwd at all", () => {
    // `parsed.cwd` is optional on the PreToolUse payload. An absolute cd is still answerable
    // without a base; a relative one is not, and inventing one from process.cwd() would be a third
    // wrong answer rather than a fix.
    expect(effectiveCwd("cd /vault && cat > a.md", undefined)).toBe("/vault");
    expect(effectiveCwd("cd notes && cat > a.md", undefined)).toBeUndefined();
    expect(effectiveCwd("cat > a.md", undefined)).toBeUndefined();
  });

  it("does not treat a command merely STARTING with the letters cd as a cd", () => {
    expect(effectiveCwd("cdk deploy && cat > a.md", FALLBACK)).toBe(FALLBACK);
  });
});
