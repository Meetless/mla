/**
 * Behavioral tests for the INDEX.md canonical matcher extracted from
 * server.js into ask-core (proposal 20260529 T5).
 *
 * Run: `node --test match_canonical.test.js`
 *
 * Pins the three match rules (exact topic / alias / substring), the
 * ambiguous-multi-match case, the empty-query guard, and the graceful
 * degrade when INDEX.md is absent (callers fall back to retrieval). The
 * mtime cache is exercised by matching twice against the same file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeMatchCanonical, normalizeTopic } from "./match_canonical.js";

function writeIndex(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-core-index-"));
  const header = "| Topic | Aliases | Canonical Path | Status | Last Reviewed |\n| --- | --- | --- | --- | --- |\n";
  const body = rows
    .map(
      (r) =>
        `| ${r.topic} | ${r.aliases || ""} | ${r.path} | ${r.status} | ${r.reviewed || ""} |`,
    )
    .join("\n");
  fs.writeFileSync(path.join(dir, "INDEX.md"), header + body + "\n", "utf-8");
  return dir;
}

test("normalizeTopic lowercases, trims, and collapses whitespace", () => {
  assert.equal(normalizeTopic("  Privacy   Model  "), "privacy model");
  assert.equal(normalizeTopic(undefined), "");
});

test("Rule 1: exact topic match wins", () => {
  const dir = writeIndex([
    { topic: "Privacy Model", aliases: "acl, permissions", path: "notes/privacy.md", status: "SHIPPED", reviewed: "2026-05-01" },
    { topic: "Flow 1", aliases: "create diff from slack", path: "notes/flow1.md", status: "SHIPPED" },
  ]);
  const matchCanonical = makeMatchCanonical({ notesRoot: dir });
  const res = matchCanonical("privacy model");
  assert.equal(res.reason, "exact topic");
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].path, "notes/privacy.md");
  assert.equal(res.matches[0].status, "SHIPPED");
});

test("Rule 2: alias match when no exact topic", () => {
  const dir = writeIndex([
    { topic: "Privacy Model", aliases: "acl, permissions", path: "notes/privacy.md", status: "SHIPPED" },
  ]);
  const matchCanonical = makeMatchCanonical({ notesRoot: dir });
  const res = matchCanonical("permissions");
  assert.equal(res.reason, "alias");
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].path, "notes/privacy.md");
});

test("Rule 3: substring fallback over topic + aliases", () => {
  const dir = writeIndex([
    { topic: "Decision Diff State Machine", aliases: "", path: "notes/states.md", status: "SHIPPED" },
  ]);
  const matchCanonical = makeMatchCanonical({ notesRoot: dir });
  const res = matchCanonical("state machine");
  assert.equal(res.reason, "substring");
  assert.equal(res.matches.length, 1);
  assert.equal(res.matches[0].path, "notes/states.md");
});

test("ambiguous: multiple exact-topic rows are all returned", () => {
  const dir = writeIndex([
    { topic: "Routing", aliases: "", path: "notes/a.md", status: "SHIPPED" },
    { topic: "Routing", aliases: "", path: "notes/b.md", status: "PROPOSED" },
  ]);
  const matchCanonical = makeMatchCanonical({ notesRoot: dir });
  const res = matchCanonical("routing");
  assert.equal(res.reason, "exact topic");
  assert.equal(res.matches.length, 2);
});

test("empty query short-circuits", () => {
  const dir = writeIndex([{ topic: "X", aliases: "", path: "notes/x.md", status: "SHIPPED" }]);
  const matchCanonical = makeMatchCanonical({ notesRoot: dir });
  const res = matchCanonical("   ");
  assert.equal(res.reason, "empty query");
  assert.equal(res.matches.length, 0);
});

test("missing INDEX.md degrades to empty match set (caller falls back to retrieval)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-core-noindex-"));
  const matchCanonical = makeMatchCanonical({ notesRoot: dir });
  const res = matchCanonical("anything");
  assert.equal(res.matches.length, 0);
  assert.equal(res.reason, "no INDEX.md match");
});

test("repeated calls reuse the mtime cache (no throw, stable result)", () => {
  const dir = writeIndex([{ topic: "Cached", aliases: "", path: "notes/c.md", status: "SHIPPED" }]);
  const matchCanonical = makeMatchCanonical({ notesRoot: dir });
  const a = matchCanonical("cached");
  const b = matchCanonical("cached");
  assert.deepEqual(a, b);
});
