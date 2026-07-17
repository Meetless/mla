/**
 * The single command registry that the `mla` dispatcher runs on.
 *
 * Before this module, `mla` carried THREE drifting representations of its own
 * command surface: the hand-maintained `USAGE` blob in cli.ts, the per-file
 * `KB_USAGE` / `GRAPH_USAGE` strings, and the dispatch switch itself. A flag
 * could ship in the switch and never reach the help screen (the exact trap
 * `test/lib/cli-help.spec.ts` was written to catch, repeatedly). The fix
 * (proposal §6.3): one registry of `CommandSpec` entries that the dispatcher
 * resolves against AND help renders from, so "documented" and "dispatchable"
 * can never diverge. A metadata-only manifest kept parallel to the switch is
 * the drift trap and is explicitly rejected: the registry the dispatcher runs
 * on IS the registry help renders from.
 *
 * This module is the PURE half (types + rendering + resolution) so it is
 * trivially unit-testable with no handler imports. The COMMANDS array itself
 * (usage blocks + handler wiring) lives in cli.ts next to the run* handlers it
 * dispatches to.
 */

/** One top-level `mla` command and everything the surface knows about it. */
export interface CommandSpec {
  /** The primary command word, e.g. "activate", "kb", "_internal". */
  name: string;
  /**
   * Back-compat / muscle-memory aliases that resolve to this same entry
   * (e.g. `rewire` -> `wire`, `cg` -> `graph`). Never printed as their own
   * catalog rows; the usage block names the alias inline.
   */
  aliases?: string[];
  /** One-line summary. Optional; reserved for future structured help. */
  summary?: string;
  /**
   * The verbatim usage block for this command as it appears on the `mla help`
   * screen: multi-line, 2-space indented, with NO leading or trailing blank
   * line. This is the single source for both `mla help` (all visible blocks
   * concatenated) and `mla help <command>` (this block alone). For a command
   * with subcommands (kb, rules, _internal) the block is the concatenation of
   * every subcommand line, exactly as the operator should read them.
   */
  usage: string;
  /**
   * The dispatch handler. Receives the FULL argv (including the command word at
   * argv[0]) so a handler can reproduce the original switch arm verbatim,
   * including subcommand routing off argv[1].
   */
  handler: (argv: string[]) => number | Promise<number>;
  /**
   * Hidden entries are dispatchable + resolvable but NOT printed on the help
   * screen. Used for removed-command stubs (e.g. `cases`) whose only job is to
   * route the operator to the replacement instead of the generic
   * "Unknown command" error.
   */
  hidden?: boolean;
  /**
   * The dispatcher's generic `mla <command> --help` interception SKIPS this entry
   * and lets the handler answer. Two unrelated reasons to set it, and a new command
   * usually has one of them:
   *
   *   1. A richer screen of its own (kb, graph, enrich, review each print a full
   *      subcommand catalog). Preempting that with the one-block registry view
   *      would be a DOWNGRADE.
   *   2. FREE-TEXT arguments (docs). The generic interception scans for a help flag
   *      ANYWHERE in the args, so `mla docs ask what does -h do` would print the
   *      help screen instead of answering the question. On a documentation surface
   *      that question is not an edge case, it is the point. Such a command must
   *      route its own help through `wantsLeadingHelp` (below), which only honors a
   *      help flag before the prose begins.
   *
   * Either way, the command still answers `--help` at its top level, so coverage of
   * `mla <command> --help` stays complete (T11).
   */
  ownHelp?: boolean;
}

/** The banner + `usage:` label that opens the help screen. */
export const USAGE_HEADER = `mla: Meetless Agent CLI\n\nusage:`;

/**
 * Resolve a command word (or alias) to its spec. Case-sensitive, exact match.
 * Returns undefined for an unknown word so the dispatcher can print the
 * unknown-command error.
 */
export function resolveCommand(
  commands: CommandSpec[],
  name: string,
): CommandSpec | undefined {
  return commands.find(
    (c) => c.name === name || (c.aliases?.includes(name) ?? false),
  );
}

/**
 * Render the full `mla help` screen: the banner, then every VISIBLE command's
 * usage block in registry order. Hidden entries (removed-command stubs) are
 * omitted. The trailing newline matches a normal template-literal usage string.
 */
export function renderUsage(commands: CommandSpec[]): string {
  const blocks = commands.filter((c) => !c.hidden).map((c) => c.usage);
  return `${USAGE_HEADER}\n${blocks.join("\n")}\n`;
}

/**
 * Render `mla help <command>` / the single-command view: the banner plus just
 * that command's usage block. Resolves aliases (so `mla help cg` shows the
 * graph block). Returns undefined for an unknown command so the caller can fall
 * back to the full screen.
 */
export function renderCommandHelp(
  commands: CommandSpec[],
  name: string,
): string | undefined {
  const spec = resolveCommand(commands, name);
  if (!spec) return undefined;
  return `${USAGE_HEADER}\n${spec.usage}\n`;
}

/**
 * Levenshtein edit distance between two short command words. Iterative two-row
 * form (O(min) memory); only ever called on the error path against a handful of
 * command names, so the constant factors are irrelevant. Pure and total.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(
        prev[j] + 1, // deletion
        prev[j - 1] + 1, // insertion
        diag + (a[i - 1] === b[j - 1] ? 0 : 1), // substitution
      );
      diag = tmp;
    }
  }
  return prev[n];
}

/**
 * The up-to-`limit` command names nearest (by edit distance) to a typo'd word,
 * for a concise "did you mean" on the unknown-command path (proposal §3 bug 1).
 * This is the antidote to the self-amplifying failure where an error path dumps
 * the whole catalog: a wrong guess costs one short line, not forty pasteable
 * commands. Matches are gated by a length-proportional distance threshold so
 * genuine gibberish yields an empty list (the caller then just points at `mla
 * help`) rather than a misleading suggestion. Hidden entries (removed-command
 * stubs) and aliases are excluded; we only ever suggest a real, visible verb.
 * Pure, so the copy is asserted verbatim in tests.
 */
export function nearestCommands(
  commands: CommandSpec[],
  name: string,
  limit = 3,
): string[] {
  const threshold = Math.max(2, Math.ceil(name.length * 0.4));
  return commands
    .filter((c) => !c.hidden)
    .map((c) => ({ name: c.name, distance: levenshtein(name, c.name) }))
    .filter((x) => x.distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((x) => x.name);
}

/**
 * Is `--help` / `-h` a plea for help, for a command whose arguments are FREE TEXT?
 *
 * The dispatcher's generic interception matches `--help` ANYWHERE in the args,
 * which is right for a command whose every argument is a flag or a subcommand
 * (`mla kb add x --help` is a plea for help, not a document named `--help`). It is
 * WRONG the moment a command takes prose. `mla docs ask what does -h do` splits into
 * three argument tokens, one of which is exactly `-h`, so the scan-anywhere rule
 * eats a legitimate question and prints the help screen instead of answering it.
 * Asking the docs what a flag does is not an exotic case; it is the single most
 * likely thing a user asks a documentation surface.
 *
 * The rule here: a help flag counts only while the free text has NOT started, i.e.
 * in the leading run of subcommand words. `mla docs ask --help` (no question yet) is
 * help; `mla docs ask what does -h do` is a question. Scanning stops at the first
 * token that is neither a help flag nor a known subcommand, because that token is
 * where the prose begins and everything after it belongs to the user.
 *
 * The one ambiguity is a question that is EXACTLY the help flag and nothing else
 * (`mla docs ask -h`): the shell hands us the same tokens either way, so it resolves
 * as help, which is the far likelier intent. The escape hatch is POSIX `--`, which is
 * neither a help flag nor a subcommand: the scan below stops on it and never sees the
 * flag behind it, so `mla docs ask -- -h` is a question. (The handler drops that
 * leading `--`, which Node passes through to argv, before joining the prose.)
 *
 * Commands whose query must be a single quoted token (`mla ask "<query>"`) do not
 * need this: an exact `--help` token there can only be a flag, so the generic scan
 * is already correct for them.
 */
export function wantsLeadingHelp(args: string[], subcommands: string[]): boolean {
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") return true;
    if (!subcommands.includes(arg)) return false;
  }
  return false;
}
