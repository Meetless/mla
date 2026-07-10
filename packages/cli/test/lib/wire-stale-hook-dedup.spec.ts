import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureClaudeSettings, POST_TOOL_USE_MATCHER } from "../../src/lib/wire";

// Double-hook root cause (dogfood F3-E): `ensureClaudeSettings` deduped a hook
// registration by EXACT command string. When a prior `mla rewire`/`mla init`
// ran with a temp MEETLESS_HOME (e.g. `/var/folders/.../T/mla-rewire-home-XXXX/
// .meetless/hooks/stop.sh`), that registration's command differs from the
// canonical `~/.meetless/hooks/stop.sh`, so a later real install did not see it
// as "ours" and APPENDED a second entry. Claude Code then fired both hooks every
// turn (double spool, double flush). The fix: recognize a meetless-managed hook
// by its script basename + a `hooks/` parent under a meetless home, reconcile a
// stale-path entry in place to the canonical path, and collapse any duplicates.

function mkSettingsPath(): { dir: string; p: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-settings-"));
  return { dir, p: path.join(dir, "settings.json") };
}

function readSettings(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function entriesFor(p: string, event: string): any[] {
  const s = readSettings(p);
  return Array.isArray(s.hooks?.[event]) ? s.hooks[event] : [];
}

// Each shared event (Stop, PostToolUse) now holds TWO managed entries: the
// load-bearing capture hook AND its CE0 evidence sibling (ce0-stop.sh /
// ce0-post-tool-use.sh). These dedup tests pin the load-bearing entry, so scope by
// exact command basename (basename equality keeps the two scripts disjoint).
function entriesForBasename(p: string, event: string, basename: string): any[] {
  // The command is forward-slash + double-quoted for the Windows shell fix, so
  // strip the surrounding quotes before taking the basename
  // (notes/20260710-windows-hook-wiring-and-portable-lock-fix.md).
  return entriesFor(p, event).filter(
    (e) => path.basename((e.hooks?.[0]?.command ?? "").replace(/^"|"$/g, "")) === basename,
  );
}

describe("ensureClaudeSettings: stale-path hook dedup (F3-E double-hook fix)", () => {
  it("reconciles a stale temp-HOME Stop registration in place instead of duplicating", () => {
    const { dir, p } = mkSettingsPath();
    try {
      // Fresh install to learn the canonical managed command path.
      ensureClaudeSettings(false, p);
      const canonical = entriesFor(p, "Stop")[0].hooks[0].command;
      expect(canonical).toMatch(/stop\.sh"$/);

      // Simulate a prior rewire that ran under a temp MEETLESS_HOME: same
      // basename + `hooks/` parent + `.meetless` segment, but a different dir.
      const stale =
        "/var/folders/zz/T/mla-rewire-home-nd0nCj/.meetless/hooks/stop.sh";
      fs.writeFileSync(
        p,
        JSON.stringify(
          { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: stale }] }] } },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const entries = entriesForBasename(p, "Stop", "stop.sh");
      expect(entries.length).toBe(1); // reconciled, not duplicated
      expect(entries[0].hooks[0].command).toBe(canonical); // healed to canonical path
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("collapses two already-duplicated stale Stop entries into one canonical entry", () => {
    const { dir, p } = mkSettingsPath();
    try {
      ensureClaudeSettings(false, p);
      const canonical = entriesFor(p, "Stop")[0].hooks[0].command;

      const staleA =
        "/var/folders/zz/T/mla-rewire-home-aaaa/.meetless/hooks/stop.sh";
      const staleB =
        "/var/folders/zz/T/mla-rewire-home-bbbb/.meetless/hooks/stop.sh";
      fs.writeFileSync(
        p,
        JSON.stringify(
          {
            hooks: {
              Stop: [
                { matcher: "", hooks: [{ type: "command", command: staleA }] },
                { matcher: "", hooks: [{ type: "command", command: staleB }] },
              ],
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const entries = entriesForBasename(p, "Stop", "stop.sh");
      expect(entries.length).toBe(1);
      expect(entries[0].hooks[0].command).toBe(canonical);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles a stale PostToolUse path AND enforces the broad matcher", () => {
    const { dir, p } = mkSettingsPath();
    try {
      ensureClaudeSettings(false, p);
      const canonical = entriesFor(p, "PostToolUse")[0].hooks[0].command;

      const stale =
        "/var/folders/zz/T/mla-rewire-home-cccc/.meetless/hooks/post-tool-use.sh";
      fs.writeFileSync(
        p,
        JSON.stringify(
          { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: stale }] }] } },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const entries = entriesForBasename(p, "PostToolUse", "post-tool-use.sh");
      expect(entries.length).toBe(1);
      expect(entries[0].hooks[0].command).toBe(canonical);
      expect(entries[0].matcher).toBe(POST_TOOL_USE_MATCHER);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT touch an operator's own hooks/stop.sh that is not under a meetless home", () => {
    const { dir, p } = mkSettingsPath();
    try {
      // An operator hook that happens to share the basename + `hooks/` parent
      // but lives outside any meetless home must be left alone, and ours appended.
      const operator = "/Users/someone/.config/hooks/stop.sh";
      fs.writeFileSync(
        p,
        JSON.stringify(
          { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: operator }] }] } },
          null,
          2,
        ),
        "utf8",
      );

      ensureClaudeSettings(false, p);

      const entries = entriesFor(p, "Stop");
      const own = entries.find((e) => e.hooks?.[0]?.command === operator);
      expect(own).toBeDefined(); // operator hook survives
      // Match OUR canonical hook by its meetless-home path, not just the "stop.sh"
      // basename: the operator's /Users/someone/.config/hooks/stop.sh shares that
      // basename, and ce0-stop.sh is a separate managed entry. Exactly one canonical
      // stop.sh is appended; the operator's own hook is left untouched.
      const oursEntries = entries.filter((e) =>
        /\.meetless\/hooks\/stop\.sh"$/.test(e.hooks?.[0]?.command ?? ""),
      );
      expect(oursEntries.length).toBe(1); // ours appended alongside, exactly once
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
