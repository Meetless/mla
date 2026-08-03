// A privacy claim is a product surface, and this one drifted from the wire in FIVE
// places at once: TELEMETRY.md's lead, its plane table, its §3 body, the `mla init`
// first-run disclosure, the public docs page, the home page card, and the privacy
// policy itself. The internal audit doc drifted too, and did it in the most telling
// way available: it said "a blocked file path is reduced to a surface enum, never the
// path" on line 301 and "rule_text, rule_node_id, blocked_path ... go to control only"
// on line 313. Twelve lines apart. Nobody noticed, because nothing could notice.
//
// The reason is structural, not sloppiness. `INV-POSTHOG-PII-1` is a real, fail-closed
// key allowlist, and it really does drop those fields. But it guards the PostHog MIRROR,
// which is the SECOND wire. The first wire is the analytics ingest into the user's own
// control, and the deny tile crosses it verbatim (by design: a block whose substance the
// operator cannot see is a block they cannot adjudicate). Every one of those sentences
// was written by someone reading the projector and describing the machine boundary.
//
// So the failure mode has a name: a guarantee proven at one boundary, restated as a
// guarantee about a different one. Code review does not catch it, because the code is
// correct. Only a test that reads the COPY can.
//
// This spec pins the two surfaces that ship: the disclosure line every user reads at
// install, and the doc that ships to the public mirror. It asserts the honest shape in
// both directions, because either half alone is a hole:
//   - the claim must not be BROADER than the wire (no "never paths"), and
//   - the exception must actually be NAMED (silence is how it drifted back last time).
//
// It deliberately does NOT assert exact prose. Rewording is fine; dropping the exception
// or re-widening the promise is not.

import * as fs from "fs";
import * as path from "path";
import { TELEMETRY_DISCLOSURE } from "../../src/commands/init";

// packages/cli/test/lib -> meetless-cli/. Holds in the public mirror too, which is
// exported from meetless-cli/ with TELEMETRY.md at its root.
const TELEMETRY_MD = path.resolve(__dirname, "../../../../TELEMETRY.md");

/** Claims that were true of the PostHog mirror and false of the machine. */
const OVERBROAD_CLAIMS = [
  "never prompts/paths",
  "never your prompts, paths",
  "prompts, paths, argv",
  "never the path itself",
  "ids/counts/rates/enums/hashes only",
];

describe("the shipped privacy copy matches the wire it describes", () => {
  describe("`mla init` first-run disclosure", () => {
    it("does not promise that file paths never leave the machine", () => {
      const lowered = TELEMETRY_DISCLOSURE.toLowerCase();
      for (const claim of OVERBROAD_CLAIMS) {
        expect(lowered).not.toContain(claim.toLowerCase());
      }
    });

    it("names the deny exception and says where it stops", () => {
      const lowered = TELEMETRY_DISCLOSURE.toLowerCase();
      // The three facts a user needs to consent: that a deny carries evidence, that
      // the path is repo-relative (so it does not describe their machine), and that
      // it stops at the control THEY configured.
      expect(lowered).toContain("deny");
      expect(lowered).toContain("repo-relative path");
      expect(lowered).toContain("your control only");
    });

    it("still states the kill switch, which is the only actionable thing in it", () => {
      expect(TELEMETRY_DISCLOSURE).toContain("MEETLESS_TELEMETRY=off");
    });
  });

  describe("TELEMETRY.md (ships to the public mirror)", () => {
    const doc = fs.readFileSync(TELEMETRY_MD, "utf8");
    const lowered = doc.toLowerCase();

    it("does not promise that file paths never leave the machine", () => {
      for (const claim of OVERBROAD_CLAIMS) {
        expect(lowered).not.toContain(claim.toLowerCase());
      }
      // The §3 "what does not leave the machine" enumeration must not list paths.
      // Matching the list item rather than the words lets the doc keep discussing
      // paths elsewhere (it must, to document the exception).
      expect(lowered).not.toMatch(
        /leave the machine:[^.]*\bfile paths\b/,
      );
    });

    it("documents the deny-review exception, by name, with both fields", () => {
      expect(lowered).toContain("rule_text");
      expect(lowered).toContain("blocked_path");
      expect(lowered).toContain("repo-relative");
    });

    it("keeps the two boundaries distinct: to your control vs onward mirror", () => {
      // The distinction IS the finding. If a future edit collapses it back into one
      // sentence, this is the thing that fails.
      expect(lowered).toContain("inv-posthog-pii-1");
      expect(lowered).toMatch(/allowlist/);
      expect(lowered).toMatch(/mirror/);
    });

    it("carries no em dash, because it ships to the public mirror verbatim", () => {
      expect(doc).not.toContain("—");
    });
  });
});
