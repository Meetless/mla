import {
  PLUGIN_SURFACE,
  LEGACY_SURFACE,
  renderCliSkill,
  renderOnboardSkill,
  renderScoutAgent,
} from "../../src/connectors/claude-code/surface";
import { SCOUT_NAMES } from "../../src/lib/enrichment/protocol";

function frontmatterField(body: string, field: string): string | undefined {
  const m = body.match(new RegExp(`^${field}: (.*)$`, "m"));
  return m ? m[1].trim() : undefined;
}

// The plugin resolver token that every EXECUTABLE `mla` is rendered as under
// PLUGIN_SURFACE (PLUGIN_SURFACE.mlaCommand).
const RESOLVER = '"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla"';

// Reverse every naming substitution the plugin surface applies (the executable-mla
// resolver token and the scoped scout dispatch names), deriving each mapping from the
// surface objects themselves so this never hardcodes a value under test. surface.ts's
// contract is that the ONLY difference between the two rendered surfaces is naming, so
// a plugin body with its naming reversed must reconstruct the legacy body exactly.
//
// What this PROVES: no drift between the surfaces beyond the naming axes, i.e. every
// TEMPLATED executable `mla` renders as the resolver and every scout dispatch renders
// scoped, with no prose `mla` (the description, `/mla <sub>`, `mla init`/`mla rewire`,
// `mla-onboard`, "run each `mla` command") disturbed. A line-start regex is vacuous
// here (commands are inline backtick spans, never at line start) and a bare-code-span
// regex would false-flag that legitimate prose, so the differential is the right tool.
//
// What this does NOT prove: that a FUTURE executable added as a hardcoded literal
// `mla` (instead of routed through naming.mlaCommand) is absent. A hardcoded literal
// renders identically in BOTH surfaces, so it is invisible to any render-level
// differential and to the legacy golden snapshot alike. That discipline lives at the
// source (always interpolate naming.mlaCommand for an executable) and in code review,
// not in this test.
function pluginToLegacy(pluginBody: string): string {
  let out = pluginBody.split(PLUGIN_SURFACE.mlaCommand).join(LEGACY_SURFACE.mlaCommand);
  for (const role of SCOUT_NAMES) {
    out = out.split(PLUGIN_SURFACE.scoutDispatch[role]).join(LEGACY_SURFACE.scoutDispatch[role]);
  }
  return out;
}

describe("PLUGIN_SURFACE (design §3.3 scoped dispatch)", () => {
  it("onboard skill dispatches the SCOPED mla:* subagent names", () => {
    const body = renderOnboardSkill(PLUGIN_SURFACE);
    expect(body).toContain("mla:doc-scout");
    expect(body).toContain("mla:history-scout");
  });

  it("onboard skill does NOT dispatch the bare legacy scout names", () => {
    const body = renderOnboardSkill(PLUGIN_SURFACE);
    expect(body).not.toContain("meetless-doc-scout");
    expect(body).not.toContain("meetless-history-scout");
  });

  it("legacy onboard skill still dispatches the bare names", () => {
    const body = renderOnboardSkill(LEGACY_SURFACE);
    expect(body).toContain("meetless-doc-scout");
    expect(body).toContain("meetless-history-scout");
  });

  it("plugin scout agent frontmatter uses the bare plugin basename", () => {
    expect(frontmatterField(renderScoutAgent("documentation", PLUGIN_SURFACE), "name")).toBe(
      "doc-scout",
    );
    expect(frontmatterField(renderScoutAgent("history", PLUGIN_SURFACE), "name")).toBe(
      "history-scout",
    );
  });

  it("covers every scout role", () => {
    expect(Object.keys(PLUGIN_SURFACE.scoutDispatch).sort()).toEqual([...SCOUT_NAMES].sort());
    expect(Object.keys(PLUGIN_SURFACE.scoutAgentName).sort()).toEqual([...SCOUT_NAMES].sort());
  });
});

describe("Blocker 1: executable mla routes through the resolver under PLUGIN_SURFACE", () => {
  // The two surfaces are the SAME renderer differing on ONE axis: naming. Templated
  // executable `mla` spots are substituted with naming.mlaCommand; prose mentions of
  // `mla` are hardcoded identically in both surfaces. Reversing the plugin surface's
  // naming substitutions must therefore reconstruct the legacy body exactly: this
  // proves the bodies differ ONLY by naming (templated executables became the resolver,
  // dispatch became scoped), with no prose `mla` disturbed. See pluginToLegacy above
  // for the one case this cannot catch: an executable hardcoded as a literal `mla`.
  it("plugin CLI skill is the legacy CLI skill with executable mla routed through the resolver", () => {
    const plugin = renderCliSkill(PLUGIN_SURFACE);
    expect(plugin).toContain(RESOLVER); // resolver actually present: the reversal is not a no-op
    expect(pluginToLegacy(plugin)).toBe(renderCliSkill(LEGACY_SURFACE));
  });

  it("plugin onboard skill is the legacy onboard skill with executable mla routed through the resolver", () => {
    const plugin = renderOnboardSkill(PLUGIN_SURFACE);
    expect(plugin).toContain(RESOLVER); // resolver actually present: the reversal is not a no-op
    expect(pluginToLegacy(plugin)).toBe(renderOnboardSkill(LEGACY_SURFACE));
  });

  it("legacy skills keep the bare `mla` command (no resolver leakage)", () => {
    expect(renderCliSkill(LEGACY_SURFACE)).not.toContain("resolve-mla");
    expect(renderOnboardSkill(LEGACY_SURFACE)).not.toContain("resolve-mla");
  });
});
