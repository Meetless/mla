import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectBinaryRemovalHint, resolveMlaBinary } from "../../src/lib/unwire";

describe("detectBinaryRemovalHint", () => {
  it("npm global install -> npm uninstall -g", () => {
    const real = "/usr/local/lib/node_modules/@meetless/mla/dist/cli.js";
    const hint = detectBinaryRemovalHint("/usr/local/bin/mla", real).join("\n");
    expect(hint).toContain("npm uninstall -g @meetless/mla");
  });

  it("pnpm global install -> pnpm rm -g", () => {
    const real =
      "/home/u/.local/share/pnpm/global/5/.pnpm/@meetless+mla@1/node_modules/@meetless/mla/dist/cli.js";
    const hint = detectBinaryRemovalHint("/home/u/.local/share/pnpm/mla", real).join("\n");
    expect(hint).toContain("pnpm rm -g @meetless/mla");
  });

  it("dev symlink to a source checkout -> rm the launcher + name the repo root", () => {
    const real = "/Users/x/code/mla/packages/cli/dist/cli.js";
    const hint = detectBinaryRemovalHint("/opt/homebrew/bin/mla", real).join("\n");
    expect(hint).toContain("rm /opt/homebrew/bin/mla");
    expect(hint).toContain("/Users/x/code/mla");
    expect(hint).not.toContain("npm uninstall");
  });

  it("not found on PATH -> manual guidance, no command", () => {
    const hint = detectBinaryRemovalHint(null, null).join("\n");
    expect(hint.toLowerCase()).toContain("could not find");
  });
});

describe("resolveMlaBinary", () => {
  it("finds an mla launcher on a synthetic PATH and resolves its realpath", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bin-"));
    const target = path.join(dir, "cli.js");
    fs.writeFileSync(target, "#!/usr/bin/env node\n", "utf8");
    const bin = path.join(dir, "mla");
    fs.symlinkSync(target, bin);
    const res = resolveMlaBinary({ PATH: dir } as NodeJS.ProcessEnv);
    expect(res.binPath).toBe(bin);
    expect(res.realPath).toBe(fs.realpathSync(target));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns nulls when mla is not on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mla-bin-empty-"));
    expect(resolveMlaBinary({ PATH: dir } as NodeJS.ProcessEnv)).toEqual({
      binPath: null,
      realPath: null,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
