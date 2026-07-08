import {
  parsePlanArgs,
  parseIngestArgs,
  parseBriefArgs,
  parseMaterializeArgs,
  extractResults,
  extractAcceptedCandidates,
  validateAcceptedCandidates,
  renderMaterializeSummary,
  resolveBudgetMs,
  renderIngestSummary,
} from "../../src/commands/enrich";
import { type ScoutIngestOutcome } from "../../src/lib/enrichment/protocol";
import { materializeRules } from "../../src/lib/enrichment/materialize-rules";

describe("parsePlanArgs", () => {
  it("defaults to a human summary (json off, force off)", () => {
    expect(parsePlanArgs([])).toEqual({ json: false, force: false });
  });

  it("parses --json, --budget-ms, --workspace", () => {
    expect(parsePlanArgs(["--json", "--budget-ms", "60000", "--workspace", "ws_9"])).toEqual({
      json: true,
      budgetMs: 60000,
      workspace: "ws_9",
      force: false,
    });
  });

  it("parses --force (idempotency-gate override)", () => {
    expect(parsePlanArgs(["--force"])).toEqual({ json: false, force: true });
  });

  it("rejects a non-positive or non-numeric budget", () => {
    expect(() => parsePlanArgs(["--budget-ms", "0"])).toThrow(/positive number/);
    expect(() => parsePlanArgs(["--budget-ms", "nope"])).toThrow(/positive number/);
    expect(() => parsePlanArgs(["--budget-ms", "-5"])).toThrow(/positive number/);
  });

  it("rejects --workspace without a value and unknown flags", () => {
    expect(() => parsePlanArgs(["--workspace"])).toThrow(/requires a workspace id/);
    expect(() => parsePlanArgs(["--bogus"])).toThrow(/Unknown flag/);
  });
});

describe("parseIngestArgs", () => {
  it("requires --run-id", () => {
    expect(() => parseIngestArgs([])).toThrow(/--run-id is required/);
  });

  it("parses run id, results file, json, workspace", () => {
    expect(
      parseIngestArgs(["--run-id", "run-1", "--results-file", "/tmp/r.json", "--json", "--workspace", "ws_2"]),
    ).toEqual({
      runId: "run-1",
      resultsFile: "/tmp/r.json",
      json: true,
      workspace: "ws_2",
    });
  });

  it("rejects missing flag values and unknown flags", () => {
    expect(() => parseIngestArgs(["--run-id"])).toThrow(/--run-id requires a value/);
    expect(() => parseIngestArgs(["--run-id", "x", "--results-file"])).toThrow(/--results-file requires a path/);
    expect(() => parseIngestArgs(["--run-id", "x", "--nope"])).toThrow(/Unknown flag/);
  });
});

describe("resolveBudgetMs", () => {
  it("prefers the flag over the env and the default", () => {
    expect(resolveBudgetMs(60000, "120000")).toEqual({ budgetMs: 60000 });
  });

  it("falls back to MLA_ENRICH_BUDGET_MS when no flag", () => {
    expect(resolveBudgetMs(undefined, "90000")).toEqual({ budgetMs: 90000 });
  });

  it("returns nothing (protocol default applies) when neither is set", () => {
    expect(resolveBudgetMs(undefined, undefined)).toEqual({});
    expect(resolveBudgetMs(undefined, "")).toEqual({});
    expect(resolveBudgetMs(undefined, "   ")).toEqual({});
  });

  it("ignores an invalid env value with a warning rather than failing", () => {
    expect(resolveBudgetMs(undefined, "nope")).toEqual({
      warning: expect.stringContaining("ignoring invalid MLA_ENRICH_BUDGET_MS"),
    });
    expect(resolveBudgetMs(undefined, "-5").warning).toMatch(/ignoring invalid/);
    expect(resolveBudgetMs(undefined, "0").warning).toMatch(/ignoring invalid/);
  });
});

describe("extractResults", () => {
  const RUN = "run-abc";

  it("accepts a bare results array", () => {
    const arr = [{ scout: "documentation" }, { scout: "history" }];
    expect(extractResults(JSON.stringify(arr), RUN)).toEqual(arr);
  });

  it("accepts an object with a results array", () => {
    const arr = [{ scout: "documentation" }];
    expect(extractResults(JSON.stringify({ results: arr }), RUN)).toEqual(arr);
  });

  it("accepts the full request when its runId matches", () => {
    const arr = [{ scout: "history" }];
    expect(extractResults(JSON.stringify({ runId: RUN, results: arr }), RUN)).toEqual(arr);
  });

  it("rejects a payload whose runId disagrees with --run-id (stale-paste defense)", () => {
    expect(() => extractResults(JSON.stringify({ runId: "run-other", results: [] }), RUN)).toThrow(
      /does not match --run-id/,
    );
  });

  it("rejects invalid JSON", () => {
    expect(() => extractResults("{not json", RUN)).toThrow(/not valid JSON/);
  });

  it("rejects an object without a results array", () => {
    expect(() => extractResults(JSON.stringify({ foo: 1 }), RUN)).toThrow(/must be a JSON array/);
    expect(() => extractResults(JSON.stringify({ results: "nope" }), RUN)).toThrow(/must be a JSON array/);
  });

  it("rejects a non-array, non-object top level", () => {
    expect(() => extractResults(JSON.stringify(42), RUN)).toThrow(/must be a JSON array/);
  });
});

describe("parseBriefArgs", () => {
  it("parses run-id and role", () => {
    expect(parseBriefArgs(["--run-id", "run-1", "--role", "documentation"])).toEqual({
      runId: "run-1",
      role: "documentation",
    });
    expect(parseBriefArgs(["--run-id", "run-1", "--role", "history", "--workspace", "ws_2"])).toEqual({
      runId: "run-1",
      role: "history",
      workspace: "ws_2",
    });
  });

  it("requires both run-id and role", () => {
    expect(() => parseBriefArgs([])).toThrow(/--run-id is required/);
    expect(() => parseBriefArgs(["--run-id", "run-1"])).toThrow(/--role is required/);
    expect(() => parseBriefArgs(["--role", "history"])).toThrow(/--run-id is required/);
  });

  it("rejects an unknown role", () => {
    expect(() => parseBriefArgs(["--run-id", "run-1", "--role", "filesystem"])).toThrow(
      /--role must be one of: documentation, history/,
    );
  });

  it("rejects missing values and unknown flags", () => {
    expect(() => parseBriefArgs(["--run-id"])).toThrow(/--run-id requires a value/);
    expect(() => parseBriefArgs(["--run-id", "x", "--role"])).toThrow(/--role requires a value/);
    expect(() => parseBriefArgs(["--run-id", "x", "--workspace"])).toThrow(/requires a workspace id/);
    expect(() => parseBriefArgs(["--run-id", "x", "--role", "history", "--nope"])).toThrow(/Unknown flag/);
  });
});

describe("renderIngestSummary", () => {
  const outcome = (over: Partial<ScoutIngestOutcome> = {}): ScoutIngestOutcome => ({
    scout: over.scout ?? "documentation",
    received: over.received ?? 0,
    accepted: over.accepted ?? 0,
    rejected: over.rejected ?? 0,
    persisted: over.persisted ?? 0,
    deduped: over.deduped ?? 0,
    errors: over.errors ?? [],
  });

  const CONSOLE_KB = "https://app.example.test/kb";

  it("reports per-scout counts and the resolved run state", () => {
    const out = renderIngestSummary(
      [outcome({ scout: "documentation", received: 3, accepted: 2, rejected: 1, persisted: 2 })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/state: ENRICHED/);
    expect(out).toMatch(/documentation: 2 accepted, 1 rejected, 2 persisted \(received 3\)/);
  });

  // The review handoff points at the real surface: born-PENDING candidates are KB
  // documents reviewed on the console KB "Needs Review" tab, NOT via `mla review` (which
  // serves relationship/agent-review packets and cannot show KB documents).
  it("points the operator to the console KB review surface, not `mla review`", () => {
    const out = renderIngestSummary([outcome({ persisted: 3 })], "ENRICHED", CONSOLE_KB);
    expect(out).toMatch(/review 3 candidates born PENDING/i);
    expect(out).toContain(CONSOLE_KB);
    expect(out).toMatch(/Needs Review/);
    expect(out).not.toMatch(/mla review/);
    expect(out).not.toMatch(/show more/i);
  });

  // The handoff is a single plain pointer regardless of count: no batch / "show more"
  // framing (that was the relationship-queue convention, irrelevant to the console KB tab).
  it("emits one plain pointer even for a large persisted set across scouts", () => {
    const out = renderIngestSummary(
      [outcome({ scout: "documentation", persisted: 8 }), outcome({ scout: "history", persisted: 12 })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/review 20 candidates born PENDING/i);
    expect(out).toContain(CONSOLE_KB);
    expect(out).not.toMatch(/show more/i);
    expect(out).not.toMatch(/first \d/i);
  });

  it("omits the review handoff entirely when nothing was persisted", () => {
    const out = renderIngestSummary(
      [outcome({ received: 2, rejected: 2, persisted: 0 })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).not.toMatch(/born PENDING/i);
    expect(out).not.toContain(CONSOLE_KB);
  });

  it("never emits an em dash or double dash in the handoff prose", () => {
    const out = renderIngestSummary([outcome({ persisted: 12 })], "ENRICHED", CONSOLE_KB);
    expect(out).not.toMatch(/—/);
    expect(out).not.toMatch(/ -- /);
  });

  // Idempotency made visible. A clean first run (deduped 0) keeps the plain "N persisted" line;
  // a partial re-run breaks out new vs already-present; a full re-run of an unchanged repo says
  // so outright. This is how the operator SEES that re-running onboarding accumulates nothing.
  it("breaks out new vs already-present when some candidates deduped", () => {
    const out = renderIngestSummary(
      [outcome({ scout: "documentation", received: 10, accepted: 10, persisted: 10, deduped: 7 })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/documentation: 10 accepted, 0 rejected, 10 persisted \(3 new, 7 already present\) \(received 10\)/);
    expect(out).toMatch(/review 10 candidates born PENDING \(3 new, 7 already present\)/i);
  });

  it("reports a full re-run of an unchanged repo as all-already-present (idempotent)", () => {
    const out = renderIngestSummary(
      [outcome({ scout: "documentation", received: 10, accepted: 10, persisted: 10, deduped: 10 })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/documentation: 10 accepted, 0 rejected, 10 persisted \(all 10 already present\) \(received 10\)/);
    expect(out).toMatch(/all 10 candidates were already present from a prior onboarding run/i);
    expect(out).toMatch(/nothing new to add/i);
    expect(out).toContain(CONSOLE_KB);
    expect(out).not.toMatch(/—/);
    expect(out).not.toMatch(/ -- /);
  });
});

// --- enrich materialize (accepted durable rules -> .meetless/rules.md) -------------
// The pure helpers behind `mla enrich materialize`. The end-to-end file write is covered
// by enrich-materialize.spec.ts; here we pin arg parsing, payload normalization, the
// reuse of ingest's shape validator, and the exact summary wording (incl. the no-em-dash
// rule and the authority split = decisions are skipped, never written).

function accepted(over: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceScout: "documentation",
    evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 2 }],
    ...over,
  };
}

describe("parseMaterializeArgs", () => {
  it("defaults to no file, json off, dry-run off", () => {
    expect(parseMaterializeArgs([])).toEqual({ json: false, dryRun: false });
  });

  it("parses --accepted-file, --dry-run, --json", () => {
    expect(parseMaterializeArgs(["--accepted-file", "/tmp/a.json", "--dry-run", "--json"])).toEqual({
      acceptedFile: "/tmp/a.json",
      dryRun: true,
      json: true,
    });
  });

  it("rejects a missing --accepted-file value and unknown flags", () => {
    expect(() => parseMaterializeArgs(["--accepted-file"])).toThrow(/requires a path/);
    expect(() => parseMaterializeArgs(["--nope"])).toThrow(/Unknown flag/);
  });
});

describe("extractAcceptedCandidates", () => {
  it("accepts a bare array", () => {
    expect(extractAcceptedCandidates('[{"x":1}]')).toEqual([{ x: 1 }]);
  });

  it("accepts an object with an `accepted` array", () => {
    expect(extractAcceptedCandidates('{"accepted":[{"x":1}]}')).toEqual([{ x: 1 }]);
  });

  it("accepts an object with a `candidates` array (onboard candidate list passthrough)", () => {
    expect(extractAcceptedCandidates('{"candidates":[{"y":2}]}')).toEqual([{ y: 2 }]);
  });

  it("rejects invalid JSON and unsupported shapes", () => {
    expect(() => extractAcceptedCandidates("{not json")).toThrow(/not valid JSON/);
    expect(() => extractAcceptedCandidates('{"nope":1}')).toThrow(/must be a JSON array/);
  });
});

describe("validateAcceptedCandidates", () => {
  it("returns the typed candidates when every shape is valid", () => {
    const res = validateAcceptedCandidates([
      accepted({ kind: "constraint", statement: "Use pnpm, not npm." }),
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0].statement).toBe("Use pnpm, not npm.");
    }
  });

  it("fails the WHOLE batch when any candidate is malformed (no silent partial)", () => {
    const res = validateAcceptedCandidates([
      accepted({ kind: "constraint", statement: "Valid one." }),
      accepted({ kind: "not-a-kind", statement: "Bad kind." }),
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === "bad_kind")).toBe(true);
    }
  });
});

describe("renderMaterializeSummary", () => {
  it("lists materialized rules and prints the effective-locally share line on a real write", () => {
    const result = materializeRules("", [
      accepted({ kind: "constraint", statement: "Never log PII." }) as never,
    ]);
    const out = renderMaterializeSummary(result, ".meetless/rules.md", false);
    expect(out).toMatch(/Materialized 1 durable rule into \.meetless\/rules\.md/);
    expect(out).toMatch(/\+ Never log PII\./);
    expect(out).toMatch(/Effective locally\. Commit and push to share/);
  });

  it("reports a decision as skipped and writes nothing (INV-AUTH-2 wording)", () => {
    const result = materializeRules("", [
      accepted({ kind: "decision", statement: "We chose Postgres SKIP LOCKED over SQS." }) as never,
    ]);
    const out = renderMaterializeSummary(result, ".meetless/rules.md", false);
    expect(out).toMatch(/No durable rules to materialize/);
    expect(out).toMatch(/Skipped 1 non-rule candidate/);
    expect(out).toMatch(/decision \(governed knowledge, not a rule\)/);
    expect(out).not.toMatch(/Effective locally/); // nothing written => nothing to share
  });

  it("uses the conditional verb and suppresses the share line under --dry-run", () => {
    const result = materializeRules("", [
      accepted({ kind: "convention", statement: "Two spaces, never tabs." }) as never,
    ]);
    const out = renderMaterializeSummary(result, ".meetless/rules.md", true);
    expect(out).toMatch(/Would materialize 1 durable rule/);
    expect(out).not.toMatch(/Effective locally/);
  });

  it("never emits an em dash or double dash", () => {
    const result = materializeRules("", [
      accepted({ kind: "boundary", statement: "control owns the state machine." }) as never,
      accepted({ kind: "decision", statement: "A decision." }) as never,
    ]);
    const out = renderMaterializeSummary(result, ".meetless/rules.md", false);
    expect(out).not.toMatch(/—/);
    expect(out).not.toMatch(/ -- /);
  });
});
