import * as path from "path";

import {
  ENFORCEMENT_GATE_REASON_CODES,
  isEnforcementGateReasonCode,
  projectEligibleEnforcement,
  resolveAttestedPathRoot,
  admitEnforcement,
  planDenyAccounting,
} from "../../../src/lib/rules/deny-admission";
import { type InputAuthorityResolution } from "../../../src/lib/rules/input-authority-resolver";

// Slice 9 (Phase B.9): the PURE deny-admission decision machinery for the R1 notes pilot.
// notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md §10.2 (R1-3,
// R1-5) and the eligible/effective enforcement computation (lines ~1205-1222). This slice builds
// the decision functions only; it records nothing and emits no deny (that is slice 10). The
// constraints proven here:
//   - eligibility is projected through `result` ONLY (VIOLATION rises to the attested ceiling,
//     everything else, including UNKNOWN, stays OBSERVE), so the no-machine-deny and
//     UNKNOWN-never-denies properties live at the eligibility step, not a post-hoc gate;
//   - the only thing between an attested DENY ceiling and an effective deny is the P0.12 gates;
//     for the pilot the reachable gate is RULE_ENFORCEMENT_UNAVAILABLE (P0.58 input authority,
//     P0.63 attested immutable path root), lowering effective to NONE (fail open, decision 5);
//   - the gate reason enum is a CLOSED set, validated in the application layer (the column is
//     bare TEXT), recording a single primary code;
//   - honest deny-emission accounting (P0.60) plans a DENY as DECISION_RECORDED before emission.

const SOLE_AUTHORITY: InputAuthorityResolution = {
  kind: "MLA_SOLE_AUTHORITY",
  configHash: "cfg_hash",
  snapshot: "{}",
  matchedCommands: [],
};

const UNAVAILABLE: InputAuthorityResolution = {
  kind: "UNAVAILABLE",
  reason: "MLA_HOOK_ABSENT",
  detail: "no MLA PreToolUse hook matches Write or Edit",
  configHash: "cfg_hash",
  snapshot: "{}",
  matchedCommands: [],
};

describe("projectEligibleEnforcement (R1-3, eligibility projected through result only)", () => {
  test("projects a VIOLATION onto the attested enforcement ceiling", () => {
    expect(projectEligibleEnforcement("VIOLATION", "DENY")).toBe("DENY");
  });

  test("projects a COMPLIANT result down to OBSERVE regardless of the ceiling", () => {
    expect(projectEligibleEnforcement("COMPLIANT", "DENY")).toBe("OBSERVE");
  });

  test("projects an UNKNOWN result down to OBSERVE so UNKNOWN can never reach a deny", () => {
    expect(projectEligibleEnforcement("UNKNOWN", "DENY")).toBe("OBSERVE");
  });
});

describe("EnforcementGateReasonCode closed set", () => {
  test("is the closed five-member set in primary-gate precedence order", () => {
    expect(ENFORCEMENT_GATE_REASON_CODES).toEqual([
      "RULE_ENFORCEMENT_UNAVAILABLE",
      "NOT_LIVE_CAPS_AT_OBSERVE",
      "UNKNOWN_EVALUATION_NEVER_DENIES",
      "WORKSPACE_POLICY_FORBIDS_DENY",
      "UNRESOLVED_CONFLICT_NEVER_DENIES",
    ]);
  });

  test("accepts every closed member", () => {
    for (const code of ENFORCEMENT_GATE_REASON_CODES) {
      expect(isEnforcementGateReasonCode(code)).toBe(true);
    }
  });

  test("rejects the dropped machine-deny gate and any foreign code", () => {
    expect(isEnforcementGateReasonCode("MACHINE_INFERRED_CAPS_AT_OBSERVE")).toBe(false);
    expect(isEnforcementGateReasonCode("")).toBe(false);
    expect(isEnforcementGateReasonCode("DENY")).toBe(false);
    expect(isEnforcementGateReasonCode(null)).toBe(false);
  });
});

describe("resolveAttestedPathRoot (P0.63, immutable attested root joined to the active scope)", () => {
  test("admits the attested immutable root joined to the active runtime project root", () => {
    const got = resolveAttestedPathRoot({
      configuredRelativeForbiddenPath: "meetless/notes",
      activeRuntimeProjectRoot: "/Users/op/projects/meetless",
    });
    expect(got).toEqual({
      admitted: true,
      forbiddenRoot: path.join("/Users/op/projects/meetless", "meetless/notes"),
    });
  });

  test("refuses admission when the attested immutable root content is missing", () => {
    expect(
      resolveAttestedPathRoot({
        configuredRelativeForbiddenPath: "",
        activeRuntimeProjectRoot: "/Users/op/projects/meetless",
      }),
    ).toEqual({ admitted: false, reason: "ATTESTED_ROOT_CONTENT_MISSING" });
  });

  test("refuses admission when the active runtime project root is unresolved", () => {
    expect(
      resolveAttestedPathRoot({
        configuredRelativeForbiddenPath: "meetless/notes",
        activeRuntimeProjectRoot: "",
      }),
    ).toEqual({ admitted: false, reason: "ACTIVE_RUNTIME_ROOT_UNRESOLVED" });
  });
});

describe("admitEnforcement (R1-5, gated decision not strength; single primary gate code)", () => {
  const admittedRoot = { admitted: true as const, forbiddenRoot: "/repo/meetless/notes" };
  const refusedRoot = { admitted: false as const, reason: "ATTESTED_ROOT_CONTENT_MISSING" as const };

  test("passes an OBSERVE eligibility through untouched with no gate reason", () => {
    expect(
      admitEnforcement({
        eligibleEnforcement: "OBSERVE",
        inputAuthority: SOLE_AUTHORITY,
        pathRoot: admittedRoot,
      }),
    ).toEqual({ effectiveEnforcement: "OBSERVE", gateReasonCode: null });
  });

  test("admits a DENY when input authority is sole and the path root is admitted", () => {
    expect(
      admitEnforcement({
        eligibleEnforcement: "DENY",
        inputAuthority: SOLE_AUTHORITY,
        pathRoot: admittedRoot,
      }),
    ).toEqual({ effectiveEnforcement: "DENY", gateReasonCode: null });
  });

  test("lowers a DENY to NONE when MLA is not the sole input authority (P0.58)", () => {
    expect(
      admitEnforcement({
        eligibleEnforcement: "DENY",
        inputAuthority: UNAVAILABLE,
        pathRoot: admittedRoot,
      }),
    ).toEqual({ effectiveEnforcement: "NONE", gateReasonCode: "RULE_ENFORCEMENT_UNAVAILABLE" });
  });

  test("lowers a DENY to NONE when the attested path root is not admissible (P0.63)", () => {
    expect(
      admitEnforcement({
        eligibleEnforcement: "DENY",
        inputAuthority: SOLE_AUTHORITY,
        pathRoot: refusedRoot,
      }),
    ).toEqual({ effectiveEnforcement: "NONE", gateReasonCode: "RULE_ENFORCEMENT_UNAVAILABLE" });
  });

  test("records a single RULE_ENFORCEMENT_UNAVAILABLE when both admission checks fail", () => {
    expect(
      admitEnforcement({
        eligibleEnforcement: "DENY",
        inputAuthority: UNAVAILABLE,
        pathRoot: refusedRoot,
      }),
    ).toEqual({ effectiveEnforcement: "NONE", gateReasonCode: "RULE_ENFORCEMENT_UNAVAILABLE" });
  });
});

describe("planDenyAccounting (P0.60, durable DECISION_RECORDED before emission)", () => {
  test("plans a durable deny as DENY + DECISION_RECORDED before any emission", () => {
    expect(planDenyAccounting("DENY")).toEqual({
      aggregateDecision: "DENY",
      denyEmissionStatus: "DECISION_RECORDED",
    });
  });

  test("plans an effective OBSERVE as NO_DECISION + NOT_APPLICABLE", () => {
    expect(planDenyAccounting("OBSERVE")).toEqual({
      aggregateDecision: "NO_DECISION",
      denyEmissionStatus: "NOT_APPLICABLE",
    });
  });

  test("plans an effective NONE (failed-open infra) as NO_DECISION + NOT_APPLICABLE", () => {
    expect(planDenyAccounting("NONE")).toEqual({
      aggregateDecision: "NO_DECISION",
      denyEmissionStatus: "NOT_APPLICABLE",
    });
  });
});
