import { ANALYTICS_INGEST_PATH } from "../../src/lib/analytics/forwarder";
import { EGRESS_RULES } from "../../src/lib/egress/rules";
import { applyEgressPolicy, resolveRule } from "../../src/lib/egress/policy";
import { redactSentryEvent } from "../../src/lib/observability";
import {
  SENSITIVE_KEY,
  redactStructured,
} from "../../src/lib/redact-structured";
import { REDACTED } from "../../src/lib/redactor";

const TRACE_INGEST_PATH = "/internal/v1/agent-traces/ingest";

/**
 * One structure-aware sanitizer, two planes (ruling §3).
 *
 * The gap this closes was live and is easy to state. `redact()` reads a string and
 * knows nothing about its key, which is fine for prose and useless for telemetry,
 * because telemetry ships the key next to the value and the key is frequently the
 * only evidence that the value is a credential. Measured against the real
 * redactor, all four of these leave verbatim:
 *
 *     { "password":      "Tr0ub4dor&3"      }
 *     { "authorization": "ZGV2Omh1bnRlcjI=" }
 *     { "x-api-key":     "sk-local-dev-1234" }
 *     { "cookie":        "session=abc123"   }
 *
 * None clears the 32-character entropy bar, none carries a provider prefix, and
 * none is a Bearer or Basic form. The scheme matters: "Basic ZGV2Omh1bnRlcjI="
 * IS caught by value alone, so the leak is specifically the schemeless case, and
 * these fixtures are the measured ones rather than the intuitive ones.
 *
 * Sentry's beforeSend dropped all four, because it had a key-aware walker of its
 * own. The egress boundary shipped all four, because it had a value-only one.
 * Same class of payload, two walkers, one of them blind.
 *
 * §3 said to reuse the existing sanitizer rather than grow a second, so there is
 * now exactly one (`redact-structured.ts`) and both planes call it. These tests
 * exist to keep that true: the parity assertions below fail the moment either
 * plane starts walking a payload its own way again.
 */
describe("the shared structure-aware sanitizer at the egress boundary", () => {
  // Short and unremarkable ON PURPOSE. If these were 40-char high-entropy tokens
  // the value rules would eat them and the test would prove nothing about keys.
  //
  // SCHEMELESS on purpose too. "Basic ZGV2Omh1bnRlcjI=" is caught by value alone,
  // so it would pass these tests without the key rule ever firing. The bare
  // credential is the case only the key can decide, and it is the realistic one:
  // header bags flatten, and what lands in a span attribute is frequently the
  // value with its scheme already stripped.
  const BASIC_CRED = "ZGV2Omh1bnRlcjI=";
  const PASSWORD = "Tr0ub4dor&3";

  const eventsBody = (properties: Record<string, unknown>) => ({
    workspaceId: "ws-1",
    events: [
      {
        event_type: "mla_command",
        schema_version: 1,
        ts: "2026-07-26T00:00:00.000Z",
        ...properties,
      },
    ],
  });

  const sendEvents = (body: unknown) =>
    applyEgressPolicy(
      EGRESS_RULES,
      "control",
      "POST",
      ANALYTICS_INGEST_PATH,
      body,
    ) as { events: Array<Record<string, unknown>> };

  const traceBody = (attributes: Record<string, unknown>) => ({
    workspaceId: "ws-1",
    traceId: "a".repeat(32),
    client: { mlaVersion: "0.2.27", platform: "darwin" },
    rootSpan: {
      spanId: "b".repeat(16),
      name: "mla ask",
      attributes,
    },
    spans: [
      {
        spanId: "c".repeat(16),
        parentSpanId: "b".repeat(16),
        name: "http.request",
        attributes,
      },
    ],
  });

  const sendTrace = (body: unknown) =>
    applyEgressPolicy(
      EGRESS_RULES,
      "control",
      "POST",
      TRACE_INGEST_PATH,
      body,
    ) as {
      traceId: string;
      client: unknown;
      rootSpan: Record<string, unknown>;
      spans: Array<Record<string, unknown>>;
    };

  it("pins the premise: the value rules alone do not catch these", () => {
    // The load-bearing measurement. Every comment in this change asserts that a
    // schemeless credential survives value-only redaction, and that assertion is
    // the ENTIRE justification for key-awareness. Pin it, so it cannot quietly
    // stop being true.
    //
    // If this fails because the value rules got stronger: good news, but the
    // comments in redact-structured.ts, egress/policy.ts, egress/rules.ts and
    // observability.ts now overstate the gap and must be re-measured. If it fails
    // because a value rule got WEAKER, that is the real alarm.
    const survivesValueRules = {
      password: PASSWORD,
      authorization: BASIC_CRED,
      "x-api-key": "sk-local-dev-1234",
      cookie: "session=abc123",
    };
    expect(redactStructured(survivesValueRules, {})).toEqual(
      survivesValueRules,
    );

    // And the scheme-carrying form is NOT part of the gap: the value rules
    // already eat it, which is why it is the wrong fixture for every test below.
    expect(
      redactStructured({ note: `Basic ${BASIC_CRED}` }, {}),
    ).toEqual({ note: REDACTED });
  });

  it("drops a short key-named credential from an analytics event", () => {
    // The leak, on the route it leaked from. Every one of these values is below
    // every value-based bar; the key name is the whole signal.
    const wire = sendEvents(
      eventsBody({ authorization: BASIC_CRED, password: PASSWORD }),
    );
    const event = wire.events[0];

    expect(event.authorization).toBe(REDACTED);
    expect(event.password).toBe(REDACTED);
    expect(JSON.stringify(wire)).not.toContain(PASSWORD);
    expect(JSON.stringify(wire)).not.toContain(BASIC_CRED);

    // The event still means something. A batch that arrived as an unbroken wall
    // of [REDACTED] would be a different bug, not a fix.
    expect(event.event_type).toBe("mla_command");
    expect(event.schema_version).toBe(1);
    expect(wire).toHaveProperty("workspaceId", "ws-1");
  });

  it("drops it from a nested span attribute bag too", () => {
    // Depth is where a key-name rule earns its keep: `fields` classifies TOP-LEVEL
    // keys, so `spans` is one "redact" decision and everything under it is the
    // walker's problem.
    const wire = sendTrace(
      traceBody({
        "http.url": "https://api.example.com",
        authorization: BASIC_CRED,
      }),
    );

    expect(wire.rootSpan.attributes).toMatchObject({ authorization: REDACTED });
    expect(
      (wire.spans[0].attributes as Record<string, unknown>).authorization,
    ).toBe(REDACTED);
    expect(JSON.stringify(wire)).not.toContain(BASIC_CRED);
  });

  it("leaves the same string alone under a content key", () => {
    // The bound on the blast radius, as a clean A/B: ONE string, two keys, two
    // outcomes. The key is doing all the work, which is both the feature and its
    // limit. A credential-shaped sentence in a message field is still just text,
    // and the VALUE rules decide what happens to it (here: nothing, which is the
    // honest residual of a name-based rule, not a claim that prose is safe).
    const wire = sendEvents(
      eventsBody({
        authorization: BASIC_CRED,
        message: `the header was ${BASIC_CRED} at the time`,
      }),
    );

    expect(wire.events[0].authorization).toBe(REDACTED);
    expect(wire.events[0].message).toBe(
      `the header was ${BASIC_CRED} at the time`,
    );
  });

  it("keeps the trace join keys and the parent edge byte-exact", () => {
    // A trace whose ids were redacted is not a safer trace, it is a destroyed one:
    // traceId joins the CLI plane to control's, and parentSpanId is the only thing
    // that makes the batch a tree rather than a bag.
    //
    // Note what changed and what did not. spanId/parentSpanId survived BEFORE this
    // by accident of width (16 hex < the 32-char entropy bar); they now survive by
    // NAME (SAFE_IDENTIFIER_KEY). Same output today, a better reason tomorrow: a
    // future 32-char span id would have started disappearing silently.
    const wire = sendTrace(traceBody({ authorization: BASIC_CRED }));

    expect(wire.traceId).toBe("a".repeat(32));
    expect(wire.client).toEqual({ mlaVersion: "0.2.27", platform: "darwin" });
    expect(wire.rootSpan.spanId).toBe("b".repeat(16));
    expect(wire.spans[0].spanId).toBe("c".repeat(16));
    expect(wire.spans[0].parentSpanId).toBe("b".repeat(16));
    expect(wire.spans[0].name).toBe("http.request");
  });

  it("produces byte-identical output to the Sentry plane for the same tree", () => {
    // THE parity lock, and the reason this file exists. Both planes walk the same
    // shape with the same options (profile `full`, keyAware, no structural keys),
    // so their outputs must be indistinguishable. If someone re-privatizes either
    // walker, this is the assertion that fails.
    const span = {
      spanId: "c".repeat(16),
      parentSpanId: "b".repeat(16),
      name: "http.request",
      attributes: {
        authorization: BASIC_CRED,
        password: PASSWORD,
        "http.url": "https://api.example.com/v1/ask",
        input_tokens: 1024,
        note: "retried once after a 429",
      },
    };

    const viaEgress = sendTrace({
      workspaceId: "ws-1",
      traceId: "a".repeat(32),
      client: { mlaVersion: "0.2.27", platform: "darwin" },
      rootSpan: { spanId: "b".repeat(16), name: "mla ask", attributes: {} },
      spans: [span],
    }).spans[0];

    expect(viaEgress).toEqual(redactSentryEvent(span));
  });

  it("does not eat LLM token accounting", () => {
    // `\btoken\b` deliberately fails on `input_tokens` and `token_count`: `s` and
    // `_` are word characters, so the trailing boundary never matches. Cost and
    // latency analytics are the main consumer of these events; a rule that ate
    // them would have been reverted the same day, and reverted key-awareness with
    // it.
    const wire = sendEvents(
      eventsBody({ input_tokens: 1024, output_tokens: 77, token_count: 1101 }),
    );
    expect(wire.events[0]).toMatchObject({
      input_tokens: 1024,
      output_tokens: 77,
      token_count: 1101,
    });
  });

  it("is idempotent, so a re-send cannot degrade a body further", () => {
    const once = sendEvents(
      eventsBody({ authorization: BASIC_CRED, note: "hello" }),
    );
    expect(sendEvents(once)).toEqual(once);
  });

  it("leaves value-only rows exactly as they were", () => {
    // Key-awareness is OPT-IN and this is why: SENSITIVE_KEY carries an unanchored
    // `secret`, which is correct for a span-attribute bag and wrong for operator
    // prose. A governance rationale field named `secretRotationPlan` must be
    // redacted by VALUE, not deleted by NAME, so a row that carries prose keeps
    // the walk it always had.
    const prose = { secretRotationPlan: "rotate the signing key each quarter" };
    expect(redactStructured(prose, {})).toEqual(prose);
    expect(redactStructured(prose, { keyAware: true })).toEqual({
      secretRotationPlan: REDACTED,
    });
  });

  it("scopes key-awareness to exactly the two telemetry rows", () => {
    // The scope assertion. Ruling §3 named these two and nothing else; anything
    // added here is a decision someone has to make on purpose, in a diff that
    // shows up in this test.
    const keyAwareRoutes = EGRESS_RULES.filter(
      (r) => r.mode === "redact" && r.keyAware === true,
    ).map((r) => `${r.service} ${r.method} ${r.match.source}`);

    expect(new Set(keyAwareRoutes)).toEqual(
      new Set([
        "control POST ^\\/internal\\/v1\\/analytics\\/events$",
        "control POST ^\\/internal\\/v1\\/agent-traces\\/ingest$",
      ]),
    );

    // And the routes really are the ones we think they are.
    for (const path of [ANALYTICS_INGEST_PATH, TRACE_INGEST_PATH]) {
      const rule = resolveRule(EGRESS_RULES, "control", "POST", path);
      expect(rule.mode).toBe("redact");
      if (rule.mode === "redact") expect(rule.keyAware).toBe(true);
    }
  });

  it("forbids a structural key that is also a credential key", () => {
    // The two name-based knobs point opposite ways, and a name in both would be a
    // rule that preserves a credential. The walker resolves it safely (SENSITIVE
    // is checked first), but a registry that can express the contradiction at all
    // is a registry someone will eventually trust. So: unrepresentable by test.
    for (const rule of EGRESS_RULES) {
      if (rule.mode !== "redact") continue;
      for (const key of rule.structuralKeys ?? []) {
        expect({ route: rule.match.source, key, sensitive: SENSITIVE_KEY.test(key) })
          .toEqual({ route: rule.match.source, key, sensitive: false });
      }
    }
  });
});
