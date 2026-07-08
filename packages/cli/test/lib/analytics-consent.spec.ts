import {
  localStatsEnabled,
  remoteAnalyticsEnabled,
  traceUploadEnabled,
} from "../../src/lib/analytics/consent";

// INV-CONSENT-1: three independent privacy postures. Local stats default ON,
// remote analytics opt-OUT (default ON; ids-only, master kill is the off switch),
// trace upload opt-OUT, master kill wins over both remote planes.

describe("analytics consent (INV-CONSENT-1)", () => {
  describe("localStatsEnabled", () => {
    it("defaults ON when unset", () => {
      expect(localStatsEnabled({})).toBe(true);
    });
    it("stays ON regardless of the remote master kill", () => {
      // Local stats are offline-only; the telemetry kill switch must NOT silence
      // them (INV-LOCAL-STATS-1).
      expect(localStatsEnabled({ MEETLESS_TELEMETRY: "off" })).toBe(true);
    });
    it.each(["off", "0", "false", "no", "OFF", " No "])(
      "is OFF for explicit off-value %p",
      (v) => {
        expect(localStatsEnabled({ MEETLESS_LOCAL_STATS: v })).toBe(false);
      },
    );
    it("is ON for any non-off value", () => {
      expect(localStatsEnabled({ MEETLESS_LOCAL_STATS: "on" })).toBe(true);
    });
  });

  describe("remoteAnalyticsEnabled (opt-out)", () => {
    it("defaults ON when unset", () => {
      expect(remoteAnalyticsEnabled({})).toBe(true);
    });
    it.each(["on", "1", "true", "yes", "YES", " On "])(
      "stays ON for an explicit truthy MEETLESS_TELEMETRY %p",
      (v) => {
        expect(remoteAnalyticsEnabled({ MEETLESS_TELEMETRY: v })).toBe(true);
      },
    );
    it.each(["off", "0", "false", "no", "OFF", " No "])(
      "is OFF for explicit off-value MEETLESS_TELEMETRY %p (the opt-out kill switch)",
      (v) => {
        expect(remoteAnalyticsEnabled({ MEETLESS_TELEMETRY: v })).toBe(false);
      },
    );
    it("master kill via MEETLESS_NO_TELEMETRY wins even with TELEMETRY unset (default ON)", () => {
      expect(remoteAnalyticsEnabled({ MEETLESS_NO_TELEMETRY: "1" })).toBe(false);
    });
    it("master kill via MEETLESS_NO_TELEMETRY wins even if TELEMETRY truthy", () => {
      expect(
        remoteAnalyticsEnabled({ MEETLESS_TELEMETRY: "on", MEETLESS_NO_TELEMETRY: "1" }),
      ).toBe(false);
    });
  });

  describe("traceUploadEnabled (opt-out)", () => {
    it("defaults ON (absence preserves existing trace-plane behavior)", () => {
      expect(traceUploadEnabled({})).toBe(true);
    });
    it("is OFF for an explicit content sub-kill", () => {
      expect(traceUploadEnabled({ MEETLESS_TRACE_UPLOAD: "off" })).toBe(false);
    });
    it("master kill wins over the trace plane", () => {
      expect(traceUploadEnabled({ MEETLESS_TELEMETRY: "off" })).toBe(false);
      expect(traceUploadEnabled({ MEETLESS_NO_TELEMETRY: "true" })).toBe(false);
    });
    it("stays ON when only the analytics opt-in is set", () => {
      expect(traceUploadEnabled({ MEETLESS_TELEMETRY: "on" })).toBe(true);
    });
  });
});
