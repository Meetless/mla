/**
 * Behavioral tests for the A6 fix: statusFallback warning synthesis.
 *
 * Run: `node --test status_fallback.test.js`
 *
 * Each test pins the EXACT warning output (or its absence) so a regression
 * that brings back the false-positive-on-every-notes-citation behavior
 * fails loudly. Tests parametrize across the 3 axes that drove the bug:
 *   (1) result mix (notes only, ops only, mixed)
 *   (2) wanted statuses (default SHIPPED, explicit UNKNOWN opt-in)
 *   (3) note status (in-set vs out-of-set)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { statusFallback } from "./status_fallback.js";

// ---------- Helpers ---------------------------------------------------------

function note(status = "SHIPPED") {
  return { docType: "note", status };
}

function diff() {
  return { docType: "diff", status: "APPROVED" };
}

function thread() {
  return { docType: "thread" };
}

// ---------- Pure-ops answer (the original false-positive bug) --------------

test("ops-only answer does NOT emit warning (no notes in scope)", () => {
  const { warnings } = statusFallback([diff(), thread()], undefined, 3);
  assert.deepEqual(warnings, []);
});

test("single diff citation does NOT emit warning", () => {
  const { warnings } = statusFallback([diff()], { statuses: ["SHIPPED"] }, 3);
  assert.deepEqual(warnings, []);
});

test("single thread citation does NOT emit warning", () => {
  const { warnings } = statusFallback([thread()], { statuses: ["SHIPPED"] }, 3);
  assert.deepEqual(warnings, []);
});

// ---------- Mixed answer (the bug from the proposal) ----------------------

test("mixed answer with 2 shipped notes + 1 diff does NOT emit warning", () => {
  // Previously: 3 results, allNotes=false, count<3 -> warning. False positive.
  // Now: 2 shipped notes, all in SHIPPED set -> no warning.
  const { warnings } = statusFallback(
    [note("SHIPPED"), note("SHIPPED"), diff()],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

test("mixed answer with 1 shipped note + 1 thread does NOT emit warning", () => {
  const { warnings } = statusFallback(
    [note("SHIPPED"), thread()],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

// ---------- Genuine fallback (the warning's intended purpose) -------------

test("note returned with UNKNOWN status emits the warning", () => {
  const { warnings } = statusFallback(
    [note("UNKNOWN")],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, [
    "fell back to UNKNOWN; only 1 of 3 found in SHIPPED",
  ]);
});

test("note returned with DRAFT status emits the warning", () => {
  const { warnings } = statusFallback(
    [note("DRAFT")],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, [
    "fell back to UNKNOWN; only 1 of 3 found in SHIPPED",
  ]);
});

test("two notes, one SHIPPED + one UNKNOWN, emits the warning", () => {
  const { warnings } = statusFallback(
    [note("SHIPPED"), note("UNKNOWN")],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, [
    "fell back to UNKNOWN; only 2 of 3 found in SHIPPED",
  ]);
});

// ---------- Threshold satisfaction ----------------------------------------

test("three shipped notes does NOT emit warning (threshold met)", () => {
  const { warnings } = statusFallback(
    [note("SHIPPED"), note("SHIPPED"), note("SHIPPED")],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

test("five mixed-status notes meeting threshold does NOT emit warning", () => {
  // Threshold satisfied by note count; we don't re-validate the per-note
  // status fitness past the threshold (the warning is about quantity).
  const { warnings } = statusFallback(
    [note("SHIPPED"), note("UNKNOWN"), note("DRAFT"), note("SHIPPED"), note("SHIPPED")],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

// ---------- Explicit UNKNOWN opt-in ---------------------------------------

test("explicit UNKNOWN in wanted statuses never emits warning", () => {
  const { warnings } = statusFallback(
    [note("UNKNOWN")],
    { statuses: ["SHIPPED", "UNKNOWN"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

test("UNKNOWN-only filter never emits warning", () => {
  const { warnings } = statusFallback(
    [],
    { statuses: ["UNKNOWN"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

// ---------- Defaults + edge cases ----------------------------------------

test("undefined filters: no explicit status target -> no warning (Bug #4)", () => {
  // Was: implicit SHIPPED default fired the warning. That made the warning
  // noise on every plain notes answer. With no caller-supplied statuses
  // there is no target to fall back from.
  const { warnings } = statusFallback([note("DRAFT")], undefined, 3);
  assert.deepEqual(warnings, []);
});

test("empty filters.statuses: no explicit target -> no warning (Bug #4)", () => {
  const { warnings } = statusFallback([note("DRAFT")], { statuses: [] }, 3);
  assert.deepEqual(warnings, []);
});

test("note with no explicit status filter -> no warning even if UNKNOWN (Bug #4)", () => {
  const { warnings } = statusFallback([note("UNKNOWN")], {}, 3);
  assert.deepEqual(warnings, []);
});

test("undefined minResults defaults to 3", () => {
  const { warnings } = statusFallback([note("DRAFT")], { statuses: ["SHIPPED"] }, undefined);
  assert.deepEqual(warnings, [
    "fell back to UNKNOWN; only 1 of 3 found in SHIPPED",
  ]);
});

test("zero minResults coerces to default 3", () => {
  const { warnings } = statusFallback([note("DRAFT")], { statuses: ["SHIPPED"] }, 0);
  assert.deepEqual(warnings, [
    "fell back to UNKNOWN; only 1 of 3 found in SHIPPED",
  ]);
});

test("custom minResults respected in warning text", () => {
  const { warnings } = statusFallback([note("DRAFT")], { statuses: ["SHIPPED"] }, 5);
  assert.deepEqual(warnings, [
    "fell back to UNKNOWN; only 1 of 5 found in SHIPPED",
  ]);
});

test("multiple wanted statuses listed in warning text", () => {
  const { warnings } = statusFallback(
    [note("DRAFT")],
    { statuses: ["SHIPPED", "DEPRECATED"] },
    3,
  );
  assert.deepEqual(warnings, [
    "fell back to UNKNOWN; only 1 of 3 found in SHIPPED,DEPRECATED",
  ]);
});

test("status comparison is case-insensitive on note status", () => {
  const { warnings } = statusFallback(
    [note("shipped")],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

test("status comparison is case-insensitive on wanted statuses", () => {
  const { warnings } = statusFallback(
    [note("SHIPPED")],
    { statuses: ["shipped"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

test("empty results + default filter does NOT emit warning (no notes)", () => {
  const { warnings } = statusFallback([], { statuses: ["SHIPPED"] }, 3);
  assert.deepEqual(warnings, []);
});

test("non-array results coerces to empty + no warning", () => {
  const { warnings } = statusFallback(null, { statuses: ["SHIPPED"] }, 3);
  assert.deepEqual(warnings, []);
});

test("missing docType treated as non-note (no warning)", () => {
  // server.js normalizes docType with || "note", so this case is mostly
  // defensive, but the helper must not crash on raw rows.
  const { warnings } = statusFallback(
    [{ status: "SHIPPED" }],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, []);
});

test("note without status field defaults to UNKNOWN and emits warning", () => {
  const { warnings } = statusFallback(
    [{ docType: "note" }],
    { statuses: ["SHIPPED"] },
    3,
  );
  assert.deepEqual(warnings, [
    "fell back to UNKNOWN; only 1 of 3 found in SHIPPED",
  ]);
});

test("results array passed through unchanged in return value", () => {
  const input = [note("SHIPPED"), diff()];
  const { results } = statusFallback(input, { statuses: ["SHIPPED"] }, 3);
  assert.equal(results, input);
});
