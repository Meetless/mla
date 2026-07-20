/**
 * Derive the file paths a tool call will WRITE.
 *
 * WHY THIS EXISTS (the 2026-07-11 bypass). The forbidden-root rule family says
 * "never create or edit any file under <root>/" — a statement about a PATH. But the
 * enforcement seam gated on `applicability.tools` (["Write","Edit"]) and the hook
 * matcher was `^(Write|Edit)$`, so the rule was really "never create a file under
 * <root>/ *using two specific tools*". Our own benchmark caught an agent stepping
 * around it in a single move:
 *
 *     Write  notes/design.md   -> DENIED by the governed rule
 *     Bash   cat > notes/design.md   -> succeeded; hook never fired
 *
 * The block stopped the model that was going to comply anyway and failed to stop the
 * one that wasn't. A rule about a path must be enforced on every tool that can write
 * that path, so this module answers one question for ANY tool call: which paths would
 * this write?
 *
 * HONEST SCOPE. The shell parser is BEST-EFFORT and cannot be otherwise: a shell can
 * obfuscate a path arbitrarily (variables, base64, python -c, eval). It covers the
 * forms an agent actually reaches for — redirects, tee, cp/mv, sed -i, dd, touch,
 * install — and is deliberately OVER-inclusive at the margins, because a false
 * positive costs a confused agent one retry while a false negative costs the
 * guarantee. The PostToolUse sweep is the backstop that does NOT depend on parsing:
 * it diffs the filesystem, so a command this parser misses is still reverted.
 */

export type ToolCallLike = { toolName: string; toolInput: Record<string, unknown> };

/** Tools that can create or modify a file, and the input field carrying the path. */
const DIRECT_PATH_FIELD: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** True for any tool that can put bytes on disk (used to scope enforcement). */
export function isWriteCapableTool(toolName: string): boolean {
  return toolName in DIRECT_PATH_FIELD || toolName === "Bash" || toolName === "apply_patch";
}

/**
 * Extract every path changed by Codex's native `apply_patch` tool. Codex sends
 * the whole patch in `tool_input.command`; file operations are introduced by
 * stable patch headers. `Move to` is a second write target in addition to the
 * preceding Update path.
 */
export function applyPatchWriteTargets(command: string): string[] {
  if (typeof command !== "string" || command.length === 0) return [];
  const out: string[] = [];
  const header = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
  const move = /^\*\*\* Move to:\s*(.+?)\s*$/gm;
  for (const re of [header, move]) {
    for (const match of command.matchAll(re)) {
      const target = match[1]?.trim();
      if (target) out.push(target);
    }
  }
  return [...new Set(out)];
}

// Strip quoting so `cat > "notes/a.md"` and `cat > 'notes/a.md'` resolve to the same
// path. Only the wrapping quotes are removed; the path itself is left untouched.
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

// A shell word: a quoted string, or a run of non-space, non-redirect characters.
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;|&<>()]+)`;

/**
 * Redirections: `> f`, `>> f`, `1> f`, `2>> f`, `&> f`.
 * Deliberately NOT matched: `<` (read), `>&1` / `>&2` (fd dup, not a path).
 */
const REDIRECT_RE = new RegExp(String.raw`(?:^|[\s;|&(])\d*&?>>?\s*(${WORD})`, "g");

/** Commands whose *destination* argument is written. Each entry: [name, how to pick]. */
const TEE_RE = new RegExp(String.raw`(?:^|[\s;|&(])tee\s+(?:-a\s+|--append\s+)?((?:${WORD}\s*)+)`, "g");
const SED_INPLACE_RE = new RegExp(String.raw`(?:^|[\s;|&(])sed\s+[^;|&]*?-i(?:\s|\b)[^;|&]*?(${WORD})\s*(?:$|[;|&])`, "g");
const DD_OF_RE = new RegExp(String.raw`(?:^|[\s;|&(])dd\s+[^;|&]*?\bof=(${WORD})`, "g");
const TOUCH_RE = new RegExp(String.raw`(?:^|[\s;|&(])touch\s+((?:${WORD}\s*)+)`, "g");
// cp/mv/install/rsync/ln: the LAST word is the destination.
const COPYLIKE_RE = new RegExp(String.raw`(?:^|[\s;|&(])(?:cp|mv|install|rsync|ln)\s+((?:${WORD}\s+)+${WORD})`, "g");

function pushWords(out: string[], blob: string): void {
  for (const m of blob.match(new RegExp(WORD, "g")) ?? []) {
    const w = unquote(m);
    if (w && !w.startsWith("-")) out.push(w);
  }
}

/**
 * Best-effort: the paths a shell command would write. Over-inclusive by design.
 */
export function shellWriteTargets(command: string): string[] {
  if (typeof command !== "string" || command.length === 0) return [];
  const out: string[] = [];

  for (const m of command.matchAll(REDIRECT_RE)) {
    const w = unquote(m[1]);
    // `>&2` / `>&1` are fd duplications, not files.
    if (w && !/^&?\d+$/.test(w)) out.push(w);
  }
  for (const m of command.matchAll(TEE_RE)) pushWords(out, m[1]);
  for (const m of command.matchAll(TOUCH_RE)) pushWords(out, m[1]);
  for (const m of command.matchAll(SED_INPLACE_RE)) {
    const w = unquote(m[1]);
    if (w && !w.startsWith("-")) out.push(w);
  }
  for (const m of command.matchAll(DD_OF_RE)) {
    const w = unquote(m[1]);
    if (w) out.push(w);
  }
  for (const m of command.matchAll(COPYLIKE_RE)) {
    const words: string[] = [];
    pushWords(words, m[1]);
    // destination = last non-flag word (`cp a b c dir/` writes into dir/)
    if (words.length >= 2) out.push(words[words.length - 1]);
  }

  // Dedupe, preserve order.
  return [...new Set(out)];
}

/**
 * Every path this tool call would write. `[]` for read-only tools.
 *
 * For Write/Edit/MultiEdit/NotebookEdit this is the declared path field (exactly what
 * the seam evaluated before, so their behaviour is unchanged). For apply_patch it is
 * every file-operation header in the patch. For Bash it is the best-effort shell
 * parse — the surface that used to be a free pass.
 */
export function deriveWriteTargets(call: ToolCallLike): string[] {
  const field = DIRECT_PATH_FIELD[call.toolName];
  if (field) {
    const v = call.toolInput?.[field];
    return typeof v === "string" && v.length > 0 ? [v] : [];
  }
  if (call.toolName === "Bash") {
    const cmd = call.toolInput?.command;
    return typeof cmd === "string" ? shellWriteTargets(cmd) : [];
  }
  if (call.toolName === "apply_patch") {
    const cmd = call.toolInput?.command;
    return typeof cmd === "string" ? applyPatchWriteTargets(cmd) : [];
  }
  return [];
}
