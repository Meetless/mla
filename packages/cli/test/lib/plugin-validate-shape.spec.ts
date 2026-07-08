import { renderPluginManifest } from "../../src/connectors/claude-code/plugin-artifact";

// The single public manifest must carry every field `claude plugin validate --strict`
// requires. Empirically `--strict` warns (and thus fails) on a manifest missing
// `version`, `description`, or `author`, so lock all three here plus the identity
// fields. This unit test guards strict-completeness WITHOUT needing `claude` on PATH;
// the real --strict run is scripts/validate-plugin.mjs (against BOTH the marketplace
// root AND the plugin subdir). `version` is passed in by the caller (the generator
// reads the real semver from meetless-cli/packages/cli/package.json, NOT the
// workspace-root meetless-cli/package.json); use a fixed value here so the assertion
// is deterministic.
describe("plugin manifest strict-completeness (design §8)", () => {
  it("carries every field `--strict` requires (name, version, description, author)", () => {
    const m = JSON.parse(renderPluginManifest("1.4.0"));
    expect(m.name).toBe("mla");
    expect(m.version).toBe("1.4.0");
    expect(typeof m.description).toBe("string");
    expect(m.description.length).toBeGreaterThan(0);
    expect(m.author?.name).toBe("Meetless");
    expect(m.homepage).toBe("https://meetless.ai");
  });

  it("echoes whatever real version the generator passes (no hardcoded string)", () => {
    // A different input version must appear verbatim: the renderer never invents or
    // pins a version, so shipping a new package.json version can never silently render
    // a stale manifest.
    expect(JSON.parse(renderPluginManifest("2.0.1")).version).toBe("2.0.1");
  });
});
