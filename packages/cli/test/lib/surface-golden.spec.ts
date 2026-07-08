import { buildMlaSkillBody, buildOnboardSkillBody, buildScoutAgent } from "../../src/lib/wire";

// GOLDEN LOCK. Captured from the pre-refactor wire.ts, then frozen. The
// surface.ts extraction (moving these renderers out and parameterizing them by
// SurfaceNaming) must reproduce the legacy home-dir surface byte-for-byte, so a
// live dogfood `mla rewire` sees zero drift. If any of these snapshots changes,
// the refactor altered legacy output: STOP, do not run jest -u, fix the renderer.
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
