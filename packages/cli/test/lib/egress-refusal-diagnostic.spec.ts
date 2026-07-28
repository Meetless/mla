// Ruling §2, the half that was missing: "For capture-only side effects: drop or
// retry the capture, record a body-free diagnostic, continue the primary command."
//
// Every capture-only egress in this CLI already dropped and continued. None of them
// recorded anything, and the failure mode that hides is specific enough to be worth
// a suite of its own:
//
//   An OUTAGE is transient. Silence is correct; the next run just works.
//   A REFUSAL means rules.ts is missing a route or a field classification. It will
//   refuse identically forever. Swallowed, capture stops permanently and the only
//   symptom is an absence, which is exactly the symptom nobody notices.
//
// So each site routes its caught error through describeEgressRefusal. These cases
// pin all three obligations per site: the line appears, it carries no body, and the
// primary command still succeeds. The outage path is asserted too, because a
// diagnostic that fires on every flaky connection is one nobody reads.
import { EgressPolicyError, describeEgressRefusal } from "../../src/lib/egress/policy";

// A refusal identical in shape to what the transport actually throws: an unregistered
// route. The detail string is the transport's own wording, body-free by contract.
const refusal = () =>
  new EgressPolicyError(
    "no_rule",
    "control",
    "POST",
    "/internal/v1/analytics/events",
    "no egress rule; register the route before sending a body to it",
  );

// A secret + a deep path, the two things a diagnostic must never leak. Any site that
// interpolated a request body would drop one of these into the assertion.
const SECRET = "sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8";
const PATHY = "apps/console/app/settings/SettingsNav.tsx";

function expectBodyFree(line: string): void {
  expect(line).not.toContain(SECRET);
  expect(line).not.toContain(PATHY);
  // The routing triple and the remedy are the whole payload.
  expect(line).toContain("egress no_rule");
  expect(line).toContain("src/lib/egress/rules.ts");
}

describe("describeEgressRefusal", () => {
  it("describes a policy refusal and names the remedy", () => {
    const line = describeEgressRefusal(refusal(), "analytics events");
    expect(line).not.toBeNull();
    expect(line).toContain("analytics events");
    expect(line).toContain("not by an outage");
    expectBodyFree(String(line));
  });

  it("returns null for an outage, so the quiet path stays quiet", () => {
    expect(describeEgressRefusal(new Error("connect ECONNREFUSED"), "x")).toBeNull();
    expect(describeEgressRefusal(Object.assign(new Error("nope"), { status: 503 }), "x")).toBeNull();
    expect(describeEgressRefusal(undefined, "x")).toBeNull();
    expect(describeEgressRefusal("egress no_rule: looks like one", "x")).toBeNull();
  });

  it("carries every refusal reason, not just the unregistered-route one", () => {
    // A field nobody classified is the other half of the fail-closed contract, and it
    // is the one a future edit is most likely to trip (add a field, forget the rule).
    const unknownField = new EgressPolicyError(
      "unknown_field",
      "intel",
      "POST",
      "/v1/ask",
      "unclassified top-level field(s): reranker",
    );
    const line = String(describeEgressRefusal(unknownField, "ask"));
    expect(line).toContain("unknown_field");
    expect(line).toContain("reranker");
    expect(line).not.toContain(SECRET);
  });
});

// The analytics forwarder needs a module mock (`post` is imported, not injected), and a
// module mock needs jest.resetModules, which mints a SECOND EgressPolicyError class and
// silently breaks `instanceof` for every later case in the file. It lives in its own
// spec, egress-refusal-forwarder.spec.ts, where a fresh registry costs nothing.

describe("the turn recap (src/commands/internal-turn-recap.ts)", () => {
  // Spawned by a Claude Code hook, so it must exit 0 no matter what. It did, and it
  // said nothing at all; a refusal here silently ends Langfuse scoring for good.
  const runRecap = async (thrown: unknown) => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, "error").mockImplementation((l?: unknown) => {
      lines.push(String(l));
    });
    try {
      const { runInternalTurnRecap } = require("../../src/commands/internal-turn-recap") as
        typeof import("../../src/commands/internal-turn-recap");
      const code = await runInternalTurnRecap(
        ["--session", "s1", "--turn", "7", "--emit-langfuse"],
        {
          // A COMPLETE recap: the emit block runs after the render, and renderStyle on a
          // partial recap throws into the outer fail-soft catch, which returns 0 without
          // ever posting. The case would then pass its exit-code assertion and prove
          // nothing about the diagnostic.
          compute: () => ({
            session_id: "s1",
            turn_index: 7,
            trace_id: "a".repeat(32),
            ran: true,
            injected_floor: true,
            injected_evidence: true,
            not_run_reason: null,
            enrich_latency_ms: 412,
            evidence_offered: true,
            offered_source_ids: ["NT:a.md"],
            zero_results: false,
            coverage_gap_type: null,
            evidence_layer_down: false,
            retrieved_count: null,
            selected_count: null,
            abstain_class: null,
            evidence_tools_pulled: ["retrieve_knowledge"],
            pull_count: 2,
            referenced_source_ids: ["NT:a.md"],
            cited_source_ids: [],
            verdict: "USED",
          }),
          readCfg: () => ({}) as never,
          postTurnRecap: async () => {
            throw thrown;
          },
          log: () => {},
        },
      );
      return { code, lines };
    } finally {
      spy.mockRestore();
    }
  };

  it("reports a refusal body-free and still exits 0", async () => {
    const { code, lines } = await runRecap(refusal());
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("turn recap");
    expectBodyFree(lines[0]);
  });

  it("stays silent on an outage, still exits 0", async () => {
    const { code, lines } = await runRecap(new Error("intel down"));
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });
});

describe("the instruction-snapshot upload (src/lib/rules/snapshot-upload.ts)", () => {
  // A library, so it returns the reason instead of printing it: scan-context already
  // owns the warning channel and already prints a COUNT. A count cannot tell a flaky
  // network from a permanent refusal, and the two need opposite reactions.
  const uploadWith = async (thrown: unknown) => {
    const { uploadSnapshotsForScan } = require("../../src/lib/rules/snapshot-upload") as
      typeof import("../../src/lib/rules/snapshot-upload");
    return uploadSnapshotsForScan(
      {
        workspaceId: "ws1",
        repositoryId: "repo1",
        scanRoot: "/repo",
        paths: ["CLAUDE.md", ".claude/rules/x.md"],
        observedCommitSha: "abc123",
        observedAt: "2026-07-27T00:00:00.000Z",
      },
      {
        loadConfig: () => ({ workspaceId: "ws1" }) as never,
        readFile: () => `# rules\nnever localhost, use 127.0.0.1 (${PATHY})\n`,
        http: { post: jest.fn().mockRejectedValue(thrown) } as never,
      },
    );
  };

  it("carries a body-free refusal out with the failure count", async () => {
    const outcome = await uploadWith(refusal());
    expect(outcome.delivered).toBe(true);
    if (!outcome.delivered) throw new Error("unreachable");
    // Every file refused, the pass still completed and the scan still succeeds.
    expect(outcome.failed).toBe(2);
    expect(outcome.attempted).toBe(2);
    expect(outcome.refusal).toBeDefined();
    expectBodyFree(String(outcome.refusal));
    expect(String(outcome.refusal)).toContain("instruction-file snapshot");
  });

  it("leaves refusal unset on an outage", async () => {
    const outcome = await uploadWith(new Error("socket hang up"));
    if (!outcome.delivered) throw new Error("unreachable");
    expect(outcome.failed).toBe(2);
    expect(outcome.refusal).toBeUndefined();
  });
});
