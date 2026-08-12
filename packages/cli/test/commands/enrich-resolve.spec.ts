// test/commands/enrich-resolve.spec.ts
//
// Coverage for `mla enrich resolve`: the command that ANSWERS a doc/code finding (§5.9).
//
// A finding is a question, not a rule. It never appears in `enrich accept`'s durable list
// (`doc_code_inconsistency` is not a durable kind), so without this verb a finding is a dead
// end: surfaced, never closed. Three answers close it, and exactly one of them touches the
// rule authority:
//
//   code_diverged  the document was right. The human's PICK is the governance approval, so the
//                  CLI-verified quote mints through the SAME materializeRules ->
//                  mintAndDeliverRules path `enrich accept` mints through. No second prompt,
//                  no second authority path. That is the load-bearing claim of this file.
//   doc_stale      the change was right. Nothing mints; the verdict is recorded.
//   carve_out      a deliberate exception. Nothing mints; the verdict is recorded.
//
// Three layers are pinned, mirroring enrich-accept.spec.ts:
//   - the pure argument parser + review renderer (fast, no fs);
//   - the real command boundary end to end: a real sidecar under a throwaway HOME, a real git
//     repo, and the real materializeRules bridge writing (or not writing) the file;
//   - the mint, through the established CLI test boundary: the injected RuleClientHttp seam.
//     No internal service is mocked.
//
// This file is also the boundary driver named by BOUNDARY_COVERAGE for `enrich.resolve` and
// `enrich.resolve.apply`: every machine envelope captured here runs through the shared §5.1
// law (assertEnvelopeBoundary), including the NEW `resolve` typed selection.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts freezes HOME at module load, so MEETLESS_HOME must be set BEFORE the command
// module is required (same pattern as enrich-accept.spec.ts).
const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-resolve-home-"));
process.env.MEETLESS_HOME = HOME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrichResolve, parseResolveArgs, renderResolveReview, resolveTransition } = enrich;

import { loadCandidatesSidecar, upsertCandidatesSidecar } from "../../src/lib/enrichment/ingest";
import { buildOnboardingRun, writeRunRecord } from "../../src/lib/enrichment/plan";
import { MANAGED_RULES_PATH } from "../../src/lib/scanner/managed-rules";
import {
  resetMachineCommand,
  resetOutputMode,
  setMachineCommand,
  setOutputMode,
  type DecisionSelection,
  type MachineEnvelope,
} from "../../src/lib/machine-output";
import { assertEnvelopeBoundary } from "../support/envelope-boundary";
import type { WorkspaceCliConfig } from "../../src/lib/config";
import type { RuleClientHttp, RuleNodeView } from "../../src/lib/rules/control-rule-client";
import {
  DISPATCH_SCOUT_NAMES,
  FINDING_RESOLUTIONS as RESOLUTIONS,
  NO_FILE_OPERATION_FINDINGS,
  RECONCILIATION_FINDING_KIND,
  scoutMayEmitKind,
} from "../../src/lib/enrichment/protocol";
import type {
  DocCodeInconsistency,
  EnrichmentKind,
  OnboardingCandidateRecord,
  OnboardingCandidatesSidecar,
} from "../../src/lib/enrichment/protocol";

const WS = "ws_enrich_resolve";

// The document's own sentence: what a `code_diverged` resolution mints. Deliberately distinct
// from the finding's generated `statement` below, because the whole point is that the quote is
// what reaches the authority and the generated prose never does.
const QUOTE = "Merged migrations are never edited in place.";
const GENERATED = "CLAUDE.md forbids editing merged migrations, and commit 9f2 modified one anyway.";
const DOC_COMMIT = "1111111111111111111111111111111111111111";
const BAD_COMMIT = "9f2a7c4e5b6d8a90112233445566778899aabbcc";

function inconsistency(over: Partial<DocCodeInconsistency> = {}): DocCodeInconsistency {
  return {
    claimClass: "never_modify",
    claimText: QUOTE,
    claimScope: "db/migrations/",
    proposedRuleKind: "constraint",
    divergence: { path: "db/migrations/0007_add_index.sql", status: "M" },
    attribution: { commit: DOC_COMMIT, authorName: "An", authorTime: "2026-06-01T00:00:00.000Z" },
    ...over,
  };
}

/** A finding record: the shape ingest persists after it verified the quote and the divergence. */
function finding(
  candidateId: string,
  over: Partial<OnboardingCandidateRecord> = {},
  inc: Partial<DocCodeInconsistency> = {},
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
    inconsistency: inconsistency(inc),
    ...over,
  };
}

/** An ordinary durable candidate: the thing `enrich accept` owns and `resolve` must refuse. */
function rule(candidateId: string, kind: EnrichmentKind, statement: string): OnboardingCandidateRecord {
  return {
    candidateId,
    kind,
    statement,
    evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 2 }],
    sourceScouts: ["documentation"],
    rationale: null,
    rationaleSource: null,
    relPath: `onboarding/${candidateId}-x.md`,
    landed: "ingested",
  };
}

// ---------------------------------------------------------------------------------------
// Pure layer: parseResolveArgs + renderResolveReview (no fs, no HOME needed).
// ---------------------------------------------------------------------------------------
describe("parseResolveArgs", () => {
  it("requires --run-id", () => {
    expect(() => parseResolveArgs([])).toThrow(/--run-id is required/);
    expect(() => parseResolveArgs(["--run-id"])).toThrow(/--run-id requires a value/);
  });

  it("parses the bare (review) form: run-id only, no verdict, PERSONAL plane by default", () => {
    expect(parseResolveArgs(["--run-id", "run_abc"])).toEqual({
      runId: "run_abc",
      dryRun: false,
      json: false,
      team: false,
      personal: false,
      yes: false,
    });
  });

  // The capability gate sniffs argv for `--finding` and `--as` in BOTH spellings to decide
  // between the review id and the mutation id. A shape the gate recognizes but the parser
  // rejects would resolve to `.apply` and then fail as a usage error inside it, which is a lie
  // about what ran. So both spellings must parse identically.
  it("accepts `--flag value` and `--flag=value` identically (the gate sniffs both)", () => {
    const spaced = parseResolveArgs(["--run-id", "r", "--finding", "a1b2c3", "--as", "doc_stale"]);
    const equals = parseResolveArgs(["--run-id=r", "--finding=a1b2c3", "--as=doc_stale"]);
    expect(spaced).toEqual(equals);
    expect(equals).toMatchObject({ runId: "r", finding: "a1b2c3", as: "doc_stale" });
  });

  it("parses each of the three verdicts, lowercased and trimmed", () => {
    for (const outcome of ["code_diverged", "doc_stale", "carve_out"]) {
      expect(parseResolveArgs(["--run-id", "r", "--finding", "a1b2c3", "--as", ` ${outcome.toUpperCase()} `])).toMatchObject({
        as: outcome,
      });
    }
  });

  it("rejects a verdict outside the closed set, and names the ones that exist", () => {
    expect(() => parseResolveArgs(["--run-id", "r", "--finding", "a1b2c3", "--as", "both_fine"])).toThrow(
      /--as must be one of: code_diverged, doc_stale, carve_out \(got "both_fine"\)/,
    );
  });

  // Half a verdict is not a verdict. `--finding` alone would silently degrade to the read-only
  // review (resolving nothing while looking like it did); `--as` alone answers no question.
  it("refuses --finding without --as", () => {
    expect(() => parseResolveArgs(["--run-id", "r", "--finding", "a1b2c3"])).toThrow(
      /--finding also requires --as <code_diverged\|doc_stale\|carve_out>/,
    );
  });

  it("refuses --as without --finding", () => {
    expect(() => parseResolveArgs(["--run-id", "r", "--as", "doc_stale"])).toThrow(
      /--as also requires --finding <id-prefix>/,
    );
  });

  it("rejects a --finding prefix that is not at least 6 hex characters", () => {
    expect(() => parseResolveArgs(["--run-id", "r", "--finding", "a1b2c", "--as", "doc_stale"])).toThrow(
      /at least 6 hex characters/,
    );
    expect(() => parseResolveArgs(["--run-id", "r", "--finding", "zzzzzz", "--as", "doc_stale"])).toThrow(
      /at least 6 hex characters/,
    );
  });

  it("parses --dry-run, --json, --workspace, --team, --yes", () => {
    const f = parseResolveArgs([
      "--run-id",
      "r",
      "--finding",
      "a1b2c3",
      "--as",
      "code_diverged",
      "--dry-run",
      "--json",
      "--workspace",
      "ws_1",
      "--team",
      "--yes",
    ]);
    expect(f).toMatchObject({ dryRun: true, json: true, workspace: "ws_1", team: true, yes: true });
  });

  it("--team and --personal are the two planes, never both", () => {
    expect(() => parseResolveArgs(["--run-id", "r", "--team", "--personal"])).toThrow(
      /either --team or --personal, not both/,
    );
  });

  it("rejects an unknown flag", () => {
    expect(() => parseResolveArgs(["--run-id", "r", "--force"])).toThrow(/Unknown flag/);
  });
});

// The transition is a total function of (what is recorded, what is being asked), which is what
// lets the command branch on a name instead of on the absence of a guard.
describe("resolveTransition", () => {
  const at = "2026-07-10T00:00:00.000Z";

  it("pending plus any verdict performs", () => {
    for (const outcome of RESOLUTIONS) {
      expect(resolveTransition(undefined, outcome)).toEqual({ kind: "perform" });
    }
  });

  it("resolved plus the same verdict is settled, and carries the record that already exists", () => {
    for (const outcome of RESOLUTIONS) {
      expect(resolveTransition({ outcome, resolvedAt: at }, outcome)).toEqual({
        kind: "settled",
        resolution: { outcome, resolvedAt: at },
      });
    }
  });

  it("resolved plus a different verdict is a conflict, for every pair", () => {
    for (const recorded of RESOLUTIONS) {
      for (const asked of RESOLUTIONS) {
        if (recorded === asked) continue;
        expect(resolveTransition({ outcome: recorded, resolvedAt: at }, asked)).toEqual({
          kind: "conflict",
          resolution: { outcome: recorded, resolvedAt: at },
        });
      }
    }
  });
});

describe("renderResolveReview", () => {
  const RUN_ID = "run_7c3f9a2e10b4";
  const open = [finding("aaaaaaaaaaaaaaaa")];

  it("leads with the VERIFIED QUOTE and never prints the generated statement", () => {
    // The quote is the half the CLI proved and the half the human is being asked about. The
    // generated prose is a model's description of the disagreement; showing it invites the human
    // to approve wording nobody verified.
    const text = renderResolveReview(RUN_ID, open, []);
    expect(text).toContain(`db/migrations/ says: "${QUOTE}"`);
    expect(text).not.toContain(GENERATED);
  });

  it("names the divergence, the commit, and who last changed the quoted line", () => {
    const text = renderResolveReview(RUN_ID, open, []);
    expect(text).toContain("but M db/migrations/0007_add_index.sql");
    expect(text).toContain(BAD_COMMIT.slice(0, 12));
    // "last changed by", not "last wrote the rule": blame names whoever last TOUCHED the anchored
    // line range. That may be the author of the sentence, or it may be whoever reflowed the
    // paragraph. Claiming authorship from a blame line puts a name on a rule they never wrote.
    expect(text).toContain("last changed by An");
    expect(text).not.toContain("written by");
  });

  it("frames the finding as a question, not a verdict (neither side is assumed right)", () => {
    const text = renderResolveReview(RUN_ID, open, []);
    // "appear inconsistent", not "disagree". The CLI proved a quote and a status letter; whether
    // the two are genuinely in conflict is the question being asked, and stating it as fact is
    // the CLI answering its own question before the human sees it.
    expect(text).toMatch(
      /1 open finding from run run_7c3f9a2e10b4 \(a document and a commit appear inconsistent; neither is assumed right\)/,
    );
    expect(text).not.toContain("disagree");
  });

  it("offers all three answers as runnable commands with the REAL run id and finding prefix", () => {
    const text = renderResolveReview(RUN_ID, open, []);
    expect(text).toContain(`mla enrich resolve --run-id ${RUN_ID} --finding aaaaaaaaaaaa --as code_diverged`);
    expect(text).toContain(`mla enrich resolve --run-id ${RUN_ID} --finding aaaaaaaaaaaa --as doc_stale`);
    expect(text).toContain(`mla enrich resolve --run-id ${RUN_ID} --finding aaaaaaaaaaaa --as carve_out`);
    expect(text).not.toContain("--run-id <id>");
  });

  it("says the pick IS the approval, so nobody waits for a second prompt", () => {
    const text = renderResolveReview(RUN_ID, open, []);
    expect(text).toContain("Your choice IS the approval; there is no second prompt.");
  });

  it("lists already-resolved findings with their outcome, below the open ones", () => {
    const closed = finding("bbbbbbbbbbbbbbbb", {
      resolution: { outcome: "carve_out", resolvedAt: "2026-07-30T00:00:00.000Z" },
    });
    const text = renderResolveReview(RUN_ID, open, [closed]);
    expect(text).toContain("1 already resolved:");
    expect(text).toContain("bbbbbbbbbbbb  carve_out");
    expect(text.indexOf("1 open finding")).toBeLessThan(text.indexOf("1 already resolved:"));
  });

  it("scopes the zero result to what the run could actually prove, and offers no commands", () => {
    // "No doc/code inconsistencies" is a clean bill of health for the repository, and this run
    // never examined the repository: it read the documents it planned and the commits it listed,
    // and it can only prove the four file operations. A zero result stated wider than its
    // coverage is the one output that makes the operator stop looking.
    const text = renderResolveReview(RUN_ID, [], []);
    expect(text).toBe(NO_FILE_OPERATION_FINDINGS);
    expect(text).toMatch(/checked one thing/);
    expect(text).toMatch(/modifying/);
    expect(text).toMatch(/renaming/);
    expect(text).not.toMatch(/no doc\/code inconsistencies/i);
  });

  it("distinguishes `all closed` from `never found any`", () => {
    const closed = finding("bbbbbbbbbbbbbbbb", {
      resolution: { outcome: "doc_stale", resolvedAt: "2026-07-30T00:00:00.000Z" },
    });
    const text = renderResolveReview(RUN_ID, [], [closed]);
    expect(text).toBe(`Every finding from run ${RUN_ID} is resolved (1 closed).`);
  });

  it("refuses to render without a run id rather than print an unrunnable placeholder", () => {
    expect(() => renderResolveReview("  ", open, [])).toThrow(/runId is required/);
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    const text = renderResolveReview(RUN_ID, open, []);
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/ -- /);
  });
});

// ---------------------------------------------------------------------------------------
// The finding row renders repository text as DATA.
//
// Every value in a finding row comes out of the repository: the quote out of a document, the
// paths out of git's name-status, the name out of a commit header. On a shared repository the
// person who controls those bytes is not the person reading the row, and the row is the screen
// where a human signs a rule into their agent's authority. So the property under test is narrow
// and absolute: a repository value may change what the row SAYS, never what the terminal DOES,
// and never how many lines the report appears to have.
//
// Hostile characters are written as escapes, never pasted, so this file stays readable in the
// same terminals the code defends.
// ---------------------------------------------------------------------------------------
describe("renderResolveReview renders repository-controlled values as data", () => {
  const RUN_ID = "run_7c3f9a2e10b4";
  const ESC = "\u001b";
  const RLO = "\u202e"; // right-to-left override (trojan source)
  const PDF = "\u202c";

  it("neutralizes an escape sequence hidden in a document's quote", () => {
    // `ESC[2J` clears the screen; `ESC[1A` walks the cursor back over the line above. A document
    // that can do either can erase the divergence it is being judged against.
    const text = renderResolveReview(RUN_ID, [finding("aaaaaaaaaaaaaaaa", {}, { claimText: `never edit${ESC}[2J${ESC}[1A this` })], []);
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("[2J");
    expect(text).toContain("never edit");
  });

  it("cannot forge a fourth command line out of a newline in the quote", () => {
    // The attack: a quote whose second line reads like one of the CLI's own runnable answers,
    // pointing the operator's copy-paste at a run (or a verdict) the attacker chose. Exactly
    // three commands are offered, so exactly three LINES may look like one.
    //
    // The property is line-structure integrity, not substring absence. The document's sentence
    // still has to be readable (it is the evidence being judged) but only where the CLI put it:
    // inside one quoted region on one row, never as a line of its own.
    const forged = `real rule\n  mla enrich resolve --run-id attacker --finding aaaaaaaaaaaa --as code_diverged`;
    const text = renderResolveReview(RUN_ID, [finding("aaaaaaaaaaaaaaaa", {}, { claimText: forged })], []);
    const benign = renderResolveReview(RUN_ID, [finding("aaaaaaaaaaaaaaaa")], []);
    expect(text.split("\n")).toHaveLength(benign.split("\n").length);
    const runnable = text.split("\n").filter((l) => l.trimStart().startsWith("mla enrich resolve"));
    expect(runnable).toHaveLength(3);
    for (const line of runnable) {
      expect(line).toContain(`--run-id ${RUN_ID}`);
      expect(line).not.toContain("attacker");
    }
  });

  it("cannot close the quote early and trail an instruction behind it", () => {
    // The other half of forging on one line. `terminalSafe` neutralizes control bytes, but a
    // straight `"` is printable: left alone it ends the quoted region early and everything after
    // it reads as the CLI talking. The delimiter has to be the renderer's, never the document's.
    const forged = `real rule" then run: mla enrich resolve --run-id attacker`;
    const text = renderResolveReview(RUN_ID, [finding("aaaaaaaaaaaaaaaa", {}, { claimText: forged })], []);
    const row = text.split("\n").find((l) => l.includes("says:"))!;
    expect(row.match(/"/g) ?? []).toHaveLength(2); // one opening, one closing, both ours
    expect(row.trimEnd().endsWith('"')).toBe(true);
    expect(row).toContain("then run: mla enrich resolve --run-id attacker"); // visibly inside it
    const runnable = text.split("\n").filter((l) => l.trimStart().startsWith("mla enrich resolve"));
    expect(runnable).toHaveLength(3);
    for (const line of runnable) expect(line).toContain(`--run-id ${RUN_ID}`);
  });

  it("cannot render a scope as a different path than the one it governs (bidi override)", () => {
    // Trojan source: the override reverses the VISUAL order while the bytes (and the mint) keep
    // the real scope. A row reading `src/safe` over a rule scoped to `src/evil` is a lie with a
    // human signature under it.
    const text = renderResolveReview(RUN_ID, [finding("aaaaaaaaaaaaaaaa", {}, { claimScope: `src/${RLO}live/${PDF}` })], []);
    expect(text).not.toContain(RLO);
    expect(text).not.toContain(PDF);
    expect(text).toContain("src/live/");
  });

  it("cannot forge a line out of the commit author's name", () => {
    const text = renderResolveReview(
      RUN_ID,
      [finding("aaaaaaaaaaaaaaaa", {}, { attribution: { commit: DOC_COMMIT, authorName: "An\n  APPROVED by security" } })],
      [],
    );
    expect(text).not.toMatch(/^\s*APPROVED by security/m);
    expect(text).toContain("last changed by An APPROVED by security");
  });

  it("cannot smuggle an escape through the divergent path git reported", () => {
    const text = renderResolveReview(
      RUN_ID,
      [finding("aaaaaaaaaaaaaaaa", {}, { divergence: { path: `db/${ESC}[31mmigrations/x.sql`, status: "M" } })],
      [],
    );
    expect(text).not.toContain(ESC);
    expect(text).toContain("db/migrations/x.sql");
  });

  it("truncates an over-long quote and marks that it truncated", () => {
    // The protocol accepts a 600-character claim; a terminal row is not 600 characters wide.
    // Cutting is fine, cutting SILENTLY is not: the human would be signing off on a sentence
    // whose remainder they never saw.
    const long = "never edit " + "x".repeat(560);
    const text = renderResolveReview(RUN_ID, [finding("aaaaaaaaaaaaaaaa", {}, { claimText: long })], []);
    expect(text).toContain("never edit xxx");
    expect(text).not.toContain(long);
    expect(text).toContain("...");
  });

  it("drops the attribution line when git's name was nothing but control bytes", () => {
    // An empty "last changed by" reads as a missing person, which is worse than no line at all.
    const text = renderResolveReview(
      RUN_ID,
      [finding("aaaaaaaaaaaaaaaa", {}, { attribution: { commit: DOC_COMMIT, authorName: `${ESC}[0m` } })],
      [],
    );
    expect(text).not.toContain("last changed by");
  });

  it("keeps the stored quote byte-exact; sanitization is a display transform only", () => {
    // The mint and the ancestry proof re-read this string out of the document. Normalize what is
    // STORED and the finding stops matching the file it came from.
    const raw = `never edit${ESC}[2J this`;
    const record = finding("aaaaaaaaaaaaaaaa", {}, { claimText: raw });
    renderResolveReview(RUN_ID, [record], []);
    expect(record.inconsistency!.claimText).toBe(raw);
  });
});

// ---------------------------------------------------------------------------------------
// Command boundary end to end: real sidecar, real git repo, real materialize, injected mint.
// ---------------------------------------------------------------------------------------
describe("mla enrich resolve (end to end, real sidecar + mint + file write)", () => {
  let repo: string;
  let root: string;
  let managedPath: string;
  let cwd0: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let err: string[];
  let posts: { path: string; body: MintBody }[];
  let deliveries: { workspaceId: string; repositoryRoot: string }[];

  const RUN = "run_resolve_e2e";
  const SCOPE = "scope_test_repo";
  const F1 = "a1a1a1a1a1a1a1a1";
  const F2 = "b2b2b2b2b2b2b2b2";

  interface MintBody {
    workspaceId: string;
    authorityScope: string;
    ownerUserId: string | null;
    canonicalPayloadHash: string;
    requestIdempotencyKey: string;
    payload: {
      text: string;
      strength: string;
      runtimeScopeId: string;
      applicability: { mode: string };
      enforcementCeiling: string;
      deliveryChannels: string[];
    };
  }

  function wsCfg(): WorkspaceCliConfig {
    return {
      workspaceId: WS,
      controlUrl: "https://control.test",
      controlToken: "tok",
      auth: { mode: "user-token", accessToken: "tok" },
    } as WorkspaceCliConfig;
  }

  function ruleNode(id: string, hash: string): RuleNodeView {
    return {
      id,
      workspaceId: WS,
      authorityScopeId: "PERSONAL",
      ownerUserId: "user_an",
      projectId: null,
      lifecycleStatusId: "ACTIVE",
      currentVersionId: `ver_${id}`,
      currentVersion: {
        id: `ver_${id}`,
        ruleId: id,
        payload: {} as NonNullable<RuleNodeView["currentVersion"]>["payload"],
        canonicalPayloadHash: hash,
        supersedesVersionId: null,
        attestedByUserId: "user_an",
        attestedAt: "2026-07-12T00:00:00.000Z",
        requestIdempotencyKey: hash,
      },
    } as RuleNodeView;
  }

  function fakeHttp(live: RuleNodeView[] = []): RuleClientHttp {
    return {
      get: (async () => live) as unknown as RuleClientHttp["get"],
      post: (async (_cfg: unknown, p: string, body: unknown) => {
        const b = body as MintBody;
        posts.push({ path: p, body: b });
        return ruleNode(`node_${posts.length}`, b.canonicalPayloadHash);
      }) as unknown as RuleClientHttp["post"],
      patch: (async () => {
        throw new Error("unexpected patch");
      }) as unknown as RuleClientHttp["patch"],
    };
  }

  /**
   * A fake that REMEMBERS: GET returns what POST has already accepted, which is what makes a
   * second run's hash lookup meaningful. A fake that always answers "nothing is live" would
   * prove only that the command posts twice against a backend that never existed. Every test
   * about a REPEATED verdict needs this one, and must pass the SAME instance to both runs.
   */
  function statefulHttp(): RuleClientHttp {
    const live: RuleNodeView[] = [];
    return {
      get: (async () => live) as unknown as RuleClientHttp["get"],
      post: (async (_cfg: unknown, p: string, body: unknown) => {
        const b = body as MintBody;
        posts.push({ path: p, body: b });
        const node = ruleNode(`node_${posts.length}`, b.canonicalPayloadHash);
        live.push(node);
        return node;
      }) as unknown as RuleClientHttp["post"],
      patch: (async () => {
        throw new Error("unexpected patch");
      }) as unknown as RuleClientHttp["patch"],
    };
  }

  function deps(over: Partial<Parameters<typeof runEnrichResolve>[1]> = {}) {
    return {
      loadConfig: () => wsCfg(),
      http: fakeHttp(),
      resolveOperator: () => ({ userId: "user_an", displayName: "An" }),
      resolveRuntimeScopeId: () => SCOPE,
      isInteractive: () => false,
      confirm: () => false,
      refreshDelivery: async (cfg: WorkspaceCliConfig, repositoryRoot: string) => {
        deliveries.push({ workspaceId: cfg.workspaceId, repositoryRoot });
      },
      ...over,
    };
  }

  function resolve(argv: string[], over: Partial<Parameters<typeof runEnrichResolve>[1]> = {}) {
    return runEnrichResolve(["--workspace", WS, ...argv], deps(over));
  }

  /** The persisted record, re-read from the sidecar (never from memory). */
  function persisted(candidateId: string): OnboardingCandidateRecord | undefined {
    return loadCandidatesSidecar(HOME, WS, RUN)?.candidates.find((c) => c.candidateId === candidateId);
  }

  beforeAll(() => {
    writeFileSync(
      join(HOME, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: "http://127.0.0.1:1",
        controlToken: "ik-test",
        actorUserId: "user_test",
        mlaPath: process.env.MLA_TEST_MLA_SHIM ?? "/bin/true",
      }),
    );
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-enrich-resolve-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim();
    managedPath = join(root, MANAGED_RULES_PATH);
    cwd0 = process.cwd();
    process.chdir(repo);
    out = [];
    err = [];
    posts = [];
    deliveries = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((m?: unknown) => void out.push(String(m ?? "")));
    errSpy = jest.spyOn(console, "error").mockImplementation((m?: unknown) => void err.push(String(m ?? "")));
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(cwd0);
    rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    rmSync(join(HOME, "workspaces"), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  function seed(candidates: OnboardingCandidateRecord[]): void {
    const sidecar: OnboardingCandidatesSidecar = {
      schemaVersion: 1,
      workspaceId: WS,
      runId: RUN,
      repositoryRoot: root,
      updatedAt: "2026-07-10T00:00:00.000Z",
      candidates,
    };
    upsertCandidatesSidecar(HOME, sidecar);
  }

  /** The plan record `enrich plan` writes: proof the run happened, independent of what it persisted. */
  function runRecord(runId: string) {
    return buildOnboardingRun({
      runId,
      workspaceId: WS,
      repositoryRoot: root,
      now: "2026-07-10T00:00:00.000Z",
      documentationTargets: [],
      historyEvidence: [],
    });
  }

  /** One open finding plus one ordinary durable rule: the run `resolve` and `accept` share. */
  function seedMixed(): void {
    seed([finding(F1), rule("c3c3c3c3c3c3c3c3", "convention", "Prefer relative imports.")]);
  }

  it("exits 2 with a helpful message when the run itself is unknown", async () => {
    const code = await resolve(["--run-id", "run_missing"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/no onboarding run run_missing/);
    expect(existsSync(managedPath)).toBe(false);
  });

  // A run that persisted nothing writes no sidecar, and the onboarding skill sends the agent
  // here anyway: run the review, and if it lists nothing, say the one scoped line. Reporting a
  // known run's honest zero as an error taught the agent to say the run FAILED, which is a
  // second false statement about a run that worked. The run record is what separates the two:
  // present means the run happened and produced nothing, absent means the id is wrong.
  it("reports a known run that persisted nothing as a zero result, not an error", async () => {
    writeRunRecord(HOME, runRecord(RUN));
    const code = await resolve(["--run-id", RUN]);
    expect(code).toBe(0);
    expect(err.join("\n")).toBe("");
    expect(out.join("\n")).toContain(NO_FILE_OPERATION_FINDINGS);
    expect(existsSync(managedPath)).toBe(false);
  });

  // The zero-result path still has no finding to resolve. A verdict against it is a bad
  // selection, and it must not silently succeed just because the run is known.
  it("refuses a verdict against a run that persisted no findings", async () => {
    writeRunRecord(HOME, runRecord(RUN));
    const code = await resolve(["--run-id", RUN, "--finding", "aaaaaa", "--as", "code_diverged"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/no finding/i);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
  });

  it("review mode (no verdict) mints nothing, writes nothing, closes nothing", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(persisted(F1)?.resolution).toBeUndefined();
    const text = out.join("\n");
    expect(text).toContain(QUOTE);
    // The durable rule in the same run belongs to `accept`; the review never offers it here.
    expect(text).not.toContain("Prefer relative imports.");
  });

  it("--json review emits the verified halves of the finding, not the generated prose", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(out.join("\n")) as {
      runId: string;
      open: { candidateId: string; claimText: string; proposedRuleKind: string; divergence: { status: string } }[];
      resolved: unknown[];
    };
    expect(payload.runId).toBe(RUN);
    expect(payload.open).toHaveLength(1);
    expect(payload.open[0]).toMatchObject({
      candidateId: F1,
      claimText: QUOTE,
      proposedRuleKind: "constraint",
      divergence: { status: "M", path: "db/migrations/0007_add_index.sql" },
    });
    expect(payload.resolved).toHaveLength(0);
  });

  // THE load-bearing claim of §5.9: the pick IS the approval, and it rides the EXISTING mint.
  it("code_diverged mints the VERIFIED QUOTE through the same authority path accept uses", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"]);
    expect(code).toBe(0);

    expect(posts).toHaveLength(1);
    const p = posts[0];
    expect(p.path).toContain("/internal/v1/rules");
    // The DOCUMENT'S sentence reaches the authority. The generated finding prose never does.
    expect(p.body.payload.text).toBe(QUOTE);
    expect(p.body.payload.text).not.toBe(GENERATED);
    expect(p.body.workspaceId).toBe(WS);
    expect(p.body.authorityScope).toBe("PERSONAL");
    expect(p.body.ownerUserId).toBe("user_an");
    expect(p.body.requestIdempotencyKey).toBe(p.body.canonicalPayloadHash);
    expect(p.body.payload.runtimeScopeId).toBe(SCOPE);
    // Triple-safe exactly like an accepted rule: injected, never enforced.
    expect(p.body.payload.applicability.mode).toBe("ambient");
    expect(p.body.payload.enforcementCeiling).toBe("OBSERVE");
    expect(p.body.payload.deliveryChannels).toEqual(["runtimeInject"]);

    // And the file, the projection, carries the same sentence.
    expect(readFileSync(managedPath, "utf8")).toContain(QUOTE);
    // Hop 3: the local caches are refreshed against the RUN's repo, never the cwd.
    expect(deliveries).toEqual([{ workspaceId: WS, repositoryRoot: root }]);
  });

  it("code_diverged stamps the verdict AND the kind that actually reached the authority", async () => {
    seedMixed();
    await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"]);
    const rec = persisted(F1);
    expect(rec?.resolution?.outcome).toBe("code_diverged");
    expect(rec?.resolution?.mintedRuleKind).toBe("constraint");
    expect(Date.parse(rec!.resolution!.resolvedAt)).not.toBeNaN();
    // Everything the finding carried survives the stamp; resolving is not a rewrite.
    expect(rec?.inconsistency?.claimText).toBe(QUOTE);
    expect(out.join("\n")).toContain("the document was right, and its sentence is now a rule");
  });

  it("resolving one finding leaves the run's other candidates untouched", async () => {
    seedMixed();
    await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"]);
    const sidecar = loadCandidatesSidecar(HOME, WS, RUN);
    expect(sidecar?.candidates).toHaveLength(2);
    expect(persisted("c3c3c3c3c3c3c3c3")?.statement).toBe("Prefer relative imports.");
    expect(persisted("c3c3c3c3c3c3c3c3")?.resolution).toBeUndefined();
  });

  it("doc_stale records the verdict and mints NOTHING (the document is what needs the edit)", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(persisted(F1)?.resolution).toMatchObject({ outcome: "doc_stale" });
    expect(persisted(F1)?.resolution?.mintedRuleKind).toBeUndefined();
    const said = out.join("\n");
    expect(said).toContain("Nothing was minted.");
    expect(said).toContain("Update the document itself; this only records the verdict.");
  });

  it("carve_out records the verdict EXPLICITLY and mints nothing", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "carve_out"]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(persisted(F1)?.resolution).toMatchObject({ outcome: "carve_out" });
    expect(out.join("\n")).toContain("a deliberate exception");
  });

  // The ordering rule: stamp LAST, never on a dry run. A finding recorded as closed while its
  // rule never reached the authority is the one state that ordering makes unreachable.
  it("--dry-run mints nothing, writes nothing, and closes NOTHING", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged", "--dry-run"]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(persisted(F1)?.resolution).toBeUndefined(); // still open: nothing happened
    expect(out.join("\n")).toContain("Would resolve");
  });

  it("a failed mint leaves the finding OPEN (no verdict without an authority write)", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"], {
      http: {
        get: (async () => []) as unknown as RuleClientHttp["get"],
        post: (async () => {
          throw new Error("control refused: 503");
        }) as unknown as RuleClientHttp["post"],
        patch: (async () => {
          throw new Error("unexpected patch");
        }) as unknown as RuleClientHttp["patch"],
      },
    });
    expect(code).not.toBe(0);
    expect(persisted(F1)?.resolution).toBeUndefined();
  });

  it("--team mints on the TEAM plane once confirmed by --yes", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged", "--team", "--yes"]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].body.authorityScope).toBe("TEAM");
    expect(posts[0].body.ownerUserId).toBeNull();
  });

  it("--team refuses non-interactively without --yes: nothing minted, and the finding stays open", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged", "--team"], {
      isInteractive: () => false,
    });
    expect(code).not.toBe(0);
    expect(posts).toHaveLength(0);
    expect(persisted(F1)?.resolution).toBeUndefined();
  });

  // Selection: fail-closed, and specific about WHY.
  it("refuses a prefix that matches nothing in the run", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "ffffff", "--as", "doc_stale"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/no finding id starts with "ffffff" in this run/);
  });

  // A prefix that hits a durable rule is not "no match", it is the WRONG VERB. Saying so is the
  // difference between a two-second fix and a hunt for a candidate id that was never missing.
  it("refuses a prefix that matches a durable rule, and names the verb that owns it", async () => {
    seedMixed();
    const code = await resolve(["--run-id", RUN, "--finding", "c3c3c3", "--as", "doc_stale"]);
    expect(code).toBe(2);
    const said = err.join("\n");
    expect(said).toMatch(/is a candidate in this run but not a finding/);
    expect(said).toMatch(/accepted with `mla enrich accept`, not resolved/);
    expect(persisted("c3c3c3c3c3c3c3c3")?.resolution).toBeUndefined();
  });

  it("refuses an ambiguous prefix rather than guessing which finding was meant", async () => {
    seed([finding("abcdef1111111111"), finding("abcdef2222222222")]);
    const code = await resolve(["--run-id", RUN, "--finding", "abcdef", "--as", "doc_stale"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/prefix "abcdef" is ambiguous \(matches 2\); use more characters/);
  });

  // Re-resolving DIFFERENTLY is refused rather than overwritten: the first answer already minted
  // (or explicitly did not), and silently replacing it leaves a live rule under a verdict that no
  // longer says it should be.
  it("refuses to re-resolve a closed finding with a different answer", async () => {
    seedMixed();
    expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "carve_out"])).toBe(0);
    err = [];
    const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/is already resolved as carve_out/);
    expect(posts).toHaveLength(0); // the second answer never reached the authority
    expect(persisted(F1)?.resolution?.outcome).toBe("carve_out"); // and never overwrote the first
  });

  // -------------------------------------------------------------------------------------
  // The three transitions, stated as behavior rather than as a fall-through.
  //
  //   pending  + any verdict        performs, exactly once
  //   resolved + the SAME verdict   no-op: nothing minted, nothing written, nothing re-stamped
  //   resolved + a DIFFERENT one    conflict, refused above
  //
  // The middle one is the one that used to be implicit: with only the conflict branch guarding
  // the body, a repeat fell through the WHOLE thing. It re-entered the mint (a network call), it
  // re-wrote the projection, and it re-stamped `resolvedAt` with a fresh clock reading, which
  // silently moved WHEN the decision was recorded. An audit trail whose timestamp moves every
  // time someone retries a command is not an audit trail.
  // -------------------------------------------------------------------------------------
  describe("resolution transitions", () => {
    it("resolved plus the SAME verdict changes nothing, including the audit timestamp", async () => {
      seedMixed();
      const http = statefulHttp();
      const argv = ["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"];
      expect(await resolve(argv, { http })).toBe(0);
      const first = persisted(F1)!.resolution!;

      // Delete the projection first: anything the retry re-writes is work that a no-op did not
      // do. The rule is live on the authority either way; this file is only its local rendering.
      rmSync(managedPath);
      out = [];

      expect(await resolve(argv, { http })).toBe(0);
      expect(posts).toHaveLength(1); // no second mint
      expect(deliveries).toHaveLength(1); // no second delivery refresh
      expect(existsSync(managedPath)).toBe(false); // no second write
      expect(persisted(F1)!.resolution).toEqual(first); // resolvedAt byte-identical

      const said = out.join("\n");
      expect(said).toContain("is already resolved as code_diverged");
      expect(said).not.toContain("its sentence is now a rule"); // it was not resolved again
    });

    it("a repeated non-minting verdict is equally frozen", async () => {
      seedMixed();
      const argv = ["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"];
      expect(await resolve(argv)).toBe(0);
      const first = persisted(F1)!.resolution!;
      out = [];
      expect(await resolve(argv)).toBe(0);
      expect(persisted(F1)!.resolution).toEqual(first);
      expect(posts).toHaveLength(0);
      expect(out.join("\n")).toContain("is already resolved as doc_stale");
    });

    // A dry run on a settled finding used to print "Would resolve ...", which is a claim about a
    // future run that would in fact do nothing.
    it("--dry-run on a settled finding says it is settled, not that it WOULD resolve it", async () => {
      seedMixed();
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "carve_out"])).toBe(0);
      out = [];
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "carve_out", "--dry-run"])).toBe(0);
      const said = out.join("\n");
      expect(said).not.toContain("Would resolve");
      expect(said).toContain("is already resolved as carve_out");
    });
  });

  // -------------------------------------------------------------------------------------
  // Failure injection around the two durable writes.
  //
  // `code_diverged` writes twice, in this order: the MINT (remote authority, then the local
  // projection) and the CLOSURE (the sidecar stamp). Either half can fail alone. The ordering
  // makes one state unreachable (a finding closed under a rule that never reached the
  // authority) and leaves the other recoverable (rule live, finding still open) with the RETRY
  // as its recovery: the mint dedups by payload hash, so re-running the same verdict finds the
  // rule already live, mints nothing, and closes the finding.
  // -------------------------------------------------------------------------------------
  describe("failure injection", () => {
    const runsDir = (): string => join(HOME, "workspaces", WS, "onboarding-runs");

    it("a closure that fails after a successful mint reports the true state instead of crashing", async () => {
      seedMixed();
      const http = statefulHttp();
      const argv = ["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"];

      let code: number;
      try {
        // Real failure injection, no seam: the stamp is an atomic temp+rename, so a directory
        // that cannot take a new file fails the write exactly as a full disk would.
        chmodSync(runsDir(), 0o500);
        code = await resolve(argv, { http });
      } finally {
        chmodSync(runsDir(), 0o700);
      }

      expect(code).not.toBe(0);
      expect(posts).toHaveLength(1); // the rule DID reach the authority
      expect(existsSync(managedPath)).toBe(true); // and the projection matches it
      expect(persisted(F1)?.resolution).toBeUndefined(); // only the closure is missing
      const said = err.join("\n");
      expect(said).toMatch(/live on the authority/i);
      expect(said).toMatch(/still open/i);
      expect(said).toMatch(/re-run/i);

      // The retry is the recovery, and it is not a second mint.
      expect(await resolve(argv, { http })).toBe(0);
      expect(posts).toHaveLength(1);
      expect(persisted(F1)?.resolution?.outcome).toBe("code_diverged");
      expect(persisted(F1)?.resolution?.mintedRuleKind).toBe("constraint");
    });

    it("a closure that fails on a non-minting verdict leaves the finding open, and the retry closes it", async () => {
      seedMixed();
      const argv = ["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"];
      let code: number;
      try {
        chmodSync(runsDir(), 0o500);
        code = await resolve(argv);
      } finally {
        chmodSync(runsDir(), 0o700);
      }
      expect(code).not.toBe(0);
      expect(posts).toHaveLength(0);
      expect(persisted(F1)?.resolution).toBeUndefined();
      // Nothing was minted, so the message must claim nothing about a rule: neither that one is
      // live nor that a retry will avoid minting it twice.
      expect(err.join("\n")).not.toMatch(/live on the authority/i);
      expect(err.join("\n")).not.toMatch(/minted twice/i);
      expect(err.join("\n")).toMatch(/still open. Re-run the same command to close it\./);

      expect(await resolve(argv)).toBe(0);
      expect(persisted(F1)?.resolution?.outcome).toBe("doc_stale");
    });
  });

  // -------------------------------------------------------------------------------------
  // The §9 metric row. The design's kill rule is computed from `carve_out` share, and the
  // resolution-rate metric needs the closure side of the pair, so this command is the only
  // producer of half the measurement plane. What matters is not just that a row is written but
  // WHEN: a row for a closure the sidecar never recorded would report governance that does not
  // exist, and the kill rule would be evaluated on it.
  // -------------------------------------------------------------------------------------
  describe("the resolved analytics row (design §9)", () => {
    const runsDir = (): string => join(HOME, "workspaces", WS, "onboarding-runs");
    let baseline: number;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const store = require("../../src/lib/analytics/store") as typeof import("../../src/lib/analytics/store");

    beforeEach(() => {
      // The spool is append-only and shared by every test in this file, so each case reads only
      // what IT appended rather than a global tally that neighbours can move.
      baseline = store.readEvents().length;
    });

    function rows(): Record<string, unknown>[] {
      return (store.readEvents() as unknown as Record<string, unknown>[])
        .slice(baseline)
        .filter((e) => e.event_type === "mla_onboarding_finding");
    }

    it("stamps one resolved row carrying the verdict and the truncated finding id", async () => {
      seedMixed();
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).toBe(0);
      const emitted = rows();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        finding_phase: "resolved",
        finding_verdict: "doc_stale",
        minted_rule: false,
        finding_id: F1.slice(0, 12),
        workspace_id: WS,
      });
    });

    it("records minted_rule only when a rule actually reached the authority", async () => {
      seedMixed();
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"])).toBe(0);
      expect(posts).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ finding_verdict: "code_diverged", minted_rule: true });
    });

    it("counts a carve_out verbatim: this row IS the kill metric", async () => {
      seedMixed();
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "carve_out"])).toBe(0);
      expect(rows()[0]).toMatchObject({ finding_verdict: "carve_out", minted_rule: false });
    });

    it("emits NOTHING on a dry run: nothing was decided, so there is nothing to count", async () => {
      seedMixed();
      expect(
        await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "carve_out", "--dry-run"]),
      ).toBe(0);
      expect(persisted(F1)?.resolution).toBeUndefined();
      expect(rows()).toHaveLength(0);
    });

    it("emits NOTHING on a settled repeat, so one closure counts once", async () => {
      seedMixed();
      const argv = ["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"];
      expect(await resolve(argv)).toBe(0);
      expect(rows()).toHaveLength(1);
      expect(await resolve(argv)).toBe(0);
      expect(rows()).toHaveLength(1); // the second run performed nothing, so it counted nothing
    });

    it("emits NOTHING when the closure itself failed (the finding is still open)", async () => {
      seedMixed();
      try {
        chmodSync(runsDir(), 0o500);
        expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).not.toBe(0);
      } finally {
        chmodSync(runsDir(), 0o700);
      }
      expect(persisted(F1)?.resolution).toBeUndefined();
      expect(rows()).toHaveLength(0);
    });

    it("emits NOTHING in review mode (no verdict was asked for)", async () => {
      seedMixed();
      expect(await resolve(["--run-id", RUN])).toBe(0);
      expect(rows()).toHaveLength(0);
    });
  });

  // A resolved finding must survive the next ingest. Ingest rewrites a record in place (that is
  // how a resuming scout refreshes its landed outcome) and has no opinion about resolution, so a
  // later run would otherwise silently RE-OPEN a question the human already answered.
  it("a later ingest of the same finding never un-resolves it", async () => {
    seedMixed();
    await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "carve_out"]);
    upsertCandidatesSidecar(HOME, {
      schemaVersion: 1,
      workspaceId: WS,
      runId: RUN,
      repositoryRoot: root,
      updatedAt: "2026-07-31T00:00:00.000Z",
      candidates: [finding(F1, { landed: "noop_unchanged" })], // fresh record, no resolution
    });
    expect(persisted(F1)?.resolution?.outcome).toBe("carve_out");
    expect(persisted(F1)?.landed).toBe("noop_unchanged"); // the refresh still landed
  });

  it("a run whose findings are all closed says so, and offers no verdict commands", async () => {
    seedMixed();
    await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"]);
    out = [];
    const code = await resolve(["--run-id", RUN]);
    expect(code).toBe(0);
    expect(out.join("\n")).toBe(`Every finding from run ${RUN} is resolved (1 closed).`);
  });

  // -------------------------------------------------------------------------------------
  // Machine mode: this file is the boundary driver BOUNDARY_COVERAGE names for both
  // `enrich.resolve` (the read-only review, which carries the typed decision_request) and
  // `enrich.resolve.apply` (the mutation). Every envelope runs through the shared §5.1 law.
  // -------------------------------------------------------------------------------------
  describe("machine mode: decision_request on the review, result on the verdict", () => {
    let stdoutSpy: jest.SpyInstance;
    let docs: string[];

    beforeEach(() => {
      docs = [];
      stdoutSpy = jest
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          docs.push(String(chunk));
          return true;
        });
    });

    afterEach(() => {
      stdoutSpy.mockRestore();
      resetOutputMode();
      resetMachineCommand();
    });

    function envelope(): MachineEnvelope {
      expect(docs).toHaveLength(1);
      return assertEnvelopeBoundary(docs[0]);
    }

    it("review: closes nothing and carries the typed three-way decision_request", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve");

      const code = await resolve(["--run-id", RUN]);
      expect(code).toBe(0);
      expect(posts).toHaveLength(0);
      expect(persisted(F1)?.resolution).toBeUndefined();

      const env = envelope();
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.command).toBe("enrich.resolve");
      expect(env.next_action).toBeUndefined();

      const dr = env.decision_request;
      expect(dr).toBeDefined();
      if (!dr) return;
      expect(dr.kind).toBe("enrich.resolve");
      expect(dr.subject.run_id).toBe(RUN);
      // The prompt states the disagreement in both parties' own terms and asks the question.
      expect(dr.prompt).toContain(QUOTE);
      expect(dr.prompt).toContain("Which one is right?");
      // Three verdicts plus "leave it open". Every selection is typed; none carries a command.
      expect(dr.options.map((o) => o.id)).toEqual(["code_diverged", "doc_stale", "carve_out", "none"]);
      const byId = Object.fromEntries(dr.options.map((o) => [o.id, o]));
      expect(byId.code_diverged.selection).toEqual({
        mode: "resolve",
        candidate_id: F1, // the FULL id, so the connector's `--finding` resolves unambiguously
        resolution: "code_diverged",
      });
      expect(byId.doc_stale.selection).toEqual({ mode: "resolve", candidate_id: F1, resolution: "doc_stale" });
      expect(byId.carve_out.selection).toEqual({ mode: "resolve", candidate_id: F1, resolution: "carve_out" });
      expect(byId.none.selection).toEqual({ mode: "none" });
      // The mint option names what would actually be minted: the quote, and its kind.
      expect(byId.code_diverged.label).toContain(QUOTE);
      expect(byId.code_diverged.label).toContain("constraint");
      expect(env.human_summary).toContain("1 open finding");
    });

    // One decision_request per envelope, so a run with several open findings asks about the
    // FIRST one and says how many follow. A request spanning several would offer an answer to a
    // question it had not asked.
    it("review: asks about ONE finding and says how many remain", async () => {
      seed([finding("abcdef1111111111"), finding("abcdef2222222222")]);
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve");

      expect(await resolve(["--run-id", RUN])).toBe(0);
      const env = envelope();
      if (!env.ok || !env.decision_request) throw new Error("expected a decision_request");
      const ids = new Set(
        env.decision_request.options
          .map((o) => o.selection)
          .filter((s): s is Extract<DecisionSelection, { mode: "resolve" }> => s.mode === "resolve")
          .map((s) => s.candidate_id),
      );
      expect([...ids]).toEqual(["abcdef1111111111"]);
      expect(env.decision_request.prompt).toContain("(1 more open after this one.)");
    });

    it("review: a run with no findings carries NO decision_request", async () => {
      seed([rule("c3c3c3c3c3c3c3c3", "convention", "Prefer relative imports.")]);
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve");

      expect(await resolve(["--run-id", RUN])).toBe(0);
      const env = envelope();
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.decision_request).toBeUndefined();
      // The agent surface gets the SAME scoped sentence the human review prints, not a looser
      // paraphrase of it. An agent handed "no doc/code findings" relays it to its user as a
      // clean repository, which widens a claim this run never made; the constant is the only
      // wording all three surfaces (ingest screen, review, skill) are allowed to say.
      expect(env.human_summary).toBe(NO_FILE_OPERATION_FINDINGS);
    });

    it("apply: the mutation emits a result envelope naming the finding, the verdict and the mint", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve.apply");

      const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"]);
      expect(code).toBe(0);

      const env = envelope();
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.command).toBe("enrich.resolve.apply");
      // A completed mutation asks nothing.
      expect(env.decision_request).toBeUndefined();
      const result = env.result as {
        runId: string;
        findingId: string;
        resolution: string;
        dryRun: boolean;
        authorityScope: string;
        minted: { ruleId: string; statement: string }[];
      };
      expect(result).toMatchObject({
        runId: RUN,
        findingId: F1,
        resolution: "code_diverged",
        dryRun: false,
        authorityScope: "PERSONAL",
      });
      expect(result.minted).toHaveLength(1);
      expect(result.minted[0].statement).toBe(QUOTE);
      expect(persisted(F1)?.resolution?.outcome).toBe("code_diverged");
    });

    it("apply: a non-minting verdict emits a boundary-valid envelope with an empty mint list", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve.apply");

      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).toBe(0);
      const env = envelope();
      if (!env.ok) throw new Error("expected a success envelope");
      const result = env.result as { resolution: string; minted: unknown[] };
      expect(result.resolution).toBe("doc_stale");
      expect(result.minted).toEqual([]);
      expect(posts).toHaveLength(0);
    });

    // A repeat is a SUCCESS, not an error: the caller asked for a state the system is already in.
    // But a caller that cannot tell "I just closed it" from "it was already closed" will report
    // work that did not happen, so the envelope says which one it was and when it happened.
    it("apply: a repeated verdict is a success envelope that says nothing changed", async () => {
      seedMixed();
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).toBe(0);
      const first = persisted(F1)!.resolution!;

      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve.apply");
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).toBe(0);

      const env = envelope();
      if (!env.ok) throw new Error("expected a success envelope");
      const result = env.result as { unchanged: boolean; resolution: string; resolvedAt: string | null };
      expect(result.unchanged).toBe(true);
      expect(result.resolution).toBe("doc_stale");
      expect(result.resolvedAt).toBe(first.resolvedAt);
      expect(persisted(F1)!.resolution).toEqual(first);
    });

    it("apply: the FIRST verdict is a success envelope that says it changed something", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve.apply");
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).toBe(0);
      const env = envelope();
      if (!env.ok) throw new Error("expected a success envelope");
      const result = env.result as { unchanged: boolean; resolvedAt: string | null };
      expect(result.unchanged).toBe(false);
      expect(result.resolvedAt).toBe(persisted(F1)!.resolution!.resolvedAt);
    });

    it("apply: a refused verdict emits a boundary-valid ERROR envelope, not a human line", async () => {
      seedMixed();
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "carve_out"])).toBe(0);

      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve.apply");
      const code = await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"]);
      expect(code).toBe(2);

      const env = envelope();
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.command).toBe("enrich.resolve.apply");
      expect(env.error.code).toBe("already_resolved");
      expect(env.error.message).toMatch(/already resolved as carve_out/);
    });

    it("apply: a usage error (half a verdict) is an error envelope, not a thrown parse crash", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.resolve.apply");

      const code = await resolve(["--run-id", RUN, "--as", "doc_stale"]);
      expect(code).toBe(2);
      const env = envelope();
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("usage_error");
      expect(env.error.message).toMatch(/--as also requires --finding/);
    });
  });

  // -------------------------------------------------------------------------------------
  // Backward compatibility of the kill patch (review 3, item 7).
  //
  // The retirement of a finding-producing scout is a one-line edit to RETIRED_SCOUT_NAMES.
  // It stops DISPATCH. It must not strand a finding a user already has on disk: the record
  // is the same record, and answering it is the same answer. These pin that resolution is a
  // pure function of the STORED record and never consults the onboarding roster, so the
  // kill can be performed (or reverted) without a data migration.
  //
  // RETIRED is derived, not spelled: the scout that produces findings today is the one a
  // retirement would remove, and deriving it means this file cannot drift from the roster.
  // -------------------------------------------------------------------------------------
  describe("a finding minted by a scout the build no longer dispatches", () => {
    const RETIRED = DISPATCH_SCOUT_NAMES.filter((role) =>
      scoutMayEmitKind(role, RECONCILIATION_FINDING_KIND),
    )[0];
    const REDUCED = DISPATCH_SCOUT_NAMES.filter((role) => role !== RETIRED);

    /** The record as an older run wrote it, whose scout the reduced roster does not brief. */
    const seedOld = (): void => {
      expect(REDUCED).not.toContain(RETIRED); // the post-kill roster, by construction
      seed([finding(F1, { sourceScouts: [RETIRED] })]);
    };

    it("still renders, with its quote, its divergence, and all three answers", async () => {
      seedOld();
      expect(await resolve(["--run-id", RUN])).toBe(0);
      const text = out.join("\n");
      expect(text).toContain(QUOTE);
      expect(text).toContain("db/migrations/0007_add_index.sql");
      for (const outcome of ["code_diverged", "doc_stale", "carve_out"]) {
        expect(text).toContain(`--finding a1a1a1a1a1a1 --as ${outcome}`);
      }
    });

    it("still resolves, and still mints through the same authority path", async () => {
      seedOld();
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"])).toBe(0);
      expect(posts).toHaveLength(1);
      expect(posts[0].body.payload.text).toBe(QUOTE);
      expect(persisted(F1)?.resolution).toMatchObject({ outcome: "code_diverged" });
      // The stored provenance is preserved verbatim: closing a finding never rewrites who
      // found it, so a later audit can still say which scout this came from.
      expect(persisted(F1)?.sourceScouts).toEqual([RETIRED]);
    });

    it("still records a non-minting verdict", async () => {
      seedOld();
      expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).toBe(0);
      expect(posts).toHaveLength(0);
      expect(persisted(F1)?.resolution).toMatchObject({ outcome: "doc_stale" });
    });
  });
});
