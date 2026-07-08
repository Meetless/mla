import { Directive, directiveId } from "./types";

const MAX_DIRECTIVES_PER_FILE = 40;
const MUST_TOKENS = /\b(MUST|NEVER|ALWAYS|REQUIRED|DO NOT|DON'?T|FORBIDDEN|NON-NEGOTIABLE)\b/i;
// Non-bullet prose must SHOUT the modal (uppercase) to count as a rule; lowercase
// modals appear constantly in natural prose and would be false positives.
const SHOUTED_TOKENS = /\b(MUST|NEVER|ALWAYS|REQUIRED|DO NOT|DON'?T|FORBIDDEN|NON-NEGOTIABLE)\b/;
// A "rule line" is a markdown bullet OR a sentence carrying a normative modal.
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
// Markdown ATX heading. Headings are section structure, never directives; their
// text (e.g. "## DO NOT") is captured noise if treated as a rule.
const ATX_HEADING = /^\s*#{1,6}\s+(.*\S)\s*$/;
// A heading whose wording negates the items beneath it. A "## DO NOT" section
// lists positively-phrased bullets ("Use relative imports...") that MEAN the
// opposite; the negation lives in the heading.
const NEGATION_HEADING = /\b(DO NOT|DON'?T|NEVER|AVOID|FORBIDDEN)\b/i;

export function parseDirectivesFromMarkdown(text: string, source: string): Directive[] {
  const out: Directive[] = [];
  const seen = new Set<string>();
  let underNegationHeading = false;
  for (const rawLine of text.split("\n")) {
    const heading = ATX_HEADING.exec(rawLine);
    if (heading) {
      // Track section sense; the heading itself is never emitted as a rule.
      underNegationHeading = NEGATION_HEADING.test(heading[1]);
      continue;
    }
    const bullet = BULLET.exec(rawLine);
    const candidate = bullet ? bullet[1].trim() : rawLine.trim();
    if (!candidate) continue;
    // A bullet qualifies if it reads imperative; a non-bullet line only qualifies
    // if it carries a strong modal token (keeps prose out).
    const isRule = bullet ? looksImperative(candidate) : SHOUTED_TOKENS.test(candidate);
    if (!isRule) continue;
    // A positive-phrased bullet under a negation heading means the OPPOSITE, so
    // re-render it as an explicit prohibition rather than inject it inverted.
    // Bullets that already carry their own modal are self-contained: keep verbatim
    // (prefixing would double-negate, e.g. "Do not NEVER expose ...").
    let ruleText = candidate;
    if (bullet && underNegationHeading && !MUST_TOKENS.test(candidate)) {
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
      strength: MUST_TOKENS.test(norm) ? "MUST_FOLLOW" : "SHOULD_FOLLOW",
      attestation: "human_attested", // committed file => attested (spec commit = attestation)
    });
    if (out.length >= MAX_DIRECTIVES_PER_FILE) break;
  }
  return out;
}

// Imperative heuristic: a strong modal, OR a leading bare verb like "Use/Prefer/Avoid/Run".
function looksImperative(s: string): boolean {
  if (MUST_TOKENS.test(s)) return true;
  return /^(use|prefer|avoid|run|keep|write|ensure|never|always|do not|don'?t)\b/i.test(s);
}
