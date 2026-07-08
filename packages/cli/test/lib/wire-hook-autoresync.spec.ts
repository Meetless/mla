import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { maybeResyncHooks } from "../../src/lib/wire";
import type { BuildInfo } from "../../src/lib/observability";

// Behavioral lock for `maybeResyncHooks`: the bootstrap self-heal that re-copies
// drifted, already-installed hooks the moment a NEW binary is in charge, so a
// binary upgrade (curl/brew/npm/manual) no longer leaves the live hooks lagging
// the new code until the operator remembers to run `mla rewire`.
//
// Design under test (notes/20260626-hook-auto-resync.md):
//   - A hidden `.mla-build-stamp` in the hooks dir records the build identity
//     that last synced the install. Matching stamp => cheap no-op (no walk).
//   - On a stamp mismatch (build changed), re-copy ONLY the `drifted` files
//     (installed-but-different). NEVER create `missing` files (that would
//     resurrect a --no-post-tool-use opt-out) and NEVER touch settings.json.
//   - Fail-open: never throws; unbuilt `dev` sha and an unwired machine are
//     skipped; a kill switch disables it.

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

const BUILD_A: BuildInfo = {
  version: "1.0.0",
  sha: "aaaaaaa",
  branch: "main",
  dirty: false,
  builtAt: "2026-06-26T00:00:00.000Z",
};
const BUILD_B: BuildInfo = {
  version: "1.1.0",
  sha: "bbbbbbb",
  branch: "main",
  dirty: false,
  builtAt: "2026-06-27T00:00:00.000Z",
};

const STAMP = ".mla-build-stamp";

function seedTemplate(tpl: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(tpl, name), body);
  }
}

describe("maybeResyncHooks (bootstrap hook self-heal)", () => {
  it("re-copies a drifted hook and stamps the build when the binary changed", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    // BUILD_B ships an updated user-prompt-submit.sh; the install still holds the
    // BUILD_A bytes (the exact "upgraded binary, stale hooks" gap).
    seedTemplate(tpl, {
      "user-prompt-submit.sh": "#!/usr/bin/env bash\n# v2 grounding\n",
      "common.sh": "#!/usr/bin/env bash\nshared() { :; }\n",
    });
    fs.writeFileSync(path.join(inst, "user-prompt-submit.sh"), "#!/usr/bin/env bash\n# v1 grounding\n");
    fs.writeFileSync(path.join(inst, "common.sh"), "#!/usr/bin/env bash\nshared() { :; }\n");

    const res = maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });

    expect(res.ran).toBe(true);
    expect(res.refreshed).toEqual(["user-prompt-submit.sh"]);
    // The drifted file now holds the new bytes; the clean one is untouched.
    expect(fs.readFileSync(path.join(inst, "user-prompt-submit.sh"), "utf8")).toContain("# v2 grounding");
    // Stamp written, naming BUILD_B.
    expect(fs.readFileSync(path.join(inst, STAMP), "utf8").trim()).toBe("bbbbbbb|clean|2026-06-27T00:00:00.000Z");
  });

  it("is a cheap no-op when the stamp already names the running binary", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    seedTemplate(tpl, { "common.sh": "#!/usr/bin/env bash\nv2\n" });
    // Install is STALE vs the template, but the stamp already names BUILD_A, so
    // the gate short-circuits before any drift walk: same build => no heal.
    fs.writeFileSync(path.join(inst, "common.sh"), "#!/usr/bin/env bash\nv1\n");
    fs.writeFileSync(path.join(inst, STAMP), "aaaaaaa|clean|2026-06-26T00:00:00.000Z\n");

    const res = maybeResyncHooks({ buildInfo: BUILD_A, templateDir: tpl, hooksDir: inst, env: {} });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("current");
    // Untouched: same-build drift is doctor's job, not auto-resync's.
    expect(fs.readFileSync(path.join(inst, "common.sh"), "utf8")).toContain("v1");
  });

  it("never resurrects a missing (opted-out) hook, only refreshes installed ones", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    seedTemplate(tpl, {
      "common.sh": "#!/usr/bin/env bash\nv2\n",
      "post-tool-use.sh": "#!/usr/bin/env bash\ncapture\n", // opted out: not installed
    });
    fs.writeFileSync(path.join(inst, "common.sh"), "#!/usr/bin/env bash\nv1\n");

    const res = maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });

    expect(res.refreshed).toEqual(["common.sh"]);
    // The opt-out stays opted out.
    expect(fs.existsSync(path.join(inst, "post-tool-use.sh"))).toBe(false);
  });

  it("stamps (no copy) when the binary moved but its templates already match the install", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    seedTemplate(tpl, { "common.sh": "#!/usr/bin/env bash\nv1\n" });
    fs.writeFileSync(path.join(inst, "common.sh"), "#!/usr/bin/env bash\nv1\n");
    // Stamp names the OLD build; bytes are identical to the new build's template.
    fs.writeFileSync(path.join(inst, STAMP), "aaaaaaa|clean|2026-06-26T00:00:00.000Z\n");

    const res = maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });

    expect(res.ran).toBe(true);
    expect(res.refreshed).toEqual([]);
    expect(res.reason).toBe("stamped");
    expect(fs.readFileSync(path.join(inst, STAMP), "utf8").trim()).toBe("bbbbbbb|clean|2026-06-27T00:00:00.000Z");
  });

  it("is idempotent: a second call after a heal is a no-op", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    seedTemplate(tpl, { "common.sh": "v2\n" });
    fs.writeFileSync(path.join(inst, "common.sh"), "v1\n");

    const first = maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });
    const second = maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });

    expect(first.ran).toBe(true);
    expect(first.refreshed).toEqual(["common.sh"]);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("current");
  });

  it("chmods re-copied .sh hooks executable", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    seedTemplate(tpl, { "stop.sh": "#!/usr/bin/env bash\nexit 0\n" });
    // Install a stale, NON-executable copy.
    fs.writeFileSync(path.join(inst, "stop.sh"), "#!/usr/bin/env bash\nexit 1\n");
    fs.chmodSync(path.join(inst, "stop.sh"), 0o644);

    maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });

    expect(fs.statSync(path.join(inst, "stop.sh")).mode & 0o111).not.toBe(0);
  });

  it("the stamp file is invisible to the drift walk (not a template, not executed)", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    seedTemplate(tpl, { "common.sh": "v2\n" });
    fs.writeFileSync(path.join(inst, "common.sh"), "v1\n");

    maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });

    // The stamp lives in the install dir but is not one of the templates, so it
    // is never refreshed away and never reported as drift on a later run.
    expect(fs.existsSync(path.join(inst, STAMP))).toBe(true);
    const again = maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });
    expect(again.refreshed).toEqual([]);
  });

  it("kill switch disables the self-heal", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    seedTemplate(tpl, { "common.sh": "v2\n" });
    fs.writeFileSync(path.join(inst, "common.sh"), "v1\n");

    const res = maybeResyncHooks({
      buildInfo: BUILD_B,
      templateDir: tpl,
      hooksDir: inst,
      env: { MLA_DISABLE_HOOK_RESYNC: "1" },
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("disabled");
    expect(fs.readFileSync(path.join(inst, "common.sh"), "utf8")).toContain("v1");
    expect(fs.existsSync(path.join(inst, STAMP))).toBe(false);
  });

  it("skips an unbuilt dev binary (no shipped binary owns these hooks)", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    seedTemplate(tpl, { "common.sh": "v2\n" });
    fs.writeFileSync(path.join(inst, "common.sh"), "v1\n");

    const res = maybeResyncHooks({
      buildInfo: { ...BUILD_B, sha: "dev" },
      templateDir: tpl,
      hooksDir: inst,
      env: {},
    });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("dev-build");
  });

  it("skips a machine that was never wired (does not auto-create a hooks dir)", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = path.join(mkTmp("ml-parent-"), "hooks-does-not-exist");
    seedTemplate(tpl, { "common.sh": "v2\n" });

    const res = maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: inst, env: {} });

    expect(res.ran).toBe(false);
    expect(res.reason).toBe("not-wired");
    expect(fs.existsSync(inst)).toBe(false);
  });

  it("never throws and reports the error reason on a malformed install", () => {
    const tpl = mkTmp("ml-tpl-");
    // hooksDir points at a FILE, not a directory: fs.existsSync is true, then the
    // drift walk / copy fails. The function must swallow it and fall open.
    const parent = mkTmp("ml-parent-");
    const instFile = path.join(parent, "hooks-is-a-file");
    fs.writeFileSync(instFile, "not a dir\n");
    seedTemplate(tpl, { "common.sh": "v2\n" });

    const res = maybeResyncHooks({ buildInfo: BUILD_B, templateDir: tpl, hooksDir: instFile, env: {} });

    expect(res.ran).toBe(false);
    expect(res.reason.startsWith("error:")).toBe(true);
  });

  it("cli.ts wires maybeResyncHooks into the bootstrap (guard against silent removal)", () => {
    const cliSrc = fs.readFileSync(path.resolve(__dirname, "../../src/cli.ts"), "utf8");
    expect(cliSrc).toContain("maybeResyncHooks");
  });
});
