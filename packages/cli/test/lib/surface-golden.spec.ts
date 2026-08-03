import { buildMlaSkillBody, buildOnboardSkillBody, buildScoutAgent } from "../../src/lib/wire";
import { SCOUT_NAMES } from "../../src/lib/enrichment/protocol";

// GOLDEN LOCK. Originally captured from the pre-refactor wire.ts to prove the
// surface.ts extraction (moving these renderers out and parameterizing them by
// SurfaceNaming) reproduced the legacy home-dir surface byte-for-byte. It now
// doubles as a drift tripwire for the operator-facing skill/agent bodies: a live
// dogfood `mla rewire` reinstalls exactly this text, so an UNINTENDED change here
// is a regression. If a snapshot changes, STOP and read the diff. Only run
// `jest -u` when the diff is EXACTLY an intended edit to a renderer (e.g. the
// onboarding auto-chain rule added to renderCliSkill); an unexplained diff means
// fix the renderer, not the snapshot.
describe("legacy surface golden", () => {
  it("cli skill body is unchanged", () => {
    expect(buildMlaSkillBody()).toMatchSnapshot();
  });
  it("onboard skill body is unchanged", () => {
    expect(buildOnboardSkillBody()).toMatchSnapshot();
  });
  // Iterated over SCOUT_NAMES, not listed one it() per role: a hand-listed pair left the
  // reconciliation agent body with no golden at all, so its text could drift silently while
  // `mla rewire` kept installing it. A new role now arrives with an unwritten snapshot,
  // which fails on CI (--ci refuses to write new snapshots) and passes locally only after
  // someone reads the body it captured.
  for (const role of SCOUT_NAMES) {
    it(`${role}-scout agent is unchanged`, () => {
      expect(buildScoutAgent(role)).toMatchSnapshot();
    });
  }
});
