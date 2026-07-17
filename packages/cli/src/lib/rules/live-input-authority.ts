import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { HOOKS_DIR, userHomeDir } from "../config";
import {
  resolveInputAuthority,
  type HookConfigLayer,
  type InputAuthorityResolution,
} from "./input-authority-resolver";

// The production input-authority loader for the R1 pilot (P0.58). It feeds the pure resolver the single
// user config layer from ~/.claude/settings.json, the only layer the installer writes for the
// single-operator pilot (P0.3). An absent settings file is a readable empty layer (the resolver concludes
// MLA_HOOK_ABSENT, the honest "not wired" state); a file that exists but will not parse is marked
// unreadable so the resolver fails CLOSED (CONFIG_LAYER_UNREADABLE) rather than concluding MLA is sole
// authority. This is the single source of truth shared by `mla doctor` and the live PreToolUse hook so
// both judge admissibility off identical inputs.

export function readUserHookConfigLayer(homeDir: string = userHomeDir()): HookConfigLayer {
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return { name: "user", settings: {} };
  }
  try {
    return { name: "user", settings: JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
  } catch (e) {
    return { name: "user", unreadable: true, error: (e as Error).message };
  }
}

export function resolveLiveInputAuthority(
  opts: { homeDir?: string; mlaHooksDir?: string } = {},
): InputAuthorityResolution {
  return resolveInputAuthority([readUserHookConfigLayer(opts.homeDir)], {
    mlaHooksDir: opts.mlaHooksDir ?? HOOKS_DIR,
  });
}
