/**
 * Unit tests for meetless__remember (conversational governed capture).
 *
 * These are written BEFORE the implementation (An 2026-09-02): they encode the
 * verified invariants the feature must hold, so a later edit that breaks one
 * fails loudly. Strategy mirrors coordination_actions.test.js: inject a stub
 * intelFetch, record the (path, init) tuples, assert on the WIRE.
 *
 * The invariants that matter (from the verification ledger,
 * notes/20260902-emily-remember-implementation-plan-and-verification.md):
 *   - the tool exposes ONLY `text`; it never accepts actor / owner / scope /
 *     provenance from the model (An correction #10);
 *   - the envelope it builds NEVER carries a SERVER_OWNED field
 *     (scope / ownerUserId / provenance / normalizedContent* / workspaceId-in-envelope),
 *     so the §5.1 boundary cannot reject it and the trust label stays server-derived;
 *   - it is an UPSERT with sourceSystem=agent, producer=human,
 *     captureMethod=authenticated_authoring_surface -> PUBLISHED (recallable);
 *   - externalObjectId is content-addressed, so a retried identical capture is
 *     idempotent (same identity) (An correction: idempotency/retry);
 *   - it persists BEFORE it confirms: the success result is derived from the
 *     route receipt, never fabricated ahead of the write (An correction #8);
 *   - it returns the withdraw handle the forget tool needs.
 *
 * Run: `node --test remember_action.test.js`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { runRemember, buildRememberEnvelope } from "./remember_action.js";
import { TOOLS, ADVERTISED_EVIDENCE_TOOLS, MUTATING_TOOL_NAMES } from "./tool_manifest.js";

const WS = "ws_test";
const OPERATOR = "wu_owner";

// SERVER_OWNED_FIELDS from intel/app/core/connector_envelope.py: a connector that
// asserts any of these is refused. The capture envelope must never carry one.
const SERVER_OWNED_FIELDS = [
  "normalizedContent",
  "normalizedContentHash",
  "contentNormalizationVersion",
  "provenance",
  "scope",
  "ownerUserId",
  "workspaceId",
  "reviewOutcome",
];

function recordingFetch(reply) {
  const calls = [];
  const fetchImpl = async (path, init = {}) => {
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : undefined });
    return typeof reply === "function" ? reply(path, init) : reply;
  };
  return { fetchImpl, calls };
}

const OK_RECEIPT = {
  outcome: "REVISION_CREATED",
  documentId: "doc_123",
  revisionId: "rev_123",
  revisionStatus: "ACTIVE",
  publicationMode: "PUBLISHED",
  bornAccepted: false,
};

test("remember: exposes only text; envelope carries no server-owned field", async () => {
  const { fetchImpl, calls } = recordingFetch(OK_RECEIPT);
  await runRemember(
    { text: "meeting with Kevin Wednesday about the payment release" },
    { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
  );
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.path, "/internal/v1/kb/ingest-governed");
  assert.equal(call.init.method, "POST");
  const env = call.body.envelope;
  assert.ok(env, "body carries an envelope");
  for (const f of SERVER_OWNED_FIELDS) {
    assert.ok(!(f in env), `envelope must not carry server-owned field ${f}`);
  }
});

test("remember: owner (actor) comes from the trusted config, never from args (#10)", async () => {
  const { fetchImpl, calls } = recordingFetch(OK_RECEIPT);
  await runRemember(
    // A model that smuggles actor/ownerUserId/scope in args must not influence the write.
    { text: "attack", actor: "wu_attacker", ownerUserId: "wu_attacker", scope: "workspace" },
    { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
  );
  const body = calls[0].body;
  assert.equal(body.actor, OPERATOR, "actor is the config operator, not the args value");
  assert.ok(!("ownerUserId" in body), "no ownerUserId smuggled to the body");
  assert.ok(!("scope" in body), "no scope smuggled to the body");
  assert.ok(!("scope" in body.envelope), "no scope in the envelope");
});

test("remember: builds an UPSERT agent-produced authenticated-authoring envelope (truthful provenance)", () => {
  const env = buildRememberEnvelope("hello world", { workspaceId: WS });
  assert.equal(env.operation, "UPSERT");
  assert.equal(env.sourceSystem, "agent");
  // producer=agent -> server derives provenance agent_distilled (NOT human_authored):
  // the only evidence here is the agent's tool submission (An review 2026-09-05).
  assert.equal(env.producerActorType, "agent");
  assert.equal(env.captureMethod, "authenticated_authoring_surface");
  // born-ACCEPTED needs producer=human + authenticatedProducerId; both absent, so PENDING.
  assert.equal(env.authenticatedProducerId, null);
  assert.equal(env.sourceOrderingKind, "SERVER_RECEIVE_SEQUENCE");
  assert.equal(env.rawContent, "hello world");
  assert.equal(env.rawContentHash, createHash("sha256").update("hello world", "utf8").digest("hex"));
});

test("remember: externalObjectId is content-addressed (idempotent on identical text)", () => {
  const a = buildRememberEnvelope("same fact", { workspaceId: WS });
  const b = buildRememberEnvelope("same fact", { workspaceId: WS });
  const c = buildRememberEnvelope("different fact", { workspaceId: WS });
  assert.equal(a.externalObjectId, b.externalObjectId, "identical text -> identical identity");
  assert.notEqual(a.externalObjectId, c.externalObjectId, "different text -> different identity");
});

test("remember: identity is per-user (two users, same text -> distinct captures)", () => {
  const an = buildRememberEnvelope("same fact", { workspaceId: WS, actorUserId: "wu_an" });
  const other = buildRememberEnvelope("same fact", { workspaceId: WS, actorUserId: "wu_other" });
  assert.equal(an.sourceTenantId, `memory:${WS}:wu_an`);
  assert.notEqual(an.sourceTenantId, other.sourceTenantId, "different owners -> different identity keyspace");
  // Same content hash, but the full identity (tenant + extObj) differs, so the two
  // are distinct documents and one owner's handle is not derivable from text alone.
  assert.equal(an.externalObjectId, other.externalObjectId);
});

test("remember: rejects empty text", async () => {
  const { fetchImpl } = recordingFetch(OK_RECEIPT);
  await assert.rejects(
    () => runRemember({ text: "   " }, { intelFetch: fetchImpl, defaultWorkspaceId: WS }),
    /text is required/,
  );
});

test("remember: confirmation is derived from the receipt, not fabricated (persist-before-confirm)", async () => {
  // If the route reports a non-served / non-active outcome, retrievalReady must be false.
  const { fetchImpl } = recordingFetch({ ...OK_RECEIPT, revisionStatus: "INGESTING", publicationMode: "DERIVED_ONLY" });
  const res = await runRemember(
    { text: "x" },
    { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
  );
  assert.equal(res.retrievalReady, false);
  // And a route error must propagate, never a fake "saved".
  const failing = async () => {
    const e = new Error("intel 503");
    e.status = 503;
    throw e;
  };
  await assert.rejects(
    () => runRemember({ text: "y" }, { intelFetch: failing, defaultWorkspaceId: WS }),
    /503/,
  );
});

test("remember: a DEDUPLICATED (re-capture of a withdrawn identity) is NEVER reported recall-ready", async () => {
  // Live-verified 2026-09-05: remember(A)->forget(A)->remember(A) returns
  // outcome=DEDUPLICATED and the doc stays TOMBSTONED. The tool must not claim it
  // is retrievable, and must say plainly it was not re-saved.
  const { fetchImpl } = recordingFetch({
    outcome: "DEDUPLICATED",
    documentId: "doc_dup",
    revisionId: null,
    revisionStatus: null,
    publicationMode: null,
    deduplicated: true,
  });
  const res = await runRemember({ text: "prior text" }, { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR });
  assert.equal(res.retrievalReady, false, "a deduped/withdrawn identity is never recall-ready");
  assert.equal(res.captured, false, "nothing new was captured");
  assert.equal(res.outcome, "DEDUPLICATED");
  assert.match(res.note, /remains withdrawn; it was not restored/i, "the note explains the no-op honestly, without a hash-manipulation workaround");
});

test("remember: returns a withdraw handle matching the envelope identity", async () => {
  const { fetchImpl } = recordingFetch(OK_RECEIPT);
  const res = await runRemember(
    { text: "handle test" },
    { intelFetch: fetchImpl, defaultWorkspaceId: WS, operatorUserId: OPERATOR },
  );
  const env = buildRememberEnvelope("handle test", { workspaceId: WS, actorUserId: OPERATOR });
  assert.equal(res.scope, "person");
  assert.equal(res.captureId, "doc_123");
  assert.deepEqual(res.withdraw, {
    sourceSystem: env.sourceSystem,
    sourceTenantId: env.sourceTenantId,
    externalObjectId: env.externalObjectId,
  });
});

test("manifest: meetless__remember is advertised, mutating, and disjoint from evidence tools", () => {
  assert.ok(MUTATING_TOOL_NAMES.includes("meetless__remember"));
  assert.ok(!ADVERTISED_EVIDENCE_TOOLS.includes("meetless__remember"));
  const tool = TOOLS.find((t) => t.name === "meetless__remember");
  assert.ok(tool, "TOOLS advertises meetless__remember");
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true);
  // The model-facing surface is text-only: no actor/scope/provenance knob.
  const props = tool.inputSchema.properties || {};
  assert.deepEqual(Object.keys(props), ["text"]);
});
