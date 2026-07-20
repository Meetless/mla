import * as fs from "fs";
import * as path from "path";

// Deterministic, in-place reconciliation of a Claude-Code-shaped hook settings
// file (`~/.claude/settings.json` for Claude, `$CODEX_HOME/hooks.json` for
// Codex: identical schema). This is the connector-neutral core of the algorithm
// that lives inline in `ensureClaudeSettings` (wire.ts). It is factored out so a
// SECOND connector (Codex) can reuse the exact same merge semantics (the
// double-hook dedup, the conservative multi-hook preservation, the
// write-only-on-change discipline) without duplicating the load-bearing logic
// or coupling to Claude's `MANAGED_HOOK_SCRIPTS` / script-path commands.
//
// The two connectors differ only in what they inject: Claude registers
// `hooks/<script>.sh` command PATHS keyed by `isManagedHookCommand`; Codex
// registers `mla _internal <subcommand>` command TOKENS keyed by its own
// predicate. Both express that difference through the `wanted` list and the
// `isOurs` predicate below; the merge itself is shared and identical.
//
// One deliberate policy seam: `onParseError`. Claude treats an unparseable
// settings file as `{}` and rewrites it ("reset"); Codex refuses to overwrite a
// malformed `$CODEX_HOME/hooks.json` and throws ("throw", the §7 test-4
// contract). The core supports both so each caller keeps its own contract.

/** A single hook entry we want present in the file. */
export interface WantedHook {
  /** Event name, e.g. "PreToolUse", "UserPromptSubmit". */
  event: string;
  /** Optional matcher regex string. Empty string when the event has no matcher. */
  matcher?: string;
  /** The exact `command` string to write (already quoted/escaped by the caller). */
  command: string;
  /** Optional per-hook timeout (seconds), written verbatim into the entry. */
  timeout?: number;
}

export interface ReconcileOptions {
  /**
   * How to handle a file whose JSON does not parse.
   *  - "reset": treat the file as `{}` and rewrite it (Claude settings.json).
   *  - "throw": refuse to overwrite; raise so the operator can inspect it
   *    (Codex hooks.json §7 test 4: a malformed file must NOT be clobbered).
   * Defaults to "reset" to match the historical `ensureClaudeSettings` behavior.
   */
  onParseError?: "reset" | "throw";
  /**
   * Snapshot the file just before an actual overwrite. Called only when the file
   * already existed AND the serialized content changed, so an idempotent rewire
   * makes no backup. Mirrors `backupAndPruneSettings`.
   */
  backup?: (filePath: string) => void;
}

export interface ReconcileResult {
  /** Events for which a brand-new managed entry was appended. */
  added: string[];
  /** The file that was reconciled. */
  filePath: string;
  /** True when the file content actually changed on disk. */
  changed: boolean;
}

/**
 * Reconcile the managed hooks in `filePath` to exactly `wanted`, identifying our
 * own prior entries via `isOurs(command, event)` and leaving every user/
 * third-party hook untouched. Idempotent: a second call with the same inputs
 * writes nothing.
 */
export function reconcileHookFile(
  filePath: string,
  wanted: WantedHook[],
  isOurs: (command: string, event: string) => boolean,
  opts: ReconcileOptions = {},
): ReconcileResult {
  const onParseError = opts.onParseError ?? "reset";

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Read the current file (if any) WITHOUT backing it up yet. We only snapshot
  // right before an actual overwrite (below), so a no-op rewire leaves no backup.
  let current: string | null = null;
  let existing: any = {};
  if (fs.existsSync(filePath)) {
    current = fs.readFileSync(filePath, "utf8");
    try {
      existing = JSON.parse(current);
    } catch (err) {
      if (onParseError === "throw") {
        throw new Error(
          `Refusing to overwrite ${filePath}: it exists but is not valid JSON ` +
            `(${(err as Error).message}). Fix or remove the file, then re-run. ` +
            `Meetless will not clobber a hand-edited or corrupt hook file.`,
        );
      }
      existing = {};
    }
  }
  // A file that parses to a non-object (e.g. a bare array or string) is not a
  // settings document. Under "throw" that is just as unsafe to clobber as bad
  // JSON; under "reset" we start fresh, matching the historical behavior.
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    if (onParseError === "throw") {
      throw new Error(
        `Refusing to overwrite ${filePath}: its top-level JSON is not an object. ` +
          `Fix or remove the file, then re-run.`,
      );
    }
    existing = {};
  }
  if (!existing.hooks || typeof existing.hooks !== "object" || Array.isArray(existing.hooks)) {
    existing.hooks = {};
  }

  const added: string[] = [];
  for (const w of wanted) {
    const cmd = w.command;
    const list: any[] = Array.isArray(existing.hooks[w.event]) ? existing.hooks[w.event] : [];

    // An entry is EXCLUSIVELY ours when it carries a single managed command for
    // THIS event. Matching on `isOurs` (never an exact string) is what prevents
    // the double-hook bug: a registration written with a different but still-ours
    // command form is recognized and reconciled in place instead of appended.
    const isOursExclusive = (entry: any): boolean => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      if (hooks.length !== 1) return false;
      const c = hooks[0];
      return (
        c?.type === "command" &&
        typeof c?.command === "string" &&
        isOurs(c.command, w.event)
      );
    };

    const ours = list.filter(isOursExclusive);
    if (ours.length > 0) {
      // Reconcile in place: keep the first ours-entry, canonicalize its command
      // and matcher, and drop any other ours-entries so duplicates collapse to
      // one. Operator-merged multi-hook entries are never ours (length check
      // above), so they are never touched.
      const keeper = ours[0];
      const keeperCmd: any = { type: "command", command: cmd };
      if (typeof w.timeout === "number") keeperCmd.timeout = w.timeout;
      keeper.hooks = [keeperCmd];
      if (typeof w.matcher === "string") keeper.matcher = w.matcher;
      const drop = new Set(ours.slice(1));
      existing.hooks[w.event] = list.filter((e) => !drop.has(e));
      continue;
    }

    // No exclusively-ours entry. If an operator merged a managed command for
    // this event into a multi-hook entry, it is already present: do not
    // duplicate, do not rewrite its matcher (conservative: never edit a
    // multi-hook entry the operator owns).
    const presentInMultiHook = list.some(
      (entry) =>
        Array.isArray(entry?.hooks) &&
        entry.hooks.some(
          (h: any) =>
            h?.type === "command" &&
            typeof h?.command === "string" &&
            isOurs(h.command, w.event),
        ),
    );
    if (presentInMultiHook) continue;

    const hookCmd: any = { type: "command", command: cmd };
    if (typeof w.timeout === "number") hookCmd.timeout = w.timeout;
    list.push({
      matcher: w.matcher ?? "",
      hooks: [hookCmd],
    });
    existing.hooks[w.event] = list;
    added.push(w.event);
  }

  // Only touch disk when the wiring actually changed. An idempotent rewire
  // serializes byte-identical to what is on disk, so it writes nothing and
  // creates no backup.
  const next = JSON.stringify(existing, null, 2) + "\n";
  const changed = next !== current;
  if (changed) {
    if (current !== null && opts.backup) opts.backup(filePath);
    fs.writeFileSync(filePath, next, "utf8");
  }
  return { added, filePath, changed };
}

/**
 * Remove every managed entry (identified by `isOurs`) from a Claude-shaped hook
 * file, preserving all user/third-party hooks and empty-out events with no
 * remaining entries. Connector-scoped uninstall: it edits ONLY the file, never
 * the shared `~/.meetless/hooks/*.sh` scripts. Returns whether anything changed.
 */
export function removeManagedHookEntries(
  filePath: string,
  isOurs: (command: string, event: string) => boolean,
  opts: { backup?: (filePath: string) => void } = {},
): { changed: boolean; filePath: string } {
  if (!fs.existsSync(filePath)) return { changed: false, filePath };
  const current = fs.readFileSync(filePath, "utf8");
  let doc: any;
  try {
    doc = JSON.parse(current);
  } catch {
    // A malformed file is not ours to rewrite on an uninstall path either.
    return { changed: false, filePath };
  }
  if (!doc || typeof doc !== "object" || !doc.hooks || typeof doc.hooks !== "object") {
    return { changed: false, filePath };
  }

  for (const event of Object.keys(doc.hooks)) {
    const list = doc.hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list
      .map((entry: any) => {
        if (!entry || !Array.isArray(entry.hooks)) return entry;
        // Drop any managed command from within an entry; keep the rest.
        const hooks = entry.hooks.filter(
          (h: any) =>
            !(
              h?.type === "command" &&
              typeof h?.command === "string" &&
              isOurs(h.command, event)
            ),
        );
        if (hooks.length === 0) return null; // whole entry was ours
        return { ...entry, hooks };
      })
      .filter((e: any) => e !== null);
    if (kept.length === 0) {
      delete doc.hooks[event];
    } else {
      doc.hooks[event] = kept;
    }
  }

  const next = JSON.stringify(doc, null, 2) + "\n";
  if (next === current) return { changed: false, filePath };
  if (opts.backup) opts.backup(filePath);
  fs.writeFileSync(filePath, next, "utf8");
  return { changed: true, filePath };
}
