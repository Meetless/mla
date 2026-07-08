/**
 * Phase 0 regression (memo notes/20260624-mla-new-user-value-and-brownfield-proof.md,
 * lines 450-457): the canonical onboarding doc (20260611-onboarding-mla.md) must be
 * retrievable through the SAME MCP path the product uses, so it stops 404-ing via our
 * own MCP. Exit condition: the doc is returned with the correct source citation.
 *
 * Why this test is LIVE-GATED (skipped unless MEETLESS_LIVE_KB=1):
 *   - The onboarding doc lives in the notes vault, a SEPARATE git repo that is not in
 *     the meetless-cli CI checkout. There is no way to assert against the real doc in a
 *     hermetic unit test without faking the very thing we are checking.
 *   - Retrieval requires a live intel backend + the dogfood workspace.
 *   So a stubbed-fetch version would prove nothing. The honest artifact is a real
 *   end-to-end probe that an operator (or a live job) runs against the dogfood stack;
 *   in CI it skips loudly with the reason, it does not silently pass.
 *
 * It exercises the exact product path: runRetrieveKnowledge -> intel POST /v1/ask/retrieve
 * (the same handler server.js binds for meetless__retrieve_knowledge). The unit-level
 * plumbing of that handler is already covered by evidence_actions.test.js with a stub;
 * this file adds the one missing thing a stub cannot: that the doc is actually in the KB.
 *
 * Run live:
 *   MEETLESS_LIVE_KB=1 \
 *   MEETLESS_WORKSPACE_ID=<dogfood ws> \
 *   INTERNAL_API_KEY=<internal key> \
 *   node --test evidence_actions.live.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { runRetrieveKnowledge } from "./evidence_actions.js";
import { makeIntelFetch } from "./kb_actions.js";

const LIVE = process.env.MEETLESS_LIVE_KB === "1";

// The canonical onboarding doc's vault-relative slug. retrieve_knowledge emits note
// citations as `NT:<vault-path>` (see kb_actions.js NOTE_CITATION_PREFIX), so a faithful
// match looks for this slug inside a candidate citation.
const ONBOARDING_SLUG = "20260611-onboarding-mla";

// A natural-language query the onboarding doc uniquely answers (it documents the
// recommended `mla activate` flow and calls it "the magic moment"). Retrieval is
// semantic, so we ask the way a new user would, not by filename.
const ONBOARDING_QUERY =
  "What is the recommended mla onboarding and activate flow for a new user?";

/** Resolve live wiring from env exactly as buildDepsFromEnv does. Fail LOUD (not skip) */
/* when live mode is requested but a required var is missing: opting in means asserting. */
function liveDeps() {
  const workspaceId = process.env.MEETLESS_WORKSPACE_ID;
  const intelBaseUrl =
    process.env.MEETLESS_INTEL_URL ||
    process.env.INTEL_BASE_URL ||
    "http://127.0.0.1:8100";
  const apiKey =
    process.env.MEETLESS_CONTROL_TOKEN || process.env.INTERNAL_API_KEY;
  assert.ok(
    workspaceId,
    "MEETLESS_LIVE_KB=1 requires MEETLESS_WORKSPACE_ID (the dogfood workspace)",
  );
  assert.ok(
    apiKey,
    "MEETLESS_LIVE_KB=1 requires INTERNAL_API_KEY (or MEETLESS_CONTROL_TOKEN)",
  );
  return {
    intelFetch: makeIntelFetch({ baseUrl: intelBaseUrl, apiKey }),
    defaultWorkspaceId: workspaceId,
  };
}

test(
  "canonical onboarding doc is retrievable via the live MCP retrieve path with its source citation",
  { skip: LIVE ? false : "set MEETLESS_LIVE_KB=1 to run (needs live intel + dogfood workspace)" },
  async () => {
    const deps = liveDeps();
    const out = await runRetrieveKnowledge(
      { query: ONBOARDING_QUERY, limit: 12 },
      deps,
    );

    assert.equal(out.tool, "meetless__retrieve_knowledge");
    assert.ok(out.count > 0, "expected at least one evidence candidate, got none");

    // The exit condition: the onboarding doc surfaces WITH the correct source citation.
    const hit = out.candidates.find(
      (c) => typeof c.citation === "string" && c.citation.includes(ONBOARDING_SLUG),
    );
    assert.ok(
      hit,
      `expected a candidate citing ${ONBOARDING_SLUG}; got citations: ` +
        JSON.stringify(out.candidates.map((c) => c.citation)),
    );
    // The citation must be a note citation (NT:<path>), the artifact the product opens
    // with kb_doc_detail -- not a decision-diff (DD:) or thread (TH:) lookalike.
    assert.ok(
      hit.citation.startsWith("NT:"),
      `onboarding citation should be a note (NT:) citation, got "${hit.citation}"`,
    );
  },
);
