import {
  PLUGIN_DESCRIPTION,
  PLUGIN_HOMEPAGE,
  renderHookManifest,
  renderPluginManifest,
  renderMarketplaceCatalog,
  renderResolverScript,
} from "../../src/connectors/claude-code/plugin-artifact";
import {
  MANAGED_HOOK_SCRIPTS,
  MCP_SERVER_KEY,
  POST_TOOL_USE_MATCHER,
} from "../../src/connectors/claude-code/hook-contract";

describe("renderHookManifest", () => {
  const parsed = () => JSON.parse(renderHookManifest());

  it("registers every managed hook under its event, in source order", () => {
    const hooks = parsed().hooks as Record<string, any[]>;

    // Event keys appear in first-encounter order over MANAGED_HOOK_SCRIPTS (this is
    // what "source order" means for the grouping). A count-only check would pass even
    // if the events were reshuffled, so pin the exact key sequence.
    const expectedEvents: string[] = [];
    for (const w of MANAGED_HOOK_SCRIPTS) {
      if (!expectedEvents.includes(w.event)) expectedEvents.push(w.event);
    }
    expect(Object.keys(hooks)).toEqual(expectedEvents);

    // Within each event, the rendered commands are that event's scripts in
    // MANAGED_HOOK_SCRIPTS source order, each as a plugin-rooted command exactly once.
    // This is where the ce0-*.sh entries riding shared events must land AFTER their
    // load-bearing sibling; a filter/length check would miss a swap.
    for (const event of expectedEvents) {
      const expectedCommands = MANAGED_HOOK_SCRIPTS.filter((w) => w.event === event).map(
        (w) => `"\${CLAUDE_PLUGIN_ROOT}"/hooks/${w.script}`,
      );
      const actualCommands = hooks[event].map((e: any) => e.hooks[0].command);
      expect(actualCommands).toEqual(expectedCommands);
    }
  });

  it("mirrors the settings.json matcher default (empty-string catch-all)", () => {
    const hooks = parsed().hooks as Record<string, any[]>;
    const sessionStart = hooks.SessionStart.find((e) =>
      e.hooks[0].command.endsWith("/hooks/session-start.sh"),
    );
    expect(sessionStart.matcher).toBe("");
    const postTool = hooks.PostToolUse.find((e) =>
      e.hooks[0].command.endsWith("/hooks/post-tool-use.sh"),
    );
    // post-tool-use.sh (the load-bearing capture hook) rides POST_TOOL_USE_MATCHER
    // (the catch-all ""), NOT CE0_POST_TOOL_USE_MATCHER ("mcp__meetless__"), which
    // belongs to the separate ce0-post-tool-use.sh entry. Asserting against the
    // real constant (rather than hardcoding "") keeps this drift-proof.
    expect(postTool.matcher).toBe(POST_TOOL_USE_MATCHER);
  });

  it("carries the timeout only where MANAGED_HOOK_SCRIPTS sets one", () => {
    const hooks = parsed().hooks as Record<string, any[]>;
    const ups = hooks.UserPromptSubmit.find((e) =>
      e.hooks[0].command.endsWith("/hooks/user-prompt-submit.sh"),
    );
    expect(ups.hooks[0].timeout).toBe(30);
    const stop = hooks.Stop.find((e) => e.hooks[0].command.endsWith("/hooks/stop.sh"));
    expect(stop.hooks[0].timeout).toBeUndefined();
  });

  it("ends with exactly one trailing newline", () => {
    const out = renderHookManifest();
    expect(out.endsWith("}\n")).toBe(true);
    expect(out.endsWith("}\n\n")).toBe(false);
  });
});

describe("renderPluginManifest", () => {
  // Global Constraints §8: ONE plugin, ONE manifest. The generator passes the real
  // semver read from meetless-cli/packages/cli/package.json (the @meetless/mla release
  // package, NOT the workspace-root meetless-cli/package.json). author carries only
  // {name}; the product URL lives in the top-level `homepage` (its documented field),
  // so both are --strict-clean.
  it("carries name + the given version + description + author{name} + homepage + hooks + mcpServers", () => {
    const m = JSON.parse(renderPluginManifest("0.4.2"));
    expect(m.name).toBe("mla");
    expect(m.version).toBe("0.4.2");
    expect(m.description).toBe(PLUGIN_DESCRIPTION);
    expect(m.author).toEqual({ name: "Meetless" });
    expect(m.homepage).toBe(PLUGIN_HOMEPAGE);
    expect(m.hooks).toBe("./hooks/hooks.json");
    expect(m.mcpServers[MCP_SERVER_KEY]).toEqual({
      command: "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla",
      args: ["mcp"],
    });
  });

  it("does NOT nest a url under author (url belongs in top-level homepage)", () => {
    const m = JSON.parse(renderPluginManifest("0.4.2"));
    expect(m.author.url).toBeUndefined();
  });

  it("throws on an empty version (the manifest is never version-less)", () => {
    expect(() => renderPluginManifest("")).toThrow(/version/i);
  });
});

describe("renderMarketplaceCatalog", () => {
  it("names the catalog meetless, carries a top-level description + owner{name}, lists the mla plugin at ./plugin", () => {
    const c = JSON.parse(renderMarketplaceCatalog());
    expect(c.name).toBe("meetless");
    // A marketplace root MUST carry a top-level description or `claude plugin
    // validate --strict` fails on the missing-description warning (Task 0 facts).
    expect(typeof c.description).toBe("string");
    expect(c.description.length).toBeGreaterThan(0);
    // owner accepts ONLY {name,email}; a url here would trip --strict (Task 0 facts).
    expect(c.owner).toEqual({ name: "Meetless" });
    expect(c.owner.url).toBeUndefined();
    expect(c.plugins).toHaveLength(1);
    expect(c.plugins[0].name).toBe("mla");
    expect(c.plugins[0].source).toBe("./plugin");
  });
});

describe("renderResolverScript", () => {
  const s = renderResolverScript();
  it("is a POSIX sh script honoring the §5 candidate order", () => {
    expect(s.startsWith("#!/bin/sh\n")).toBe(true);
    const iEnv = s.indexOf("MEETLESS_MLA_PATH");
    const iMeetlessBin = s.indexOf(".meetless/bin/mla");
    const iBrew = s.indexOf("/opt/homebrew/bin/mla");
    const iUsrLocal = s.indexOf("/usr/local/bin/mla");
    const iLinuxbrew = s.indexOf("/home/linuxbrew/.linuxbrew/bin/mla");
    expect(iEnv).toBeGreaterThan(-1);
    expect(iEnv).toBeLessThan(iMeetlessBin);
    expect(iMeetlessBin).toBeLessThan(iBrew);
    expect(iBrew).toBeLessThan(iUsrLocal);
    expect(iUsrLocal).toBeLessThan(iLinuxbrew);
  });
  it("skips itself and falls back to mla on PATH", () => {
    // Assert the FUNCTIONAL shell tokens, not bare "exec"/"mla" substrings that also
    // live in the header comments (which would make this pass even if the guards were
    // deleted). The behavioral proof (an actual run under a stripped PATH) is Task 4;
    // here we pin that the self-skip guards and the PATH-fallback exec are rendered.
    expect(s).toContain("command -v mla"); // last-resort PATH probe
    expect(s).toContain('[ "$cand" = "$self" ] && continue'); // candidate-loop self-skip
    expect(s).toContain('[ "$onpath" != "$self" ]'); // PATH-fallback self-skip guard
    expect(s).toContain('exec "$onpath" "$@"'); // actually execs the PATH-found mla
  });
  it("ends with a nonzero exit when nothing is found", () => {
    expect(s).toContain("exit 127");
  });
});
