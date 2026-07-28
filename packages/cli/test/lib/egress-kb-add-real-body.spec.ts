// `mla kb add` was a DEAD COMMAND, and three suites watched it happen.
//
// The egress registry's allowlist for `POST /internal/v1/kb/add` omitted
// `agentSession` and `corpusName`. commands/kb_add.ts puts both keys on every
// request envelope it builds (as `undefined` when absent, which still puts the
// KEY on the object the classifier reads), so the boundary refused every single
// invocation with `unknown_field` before a byte left the process:
//
//   kb add: a batch did not land: egress unknown_field:
//     POST intel/internal/v1/kb/add (unclassified top-level field(s):
//     agentSession, corpusName)
//
// Why nothing caught it:
//
//   egress-wire-recording.spec.ts   generates bodies FROM the rule, so rule and
//                                   body agree by construction.
//   egress-caller-bodies.spec.ts    HAS a witness for this route, and the
//                                   witness was written from the rule rather
//                                   than read from the caller it named. It
//                                   carried `captureMethod: "cli"` (not a value
//                                   the route accepts), `mode: "upsert"` (the
//                                   field is "file" | "corpus") and a
//                                   `provenance` object (every caller sends a
//                                   string). Fixed alongside this file.
//   the command specs               inject their transport above http.ts, so no
//                                   spec drove a real body through the real
//                                   policy.
//
// The durable fix is this file: it imports the PRODUCER, not a transcription of
// it. `buildKbAddBaseBody` is the one place commands/kb_add.ts builds its
// envelope, so a field added there and not classified here fails at build time
// in CI instead of at the user's terminal.

import {
  EgressPolicyError,
  applyEgressPolicy,
} from "../../src/lib/egress/policy";
import { EGRESS_RULES } from "../../src/lib/egress/rules";
import { buildKbAddBaseBody } from "../../src/commands/kb_add";

const INTEL_URL = "https://intel.example.test/internal/v1/kb/add";
const CONTROL_URL = "https://control.example.test/internal/v1/kb/add";

/** One document, shaped the way enumerateDocuments emits them. */
const DOCS = [{ relPath: "notes/20260728-x.md", content: "# x\n\nbody\n" }];

function send(body: unknown, service: "intel" | "control" = "intel"): unknown {
  return applyEgressPolicy(
    EGRESS_RULES,
    service,
    "POST",
    service === "intel" ? INTEL_URL : CONTROL_URL,
    body,
  );
}

/** The kb/add allowlist, read off the live registry rather than restated. */
function intelKbAddFields(): readonly string[] {
  const rule = EGRESS_RULES.find(
    (r) =>
      r.service === "intel" &&
      r.method === "POST" &&
      r.match.test("/internal/v1/kb/add"),
  );
  if (!rule) throw new Error("no intel kb/add rule");
  return Array.isArray(rule.fields) ? rule.fields : Object.keys(rule.fields);
}

describe("kb add: the real envelope crosses the real boundary", () => {
  // The exact shape that failed in production on 2026-07-28: a single file, no
  // corpus marker, no agent session. Both optional keys are present-and-undefined.
  //
  // The ids are synthetic. They were the live dogfood workspace and actor, which
  // this file ships to the public mirror; the mirror's identifier gate refused the
  // 0.2.28 export over them. Nothing here reads an id, only the field names it is
  // filed under, so realism costs a disclosure and buys no coverage.
  it("accepts a single-file add with no session and no corpus", () => {
    const base = buildKbAddBaseBody({
      workspaceId: "cmexample40a1b2c3d4e5f6g7",
      actor: "c00example41a1b2c3d4e5f6g",
      provenance: "agent_distilled",
      profile: "",
      agentSession: null,
      mode: "file",
      corpusName: undefined,
    });

    // The regression, stated as the property that failed: the keys ARE there,
    // even with nothing to put in them, so the classifier has to know them.
    expect(Object.keys(base)).toEqual(
      expect.arrayContaining(["agentSession", "corpusName"]),
    );
    expect(base.agentSession).toBeUndefined();
    expect(base.corpusName).toBeUndefined();

    expect(() => send({ ...base, documents: DOCS })).not.toThrow();
  });

  it("accepts a corpus add carrying a session and a corpus name", () => {
    const body = {
      ...buildKbAddBaseBody({
        workspaceId: "ws_1",
        actor: "user_1",
        provenance: "human_authored",
        profile: "markdown_atomic_v1",
        agentSession: "5f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
        mode: "corpus",
        corpusName: "notes",
      }),
      documents: DOCS,
    };
    expect(() => send(body)).not.toThrow();
  });

  // block_on_detect never rewrites this body: a redacted document is a
  // permanently wrong document. Prove the envelope change did not turn the
  // route into a passthrough that echoes an edited copy.
  it("returns the body byte-identical when clean", () => {
    const body = {
      ...buildKbAddBaseBody({
        workspaceId: "ws_1",
        actor: "user_1",
        provenance: "agent_distilled",
        profile: "markdown_atomic_v1",
        agentSession: null,
        mode: "file",
        corpusName: undefined,
      }),
      documents: DOCS,
    };
    expect(JSON.stringify(send(body))).toBe(JSON.stringify(body));
  });

  it("still refuses a credential in a document body", () => {
    const body = {
      ...buildKbAddBaseBody({
        workspaceId: "ws_1",
        actor: "user_1",
        provenance: "agent_distilled",
        profile: "markdown_atomic_v1",
        agentSession: null,
        mode: "file",
        corpusName: undefined,
      }),
      documents: [
        {
          relPath: "notes/leak.md",
          content: "token: xoxb-111111111111-222222222222-abcdefghijklmnopqrstuvwx\n",
        },
      ],
    };
    expect(() => send(body)).toThrow(EgressPolicyError);
    try {
      send(body);
    } catch (e) {
      expect((e as EgressPolicyError).reason).toBe("blocked");
    }
  });
});

describe("kb add: the allowlist is bounded on both sides", () => {
  // Direction 1, producer -> rule. Every key the real builder emits must be
  // classified. This is the assertion that would have failed before the fix.
  it("classifies every key commands/kb_add.ts emits", () => {
    const emitted = Object.keys(
      buildKbAddBaseBody({
        workspaceId: "ws_1",
        actor: "user_1",
        provenance: "agent_distilled",
        profile: "markdown_atomic_v1",
        agentSession: "5f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
        mode: "corpus",
        corpusName: "notes",
      }),
    );
    const allowed = new Set(intelKbAddFields());
    expect(emitted.filter((k) => !allowed.has(k))).toEqual([]);
  });

  // Direction 2, rule -> server. intel's `KbAddRequest`
  // (intel app/api/routes/kb_add.py) is the authority: a field this rule
  // pre-authorizes that the server does not model is a standing permission for
  // a field nobody has reviewed. Restated here because the model lives in
  // another repo and cannot be imported; keep the two in step by hand.
  it("stays a subset of intel's KbAddRequest model", () => {
    const SERVER_MODEL = [
      "workspaceId",
      "actor",
      "documents",
      "provenance",
      "profile",
      "agentSession",
      "mode",
      "corpusName",
      "captureMethod",
      "bindingId",
      "consentedAt",
    ];
    const extra = intelKbAddFields().filter((f) => !SERVER_MODEL.includes(f));
    expect(extra).toEqual([]);
  });
});

describe("kb add: control is not a kb/add target", () => {
  // All three producers (commands/kb_add.ts, agent-memory-capture/upsert-client,
  // commands/enrich.ts) call intelPost, which tags the service "intel"
  // unconditionally. The registry used to carry a "control relay" row nothing
  // could reach. Fail closed instead: an unreachable row is a pre-authorization
  // for whoever adds that call site later.
  it("has no control kb/add rule", () => {
    const row = EGRESS_RULES.find(
      (r) =>
        r.service === "control" &&
        r.method === "POST" &&
        r.match.test("/internal/v1/kb/add"),
    );
    expect(row).toBeUndefined();
  });

  it("refuses a control-targeted kb/add outright", () => {
    const body = {
      ...buildKbAddBaseBody({
        workspaceId: "ws_1",
        actor: "user_1",
        provenance: "agent_distilled",
        profile: "markdown_atomic_v1",
        agentSession: null,
        mode: "file",
        corpusName: undefined,
      }),
      documents: DOCS,
    };
    expect(() => send(body, "control")).toThrow(EgressPolicyError);
    try {
      send(body, "control");
    } catch (e) {
      expect((e as EgressPolicyError).reason).toBe("no_rule");
    }
  });
});
