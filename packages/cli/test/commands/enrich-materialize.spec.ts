// test/commands/enrich-materialize.spec.ts
//
// Coverage for `mla enrich materialize`: the MANUAL accept path. Where `enrich accept` reads a
// run's candidates sidecar by run id, `materialize` takes an accepted-candidates JSON payload
// directly (a hand-assembled batch, or a paste of a scout-result list) and binds the DURABLE ones.
//
// MATERIALIZING IS THE MINT, identical to `enrich accept`. The P0 this file pins: materialize used
// to write ONLY `.meetless/rules.md`, and `scan` skips that file as an injection source (it injects
// from the principal-bound backend bundle), so a rule that only reached the file was invisible to
// every agent. It is the same "accepted but never injected" illusion `enrich accept` was fixed for,
// on the manual path. Materialize now mints into the backend rule bundle FIRST and writes the file
// as its projection second, then delivers into the local caches an agent reads.
//
// Two layers are pinned here:
//   - the pure argument parser (fast, no fs);
//   - the real command boundary end to end: a real accepted-candidates file, a real git repo, the
//     real materializeRules bridge writing (or not writing) the file, and the mint through the
//     established CLI test boundary (an injected RuleClientHttp seam, the same one accept uses). No
//     internal service is mocked; the operator, workspace config and runtime scope are injected so
//     no network, disk auth or tty is touched.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts freezes HOME at module load, so MEETLESS_HOME must be set BEFORE the command module is
// required (same defensive pattern as enrich-accept.spec.ts). With deps fully injected the mint path
// never touches HOME, but this keeps the module load hermetic if it ever reads config at import.
const HOME = mkdtempSync(join(tmpdir(), "mla-enrich-materialize-home-"));
process.env.MEETLESS_HOME = HOME;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const enrich = require("../../src/commands/enrich") as typeof import("../../src/commands/enrich");
const { runEnrichMaterialize } = enrich;

import { MANAGED_RULES_PATH } from "../../src/lib/scanner/managed-rules";
import type { WorkspaceCliConfig } from "../../src/lib/config";
import type { RuleClientHttp, RuleNodeView } from "../../src/lib/rules/control-rule-client";

const WS = "ws_enrich_materialize";

// A valid documentation candidate (passes the same shape validator ingest uses: a file anchor is
// required for the documentation scout).
function docCandidate(kind: string, statement: string): Record<string, unknown> {
  return {
    kind,
    statement,
    sourceScout: "documentation",
    evidence: [{ type: "file", path: "CLAUDE.md", startLine: 1, endLine: 2 }],
  };
}

// The pure parseMaterializeArgs unit tests live with the other enrich sub-parsers in enrich.spec.ts
// (the established split: parseXArgs/renderX unit tests there, end-to-end command behavior here).
//
// ---------------------------------------------------------------------------------------
// Command boundary end to end: real accepted file, real git repo, real materialize, injected mint.
// ---------------------------------------------------------------------------------------
describe("mla enrich materialize (end to end, real file + mint + write)", () => {
  let repo: string;
  let root: string; // git toplevel (realpath); the command binds + writes relative to this (the cwd repo)
  let managedPath: string;
  let acceptedFile: string;
  let cwd0: string;
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  let out: string[];
  let err: string[];
  let posts: { path: string; body: MintBody }[];
  // Every post-mint local-cache refresh the command asked for (refreshRuleDelivery). Minting is hop
  // 1 of 3: the rules only reach an agent once the local bundle + scan caches carry them.
  let deliveries: { workspaceId: string; repositoryRoot: string }[];

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
  function deps(over: Partial<Parameters<typeof runEnrichMaterialize>[1]> = {}) {
    return {
      loadConfig: () => wsCfg(),
      http: fakeHttp(),
      resolveOperator: () => ({ userId: "user_an", displayName: "An" }),
      resolveRuntimeScopeId: () => SCOPE,
      isInteractive: () => false,
      confirm: () => false,
      // The real refresh fetches the bundle and rewrites two caches under HOME. Stub it by default
      // so every other test sees the SUCCESS path and the summary tells the truth about injection; a
      // test that wants the failure path overrides it with a thrower.
      refreshDelivery: async (cfg: WorkspaceCliConfig, repositoryRoot: string) => {
        deliveries.push({ workspaceId: cfg.workspaceId, repositoryRoot });
      },
      ...over,
    };
  }

  function writeAccepted(candidates: unknown[]): void {
    writeFileSync(acceptedFile, JSON.stringify(candidates), "utf8");
  }

  /** The command under test, always reading the accepted file, with the injected mint seams. */
  function materialize(argv: string[], over: Partial<Parameters<typeof runEnrichMaterialize>[1]> = {}) {
    return runEnrichMaterialize(["--accepted-file", acceptedFile, ...argv], deps(over));
  }

  afterAll(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mla-enrich-materialize-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim();
    managedPath = join(root, MANAGED_RULES_PATH);
    acceptedFile = join(repo, "accepted.json");
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
  });

  // The P0 itself: the file was the ONLY sink, and `scan` never reads it. Materializing must reach
  // the backend rule bundle, or the accepted rule is invisible to every agent.
  it("MATERIALIZING IS THE MINT: a durable candidate POSTs to the rule authority AND writes the file", async () => {
    writeAccepted([docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS.")]);
    const code = await materialize([]);
    expect(code).toBe(0);

    expect(posts).toHaveLength(1);
    const p = posts[0];
    expect(p.path).toContain("/internal/v1/rules");
    expect(p.body.workspaceId).toBe(WS);
    expect(p.body.authorityScope).toBe("PERSONAL"); // the default plane
    expect(p.body.ownerUserId).toBe("user_an");
    // One hash, sent as both the canonical identity and the idempotency key.
    expect(p.body.requestIdempotencyKey).toBe(p.body.canonicalPayloadHash);
    expect(p.body.canonicalPayloadHash).toMatch(/^[0-9a-f]{16,}$/);
    // The rule binds to the cwd repository (materialize has no run to inherit a scope from).
    expect(p.body.payload.runtimeScopeId).toBe(SCOPE);
    // Triple-safe, exactly like `mla rules add`: an accepted convention is injected, never enforced.
    expect(p.body.payload.applicability.mode).toBe("ambient");
    expect(p.body.payload.enforcementCeiling).toBe("OBSERVE");
    expect(p.body.payload.deliveryChannels).toEqual(["runtimeInject"]);
    expect(p.body.payload.text).toBe("Use 127.0.0.1, not localhost, on macOS.");

    // And the file is the projection, written AFTER the authority.
    expect(existsSync(managedPath)).toBe(true);
    expect(readFileSync(managedPath, "utf8")).toContain("Use 127.0.0.1, not localhost, on macOS.");

    const said = out.join("\n");
    expect(said).toMatch(/MINTED PERSONAL rule node_1: /);
    expect(said).toMatch(/they are in your local rule cache now/);
  });

  it("never tells the operator to commit and push to share: sharing is --team, not a git push", async () => {
    writeAccepted([docCandidate("constraint", "Never commit secrets.")]);
    const code = await materialize([]);
    expect(code).toBe(0);
    const printed = out.join("\n");
    expect(printed).not.toMatch(/Effective locally/); // the file is a projection, not the authority
    expect(printed).not.toMatch(/Commit and push to share/);
    expect(printed).toMatch(/Re-run with --team to enforce workspace-wide/);
  });

  it("mints the durable rules and skips governed-knowledge kinds (kind split, INV-AUTH-2)", async () => {
    writeAccepted([
      docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS."),
      docCandidate("convention", "Prefer relative imports."),
      docCandidate("boundary", "control owns the state machine."),
      docCandidate("decision", "We picked Cloud Run over a VM."),
      docCandidate("deprecation", "apps/api is decommissioned."),
    ]);
    const code = await materialize([]);
    expect(code).toBe(0);

    expect(posts).toHaveLength(3); // only the 3 durable kinds
    const statements = posts.map((p) => p.body.payload.text).sort();
    expect(statements).toEqual([
      "Prefer relative imports.",
      "Use 127.0.0.1, not localhost, on macOS.",
      "control owns the state machine.",
    ]);

    const file = readFileSync(managedPath, "utf8");
    expect(file).toContain("Use 127.0.0.1, not localhost, on macOS.");
    expect(file).toContain("Prefer relative imports.");
    expect(file).toContain("control owns the state machine.");
    expect(file).not.toContain("We picked Cloud Run over a VM."); // decision
    expect(file).not.toContain("apps/api is decommissioned."); // deprecation
    expect(out.join("\n")).toMatch(/Skipped 2 non-rule candidate/);
  });

  // INV-AUTH-2: a decision alone must not become a rule. Here nothing mints and the file is not
  // even created (this is the required Phase 1 behavior, now also proven at the authority).
  it("mints NOTHING and writes NOTHING when only a decision is accepted (INV-AUTH-2)", async () => {
    writeAccepted([docCandidate("decision", "We chose Postgres SKIP LOCKED over SQS.")]);
    const code = await materialize([]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(out.join("\n")).toMatch(/No durable rules to materialize/);
    expect(out.join("\n")).toMatch(/Skipped 1 non-rule candidate/);
  });

  // THE MINT IS ONLY HOP 1 OF 3. The backend bundle is the authority, but no hook ever fetches it:
  // `scan` reads the local bundle cache, and the prompt hook reads the scan cache `scan` writes. So a
  // mint that stops at the authority reaches no agent. Materialize delivers its own mint.
  it("DELIVERY: a successful mint refreshes the local caches, scoped to the cwd repo", async () => {
    writeAccepted([docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS.")]);
    const code = await materialize([]);
    expect(code).toBe(0);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].workspaceId).toBe(WS);
    expect(deliveries[0].repositoryRoot).toBe(root);
  });

  it("DELIVERY: a refresh failure never fails the durable mint, and never claims injection", async () => {
    writeAccepted([docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS.")]);
    const code = await materialize([], {
      refreshDelivery: async () => {
        throw new Error("bundle fetch failed: 503");
      },
    });

    // The rule IS on the authority: reporting a mint that happened as a failure would be a lie in the
    // other direction, and re-running would be the user's only recourse for a durable success.
    expect(code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(existsSync(managedPath)).toBe(true);

    // But it must be LOUD, and must NOT claim injection. A silent refresh failure is the original bug
    // wearing a different hat: live on the backend, invisible to every agent.
    const said = out.join("\n");
    expect(said).toMatch(/MINTED PERSONAL rule node_1: /);
    expect(said).toMatch(/WARNING: the rules are live on the backend but your LOCAL cache/);
    expect(said).toMatch(/bundle fetch failed: 503/);
    expect(said).toMatch(/Run `mla scan` to pull them down/);
    expect(said).not.toMatch(/they are in your local rule cache now/);
  });

  it("DELIVERY: --dry-run refreshes nothing (it minted nothing)", async () => {
    writeAccepted([docCandidate("convention", "Prefer relative imports.")]);
    const code = await materialize(["--dry-run"]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("--dry-run previews the mint and the write without doing either", async () => {
    writeAccepted([docCandidate("convention", "Prefer relative imports.")]);
    const code = await materialize(["--dry-run"]);
    expect(code).toBe(0);
    expect(existsSync(managedPath)).toBe(false);
    expect(posts).toHaveLength(0);
    expect(out.join("\n")).toMatch(/Would materialize 1 durable rule/);
    expect(out.join("\n")).toMatch(/Would mint 1 PERSONAL rule\(s\) into the backend rule bundle/);
  });

  it("--team mints on the TEAM plane (ownerUserId null) once confirmed by --yes", async () => {
    writeAccepted([docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS.")]);
    const code = await materialize(["--team", "--yes"]);
    expect(code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].body.authorityScope).toBe("TEAM");
    expect(posts[0].body.ownerUserId).toBeNull();
    expect(out.join("\n")).toMatch(/enforce for every member of the workspace/);
  });

  it("--team refuses non-interactively without --yes (blast radius gate): nothing minted, nothing written", async () => {
    writeAccepted([docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS.")]);
    const code = await materialize(["--team"], { isInteractive: () => false });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/refusing to mint TEAM rules non-interactively without --yes/);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
  });

  it("--team declined at the interactive prompt: nothing minted, nothing written", async () => {
    writeAccepted([docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS.")]);
    const code = await materialize(["--team"], { isInteractive: () => true, confirm: () => false });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/team rules not confirmed/);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false);
  });

  // A binding rule requires an authenticated human. A shared key / agent is not a human.
  it("refuses to materialize when the session is not an authenticated human (no user-token)", async () => {
    writeAccepted([docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS.")]);
    const code = await materialize([], { resolveOperator: () => null });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/requires an authenticated human \(run `mla login`\)/);
    expect(posts).toHaveLength(0);
    expect(existsSync(managedPath)).toBe(false); // the projection never runs ahead of the authority
  });

  // The native mint does not dedup, so a re-run must not double-mint what is already live.
  it("re-materializing skips what is already live on the authority (no duplicate RuleNode)", async () => {
    writeAccepted([docCandidate("boundary", "control owns the state machine.")]);
    expect(await materialize([])).toBe(0);
    expect(posts).toHaveLength(1);

    // Second run: the backend now lists the hash the first run minted.
    const live = posts.map((p, i) => ruleNode(`node_${i + 1}`, p.body.canonicalPayloadHash));
    posts = [];
    deliveries = [];
    const code = await materialize([], { http: fakeHttp(live) });
    expect(code).toBe(0);
    expect(posts).toHaveLength(0); // nothing minted twice
    expect(out.join("\n")).toMatch(/Already live \(not minted again\)/);
  });

  // The ordering invariant: the authority is written first, so the file can never claim a rule the
  // backend never received.
  it("a mint failure aborts: the projection is NOT written and the exit is non-zero", async () => {
    writeAccepted([docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS.")]);
    const boom: RuleClientHttp = {
      get: (async () => []) as unknown as RuleClientHttp["get"],
      post: (async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3006");
      }) as unknown as RuleClientHttp["post"],
      patch: (async () => {
        throw new Error("unexpected patch");
      }) as unknown as RuleClientHttp["patch"],
    };
    const code = await materialize([], { http: boom });
    expect(code).toBe(1);
    expect(existsSync(managedPath)).toBe(false);
    expect(err.join("\n")).toMatch(/was NOT written/);
    expect(err.join("\n")).toMatch(/No rule reached the authority/);
  });

  it("--json reports the machine shape (wrote true, minted ids, delivered, skipped records)", async () => {
    writeAccepted([
      docCandidate("constraint", "Use 127.0.0.1, not localhost, on macOS."),
      docCandidate("convention", "Prefer relative imports."),
      docCandidate("decision", "We picked Cloud Run over a VM."),
    ]);
    const code = await materialize(["--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.path).toBe(MANAGED_RULES_PATH);
    expect(parsed.changed).toBe(true);
    expect(parsed.wrote).toBe(true);
    expect(parsed.authorityScope).toBe("PERSONAL");
    expect(parsed.materialized).toHaveLength(2);
    expect(parsed.minted).toHaveLength(2);
    expect(parsed.minted.map((m: { ruleId: string }) => m.ruleId)).toEqual(["node_1", "node_2"]);
    expect(parsed.alreadyLive).toEqual([]);
    expect(parsed.delivered).toBe(true);
    expect(parsed.deliveryError).toBeNull();
    // skipped is the array of skip records (kind/reason/statement), not a count.
    expect(parsed.skipped).toHaveLength(1);
    expect(parsed.skipped.map((s: { kind: string }) => s.kind)).toEqual(["decision"]);
  });

  it("refuses the whole batch (exit 2) on a malformed candidate: no mint, no partial file", async () => {
    writeAccepted([
      docCandidate("constraint", "A good rule."),
      docCandidate("not-a-kind", "A bad rule."),
    ]);
    const code = await materialize([]);
    expect(code).toBe(2);
    expect(existsSync(managedPath)).toBe(false);
    expect(posts).toHaveLength(0); // validation fails before any mint
    expect(err.join("\n")).toMatch(/refusing to materialize/);
    expect(err.join("\n")).toMatch(/bad_kind/);
  });

  it("exits 2 when the accepted payload is unreadable JSON: no mint, nothing written", async () => {
    writeFileSync(acceptedFile, "{not json", "utf8");
    const code = await materialize([]);
    expect(code).toBe(2);
    expect(existsSync(managedPath)).toBe(false);
    expect(posts).toHaveLength(0);
    expect(err.join("\n")).toMatch(/not valid JSON/);
  });

  it("is byte-idempotent: re-materializing the same accepted rule does not change the file", async () => {
    writeAccepted([docCandidate("boundary", "control owns the state machine.")]);
    await materialize([]);
    const first = readFileSync(managedPath, "utf8");
    // Second run with the hash already live so it does not double-mint; the file must be byte-stable.
    const live = posts.map((p, i) => ruleNode(`node_${i + 1}`, p.body.canonicalPayloadHash));
    const code = await materialize([], { http: fakeHttp(live) });
    expect(code).toBe(0);
    expect(readFileSync(managedPath, "utf8")).toBe(first);
  });
});
