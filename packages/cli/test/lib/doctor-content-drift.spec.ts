import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { checkHookDrift, locateHooksTemplateDir } from "../../src/lib/wire";

// Behavioral lock for `mla doctor`'s hook content-drift check.
//
// HISTORY: the original check (Wedge v6 Epoch 27/35) scanned flush.sh and
// session-start.sh for specific marker substrings (`event-batch-filter.jq`,
// `export MEETLESS_REPO_PATH=`, ...). That was brittle in two ways:
//   1. It only covered two of the seven hook files. common.sh and
//      user-prompt-submit.sh had NO drift check at all, so the 2026-05-31
//      turn_index fix (a new `next_turn_index` function in common.sh + a
//      changed write_trace in user-prompt-submit.sh) shipped in the binary
//      but the stale installed hooks kept writing `turn_index: null` and
//      doctor reported "content current". The operator got no signal to
//      re-run `mla rewire`.
//   2. Each new hook edit required hand-adding a new marker substring or the
//      drift went undetected.
//
// The fix replaces marker-scanning with a generic byte comparison: every
// installed hook is compared to the template THIS binary would install
// (the exact source `copyHooks` reads from). Any difference => stale =>
// `mla rewire`. Zero per-edit maintenance; all files covered for free.

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

describe("mla doctor hook content-drift check (byte comparison vs shipped template)", () => {
  it("reports NO drift when the install is a verbatim copy of the template", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    fs.writeFileSync(path.join(tpl, "common.sh"), "#!/usr/bin/env bash\nnext_turn_index() { :; }\n");
    fs.writeFileSync(path.join(tpl, "stop.sh"), "#!/usr/bin/env bash\nexit 0\n");
    for (const f of fs.readdirSync(tpl)) {
      fs.copyFileSync(path.join(tpl, f), path.join(inst, f));
    }
    const drift = checkHookDrift({ templateDir: tpl, hooksDir: inst });
    expect(drift.drifted).toEqual([]);
    expect(drift.errors).toEqual([]);
  });

  it("flags a file whose installed bytes differ from the template", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    fs.writeFileSync(path.join(tpl, "common.sh"), "#!/usr/bin/env bash\nnext_turn_index() { :; }\n");
    // Stale install: missing the next_turn_index function (the exact 2026-05-31 regression).
    fs.writeFileSync(path.join(inst, "common.sh"), "#!/usr/bin/env bash\n");
    const drift = checkHookDrift({ templateDir: tpl, hooksDir: inst });
    expect(drift.drifted).toEqual(["common.sh"]);
  });

  it("does NOT count an un-installed template file as drift (presence is checked separately)", () => {
    // post-tool-use.sh opt-out: the file is intentionally absent. Drift is
    // strictly about installed-but-different, never about missing.
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    fs.writeFileSync(path.join(tpl, "common.sh"), "x\n");
    fs.writeFileSync(path.join(tpl, "post-tool-use.sh"), "y\n");
    fs.copyFileSync(path.join(tpl, "common.sh"), path.join(inst, "common.sh"));
    // post-tool-use.sh deliberately not installed.
    const drift = checkHookDrift({ templateDir: tpl, hooksDir: inst });
    expect(drift.drifted).toEqual([]);
    expect(drift.missing).toEqual(["post-tool-use.sh"]);
  });

  it("ignores subdirectories / non-files in the template dir", () => {
    const tpl = mkTmp("ml-tpl-");
    const inst = mkTmp("ml-inst-");
    fs.mkdirSync(path.join(tpl, "subdir"));
    fs.writeFileSync(path.join(tpl, "common.sh"), "x\n");
    fs.copyFileSync(path.join(tpl, "common.sh"), path.join(inst, "common.sh"));
    const drift = checkHookDrift({ templateDir: tpl, hooksDir: inst });
    expect(drift.drifted).toEqual([]);
    expect(drift.missing).toEqual([]);
  });

  it("positive control: the REAL shipped templates compare clean against a verbatim copy", () => {
    // Copies every shipped template into a temp install dir and asserts zero
    // drift. Guards against a checkHookDrift bug that would false-positive on
    // the very files rewire installs.
    const realTpl = locateHooksTemplateDir();
    const inst = mkTmp("ml-inst-real-");
    for (const f of fs.readdirSync(realTpl)) {
      const src = path.join(realTpl, f);
      if (!fs.statSync(src).isFile()) continue;
      fs.copyFileSync(src, path.join(inst, f));
    }
    const drift = checkHookDrift({ templateDir: realTpl, hooksDir: inst });
    expect(drift.drifted).toEqual([]);
    expect(drift.errors).toEqual([]);
  });

  it("doctor.ts wires checkHookDrift (drift guard against silent removal)", () => {
    const doctorSrc = fs.readFileSync(
      path.resolve(__dirname, "../../src/commands/doctor.ts"),
      "utf8",
    );
    expect(doctorSrc).toContain("checkHookDrift");
    // The drift remediation hint points at the canonical `mla wire` (rewire
    // remains a silent alias, but the operator-facing string uses the new name).
    expect(doctorSrc).toContain("mla wire");
  });
});
