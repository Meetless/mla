import * as os from "os";
import * as path from "path";
import { codexHooksPath, resolveCodexHome } from "../../src/lib/config";
import { isUnderTempDir } from "../../src/lib/wire";

// Destructive-default footgun (2026-07-20): `mla uninstall`'s spec injected fakes for the Claude
// removers but not for the Codex one, so `deps.removeCodexHooks ?? removeCodexHooks` fell through to
// the REAL remover and `deps.codexHooksPath ?? codexHooksPath()` to the REAL ~/.codex/hooks.json.
// Every non-dry-run case therefore stripped the developer's own Codex governance hooks, reducing the
// file to `{"hooks": {}}`. The suite reported 12/12 passing while doing it: the damage lands on a
// file no assertion looks at, so nothing in the test result can reveal it. The observable symptom was
// downstream and days later, as `mla doctor` reporting "Codex connector incomplete" and the operator
// re-running `mla codex install` to undo a wipe they could not attribute.
//
// MEETLESS_HOME containment does not reach this: $CODEX_HOME is Codex's directory, derived from the
// passwd home, not from ours. So jest.setup-home.js sandboxes CODEX_HOME too, and this spec pins that
// containment. It is deliberately a property of the ENVIRONMENT rather than of any one spec, because
// the failure mode is a future spec forgetting an override, which no per-spec assertion can catch.

describe("Codex home containment", () => {
  it("resolves $CODEX_HOME into the throwaway test sandbox, never the operator's real ~/.codex", () => {
    expect(process.env.CODEX_HOME).toBeTruthy();
    expect(isUnderTempDir(resolveCodexHome())).toBe(true);
    expect(isUnderTempDir(codexHooksPath())).toBe(true);
  });

  it("keeps the resolved hooks file off the real passwd home", () => {
    // os.userInfo().homedir reads the passwd entry directly, so it is the real home even when $HOME
    // is redirected. That is precisely the path a leaked write would land in.
    const realCodex = path.join(os.userInfo().homedir, ".codex");
    expect(codexHooksPath().startsWith(realCodex)).toBe(false);
  });
});
