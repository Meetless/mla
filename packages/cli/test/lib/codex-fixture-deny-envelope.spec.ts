import * as fs from "fs";
import * as path from "path";

import {
  ENFORCEMENT_ADJUDICATE_HINT,
  buildOverrideHint,
} from "../../src/commands/internal-pretool-observe";

/**
 * Keep the Codex governed-change demo's `expected-output.md` honest against the
 * LIVE deny envelope.
 *
 * WHY. The fixture is the operator's "what success looks like" reference for a
 * real, on-camera demo whose whole promise is "we do not overclaim; every step
 * mechanically proven". It was last aligned to the code at 1e76bba33 (2026-07-19).
 * 722 commits later, eb450516f (2026-08-05) made the live PreToolUse deny append a
 * one-retry OVERRIDE CTA (`appendEnforcementHint` -> `buildOverrideHint`), and the
 * bundle-enforce cutover added a SOURCE provenance clause
 * (`Attested <date>, ceiling <CEILING>, version <id>.`). The fixture was never
 * updated, so it showed a deny reason the hook no longer produces.
 *
 * These assertions bind the fixture to the REAL operator-facing copy (imported from
 * the seam, not re-typed) so the two cannot drift again silently: change the copy
 * and this fails until the demo reference is updated with it.
 */
const FIXTURE_REL = "examples/codex-governed-change/expected-output.md";

/** Climb from this test file to the meetless-cli root and resolve the fixture, so the
 * lookup does not hard-code a `../` depth that silently breaks if the tree is restructured. */
function resolveFixture(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, FIXTURE_REL);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`fixture ${FIXTURE_REL} not found climbing up from ${__dirname} (did the example move?)`);
}

const FIXTURE = resolveFixture();

describe("codex-governed-change fixture: expected-output.md matches the live deny envelope", () => {
  const doc = (() => {
    if (!fs.existsSync(FIXTURE)) {
      throw new Error(`fixture not found at ${FIXTURE} (did the example move?)`);
    }
    return fs.readFileSync(FIXTURE, "utf8");
  })();

  it("shows the one-retry override CTA that appendEnforcementHint inserts (regression: eb450516f)", () => {
    const [firstLine, , lastLine] = buildOverrideHint("<incident-id>").split("\n");
    expect(doc).toContain(firstLine); // "If this block is wrong for THIS action, authorize one retry:"
    expect(doc).toContain("mla enforcement allow"); // the copyable single-use override command
    expect(doc).toContain(lastLine); // "That permits this exact action once, in this session only. The rule stays in force."
  });

  it("shows the adjudicate hint the live hook appends last", () => {
    expect(doc).toContain(ENFORCEMENT_ADJUDICATE_HINT);
  });

  it("shows the SOURCE provenance clause the live bundle deny carries", () => {
    // buildSourceClause (bundle-enforce.ts): `Attested <YYYY-MM-DD>, ceiling <CEILING>, version <id>.`
    expect(doc).toMatch(/Attested [^\n,]+, ceiling DENY, version /);
  });
});
