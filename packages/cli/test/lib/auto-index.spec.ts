// tools/meetless-agent/test/lib/auto-index.spec.ts
import { selectIndexTargets, buildKbAddArgv } from "../../src/lib/auto-index";
import { ActiveMemoryRecord } from "../../src/lib/active-memory";

function rec(over: Partial<ActiveMemoryRecord>): ActiveMemoryRecord {
  return {
    ts: "t",
    event: "active_memory_record",
    workspaceId: "ws_1",
    ownerUserId: "u",
    repoRootHash: "rrh",
    canonicalPath: "notes/x.md",
    contentHash: "c1",
    sessionId: "s",
    turnIndex: 1,
    sourceProduct: "claude_code",
    kind: "produced_doc",
    createdAt: "2026-06-05T00:00:00Z",
    repoRoot: "/repo",
    ...over,
  };
}

describe("auto-index selection", () => {
  it("selects a produced_doc that carries a repoRoot and joins the abs path", () => {
    const t = selectIndexTargets([rec({})]);
    expect(t).toHaveLength(1);
    expect(t[0].absPath).toBe("/repo/notes/x.md");
    expect(t[0].workspaceId).toBe("ws_1");
    expect(t[0].canonicalPath).toBe("notes/x.md");
    expect(t[0].contentHash).toBe("c1");
  });

  it("excludes tagged_reference records (user-named, not agent-produced)", () => {
    expect(selectIndexTargets([rec({ kind: "tagged_reference" })])).toHaveLength(0);
  });

  it("excludes records without a repoRoot (pre-Phase-A; cannot resolve on disk)", () => {
    expect(selectIndexTargets([rec({ repoRoot: undefined })])).toHaveLength(0);
    expect(selectIndexTargets([rec({ repoRoot: "" })])).toHaveLength(0);
  });

  it("collapses the same canonical path to one target, latest record wins", () => {
    const t = selectIndexTargets([
      rec({ contentHash: "old" }),
      rec({ contentHash: "new" }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].contentHash).toBe("new");
  });

  it("keeps same-named docs in different repos distinct", () => {
    const t = selectIndexTargets([
      rec({ repoRootHash: "A", repoRoot: "/a" }),
      rec({ repoRootHash: "B", repoRoot: "/b" }),
    ]);
    expect(t).toHaveLength(2);
    expect(t.map((x) => x.absPath).sort()).toEqual(["/a/notes/x.md", "/b/notes/x.md"]);
  });

  it("builds the agent_distilled / queued, upsert add argv (born PENDING, no posture)", () => {
    const argv = buildKbAddArgv({
      absPath: "/repo/notes/x.md",
      workspaceId: "ws_1",
      canonicalPath: "notes/x.md",
      contentHash: "c1",
    });
    // --reingest-if-active makes the loop an add-or-UPDATE: a re-edited doc that is
    // already ACTIVE gets reingested in place (new revision) instead of the python
    // worker's hard refusal, which the loop would otherwise swallow as a failure.
    expect(argv).toEqual([
      "/repo/notes/x.md",
      "--mode",
      "file",
      "--provenance",
      "agent_distilled",
      "--workspace",
      "ws_1",
      "--queue",
      "--reingest-if-active",
    ]);
    // Regression guard (e7f20756): `mla kb add` dropped the --posture contract for
    // the two-axis born-PENDING model. The loop MUST NOT emit --posture or every
    // ingest dies on "Unknown flag: --posture" and no session file is mined.
    expect(argv).not.toContain("--posture");
  });

  // S2-c (CLI half): the raw Stop-hook session UUID is canonicalized at this
  // boundary and appended as `--agent-session <uuid>` so the python sink can
  // compose the workspace-authoritative Langfuse session id exactly once. A
  // valid UUID arrives upper-cased and whitespace-padded; the flag value must
  // be the trimmed, lowercased canonical form.
  const TARGET: import("../../src/lib/auto-index").IndexTarget = {
    absPath: "/repo/notes/x.md",
    workspaceId: "ws_1",
    canonicalPath: "notes/x.md",
    contentHash: "c1",
  };
  const VALID_UUID_UPPER = "1B4E28BA-2FA1-11D2-883F-0016D3CCA427";
  const VALID_UUID_LOWER = VALID_UUID_UPPER.toLowerCase();

  it("appends a canonicalized --agent-session when a valid session UUID is given", () => {
    const argv = buildKbAddArgv(TARGET, `  ${VALID_UUID_UPPER}  `);
    expect(argv.slice(-2)).toEqual(["--agent-session", VALID_UUID_LOWER]);
  });

  it("omits --agent-session when the session is null, undefined, or malformed", () => {
    // No flag is the explicit fail-closed default: the ingest still runs, intel
    // falls back to its own grouping. Never push an empty or junk value.
    expect(buildKbAddArgv(TARGET, null)).not.toContain("--agent-session");
    expect(buildKbAddArgv(TARGET, undefined)).not.toContain("--agent-session");
    expect(buildKbAddArgv(TARGET)).not.toContain("--agent-session");
    expect(buildKbAddArgv(TARGET, "not-a-uuid")).not.toContain("--agent-session");
    expect(buildKbAddArgv(TARGET, "")).not.toContain("--agent-session");
  });
});
