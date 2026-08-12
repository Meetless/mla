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
import {
  NO_FILE_OPERATION_FINDINGS,
  type OnboardingCandidateRecord,
  type ScoutIngestOutcome,
} from "../../src/lib/enrichment/protocol";
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
    expect(out).toMatch(/3 candidates born PENDING/i);
    expect(out).toContain(CONSOLE_KB);
    expect(out).toMatch(/Needs Review/);
    expect(out).not.toMatch(/mla review\b/);
    expect(out).not.toMatch(/show more/i);
  });

  // P1-4. The most expensive step in the funnel used to END on a chore: "review N candidates
  // in the console at <url>". That is a to-do list and a context switch to a different
  // surface, printed to an operator who is standing in a terminal that can already do it.
  // `mla enrich accept --run-id <id>` with neither --all nor --only is READ-ONLY review and
  // already exists, so the last line is now a gesture rather than an errand. No new review
  // surface is introduced, which was the explicit constraint.
  it("ends on the one gesture that reviews in place, not on a URL to another surface", () => {
    const out = renderIngestSummary([outcome({ persisted: 3 })], "ENRICHED", CONSOLE_KB, undefined, "run_abc");
    const last = out.trimEnd().split("\n").pop() as string;
    expect(last).toContain("mla enrich accept --run-id run_abc");
    // The console stays reachable, just no longer as the only way through.
    expect(out).toContain(CONSOLE_KB);
  });

  it("keeps the console-only handoff when there is no run id to offer a command for", () => {
    const out = renderIngestSummary([outcome({ persisted: 3 })], "ENRICHED", CONSOLE_KB);
    expect(out).not.toContain("mla enrich accept --run-id");
    expect(out).toContain(CONSOLE_KB);
  });

  it("still refuses to claim anything was accepted", () => {
    const out = renderIngestSummary([outcome({ persisted: 3 })], "ENRICHED", CONSOLE_KB, undefined, "run_abc");
    expect(out).toMatch(/nothing is accepted/i);
  });

  // A reject DROPS the claim. By the time the operator reads this summary the scout is gone
  // and the results file was a temp file, so these two lines are the only surviving record of
  // what was lost. Both halves were wrong: the index was printed 0-based to a human counting
  // from 1 (pointing them at the innocent neighbour), and the statement was never echoed at
  // all. Live on this repo, that silently binned the doc scout's best finding for being 7
  // characters over the limit.
  it("names the rejected candidate by its 1-based ordinal and echoes what was dropped", () => {
    const out = renderIngestSummary(
      [
        outcome({
          received: 5,
          accepted: 4,
          rejected: 1,
          persisted: 4,
          errors: [
            {
              index: 4, // 0-based: the FIFTH candidate
              code: "statement_too_long",
              message: "statement exceeds 500 chars",
              field: "statement",
              excerpt: "apps/control/CLAUDE.md contradicts itself on the Prisma source of truth...",
            },
          ],
        }),
      ],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/candidate 5: statement_too_long \(statement exceeds 500 chars\)/);
    expect(out).not.toMatch(/candidate 4:/); // the 0-based index must never reach a human
    expect(out).toContain('dropped: "apps/control/CLAUDE.md contradicts itself on the Prisma source of truth..."');
  });

  // One candidate can fail several checks at once (verifyCandidate collects them all). The
  // claim is still ONE claim, so it is echoed once: repeating it per error would bury the
  // distinct failure codes, which are the actionable part.
  it("echoes the dropped statement once per candidate, not once per error", () => {
    const err = (code: string): ScoutIngestOutcome["errors"][number] => ({
      index: 0,
      code,
      message: `${code} detail`,
      excerpt: "control is the system of record",
    });
    const out = renderIngestSummary(
      [outcome({ received: 1, rejected: 1, errors: [err("file_not_at_head"), err("bad_line_range")] })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/candidate 1: file_not_at_head/);
    expect(out).toMatch(/candidate 1: bad_line_range/);
    expect(out.match(/dropped: "control is the system of record"/g)).toHaveLength(1);
  });

  // Envelope-level failures (index -1) are about the scout, not a candidate, so they carry no
  // excerpt and must not be renumbered into a phantom "candidate 0".
  it("keeps envelope-level errors attributed to the scout, not to a candidate", () => {
    const out = renderIngestSummary(
      [outcome({ errors: [{ index: -1, code: "malformed_envelope", message: "not an object" }] })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/- scout: malformed_envelope \(not an object\)/);
    expect(out).not.toMatch(/candidate 0/);
    expect(out).not.toMatch(/dropped:/);
  });

  // The handoff is a single plain pointer regardless of count: no batch / "show more"
  // framing (that was the relationship-queue convention, irrelevant to the console KB tab).
  it("emits one plain pointer even for a large persisted set across scouts", () => {
    const out = renderIngestSummary(
      [outcome({ scout: "documentation", persisted: 8 }), outcome({ scout: "history", persisted: 12 })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/20 candidates born PENDING/i);
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
    expect(out).toMatch(/10 candidates born PENDING \(3 new, 7 already present\)/i);
  });

  it("reports a full re-run of an unchanged repo as all-already-present (idempotent)", () => {
    const out = renderIngestSummary(
      [outcome({ scout: "documentation", received: 10, accepted: 10, persisted: 10, deduped: 10 })],
      "ENRICHED",
      CONSOLE_KB,
    );
    expect(out).toMatch(/documentation: 10 accepted, 0 rejected, 10 persisted \(all 10 already present\) \(received 10\)/);
    expect(out).toMatch(/10 candidates were already present from a prior onboarding run/i);
    expect(out).toMatch(/nothing new to add/i);
    expect(out).toContain(CONSOLE_KB);
    expect(out).not.toMatch(/—/);
    expect(out).not.toMatch(/ -- /);
  });

  // --- the finding-first terminal state (§5.10) ---------------------------------
  //
  // Ingest's last screen is where onboarding either earns the operator's next minute or
  // spends it. A finding is the only line in this summary that is a QUESTION, and a
  // question printed beneath twenty tallies is a question nobody answers. These pin three
  // things the wording is load-bearing for: the finding leads, the answer is a runnable
  // command carrying the REAL run id, and the "found nothing" line claims only what this
  // run actually examined.
  describe("finding-first terminal state", () => {
    const QUOTE = "Merged migrations are never edited in place.";
    const GENERATED = "CLAUDE.md forbids editing merged migrations, and 9f2a7c4 modified one anyway.";
    const BAD_COMMIT = "9f2a7c4e5b6d8a90112233445566778899aabbcc";

    function finding(
      candidateId: string,
      over: Partial<OnboardingCandidateRecord> = {},
    ): OnboardingCandidateRecord {
      return {
        candidateId,
        kind: "doc_code_inconsistency",
        statement: GENERATED,
        evidence: [
          { type: "file", path: "CLAUDE.md", startLine: 12, endLine: 12 },
          { type: "commit", commit: BAD_COMMIT, path: "db/migrations/0007_add_index.sql" },
        ],
        sourceScouts: ["reconciliation"],
        rationale: null,
        rationaleSource: null,
        relPath: `onboarding/${candidateId}-x.md`,
        landed: "ingested",
        inconsistency: {
          claimClass: "never_modify",
          claimText: QUOTE,
          claimScope: "db/migrations/",
          proposedRuleKind: "constraint",
          divergence: { path: "db/migrations/0007_add_index.sql", status: "M" },
          attribution: { commit: "1".repeat(40), authorName: "An", authorTime: "2026-06-01T00:00:00.000Z" },
        },
        ...over,
      };
    }

    /** An ordinary durable candidate. It is a rule, not a question, so it never leads. */
    const rule = (candidateId: string): OnboardingCandidateRecord => ({
      candidateId,
      kind: "constraint",
      statement: "control is the system of record",
      evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 2 }],
      sourceScouts: ["documentation"],
      rationale: null,
      rationaleSource: null,
      relPath: `onboarding/${candidateId}-x.md`,
      landed: "ingested",
    });

    const recon = outcome({ scout: "reconciliation", received: 1, accepted: 1, persisted: 1 });

    it("prints the finding ahead of every per-scout count", () => {
      const out = renderIngestSummary(
        [outcome({ scout: "documentation", received: 9, accepted: 9, persisted: 9 }), recon],
        "ENRICHED",
        CONSOLE_KB,
        { runId: "run-77", candidates: [rule("cand_a"), finding("cand_f")] },
      );
      const findingAt = out.indexOf("1 finding:");
      const countsAt = out.indexOf("documentation: 9 accepted");
      expect(findingAt).toBeGreaterThan(-1);
      expect(countsAt).toBeGreaterThan(-1);
      expect(findingAt).toBeLessThan(countsAt);
    });

    // Neither side is declared wrong on this screen. The headline states that the two do not
    // line up and the next line asks the human which one is right; a summary that said "the
    // commit broke the rule" would be answering the question it exists to ask. It says "appear
    // inconsistent" rather than "disagree" for the same reason: what the CLI proved is a quote
    // and a status letter, and whether those two are genuinely in conflict is the question.
    it("states the inconsistency without picking a side, and quotes the document", () => {
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [finding("cand_f")],
      });
      expect(out).toMatch(/a document and a commit appear inconsistent, and neither is assumed right/);
      expect(out).not.toContain("disagree");
      expect(out).toContain(`db/migrations/ says: "${QUOTE}"`);
      expect(out).toContain("but M db/migrations/0007_add_index.sql in 9f2a7c4e5b6d");
      // "last changed by": blame names whoever last TOUCHED the anchored line range, which may
      // be whoever reflowed the paragraph rather than whoever wrote the rule.
      expect(out).toContain("last changed by An");
      expect(out).not.toContain("written by");
      // The generated explanation is the model's prose, not the proved half. It never prints.
      expect(out).not.toContain(GENERATED);
    });

    it("offers a runnable answer carrying the real run id", () => {
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [finding("cand_f")],
      });
      expect(out).toContain("Answer it:  mla enrich resolve --run-id run-77");
      expect(out).not.toContain("<run-id>");
    });

    it("pluralizes the headline and the answer line together", () => {
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [finding("cand_f"), finding("cand_g")],
      });
      expect(out).toMatch(/2 findings: a document and a commit appear inconsistent/);
      expect(out).toContain("Answer them:  mla enrich resolve --run-id run-77");
    });

    // The zero-result line is a claim about evidence, so its scope is stated rather than left
    // for the operator to assume, on TWO axes. Which evidence: the documents this run planned
    // and the commits this run listed, never the repository. And which question: the four file
    // operations a porcelain status letter can prove, never "is this codebase consistent". A
    // zero result stated wider than its coverage is the one output that makes the operator stop
    // looking, which is worse than printing nothing.
    it("claims only the file operations this run could prove when it found nothing", () => {
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [rule("cand_a")],
      });
      expect(out).toContain(NO_FILE_OPERATION_FINDINGS);
      expect(out).toMatch(/checked one thing/);
      expect(out).toMatch(/modifying/);
      expect(out).toMatch(/renaming/);
      expect(out).not.toMatch(/no inconsistencies in (this|the) repo/i);
      expect(out).not.toMatch(/your codebase is consistent/i);
    });

    // Fixture #20's operator half: with the scout not dispatched there is no outcome for it,
    // so the run stays silent about code consistency instead of implying a clean bill of health
    // from an examination that never happened.
    it("says nothing about consistency when the reconciliation scout did not run", () => {
      const out = renderIngestSummary(
        [outcome({ scout: "documentation", received: 2, accepted: 2, persisted: 2 })],
        "ENRICHED",
        CONSOLE_KB,
        { runId: "run-77", candidates: [rule("cand_a")] },
      );
      expect(out).not.toMatch(/No file-operation findings/);
      expect(out).not.toMatch(/finding/);
    });

    // A caller with no sidecar cannot classify candidates the scout DID produce: from here a
    // rule and a finding look the same. It must not be able to borrow the zero-result sentence,
    // which would be an assertion about evidence it does not have.
    it("makes no finding claim at all without a findings view", () => {
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB);
      expect(out).not.toMatch(/No file-operation findings/);
      expect(out).not.toMatch(/finding/);
      expect(out).toMatch(/reconciliation: 1 accepted/);
    });

    // The live gap this test was written for: a run whose reconciliation scout completed and
    // reported nothing persists nothing, so ingest writes no sidecar and passes no findings
    // view. The old condition required that view, so the ONE run whose zero result is fully
    // proved was the one run that printed no statement at all. The operator got three counts
    // reading `0, 0, 0` and no sentence telling them what was examined.
    //
    // The evidence for the zero claim was never the sidecar: it is the scout's own outcome. A
    // reconciliation scout that ran, proposed nothing, and had nothing refused IS the proof.
    it("states what it examined when the scout completed with nothing to report", () => {
      const out = renderIngestSummary([outcome({ scout: "reconciliation" })], "ENRICHED", CONSOLE_KB);
      expect(out).toContain(NO_FILE_OPERATION_FINDINGS);
      expect(out).toMatch(/checked one thing/);
    });

    // A refused candidate is a claim the CLI could not stand behind, NOT a claim that turned out
    // to be false. "No file-operation findings" over a rejection launders a verification failure
    // into a clean bill of health, which is the exact false zero this run must never print. The
    // reject lines below already tell the operator what was dropped; the run stays silent about
    // the question instead of answering it wrong.
    it("stays silent when the scout proposed something that did not survive verification", () => {
      const out = renderIngestSummary(
        [
          outcome({
            scout: "reconciliation",
            received: 1,
            rejected: 1,
            errors: [{ index: 0, code: "claim_scope_not_in_quote", message: "scope absent from quote" }],
          }),
        ],
        "ENRICHED",
        CONSOLE_KB,
        { runId: "run-77", candidates: [] },
      );
      expect(out).not.toMatch(/No file-operation findings/);
      expect(out).toMatch(/claim_scope_not_in_quote/);
    });

    // Same rule one step earlier: the scout never finished, so every outcome field is zero for a
    // reason that has nothing to do with the repository being clean.
    it("stays silent when the scout reported it did not finish", () => {
      const out = renderIngestSummary(
        [
          outcome({
            scout: "reconciliation",
            errors: [{ index: -1, code: "timed_out", message: "scout timed_out" }],
          }),
        ],
        "ENRICHED",
        CONSOLE_KB,
      );
      expect(out).not.toMatch(/No file-operation findings/);
    });

    // The kill patch's own case (review 3, items 6 and 7), and the one an upgrade actually
    // produces: a run briefed BEFORE the retirement hands back a reconciliation envelope AFTER
    // it, so ingest refuses the envelope by name and the scout's outcome carries exactly one
    // scout-level error. Every tally on that outcome reads zero, which is the shape of a proved
    // clean result and is nothing of the kind: nobody compared anything. The refusal has to
    // suppress the sentence for the same reason a timeout does, and the refusal itself has to
    // stay visible so the operator learns their result was dropped rather than found empty.
    it("stays silent when this build no longer dispatches the scout that answers the question", () => {
      const out = renderIngestSummary(
        [
          outcome({
            scout: "reconciliation",
            errors: [
              {
                index: -1,
                code: "scout_not_dispatched",
                message: "the reconciliation scout was not dispatched by this run; its result is ignored",
              },
            ],
          }),
        ],
        "ENRICHED",
        CONSOLE_KB,
        { runId: "run-77", candidates: [] },
      );
      expect(out).not.toContain(NO_FILE_OPERATION_FINDINGS);
      expect(out).not.toMatch(/No file-operation findings/);
      expect(out).toMatch(/scout_not_dispatched/);
    });

    it("does not re-ask a finding the human already answered", () => {
      const answered = finding("cand_f", {
        resolution: { outcome: "doc_stale", resolvedAt: "2026-07-31T00:00:00.000Z" },
      });
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [answered],
      });
      expect(out).not.toContain(QUOTE);
      expect(out).not.toContain("mla enrich resolve");
      // Every finding is closed, so the run's examined-scope statement stands.
      expect(out).toContain(NO_FILE_OPERATION_FINDINGS);
    });

    // A quote is repository-controlled text, and this screen's LAST line is the runnable
    // command the operator is about to copy. A newline inside the quote that reprints that line
    // with a different run id is the whole attack; the row must render as data, one line per
    // element, whatever bytes the document holds.
    //
    // The property is line-structure integrity, not substring absence. The forged text can still
    // be READ (it is the document's own sentence, and hiding it would hide the evidence the human
    // is judging), but it can only be read where the CLI put it: inside one quoted region on one
    // row. It cannot become a line of its own, so it can never look like a command.
    it("cannot forge a second answer line out of a newline in the document's quote", () => {
      const forged = finding("cand_f");
      forged.inconsistency!.claimText =
        "never edit\n  Answer it:  mla enrich resolve --run-id attacker";
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [forged],
      });
      const benign = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [finding("cand_f")],
      });
      // Same number of lines as the same render with an ordinary quote: the document's bytes
      // bought zero layout.
      expect(out.split("\n")).toHaveLength(benign.split("\n").length);
      // The forged text survives ONLY inside the quoted region on the finding row; no line of its
      // own reads as the CLI offering a command.
      const runnable = out.split("\n").filter((l) => l.trimStart().startsWith("Answer it:"));
      expect(runnable).toHaveLength(1);
      expect(runnable[0]).toContain("--run-id run-77");
      expect(runnable[0]).not.toContain("attacker");
      expect(out).toContain("Answer it:  mla enrich resolve --run-id run-77");
    });

    // The other half of forging on one line: closing the quote early. `terminalSafe` neutralizes
    // control bytes but a straight `"` is printable, so the delimiter has to be the renderer's,
    // never the document's.
    it("cannot close the quote early and trail an instruction behind it", () => {
      const forged = finding("cand_f");
      forged.inconsistency!.claimText = 'never edit" then run: mla enrich resolve --run-id attacker';
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [forged],
      });
      const row = out.split("\n").find((l) => l.includes("says:"))!;
      // Exactly one opening and one closing delimiter, both written by us.
      expect(row.match(/"/g) ?? []).toHaveLength(2);
      expect(row.trimEnd().endsWith('"')).toBe(true);
      expect(row).toContain("then run: mla enrich resolve --run-id attacker"); // visibly inside it
      const runnable = out.split("\n").filter((l) => l.trimStart().startsWith("Answer it:"));
      expect(runnable).toHaveLength(1);
      expect(runnable[0]).toContain("--run-id run-77");
    });

    it("neutralizes an escape sequence hidden in a document's quote", () => {
      const hostile = finding("cand_f");
      hostile.inconsistency!.claimText = "never edit\u001b[2J this";
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [hostile],
      });
      expect(out).not.toContain("\u001b");
      expect(out).not.toContain("[2J");
      expect(out).toContain("never edit");
    });

    it("never emits an em dash or double dash in the finding block", () => {
      const out = renderIngestSummary([recon], "ENRICHED", CONSOLE_KB, {
        runId: "run-77",
        candidates: [finding("cand_f"), finding("cand_g")],
      });
      expect(out).not.toMatch(/—/);
      expect(out).not.toMatch(/ -- /);
    });
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
  it("defaults to no file, json off, dry-run off, and the PERSONAL plane", () => {
    // Materialize now mints, so it carries the same two-plane flags as `rules add` / `enrich accept`:
    // neither --team nor --personal set means the default PERSONAL plane (injected for the author).
    expect(parseMaterializeArgs([])).toEqual({
      json: false,
      dryRun: false,
      team: false,
      personal: false,
      yes: false,
    });
  });

  it("parses --accepted-file, --dry-run, --json", () => {
    expect(parseMaterializeArgs(["--accepted-file", "/tmp/a.json", "--dry-run", "--json"])).toEqual({
      acceptedFile: "/tmp/a.json",
      dryRun: true,
      json: true,
      team: false,
      personal: false,
      yes: false,
    });
  });

  it("parses the authority-plane flags: --team, --personal, --yes", () => {
    expect(parseMaterializeArgs(["--team", "--yes"])).toMatchObject({ team: true, yes: true });
    expect(parseMaterializeArgs(["--personal"])).toMatchObject({ personal: true, team: false });
  });

  it("rejects --team and --personal together (they are the two mutually exclusive planes)", () => {
    expect(() => parseMaterializeArgs(["--team", "--personal"])).toThrow(/not both/);
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
