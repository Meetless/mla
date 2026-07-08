import {
  resolveInputAuthority,
  INPUT_AUTHORITY_CONFIG_DOMAIN,
  HOOK_CONFIG_LAYERS,
  type HookConfigLayer,
  type InputAuthorityResolution,
} from "../../../src/lib/rules/input-authority-resolver";

// Phase A.5: the effective-hook-config resolver foundation
// (notes/20260615-rules-as-node-and-action-interception-consolidated-proposal.md
// INV-R1-SINGLE-INPUT-AUTHORITY P0.19, made continuous by P0.58, worked mechanism in §2.4). It is a
// PURE resolver over the Claude Code config hierarchy: given the five settings layers (user, project,
// local, plugin, managed), it enumerates the effective `PreToolUse` hooks, identifies the input-
// mutators for `Write` / `Edit`, and proves the mechanically-provable v1 condition (MLA is the SOLE
// effective matching `PreToolUse` hook) OR returns a typed unavailable reason. It hits no network,
// reads no filesystem (the IO shell that loads the files lives outside this foundation), emits no
// deny, and produces a deterministic canonical snapshot + hash for `inputAuthorityConfigHash`.

const MLA_HOOKS_DIR = "/home/op/.meetless/hooks";
const MLA_CMD = "/home/op/.meetless/hooks/pre-tool-use.sh";

// One Claude Code settings PreToolUse entry: { matcher, hooks: [{ type: "command", command }] }.
function entry(matcher: string, command: string) {
  return { matcher, hooks: [{ type: "command", command }] };
}

// The MLA-managed PreToolUse registration `mla init` writes (matcher "^(Write|Edit)$").
function mlaEntry() {
  return entry("^(Write|Edit)$", MLA_CMD);
}

// A loaded config layer carrying the given PreToolUse entries (absent layers carry none).
function layer(name: (typeof HOOK_CONFIG_LAYERS)[number], ...entries: object[]): HookConfigLayer {
  return { name, settings: { hooks: { PreToolUse: entries } } };
}

// The five layers with MLA's hook in `user` and nothing foreign anywhere: the baseline sole-authority
// configuration. Callers splice a foreign entry into one layer to exercise the failure arms.
function baselineLayers(): HookConfigLayer[] {
  return [
    layer("user", mlaEntry()),
    layer("project"),
    layer("local"),
    layer("plugin"),
    layer("managed"),
  ];
}

function resolve(layers: HookConfigLayer[]): InputAuthorityResolution {
  return resolveInputAuthority(layers, { mlaHooksDir: MLA_HOOKS_DIR });
}

describe("MLA sole authority", () => {
  it("proves sole authority when MLA is the only matching PreToolUse hook", () => {
    const r = resolve(baselineLayers());
    expect(r.kind).toBe("MLA_SOLE_AUTHORITY");
    expect(r.configHash).toMatch(/^[0-9a-f]{64}$/);
    const mla = r.matchedCommands.find((c) => c.command === MLA_CMD);
    expect(mla?.mutatorClass).toBe("MLA");
    expect(mla?.matchesWrite).toBe(true);
    expect(mla?.matchesEdit).toBe(true);
  });

  it("ignores a foreign PreToolUse hook that matches neither Write nor Edit", () => {
    const layers = baselineLayers();
    layers[1] = layer("project", entry("^Bash$", "/usr/local/bin/audit-bash.sh"));
    const r = resolve(layers);
    expect(r.kind).toBe("MLA_SOLE_AUTHORITY");
  });

  it("ignores a foreign hook scoped to MultiEdit/NotebookEdit (the pilot governs Write/Edit only)", () => {
    const layers = baselineLayers();
    layers[1] = layer("project", entry("^(MultiEdit|NotebookEdit)$", "/usr/local/bin/other.sh"));
    expect(resolve(layers).kind).toBe("MLA_SOLE_AUTHORITY");
  });
});

describe("a foreign matching mutator makes deny inadmissible", () => {
  it("flags a foreign hook that matches Write", () => {
    const layers = baselineLayers();
    layers[1] = layer("project", entry("^Write$", "/usr/local/bin/foreign.sh"));
    const r = resolve(layers);
    expect(r.kind).toBe("UNAVAILABLE");
    if (r.kind !== "UNAVAILABLE") throw new Error("unreachable");
    expect(r.reason).toBe("FOREIGN_MUTATOR_PRESENT");
    expect(r.detail).toContain("/usr/local/bin/foreign.sh");
  });

  it("treats a catch-all (empty matcher) foreign hook as a Write/Edit mutator", () => {
    const layers = baselineLayers();
    layers[2] = layer("local", entry("", "/usr/local/bin/catch-all.sh"));
    const r = resolve(layers);
    expect(r.kind).toBe("UNAVAILABLE");
    if (r.kind !== "UNAVAILABLE") throw new Error("unreachable");
    expect(r.reason).toBe("FOREIGN_MUTATOR_PRESENT");
  });

  it("enumerates the managed layer too (a foreign mutator there is still detected)", () => {
    const layers = baselineLayers();
    layers[4] = layer("managed", entry("Edit", "/opt/enterprise/guard.sh"));
    const r = resolve(layers);
    expect(r.kind).toBe("UNAVAILABLE");
    if (r.kind !== "UNAVAILABLE") throw new Error("unreachable");
    expect(r.reason).toBe("FOREIGN_MUTATOR_PRESENT");
  });
});

describe("MLA hook absent", () => {
  it("is unavailable when no MLA matching PreToolUse hook is registered", () => {
    const layers: HookConfigLayer[] = [
      layer("user", entry("^Bash$", "/usr/local/bin/audit-bash.sh")),
      layer("project"),
      layer("local"),
      layer("plugin"),
      layer("managed"),
    ];
    const r = resolve(layers);
    expect(r.kind).toBe("UNAVAILABLE");
    if (r.kind !== "UNAVAILABLE") throw new Error("unreachable");
    expect(r.reason).toBe("MLA_HOOK_ABSENT");
  });
});

describe("fail closed on an incomplete or uninterpretable hierarchy", () => {
  it("an unreadable layer makes authority unavailable even with MLA present and no foreign hook", () => {
    const layers = baselineLayers();
    layers[3] = { name: "plugin", unreadable: true, error: "EACCES: permission denied" };
    const r = resolve(layers);
    expect(r.kind).toBe("UNAVAILABLE");
    if (r.kind !== "UNAVAILABLE") throw new Error("unreachable");
    expect(r.reason).toBe("CONFIG_LAYER_UNREADABLE");
    expect(r.detail).toContain("plugin");
  });

  it("an uninterpretable matcher (invalid regex) fails closed", () => {
    const layers = baselineLayers();
    layers[1] = layer("project", entry("[", "/usr/local/bin/broken.sh"));
    const r = resolve(layers);
    expect(r.kind).toBe("UNAVAILABLE");
    if (r.kind !== "UNAVAILABLE") throw new Error("unreachable");
    expect(r.reason).toBe("HOOK_ENTRY_UNINTERPRETABLE");
  });
});

describe("the canonical snapshot + hash", () => {
  it("uses the domain-separated effective-hook-config-v1 hash", () => {
    expect(INPUT_AUTHORITY_CONFIG_DOMAIN).toBe("effective-hook-config-v1");
  });

  it("is order-independent: the same hooks in a different layer/entry order hash identically", () => {
    const a = resolve(baselineLayers());
    // Same hooks, reversed layer order and an extra (non-matching) Bash entry placed differently.
    const reordered: HookConfigLayer[] = [
      layer("managed"),
      layer("plugin"),
      layer("local"),
      layer("project"),
      layer("user", mlaEntry()),
    ];
    expect(resolve(reordered).configHash).toBe(a.configHash);
  });

  it("changes when a foreign PreToolUse hook is added (detects a config change)", () => {
    const before = resolve(baselineLayers()).configHash;
    const layers = baselineLayers();
    layers[1] = layer("project", mlaEntry().matcher ? entry("^Bash$", "/usr/local/bin/x.sh") : mlaEntry());
    const after = resolve(layers).configHash;
    expect(after).not.toBe(before);
  });
});
