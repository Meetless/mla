import * as fs from "fs";
import * as path from "path";
import {
  classifyPluginList,
  detectPluginOwnership,
  PLUGIN_QUALIFIED_ID,
} from "../../src/connectors/claude-code/plugin-detect";

const FIXTURE = path.join(__dirname, "..", "fixtures", "plugin-list.observed.json");

describe("classifyPluginList (design §6.1 exact-identity, 4-state)", () => {
  it("owns a user-scope, enabled mla@meetless plugin", () => {
    const r = classifyPluginList([
      { id: "mla@meetless", version: "unknown", scope: "user", enabled: true },
    ]);
    expect(r).toEqual({
      status: "owned",
      scope: "user",
      version: "unknown",
      installPath: undefined,
    });
  });

  it("owns a managed-scope, enabled mla@meetless plugin and reports its version", () => {
    const r = classifyPluginList([
      { id: "mla@meetless", version: "0.4.2", scope: "managed", enabled: true, installPath: "/x" },
    ]);
    expect(r).toEqual({ status: "owned", scope: "managed", version: "0.4.2", installPath: "/x" });
  });

  it("classifies a project-scope mla@meetless plugin as non-global, NOT owned", () => {
    const r = classifyPluginList([
      { id: "mla@meetless", version: "0.4.2", scope: "project", enabled: true },
    ]);
    expect(r).toEqual({ status: "non-global", scope: "project", version: "0.4.2" });
  });

  it("classifies a local-scope mla@meetless plugin as non-global too", () => {
    const r = classifyPluginList([
      { id: "mla@meetless", version: "0.4.2", scope: "local", enabled: true },
    ]);
    expect(r).toEqual({ status: "non-global", scope: "local", version: "0.4.2" });
  });

  it("is unknown (never non-global) for an enabled but UNRECOGNIZED scope", () => {
    // Only user/managed => owned and project/local => non-global are interpretable.
    // Any other enabled scope string is a shape we do not understand -> unknown,
    // never a silent non-global (design §6.1 / An high-pri #4).
    expect(
      classifyPluginList([{ id: "mla@meetless", scope: "sandbox", enabled: true }]).status,
    ).toBe("unknown");
  });

  it("is unknown (never absent) for a missing scope", () => {
    expect(classifyPluginList([{ id: "mla@meetless", enabled: true }]).status).toBe("unknown");
  });

  it("is unknown (never absent) for a BLANK scope string", () => {
    // Distinct fail-safe half from "missing scope": a present-but-empty scope trips
    // the `e.scope.length === 0` disjunct of the shape guard, not the typeof check.
    // Both must degrade to unknown so a malformed-but-ours row never reads as absent.
    expect(
      classifyPluginList([{ id: "mla@meetless", scope: "", enabled: true }]).status,
    ).toBe("unknown");
  });

  it("is unknown (never absent) for a non-boolean enabled", () => {
    expect(
      classifyPluginList([{ id: "mla@meetless", scope: "user", enabled: "yes" as any }]).status,
    ).toBe("unknown");
  });

  it("is absent for a disabled mla@meetless plugin (ours, but not active)", () => {
    expect(
      classifyPluginList([{ id: "mla@meetless", scope: "user", enabled: false }]).status,
    ).toBe("absent");
  });

  it("does NOT own a foreign marketplace: mla@other is absent", () => {
    expect(
      classifyPluginList([{ id: "mla@other", scope: "user", enabled: true }]).status,
    ).toBe("absent");
  });

  it("does NOT prefix-match: mla@meetless-staging is absent", () => {
    expect(
      classifyPluginList([{ id: "mla@meetless-staging", scope: "user", enabled: true }]).status,
    ).toBe("absent");
  });

  it("is absent for an unrelated plugin", () => {
    expect(
      classifyPluginList([{ id: "other@x", scope: "user", enabled: true }]).status,
    ).toBe("absent");
  });

  it("is absent for an empty list", () => {
    expect(classifyPluginList([]).status).toBe("absent");
  });

  it("prefers an owned (global) row over a co-present project row, order-independent", () => {
    const r = classifyPluginList([
      { id: "mla@meetless", scope: "project", enabled: true, version: "0.4.2" },
      { id: "mla@meetless", scope: "user", enabled: true, version: "0.4.2" },
    ]);
    expect(r.status).toBe("owned");
  });

  it("exposes the exact-identity key", () => {
    expect(PLUGIN_QUALIFIED_ID).toBe("mla@meetless");
  });

  it("classifies the committed Phase-0 observed fixture as absent (it has no mla@meetless row)", () => {
    // The observed capture is REAL redacted output from a machine that dogfoods via
    // the mla binary, so the plugin is genuinely not installed. With no mla@meetless
    // row, classification is `absent`. (The owned/non-global/unknown branches are the
    // synthetic inline cases above, never this fixture.)
    const entries = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    expect(classifyPluginList(entries).status).toBe("absent");
  });

  it("the observed fixture parses to well-formed rows (real wire shape)", () => {
    const entries = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    expect(Array.isArray(entries)).toBe(true);
    // Whatever real rows exist must carry the field set we classify on. (An empty
    // capture is allowed; then this loop is vacuous and only the parse is proven.)
    for (const e of entries) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.scope).toBe("string");
      expect(typeof e.enabled).toBe("boolean");
    }
  });
});

describe("detectPluginOwnership (fail-safe IO)", () => {
  it("returns unknown when the runner throws (claude missing)", () => {
    const r = detectPluginOwnership({
      run: () => {
        throw new Error("spawn claude ENOENT");
      },
    });
    expect(r.status).toBe("unknown");
  });

  it("returns unknown on nonzero exit", () => {
    const r = detectPluginOwnership({ run: () => 1 });
    expect(r.status).toBe("unknown");
  });

  it("returns unknown on unparseable JSON", () => {
    const r = detectPluginOwnership({
      run: (_bin, tmp) => {
        fs.writeFileSync(tmp, "not json");
        return 0;
      },
    });
    expect(r.status).toBe("unknown");
  });

  it("classifies a well-formed list written to the temp file", () => {
    const r = detectPluginOwnership({
      run: (_bin, tmp) => {
        fs.writeFileSync(
          tmp,
          JSON.stringify([{ id: "mla@meetless", version: "unknown", scope: "user", enabled: true }]),
        );
        return 0;
      },
    });
    expect(r.status).toBe("owned");
  });
});
