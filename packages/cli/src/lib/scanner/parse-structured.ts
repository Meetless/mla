import { Directive, StaleSignal, directiveId } from "./types";
import { parseDirectivesFromMarkdown } from "./parse-directives";

export function parseAdrStatus(text: string, source: string): StaleSignal | null {
  const m = /^\s*Status:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const status = m[1];
  const sup = /superseded\s+by\s+(ADR-?\d+)/i.exec(status);
  if (sup) {
    return {
      id: directiveId(source, `adr_superseded:${status}`),
      source,
      reason: "adr_superseded",
      detail: `${source} is superseded by ${sup[1]}.`,
      supersededBy: sup[1],
    };
  }
  if (/\b(deprecated|superseded|rejected)\b/i.test(status)) {
    return {
      id: directiveId(source, `adr_superseded:${status}`),
      source,
      reason: "adr_superseded",
      detail: `${source} is marked ${status}.`,
    };
  }
  return null;
}

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

export function parseCodeowners(text: string): OwnerRule[] {
  const out: OwnerRule[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    const pattern = parts.shift()!;
    if (!parts.length) continue;
    out.push({ pattern, owners: parts });
  }
  return out;
}

export interface ClaudeRulesFile {
  globs: string[];
  directives: Directive[];
}

export function parseClaudeRulesFile(text: string, source: string): ClaudeRulesFile {
  const globs = parsePathsList(text);
  const bodyStart = text.indexOf("\n---", 4);
  const body = bodyStart === -1 ? text : text.slice(text.indexOf("\n", bodyStart + 1) + 1);
  const directives = parseDirectivesFromMarkdown(body, source).map((d) => ({ ...d, globs }));
  return { globs, directives };
}

// Reads a YAML paths: block list (the one nested structure we care about).
// Stops at any line that is not a list item (e.g. the closing --- fence).
function parsePathsList(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^paths:\s*$/.test(l.trim()));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "") break;
    const m = /^\s*-\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1].replace(/^['"]|['"]$/g, ""));
  }
  return out;
}
