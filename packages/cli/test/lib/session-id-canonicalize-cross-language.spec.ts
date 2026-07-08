// S1-a (TS twin): canonicalizeSessionId must match the shared cross-language
// fixture exactly. The SAME fixture (test/fixtures/session-id-canonicalize-fixtures.json,
// duplicated byte-for-byte into intel/tests/fixtures) drives the Python twin
// (canonicalize_agent_session_id in intel app/observability/langfuse_session.py)
// and the Bash twin (canonicalize_agent_session_id in common.sh, asserted in
// test/hooks/session-id-canonicalize-bash.spec.ts). If any twin drifts from this
// grammar, the same Claude session id canonicalizes to two strings and splits the
// Langfuse Session; this test catches the TS side of that drift.

import * as fs from "fs";
import * as path from "path";

import { canonicalizeSessionId } from "../../src/lib/observability";

interface CanonCase {
  name: string;
  input: string;
  expected: string | null;
}

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "session-id-canonicalize-fixtures.json"),
    "utf8",
  ),
) as { cases: CanonCase[] };

describe("canonicalizeSessionId cross-language fixture (S1-a)", () => {
  it("has fixture rows to assert against", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it("matches the shared fixture for every case (must equal intel + bash twins)", () => {
    for (const c of fixture.cases) {
      expect(canonicalizeSessionId(c.input)).toBe(c.expected);
    }
  });

  // The JSON fixture cannot express an absent value (null in JSON would be a
  // present null), so the None / undefined input arm is asserted per language.
  // Both must fail closed to null (no agent session), never to a console key.
  it("treats null and undefined as no agent session (fails closed)", () => {
    expect(canonicalizeSessionId(null)).toBeNull();
    expect(canonicalizeSessionId(undefined)).toBeNull();
  });
});
