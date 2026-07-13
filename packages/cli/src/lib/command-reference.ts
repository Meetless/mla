/**
 * The machine-owned command-reference region (proposal §6.3, T6).
 *
 * The website's command page groups commands by purpose in hand-written prose.
 * That prose stays curated. This module owns exactly ONE fenced region of that
 * page: the exhaustive command index, rendered from the SAME `COMMANDS` registry
 * the dispatcher runs on. A command therefore cannot appear in the index without
 * being runnable, nor be runnable without appearing there.
 *
 * Pure string work only (no fs, no paths) so it is trivially testable and so the
 * CLI bundle never pulls it in: nothing under `src/cli.ts` imports it. The fs
 * half lives in `scripts/gen-command-reference.ts`, and the freshness gate lives
 * in `test/lib/command-registry.spec.ts`.
 *
 * Only the bytes BETWEEN the markers are ever rewritten. Anything outside them,
 * including the curated tables, is preserved byte for byte.
 */
import type { CommandSpec } from "./command-registry";

/**
 * `{/* ... *\/}` (an MDX flow expression) rather than an HTML comment: the docs
 * tree is parsed as MDX (Starlight components, `remark-mdx`), where HTML comments
 * are a parse error, and the docs-corpus generator drops `mdxFlowExpression`
 * nodes outright, so these markers never leak into a corpus passage.
 */
export const BEGIN_MARKER =
  "{/* BEGIN GENERATED: mla-command-index. Machine-owned. Do not edit by hand: run `pnpm gen:command-reference` in meetless-cli/packages/cli. */}";
export const END_MARKER = "{/* END GENERATED: mla-command-index */}";

/** Escape a GFM table cell: a literal `|` would otherwise end the cell early. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * Render the index rows for every VISIBLE command, in registry order (which is
 * also help-screen order). Hidden entries (removed-command redirect stubs) are
 * dispatchable but deliberately undocumented, so they are omitted here exactly
 * as they are omitted from `renderUsage`.
 */
export function renderCommandIndex(commands: readonly CommandSpec[]): string {
  const rows = commands
    .filter((c) => !c.hidden)
    .map((c) => {
      const names = [c.name, ...(c.aliases ?? [])].map((n) => `\`mla ${n}\``).join(" / ");
      if (!c.summary) {
        // A visible command with no summary is a hard error, not an empty cell.
        throw new Error(`Command "${c.name}" is on the help screen but has no summary.`);
      }
      return `| ${names} | ${cell(c.summary)} |`;
    });
  return ["| Command | What it does |", "| --- | --- |", ...rows].join("\n");
}

/** Splice a freshly rendered index into the page, preserving everything else. */
export function spliceCommandIndex(page: string, index: string): string {
  const begin = page.indexOf(BEGIN_MARKER);
  const end = page.indexOf(END_MARKER);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(
      "Machine-owned command-index markers not found (or out of order). Expected:\n" +
        `${BEGIN_MARKER}\n...\n${END_MARKER}`,
    );
  }
  const head = page.slice(0, begin + BEGIN_MARKER.length);
  const tail = page.slice(end);
  return `${head}\n\n${index}\n\n${tail}`;
}
