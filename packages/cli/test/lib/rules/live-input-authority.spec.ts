import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { resolveLiveInputAuthority } from "../../../src/lib/rules/live-input-authority";

// The production input-authority loader (P0.58). It reads the single user layer (~/.claude/settings.json,
// the only layer the installer writes for the single-operator R1 pilot) and runs the pure resolver. A
// would-be deny is admissible ONLY when MLA's managed pre-tool-use.sh is the sole effective Write/Edit
// PreToolUse hook. An absent settings file is the honest "not wired" state (MLA_HOOK_ABSENT); a file that
// will not parse fails CLOSED (CONFIG_LAYER_UNREADABLE), never to MLA_SOLE_AUTHORITY.

let home: string;
let mlaHooksDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "live-auth-home-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  mlaHooksDir = path.join(home, "hooks");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSettings(settings: unknown): void {
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(settings));
}

it("resolves MLA_SOLE_AUTHORITY when the managed hook is the only Write/Edit PreToolUse hook", () => {
  const mlaCommand = path.join(mlaHooksDir, "pre-tool-use.sh");
  writeSettings({ hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: mlaCommand }] }] } });
  const res = resolveLiveInputAuthority({ homeDir: home, mlaHooksDir });
  expect(res.kind).toBe("MLA_SOLE_AUTHORITY");
});

it("reports MLA_HOOK_ABSENT (UNAVAILABLE) when settings.json does not exist", () => {
  fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });
  const res = resolveLiveInputAuthority({ homeDir: home, mlaHooksDir });
  expect(res.kind).toBe("UNAVAILABLE");
  if (res.kind !== "UNAVAILABLE") throw new Error("unreachable");
  expect(res.reason).toBe("MLA_HOOK_ABSENT");
});

it("fails CLOSED (CONFIG_LAYER_UNREADABLE) when settings.json will not parse", () => {
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ not json");
  const res = resolveLiveInputAuthority({ homeDir: home, mlaHooksDir });
  expect(res.kind).toBe("UNAVAILABLE");
  if (res.kind !== "UNAVAILABLE") throw new Error("unreachable");
  expect(res.reason).toBe("CONFIG_LAYER_UNREADABLE");
});

it("reports UNAVAILABLE when a foreign Write/Edit mutator is also present", () => {
  const mlaCommand = path.join(mlaHooksDir, "pre-tool-use.sh");
  writeSettings({
    hooks: {
      PreToolUse: [
        { matcher: "Write|Edit", hooks: [{ type: "command", command: mlaCommand }] },
        { matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/other.sh" }] },
      ],
    },
  });
  const res = resolveLiveInputAuthority({ homeDir: home, mlaHooksDir });
  expect(res.kind).toBe("UNAVAILABLE");
  if (res.kind !== "UNAVAILABLE") throw new Error("unreachable");
  expect(res.reason).toBe("FOREIGN_MUTATOR_PRESENT");
});
