export interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

// Deliberately tiny: scalar `key: value` lines only. List/block values are
// skipped here; .claude/rules `paths:` lists are parsed by parse-structured.ts.
export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith("---\n")) {
    return { data: {}, body: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    return { data: {}, body: text };
  }
  const raw = text.slice(4, end);
  const afterFence = text.indexOf("\n", end + 1);
  const body = afterFence === -1 ? "" : text.slice(afterFence + 1);

  const data: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):[ \t]+(\S.*?)[ \t]*$/.exec(line);
    if (m) {
      data[m[1]] = unwrapScalar(m[2]);
    }
  }
  return { data, body };
}

// Unwrap a YAML scalar value to its real string. A double-quoted scalar gets the
// standard escapes that occur in real frontmatter (\" -> ", \\ -> \, \n -> newline,
// \t -> tab); a single-quoted scalar gets YAML's doubled-quote rule ('' -> '); a
// plain scalar is returned verbatim. We only unwrap when BOTH ends carry the same
// quote, so a plain value that merely contains a quote is left alone (the earlier
// strip removed a lone leading/trailing quote and left \" backslashes behind, which
// surfaced as stray slashes in the agent-memory advisory list). Full YAML is out of
// scope for this tiny parser; callers normalize whitespace downstream.
function unwrapScalar(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) =>
      c === "n" ? "\n" : c === "t" ? "\t" : c,
    );
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}
