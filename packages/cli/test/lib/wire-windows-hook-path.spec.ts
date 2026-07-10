import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ensureClaudeSettings,
  hookCommandPath,
  isManagedHookCommand,
} from "../../src/lib/wire";

// Windows double-strip bug (production, Windows/Git Bash, 2026-07-10;
// notes/20260710-windows-hook-wiring-and-portable-lock-fix.md). The hook
// `command` was written as a native path from `path.join(HOOKS_DIR, script)`.
// On Windows that is `C:\Users\pham\.meetless\hooks\post-tool-use.sh`. Claude
// Code runs every hook `command` through the shell (Git Bash on Windows), which
// treats each `\` as an escape, collapsing the path to
// `C:Usersphamn.meetlesshookspost-tool-use.sh` -> ENOENT. Every hook died with
// `bash: ...: No such file or directory`. Fix: emit a forward-slash,
// double-quoted command; keep the matcher separator- and quote-agnostic so a
// legacy backslash entry is recognized as ours and healed on the next wire.
//
// These assertions are platform-independent: they run on POSIX CI yet pin the
// exact behavior that was broken on Windows.

const POSTTOOL = "post-tool-use.sh";

describe("wire: Windows hook command paths run through the shell", () => {
  it("emits a double-quoted, forward-slash command with no backslashes", () => {
    const cmd = hookCommandPath(POSTTOOL);
    expect(cmd.startsWith('"')).toBe(true);
    expect(cmd.endsWith('"')).toBe(true);
    expect(cmd).not.toContain("\\");
    // The inner path ends at the script and lives under .meetless/hooks.
    expect(cmd).toMatch(/\/\.meetless\/hooks\/post-tool-use\.sh"$/);
  });

  it("recognizes a legacy Windows backslash entry as ours (heals, not duplicates)", () => {
    // What the old binary wrote into settings.json on Windows.
    const legacyWin = "C:\\Users\\pham\\.meetless\\hooks\\post-tool-use.sh";
    const canonical = hookCommandPath(POSTTOOL);
    expect(isManagedHookCommand(legacyWin, POSTTOOL, canonical)).toBe(true);
  });

  it("recognizes a legacy POSIX unquoted entry as ours", () => {
    const legacyPosix = "/home/ci/.meetless/hooks/post-tool-use.sh";
    const canonical = hookCommandPath(POSTTOOL);
    expect(isManagedHookCommand(legacyPosix, POSTTOOL, canonical)).toBe(true);
  });

  it("does not claim an operator hook outside a meetless home", () => {
    const operator = "/Users/someone/.config/hooks/post-tool-use.sh";
    const canonical = hookCommandPath(POSTTOOL);
    expect(isManagedHookCommand(operator, POSTTOOL, canonical)).toBe(false);
  });

  it("never writes a backslash into any hook command in settings.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-winpath-"));
    try {
      const p = path.join(dir, "settings.json");
      ensureClaudeSettings(false, p);
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const commands: string[] = [];
      for (const ev of Object.keys(s.hooks ?? {})) {
        for (const entry of s.hooks[ev] ?? []) {
          for (const h of entry.hooks ?? []) commands.push(h.command);
        }
      }
      expect(commands.length).toBeGreaterThan(0);
      for (const c of commands) {
        expect(typeof c).toBe("string");
        expect(c).not.toContain("\\");
        expect(c.startsWith('"') && c.endsWith('"')).toBe(true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles a legacy backslash PostToolUse entry in place on the next wire", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-winheal-"));
    try {
      const p = path.join(dir, "settings.json");
      // Seed what the old Windows binary left behind: an unquoted backslash path.
      const legacyWin = "C:\\Users\\pham\\.meetless\\hooks\\post-tool-use.sh";
      fs.writeFileSync(
        p,
        JSON.stringify(
          {
            hooks: {
              PostToolUse: [
                {
                  matcher: "Bash",
                  hooks: [{ type: "command", command: legacyWin }],
                },
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      // Anchor on `/post-tool-use.sh` so the CE0 sibling `ce0-post-tool-use.sh`
      // (a second managed PostToolUse script) is not swept in by a loose suffix.
      const postTool = (s.hooks.PostToolUse ?? []).filter((e: any) =>
        /\/post-tool-use\.sh"?$/.test(e.hooks?.[0]?.command ?? ""),
      );
      // Reconciled in place to exactly one entry, healed to the quoted path.
      expect(postTool.length).toBe(1);
      expect(postTool[0].hooks[0].command).toBe(hookCommandPath(POSTTOOL));
      expect(postTool[0].hooks[0].command).not.toContain("\\");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
