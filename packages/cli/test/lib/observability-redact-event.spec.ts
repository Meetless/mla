// T21b: the Sentry beforeSend redactor (§9 redaction invariant, Finding K / P7).
// Proves no credential leaves the process via telemetry: Authorization headers,
// access/refresh tokens, the one-time grant code, the PKCE codeVerifier, and
// INTERNAL_API_KEY are scrubbed from every place Sentry can carry them
// (request headers, breadcrumb data, contexts, extra, exception/stack vars),
// while benign fields (error code, http status, messages) survive intact.

import { redactSentryEvent } from "../../src/lib/observability";
import { REDACTED } from "../../src/lib/redactor";

// Realistic high-entropy stand-ins. The grant code is 64-hex (matches control's
// ExchangeCliLoginGrantDto `^[0-9a-f]{64}$`); the codeVerifier is 43-char
// base64url (matches the PKCE DTO). Tokens use the ctk_/crf_ prefixes login.ts
// mints. These must NOT appear anywhere in the scrubbed event.
const ACCESS_TOKEN = "ctk_" + "a1B2c3D4e5F6g7H8".repeat(3);
const REFRESH_TOKEN = "crf_" + "Z9y8X7w6V5u4T3s2".repeat(3);
const GRANT_CODE = "0123456789abcdef".repeat(4); // 64-hex, uniform high entropy
const CODE_VERIFIER = "dBjftJeZ4CVP_mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const INTERNAL_API_KEY = "ik_" + "9Q7r5T3p1N0m8K6j4H2g".repeat(2);
const BEARER_HEADER = `Bearer ${ACCESS_TOKEN}`;

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

describe("redactSentryEvent", () => {
  it("scrubs every credential from every nesting site, keeps benign fields", () => {
    const event = {
      message: "request failed",
      tags: { trace_source: "mla-cli", controlToken: ACCESS_TOKEN },
      request: {
        url: "https://control.meetless.ai/internal/v1/auth/token/refresh",
        headers: {
          Authorization: BEARER_HEADER,
          "Content-Type": "application/json",
          "X-Trace-ID": "0123456789abcdef0123456789abcdef",
        },
      },
      contexts: {
        cli: { code: "ENOENT", status: 401, accessToken: ACCESS_TOKEN },
      },
      extra: {
        refreshToken: REFRESH_TOKEN,
        codeVerifier: CODE_VERIFIER,
        grantCode: GRANT_CODE,
        internalApiKey: INTERNAL_API_KEY,
        note: "rotation failed",
      },
      breadcrumbs: [
        {
          category: "http",
          data: {
            access_token: ACCESS_TOKEN,
            refresh_token: REFRESH_TOKEN,
            body: `{"accessToken":"${ACCESS_TOKEN}"}`,
          },
        },
      ],
      exception: {
        values: [
          {
            type: "Error",
            value: `refresh failed with ${BEARER_HEADER}`,
            stacktrace: {
              frames: [{ vars: { token: ACCESS_TOKEN, codeVerifier: CODE_VERIFIER } }],
            },
          },
        ],
      },
    };

    const scrubbed = redactSentryEvent(event)!;
    const dump = serialize(scrubbed);

    // 1. No raw secret survives anywhere in the serialized event.
    for (const secret of [
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      GRANT_CODE,
      CODE_VERIFIER,
      INTERNAL_API_KEY,
      BEARER_HEADER,
    ]) {
      expect(dump).not.toContain(secret);
    }

    // 2. Sensitive keys are redacted by name even when nested.
    expect(scrubbed.tags.controlToken).toBe(REDACTED);
    expect(scrubbed.request.headers.Authorization).toBe(REDACTED);
    expect(scrubbed.contexts.cli.accessToken).toBe(REDACTED);
    expect(scrubbed.extra.refreshToken).toBe(REDACTED);
    expect(scrubbed.extra.codeVerifier).toBe(REDACTED);
    expect(scrubbed.extra.internalApiKey).toBe(REDACTED);
    expect(scrubbed.breadcrumbs[0].data.access_token).toBe(REDACTED);
    expect(scrubbed.breadcrumbs[0].data.refresh_token).toBe(REDACTED);
    expect(scrubbed.exception.values[0].stacktrace.frames[0].vars.token).toBe(REDACTED);
    expect(scrubbed.exception.values[0].stacktrace.frames[0].vars.codeVerifier).toBe(
      REDACTED,
    );

    // 3. The high-entropy grant code (a benign-named `grantCode` field) is caught
    //    by the value redactor even though its KEY is not on the sensitive list.
    expect(scrubbed.extra.grantCode).toBe(REDACTED);

    // 4. Bearer values embedded in free-text strings are scrubbed too.
    expect(scrubbed.exception.values[0].value).not.toContain(ACCESS_TOKEN);
    expect(scrubbed.exception.values[0].value).toContain(REDACTED);

    // 5. Benign fields survive: error code, http status, messages, trace id.
    expect(scrubbed.contexts.cli.code).toBe("ENOENT");
    expect(scrubbed.contexts.cli.status).toBe(401);
    expect(scrubbed.message).toBe("request failed");
    expect(scrubbed.extra.note).toBe("rotation failed");
    expect(scrubbed.request.headers["Content-Type"]).toBe("application/json");
    expect(scrubbed.request.headers["X-Trace-ID"]).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(scrubbed.tags.trace_source).toBe("mla-cli");
  });

  it("returns null/undefined inputs untouched (no throw)", () => {
    expect(redactSentryEvent(null)).toBeNull();
    expect(redactSentryEvent(undefined)).toBeUndefined();
  });
});
