/**
 * Intel /v1/ask mode handlers for the meetless__query MCP tool.
 *
 * Extracted from server.js so the mode routing (answer / search / canonical /
 * compare) is unit-testable with an injected fetch, matching the
 * relationship_actions.js + status_fallback.js convention. This module reads
 * NO env: the caller (server.js) supplies intelBaseUrl, apiKey,
 * defaultWorkspaceId, the INDEX.md matcher, and the statusFallback rule.
 *
 * Bugs fixed here (2026-05-20 ingest-eval dogfood run):
 *
 *   #1 Workspace override. intelAsk previously hardcoded the env workspace
 *      (MEETLESS_WORKSPACE_ID), so an MCP caller could NEVER target another
 *      workspace even though the tool schema advertised a workspace_id arg.
 *      Every query silently resolved against the single env workspace, which
 *      made per-workspace work (evals, multi-tenant inspection) impossible and
 *      produced answers grounded in the wrong corpus. Each mode now honors a
 *      per-call workspace_id and falls back to defaultWorkspaceId.
 *
 *   #2/#3 search + canonical no-INDEX-match fallback used to send
 *      mode:"search" to intel, which only accepts "answer" | "draft_response"
 *      and replied 422 (literal_error). Both now run an answer-mode retrieval
 *      and drop the synthesized prose, returning the grounded citations as
 *      `results`. (intel has no retrieval-only endpoint today; running answer
 *      and discarding the prose is the honest, low-risk way to expose
 *      retrieval until a dedicated /v1/retrieve lands. The extra synthesis
 *      cost is acceptable for the fallback-ladder use of search.)
 */

import { randomUUID } from "node:crypto";

// ---------- Intel client -----------------------------------------------------

/**
 * Build an intelAsk closure bound to a base URL + INTERNAL_API_KEY. Returns an
 * async ({question, workspaceId, mode, filters, maxResults, minResults}) =>
 * parsed JSON; throws on non-2xx with a body snippet. fetchImpl is injectable
 * so tests stub the intel surface without a live server.
 */
export function makeIntelAsk({ intelBaseUrl, apiKey, fetchImpl = fetch }) {
  return async function intelAsk({
    question,
    workspaceId,
    mode = "answer",
    filters = {},
    maxResults = 8,
    minResults = 3,
    asOf,
    submissionId,
  }) {
    const payload = {
      workspace_id: workspaceId,
      question,
      surface: "mcp",
      stream: false,
      language: "en",
      thread_text: null,
      mode,
      filters,
      max_results: maxResults,
      min_results: minResults,
    };
    // The delivery key. Intel turns it into `mcp:<submission_id>:answer` and hands
    // it to Control, so a re-delivered request collapses onto the one money
    // authorization it already opened instead of buying the run twice.
    //
    // The CALLER's key wins, because only the caller knows what a "delivery" is:
    // `mla mcp` mints one per tool call, so a replayed tool call reuses it. The
    // fallback mint covers callers that pass nothing (today: `mla ask`, where a
    // process invocation IS the delivery). It never leaves the key empty: an ask
    // with no key is a keyless spend, and Control denies those.
    payload.submission_id = submissionId ?? randomUUID();
    // B9: a VALID-time point-in-time cutoff (intel AskRequest.as_of). The MLA
    // front-end (`mla ask --as-of T`) sets it; the MCP front-end never does, so
    // when absent the body stays byte-identical to today.
    if (asOf !== undefined && asOf !== null) {
      payload.as_of = asOf;
    }

    const res = await fetchImpl(`${intelBaseUrl}/v1/ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`intel /v1/ask ${res.status}: ${body.slice(0, 400)}`);
    }
    return await res.json();
  };
}

export function normalizeIntelResponse(raw, mode) {
  // Map intel's response shape into the §D2 contract. intel returns note
  // citations as {type:"note", note_path, note_title}; diffs/threads carry
  // their own ids. We coalesce across both naming schemes.
  const results = (raw.results || raw.citations || []).map((r) => ({
    path: r.path || r.note_path || r.source_path || null,
    title: r.title || r.note_title || r.diff_title || null,
    docType: r.docType || r.doc_type || r.type || "note",
    status: r.status || r.note_status || "UNKNOWN",
    canonical: !!r.canonical,
    superseded: !!(r.superseded || r.note_superseded_by),
    headingPath: r.headingPath || r.heading_path || [],
    snippet: r.snippet || r.content_snippet || r.content || "",
    whyRelevant: r.whyRelevant || r.why_relevant || null,
    lastModifiedOrDate:
      r.lastModifiedOrDate || r.note_date || r.last_modified || null,
  }));
  return {
    mode,
    answer: raw.answer || null,
    confidence: raw.confidence || "medium",
    results,
    warnings: raw.warnings || [],
  };
}

// ---------- Mode handlers ----------------------------------------------------

/**
 * Build the four query-mode handlers. Dependencies:
 *   - intelAsk: from makeIntelAsk (or a test stub).
 *   - defaultWorkspaceId: env MEETLESS_WORKSPACE_ID fallback.
 *   - matchCanonical: INDEX.md topic matcher (server.js owns the fs/loadIndex).
 *   - statusFallback: the A6 warning-synthesis rule.
 */
export function makeAskModes({
  intelAsk,
  defaultWorkspaceId,
  matchCanonical,
  statusFallback,
}) {
  // Bug #1: every mode resolves the effective workspace the same way.
  const wsOf = (args) => args.workspace_id || defaultWorkspaceId;

  async function runAnswer(args) {
    const filters = args.filters || {};
    const raw = await intelAsk({
      question: args.query,
      workspaceId: wsOf(args),
      mode: "answer",
      filters,
      maxResults: args.maxResults ?? 8,
      minResults: args.minResults ?? 3,
      asOf: args.as_of,
      submissionId: args.submission_id,
    });
    const out = normalizeIntelResponse(raw, "answer");
    const fb = statusFallback(out.results, filters, args.minResults ?? 3);
    out.warnings = [...out.warnings, ...fb.warnings];
    return out;
  }

  async function runSearch(args) {
    const filters = args.filters || {};
    // Bug #2: intel has no "search" mode. Run answer-mode retrieval and drop
    // the prose; the grounded citations ARE the search results.
    const raw = await intelAsk({
      question: args.query,
      workspaceId: wsOf(args),
      mode: "answer",
      filters,
      maxResults: args.maxResults ?? 8,
      minResults: args.minResults ?? 3,
      asOf: args.as_of,
      submissionId: args.submission_id,
    });
    const out = normalizeIntelResponse(raw, "search");
    out.answer = null; // search is retrieval-only
    const fb = statusFallback(out.results, filters, args.minResults ?? 3);
    out.warnings = [...out.warnings, ...fb.warnings];
    return out;
  }

  async function runCanonical(args) {
    const match = matchCanonical(args.query);
    if (match.matches.length === 0) {
      // Bug #3: no INDEX.md hit -> retrieval fallback. Must NOT use mode:search
      // (intel 422s). Run answer-mode, drop prose, keep citations.
      const filters = { ...(args.filters || {}), canonical: true };
      const raw = await intelAsk({
        question: args.query,
        workspaceId: wsOf(args),
        mode: "answer",
        filters,
        maxResults: args.maxResults ?? 8,
        minResults: args.minResults ?? 3,
        asOf: args.as_of,
        submissionId: args.submission_id,
      });
      const out = normalizeIntelResponse(raw, "canonical");
      out.answer = null;
      out.warnings = [
        ...out.warnings,
        "no INDEX.md match; fell back to retrieval with canonical hint",
      ];
      return out;
    }
    if (match.matches.length > 1) {
      return {
        mode: "canonical",
        answer: null,
        confidence: "low",
        results: match.matches.map((m) => ({
          path: m.path,
          title: m.topic,
          docType: "note",
          status: m.status,
          canonical: true,
          superseded: false,
          headingPath: [],
          snippet: null,
          whyRelevant: `INDEX.md topic "${m.topic}" matched via ${match.reason}`,
          lastModifiedOrDate: m.lastReviewed,
        })),
        warnings: [
          `ambiguous canonical match: ${match.matches.length} entries matched via ${match.reason}: ${match.matches
            .map((m) => m.path)
            .join(", ")}`,
        ],
      };
    }
    // Unique match. Synthesize an answer scoped (best-effort) to that path.
    const winner = match.matches[0];
    const filters = {
      ...(args.filters || {}),
      paths: [winner.path],
    };
    const raw = await intelAsk({
      question: args.query,
      workspaceId: wsOf(args),
      mode: "answer",
      filters,
      maxResults: args.maxResults ?? 4,
      minResults: 1,
      asOf: args.as_of,
      submissionId: args.submission_id,
    });
    const out = normalizeIntelResponse(raw, "canonical");
    // Guarantee the canonical winner is present, flagged canonical:true, and
    // leads the results, whether or not intel ALSO returned it as a plain
    // retrieval hit. If intel returned it (common when the query is close to
    // the doc's own content), intel's row carries canonical:false; stamping it
    // here is what makes a `canonical === true` filter find the source of truth.
    const idx = out.results.findIndex((r) => r.path === winner.path);
    if (idx === -1) {
      out.results.unshift({
        path: winner.path,
        title: winner.topic,
        docType: "note",
        status: winner.status,
        canonical: true,
        superseded: false,
        headingPath: [],
        snippet: null,
        whyRelevant: `INDEX.md topic "${winner.topic}" matched via ${match.reason}`,
        lastModifiedOrDate: winner.lastReviewed,
      });
    } else {
      // Keep intel's richer snippet/heading context, but assert canonicality
      // (INDEX.md metadata wins for the known fields) and float it to the front.
      const existing = out.results[idx];
      out.results.splice(idx, 1);
      out.results.unshift({
        ...existing,
        canonical: true,
        title: existing.title || winner.topic,
        status: winner.status || existing.status,
        whyRelevant:
          existing.whyRelevant ||
          `INDEX.md topic "${winner.topic}" matched via ${match.reason}`,
        lastModifiedOrDate: existing.lastModifiedOrDate || winner.lastReviewed,
      });
    }
    return out;
  }

  async function runCompare(args) {
    // Compare returns evidence only: canonical + any PROPOSED on the same
    // topic. Pure INDEX.md lookup; no intel call.
    const match = matchCanonical(args.query);
    const proposed = [];
    let canonical = null;
    if (match.matches.length > 0) {
      canonical =
        match.matches.find((m) => m.status === "SHIPPED") || match.matches[0];
      for (const m of match.matches) {
        if (m.status === "PROPOSED" && m.path !== (canonical && canonical.path)) {
          proposed.push(m);
        }
      }
    }
    return {
      mode: "compare",
      canonical: canonical
        ? {
            path: canonical.path,
            title: canonical.topic,
            status: canonical.status,
            canonical: true,
          }
        : null,
      proposed: proposed.map((p) => ({
        path: p.path,
        title: p.topic,
        status: p.status,
        canonical: false,
      })),
      results: [
        ...(canonical
          ? [
              {
                path: canonical.path,
                title: canonical.topic,
                docType: "note",
                status: canonical.status,
                canonical: true,
                superseded: false,
                headingPath: [],
                snippet: null,
                whyRelevant: "INDEX.md canonical",
                lastModifiedOrDate: canonical.lastReviewed,
              },
            ]
          : []),
        ...proposed.map((p) => ({
          path: p.path,
          title: p.topic,
          docType: "note",
          status: p.status,
          canonical: false,
          superseded: false,
          headingPath: [],
          snippet: null,
          whyRelevant: "INDEX.md proposed candidate",
          lastModifiedOrDate: p.lastReviewed,
        })),
      ],
      warnings: [
        "compare mode returns evidence only; synthesis is the caller's job via mode='answer'",
      ],
    };
  }

  return { runAnswer, runSearch, runCanonical, runCompare };
}
