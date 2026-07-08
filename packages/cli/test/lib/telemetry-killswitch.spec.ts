// Phase 4.4 (OSS hardening): the telemetry kill switch is the single, grep-able
// guarantee that nothing leaves the machine. telemetryDisabled() forces BOTH
// outbound content planes off: initSentry() refuses to init, and (via
// traceUploadEnabled(), which the master kill always wins over) cli.ts builds a
// null flushFn so the trace plane is a no-op tracer (zero POSTs). The
// MEETLESS_TRACE_UPLOAD content sub-kill can also null the flushFn on its own.
// These tests pin the env-parsing contract and the initSentry early-return.

import { telemetryDisabled, initSentry } from "../../src/lib/observability";
import type { BuildInfo } from "../../src/lib/observability";

const baseBuild: BuildInfo = {
  version: "0.1.0",
  sha: "deadbee",
  branch: "test",
  dirty: false,
  builtAt: "2026-06-06T00:00:00.000Z",
};

describe("telemetryDisabled: env-parsing contract (4.4)", () => {
  it("is false when neither kill-switch env is set", () => {
    expect(telemetryDisabled({})).toBe(false);
  });

  it.each(["off", "0", "false", "no", "OFF", "Off", " off "])(
    "is true for MEETLESS_TELEMETRY=%j",
    (val) => {
      expect(telemetryDisabled({ MEETLESS_TELEMETRY: val })).toBe(true);
    },
  );

  it.each(["on", "1", "true", "yes", "enabled"])(
    "is false for MEETLESS_TELEMETRY=%j (only explicit off disables)",
    (val) => {
      expect(telemetryDisabled({ MEETLESS_TELEMETRY: val })).toBe(false);
    },
  );

  it.each(["1", "true", "yes", "on"])(
    "is true for any truthy MEETLESS_NO_TELEMETRY=%j",
    (val) => {
      expect(telemetryDisabled({ MEETLESS_NO_TELEMETRY: val })).toBe(true);
    },
  );

  it.each(["", "0", "false", "no"])(
    "is false for falsy MEETLESS_NO_TELEMETRY=%j",
    (val) => {
      expect(telemetryDisabled({ MEETLESS_NO_TELEMETRY: val })).toBe(false);
    },
  );

  it("defaults to reading process.env when no arg is passed", () => {
    const prev = process.env.MEETLESS_TELEMETRY;
    try {
      process.env.MEETLESS_TELEMETRY = "off";
      expect(telemetryDisabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MEETLESS_TELEMETRY;
      else process.env.MEETLESS_TELEMETRY = prev;
    }
  });
});

describe("initSentry: kill switch wins over a baked DSN (4.4)", () => {
  it("returns false (never inits) when telemetry is disabled, even with a baked DSN", () => {
    const prev = process.env.MEETLESS_TELEMETRY;
    try {
      process.env.MEETLESS_TELEMETRY = "off";
      const withDsn: BuildInfo = {
        ...baseBuild,
        sentryDsn: "https://public@example.test/1",
      };
      // Returning false here means we short-circuited BEFORE Sentry.init,
      // so no SDK init / no transport is wired.
      expect(initSentry(withDsn)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MEETLESS_TELEMETRY;
      else process.env.MEETLESS_TELEMETRY = prev;
    }
  });

  it("returns false when no DSN is baked and no dev override is set (OSS default OFF)", () => {
    const prevT = process.env.MEETLESS_TELEMETRY;
    const prevM = process.env.MEETLESS_SENTRY_DSN;
    const prevL = process.env.MLA_SENTRY_DSN;
    try {
      delete process.env.MEETLESS_TELEMETRY;
      delete process.env.MEETLESS_SENTRY_DSN;
      delete process.env.MLA_SENTRY_DSN;
      expect(initSentry(baseBuild)).toBe(false);
    } finally {
      if (prevT !== undefined) process.env.MEETLESS_TELEMETRY = prevT;
      if (prevM !== undefined) process.env.MEETLESS_SENTRY_DSN = prevM;
      if (prevL !== undefined) process.env.MLA_SENTRY_DSN = prevL;
    }
  });
});
