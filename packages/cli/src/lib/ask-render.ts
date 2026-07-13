/**
 * The plain-text presenter shared by every ASK-shaped answer the CLI renders
 * (proposal 20260711 §7.4, T21).
 *
 * There are two ask surfaces and they must LOOK the same, because to the reader
 * they are the same act: you asked, something answered, and here is what it stood
 * on.
 *
 *   `mla ask`       -> the user's governed memory (their workspace, their data)
 *   `mla docs ask`  -> the mla product documentation (ours, identical for everyone)
 *
 * They are two corpora that are NEVER merged (§7.1), so they are two commands and
 * two backends. What they share is the SHAPE of an answer: prose, then the
 * citations it rests on, then whatever the caller needs to know about the run. One
 * presenter, so the two can never drift into looking like different products.
 *
 * The contract is deliberately structural, not typed to either caller: a result is
 * a bag of optional fields, and every section renders only if its field is there.
 * That is what lets `mla docs ask` reuse it without carrying a `confidence` (its
 * server result deliberately has none: an answer is cited or it is an abstention,
 * and a number in between would be a number we made up).
 */

/**
 * A citation field is "meaningful" only if it is a non-empty string that is not
 * the "UNKNOWN" sentinel ask-core stamps when intel returns no value. Keeps noise
 * (`[UNKNOWN]`) out of the rendered citation line.
 */
export function meaningful(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.toUpperCase() === "UNKNOWN") return null;
  return t;
}

/**
 * The bracketed metadata after a citation path: the doc KIND (docType, which
 * ask-core always sets, defaulting to "note") and, when present, the lifecycle
 * STATUS (SHIPPED/PROPOSED/...). Kind-first, status-when-real: before this,
 * rendering `status` alone printed a useless `[UNKNOWN]` on every grounded note.
 */
export function citationMeta(r: Record<string, unknown>): string {
  const parts = [meaningful(r.docType), meaningful(r.status)].filter(
    (x): x is string => x !== null,
  );
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}

/**
 * Render an ask result as plain text.
 *
 * Recognized fields (all optional):
 *   answer      string   the prose
 *   results     array    citations: { path | title, docType?, status?, hint? }
 *   warnings    array    printed verbatim, one per line
 *   workspace   string   \
 *   mode        string    > the footer, built ONLY from the fields present
 *   confidence  string   /
 *
 * `hint` is the one field `mla ask` never sets: docs citations use it to print the
 * command and the URL that open the cited page, so a citation is a place you can
 * actually go rather than an id you have to trust.
 */
export function renderPlain(result: Record<string, unknown>): string {
  const lines: string[] = [];

  const answer = result.answer;
  if (typeof answer === "string" && answer.trim()) {
    lines.push(answer.trim());
    lines.push("");
  }

  const results = Array.isArray(result.results) ? (result.results as Record<string, unknown>[]) : [];
  if (results.length > 0) {
    lines.push(`Citations (${results.length}):`);
    for (const r of results) {
      const p = r.path ?? r.title ?? "(unknown)";
      lines.push(`  - ${String(p)}${citationMeta(r)}`);
      const hint = meaningful(r.hint);
      if (hint) lines.push(`      ${hint}`);
    }
  }

  const warnings = Array.isArray(result.warnings) ? (result.warnings as unknown[]) : [];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of warnings) lines.push(`  ! ${String(w)}`);
  }

  // The footer carries only what the surface actually knows. `mla ask` sets all
  // three; `mla docs ask` sets none, and an empty `(workspace: , mode: )` would be
  // a lie dressed as metadata.
  const footer: string[] = [];
  for (const key of ["workspace", "mode", "confidence"] as const) {
    const v = result[key];
    const s = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v);
    if (s) footer.push(`${key}: ${s}`);
  }
  if (footer.length > 0) {
    lines.push("");
    lines.push(`(${footer.join(", ")})`);
  }

  return lines.join("\n");
}
