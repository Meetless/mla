import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sessionCaptureCheck } from "../../src/commands/doctor";

// Behavioral lock for `mla doctor`'s session-capture lifecycle row (folder =
// workspace, T3.3, notes/20260604-folder-equals-workspace-binding-design.md).
//
// doctor reports TWO distinct lifecycles:
//   - Workspace binding (the `.meetless.json` marker; activate / deactivate).
//   - Session capture (the `<sid>.off` sentinel in the session gate; mute /
//     unmute). A folder can be activated while THIS session is muted.
//
// sessionCaptureCheck is the pure seam for the second one: given the live
// session id and the session-gate dir, it reports active vs muted. It is always
// informational (a muted session is a valid state, never a doctor failure).

describe("sessionCaptureCheck (mla doctor, T3.3)", () => {
  let tmp: string;
  let gate: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-doctor-sc-"));
    gate = path.join(tmp, "session-gate");
    fs.mkdirSync(gate, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports active when no <sid>.off sentinel exists", () => {
    const c = sessionCaptureCheck("sess-abcdef12-rest", gate);
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
    expect(c.label.toLowerCase()).toContain("active");
    expect(c.label).not.toMatch(/muted/i);
  });

  it("reports MUTED when the <sid>.off sentinel exists and points at `mla unmute`", () => {
    const sid = "sess-abcdef12-rest";
    fs.writeFileSync(path.join(gate, `${sid}.off`), "2026-06-04T00:00:00Z\n");

    const c = sessionCaptureCheck(sid, gate);

    expect(c.label).toMatch(/muted/i);
    expect(c.label).toContain("mla unmute");
    // A muted session is a valid state, not a doctor failure.
    expect(c.ok).toBe(true);
    expect(c.level).toBe("info");
  });

  it("uses only the first 8 chars of the session id in the label", () => {
    const c = sessionCaptureCheck("abcdefgh-the-long-tail", gate);
    expect(c.label).toContain("abcdefgh");
    expect(c.label).not.toContain("the-long-tail");
  });

  it("reports no-live-session (per-session status) when the session id is absent", () => {
    for (const sid of [undefined, "", "   "]) {
      const c = sessionCaptureCheck(sid, gate);
      expect(c.ok).toBe(true);
      expect(c.level).toBe("info");
      expect(c.label.toLowerCase()).toContain("no live");
    }
  });
});
