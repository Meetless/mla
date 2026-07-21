import { doctorJson, ruleBundleDoctorChecks } from "../../src/commands/doctor";
import type { BundleCacheRead } from "../../src/lib/rules/bundle-cache";

describe("doctor governed rule bundle checks", () => {
  it("surfaces an active date-prefixed notes rule and its warning receipts", () => {
    const read: BundleCacheRead = {
      status: "fresh",
      ageMs: 10,
      droppedForIntegrity: 0,
      reason: null,
      bundle: {
        schemaVersion: 1,
        principalUserId: "u_1",
        workspaceId: "ws_1",
        projectId: null,
        bundleRevision: 7,
        generatedAt: "2026-07-21T00:00:00.000Z",
        validUntil: "2026-07-22T00:00:00.000Z",
        rules: [
          {
            ruleNodeId: "rule_notes",
            ruleVersionId: "version_notes",
            authorityScope: "PERSONAL",
            ownerUserId: "u_1",
            projectId: null,
            canonicalPayloadHash: "hash",
            attestedByUserId: "u_1",
            attestedAt: "2026-07-21T00:00:00.000Z",
            supersedesVersionId: null,
            payload: {
              payloadSchemaVersion: "rule-payload-v1",
              canonicalSerializationVersion: "v1",
              text: "Date-prefixed notes belong in the vault.",
              effect: "PROHIBIT",
              strength: "MUST_FOLLOW",
              applicability: {
                mode: "action",
                tools: ["Write"],
                matcher: { field: "file_path", glob: "*.md" },
              },
              runtimeScopeId: "/repo",
              deliveryChannels: ["preToolUse"],
              enforcementCeiling: "WARN",
              infrastructureFailurePolicy: "PASS_WITH_ALERT",
              compliance: {
                evaluatorContractVersion: "date-prefixed-note-vault-evaluator-v1",
                matcherSchemaVersion: "date-prefixed-markdown-action-v1",
                pathCanonicalizerVersion: "note-vault-path-v1",
                config: {
                  allowedRootAbsolutePath: "/vault/notes",
                  filenamePrefixPattern: "^\\d{8}-",
                },
              },
            },
          },
        ],
      },
    };

    const out = doctorJson(ruleBundleDoctorChecks(read));
    expect(out.status).toBe("green");
    expect(out.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rules.notes-vault",
          status: "pass",
          message: expect.stringContaining("WARN via rule rule_notes"),
        }),
      ]),
    );
    expect(out.checks.find((check) => check.id === "rules.notes-vault")?.message).toContain(
      "mla enforcement --json",
    );
  });

  it("makes a stale or integrity-damaged bundle fail doctor", () => {
    const checks = ruleBundleDoctorChecks({
      status: "stale",
      bundle: {
        schemaVersion: 1,
        principalUserId: null,
        workspaceId: "ws_1",
        projectId: null,
        bundleRevision: 2,
        generatedAt: "2026-07-20T00:00:00.000Z",
        validUntil: "2026-07-20T01:00:00.000Z",
        rules: [],
      },
      ageMs: 1000,
      droppedForIntegrity: 1,
      reason: "bundle lease expired",
    });
    expect(doctorJson(checks).status).toBe("red");
  });
});
