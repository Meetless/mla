import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { removeMeetlessHooks } from "../../src/lib/unwire";
import { HOOKS_DIR } from "../../src/lib/config";

function tmpSettings(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-rmhooks-"));
  const p = path.join(dir, "settings.json");
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return p;
}
const managed = (script: string) => path.join(HOOKS_DIR, script);

describe("removeMeetlessHooks", () => {
  it("removes exactly the four managed entries and deletes emptied event keys", () => {
    const p = tmpSettings({
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: managed("session-start.sh") }] }],
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: managed("user-prompt-submit.sh"), timeout: 30 }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: managed("stop.sh") }] }],
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: managed("post-tool-use.sh") }] }],
      },
    });
    const res = removeMeetlessHooks(p);
    expect(res.changed).toBe(true);
    expect(res.removed.sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(res.backupPath).not.toBeNull();
    const after = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(after.hooks).toBeUndefined(); // whole hooks object emptied -> dropped
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it("leaves an operator's own SessionStart hook untouched", () => {
    const p = tmpSettings({
      hooks: {
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/my-own.sh" }] },
          { matcher: "", hooks: [{ type: "command", command: managed("session-start.sh") }] },
        ],
      },
    });
    const res = removeMeetlessHooks(p);
    expect(res.changed).toBe(true);
    const after = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(after.hooks.SessionStart).toHaveLength(1);
    expect(after.hooks.SessionStart[0].hooks[0].command).toBe("/usr/local/bin/my-own.sh");
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it("does not touch a multi-hook entry an operator merged our command into", () => {
    const p = tmpSettings({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: managed("stop.sh") },
              { type: "command", command: "/usr/local/bin/also-mine.sh" },
            ],
          },
        ],
      },
    });
    const res = removeMeetlessHooks(p);
    expect(res.changed).toBe(false);
    const after = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(after.hooks.Stop[0].hooks).toHaveLength(2);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it("is a no-op (no change, no backup) on a settings file with no meetless hooks", () => {
    const p = tmpSettings({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/x/other.sh" }] }] } });
    const res = removeMeetlessHooks(p);
    expect(res.changed).toBe(false);
    expect(res.backupPath).toBeNull();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });

  it("is a safe no-op when the file is missing or unparseable", () => {
    expect(removeMeetlessHooks("/no/such/settings.json").changed).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-rmhooks-bad-"));
    const p = path.join(dir, "settings.json");
    fs.writeFileSync(p, "{not json", "utf8");
    expect(removeMeetlessHooks(p).changed).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
