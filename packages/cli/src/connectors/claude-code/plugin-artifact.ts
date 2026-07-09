// plugin-artifact.ts: renderers for the plugin-only files (the ones with no
// legacy home-dir equivalent). These join the two source-of-truth halves: the
// operator surface (surface.ts, rendered by the generator with PLUGIN_SURFACE) and
// the install wiring (hook-contract.ts's MANAGED_HOOK_SCRIPTS + MCP_SERVER_KEY).
// Keeping the hook manifest a pure function of MANAGED_HOOK_SCRIPTS means a hook
// added to the settings.json installer is automatically added to the plugin
// manifest too; they can never drift. Every renderer is deterministic (fixed key
// order, single trailing newline) so `sync-plugin --check` is a stable drift gate.

import { MANAGED_HOOK_SCRIPTS, MCP_SERVER_KEY } from "./hook-contract";

export const PLUGIN_DESCRIPTION =
  "The Meetless agent CLI (mla): capture hooks, the governed-memory MCP server, " +
  "and the /mla:cli and /mla:onboard skills for Claude Code.";

// The product URL. It goes in the plugin manifest's top-level `homepage` field (its
// documented purpose), NOT nested under author.url. `homepage` is a valid top-level
// plugin.json field; there is no top-level marketplace homepage, so the marketplace
// catalog does not carry it.
export const PLUGIN_HOMEPAGE = "https://meetless.ai";

// Two SEPARATE constants because the two schemas differ:
//   plugin.json `author` accepts { name, email, url } (all valid); we use just
//     { name } and put the URL in `homepage`.
//   marketplace.json `owner` accepts ONLY { name, email }; a `url` there is an
//     unrecognized subfield that trips `claude plugin validate --strict`.
// Keeping them distinct prevents a future editor from "DRY-ing" them into one object
// that silently reintroduces owner.url.
export const AUTHOR = { name: "Meetless" } as const;
export const OWNER = { name: "Meetless" } as const;

// Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} with the absolute install dir at
// load time. We wrap it in double quotes so a path containing spaces survives the
// shell word-splitting that runs the command. In a TS single-quoted string the
// ${...} is a literal (no interpolation).
function pluginHookCommand(script: string): string {
  return '"${CLAUDE_PLUGIN_ROOT}"/hooks/' + script;
}

export function renderHookManifest(): string {
  const byEvent: Record<string, any[]> = {};
  const order: string[] = [];
  for (const w of MANAGED_HOOK_SCRIPTS) {
    if (!byEvent[w.event]) {
      byEvent[w.event] = [];
      order.push(w.event);
    }
    const cmd: any = { type: "command", command: pluginHookCommand(w.script) };
    if (typeof w.timeout === "number") cmd.timeout = w.timeout;
    // Mirror the settings.json installer, which writes `matcher: w.matcher ?? ""`
    // (wire.ts's ensureClaudeSettings). The empty string is the catch-all; the two
    // tool events carry their real matcher.
    byEvent[w.event].push({ matcher: w.matcher ?? "", hooks: [cmd] });
  }
  const hooks: Record<string, any[]> = {};
  for (const ev of order) hooks[ev] = byEvent[ev];
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

// ONE manifest, no variant. The generator reads the real semver from
// meetless-cli/packages/cli/package.json (the @meetless/mla release package, NOT the
// workspace-root meetless-cli/package.json) and passes it here (Global Constraints §8).
// Dogfooding does NOT use the plugin, so there is no sentinel/dogfood branch. A version
// is always required: a version-less manifest fails `claude plugin validate --strict`.
export function renderPluginManifest(version: string): string {
  if (!version) {
    throw new Error("plugin manifest requires an explicit semver version");
  }
  const manifest: Record<string, unknown> = { name: "mla" };
  manifest.version = version;
  manifest.description = PLUGIN_DESCRIPTION;
  // author carries only { name }; the product URL is the top-level `homepage`.
  manifest.author = AUTHOR;
  manifest.homepage = PLUGIN_HOMEPAGE;
  manifest.hooks = "./hooks/hooks.json";
  manifest.mcpServers = {
    [MCP_SERVER_KEY]: {
      command: "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla",
      args: ["mcp"],
    },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

export function renderMarketplaceCatalog(): string {
  const catalog = {
    name: "meetless",
    // A marketplace root needs a TOP-LEVEL description or `claude plugin validate
    // --strict` fails on the missing-description warning (Task 0 facts). Distinct
    // from the plugin ENTRY's description below.
    description:
      "Meetless plugins for Claude Code. Ships mla: capture hooks, the " +
      "governed-memory MCP server, and the /mla:cli and /mla:onboard skills.",
    // owner accepts ONLY { name, email }; never a url (would trip --strict).
    owner: OWNER,
    plugins: [
      { name: "mla", source: "./plugin", description: PLUGIN_DESCRIPTION },
    ],
  };
  return JSON.stringify(catalog, null, 2) + "\n";
}

export function renderResolverScript(): string {
  return `#!/bin/sh
# resolve-mla: locate the installed \`mla\` binary and exec it with the forwarded
# arguments. Bundled in the Meetless Claude Code plugin so the \`meetless\` MCP
# server can boot \`mla mcp\` regardless of where mla was installed (brew, npm,
# install.sh) and regardless of whether a GUI-launched Claude Code inherited the
# shell PATH. Pure POSIX sh; the exec path relies only on shell builtins so it
# still works under a stripped PATH (env -i), where external tools are absent.
set -u

self="\$0"
selfreal="\$self"
if command -v realpath >/dev/null 2>&1; then
  selfreal="\$(realpath "\$self" 2>/dev/null || printf '%s' "\$self")"
fi

# §5 candidate order. MEETLESS_MLA_PATH is the operator override; then the
# install.sh default; then Homebrew (Apple silicon and Intel); then Linuxbrew.
for cand in \\
  "\${MEETLESS_MLA_PATH:-}" \\
  "\${HOME:-}/.meetless/bin/mla" \\
  "/opt/homebrew/bin/mla" \\
  "/usr/local/bin/mla" \\
  "/home/linuxbrew/.linuxbrew/bin/mla"
do
  [ -n "\$cand" ] || continue
  [ "\$cand" = "\$self" ] && continue
  if command -v realpath >/dev/null 2>&1; then
    candreal="\$(realpath "\$cand" 2>/dev/null || printf '%s' "\$cand")"
    [ "\$candreal" = "\$selfreal" ] && continue
  fi
  [ -x "\$cand" ] || continue
  exec "\$cand" "\$@"
done

# Last resort: mla on PATH, but never this very script (guards an infinite
# re-exec if resolve-mla were ever itself named mla on PATH).
if command -v mla >/dev/null 2>&1; then
  onpath="\$(command -v mla)"
  onpathreal="\$onpath"
  if command -v realpath >/dev/null 2>&1; then
    onpathreal="\$(realpath "\$onpath" 2>/dev/null || printf '%s' "\$onpath")"
  fi
  if [ "\$onpath" != "\$self" ] && [ "\$onpathreal" != "\$selfreal" ]; then
    exec "\$onpath" "\$@"
  fi
fi

# No binary on any candidate path. resolve-mla runs only as the \`meetless\` MCP
# server command, so this is the MCP boot. Self-heal ONCE: fetch the
# tool-agnostic binary from the same installer the website serves so
# \`claude plugin install mla@meetless\` works even when the plugin was installed
# before the binary. Opt out with MEETLESS_MLA_NO_BOOTSTRAP=1; override the
# installer source with MEETLESS_INSTALL_URL (enterprise mirror / tests). Every
# line here writes to stderr: stdout is the MCP JSON-RPC channel and must stay clean.
bootstrap_target="\${HOME:-}/.meetless/bin/mla"
if [ "\${MEETLESS_MLA_NO_BOOTSTRAP:-}" != "1" ] && [ -n "\${HOME:-}" ]; then
  install_url="\${MEETLESS_INSTALL_URL:-https://meetless.ai/install.sh}"
  if command -v curl >/dev/null 2>&1; then
    fetch="curl -fsSL --max-time 180"
  elif command -v wget >/dev/null 2>&1; then
    fetch="wget -qO- --timeout=180"
  else
    fetch=""
  fi
  if [ -n "\$fetch" ]; then
    mkdir -p "\${HOME}/.meetless" 2>/dev/null || true
    lock="\${HOME}/.meetless/.mla-bootstrap.lock"
    # Atomic single-runner guard: if two Claude Code sessions cold-boot the MCP
    # at once, only the lock holder installs; the other falls through to the hint
    # and boots clean on its next restart once the binary lands.
    if mkdir "\$lock" 2>/dev/null; then
      trap 'rmdir "\$lock" 2>/dev/null' EXIT INT TERM
      printf 'resolve-mla: mla binary not found; bootstrapping once from %s (MEETLESS_MLA_NO_BOOTSTRAP=1 to skip)...\\n' "\$install_url" >&2
      # MLA_NO_WIRE=1: the plugin IS the Claude Code wiring; the installer must
      # not hand-wire ~/.claude too, or the two would double-wire.
      \$fetch "\$install_url" 2>/dev/null | MLA_NO_WIRE=1 sh >&2 || true
      rmdir "\$lock" 2>/dev/null || true
      trap - EXIT INT TERM
      [ -x "\$bootstrap_target" ] && exec "\$bootstrap_target" "\$@"
    fi
  fi
fi

printf 'resolve-mla: could not find the \`mla\` binary. Install it (https://meetless.ai/install.sh) or set MEETLESS_MLA_PATH.\\n' >&2
exit 127
`;
}
