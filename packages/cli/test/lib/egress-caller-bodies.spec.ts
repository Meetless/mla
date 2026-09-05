// One witness body per egress rule, transcribed from the REAL caller.
//
// WHY THIS FILE EXISTS. The registry's `fields` allowlist is a claim about what
// a specific call site sends. Nothing in the codebase forced that claim to be
// true, and it was not: an audit of all 40 rows found 13 whose field lists had
// been written from the ROUTE NAME rather than read from the caller. Because
// the boundary fails closed on an unlisted top-level field, each of those rows
// was not a leak, it was a DEAD COMMAND: `mla kb review --accept` and the kb
// forget/purge cascades were refused at the boundary with `unknown_field`.
//
// Neither existing suite could see it:
//
//   egress-wire-recording.spec.ts   generates its bodies FROM each rule's own
//                                   field list, so a rule and its generated body
//                                   agree by construction. It can prove what the
//                                   policy does to a body; it can never prove
//                                   the body is the one the product sends.
//   the 5735-test CLI suite         command specs inject their transport ABOVE
//                                   http.ts, so no spec drives a real body
//                                   through the real policy.
//
// So the witness has to come from OUTSIDE the registry. Each entry below is
// transcribed by hand from the call site named in its `caller` field, and the
// checks run in both directions:
//
//   body -> fields   applyEgressPolicy accepts the witness. A field the caller
//                    sends and the rule forgot is a dead command; this catches it.
//   fields -> body   every declared field appears in the witness. A field the
//                    rule declares and no caller sends is not harmless padding:
//                    under `preserve` or `passthrough` it is a standing
//                    pre-authorization for the day someone adds a field by that
//                    name, granted by a reviewer who never saw the content.
//
// Each witness is the MAXIMAL body its caller can produce (every optional field
// populated, every alternation branch's fields unioned), because the second
// direction is only meaningful against a maximal body.
//
// Keeping it honest: the completeness test asserts every rule has a witness and
// every witness has a rule, so a row added later cannot quietly opt out, and a
// witness left behind by a deleted row fails instead of rotting.

import { EGRESS_RULES } from "../../src/lib/egress/rules";
import {
  EgressPolicyError,
  EgressService,
  applyEgressPolicy,
} from "../../src/lib/egress/policy";

const ORIGIN: Record<EgressService, string> = {
  control: "https://control.example.test",
  intel: "https://intel.example.test",
  external: "https://external.example.test",
};

interface Witness {
  /** Where the body below was transcribed from. Keep it file:symbol precise. */
  caller: string;
  /** A concrete pathname a real call produces. Checked against the rule regex. */
  path: string;
  /** The maximal body that call site can send. */
  body: Record<string, unknown>;
}

/** Keyed by `${service} ${method} ${match.source}`. */
const WITNESSES: Record<string, Witness> = {
  // ------------------------------------------------------- D0 shadow query
  // The canonical `/v1/query` run beside the legacy Ask. The maximal body is the
  // whole public request schema, not just the field the shadow sends today: this
  // boundary fails closed on an undeclared key, so declaring only `question` would
  // break the moment the shadow threaded a language through.
  [`control POST ${/^\/v1\/query$/.source}`]: {
    caller: "lib/query-shadow.ts runQueryShadow",
    path: "/v1/query",
    body: {
      question: "why did we deprecate the decision diff",
      idempotencyKey: "sub_shadow_1",
      surface: "mcp",
      conversationId: "conv_1",
      language: "en",
      asOf: "2026-08-01T00:00:00Z",
    },
  },
  // ------------------------------------------------------- D3 shadow coordination pull
  // The canonical `/v1/coordination/pull` run beside the legacy session-steer pull. The tier's
  // pull schema is strict and accepts exactly one field, so `sessionId` is the whole maximal
  // body (lib/coordination-shadow.ts runCoordinationShadow).
  [`control POST ${/^\/v1\/coordination\/pull$/.source}`]: {
    caller: "lib/coordination-shadow.ts runCoordinationShadow",
    path: "/v1/coordination/pull",
    body: {
      sessionId: "sess_1",
    },
  },
  // ------------------------------------------------------- E1 shadow turns/prepare
  // The canonical `/v1/turns/prepare` run beside the legacy turn decision. The maximal body is
  // the whole request: the prompt task, the session, and the local-fact signals
  // (lib/turn-prepare-shadow.ts runTurnPrepareShadow).
  [`control POST ${/^\/v1\/turns\/prepare$/.source}`]: {
    caller: "lib/turn-prepare-shadow.ts runTurnPrepareShadow",
    path: "/v1/turns/prepare",
    body: {
      task: "please write a design doc",
      sessionId: "sess_1",
      signals: {
        explicitPaths: ["apps/x.ts"],
        workingSet: ["b.ts"],
        reconcileDigests: [{ path: "CLAUDE.md", digest: "abc" }],
      },
    },
  },
  // ---------------------------------------------------------------- intel ask
  [`intel POST ${/^\/v1\/ask$/.source}`]: {
    caller:
      "lib/mcp-fetchers.ts makeIntelAskFromCli + packages/ask-core/ask_modes.js makeIntelAsk (two builders, byte-compatible)",
    path: "/v1/ask",
    body: {
      workspace_id: "ws_1",
      // The metering actor. Null under shared-key, a workspace_users id under a
      // user token; either way the KEY is always sent, so the witness must
      // declare it or the boundary fails closed on it.
      user_id: "c00exampleuser00000000001",
      question: "why did we deprecate the decision diff",
      surface: "mcp",
      stream: false,
      language: "en",
      thread_text: null,
      mode: "answer",
      filters: {},
      max_results: 8,
      min_results: 3,
      submission_id: "11111111-2222-3333-4444-555555555555",
      // Only `mla ask --as-of T` sets it; omitted keeps the body byte-identical.
      as_of: "2026-07-01T00:00:00.000Z",
    },
  },
  [`intel POST ${/^\/v1\/ask\/retrieve$/.source}`]: {
    caller: "packages/mcp/evidence_actions.js runRetrieveKnowledge",
    path: "/v1/ask/retrieve",
    body: {
      workspace_id: "ws_1",
      query: "coordination case state machine",
      source_context: { surface: "mcp" },
      limit: 12,
    },
  },

  // --------------------------------------------------------------------- auth
  [`control POST ${/^\/internal\/v1\/auth\/token\/refresh$/.source}`]: {
    caller: "lib/http.ts callRefresh",
    path: "/internal/v1/auth/token/refresh",
    body: { refreshToken: "rt_opaque", userAgent: "mla/0.2.27 (darwin)" },
  },
  [`control POST ${/^\/internal\/v1\/auth\/sessions\/revoke$/.source}`]: {
    caller: "commands/logout.ts revokeSession",
    path: "/internal/v1/auth/sessions/revoke",
    body: { sessionId: "sess_1", refreshToken: "rt_opaque" },
  },
  [`control POST ${/^\/internal\/v1\/auth\/cli-login-grants\/exchange$/.source}`]:
    {
      caller: "lib/login.ts exchangeGrant",
      path: "/internal/v1/auth/cli-login-grants/exchange",
      body: {
        code: "grant_code",
        codeVerifier: "pkce_verifier",
        userAgent: "mla/0.2.27 (darwin)",
      },
    },

  // ---------------------------------------------------------------- telemetry
  [`control POST ${/^\/internal\/v1\/analytics\/events$/.source}`]: {
    caller: "lib/analytics/forwarder.ts flush",
    path: "/internal/v1/analytics/events",
    body: {
      workspaceId: "ws_1",
      events: [{ name: "mla_command", properties: { command: "ask" } }],
    },
  },
  [`control POST ${/^\/internal\/v1\/agent-traces\/ingest$/.source}`]: {
    caller: "lib/observability.ts flushTrace",
    path: "/internal/v1/agent-traces/ingest",
    body: {
      workspaceId: "ws_1",
      traceId: "trace_1",
      client: { name: "mla", version: "0.2.27" },
      rootSpan: { name: "mla ask", startedAt: "2026-07-26T00:00:00.000Z" },
      spans: [{ name: "intel.ask", attributes: { question: "hello" } }],
    },
  },
  [`control POST ${/^\/internal\/v1\/evidence\/work-product-capture$/.source}`]:
    {
      caller: "lib/analytics/work-product-seal.ts postSeal",
      path: "/internal/v1/evidence/work-product-capture",
      body: {
        workspaceId: "ws_1",
        injectId: "inj_1",
        captureContractVersion: 1,
        status: "CAPTURED",
        capturedTurnStart: 3,
        capturedTurnEnd: 5,
        truncated: false,
        redactedSubstance: true,
        workProductDigest: { files: ["src/a.ts"], summary: "edited one file" },
      },
    },
  [`intel POST ${/^\/v1\/observability\/turn-recap$/.source}`]: {
    caller: "lib/turn-recap-emit.ts postTurnRecapToIntel",
    path: "/v1/observability/turn-recap",
    body: {
      traceId: "trace_1",
      sessionId: "sess_1",
      turnIndex: 4,
      verdict: "assist",
      footer: "mla: 3 sources",
      notRunReason: null,
      // Projected field by field at the call site on purpose; see the comment
      // there. turn-recap-emit.spec.ts pins the 21 inner keys against the
      // emitted body, which is the check this row cannot make: `recap` is one
      // top-level key here, so passthrough says nothing about its contents.
      recap: { session_id: "sess_1", turn_index: 4, trace_id: "trace_1" },
    },
  },

  // ------------------------------------------------------------- bug + docs
  [`control POST ${/^\/internal\/v1\/bug-reports$/.source}`]: {
    caller: "commands/bug.ts submitReport",
    path: "/internal/v1/bug-reports",
    body: {
      workspaceId: "ws_1",
      objectKey: "bundles/ws_1/abc.tar.gz",
      traceId: "trace_1",
      sessionId: "sess_1",
      mlaVersion: "0.2.27",
      platform: "darwin-arm64",
      redactionSummary: { patterns: 2, spans: 5 },
      title: "mla ask times out",
      message: "it hangs for 60s and then prints nothing",
    },
  },
  [`control POST ${/^\/internal\/v1\/bug-reports\/upload-url$/.source}`]: {
    caller: "commands/bug.ts requestUploadUrl",
    path: "/internal/v1/bug-reports/upload-url",
    body: {
      workspaceId: "ws_1",
      byteLength: 4096,
      contentType: "application/gzip",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  },
  [`control POST ${/^\/internal\/v1\/docs\/ask$/.source}`]: {
    caller: "commands/docs.ts askDocs",
    path: "/internal/v1/docs/ask",
    body: {
      question: "how do I rotate the internal api key",
      corpusHash: "sha256:abc123",
    },
  },

  // ------------------------------------------------------------- adjudication
  [`control POST ${/^\/internal\/v1\/session-conflicts\/[^/]+\/resolve$/.source}`]:
    {
      caller: "commands/conflicts.ts resolveConflict",
      path: "/internal/v1/session-conflicts/cf_1/resolve",
      body: {
        workspaceId: "ws_1",
        outcome: "ACCEPTED",
        rationale: "the newer rule wins, the old one predates the migration",
      },
    },
  [`control POST ${/^\/internal\/v1\/session-conflicts\/[^/]+\/agent-dismiss$/.source}`]:
    {
      caller: "MCP meetless__dismiss_conflict -> lib/mcp-fetchers.ts",
      path: "/internal/v1/session-conflicts/cf_1/agent-dismiss",
      body: {
        rationale: "not applicable to this repo",
        runtimeHint: "claude-code",
      },
    },
  [`control POST ${/^\/internal\/v1\/analytics\/enforcement\/incidents\/[^/]+\/adjudicate$/.source}`]:
    {
      caller: "commands/enforcement.ts defaultAdjudicate",
      path: "/internal/v1/analytics/enforcement/incidents/inc_1/adjudicate",
      body: { verdict: "CONFIRMED", note: "real violation, rule 12" },
    },

  // ------------------------------------------------------- governed artifacts
  [`control POST ${/^\/internal\/v1\/repo-instruction-snapshots$/.source}`]: {
    caller: "lib/rules/repo-instruction-snapshot-client.ts upsertSnapshot",
    path: "/internal/v1/repo-instruction-snapshots",
    body: {
      repositoryId: "repo_1",
      relativePath: "CLAUDE.md",
      normalizedContent: "# Project\n\nWork directly on main.\n",
      normalizedContentHash: "sha256:deadbeef",
      contentNormalizationVersion: 1,
      observedCommitSha: "8c80ec96f",
      observedAt: "2026-07-26T00:00:00.000Z",
      workspaceId: "ws_1",
    },
  },
  [`control POST ${/^\/internal\/v1\/repo-instruction-snapshots\/sweep$/.source}`]: {
    caller: "lib/rules/repo-instruction-snapshot-client.ts sweepRepoInstructionSnapshots",
    path: "/internal/v1/repo-instruction-snapshots/sweep",
    body: {
      repositoryId: "repo_1",
      observedPaths: ["CLAUDE.md", ".claude/rules/floor.md"],
      workspaceId: "ws_1",
    },
  },
  // Three producers share this route, so the maximal body is their union. The
  // entry that used to sit here claimed `commands/kb_add.ts` and had in fact been
  // written from the rule: it carried `captureMethod: "cli"` (no such value; the
  // route accepts only "agent_auto_memory"), `mode: "upsert"` (the field is
  // "file" | "corpus"), a `provenance` OBJECT (every caller sends a string), and
  // it omitted `agentSession` and `corpusName`, which kb_add.ts sends on every
  // invocation. That omission is what made `mla kb add` a dead command.
  // The withdraw sibling of kb/add. It had NO rule at all, so every withdraw the
  // agent-memory pipeline attempted was refused at the boundary with
  // `no egress rule`. Found live 2026-08-06 while exercising Phase 2 capture: a
  // memory file deleted locally, or reclassified to a non-capturable type, could
  // never be withdrawn from the governed KB. It failed every pass, forever, and
  // the retry loop meant it failed silently and repeatedly rather than once
  // loudly. The body below is READ FROM upsert-client.ts:withdraw, not written
  // from the rule (that inversion is what made kb/add dead for months).
  [`intel POST ${/^\/internal\/v1\/kb\/withdraw$/.source}`]: {
    caller: "agent-memory-capture/upsert-client.ts:withdraw",
    path: "/internal/v1/kb/withdraw",
    body: {
      workspaceId: "ws_1",
      actor: "user_1",
      captureMethod: "agent_auto_memory",
      relPath: "agent-memory/bind_1/reference_x.md",
      reason: "reclassified",
    },
  },
  [`intel POST ${/^\/internal\/v1\/kb\/add$/.source}`]: {
    caller:
      "commands/kb_add.ts:baseBody + agent-memory-capture/upsert-client.ts:upsert + commands/enrich.ts:persist",
    path: "/internal/v1/kb/add",
    body: {
      workspaceId: "ws_1",
      actor: "user_1",
      // upsert-client only; the other two producers omit these three.
      captureMethod: "agent_auto_memory",
      bindingId: "bind_1",
      consentedAt: "2026-07-26T00:00:00.000Z",
      // Advisory string on all three; the server derives the recorded value.
      provenance: "agent_distilled",
      profile: "markdown_atomic_v1",
      // kb_add.ts only, canonicalized upstream; undefined when absent, which
      // still puts the key on the object the classifier reads.
      agentSession: "5f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      // kb_add.ts sends "file" | "corpus"; the other two hardcode "file".
      mode: "corpus",
      // kb_add.ts only, and only in corpus mode.
      corpusName: "notes",
      // contentSha256 is sent by upsert-client only.
      documents: [
        { relPath: "notes/x.md", content: "# x\n", contentSha256: "a".repeat(64) },
      ],
    },
  },
  [`intel POST ${/^\/internal\/v1\/kb\/reingest$/.source}`]: {
    caller: "commands/kb_reingest.ts",
    path: "/internal/v1/kb/reingest",
    body: {
      workspaceId: "ws_1",
      actor: "user_1",
      ref: "NT:notes/x.md",
      profile: "full",
      reason: "content drifted from the file on disk",
      agentSession: "sess_1",
      content: "# x\n\nthe whole file body ships here\n",
      documentId: "doc_1",
      relPath: "notes/x.md",
    },
  },

  // ------------------------------------------------------------- kb selectors
  [`control POST ${/^\/internal\/v1\/kb\/retime$/.source}`]: {
    caller: "commands/kb_retime.ts (control target)",
    path: "/internal/v1/kb/retime",
    body: {
      workspaceId: "ws_1",
      sourceItemId: "NT:notes/x.md",
      effectiveDate: "2026-07-01",
      actor: "user_1",
      anchorType: "VALID_FROM",
      reason: "the note was backdated by hand",
    },
  },
  [`intel POST ${/^\/internal\/v1\/kb\/retime$/.source}`]: {
    caller: "commands/kb_retime.ts (intel target)",
    path: "/internal/v1/kb/retime",
    body: {
      workspaceId: "ws_1",
      sourceItemId: "NT:notes/x.md",
      effectiveDate: "2026-07-01",
      actor: "user_1",
      anchorType: "VALID_FROM",
      reason: "the note was backdated by hand",
    },
  },
  [`intel POST ${/^\/internal\/v1\/kb\/(forget|purge)$/.source}`]: {
    caller: "commands/kb_forget.ts + commands/kb_purge.ts (union)",
    path: "/internal/v1/kb/forget",
    body: {
      workspaceId: "ws_1",
      actor: "user_1",
      ref: "NT:notes/x.md",
      relPath: "notes/x.md",
      reason: "superseded by the 2026-07 ruling",
    },
  },
  [`intel POST ${/^\/internal\/v1\/kb\/documents\/[^/]+\/scope$/.source}`]: {
    caller: "commands/kb_scope.ts",
    path: "/internal/v1/kb/documents/doc_1/scope",
    body: {
      scope: "TEAM",
      actorBy: "user_1",
      reason: "the doc is governance, not a personal note",
    },
  },
  [`intel POST ${/^\/internal\/v1\/kb-claims\/[^/]+\/verdict$/.source}`]: {
    caller: "commands/kb_claims.ts postVerdict",
    path: "/internal/v1/kb-claims/claim_1/verdict",
    body: {
      outcome: "CONFIRMED",
      expectedPriorOutcome: "PENDING",
      idempotencyKey: "idem_1",
    },
  },
  [`intel POST ${/^\/internal\/v1\/relation-assertions\/[^/]+\/verdict$/.source}`]:
    {
      caller: "commands/kb_review.ts postAssertionVerdict",
      path: "/internal/v1/relation-assertions/ra_1/verdict",
      body: {
        outcome: "ACCEPTED",
        expectedPriorOutcome: "PENDING",
        actorUserId: "user_1",
        idempotencyKey: "idem_1",
      },
    },

  // ------------------------------------------------------------- workspace
  [`control POST ${/^\/internal\/v1\/workspaces$/.source}`]: {
    caller: "commands/activate.ts provisionWorkspace",
    path: "/internal/v1/workspaces",
    body: { name: "meetless", repoPath: "/Users/dev/projects/meetless" },
  },
  [`control POST ${/^\/internal\/v1\/workspaces\/(deactivate|reactivate)$/.source}`]:
    {
      caller: "lib/control-workspace-lifecycle-client.ts",
      path: "/internal/v1/workspaces/deactivate",
      body: { workspaceId: "ws_1" },
    },
  [`control POST ${/^\/internal\/v1\/workspaces\/members$/.source}`]: {
    caller: "lib/control-workspace-member-client.ts inviteMember",
    path: "/internal/v1/workspaces/members",
    body: { email: "dev@example.test", workspaceId: "ws_1" },
  },

  // ------------------------------------------------------------- session sync
  [`control POST ${/^\/internal\/v1\/agent-runs\/by-session\/[^/]+\/(finalize|archive)$/.source}`]:
    {
      caller: "commands/internal-finalize.ts (finalize branch is the maximal one)",
      path: "/internal/v1/agent-runs/by-session/sess_1/finalize",
      body: {
        workspaceId: "ws_1",
        gitEvidence: {
          topLevel: "/Users/dev/projects/meetless",
          branch: "main",
          trackedModified: ["src/a.ts"],
          lastCommit: "fix: a thing",
          errors: [],
        },
      },
    },
  [`control POST ${/^\/internal\/v1\/session-steers\/by-session\/[^/]+\/pull$/.source}`]:
    {
      caller: "commands/internal-steer-sync.ts realTransport.pull",
      path: "/internal/v1/session-steers/by-session/sess_1/pull",
      body: { workspaceId: "ws_1" },
    },
  [`control POST ${/^\/internal\/v1\/session-steers\/[^/]+\/injected$/.source}`]:
    {
      caller: "commands/internal-steer-sync.ts realTransport.markInjected",
      path: "/internal/v1/session-steers/st_1/injected",
      body: { workspaceId: "ws_1" },
    },

  // --------------------------------------------------- relationship candidates
  [`control POST ${/^\/internal\/v1\/relationship-candidates\/publish-rules$/.source}`]:
    {
      caller: "commands/rules.ts publishRules",
      path: "/internal/v1/relationship-candidates/publish-rules",
      body: {
        workspaceId: "ws_1",
        runtimeScopeId: "scope_1",
        rules: [
          {
            headline: "Work directly on main",
            canonicalPayloadHash: "sha256:abc",
          },
        ],
      },
    },
  [`control POST ${/^\/internal\/v1\/relationship-candidates\/[^/]+\/(accept|reject|confirm|dismiss)$/.source}`]:
    {
      caller: "commands/kb_review.ts postCandidateVerdict",
      path: "/internal/v1/relationship-candidates/cand_1/accept",
      body: {
        workspaceId: "ws_1",
        userId: "user_1",
        note: "confirmed against the PR that introduced it",
      },
    },
  [`control POST ${/^\/internal\/v1\/relationship-candidates\/[^/]+\/propose-correction$/.source}`]:
    {
      caller: "commands/kb_review.ts proposeCorrection",
      path: "/internal/v1/relationship-candidates/cand_1/propose-correction",
      body: {
        workspaceId: "ws_1",
        userId: "user_1",
        note: "the direction is backwards",
        correction: { relationType: "SUPERSEDES", sourceSectionPath: "## Rules" },
      },
    },

  // ----------------------------------------------------------- active review
  [`intel POST ${/^\/internal\/v1\/active-review\/detect$/.source}`]: {
    caller: "commands/internal-active-review.ts",
    path: "/internal/v1/active-review/detect",
    body: {
      workspaceId: "ws_1",
      ownerUserId: "user_1",
      dryRun: false,
      candidates: [{ text: "we decided to defer the SSO work" }],
    },
  },
  [`intel POST ${/^\/internal\/v1\/onboarding\/marker$/.source}`]: {
    caller: "mla-onboard skill path -> commands/enrich.ts",
    path: "/internal/v1/onboarding/marker",
    body: {
      workspaceId: "ws_1",
      headCommit: "8c80ec96f",
      rootCommit: "0000001",
      planDigest: "sha256:abc",
      candidatesPersisted: 12,
    },
  },

  // ------------------------------------------------------------------- rules
  [`control POST ${/^\/internal\/v1\/rules$/.source}`]: {
    caller: "lib/rules/control-rule-client.ts mintRule",
    path: "/internal/v1/rules",
    body: {
      workspaceId: "ws_1",
      authorityScope: "WORKSPACE",
      ownerUserId: "user_1",
      projectId: null,
      payload: { headline: "Work directly on main", body: "never branch" },
      canonicalPayloadHash: "sha256:abc",
      requestIdempotencyKey: "idem_1",
      movedFromRuleId: "rule_0",
    },
  },
  [`control POST ${/^\/internal\/v1\/rules\/import$/.source}`]: {
    caller: "lib/rules/control-rule-client.ts importRules",
    path: "/internal/v1/rules/import",
    body: {
      workspaceId: "ws_1",
      rules: [
        {
          payload: { headline: "Work directly on main" },
          canonicalPayloadHash: "sha256:abc",
        },
      ],
    },
  },
  [`control PATCH ${/^\/internal\/v1\/rules\/[^/]+$/.source}`]: {
    caller: "lib/rules/control-rule-client.ts editRule",
    path: "/internal/v1/rules/rule_1",
    body: {
      workspaceId: "ws_1",
      expectedCurrentVersionId: "ver_1",
      payload: { headline: "Work directly on main", body: "never branch" },
      canonicalPayloadHash: "sha256:abc",
      requestIdempotencyKey: "idem_1",
    },
  },
  [`control POST ${/^\/internal\/v1\/rules\/[^/]+\/revoke$/.source}`]: {
    caller: "lib/rules/control-rule-client.ts revokeRule",
    path: "/internal/v1/rules/rule_1/revoke",
    body: { workspaceId: "ws_1", expectedCurrentVersionId: "ver_1" },
  },

  // ------------------------------------------------- coordination driver (Emily)
  // The three coordination driver POSTs (packages/mcp/coordination_actions.js).
  // The two GET reads (goal state, pending proposals) carry no body and need no
  // rule. Each maximal body includes its optional fields: start-goal attaches
  // `context` when an operator identity is configured; proposals/review attaches
  // `rejectionReason` when a rationale is given.
  [`control POST ${/^\/internal\/v1\/cases\/start-goal$/.source}`]: {
    caller: "packages/mcp/coordination_actions.js runCoordinationSubmitGoal",
    path: "/internal/v1/cases/start-goal",
    body: {
      workspaceId: "ws_1",
      objective: "get the checkout pilot ready for monday",
      canonicalFingerprint: "emily-agent:abc123def456",
      evidenceRefs: [
        {
          kind: "slack_thread",
          ref: { source: "emily-agent", objective: "get the checkout pilot ready" },
          label: "Operator instruction (chat)",
        },
      ],
      stakeholders: [{ workspaceUserId: "user_1", role: "DECISION_OWNER" }],
      context: {
        workspaceId: "ws_1",
        initiatorId: "user_1",
        requesterId: "user_1",
        surface: "system",
        directness: "EXPLICIT_REQUEST",
      },
    },
  },
  [`control POST ${/^\/internal\/v1\/coordination\/proposals\/review$/.source}`]: {
    caller: "packages/mcp/coordination_actions.js runCoordinationReviewProposal",
    path: "/internal/v1/coordination/proposals/review",
    body: {
      caseId: "case_1",
      proposalId: "prop_1",
      action: "reject",
      reviewerId: "user_1",
      rejectionReason: "the rollout note is missing the migration step",
    },
  },
  [`control POST ${/^\/internal\/v1\/cases\/resolve-goal$/.source}`]: {
    caller: "packages/mcp/coordination_actions.js runCoordinationProposeClose",
    path: "/internal/v1/cases/resolve-goal",
    body: { workspaceId: "ws_1", goalCaseId: "case_1" },
  },
};

function ruleKey(r: (typeof EGRESS_RULES)[number]): string {
  return `${r.service} ${r.method} ${r.match.source}`;
}

/** The top-level keys a rule allows. Every mode carries a field list. */
function declaredFields(r: (typeof EGRESS_RULES)[number]): string[] {
  return r.mode === "redact" ? Object.keys(r.fields) : [...r.fields];
}

describe("egress registry: every rule has a witness from its real caller", () => {
  it("covers every rule, and every witness maps to a rule", () => {
    const ruleKeys = EGRESS_RULES.map(ruleKey).sort();
    const witnessKeys = Object.keys(WITNESSES).sort();
    // Two-sided on purpose: the first direction stops a new row from shipping
    // with an unverified field list, the second stops a witness outliving the
    // row it described.
    expect(witnessKeys).toEqual(ruleKeys);
  });

  it.each(EGRESS_RULES.map((r) => [ruleKey(r), r] as const))(
    "%s",
    (key, rule) => {
      const w = WITNESSES[key];
      expect(w).toBeDefined();

      // The witness path must be produced by THIS rule and no other, otherwise
      // the acceptance check below would be judging a different row.
      expect(rule.match.test(w.path)).toBe(true);
      const matching = EGRESS_RULES.filter(
        (r) =>
          r.service === rule.service &&
          r.method === rule.method &&
          r.match.test(w.path),
      );
      expect(matching).toHaveLength(1);

      // Direction 1: the caller's body survives the boundary. A field the caller
      // sends and the rule forgot throws `unknown_field`, which in production is
      // a dead command.
      const url = `${ORIGIN[rule.service]}${w.path}`;
      expect(() =>
        applyEgressPolicy(EGRESS_RULES, rule.service, rule.method, url, w.body),
      ).not.toThrow();

      // Direction 2: no declared field is a phantom. Anything the rule names but
      // the caller never sends is a pre-authorized passthrough for a future
      // field of that name.
      const witnessed = Object.keys(w.body);
      const phantom = declaredFields(rule).filter(
        (f) => !witnessed.includes(f),
      );
      expect(phantom).toEqual([]);
    },
  );

  // Both checks above pass today. A green check proves nothing unless the same
  // check goes red on the defect it claims to catch, so each direction is
  // mutation-proved against a deliberately wrong copy of a real row.
  describe("the checks have teeth", () => {
    const scopeRule = EGRESS_RULES.find(
      (r) =>
        r.match.source ===
        /^\/internal\/v1\/kb\/documents\/[^/]+\/scope$/.source,
    );
    if (!scopeRule || scopeRule.mode !== "redact") {
      throw new Error("kb scope row changed shape; update this mutation test");
    }
    const witness = WITNESSES[ruleKey(scopeRule)];

    it("direction 1 goes red when a rule forgets a field its caller sends", () => {
      // Exactly the 13-row defect: `reason` dropped from the field list. In
      // production this is not a leak, it is `mla kb scope` refused at the
      // boundary.
      const forgetful = {
        ...scopeRule,
        fields: { scope: "preserve", actorBy: "preserve" },
      } as typeof scopeRule;
      let thrown: unknown;
      try {
        applyEgressPolicy(
          [forgetful],
          scopeRule.service,
          scopeRule.method,
          `${ORIGIN[scopeRule.service]}${witness.path}`,
          witness.body,
        );
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(EgressPolicyError);
      expect((thrown as EgressPolicyError).reason).toBe("unknown_field");
    });

    it("direction 2 goes red when a rule declares a field no caller sends", () => {
      // The superset defect: a `preserve` entry for a phantom field, which is a
      // standing pre-authorization nobody reviewed.
      const padded = {
        ...scopeRule,
        fields: { ...scopeRule.fields, tenantId: "preserve" },
      } as typeof scopeRule;
      const phantom = declaredFields(padded).filter(
        (f) => !Object.keys(witness.body).includes(f),
      );
      expect(phantom).toEqual(["tenantId"]);
      // ...and the padded rule still ACCEPTS the body, which is precisely why
      // direction 1 alone cannot see this class.
      expect(() =>
        applyEgressPolicy(
          [padded],
          scopeRule.service,
          scopeRule.method,
          `${ORIGIN[scopeRule.service]}${witness.path}`,
          witness.body,
        ),
      ).not.toThrow();
    });
  });
});
