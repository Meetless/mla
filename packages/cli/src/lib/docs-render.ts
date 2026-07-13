/**
 * Terminal rendering for the OFFLINE documentation surface (proposal §6.2, T8-T12).
 *
 * Pure string work: every function here takes a corpus and returns text. No fs, no
 * network, no auth, no process. `src/commands/docs.ts` is the thin shell that loads
 * the vendored corpus, calls these, and prints.
 *
 * Rendering contract (§6.2):
 *   - plain stdout, no ANSI, no pager. A 19-page corpus renders fine to a pipe, and
 *     a `PAGER`/`--no-pager` abstraction would add an untested code path for no
 *     proven need (pipe it to your own pager if you want one).
 *   - width-aware: prose re-wraps to the terminal and list items re-wrap with a
 *     hanging indent, but code fences, tables, headings, and blockquotes are copied
 *     byte for byte (re-wrapping a fenced block or a table corrupts it).
 */
import type { DocsDoc, DocsPassage } from "./docs-corpus";

/** Terminal width to render at, clamped so output stays readable in tiny and huge panes. */
export const MIN_WIDTH = 50;
export const MAX_WIDTH = 96;
export const FALLBACK_WIDTH = 80;

/**
 * Words that can never be a topic: they are `docs` SUBCOMMANDS. `mla docs ask` is
 * the AI surface (§7) and `mla docs search` is the lexical one, so neither token is
 * ever resolved as a page, and the alias table below must not mint them.
 *
 * This is why `concepts/ask` gets no short alias: `ask` belongs to the AI surface.
 * The page stays reachable by its full slug (`mla docs concepts/ask`), and the
 * no-question error for `mla docs ask` says so out loud.
 */
export const RESERVED_TOPIC_WORDS = new Set(["ask", "search", "help"]);

/** Hand-added conveniences on top of the derived aliases. Kept tiny on purpose. */
const EXTRA_ALIASES: Record<string, string> = {
  home: "index",
  trust: "concepts/trust-model",
  troubleshoot: "reference/troubleshooting",
};

export interface TopicAliases {
  /** alias -> slug */
  aliases: Map<string, string>;
  /** last-path-segments that collided across two slugs, so no alias was minted */
  collisions: string[];
}

/**
 * Derive the alias table FROM the corpus rather than hand-maintaining one: every
 * slug's last path segment becomes a short alias (`claude-code/onboarding` ->
 * `onboarding`), so a new docs page is addressable the day it lands with no CLI
 * change. A segment claimed by two slugs mints NO alias for either (ambiguous is
 * worse than long), and reserved subcommand words never become aliases.
 */
export function buildTopicAliases(docs: readonly DocsDoc[]): TopicAliases {
  const bySegment = new Map<string, string[]>();
  for (const doc of docs) {
    const segment = doc.slug.split("/").pop() ?? doc.slug;
    if (segment === doc.slug) continue; // a top-level slug is already its own short name
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), doc.slug]);
  }

  const aliases = new Map<string, string>();
  const collisions: string[] = [];
  for (const [segment, slugs] of bySegment) {
    if (RESERVED_TOPIC_WORDS.has(segment)) continue;
    if (slugs.length > 1) {
      collisions.push(segment);
      continue;
    }
    aliases.set(segment, slugs[0]);
  }

  for (const [alias, slug] of Object.entries(EXTRA_ALIASES)) {
    if (RESERVED_TOPIC_WORDS.has(alias)) continue;
    if (!docs.some((d) => d.slug === slug)) continue; // the target page may not exist yet
    if (!aliases.has(alias)) aliases.set(alias, slug);
  }

  return { aliases, collisions };
}

/** Resolve a user-typed topic to a slug: exact slug first, then an alias. */
export function resolveTopic(docs: readonly DocsDoc[], topic: string): string | undefined {
  const wanted = topic.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  if (!wanted) return undefined;
  if (RESERVED_TOPIC_WORDS.has(wanted)) return undefined;
  if (docs.some((d) => d.slug === wanted)) return wanted;
  return buildTopicAliases(docs).aliases.get(wanted);
}

/**
 * Topics whose slug or title share a token with the miss, so an unknown topic can
 * say "did you mean" instead of dumping all 19 pages. Cheap prefix/substring match:
 * the corpus is 19 rows, and a real fuzzy metric would be more machinery than the
 * problem deserves.
 */
export function suggestTopics(docs: readonly DocsDoc[], topic: string, limit = 3): string[] {
  const needle = topic.trim().toLowerCase();
  if (!needle) return [];
  const hits = docs
    .filter((d) => {
      const hay = `${d.slug} ${d.title}`.toLowerCase();
      // The leaf ("ask" of "concepts/ask") catches the reverse direction: a user who
      // typed something LONGER than the slug. Guard the empty leaf, or `includes("")`
      // would match every doc and the suggestion list would be pure noise.
      const leaf = d.slug.split("/").pop() ?? "";
      return hay.includes(needle) || (leaf !== "" && needle.includes(leaf));
    })
    .map((d) => d.slug);
  return hits.slice(0, limit);
}

/** The width to render at: the caller's terminal, clamped, with a fallback for pipes. */
export function resolveWidth(columns: number | undefined): number {
  const raw = typeof columns === "number" && columns > 0 ? columns : FALLBACK_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, raw));
}

/** Wrap one paragraph of prose to `width`, preserving its leading indent. */
function wrapParagraph(text: string, width: number): string[] {
  const indentMatch = /^\s*/.exec(text);
  const indent = indentMatch ? indentMatch[0] : "";
  const words = text.trim().split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (indent.length + candidate.length > width && line) {
      out.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(indent + line);
  return out.length > 0 ? out : [""];
}

/** The bullet or number that opens a list item, e.g. "  - " or "1. ". */
const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/;

/**
 * A line whose structure must survive verbatim: re-wrapping it would corrupt it.
 * Lists are NOT in this set (they wrap with a hanging indent instead); a table or
 * a fence or a heading is corrupted by any reflow at all, so it is copied through
 * even when it overruns a narrow terminal.
 */
function isVerbatim(line: string): boolean {
  return (
    /^\s*>/.test(line) || // blockquote
    /^\s*\|/.test(line) || // table row
    /^\s*#{1,6}\s/.test(line) || // heading
    /^\s{4,}\S/.test(line) // indented code (checked AFTER the list-continuation case)
  );
}

/**
 * Re-wrap markdown prose to `width`.
 *
 *   - fenced code, tables, headings, and blockquotes are copied BYTE FOR BYTE
 *     (reflowing any of them corrupts it, and a long code line is better truncated
 *     by the terminal than silently rearranged),
 *   - list items re-wrap with a HANGING INDENT, so a long bullet stays a bullet,
 *   - consecutive prose lines are joined into a paragraph FIRST and then wrapped,
 *     so a source file hard-wrapped at 80 re-flows correctly into a 60-column pane
 *     instead of double-wrapping into ragged fragments.
 */
export function wrapMarkdown(markdown: string, width: number): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let item: { prefix: string; text: string[] } | null = null;
  let inFence = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(...wrapParagraph(paragraph.join(" "), width));
    paragraph = [];
  };
  const flushItem = () => {
    if (!item) return;
    const hang = " ".repeat(item.prefix.length);
    const wrapped = wrapParagraph(item.text.join(" "), Math.max(20, width - item.prefix.length));
    out.push(...wrapped.map((l, i) => (i === 0 ? item!.prefix + l : hang + l)));
    item = null;
  };
  const flush = () => {
    flushParagraph();
    flushItem();
  };

  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      flush();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      out.push("");
      continue;
    }

    const listMatch = LIST_ITEM.exec(line);
    if (listMatch) {
      flush();
      item = { prefix: listMatch[1], text: [listMatch[2]] };
      continue;
    }
    // An indented line under an open list item is that item's continuation, not a
    // new paragraph: fold it in so the item wraps as one unit.
    if (item && /^\s+\S/.test(line)) {
      item.text.push(line.trim());
      continue;
    }

    if (isVerbatim(line)) {
      flush();
      out.push(line);
      continue;
    }
    flushItem();
    paragraph.push(line);
  }
  flush();

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** `mla docs` (no topic): every page, its title, and its frontmatter description. */
export function renderTopicList(docs: readonly DocsDoc[], width: number): string {
  const sorted = [...docs].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const slugWidth = Math.max(...sorted.map((d) => d.slug.length), 4);
  const { aliases } = buildTopicAliases(docs);
  const shortFor = new Map<string, string>();
  for (const [alias, slug] of aliases) if (!shortFor.has(slug)) shortFor.set(slug, alias);

  const lines: string[] = ["Documentation topics:", ""];
  for (const doc of sorted) {
    const gutter = " ".repeat(slugWidth + 4);
    lines.push(`  ${doc.slug.padEnd(slugWidth)}  ${doc.title}`);
    for (const l of wrapParagraph(doc.description ?? "", Math.max(20, width - gutter.length))) {
      if (l.trim()) lines.push(`${gutter}${l}`);
    }
    const short = shortFor.get(doc.slug);
    if (short) lines.push(`${gutter}(also: mla docs ${short})`);
    lines.push("");
  }
  lines.push("Read one:   mla docs <topic>");
  lines.push('Search:     mla docs search "<terms>"');
  lines.push('Ask:        mla docs ask "<question>"   (needs `mla login`)');
  return lines.join("\n");
}

/** `mla docs <topic>`: the page, reassembled from its passages in document order. */
export function renderTopic(
  doc: DocsDoc,
  passages: readonly DocsPassage[],
  width: number,
): string {
  const body = passages
    .filter((p) => p.slug === doc.slug)
    .map((p) => wrapMarkdown(p.markdown, width))
    .filter((s) => s.length > 0)
    .join("\n\n");

  const head = [`# ${doc.title}`, "", ...wrapParagraph(doc.description ?? "", width)]
    .join("\n")
    .trim();

  return [head, "", body, "", `(docs/${doc.slug} | https://meetless.ai/docs/${doc.slug})`]
    .join("\n")
    .trim();
}

export interface RenderableHit {
  passageId: string;
  slug: string;
  title: string;
  headingPath: string[];
  score: number;
  snippet: string;
}

/** `mla docs search "<terms>"`: ranked passage hits with their snippet. */
export function renderSearchHits(
  query: string,
  hits: readonly RenderableHit[],
  width: number,
): string {
  if (hits.length === 0) {
    return [
      `No documentation matches ${JSON.stringify(query)}.`,
      "",
      "Try `mla docs` for the topic list, or ask in your own words:",
      `  mla docs ask ${JSON.stringify(query)}`,
    ].join("\n");
  }

  const lines: string[] = [
    `${hits.length} match${hits.length === 1 ? "" : "es"} for ${JSON.stringify(query)}:`,
    "",
  ];
  for (const hit of hits) {
    // The heading path minus the page title: the title is already on the slug line.
    // This ONE line must not wrap (it is the address you retype), so it truncates.
    const where = hit.headingPath.slice(1).join(" > ");
    const location = `  ${hit.slug}${where ? ` > ${where}` : ""}`;
    lines.push(location.length <= width ? location : `${location.slice(0, width - 1)}…`);
    for (const l of wrapParagraph(hit.snippet, Math.max(20, width - 6))) {
      if (l.trim()) lines.push(`      ${l}`);
    }
    lines.push("");
  }
  lines.push("Read one:   mla docs <topic>");
  return lines.join("\n");
}

/** The miss path for `mla docs <unknown>`: never a bare error, always a way forward. */
export function renderUnknownTopic(docs: readonly DocsDoc[], topic: string): string {
  const lines = [`No documentation topic named ${JSON.stringify(topic)}.`];
  const suggestions = suggestTopics(docs, topic);
  if (suggestions.length > 0) {
    lines.push("", "Did you mean:");
    for (const s of suggestions) lines.push(`  mla docs ${s}`);
  }
  lines.push("", "List every topic:  mla docs");
  lines.push(`Search the docs:   mla docs search ${JSON.stringify(topic)}`);
  return lines.join("\n");
}
