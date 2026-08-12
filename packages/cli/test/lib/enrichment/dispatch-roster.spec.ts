// test/lib/enrichment/dispatch-roster.spec.ts
//
// Retiring a scout (review 3, items 6 and 7).
//
// The kill operation for a scout is NOT deleting it from `SCOUT_NAMES`. `SCOUT_NAMES` is the
// PROTOCOL roster: the names a stored run record may carry, an ingest envelope may name, and a
// persisted finding may cite as its source. Deleting a role from it makes every run that ever
// mentioned the role unparseable and every finding it produced unreadable, which is the
// opposite of retiring: history still has to load, render, and resolve.
//
// The kill is removing the role from `DISPATCH_SCOUT_NAMES`, the ONBOARDING roster: the list
// the operator surface dispatches, the list wire installs an agent file for, and the list
// ingest expects a result from. One compile-time array, one line to edit, no runtime flag.
//
// This file proves the patch BEFORE it is applied, by rendering and ingesting against a roster
// with the finding-producing role removed:
//   - nothing dispatches it and no brief can be built for it (no token cost);
//   - the skill body does not ask a question no scout answered, and does not report a zero
//     result for a scout that never ran (the false zero-result failure);
//   - an old run record that names it still loads, its slot survives untouched, and a finding
//     it produced still parses;
//   - a late result from the retired scout is refused by name rather than silently swallowed
//     by a zero budget or crashing on an absent slot.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DISPATCH_SCOUT_NAMES,
  NO_FILE_OPERATION_FINDINGS,
  RECONCILIATION_FINDING_KIND,
  SCOUT_NAMES,
  isDispatchScoutName,
  rosterProducesFindings,
  scoutCountWord,
  scoutMayEmitKind,
  validateCandidateShape,
  validateScoutResultShape,
  type ScoutName,
} from "../../../src/lib/enrichment/protocol";
import {
  LEGACY_SURFACE,
  PLUGIN_SURFACE,
  renderOnboardSkill,
} from "../../../src/connectors/claude-code/surface";
import { SCOUT_AGENT_FILES, INSTALLED_SCOUT_AGENT_FILES } from "../../../src/lib/unwire";

// The role under retirement, derived rather than typed out: it is the one the dispatch roster
// carries that may emit a finding. A test that hardcoded "reconciliation" would go quietly
// vacuous the day the role is renamed, which is exactly the drift this whole file exists to
// catch elsewhere.
const RETIRED: ScoutName = DISPATCH_SCOUT_NAMES.filter((role) =>
  scoutMayEmitKind(role, RECONCILIATION_FINDING_KIND),
)[0];

// The kill patch itself, expressed as data: the shipped roster minus that role.
const REDUCED: readonly ScoutName[] = DISPATCH_SCOUT_NAMES.filter((role) => role !== RETIRED);

describe("DISPATCH_SCOUT_NAMES: the onboarding roster is a subset of the protocol roster", () => {
  it("every dispatched role is a protocol role (a scout can never be dispatched but unparseable)", () => {
    for (const role of DISPATCH_SCOUT_NAMES) {
      expect(SCOUT_NAMES).toContain(role);
    }
  });

  it("ships with the finding-producing scout dispatched (the retirement has NOT been performed)", () => {
    // This file proves the patch works; it does not perform it. If this ever fails, the kill
    // landed, and the assertions below stop being a rehearsal and start describing production.
    expect(RETIRED).toBeDefined();
    expect(DISPATCH_SCOUT_NAMES).toContain(RETIRED);
    expect(rosterProducesFindings(DISPATCH_SCOUT_NAMES)).toBe(true);
  });

  it("a retired role is no longer dispatchable, while staying a valid protocol name", () => {
    expect(isDispatchScoutName(RETIRED, REDUCED)).toBe(false);
    expect(SCOUT_NAMES).toContain(RETIRED); // still parseable: old records name it
  });

  it("counts the roster that RUNS, not the roster that parses", () => {
    expect(scoutCountWord(DISPATCH_SCOUT_NAMES)).toBe("three");
    expect(scoutCountWord(REDUCED)).toBe("two");
  });

  it("knows whether the dispatched roster can produce a finding at all", () => {
    expect(rosterProducesFindings(REDUCED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The operator surface under the reduced roster.
// ---------------------------------------------------------------------------------------
describe("renderOnboardSkill: a retired scout is not dispatched and not spoken about", () => {
  const full = (): string => renderOnboardSkill(LEGACY_SURFACE);
  const killed = (): string => renderOnboardSkill(LEGACY_SURFACE, REDUCED);

  it("names no dispatch target for the retired role (no Task call, so no token cost)", () => {
    const body = killed();
    expect(body).not.toContain(LEGACY_SURFACE.scoutDispatch[RETIRED]);
    expect(body).not.toContain(`role \`${RETIRED}\``);
    for (const role of REDUCED) {
      expect(body).toContain(LEGACY_SURFACE.scoutDispatch[role]);
    }
  });

  it("states the reduced count and roster everywhere it states them (prose is not type-checked)", () => {
    const body = killed();
    expect(body).toContain("two read-only scouts");
    expect(body).toContain("There are exactly two scouts");
    expect(body).not.toMatch(/three scouts/);
    // The role name appears NOWHERE in the body, backticked or not: a retired scout that is
    // still named in prose is still something the operator (or an agent reading the skill)
    // will try to invoke.
    expect(body).not.toContain(RETIRED);
  });

  it("asks no findings question, because no dispatched scout can answer one", () => {
    const body = killed();
    expect(body).not.toMatch(/enrich resolve/);
    expect(body).not.toMatch(/finding/i);
  });

  // The false zero-result failure: the skill told the operator, as the EMPTY case of a question,
  // that the documents and the commits this run examined did not disagree. With the scout that
  // looks for disagreement retired, that sentence is not an empty result, it is a claim about
  // evidence nobody read.
  //
  // The sentence is now one shared constant (review 3, item 11) so the ingest screen, the resolve
  // review and this skill cannot drift into three different claims. That makes this assertion
  // exact rather than a regex over prose: the killed roster carries NO zero-result sentence at
  // all, and the dispatching roster carries THE one the CLI itself prints.
  it("never reports a zero result for a comparison no scout performed", () => {
    expect(killed()).not.toContain(NO_FILE_OPERATION_FINDINGS);
    expect(killed()).not.toMatch(/did not disagree/);
    expect(full()).toContain(NO_FILE_OPERATION_FINDINGS); // still correct while the scout runs
  });

  // The claim the sentence makes is scoped on BOTH axes. The old wording was scoped on evidence
  // ("the documents and the commits this run examined") but not on question: a reader takes "did
  // not disagree" to cover every way a doc and a commit can disagree, when the run can only prove
  // four file operations from a porcelain status letter. A silent zero on everything else reads
  // as a clean bill of health for work that was never attempted.
  it("scopes the zero result to the question the run can actually answer", () => {
    const body = full();
    expect(body).toContain("file-operation findings");
    expect(body).toMatch(/checked one thing/);
    // And it does not let the agent restate it in its own, broader words.
    expect(body).not.toMatch(/repo is consistent/i);
  });

  it("keeps the findings step while the scout IS dispatched (today's shipped behavior)", () => {
    const body = full();
    expect(body).toMatch(/Step 4: Answer the findings/);
    expect(body).toContain(LEGACY_SURFACE.scoutDispatch[RETIRED]);
  });

  // Step numbers are prose. Dropping a step mid-body leaves either a hole in the sequence or a
  // cross-reference pointing at a step that is no longer rendered; both read to an agent as a
  // rendering bug, and "continue to Step 5" with no Step 5 is an instruction it cannot follow.
  const stepHeaders = (body: string): number[] =>
    [...body.matchAll(/^Step (\d+):/gm)].map((m) => Number(m[1]));
  const stepRefs = (body: string): number[] =>
    [...body.matchAll(/Step (\d+)/g)].map((m) => Number(m[1]));

  for (const [label, render] of [
    ["full roster", full],
    ["retired roster", killed],
  ] as const) {
    it(`renders contiguous step numbers under the ${label}`, () => {
      const headers = stepHeaders(render());
      expect(headers.length).toBeGreaterThan(3);
      expect(headers).toEqual(headers.map((_, i) => i));
    });

    it(`references only steps it renders under the ${label}`, () => {
      const body = render();
      const headers = new Set(stepHeaders(body));
      for (const ref of stepRefs(body)) expect(headers.has(ref)).toBe(true);
    });
  }

  it("applies the same retirement to the plugin surface", () => {
    const body = renderOnboardSkill(PLUGIN_SURFACE, REDUCED);
    expect(body).not.toContain(PLUGIN_SURFACE.scoutDispatch[RETIRED]);
    for (const role of REDUCED) expect(body).toContain(PLUGIN_SURFACE.scoutDispatch[role]);
  });
});

// ---------------------------------------------------------------------------------------
// Install / uninstall: what this version writes vs what any version could have written.
// ---------------------------------------------------------------------------------------
describe("scout agent files: install the roster, remove everything any version installed", () => {
  it("installs one agent definition per DISPATCHED role", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wire = require("../../../src/lib/wire") as typeof import("../../../src/lib/wire");
    const home = mkdtempSync(join(tmpdir(), "mla-roster-home-"));
    const prevHome = process.env.MEETLESS_HOME;
    process.env.MEETLESS_HOME = home;
    try {
      const written = wire.installScoutAgents(REDUCED);
      expect(written).toHaveLength(REDUCED.length);
      for (const file of written) expect(existsSync(file)).toBe(true);
      expect(written.join("\n")).not.toMatch(new RegExp(RETIRED.slice(0, 6)));
    } finally {
      if (prevHome === undefined) delete process.env.MEETLESS_HOME;
      else process.env.MEETLESS_HOME = prevHome;
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it("uninstall still removes a retired scout's agent file (it is on disk from an older wire)", () => {
    expect(SCOUT_AGENT_FILES).toHaveLength(SCOUT_NAMES.length);
    expect(INSTALLED_SCOUT_AGENT_FILES.length).toBe(DISPATCH_SCOUT_NAMES.length);
    // The removal set is the superset: everything the installer writes, plus every file an
    // older version of the installer wrote for a role since retired.
    for (const file of INSTALLED_SCOUT_AGENT_FILES) expect(SCOUT_AGENT_FILES).toContain(file);
  });
});

// ---------------------------------------------------------------------------------------
// Old data: the half of the operation that must NOT change.
// ---------------------------------------------------------------------------------------
describe("existing data survives the retirement", () => {
  it("a stored candidate still names the retired scout as its source", () => {
    // The parse path reads SCOUT_NAMES, never the dispatch roster, so a candidate persisted
    // before the retirement stays valid input for every reader.
    const res = validateCandidateShape(
      {
        kind: "constraint",
        statement: "Merged migrations are never edited in place, only superseded.",
        evidence: [{ type: "file", path: "CLAUDE.md", startLine: 3, endLine: 4 }],
        sourceScout: SCOUT_NAMES.find((r) => r !== RETIRED),
      },
      0,
    );
    expect(res.ok).toBe(true);
  });

  it("an old run's scout envelope still parses under its retired name", () => {
    const res = validateScoutResultShape({ scout: RETIRED, status: "complete", candidates: [] });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// Ingest under the reduced roster: old slots survive, a late result is refused by name.
// ---------------------------------------------------------------------------------------
describe("ingestRun under a reduced dispatch roster", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ingest = require("../../../src/lib/enrichment/ingest") as typeof import("../../../src/lib/enrichment/ingest");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const plan = require("../../../src/lib/enrichment/plan") as typeof import("../../../src/lib/enrichment/plan");
  const NOW = "2026-08-02T12:00:00.000Z";
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mla-roster-ingest-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  const seed = (): void => {
    const run = plan.buildOnboardingRun({
      runId: "run-1",
      workspaceId: "ws_1",
      repositoryRoot: "/repo",
      now: NOW,
      documentationTargets: [],
      historyEvidence: [],
      headCommit: null,
    });
    plan.writeRunRecord(home, run);
  };

  const args = (results: unknown[], dispatchRoster: readonly ScoutName[]) => ({
    env: { home, workspaceId: "ws_1", repositoryRoot: "/repo" },
    request: { protocolVersion: 1, runId: "run-1", results },
    persist: jest.fn(async (docs: Array<{ relPath: string }>) => ({
      docs: docs.map((d) => ({ relPath: d.relPath, outcome: "ingested" as const })),
    })) as never,
    now: NOW,
    dispatchRoster,
  });

  it("reaches complete when every DISPATCHED scout is complete (a retired slot never blocks)", async () => {
    seed();
    const res = await ingest.ingestRun(
      args(
        REDUCED.map((role) => ({ scout: role, status: "complete", candidates: [] })),
        REDUCED,
      ),
    );
    expect(res.ok).toBe(true);
    expect(ingest.loadState(home, "ws_1", "run-1")?.status).toBe("complete");
  });

  it("refuses a result from a scout this version does not dispatch, by name", async () => {
    seed();
    const res = await ingest.ingestRun(
      args(
        [
          ...REDUCED.map((role) => ({ scout: role, status: "complete", candidates: [] })),
          { scout: RETIRED, status: "complete", candidates: [] },
        ],
        REDUCED,
      ),
    );
    expect(res.ok).toBe(true);
    const refused = res.outcomes.find((o) => o.scout === RETIRED);
    expect(refused?.errors[0]?.code).toBe("scout_not_dispatched");
    expect(refused?.persisted).toBe(0);
  });

  it("carries a prior run's retired-scout state forward untouched", async () => {
    seed();
    // A run that ingested BEFORE the retirement: the retired scout completed with candidates.
    const priorSlot = { status: "complete" as const, candidateCount: 4 };
    ingest.writeState(home, {
      schemaVersion: 2,
      runId: "run-1",
      workspaceId: "ws_1",
      repositoryRoot: "/repo",
      status: "partial",
      updatedAt: NOW,
      scouts: Object.fromEntries(
        SCOUT_NAMES.map((role) => [
          role,
          role === RETIRED ? priorSlot : { status: "not_started" as const },
        ]),
      ) as never,
    } as never);

    const res = await ingest.ingestRun(
      args(
        REDUCED.map((role) => ({ scout: role, status: "complete", candidates: [] })),
        REDUCED,
      ),
    );
    expect(res.ok).toBe(true);
    const state = ingest.loadState(home, "ws_1", "run-1");
    expect(state?.scouts[RETIRED]).toEqual(priorSlot);
    expect(state?.status).toBe("complete");
  });

  it("does not spend the retired scout's capacity on the scouts that remain", async () => {
    // A retired role frees no budget: per-role caps are independent, so the surviving scouts
    // get exactly what they always got. (Guards against "reallocate the dead scout's cap".)
    seed();
    const res = await ingest.ingestRun(
      args(
        REDUCED.map((role) => ({ scout: role, status: "complete", candidates: [] })),
        REDUCED,
      ),
    );
    expect(res.ok).toBe(true);
    for (const o of res.outcomes) expect(o.errors.filter((e) => e.code === "cap_exceeded")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// No brief, no tokens.
// ---------------------------------------------------------------------------------------
describe("enrich brief --role: a retired scout cannot be briefed", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const protocol = require("../../../src/lib/enrichment/protocol") as typeof import("../../../src/lib/enrichment/protocol");

  it("rejects the retired role and names only the roles that run", () => {
    expect(() => protocol.assertDispatchableRole(RETIRED, REDUCED)).toThrow(
      new RegExp(`--role must be one of: ${REDUCED.join(", ")}`),
    );
  });

  it("accepts every role that is still dispatched", () => {
    for (const role of REDUCED) expect(protocol.assertDispatchableRole(role, REDUCED)).toBe(role);
  });

  it("the shipped command gates on the dispatch roster, not the protocol roster", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const enrich = require("../../../src/commands/enrich") as typeof import("../../../src/commands/enrich");
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "src", "commands", "enrich.ts"),
      "utf8",
    );
    expect(src).toContain("assertDispatchableRole");
    expect(typeof enrich.parseBriefArgs).toBe("function");
  });
});
