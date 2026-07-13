import { Directive, directiveId } from "./types";

const MAX_DIRECTIVES_PER_FILE = 40;

// Two classes of normative token, and the difference matters.
//
// MODAL: verb-adjacent, so it reads as an instruction in any casing ("must go
// through", "Never create feature branches", "don't mock internal services").
const MODAL_TOKENS = /\b(MUST|NEVER|ALWAYS|DO NOT|DON'?T)\b/i;
// ADJECTIVAL: these are ordinary adjectives in prose. "**Required sign-offs**
// (accountable owners via ownership rules)" is a noun phrase describing a field
// of an object, not an instruction to an agent, and we injected it as a
// MUST_FOLLOW rule for months. An all-caps REQUIRED is an author deliberately
// marking a rule; a capitalized "Required" is just a word. Only honor the shout.
const ADJECTIVAL_TOKENS = /\b(REQUIRED|FORBIDDEN|NON-NEGOTIABLE)\b/;
function carriesRuleToken(s: string): boolean {
  return MODAL_TOKENS.test(s) || ADJECTIVAL_TOKENS.test(s);
}

// Non-bullet prose must SHOUT the modal (uppercase) to count as a rule; lowercase
// modals appear constantly in natural prose and would be false positives.
const SHOUTED_TOKENS = /\b(MUST|NEVER|ALWAYS|REQUIRED|DO NOT|DON'?T|FORBIDDEN|NON-NEGOTIABLE)\b/;
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
// Markdown ATX heading. Headings are section structure, never directives; their
// text (e.g. "## DO NOT") is captured noise if treated as a rule.
const ATX_HEADING = /^\s*#{1,6}\s+(.*\S)\s*$/;
// A heading whose wording negates the items beneath it. A "## DO NOT" section
// lists positively-phrased bullets ("Use relative imports...") that MEAN the
// opposite; the negation lives in the heading.
const NEGATION_HEADING = /\b(DO NOT|DON'?T|NEVER|AVOID|FORBIDDEN)\b/i;
const FENCE = /^\s*(```|~~~)/;

type BlockKind = "heading" | "bullet" | "prose";
interface Block {
  kind: BlockKind;
  text: string;
}

/**
 * Fold a markdown file into logical blocks, undoing hard wrapping.
 *
 * This is the whole point of the module's rewrite. Markdown authors wrap prose at
 * 80 columns, so a line is NOT a unit of meaning. Reading line by line, the
 * governing rule of this very repo
 *
 *   Any question about an **idea, concept, ... "what's the difference between X
 *   and Y"** MUST go through `meetless__retrieve_knowledge` first, then open the
 *   citations that matter with `meetless__kb_doc_detail`.
 *
 * was extracted as the fourth of its five lines, verbatim:
 *
 *   about Y", "what's the difference between X and Y"** MUST go through
 *
 * an incoherent fragment, stamped MUST_FOLLOW, injected into every session. A
 * rule the agent cannot parse is worse than no rule: it burns context and teaches
 * the reader that the injected block is noise.
 *
 * Blocks end at a blank line, a heading, or the start of a new bullet. An indented
 * continuation line belongs to the block above it. Fenced code is skipped whole:
 * a shell snippet is not an instruction, however loudly it shouts.
 */
export function toBlocks(text: string): Block[] {
  const out: Block[] = [];
  let inFence = false;
  let cur: Block | null = null;

  const flush = () => {
    if (cur && cur.text.trim()) out.push({ kind: cur.kind, text: cur.text.trim() });
    cur = null;
  };

  for (const raw of text.split("\n")) {
    if (FENCE.test(raw)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!raw.trim()) {
      flush();
      continue;
    }
    const heading = ATX_HEADING.exec(raw);
    if (heading) {
      flush();
      out.push({ kind: "heading", text: heading[1].trim() });
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (bullet) {
      flush();
      cur = { kind: "bullet", text: bullet[1].trim() };
      continue;
    }
    // A wrapped PARAGRAPH continues on the next flush-left line, so rejoin it. A
    // BULLET only continues on an INDENTED line: a flush-left line after a bullet
    // is the next paragraph, and swallowing it would weld narrative onto the rule
    // ("Use pnpm, not npm. Some narrative prose that is not a rule.").
    if (cur && (cur.kind === "prose" || /^\s+\S/.test(raw))) {
      cur.text += " " + raw.trim();
      continue;
    }
    flush();
    cur = { kind: "prose", text: raw.trim() };
  }
  flush();
  return out;
}

// Split a paragraph into sentences so a rule is emitted whole and alone: the
// sentence carrying the modal, not the 400-word paragraph around it and not a
// wrapped shard of it. Deliberately naive (a lookbehind on terminal punctuation
// followed by a capital); "e.g." mid-sentence is the known cost, and an
// over-split sentence is still a coherent clause, which a wrapped line never was.
function toSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z*`"'([])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseDirectivesFromMarkdown(text: string, source: string): Directive[] {
  const out: Directive[] = [];
  const seen = new Set<string>();
  let underNegationHeading = false;

  for (const block of toBlocks(text)) {
    if (block.kind === "heading") {
      // Track section sense; the heading itself is never emitted as a rule.
      underNegationHeading = NEGATION_HEADING.test(block.text);
      continue;
    }

    // A bullet qualifies if it reads imperative; prose only qualifies sentence by
    // sentence, and only when it SHOUTS the modal (keeps ordinary prose out).
    const candidates =
      block.kind === "bullet"
        ? bulletCandidates(block.text)
        : toSentences(block.text).filter((s) => SHOUTED_TOKENS.test(s));

    for (let candidate of candidates) {
      if (TRAILING_COLON.test(candidate)) {
        const body = candidate.replace(TRAILING_COLON, "").trim();
        // Nothing but a lead-in; the sub-list beneath it is scanned on its own.
        if (DANGLING_TOKEN.test(body)) continue;
        // A real rule that happened to introduce a code block: keep it, drop the colon
        // so the injected rule does not read as if it were cut off.
        candidate = body;
      }
      // A positive-phrased bullet under a negation heading means the OPPOSITE, so
      // re-render it as an explicit prohibition rather than inject it inverted.
      // Bullets that already carry their own modal are self-contained: keep verbatim
      // (prefixing would double-negate, e.g. "Do not NEVER expose ...").
      let ruleText = candidate;
      if (block.kind === "bullet" && underNegationHeading && !carriesRuleToken(candidate)) {
        ruleText = "Do not " + candidate.charAt(0).toLowerCase() + candidate.slice(1);
      }
      const norm = ruleText.replace(/\s+/g, " ");
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({
        id: directiveId(source, norm),
        text: norm,
        source,
        kind: "RULE",
        strength: carriesRuleToken(norm) ? "MUST_FOLLOW" : "SHOULD_FOLLOW",
        attestation: "human_attested", // committed file => attested (spec commit = attestation)
      });
      if (out.length >= MAX_DIRECTIVES_PER_FILE) return out;
    }
  }
  return out;
}

/**
 * Which parts of a bullet are actually rules.
 *
 * A one-sentence bullet IS the author's chosen unit; keep it whole. A five-sentence
 * bullet is a paragraph wearing a bullet, and CLAUDE.md is full of them (the auth-mode
 * entries, the deprecation notices). Emit only the sentences that instruct, never the
 * documentation wrapped around them.
 */
function bulletCandidates(bullet: string): string[] {
  const sentences = toSentences(bullet);
  if (sentences.length <= 1) return looksImperative(bullet) ? [bullet] : [];
  return sentences.filter(looksImperative);
}

// Leading EMPHASIS is decoration, not content: "**Never** commit secrets" leads with
// `never` for our purposes. A leading CODE SPAN is not decoration; it is the subject
// of a reference entry ("`run scenarios <diff-id>` — run all 7 scenario scripts"),
// and unwrapping it exposed the verb inside the command name as if it were an order.
const LEADING_EMPHASIS = /^[*_~\s]+/;
const LEADING_IMPERATIVE = /^(use|prefer|avoid|run|keep|write|ensure|never|always|do not|don'?t)\b/i;
// "It MUST:" is a lead-in: the sub-list below it carries the actual rules, and the
// line on its own commands nothing. But a trailing colon alone does NOT make a
// lead-in: "Worker's schema.prisma MUST be a symlink pointing to Control's schema:"
// is a complete rule whose colon merely introduces a code fence. The tell is that a
// lead-in's normative token is its LAST word; a rule keeps going after the token.
const TRAILING_COLON = /:\s*$/;
const DANGLING_TOKEN = /\b(MUST(\s+NOT)?|SHOULD(\s+NOT)?|SHALL|NEVER|ALWAYS|DO(\s+NOT)?|DON'?T)$/i;

// Does this sentence COMMAND, or merely describe?
function looksImperative(s: string): boolean {
  // The author SHOUTED the token. That is a deliberate act; honor it anywhere.
  if (SHOUTED_TOKENS.test(s)) return true;
  // A lowercase deontic modal imposes an obligation wherever it sits in the clause:
  // "Routing and notifications must be precise, batched, configurable."
  if (/\bmust\b/i.test(s)) return true;
  // Lowercase frequency adverbs and bare verbs only command from the LEAD position.
  // Mid-sentence they DESCRIBE: "so an actively-used CLI never re-auths" is a fact
  // about token refresh, and we shipped that whole doc paragraph as a MUST_FOLLOW
  // rule because of that one word.
  return LEADING_IMPERATIVE.test(s.replace(LEADING_EMPHASIS, ""));
}
