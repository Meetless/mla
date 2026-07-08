/**
 * INDEX.md canonical-topic matcher.
 *
 * Lifted verbatim out of meetless-mcp/server.js so BOTH front-ends (the MCP
 * server and the `mla` CLI) import the SAME matcher instead of one copying the
 * other. This module reads NO env: the caller supplies `notesRoot` (the
 * directory that holds INDEX.md). The per-instance mtime cache lives inside the
 * closure returned by makeMatchCanonical, so two front-ends in the same process
 * never share or clobber each other's cache.
 *
 * Behavior is unchanged from the original server.js implementation:
 *   Rule 1 exact topic -> Rule 2 alias -> Rule 3 substring fallback. A missing
 *   INDEX.md yields an empty match set (callers fall back to retrieval), so a
 *   front-end with no notes checkout degrades gracefully rather than throwing.
 */

import fs from "node:fs";
import path from "node:path";

export function normalizeTopic(s) {
  return (s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Build a matchCanonical(query) closure bound to a notes root. The INDEX.md
 * parse is cached by file mtime so repeated calls in a long-lived MCP process
 * do not re-read the file every query; a short-lived `mla ask` invocation reads
 * it at most once.
 *
 * @param {{notesRoot: string}} deps
 * @returns {(query: string) => {matches: Array, reason: string}}
 */
export function makeMatchCanonical({ notesRoot }) {
  let indexCache = null;
  let indexCacheMtime = 0;

  function loadIndex() {
    const indexPath = path.join(notesRoot, "INDEX.md");
    if (!fs.existsSync(indexPath)) {
      return [];
    }
    const stat = fs.statSync(indexPath);
    if (indexCache && indexCacheMtime === stat.mtimeMs) {
      return indexCache;
    }
    const raw = fs.readFileSync(indexPath, "utf-8");
    const rows = [];
    for (const line of raw.split("\n")) {
      const m = line.match(
        /^\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/,
      );
      if (!m) continue;
      const [, topic, aliases, canonicalPath, status, reviewed] = m;
      if (topic.toLowerCase() === "topic" || /^[-:\s]+$/.test(topic)) {
        continue;
      }
      rows.push({
        topic: topic.trim(),
        topicNorm: normalizeTopic(topic),
        aliases: aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
        aliasNorms: aliases
          .split(",")
          .map((a) => normalizeTopic(a))
          .filter(Boolean),
        path: canonicalPath.trim(),
        status: status.trim().toUpperCase() || "UNKNOWN",
        lastReviewed: reviewed.trim(),
      });
    }
    indexCache = rows;
    indexCacheMtime = stat.mtimeMs;
    return rows;
  }

  return function matchCanonical(query) {
    const rows = loadIndex();
    const q = normalizeTopic(query);
    if (!q) return { matches: [], reason: "empty query" };

    // Rule 1: exact topic match.
    const exact = rows.filter((r) => r.topicNorm === q);
    if (exact.length > 0) {
      return { matches: exact, reason: "exact topic" };
    }
    // Rule 2: alias match.
    const aliasHits = rows.filter((r) => r.aliasNorms.includes(q));
    if (aliasHits.length > 0) {
      return { matches: aliasHits, reason: "alias" };
    }
    // Rule 3: substring fallback over topic + aliases.
    const sub = rows.filter(
      (r) =>
        r.topicNorm.includes(q) ||
        q.includes(r.topicNorm) ||
        r.aliasNorms.some((a) => a.includes(q) || q.includes(a)),
    );
    if (sub.length > 0) {
      return { matches: sub, reason: "substring" };
    }
    return { matches: [], reason: "no INDEX.md match" };
  };
}
