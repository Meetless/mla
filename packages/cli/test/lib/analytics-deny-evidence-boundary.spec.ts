// The analytics plane has TWO boundaries, and TELEMETRY.md described only one of them.
//
// `INV-POSTHOG-PII-1` is a claim about the PostHog MIRROR: control's
// `projectForPostHog` is a fail-closed key allowlist, so an un-allowlisted key never
// crosses to the analytics vendor. That claim is true, and the CLI's own comments lean
// on it ("dropped from PostHog by the fail-closed allowlist") to justify carrying two
// content-bearing fields on the enforcement incident.
//
// But the PostHog mirror is not the first wire. The order is:
//
//   CLI spool -> forwardEvents POSTs the VERBATIM event to control
//             -> control lands it in analytics_events (the console review queue reads it)
//             -> only THEN does projectForPostHog run, for the onward mirror
//
// So "dropped before PostHog" and "never leaves the machine" are statements about two
// different wires, and §3 of TELEMETRY.md restated the first as the second: it claimed
// **file paths** do not leave the machine and that a blocked path "is reduced to a coarse
// surface enum ... never the path itself". On the deny tile, `touched_surface` rides
// ALONGSIDE `blocked_path`, not instead of it, and both reach control verbatim.
//
// That is by design, not a bug: a deny the operator cannot see the WHAT of is a deny
// they cannot adjudicate, and this plane goes to the user's OWN control. The fix is to
// say so in the doc. This spec is the thing that keeps the doc honest, and it does it
// against the REAL egress policy over the REAL forwarder body shape, because the
// question "what actually reaches the wire" cannot be answered by reading a builder:
// the analytics ingest rule is `mode: "redact", profile: "full", keyAware: true`, so
// whether the walker eats a repo-relative path is an empirical question.
//
// It has a second job. If a future egress-profile change starts redacting `blocked_path`,
// the console review queue silently becomes unadjudicable with NO other symptom: no
// error, no failing test, no log. This spec is that symptom.

import { emitEnforcementIncident } from "../../src/lib/analytics/enforcement-incident";
import { buildEvent } from "../../src/lib/analytics/recorder";
import { ANALYTICS_INGEST_PATH } from "../../src/lib/analytics/forwarder";
import { applyEgressPolicy } from "../../src/lib/egress/policy";
import { EGRESS_RULES } from "../../src/lib/egress/rules";
import type { AnalyticsEvent } from "../../src/lib/analytics/envelope";

// The envelope carries this through verbatim, so the spec only needs A workspace id,
// never a real one. Keep it on the synthetic cmexample* placeholder: this subtree is
// exported to a public mirror whose scrub gate denies any cuid it cannot recognize as
// synthetic, and that refusal is silent (it held 0.2.31 back for a whole release).
const WORKSPACE_ID = "cmexample0000000000000001";
// Authored rule prose and a repo-relative path that names a client and a feature. Both
// are exactly what an operator needs to adjudicate the deny, and exactly what the doc
// claimed stays home.
const RULE_TEXT = "Notes live under notes/, never docs/.";
const BLOCKED_PATH = "docs/acme-sso-q3-pilot/rollout.md";

/** Build one real enforcement-incident event: the real payload builder and the real
 * envelope, with only the local-jsonl append and the in-process buffer skipped. */
function buildIncidentEvent(
  over: Partial<Parameters<typeof emitEnforcementIncident>[0]> = {},
): AnalyticsEvent {
  let captured: AnalyticsEvent | null = null;
  emitEnforcementIncident(
    {
      incidentId: "01J0000000DENYATTEMPT0001",
      decision: "deny",
      tool: "Write",
      touchedSurface: "docs",
      ruleVersionId: "ver_1",
      ruleNodeId: "rn_notes_location",
      ruleText: RULE_TEXT,
      blockedPath: BLOCKED_PATH,
      ...over,
    },
    { workspaceId: WORKSPACE_ID, sessionId: "sess_1", nowMs: 1785681765000 },
    {
      readCfg: () => null,
      machineId: () => "m_000000000000000000000000",
      runId: "run_1",
      traceId: "d".repeat(32),
      repoFingerprint: "r_111111111111111111111111",
      record: (ctx, input) => {
        captured = buildEvent(ctx, input);
        return captured;
      },
      env: {},
    },
  );
  if (!captured) throw new Error("emitEnforcementIncident swallowed the build (fail-soft)");
  return captured;
}

/** Run the real registry over the real forwarder body shape and return what the wire gets. */
function overTheWire(events: AnalyticsEvent[]): string {
  const out = applyEgressPolicy(
    EGRESS_RULES,
    "control",
    "POST",
    `http://127.0.0.1:9412${ANALYTICS_INGEST_PATH}`,
    { workspaceId: WORKSPACE_ID, events },
  );
  return JSON.stringify(out);
}

describe("the deny tile's review evidence DOES leave the machine (to your own control)", () => {
  it("carries the deciding rule's text and the blocked path verbatim past the egress redactor", () => {
    const wire = overTheWire([buildIncidentEvent()]);

    // The two content-bearing fields on the whole analytics plane. If either of these
    // ever stops arriving, the console review queue can no longer answer "what did this
    // deny block, and on what rule", which is the only reason the queue exists.
    expect(wire).toContain(RULE_TEXT);
    expect(wire).toContain(BLOCKED_PATH);
    // And the surface enum rides ALONGSIDE the path, not instead of it. This is the
    // exact sentence TELEMETRY.md got backwards.
    expect(wire).toContain('"touched_surface":"docs"');
  });

  it("keeps the path repo-relative, so the machine's directory layout is not on the wire", () => {
    // `runtimeRelativePath` (bundle-enforce.ts) returns a path ONLY for a
    // RUNTIME_RELATIVE target and null otherwise, so an absolute path is unreachable
    // by construction on both the deny and the warn producer. That is what lets the
    // doc promise "never an absolute path" without hedging.
    const wire = overTheWire([buildIncidentEvent()]);
    const parsed = JSON.parse(wire) as { events: Array<Record<string, unknown>> };
    const path = parsed.events[0].blocked_path as string;
    expect(path).toBe(BLOCKED_PATH);
    expect(path.startsWith("/")).toBe(false);
    expect(path).not.toMatch(/^[A-Za-z]:[\\/]/); // no Windows drive root either
    expect(wire).not.toContain("/Users/");
  });

  it("carries nothing content-bearing BESIDE those two: the rest of the payload is ids and enums", () => {
    // The bound on the finding. A leak of two named, deliberate fields is a doc defect;
    // a leak the catalog cannot enumerate is a design defect. This asserts the incident
    // payload is exactly its closed set, so a future field carrying free text has to
    // walk past a red test to get onto this wire.
    const ev = buildIncidentEvent() as unknown as Record<string, unknown>;
    const payloadKeys = Object.keys(ev)
      .filter(
        (k) =>
          ![
            "schema_version",
            "event_id",
            "event_type",
            "created_at",
            "emitted_at",
            "workspace_id",
            "distinct_id",
            "session_id",
            "run_id",
            "trace_id",
            "source",
            "attribution",
            "repo_fingerprint",
          ].includes(k),
      )
      .sort();
    expect(payloadKeys).toEqual(
      [
        "blocked_path",
        "decision",
        "enforced_tool",
        "incident_id",
        "review_status",
        "rule_node_id",
        "rule_text",
        "rule_version_id",
        "touched_surface",
      ].sort(),
    );
  });

  it("omits both fields entirely on a non-file deny rather than sending an empty string", () => {
    // The lean case the emitter's presence guards exist for: a deny whose target was
    // not a runtime-relative file has no path to show, so the key is absent, not "".
    const wire = overTheWire([
      buildIncidentEvent({ ruleText: null, blockedPath: null }),
    ]);
    const parsed = JSON.parse(wire) as { events: Array<Record<string, unknown>> };
    expect(parsed.events[0]).not.toHaveProperty("blocked_path");
    expect(parsed.events[0]).not.toHaveProperty("rule_text");
    expect(parsed.events[0].incident_id).toBe("01J0000000DENYATTEMPT0001");
  });
});
