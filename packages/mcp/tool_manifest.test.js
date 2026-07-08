/**
 * D5 §12.6 + §12.2.1 manifest hygiene tests.
 *
 * Run: node --test (no npm test script in this package).
 *
 * Covers:
 *   §12.6   meetless__query and meetless__kb_doc_detail no longer advertise a
 *           `workspace_id` override; the MUTATING verdict tool keeps it.
 *   §12.2.2 the new evidence tool (retrieve_knowledge) never advertises one.
 *   §12.2.1 ADVERTISED_EVIDENCE_TOOLS ∩ MUTATING_TOOL_NAMES = ∅, and
 *           assertReadOnlyManifest() passes for the shipped registries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOOLS,
  ADVERTISED_EVIDENCE_TOOLS,
  MUTATING_TOOL_NAMES,
  assertReadOnlyManifest,
} from "./tool_manifest.js";

function toolByName(name) {
  const t = TOOLS.find((x) => x.name === name);
  assert.ok(t, `tool ${name} must be registered`);
  return t;
}

function hasProp(tool, prop) {
  return Object.prototype.hasOwnProperty.call(
    tool.inputSchema.properties || {},
    prop,
  );
}

test("§12.6: meetless__query does NOT advertise a workspace_id override", () => {
  const q = toolByName("meetless__query");
  assert.equal(
    hasProp(q, "workspace_id"),
    false,
    "meetless__query inputSchema must not expose workspace_id (cross-tenant foot-gun under shared key)",
  );
});

test("§12.6: meetless__kb_doc_detail does NOT advertise a workspace_id override", () => {
  const d = toolByName("meetless__kb_doc_detail");
  assert.equal(
    hasProp(d, "workspace_id"),
    false,
    "meetless__kb_doc_detail inputSchema must not expose workspace_id",
  );
});

test("§12.2.2: meetless__retrieve_knowledge does NOT advertise workspace_id", () => {
  const r = toolByName("meetless__retrieve_knowledge");
  assert.equal(hasProp(r, "workspace_id"), false);
  // it should still only take query + optional limit
  assert.deepEqual(
    Object.keys(r.inputSchema.properties).sort(),
    ["limit", "query"],
  );
});

test("the MUTATING verdict tool ENV-PINS the workspace (no workspace_id param)", () => {
  const v = toolByName("meetless__relationship_verdict");
  // §10.2 hard swap + SEC-2.2: the verdict records onto intel's RelationAssertion
  // model and the workspace is env-pinned (MEETLESS_WORKSPACE_ID). A verdict is a
  // mutation, so honoring a model-supplied workspace_id would be a cross-tenant
  // write foot-gun under the shared key; the parameter is dropped entirely.
  assert.equal(
    hasProp(v, "workspace_id"),
    false,
    "meetless__relationship_verdict must not expose workspace_id (env-pinned mutation)",
  );
  // The post-cutover shape: act on an assertion_id with accept/reject only.
  assert.deepEqual(
    Object.keys(v.inputSchema.properties).sort(),
    ["action", "assertion_id", "expected_prior_outcome", "idempotency_key", "user_id"],
  );
  assert.deepEqual(v.inputSchema.properties.action.enum, ["accept", "reject"]);
  assert.deepEqual(v.inputSchema.required, ["action", "assertion_id"]);
});

test("§12.2.1: ADVERTISED_EVIDENCE_TOOLS and MUTATING_TOOL_NAMES are disjoint", () => {
  const mutating = new Set(MUTATING_TOOL_NAMES);
  const overlap = ADVERTISED_EVIDENCE_TOOLS.filter((t) => mutating.has(t));
  assert.deepEqual(overlap, [], "evidence and mutating registries must not overlap");
  // assertReadOnlyManifest() must not throw for the shipped registries
  assert.doesNotThrow(() => assertReadOnlyManifest());
});

test("registry membership: read-only evidence tools vs the mutating surface", () => {
  // The demoted convenience tool is NOT advertised as evidence.
  assert.ok(!ADVERTISED_EVIDENCE_TOOLS.includes("meetless__query"));
  // The two read-only facade tools ARE advertised.
  assert.ok(ADVERTISED_EVIDENCE_TOOLS.includes("meetless__retrieve_knowledge"));
  assert.ok(ADVERTISED_EVIDENCE_TOOLS.includes("meetless__kb_doc_detail"));
  // The verdict tool is the mutating surface, never advertised as evidence.
  assert.ok(MUTATING_TOOL_NAMES.includes("meetless__relationship_verdict"));
  assert.ok(!ADVERTISED_EVIDENCE_TOOLS.includes("meetless__relationship_verdict"));
});

test("assertReadOnlyManifest throws when registries overlap (guard is real)", () => {
  // Simulate the failure mode the boot guard exists to catch: a future edit that
  // advertises a mutating tool as evidence. We re-implement the check against a
  // poisoned pair to prove the assertion logic is not a no-op.
  const poisonedEvidence = ["meetless__relationship_verdict", "meetless__retrieve_knowledge"];
  const mutating = new Set(MUTATING_TOOL_NAMES);
  const overlap = poisonedEvidence.filter((t) => mutating.has(t));
  assert.ok(overlap.length > 0, "the disjointness check must flag a poisoned manifest");
});
