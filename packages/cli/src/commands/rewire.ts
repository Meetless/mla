import {
  CFG_PATH,
  configExists,
  readConfig,
  writeConfig,
} from "../lib/config";
import { printWireResult, resolveMlaPath, runWire } from "../lib/wire";

// `mla rewire` (Wedge v6 init/rewire split).
//
// Idempotent local re-wiring. Does everything `mla init` does EXCEPT
// write credentials -- so it can be safely chained off `pnpm build` or
// suggested by `mla doctor` when hook drift is detected, without
// forcing the operator to dig up their control token.
//
// Contract:
//   - Refuses to run if cli-config.json does not exist. Tells the
//     operator to run `mla init` first.
//   - Re-resolves mlaPath (the binary may have moved across upgrades)
//     and re-writes the cli-config.json with the new path. Credentials
//     and URLs are preserved byte-for-byte.
//   - Re-copies hook scripts to ~/.meetless/hooks/.
//   - Re-registers hook entries in ~/.claude/settings.json (idempotent;
//     existing entries are detected by exact command-path match).
//   - Re-installs the /mla skill.
//   - Re-checks `flock` and auto-installs on macOS unless --no-install-flock.
//
// Flags:
//   --no-post-tool-use      skip post-tool-use.sh install (Bash capture opt-out)
//   --no-install-flock      skip auto-install of flock (macOS)
//   --no-mcp                skip registering the Meetless MCP server in ~/.claude.json
//   --skill-only            only re-install the /mla skill
//
// Exit codes:
//   0  fully ready
//   1  wrote everything but flock missing (hook pipeline will no-op until fixed)
//   2  bad flags / no config

const BOOLEAN_FLAGS = new Set([
  "--no-post-tool-use",
  "--no-install-flock",
  "--no-mcp",
  "--skill-only",
]);

interface RewireFlags {
  noPostToolUse?: boolean;
  noInstallFlock?: boolean;
  noMcp?: boolean;
  skillOnly?: boolean;
}

// Strict argv parser. `mla rewire` takes only boolean flags; any
// value-shaped flag, short flag, or positional is rejected loudly so
// operators don't accidentally pass a `--control-token` here expecting
// it to be honored (it's not -- use `mla init` for that).
export function parseRewireArgs(argv: string[]): RewireFlags {
  const out: RewireFlags = {};
  for (const a of argv) {
    if (BOOLEAN_FLAGS.has(a)) {
      if (a === "--no-post-tool-use") out.noPostToolUse = true;
      else if (a === "--no-install-flock") out.noInstallFlock = true;
      else if (a === "--no-mcp") out.noMcp = true;
      else if (a === "--skill-only") out.skillOnly = true;
      continue;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      throw new Error(
        `Unknown flag: ${a}. \`mla wire\` takes only boolean flags: ${[...BOOLEAN_FLAGS].sort().join(", ")}. ` +
          `To change credentials or URLs, run \`mla init\` instead.`,
      );
    }
    throw new Error(
      `Unexpected positional argument: ${a}. \`mla wire\` takes no positional arguments.`,
    );
  }
  return out;
}

export async function runRewire(argv: string[]): Promise<number> {
  let flags: RewireFlags;
  try {
    flags = parseRewireArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  if (flags.skillOnly) {
    const res = runWire({ skillOnly: true });
    printWireResult(res, { skillOnly: true });
    return 0;
  }

  if (!configExists()) {
    console.error(
      `cli-config.json not found at ${CFG_PATH}. ` +
        `\`mla wire\` only refreshes the local wiring of an existing install; ` +
        `run \`mla init --control-token <token>\` first.`,
    );
    return 2;
  }

  let cfg;
  try {
    cfg = readConfig();
  } catch (e) {
    console.error(
      `cli-config.json at ${CFG_PATH} is unreadable: ${(e as Error).message}. ` +
        `Run \`mla init --control-token <token>\` to re-create it.`,
    );
    return 2;
  }

  // Re-resolve mlaPath so a moved binary (e.g. pnpm link to a new
  // dist/) gets re-pinned. Credentials and URLs come from the existing
  // config unchanged.
  const refreshed = { ...cfg, mlaPath: resolveMlaPath() };
  writeConfig(refreshed);

  // Project rules (a repo's CLAUDE.md) are `mla init`'s job: an operator
  // explicitly opting a repo into consult-governed-memory-first onboarding
  // hygiene. rewire
  // is a frequent, cwd-sensitive refresh of *local wiring* (hooks, skill,
  // flock, cli-config.json), so it must never mutate whatever repo the cwd
  // happens to sit in. Re-run `mla init` in a repo to refresh its block.
  const wire = runWire({
    noPostToolUse: !!flags.noPostToolUse,
    noInstallFlock: !!flags.noInstallFlock,
    noProjectRules: true,
    noMcp: !!flags.noMcp,
  });

  console.log(`Refreshed ${CFG_PATH}`);
  console.log(`  controlUrl:  ${refreshed.controlUrl}`);
  // workspaceId is DEPRECATED as a config field (T1.1, folder = workspace): it is
  // intentionally unpopulated and resolved from the nearest `.meetless.json`
  // marker instead, so printing it here only ever showed a misleading `undefined`.
  console.log(`  intelUrl:    ${refreshed.intelUrl}`);
  console.log(`  mlaPath:     ${refreshed.mlaPath}`);
  printWireResult(wire);
  console.log("Next: mla doctor");
  return wire.flock?.ok ? 0 : 1;
}
