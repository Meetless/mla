// connectors/codex/wire.ts: install/uninstall mechanics for the Codex connector's
// global hook file (`$CODEX_HOME/hooks.json`) AND its MCP registration
// (`$CODEX_HOME/config.toml`). This is the Codex sibling of the Claude wiring in
// lib/wire.ts. It deliberately does NOT touch the Claude path.
//
// The hook file schema is identical to Claude's settings.json, so the merge
// itself is the shared engine in lib/hook-reconcile.ts. Codex differs only in:
//   - WHERE it writes: $CODEX_HOME/hooks.json (config.codexHooksPath), not
//     ~/.claude/settings.json.
//   - WHAT it registers: mla SUBCOMMANDS, not hook-script paths, so identity is
//     the subcommand token run (hook-contract.codexManagedEventOf), not a
//     basename under hooks/.
//   - MALFORMED policy: it refuses to overwrite a corrupt/hand-edited hooks.json
//     (onParseError: "throw"), where Claude resets it. This is the §7 test-4
//     contract: a bad file fails visibly instead of being clobbered.
//
// MCP registration ($CODEX_HOME/config.toml) is the second half of Codex install
// parity with Claude. Unlike ~/.claude.json (JSON we own end-to-end), config.toml
// is the USER's file (their model, their other MCP servers, their timeouts and
// approval modes), so we never parse-and-rewrite it. Detection goes through
// Codex's own argv API (`codex mcp get`/`list --json`), and the only mutation is
// APPENDING a fresh `[mcp_servers.meetless]` table, and only when Codex itself
// reports the server absent from a config that otherwise loads. See
// ensureCodexMcpServer below.

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  codexConfigPath,
  codexHooksPath,
  HomeResolutionDeps,
} from "../../lib/config";
import { resolveMlaPath, backupAndPruneSettings } from "../../lib/wire";
import {
  reconcileHookFile,
  removeManagedHookEntries,
  ReconcileResult,
} from "../../lib/hook-reconcile";
import {
  CODEX_MANAGED_HOOKS,
  buildCodexWantedHooks,
  codexManagedEventOf,
  isCodexManagedCommand,
} from "./hook-contract";

// Quote the mla executable path for a shell-run hook command, matching the
// forward-slash + double-quote convention lib/wire.ts uses for Claude hook
// commands: forward slashes so Git Bash on Windows does not eat backslashes,
// quotes so a home dir containing a space survives. On POSIX this is a plain
// quoted absolute path.
export function quoteMlaCommand(mlaPath: string): string {
  const p = mlaPath.split(path.sep).join("/");
  return `"${p}"`;
}

/**
 * Reconcile `$CODEX_HOME/hooks.json` so it registers exactly the Meetless-managed
 * Codex hooks (PreToolUse -> pretool-observe, UserPromptSubmit -> the codex-hook
 * wrapper), preserving every user/third-party hook. Idempotent. A malformed
 * hooks.json is NOT overwritten: it throws so the operator can inspect it.
 *
 * @param opts.hooksPathOverride  target file (tests point this at a temp dir)
 * @param opts.mlaPath            mla executable to register (defaults to resolveMlaPath)
 */
export function ensureCodexHooks(opts: {
  hooksPathOverride?: string;
  mlaPath?: string;
  homeDeps?: HomeResolutionDeps;
} = {}): ReconcileResult {
  const hooksPath = opts.hooksPathOverride ?? codexHooksPath(opts.homeDeps);
  const mlaPath = opts.mlaPath ?? resolveMlaPath();
  const wanted = buildCodexWantedHooks(quoteMlaCommand(mlaPath));

  return reconcileHookFile(hooksPath, wanted, isCodexManagedCommand, {
    onParseError: "throw",
    backup: backupAndPruneSettings,
  });
}

/**
 * Connector-scoped uninstall: strip only the Meetless-managed entries from
 * `$CODEX_HOME/hooks.json`, leaving every user/third-party hook intact. Like the
 * Claude `removeMeetlessHooks`, it edits ONLY the file; it never unlinks the
 * shared `~/.meetless/hooks/*.sh` scripts (so removing the Codex connector cannot
 * break Claude grounding, and vice versa).
 */
export function removeCodexHooks(opts: {
  hooksPathOverride?: string;
  homeDeps?: HomeResolutionDeps;
} = {}): { changed: boolean; filePath: string } {
  const hooksPath = opts.hooksPathOverride ?? codexHooksPath(opts.homeDeps);
  return removeManagedHookEntries(hooksPath, isCodexManagedCommand, {
    backup: backupAndPruneSettings,
  });
}

/** True when a Codex hooks.json currently registers every managed hook. */
export function codexHooksInstalled(opts: {
  hooksPathOverride?: string;
  homeDeps?: HomeResolutionDeps;
} = {}): boolean {
  const hooksPath = opts.hooksPathOverride ?? codexHooksPath(opts.homeDeps);
  if (!fs.existsSync(hooksPath)) return false;
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
  } catch {
    return false;
  }
  const events = doc?.hooks;
  if (!events || typeof events !== "object") return false;
  const installed = new Set<string>();
  for (const event of Object.keys(events)) {
    const list = events[event];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const h of hooks) {
        if (
          h?.type === "command" &&
          typeof h?.command === "string" &&
          codexManagedEventOf(h.command) === event
        ) {
          installed.add(event);
        }
      }
    }
  }
  return CODEX_MANAGED_HOOKS.every((hook) => installed.has(hook.event));
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex MCP registration ($CODEX_HOME/config.toml)
// ─────────────────────────────────────────────────────────────────────────────

// "added"              was absent; appended a fresh [mcp_servers.meetless] table
// "unchanged"          present, canonical (`mla mcp`), enabled -> no write
// "preserved-disabled" present + ours but enabled=false -> left disabled, reported
// "conflict"           present but foreign (not `mla mcp`) -> NOT overwritten
// "skipped"            codex absent / config would not load / --no-mcp / write failed
export type CodexMcpAction =
  | "added"
  | "unchanged"
  | "preserved-disabled"
  | "conflict"
  | "skipped";

export interface CodexMcpResult {
  action: CodexMcpAction;
  configPath: string;
  detail?: string;
  /** For a conflict: the command/args of the entry we refused to replace. */
  existingCommand?: string;
  existingArgs?: string[];
}

// The MCP approval mode we register. Codex's AppToolApproval enum defaults to
// `auto` (every tool auto-approved) when a server declares no override, so
// OMITTING this field would auto-approve Meetless's governance-MUTATING write
// tools (decision_record, dismiss_conflict, relationship_verdict). "writes"
// keeps the read tools (retrieve_knowledge, query, kb_doc_detail) friction-free
// while gating the writes behind a human approval, which is the entire point of
// a governance connector. `codex mcp add` cannot set this field, and a `-c`
// override makes the config fail to load, so we can only carry it in the table
// we append ourselves.
export const CODEX_MCP_APPROVAL_MODE = "writes";

interface CodexProbe {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

/**
 * Injectable argv-subprocess runner for the `codex` CLI. Always an argument
 * VECTOR (never a shell command string), so a path with spaces or metacharacters
 * cannot be misparsed. The `cwd` is EXPLICIT because `codex mcp get`/`list` merge
 * the trusted project-level `.codex/config.toml` of the working directory into
 * their view (proven live against 0.144.6, notes/20260727-codex-mcp-probe-cwd-scope.md):
 * probing from the operator's repo could mistake a project-local entry for
 * machine-level wiring. Callers pass a NEUTRAL cwd so detection reflects only the
 * user/machine scope. Tests pass a fake to exercise every branch without a real
 * Codex on the machine.
 */
export type CodexExecFn = (args: string[], cwd: string) => CodexProbe;

// A working directory that carries no trusted project-level Codex config, so a
// `codex mcp` probe run there reflects only the user/machine scope. The OS temp
// dir is never a git repo with a trusted `.codex/config.toml`.
function neutralProbeCwd(): string {
  return os.tmpdir();
}

function defaultCodexExec(args: string[], cwd: string): CodexProbe {
  const r = spawnSync("codex", args, { encoding: "utf8", timeout: 5000, cwd });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    errorCode: (r.error as NodeJS.ErrnoException | undefined)?.code,
  };
}

function firstLine(s: string): string {
  const line = (s ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "unknown error";
}

// A registered server "is ours" when it launches `mla mcp`: args are exactly
// ["mcp"] (checked by the caller) and the command resolves to an mla binary. We
// accept the absolute path we register (resolveMlaPath), the bare name "mla"
// (the declarative plugin form), a symlink/realpath match, and any basename-`mla`
// command (a relocated binary is still the Meetless server, not a foreign one).
export function isOurMlaCommand(command: unknown, mlaPath: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  if (command === mlaPath || command === "mla") return true;
  try {
    if (fs.realpathSync(command) === fs.realpathSync(mlaPath)) return true;
  } catch {
    /* command path may not exist on this machine; fall through to basename */
  }
  return path.basename(command) === "mla";
}

// Classify a present entry (from `codex mcp get`/`list --json`) WITHOUT writing:
// canonical -> unchanged, ours-but-disabled -> preserved-disabled, anything not
// launching `mla mcp` -> conflict (reported with its exact command+args, never
// overwritten).
function classifyCodexEntry(
  entry: any,
  mlaPath: string,
  configPath: string,
): CodexMcpResult {
  const transport = entry?.transport ?? {};
  const command = transport.command;
  const args = transport.args;
  const isStdio = transport.type === "stdio";
  const argsCanonical =
    Array.isArray(args) && args.length === 1 && args[0] === "mcp";
  if (!isStdio || !argsCanonical || !isOurMlaCommand(command, mlaPath)) {
    return {
      action: "conflict",
      configPath,
      existingCommand: typeof command === "string" ? command : undefined,
      existingArgs: Array.isArray(args) ? args : undefined,
      detail:
        "an `mcp_servers.meetless` entry MLA does not own already exists; " +
        "left unchanged so a user-managed or externally-managed server is " +
        "never overwritten.",
    };
  }
  if (entry?.enabled === false) {
    return {
      action: "preserved-disabled",
      configPath,
      detail:
        "the meetless MCP server is registered but disabled; left disabled " +
        "(re-enable it in Codex to use governed memory there).",
    };
  }
  return {
    action: "unchanged",
    configPath,
  };
}

// Minimal TOML basic-string escaping: backslash and double-quote. A realpath'd
// executable path realistically contains neither, but correctness demands it.
function tomlBasicString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function buildMeetlessMcpTable(mlaPath: string): string {
  return (
    [
      "[mcp_servers.meetless]",
      `command = ${tomlBasicString(mlaPath)}`,
      `args = ["mcp"]`,
      `default_tools_approval_mode = "${CODEX_MCP_APPROVAL_MODE}"`,
    ].join("\n") + "\n"
  );
}

// Append a fresh [mcp_servers.meetless] table. Only ever reached after Codex has
// confirmed the config loads AND has no meetless entry, so appending a top-level
// table cannot land inside an unterminated construct. A pre-existing file is
// byte-backed-up first and its content preserved verbatim; a blank separator
// line precedes our table for readability.
function appendMeetlessMcpTable(configPath: string, mlaPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const existed = fs.existsSync(configPath);
  const prior = existed ? fs.readFileSync(configPath, "utf8") : "";
  if (existed) {
    try {
      fs.copyFileSync(configPath, configPath + ".bak." + Date.now());
    } catch {
      /* best effort: an un-backed-up append still beats no registration */
    }
  }
  let out = prior;
  if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  if (out.length > 0) out += "\n"; // blank line before our table
  out += buildMeetlessMcpTable(mlaPath);
  fs.writeFileSync(configPath, out, "utf8");
}

/**
 * Register the Meetless MCP server in `$CODEX_HOME/config.toml`, mirroring
 * ensureClaudeMcpServer but for Codex's user-owned TOML. Never parses/rewrites
 * the file: detection is Codex's own argv API, and the only mutation is an append
 * in the genuinely-absent case.
 *
 * Ownership behavior (RC4): absent -> append; present+canonical+enabled ->
 * no-op; present+ours+disabled -> preserve disabled + report; present+foreign ->
 * conflict (report exact command+args, do NOT overwrite). Never remove-and-re-add
 * (that would erase a user's env/timeouts/tool allowlists/approval mode).
 *
 * Robustness: a missing `codex` on PATH, or a config Codex cannot load, yields a
 * "skipped" result with a precise detail rather than a throw or a blind write, so
 * the caller can report it without failing the install (Codex hooks are wired
 * independently).
 */
export function ensureCodexMcpServer(
  opts: {
    mlaPath?: string;
    homeDeps?: HomeResolutionDeps;
    configPathOverride?: string;
    exec?: CodexExecFn;
  } = {},
): CodexMcpResult {
  const mlaPath = opts.mlaPath ?? resolveMlaPath();
  const configPath = opts.configPathOverride ?? codexConfigPath(opts.homeDeps);
  const exec = opts.exec ?? defaultCodexExec;
  // Probe from a neutral cwd so a trusted project-level `.codex/config.toml` in
  // the operator's current repo cannot masquerade as machine-level wiring.
  const cwd = neutralProbeCwd();

  // Fast path: a direct `get` that cleanly returns the entry.
  const get = exec(["mcp", "get", "meetless", "--json"], cwd);
  if (get.errorCode === "ENOENT") {
    return {
      action: "skipped",
      configPath,
      detail:
        "the `codex` executable is not on PATH; skipped Codex MCP registration. " +
        "Install Codex and run `mla codex install`.",
    };
  }
  if (get.status === 0) {
    let entry: any;
    try {
      entry = JSON.parse(get.stdout);
    } catch {
      entry = undefined;
    }
    if (entry && typeof entry === "object") {
      return classifyCodexEntry(entry, mlaPath, configPath);
    }
  }

  // `get` did not cleanly resolve (exit 1 = absent OR a config load error).
  // `list --json` is the authoritative disambiguator: it reads the SAME config,
  // so its success proves the file loads and any absence is genuine.
  const list = exec(["mcp", "list", "--json"], cwd);
  if (list.errorCode === "ENOENT") {
    return {
      action: "skipped",
      configPath,
      detail: "the `codex` executable is not on PATH; skipped Codex MCP registration.",
    };
  }
  if (list.status !== 0) {
    return {
      action: "skipped",
      configPath,
      detail:
        `Codex could not load its config, so MLA left it untouched: ${firstLine(list.stderr)}. ` +
        `Fix ${configPath}, then run \`mla codex install\`.`,
    };
  }
  let servers: any;
  try {
    servers = JSON.parse(list.stdout);
  } catch {
    return {
      action: "skipped",
      configPath,
      detail:
        "`codex mcp list --json` returned output MLA could not parse; left the config untouched.",
    };
  }
  if (Array.isArray(servers)) {
    const found = servers.find((s) => s && s.name === "meetless");
    if (found) return classifyCodexEntry(found, mlaPath, configPath);
  }
  // Config loads and has no meetless entry -> genuinely absent -> append.
  try {
    appendMeetlessMcpTable(configPath, mlaPath);
  } catch (e) {
    return {
      action: "skipped",
      configPath,
      detail: `could not write ${configPath}: ${(e as Error).message}`,
    };
  }
  return { action: "added", configPath };
}

/**
 * Resolve a runnable `codex` on PATH WITHOUT spawning it. Returns the absolute
 * path or null. The install orchestrator uses this to decide whether to attempt
 * Codex auto-wiring at all: on a machine without Codex we register nothing rather
 * than write a hooks/config file no Codex will ever read.
 */
export function findCodexExecutable(
  deps: { env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = deps.env ?? process.env;
  const raw = env.PATH || "";
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "codex");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here; keep scanning PATH */
    }
  }
  return null;
}

export interface CodexWireOutcome {
  hooks: { result?: ReconcileResult; error?: string };
  mcp: CodexMcpResult;
}

/**
 * Automatic Codex wiring for the install orchestrator (runWire): reconcile the
 * Codex hooks and register the MCP server, NEVER throwing. A malformed hooks.json
 * is reported (not clobbered) and returned as an error string so the caller can
 * surface it without failing the whole install. The Codex-executable presence
 * check is the CALLER's job (runWire only calls this when a usable codex is on
 * PATH); the explicit `mla codex install` path handles a missing codex through
 * ensureCodexMcpServer's own detection.
 *
 * `registerMcp: false` (from `--no-mcp`) wires hooks only and marks the MCP
 * result skipped, so `--no-mcp` stays a single "don't touch my MCP registries"
 * switch without also suppressing Codex hooks.
 */
export function autoWireCodex(
  opts: {
    registerMcp?: boolean;
    hooksPathOverride?: string;
    configPathOverride?: string;
    homeDeps?: HomeResolutionDeps;
    mlaPath?: string;
    exec?: CodexExecFn;
  } = {},
): CodexWireOutcome {
  const registerMcp = opts.registerMcp !== false;

  let hooks: { result?: ReconcileResult; error?: string };
  try {
    hooks = {
      result: ensureCodexHooks({
        hooksPathOverride: opts.hooksPathOverride,
        homeDeps: opts.homeDeps,
        mlaPath: opts.mlaPath,
      }),
    };
  } catch (e) {
    hooks = { error: e instanceof Error ? e.message : String(e) };
  }

  const mcp = registerMcp
    ? ensureCodexMcpServer({
        mlaPath: opts.mlaPath,
        homeDeps: opts.homeDeps,
        configPathOverride: opts.configPathOverride,
        exec: opts.exec,
      })
    : {
        action: "skipped" as const,
        configPath: opts.configPathOverride ?? codexConfigPath(opts.homeDeps),
        detail: "--no-mcp",
      };

  return { hooks, mcp };
}
