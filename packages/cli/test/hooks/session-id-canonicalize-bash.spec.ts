// S1-a (Bash twin): canonicalize_agent_session_id in common.sh must match the
// shared cross-language fixture exactly. Same fixture as the TS twin
// (test/lib/session-id-canonicalize-cross-language.spec.ts) and the Python twin
// (intel). The hook hands the canonicalized value to a `curl -H` header, so the
// anchored-match rejection of control chars and newline-injection bytes is a
// security property, not just formatting: this test drives the REAL function in
// common.sh (sourced, not a re-implementation) so any drift splits the Session or
// admits a header-injection byte and fails here.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface CanonCase {
  name: string;
  input: string;
  expected: string | null;
}

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, "..", "fixtures", "session-id-canonicalize-fixtures.json"),
    "utf8",
  ),
) as { cases: CanonCase[] };

const COMMON_SH = join(__dirname, "..", "..", "src", "hooks-template", "common.sh");

// Source the real common.sh (its stdout/stderr suppressed so only the function's
// output reaches our stdout), then echo exactly what the function prints. printf
// '%s' in the function means no trailing newline, so an empty stdout is the
// canonical "no agent session" (expected null) signal.
const SCRIPT = 'source "$COMMON_SH" >/dev/null 2>&1; canonicalize_agent_session_id "$1"';

describe("canonicalize_agent_session_id bash twin cross-language fixture (S1-a)", () => {
  let home: string;

  beforeEach(() => {
    // Isolate MEETLESS_HOME so sourcing common.sh does not touch ~/.meetless.
    home = mkdtempSync(join(tmpdir(), "mla-canon-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function canon(input: string): string {
    return execFileSync("bash", ["-c", SCRIPT, "mla-canon-test", input], {
      encoding: "utf8",
      env: { ...process.env, MEETLESS_HOME: home, MEETLESS_DEBUG: "0", COMMON_SH },
    });
  }

  it("has fixture rows to assert against", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it("matches the shared fixture for every case (must equal TS + python twins)", () => {
    for (const c of fixture.cases) {
      // Empty stdout is the bash representation of expected null.
      expect(canon(c.input)).toBe(c.expected ?? "");
    }
  });
});
