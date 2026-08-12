import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decideBundleEnforcement } from "../../../src/lib/rules/bundle-enforce";
import {
  NOTE_VAULT_EVALUATOR_CONTRACT_VERSION,
  NOTE_VAULT_FILENAME_PREFIX_PATTERN,
  NOTE_VAULT_MATCHER_SCHEMA_VERSION,
  NOTE_VAULT_PATH_CANONICALIZER_VERSION,
} from "../../../src/lib/rules/notes-path";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import { effectiveCwd } from "../../../src/lib/rules/write-targets";
import type { RuleBundle, RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";
import type { BundleCacheRead } from "../../../src/lib/rules/bundle-cache";
import type { RulePayloadV1 } from "../../../src/lib/rules/types";
import type { ToolCall } from "../../../src/lib/rules/evaluator";

// A FALSE POSITIVE observed live on 2026-08-05, twice, on this session's own writes.
//
// `cat >> 20260804-note.md` run from INSIDE the notes vault produced a governed-rule advisory saying
// the write was "outside the required note vault", and its suggested compliant path was
// byte-identical to where the file already was. A rule whose remediation is "put it where it already
// is" has mis-resolved the target, not caught a violation.
//
// Cause: a relative write target resolved against `runtimeProjectRoot` (the activated repo root)
// rather than the shell's real working directory, which the PreToolUse payload carries as `cwd` and
// the evaluator ignored. Invisible for Edit and Write, whose `file_path` is absolute. It bites Bash,
// where a redirect target is usually relative and the operator has usually cd'd first.
//
// These specs use REAL temp directories and the REAL canonicalizer, with no injected classifier.
// That is deliberate and it is the thing a first attempt at this file got wrong: injecting the
// note-vault classifier stubs out the very join under test, and pointing the real one at a
// non-existent root makes every case return INDETERMINATE, so every assertion passes while proving
// nothing. The join only tells the truth against a filesystem that exists.
//
// Severity beyond the nag: this rule is attested at WARN so it only advised. The SAME mis-resolution
// under a DENY ceiling blocks a fully compliant write, and one wrong denial costs the user's consent
// to be governed. It is also exactly the population the overturned-denial rate exists to measure.

let root: string;
let repo: string;
let vault: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mla-cwd-"));
  repo = path.join(root, "meetless");
  vault = path.join(root, "notes");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

function payload(): RulePayloadV1 {
  return {
    text: "Date-prefixed working notes belong in the standalone vault.",
    applicability: {
      mode: "action",
      tools: ["Edit", "Write"],
      matcher: { field: "file_path", glob: "*.md" },
    },
    compliance: {
      evaluatorContractVersion: NOTE_VAULT_EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: NOTE_VAULT_MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: NOTE_VAULT_PATH_CANONICALIZER_VERSION,
      config: {
        allowedRootAbsolutePath: vault,
        filenamePrefixPattern: NOTE_VAULT_FILENAME_PREFIX_PATTERN,
      },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: "WARN",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: repo,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
  };
}

function fresh(): BundleCacheRead {
  const p = payload();
  const entry: RuleBundleEntry = {
    ruleNodeId: "rn_vault",
    ruleVersionId: "rv_vault_1",
    authorityScope: "WORKSPACE",
    ownerUserId: null,
    projectId: null,
    payload: p,
    canonicalPayloadHash: ruleVersionHash(p),
    attestedByUserId: "user_an",
    attestedAt: "2026-07-21T16:04:01.673Z",
    supersedesVersionId: null,
  };
  const bundle: RuleBundle = {
    schemaVersion: 1,
    principalUserId: "user_an",
    workspaceId: "ws_1",
    projectId: null,
    bundleRevision: 7,
    generatedAt: "2026-06-27T00:00:00.000Z",
    validUntil: "2026-06-27T01:00:00.000Z",
    rules: [entry],
  };
  return { status: "fresh", bundle, ageMs: 1000, droppedForIntegrity: 0, reason: null };
}

/** The real decision, real canonicalizer, real filesystem. `relativeBase` is the payload cwd. */
function decide(command: string, relativeBase?: string) {
  const call: ToolCall = { toolName: "Bash", toolInput: { command } };
  return decideBundleEnforcement({
    call,
    read: fresh(),
    runtimeProjectRoot: repo,
    runtimeScopeId: repo,
    maxEnforcement: "DENY",
    ...(relativeBase === undefined ? {} : { relativeBase }),
  });
}

describe("a relative write target resolves against the shell's cwd", () => {
  it("does NOT fire when the shell is IN the vault writing a relative note", async () => {
    // The exact live false positive. The file lands in the vault, so the rule is satisfied.
    const d = await decide("cat >> 20260805-note.md", vault);
    expect(d.kind).toBe("PASS");
  });

  it("STILL fires when the shell is in the REPO writing the same relative name", async () => {
    // The genuine violation must keep firing. Fixing a false positive by going blind is not a fix,
    // and this is the assertion that separates the two.
    const d = await decide("cat >> 20260805-note.md", repo);
    expect(d.kind).toBe("WARN");
    if (d.kind !== "WARN") throw new Error("unreachable");
    expect(d.reason).toContain("outside the required note vault");
  });

  it("is unaffected for an ABSOLUTE target, whatever the cwd", async () => {
    // Edit and Write always send absolute paths, which is why this defect was invisible there.
    const outside = await decide(`cat >> ${repo}/20260805-note.md`, vault);
    expect(outside.kind).toBe("WARN");
    const inside = await decide(`cat >> ${vault}/20260805-note.md`, repo);
    expect(inside.kind).toBe("PASS");
  });

  it("falls back to the repo root when no cwd is supplied", async () => {
    // An older host, or any payload without `cwd`, keeps the exact behavior it had before this
    // parameter existed. A missing cwd must never silently stop enforcement.
    const d = await decide("cat >> 20260805-note.md");
    expect(d.kind).toBe("WARN");
  });

  it("ignores a non-absolute cwd rather than composing two relative paths", async () => {
    const d = await decide("cat >> 20260805-note.md", "../somewhere");
    expect(d.kind).toBe("WARN");
  });

  it("leaves a non-date-prefixed file compliant wherever it is written", async () => {
    // The generation-2 narrowing, unchanged: ordinary docs are governed by nothing here.
    const d = await decide("cat >> README.md", repo);
    expect(d.kind).toBe("PASS");
  });
});

// The SEAM as the hook actually composes it: raw command -> effectiveCwd -> decideBundleEnforcement.
// The specs above hand `relativeBase` in pre-computed, so they cannot see a defect in the step that
// computes it, and that is exactly where the 2026-08-08 recurrence lived. Running the composition is
// what makes this regression falsifiable end to end.
function decideFromRawCommand(command: string, payloadCwd: string | undefined) {
  const call: ToolCall = { toolName: "Bash", toolInput: { command } };
  const base = effectiveCwd(command, payloadCwd);
  return decideBundleEnforcement({
    call,
    read: fresh(),
    runtimeProjectRoot: repo,
    runtimeScopeId: repo,
    maxEnforcement: "DENY",
    ...(base === undefined ? {} : { relativeBase: base }),
  });
}

describe("a leading `cd` inside the SAME command sets the base (the live 2026-08-08 false positive)", () => {
  it("does NOT fire on the exact heredoc shape that warned twice in session 2be606bb", async () => {
    // Verbatim command shape, newline separator and all. The payload cwd is a THIRD directory
    // (the console app), which is what made the old fallback land on a path that does not exist.
    const outside = path.join(repo, "apps", "console");
    fs.mkdirSync(outside, { recursive: true });
    const d = await decideFromRawCommand(
      `cd ${vault}\ncat >> 20260806-f3-self-correction-exemption-verification.md <<'EOF'\n## 15. body\nEOF`,
      outside,
    );
    expect(d.kind).toBe("PASS");
  });

  it("still fires when the SAME shape cd's somewhere that is not the vault", async () => {
    // The falsifier. A fix that merely stops warning is indistinguishable from deleting the rule.
    const d = await decideFromRawCommand(`cd ${repo}\ncat >> 20260806-note.md <<'EOF'\nbody\nEOF`, vault);
    expect(d.kind).toBe("WARN");
    if (d.kind !== "WARN") throw new Error("unreachable");
    expect(d.reason).toContain("outside the required note vault");
  });

  it("keeps honouring `&&` and `;` through the same composition", async () => {
    expect((await decideFromRawCommand(`cd ${vault} && cat >> 20260806-x.md`, repo)).kind).toBe("PASS");
    expect((await decideFromRawCommand(`cd ${vault}; cat >> 20260806-x.md`, repo)).kind).toBe("PASS");
  });

  it("falls back to the payload cwd when the command has no leading cd", async () => {
    expect((await decideFromRawCommand("cat >> 20260806-x.md", vault)).kind).toBe("PASS");
    expect((await decideFromRawCommand("cat >> 20260806-x.md", repo)).kind).toBe("WARN");
  });
});
