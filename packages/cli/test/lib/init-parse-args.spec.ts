import { parseInitArgs } from "../../src/commands/init";

// Behavioral lock for `mla init` argv parsing (Wedge v6 Epoch 54).
//
// The traps this epoch closes:
//
//   1. The genuinely dangerous one: `mla init --control-token
//      --workspace-id ws_x` bound controlToken = "--workspace-id"
//      because `next = () => argv[++i]` blindly ate the next slot.
//      Then "ws_x" fell through the switch's `default` (positional,
//      no `--` prefix) and was silently dropped. The CLI wrote a
//      0o600 config with a literal `--workspace-id` token and a
//      default workspaceId, breaking every subsequent `mla` call
//      with an opaque 401.
//
//   2. `mla init -x` (any short flag) hit the old `default`
//      branch's `if (a.startsWith("--"))` guard, which is `--`
//      only -- so `-x` was silently dropped.
//
//   3. `mla init some_positional --control-token T` silently
//      dropped the positional. `mla init` takes no positionals.

describe("parseInitArgs (mla init)", () => {
  describe("happy paths", () => {
    it("accepts no arguments", () => {
      expect(parseInitArgs([])).toEqual({});
    });

    it("accepts --control-token with a value", () => {
      expect(parseInitArgs(["--control-token", "secret"]).controlToken).toBe(
        "secret",
      );
    });

    it("accepts every value flag with a value", () => {
      const out = parseInitArgs([
        "--control-url",
        "http://127.0.0.1:3006",
        "--control-token",
        "T",
        "--intel-url",
        "http://127.0.0.1:8100",
        "--actor",
        "user_1",
      ]);
      expect(out.controlUrl).toBe("http://127.0.0.1:3006");
      expect(out.controlToken).toBe("T");
      expect(out.intelUrl).toBe("http://127.0.0.1:8100");
      expect(out.actorUserId).toBe("user_1");
    });

    it("accepts every boolean flag", () => {
      const out = parseInitArgs([
        "--no-post-tool-use",
        "--skill-only",
        "--no-install-flock",
        "--no-project-rules",
        "--unsafe-capture-non-bash",
      ]);
      expect(out.noPostToolUse).toBe(true);
      expect(out.skillOnly).toBe(true);
      expect(out.noInstallFlock).toBe(true);
      expect(out.noProjectRules).toBe(true);
      expect(out.unsafeCaptureNonBash).toBe(true);
    });

    it("accepts value flags and boolean flags interleaved", () => {
      const out = parseInitArgs([
        "--no-post-tool-use",
        "--control-token",
        "T",
        "--skill-only",
      ]);
      expect(out.noPostToolUse).toBe(true);
      expect(out.controlToken).toBe("T");
      expect(out.skillOnly).toBe(true);
    });
  });

  describe("missing-value guards (Trap 1)", () => {
    it("throws when --control-token has no following value", () => {
      expect(() => parseInitArgs(["--control-token"])).toThrow(
        /Missing value for --control-token/,
      );
    });

    // Trap 1 -- the catastrophic case. The missing-value guard fires before any
    // unknown-flag check, so even a now-removed flag name in the next slot is
    // surfaced as the eaten token.
    it("throws when --control-token is followed by another --flag", () => {
      expect(() =>
        parseInitArgs(["--control-token", "--intel-url", "http://x"]),
      ).toThrow(/Missing value for --control-token.*--intel-url/);
    });

    it("throws when --control-url has no following value", () => {
      expect(() => parseInitArgs(["--control-url"])).toThrow(
        /Missing value for --control-url/,
      );
    });

    it("throws when --intel-url has no following value", () => {
      expect(() => parseInitArgs(["--intel-url"])).toThrow(
        /Missing value for --intel-url/,
      );
    });

    it("throws when --control-token is the last argv even after other flags", () => {
      expect(() =>
        parseInitArgs(["--skill-only", "--control-token"]),
      ).toThrow(/Missing value for --control-token/);
    });
  });

  describe("unknown flag guards (Trap 2)", () => {
    it("throws on a short flag (-x)", () => {
      expect(() => parseInitArgs(["-x"])).toThrow(/Unknown flag: -x/);
    });

    it("throws on an unknown long flag", () => {
      expect(() => parseInitArgs(["--bogus"])).toThrow(/Unknown flag: --bogus/);
    });

    // T3.1: `--workspace-id` was removed (folder = workspace). `mla init` no
    // longer carries a workspace binding, so the flag is now an unknown flag.
    it("rejects the removed --workspace-id flag as unknown", () => {
      expect(() => parseInitArgs(["--workspace-id", "ws_x"])).toThrow(
        /Unknown flag: --workspace-id/,
      );
    });

    it("error message lists the supported flag set", () => {
      expect(() => parseInitArgs(["--bogus"])).toThrow(
        /--control-token[\s\S]*--intel-url/,
      );
    });
  });

  describe("positional argument guards (Trap 3)", () => {
    it("throws on a stray positional", () => {
      expect(() => parseInitArgs(["some_positional"])).toThrow(
        /no positional arguments/,
      );
    });

    it("throws on a positional after valid flags", () => {
      expect(() =>
        parseInitArgs(["--control-token", "T", "extra"]),
      ).toThrow(/no positional arguments/);
    });
  });

  describe("drift guard", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");

    function source(): string {
      const p = path.resolve(__dirname, "../../src/commands/init.ts");
      return fs.readFileSync(p, "utf8");
    }

    it("VALUE_FLAGS includes every documented value flag", () => {
      const src = source();
      for (const f of [
        "--control-url",
        "--control-token",
        "--intel-url",
        "--actor",
      ]) {
        expect(src.includes(`"${f}"`)).toBe(true);
      }
    });

    // T3.1 drift guard: `--workspace-id` must NOT come back as a value flag.
    // Strip comments first so a historical narrative mention does not false-trip.
    it("does NOT re-introduce --workspace-id as a value flag", () => {
      const src = source()
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^.*?\/\/.*$/gm, "");
      expect(src.includes('"--workspace-id"')).toBe(false);
    });

    it("BOOLEAN_FLAGS includes every documented boolean flag", () => {
      const src = source();
      for (const f of [
        "--no-post-tool-use",
        "--unsafe-capture-non-bash",
        "--skill-only",
        "--no-install-flock",
        "--no-project-rules",
      ]) {
        expect(src.includes(`"${f}"`)).toBe(true);
      }
    });

    it("parseInitArgs is exported so future flag rules can be pinned here", () => {
      expect(source()).toMatch(/export function parseInitArgs/);
    });

    // The old shape used `const next = () => argv[++i]` which was the
    // exact silent-eat-next-token primitive. Pin that it stays gone.
    // Strip comments before matching so the narrative comment quoting
    // the trap pattern doesn't false-trip.
    it("does NOT re-introduce the `argv[++i]` value-eat pattern", () => {
      const src = source()
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^.*?\/\/.*$/gm, "");
      expect(src).not.toMatch(/argv\[\+\+i\]/);
    });
  });
});
