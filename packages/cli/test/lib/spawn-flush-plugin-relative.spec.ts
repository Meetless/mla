import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Plugin blocker regression lock (2026-07-04): spawn_flush must resolve flush.sh
// RELATIVE TO common.sh's own directory, never to $MEETLESS_HOME/hooks. When the
// hooks run from the plugin (${CLAUDE_PLUGIN_ROOT}/hooks) that home path need not
// exist, so a hardcoded "$MEETLESS_HOME_DIR/hooks/flush.sh" makes the detached
// flush silently never run and capture dies with no error.

const REAL_COMMON = path.resolve(__dirname, "../../src/hooks-template/common.sh");

describe("common.sh resolves flush.sh self-relative (plugin-safe)", () => {
  it("MEETLESS_HOOK_SCRIPT_DIR is the dir of the sourced common.sh, not $MEETLESS_HOME/hooks", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mla-plugin-hooks-"));
    try {
      // A plugin-like hooks dir, deliberately NOT under MEETLESS_HOME.
      const pluginHooks = path.join(tmp, "plugin", "hooks");
      fs.mkdirSync(pluginHooks, { recursive: true });
      fs.copyFileSync(REAL_COMMON, path.join(pluginHooks, "common.sh"));
      // A DISTINCT MEETLESS_HOME whose hooks/ must NOT be where flush is resolved.
      const home = path.join(tmp, "home");
      fs.mkdirSync(path.join(home, "hooks"), { recursive: true });

      const script = `
set -euo pipefail
source "$1"
echo "$MEETLESS_HOOK_SCRIPT_DIR"
`;
      const r = spawnSync(
        "bash",
        ["-c", script, "runner", path.join(pluginHooks, "common.sh")],
        { encoding: "utf8", env: { ...process.env, MEETLESS_HOME: home } },
      );
      expect(r.status).toBe(0);
      const resolved = r.stdout.trim();
      // realpathSync collapses /var -> /private/var on macOS so the compare holds.
      expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(pluginHooks));
      expect(fs.realpathSync(resolved)).not.toBe(fs.realpathSync(path.join(home, "hooks")));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
