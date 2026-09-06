// The conversational governed-capture tools (`meetless__remember`,
// `meetless__forget`) were DEAD through the packaged `mla mcp` in 0.2.41.
//
// remember POSTs `intel /internal/v1/kb/ingest-governed`, which had NO egress
// rule at all (`no egress rule`); forget POSTs `intel /internal/v1/kb/withdraw`,
// whose rule allowlisted only the `relPath` handle, not the source-tuple handle
// (`sourceSystem`/`sourceTenantId`/`externalObjectId`) the tool actually sends,
// so it was refused `unknown_field`. The action-function tests import the tool
// and hit intel directly (no egress boundary), so nothing caught it; it was
// found by driving the INSTALLED mla mcp server on 2026-09-05.
//
// This spec drives the real bodies through the real policy so a future edit that
// drops either route, or a body field the tools send, fails in CI instead of at
// the user's MCP session.

import { applyEgressPolicy } from "../../src/lib/egress/policy";
import { EGRESS_RULES } from "../../src/lib/egress/rules";

const INTEL = "intel" as const;
const send = (path: string, body: unknown) =>
  applyEgressPolicy(EGRESS_RULES, INTEL, "POST", `https://intel.example.test${path}`, body);

// The top-level body `remember_action.js` sends (workspaceId + envelope [+ actor
// on the shared-key plane]); the capture text rides in envelope.rawContent.
const REMEMBER_BODY = {
  workspaceId: "ws1",
  actor: "wu_owner",
  envelope: {
    operation: "UPSERT",
    sourceSystem: "agent",
    sourceTenantId: "memory:ws1:wu_owner",
    externalObjectId: "mem-abc",
    producerActorType: "agent",
    captureMethod: "authenticated_authoring_surface",
    sourceOrderingKind: "SERVER_RECEIVE_SEQUENCE",
    rawContent: "meeting with Kevin Wednesday about the payment release",
    rawContentHash: "a".repeat(64),
  },
};

// The top-level body `forget_action.js` sends: the source-tuple handle + reason
// (+ actor on the shared-key plane).
const FORGET_BODY = {
  workspaceId: "ws1",
  actor: "wu_owner",
  sourceSystem: "agent",
  sourceTenantId: "memory:ws1:wu_owner",
  externalObjectId: "mem-abc",
  reason: "deleted",
};

describe("egress allowlist covers the remember/forget tools", () => {
  test("remember: kb/ingest-governed passes the egress policy", () => {
    expect(() => send("/internal/v1/kb/ingest-governed", REMEMBER_BODY)).not.toThrow();
  });

  test("forget: kb/withdraw passes with the source-tuple handle", () => {
    expect(() => send("/internal/v1/kb/withdraw", FORGET_BODY)).not.toThrow();
  });

  test("the allowlist is real: an unknown top-level field is still refused", () => {
    expect(() => send("/internal/v1/kb/ingest-governed", { ...REMEMBER_BODY, smuggled: "x" })).toThrow(
      /unknown_field/,
    );
  });
});
