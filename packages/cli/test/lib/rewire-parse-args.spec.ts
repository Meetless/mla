import { parseRewireArgs } from "../../src/commands/rewire";

// Behavioral lock for `mla rewire` argv parsing (init/rewire split).
//
// `rewire` only accepts boolean flags. Three trap classes are pinned:
//
//   1. Passing a credential flag (e.g. `--control-token T`) must reject
//      loudly, NOT silently no-op. Operators reasonably reach for
//      `--control-token` after seeing it on `mla init`; failing fast
//      with a "use mla init instead" hint prevents the silent-drop
//      footgun.
//
//   2. Any value-shape flag (`--control-url ...`, `--workspace-id ...`)
//      rejects with the same hint.
//
//   3. Any positional argument throws (rewire takes none).

describe("parseRewireArgs (mla rewire)", () => {
  describe("happy paths", () => {
    it("accepts no arguments", () => {
      expect(parseRewireArgs([])).toEqual({});
    });

    it("accepts --no-post-tool-use", () => {
      expect(parseRewireArgs(["--no-post-tool-use"])).toEqual({
        noPostToolUse: true,
      });
    });

    it("accepts --no-install-flock", () => {
      expect(parseRewireArgs(["--no-install-flock"])).toEqual({
        noInstallFlock: true,
      });
    });

    it("accepts --skill-only", () => {
      expect(parseRewireArgs(["--skill-only"])).toEqual({
        skillOnly: true,
      });
    });

    it("accepts all boolean flags interleaved", () => {
      const out = parseRewireArgs([
        "--no-post-tool-use",
        "--no-install-flock",
        "--skill-only",
      ]);
      expect(out.noPostToolUse).toBe(true);
      expect(out.noInstallFlock).toBe(true);
      expect(out.skillOnly).toBe(true);
    });
  });

  describe("credential-flag rejection (Trap 1)", () => {
    it("throws when --control-token is passed", () => {
      expect(() => parseRewireArgs(["--control-token", "T"])).toThrow(
        /Unknown flag: --control-token/,
      );
    });

    it("error hint points the operator at `mla init`", () => {
      expect(() => parseRewireArgs(["--control-token", "T"])).toThrow(
        /mla init/,
      );
    });

    it("throws when --workspace-id is passed", () => {
      expect(() => parseRewireArgs(["--workspace-id", "ws_x"])).toThrow(
        /Unknown flag: --workspace-id/,
      );
    });

    it("throws when --control-url is passed", () => {
      expect(() =>
        parseRewireArgs(["--control-url", "http://localhost:3006"]),
      ).toThrow(/Unknown flag: --control-url/);
    });

    it("throws when --intel-url is passed", () => {
      expect(() =>
        parseRewireArgs(["--intel-url", "http://localhost:8100"]),
      ).toThrow(/Unknown flag: --intel-url/);
    });
  });

  describe("unknown flag guards (Trap 2)", () => {
    it("throws on a short flag (-x)", () => {
      expect(() => parseRewireArgs(["-x"])).toThrow(/Unknown flag: -x/);
    });

    it("throws on an unknown long flag", () => {
      expect(() => parseRewireArgs(["--bogus"])).toThrow(
        /Unknown flag: --bogus/,
      );
    });

    it("error message lists the supported boolean flag set", () => {
      expect(() => parseRewireArgs(["--bogus"])).toThrow(
        /--no-post-tool-use.*--skill-only/,
      );
    });
  });

  describe("positional argument guards (Trap 3)", () => {
    it("throws on a stray positional", () => {
      expect(() => parseRewireArgs(["some_positional"])).toThrow(
        /no positional arguments/,
      );
    });

    it("throws on a positional after a valid boolean flag", () => {
      expect(() =>
        parseRewireArgs(["--no-post-tool-use", "extra"]),
      ).toThrow(/no positional arguments/);
    });
  });
});
