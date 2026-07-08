import { runKbMove, MOVE_BLOCKED_MESSAGE } from "../../src/commands/kb_move";

// Behavioral lock for `mla kb move` after the slice-A cutover.
//
// Move is a BLOCKED capability: a governed document's identity is its source
// tuple (sourceSystem, sourceTenantId, externalObjectId), so re-pathing a note
// yields a different document, and slice A ships no redirect/alias primitive to
// carry identity across the re-path. The command must refuse FAST: exit 2, no
// config load, no owner check, no subprocess spawn. This test locks that the
// refusal happens regardless of argv and explains the governed rationale plus
// the add+forget workaround.

describe("runKbMove (blocked in slice A)", () => {
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("exits 2 and prints the block rationale regardless of argv", async () => {
    for (const argv of [
      [],
      ["notes/a.md", "notes/b.md"],
      ["kbdoc:abc", "notes/b.md", "--workspace", "ws_1"],
      ["--allow-file-missing"],
    ]) {
      errSpy.mockClear();
      const code = await runKbMove(argv);
      expect(code).toBe(2);
      expect(errSpy).toHaveBeenCalledWith(MOVE_BLOCKED_MESSAGE);
    }
  });

  it("explains the governed identity rationale and the add+forget workaround", () => {
    expect(MOVE_BLOCKED_MESSAGE).toMatch(/blocked in the governed model/i);
    expect(MOVE_BLOCKED_MESSAGE).toMatch(/source tuple/i);
    expect(MOVE_BLOCKED_MESSAGE).toMatch(/redirect \/ alias primitive/i);
    expect(MOVE_BLOCKED_MESSAGE).toMatch(/mla kb add/);
    expect(MOVE_BLOCKED_MESSAGE).toMatch(/mla kb forget/);
  });

  it("does not resurrect the legacy move machinery in its rationale", () => {
    // parentUuid / path_aliases / KB_MOVED were the legacy rename concepts; the
    // governed block message must not imply any of them still work.
    expect(MOVE_BLOCKED_MESSAGE).not.toMatch(/path_aliases/);
    expect(MOVE_BLOCKED_MESSAGE).not.toMatch(/parentUuid|parent_uuid/);
    expect(MOVE_BLOCKED_MESSAGE).not.toMatch(/KB_MOVED/);
  });
});
