import * as os from "os";

import {
  defaultReadBundle,
  parseMaxEnforcement,
  renderConflictWarning,
  renderPreToolUseAsk,
  renderPreToolUseResponse,
  renderPreToolUseWarn,
  runInternalPretoolObserve,
  PRETOOL_PASS_THROUGH,
  type PretoolObserveDeps,
} from "../../../src/commands/internal-pretool-observe";
import * as bundleCacheModule from "../../../src/lib/rules/bundle-cache";
import { type BundleCacheRead } from "../../../src/lib/rules/bundle-cache";
import { HOME } from "../../../src/lib/config";
import { type RuleBundle, type RuleBundleEntry } from "../../../src/lib/rules/control-rule-client";
import { type ActiveConflict } from "../../../src/lib/active-conflict-cache";
import {
  EVALUATOR_CONTRACT_VERSION,
  MATCHER_SCHEMA_VERSION,
  PATH_CANONICALIZER_VERSION,
} from "../../../src/lib/rules/durable-observation";
import { ruleVersionHash } from "../../../src/lib/rules/rule-version-hash";
import { type EvaluationTarget } from "../../../src/lib/rules/evaluation-input-hash";
import { type RulePayloadV1 } from "../../../src/lib/rules/types";
import {
  type EnforcementIncidentCoords,
  type EnforcementIncidentInput,
} from "../../../src/lib/analytics/enforcement-incident";

// `mla _internal pretool-observe` is the transport the managed pre-tool-use.sh hook pipes its raw
// PreToolUse stdin into. The hook decides from the principal-bound backend rule bundle (§6): it emits a
// real deny on the wire when, and only when, a bundle rule matches the call and its lease admits
// enforcement; a stale-degraded or natively-attested ceiling becomes an ASK; everything else (and any
// failure) is the empty pass-through. Two invariants are load-bearing: (1) the decision is NEVER
// reflected from the input, it is computed from the rule evaluation; (2) the hook can never block on
// infrastructure, every failure path is the exit-0 pass-through.

const PILOT_SCOPE = "/work/meetless";
const RUNTIME_ROOT = "/runtime/root";
const FORBIDDEN_ROOT = "notes";

function pilotPayload(over: Partial<RulePayloadV1> = {}): RulePayloadV1 {
  return {
    text: "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
    applicability: { mode: "action", tools: ["Edit", "Write"], matcher: { field: "file_path", glob: "*.md" } },
    compliance: {
      evaluatorContractVersion: EVALUATOR_CONTRACT_VERSION,
      matcherSchemaVersion: MATCHER_SCHEMA_VERSION,
      pathCanonicalizerVersion: PATH_CANONICALIZER_VERSION,
      config: { forbiddenRootRelativePath: FORBIDDEN_ROOT },
    },
    effect: "PROHIBIT",
    strength: "MUST_FOLLOW",
    deliveryChannels: ["preToolUse"],
    enforcementCeiling: "DENY",
    infrastructureFailurePolicy: "PASS_WITH_ALERT",
    runtimeScopeId: PILOT_SCOPE,
    payloadSchemaVersion: "rule-payload-v1",
    canonicalSerializationVersion: "v1",
    ...over,
  };
}

// Echo classifier: the raw file path is the runtime-relative target. Keeps the handler filesystem-free
// and deterministic; the forbidden-root verdict is derived purely from the echoed path.
const classifyRuntime = async (rawFilePath: unknown): Promise<EvaluationTarget> => ({
  kind: "RUNTIME_RELATIVE",
  path: String(rawFilePath),
});

function writeStdin(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "sess_1",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "notes/scratch.md", content: "hi" },
    ...over,
  });
}

const BUNDLE_PRINCIPAL = { workspaceId: "ws_1", principalUserId: "user_an", projectId: null };

function bundleEntry(over: Partial<RuleBundleEntry> = {}): RuleBundleEntry {
  const payload = (over.payload as RulePayloadV1 | undefined) ?? pilotPayload();
  return {
    ruleNodeId: "rn_notes",
    ruleVersionId: "rv_notes_1",
    authorityScope: "WORKSPACE",
    ownerUserId: null,
    projectId: null,
    payload,
    canonicalPayloadHash: ruleVersionHash(payload),
    attestedByUserId: "user_an",
    attestedAt: "2026-06-19T00:00:00.000Z",
    supersedesVersionId: null,
    ...over,
  };
}

function ruleBundle(rules: RuleBundleEntry[], over: Partial<RuleBundle> = {}): RuleBundle {
  return {
    schemaVersion: 1,
    principalUserId: "user_an",
    workspaceId: "ws_1",
    projectId: null,
    bundleRevision: 1,
    generatedAt: "2026-06-19T00:00:00.000Z",
    validUntil: "2026-06-20T00:00:00.000Z",
    rules,
    ...over,
  };
}

function freshRead(rules: RuleBundleEntry[]): BundleCacheRead {
  return { status: "fresh", bundle: ruleBundle(rules), ageMs: 0, droppedForIntegrity: 0, reason: null };
}

function staleRead(rules: RuleBundleEntry[]): BundleCacheRead {
  return {
    status: "stale",
    bundle: ruleBundle(rules),
    ageMs: 99_999_999,
    droppedForIntegrity: 0,
    reason: "bundle lease expired",
  };
}

function unavailableRead(reason = "rule protection unavailable"): BundleCacheRead {
  return { status: "unavailable", bundle: null, ageMs: null, droppedForIntegrity: 0, reason };
}

// Base deps face the bundle path hermetically: a resolvable principal, an empty conflict snapshot, and an
// UNAVAILABLE bundle by default (no rules -> pass-through). Tests inject a fresh/stale read to arm a rule.
function makeDeps(over: Partial<PretoolObserveDeps> = {}): { deps: PretoolObserveDeps; written: () => string } {
  let captured = "";
  const deps: PretoolObserveDeps = {
    readStdin: async () => writeStdin(),
    writeOut: (s) => {
      captured += s;
    },
    resolveScope: () => ({ runtimeScopeId: PILOT_SCOPE, runtimeProjectRoot: RUNTIME_ROOT }),
    classifyRuntime,
    clock: () => ({ now: 1718700000000, createdAt: "2026-06-19T00:00:00.000Z" }),
    resolvePrincipal: () => BUNDLE_PRINCIPAL,
    readBundle: () => unavailableRead(),
    readConflicts: () => [],
    // Default: a no-op deny emitter, so the suite never touches the real analytics spool. Tests that
    // assert the deny-tile emission inject their own spy.
    emitIncident: () => {},
    ...over,
  };
  return { deps, written: () => captured };
}

// A bundle is armed for this read; everything else stays on the hermetic base.
//
// The ceiling is pinned to DENY here, EXPLICITLY. The suites below exercise the deny/ask
// machinery (does a fresh forbidden write deny, does a stale one degrade to ask, is the
// incident stamped), and that machinery only runs at a DENY ceiling. The shipped product
// ships WARN (owner ruling, 2026-07-12), so leaving these on the default would silently
// turn eight enforcement tests into eight advisory tests that assert nothing. What the
// stock ceiling actually does to the same call is pinned separately, below.
function bundleDeps(
  read: BundleCacheRead,
  over: Partial<PretoolObserveDeps> = {},
): { deps: PretoolObserveDeps; written: () => string } {
  return makeDeps({ readBundle: () => read, resolveMaxEnforcement: () => "DENY", ...over });
}

describe("renderPreToolUseResponse: the pure seam-to-wire mapper", () => {
  it("maps a deny seam to the Claude Code PreToolUse deny wire shape, exit 0", () => {
    const out = renderPreToolUseResponse({ permissionDecision: "deny", reason: "blocked: notes/x.md" });
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked: notes/x.md",
      },
    });
  });

  it("maps the empty pass-through seam to {} with no permissionDecision, exit 0", () => {
    const out = renderPreToolUseResponse({});
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toMatch(/permissionDecision/);
    expect(JSON.parse(out.stdout)).toEqual({});
  });

  it("exports the empty pass-through constant", () => {
    expect(PRETOOL_PASS_THROUGH).toEqual({});
  });

  it("maps an ASK reason to the documented interactive ask body, exit 0", () => {
    const out = renderPreToolUseAsk("confirm: notes/x.md");
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe("confirm: notes/x.md");
  });

  it("maps a WARN reason to the non-blocking advisory body (systemMessage + additionalContext, NO permissionDecision, exit 0)", () => {
    const out = renderPreToolUseWarn("Meetless rule rn_x: writing references/scratch.md is discouraged. keep it in the vault.");
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    // A WARN is the middle rung: the tool is PERMITTED, so no permissionDecision is ever rendered (INV-8).
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    // Human-facing heads-up carries the advisory marker + the rule's own words.
    expect(parsed.systemMessage).toContain("advisory");
    expect(parsed.systemMessage).toContain("discouraged");
    // Model-facing context makes the non-blocking nature explicit and steers a correction.
    expect(parsed.hookSpecificOutput.additionalContext).toContain("non-blocking");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("permitted");
  });
});

describe("runInternalPretoolObserve: the decision is computed, never reflected from input", () => {
  it("ignores an attacker-supplied permissionDecision on a non-forbidden path (pass-through)", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      readStdin: async () =>
        writeStdin({
          tool_input: { file_path: "src/app/main.md", content: "y" },
          hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "pwn" },
        }),
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(written()).not.toMatch(/permissionDecision/);
    expect(JSON.parse(written())).toEqual({});
  });

  it("never reflects an attacker reason even when the path does violate the rule", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      readStdin: async () =>
        writeStdin({
          hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "pwn" },
        }),
    });
    await runInternalPretoolObserve([], deps);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).not.toContain("pwn");
  });
});

describe("runInternalPretoolObserve: never blocks on infrastructure (fail open, exit 0)", () => {
  it("passes through malformed stdin without erroring or deciding", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), { readStdin: async () => "{ not json" });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
  });

  it("fails open to pass-through when a dependency throws", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      resolveScope: () => {
        throw new Error("scope resolution blew up");
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
  });

  it("fails open to pass-through when stdin cannot be read", async () => {
    const { deps, written } = makeDeps({
      readStdin: async () => {
        throw new Error("stdin read failed");
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
  });
});

// G8 / D1 §11.3 (CRITICAL-5): after the bundle path passes through, the same hook
// surfaces a SOFT cross-session conflict warning when the session has an open conflict
// in its zero-network snapshot. The warning never denies (the tool is permitted) and a
// real bundle deny always wins over it. The decision function is TOOL-AGNOSTIC: the
// managed matcher pins the hook to Write|Edit, but the warning logic does not branch on
// the tool, so it is asserted against both a mutating (Write) and a read-shaped (Read)
// payload.
function activeConflict(over: Partial<ActiveConflict> = {}): ActiveConflict {
  return {
    caseId: "case_42",
    openedAt: "2026-06-26T00:00:00.000Z",
    reason: "Another session is changing the same decision.",
    ...over,
  };
}

describe("renderConflictWarning: the pure soft-warning body", () => {
  it("renders a systemMessage and additionalContext, and carries NO permissionDecision", () => {
    const out = renderConflictWarning([activeConflict()], "soft");
    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(parsed.systemMessage).toContain("case_42");
    expect(parsed.systemMessage).toContain("/now");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("case_42");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("permitted");
  });

  it("names the gate mode in the agent context and counts the extra open conflicts", () => {
    const out = renderConflictWarning(
      [activeConflict(), activeConflict({ caseId: "case_43" })],
      "hard",
    );
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("gate: hard");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("and 1 more");
    // Even in hard mode this surface only ever warns: no deny is rendered.
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  });
});

describe("runInternalPretoolObserve: the soft cross-session conflict warning", () => {
  it("passes through when the session has no open conflict (empty snapshot)", async () => {
    const { deps, written } = makeDeps({ readConflicts: () => [] });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
  });

  it("warns (tool permitted) when the session has an open conflict, on a Write payload", async () => {
    const { deps, written } = makeDeps({
      // A non-forbidden path so the bundle rule passes through and the warning can layer.
      readStdin: async () => writeStdin({ tool_input: { file_path: "src/app/main.md", content: "y" } }),
      readConflicts: () => [activeConflict()],
      resolveGateMode: () => "soft",
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.systemMessage).toContain("case_42");
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  });

  it("warns identically on a read-shaped payload (the decision function is tool-agnostic)", async () => {
    const { deps, written } = makeDeps({
      readStdin: async () =>
        writeStdin({ tool_name: "Read", tool_input: { file_path: "src/app/main.ts" } }),
      readConflicts: () => [activeConflict()],
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.systemMessage).toContain("case_42");
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  });

  it("a real bundle deny WINS over the conflict warning (deny precedence)", async () => {
    // Forbidden notes path with an armed bundle -> the rule denies. The open conflict must NOT
    // soften that into a warning.
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      readConflicts: () => [activeConflict()],
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed).not.toHaveProperty("systemMessage");
  });

  it("clears the warning the moment the snapshot reports the conflict resolved", async () => {
    const { deps, written } = makeDeps({
      readStdin: async () => writeStdin({ tool_input: { file_path: "src/app/main.md", content: "y" } }),
      // Resolved: the refreshed snapshot is empty.
      readConflicts: () => [],
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
  });

  it("fails open to pass-through when the snapshot read throws", async () => {
    const { deps, written } = makeDeps({
      readStdin: async () => writeStdin({ tool_input: { file_path: "src/app/main.md", content: "y" } }),
      readConflicts: () => {
        throw new Error("snapshot read blew up");
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
  });

  it("passes through when the payload carries no session id (cannot key the snapshot)", async () => {
    const readConflicts = jest.fn(() => [activeConflict()]);
    const { deps, written } = makeDeps({
      readStdin: async () =>
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: { file_path: "src/app/main.md", content: "y" },
        }),
      readConflicts,
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
    // Never even attempts to read a snapshot it cannot key.
    expect(readConflicts).not.toHaveBeenCalled();
  });
});

// The deny tile (notes/20260627-mla-product-health-dashboard-posthog-metrics.md §5.1): exactly one
// enforcement-incident is emitted per fired deny, the path is reduced to a surface enum before it
// leaves the device (INV-POSTHOG-PII-1), and a telemetry fault can NEVER turn the deny into a thrown
// (blocking) hook. The wiring (classify -> build input/coords -> hand to the emitter) is asserted via
// an injected spy; the recorder graph itself is exercised in analytics-enforcement-incident.spec.ts.
describe("runInternalPretoolObserve: the deny tile enforcement-incident emission (§5.1)", () => {
  it("emits exactly one incident on a fired deny, stamping the bundle rule VERSION id and PII-safe facts", async () => {
    const calls: Array<{ input: EnforcementIncidentInput; coords: EnforcementIncidentCoords }> = [];
    const { deps } = bundleDeps(freshRead([bundleEntry()]), {
      emitIncident: (input, coords) => {
        calls.push({ input, coords });
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const { input, coords } = calls[0];
    // A fresh synthetic incident id (a ULID), never empty.
    expect(typeof input.incidentId).toBe("string");
    expect(input.incidentId.length).toBeGreaterThan(0);
    expect(input.decision).toBe("deny");
    expect(input.tool).toBe("Write");
    // The raw path is classified to a PII-safe surface enum for telemetry...
    expect(input.touchedSurface).toBe("docs");
    // ...AND the runtime-relative path itself rides along as the review-queue evidence (Piece 2). It is
    // runtime-relative by construction (a DENY can only fire on a RUNTIME_RELATIVE target), never absolute.
    expect(input.blockedPath).toBe("notes/scratch.md");
    // The deciding rule's bundle VERSION id.
    expect(input.ruleVersionId).toBe("rv_notes_1");
    // ...plus the cutover-stable NODE id and the rule's verbatim statement, snapshotted from the same
    // bundle decision so the review queue resolves the rule name + text without a version-id join.
    expect(input.ruleNodeId).toBe("rn_notes");
    expect(input.ruleText).toBe(
      "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
    );
    expect(coords.sessionId).toBe("sess_1");
    expect(coords.nowMs).toBe(1718700000000);
  });

  it("carries the runtime-relative blocked path as review evidence, but never the raw tool_input shape or file body", async () => {
    const calls: Array<{ input: EnforcementIncidentInput; coords: EnforcementIncidentCoords }> = [];
    const { deps } = bundleDeps(freshRead([bundleEntry()]), {
      emitIncident: (input, coords) => {
        calls.push({ input, coords });
      },
    });
    await runInternalPretoolObserve([], deps);
    expect(calls).toHaveLength(1);
    // The runtime-relative path IS the evidence the review queue needs, so it survives into the emitter
    // (Piece 2). It is relative by construction; an absolute path can never reach a fired deny.
    expect(calls[0].input.blockedPath).toBe("notes/scratch.md");
    // Nothing ELSE from the raw tool_input rides along: not the tool_input key shape, not the file body.
    const serialized = JSON.stringify(calls[0]);
    expect(serialized).not.toContain("file_path");
    expect(serialized).not.toContain('"hi"');
  });

  it("does NOT emit on a pass-through (non-forbidden path, no deny)", async () => {
    const emitIncident = jest.fn();
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      readStdin: async () => writeStdin({ tool_input: { file_path: "src/app/main.md", content: "y" } }),
      emitIncident,
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
    expect(emitIncident).not.toHaveBeenCalled();
  });

  it("does NOT emit when no usable bundle is armed (pass-through)", async () => {
    const emitIncident = jest.fn();
    const { deps } = makeDeps({ emitIncident });
    await runInternalPretoolObserve([], deps);
    expect(emitIncident).not.toHaveBeenCalled();
  });

  it("is fail-soft: a throwing emitter still renders the deny on the wire, exit 0", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      emitIncident: () => {
        throw new Error("telemetry spool down");
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// §6 (P1G / G4): the hook decides from the principal-bound backend bundle. The dispatch is fail-open at
// every seam (a null principal or a throwing bundle read degrades to the advisory pass-through, never a
// block). The three load-bearing bundle states map to three wire shapes: fresh DENY -> hard block; stale
// DENY -> interactive ASK (§6.4); no-usable-bundle -> pass-through (the runtime holds no rules, §6.3).
describe("runInternalPretoolObserve: faces the backend bundle (P1G / G4)", () => {
  it("denies a fresh-bundle forbidden write on the wire, reason naming the rule node + target, exit 0", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]));
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("rn_notes");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("notes/scratch.md");
  });

  it("passes through a fresh-bundle COMPLIANT write (no rule selects it), exit 0", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      readStdin: async () => writeStdin({ tool_input: { file_path: "src/app/main.md", content: "y" } }),
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
  });

  // Owner ruling (An, 2026-07-12): "We will only ship warn and never block." Same fresh
  // bundle, same DENY-attested rule, same violating write as the first test in this block.
  // The ONLY difference is that nobody set MEETLESS_ACTION_INTERCEPT_MAX, which is what a
  // real install looks like. The write must survive.
  it("at the SHIPPED ceiling, the same fresh-bundle forbidden write WARNS and is allowed", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      resolveMaxEnforcement: undefined, // fall through to the real default resolver
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput?.permissionDecision).not.toBe("deny");
    expect(parsed.hookSpecificOutput?.permissionDecision).not.toBe("ask");
    // The agent is still TOLD it broke a governed rule. Warn is not silence.
    const body = written();
    expect(body).toContain("rn_notes");
  });

  it("degrades a STALE-bundle forbidden DENY to an interactive ASK (§6.4), exit 0", async () => {
    const { deps, written } = bundleDeps(staleRead([bundleEntry()]));
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("stale");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("rn_notes");
  });

  it("does NOT emit a deny tile on a degraded ASK (an ASK is not a deny)", async () => {
    const emitIncident = jest.fn();
    const { deps } = bundleDeps(staleRead([bundleEntry()]), { emitIncident });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(emitIncident).not.toHaveBeenCalled();
  });

  it("surfaces a natively-attested ASK ceiling as an ASK even on a FRESH bundle, exit 0", async () => {
    const askPayload = pilotPayload({ enforcementCeiling: "ASK" });
    const { deps, written } = bundleDeps(freshRead([bundleEntry({ payload: askPayload })]));
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("confirm");
  });

  it("passes through when there is no usable bundle (must not claim enforcement, §6.3, acceptance 15)", async () => {
    const { deps, written } = bundleDeps(unavailableRead());
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    // The runtime holds no rules: it grants nothing and decides nothing, never a deny.
    expect(JSON.parse(written())).toEqual({});
  });

  it("passes through with NO bundle read when the principal cannot be resolved (null)", async () => {
    const readBundle = jest.fn();
    const { deps, written } = makeDeps({
      resolvePrincipal: () => null,
      readBundle,
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
    expect(readBundle).not.toHaveBeenCalled();
  });

  it("fails open to pass-through when the bundle read throws", async () => {
    const { deps, written } = makeDeps({
      readBundle: () => {
        throw new Error("bundle cache read blew up");
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written())).toEqual({});
  });

  it("layers the SOFT conflict warning on a bundle pass-through (compliant path + open conflict)", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      readStdin: async () => writeStdin({ tool_input: { file_path: "src/app/main.md", content: "y" } }),
      readConflicts: () => [activeConflict()],
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.systemMessage).toContain("case_42");
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  });
});

// WIRING PROOF (Option A, per-checkout PERSONAL isolation): the enforce-time scope gate lives in
// bundle-enforce, but it is only load-bearing if the CURRENT checkout's runtime scope actually
// threads from resolveScope() -> decideBundleEnforcement({ runtimeScopeId }) -> the gate. A PERSONAL
// rule is minted projectId:null and syncs into every checkout of its owner's workspace; without the
// gate a personal deny attested in checkout A would fire in sibling checkout B. These two drive the
// REAL runInternalPretoolObserve entry (not the pure decider) so the plumbing is what is under test:
// a PERSONAL rule attested at PILOT_SCOPE must deny only when the live checkout IS PILOT_SCOPE.
describe("runInternalPretoolObserve: PERSONAL rules are per-checkout (Option A wiring)", () => {
  const SIBLING_SCOPE = "/work/intel"; // a different checkout of the SAME workspace (projectId:null)
  const personalEntry = () => bundleEntry({ authorityScope: "PERSONAL", ownerUserId: "user_an" });

  it("ENFORCES a PERSONAL deny when the live checkout matches its attested scope (deny)", async () => {
    // resolveScope defaults to PILOT_SCOPE, the same scope pilotPayload stamped. Gate lets it through.
    const { deps, written } = bundleDeps(freshRead([personalEntry()]));
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("rn_notes");
  });

  it("does NOT enforce a PERSONAL deny in a SIBLING checkout of the same workspace (pass-through)", async () => {
    // Same principal, same workspace bundle, same violating write. Only the live checkout differs.
    const { deps, written } = bundleDeps(freshRead([personalEntry()]), {
      resolveScope: () => ({ runtimeScopeId: SIBLING_SCOPE, runtimeProjectRoot: RUNTIME_ROOT }),
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    // The personal deny belongs to PILOT_SCOPE's checkout; here it is invisible, so the write survives.
    expect(JSON.parse(written())).toEqual({});
  });

  it("keeps a WORKSPACE rule enforcing across checkouts (the gate is PERSONAL-only)", async () => {
    // Default bundleEntry() is authorityScope WORKSPACE: a sibling checkout must STILL be denied.
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      resolveScope: () => ({ runtimeScopeId: SIBLING_SCOPE, runtimeProjectRoot: RUNTIME_ROOT }),
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(JSON.parse(written()).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

// INV-8: the non-blocking WARN rung. A VIOLATION whose attested ceiling is WARN (or a DENY clamped to
// WARN by the MEETLESS_ACTION_INTERCEPT_MAX kill switch) surfaces the rule's concern to both the operator
// and the model, but NEVER a permissionDecision, so it can never false-positive-block. It DOES persist an
// enforcement-incident per warned rule (decision:"warn") so the console review queue surfaces WARN
// violations, not only hard DENY blocks; the incident is a WARN, never a deny (input.decision === "warn").
describe("runInternalPretoolObserve: the WARN rung (non-blocking, INV-8)", () => {
  it("surfaces a fresh WARN-ceiling forbidden write as a non-blocking advisory (no permissionDecision), exit 0", async () => {
    const warnPayload = pilotPayload({ enforcementCeiling: "WARN" });
    const { deps, written } = bundleDeps(freshRead([bundleEntry({ payload: warnPayload })]));
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    // The advisory names the deciding rule + the rule's own statement to both audiences.
    expect(parsed.systemMessage).toContain("advisory");
    expect(parsed.systemMessage).toContain("rn_notes");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("non-blocking");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("standalone vault");
  });

  it("emits ONE warn incident (decision:\"warn\", a warning is not a deny) stamping the rule + PII-safe facts", async () => {
    const calls: Array<{ input: EnforcementIncidentInput; coords: EnforcementIncidentCoords }> = [];
    const warnPayload = pilotPayload({ enforcementCeiling: "WARN" });
    const { deps } = bundleDeps(freshRead([bundleEntry({ payload: warnPayload })]), {
      emitIncident: (input, coords) => {
        calls.push({ input, coords });
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    // The bug this fixes: a WARN used to persist NOTHING, so the review queue only ever saw hard DENY
    // blocks. Now the warned rule becomes its own review-queue record.
    expect(calls).toHaveLength(1);
    const { input, coords } = calls[0];
    // It is a WARN, never a deny. This is the spirit of the old "a warning is not a deny" assertion,
    // preserved as a field check instead of "emits nothing".
    expect(input.decision).toBe("warn");
    // A fresh synthetic incident id (a ULID), never empty.
    expect(typeof input.incidentId).toBe("string");
    expect(input.incidentId.length).toBeGreaterThan(0);
    expect(input.tool).toBe("Write");
    // The raw path is reduced to a PII-safe surface enum for telemetry (.md => docs)...
    expect(input.touchedSurface).toBe("docs");
    // ...and the runtime-relative warned path rides along as the review-queue evidence.
    expect(input.blockedPath).toBe("notes/scratch.md");
    // The deciding rule's version + cutover-stable node id + verbatim statement, snapshotted at warn time.
    expect(input.ruleVersionId).toBe("rv_notes_1");
    expect(input.ruleNodeId).toBe("rn_notes");
    expect(input.ruleText).toBe(
      "Notes and design docs MUST go in the standalone vault, never the repo notes directory.",
    );
    expect(coords.sessionId).toBe("sess_1");
    expect(coords.nowMs).toBe(1718700000000);
  });

  it("emits one warn incident PER co-firing warned rule, each with a distinct incident id", async () => {
    const calls: Array<{ input: EnforcementIncidentInput; coords: EnforcementIncidentCoords }> = [];
    const warnPayload = pilotPayload({ enforcementCeiling: "WARN" });
    // Two DISTINCT warned rules select the same violating write (different node ids so both survive the
    // bundle fold). Each must become its own review-queue record; neither may be silently dropped.
    const { deps } = bundleDeps(
      freshRead([
        bundleEntry({ ruleNodeId: "rn_notes", ruleVersionId: "rv_notes_1", payload: warnPayload }),
        bundleEntry({ ruleNodeId: "rn_docs", ruleVersionId: "rv_docs_1", payload: warnPayload }),
      ]),
      {
        emitIncident: (input, coords) => {
          calls.push({ input, coords });
        },
      },
    );
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.input.decision === "warn")).toBe(true);
    // Both warned rules are represented (bundle folds in ruleNodeId order).
    expect(calls.map((c) => c.input.ruleNodeId).sort()).toEqual(["rn_docs", "rn_notes"]);
    // Distinct incident ids: co-firing warns are never dedup-collapsed onto one id.
    const ids = calls.map((c) => c.input.incidentId);
    expect(new Set(ids).size).toBe(2);
  });

  it("is fail-soft: a throwing warn emitter still renders the advisory (never a block), exit 0", async () => {
    const warnPayload = pilotPayload({ enforcementCeiling: "WARN" });
    const { deps, written } = bundleDeps(freshRead([bundleEntry({ payload: warnPayload })]), {
      emitIncident: () => {
        throw new Error("telemetry spool down");
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    // The advisory still lands; a telemetry fault never escalates the non-blocking WARN into a block.
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(parsed.systemMessage).toContain("advisory");
  });

  it("concatenates the governed-rule WARN and an open cross-session conflict into one advisory (both ride additionalContext)", async () => {
    const warnPayload = pilotPayload({ enforcementCeiling: "WARN" });
    const { deps, written } = bundleDeps(freshRead([bundleEntry({ payload: warnPayload })]), {
      readConflicts: () => [activeConflict()],
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    // Both the rule advisory and the conflict warning reach the operator...
    expect(parsed.systemMessage).toContain("advisory");
    expect(parsed.systemMessage).toContain("case_42");
    // ...and the model, in one additionalContext blob.
    expect(parsed.hookSpecificOutput.additionalContext).toContain("non-blocking");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("case_42");
  });

  it("MEETLESS_ACTION_INTERCEPT_MAX=warn clamps a would-be DENY into a non-blocking advisory (kill switch) and emits a WARN incident, not a deny tile", async () => {
    const calls: Array<{ input: EnforcementIncidentInput; coords: EnforcementIncidentCoords }> = [];
    // A DENY-ceiling rule on a forbidden path would normally hard-block; the session cap turns it into a WARN.
    // This is the exact case An hit: the shipped WARN ceiling clamps every DENY, so before this fix the
    // review queue saw nothing at all. The clamped violation must now persist as a WARN incident.
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      resolveMaxEnforcement: () => "WARN",
      emitIncident: (input, coords) => {
        calls.push({ input, coords });
      },
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(parsed.systemMessage).toContain("advisory");
    // Emitted as a WARN (clamped), never a deny.
    expect(calls).toHaveLength(1);
    expect(calls[0].input.decision).toBe("warn");
    expect(calls[0].input.ruleNodeId).toBe("rn_notes");
    expect(calls[0].input.blockedPath).toBe("notes/scratch.md");
  });

  it("MEETLESS_ACTION_INTERCEPT_MAX=ask clamps a would-be DENY into an interactive ASK (not a block)", async () => {
    const { deps, written } = bundleDeps(freshRead([bundleEntry()]), {
      resolveMaxEnforcement: () => "ASK",
    });
    const code = await runInternalPretoolObserve([], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(written());
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
  });
});

describe("parseMaxEnforcement: the MEETLESS_ACTION_INTERCEPT_MAX ceiling parser", () => {
  it("parses the honored rungs case-insensitively", () => {
    expect(parseMaxEnforcement("observe")).toBe("OBSERVE");
    expect(parseMaxEnforcement("warn")).toBe("WARN");
    expect(parseMaxEnforcement("ASK")).toBe("ASK");
    expect(parseMaxEnforcement("  Deny  ")).toBe("DENY");
  });

  // Owner ruling (An, 2026-07-12): "We will only ship warn and never block." The default
  // used to be DENY (uncapped), which meant a stock install could take a user's tool call
  // away from them. WARN is now the shipped ceiling; DENY is an explicit opt-in.
  it("defaults to WARN for unset or empty, so the shipped product never blocks", () => {
    expect(parseMaxEnforcement(undefined)).toBe("WARN");
    expect(parseMaxEnforcement("")).toBe("WARN");
  });

  it("never reads an unrecognized value as an escalation (a typo is not consent to block)", () => {
    expect(parseMaxEnforcement("block")).toBe("WARN");
    expect(parseMaxEnforcement("DENY!!")).toBe("WARN");
    expect(parseMaxEnforcement("true")).toBe("WARN");
  });
});

describe("defaultReadBundle: the IO shell reads the writer's base (regression)", () => {
  // Regression for the DENY that silently degraded to a pass-through: the hook's default bundle reader
  // hardcoded the raw os homedir() (`~/...`) while the steer-sync writer and the scanner read from
  // $MEETLESS_HOME (`HOME`, `~/.meetless`). `readRuleBundleCache` joins `home` + "rules" directly, so the
  // reader looked under `~/rules/...` (never created) and got UNAVAILABLE -> the notes-location DENY
  // passed through. The decision suite above injects `readBundle`, so it could never have caught this;
  // this pins the real IO shell's base to HOME and forbids a regression back to the bare os homedir.
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the $MEETLESS_HOME base (HOME), never the raw os homedir, to readRuleBundleCache", () => {
    const spy = jest
      .spyOn(bundleCacheModule, "readRuleBundleCache")
      .mockReturnValue(unavailableRead());
    defaultReadBundle(BUNDLE_PRINCIPAL, 1_700_000_000_000);
    expect(spy).toHaveBeenCalledTimes(1);
    const [principalArg, optsArg] = spy.mock.calls[0];
    expect(principalArg).toBe(BUNDLE_PRINCIPAL);
    // The exact defect: the read base MUST be the config HOME (which includes the `.meetless` segment the
    // writer uses), and MUST NOT be the bare os homedir the buggy version passed.
    expect(optsArg?.home).toBe(HOME);
    expect(optsArg?.home).not.toBe(os.homedir());
    expect(optsArg?.nowMs).toBe(1_700_000_000_000);
  });
});
