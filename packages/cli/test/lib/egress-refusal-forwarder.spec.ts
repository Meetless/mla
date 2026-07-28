// The analytics-forward half of ruling §2 (the rest is in egress-refusal-diagnostic.spec.ts).
//
// Split into its own file on purpose. `forwardEvents` imports `post` rather than taking it
// as a dep, so the only way to make it fail is a module mock, and a module mock needs
// jest.resetModules. That mints a SECOND EgressPolicyError class: an error built from the
// statically-imported class is no longer `instanceof` the class the re-required code sees,
// so describeEgressRefusal returns null and the case fails for a reason that has nothing to
// do with the behaviour under test. A fresh module registry per file removes the trap
// instead of working around it.
//
// What makes this site worth its own file at all: the forwarder's `onError` is a DEBUG hook
// with no production caller (cli.ts finalizes without one), so before this change a refusal
// here was invisible everywhere except a test that passed the hook. Analytics would simply
// stop forwarding, permanently, with no symptom.
import type { AnalyticsEvent } from "../../src/lib/analytics/envelope";

const SECRET = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8";

// A complete envelope: isRemotelyEmittable partitions an incomplete one into `withheld`
// and never posts it, which would make this suite pass for the wrong reason.
const EVENT = {
  schema_version: 1,
  event_id: "e1",
  event_type: "mla_command",
  created_at: "2026-07-27T00:00:00.000Z",
  workspace_id: "ws1",
  session_id: "s1",
  run_id: "r1",
  trace_id: "a".repeat(32),
  distinct_id: "d1",
  source: "cli",
  payload: { command: "scan" },
} as unknown as AnalyticsEvent;

describe("the analytics forward (src/lib/analytics/forwarder.ts)", () => {
  // `make` receives the module-local EgressPolicyError so the instance it builds is the
  // one the re-required forwarder will actually recognize.
  const forwardWith = async (
    make: (Err: typeof import("../../src/lib/egress/policy").EgressPolicyError) => unknown,
  ) => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, "error").mockImplementation((l?: unknown) => {
      lines.push(String(l));
    });
    try {
      jest.resetModules();
      const { EgressPolicyError } = require("../../src/lib/egress/policy") as
        typeof import("../../src/lib/egress/policy");
      jest.doMock("../../src/lib/http", () => ({
        post: jest.fn().mockRejectedValue(make(EgressPolicyError)),
      }));
      const { forwardEvents } = require("../../src/lib/analytics/forwarder") as
        typeof import("../../src/lib/analytics/forwarder");
      const result = await forwardEvents({} as never, [EVENT], {
        MEETLESS_TELEMETRY: "1",
      } as NodeJS.ProcessEnv);
      return { lines, result };
    } finally {
      spy.mockRestore();
      jest.dontMock("../../src/lib/http");
      jest.resetModules();
    }
  };

  it("reports a refusal body-free and still returns (the command is unaffected)", async () => {
    const { lines, result } = await forwardWith(
      (Err) =>
        new Err(
          "no_rule",
          "control",
          "POST",
          "/internal/v1/analytics/events",
          "no egress rule; register the route before sending a body to it",
        ),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("analytics events");
    expect(lines[0]).toContain("egress no_rule");
    expect(lines[0]).toContain("src/lib/egress/rules.ts");
    expect(lines[0]).not.toContain(SECRET);
    // Dropped, counted, not thrown: the primary command's exit code cannot move.
    expect(result.failed).toBe(1);
    expect(result.forwarded).toBe(0);
  });

  it("stays silent on an outage", async () => {
    const { lines, result } = await forwardWith(
      () => new Error("connect ECONNREFUSED 127.0.0.1:3006"),
    );
    expect(lines).toEqual([]);
    expect(result.failed).toBe(1);
  });
});
