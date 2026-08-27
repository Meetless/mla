/**
 * `mla workspace parent` (E1.4). Pure-unit: every dependency is injected, so
 * these run offline and assert the DECISIONS, not the plumbing.
 *
 * The behaviour worth pinning is the resolution ORDER on the activate path and
 * the fact that a failed attach never fails an activation, because both are
 * places where a convenience feature could quietly break setup.
 */
import { renderChain, runWorkspaceParent, type ChainEntry } from "../../src/commands/workspace_parent";

function chain(...entries: Array<Partial<ChainEntry>>): ChainEntry[] {
  return entries.map((e, i) => ({
    workspaceId: e.workspaceId ?? `ws-${i}`,
    distance: e.distance ?? i,
    name: e.name ?? null,
    slug: e.slug ?? null,
  }));
}

describe("renderChain", () => {
  it("says plainly that there is no parent, and how to add one", () => {
    const out = renderChain(chain({ workspaceId: "ws-leaf", name: "My Repo" }));
    expect(out).toContain("Parent context: none");
    expect(out).toContain("mla workspace parent set");
    // Never claims inheritance that does not exist.
    expect(out).not.toContain("ancestors");
  });

  it("renders the chain nearest-first and names the sibling exclusion", () => {
    const out = renderChain(
      chain(
        { workspaceId: "ws-repo", name: "Acme API", distance: 0 },
        { workspaceId: "ws-acme", name: "Acme AI", distance: 1 },
        { workspaceId: "ws-studio", name: "Martell Ventures", distance: 2 },
      ),
    );
    expect(out.indexOf("Acme API")).toBeLessThan(out.indexOf("Acme AI"));
    expect(out.indexOf("Acme AI")).toBeLessThan(out.indexOf("Martell Ventures"));
    expect(out).toContain("(this workspace)");
    // The guarantee a studio operator actually asks about.
    expect(out).toContain("Sibling workspaces are never included");
  });

  it("falls back to the id when a workspace has no name", () => {
    const out = renderChain(
      chain(
        { workspaceId: "ws-a", name: null, distance: 0 },
        { workspaceId: "ws-b", name: null, distance: 1 },
      ),
    );
    expect(out).toContain("ws-b");
  });
});

describe("mla workspace parent set", () => {
  const cfg = { workspaceId: "ws-child" } as never;

  it("posts the attach and reports that nothing was copied", async () => {
    const posted: Array<{ path: string; body: unknown }> = [];
    const lines: string[] = [];
    const code = await runWorkspaceParent(["set", "ws-parent"], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      loadConfig: () => cfg,
      http: {
        post: (async (_c: unknown, path: string, body: unknown) => {
          posted.push({ path, body });
          return {};
        }) as never,
      },
    });
    expect(code).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toEqual({
      workspaceId: "ws-child",
      parentWorkspaceId: "ws-parent",
    });
    // The copy question is the first one every operator asks; answer it here.
    expect(lines.join("\n")).toContain("Nothing was copied");
  });

  it("refuses a self-parent locally, without a round trip", async () => {
    let called = false;
    const code = await runWorkspaceParent(["set", "ws-child"], {
      out: () => undefined,
      err: () => undefined,
      loadConfig: () => cfg,
      http: {
        post: (async () => {
          called = true;
          return {};
        }) as never,
      },
    });
    expect(code).toBe(2);
    expect(called).toBe(false);
  });

  it("needs an id", async () => {
    const errs: string[] = [];
    const code = await runWorkspaceParent(["set"], {
      out: () => undefined,
      err: (l) => errs.push(l),
      loadConfig: () => cfg,
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("needs a workspace id");
  });
});

describe("mla workspace parent unset", () => {
  const cfg = { workspaceId: "ws-child" } as never;

  it("reports the detach and reassures that nothing was lost", async () => {
    const lines: string[] = [];
    const code = await runWorkspaceParent(["unset"], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      loadConfig: () => cfg,
      http: { del: (async () => ({ detachedFrom: "ws-parent" })) as never },
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("ws-parent");
    expect(lines.join("\n")).toContain("keeps everything it owns");
  });

  it("is a no-op, not an error, when there was no parent", async () => {
    const lines: string[] = [];
    const code = await runWorkspaceParent(["unset"], {
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
      loadConfig: () => cfg,
      http: { del: (async () => ({ detachedFrom: null })) as never },
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nothing changed");
  });
});

describe("mla workspace parent default", () => {
  it("stores the remembered default", async () => {
    let written: Record<string, unknown> | null = null;
    const code = await runWorkspaceParent(["default", "ws-root"], {
      out: () => undefined,
      err: () => undefined,
      cfgExists: () => true,
      readCfg: (() => ({ controlUrl: "x" })) as never,
      writeCfg: ((c: Record<string, unknown>) => {
        written = c;
      }) as never,
    });
    expect(code).toBe(0);
    expect(written).toMatchObject({ defaultParentWorkspaceId: "ws-root" });
  });

  it("--clear removes it", async () => {
    let written: Record<string, unknown> | null = null;
    const code = await runWorkspaceParent(["default", "--clear"], {
      out: () => undefined,
      err: () => undefined,
      cfgExists: () => true,
      readCfg: (() => ({ controlUrl: "x", defaultParentWorkspaceId: "ws-root" })) as never,
      writeCfg: ((c: Record<string, unknown>) => {
        written = c;
      }) as never,
    });
    expect(code).toBe(0);
    expect(written).not.toHaveProperty("defaultParentWorkspaceId");
  });

  it("with no argument reports the current value rather than clearing it", async () => {
    let wrote = false;
    const lines: string[] = [];
    const code = await runWorkspaceParent(["default"], {
      out: (l) => lines.push(l),
      err: () => undefined,
      cfgExists: () => true,
      readCfg: (() => ({ controlUrl: "x", defaultParentWorkspaceId: "ws-root" })) as never,
      writeCfg: (() => {
        wrote = true;
      }) as never,
    });
    expect(code).toBe(0);
    expect(wrote).toBe(false);
    expect(lines.join("\n")).toContain("ws-root");
  });
});
