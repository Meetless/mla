// The egress boundary's own tests. Two halves:
//
//   1. The ENGINE, against a small hand-built registry, so each fail-closed path
//      is exercised in isolation.
//   2. The REAL registry, so a row someone adds later cannot be unanchored,
//      overlapping, or silently wrong about what it classifies.
//
// The property under test throughout is not "secrets get redacted". It is
// "a body that nobody classified cannot be sent". Redaction is what a
// classified body gets; refusal is what an unclassified one gets.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  applyEgressPolicy,
  EgressPolicyError,
  EgressRule,
  isAnchored,
  normalizePathname,
  resolveRule,
} from "../../src/lib/egress/policy";
import { EGRESS_RULES } from "../../src/lib/egress/rules";

const SECRET = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8";

const FIXTURE: EgressRule[] = [
  {
    service: "control",
    method: "POST",
    match: /^\/x\/mixed$/,
    note: "fixture: mixed",
    mode: "redact",
    profile: "full",
    fields: { id: "preserve", payload: "redact" },
  },
  {
    service: "control",
    method: "POST",
    match: /^\/x\/structural$/,
    note: "fixture: structural",
    mode: "passthrough",
    why: "ids only",
    fields: ["id", "count"],
  },
];

describe("normalizePathname", () => {
  it("drops the query string, which is the whole reason we do not match raw URLs", () => {
    // An attacker-influenced query must never be able to steer a rule. If the
    // registry matched path-and-query, this input would test against a string
    // containing "/internal/v1/auth/token/refresh".
    expect(
      normalizePathname(
        "http://c/internal/v1/kb/add?next=/internal/v1/auth/token/refresh",
      ),
    ).toBe("/internal/v1/kb/add");
  });

  it("drops the fragment", () => {
    expect(normalizePathname("/internal/v1/kb/add#frag")).toBe("/internal/v1/kb/add");
  });

  it("collapses duplicate slashes and strips one trailing slash", () => {
    expect(normalizePathname("http://c//internal//v1/kb/add/")).toBe("/internal/v1/kb/add");
  });

  it("keeps a bare root as /", () => {
    expect(normalizePathname("http://c/")).toBe("/");
  });

  it("accepts a path-only input as readily as an absolute URL", () => {
    expect(normalizePathname("/internal/v1/kb/add")).toBe("/internal/v1/kb/add");
  });

  it("strips the query from a junk input too, however it ends up parsed", () => {
    // With a base, `new URL` resolves almost anything, so the exact bytes here
    // are an implementation detail. The invariant is the one that matters: no
    // query survives into the string a rule is matched against.
    const out = normalizePathname("::not a url::/a?b=SECRETVALUE");
    expect(out).not.toContain("?");
    expect(out).not.toContain("SECRETVALUE");
  });
});

describe("resolveRule: exactly one, or nothing goes out", () => {
  it("fails closed on an unregistered route", () => {
    expect(() => resolveRule(FIXTURE, "control", "POST", "/x/brand-new")).toThrow(
      /egress no_rule/,
    );
  });

  it("fails closed when two rules match, rather than picking the first", () => {
    const dup: EgressRule[] = [
      ...FIXTURE,
      {
        service: "control",
        method: "POST",
        match: /^\/x\/mi[a-z]+$/,
        note: "fixture: overlapping",
        mode: "passthrough",
        why: "deliberately overlaps the mixed rule",
        fields: ["id"],
      },
    ];
    expect(() => resolveRule(dup, "control", "POST", "/x/mixed")).toThrow(
      /egress ambiguous_rule/,
    );
  });

  it("fails closed on an unanchored rule at USE time, not only in review", () => {
    const loose: EgressRule[] = [
      {
        service: "control",
        method: "POST",
        match: /\/x\/loose/,
        note: "fixture: unanchored",
        mode: "passthrough",
        why: "n/a",
        fields: [],
      },
    ];
    expect(() => resolveRule(loose, "control", "POST", "/x/loose-and-leaking")).toThrow(
      /egress unanchored_rule/,
    );
  });

  it("does not let one service's rule answer for another", () => {
    expect(() => resolveRule(FIXTURE, "intel", "POST", "/x/mixed")).toThrow(/no_rule/);
  });

  it("does not let one method's rule answer for another", () => {
    expect(() => resolveRule(FIXTURE, "control", "PATCH", "/x/mixed")).toThrow(/no_rule/);
  });

  it("matches case-insensitively on the method", () => {
    expect(resolveRule(FIXTURE, "control", "post", "/x/mixed").note).toBe("fixture: mixed");
  });
});

describe("applyEgressPolicy: field classification", () => {
  const run = (service: "control" | "intel", path: string, body: unknown) =>
    applyEgressPolicy(FIXTURE, service, "POST", path, body);

  it("redacts a 'redact' field to every string leaf, at any depth", () => {
    const out = run("control", "/x/mixed", {
      id: "doc_123",
      payload: { deep: [{ deeper: `run with ${SECRET}` }] },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  it("passes a 'preserve' field through byte for byte", () => {
    // A preserved id must survive intact or the server cannot join on it. This
    // is the fidelity half of the boundary; redaction that breaks joins is not
    // a win.
    const out = run("control", "/x/mixed", {
      id: "0f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
      payload: "clean",
    }) as Record<string, unknown>;
    expect(out.id).toBe("0f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c");
  });

  it("fails closed on an unclassified top-level field in a redact rule", () => {
    // This is the case a call-site redactor cannot catch: someone adds a field
    // and the old redaction call keeps passing.
    expect(() =>
      run("control", "/x/mixed", { id: "a", payload: "b", newlyAdded: SECRET }),
    ).toThrow(/unclassified top-level field\(s\): newlyAdded/);
  });

  it("fails closed on an unclassified top-level field in a passthrough rule", () => {
    expect(() =>
      run("control", "/x/structural", { id: "a", count: 1, notes: SECRET }),
    ).toThrow(/unclassified top-level field\(s\): notes/);
  });

  it("names every unclassified field, sorted, so one round trip fixes them all", () => {
    expect(() => run("control", "/x/structural", { zeta: 1, alpha: 2 })).toThrow(
      /unclassified top-level field\(s\): alpha, zeta/,
    );
  });

  it("refuses a non-object body, which would bypass classification entirely", () => {
    expect(() => run("control", "/x/mixed", "a bare string")).toThrow(
      /body must be a JSON object; got string/,
    );
    expect(() => run("control", "/x/mixed", [1, 2])).toThrow(
      /body must be a JSON object; got array/,
    );
  });

  it("lets a body-free request through untouched", () => {
    expect(run("control", "/x/mixed", undefined)).toBeUndefined();
  });

  it("leaves the caller's object unmutated, so local logic keeps its raw text", () => {
    const body = { id: "a", payload: `x ${SECRET}` };
    run("control", "/x/mixed", body);
    expect(body.payload).toContain(SECRET);
  });
});

describe("diagnostics are body-free", () => {
  it("never quotes the body in a fail-closed error", () => {
    let msg = "";
    try {
      applyEgressPolicy(FIXTURE, "control", "POST", "/x/unknown", { s: SECRET });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("/x/unknown");
    expect(msg).toContain("POST");
    expect(msg).not.toContain(SECRET);
  });

  it("never quotes the query string, which can itself carry a token", () => {
    let msg = "";
    try {
      applyEgressPolicy(FIXTURE, "control", "POST", `/x/unknown?token=${SECRET}`, {});
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(SECRET);
    expect(msg).not.toContain("token=");
  });

  it("carries a machine-readable reason so callers can classify without parsing prose", () => {
    try {
      applyEgressPolicy(FIXTURE, "control", "POST", "/x/unknown", {});
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EgressPolicyError);
      expect((e as EgressPolicyError).reason).toBe("no_rule");
      expect((e as EgressPolicyError).pathname).toBe("/x/unknown");
    }
  });
});

describe("the real registry", () => {
  it("anchors every match at both ends", () => {
    const loose = EGRESS_RULES.filter((r) => !isAnchored(r.match));
    expect(loose.map((r) => r.note)).toEqual([]);
  });

  it("has no two rules that can both match the same request", () => {
    // Overlap is caught at send time too, but only for paths someone happens to
    // exercise. This catches it for every path each rule claims.
    const probes: { service: string; method: string; path: string }[] = [];
    for (const r of EGRESS_RULES) {
      // Turn the rule's own source into a representative path by substituting a
      // concrete segment for each `[^/]+` and picking the first alternative of
      // each `(a|b)` group.
      const path = r.match.source
        .replace(/^\^/, "")
        .replace(/\$$/, "")
        .replace(/\[\^\/\]\+/g, "SEG")
        .replace(/\(([^)|]+)\|[^)]*\)/g, "$1")
        .replace(/\\\//g, "/");
      probes.push({ service: r.service, method: r.method, path });
    }
    const ambiguous: string[] = [];
    for (const p of probes) {
      const hits = EGRESS_RULES.filter(
        (r) => r.service === p.service && r.method === p.method && r.match.test(p.path),
      );
      if (hits.length !== 1) {
        ambiguous.push(`${p.method} ${p.service}${p.path} -> ${hits.length} rules`);
      }
    }
    expect(ambiguous).toEqual([]);
  });

  it("gives every redact rule at least one redacted field", () => {
    // A "redact" rule whose fields are all "preserve" is a passthrough wearing a
    // disguise, and reads in review as if it were protecting something.
    const hollow = EGRESS_RULES.filter(
      (r) => r.mode === "redact" && !Object.values(r.fields).includes("redact"),
    );
    expect(hollow.map((r) => r.note)).toEqual([]);
  });

  it("gives every passthrough rule a stated reason and a closed field list", () => {
    const bad = EGRESS_RULES.filter(
      (r) => r.mode === "passthrough" && (!r.why || !Array.isArray(r.fields)),
    );
    expect(bad.map((r) => r.note)).toEqual([]);
  });

  it("registers /v1/ask exactly once, at the bar ask-core already used", () => {
    // This test used to assert the OPPOSITE: that /v1/ask was absent, because
    // ruling §6 gives ask-core sole ownership. That reading was wrong in a way
    // only a live run could show. The MCP posts /v1/ask through this transport
    // (it needs a user-token bearer that ask-core's static-key fetch has no way
    // to carry), so an absent row did not preserve ask-core's ownership, it made
    // `meetless__query` fail closed with `egress no_rule` against a live intel.
    //
    // What §6 actually protects against is a SECOND, different policy. So the
    // invariant worth guarding is not "no row" but "exactly one row, at the same
    // bar, from the same redactor". Drift is caught by the profile assertion
    // here plus the idempotence test above.
    const ask = EGRESS_RULES.filter((r) => r.match.test("/v1/ask"));
    expect(ask).toHaveLength(1);
    expect(ask[0].mode).toBe("redact");
    expect((ask[0] as any).profile).toBe("retrieval");
  });

  it("registers KB ingest once, on intel, and never redacts it", () => {
    // A redacted document is a wrong document, permanently, and the KB is read
    // back as fact, so the route lands on block_on_detect.
    //
    // ONE row, not two. A "control relay" row sat beside this one and no
    // producer could reach it: all three (commands/kb_add.ts,
    // agent-memory-capture/upsert-client, commands/enrich.ts) call intelPost,
    // which tags the service "intel" unconditionally. An unreachable row is a
    // pre-authorization for a call site nobody has written yet.
    const kbAdd = EGRESS_RULES.filter((r) => r.match.test("/internal/v1/kb/add"));
    expect(kbAdd.map((r) => `${r.service}:${r.mode}`).sort()).toEqual([
      "intel:block_on_detect",
    ]);
  });

  it("keeps block_on_detect to routes whose body cannot be rewritten", () => {
    // The mode exists for bodies that redaction would CORRUPT rather than
    // protect, and there are exactly three reasons a body qualifies:
    //
    //   1. it is stored verbatim and read back as fact (the KB documents:
    //      a redacted document is a wrong document, permanently);
    //   2. it ships under a stable-hash contract the far side re-computes, so a
    //      rewritten byte does not degrade the artifact, it breaks it. Three
    //      such contracts exist. repo-instruction-snapshots sends
    //      normalizedContentHash = sha256(normalizedContent) and control 400s on
    //      a mismatch. The rules routes send canonicalPayloadHash, which control
    //      stores VERBATIM while the read path re-hashes the stored payload:
    //      rewriting there fails LATER and SILENTLY, as a governing rule dropped
    //      at bundle-verify. publish-rules publishes rule text under that same
    //      hash.
    //   3. the body is an authoritative SET whose complement the far side acts
    //      on. The snapshot sweep sends the instruction-file paths this scan
    //      observed and control retires every live revision outside them, so a
    //      redacted path is not a weaker claim, it is the opposite claim:
    //      ["CLAUDE.md"] rewritten to ["[REDACTED].md"] says "I have a file
    //      nobody has heard of" and tombstones the whole real corpus. Nothing is
    //      lost by redacting these bytes; the MEANING inverts.
    //
    // The pin is a list, not a rule, because "cannot be rewritten" is a
    // judgement. A future row reaching for this mode to dodge classifying its
    // fields fails here and has to argue for itself in a diff.
    const rows = EGRESS_RULES.filter((r) => r.mode === "block_on_detect");
    expect(rows.map((r) => r.note).sort()).toEqual([
      "KB ingest (intel)",
      "KB reingest: re-deliver an existing document's CURRENT on-disk bytes",
      "amend governing rule (mint-next)",
      "bulk rule import (G2 one-time importer)",
      "mint governing rule v1",
      "publish the LIVE governing-rule set for one runtime scope",
      "repo file PATHS: the instruction files this scan observed on disk",
      "repo file content: CLAUDE.md / AGENTS.md snapshot",
    ]);
  });

  it("sends a clean KB document byte-exact, including the paths a bar would eat", () => {
    // The point of not redacting: `retrieval` and `full` both eat a
    // date-prefixed note path as one 32+ char entropy token. Through this rule
    // the document arrives as written.
    const content =
      "# Note\n\nSee notes/20260726-mla-redaction-fidelity-and-egress-boundary-proposal.md for the ruling.\n";
    const sent = applyEgressPolicy(
      EGRESS_RULES,
      "intel",
      "POST",
      "https://intel.invalid/internal/v1/kb/add?trace=1",
      {
        workspaceId: "ws_1",
        actor: "user_a",
        provenance: "agent_distilled",
        profile: "markdown_atomic_v1",
        mode: "file",
        documents: [{ relPath: "notes/x.md", content }],
      },
    ) as { documents: Array<{ content: string }> };
    expect(sent.documents[0].content).toBe(content);
  });

  it("refuses a KB document carrying a credential, and names the rule not the secret", () => {
    const SECRET = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8";
    let err: EgressPolicyError | undefined;
    try {
      applyEgressPolicy(
        EGRESS_RULES,
        "intel",
        "POST",
        "https://intel.invalid/internal/v1/kb/add",
        {
          workspaceId: "ws_1",
          actor: "user_a",
          provenance: "agent_distilled",
          profile: "markdown_atomic_v1",
          mode: "file",
          documents: [
            { relPath: "notes/x.md", content: `run with ${SECRET} exported` },
          ],
        },
      );
    } catch (e) {
      err = e as EgressPolicyError;
    }
    expect(err).toBeInstanceOf(EgressPolicyError);
    expect(err!.reason).toBe("blocked");
    // The rule id is what the human needs. The matched text IS the credential;
    // naming it in an error that gets logged would leak the thing we just
    // refused to send.
    expect(err!.message).toContain("provider_token");
    expect(err!.message).not.toContain(SECRET);
    // The diagnostic still says where, per ruling §5.
    expect(err!.message).toContain("/internal/v1/kb/add");
  });

  it("finds a credential nested anywhere in the KB body, not just in content", () => {
    const SECRET =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(() =>
      applyEgressPolicy(
        EGRESS_RULES,
        "intel",
        "POST",
        "https://intel.invalid/internal/v1/kb/add",
        {
          workspaceId: "ws_1",
          actor: "user_a",
          provenance: "agent_distilled",
          profile: "markdown_atomic_v1",
          mode: "file",
          documents: [{ relPath: `notes/${SECRET}.md`, content: "clean" }],
        },
      ),
    ).toThrow(/jwt/);
  });

  it("fails closed on an unclassified KB field rather than shipping it unscanned", () => {
    expect(() =>
      applyEgressPolicy(
        EGRESS_RULES,
        "intel",
        "POST",
        "https://intel.invalid/internal/v1/kb/add",
        {
          workspaceId: "ws_1",
          actor: "user_a",
          provenance: "agent_distilled",
          profile: "markdown_atomic_v1",
          mode: "file",
          documents: [{ relPath: "notes/x.md", content: "clean" }],
          rawStdout: "whatever a future caller decides to staple on",
        },
      ),
    ).toThrow(/unclassified top-level field\(s\): rawStdout/);
  });

  it("redacts a span's content without eating the ids that make it a tree", () => {
    // Ruling §3 forbade marking a trace subtree "redact" on the assumption that
    // the ids come through. This is that proof, run against the real rule and
    // the real redactor rather than asserted in a comment.
    //
    // It also documents WHY the widths differ: ENTROPY_TOKEN only looks at runs
    // of 32+ chars, so a randomBytes(8) span id (16 hex) is structurally out of
    // reach, while a 32-hex trace id is not and has to be classified "preserve"
    // by hand. If either id width changes, this fails instead of quietly
    // severing every trace.
    const SPAN_ID = "0f1e2d3c4b5a6978"; // randomBytes(8).toString("hex")
    const PARENT_ID = "1122334455667788";
    const TRACE_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90"; // 32 hex: would be eaten
    const LEAKED = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8";

    const sent = applyEgressPolicy(
      EGRESS_RULES,
      "control",
      "POST",
      "https://control.invalid/internal/v1/agent-traces/ingest",
      {
        workspaceId: "cmexamplews1a2b3c4d5e6f7g",
        traceId: TRACE_ID,
        client: { mlaVersion: "0.2.27", platform: "darwin-arm64" },
        rootSpan: {
          spanId: PARENT_ID,
          parentSpanId: null,
          name: "mla.cmd.review",
          status: "ok",
        },
        spans: [
          {
            spanId: SPAN_ID,
            parentSpanId: PARENT_ID,
            name: "http.post",
            startTime: "2026-07-27T00:00:00.000Z",
            endTime: "2026-07-27T00:00:01.500Z",
            status: "ok",
            input: { prompt: `export OPENAI_API_KEY=${LEAKED}` },
            attributes: { note: `bearer ${LEAKED}` },
          },
        ],
      },
    ) as Record<string, any>;

    // The skeleton survives, so the tree can still be reassembled server-side.
    expect(sent.traceId).toBe(TRACE_ID);
    expect(sent.client).toEqual({ mlaVersion: "0.2.27", platform: "darwin-arm64" });
    expect(sent.rootSpan.spanId).toBe(PARENT_ID);
    expect(sent.spans[0].spanId).toBe(SPAN_ID);
    expect(sent.spans[0].parentSpanId).toBe(PARENT_ID);
    expect(sent.spans[0].name).toBe("http.post");
    expect(sent.spans[0].status).toBe("ok");
    expect(sent.spans[0].startTime).toBe("2026-07-27T00:00:00.000Z");

    // The content does not. Assert on the serialized body: a leak that hides in
    // a key this test forgot to name is still a leak.
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(LEAKED);
    // §8: the variable name is the retrieval key and must survive its value.
    expect(sent.spans[0].input.prompt).toContain("OPENAI_API_KEY");
    expect(sent.spans[0].input.prompt).not.toContain(LEAKED);
  });

  it("keeps every structuralKeys use to the reviewed set", () => {
    // structuralKeys is the one way to pass a value through a redacted subtree,
    // so its use has to stay a deliberate, listed exception rather than a habit.
    // Adding a row here should require editing this assertion and saying why.
    const used = EGRESS_RULES.filter(
      (r) => r.mode === "redact" && (r as any).structuralKeys?.length,
    ).map((r) => `${r.note} :: ${((r as any).structuralKeys as string[]).join(",")}`);
    // EMPTY as of 2026-07-28. The one user (active-review/detect :: canonicalPath)
    // existed because the `retrieval` profile ate date-prefixed note paths; OR-1
    // fixed that at the redactor, so the field is now walked like any other and
    // the whole-value passthrough is unused. The mechanism is kept because it is
    // the reviewed way to solve that class, not because anything needs it today.
    expect(used).toEqual([]);
  });

  it("keeps a detect candidate's join key while redacting the file it carries", () => {
    // Both demands land on the same array, and a date-prefixed note path is the
    // measured worst case. This used to hold via structuralKeys; since OR-1 it
    // holds because the retrieval profile measures a path by its parts, which is
    // why the assertion is unchanged while the mechanism under it is gone. That
    // is the point of asserting behaviour instead of wiring.
    const NOTE = "notes/20260726-mla-redaction-fidelity-and-egress-boundary-proposal.md";
    const LEAKED = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8";

    const sent = applyEgressPolicy(
      EGRESS_RULES,
      "intel",
      "POST",
      "https://intel.invalid/internal/v1/active-review/detect",
      {
        workspaceId: "ws_1",
        ownerUserId: "user_a",
        dryRun: true,
        candidates: [
          { canonicalPath: NOTE, kind: "produced_doc", body: `token: ${LEAKED}` },
        ],
      },
    ) as any;

    // Byte-exact, or the detection is filed against a document that does not exist.
    expect(sent.candidates[0].canonicalPath).toBe(NOTE);
    // And the exemption is a key name, not an amnesty for the row.
    expect(JSON.stringify(sent)).not.toContain(LEAKED);
    expect(sent.candidates[0].kind).toBe("produced_doc");
  });

  it("scans the join key itself, so a credential cannot ride out inside a path", () => {
    // This is the leak that removing structuralKeys closed, asserted directly.
    // A structural key preserves its value WHOLE, so while canonicalPath was
    // named there it was the one field in this body that NO redaction touched:
    // both of these shipped raw to intel, byte for byte.
    //
    // The test deliberately uses credentials embedded in path-shaped strings.
    // Anything else would pass under either implementation and prove nothing:
    // the old bypass and the new walk agree on every ordinary path, and that
    // agreement is exactly what made the leak invisible for as long as it was.
    const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWX";
    const JWT =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    const sent = applyEgressPolicy(
      EGRESS_RULES,
      "intel",
      "POST",
      "https://intel.invalid/internal/v1/active-review/detect",
      {
        workspaceId: "ws_1",
        ownerUserId: "user_a",
        dryRun: true,
        candidates: [
          { canonicalPath: `notes/token-${TOKEN}.md`, kind: "produced_doc", body: "fine" },
          {
            canonicalPath: `notes/jwt-${JWT}.md`,
            kind: "produced_doc",
            // A sibling of the same shape, to keep the original claim too: no
            // key name here is exempt from the walk.
            otherPath: `notes/token-${TOKEN}.md`,
            body: "fine",
          },
        ],
      },
    ) as any;

    const wire = JSON.stringify(sent);
    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toContain(JWT);
    // Redacted in place, not eaten whole: the surviving path is still the join
    // key, which is the whole reason this row is `retrieval`.
    expect(sent.candidates[0].canonicalPath).toBe("notes/token-[REDACTED].md");
    expect(sent.candidates[1].canonicalPath).toBe("notes/jwt-[REDACTED].md");
    expect(sent.candidates[1].otherPath).toBe("notes/token-[REDACTED].md");
  });

  // The /v1/ask row is the one place where the boundary re-runs a redaction the
  // builder already ran. Ruling §6 allows exactly one owner per body, so this
  // row has to earn its place by being provably the SAME policy applied twice
  // rather than a second one that can disagree. These four tests are that proof.
  describe("the /v1/ask row (ruling §6: one owner, applied twice)", () => {
    const parity = JSON.parse(
      readFileSync(
        path.resolve(__dirname, "../../../ask-core/ask_payload_parity.json"),
        "utf8",
      ),
    ) as { input: Record<string, unknown>; wire: string };

    const askThrough = (body: unknown) =>
      applyEgressPolicy(EGRESS_RULES, "intel", "POST", "/v1/ask", body);

    it("is idempotent, so the boundary cannot alter what ask-core built", () => {
      // The whole argument for this row rests on this. If re-redacting changed a
      // single byte, the boundary would be a second policy silently rewriting
      // the first, and `mla ask` (which does NOT transit this transport) and the
      // MCP would put different bytes on the wire for the same question.
      const once = JSON.parse(parity.wire);
      expect(JSON.stringify(askThrough(once))).toBe(parity.wire);
    });

    it("still redacts if a future edit deletes the builder's redaction", () => {
      // Defense in depth, stated as a behaviour rather than a hope: feed the row
      // the RAW question ask-core starts from and the secret must not survive.
      const raw = { ...JSON.parse(parity.wire), question: parity.input.question };
      const sent = askThrough(raw) as Record<string, string>;
      expect(sent.question).not.toContain("sk-proj-");
      expect(sent.question).toContain("OPENAI_API_KEY=[REDACTED]");
      // ...and the retrieval key survives, which is why this row is `retrieval`
      // and not `full`.
      expect(sent.question).toContain("apps/console/app/settings/SettingsNav.tsx");
    });

    it("keeps the retrieval selector byte-exact", () => {
      // filters.paths is matched server-side. A redacted selector does not
      // return less, it returns nothing, and does it without saying so.
      const sent = askThrough({
        ...JSON.parse(parity.wire),
        filters: { canonical: true, paths: ["notes/20260726-mla-redaction.md"] },
      }) as any;
      expect(sent.filters.paths).toEqual(["notes/20260726-mla-redaction.md"]);
    });

    it("preserves user_id, the metering actor the row is attributed to", () => {
      // A workspace_users id, not a secret, and intel writes it straight onto
      // llm_usage_events.userId. Redacting it would be worse than dropping it:
      // the row would carry a mangled id that joins to nothing and looks
      // attributed. This test is coupled to the builders on purpose: the
      // boundary fails CLOSED on unclassified fields (the test right below), so
      // adding user_id to a builder without adding it here does not leak, it
      // throws, and `mla ask` stops working outright.
      const sent = askThrough({
        ...JSON.parse(parity.wire),
        user_id: "c00exampleuser00000000001",
      }) as Record<string, unknown>;
      expect(sent.user_id).toBe("c00exampleuser00000000001");
    });

    it("carries user_id: null through untouched when there is no actor", () => {
      const sent = askThrough({
        ...JSON.parse(parity.wire),
        user_id: null,
      }) as Record<string, unknown>;
      expect(sent.user_id).toBeNull();
    });

    it("fails closed on a field ask-core adds and nobody classifies here", () => {
      expect(() =>
        askThrough({ ...JSON.parse(parity.wire), reranker: "v2" }),
      ).toThrow(/unknown_field/);
    });

    it("classifies the retrieve route the primary MCP tool uses", () => {
      // meetless__retrieve_knowledge, missed by the first inventory pass and
      // caught only by driving the real MCP server against a live intel.
      const sent = applyEgressPolicy(
        EGRESS_RULES,
        "intel",
        "POST",
        "/v1/ask/retrieve?workspaceId=ws_1",
        {
          workspace_id: "ws_1",
          query: `where is ${SECRET} used in apps/console/app/settings/SettingsNav.tsx?`,
          source_context: { surface: "mcp" },
          limit: 8,
        },
      ) as any;
      expect(sent.query).not.toContain("sk-proj-");
      expect(sent.query).toContain("apps/console/app/settings/SettingsNav.tsx");
      expect(sent.source_context).toEqual({ surface: "mcp" });
    });
  });

  it("states what a passthrough actually carries, not what is convenient", () => {
    // Ruling §4: "Row 2 should not be described as 'ids only.' It contains at
    // least repoPath and branch." A `why` that undersells its own row is how the
    // next reader concludes there is nothing here to fix. The finalize row ships
    // absolute repo paths, branch names, file paths and raw git stderr, so it
    // may not describe itself as ids.
    const run = EGRESS_RULES.find((r) =>
      r.match.test("/internal/v1/agent-runs/by-session/abc/finalize"),
    );
    expect(run).toBeDefined();
    expect(run!.mode).toBe("passthrough");
    expect((run as any).fields).toContain("gitEvidence");
    expect((run as any).why).toMatch(/git stderr/);
    expect((run as any).why).toMatch(/NOT ids only/);
  });
});
