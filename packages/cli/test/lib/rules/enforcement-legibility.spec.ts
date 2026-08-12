import {
  EVALUATOR_CONTRACT_VERSION,
  MATCHER_SCHEMA_VERSION,
  PATH_CANONICALIZER_VERSION,
} from "../../../src/lib/rules/durable-observation";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import type { EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";
import type { RuleBundle, RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";
import type { BundleCacheRead } from "../../../src/lib/rules/bundle-cache";
import type { RulePayloadV1 } from "../../../src/lib/rules/types";
import type { ToolCall } from "../../../src/lib/rules/evaluator";
import { decideBundleEnforcement } from "../../../src/lib/rules/bundle-enforce";
import type { EligibleEnforcement } from "../../../src/lib/rules/deny-admission";
import {
  NOTE_VAULT_EVALUATOR_CONTRACT_VERSION,
  NOTE_VAULT_FILENAME_PREFIX_PATTERN,
  NOTE_VAULT_MATCHER_SCHEMA_VERSION,
  NOTE_VAULT_PATH_CANONICALIZER_VERSION,
  type NoteVaultClassification,
} from "../../../src/lib/rules/notes-path";

// D.1 / D.2 (notes/20260804-value-program-closeout-and-browser-delivery.md §4.2): a block or advisory
// must say on whose authority it fired and, where it can be DERIVED, what the compliant move is.
//
// Two negative properties matter more than the positive ones here, and both are pinned below:
//
//   1. The opaque attester id is NEVER printed. The bundle carries only `attestedByUserId`, a cuid,
//      and no human-readable attester exists on the entry at all. A cuid in a block message is a
//      token the operator cannot act on, and resolving it would mean a network call on the PreToolUse
//      hot path. So the SOURCE clause carries date + ceiling + version and no identity.
//   2. A compliant path is emitted ONLY from an explicit destination root. A forbidden-root config
//      says where a file may not go and names no destination, so nothing is emitted. Guessing one
//      would be INV-4 applied to a suggestion.

const SCOPE = "/work/meetless";
const VAULT = "/work/notes";
const ATTESTER_CUID = "c00example000000000000001";

function forbiddenRootPayload(ceiling: EligibleEnforcement): RulePayloadV1 {
  return {
    text: "Notes and design docs MUST go in the standalone vault.",
    applicability: {
      mode: "action",
      tools: ["Edit", "Write"],
      matcher: { field: "file_path", glob: "*.md" },
    },
    compliance: {
      evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
      config: { forbiddenRootRelativePath: "notes" },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: ceiling,
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: SCOPE,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
  };
}

function noteVaultPayload(ceiling: EligibleEnforcement): RulePayloadV1 {
  return {
    ...forbiddenRootPayload(ceiling),
    text: "Date-prefixed working notes must go in the standalone vault.",
    compliance: {
      evaluatorContractVersion: NOTE_VAULT_EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: NOTE_VAULT_MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: NOTE_VAULT_PATH_CANONICALIZER_VERSION,
      config: {
        allowedRootAbsolutePath: VAULT,
        filenamePrefixPattern: NOTE_VAULT_FILENAME_PREFIX_PATTERN,
      },
    },
  };
}

function entry(nodeId: string, payload: RulePayloadV1): RuleBundleEntry {
  return {
    ruleNodeId: nodeId,
    ruleVersionId: `${nodeId}_v1`,
    authorityScope: "WORKSPACE",
    ownerUserId: null,
    projectId: null,
    payload,
    canonicalPayloadHash: ruleVersionHash(payload),
    attestedByUserId: ATTESTER_CUID,
    attestedAt: "2026-07-21T16:04:01.673Z",
    supersedesVersionId: null,
  };
}

function fresh(rules: RuleBundleEntry[]): BundleCacheRead {
  const b: RuleBundle = {
    schemaVersion: 1,
    principalUserId: "user_an",
    workspaceId: "ws_1",
    projectId: null,
    bundleRevision: 7,
    generatedAt: "2026-06-27T00:00:00.000Z",
    validUntil: "2026-06-27T01:00:00.000Z",
    rules,
  };
  return { status: "fresh", bundle: b, ageMs: 1000, droppedForIntegrity: 0, reason: null };
}

const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

// The note-vault arm reaches its own canonicalizer, which touches the filesystem. Inject the
// classification so this stays pure, exactly as the sibling bundle-enforce spec does.
const classifyNoteVault = async (): Promise<NoteVaultClassification> =>
  "DATE_PREFIXED_OUTSIDE_ALLOWED_ROOT";

function decide(read: BundleCacheRead, call: ToolCall, maxEnforcement: EligibleEnforcement) {
  return decideBundleEnforcement({
    call,
    read,
    runtimeProjectRoot: "/runtime/root",
    runtimeScopeId: SCOPE,
    classifyRuntime,
    classifyNoteVault,
    maxEnforcement,
  });
}

function writeMd(filePath: string): ToolCall {
  return { toolName: "Write", toolInput: { file_path: filePath, content: "hi" } };
}

describe("D.1: the SOURCE clause states authority without naming an identity", () => {
  it("a DENY body carries the attestation date, the ceiling and the version", async () => {
    const d = await decide(fresh([entry("r_deny", forbiddenRootPayload("DENY"))]), writeMd("notes/x.md"), "DENY");
    if (d.kind !== "DENY") throw new Error(`expected DENY, got ${d.kind}`);
    expect(d.reason).toContain("Attested 2026-07-21");
    expect(d.reason).toContain("ceiling DENY");
    expect(d.reason).toContain("version r_deny_v1");
  });

  it("NEVER prints the opaque attester id, on any arm", async () => {
    // The cuid is present on the entry and deliberately unused. If a future edit starts rendering
    // `attestedByUserId`, this fails.
    const deny = await decide(fresh([entry("r_deny", forbiddenRootPayload("DENY"))]), writeMd("notes/x.md"), "DENY");
    const warn = await decide(fresh([entry("r_warn", forbiddenRootPayload("WARN"))]), writeMd("notes/x.md"), "DENY");
    const ask = await decide(fresh([entry("r_ask", forbiddenRootPayload("ASK"))]), writeMd("notes/x.md"), "DENY");
    for (const d of [deny, warn, ask]) {
      const body = "reason" in d ? d.reason : "";
      expect(body).not.toContain(ATTESTER_CUID);
    }
  });

  it("omits the date rather than printing garbage when attestedAt is unparseable", async () => {
    const bad = { ...entry("r_deny", forbiddenRootPayload("DENY")), attestedAt: "not-a-date" };
    const d = await decide(fresh([bad]), writeMd("notes/x.md"), "DENY");
    if (d.kind !== "DENY") throw new Error(`expected DENY, got ${d.kind}`);
    expect(d.reason).not.toContain("Invalid Date");
    expect(d.reason).not.toContain("Attested");
    // The rest of the clause still lands: a bad timestamp costs the date, not the authority.
    expect(d.reason).toContain("ceiling DENY");
  });
});

describe("D.2: a compliant path is derived, never guessed", () => {
  it("emits a concrete compliant path for a config with an explicit destination root", async () => {
    const d = await decide(
      fresh([entry("r_vault", noteVaultPayload("WARN"))]),
      writeMd("notes/20260805-thing.md"),
      "DENY",
    );
    if (d.kind !== "WARN") throw new Error(`expected WARN, got ${d.kind}`);
    expect(d.reason).toContain(`Compliant path: ${VAULT}/20260805-thing.md`);
  });

  it("emits NO compliant path for a forbidden-root config, which names no destination", async () => {
    const d = await decide(fresh([entry("r_deny", forbiddenRootPayload("DENY"))]), writeMd("notes/x.md"), "DENY");
    if (d.kind !== "DENY") throw new Error(`expected DENY, got ${d.kind}`);
    expect(d.reason).not.toContain("Compliant path:");
  });
});

describe("D.1/D.2 compactness: the aggregate cap still bounds the advisory", () => {
  it("an aggregate of many warned rules stays capped, with provenance inside each shown reason", async () => {
    const rules = ["a", "b", "c", "d", "e"].map((n) => entry(`r_${n}`, forbiddenRootPayload("WARN")));
    const d = await decide(fresh(rules), writeMd("notes/x.md"), "DENY");
    if (d.kind !== "WARN") throw new Error(`expected WARN, got ${d.kind}`);
    // Every warned rule still reaches the review queue (warnings is uncapped by design)...
    expect(d.warnings).toHaveLength(5);
    // ...while the rendered body stays capped and says so.
    expect(d.reason).toContain("more governed-rule warning(s) on this action");
    // The provenance rides INSIDE each shown reason, so the cap governs it too rather than the
    // clauses accumulating past it.
    expect(d.reason.split("ceiling WARN").length - 1).toBeLessThanOrEqual(3);
  });
});
