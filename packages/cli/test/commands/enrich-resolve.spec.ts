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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts freezes HOME at module load, so MEETLESS_HOME must be set BEFORE the command
// module is required (same pattern as enrich-accept.spec.ts).
const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-resolve-home-"));
process.env.MEETLESS_HOME = HOME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrichResolve, parseResolveArgs, renderResolveReview } = enrich;

import { loadCandidatesSidecar, upsertCandidatesSidecar } from "../../src/lib/enrichment/ingest";
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

  it("names the divergence, the commit, and who last wrote the rule", () => {
    const text = renderResolveReview(RUN_ID, open, []);
    expect(text).toContain("but M db/migrations/0007_add_index.sql");
    expect(text).toContain(BAD_COMMIT.slice(0, 12));
    expect(text).toContain("the rule was last written by An");
  });

  it("frames the finding as a question, not a verdict (neither side is assumed right)", () => {
    const text = renderResolveReview(RUN_ID, open, []);
    expect(text).toMatch(/1 open finding from run run_7c3f9a2e10b4 \(a document and a commit disagree; neither is assumed right\)/);
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

  it("says the run found nothing when there is nothing at all, and offers no commands", () => {
    const text = renderResolveReview(RUN_ID, [], []);
    expect(text).toBe("This run found no doc/code inconsistencies.");
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
    rmSync(HOME, { recursive: true, force: true });
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
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(HOME, "workspaces"), { recursive: true, force: true });
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

  /** One open finding plus one ordinary durable rule: the run `resolve` and `accept` share. */
  function seedMixed(): void {
    seed([finding(F1), rule("c3c3c3c3c3c3c3c3", "convention", "Prefer relative imports.")]);
  }

  it("exits 2 with a helpful message when no sidecar exists for the run", async () => {
    const code = await resolve(["--run-id", "run_missing"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/no candidates sidecar for run run_missing/);
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

  it("re-running the SAME answer is a no-op, so a retried command is safe", async () => {
    seedMixed();
    expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).toBe(0);
    expect(await resolve(["--run-id", RUN, "--finding", "a1a1a1", "--as", "doc_stale"])).toBe(0);
    expect(persisted(F1)?.resolution?.outcome).toBe("doc_stale");
    expect(posts).toHaveLength(0);
  });

  // The retry case for the answer that DOES touch the authority. A repeat is allowed (it is the
  // same verdict, not a contradicting one) and must not mint the sentence twice: the dedup is by
  // payload hash, so the second run sees it live and skips.
  it("re-running code_diverged reports the rule already live instead of minting it twice", async () => {
    seedMixed();
    // A fake that REMEMBERS: GET returns what POST has already accepted, which is what makes the
    // second run's hash lookup meaningful. A fake that always answers "nothing is live" would prove
    // only that the command posts twice against a backend that never existed.
    const live: RuleNodeView[] = [];
    const stateful: RuleClientHttp = {
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
    const argv = ["--run-id", RUN, "--finding", "a1a1a1", "--as", "code_diverged"];
    expect(await resolve(argv, { http: stateful })).toBe(0);
    out = [];
    expect(await resolve(argv, { http: stateful })).toBe(0);
    expect(posts).toHaveLength(1); // the second run minted nothing
    expect(out.join("\n")).toContain(`Already live (not minted again): ${QUOTE}`);
    expect(persisted(F1)?.resolution?.outcome).toBe("code_diverged");
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
      expect(env.human_summary).toContain("No open doc/code findings");
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
});
