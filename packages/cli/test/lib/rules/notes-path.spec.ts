import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { NotesPathScope } from "../../../src/lib/rules/notes-path";
import {
  classifyDatePrefixedNoteVaultTarget,
  classifyRuntimeTarget,
  classifyTargetPath,
  isUnderRoot,
  NOTE_VAULT_FILENAME_PREFIX_PATTERN,
} from "../../../src/lib/rules/notes-path";
import { EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";

// R0 notes-location path matcher. Classifies a concrete target path against a
// configured, repository-relative forbidden root. Uses real filesystem fixtures
// (no fs mocking, per project testing rules): existing files, new files,
// symlinks, traversal, case behavior, nested repositories, external paths,
// unreadable ancestors, and different subtrees. Canonicalization that cannot be
// proven degrades to INDETERMINATE (the evaluator turns that into UNKNOWN).

let projectRoot: string;
let tmpRoot: string;

function makeDir(...segments: string[]): string {
  const p = path.join(projectRoot, ...segments);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function makeFile(rel: string, body = "x"): string {
  const p = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

function scope(forbidden = "notes"): NotesPathScope {
  return { canonicalProjectRoot: projectRoot, configuredRelativeForbiddenPath: forbidden };
}

const insensitiveProbe = () => true;
const sensitiveProbe = () => false;
const undeterminableProbe = () => null;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mla-notes-path-"));
  // realpath so assertions are independent of macOS /var -> /private/var symlinks.
  projectRoot = fs.realpathSync(tmpRoot);
  makeDir("notes");
});

afterEach(() => {
  try {
    // restore any permissions we stripped so cleanup can recurse.
    for (const dir of fs.readdirSync(tmpRoot)) {
      try {
        fs.chmodSync(path.join(tmpRoot, dir), 0o700);
      } catch {
        /* best effort */
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("classifyTargetPath - existing files", () => {
  it("classifies an existing file under the forbidden root as UNDER", async () => {
    const target = makeFile("notes/today.md");
    expect(await classifyTargetPath(target, scope())).toBe("UNDER_FORBIDDEN_ROOT");
  });

  it("classifies an existing file outside the forbidden root as OUTSIDE", async () => {
    const target = makeFile("src/today.md");
    expect(await classifyTargetPath(target, scope())).toBe("OUTSIDE_FORBIDDEN_ROOT");
  });

  it("does not treat a sibling sharing the root prefix as UNDER", async () => {
    const target = makeFile("notes-archive/old.md");
    expect(await classifyTargetPath(target, scope())).toBe("OUTSIDE_FORBIDDEN_ROOT");
  });
});

describe("classifyDatePrefixedNoteVaultTarget", () => {
  it("governs date-prefixed notes outside the required vault", async () => {
    const vault = makeDir("vault");
    expect(
      await classifyDatePrefixedNoteVaultTarget(
        "notes/20260721-proposal.md",
        projectRoot,
        vault,
        NOTE_VAULT_FILENAME_PREFIX_PATTERN,
        { caseProbe: sensitiveProbe },
      ),
    ).toBe("DATE_PREFIXED_OUTSIDE_ALLOWED_ROOT");
  });

  it("allows date-prefixed notes inside the required vault", async () => {
    const vault = makeDir("vault");
    expect(
      await classifyDatePrefixedNoteVaultTarget(
        path.join(vault, "20260721-proposal.md"),
        projectRoot,
        vault,
        NOTE_VAULT_FILENAME_PREFIX_PATTERN,
        { caseProbe: sensitiveProbe },
      ),
    ).toBe("DATE_PREFIXED_UNDER_ALLOWED_ROOT");
  });

  it.each(["README.md", "docs/architecture.md", "/tmp/plain.md"])(
    "does not govern ordinary markdown: %s",
    async (target) => {
      const vault = makeDir("vault");
      expect(
        await classifyDatePrefixedNoteVaultTarget(
          target,
          projectRoot,
          vault,
          NOTE_VAULT_FILENAME_PREFIX_PATTERN,
          { caseProbe: sensitiveProbe },
        ),
      ).toBe("NOT_DATE_PREFIXED_NOTE");
    },
  );

  it("fails open when the config is not the pinned v1 discriminator", async () => {
    expect(
      await classifyDatePrefixedNoteVaultTarget(
        "20260721-proposal.md",
        projectRoot,
        projectRoot,
        ".*",
      ),
    ).toBe("INDETERMINATE");
  });
});

describe("classifyTargetPath - new (not-yet-existing) files", () => {
  it("classifies a new file under the forbidden root as UNDER", async () => {
    const target = path.join(projectRoot, "notes", "brand", "new.md");
    expect(await classifyTargetPath(target, scope())).toBe("UNDER_FORBIDDEN_ROOT");
  });

  it("classifies a new file outside the forbidden root as OUTSIDE", async () => {
    const target = path.join(projectRoot, "src", "brand", "new.md");
    expect(await classifyTargetPath(target, scope())).toBe("OUTSIDE_FORBIDDEN_ROOT");
  });
});

describe("classifyTargetPath - relative paths anchored at the project root", () => {
  it("anchors a relative path at the configured project root (not a nested repo)", async () => {
    makeDir(".git");
    makeDir("inner/.git");
    makeFile("inner/notes/x.md");
    // Resolved from projectRoot this is projectRoot/inner/notes/x.md, which is
    // NOT under projectRoot/notes. A git-detection scheme would mis-anchor here.
    expect(await classifyTargetPath("inner/notes/x.md", scope())).toBe("OUTSIDE_FORBIDDEN_ROOT");
  });

  it("resolves a relative forbidden path from the project root as UNDER", async () => {
    makeFile("notes/x.md");
    expect(await classifyTargetPath("notes/x.md", scope())).toBe("UNDER_FORBIDDEN_ROOT");
  });
});

describe("classifyTargetPath - symlinks", () => {
  it("follows a symlink in the existing prefix that points into the forbidden root", async () => {
    makeDir("allowed");
    fs.symlinkSync(path.join(projectRoot, "notes"), path.join(projectRoot, "allowed", "link"));
    const target = path.join(projectRoot, "allowed", "link", "x.md");
    expect(await classifyTargetPath(target, scope())).toBe("UNDER_FORBIDDEN_ROOT");
  });

  it("follows a symlink inside the forbidden root that escapes it", async () => {
    makeDir("elsewhere");
    fs.symlinkSync(path.join(projectRoot, "elsewhere"), path.join(projectRoot, "notes", "link"));
    const target = path.join(projectRoot, "notes", "link", "x.md");
    expect(await classifyTargetPath(target, scope())).toBe("OUTSIDE_FORBIDDEN_ROOT");
  });
});

describe("classifyTargetPath - traversal", () => {
  // NB: these use string concatenation, not path.join, so the literal ".." is
  // NOT lexically collapsed by the test before reaching the matcher. The matcher
  // must resolve ".." through the real filesystem (via realpath of the existing
  // prefix), never by naive lexical normalization across symlinks.
  it("resolves .. through existing directories and classifies the real location", async () => {
    makeFile("notes/x.md");
    makeDir("notes/sub"); // notes/sub/../x.md resolves through sub back to notes/x.md.
    const target = projectRoot + "/notes/sub/../x.md";
    expect(await classifyTargetPath(target, scope())).toBe("UNDER_FORBIDDEN_ROOT");
  });

  it("classifies a path that escapes the forbidden root via .. as OUTSIDE", async () => {
    makeDir("notes/sub");
    const target = projectRoot + "/notes/sub/../../src/x.md";
    expect(await classifyTargetPath(target, scope())).toBe("OUTSIDE_FORBIDDEN_ROOT");
  });

  it("returns INDETERMINATE for a .. component beyond a non-existent directory", async () => {
    const target = projectRoot + "/notes/ghost/../x.md";
    expect(await classifyTargetPath(target, scope())).toBe("INDETERMINATE");
  });
});

describe("classifyTargetPath - case behavior", () => {
  it("treats a case-variant root as UNDER on a case-insensitive volume", async () => {
    // "Vault" / "vault" are never created, so canonicalization preserves the
    // literal case of the missing components and the comparison applies policy
    // independently of the host filesystem's own case behavior.
    const target = path.join(projectRoot, "vault", "x.md");
    const result = await classifyTargetPath(target, scope("Vault"), { caseProbe: insensitiveProbe });
    expect(result).toBe("UNDER_FORBIDDEN_ROOT");
  });

  it("treats a case-variant root as OUTSIDE on a case-sensitive volume", async () => {
    const target = path.join(projectRoot, "vault", "x.md");
    const result = await classifyTargetPath(target, scope("Vault"), { caseProbe: sensitiveProbe });
    expect(result).toBe("OUTSIDE_FORBIDDEN_ROOT");
  });

  it("returns INDETERMINATE when case behavior cannot be determined", async () => {
    const target = makeFile("notes/x.md");
    const result = await classifyTargetPath(target, scope(), { caseProbe: undeterminableProbe });
    expect(result).toBe("INDETERMINATE");
  });

  it("classifies correctly with the real per-device probe (no injection)", async () => {
    const target = makeFile("notes/real.md");
    // The real probe must yield a definite verdict on a normal volume.
    expect(await classifyTargetPath(target, scope())).toBe("UNDER_FORBIDDEN_ROOT");
  });
});

describe("classifyTargetPath - external paths and different subtrees", () => {
  it("classifies a path in a different temp subtree as OUTSIDE", async () => {
    const otherRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mla-other-")));
    try {
      const target = path.join(otherRoot, "notes", "x.md");
      expect(await classifyTargetPath(target, scope())).toBe("OUTSIDE_FORBIDDEN_ROOT");
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it("classifies an absolute system path as OUTSIDE", async () => {
    expect(await classifyTargetPath("/etc/hosts", scope())).toBe("OUTSIDE_FORBIDDEN_ROOT");
  });
});

describe("classifyTargetPath - unreadable ancestors", () => {
  it("returns INDETERMINATE when an ancestor cannot be traversed", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      // root bypasses permission bits; the EACCES path is unreachable.
      return;
    }
    const locked = makeDir("locked");
    fs.mkdirSync(path.join(locked, "notes"), { recursive: true });
    fs.chmodSync(locked, 0o000);
    try {
      const target = path.join(locked, "notes", "x.md");
      expect(await classifyTargetPath(target, scope())).toBe("INDETERMINATE");
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

describe("classifyTargetPath - malformed input", () => {
  it("returns INDETERMINATE for a non-string path", async () => {
    expect(await classifyTargetPath(42, scope())).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE for an empty path", async () => {
    expect(await classifyTargetPath("", scope())).toBe("INDETERMINATE");
  });

  it("returns INDETERMINATE for a path containing a NUL byte", async () => {
    expect(await classifyTargetPath("notes/x .md", scope())).toBe("INDETERMINATE");
  });
});

describe("isUnderRoot (pure comparator)", () => {
  it("treats an identical path as under the root", () => {
    expect(isUnderRoot("/a/notes", "/a/notes", false)).toBe(true);
  });

  it("treats a descendant as under the root", () => {
    expect(isUnderRoot("/a/notes/x.md", "/a/notes", false)).toBe(true);
  });

  it("does not treat a prefix-sharing sibling as under the root", () => {
    expect(isUnderRoot("/a/notes-archive/x.md", "/a/notes", false)).toBe(false);
  });

  it("applies case-insensitive comparison when requested", () => {
    expect(isUnderRoot("/a/NOTES/x.md", "/a/notes", true)).toBe(true);
    expect(isUnderRoot("/a/NOTES/x.md", "/a/notes", false)).toBe(false);
  });
});

// classifyRuntimeTarget produces the evaluation-input-v1 `target` union: where the
// action wants to write, expressed RELATIVE to the runtime project root (never an
// absolute home path), or OUTSIDE_RUNTIME_SCOPE, or UNKNOWN when canonicalization
// cannot prove the answer. This is the pathCanonicalizerVersion="notes-path-v1"
// canonicalizer feeding the persisted snapshot; it is a different axis from the
// forbidden-root denylist (a src/ file is RUNTIME_RELATIVE here but OUTSIDE the
// forbidden root) so the stored target plus forbiddenRootRelativePath together let a
// later replay recompute the verdict from the snapshot alone.
describe("classifyRuntimeTarget - runtime-relative target union", () => {
  let externalDir: string;

  beforeEach(() => {
    externalDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mla-rt-ext-")));
  });

  afterEach(() => {
    fs.rmSync(externalDir, { recursive: true, force: true });
  });

  it("classifies a file under the project root as RUNTIME_RELATIVE with a posix relative path", async () => {
    const target = makeFile("src/app/main.ts");
    expect(await classifyRuntimeTarget(target, projectRoot, { caseProbe: sensitiveProbe })).toEqual<EvaluationTarget>({
      kind: "RUNTIME_RELATIVE",
      path: "src/app/main.ts",
    });
  });

  it("classifies a notes file as RUNTIME_RELATIVE (membership in the forbidden root is a separate axis)", async () => {
    const target = makeFile("notes/today.md");
    expect(await classifyRuntimeTarget(target, projectRoot, { caseProbe: sensitiveProbe })).toEqual<EvaluationTarget>({
      kind: "RUNTIME_RELATIVE",
      path: "notes/today.md",
    });
  });

  it("resolves a project-relative input path against the runtime root", async () => {
    makeFile("docs/readme.md");
    expect(
      await classifyRuntimeTarget("docs/readme.md", projectRoot, { caseProbe: sensitiveProbe }),
    ).toEqual<EvaluationTarget>({ kind: "RUNTIME_RELATIVE", path: "docs/readme.md" });
  });

  it("classifies a file outside the project root as OUTSIDE_RUNTIME_SCOPE carrying no path", async () => {
    const target = path.join(externalDir, "elsewhere.md");
    fs.writeFileSync(target, "x");
    expect(await classifyRuntimeTarget(target, projectRoot, { caseProbe: sensitiveProbe })).toEqual<EvaluationTarget>({
      kind: "OUTSIDE_RUNTIME_SCOPE",
    });
  });

  it("returns UNKNOWN/CANONICALIZATION_FAILED for a non-string path", async () => {
    expect(await classifyRuntimeTarget(42, projectRoot)).toEqual<EvaluationTarget>({
      kind: "UNKNOWN",
      reasonCode: "CANONICALIZATION_FAILED",
    });
  });

  it("returns UNKNOWN/CANONICALIZATION_FAILED for a path containing a NUL byte", async () => {
    expect(await classifyRuntimeTarget("notes/x\0.md", projectRoot)).toEqual<EvaluationTarget>({
      kind: "UNKNOWN",
      reasonCode: "CANONICALIZATION_FAILED",
    });
  });

  it("returns UNKNOWN when the case policy cannot be determined", async () => {
    const target = makeFile("src/app/main.ts");
    expect(await classifyRuntimeTarget(target, projectRoot, { caseProbe: undeterminableProbe })).toEqual<EvaluationTarget>(
      { kind: "UNKNOWN", reasonCode: "CANONICALIZATION_FAILED" },
    );
  });
});
