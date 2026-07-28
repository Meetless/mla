// THE registry. Every body-bearing request the CLI makes to control or intel
// resolves against exactly one row here, or it does not get sent.
//
// HOW TO ADD A ROUTE. You cannot POST a body to a new route without adding a
// row; the transport throws `egress no_rule` the first time you try, in every
// environment including your laptop. That is the point. Adding the row forces
// one question to be answered out loud: does this body carry human or agent
// text, or only structural identifiers?
//
//   passthrough  Structural only: ids, enums, counts, booleans, timestamps,
//                paths we deliberately keep. `fields` is EXHAUSTIVE; a new key
//                fails closed until someone classifies it. Use this when there
//                is genuinely no free text, and be honest about what "free
//                text" means: a rationale, a title, a commit message and a file
//                path are all content.
//   redact       The body carries content. Name every top-level key and mark it
//                "redact" (walked to every string leaf) or "preserve" (passed
//                through: use ONLY for structural values whose exact bytes the
//                server needs, such as an id or a hash).
//   block_on_detect
//                Redacting would corrupt the meaning permanently (a governed
//                artifact stored verbatim, or a body whose hash was computed
//                over the original bytes). Scan every string leaf for
//                high-confidence credentials, send byte-for-byte unchanged when
//                clean, and refuse the whole request plus surface it to the
//                human when it is not. `fields` is EXHAUSTIVE, same as
//                passthrough.
//
// There is deliberately no unconditional "block" mode. A route that must never
// carry a body simply has no row, and no row means `egress no_rule`, which is
// the same refusal with one fewer abstraction to keep honest.
//
// PROFILE CHOICE. `full` is the at-rest bar (2 character classes, H >= 3.5).
// `retrieval` is the on-the-wire-to-intel bar (3 classes, H >= 4.0), used where
// the text IS a retrieval key and the strict bar measurably destroys it. The
// measurement behind those two numbers is in
// notes/20260726-mla-redaction-fidelity-and-egress-boundary-proposal.md §2.
//
// NOT IN THIS FILE, ON PURPOSE:
//   - The bash capture spool (POST/PATCH /internal/v1/agent-runs). flush.sh
//     owns it and pipes every batch through `mla _internal redact-events`
//     before the curl; test/hooks/redaction-egress.spec.ts locks that wiring.
//     It never touches this transport, so a row here would classify nothing.
//
// WHY /v1/ask IS IN THIS FILE (it was not, and that was a live bug). An earlier
// ruling warned against registering the route here "merely to make the registry
// look comprehensive". It is not merely that. There are TWO /v1/ask payload
// builders, because there are two module systems: `makeIntelAskFromCli` here in
// the CLI (CommonJS, used by `mla mcp`, posting through http.ts so it can carry
// a user-token bearer and its reactive refresh) and `makeIntelAsk` in ask-core
// (ESM, used by `mla ask` and the standalone meetless-mcp bin, posting with a
// plain fetch and a static key). Leaving the row out did not keep the boundary
// clean; it made `meetless__query` fail closed with `egress no_rule` against a
// live intel, which is how the gap was found. The choice was to register the
// route or to punch a hole in the fail-closed rule, and a hole is the one thing
// the ruling forbids.
//
// The invariant is NOT "one place builds the body". It is:
//   - Both builders redact, and each has its own tests proving it.
//   - Their behavior is parity-locked: packages/ask-core/ask_payload_parity.json
//     pins the field shape byte for byte and BOTH suites assert against it, so a
//     field added in one builder and forgotten in the other is two red tests,
//     not a silent divergence.
//   - This shared wire boundary applies the registered /v1/ask policy whichever
//     builder produced the body: the SAME parity-locked redactor at the SAME
//     `retrieval` bar the builder already used. Not a second policy, the same
//     module, and idempotent, so it cannot disagree with itself.
//     test/lib/egress-policy.spec.ts proves the idempotence rather than assuming
//     it. What it buys is that a future edit deleting redactForWire from a
//     builder still cannot put a raw secret on the wire.
//   - No third builder or direct sender can bypass it: the outbound-primitive
//     ownership test in test/lib/egress-ownership.spec.ts is what makes that
//     structural rather than aspirational, in BOTH packages.

import { EgressRule } from "./policy";

// Fields that ride along on nearly every control write and are always
// structural. Spelled out per rule rather than spread from a shared constant,
// because a shared constant is a place to hide a field.

export const EGRESS_RULES: readonly EgressRule[] = [
  // ------------------------------------------------------------ retrieval ---
  // The two routes that carry an operator's question to intel. Both go at the
  // `retrieval` bar for the same reason: the text IS the retrieval key, and the
  // `full` bar measurably destroys it (a diverse file path is one 32+ char
  // entropy token, so "apps/console/app/settings/SettingsNav.tsx" would leave
  // as "[REDACTED].tsx" and the question would no longer find its own answer).
  {
    service: "intel",
    method: "POST",
    match: /^\/v1\/ask$/,
    note: "ask: question to intel (shape owned by ask-core; see the header)",
    mode: "redact",
    profile: "retrieval",
    fields: {
      workspace_id: "preserve",
      question: "redact",
      thread_text: "redact",
      surface: "preserve",
      stream: "preserve",
      language: "preserve",
      mode: "preserve",
      // { canonical?: boolean, paths?: string[], ... }. A retrieval SELECTOR,
      // matched byte-for-byte server-side: ask-core's canonical mode sends
      // `paths: [winner.path]`. Redacting a selector does not return less, it
      // returns nothing, and does it silently.
      filters: "preserve",
      max_results: "preserve",
      min_results: "preserve",
      submission_id: "preserve",
      as_of: "preserve",
    },
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/v1\/ask\/retrieve$/,
    note: "ask: raw-evidence retrieval (meetless__retrieve_knowledge)",
    mode: "redact",
    profile: "retrieval",
    fields: {
      workspace_id: "preserve",
      query: "redact",
      // { surface: "mcp" }. One fixed enum.
      source_context: "preserve",
      limit: "preserve",
    },
  },

  // ---------------------------------------------------------------- auth ----
  // Credentials by definition. Redacting these would redact the thing the
  // request exists to present. Passthrough, with every field named so a future
  // `userEmail` or `deviceName` cannot join silently.
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/auth\/token\/refresh$/,
    note: "auth: token refresh",
    mode: "passthrough",
    why: "the refresh token IS the payload; there is no content here",
    fields: ["refreshToken", "userAgent"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/auth\/sessions\/revoke$/,
    note: "auth: session revoke",
    mode: "passthrough",
    why: "ids and the credential being revoked",
    fields: ["sessionId", "refreshToken"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/auth\/cli-login-grants\/exchange$/,
    note: "auth: PKCE code exchange",
    mode: "passthrough",
    why: "PKCE verifier and code; redacting either breaks login",
    fields: ["code", "codeVerifier", "userAgent"],
  },

  // ------------------------------------------------------------- capture ----
  // Agent and operator content. These are the rows the 2026-07-26 review was
  // about.
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/analytics\/events$/,
    note: "capture: analytics event batch",
    mode: "redact",
    profile: "full",
    // A telemetry bag, so redact by KEY NAME as well as by value. The values
    // that matter most here are the ones the value rules cannot see. Measured:
    // `password: "Tr0ub4dor&3"`, a schemeless `authorization:
    // "ZGV2Omh1bnRlcjI="`, `x-api-key: "sk-local-dev-1234"` and `cookie:
    // "session=abc123"` all leave verbatim, because none carries a scheme or
    // provider prefix and none reaches the 32-char entropy bar. Before this they
    // left HERE verbatim while the Sentry plane dropped them, because the two
    // planes had two different walkers over the same shape.
    //
    // `AnalyticsEvent` being a closed discriminated union is not a defense. The
    // batch is read back off a JSONL spool with an unchecked cast
    // (analytics/store.ts readEvents: `JSON.parse(trimmed) as AnalyticsEvent`),
    // so the union is a compile-time fiction at the wire and the real shape is
    // whatever any producer, at any version, wrote to that file.
    //
    // The cost is bounded and known: a property whose NAME matches SENSITIVE_KEY
    // collapses to [REDACTED] even when its value was harmless. Checked against
    // the properties this CLI actually emits; `\btoken\b` does not match
    // `input_tokens` or `token_count`, so LLM accounting survives. If a future
    // event needs a field named like a credential, rename the field.
    keyAware: true,
    fields: {
      workspaceId: "preserve",
      events: "redact",
    },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/agent-traces\/ingest$/,
    note: "capture: CLI self-trace batch",
    mode: "redact",
    profile: "full",
    // Ruling §3 required proof, before marking a span subtree "redact", that
    // walking it does not eat the structural IDs that make a trace a tree.
    // Measured against the real redactor, not assumed:
    //   traceId    32 hex  -> REDACTED by `full`. Hence "preserve" here; it is
    //                         the join key and its exact bytes are the point.
    //   spanId,
    //   parentSpanId
    //              16 hex  -> survive. ENTROPY_TOKEN needs 32+ chars, and a
    //                         randomBytes(8) id is 16, so the entropy rule never
    //                         sees them. The parent/child edges stay intact.
    //   name, status,
    //   ISO times          -> survive (short, low entropy).
    // What "redact" actually reaches is Span.input / .output / .attributes /
    // .events[].attributes, every one typed `unknown`, which is exactly the
    // agent content this exercise is about. test/lib/egress-policy.spec.ts
    // pins that finding so a future id-width change fails loudly.
    //
    // keyAware for the same reason as the events row, and with one extra effect
    // worth naming: a nested `spanId` / `parentSpanId` inside `attributes` now
    // survives BY NAME (SAFE_IDENTIFIER_KEY) rather than by the accident of
    // being 16 hex characters. That is a strictly better reason for it to
    // survive, and it does not change today's output, because 16 chars was
    // already under the entropy bar. The load-bearing change is the other
    // direction: an `authorization` or `password` key anywhere in a span
    // attribute bag or event payload now dies, matching what Sentry already did
    // with the identical tree.
    keyAware: true,
    fields: {
      workspaceId: "preserve",
      traceId: "preserve",
      // { mlaVersion, platform }. Two fixed strings, no content.
      client: "preserve",
      rootSpan: "redact",
      spans: "redact",
    },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/evidence\/work-product-capture$/,
    note: "capture: work-product seal",
    mode: "redact",
    profile: "full",
    // Every top-level key of WorkProductCaptureBody (work-product-seal.ts). The first
    // list here was written from the route name rather than from the body, and named
    // three fields that do not exist while missing seven that do, so the policy failed
    // closed on EVERY real seal: `unknown_field: captureContractVersion,
    // capturedTurnEnd, capturedTurnStart, injectId, redactedSubstance, status,
    // truncated`. It had been dead since the registry landed, and before the §2
    // diagnostic it died silently. egress-work-product-seal.spec.ts now runs a real
    // buildSealBody output through the real policy, so the two cannot drift again.
    fields: {
      workspaceId: "preserve",
      injectId: "preserve",
      captureContractVersion: "preserve",
      status: "preserve",
      capturedTurnStart: "preserve",
      capturedTurnEnd: "preserve",
      truncated: "preserve",
      redactedSubstance: "preserve",
      // The §5 record: user prompts, assistant outputs, and changed hunks. A real
      // object, so the walk reaches every string leaf individually (as a packed JSON
      // string it was one leaf, and escaping hid credentials from the rules).
      workProductDigest: "redact",
    },
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/v1\/observability\/turn-recap$/,
    note: "capture: per-turn assist recap",
    mode: "passthrough",
    // `recap` is a nested object and passthrough allowlists TOP-LEVEL keys only,
    // so this row is only as honest as that object. The emitter therefore
    // projects TurnRecap field by field rather than shipping it whole (see
    // turn-recap-emit.ts), and every projected field is an id, a boolean, a
    // count, a closed enum or an array of citation ids. Residual, stated
    // plainly: citation ids are path-shaped (`NT:notes/....md`), so document
    // PATHS reach intel here. That is the same residual the governed `events`
    // profile exemption already accepts for telemetry, not an oversight.
    why: "ids, booleans, counts, closed enums and citation-id arrays; the footer is composed from them and renderFooter interpolates no free text; recap is a pinned field-by-field projection, never the whole object",
    fields: ["traceId", "sessionId", "turnIndex", "verdict", "footer", "notRunReason", "recap"],
  },

  // ------------------------------------------------- operator-authored text --
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/bug-reports$/,
    note: "operator text: bug report",
    mode: "redact",
    profile: "full",
    fields: {
      workspaceId: "preserve",
      objectKey: "preserve",
      traceId: "preserve",
      sessionId: "preserve",
      mlaVersion: "preserve",
      platform: "preserve",
      redactionSummary: "preserve",
      title: "redact",
      message: "redact",
    },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/bug-reports\/upload-url$/,
    note: "bug report: presigned upload handshake",
    mode: "passthrough",
    why: "size and content-type only; the bundle itself is redacted before it is built",
    fields: ["workspaceId", "byteLength", "contentType", "sha256"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/docs\/ask$/,
    note: "operator text: bundled-docs question",
    mode: "redact",
    // The question is the retrieval key, same as /v1/ask.
    profile: "retrieval",
    fields: {
      question: "redact",
      corpusHash: "preserve",
    },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/session-conflicts\/[^/]+\/resolve$/,
    note: "operator text: conflict resolution rationale",
    mode: "redact",
    profile: "full",
    fields: {
      workspaceId: "preserve",
      outcome: "preserve",
      rationale: "redact",
    },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/session-conflicts\/[^/]+\/agent-dismiss$/,
    note: "operator text: agent false-positive dismissal rationale",
    mode: "redact",
    // `full`, not `retrieval`: this rationale is a governance record stored at
    // rest in control, not a retrieval key sent to intel. Measured cost, live:
    // "the token sk-proj-... in apps/console/.../SettingsNav.tsx is a fixture"
    // arrives as "the token [REDACTED] in [REDACTED].tsx is a fixture". The
    // secret dies and so does the path. That is a real fidelity loss on text a
    // human reads back later, and it is NOT fixed by Phase 3: the scoped
    // `events` profile is allowed exactly one production caller. Recorded here
    // as an accepted residual so the next reader does not mistake it for an
    // oversight.
    profile: "full",
    fields: {
      rationale: "redact",
      // "claude-code" and friends. An enum of runtime names, or null.
      runtimeHint: "preserve",
    },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/analytics\/enforcement\/incidents\/[^/]+\/adjudicate$/,
    note: "operator text: enforcement adjudication note",
    mode: "redact",
    profile: "full",
    // No `workspaceId`: the incident id is in the path and the workspace is
    // resolved server-side (enforcement.ts defaultAdjudicate sends `{verdict}`
    // plus an optional trimmed `note`). A `preserve` entry for a field no caller
    // sends is not padding, it is a standing pre-authorization: the day someone
    // adds a field by that name, it ships unredacted and no reviewer is asked.
    fields: {
      verdict: "preserve",
      note: "redact",
    },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/repo-instruction-snapshots$/,
    note: "repo file content: CLAUDE.md / AGENTS.md snapshot",
    // NOT "redact", and the reason is a hard contract, not a preference.
    // `normalizedContentHash` is sha256(normalizedContent) computed by the CLI,
    // and control RE-COMPUTES it server-side and rejects a mismatch with 400
    // (repo-instruction-snapshot-client.ts). Rewriting one byte of
    // `normalizedContent` at this boundary therefore does not degrade the
    // snapshot, it guarantees the upsert fails. Redaction and a stable-hash
    // contract cannot both hold, so this row refuses instead: a credential in a
    // CLAUDE.md is a real finding the operator should see, not something to
    // paper over.
    mode: "block_on_detect",
    why: "normalizedContentHash is a stable-hash contract over normalizedContent that control re-verifies (400 on mismatch), so the body is never rewritten; a credential in the instruction file is refused instead",
    fields: [
      "repositoryId",
      "relativePath",
      "normalizedContent",
      "normalizedContentHash",
      "contentNormalizationVersion",
      "observedCommitSha",
      "observedAt",
      "workspaceId",
    ],
  },

  // ------------------------------------------------------------ KB writes ----
  // Neither "redact" nor "passthrough" is right here, so these two rows are the
  // only block_on_detect rows in the registry.
  //
  //   redact      A redacted document is a WRONG document, permanently. The KB
  //               is read back as fact; a "[REDACTED]" that used to be a version
  //               number or a path is not a smaller answer, it is a false one.
  //   passthrough Sending unconditionally is exactly what put a credential in
  //               the knowledge base to begin with.
  //
  // So: scan every string leaf with the high-confidence credential denylist
  // (never the entropy scanner, which would refuse ordinary documents), send
  // byte-exact when clean, and refuse plus name the rule ids when not.
  //
  // The scan lives at this boundary rather than in the capture pipeline that
  // used to own it because there are THREE producers and only one of them went
  // through that pipeline. A check that only some producers reach is not a
  // boundary. `fields` below is the union of what all three send:
  //
  //   commands/kb_add.ts:baseBody        workspaceId, actor, provenance, profile,
  //                                      agentSession, mode, corpusName, documents
  //   agent-memory-capture/upsert-client workspaceId, actor, captureMethod,
  //                                      bindingId, consentedAt, provenance,
  //                                      profile, mode, documents
  //   commands/enrich.ts:persist         workspaceId, actor, documents,
  //                                      provenance, profile, mode
  //
  // That union is exactly the eleven fields of intel's `KbAddRequest`
  // (intel app/api/routes/kb_add.py), which is the authority here: this row may
  // narrow the server model, never exceed it.
  //
  // `agentSession` and `corpusName` were missing until 2026-07-28, which made
  // `mla kb add` a DEAD COMMAND at the boundary: kb_add.ts sends both keys
  // unconditionally (as `undefined` when absent, which still puts the key on the
  // object the classifier reads), so EVERY invocation was refused with
  // `unknown_field`. The caller-body witness that exists to catch precisely this
  // named kb_add.ts and had been written from the rule instead of read from it.
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/kb\/add$/,
    note: "KB ingest (intel)",
    mode: "block_on_detect",
    why: "a redacted document would be silently wrong forever, so this body is never rewritten; a credential in it is refused instead",
    fields: [
      "workspaceId",
      "actor",
      "captureMethod",
      "bindingId",
      "consentedAt",
      "provenance",
      "profile",
      "agentSession",
      "mode",
      "corpusName",
      "documents",
    ],
  },
  // There is no `control POST /internal/v1/kb/add` row. One used to sit here,
  // labelled "control relay", and nothing could reach it: all three producers
  // above call `intelPost` (lib/http.ts), which tags the egress service "intel"
  // unconditionally and targets `cfg.intelUrl`. A rule row no producer can reach
  // is a standing pre-authorization for whoever adds that call site later,
  // granted by a reviewer who never saw the body. Its absence is the fail-closed
  // default: a kb/add aimed at control now stops at `unregistered_route`.

  // ---------------------------------------------------- structural writes ----
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/workspaces$/,
    note: "workspace provision (mla activate, first run)",
    mode: "passthrough",
    // `slug`, `branch` and `seedFromRepo` were listed here and are sent by
    // nobody. An allowlist that names fields no caller produces is not harmless
    // padding: it is the tell that the row was written from the route name.
    why: "a workspace name the operator typed (or the cwd basename) and the canonical absolute repo path; both are identifiers control stores as-is",
    fields: ["name", "repoPath"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/workspaces\/(deactivate|reactivate)$/,
    note: "workspace lifecycle",
    mode: "passthrough",
    why: "one id",
    fields: ["workspaceId"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/workspaces\/members$/,
    note: "workspace member invite",
    mode: "passthrough",
    // `role` was listed and is sent by nobody: the upsert is role-preserving and
    // can only ever create or reactivate a MEMBER (control-workspace-member-client.ts).
    why: "an email address and a workspace id; both are identifiers the server must receive intact",
    fields: ["email", "workspaceId"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/agent-runs\/by-session\/[^/]+\/(finalize|archive)$/,
    note: "agent-run lifecycle (finalize carries gitEvidence; archive is the id alone)",
    mode: "passthrough",
    // Ruling §4: do not describe this row as "ids only". It is not. Naming the
    // residual precisely is the whole value of the row:
    //   gitEvidence.topLevel        an ABSOLUTE repo path, so a username
    //   gitEvidence.branch          a branch name, often a ticket title
    //   gitEvidence.trackedModified,
    //     .staged, .untracked,
    //     .deleted, .renamed        file paths across the repo
    //   gitEvidence.lastCommit      a commit subject
    //   gitEvidence.errors[]        RAW git stderr. The one genuine leak here:
    //                               a remote URL with an embedded token lands in
    //                               stderr verbatim. Known residual, closed in
    //                               Phase 3.
    // Why not "redact" today: measured, `full` eats the file lists (a diverse
    // path is a single 32+ char entropy token, so "apps/console/app/settings/
    // SettingsNav.tsx" becomes "[REDACTED].tsx"). That destroys the evidence the
    // route exists to carry, which is a worse outcome than the residual. Phase 3
    // flips this row to mode "redact" at the scoped `events` profile, whose
    // path-like exemption keeps the paths while still catching a token in
    // stderr. This row is the reason that profile is scoped rather than global.
    why: "git evidence: repo path, branch, file paths, commit subject and raw git stderr; NOT ids only",
    fields: ["workspaceId", "gitEvidence"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/session-steers\/by-session\/[^/]+\/pull$/,
    note: "steer pull",
    mode: "passthrough",
    // No cursor: the session id is in the path and the body is one id
    // (internal-steer-sync.ts realTransport.pull).
    why: "one workspace id",
    fields: ["workspaceId"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/session-steers\/[^/]+\/injected$/,
    note: "steer injection ack",
    mode: "passthrough",
    // The steer id is in the path and the server stamps the time; the body is
    // one id (internal-steer-sync.ts realTransport.markInjected).
    why: "one workspace id",
    fields: ["workspaceId"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/relationship-candidates\/publish-rules$/,
    note: "publish the LIVE governing-rule set for one runtime scope",
    // `rules[].text` is the rule headline pulled from the same payload that
    // `rules[].payloadHash` (the local canonicalPayloadHash) is computed over,
    // and control stores both. Redacting the headline would publish a governing
    // rule whose displayed text and whose hash describe different things, which
    // is a governance artifact that lies. Refuse instead.
    mode: "block_on_detect",
    why: "publishes governing rule text alongside its canonicalPayloadHash; a rewritten headline would diverge from the hash it is published under, so a credential is refused rather than redacted",
    fields: ["workspaceId", "runtimeScopeId", "rules"],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/relationship-candidates\/[^/]+\/(accept|reject|confirm|dismiss)$/,
    note: "relationship candidate verdict (mla kb review --accept/--reject)",
    mode: "redact",
    profile: "full",
    fields: {
      workspaceId: "preserve",
      // The acting human. An id, and the whole point of the audit row.
      userId: "preserve",
      // Operator free text: the reviewer's reason. Same class as the
      // agent-dismiss and adjudicate notes above, so the same treatment.
      note: "redact",
    },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/relationship-candidates\/[^/]+\/propose-correction$/,
    note: "relationship candidate correction (--reclassify / --scope-section / --no-relation)",
    mode: "redact",
    profile: "full",
    fields: {
      workspaceId: "preserve",
      userId: "preserve",
      note: "redact",
      // CorrectionSpec: correctionKind, correctedRelationType and scopeKind are
      // closed enums, and sourceSectionPath is a heading path inside a governed
      // document. Preserved, not redacted, because the correction IS the
      // training label: a label filed against "[REDACTED]" points at nothing and
      // is worse than no label. Residual, stated plainly: a document heading
      // reaches control here. Same residual class as the citation ids on the
      // turn-recap row, and the enums cannot carry a secret.
      correction: "preserve",
    },
  },
  // The three KB correction verbs below all carry one operator `reason` and one
  // DOCUMENT SELECTOR. The selector (`sourceItemId`, `ref`, `relPath`) is always
  // preserved: redacting the thing that names WHICH document to retime or forget
  // does not make the call safer, it makes it resolve to nothing or, worse, to a
  // different document. A selector is an identifier by construction.
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/kb\/retime$/,
    note: "KB retime: correct one document's effective date (control front door)",
    mode: "redact",
    profile: "full",
    fields: {
      workspaceId: "preserve",
      sourceItemId: "preserve",
      effectiveDate: "preserve",
      actor: "preserve",
      anchorType: "preserve",
      reason: "redact",
    },
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/kb\/retime$/,
    note: "KB retime (intel direct; same body as the control row)",
    mode: "redact",
    profile: "full",
    fields: {
      workspaceId: "preserve",
      sourceItemId: "preserve",
      effectiveDate: "preserve",
      actor: "preserve",
      anchorType: "preserve",
      reason: "redact",
    },
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/kb\/(forget|purge)$/,
    note: "KB forget / purge: tombstone or hard-delete one governed document",
    mode: "redact",
    profile: "full",
    fields: {
      workspaceId: "preserve",
      actor: "preserve",
      // ForgetHandle: exactly one of these is set. Both are selectors.
      ref: "preserve",
      relPath: "preserve",
      reason: "redact",
    },
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/kb\/reingest$/,
    note: "KB reingest: re-deliver an existing document's CURRENT on-disk bytes",
    // Same category as kb/add, and for the same reason: `content` is the whole
    // file, read off the operator's disk and stored as the governed document.
    // A redacted reingest would silently rewrite a document that is later read
    // back as fact. This route was modelled as "ids and a selector" before this
    // audit, which meant whole-file content shipped with no credential scan at
    // all: the same gap kb/add had.
    mode: "block_on_detect",
    why: "ships whole file bytes that become the governed document; a redacted reingest would be permanently wrong, so a credential is refused instead",
    fields: [
      "workspaceId",
      "actor",
      // RESOLVE leg: `ref` alone (no content yet).
      "ref",
      // APPLY leg.
      "profile",
      "reason",
      "agentSession",
      "content",
      "documentId",
      "relPath",
    ],
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/kb\/documents\/[^/]+\/scope$/,
    note: "KB document scope change (mla kb promote / demote)",
    mode: "redact",
    profile: "full",
    fields: {
      scope: "preserve",
      actorBy: "preserve",
      reason: "redact",
    },
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/kb-claims\/[^/]+\/verdict$/,
    note: "KB claim verdict (mla kb claims --accept/--reject)",
    mode: "passthrough",
    why: "two outcome enums plus a per-invocation idempotency uuid; the claim id is in the path and the workspace id in the query string. No free text: this route has no note field",
    fields: ["outcome", "expectedPriorOutcome", "idempotencyKey"],
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/relation-assertions\/[^/]+\/verdict$/,
    note: "relation assertion verdict (meetless__relationship_verdict)",
    mode: "passthrough",
    why: "two outcome enums, a user id and an optional idempotency key; the assertion id is in the path and the workspace id in the query string",
    fields: ["outcome", "expectedPriorOutcome", "actorUserId", "idempotencyKey"],
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/active-review\/detect$/,
    note: "active review detection: produced-doc bodies sent to intel",
    mode: "redact",
    // The document text IS the retrieval subject, same category as /v1/ask and
    // /internal/v1/docs/ask, so it goes at the deliberately laxer wire bar.
    profile: "retrieval",
    fields: {
      workspaceId: "preserve",
      ownerUserId: "preserve",
      dryRun: "preserve",
      // [{ canonicalPath, body, kind }]. `body` is a file read off disk at
      // review time: content, unambiguously.
      candidates: "redact",
    },
    // canonicalPath is the key intel records the detection against, and a
    // detection filed against "[REDACTED].md" is worse than no detection: it
    // silently points at nothing. It cannot be hoisted to a top-level preserve
    // because it is per-candidate. Measured: `retrieval` keeps ordinary source
    // paths but eats date-prefixed note paths (one long high-entropy token),
    // which is the notes vault this feature is aimed at, so the damage would
    // land on an unpredictable subset rather than announce itself.
    structuralKeys: ["canonicalPath"],
  },
  {
    service: "intel",
    method: "POST",
    match: /^\/internal\/v1\/onboarding\/marker$/,
    note: "onboarding completion marker (§4C cross-machine short-circuit)",
    mode: "passthrough",
    why: "a workspace id, two git commit shas, a plan digest and a count; buildOnboardingMarkerRequest constructs exactly these five and no free text",
    fields: [
      "workspaceId",
      "headCommit",
      "rootCommit",
      "planDigest",
      "candidatesPersisted",
    ],
  },

  // --------------------------------------------------------------- rules ----
  // Rule text is authored by a human and, increasingly, proposed by an agent
  // from repo files. It is content, so the instinct is "redact". That instinct
  // is WRONG here, and the reason is the second stable-hash contract in this
  // registry (the first is repo-instruction-snapshots).
  //
  // The CLI computes ruleVersionHash(payload) and ships it as
  // `canonicalPayloadHash`. Control stores that value VERBATIM and the read
  // path re-hashes the stored payload and compares (verifyEntryIntegrity). If
  // this boundary rewrote one byte of `payload`, the hash would still describe
  // the ORIGINAL text, and the divergence would not surface at write time. It
  // would surface later, as a governing rule silently dropped at bundle-verify.
  //
  // A governance system whose rules can be quietly altered in transit is worse
  // than one that refuses to publish. So: scan, ship byte-exact when clean,
  // refuse and name the rule ids when not.
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/rules$/,
    note: "mint governing rule v1",
    mode: "block_on_detect",
    why: "payload is stored verbatim under a CLI-computed canonicalPayloadHash that the read path re-verifies; rewriting it would silently drop the rule at bundle-verify, so a credential is refused instead",
    fields: [
      "workspaceId",
      "authorityScope",
      "ownerUserId",
      "projectId",
      "payload",
      "canonicalPayloadHash",
      "requestIdempotencyKey",
      "movedFromRuleId",
    ],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/rules\/import$/,
    note: "bulk rule import (G2 one-time importer)",
    // Every imported VERSION carries its legacy canonicalPayloadHash preserved
    // verbatim next to the payload it hashes. Same contract, one level deeper.
    mode: "block_on_detect",
    why: "each imported version preserves a legacy canonicalPayloadHash verbatim beside its payload; a rewritten payload would break historical integrity, so a credential is refused instead",
    fields: ["workspaceId", "rules"],
  },
  {
    service: "control",
    method: "PATCH",
    match: /^\/internal\/v1\/rules\/[^/]+$/,
    note: "amend governing rule (mint-next)",
    mode: "block_on_detect",
    why: "same canonicalPayloadHash contract as the mint route",
    fields: [
      "workspaceId",
      "expectedCurrentVersionId",
      "payload",
      "canonicalPayloadHash",
      "requestIdempotencyKey",
    ],
  },
  {
    service: "control",
    method: "POST",
    match: /^\/internal\/v1\/rules\/[^/]+\/revoke$/,
    note: "revoke governing rule (compare-and-swap)",
    mode: "passthrough",
    why: "a workspace id and the version id the caller believes is current; RevokeRuleBody has no reason field and no free text",
    fields: ["workspaceId", "expectedCurrentVersionId"],
  },
];
