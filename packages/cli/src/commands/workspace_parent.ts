// `mla workspace parent [show | set <id> | unset | default <id> | default --clear]`
//
// The parent-context binding for the workspace this folder is bound to
// (notes/20260816-scoped-truth-hierarchy-roadmap.md, E1.4).
//
// WHY THERE IS NO AUTO-PARENTING.
// The roadmap assumed `mla activate` could silently place a new repo under the
// caller's PERSONAL workspace. That workspace does not reliably exist: since the
// P4 account cutover (INV-ACC-3) logging in creates an Account and NOTHING else,
// and INV-ACC-4 says a workspace is born only from an explicit act. Measured on
// the dogfood install: 69 REPO workspaces, 3 TEAM, and exactly ONE PERSONAL.
// Guessing a root from `kind = 'PERSONAL'` would therefore pick nothing for
// almost everyone and, for the one who has it, pick it without being asked.
//
// So the daily-friction fix is a REMEMBERED CHOICE instead of a guess:
//
//     mla workspace parent default <id>     # once
//     mla activate                          # every new repo, inherits it
//
// One explicit decision, then zero friction forever. `--parent <id>` on activate
// overrides it per-invocation, and `--parent none` opts a single repo out.
import {
  CFG_PATH,
  configExists,
  loadWorkspaceConfig,
  readConfig,
  writeConfig,
  type CliConfig,
  type WorkspaceCliConfig,
} from "../lib/config";
import { del, get, post, serverMessageOrRaw, type HttpError } from "../lib/http";

export const WORKSPACE_PARENT_USAGE =
  "Usage: mla workspace parent [show | set <workspace-id> | unset | default <workspace-id> | default --clear]";

export interface ChainEntry {
  workspaceId: string;
  distance: number;
  name: string | null;
  slug: string | null;
}
interface ChainResponse {
  workspaceId: string;
  chain: ChainEntry[];
}

export interface ParentDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  loadConfig?: (override?: string) => WorkspaceCliConfig;
  readCfg?: () => CliConfig;
  writeCfg?: (cfg: CliConfig) => void;
  cfgExists?: () => boolean;
  http?: {
    get?: typeof get;
    post?: typeof post;
    del?: typeof del;
  };
}

/**
 * Render the chain as an indented tree, nearest scope first.
 *
 * The label is the point: a human reading their agent's context needs to know
 * which statements are theirs and which arrived from a broader scope. Distance
 * is shown, never a precedence claim, because a parent rule is not weaker for
 * being further away.
 */
export function renderChain(chain: ChainEntry[]): string {
  if (chain.length <= 1) {
    return [
      "Parent context: none",
      "",
      "This workspace grounds agents from its own knowledge only.",
      "Place it inside a broader context with:  mla workspace parent set <workspace-id>",
    ].join("\n");
  }
  const lines = ["Parent context:"];
  for (const entry of chain) {
    const label = entry.name ?? entry.workspaceId;
    const marker = entry.distance === 0 ? "* " : "  ";
    lines.push(
      `${"  ".repeat(entry.distance)}${marker}${label}  ${
        entry.distance === 0 ? "(this workspace)" : `[${entry.workspaceId}]`
      }`,
    );
  }
  lines.push("");
  lines.push(
    `Agents here ground from ${chain.length} scope${chain.length === 1 ? "" : "s"}: ` +
      "this workspace and its ancestors. Sibling workspaces are never included.",
  );
  return lines.join("\n");
}

async function runShow(deps: ParentDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)();
  } catch (e) {
    err(`workspace parent: ${(e as Error).message}`);
    return 2;
  }
  try {
    const res = await (deps.http?.get ?? get)<ChainResponse>(
      cfg,
      `/internal/v1/workspace-hierarchy/chain?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
      8000,
    );
    out(renderChain(res.chain ?? []));
    const stored = (deps.readCfg ?? readConfig)().defaultParentWorkspaceId;
    if (stored) {
      out("");
      out(`New workspaces from \`mla activate\` will attach under: ${stored}`);
    }
    return 0;
  } catch (e) {
    err(`workspace parent failed: ${serverMessageOrRaw(e as HttpError)}`);
    return 1;
  }
}

async function runSet(argv: string[], deps: ParentDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const target = (argv[0] ?? "").trim();
  if (!target || target.startsWith("-")) {
    err(`workspace parent set needs a workspace id\n${WORKSPACE_PARENT_USAGE}`);
    return 2;
  }
  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)();
  } catch (e) {
    err(`workspace parent set: ${(e as Error).message}`);
    return 2;
  }
  if (target === cfg.workspaceId) {
    err("A workspace cannot be its own parent context.");
    return 2;
  }
  try {
    await (deps.http?.post ?? post)(
      cfg,
      "/internal/v1/workspace-hierarchy/parent",
      { workspaceId: cfg.workspaceId, parentWorkspaceId: target },
      15000,
    );
    out(`This workspace now operates inside ${target}.`);
    out(
      "Its agents will ground from that workspace's knowledge as well as their own. " +
        "Nothing was copied: the parent stays the single source of what it owns.",
    );
    return 0;
  } catch (e) {
    err(`workspace parent set failed: ${serverMessageOrRaw(e as HttpError)}`);
    return 1;
  }
}

async function runUnset(deps: ParentDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  let cfg: WorkspaceCliConfig;
  try {
    cfg = (deps.loadConfig ?? loadWorkspaceConfig)();
  } catch (e) {
    err(`workspace parent unset: ${(e as Error).message}`);
    return 2;
  }
  try {
    const res = await (deps.http?.del ?? del)<{ detachedFrom: string | null }>(
      cfg,
      `/internal/v1/workspace-hierarchy/parent?workspaceId=${encodeURIComponent(cfg.workspaceId)}`,
      15000,
    );
    if (!res?.detachedFrom) {
      out("This workspace had no parent context; nothing changed.");
      return 0;
    }
    out(`Detached from ${res.detachedFrom}.`);
    out(
      "This workspace keeps everything it owns. It simply stops inheriting that " +
        "context, so its agents no longer see the parent's knowledge.",
    );
    return 0;
  } catch (e) {
    err(`workspace parent unset failed: ${serverMessageOrRaw(e as HttpError)}`);
    return 1;
  }
}

/**
 * The remembered default for FUTURE activations. Stored in cli-config, which is
 * per-machine and per-human, so it never travels in a committed marker and never
 * decides anything for a teammate.
 */
async function runDefault(argv: string[], deps: ParentDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  if (!(deps.cfgExists ?? configExists)()) {
    err(`workspace parent default: cli-config.json not found at ${CFG_PATH}. Run \`mla login\` first.`);
    return 2;
  }
  const readCfg = deps.readCfg ?? readConfig;
  const writeCfg = deps.writeCfg ?? writeConfig;

  if (argv.includes("--clear")) {
    const cfg = readCfg();
    delete cfg.defaultParentWorkspaceId;
    writeCfg(cfg);
    out("Cleared. New workspaces will be created with no parent context.");
    return 0;
  }
  const target = (argv[0] ?? "").trim();
  if (!target || target.startsWith("-")) {
    const current = readCfg().defaultParentWorkspaceId;
    out(
      current
        ? `New workspaces from \`mla activate\` attach under: ${current}`
        : "No default parent context set. New workspaces start with no inherited context.",
    );
    out(WORKSPACE_PARENT_USAGE);
    return 0;
  }
  const cfg = readCfg();
  cfg.defaultParentWorkspaceId = target;
  writeCfg(cfg);
  out(`Every workspace \`mla activate\` creates from now on will attach under ${target}.`);
  out("Override per repo with `mla activate --parent <id>`, or opt one out with `--parent none`.");
  return 0;
}

export async function runWorkspaceParent(
  argv: string[],
  deps: ParentDeps = {},
): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "show") return runShow(deps);
  if (sub === "set") return runSet(rest, deps);
  if (sub === "unset") return runUnset(deps);
  if (sub === "default") return runDefault(rest, deps);
  (deps.err ?? ((l: string) => console.error(l)))(
    `Unknown parent subcommand: ${sub}\n${WORKSPACE_PARENT_USAGE}`,
  );
  return 2;
}
