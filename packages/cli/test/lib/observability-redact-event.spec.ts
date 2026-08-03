// T21b: the credential walker behind Sentry's beforeSend (§9 redaction
// invariant, Finding K / P7).
//
// `redactSentryEvent` is no longer beforeSend itself; `scrubSentryEvent` is,
// and it composes this walker with the exception-message reduction (see the
// second describe below, and sentry-event-reduction.spec.ts for the plane-level
// proof). This half is still pinned separately because egress-structured-
// sanitizer.spec.ts holds it byte-identical to the egress plane's walker.
// Proves no credential leaves the process via telemetry: Authorization headers,
// access/refresh tokens, the one-time grant code, the PKCE codeVerifier, and
// INTERNAL_API_KEY are scrubbed from every place Sentry can carry them
// (request headers, breadcrumb data, contexts, extra, exception/stack vars),
// while benign fields (error code, http status, messages) survive intact.

import {
  redactSentryEvent,
  scrubSentryEvent,
  SENTRY_MESSAGE_WITHHELD,
} from "../../src/lib/observability";
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

// One event carrying a credential at every nesting site Sentry can reach.
// Built fresh per call because both walkers mutate in place.
function credentialEvent() {
  return {
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
}

describe("redactSentryEvent", () => {
  it("scrubs every credential from every nesting site, keeps benign fields", () => {
    const scrubbed = redactSentryEvent(credentialEvent())!;
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

// The function that is ACTUALLY wired to beforeSend. The describe above pins the
// walker in isolation because the egress plane holds it byte-identical; this one
// pins the composition, so a future refactor cannot drop the walker half while
// keeping the reduction (or the reverse) and still look green.
describe("scrubSentryEvent (the real beforeSend)", () => {
  it("still scrubs every credential the walker alone catches", () => {
    const scrubbed = scrubSentryEvent(credentialEvent())!;
    const dump = serialize(scrubbed);

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

    expect(scrubbed.tags.controlToken).toBe(REDACTED);
    expect(scrubbed.request.headers.Authorization).toBe(REDACTED);
    expect(scrubbed.contexts.cli.accessToken).toBe(REDACTED);
    expect(scrubbed.extra.refreshToken).toBe(REDACTED);
    expect(scrubbed.extra.codeVerifier).toBe(REDACTED);
    expect(scrubbed.extra.internalApiKey).toBe(REDACTED);
    expect(scrubbed.extra.grantCode).toBe(REDACTED);
    expect(scrubbed.breadcrumbs[0].data.access_token).toBe(REDACTED);
    expect(scrubbed.breadcrumbs[0].data.refresh_token).toBe(REDACTED);
    expect(scrubbed.exception.values[0].stacktrace.frames[0].vars.token).toBe(REDACTED);

    // Benign fields still survive the composition.
    expect(scrubbed.contexts.cli.code).toBe("ENOENT");
    expect(scrubbed.contexts.cli.status).toBe(401);
    expect(scrubbed.extra.note).toBe("rotation failed");
    expect(scrubbed.tags.trace_source).toBe("mla-cli");
  });

  it("replaces the exception message outright instead of scrubbing inside it", () => {
    // The walker's best case on free text is a partial: it found the Bearer
    // token in "refresh failed with <token>" and left the English around it.
    // That is the whole INV-ARGV-1 lesson, so beforeSend does not try to clean
    // prose, it declines to ship it.
    expect(redactSentryEvent(credentialEvent())!.exception.values[0].value).toContain(
      "refresh failed with",
    );
    expect(scrubSentryEvent(credentialEvent())!.exception.values[0].value).toBe(
      SENTRY_MESSAGE_WITHHELD,
    );
  });

  it("leaves captureMessage's top-level message alone", () => {
    // `event.message` is ours by construction: captureCliNonZeroExit builds it
    // from the already-reduced command keyword. Reducing it would delete the
    // only content of a non-exception event.
    expect(scrubSentryEvent(credentialEvent())!.message).toBe("request failed");
  });

  it("returns null/undefined inputs untouched (no throw)", () => {
    expect(scrubSentryEvent(null)).toBeNull();
    expect(scrubSentryEvent(undefined)).toBeUndefined();
  });
});
