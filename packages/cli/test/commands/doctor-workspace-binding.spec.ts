import { workspaceBindingCheck } from "../../src/commands/doctor";

// `mla doctor` sends the folder's marker workspaceId to control's whoami, and control echoes
// back the workspace it actually resolved for that (token, workspaceId). The load-bearing
// invariant pinned here: the check is GREEN only when the resolved id EQUALS the marker id.
// Reporting "workspace resolves" without that equality is a false-green that hides a real
// misbinding -- the dogfood marker was once silently re-pointed to a workspace no local control
// had, and the old unconditional `ok: true` showed green anyway. The orchestrator `runDoctor`
// is an IO shell, so the comparison is extracted as a pure function and pinned directly.

describe("workspaceBindingCheck: the folder-binding assertion", () => {
  const MARKER = "cmexampledogfoodws0000000";

  it("passes when the resolved workspace id equals the marker id, showing the id (not just the slug)", () => {
    const c = workspaceBindingCheck(MARKER, { workspace: { id: MARKER, slug: "example-workspace-slug" } });
    expect(c.ok).toBe(true);
    expect(c.label).toBe("token valid + workspace resolves");
    // The id must be visible so this line and the "folder activated" line are recognizably the
    // SAME workspace even though their display names differ (marker name "meetless" vs live slug).
    expect(c.detail).toContain(MARKER);
    expect(c.detail).toContain("example-workspace-slug");
  });

  it("shows just the id when the resolved workspace has no slug", () => {
    const c = workspaceBindingCheck(MARKER, { workspace: { id: MARKER } });
    expect(c.ok).toBe(true);
    expect(c.detail).toBe(MARKER);
  });

  it("FAILS (not green) when control resolves a different workspace id than the marker", () => {
    const c = workspaceBindingCheck(MARKER, { workspace: { id: "cmr9nonon00r37o4rspjl9n88", slug: "phantom" } });
    expect(c.ok).toBe(false);
    expect(c.label).toBe("resolved workspace does not match the folder binding");
    expect(c.detail).toContain(MARKER); // what the marker binds
    expect(c.detail).toContain("cmr9nonon00r37o4rspjl9n88"); // what the token actually resolves
  });

  it("FAILS when the backend cannot see the workspace at all (whoami returned no workspace)", () => {
    // control returns `{}` for a workspaceId its DB does not hold (e.g. cli-config aimed at a
    // backend that never minted this folder's workspace). That must fail the gate, not pass.
    for (const empty of [{}, { workspace: undefined }, null, undefined] as const) {
      const c = workspaceBindingCheck(MARKER, empty);
      expect(c.ok).toBe(false);
      expect(c.label).toBe("resolved workspace does not match the folder binding");
      expect(c.detail).toContain("no workspace");
    }
  });
});
