// test/commands/enrich-accept.spec.ts
//
// Coverage for `mla enrich accept`: the command that closes the loop the onboarding
// investigation found. `enrich ingest` parks a run's merged candidates in a per-run
// sidecar; `enrich accept` reads that sidecar and accepts the DURABLE ones (constraint,
// convention, boundary), leaving decisions and deprecations to the governed Console KB.
//
// ACCEPTANCE IS THE MINT. The P0 this file now pins: acceptance used to write ONLY
// `.meetless/rules.md`, and `scan` skips that file as an injection source (it injects from the
// principal-bound backend bundle), so no onboarded + accepted rule was ever injected. Accept now
// mints into the backend rule bundle FIRST and writes the file as its projection second.
//
// Three layers are pinned here:
//   - the pure argument parser + review renderer (fast, no fs);
//   - the real command boundary end to end: a real sidecar under a throwaway HOME, a real
//     git repo, and the real materializeRules bridge writing (or not writing) the file;
//   - the mint, through the established CLI test boundary: the injected RuleClientHttp seam
//     (the same one rules-backend.spec.ts uses). No internal service is mocked; the operator,
//     workspace config and runtime scope are injected so no network, disk auth or tty is touched.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts freezes HOME at module load, so MEETLESS_HOME must be set BEFORE the command
// module is required (same pattern as enrich-workspace-gate.spec.ts).
const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-accept-home-"));
process.env.MEETLESS_HOME = HOME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrichAccept, parseAcceptArgs, renderAcceptReview } = enrich;

import { upsertCandidatesSidecar } from "../../src/lib/enrichment/ingest";
import { MANAGED_RULES_PATH } from "../../src/lib/scanner/managed-rules";
import {
  resetMachineCommand,
  resetOutputMode,
  setMachineCommand,
  setOutputMode,
  type MachineEnvelope,
} from "../../src/lib/machine-output";
import { assertEnvelopeBoundary } from "../support/envelope-boundary";
import type { WorkspaceCliConfig } from "../../src/lib/config";
import type { RuleClientHttp, RuleNodeView } from "../../src/lib/rules/control-rule-client";
import type {
  EnrichmentKind,
  OnboardingCandidateRecord,
  OnboardingCandidatesSidecar,
} from "../../src/lib/enrichment/protocol";

const WS = "ws_enrich_accept";

function rec(candidateId: string, kind: EnrichmentKind, statement: string): OnboardingCandidateRecord {
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
// Pure layer: parseAcceptArgs + renderAcceptReview (no fs, no HOME needed).
// ---------------------------------------------------------------------------------------
describe("parseAcceptArgs", () => {
  it("requires --run-id (missing entirely) ", () => {
    expect(() => parseAcceptArgs([])).toThrow(/--run-id is required/);
  });

  it("requires a value for --run-id", () => {
    expect(() => parseAcceptArgs(["--run-id"])).toThrow(/--run-id requires a value/);
  });

  it("parses the bare (review) form: run-id only, no selection, PERSONAL plane by default", () => {
    const f = parseAcceptArgs(["--run-id", "run_abc"]);
    expect(f).toEqual({
      runId: "run_abc",
      all: false,
      dryRun: false,
      json: false,
      team: false,
      personal: false,
      yes: false,
    });
  });

  it("parses --all, --dry-run, --json, --workspace", () => {
    const f = parseAcceptArgs(["--run-id", "run_abc", "--all", "--dry-run", "--json", "--workspace", "ws_1"]);
    expect(f).toMatchObject({ runId: "run_abc", all: true, dryRun: true, json: true, workspace: "ws_1" });
  });

  it("parses the authority-plane flags: --team, --personal, --yes", () => {
    expect(parseAcceptArgs(["--run-id", "r", "--team", "--yes"])).toMatchObject({ team: true, yes: true });
    expect(parseAcceptArgs(["--run-id", "r", "--personal"])).toMatchObject({ personal: true, team: false });
  });

  it("--team and --personal are the two planes, never both", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--team", "--personal"])).toThrow(
      /either --team or --personal, not both/,
    );
  });

  it("--all and --only are mutually exclusive", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--all", "--only", "a1b2c3"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("lowercases and trims --only prefixes", () => {
    const f = parseAcceptArgs(["--run-id", "r", "--only", " A1B2C3 , d4e5f6 "]);
    expect(f.only).toEqual(["a1b2c3", "d4e5f6"]);
  });

  it("rejects an --only prefix shorter than 6 hex chars", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--only", "a1b2c"])).toThrow(
      /at least 6 hex characters/,
    );
  });

  it("rejects a non-hex --only prefix (a typo can never be read as an id)", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--only", "zzzzzz"])).toThrow(
      /at least 6 hex characters/,
    );
  });

  it("requires at least one prefix for --only", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--only", " , "])).toThrow(/at least one candidate id prefix/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseAcceptArgs(["--run-id", "r", "--promote"])).toThrow(/Unknown flag/);
  });
});

describe("renderAcceptReview", () => {
  const RUN_ID = "run_7c3f9a2e10b4";
  const durable = [
    rec("b2b2b2b2b2b2", "convention", "Prefer relative imports."),
    rec("a1a1a1a1a1a1", "constraint", "Use 127.0.0.1, not localhost, on macOS."),
  ];
  const knowledge = [rec("d4d4d4d4d4d4", "decision", "We picked Cloud Run over a VM.")];

  it("lists durable rules sorted by statement with a 12-char id and [kind]", () => {
    const text = renderAcceptReview(RUN_ID, durable, knowledge);
    // The review sells the MINT, not the file: the bundle is the authority, the file its projection.
    expect(text).toMatch(/2 durable rules this run found \(accept to mint into the rule bundle/);
    expect(text).toContain("`mla scan` injects from");
    // Sorted by statement: "Prefer relative imports." precedes "Use 127.0.0.1...".
    expect(text.indexOf("Prefer relative imports.")).toBeLessThan(text.indexOf("Use 127.0.0.1"));
    expect(text).toContain("a1a1a1a1a1a1  [constraint]  Use 127.0.0.1, not localhost, on macOS.");
    expect(text).toContain("b2b2b2b2b2b2  [convention]  Prefer relative imports.");
  });

  it("lists governed-knowledge candidates separately and marks them NOT materialized", () => {
    const text = renderAcceptReview(RUN_ID, durable, knowledge);
    expect(text).toMatch(/1 governed-knowledge candidate \(NOT materialized; governed in the Console KB\):/);
    expect(text).toContain("d4d4d4d4d4d4  [decision]  We picked Cloud Run over a VM.");
  });

  it("shows the --all / --only / --dry-run / --team hints when there are durable rules", () => {
    const text = renderAcceptReview(RUN_ID, durable, knowledge);
    expect(text).toContain("--all");
    expect(text).toContain("--only");
    expect(text).toContain("--dry-run");
    expect(text).toContain("--team");
    expect(text).toContain("default is PERSONAL");
  });

  it("interpolates the REAL run id into the runnable next-step commands (no literal placeholder)", () => {
    // Proposal §3 bug 3: the menu used to print `--run-id <id>` literally, so a paste
    // was a guaranteed error. The run id we know must be filled in; only `<id-prefix>`
    // (a value the operator chooses) stays a placeholder.
    const text = renderAcceptReview(RUN_ID, durable, knowledge);
    expect(text).toContain(`mla enrich accept --run-id ${RUN_ID} --all`);
    expect(text).toContain(`mla enrich accept --run-id ${RUN_ID} --only <id-prefix>`);
    expect(text).not.toContain("--run-id <id>");
  });

  it("says nothing to accept (and omits hints) when there are no durable rules", () => {
    const text = renderAcceptReview(RUN_ID, [], knowledge);
    expect(text).toMatch(/This run found no durable rules to accept\./);
    expect(text).not.toContain("--all");
  });

  it("contains no em dash or double dash (writing-style guard)", () => {
    const text = renderAcceptReview(RUN_ID, durable, knowledge);
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/ -- /);
  });
});

// ---------------------------------------------------------------------------------------
// Command boundary end to end: real sidecar, real git repo, real materialize, injected mint.
// ---------------------------------------------------------------------------------------
describe("mla enrich accept (end to end, real sidecar + mint + file write)", () => {
  let repo: string;
  let root: string; // git toplevel (realpath); the command writes relative to the sidecar's repositoryRoot
  let managedPath: string;
  let cwd0: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let err: string[];
  let posts: { path: string; body: MintBody }[];
  // Every post-mint local-cache refresh the command asked for (see refreshRuleDelivery). Minting is
  // hop 1 of 3: the rules only reach an agent once the local bundle + scan caches carry them.
  let deliveries: { workspaceId: string; repositoryRoot: string }[];

  const RUN = "run_accept_e2e";
  const SCOPE = "scope_test_repo";

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

  // The mint sink: a programmable RuleClientHttp (the established CLI test boundary). GET is
  // listRules (what is already live); POST is the mint. Nothing touches the network.
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

  // A logged-in human, a bound workspace, a fixed runtime scope, and no tty. Every seam the mint
  // needs, injected, so the test pins the WIRE the command sends and never the transport.
  function deps(over: Partial<Parameters<typeof runEnrichAccept>[1]> = {}) {
    return {
      loadConfig: () => wsCfg(),
      http: fakeHttp(),
      resolveOperator: () => ({ userId: "user_an", displayName: "An" }),
      resolveRuntimeScopeId: () => SCOPE,
      isInteractive: () => false,
      confirm: () => false,
      // The real refresh fetches the bundle and rewrites two caches under HOME. Stub it by default
      // (its own coverage is below) so every other test sees the SUCCESS path and the summary tells
      // the truth about injection; a test that wants the failure path overrides it with a thrower.
      refreshDelivery: async (cfg: WorkspaceCliConfig, repositoryRoot: string) => {
        deliveries.push({ workspaceId: cfg.workspaceId, repositoryRoot });
      },
      ...over,
    };
  }

  /** The command under test, always with the workspace override the sidecar was seeded under. */
  function accept(argv: string[], over: Partial<Parameters<typeof runEnrichAccept>[1]> = {}) {
    return runEnrichAccept(["--workspace", WS, ...argv], deps(over));
  }

  beforeAll(() => {
    // A minimal cli-config so readKbConfig resolves an actor without a marker; --workspace
    // supplies the workspaceId directly (admin override), so no `.meetless.json` is needed.
    writeFileSync(
      join(HOME, "cli-config.json"),
      JSON.stringify({
        controlUrl: "http://127.0.0.1:1",
        intelUrl: "http://127.0.0.1:1",
        controlToken: "ik-test",
        actorUserId: "user_test",
        mlaPath: "/bin/true",
      }),
    );
  });

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-enrich-accept-repo-"));
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

  function seed(runId: string, candidates: OnboardingCandidateRecord[]): void {
    const sidecar: OnboardingCandidatesSidecar = {
      schemaVersion: 1,
      workspaceId: WS,
      runId,
      repositoryRoot: root,
      updatedAt: "2026-07-10T00:00:00.000Z",
      candidates,
    };
    upsertCandidatesSidecar(HOME, sidecar);
  }

  // The mixed run every selection test reuses: 3 durable kinds + 2 governed-knowledge kinds.
  function seedMixed(): void {
    seed(RUN, [
      rec("a1a1a1a1a1a1a1a1", "constraint", "Use 127.0.0.1, not localhost, on macOS."),
      rec("b2b2b2b2b2b2b2b2", "convention", "Prefer relative imports."),
      rec("c3c3c3c3c3c3c3c3", "boundary", "control owns the state machine."),
      rec("d4d4d4d4d4d4d4d4", "decision", "We picked Cloud Run over a VM."),
      rec("e5e5e5e5e5e5e5e5", "deprecation", "apps/api is decommissioned."),
    ]);
  }

  it("exits 2 with a helpful message when no sidecar exists for the run", async () => {
    const code = await accept(["--run-id", "run_missing"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/no candidates sidecar for run run_missing/);
    expect(err.join("\n")).toMatch(/Run `mla enrich ingest` first/);
    expect(existsSync(managedPath)).toBe(false);
  });

  it("review mode (no selection flag) mints nothing, writes nothing, shows durable + governed-knowledge", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN]);
    expect(code).toBe(0);
    expect(existsSync(managedPath)).toBe(false); // read-only
    expect(posts).toHaveLength(0); // and the authority is untouched
    const text = out.join("\n");
    expect(text).toMatch(/3 durable rules this run found/);
    expect(text).toContain("Use 127.0.0.1, not localhost, on macOS.");
    expect(text).toMatch(/2 governed-knowledge candidates \(NOT materialized/);
    expect(text).toContain("We picked Cloud Run over a VM.");
  });

  it("--all materializes the 3 durable rules and skips the 2 governed-knowledge ones (kind split)", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN]);
    expect(code).toBe(0);
    // review printed above did not write; now accept for real:
    const code2 = await accept(["--run-id", RUN, "--all"]);
    expect(code2).toBe(0);
    expect(existsSync(managedPath)).toBe(true);
    const file = readFileSync(managedPath, "utf8");
    expect(file).toContain("Use 127.0.0.1, not localhost, on macOS."); // constraint
    expect(file).toContain("Prefer relative imports."); // convention
    expect(file).toContain("control owns the state machine."); // boundary
    // The governed-knowledge kinds never reach the managed file.
    expect(file).not.toContain("We picked Cloud Run over a VM."); // decision
    expect(file).not.toContain("apps/api is decommissioned."); // deprecation
    expect(out.join("\n")).toMatch(/Skipped 2 non-rule candidate/);
  });

  it("never tells the operator to commit and push to share: sharing is --team, not a git push", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all"]);
    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).not.toMatch(/Effective locally/); // the file is a projection, not the authority
    expect(printed).not.toMatch(/Commit and push to share/);
    expect(printed).toMatch(/Re-run with --team to enforce workspace-wide/);
  });

  // The P0 itself: the file was the ONLY sink, and `scan` never reads it. Acceptance must reach the
  // backend rule bundle, or the accepted rule is invisible to every agent.
  it("ACCEPTANCE IS THE MINT: --all POSTs each durable rule to the rule authority", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all"]);
    expect(code).toBe(0);

    expect(posts).toHaveLength(3); // the 3 durable kinds; decision + deprecation never mint
    for (const p of posts) {
      expect(p.path).toContain("/internal/v1/rules");
      expect(p.body.workspaceId).toBe(WS);
      expect(p.body.authorityScope).toBe("PERSONAL"); // the default plane
      expect(p.body.ownerUserId).toBe("user_an");
      // One hash, sent as both the canonical identity and the idempotency key.
      expect(p.body.requestIdempotencyKey).toBe(p.body.canonicalPayloadHash);
      expect(p.body.canonicalPayloadHash).toMatch(/^[0-9a-f]{16,}$/);
      // The rule binds to the RUN's repository (the sidecar's root), not to the cwd.
      expect(p.body.payload.runtimeScopeId).toBe(SCOPE);
      // Triple-safe, exactly like `mla rules add`: an accepted convention is injected, never enforced.
      expect(p.body.payload.applicability.mode).toBe("ambient");
      expect(p.body.payload.enforcementCeiling).toBe("OBSERVE");
      expect(p.body.payload.deliveryChannels).toEqual(["runtimeInject"]);
    }
    const statements = posts.map((p) => p.body.payload.text).sort();
    expect(statements).toEqual([
      "Prefer relative imports.",
      "Use 127.0.0.1, not localhost, on macOS.",
      "control owns the state machine.",
    ]);
    expect(out.join("\n")).toMatch(/MINTED PERSONAL rule node_1: /);
    expect(out.join("\n")).toMatch(/they are in your local rule cache now/);
  });

  // THE MINT IS ONLY HOP 1 OF 3. The backend bundle is the authority, but no hook ever fetches it:
  // `scan` reads the local bundle cache, and the UserPromptSubmit hook reads the scan cache `scan`
  // writes. So a mint that stops at the authority reaches no agent, and 0.2.18 shipped exactly that:
  // accept printed "`mla scan` injects them now" while refreshing neither local cache. Inside a
  // session the flush-hook's steer-sync papered over it one turn late; outside one (a scripted demo,
  // CI, a plain shell) the rule simply never arrived. Accept delivers its own mint now.
  it("DELIVERY: a successful mint refreshes the local caches, scoped to the RUN's repo", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all"]);
    expect(code).toBe(0);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].workspaceId).toBe(WS);
    // The rescan targets the repository the RUN was mined from (the sidecar's root), never the cwd:
    // accept is explicitly allowed to run from somewhere else, and the rules bind to the run's repo.
    expect(deliveries[0].repositoryRoot).toBe(root);
  });

  it("DELIVERY: a refresh failure never fails the durable mint, and never claims injection", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all"], {
      refreshDelivery: async () => {
        throw new Error("bundle fetch failed: 503");
      },
    });

    // The rules ARE on the authority: reporting a mint that happened as a failure would be a lie in
    // the other direction, and re-running would be the user's only recourse for a durable success.
    expect(code).toBe(0);
    expect(posts).toHaveLength(3);
    expect(existsSync(managedPath)).toBe(true);

    // But it must be LOUD, and it must NOT claim the rules are injected. A silent refresh failure is
    // the original bug wearing a different hat: live on the backend, invisible to every agent.
    const said = out.join("\n");
    expect(said).toMatch(/MINTED PERSONAL rule node_1: /);
    expect(said).toMatch(/WARNING: the rules are live on the backend but your LOCAL cache/);
    expect(said).toMatch(/bundle fetch failed: 503/);
    expect(said).toMatch(/Run `mla scan` to pull them down/);
    expect(said).not.toMatch(/they are in your local rule cache now/);
  });

  it("DELIVERY: --dry-run refreshes nothing (it minted nothing)", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all", "--dry-run"]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("--team mints on the TEAM plane (ownerUserId null) once confirmed by --yes", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all", "--team", "--yes"]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(3);
    for (const p of posts) {
      expect(p.body.authorityScope).toBe("TEAM");
      expect(p.body.ownerUserId).toBeNull();
    }
    expect(out.join("\n")).toMatch(/They enforce for every member of the workspace|enforce for every member/);
  });

  it("--team refuses non-interactively without --yes (blast radius gate): nothing minted, nothing written", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all", "--team"], { isInteractive: () => false });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/refusing to mint TEAM rules non-interactively without --yes/);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
  });

  it("--team declined at the interactive prompt: nothing minted, nothing written", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all", "--team"], {
      isInteractive: () => true,
      confirm: () => false,
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/team rules not confirmed/);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
  });

  // Acceptance 8: a binding rule requires an authenticated human. A shared key is not a human.
  it("refuses to accept when the session is not an authenticated human (no user-token)", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all"], { resolveOperator: () => null });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/requires an authenticated human \(run `mla login`\)/);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false); // the projection never runs ahead of the authority
  });

  // The native mint does not dedup, so a re-run must not double-mint what is already live.
  it("re-accepting skips what is already live on the authority (no duplicate RuleNode)", async () => {
    seedMixed();
    expect(await accept(["--run-id", RUN, "--all"])).toBe(0);
    expect(posts).toHaveLength(3);

    // Second run: the backend now lists the 3 hashes the first run minted.
    const live = posts.map((p, i) => ruleNode(`node_${i + 1}`, p.body.canonicalPayloadHash));
    posts = [];
    deliveries = [];
    const code = await accept(["--run-id", RUN, "--all"], { http: fakeHttp(live) });
    expect(code).toBe(0);
    expect(posts).toHaveLength(0); // nothing minted twice
    expect(out.join("\n")).toMatch(/Already live \(not minted again\)/);
  });

  // The ordering invariant: the authority is written first, so the file can never claim a rule the
  // backend never received.
  it("a mint failure aborts: the projection is NOT written and the exit is non-zero", async () => {
    seedMixed();
    const boom: RuleClientHttp = {
      get: (async () => []) as unknown as RuleClientHttp["get"],
      post: (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3006");
      }) as unknown as RuleClientHttp["post"],
      patch: (async () => {
        throw new Error("unexpected patch");
      }) as unknown as RuleClientHttp["patch"],
    };
    const code = await accept(["--run-id", RUN, "--all"], { http: boom });
    expect(code).toBe(1);
    expect(existsSync(managedPath)).toBe(false);
    expect(err.join("\n")).toMatch(/was NOT written/);
    expect(err.join("\n")).toMatch(/No rule reached the authority/);
  });

  it("INV-AUTH-2: --all mints and writes NOTHING when the run found only governed-knowledge kinds", async () => {
    seed(RUN, [
      rec("d4d4d4d4d4d4d4d4", "decision", "We chose Postgres SKIP LOCKED over SQS."),
      rec("e5e5e5e5e5e5e5e5", "deprecation", "agent is superseded by intel."),
    ]);
    const code = await accept(["--run-id", RUN, "--all"]);
    expect(code).toBe(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(posts).toHaveLength(0);
    expect(out.join("\n")).toMatch(/No durable rules to materialize/);
  });

  it("--only <prefix> mints and materializes just the matched candidate", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--only", "a1a1a1"]);
    expect(code).toBe(0);
    const file = readFileSync(managedPath, "utf8");
    expect(file).toContain("Use 127.0.0.1, not localhost, on macOS.");
    expect(file).not.toContain("Prefer relative imports.");
    expect(file).not.toContain("control owns the state machine.");
    expect(posts).toHaveLength(1);
    expect(posts[0].body.payload.text).toBe("Use 127.0.0.1, not localhost, on macOS.");
  });

  it("--only is fail-closed on a zero-match prefix (exit 2, no mint, no write)", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--only", "999999"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/no candidate id starts with "999999"/);
    expect(existsSync(managedPath)).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("--only is fail-closed on an ambiguous prefix (exit 2, no mint, no write)", async () => {
    seed(RUN, [
      rec("abcdef111111", "constraint", "First colliding rule."),
      rec("abcdef222222", "convention", "Second colliding rule."),
    ]);
    const code = await accept(["--run-id", RUN, "--only", "abcdef"]);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/prefix "abcdef" is ambiguous/);
    expect(existsSync(managedPath)).toBe(false);
    expect(posts).toHaveLength(0);
  });

  it("--dry-run --all previews the mint and the write without doing either", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all", "--dry-run"]);
    expect(code).toBe(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(posts).toHaveLength(0);
    expect(out.join("\n")).toMatch(/Would materialize 3 durable rule/);
    expect(out.join("\n")).toMatch(/Would mint 3 PERSONAL rule\(s\) into the backend rule bundle/);
  });

  it("--json --all reports the machine shape (wrote true, minted ids, skipped records)", async () => {
    seedMixed();
    const code = await accept(["--run-id", RUN, "--all", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.runId).toBe(RUN);
    expect(parsed.path).toBe(MANAGED_RULES_PATH);
    expect(parsed.changed).toBe(true);
    expect(parsed.wrote).toBe(true);
    expect(parsed.materialized).toHaveLength(3);
    expect(parsed.authorityScope).toBe("PERSONAL");
    expect(parsed.minted).toHaveLength(3);
    expect(parsed.minted.map((m: { ruleId: string }) => m.ruleId)).toEqual(["node_1", "node_2", "node_3"]);
    expect(parsed.alreadyLive).toEqual([]);
    // skipped is the array of skip records (kind/reason/statement), not a count.
    expect(parsed.skipped).toHaveLength(2);
    expect(parsed.skipped.map((s: { kind: string }) => s.kind).sort()).toEqual(["decision", "deprecation"]);
  });

  it("is byte-idempotent: re-accepting --all does not change the file", async () => {
    seedMixed();
    await accept(["--run-id", RUN, "--all"]);
    const first = readFileSync(managedPath, "utf8");
    const code = await accept(["--run-id", RUN, "--all"]);
    expect(code).toBe(0);
    expect(readFileSync(managedPath, "utf8")).toBe(first);
  });

  // -------------------------------------------------------------------------------------
  // Machine mode (Phase 3, §4.5-§4.6): the read-only preview carries a typed decision_request
  // and the mutation emits a result envelope. Driven with the mode + command the dispatch gate
  // would have armed (that arming is covered by machine-capability + machine-dispatch-gate specs);
  // here we pin what the CONVERTED handler emits on stdout end to end, over the same real sidecar.
  // -------------------------------------------------------------------------------------
  describe("machine mode: decision_request on preview, result on mutation", () => {
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

    /**
     * The single stdout document machine mode emits, parsed. Every real envelope this block
     * captures is run through the shared §5.1 boundary LAW (assertEnvelopeBoundary), so the
     * enrich.accept preview + apply + error envelopes are pinned against the SAME protocol
     * contract the dedicated boundary guard enforces, at one choke point rather than duplicated.
     */
    function envelope(): MachineEnvelope {
      expect(docs).toHaveLength(1);
      return assertEnvelopeBoundary(docs[0]);
    }

    it("preview: mints nothing, carries the typed decision_request (all / constraints / none) + human_summary", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.accept"); // the read-only review id the gate resolves for a bare accept

      const code = await accept(["--run-id", RUN]);
      expect(code).toBe(0);
      expect(posts).toHaveLength(0); // read-only: the authority is untouched
      expect(existsSync(managedPath)).toBe(false); // and nothing is written

      const env = envelope();
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.command).toBe("enrich.accept");
      // A preview asks the decision; it never carries the onboard nudge.
      expect(env.next_action).toBeUndefined();

      const result = env.result as {
        runId: string;
        durable: unknown[];
        knowledgeOnly: unknown[];
      };
      expect(result.runId).toBe(RUN);
      expect(result.durable).toHaveLength(3);
      expect(result.knowledgeOnly).toHaveLength(2);

      const dr = env.decision_request;
      expect(dr).toBeDefined();
      if (!dr) return;
      expect(dr.kind).toBe("enrich.accept");
      expect(dr.subject.run_id).toBe(RUN);
      expect(dr.prompt).toContain(RUN);
      // Three options: accept all, the constraints-only middle ground (1 constraint is a PROPER
      // subset of the 3 durable), and leave pending. The typed selections carry NO shell command.
      expect(dr.options.map((o) => o.id)).toEqual(["all", "constraints", "none"]);
      const byId = Object.fromEntries(dr.options.map((o) => [o.id, o]));
      expect(byId.all.selection).toEqual({ mode: "all" });
      expect(byId.constraints.selection).toEqual({
        mode: "only",
        candidate_ids: ["a1a1a1a1a1a1a1a1"], // the full sha id, so `--only` resolves unambiguously
      });
      expect(byId.none.selection).toEqual({ mode: "none" });

      expect(env.human_summary).toContain("3 durable rules found");
      expect(env.human_summary).toContain("2 knowledge-only");
      expect(env.human_summary).toContain("Nothing is accepted until you choose.");
    });

    it("preview: a run with only governed-knowledge kinds carries NO decision_request", async () => {
      seed(RUN, [
        rec("d4d4d4d4d4d4d4d4", "decision", "We chose Postgres SKIP LOCKED over SQS."),
        rec("e5e5e5e5e5e5e5e5", "deprecation", "agent is superseded by intel."),
      ]);
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.accept");

      const code = await accept(["--run-id", RUN]);
      expect(code).toBe(0);

      const env = envelope();
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect((env.result as { durable: unknown[] }).durable).toHaveLength(0);
      expect(env.decision_request).toBeUndefined();
      expect(env.human_summary).toBe("This run found no durable rules to accept.");
    });

    it("preview: when every durable rule IS a constraint, the constraints middle ground is omitted", async () => {
      // constraints == durable, not a proper subset, so offering "constraints only" would duplicate
      // "all". Options collapse to all / none.
      seed(RUN, [
        rec("a1a1a1a1a1a1a1a1", "constraint", "Use 127.0.0.1, not localhost, on macOS."),
        rec("f6f6f6f6f6f6f6f6", "constraint", "control owns the state machine transitions."),
      ]);
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.accept");

      const code = await accept(["--run-id", RUN]);
      expect(code).toBe(0);

      const env = envelope();
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.decision_request?.options.map((o) => o.id)).toEqual(["all", "none"]);
    });

    it("mutation --all: emits a result envelope (command enrich.accept.apply), no decision_request, mints 3", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.accept.apply"); // the mutation id the gate resolves for accept + a selection flag

      const code = await accept(["--run-id", RUN, "--all"]);
      expect(code).toBe(0);
      expect(posts).toHaveLength(3);
      expect(existsSync(managedPath)).toBe(true);

      const env = envelope();
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.command).toBe("enrich.accept.apply");
      // A completed mutation is an outcome: it carries neither a decision nor a next step.
      expect(env.decision_request).toBeUndefined();
      expect(env.next_action).toBeUndefined();

      const result = env.result as {
        wrote: boolean;
        authorityScope: string;
        minted: unknown[];
      };
      expect(result.wrote).toBe(true);
      expect(result.authorityScope).toBe("PERSONAL");
      expect(result.minted).toHaveLength(3);
    });

    it("mutation --only: a selection that no longer resolves fails closed with an invalid_selection error envelope", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.accept.apply");

      const code = await accept(["--run-id", RUN, "--only", "999999"]);
      expect(code).toBe(2);
      expect(posts).toHaveLength(0); // fail closed: nothing minted
      expect(existsSync(managedPath)).toBe(false);

      const env = envelope();
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.command).toBe("enrich.accept.apply");
      expect(env.error.code).toBe("invalid_selection");
      expect(env.error.message).toMatch(/refusing to accept/);
    });

    it("mutation: an unauthenticated session becomes a not_authenticated error envelope (mint refusal)", async () => {
      seedMixed();
      setOutputMode("machine-best-effort");
      setMachineCommand("enrich.accept.apply");

      const code = await accept(["--run-id", RUN, "--all"], { resolveOperator: () => null });
      expect(code).toBe(1);
      expect(posts).toHaveLength(0);

      const env = envelope();
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.code).toBe("not_authenticated");
      expect(env.error.message).toMatch(/requires an authenticated human/);
    });
  });
});
