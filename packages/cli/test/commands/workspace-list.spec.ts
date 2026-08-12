import { renderWorkspaceList, type MembershipRow } from "../../src/commands/workspace";

// D2 discovery. `mla activate --workspace <id>` needs an id, and before this the
// CLI could not name a single workspace the caller belonged to: `mla workspace`
// shows only the folder-bound one, and `mla whoami` showed the session's home.
// The data already existed on `request.auth.memberships` (the same authority
// list resolveMarkerWorkspace authorizes markers against), so this is a render
// over an existing identity response, not a new source of truth.

const ROWS: MembershipRow[] = [
  { workspaceId: "cmacme000000000000000001", name: "Acme Engineering", role: "OWNER", retiredAt: null },
  { workspaceId: "cmacme000000000000000002", name: "Acme Platform", role: "MEMBER", retiredAt: null },
];

describe("renderWorkspaceList", () => {
  it("lists id, name and role for every membership", () => {
    const out = renderWorkspaceList(ROWS, null);
    expect(out).toContain("cmacme000000000000000001");
    expect(out).toContain("Acme Engineering");
    expect(out).toContain("OWNER");
    expect(out).toContain("cmacme000000000000000002");
    expect(out).toContain("MEMBER");
  });

  it("never presents repoPath as though it were the workspace's repository", () => {
    // Workspace.repoPath is whichever folder happened to provision the workspace.
    // Under D2 a workspace has SEVERAL repos, so rendering that one path as "the"
    // repo is worse than rendering nothing: it is confidently wrong.
    const withRepo = [{ ...ROWS[0], repoPath: "/Users/someone/projects/first-repo-ever" }];
    const out = renderWorkspaceList(withRepo, null);
    expect(out).not.toContain("/Users/someone/projects/first-repo-ever");
  });

  it("marks the workspace this folder is bound to", () => {
    const out = renderWorkspaceList(ROWS, "cmacme000000000000000002");
    const bound = out.split("\n").find((l) => l.includes("cmacme000000000000000002"));
    const other = out.split("\n").find((l) => l.includes("cmacme000000000000000001"));
    expect(bound).toMatch(/this folder/i);
    expect(other).not.toMatch(/this folder/i);
  });

  it("shows how to bind another folder, which is the reason to run it", () => {
    expect(renderWorkspaceList(ROWS, null)).toContain("mla activate --workspace");
  });

  it("says so plainly when the caller belongs to nothing", () => {
    const out = renderWorkspaceList([], null);
    expect(out).toMatch(/not a member of any workspace/i);
    // Both ways out: make one, or be invited to one.
    expect(out).toContain("mla activate");
    expect(out).toContain("mla workspace invite");
  });

  it("demotes a retired workspace rather than hiding or ranking it", () => {
    const out = renderWorkspaceList(
      [...ROWS, { workspaceId: "cmexample0000000000000023", name: "Old", role: "MEMBER", retiredAt: "2026-01-01T00:00:00.000Z" }],
      null,
    );
    const line = out.split("\n").find((l) => l.includes("cmexample0000000000000023"));
    expect(line).toMatch(/deactivated/i);
  });

  it("prints no em dash or double dash (writing-style guard)", () => {
    const out = renderWorkspaceList(ROWS, "cmacme000000000000000001") + renderWorkspaceList([], null);
    expect(out).not.toContain("—");
    expect(out.replace(/--workspace/g, "")).not.toContain("--");
  });
});
