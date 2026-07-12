import { buildMlaSkillBody, buildOnboardSkillBody, buildScoutAgent } from "../../src/lib/wire";

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
  it("doc-scout agent is unchanged", () => {
    expect(buildScoutAgent("documentation")).toMatchSnapshot();
  });
  it("history-scout agent is unchanged", () => {
    expect(buildScoutAgent("history")).toMatchSnapshot();
  });
});
